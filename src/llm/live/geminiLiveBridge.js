/**
 * Bridges one Socket.IO client ↔ Gemini Multimodal Live API.
 * Per chatbot: isolated prompt, image slideshow, lead capture.
 */
const { GoogleGenAI, Modality, ActivityHandling, StartSensitivity, EndSensitivity } = require('@google/genai');
const { geminiConfig, assertGeminiConfigured } = require('../config/geminiConfig');
const { buildChatbotLiveInstruction, buildTopicGreeting } = require('./chatbotLivePrompt');
const { formatGeminiErrorForUser } = require('../utils/geminiHelper');
const { SUBMIT_LEAD_TOOL } = require('./liveLeadTools');
const { SEARCH_KNOWLEDGE_TOOL } = require('./liveKnowledgeTools');
const { SET_PRESENTATION_TOPIC_TOOL } = require('./liveImageTools');
const { saveLead } = require('../services/leadService');
const {
  searchKnowledgeChunks,
  getOverviewChunks,
  formatChunksForPrompt,
  normalizeRagQuery,
} = require('../services/knowledgeRetrievalService');
const {
  buildNumberedImageCatalog,
  resolveSlideshowForTopicKey,
  findCatalogImageById,
  formatImageForFrontend,
  scoreImageAgainstSpeech,
  pickBestImageForSpeech,
  pickClusterForSpeech,
} = require('./chatbotImageService');
const {
  isNoiseTranscript,
  detectActivation,
  hasGreetingWakeKey,
  isJunkWakeTranscript,
  isActivationOnlyUtterance,
  shouldDispatchImagesForUtterance,
  shouldVadFallbackActivate,
} = require('./liveActivation');
const { classifyWakeUtterance, classifyWakeText, isWakeTextCandidate } = require('../services/wakeDetectService');
const { toRomanDisplay } = require('./romanizeTranscript');

const FALLBACK_LIVE_MODELS = [
  'gemini-2.5-flash-native-audio-preview-12-2025',
  'gemini-3.1-flash-live-preview',
  'gemini-live-2.5-flash-native-audio',
].filter(Boolean);

const liveSessions = new Map();
const audioChunkCounts = new Map();
const liveStartLocks = new Map();
const pendingSessionStops = new Map();

function cancelPendingSessionStop(socketId) {
  const timer = pendingSessionStops.get(socketId);
  if (timer) {
    clearTimeout(timer);
    pendingSessionStops.delete(socketId);
  }
}

function findReusableLiveSession(chatbotId, preferSocketId) {
  const id = String(chatbotId);
  const trySid = (sid) => {
    const entry = liveSessions.get(sid);
    if (entry?.geminiSession && entry.setupDone?.() && String(entry.meta?.chatbotId) === id) {
      return { socketId: sid, entry };
    }
    return null;
  };

  if (preferSocketId) {
    const hit = trySid(preferSocketId);
    if (hit) return hit;
  }

  for (const sid of pendingSessionStops.keys()) {
    const hit = trySid(sid);
    if (hit) return hit;
  }
  return null;
}

function adoptLiveSession(entry, socket, fromSocketId) {
  if (fromSocketId && fromSocketId !== socket.id) {
    liveSessions.delete(fromSocketId);
  }
  cancelPendingSessionStop(fromSocketId);
  cancelPendingSessionStop(socket.id);
  entry.meta.socket = socket;
  // New browser tab/refresh must start at wake — do not keep old "already answered" lock
  if (fromSocketId && fromSocketId !== socket.id) {
    resetWakeStateForNewClient(entry.meta);
  }
  liveSessions.set(socket.id, entry);
}

function resetWakeStateForNewClient(meta) {
  if (!meta) return;
  cancelRagPrefetch(meta);
  cancelInterruptHandoff(meta);
  meta.isActivated = false;
  meta.activatedAt = 0;
  meta.silenceAfterAnswer = false;
  meta.answerLockedThisTurn = false;
  meta.dropBotUntilSpeechEnd = false;
  meta.interruptedPending = false;
  meta.suppressOutput = false;
  meta.awaitingGreetingTurn = false;
  meta.greetTurnUnlocked = false;
  meta.greetNudgeSent = false;
  meta.discardSttUntilTurnComplete = false;
  meta.ignoreWakeUntil = 0;
  meta.wakePending = false;
  meta.userStreamBuffer = '';
  meta.userUtteranceBuffer = '';
  meta.lastEmittedUserStt = '';
  meta.assistantBuffer = '';
  meta.spokenTurnText = '';
  meta.llmTopicSetThisTurn = false;
  meta.lockedPdfKey = null;
  console.log('[live] Rebound client reset — waiting for activation keyword');
}

function msBetween(start, end = Date.now()) {
  if (!start) return null;
  return Math.max(0, end - start);
}

function formatMs(ms) {
  if (ms == null) return 'n/a';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms}ms`;
}

function cancelInterruptHandoff(meta) {
  if (meta?.interruptHandoffTimer) {
    clearTimeout(meta.interruptHandoffTimer);
    meta.interruptHandoffTimer = null;
  }
}

function beginUserInterrupt(meta, reason = 'barge-in') {
  if (!meta?.isActivated) return;
  cancelRagPrefetch(meta);
  cancelInterruptHandoff(meta);
  meta.interruptedPending = true;
  meta.dropBotUntilSpeechEnd = true;
  meta.assistantBuffer = '';
  meta.spokenTurnText = '';
  meta.deferredShowImageIds = [];
  meta.topicDispatchedThisTurn = false;
  meta.botResponseTurnId = null;
  if (meta.isActivated) {
    meta.userStreamBuffer = '';
    meta.lastEmittedUserStt = '';
    meta.userUtteranceBuffer = '';
  }
  console.log(`[live] Interrupt — stop previous answer (${reason})`);
}

function sendInterruptHandoff(meta) {
  if (!meta?.interruptedPending || !meta.geminiSession) return;
  const spoken = cleanTranscriptNoise(
    meta.userStreamBuffer || meta.userUtteranceBuffer || meta.pendingRagQuery || ''
  );
  if (!spoken || spoken.length < 3) return;

  meta.interruptedPending = false;
  meta.dropBotUntilSpeechEnd = false;
  cancelInterruptHandoff(meta);

  try {
    meta.geminiSession.sendClientContent({
      turns: [{
        role: 'user',
        parts: [{
          text:
            '[USER_INTERRUPT] Your previous spoken answer is finished — stop as if you reached ".", "!" or "?". '
            + 'Do NOT continue, resume, or repeat that answer. '
            + `Answer ONLY this new visitor question (Roman): "${toRomanDisplay(spoken)}".`,
        }],
      }],
      turnComplete: true,
    });
    console.log(`[live] Interrupt handoff → new question "${toRomanDisplay(spoken).slice(0, 80)}"`);
  } catch (err) {
    console.warn('[live] Interrupt handoff failed:', err.message);
  }
}

function scheduleInterruptHandoff(meta, delayMs = 450) {
  if (!meta?.interruptedPending) return;
  cancelInterruptHandoff(meta);
  const turnId = meta.latency?.turnId || 0;
  meta.interruptHandoffTimer = setTimeout(() => {
    meta.interruptHandoffTimer = null;
    if ((meta.latency?.turnId || 0) !== turnId) return;
    sendInterruptHandoff(meta);
  }, delayMs);
}

function cancelRagPrefetch(meta) {
  if (meta?.ragPrefetchTimer) {
    clearTimeout(meta.ragPrefetchTimer);
    meta.ragPrefetchTimer = null;
  }
}

/** Drop slideshow from the previous question so AC slides don't leak into a Solar answer. */
function clearSlideshowForNewQuestion(meta) {
  meta.fullPdfPool = [];
  meta.pendingSlideshow = [];
  meta.currentSlideshow = [];
  meta.lastShownImageId = null;
  meta.slideshowEmittedKey = null;
  meta.lastSpeechSyncLen = 0;
  meta.lastImageSyncAt = 0;
  meta.imageShownThisTurn = false;
  meta.deferredShowImageIds = [];
  meta.topicDispatchedThisTurn = false;
}

function resetTurnLatency(meta, reason = '') {
  cancelRagPrefetch(meta);
  meta.turnRagCache = null;
  meta.ragPrefetchInFlight = false;
  meta.pendingRagQuery = '';
  meta.lockedPdfKey = null;
  meta.llmTopicSetThisTurn = false;
  meta.answerLockedThisTurn = false;
  meta.silenceAfterAnswer = false;
  meta.latency = {
    turnId: (meta.latency?.turnId || 0) + 1,
    reason: reason || '',
    userAudioStartAt: 0,
    lastUserAudioAt: 0,
    userSpeechEndAt: 0,
    firstUserSttAt: 0,
    firstModelAudioAt: 0,
    firstModelTextAt: 0,
    turnCompleteAt: 0,
    firstUplinkAt: 0,
    firstUplinkHopMs: null,
    ragStartedAt: 0,
    ragMs: null,
    wakeReceivedAt: 0,
    loggedFirstAudio: false,
    loggedComplete: false,
    loggedUplinkHop: false,
  };
}

function speakDurationMs(L) {
  if (!L?.userAudioStartAt) return null;
  const end = L.userSpeechEndAt || L.lastUserAudioAt || 0;
  if (!end) return null;
  return Math.max(0, end - L.userAudioStartAt);
}

function emitLatency(meta, phase, extra = {}) {
  const L = meta.latency || {};
  const now = Date.now();
  const payload = {
    type: 'latency',
    phase,
    turnId: L.turnId || 0,
    serverNow: now,
    speakDurationMs: speakDurationMs(L),
    feToBeHopMs: L.firstUplinkHopMs,
    ragMs: L.ragMs,
    sinceUserAudioStartMs: msBetween(L.userAudioStartAt, now),
    sinceUserSpeechEndMs: msBetween(L.userSpeechEndAt, now),
    userAudioToFirstSttMs: msBetween(L.userAudioStartAt, L.firstUserSttAt),
    speechEndToFirstSttMs: msBetween(L.userSpeechEndAt, L.firstUserSttAt),
    userAudioToFirstBotAudioMs: msBetween(L.userAudioStartAt, L.firstModelAudioAt),
    speechEndToFirstBotAudioMs: msBetween(L.userSpeechEndAt, L.firstModelAudioAt),
    speechEndToFirstBotTextMs: msBetween(L.userSpeechEndAt, L.firstModelTextAt),
    userAudioToTurnCompleteMs: msBetween(L.userAudioStartAt, L.turnCompleteAt || now),
    speechEndToTurnCompleteMs: msBetween(L.userSpeechEndAt, L.turnCompleteAt || now),
    ...extra,
  };

  const hop = payload.feToBeHopMs != null ? payload.feToBeHopMs : extra.feToBeHopMs;
  console.log(
    `[LATENCY][BE] turn#${payload.turnId} ${phase}`
    + ` | spoke ${formatMs(payload.speakDurationMs)}`
    + ` | FE→BE hop ${formatMs(hop ?? extra.feToBeHopMs)}`
    + ` | speechEnd→STT ${formatMs(payload.speechEndToFirstSttMs)}`
    + ` | speechEnd→botAudio ${formatMs(payload.speechEndToFirstBotAudioMs)}`
    + ` | RAG ${formatMs(payload.ragMs)}`
    + ` | audio→done ${formatMs(payload.userAudioToTurnCompleteMs)}`
    + (extra.detail ? ` | ${extra.detail}` : '')
  );

  try {
    emitJson(meta.socket, payload);
  } catch {
    /* ignore */
  }
}

function markUserSpeechStart(meta, source = 'uplink') {
  if (!meta) return;
  if (!meta.latency) resetTurnLatency(meta, 'init');

  const L = meta.latency;
  const openTurn = L.userAudioStartAt && !L.turnCompleteAt && !L.firstModelAudioAt;
  const previousEnded = Boolean(L.userSpeechEndAt);
  // Same open utterance — ignore duplicate VAD starts. After a pause, start a new turn.
  if (openTurn && !previousEnded) {
    L.lastUserAudioAt = Date.now();
    return;
  }

  const interrupting = Boolean(
    meta.isActivated
    && !meta.awaitingGreetingTurn
    && L.firstModelAudioAt
    && !L.turnCompleteAt
  );

  resetTurnLatency(meta, source);
  meta.botResponseTurnId = null;
  meta.topicDispatchedThisTurn = false;
  meta.imageShownThisTurn = false;
  meta.deferredShowImageIds = [];
  if (interrupting || meta.interruptedPending) {
    beginUserInterrupt(meta, source);
  }
  meta.latency.userAudioStartAt = Date.now();
  meta.latency.lastUserAudioAt = meta.latency.userAudioStartAt;
  console.log(`[LATENCY][BE] turn#${meta.latency.turnId} USER question started (${source})`);
  emitLatency(meta, 'user_audio_start', { detail: source });
}

