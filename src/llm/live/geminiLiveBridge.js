/**
 * Bridges one Socket.IO client ↔ Gemini Multimodal Live API.
 * Per chatbot: isolated prompt, image slideshow, lead capture.
 */
const { GoogleGenAI, Modality, ActivityHandling, StartSensitivity, EndSensitivity } = require('@google/genai');
const { geminiConfig, assertGeminiConfigured } = require('../config/geminiConfig');
const { buildChatbotLiveInstruction, buildTopicGreeting } = require('./chatbotLivePrompt');
const { formatGeminiErrorForUser } = require('../utils/geminiHelper');
const { SUBMIT_LEAD_TOOL } = require('./liveLeadTools');
const { saveLead } = require('../services/leadService');
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
} = require('./liveActivation');

const FALLBACK_LIVE_MODELS = [
  'gemini-2.5-flash-native-audio-preview-12-2025',
  'gemini-2.5-flash-native-audio-preview',
  'gemini-live-2.5-flash-preview',
  'gemini-2.0-flash-live-001',
].filter(Boolean);

const liveSessions = new Map();
const audioChunkCounts = new Map();

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
    slideshowEmittedKey: null,
    assistantBuffer: '',
    spokenTurnText: '',
    imageShownThisTurn: false,
    lastShownImageId: null,
    lastSpeechSyncLen: 0,
    deferredShowImageIds: [],
    topicDispatchedThisTurn: false,
    leadDraft: { name: '', company: '', designation: '', phone: '', email: '' },
    leadFormShown: false,
    topicCounts: {},
    isActivated: false,
    activatedAt: 0,
    wakePending: false,
    ignoreWakeUntil: 0,
    suppressOutput: false,
    micEnabled: false,
    userUtteranceBuffer: '',
    userStreamBuffer: '',
    greetNudgeSent: false,
    lastSpeechEndAt: 0,
    wakeActivationTimer: null,
    wakeAudioEndTimer: null,
    setupDone: false,
    geminiSession: null,
    model: null,
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

function mergeLeadDraft(meta, text, forceShow = false) {
  const extracted = extractLeadDetails(text);
  if (!Object.keys(extracted).length && !forceShow) return;

  if (Object.keys(extracted).length) {
    meta.leadDraft = { ...meta.leadDraft, ...extracted };
  }

  const d = meta.leadDraft;
  if ((forceShow || leadLooksReady(d)) && !meta.leadFormShown) {
    meta.leadFormShown = true;
    emitJson(meta.socket, { type: 'show_lead_form', data: { ...d } });
    console.log('[live] Lead form shown', d);
  } else if (meta.leadFormShown && Object.keys(extracted).length) {
    // Keep form updated as more fields arrive
    emitJson(meta.socket, { type: 'show_lead_form', data: { ...d } });
  }
}

function emitLeadForm(meta, data, { editable = false } = {}) {
  meta.leadFormShown = true;
  meta.leadDraft = { ...meta.leadDraft, ...(data || {}) };
  emitJson(meta.socket, {
    type: 'show_lead_form',
    data: { ...meta.leadDraft },
    editable,
  });
  console.log('[live] Lead form emit', meta.leadDraft);
}

/**
 * [[TOPIC: pdfKey]] from assistant response only.
 * Prepares the image pool — does NOT flash wrong slides.
 * Visible images appear when [[SHOW_IMAGE:N]] fires.
 */
function dispatchSlideshowForTopic(meta, topicKey) {
  const result = resolveSlideshowForTopicKey(meta.catalog, meta.topics, topicKey);

  if (!result.matched || !result.images.length) {
    meta.pendingSlideshow = [];
    meta.fullPdfPool = [];
    meta.currentSlideshow = [];
    meta.slideshowEmittedKey = null;
    // Do not wipe UI while lead form is up (TOPIC General was hiding the form)
    if (!meta.leadFormShown) {
      emitJson(meta.socket, {
        type: 'show_onboarding',
        topic: topicKey,
        reason: 'general_or_unknown_topic',
      });
    }
    console.log(`[live] LLM topic "${topicKey}" → onboarding (no images)`);
    return;
  }

  meta.pendingSlideshow = result.images;
  meta.fullPdfPool = result.images;
  meta.pendingPdfName = result.pdfName;
  meta.pendingPdfKey = result.pdfKey;
  console.log(
    `[live] LLM topic "${topicKey}" → prepared ${result.images.length} image(s) from "${result.pdfName}" (waiting for SHOW_IMAGE)`
  );
}

