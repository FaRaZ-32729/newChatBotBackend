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
  formatImageForFrontend,
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
    assistantBuffer: '',
    topicDispatchedThisTurn: false,
    leadDraft: { name: '', company: '', designation: '', phone: '', email: '' },
    leadFormShown: false,
    topicCounts: {},
    isActivated: false,
    micEnabled: false,
    userUtteranceBuffer: '',
    userStreamBuffer: '',
    greetNudgeSent: false,
    lastSpeechEndAt: 0,
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
    /\b(?:my\s+name\s+is|name\s+is|i\s+am|i'm|this\s+is)\s+([A-Za-z][A-Za-z .'-]{1,60})(?=\s+(?:and|phone|number|email|from|in)\b|[,.;]|$)/i
  );
  if (nameMatch) details.name = cleanLeadValue(nameMatch[1]);

  const companyMatch = source.match(
    /\b(?:company\s+(?:name\s+)?is|company\s+is|i\s+work\s+(?:at|for))\s+([A-Za-z0-9][A-Za-z0-9 .&'()-]{1,80})(?=\s+(?:and|designation|phone|email)\b|[,.;]|$)/i
  );
  if (companyMatch) details.company = cleanLeadValue(companyMatch[1]);

  const designationMatch = source.match(
    /\b(?:designation\s+is|job\s+title\s+is|title\s+is|role\s+is)\s+([A-Za-z][A-Za-z .&'/-]{1,60})(?=\s+(?:and|phone|email)\b|[,.;]|$)/i
  );
  if (designationMatch) details.designation = cleanLeadValue(designationMatch[1]);

  return details;
}

function mergeLeadDraft(meta, text, forceShow = false) {
  const extracted = extractLeadDetails(text);
  if (!Object.keys(extracted).length) return;

  meta.leadDraft = { ...meta.leadDraft, ...extracted };

  const d = meta.leadDraft;
  const hasRequired = Boolean(d.name && d.phone && d.email);
  if ((forceShow || hasRequired) && !meta.leadFormShown) {
    meta.leadFormShown = true;
    emitJson(meta.socket, { type: 'show_lead_form', data: { ...d } });
  }
}

function dispatchSlideshowForTopic(meta, topicKey) {
  const result = resolveSlideshowForTopicKey(meta.catalog, meta.topics, topicKey);

  if (!result.matched || !result.images.length) {
    meta.currentSlideshow = [];
    emitJson(meta.socket, {
      type: 'show_onboarding',
      topic: topicKey,
      reason: 'general_or_unknown_topic',
    });
    console.log(`[live] LLM topic "${topicKey}" → onboarding image`);
    return;
  }

  meta.currentSlideshow = result.images;
  const images = result.images.map(formatImageForFrontend);

  emitJson(meta.socket, {
    type: 'images',
    images,
    pdfName: result.pdfName,
    pdfKey: result.pdfKey,
    replace: true,
    holdCarouselMs: 5000,
  });

  console.log(`[live] LLM topic "${topicKey}" → ${images.length} image(s) from "${result.pdfName}"`);
}

function emitImageSync(meta, catalogImageId) {
  const slideshow = meta.currentSlideshow || [];
  let slideIndex = slideshow.findIndex((img) => img.id === catalogImageId);
  if (slideIndex < 0 && catalogImageId >= 1 && catalogImageId <= slideshow.length) {
    slideIndex = catalogImageId - 1;
  }

  emitJson(meta.socket, {
    type: 'image_sync',
    imageId: catalogImageId,
    slideIndex: slideIndex >= 0 ? slideIndex : 0,
    timestamp: Date.now(),
  });
}

function parseAssistantMarkers(meta, chunkText) {
  meta.assistantBuffer += chunkText;
  let buffer = meta.assistantBuffer;
  let imageId = null;

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

  // Process every [[SHOW_IMAGE:N]] marker in order (sync slides as bot discusses each image)
  let imageMatch;
  while ((imageMatch = buffer.match(/\[\[SHOW_IMAGE:(\d+)\]\]/))) {
    imageId = parseInt(imageMatch[1], 10);
    buffer = buffer.replace(imageMatch[0], '');
    emitImageSync(meta, imageId);
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

    meta.leadFormShown = true;
    buffer = buffer.replace(leadFormMatch[0], '');
    emitJson(meta.socket, { type: 'show_lead_form', data: leadData || { ...meta.leadDraft } });
  }

  const cameraMatch = buffer.match(/\[ACTIVATE_CAMERA\]/i);
  if (cameraMatch) {
    buffer = buffer.replace(cameraMatch[0], '');
    emitJson(meta.socket, { type: 'activate_camera' });
    emitJson(meta.socket, { type: 'transcript', role: 'assistant', text: '[ACTIVATE_CAMERA]' });
  }

  meta.assistantBuffer = buffer;

  const cleaned = chunkText
    .replace(/\[\[SHOW_IMAGE:\d+\]\]/g, '')
    .replace(/\[\[TOPIC:\s*[^\]]+?\]\]/gi, '')
    .replace(/\[SHOW_LEAD_FORM.*?\]/gi, '')
    .replace(/\[ACTIVATE_CAMERA\]/gi, '');

  return { cleaned, imageId };
}

async function handleToolCall(toolCall, meta) {
  const calls = toolCall?.functionCalls || [];
  const responses = [];
  let leadSaved = false;

  for (const call of calls) {
    if (call.name === 'submitLead') {
      const args = call.args || {};
      try {
        const lead = await saveLead({
          name: args.name,
          company: args.company || '',
          designation: args.designation || '',
          phone: args.phone,
          email: args.email,
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
    meta.isActivated = false;
    meta.userUtteranceBuffer = '';
    meta.userStreamBuffer = '';
    meta.greetNudgeSent = false;
    meta.lastSpeechEndAt = 0;
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
  const full = meta.userStreamBuffer.trim();
  meta.userStreamBuffer = '';
  if (!full || isNoiseTranscript(full)) return;

  console.log(`[live] User said: "${full}"`);
  emitJson(meta.socket, { type: 'transcript', role: 'user', text: full, final: true });

  if (!meta.isActivated && detectActivation(full, meta.chatbot)) {
    activateSession(meta, full);
  }

  if (meta.isActivated) {
    mergeLeadDraft(meta, full);
  }

  meta.userUtteranceBuffer = '';
}

function flushAssistantTranscript(meta) {
  const full = stripMarkerText(meta.assistantBuffer).trim();
  if (!full) return;
  console.log(`[live] Bot said: "${full}"`);
  emitJson(meta.socket, { type: 'transcript', role: 'assistant', text: full, final: true });
}

function activateSession(meta, heard) {
  if (meta.isActivated) return;
  meta.isActivated = true;
  emitJson(meta.socket, { type: 'activated' });
  console.log(`[live] Activated — heard: "${heard}"`);

  const botName = meta.chatbot.name || 'Assistant';
  const greetingTopics = buildTopicGreeting(meta.topics || []);

  if (meta.geminiSession && !meta.greetNudgeSent) {
    meta.greetNudgeSent = true;
    try {
      meta.geminiSession.sendClientContent({
        turns: [{
          role: 'user',
          parts: [{
            text: `[USER_ACTIVATED] User woke you. Greet warmly as ${botName} in AUDIO. `
              + `Introduce yourself and naturally mention you can help with: ${greetingTopics}. `
              + `Then ask what they would like to know. Sound human — no AI/PDF language.`,
          }],
        }],
        turnComplete: true,
      });
    } catch (err) {
      console.warn('[live] Activation nudge failed:', err.message);
    }
  }
}

function accumulateUserTranscript(meta, chunk) {
  if (isNoiseTranscript(chunk)) return;

  meta.userStreamBuffer = appendTranscript(meta.userStreamBuffer, chunk);
  meta.userUtteranceBuffer = meta.userStreamBuffer;

  if (!meta.isActivated && detectActivation(meta.userStreamBuffer, meta.chatbot)) {
    activateSession(meta, meta.userStreamBuffer);
  }
}

function stripMarkerText(text) {
  return String(text || '')
    .replace(/\[\[SHOW_IMAGE:\d+\]\]/gi, '')
    .replace(/\[\[TOPIC:\s*[^\]]+?\]\]/gi, '')
    .replace(/\[SHOW_LEAD_FORM[^\]]*\]/gi, '')
    .replace(/\[ACTIVATE_CAMERA\]/gi, '')
    .replace(/\[USER_ACTIVATED\][^\n]*/gi, '')
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
    emitJson(meta.socket, { type: 'interrupted' });
    meta.assistantBuffer = '';
    meta.userStreamBuffer = '';
    meta.topicDispatchedThisTurn = false;
  }

  if (sc.inputTranscription?.text) {
    accumulateUserTranscript(meta, sc.inputTranscription.text.trim());
  }

  // Always forward bot audio — Gemini greets from live audio immediately (no backend delay)
  const parts = sc.modelTurn?.parts || [];
  for (const part of parts) {
    const inline = part.inlineData;
    if (inline?.data && inline?.mimeType?.includes('audio')) {
      if (!meta.isActivated) {
        activateSession(meta, 'bot responded to wake phrase');
      }
      emitJson(meta.socket, { type: 'audio', data: inline.data, mimeType: inline.mimeType });
    }
  }

  if (sc.outputTranscription?.text) {
    if (meta.isActivated) {
      parseAssistantMarkers(meta, sc.outputTranscription.text);
    } else {
      meta.assistantBuffer += sc.outputTranscription.text;
    }
  }

  if (sc.turnComplete) {
    flushUserTranscript(meta);
    flushAssistantTranscript(meta);
    emitJson(meta.socket, { type: 'turn_complete' });
    meta.assistantBuffer = '';
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
      activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
      automaticActivityDetection: {
        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
        silenceDurationMs: 280,
        prefixPaddingMs: 40,
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
  if (!entry?.geminiSession) return false;
  try {
    // User started speaking — end audio stream so Gemini VAD can barge-in
    entry.geminiSession.sendRealtimeInput({ audioStreamEnd: true });
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

/** User finished speaking — commit ONE turn; debounced wake prompt */
function handleUserSpeechEnd(socketId) {
  const entry = getSessionEntry(socketId);
  if (!entry?.geminiSession) return;

  const meta = entry.meta;
  if (!meta || meta.isActivated) return;

  const now = Date.now();
  if (now - (meta.lastSpeechEndAt || 0) < 2500) return;
  meta.lastSpeechEndAt = now;

  endLiveAudioStream(socketId);

  if (meta.greetNudgeSent) return;

  meta.greetNudgeSent = true;
  const botName = meta.chatbot?.name || 'Assistant';
  const key = meta.chatbot?.activationKey || '';
  const greetingTopics = buildTopicGreeting(meta.topics || []);

  console.log(`[live] Turn committed — greeting for "${botName}"`);

  try {
    entry.geminiSession.sendClientContent({
      turns: [{
        role: 'user',
        parts: [{
          text: `[WAKE] User spoke (maybe "${key}" or "${botName}" or salam). `
            + `Greet warmly in AUDIO as ${botName}. Mention you can help with: ${greetingTopics}. `
            + `Ask what they want to know. Human tone only — never mention PDF or AI.`,
        }],
      }],
      turnComplete: true,
    });
  } catch (err) {
    console.warn('[live] Wake prompt failed:', err.message);
    meta.greetNudgeSent = false;
  }
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
  stopGeminiLiveForSocket,
  liveSessions,
  mergeLeadDraft,
  getSessionEntry,
  setMicEnabled,
  interruptLiveSession,
};
