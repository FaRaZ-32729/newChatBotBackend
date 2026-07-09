/**
 * Speech helpers for Gemini:
 * 1) Speech-to-text: user audio → transcript
 * 2) Text-to-speech: bot text → male human-like voice audio (base64)
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { geminiConfig, assertGeminiConfigured, getModelCandidates } = require('../config/geminiConfig');
const { withModelFallback, withRetry } = require('../utils/geminiHelper');

let client = null;

function getClient() {
  assertGeminiConfigured();
  if (!client) {
    client = new GoogleGenerativeAI(geminiConfig.apiKey);
  }
  return client;
}

/**
 * Convert uploaded audio into plain text using Gemini (tries fallback models on quota error).
 */
async function transcribeAudio({ base64Audio, mimeType = 'audio/webm' }) {
  assertGeminiConfigured();

  const models = getModelCandidates(geminiConfig.sttModel);

  return withModelFallback(models, async (modelName) => {
    console.log(`[gemini] STT using model: ${modelName}`);
    const model = getClient().getGenerativeModel({ model: modelName });

    const result = await model.generateContent([
      {
        inlineData: {
          data: base64Audio,
          mimeType,
        },
      },
      {
        text: [
          'Transcribe the spoken words in this audio.',
          'Return ONLY the transcript text.',
          'Do not add labels, quotes, or explanation.',
          'If the audio is empty or unintelligible, return an empty string.',
        ].join(' '),
      },
    ]);

    return (result.response?.text?.() || '').trim();
  });
}

/**
 * Turn reply text into spoken audio with a fixed male voice.
 */
async function synthesizeMaleSpeech(text) {
  assertGeminiConfigured();

  const spoken = String(text || '').trim();
  if (!spoken) {
    throw new Error('Nothing to speak');
  }

  const ttsPrompt = [
    'Speak the following text in a natural, warm, human-like adult male voice.',
    'Clear pronunciation, calm pace, professional but friendly.',
    'Do not add extra words.',
    '',
    spoken,
  ].join('\n');

  const url = `${geminiConfig.apiBaseUrl}/models/${geminiConfig.ttsModel}:generateContent?key=${geminiConfig.apiKey}`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: ttsPrompt }],
      },
    ],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: geminiConfig.voiceName,
          },
        },
      },
    },
  };

  const data = await withRetry(async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = await response.json();

    if (!response.ok) {
      const err = new Error(json?.error?.message || `TTS request failed (${response.status})`);
      err.status = response.status;
      throw err;
    }

    return json;
  });

  const inline = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!inline?.data) {
    throw new Error('TTS returned no audio data');
  }

  return {
    audioBase64: inline.data,
    mimeType: inline.mimeType || 'audio/L16;rate=24000',
  };
}

module.exports = {
  transcribeAudio,
  synthesizeMaleSpeech,
};