/**
 * Show a related-section cluster for what the LLM is saying.
 * 1 related image → single; many → carousel of that section only (not whole PDF).
 */
function emitImageSync(meta, catalogImageId, options = {}) {
  const fromSpeech = Boolean(options.fromSpeech);
  const recentSpeech = String(options.speechText || meta.spokenTurnText || '').trim();

  let pdfPool = Array.isArray(meta.pendingSlideshow) && meta.pendingSlideshow.length
    ? meta.pendingSlideshow
    : Array.isArray(meta.fullPdfPool) && meta.fullPdfPool.length
      ? meta.fullPdfPool
      : Array.isArray(meta.currentSlideshow) && meta.currentSlideshow.length
        ? meta.currentSlideshow
        : [];

  const preferred = findCatalogImageById(meta.catalog, catalogImageId);
  if (preferred && (!pdfPool.length || !pdfPool.some((img) => img.pdfKey === preferred.pdfKey))) {
    pdfPool = (meta.catalog || []).filter((img) => img.pdfKey === preferred.pdfKey);
  }
  if (!pdfPool.length && preferred) {
    pdfPool = (meta.catalog || []).filter((img) => img.pdfKey === preferred.pdfKey);
  }

  const picked = pickClusterForSpeech(
    pdfPool.length ? pdfPool : meta.catalog,
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

  const cluster = (picked?.cluster?.length ? picked.cluster : [target]);
  if (Number(target.id) !== Number(catalogImageId) || fromSpeech) {
    console.log(
      `[live] IMAGE cluster ${cluster.length} slide(s) focus=${target.id} "${String(target.topic).slice(0, 50)}"${fromSpeech ? ' (speech)' : ''}`
    );
  }

  meta.fullPdfPool = pdfPool.length
    ? pdfPool
    : (meta.catalog || []).filter((img) => img.pdfKey === target.pdfKey);

  const slideIndex = Math.max(0, cluster.findIndex((img) => img.id === target.id));
  const poolKey = `${target.pdfKey}:sec:${cluster.map((i) => i.id).join(',')}`;
  const needEmitImages = meta.slideshowEmittedKey !== poolKey;

  meta.currentSlideshow = cluster;
  meta.pendingSlideshow = meta.fullPdfPool;
  meta.pendingPdfKey = target.pdfKey;
  meta.pendingPdfName = target.pdfName;
  meta.imageShownThisTurn = true;
  meta.lastShownImageId = target.id;

  if (needEmitImages) {
    meta.slideshowEmittedKey = poolKey;
    emitJson(meta.socket, {
      type: 'images',
      images: cluster.map(formatImageForFrontend),
      pdfName: target.pdfName,
      pdfKey: target.pdfKey,
      replace: true,
      // Multi-image section → gentle carousel; single → no auto-advance needed
      holdCarouselMs: cluster.length > 1 ? 4500 : 0,
      autoAdvance: cluster.length > 1,
      initialSlideIndex: slideIndex,
    });
  }

  emitJson(meta.socket, {
    type: 'image_sync',
    imageId: target.id,
    slideIndex,
    timestamp: Date.now(),
  });

  console.log(
    `[live] SHOW → slide ${slideIndex + 1}/${cluster.length} id=${target.id} "${String(target.topic).slice(0, 55)}"`
  );
}

/** Progressive sync: as LLM speaks, switch section cluster to match recent words. */
function syncImagesFromRecentSpeech(meta, force = false) {
  const spoken = String(meta.spokenTurnText || '').trim();
  if (spoken.length < 20) return;

  const sinceLast = spoken.length - (meta.lastSpeechSyncLen || 0);
  if (!force && sinceLast < 22) return;
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
  if (newKey === meta.slideshowEmittedKey && meta.lastShownImageId === picked.focus.id) {
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
  if (!force && spokenLen < 28) return;

  meta.deferredShowImageIds = [];
  for (const imageId of queue) {
    emitImageSync(meta, imageId);
  }
}

/** After full answer text is known, fix a clearly wrong slide. */
function revalidateShownImage(meta) {
  syncImagesFromRecentSpeech(meta, true);
}

function parseAssistantMarkers(meta, chunkText) {
  meta.assistantBuffer += chunkText;
  let buffer = meta.assistantBuffer;

  // Process TOPIC markers (may appear once per turn)
  const topicMatch = buffer.match(/\[\[TOPIC:\s*([^\]]+?)\]\]/i);
  if (topicMatch) {
    const topic = topicMatch[1].trim();
    buffer = buffer.replace(topicMatch[0], '');

    if (!meta.topicDispatchedThisTurn) {
      meta.topicDispatchedThisTurn = true;
      const key = topic.toLowerCase();
      if (key !== 'general') {
        meta.topicCounts[key] = (meta.topicCounts[key] || 0) + 1;
      }
      dispatchSlideshowForTopic(meta, topic);
    }
  }

  // SHOW_IMAGE — defer briefly until we have spoken words (markers often arrive first)
  let imageMatch;
  while ((imageMatch = buffer.match(/\[\[SHOW_IMAGE:(\d+)\]\]/i))) {
    const imageId = parseInt(imageMatch[1], 10);
    buffer = buffer.replace(imageMatch[0], '');
    if (String(meta.spokenTurnText || '').trim().length < 28) {
      if (!Array.isArray(meta.deferredShowImageIds)) meta.deferredShowImageIds = [];
      meta.deferredShowImageIds.push(imageId);
    } else {
      emitImageSync(meta, imageId);
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
    emitJson(meta.socket, { type: 'activate_camera' });
    emitJson(meta.socket, { type: 'transcript', role: 'assistant', text: '[ACTIVATE_CAMERA]' });
  }

  meta.assistantBuffer = buffer;

  const cleaned = chunkText
    .replace(/\[\[SHOW_IMAGE:\d+\]\]/gi, '')
    .replace(/\[\[TOPIC:\s*[^\]]+?\]\]/gi, '')
    .replace(/\[SHOW_LEAD_FORM.*?\]/gi, '')
    .replace(/\[ACTIVATE_CAMERA\]/gi, '');

  const spokenBit = String(cleaned || '').replace(/\s+/g, ' ').trim();
  if (spokenBit) {
    meta.spokenTurnText = `${meta.spokenTurnText || ''} ${spokenBit}`.trim();
    flushDeferredShowImages(meta, false);
    syncImagesFromRecentSpeech(meta, false);
  }

  return { cleaned };
}

async function handleToolCall(toolCall, meta) {
  const calls = toolCall?.functionCalls || [];
  const responses = [];
  let leadSaved = false;

  for (const call of calls) {
    if (call.name === 'submitLead') {
      const args = call.args || {};
      const leadData = {
        name: args.name || '',
        company: args.company || '',
        designation: args.designation || '',
        phone: args.phone || '',
        email: args.email || '',
      };

      // Never save silently — form must appear on screen for visitor to verify first
      if (!meta.leadFormShown) {
        emitLeadForm(meta, leadData);
        responses.push({
          id: call.id,
          name: call.name,
          response: {
            result:
              'Lead form is now on screen. Read the details aloud, ask the visitor to confirm. '
              + 'Call submitLead again ONLY after they say yes / sahi hai.',
            formShown: true,
            saved: false,
          },
        });
        console.log('[live] submitLead blocked — form shown for confirmation first', leadData);
        continue;
      }

      try {
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
          response: { result: 'Lead saved successfully.', leadId: String(lead._id) },
        });

        console.log(`[live] Lead saved: ${lead.name} | bot ${meta.chatbot.name}`);
      } catch (err) {
        responses.push({
          id: call.id,
          name: call.name,
          response: { error: err.message },
        });
      }
    }
  }

  if (leadSaved) {
    meta.leadDraft = { name: '', company: '', designation: '', phone: '', email: '' };
    meta.leadFormShown = false;
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

function flushUserTranscript(meta) {
  const full = cleanTranscriptNoise(meta.userStreamBuffer);
  meta.userStreamBuffer = '';
  if (!full || isNoiseTranscript(full)) return;

  console.log(`[live] USER said: "${full}"`);
  emitJson(meta.socket, { type: 'transcript', role: 'user', text: full, final: true });

  if (!meta.isActivated && detectActivation(full, meta.chatbot)) {
    console.log(`[live] Activation keyword matched in STT: "${full}"`);
    activateSession(meta, full, { greet: true });
  } else if (!meta.isActivated) {
    console.log(`[live] Onboarding — heard "${full}" but not an activation keyword`);
  }

  if (meta.isActivated) {
    mergeLeadDraft(meta, full);
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

  // Bot often reads details aloud without emitting SHOW_LEAD_FORM — still show the form
  mergeLeadDraft(meta, full);
}

function cleanTranscriptNoise(text) {
  return String(text || '')
    .replace(/<noise>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

  meta.isActivated = true;
  meta.activatedAt = Date.now();
  meta.wakePending = false;
  meta.ignoreWakeUntil = 0;
  meta.suppressOutput = false;
  emitJson(meta.socket, { type: 'activated' });
  console.log(`[live] Activated — heard: "${heard}"${greet ? ' (with greet nudge)' : ''}`);

  // Only nudge when Gemini did not already hear the user (empty STT fallback).
  if (greet && meta.geminiSession && !meta.greetNudgeSent) {
    meta.greetNudgeSent = true;
    const botName = meta.chatbot.name || 'Assistant';
    const greetingTopics = buildTopicGreeting(meta.topics || []);
    try {
      meta.geminiSession.sendClientContent({
        turns: [{
          role: 'user',
          parts: [{
            text:
              `[USER_ACTIVATED] Greet once as ${botName} in AUDIO. `
              + `Warm detailed intro: who you are, that you help with ${greetingTopics}, `
              + `features/benefits/how things work. Invite any question. `
              + `About 4–5 spoken sentences. [[TOPIC: General]]. No PDF names. Never say "and more".`,
          }],
        }],
        turnComplete: true,
      });
    } catch (err) {
      console.warn('[live] Activation nudge failed:', err.message);
      meta.greetNudgeSent = false;
    }
  }

  return true;
}

function accumulateUserTranscript(meta, chunk) {
  const cleaned = cleanTranscriptNoise(chunk);
  if (!cleaned || isNoiseTranscript(cleaned)) return;

  meta.userStreamBuffer = appendTranscript(meta.userStreamBuffer, cleaned);
  meta.userUtteranceBuffer = meta.userStreamBuffer;

  if (!meta.isActivated) {
    console.log(`[live] STT (wake): "${meta.userStreamBuffer}"`);
  }

  if (!meta.isActivated && detectActivation(meta.userStreamBuffer, meta.chatbot)) {
    // Prefer greet nudge so intro is never lost if pre-activate audio was dropped
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
    meta.assistantBuffer = '';
    meta.spokenTurnText = '';
    meta.imageShownThisTurn = false;
    meta.lastShownImageId = null;
    meta.lastSpeechSyncLen = 0;
    meta.deferredShowImageIds = [];
    meta.userStreamBuffer = '';
    meta.topicDispatchedThisTurn = false;
  }

  if (sc.inputTranscription?.text) {
    accumulateUserTranscript(meta, sc.inputTranscription.text.trim());
  }

  // Forward bot audio only while active + not suppressed.
  // Never activate from wakePending alone — STT must contain a real keyword/greeting.
  const parts = sc.modelTurn?.parts || [];
  for (const part of parts) {
    const inline = part.inlineData;
    if (inline?.data && inline?.mimeType?.includes('audio')) {
      if (meta.suppressOutput) continue;
      if (!meta.isActivated) {
        if (meta.ignoreWakeUntil && Date.now() < meta.ignoreWakeUntil) continue;
        const buf = String(meta.userStreamBuffer || '').trim();
        if (!buf || !detectActivation(buf, meta.chatbot)) continue;
        activateSession(meta, buf, { greet: true });
        if (!meta.isActivated) continue;
      }
      emitJson(meta.socket, { type: 'audio', data: inline.data, mimeType: inline.mimeType });
    }
  }

  if (sc.outputTranscription?.text) {
    if (meta.isActivated && !meta.suppressOutput) {
      parseAssistantMarkers(meta, sc.outputTranscription.text);
    } else {
      // Drop leftover model text while onboarding / after End Chat
      meta.assistantBuffer = '';
    }
  }

  if (sc.turnComplete) {
    flushUserTranscript(meta);
    if (meta.isActivated && !meta.suppressOutput) {
      flushDeferredShowImages(meta, true);
      revalidateShownImage(meta);
      autoSyncImageFromSpeech(meta);
      flushAssistantTranscript(meta);
      emitJson(meta.socket, { type: 'turn_complete' });
    }
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

  const setupPromise = new Promise((resolve, reject) => {
    resolveSetup = resolve;
    rejectSetup = reject;
    setupTimer = setTimeout(() => {
      reject(new Error(`Setup timed out for model ${model}`));
    }, 15000);
  });

  const settle = (fn, value) => {
    clearTimeout(setupTimer);
    fn(value);
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
        settle(rejectSetup, new Error(msg));
      } else {
        emitJson(meta.socket, { type: 'error', message: msg });
      }
    },
    onclose: (evt) => {
      const reason = evt?.reason || evt?.message || '';
      if (!meta.setupDone) {
        const msg = reason || `Connection closed before setup (${model})`;
        console.warn(`[live] Closed before ready (${model}):`, msg);
        settle(rejectSetup, new Error(msg));
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
      clearTimeout(setupTimer);
      try {
        meta.geminiSession?.close();
      } catch {
        /* ignore */
      }
      throw err;
    });
}

async function startGeminiLiveForSocket(socket, chatbot, knowledgeText) {
  assertGeminiConfigured();

  await stopGeminiLiveForSocket(socket.id);
  audioChunkCounts.delete(socket.id);

  const meta = createSessionMeta(socket, chatbot);
  const ai = new GoogleGenAI({ apiKey: geminiConfig.apiKey });
  const systemText = buildChatbotLiveInstruction(chatbot, knowledgeText);
  console.log(`[live] System instruction ${systemText.length} chars (keep small for fast replies)`);

  const liveConfig = {
    responseModalities: [Modality.AUDIO],
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: process.env.GEMINI_LIVE_VOICE || 'Alnilam',
        },
      },
    },
    systemInstruction: { parts: [{ text: systemText }] },
    tools: [{ functionDeclarations: SUBMIT_LEAD_TOOL.functionDeclarations }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      // Hear user quickly; allow bot to finish long detailed answers
      activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
      automaticActivityDetection: {
        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
        silenceDurationMs: 650,
        prefixPaddingMs: 100,
      },
    },
  };

  const candidates = getLiveModelCandidates(
    process.env.GEMINI_LIVE_MODEL || FALLBACK_LIVE_MODELS[0]
  );

  let lastError = null;

  for (const model of candidates) {
    try {
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
      meta.geminiSession = null;
      console.warn(`[live] Model failed (${model}):`, err.message);
    }
  }

  const msg = lastError?.message || 'No compatible Gemini Live model available';
  emitJson(socket, { type: 'error', message: msg });
  throw new Error(msg);
}

