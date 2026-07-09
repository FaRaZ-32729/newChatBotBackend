/**
 * Talks to Gemini for TEXT answers only.
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { geminiConfig, assertGeminiConfigured, getModelCandidates } = require('../config/geminiConfig');
const { buildSystemPrompt, buildTurnInstruction } = require('../prompts/chatbotPrompt');
const { withModelFallback } = require('../utils/geminiHelper');

let client = null;

function getClient() {
  assertGeminiConfigured();
  if (!client) {
    client = new GoogleGenerativeAI(geminiConfig.apiKey);
  }
  return client;
}

function detectActivation(userText, activationKey) {
  if (!activationKey) return false;
  const said = String(userText || '').toLowerCase();
  const key = String(activationKey).toLowerCase().trim();
  if (!key) return false;

  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  return pattern.test(said);
}

async function generateChatReply({ chatbot, knowledgeText, session, userText }) {
  const justActivated = detectActivation(userText, session.activationKey);
  if (justActivated && !session.isActivated) {
    session.isActivated = true;
  }

  const systemPrompt = buildSystemPrompt(chatbot, knowledgeText, session.isActivated);
  const turnInstruction = buildTurnInstruction(userText, session.isActivated);

  const history = (session.history || []).map((item) => ({
    role: item.role === 'bot' ? 'model' : 'user',
    parts: [{ text: item.text }],
  }));

  const models = getModelCandidates(geminiConfig.chatModel);

  const replyText = await withModelFallback(models, async (modelName) => {
    console.log(`[gemini] Chat using model: ${modelName}`);
    const model = getClient().getGenerativeModel({
      model: modelName,
      systemInstruction: systemPrompt,
    });

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(turnInstruction);
    const text = (result.response?.text?.() || '').trim();

    if (!text) {
      throw new Error('Gemini returned an empty reply');
    }

    return text;
  });

  return {
    replyText,
    isActivated: session.isActivated,
    justActivated,
  };
}

module.exports = {
  detectActivation,
  generateChatReply,
};