function markUserAudioChunk(meta) {
  if (!meta?.isActivated) return;
  if (!meta.latency) resetTurnLatency(meta, 'init');
  const L = meta.latency;
  // Continuous PCM uplink includes silence — do NOT start turns from every chunk.
  // Only refresh timestamp while a turn is already open.
  if (L.userAudioStartAt && !L.turnCompleteAt) {
    L.lastUserAudioAt = Date.now();
  }
}

function markUserSpeechEnd(meta, source = 'client') {
  if (!meta?.latency) return;
  const L = meta.latency;
  if (!L.userAudioStartAt) {
    markUserSpeechStart(meta, `speech_end_implies_start:${source}`);
  }
  if (L.userSpeechEndAt) return;
  L.userSpeechEndAt = Date.now();
  meta.botAnswerForTurnId = L.turnId;
  const spoke = speakDurationMs(L);
  const likelyEcho = !L.firstUserSttAt && spoke != null && spoke < 900;
  if (meta.interruptedPending) {
    if (likelyEcho) {
      meta.dropBotUntilSpeechEnd = true;
    } else {
      scheduleInterruptHandoff(meta, 450);
    }
  } else {
    meta.dropBotUntilSpeechEnd = false;
  }
  console.log(
    `[LATENCY][BE] turn#${L.turnId} USER speech end (${source}) — spoke ${formatMs(spoke)}`
  );
  emitLatency(meta, 'user_speech_end', { detail: source, speakDurationMs: spoke });
}

function markFirstUserStt(meta, text) {
  if (!meta?.latency) return;
  const L = meta.latency;
  if (!L.userAudioStartAt || L.turnCompleteAt) {
    markUserSpeechStart(meta, 'first_stt');
  }
  if (L.firstUserSttAt) return;
  L.firstUserSttAt = Date.now();
  emitLatency(meta, 'first_user_stt', { detail: String(text || '').slice(0, 80) });
}

function markFirstModelAudio(meta) {
  if (!meta?.latency) return;
  const L = meta.latency;
  if (L.firstModelAudioAt) return;
  L.firstModelAudioAt = Date.now();
  L.loggedFirstAudio = true;
  if (meta.botResponseTurnId == null) {
    meta.botResponseTurnId = L.turnId;
  }
  meta.answerLockedThisTurn = true;
  emitLatency(meta, 'first_bot_audio', {
    detail: `LLM first audio after speech-end ${formatMs(msBetween(L.userSpeechEndAt))}`,
  });
}

function markFirstModelText(meta) {
  if (!meta?.latency) return;
  const L = meta.latency;
  if (L.firstModelTextAt) return;
  L.firstModelTextAt = Date.now();
  if (meta.botResponseTurnId == null) {
    meta.botResponseTurnId = L.turnId;
  }
  meta.answerLockedThisTurn = true;
  emitLatency(meta, 'first_bot_text');
}

function isStaleBotTurnComplete(meta) {
  const currentTurn = meta.latency?.turnId ?? 0;
  if (meta.botResponseTurnId != null && currentTurn > meta.botResponseTurnId) {
    return true;
  }
  if (meta.botAnswerForTurnId != null && currentTurn > meta.botAnswerForTurnId) {
    return true;
  }
  return false;
}

function markTurnCompleteLatency(meta) {
  if (!meta?.latency) return;
  const L = meta.latency;
  if (L.loggedComplete) return;
  L.turnCompleteAt = Date.now();
  L.loggedComplete = true;
  emitLatency(meta, 'turn_complete');
  console.log(
    `[LATENCY][BE] SUMMARY turn#${L.turnId}`
    + ` | user spoke ${formatMs(speakDurationMs(L))}`
    + ` | FE→BE hop ${formatMs(L.firstUplinkHopMs)}`
    + ` | speechEnd→STT ${formatMs(msBetween(L.userSpeechEndAt, L.firstUserSttAt))}`
    + ` | speechEnd→RAG ${formatMs(L.ragMs)}`
    + ` | speechEnd→LLM audio ${formatMs(msBetween(L.userSpeechEndAt, L.firstModelAudioAt))}`
    + ` | speechEnd→done ${formatMs(msBetween(L.userSpeechEndAt, L.turnCompleteAt))}`
  );
}

