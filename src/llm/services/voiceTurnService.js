/**
 * Shared voice-turn logic used by HTTP routes and Socket.IO.
 * Keeps one code path so REST and sockets behave the same.
 */
const ChatbotModel = require('../../models/chatbotModel');
const {
  getOrCreateSession,
  getSession,
  pushHistory,
  endSession,
  touchSession,
} = require('../sessions/sessionManager');
const { getChatbotKnowledge } = require('./knowledgeService');
const { generateChatReply } = require('./geminiChatService');
const { transcribeAudio, synthesizeMaleSpeech } = require('./speechService');
const { formatGeminiErrorForUser } = require('../utils/geminiHelper');

function canAccessChatbot(user, chatbot) {
  if (!user || !chatbot) return false;
  if (user.role === 'admin') return true;

  const ownerId = chatbot.createdBy?.toString?.() || String(chatbot.createdBy);
  if (user._id.toString() === ownerId) return true;

  if (user.role === 'user' && user.createdBy?.toString() === ownerId) {
    return true;
  }

  return false;
}

/**
 * Load chatbot for voice.
 * - Logged-in user: must have team access
 * - Guest (public URL): any active chatbot by id
 */
async function loadChatbotForVoice(chatbotId, user = null) {
  const chatbot = await ChatbotModel.findById(chatbotId);
  if (!chatbot || chatbot.isActive === false) {
    return { error: { code: 'NOT_FOUND', message: 'Chatbot not found or inactive' } };
  }

  if (user && !canAccessChatbot(user, chatbot)) {
    return { error: { code: 'FORBIDDEN', message: 'You do not have access to this chatbot' } };
  }

  return { chatbot };
}

/**
 * Start an isolated voice session for userId + chatbotId.
 */
async function startVoiceSessionForUser({ userId, chatbotId, sessionId, user = null }) {
  const { chatbot, error } = await loadChatbotForVoice(chatbotId, user);
  if (error) return { error };

  const knowledgeText = await getChatbotKnowledge(chatbot);

  const session = getOrCreateSession({
    userId,
    chatbotId: chatbot._id,
    sessionId,
    chatbotName: chatbot.name,
    activationKey: chatbot.activationKey,
  });

  return {
    session,
    chatbot,
    knowledgeReady: Boolean(knowledgeText && knowledgeText.length > 0),
  };
}

/**
 * Process one voice turn: audio in → transcript → Gemini → TTS audio out.
 */
async function processVoiceTurnForUser({
  userId,
  chatbotId,
  sessionId,
  base64Audio,
  mimeType = 'audio/webm',
  user = null,
}) {
  const { chatbot, error } = await loadChatbotForVoice(chatbotId, user);
  if (error) return { error };

  let session = getSession(userId, chatbotId, sessionId);
  if (!session) {
    session = getOrCreateSession({
      userId,
      chatbotId: chatbot._id,
      sessionId,
      chatbotName: chatbot.name,
      activationKey: chatbot.activationKey,
    });
  }
  touchSession(session);

  console.log('\n────────── Voice turn ──────────');
  console.log(`[voice] Bot: ${chatbot.name} | User: ${userId} | Session: ${sessionId}`);

  const transcript = await transcribeAudio({ base64Audio, mimeType });

  if (!transcript) {
    console.log('[voice] User said: (no speech detected)');
    console.log('[voice] Gemini reply: I could not hear you clearly. Please try again.');
    console.log('────────────────────────────────\n');

    return {
      data: {
        sessionId: session.sessionId,
        chatbotId: String(chatbot._id),
        chatbotName: chatbot.name,
        transcript: '',
        replyText: 'I could not hear you clearly. Please try again.',
        isActivated: session.isActivated,
        justActivated: false,
        audioBase64: null,
        audioMimeType: null,
      },
    };
  }

  console.log(`[voice] User said: "${transcript}"`);

  const knowledgeText = await getChatbotKnowledge(chatbot);
  pushHistory(session, 'user', transcript);

  const { replyText, isActivated, justActivated } = await generateChatReply({
    chatbot,
    knowledgeText,
    session,
    userText: transcript,
  });

  pushHistory(session, 'bot', replyText);

  console.log(`[voice] Gemini reply: "${replyText}"`);
  console.log(`[voice] Activated: ${isActivated}${justActivated ? ' (just activated)' : ''}`);

  let speech = null;
  try {
    speech = await synthesizeMaleSpeech(replyText);
    console.log('[voice] TTS audio: ready');
  } catch (ttsError) {
    console.error('[voice] TTS error:', ttsError.message);
  }

  console.log('────────────────────────────────\n');

  return {
    data: {
      sessionId: session.sessionId,
      chatbotId: String(chatbot._id),
      chatbotName: chatbot.name,
      transcript,
      replyText,
      isActivated,
      justActivated,
      audioBase64: speech?.audioBase64 || null,
      audioMimeType: speech?.mimeType || null,
    },
  };
}

/** Wrap voice turn errors with a short user-facing message */
function wrapVoiceTurnError(error) {
  return {
    error: {
      code: 'GEMINI_ERROR',
      message: formatGeminiErrorForUser(error),
    },
  };
}

async function processVoiceTurnForUserSafe(params) {
  try {
    return await processVoiceTurnForUser(params);
  } catch (error) {
    console.error('[voice] Turn failed:', error.message);
    return wrapVoiceTurnError(error);
  }
}

function endVoiceSessionForUser({ userId, chatbotId, sessionId }) {
  endSession(userId, chatbotId, sessionId);
  return { sessionId, chatbotId };
}

module.exports = {
  canAccessChatbot,
  loadChatbotForVoice,
  startVoiceSessionForUser,
  processVoiceTurnForUser,
  processVoiceTurnForUserSafe,
  endVoiceSessionForUser,
};
