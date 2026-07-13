/**
 * Mindee OCR configuration from environment.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

function getMindeeConfig() {
  // Prefer V2 key name used by Mindee SDK docs, then our project name
  const apiKey = String(
    process.env.MINDEE_API_KEY || process.env.MINDEE_V2_API_KEY || ''
  ).trim();
  const modelId = String(process.env.MINDEE_MODEL_ID || '').trim();

  return { apiKey, modelId };
}

function assertMindeeConfigured() {
  const { apiKey, modelId } = getMindeeConfig();
  if (!apiKey || !modelId) {
    throw new Error(
      'MINDEE_API_KEY or MINDEE_MODEL_ID is missing from backend/.env — restart the server after adding them'
    );
  }
  return { apiKey, modelId };
}

module.exports = {
  getMindeeConfig,
  assertMindeeConfigured,
};
