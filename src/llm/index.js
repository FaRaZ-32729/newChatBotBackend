/**
 * LLM / Voice module map (backend)
 *
 * How multi-user / multi-chatbot stays conflict-free:
 * - Every voice session key = userId + chatbotId + sessionId
 * - Prompt always includes THAT chatbot's name, activation key, and PDF text
 * - Knowledge cache is per chatbot document (shared read-only, never mixed)
 * - TTS uses one male voice (Charon by default) for every bot reply
 *
 * Folders:
 * - config/     Gemini keys + model names
 * - prompts/    Strict system prompt builder
 * - sessions/   In-memory isolated sessions
 * - services/   Knowledge extract, Gemini chat, STT/TTS
 *
 * HTTP entry: /api/voice/* (see routes/voiceRoutes.js)
 */

module.exports = {
  geminiConfig: require('./config/geminiConfig'),
  chatbotPrompt: require('./prompts/chatbotPrompt'),
  sessionManager: require('./sessions/sessionManager'),
  knowledgeService: require('./services/knowledgeService'),
  geminiChatService: require('./services/geminiChatService'),
  speechService: require('./services/speechService'),
};
