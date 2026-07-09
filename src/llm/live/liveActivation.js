/**
 * Activation + noise helpers for live voice sessions.
 */

function isNoiseTranscript(text) {
  const t = String(text || '').trim();
  if (!t || t.length < 2) return true;
  if (/^<noise>$/i.test(t)) return true;
  if (/^<[^>]+>$/i.test(t)) return true;
  if (/^[\s.,!?]+$/.test(t)) return true;
  return false;
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GREETING_PATTERN =
  /\b(hi|hello|hey|halo|salam|salaam|salam\s+alaikum|salam\s+alekum|assalam|assalamu|assalamu\s+alaikum|alaikum|alekum|walaikum|aoa|adaab|namaste)\b/i;

function matchActivationKey(said, activationKey) {
  const key = normalizeForMatch(activationKey);
  if (!key || key.length < 1) return false;

  const normalized = normalizeForMatch(said);
  if (!normalized) return false;

  if (normalized === key || normalized.includes(key)) return true;

  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(^| )${escaped}( |$)`).test(normalized)) return true;

  const keyWords = key.split(' ').filter((w) => w.length >= 1);
  if (keyWords.length > 1 && keyWords.every((w) => normalized.includes(w))) return true;
  if (keyWords.length === 1 && keyWords[0].length >= 2 && normalized.includes(keyWords[0])) return true;

  return false;
}

function matchBotName(said, chatbot) {
  const name = normalizeForMatch(chatbot.name);
  if (!name || name.length < 2) return false;
  const normalized = normalizeForMatch(said);
  return normalized === name || normalized.includes(name);
}

function detectActivation(text, chatbot) {
  const said = normalizeForMatch(text);
  if (!said) return false;

  if (matchActivationKey(said, chatbot.activationKey)) return true;
  if (matchBotName(said, chatbot)) return true;
  if (GREETING_PATTERN.test(said)) return true;
  if (/good\s+(morning|afternoon|evening)/i.test(said)) return true;

  return false;
}

const GREETING_ONLY = /^(hi|hello|hey|salam|assalam|ok|okay|thanks|thank you)\b/i;

function shouldDispatchImagesForUtterance(text) {
  const t = String(text || '').trim();
  if (!t || isNoiseTranscript(t)) return false;
  if (t.length < 4) return false;
  if (GREETING_ONLY.test(t) && t.length < 30) return false;
  return true;
}

module.exports = {
  isNoiseTranscript,
  detectActivation,
  matchActivationKey,
  shouldDispatchImagesForUtterance,
};