function getSessionEntry(socketId) {
  return liveSessions.get(socketId);
}

function sendLiveAudio(socketId, { data, mimeType }) {
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

  const count = (audioChunkCounts.get(socketId) || 0) + 1;
  audioChunkCounts.set(socketId, count);
  if (count === 1 || count % 50 === 0) {
    console.log(`[live] Audio chunks: ${count} (socket ${socketId})`);
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
    meta.assistantBuffer = '';
    meta.spokenTurnText = '';
    meta.deferredShowImageIds = [];
    meta.topicDispatchedThisTurn = false;
    console.log(`[live] Barge-in (socket ${socketId}) — waiting for user audio`);
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

/** Wake path: frontend already detected a real spoken phrase. */
function handleWakeAttempt(socketId) {
  const entry = getSessionEntry(socketId);
  if (!entry?.geminiSession) return;

  const meta = entry.meta;
  if (!meta || meta.isActivated) return;
  if (meta.ignoreWakeUntil && Date.now() < meta.ignoreWakeUntil) {
    console.log('[live] Wake ignored — post end-chat cooldown');
    return;
  }

  const now = Date.now();
  if (now - (meta.lastSpeechEndAt || 0) < 900) return;
  // Already waiting on a wake — don't reset the timer (spam cancels greeting)
  if (meta.wakePending && meta.wakeActivationTimer) {
    console.log('[live] Wake already pending — ignoring duplicate');
    return;
  }
  meta.lastSpeechEndAt = now;
  meta.wakePending = true;

  console.log(`[live] Wake attempt (socket ${socketId}) — waiting for STT keyword match`);

  // Do NOT cut the stream instantly — give Gemini time to produce inputTranscription.
  if (meta.wakeAudioEndTimer) clearTimeout(meta.wakeAudioEndTimer);
  meta.wakeAudioEndTimer = setTimeout(() => {
    meta.wakeAudioEndTimer = null;
    if (!meta.isActivated) endLiveAudioStream(socketId);
  }, 550);

  scheduleWakeActivation(meta);
}

/** After activation, Gemini automatic VAD owns turn-taking — do NOT audioStreamEnd. */
function handleUserSpeechEnd(socketId) {
  const entry = getSessionEntry(socketId);
  if (!entry?.geminiSession || !entry.meta) return;
  if (entry.meta.isActivated) return;
  // Wake path owns audio_end timing
  if (entry.meta.wakePending) return;
  endLiveAudioStream(socketId);
}

function scheduleWakeActivation(meta) {
  if (meta.wakeActivationTimer) {
    clearTimeout(meta.wakeActivationTimer);
    meta.wakeActivationTimer = null;
  }

  const tryActivateFromStt = () => {
    if (meta.isActivated) return true;
    if (meta.ignoreWakeUntil && Date.now() < meta.ignoreWakeUntil) return false;
    const buf = cleanTranscriptNoise(meta.userStreamBuffer || meta.userUtteranceBuffer || '');
    if (buf) {
      console.log(`[live] Wake STT buffer: "${buf}"`);
    }
    if (buf && detectActivation(buf, meta.chatbot)) {
      // STT matched — still nudge greet so user always hears intro (audio may have been dropped pre-activate)
      activateSession(meta, buf, { greet: true });
      return true;
    }
    return false;
  };

  if (tryActivateFromStt()) return;

  // Wait longer for STT — previous 1.4s window was too short (salam never matched).
  const delays = [500, 1000, 1600, 2400, 3500];
  let step = 0;

  const tick = () => {
    if (tryActivateFromStt()) return;
    if (step >= delays.length) {
      const buf = cleanTranscriptNoise(meta.userStreamBuffer || meta.userUtteranceBuffer || '');
      const keys = String(meta.chatbot?.activationKey || '').trim() || '(none)';
      console.log(
        `[live] Wake STT finished — NOT activating (no DB keyword match). `
        + `keys=[${keys}] buffer="${buf || '(empty)'}"`
      );
      meta.wakePending = false;
      if (meta.wakeActivationTimer) {
        clearTimeout(meta.wakeActivationTimer);
        meta.wakeActivationTimer = null;
      }
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

  meta.isActivated = false;
  meta.activatedAt = 0;
  meta.wakePending = false;
  meta.suppressOutput = true; // drop any leftover model audio/text until real wake
  // Block accidental re-wake from leftover speaker echo / mic noise after End Chat
  meta.ignoreWakeUntil = Date.now() + 5000;
  meta.leadDraft = { name: '', company: '', designation: '', phone: '', email: '' };
  meta.leadFormShown = false;
  meta.currentSlideshow = [];
  meta.pendingSlideshow = null;
  meta.fullPdfPool = [];
  meta.slideshowEmittedKey = null;
  meta.userUtteranceBuffer = '';
  meta.userStreamBuffer = '';
  meta.assistantBuffer = '';
  meta.spokenTurnText = '';
  meta.deferredShowImageIds = [];
  meta.greetNudgeSent = false;
  meta.topicDispatchedThisTurn = false;
  meta.lastSpeechEndAt = 0;
  meta.lastShownImageId = null;
  meta.lastSpeechSyncLen = 0;

  emitJson(meta.socket, { type: 'chat_ended', reason: 'user_ended' });
  emitJson(meta.socket, { type: 'show_onboarding', reason: 'chat_ended' });

  // Do NOT sendClientContent here — that made Gemini emit "(Silence)" and look "alive".
  console.log(`[live] Conversation ended — cooldown 5s, keyword required (bot "${meta.chatbot?.name}")`);
  return true;
}

async function stopGeminiLiveForSocket(socketId) {
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
  endLiveConversation,
  stopGeminiLiveForSocket,
  liveSessions,
  mergeLeadDraft,
  emitLeadForm,
  getSessionEntry,
  setMicEnabled,
  interruptLiveSession,
};
