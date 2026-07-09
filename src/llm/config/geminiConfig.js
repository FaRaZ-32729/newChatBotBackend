/**
 * Gemini API settings used by the chat + voice features.
 * All LLM/voice code should read from here so keys and model names stay in one place.
 */
require('dotenv').config();

const geminiConfig = {
  apiKey: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '',

  // Chat answers from knowledge base
  chatModel: process.env.GEMINI_MODEL || process.env.GEMINI_CHAT_MODEL || 'gemini-1.5-flash',

  // Speech-to-text (audio → transcript) — lighter model saves quota
  sttModel: process.env.GEMINI_STT_MODEL || process.env.GEMINI_MODEL || 'gemini-1.5-flash',

  // Fallback models if primary hits free-tier quota (comma-separated in .env)
  fallbackModels: (process.env.GEMINI_FALLBACK_MODELS || 'gemini-1.5-flash,gemini-2.5-flash-lite,gemini-2.0-flash')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean),

  ttsModel: process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts',
  voiceName: process.env.GEMINI_VOICE_NAME || 'Charon',
  apiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  sessionIdleMs: Number(process.env.VOICE_SESSION_IDLE_MS) || 30 * 60 * 1000,
  maxKnowledgeChars: Number(process.env.VOICE_MAX_KNOWLEDGE_CHARS) || 120000,
};

/** All models to try for chat/STT, primary first */
function getModelCandidates(primary) {
  return [...new Set([primary, ...geminiConfig.fallbackModels])];
}

function assertGeminiConfigured() {
  if (!geminiConfig.apiKey) {
    throw new Error('GOOGLE_API_KEY (or GEMINI_API_KEY) is missing in backend .env');
  }
}

module.exports = {
  geminiConfig,
  assertGeminiConfigured,
  getModelCandidates,
};
