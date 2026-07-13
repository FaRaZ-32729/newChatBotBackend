/**
 * Activation helpers — ONLY this chatbot's DB activationKey(s).
 * Supports one phrase or comma/pipe/semicolon-separated keywords.
 * Salam-family keys also accept Arabic/Urdu script + common Latin variants.
 */

function isNoiseTranscript(text) {
  const t = String(text || '')
    .replace(/<noise>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.length < 2) return true;
  if (/^[\s.,!?]+$/.test(t)) return true;
  return false;
}

/** Keep Latin + Arabic/Urdu/Hindi letters. */
function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse DB activationKey into individual keywords.
 * e.g. "salam" | "salam, hello" | "assalam | salaam"
 */
function getActivationKeywords(chatbotOrKey) {
  const raw =
    typeof chatbotOrKey === 'string'
      ? chatbotOrKey
      : String(chatbotOrKey?.activationKey || '');

  return raw
    .split(/[,|;/]+/)
    .map((s) => normalizeForMatch(s))
    .filter((s) => s.length >= 1);
}

function isSalamFamilyKey(key) {
  return /(salam|salaam|assalam|alaikum|alaykum|aleikum)/.test(normalizeForMatch(key));
}

/** Latin variants for a DB salam-family phrase (STT often differs from stored spelling). */
function salamLatinAliases(key) {
  const base = [
    key,
    'salam',
    'salaam',
    'assalam',
    'asalam',
    'assalamualaikum',
    'assalamu alaikum',
    'assalam o alaikum',
    'salam o alaikum',
    'salam alaikum',
    'salaam alaikum',
    'salamoalaikum',
  ];
  // Also keep distinctive words from the stored key
  const words = normalizeForMatch(key).split(/\s+/).filter((w) => w.length >= 4);
  return [...new Set([...base, ...words])];
}

/**
 * Strict match: full phrase as its own token(s), not loose substring of longer words.
 */
function matchOneKeyword(saidNormalized, key) {
  if (!saidNormalized || !key) return false;

  if (saidNormalized === key) return true;

  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  if (new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(saidNormalized)) return true;

  // Multi-word keys: compact form ("salam o alaikum" ↔ "salamoalaikum")
  if (key.includes(' ')) {
    const compactSaid = saidNormalized.replace(/\s+/g, '');
    const compactKey = key.replace(/\s+/g, '');
    if (compactKey.length >= 4 && compactSaid.includes(compactKey)) return true;
  }

  return false;
}

function matchSalamFamily(raw, key) {
  if (!isSalamFamilyKey(key)) return false;

  // Arabic / Urdu script (Gemini STT often returns this for spoken salam)
  if (/السلام|علیکم|عليكم|سلام|وعلیکم|وعليكم/.test(String(raw || ''))) {
    return true;
  }

  const normalized = normalizeForMatch(raw);
  if (!normalized) return false;

  // Compact Arabic-ish leftovers after normalize still may include سلام
  if (/سلام|علیکم|عليكم|السلام/.test(normalized)) return true;

  return salamLatinAliases(key).some((alias) => matchOneKeyword(normalized, normalizeForMatch(alias)));
}

function matchActivationKey(said, activationKey) {
  const normalized = normalizeForMatch(said);
  if (!normalized && !String(said || '').trim()) return false;

  const keys = getActivationKeywords(activationKey);
  return keys.some((key) => {
    if (matchOneKeyword(normalized, key)) return true;
    if (matchSalamFamily(said, key)) return true;
    return false;
  });
}

/**
 * Activate ONLY when spoken text matches this chatbot's DB activationKey(s).
 * Salam-family DB keys also accept Arabic script + common Latin spellings.
 */
function detectActivation(text, chatbot) {
  const raw = String(text || '').trim();
  if (!raw || isNoiseTranscript(raw)) return false;

  const keys = getActivationKeywords(chatbot);
  if (!keys.length) {
    console.warn('[live] No activationKey on chatbot — refusing activation');
    return false;
  }

  const matched = keys.some((key) => {
    const normalized = normalizeForMatch(raw);
    if (matchOneKeyword(normalized, key)) return true;
    if (matchSalamFamily(raw, key)) return true;
    return false;
  });

  if (matched) {
    console.log(`[live] Activation keyword matched from DB keys [${keys.join(' | ')}] in: "${raw}"`);
  }
  return matched;
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
  getActivationKeywords,
  shouldDispatchImagesForUtterance,
};