function normalizeModelId(model) {
  return String(model || '').replace(/^models\//, '');
}

function emitJson(socket, payload) {
  socket.emit('live:event', payload);
}

function getLiveModelCandidates(preferredModel) {
  const tried = new Set();
  return [
    normalizeModelId(preferredModel),
    ...FALLBACK_LIVE_MODELS.map(normalizeModelId),
  ].filter((m) => m && !tried.has(m) && tried.add(m));
}

function createSessionMeta(socket, chatbot) {
  const { catalog, topics } = buildNumberedImageCatalog(chatbot);
  return {
    socket,
    chatbot,
    chatbotId: String(chatbot._id),
    sessionId: socket.id,
    catalog,
    topics,
    currentSlideshow: [],
    fullPdfPool: [],
    pendingSlideshow: null,
    pendingPdfName: null,
    pendingPdfKey: null,
    lockedPdfKey: null,
    slideshowEmittedKey: null,
    assistantBuffer: '',
    spokenTurnText: '',
    imageShownThisTurn: false,
    lastShownImageId: null,
    lastSpeechSyncLen: 0,
    lastImageSyncAt: 0,
    deferredShowImageIds: [],
    topicDispatchedThisTurn: false,
    leadDraft: { name: '', company: '', designation: '', phone: '', email: '' },
    leadFormShown: false,
    leadDraftLocked: false,
    cameraOpened: false,
    leadSaveInFlight: false,
    topicCounts: {},
    isActivated: false,
    activatedAt: 0,
    wakePending: false,
    wakeClassifyInFlight: false,
    wakeAttemptId: 0,
    wakeSpeakMs: null,
    ignoreWakeUntil: 0,
    suppressOutput: false,
    micEnabled: false,
    userUtteranceBuffer: '',
    userStreamBuffer: '',
    lastEmittedUserStt: '',
    greetNudgeSent: false,
    awaitingGreetingTurn: false,
    discardSttUntilTurnComplete: false,
    greetTurnUnlocked: false,
    turnRagCache: null,
    ragPrefetchInFlight: false,
    ragPrefetchTimer: null,
    pendingRagQuery: '',
    llmTopicSetThisTurn: false,
    answerLockedThisTurn: false,
    silenceAfterAnswer: false,
    dropBotUntilSpeechEnd: false,
    interruptedPending: false,
    interruptHandoffTimer: null,
    botResponseTurnId: null,
    botAnswerForTurnId: null,
    lastSpeechEndAt: 0,
    wakeActivationTimer: null,
    wakeAudioEndTimer: null,
    setupDone: false,
    geminiSession: null,
    model: null,
    overviewImageIds: [],
    latency: {
      turnId: 0,
      reason: '',
      userAudioStartAt: 0,
      lastUserAudioAt: 0,
      userSpeechEndAt: 0,
      firstUserSttAt: 0,
      firstModelAudioAt: 0,
      firstModelTextAt: 0,
      turnCompleteAt: 0,
      firstUplinkAt: 0,
      firstUplinkHopMs: null,
      ragStartedAt: 0,
      ragMs: null,
      wakeReceivedAt: 0,
      loggedFirstAudio: false,
      loggedComplete: false,
      loggedUplinkHop: false,
    },
  };
}

function cleanLeadValue(value) {
  return String(value || '')
    .replace(/^[\s:,-]+|[\s,.;]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLeadDetails(text) {
  const source = String(text || '');
  const details = {};

  const emails = [...source.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((m) => m[0]);
  if (emails.length) details.email = emails.join(', ');

  const phones = [...source.matchAll(/(?:\+?\d[\d\s().-]{6,}\d)/g)].map((m) => cleanLeadValue(m[0]));
  if (phones.length) details.phone = phones.join(', ');

  const nameMatch = source.match(
    /\b(?:my\s+name\s+is|name\s+is|i\s+am|i'm|this\s+is|mera\s+naam|mera\s+name)\s*(?:hai\s*)?[:\-]?\s*([A-Za-z\u0600-\u06FF][A-Za-z\u0600-\u06FF .'-]{1,60})(?=\s+(?:and|aur|phone|number|email|from|in|company|designation)\b|[,.;]|$)/i
  );
  if (nameMatch) details.name = cleanLeadValue(nameMatch[1]);

  // "mera naam Faraz hai" / bot read-back "naam Faraz,"
  if (!details.name) {
    const altName = source.match(
      /\b(?:naam|name)\s+([A-Za-z\u0600-\u06FF][A-Za-z\u0600-\u06FF .']{1,40}?)(?=\s+hai\b|\s*,|\s+company|\s+designation|\s+phone|\s+email|\s+aur\b|$)/i
    );
    if (altName) details.name = cleanLeadValue(altName[1]);
  }

  const companyMatch = source.match(
    /\b(?:company\s+(?:name\s+)?is|company\s+is|i\s+work\s+(?:at|for)|meri\s+company)\s*(?:hai\s*)?[:\-]?\s*([A-Za-z0-9\u0600-\u06FF][A-Za-z0-9\u0600-\u06FF .&'()-]{1,80})(?=\s+(?:and|aur|designation|phone|email)\b|[,.;]|$)/i
  );
  if (companyMatch) details.company = cleanLeadValue(companyMatch[1]);

  if (!details.company) {
    const altCo = source.match(
      /\bcompany\s+([A-Za-z0-9\u0600-\u06FF][A-Za-z0-9\u0600-\u06FF .&'-]{0,60}?)(?=\s*,|\s+designation|\s+phone|\s+email|\s+aur\b|$)/i
    );
    if (altCo) details.company = cleanLeadValue(altCo[1]);
  }

  const designationMatch = source.match(
    /\b(?:designation\s+is|job\s+title\s+is|title\s+is|role\s+is|mera\s+designation)\s*(?:hai\s*)?[:\-]?\s*([A-Za-z\u0600-\u06FF][A-Za-z\u0600-\u06FF .&'/-]{1,60})(?=\s+(?:and|aur|phone|email)\b|[,.;]|$)/i
  );
  if (designationMatch) details.designation = cleanLeadValue(designationMatch[1]);

  if (!details.designation) {
    const altDes = source.match(
      /\bdesignation\s+([A-Za-z\u0600-\u06FF][A-Za-z\u0600-\u06FF .&'/-]{0,40}?)(?=\s*,|\s+phone|\s+email|\s+aur\b|$)/i
    );
    if (altDes) details.designation = cleanLeadValue(altDes[1]);
  }

  return details;
}

function leadLooksReady(draft) {
  const d = draft || {};
  const name = String(d.name || '').trim();
  const phone = String(d.phone || '').trim();
  const email = String(d.email || '').trim();
  // Show once we have identity + at least one contact channel
  return Boolean(name && (phone || email));
}

/** Short verbal confirmation while form is on screen */
function isLeadConfirmYes(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/[^\w\s\u0600-\u06FF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.length > 72) return false;
  if (/\b(nahi|nahin|no|nope|galat|wrong|incorrect|change|fix|mat)\b/i.test(t)) {
    return false;
  }
  return /\b(yes|yeah|yep|yup|haan|han|haa|ha|sahi|theek|correct|confirm|ok|okay|bilkul)\b/i.test(t);
}

function mergeLeadDraft(meta, text, forceShow = false, { fromAssistant = false } = {}) {
  // Card-locked / on-screen form: never let bot read-back corrupt fields
  if (fromAssistant && (meta.leadDraftLocked || meta.leadFormShown)) return;

  const extracted = extractLeadDetails(text);
  if (!Object.keys(extracted).length && !forceShow) return;

  if (Object.keys(extracted).length) {
    meta.leadDraft = { ...meta.leadDraft, ...extracted };
    // User corrected a locked card form — unlock so updates stick for submit
    if (meta.leadDraftLocked && !fromAssistant) {
      meta.leadDraftLocked = false;
    }
  }

  const d = meta.leadDraft;
  if ((forceShow || leadLooksReady(d)) && !meta.leadFormShown) {
    meta.leadFormShown = true;
    emitJson(meta.socket, { type: 'show_lead_form', data: { ...d }, editable: false });
    console.log('[live] Lead form shown', d);
  } else if (meta.leadFormShown && Object.keys(extracted).length) {
    emitJson(meta.socket, { type: 'show_lead_form', data: { ...d }, editable: false });
  }
}

function emitLeadForm(meta, data, { editable = false, lock = false } = {}) {
  meta.leadFormShown = true;
  meta.leadDraft = { ...meta.leadDraft, ...(data || {}) };
  if (lock) meta.leadDraftLocked = true;
  emitJson(meta.socket, {
    type: 'show_lead_form',
    data: { ...meta.leadDraft },
    editable,
  });
  console.log('[live] Lead form emit', meta.leadDraft, lock ? '(locked)' : '');
}

function pickLeadFields(args, draft, preferDraft) {
  const a = args || {};
  const d = draft || {};
  const pick = (key) => {
    const fromArgs = String(a[key] || '').trim();
    const fromDraft = String(d[key] || '').trim();
    if (preferDraft && fromDraft) return fromDraft;
    return fromArgs || fromDraft;
  };
  return {
    name: pick('name'),
    company: pick('company'),
    designation: pick('designation'),
    phone: pick('phone'),
    email: pick('email'),
  };
}

function lockPdfKey(meta, pdfKey) {
  const key = String(pdfKey || '').trim();
  if (!key || key.toLowerCase() === 'general') return;
  meta.lockedPdfKey = key;
}

function poolForLockedPdf(meta) {
  const lock = meta.lockedPdfKey || meta.pendingPdfKey;
  if (!lock) return [];
  return (meta.catalog || []).filter((img) => img.pdfKey === lock);
}

function resolvePdfKeyForSearch(meta, rawPdfKey) {
  const raw = String(rawPdfKey || meta.pendingPdfKey || '').trim();
  if (!raw) return undefined;
  const result = resolveSlideshowForTopicKey(meta.catalog, meta.topics, raw);
  return result.matched ? result.pdfKey : undefined;
}

function inferPdfKeyFromQuery(query, topics) {
  const q = ` ${normalizeRagQuery(query, { topics }).toLowerCase()} `;
  const compact = String(query || '').replace(/\s+/g, '').toLowerCase();
  if (!q.trim() && !compact) return undefined;

  const word = (s) => new RegExp(`(?:^|[^a-z0-9])${String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`, 'i');

  const findTopic = (pred) => (topics || []).find(pred);

  if (
    /\b(ac[\s-]?kit|ackit|acki?t|sikt)\b/i.test(q)
    || /sikt|ackit|acki?t/.test(compact)
  ) {
    const ac = findTopic((t) => /ac|cooling|kit/i.test(`${t.displayName} ${t.pdfKey}`));
    if (ac) return ac.pdfKey;
  }

  if (
    /\b(solar|solos|cleaning|panel|solosistam|solarsystem|faayada|phaayada|benefit)\b/i.test(q)
    || /solosistam|solarsystem|solarpanel|autoclean/.test(compact)
  ) {
    const solar = findTopic((t) => /solar|easy/i.test(`${t.displayName} ${t.pdfKey}`));
    if (solar) return solar.pdfKey;
  }

  if (
    /\b(machinery|machines|machine|dashboard|centralized|ecosystem|multipl|venue|organization)\b/i.test(q)
    || /ecosystem|dashboard|machinery|centralized/.test(compact)
  ) {
    const eco = findTopic((t) => /ecosystem/i.test(`${t.displayName} ${t.pdfKey}`));
    if (eco) return eco.pdfKey;
  }

  for (const t of topics || []) {
    const name = String(t.displayName || '').replace(/\.pdf$/i, '').trim().toLowerCase();
    const keyPhrase = String(t.pdfKey || '').replace(/_/g, ' ').toLowerCase();
    if (name.length >= 4 && word(name).test(q)) return t.pdfKey;
    if (/\bgateway\b/.test(q) && /gateway/.test(name)) return t.pdfKey;
    if (/\bsolar\b/.test(q) && /solar/.test(name)) return t.pdfKey;
    if (/\bac\b/.test(q) && /ac|cooling/.test(name)) return t.pdfKey;
    if (keyPhrase.length >= 4 && word(keyPhrase).test(q)) return t.pdfKey;
  }
  return undefined;
}

function scheduleRagPrefetch(meta, rawQuery, delayMs = 700) {
  if (!meta?.isActivated || meta.leadFormShown || meta.awaitingGreetingTurn) return;
  const spoken = String(rawQuery || meta.userStreamBuffer || meta.userUtteranceBuffer || '').trim();
  if (!spoken || !shouldDispatchImagesForUtterance(spoken)) return;
  if (isActivationOnlyUtterance(spoken, meta.chatbot)) return;

  meta.pendingRagQuery = spoken;
  const turnId = meta.latency?.turnId || 0;
  cancelRagPrefetch(meta);

  meta.ragPrefetchTimer = setTimeout(() => {
    meta.ragPrefetchTimer = null;
    if ((meta.latency?.turnId || 0) !== turnId) return;
    const latest = String(meta.pendingRagQuery || meta.userStreamBuffer || '').trim();
    if (!latest) return;
    prefetchRagForUserQuestion(meta, latest, turnId).catch(() => {});
  }, delayMs);
}

async function prefetchRagForUserQuestion(meta, rawQuery, forTurnId) {
  const spoken = String(rawQuery || meta.userStreamBuffer || meta.userUtteranceBuffer || '').trim();
  if (!spoken || !meta.isActivated || meta.leadFormShown || meta.awaitingGreetingTurn) return;
  if (!shouldDispatchImagesForUtterance(spoken)) return;
  if (isActivationOnlyUtterance(spoken, meta.chatbot)) return;

  const turnId = forTurnId ?? meta.latency?.turnId ?? 0;
  if ((meta.latency?.turnId || 0) !== turnId) return;

  meta.ragPrefetchInFlight = true;
  meta.ragPrefetchTurnId = turnId;
  if (meta.latency && !meta.latency.ragStartedAt) {
    meta.latency.ragStartedAt = Date.now();
  }

  const pdfKey = resolvePdfKeyForSearch(meta, meta.pendingPdfKey)
    || (meta.llmTopicSetThisTurn ? meta.lockedPdfKey : undefined)
    || undefined;
  const pdfName = pdfKey
    ? meta.topics?.find((t) => t.pdfKey === pdfKey)?.displayName
    : undefined;

  try {
    const chunks = await searchKnowledgeChunks({
      chatbotId: meta.chatbotId,
      query: spoken,
      pdfKey,
      pdfName,
      topics: meta.topics,
      topK: 6,
    });

    if ((meta.latency?.turnId || 0) !== turnId) {
      console.log(`[live] Dropped stale RAG prefetch for turn#${turnId}`);
      return;
    }

    const ragMs = meta.latency?.ragStartedAt
      ? Date.now() - meta.latency.ragStartedAt
      : null;
    if (meta.latency && ragMs != null) {
      meta.latency.ragMs = ragMs;
      emitLatency(meta, 'rag_done', {
        ragMs,
        detail: `${chunks.length} chunk(s) prefetch ${formatMs(ragMs)}`,
      });
    }

    meta.turnRagCache = {
      query: normalizeRagQuery(spoken, { topics: meta.topics, pdfName, pdfKey }),
      rawQuery: spoken,
      pdfKey,
      chunks,
      at: Date.now(),
    };

    // Do NOT inject RAG as a new user turn — that makes Gemini answer twice.
  } catch (err) {
    console.warn('[live] prefetch RAG failed:', err.message);
  } finally {
    meta.ragPrefetchInFlight = false;
  }
}

function applyOverviewImagePool(meta) {
  const ids = Array.isArray(meta.overviewImageIds) ? meta.overviewImageIds : [];
  if (!ids.length) return;
  const images = ids
    .map((id) => findCatalogImageById(meta.catalog, id))
    .filter(Boolean);
  if (!images.length) return;
  meta.pendingSlideshow = images;
  meta.fullPdfPool = images;
  meta.pendingPdfName = images[0]?.pdfName || null;
  meta.pendingPdfKey = images[0]?.pdfKey || 'general';
}

/** Clear slideshow on frontend — show chatbot onboarding / display image. */
function showOnboardingDisplay(meta, reason = 'general') {
  if (meta.leadFormShown) return;
  meta.currentSlideshow = [];
  meta.pendingSlideshow = [];
  meta.fullPdfPool = [];
  meta.slideshowEmittedKey = 'onboarding';
  meta.lastShownImageId = null;
  meta.pendingPdfKey = null;
  meta.pendingPdfName = null;
  emitJson(meta.socket, { type: 'show_onboarding', reason });
}

/** Collect unique catalog images linked to retrieved vector chunks. */
function collectImagesFromRagChunks(chunks, catalog) {
  const seen = new Set();
  const images = [];
  for (const chunk of chunks || []) {
    for (const rawId of chunk.relatedImageIds || []) {
      const id = Number(rawId);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const img = findCatalogImageById(catalog, id);
      if (img) images.push(img);
    }
  }
  return images;
}

/** Emit full slideshow pool to frontend (after LLM picks topic). */
function emitSlideshowPool(meta, result, initialSlideIndex = 0) {
  if (!result?.images?.length) return;
  const poolKey = `${result.pdfKey}:all`;
  const alreadyShowing = meta.slideshowEmittedKey === poolKey;
  meta.slideshowEmittedKey = poolKey;
  meta.currentSlideshow = result.images;
  meta.pendingSlideshow = result.images;
  meta.fullPdfPool = result.images;
  meta.pendingPdfKey = result.pdfKey;
  meta.pendingPdfName = result.pdfName;
  if (alreadyShowing) return;
  emitJson(meta.socket, {
    type: 'images',
    images: result.images.map(formatImageForFrontend),
    pdfName: result.pdfName,
    pdfKey: result.pdfKey,
    replace: true,
    holdCarouselMs: 0,
    autoAdvance: false,
    initialSlideIndex: Math.max(0, initialSlideIndex),
  });
}

/**
 * LLM → backend: load slideshow for the topic the model chose (authoritative).
 * Called from setPresentationTopic tool or [[TOPIC:]] marker.
 */
function applyPresentationTopic(meta, topicKey, imageId = null, options = {}) {
  if (meta.leadFormShown) {
    return { success: false, reason: 'lead_form_active' };
  }

  const topicNorm = String(topicKey || '').trim().toLowerCase();
  if (!topicNorm || topicNorm === 'general') {
    showOnboardingDisplay(meta, 'general_topic');
    meta.llmTopicSetThisTurn = true;
    return { success: true, pdfKey: 'general', imageCount: 0 };
  }

  const result = resolveSlideshowForTopicKey(meta.catalog, meta.topics, topicKey);
  if (!result.matched || !result.images.length) {
    if (meta.isActivated && !meta.leadFormShown) {
      showOnboardingDisplay(meta, 'unknown_topic');
    }
    return { success: false, pdfKey: topicKey, reason: 'no_pdf_match' };
  }

  lockPdfKey(meta, result.pdfKey);
  meta.llmTopicSetThisTurn = true;
  emitSlideshowPool(meta, result);

  let targetId = imageId != null ? Number(imageId) : null;
  const inCatalog = targetId && findCatalogImageById(meta.catalog, targetId);
  if (inCatalog && inCatalog.pdfKey !== result.pdfKey) {
    targetId = null;
  }
  if (!targetId) {
    const related = collectImagesFromRagChunks(meta.turnRagCache?.chunks || [], meta.catalog)
      .filter((img) => img.pdfKey === result.pdfKey);
    targetId = related[0]?.id || result.images[0]?.id;
  }

  if (targetId) {
    emitImageSync(meta, targetId, { force: true });
    meta.imageShownThisTurn = true;
  }
  flushDeferredShowImages(meta, true);

  console.log(
    `[live] LLM topic "${topicKey}" → ${result.images.length} image(s) from "${result.pdfName}"`
    + (targetId ? ` | showing id=${targetId}` : '')
  );

  return {
    success: true,
    pdfKey: result.pdfKey,
    pdfName: result.pdfName,
    imageCount: result.images.length,
    shownImageId: targetId,
  };
}

/**
 * [[TOPIC: pdfKey]] from assistant response only.
 * Prepares the image pool — does NOT flash wrong slides.
 * Visible images appear when [[SHOW_IMAGE:N]] fires.
 */
function dispatchSlideshowForTopic(meta, topicKey, options = {}) {
  applyPresentationTopic(meta, topicKey, options.imageId ?? null, options);
}

/**
 * Show a related-section cluster for what the LLM is saying.
 * 1 related image → single; many → carousel of that section only (not whole PDF).
 */
function emitImageSync(meta, catalogImageId, options = {}) {
  const fromSpeech = Boolean(options.fromSpeech);
  const recentSpeech = String(options.speechText || meta.spokenTurnText || '').trim();
  let locked = meta.lockedPdfKey || meta.pendingPdfKey;

  let pdfPool = Array.isArray(meta.pendingSlideshow) && meta.pendingSlideshow.length
    ? meta.pendingSlideshow
    : Array.isArray(meta.fullPdfPool) && meta.fullPdfPool.length
      ? meta.fullPdfPool
      : Array.isArray(meta.currentSlideshow) && meta.currentSlideshow.length
        ? meta.currentSlideshow
        : [];

  if (locked) {
    pdfPool = (meta.catalog || []).filter((img) => img.pdfKey === locked);
  }

  const preferred = findCatalogImageById(meta.catalog, catalogImageId);
  if (preferred && locked && preferred.pdfKey !== locked) {
    console.log(
      `[live] Topic switch SHOW_IMAGE:${catalogImageId} ${locked} → ${preferred.pdfKey}`
    );
    applyPresentationTopic(meta, preferred.pdfKey, preferred.id, { allowSwitch: true, fromLlm: true });
    return;
  }

  if (preferred && (!pdfPool.length || !pdfPool.some((img) => img.pdfKey === preferred.pdfKey))) {
    pdfPool = (meta.catalog || []).filter((img) => img.pdfKey === preferred.pdfKey);
  }
  if (!pdfPool.length && preferred) {
    pdfPool = (meta.catalog || []).filter((img) => img.pdfKey === preferred.pdfKey);
  }

  const picked = pickClusterForSpeech(
    pdfPool.length ? pdfPool : (locked ? poolForLockedPdf(meta) : []),
    recentSpeech,
    catalogImageId
  );

  const target = picked?.focus
    || preferred
    || findCatalogImageById(meta.catalog, catalogImageId);

  if (!target) {
    console.warn(`[live] SHOW_IMAGE:${catalogImageId} — not found in catalog`);
    return;
  }

  const poolKey = `${target.pdfKey}:all`;
  const needEmitImages = meta.slideshowEmittedKey !== poolKey;
  const prevShownId = meta.lastShownImageId;
  if (!options.force && Number(prevShownId) === Number(target.id) && !needEmitImages) {
    return;
  }

  const cluster = (picked?.cluster?.length ? picked.cluster : [target]);
  if (Number(target.id) !== Number(catalogImageId) || fromSpeech) {
    console.log(
      `[live] IMAGE cluster ${cluster.length} slide(s) focus=${target.id} "${String(target.topic).slice(0, 50)}"${fromSpeech ? ' (speech)' : ''}`
    );
  }

  meta.fullPdfPool = pdfPool.length
    ? pdfPool
    : (meta.catalog || []).filter((img) => img.pdfKey === target.pdfKey);

  const displayPool = meta.fullPdfPool.length ? meta.fullPdfPool : cluster;
  const slideIndex = Math.max(0, displayPool.findIndex((img) => Number(img.id) === Number(target.id)));

  meta.currentSlideshow = displayPool;
  meta.pendingSlideshow = meta.fullPdfPool;
  meta.pendingPdfKey = target.pdfKey;
  meta.pendingPdfName = target.pdfName;
  meta.imageShownThisTurn = true;
  meta.lastShownImageId = target.id;
  meta.lastImageSyncAt = Date.now();

  if (needEmitImages) {
    meta.slideshowEmittedKey = poolKey;
    emitJson(meta.socket, {
      type: 'images',
      images: displayPool.map(formatImageForFrontend),
      pdfName: target.pdfName,
      pdfKey: target.pdfKey,
      replace: true,
      holdCarouselMs: 0,
      autoAdvance: false,
      initialSlideIndex: Math.max(0, slideIndex),
    });
  }

  if (needEmitImages || Number(prevShownId) !== Number(target.id)) {
    emitJson(meta.socket, {
      type: 'image_sync',
      imageId: target.id,
      slideIndex: Math.max(0, slideIndex),
      pdfName: target.pdfName,
      timestamp: Date.now(),
    });
    console.log(
      `[live] SHOW → slide ${slideIndex + 1}/${cluster.length} id=${target.id} "${String(target.topic).slice(0, 55)}"`
    );
  }
}

/** Progressive sync: as LLM speaks, switch section cluster to match recent words. */
function syncImagesFromRecentSpeech(meta, force = false) {
  const spoken = String(meta.spokenTurnText || '').trim();
  if (spoken.length < 30) return;

  const sinceLast = spoken.length - (meta.lastSpeechSyncLen || 0);
  if (!force && sinceLast < 50) return;
  if (!force && meta.lastImageSyncAt && Date.now() - meta.lastImageSyncAt < 1500) return;
  meta.lastSpeechSyncLen = spoken.length;

  const recent = spoken.slice(-200);
  const pdfPool = Array.isArray(meta.fullPdfPool) && meta.fullPdfPool.length
    ? meta.fullPdfPool
    : Array.isArray(meta.pendingSlideshow) && meta.pendingSlideshow.length
      ? meta.pendingSlideshow
      : Array.isArray(meta.currentSlideshow) && meta.currentSlideshow.length
        ? meta.currentSlideshow
        : [];

  if (!pdfPool.length) return;

  const picked = pickClusterForSpeech(pdfPool, recent, meta.lastShownImageId);
  if (!picked?.focus) return;

  const focusScore = scoreImageAgainstSpeech(picked.focus, recent);
  if (focusScore < 2 && !force) return;

  const newKey = `${picked.focus.pdfKey}:sec:${picked.cluster.map((i) => i.id).join(',')}`;
  if (
    !force
    && Number(meta.lastShownImageId) === Number(picked.focus.id)
    && meta.slideshowEmittedKey === newKey
  ) {
    return;
  }

  emitImageSync(meta, picked.focus.id, { fromSpeech: true, speechText: recent });
}

/** If model never emitted SHOW_IMAGE, pick best cluster from spoken answer. */
function autoSyncImageFromSpeech(meta) {
  if (meta.imageShownThisTurn) {
    syncImagesFromRecentSpeech(meta, true);
    return;
  }
  const spoken = String(meta.spokenTurnText || '').trim();
  if (spoken.length < 24) return;

  const pool = Array.isArray(meta.pendingSlideshow) && meta.pendingSlideshow.length
    ? meta.pendingSlideshow
    : Array.isArray(meta.fullPdfPool) && meta.fullPdfPool.length
      ? meta.fullPdfPool
      : Array.isArray(meta.currentSlideshow) && meta.currentSlideshow.length
        ? meta.currentSlideshow
        : [];

  if (!pool.length) return;

  const best = pickBestImageForSpeech(pool, spoken);
  if (!best) return;

  console.log(`[live] Auto image from speech → ${best.id} "${String(best.topic).slice(0, 50)}"`);
  emitImageSync(meta, best.id, { fromSpeech: true, speechText: spoken });
}

/** Flush SHOW_IMAGE ids that arrived before enough spoken text existed. */
function flushDeferredShowImages(meta, force = false) {
  const queue = Array.isArray(meta.deferredShowImageIds) ? meta.deferredShowImageIds : [];
  if (!queue.length) return;

  const spokenLen = String(meta.spokenTurnText || '').trim().length;
  if (!force && spokenLen < 40) return;

  meta.deferredShowImageIds = [];
  const lastId = queue[queue.length - 1];
  if (lastId) emitImageSync(meta, lastId);
}

/** After full answer text is known, fix a clearly wrong slide. */
function revalidateShownImage(meta) {
  syncImagesFromRecentSpeech(meta, true);
}

function parseAssistantMarkers(meta, chunkText) {
  meta.assistantBuffer = appendTranscript(meta.assistantBuffer, chunkText);
  let buffer = meta.assistantBuffer;

  // Process every [[TOPIC:]] — LLM may switch product mid-answer (Gateway then Ecosystem)
  let topicMatch;
  while ((topicMatch = buffer.match(/\[\[TOPIC:\s*([^\]]+?)\]\]/i))) {
    const topic = topicMatch[1].trim();
    buffer = buffer.replace(topicMatch[0], '');
    const key = topic.toLowerCase();
    if (key !== 'general') {
      meta.topicCounts[key] = (meta.topicCounts[key] || 0) + 1;
    }
    if (!meta.awaitingGreetingTurn || key === 'general') {
      dispatchSlideshowForTopic(meta, topic, { fromLlm: true, force: true, allowSwitch: true });
    }
  }

  // SHOW_IMAGE follows whatever product the LLM is talking about now
  let imageMatch;
  while ((imageMatch = buffer.match(/\[\[SHOW_IMAGE:(\d+)\]\]/i))) {
    const imageId = parseInt(imageMatch[1], 10);
    buffer = buffer.replace(imageMatch[0], '');
    if (String(meta.spokenTurnText || '').trim().length < 24) {
      if (!Array.isArray(meta.deferredShowImageIds)) meta.deferredShowImageIds = [];
      meta.deferredShowImageIds.push(imageId);
    } else {
      emitImageSync(meta, imageId, { fromLlm: true, force: true });
    }
  }

  const leadFormMatch = buffer.match(/\[SHOW_LEAD_FORM(.*?)\]/i);
  if (leadFormMatch) {
    const inner = leadFormMatch[1].trim();
    let leadData = null;

    if (inner.startsWith('|')) {
      const args = inner.substring(1).split('|').map((s) => s.trim());
      leadData = {
        name: args[0] && args[0].toUpperCase() !== 'N/A' ? args[0] : '',
        company: args[1] && args[1].toUpperCase() !== 'N/A' ? args[1] : '',
        designation: args[2] && args[2].toUpperCase() !== 'N/A' ? args[2] : '',
        phone: args[3] && args[3].toUpperCase() !== 'N/A' ? args[3] : '',
        email: args[4] && args[4].toUpperCase() !== 'N/A' ? args[4] : '',
      };
      meta.leadDraft = { ...meta.leadDraft, ...leadData };
    }

    buffer = buffer.replace(leadFormMatch[0], '');
    emitLeadForm(meta, leadData || { ...meta.leadDraft });
  }

  const cameraMatch = buffer.match(/\[ACTIVATE_CAMERA\]/i);
  if (cameraMatch) {
    buffer = buffer.replace(cameraMatch[0], '');
    // One camera open per lead attempt — ignore repeat markers (stops photo spam)
    if (!meta.cameraOpened && !meta.leadFormShown) {
      meta.cameraOpened = true;
      emitJson(meta.socket, { type: 'activate_camera' });
      emitJson(meta.socket, { type: 'transcript', role: 'assistant', text: '[ACTIVATE_CAMERA]' });
    } else {
      console.log('[live] Ignoring duplicate [ACTIVATE_CAMERA]');
    }
  }

  meta.assistantBuffer = buffer;

  const cleaned = chunkText
    .replace(/\[\[SHOW_IMAGE:\d+\]\]/gi, '')
    .replace(/\[\[TOPIC:\s*[^\]]+?\]\]/gi, '')
    .replace(/\[SHOW_LEAD_FORM.*?\]/gi, '')
    .replace(/\[ACTIVATE_CAMERA\]/gi, '');

  const spokenBit = String(cleaned || '').replace(/\s+/g, ' ').trim();
  if (spokenBit) {
    meta.spokenTurnText = appendTranscript(meta.spokenTurnText || '', spokenBit);
    flushDeferredShowImages(meta, false);
    // Do NOT sync images on every STT chunk — only at turn end or via RAG/SHOW_IMAGE.
  }

  return { cleaned };
}

async function handleToolCall(toolCall, meta) {
  const calls = toolCall?.functionCalls || [];
  const responses = [];
  let leadSaved = false;

  for (const call of calls) {
    if (call.name === 'submitLead') {
      if (meta.leadSaveInFlight) {
        responses.push({
          id: call.id,
          name: call.name,
          response: { result: 'Lead save already in progress.', saved: false },
        });
        continue;
      }

      const args = call.args || {};
      // Prefer locked card draft so bot speech never corrupts email/phone
      const leadData = pickLeadFields(args, meta.leadDraft, Boolean(meta.leadDraftLocked));

      // Never save silently — form must appear on screen for visitor to verify first
      if (!meta.leadFormShown) {
        emitLeadForm(meta, leadData);
        responses.push({
          id: call.id,
          name: call.name,
          response: {
            result:
              'Lead form is now on screen. Read Name, Company, Designation, Phone, Email once in the SAME voice. '
              + 'Ask "Kya yeh details sahi hain?" Call submitLead again ONLY after they say yes — use the EXACT on-screen values.',
            formShown: true,
            saved: false,
            fields: leadData,
          },
        });
        console.log('[live] submitLead blocked — form shown for confirmation first', leadData);
        continue;
      }

      meta.leadSaveInFlight = true;
      try {
        const t0 = Date.now();
        const lead = await saveLead({
          name: leadData.name,
          company: leadData.company,
          designation: leadData.designation,
          phone: leadData.phone,
          email: leadData.email,
          chatbotId: meta.chatbotId,
          sessionId: meta.sessionId,
          topic_counts: meta.topicCounts,
        });

        emitJson(meta.socket, {
          type: 'lead_saved',
          lead: {
            id: lead._id,
            name: lead.name,
            company: lead.company,
            designation: lead.designation,
            phone: lead.phone,
            email: lead.email,
          },
        });

        leadSaved = true;
        responses.push({
          id: call.id,
          name: call.name,
          response: {
            result: 'Lead saved successfully. Say a brief thank-you in the SAME voice, then stop.',
            leadId: String(lead._id),
          },
        });

        console.log(`[live] Lead saved in ${Date.now() - t0}ms: ${lead.name} | bot ${meta.chatbot.name}`);
      } catch (err) {
        meta.leadSaveInFlight = false;
        responses.push({
          id: call.id,
          name: call.name,
          response: { error: err.message },
        });
      }
    } else if (call.name === 'searchKnowledgeBase') {
      const args = call.args || {};
      const query = String(args.query || '').trim();
      const pdfKey = String(args.pdfKey || '').trim() || undefined;

      if (meta.silenceAfterAnswer || meta.dropBotUntilSpeechEnd) {
        responses.push({
          id: call.id,
          name: call.name,
          response: {
            result: 'STOP. The spoken answer is already done. Output NO more audio. Do not repeat. Do not search.',
            matchCount: 0,
            skip: true,
          },
        });
        console.log('[live] searchKnowledgeBase skipped — answer already finished');
        continue;
      }

      if (meta.answerLockedThisTurn) {
        responses.push({
          id: call.id,
          name: call.name,
          response: {
            result:
              'STOP. You already started speaking this answer. Do NOT restart. Do NOT produce a second full answer. Finish the current sentence only, then silence.',
            matchCount: 0,
            skip: true,
          },
        });
        console.log('[live] searchKnowledgeBase skipped — already speaking this turn');
        continue;
      }

      if (
        meta.awaitingGreetingTurn
        || (
          meta.activatedAt
          && Date.now() - meta.activatedAt < 12000
          && isActivationOnlyUtterance(meta.userUtteranceBuffer || query, meta.chatbot)
        )
      ) {
        responses.push({
          id: call.id,
          name: call.name,
          response: {
            result: 'SKIP — visitor only said the wake phrase. Greet briefly; do not search yet.',
            matchCount: 0,
          },
        });
        continue;
      }

      try {
        if (meta.latency) {
          meta.latency.ragStartedAt = Date.now();
        }
        emitLatency(meta, 'rag_start', { detail: query.slice(0, 80) });
        const t0 = Date.now();

        const resolvedPdfKey = pdfKey
          ? resolvePdfKeyForSearch(meta, pdfKey)
          : undefined;
        const pdfName = resolvedPdfKey
          ? meta.topics?.find((t) => t.pdfKey === resolvedPdfKey)?.displayName
          : undefined;
        const spokenQuery = query || String(meta.userUtteranceBuffer || meta.spokenTurnText || '').trim();

        const cache = meta.turnRagCache;
        const cacheFresh = cache?.chunks?.length
          && Date.now() - (cache.at || 0) < 45000
          && (
            !spokenQuery
            || normalizeRagQuery(spokenQuery, { topics: meta.topics, pdfName, pdfKey: resolvedPdfKey })
              .includes(normalizeRagQuery(cache.rawQuery || '', { topics: meta.topics }).slice(0, 8))
            || normalizeRagQuery(cache.rawQuery || '', { topics: meta.topics })
              .includes(normalizeRagQuery(spokenQuery, { topics: meta.topics }).slice(0, 8))
          );

        let chunks = cacheFresh ? cache.chunks : [];
        if (!chunks.length) {
          chunks = await searchKnowledgeChunks({
            chatbotId: meta.chatbotId,
            query: spokenQuery,
            pdfKey: resolvedPdfKey,
            pdfName,
            topics: meta.topics,
            topK: 6,
          });
        }
        const ragMs = Date.now() - t0;
        if (meta.latency) meta.latency.ragMs = ragMs;

        const body = formatChunksForPrompt(chunks);
        const emptyRag = 'SEARCH RETURNED 0 RESULTS. Say politely you could not find that exact detail in the indexed excerpts, then offer to help with another topic from your documents. Do NOT invent pricing or specs.';
        const topKey = chunks[0]?.pdfKey || pdfKey || resolvedPdfKey || '';
        const topImageId = chunks[0]?.relatedImageIds?.[0];
        const alreadySpeaking = Boolean(meta.latency?.firstModelAudioAt || meta.latency?.firstModelTextAt);
        const imageRule = alreadySpeaking
          ? '\n\nYou are ALREADY answering out loud. Use these excerpts if needed. Do NOT restart the answer. Do NOT repeat the intro. Continue only if a fact was missing.'
          : (topKey
            ? `\n\nREQUIRED BEFORE SPEAKING: call setPresentationTopic(pdfKey="${topKey}"${topImageId ? `, imageId=${topImageId}` : ''}). `
              + 'Then speak the answer once. Do not restart after tools.'
            : '\n\nREQUIRED: call setPresentationTopic with the correct pdfKey before speaking.');
        responses.push({
          id: call.id,
          name: call.name,
          response: {
            result: (body || emptyRag) + imageRule,
            matchCount: chunks.length,
            suggestedPdfKey: topKey || undefined,
          },
        });
        emitLatency(meta, 'rag_done', {
          ragMs,
          detail: `${chunks.length} chunk(s) in ${formatMs(ragMs)}`,
        });
        if (!chunks.length) {
          console.warn(
            `[live] RAG miss chatbotId=${meta.chatbotId} pdfKey=${resolvedPdfKey || 'any'}`
            + ` query="${normalizeRagQuery(spokenQuery, { topics: meta.topics, pdfName }).slice(0, 80)}"`
          );
        }
        console.log(
          `[live] searchKnowledgeBase "${normalizeRagQuery(spokenQuery, { topics: meta.topics }).slice(0, 80)}"`
          + ` → ${chunks.length} chunk(s) in ${ragMs}ms${cacheFresh ? ' (cache)' : ''}`
        );
      } catch (err) {
        responses.push({
          id: call.id,
          name: call.name,
          response: { error: err.message || 'Knowledge search failed' },
        });
        console.error('[live] searchKnowledgeBase failed:', err.message);
      }
    } else if (call.name === 'setPresentationTopic') {
      const args = call.args || {};
      const pdfKey = String(args.pdfKey || '').trim();
      const imageId = args.imageId != null ? Number(args.imageId) : null;
      if (meta.silenceAfterAnswer || meta.dropBotUntilSpeechEnd) {
        responses.push({
          id: call.id,
          name: call.name,
          response: {
            success: true,
            skip: true,
            instruction: 'STOP. Answer already finished. No more audio.',
          },
        });
        continue;
      }
      const outcome = applyPresentationTopic(meta, pdfKey, imageId, { fromLlm: true, allowSwitch: true });
      const alreadySpeaking = Boolean(meta.latency?.firstModelAudioAt || meta.latency?.firstModelTextAt);
      responses.push({
        id: call.id,
        name: call.name,
        response: {
          ...outcome,
          continueSpeaking: alreadySpeaking,
          instruction: alreadySpeaking
            ? 'Images are on screen. Continue the SAME spoken answer. Do NOT restart or repeat.'
            : 'Images are on screen. Speak the answer once. Do not call this tool again this turn.',
        },
      });
      console.log(
        `[live] setPresentationTopic "${pdfKey}" → ${outcome.success ? 'ok' : outcome.reason}`
        + (outcome.shownImageId ? ` id=${outcome.shownImageId}` : '')
      );
    }
  }

  if (leadSaved) {
    meta.leadDraft = { name: '', company: '', designation: '', phone: '', email: '' };
    meta.leadFormShown = false;
    meta.leadDraftLocked = false;
    meta.cameraOpened = false;
    meta.leadSaveInFlight = false;
    meta.currentSlideshow = [];
    meta.pendingSlideshow = null;
    meta.slideshowEmittedKey = null;
    meta.isActivated = false;
    meta.suppressOutput = true;
    meta.ignoreWakeUntil = Date.now() + 5000;
    meta.wakePending = false;
    meta.userUtteranceBuffer = '';
    meta.userStreamBuffer = '';
    meta.greetNudgeSent = false;
    meta.lastSpeechEndAt = 0;
    emitJson(meta.socket, { type: 'chat_ended', reason: 'lead_saved' });
    emitJson(meta.socket, { type: 'show_onboarding', reason: 'chat_ended' });
    console.log('[live] Lead saved — session stays open, onboarding restored');
  }

  if (responses.length && meta.geminiSession) {
    meta.geminiSession.sendToolResponse({ functionResponses: responses });
  }
}

function flushUserUtterance(meta) {
  meta.userUtteranceBuffer = '';
  meta.userStreamBuffer = '';
}

/** Merge streaming STT fragments into one sentence */
function appendTranscript(buffer, chunk) {
  const c = String(chunk || '');
  if (!c) return buffer;
  const trimmed = c.trim();
  if (!buffer) return trimmed;
  if (trimmed.startsWith(buffer)) return trimmed;
  if (buffer.startsWith(trimmed)) return buffer;
  const joined = buffer + c;
  return joined.replace(/\s+/g, ' ').trim();
}

function requestLlmWakeMatch(meta, heard) {
  if (!meta || meta.isActivated) return;
  if (meta.ignoreWakeUntil && Date.now() < meta.ignoreWakeUntil) return;

  const roman = toRomanDisplay(heard);
  if (!isWakeTextCandidate(roman || heard)) return;

  const stamp = String(roman || heard).toLowerCase();
  if (meta.wakeTextTried === stamp || meta.wakeTextClassifyInFlight) return;
  meta.wakeTextTried = stamp;
  meta.wakeTextClassifyInFlight = true;
  console.log(`[live] LLM resemblance check for "${roman}"`);

  Promise.resolve(classifyWakeText({ chatbot: meta.chatbot, heard: roman || heard }))
    .then((result) => {
      if (meta.isActivated) return;
      if (!result.match) return;
      console.log(
        `[live] Wake MATCH via LLM resemblance — heard "${roman}"`
        + ` key=${result.matchedKey || meta.chatbot.activationKey}`
      );
      activateSession(meta, result.matchedKey || roman, { greet: true });
    })
    .catch((err) => {
      console.warn('[live] LLM wake resemblance failed:', err.message);
    })
    .finally(() => {
      meta.wakeTextClassifyInFlight = false;
    });
}

function flushUserTranscript(meta) {
  if (meta.discardSttUntilTurnComplete) {
    meta.userStreamBuffer = '';
    return;
  }

  const full = cleanTranscriptNoise(meta.userStreamBuffer);
  meta.userStreamBuffer = '';
  if (!full || isNoiseTranscript(full)) return;

  const shown = toRomanDisplay(full);
  console.log(`[live] USER said: "${shown}"`);
  meta.lastEmittedUserStt = '';
  emitJson(meta.socket, { type: 'transcript', role: 'user', text: shown, final: true });

  if (!meta.isActivated && detectActivation(full, meta.chatbot)) {
    console.log(`[live] Activation keyword matched in STT: "${shown}"`);
    activateSession(meta, full, { greet: true });
  } else if (!meta.isActivated) {
    console.log(`[live] Onboarding — heard "${shown}" — LLM checking resemblance to saved key`);
    requestLlmWakeMatch(meta, shown || full);
  }

  if (meta.isActivated) {
    mergeLeadDraft(meta, full);

    // Prefetch RAG images as soon as full user STT is known — before LLM tool call
    if (
      !meta.leadFormShown
      && !meta.awaitingGreetingTurn
      && !meta.latency?.firstModelAudioAt
      && !meta.latency?.turnCompleteAt
      && shouldDispatchImagesForUtterance(full)
      && !isActivationOnlyUtterance(full, meta.chatbot)
    ) {
      cancelRagPrefetch(meta);
      const turnId = meta.latency?.turnId || 0;
      prefetchRagForUserQuestion(meta, full, turnId).catch((err) => {
        console.warn('[live] prefetch RAG images failed:', err.message);
      });
    }

    // Fast path: visitor says yes while form is on screen → save immediately
    if (
      meta.leadFormShown
      && !meta.leadSaveInFlight
      && leadLooksReady(meta.leadDraft)
      && isLeadConfirmYes(full)
    ) {
      console.log('[live] Verbal YES detected — auto submitLead');
      handleToolCall(
        {
          functionCalls: [
            {
              id: `auto-yes-${Date.now()}`,
              name: 'submitLead',
              args: { ...meta.leadDraft },
            },
          ],
        },
        meta
      ).catch((err) => console.error('[live] auto submitLead failed:', err.message));
    }
  }

  meta.userUtteranceBuffer = '';
}

function flushAssistantTranscript(meta) {
  const full = stripMarkerText(meta.assistantBuffer).trim();
  if (!full) return;
  // Ignore empty/silence stubs after End Chat
  if (/^\(?\s*silence\s*\)?$/i.test(full) || full.length < 2) return;
  console.log(`[live] Bot said: "${full}"`);
  emitJson(meta.socket, { type: 'transcript', role: 'assistant', text: full, final: true });

  // Never merge assistant speech into lead fields (read-back corrupts email/phone)
  mergeLeadDraft(meta, full, false, { fromAssistant: true });
}

function cleanTranscriptNoise(text) {
  return String(text || '')
    .replace(/<noise>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function invalidateWakeAttempts(meta) {
  meta.wakeAttemptId = (meta.wakeAttemptId || 0) + 1;
  meta.wakeClassifyInFlight = false;
  meta.wakePending = false;
  if (meta.wakeActivationTimer) {
    clearTimeout(meta.wakeActivationTimer);
    meta.wakeActivationTimer = null;
  }
}

function isWakeAttemptCurrent(meta, attemptId) {
  if (meta.isActivated) return false;
  if (meta.ignoreWakeUntil && Date.now() < meta.ignoreWakeUntil) return false;
  return attemptId === meta.wakeAttemptId;
}

function activateSession(meta, heard, { greet = false } = {}) {
  if (meta.isActivated) return false;
  if (meta.ignoreWakeUntil && Date.now() < meta.ignoreWakeUntil) {
    console.log('[live] Activation blocked — post end-chat cooldown');
    return false;
  }

  if (meta.wakeActivationTimer) {
    clearTimeout(meta.wakeActivationTimer);
    meta.wakeActivationTimer = null;
  }
  if (meta.wakeAudioEndTimer) {
    clearTimeout(meta.wakeAudioEndTimer);
    meta.wakeAudioEndTimer = null;
  }

  invalidateWakeAttempts(meta);

  meta.assistantBuffer = '';
  meta.spokenTurnText = '';
  meta.deferredShowImageIds = [];
  meta.topicDispatchedThisTurn = false;
  meta.imageShownThisTurn = false;
  meta.lastShownImageId = null;
  meta.lastSpeechSyncLen = 0;

  meta.isActivated = true;
  meta.activatedAt = Date.now();
  meta.ignoreWakeUntil = 0;
  emitJson(meta.socket, { type: 'activated' });
  const sinceSpeechEnd = msBetween(meta.latency?.userSpeechEndAt);
  const sinceWake = msBetween(meta.latency?.wakeReceivedAt);
  console.log(
    `[live] Activated — heard: "${heard}"${greet ? ' (with greet nudge)' : ''}`
    + ` | since speech-end ${formatMs(sinceSpeechEnd)} | since wake ${formatMs(sinceWake)}`
  );
  emitLatency(meta, 'activated', {
    detail: `keyword matched; speechEnd→activate ${formatMs(sinceSpeechEnd)}`,
  });

  if (greet && meta.geminiSession) {
    meta.awaitingGreetingTurn = true;
    meta.greetTurnUnlocked = true;
    meta.suppressOutput = false;
    meta.discardSttUntilTurnComplete = false;
    meta.silenceAfterAnswer = false;
    meta.answerLockedThisTurn = false;

    const wakeDisplay = toRomanDisplay(
      String(heard || meta.userStreamBuffer || '').trim()
    );
    if (wakeDisplay) {
      emitJson(meta.socket, {
        type: 'transcript',
        role: 'user',
        text: wakeDisplay,
        final: true,
      });
    }
    meta.userStreamBuffer = '';
    meta.userUtteranceBuffer = '';
    meta.lastEmittedUserStt = '';

    try {
      meta.geminiSession.sendRealtimeInput({ audioStreamEnd: true });
    } catch (err) {
      console.warn('[live] audioStreamEnd on activate failed:', err.message);
    }

    if (!meta.greetNudgeSent) {
      meta.greetNudgeSent = true;
      const botName = meta.chatbot.name || 'Assistant';
      const greetingTopics = buildTopicGreeting(meta.topics || []);
      try {
        meta.geminiSession.sendClientContent({
          turns: [{
            role: 'user',
            parts: [{
              text:
                `[USER_ACTIVATED] The visitor ONLY said the wake phrase — NOT a product question. `
                + `Reply with AUDIO ONLY: a short greeting as ${botName}. `
                + `Two or three sentences: who you are, you can help with ${greetingTopics}, invite a question. `
                + `Do NOT call searchKnowledgeBase. Do NOT describe products yet. `
                + `[[TOPIC: General]]. No PDF names. Never say "and more".`,
            }],
          }],
          turnComplete: true,
        });
      } catch (err) {
        console.warn('[live] Activation nudge failed:', err.message);
        meta.greetNudgeSent = false;
        meta.awaitingGreetingTurn = false;
        meta.greetTurnUnlocked = false;
        meta.suppressOutput = false;
        meta.discardSttUntilTurnComplete = false;
      }
    }
  } else {
    meta.suppressOutput = false;
  }

  return true;
}

function accumulateUserTranscript(meta, chunk) {
  if (meta.discardSttUntilTurnComplete) return;

  // Incremental STT often arrives 1–2 chars at a time — do not drop as "noise"
  const cleaned = String(chunk || '')
    .replace(/<noise>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return;

  meta.userStreamBuffer = appendTranscript(meta.userStreamBuffer, cleaned);
  meta.userUtteranceBuffer = meta.userStreamBuffer;

  const shown = toRomanDisplay(meta.userStreamBuffer);
  if (shown && shown !== meta.lastEmittedUserStt) {
    meta.lastEmittedUserStt = shown;
    console.log(`[live] USER (live): "${shown}"`);
    emitJson(meta.socket, { type: 'transcript', role: 'user', text: shown, final: false });
  }

  if (meta.isActivated) {
    markFirstUserStt(meta, cleaned);
    if (meta.interruptedPending && meta.latency?.userSpeechEndAt) {
      scheduleInterruptHandoff(meta, 200);
    }
    if (meta.latency?.userSpeechEndAt) {
      scheduleRagPrefetch(meta, meta.userStreamBuffer, 350);
    }
  }

  if (!meta.isActivated && detectActivation(meta.userStreamBuffer, meta.chatbot)) {
    activateSession(meta, meta.userStreamBuffer, { greet: true });
  }
}

function stripMarkerText(text) {
  return String(text || '')
    .replace(/\[\[SHOW_IMAGE:\d+\]\]/gi, '')
    .replace(/\[\[TOPIC:\s*[^\]]+?\]\]/gi, '')
    .replace(/\[SHOW_LEAD_FORM[^\]]*\]/gi, '')
    .replace(/\[ACTIVATE_CAMERA\]/gi, '')
    .replace(/\[USER_ACTIVATED\][^\n]*/gi, '')
    .replace(/\[SESSION_ENDED\][^\n]*/gi, '')
    .replace(/\[WAKE\][^\n]*/gi, '')
    .replace(/\[Image\s*\d+\]/gi, '')
    .replace(/\bshow\s+image(?:\s+(?:number\s*)?\d+)?\b/gi, '')
    .replace(/\bimage\s+(?:number\s*)?\d+\b/gi, '')
    .replace(/\b(?:topic|pdf)\s*marker\b/gi, '')
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function handleLiveMessage(meta, message) {
  if (message.toolCall) {
    if (!meta.isActivated) return;
    if (meta.dropBotUntilSpeechEnd) {
      console.log('[live] Drop leftover tool call after interrupt');
      return;
    }
    emitLatency(meta, 'tool_call', { detail: (message.toolCall.functionCalls || []).map((c) => c.name).join(',') });
    handleToolCall(message.toolCall, meta).catch((err) => {
      console.error('[live] Tool call error:', err.message);
    });
    return;
  }

  if (message.setupComplete) {
    meta.setupDone = true;
    emitJson(meta.socket, {
      type: 'ready',
      chatbotName: meta.chatbot.name,
      scanCardRequired: Boolean(meta.chatbot.scanCardRequired),
      activationKey: meta.chatbot.activationKey,
    });
    console.log(`[live] Ready — bot "${meta.chatbot.name}" | model ${meta.model}`);
    return;
  }

  const sc = message.serverContent;
  if (!sc) return;

  if (sc.interrupted) {
    if (meta.isActivated && !meta.suppressOutput) {
      emitJson(meta.socket, { type: 'interrupted' });
    }
    beginUserInterrupt(meta, 'gemini_interrupted');
  }

  const sttText = sc.inputTranscription?.text;
  if (sttText) {
    accumulateUserTranscript(meta, String(sttText));
  }

  // Forward bot audio only while active + not suppressed.
  // Never activate from wakePending alone — STT must contain a real keyword/greeting.
  const parts = sc.modelTurn?.parts || [];
  for (const part of parts) {
    const inline = part.inlineData;
    if (inline?.data && inline?.mimeType?.includes('audio')) {
      if (meta.suppressOutput) {
        if (meta.awaitingGreetingTurn && meta.greetTurnUnlocked) {
          meta.suppressOutput = false;
        } else {
          continue;
        }
      }
      if (meta.dropBotUntilSpeechEnd || meta.silenceAfterAnswer) continue;
      if (!meta.isActivated) {
        if (meta.ignoreWakeUntil && Date.now() < meta.ignoreWakeUntil) continue;
        const buf = String(meta.userStreamBuffer || '').trim();
        if (!buf || !detectActivation(buf, meta.chatbot)) continue;
        activateSession(meta, buf, { greet: true });
        if (!meta.isActivated) continue;
      }
      markFirstModelAudio(meta);
      emitJson(meta.socket, { type: 'audio', data: inline.data, mimeType: inline.mimeType });
    }
  }

  if (sc.outputTranscription?.text) {
    if (meta.dropBotUntilSpeechEnd || meta.silenceAfterAnswer) {
      meta.assistantBuffer = '';
    } else if (meta.isActivated && !meta.suppressOutput) {
      markFirstModelText(meta);
      parseAssistantMarkers(meta, sc.outputTranscription.text);
    } else {
      // Drop leftover model text while onboarding / after End Chat
      meta.assistantBuffer = '';
    }
  }

  if (sc.turnComplete) {
    if (meta.awaitingGreetingTurn && meta.suppressOutput) {
      meta.greetTurnUnlocked = true;
      meta.suppressOutput = false;
      meta.discardSttUntilTurnComplete = false;
      console.log('[live] Greeting turn — allowing bot audio');
    }

    if (isStaleBotTurnComplete(meta) || meta.dropBotUntilSpeechEnd || meta.silenceAfterAnswer) {
      console.log(
        `[live] Ignoring extra turn_complete — already answered this question`
        + `${meta.silenceAfterAnswer ? ' (silenceAfterAnswer)' : ''}`
      );
      meta.assistantBuffer = '';
      meta.spokenTurnText = '';
      meta.deferredShowImageIds = [];
      meta.botResponseTurnId = null;
      meta.botAnswerForTurnId = null;
      return;
    }

    if (meta.discardSttUntilTurnComplete) {
      meta.discardSttUntilTurnComplete = false;
      meta.userStreamBuffer = '';
      meta.lastEmittedUserStt = '';
    }

    flushUserTranscript(meta);
    if (meta.isActivated && !meta.suppressOutput) {
      markTurnCompleteLatency(meta);
      flushDeferredShowImages(meta, true);
      flushAssistantTranscript(meta);
      emitJson(meta.socket, { type: 'turn_complete' });
      meta.silenceAfterAnswer = true;
      console.log('[live] Answer complete — blocking repeat generation until next user question');
    }
    if (meta.awaitingGreetingTurn && !meta.suppressOutput) {
      meta.awaitingGreetingTurn = false;
    }
    meta.botResponseTurnId = null;
    meta.botAnswerForTurnId = null;
    meta.assistantBuffer = '';
    meta.spokenTurnText = '';
    meta.imageShownThisTurn = false;
    meta.lastShownImageId = null;
    meta.lastSpeechSyncLen = 0;
    meta.deferredShowImageIds = [];
    meta.topicDispatchedThisTurn = false;
  }
}

function connectAndWaitForSetup(ai, model, liveConfig, meta) {
  let resolveSetup = null;
  let rejectSetup = null;
  let setupTimer = null;
  let settled = false;

  const setupPromise = new Promise((resolve, reject) => {
    resolveSetup = resolve;
    rejectSetup = reject;
    setupTimer = setTimeout(() => {
      reject(new Error(`Setup timed out for model ${model}`));
    }, Number(meta.setupTimeoutMs) || 18000);
  });
  // WS can fail before .then() attaches — avoid unhandledRejection crash
  setupPromise.catch(() => {});

  const settle = (fn, value) => {
    if (settled || typeof fn !== 'function') return;
    settled = true;
    clearTimeout(setupTimer);
    try {
      fn(value);
    } catch {
      /* ignore */
    }
  };

  const failSetup = (err) => {
    const msg = formatGeminiErrorForUser(err);
    settle(rejectSetup, err instanceof Error ? err : new Error(msg));
  };

  const callbacks = {
    onopen: () => {
      emitJson(meta.socket, { type: 'status', status: 'gemini_connected' });
      console.log(`[live] WebSocket open — bot "${meta.chatbot.name}" | model ${model}`);
    },
    onmessage: (message) => {
      if (!meta.setupDone && message.setupComplete) {
        handleLiveMessage(meta, message);
        settle(resolveSetup, true);
        return;
      }
      handleLiveMessage(meta, message);
    },
    onerror: (err) => {
      const msg = formatGeminiErrorForUser(err);
      console.error(`[live] Gemini error (${model}):`, err?.message || msg);
      if (!meta.setupDone) {
        failSetup(err);
      } else {
        emitJson(meta.socket, { type: 'error', message: msg });
      }
    },
    onclose: (evt) => {
      const reason = evt?.reason || evt?.message || '';
      if (!meta.setupDone) {
        const msg = reason || `Connection closed before setup (${model})`;
        console.warn(`[live] Closed before ready (${model}):`, msg);
        failSetup(new Error(msg));
      } else {
        emitJson(meta.socket, { type: 'status', status: 'gemini_closed' });
      }
    },
  };

  meta.model = model;

  return ai.live.connect({ model, config: liveConfig, callbacks })
    .then((session) => {
      meta.geminiSession = session;
      return setupPromise.then(() => session);
    })
    .catch((err) => {
      failSetup(err);
      try {
        meta.geminiSession?.close();
      } catch {
        /* ignore */
      }
      const wrapped = err instanceof Error ? err : new Error(formatGeminiErrorForUser(err));
      if (!wrapped.message) wrapped.message = formatGeminiErrorForUser(err);
      return Promise.reject(new Error(formatGeminiErrorForUser(err)));
    });
}

async function startGeminiLiveForSocket(socket, chatbot, knowledgeText) {
  assertGeminiConfigured();

  const existing = liveSessions.get(socket.id);
  if (
    existing?.geminiSession
    && existing.setupDone?.()
    && String(existing.meta?.chatbotId) === String(chatbot._id)
  ) {
    existing.meta.socket = socket;
    console.log(`[live] Reusing Gemini session (${existing.meta.model}) — bot "${chatbot.name}"`);
    return { model: existing.meta.model, reused: true };
  }

  const reusable = findReusableLiveSession(chatbot._id, socket.id);
  if (reusable?.entry) {
    adoptLiveSession(reusable.entry, socket, reusable.socketId);
    console.log(
      `[live] Rebound Gemini session (${reusable.entry.meta.model}) `
      + `→ socket ${socket.id} — bot "${chatbot.name}"`
    );
    return { model: reusable.entry.meta.model, reused: true };
  }

  if (liveStartLocks.has(socket.id)) {
    console.log('[live] Waiting for in-flight Gemini start…');
    return liveStartLocks.get(socket.id);
  }

  const job = actuallyStartGeminiLive(socket, chatbot, knowledgeText);
  liveStartLocks.set(socket.id, job);
  try {
    return await job;
  } finally {
    liveStartLocks.delete(socket.id);
  }
}

async function actuallyStartGeminiLive(socket, chatbot, knowledgeTextOrLoader) {
  await stopGeminiLiveForSocket(socket.id);
  audioChunkCounts.delete(socket.id);

  const knowledgeText = typeof knowledgeTextOrLoader === 'function'
    ? await knowledgeTextOrLoader()
    : (knowledgeTextOrLoader || '');

  const meta = createSessionMeta(socket, chatbot);
  // Overview images are not required to open Gemini — load in parallel.
  getOverviewChunks(chatbot._id)
    .then((overview) => {
      const ids = [];
      for (const chunk of overview) {
        for (const id of chunk.relatedImageIds || []) ids.push(Number(id));
      }
      meta.overviewImageIds = [...new Set(ids.filter(Boolean))];
    })
    .catch((err) => {
      meta.overviewImageIds = [];
      console.warn('[live] overview chunks unavailable:', err.message);
    });

  const ai = new GoogleGenAI({ apiKey: geminiConfig.apiKey });
  const systemText = buildChatbotLiveInstruction(chatbot, knowledgeText);
  console.log(`[live] System instruction ${systemText.length} chars (keep small for fast replies)`);

  const liveConfig = {
    responseModalities: [Modality.AUDIO],
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          // Lock one voice for the whole Live session (no mid-chat voice switch)
          voiceName: process.env.GEMINI_LIVE_VOICE || 'Charon',
        },
      },
    },
    systemInstruction: { parts: [{ text: systemText }] },
    tools: [{
      functionDeclarations: [
        ...SUBMIT_LEAD_TOOL.functionDeclarations,
        ...SEARCH_KNOWLEDGE_TOOL.functionDeclarations,
        ...SET_PRESENTATION_TOPIC_TOOL.functionDeclarations,
      ],
    }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
      automaticActivityDetection: {
        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
        silenceDurationMs: Number(process.env.GEMINI_SILENCE_DURATION_MS) || 1600,
        prefixPaddingMs: 120,
      },
    },
  };

  const candidates = getLiveModelCandidates(
    process.env.GEMINI_LIVE_MODEL || FALLBACK_LIVE_MODELS[0]
  );

  let lastError = null;
  let quotaError = null;

  for (let i = 0; i < candidates.length; i += 1) {
    const model = candidates[i];
    try {
      meta.setupTimeoutMs = i === 0 ? 20000 : 7000;
      console.log(`[live] Connecting Gemini Live → ${model}`);
      const session = await connectAndWaitForSetup(ai, model, liveConfig, meta);

      liveSessions.set(socket.id, {
        geminiSession: session,
        meta,
        setupDone: () => meta.setupDone,
      });

      console.log(`[live] Session active (${model}) — bot "${chatbot.name}" | ${meta.catalog.length} images`);
      return { model };
    } catch (err) {
      lastError = err;
      meta.setupDone = false;
      try {
        meta.geminiSession?.close?.();
      } catch {
        /* ignore */
      }
      meta.geminiSession = null;
      const msg = String(err?.message || '');
      if (/quota exceeded|resource exhausted/i.test(msg)) quotaError = err;
      if (/is not found|not supported for bidiGenerateContent/i.test(msg)) {
        console.warn(`[live] Skipping retired Live model (${model})`);
      } else {
        console.warn(`[live] Model failed (${model}):`, msg);
      }
    }
  }

  const msg = quotaError?.message
    || lastError?.message
    || 'No compatible Gemini Live model available';
  emitJson(socket, { type: 'error', message: msg });
  throw new Error(msg);
}

function getSessionEntry(socketId) {
  return liveSessions.get(socketId);
}

function sendLiveAudio(socketId, { data, mimeType, clientT }) {
  const entry = getSessionEntry(socketId);
  if (!entry?.geminiSession || !entry.setupDone?.()) return false;
  if (!entry.meta?.micEnabled) return false;
  // Drop uplink during post-end cooldown so echo cannot re-wake the model
  if (
    !entry.meta.isActivated
    && entry.meta.ignoreWakeUntil
    && Date.now() < entry.meta.ignoreWakeUntil
  ) {
    return false;
  }

  if (entry.meta.isActivated) {
    markUserAudioChunk(entry.meta);
  }

  const receivedAt = Date.now();
  const hop = Number(clientT) > 0 ? receivedAt - Number(clientT) : null;
  const L = entry.meta.latency;
  if (L && hop != null && !L.loggedUplinkHop) {
    L.loggedUplinkHop = true;
    L.firstUplinkAt = receivedAt;
    L.firstUplinkHopMs = hop;
    emitLatency(entry.meta, 'audio_uplink_hop', {
      feToBeHopMs: hop,
      detail: `voice packet FE→BE ${formatMs(hop)}`,
    });
  }

  const count = (audioChunkCounts.get(socketId) || 0) + 1;
  audioChunkCounts.set(socketId, count);
  if (count === 1 || count % 50 === 0) {
    console.log(
      `[live] Audio chunks: ${count} (socket ${socketId})`
      + (hop != null ? ` | last hop ${formatMs(hop)}` : '')
    );
  }

  entry.geminiSession.sendRealtimeInput({
    audio: { data, mimeType: mimeType || 'audio/pcm;rate=16000' },
  });
  return true;
}

function interruptLiveSession(socketId) {
  const entry = getSessionEntry(socketId);
  if (!entry?.geminiSession || !entry.meta) return false;
  // Do NOT send audioStreamEnd here — that ends the user turn.
  // Barge-in needs continuous mic uplink so Gemini VAD can interrupt generation.
  // Frontend already stops local playback; clear local turn buffers only.
  try {
    const meta = entry.meta;
    beginUserInterrupt(meta, 'frontend_barge_in');
    console.log(`[live] Barge-in (socket ${socketId}) — previous answer stopped`);
    return true;
  } catch {
    return false;
  }
}

function sendLiveText(socketId, text) {
  const entry = getSessionEntry(socketId);
  if (!entry?.geminiSession || !entry.setupDone?.()) return false;

  entry.geminiSession.sendClientContent({
    turns: [{ role: 'user', parts: [{ text }] }],
    turnComplete: true,
  });
  return true;
}

function endLiveAudioStream(socketId) {
  const entry = getSessionEntry(socketId);
  if (!entry?.geminiSession) return;
  try {
    entry.geminiSession.sendRealtimeInput({ audioStreamEnd: true });
  } catch {
    /* ignore */
  }
}

/** Wake path: dedicated classifier on the VAD clip, then main Live LLM. */
async function handleWakeAttempt(socketId, payload = {}) {
  const entry = getSessionEntry(socketId);
  if (!entry?.geminiSession) return;

  const meta = entry.meta;
  if (!meta || meta.isActivated) return;
  if (meta.ignoreWakeUntil && Date.now() < meta.ignoreWakeUntil) {
    console.log('[live] Wake ignored — post end-chat cooldown');
    return;
  }

  const now = Date.now();
  if (now - (meta.lastSpeechEndAt || 0) < 400) return;

  // Supersede any in-flight wake — never block the user's latest attempt
  if (meta.wakeActivationTimer) {
    clearTimeout(meta.wakeActivationTimer);
    meta.wakeActivationTimer = null;
  }
  meta.wakeAttemptId = (meta.wakeAttemptId || 0) + 1;
  const attemptId = meta.wakeAttemptId;

  const speakMs = Number(payload.speakMs);
  meta.lastSpeechEndAt = now;
  meta.wakePending = true;
  meta.wakeSpeakMs = Number.isFinite(speakMs) ? speakMs : null;

  resetTurnLatency(meta, 'wake');
  const spoke = Number.isFinite(speakMs) ? speakMs : 0;
  meta.latency.userAudioStartAt = now - spoke;
  meta.latency.lastUserAudioAt = now;
  meta.latency.userSpeechEndAt = now;
  meta.latency.wakeReceivedAt = now;

  const hop = Number(payload.clientT) > 0 ? now - Number(payload.clientT) : null;
  emitLatency(meta, 'wake_received', {
    feToBeHopMs: hop,
    speakDurationMs: spoke || null,
    detail: `wake FE→BE ${formatMs(hop)} spoke ${formatMs(spoke)}`,
  });

  endLiveAudioStream(socketId);
  scheduleWakeActivation(meta);

  const clip = String(payload.data || '').trim();
  const CLASSIFY_TIMEOUT_MS = Number(process.env.WAKE_CLASSIFY_TIMEOUT_MS) || 8000;

  if (clip) {
    meta.wakeClassifyInFlight = true;
    emitLatency(meta, 'wake_classify_start', { detail: 'dedicated wake prompt' });
    try {
      const t0 = Date.now();
      const result = await Promise.race([
        classifyWakeUtterance({
          chatbot: meta.chatbot,
          base64Audio: clip,
          mimeType: payload.mimeType || 'audio/pcm;rate=16000',
        }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('wake classify timeout')), CLASSIFY_TIMEOUT_MS);
        }),
      ]);
      const classifyMs = Date.now() - t0;

      if (!isWakeAttemptCurrent(meta, attemptId)) {
        console.log('[live] Wake classify result ignored — superseded or already activated');
        return;
      }

      emitLatency(meta, 'wake_classify_done', {
        detail: `match=${result.match} heard="${result.heard}" in ${formatMs(classifyMs)}`,
      });

      if (result.match) {
        console.log(
          `[live] Wake MATCH via dedicated detector — heard "${toRomanDisplay(result.heard)}"`
          + ` en="${result.english || ''}"`
          + ` key=${result.matchedKey || meta.chatbot.activationKey}`
        );
        activateSession(meta, result.matchedKey || result.english || result.heard || 'wake', { greet: true });
        return;
      }

      if (!result.parseOk && shouldVadFallbackActivate({
        chatbot: meta.chatbot,
        sttText: result.heard || result.raw,
        speakMs: spoke,
      })) {
        console.log('[live] Wake MATCH via VAD fallback (classifier JSON incomplete)');
        activateSession(meta, result.heard || 'wake', { greet: true });
        return;
      }

      console.log(
        `[live] Wake detector: no keyword in clip (heard "${toRomanDisplay(result.heard || '')}"`
        + ` en="${result.english || ''}")`
      );
      meta.wakePending = false;
    } catch (err) {
      if (!isWakeAttemptCurrent(meta, attemptId)) return;
      console.warn('[live] Wake classifier failed — STT fallback active:', err.message);
    } finally {
      if (attemptId === meta.wakeAttemptId) {
        meta.wakeClassifyInFlight = false;
      }
    }
  } else {
    console.log(
      `[live] Wake attempt (socket ${socketId}) — VAD phrase ${formatMs(spoke)}`
      + ` | greetingKey=${hasGreetingWakeKey(meta.chatbot)} | clip=no`
    );
  }
}

/** After activation, Gemini automatic VAD owns turn-taking — do NOT audioStreamEnd. */
function handleUserSpeechEnd(socketId) {
  const entry = getSessionEntry(socketId);
  if (!entry?.geminiSession || !entry.meta) return;
  if (entry.meta.isActivated) {
    markUserSpeechEnd(entry.meta, 'live:audio_end_or_pause');
    return;
  }
  // Wake path owns audio_end timing
  if (entry.meta.wakePending) return;
  endLiveAudioStream(socketId);
}

/** Explicit client timing marks (speech start/end from mic VAD). */
function handleClientLatencyMark(socketId, payload = {}) {
  const entry = getSessionEntry(socketId);
  if (!entry?.meta) return;
  const phase = String(payload.phase || '');
  const hop = Number(payload.t) > 0 ? Date.now() - Number(payload.t) : null;
  if (phase === 'user_speech_start') {
    markUserSpeechStart(entry.meta, entry.meta.isActivated ? 'frontend_vad_start' : 'frontend_wake_start');
    if (hop != null) {
      emitLatency(entry.meta, 'vad_start_hop', {
        feToBeHopMs: hop,
        detail: `VAD start mark FE→BE ${formatMs(hop)}`,
      });
    }
    return;
  }
  if (phase === 'user_speech_end') {
    markUserSpeechEnd(entry.meta, entry.meta.isActivated ? 'frontend_vad_end' : 'frontend_wake_end');
    if (hop != null) {
      emitLatency(entry.meta, 'vad_end_hop', {
        feToBeHopMs: hop,
        speakDurationMs: Number(payload.speakMs) || speakDurationMs(entry.meta.latency),
        detail: `VAD end mark FE→BE ${formatMs(hop)}`,
      });
    }
    if (entry.meta.isActivated && !entry.meta.awaitingGreetingTurn) {
      const buf = cleanTranscriptNoise(
        entry.meta.userStreamBuffer || entry.meta.userUtteranceBuffer || ''
      );
      if (buf) {
        scheduleRagPrefetch(entry.meta, buf, 650);
        scheduleInterruptHandoff(entry.meta, 450);
      }
    }
  }
}

function scheduleWakeActivation(meta) {
  if (meta.wakeActivationTimer) {
    clearTimeout(meta.wakeActivationTimer);
    meta.wakeActivationTimer = null;
  }

  const speakMs = meta.wakeSpeakMs;
  const clearWakeTimer = () => {
    if (meta.wakeActivationTimer) {
      clearTimeout(meta.wakeActivationTimer);
      meta.wakeActivationTimer = null;
    }
  };

  const sttBuffer = () => cleanTranscriptNoise(meta.userStreamBuffer || meta.userUtteranceBuffer || '');

  const tryActivate = (reason) => {
    if (meta.isActivated) return true;
    if (meta.ignoreWakeUntil && Date.now() < meta.ignoreWakeUntil) return false;
    const buf = sttBuffer();
    if (buf) console.log(`[live] Wake STT buffer: "${toRomanDisplay(buf)}"`);

    if (buf && detectActivation(buf, meta.chatbot)) {
      activateSession(meta, buf, { greet: true });
      return true;
    }

    if (buf) requestLlmWakeMatch(meta, buf);

    if (shouldVadFallbackActivate({ chatbot: meta.chatbot, sttText: buf, speakMs })) {
      console.log(
        `[live] VAD-first wake — junk/empty STT "${buf || '(empty)'}"`
        + ` after ${formatMs(speakMs)} (greeting key)`
      );
      activateSession(meta, buf || reason || 'vad_phrase', { greet: true });
      return true;
    }
    return false;
  };

  if (tryActivate('immediate')) return;

  const bufNow = sttBuffer();
  const junkAlready = isJunkWakeTranscript(bufNow);
  const greetingKey = hasGreetingWakeKey(meta.chatbot);

  // Wrong-script STT will not become "hello" if we wait 5s — peek once, then VAD fallback.
  if (junkAlready && greetingKey) {
    meta.wakeActivationTimer = setTimeout(() => {
      if (tryActivate('junk_stt_peek')) return;
      if (shouldVadFallbackActivate({ chatbot: meta.chatbot, sttText: sttBuffer(), speakMs })) {
        activateSession(meta, sttBuffer() || 'vad_junk_stt', { greet: true });
        return;
      }
      meta.wakePending = false;
      clearWakeTimer();
    }, 300);
    return;
  }

  // Empty STT: short peek window only, then VAD fallback for greeting keys.
  const delays = greetingKey ? [250, 500, 800] : [400, 800, 1400, 2200];
  let step = 0;

  const tick = () => {
    if (tryActivate('poll')) return;
    if (step >= delays.length) {
      const buf = sttBuffer();
      if (shouldVadFallbackActivate({ chatbot: meta.chatbot, sttText: buf, speakMs })) {
        activateSession(meta, buf || 'vad_timeout', { greet: true });
        return;
      }
      const keys = String(meta.chatbot?.activationKey || '').trim() || '(none)';
      console.log(
        `[live] Wake STT finished — NOT activating. keys=[${keys}] buffer="${toRomanDisplay(buf) || '(empty)'}"`
        + ` spoke=${formatMs(speakMs)}`
      );
      meta.wakePending = false;
      clearWakeTimer();
      return;
    }
    const wait = delays[step];
    step += 1;
    meta.wakeActivationTimer = setTimeout(tick, wait);
  };

  tick();
}

/**
 * Hard-end conversation: onboarding, deactivate, wait for activation keyword again.
 */
function endLiveConversation(socketId) {
  const entry = getSessionEntry(socketId);
  if (!entry?.meta) return false;

  const meta = entry.meta;

  // Block accidental End Chat clicks right as greeting starts (button appears under finger)
  if (meta.isActivated && meta.activatedAt && Date.now() - meta.activatedAt < 5000) {
    console.warn('[live] Ignoring end_chat — too soon after activation');
    return false;
  }

  try {
    entry.geminiSession?.sendRealtimeInput({ audioStreamEnd: true });
  } catch {
    /* ignore */
  }

  if (meta.wakeActivationTimer) {
    clearTimeout(meta.wakeActivationTimer);
    meta.wakeActivationTimer = null;
  }
  if (meta.wakeAudioEndTimer) {
    clearTimeout(meta.wakeAudioEndTimer);
    meta.wakeAudioEndTimer = null;
  }

  invalidateWakeAttempts(meta);

  meta.isActivated = false;
  meta.activatedAt = 0;
  meta.suppressOutput = true; // drop any leftover model audio/text until real wake
  // Block accidental re-wake from leftover speaker echo / mic noise after End Chat
  meta.ignoreWakeUntil = Date.now() + 5000;
  meta.leadDraft = { name: '', company: '', designation: '', phone: '', email: '' };
  meta.leadFormShown = false;
  meta.leadDraftLocked = false;
  meta.cameraOpened = false;
  meta.leadSaveInFlight = false;
  meta.currentSlideshow = [];
  meta.pendingSlideshow = null;
  meta.fullPdfPool = [];
  meta.slideshowEmittedKey = null;
  meta.lockedPdfKey = null;
  meta.userUtteranceBuffer = '';
  meta.userStreamBuffer = '';
  meta.assistantBuffer = '';
  meta.spokenTurnText = '';
  meta.deferredShowImageIds = [];
  meta.greetNudgeSent = false;
  meta.awaitingGreetingTurn = false;
  meta.discardSttUntilTurnComplete = false;
  meta.greetTurnUnlocked = false;
  meta.turnRagCache = null;
  meta.ragPrefetchInFlight = false;
  meta.topicDispatchedThisTurn = false;
  meta.lastSpeechEndAt = 0;
  meta.lastShownImageId = null;
  meta.lastSpeechSyncLen = 0;
  meta.latency.turnId += 1;
  meta.latency.userAudioStartAt = 0;
  meta.latency.userSpeechEndAt = 0;
  meta.latency.firstUserSttAt = 0;
  meta.latency.firstModelAudioAt = 0;
  meta.latency.firstModelTextAt = 0;
  meta.latency.turnCompleteAt = 0;
  meta.latency.ragStartedAt = 0;
  meta.latency.ragMs = null;
  meta.latency.loggedFirstAudio = false;
  meta.latency.loggedComplete = false;

  emitJson(meta.socket, { type: 'chat_ended', reason: 'user_ended' });
  emitJson(meta.socket, { type: 'show_onboarding', reason: 'chat_ended' });

  // Do NOT sendClientContent here — that made Gemini emit "(Silence)" and look "alive".
  console.log(`[live] Conversation ended — cooldown 5s, keyword required (bot "${meta.chatbot?.name}")`);
  return true;
}

async function stopGeminiLiveForSocket(socketId) {
  cancelPendingSessionStop(socketId);
  const entry = getSessionEntry(socketId);
  if (!entry) return;

  liveSessions.delete(socketId);
  audioChunkCounts.delete(socketId);
  try {
    entry.geminiSession?.close();
  } catch {
    /* ignore */
  }
}

/** Keep Gemini warm briefly so a socket reconnect does not pay ~14s handshake again. */
function scheduleDelayedStopGemini(socketId, delayMs = 8000) {
  cancelPendingSessionStop(socketId);
  if (!liveSessions.has(socketId)) return;
  const timer = setTimeout(() => {
    pendingSessionStops.delete(socketId);
    stopGeminiLiveForSocket(socketId).catch(() => {});
  }, delayMs);
  pendingSessionStops.set(socketId, timer);
}

function setMicEnabled(socketId, enabled) {
  const entry = getSessionEntry(socketId);
  if (!entry?.meta) return;
  entry.meta.micEnabled = Boolean(enabled);
}

module.exports = {
  startGeminiLiveForSocket,
  sendLiveAudio,
  sendLiveText,
  endLiveAudioStream,
  handleUserSpeechEnd,
  handleWakeAttempt,
  handleClientLatencyMark,
  endLiveConversation,
  stopGeminiLiveForSocket,
  scheduleDelayedStopGemini,
  liveSessions,
  mergeLeadDraft,
  emitLeadForm,
  getSessionEntry,
  setMicEnabled,
  interruptLiveSession,
};
