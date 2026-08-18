/**
 * Gemini API settings used by the chat + voice features.
 * All LLM/voice code should read from here so keys and model names stay in one place.
 */
require('dotenv').config();

const geminiConfig = {
  apiKey: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '',

  // Chat answers from knowledge base
  chatModel: process.env.GEMINI_MODEL || process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash',

  // Speech-to-text / wake classifier — 1.5-flash was shut down
  sttModel: process.env.GEMINI_STT_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash',

  // Fallback models if primary hits free-tier quota (comma-separated in .env)
  fallbackModels: (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.6-flash,gemini-2.5-flash,gemini-2.5-flash-lite')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean),

  ttsModel: process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts',
  voiceName: process.env.GEMINI_VOICE_NAME || 'Charon',
  apiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  sessionIdleMs: Number(process.env.VOICE_SESSION_IDLE_MS) || 30 * 60 * 1000,
  maxKnowledgeChars: Number(process.env.VOICE_MAX_KNOWLEDGE_CHARS) || 120000,

  // text-embedding-004 was shut down Jan 2026. gemini-embedding-001 is the
  // current stable text embedding model; we request 768 dims (recommended).
  embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001',
  embeddingDimensions: Number(process.env.GEMINI_EMBEDDING_DIMENSIONS) || 768,
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
