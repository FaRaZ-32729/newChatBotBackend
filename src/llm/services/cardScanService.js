const { GoogleGenerativeAI } = require('@google/generative-ai');
const { geminiConfig, assertGeminiConfigured } = require('../config/geminiConfig');

async function extractCardFromImage(base64Data, mimeType = 'image/jpeg') {
  assertGeminiConfigured();

  const client = new GoogleGenerativeAI(geminiConfig.apiKey);
  const model = client.getGenerativeModel({ model: geminiConfig.chatModel });

  const prompt = `Extract visiting card / business card details from this image.
Return ONLY valid JSON with keys: name, company, designation, phone, email, rawText.
Use empty string for missing fields. rawText is all readable text on the card.`;

  const result = await model.generateContent([
    { text: prompt },
    {
      inlineData: {
        mimeType,
        data: base64Data.replace(/^data:[^;]+;base64,/, ''),
      },
    },
  ]);

  const text = (result.response?.text?.() || '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  let parsed = {};

  if (jsonMatch) {
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      parsed = { rawText: text };
    }
  } else {
    parsed = { rawText: text };
  }

  return {
    name: String(parsed.name || '').trim(),
    company: String(parsed.company || '').trim(),
    designation: String(parsed.designation || '').trim(),
    phone: String(parsed.phone || '').trim(),
    email: String(parsed.email || '').trim(),
    rawText: String(parsed.rawText || text).trim(),
  };
}

module.exports = { extractCardFromImage };
