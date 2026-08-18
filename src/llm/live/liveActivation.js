/**
 * Activation helpers — ONLY this chatbot's DB activationKey(s).
 * Supports one phrase or comma/pipe/semicolon-separated keywords.
 * Salam-family keys also accept Arabic/Urdu script + common Latin variants.
 * Greeting keys (hi/hello/hey) accept phonetic STT near-misses.
 */

const { toRomanDisplay, wakeMatchForms } = require('./romanizeTranscript');

const VAD_FALLBACK_MIN_MS = 400;
const VAD_FALLBACK_MAX_MS = 3500;

const HELLO_ALIASES = [
  'hello',
  'hallo',
  'hullo',
  'helo',
  'hellow',
  'hallow',
  'halo',
  'yellow',
  'helu',
  'ello',
];

const HI_ALIASES = ['hi', 'hey', 'hay', 'hii', 'heyy'];

/** Hello/hi spoken in other scripts or languages (maps back to a saved greeting key). */
const HELLO_ANY_LANGUAGE =
  /ہیلو|هيلاو?|هلو+|ہائے|हेलो|हैलो|हाय|नमस्ते|नमस्कार|bonjour|hola|ciao|olá|merhaba|こんにちは|你好|안녕/;

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

function levenshtein(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const row = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) row[j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cur = row[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = cur;
    }
  }
  return row[t.length];
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

function isHelloFamilyKey(key) {
  const k = normalizeForMatch(key);
  return k === 'hello' || HELLO_ALIASES.includes(k);
}

function isHiFamilyKey(key) {
  const k = normalizeForMatch(key);
  return HI_ALIASES.includes(k);
}

function isGreetingFamilyKey(key) {
  return isHelloFamilyKey(key) || isHiFamilyKey(key) || isSalamFamilyKey(key);
}

function hasGreetingWakeKey(chatbotOrKey) {
  return getActivationKeywords(chatbotOrKey).some(isGreetingFamilyKey);
}

function latinLetterRatio(text) {
  const letters = String(text || '').match(/\p{L}/gu) || [];
  if (!letters.length) return 0;
  let latin = 0;
  for (const ch of letters) {
    const base = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    if (/[a-z]/i.test(base)) latin += 1;
  }
  return latin / letters.length;
}

/**
 * Gemini Live often transcribes short "hello" as Thai/Sinhala/CJK fragments.
 */
function isJunkWakeTranscript(text) {
  const raw = String(text || '').trim();
  if (!raw) return true;
  if (isNoiseTranscript(raw)) return true;

  const stripped = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
  if (stripped.length <= 2) return true;

  if (/[\u0E00-\u0E7F\u0D80-\u0DFF\u0B80-\u0BFF\u0900-\u097F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/u.test(raw)
    && latinLetterRatio(raw) < 0.35) {
    return true;
  }

  if (latinLetterRatio(raw) < 0.25 && !/[\u0600-\u06FF]/.test(raw)) {
    return true;
  }

  return false;
}

function shouldVadFallbackActivate({ chatbot, sttText, speakMs } = {}) {
  if (!hasGreetingWakeKey(chatbot)) return false;
  const ms = Number(speakMs);
  if (!Number.isFinite(ms) || ms < VAD_FALLBACK_MIN_MS || ms > VAD_FALLBACK_MAX_MS) {
    return false;
  }
  return isJunkWakeTranscript(sttText);
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

  const compactSaid = saidNormalized.replace(/\s+/g, '');
  const compactKey = key.replace(/\s+/g, '');
  if (compactKey.length >= 4 && compactSaid.includes(compactKey)) return true;

  return false;
}

/** "आईओटीएफआईवाई" / "iotfiy" / jammed roman vs a custom saved key like iotfiy. */
function matchBrandOrSpelledKey(said, key) {
  const compactKey = normalizeForMatch(key).replace(/\s+/g, '');
  if (compactKey.length < 3) return false;

  const forms = wakeMatchForms(said);
  return forms.some((form) => {
    const compact = normalizeForMatch(form).replace(/\s+/g, '');
    if (!compact) return false;
    if (compact === compactKey) return true;
    if (compactKey.length >= 4 && compact.includes(compactKey)) return true;
    return false;
  });
}

function matchHelloFamily(saidNormalized, key, raw) {
  if (!isHelloFamilyKey(key) && !isHiFamilyKey(key)) return false;
  if (HELLO_ANY_LANGUAGE.test(String(raw || '')) || HELLO_ANY_LANGUAGE.test(String(saidNormalized || ''))) {
    return true;
  }
  const tokens = String(saidNormalized || '').split(/\s+/).filter(Boolean);
  const aliases = isHiFamilyKey(key) ? HI_ALIASES : [...HELLO_ALIASES, ...HI_ALIASES];

  return tokens.some((tok) => {
    if (aliases.includes(tok)) return true;
    if (tok.length < 4) return false;
    return aliases.some((alias) => alias.length >= 4 && levenshtein(tok, alias) <= 1);
  });
}

function matchSalamFamily(raw, key) {
  if (!isSalamFamilyKey(key)) return false;

  if (/السلام|علیکم|عليكم|سلام|وعلیکم|وعليكم/.test(String(raw || ''))) {
    return true;
  }

  const normalized = normalizeForMatch(raw);
  if (!normalized) return false;

  if (/سلام|علیکم|عليكم|السلام/.test(normalized)) return true;

  return salamLatinAliases(key).some((alias) => matchOneKeyword(normalized, normalizeForMatch(alias)));
}

function matchActivationKey(said, activationKey) {
  const normalized = normalizeForMatch(said);
  if (!normalized && !String(said || '').trim()) return false;

  const keys = getActivationKeywords(activationKey);
  return keys.some((key) => {
    if (matchOneKeyword(normalized, key)) return true;
    if (matchHelloFamily(normalized, key, said)) return true;
    if (matchSalamFamily(said, key)) return true;
    if (matchBrandOrSpelledKey(said, key)) return true;
    return false;
  });
}

/**
 * Activate when spoken text matches this chatbot's DB activationKey(s),
 * including phonetic near-misses for greeting keys.
 */
function detectActivation(text, chatbot) {
  const raw = String(text || '').trim();
  if (!raw || isNoiseTranscript(raw)) return false;

  const keys = getActivationKeywords(chatbot);
  if (!keys.length) {
    console.warn('[live] No activationKey on chatbot — refusing activation');
    return false;
  }

  const variants = wakeMatchForms(raw);
  const matched = keys.some((key) => variants.some((said) => {
    const normalized = normalizeForMatch(said);
    if (matchOneKeyword(normalized, key)) return true;
    if (matchHelloFamily(normalized, key, said)) return true;
    if (matchSalamFamily(said, key) || matchSalamFamily(raw, key)) return true;
    if (matchBrandOrSpelledKey(said, key) || matchBrandOrSpelledKey(raw, key)) return true;
    return false;
  }));

  if (matched) {
    console.log(
      `[live] Activation keyword matched from DB keys [${keys.join(' | ')}]`
      + ` in: "${toRomanDisplay(raw)}"`
    );
  }
  return matched;
}

const GREETING_ONLY = /^(hi|hello|hey|salam|assalam|ok|okay|thanks|thank you)\b/i;

function shouldDispatchImagesForUtterance(text) {
  const t = String(text || '').trim();
  if (!t || isNoiseTranscript(t)) return false;
  const norm = normalizeForMatch(t);
  if (norm.length < 4) return false;
  if (GREETING_ONLY.test(norm) && norm.length < 30) return false;
  return true;
}

/** Wake phrase only (hello/salam/iotfiy) — not a real product question. */
function isActivationOnlyUtterance(text, chatbot) {
  const raw = String(text || '').trim();
  if (!raw || !detectActivation(raw, chatbot)) return false;
  const norm = normalizeForMatch(raw);
  const words = norm.split(/\s+/).filter(Boolean);
  return words.length <= 5 && norm.length <= 48;
}

module.exports = {
  isNoiseTranscript,
  normalizeForMatch,
  detectActivation,
  matchActivationKey,
  getActivationKeywords,
  shouldDispatchImagesForUtterance,
  isActivationOnlyUtterance,
  hasGreetingWakeKey,
  isJunkWakeTranscript,
  shouldVadFallbackActivate,
  isGreetingFamilyKey,
  VAD_FALLBACK_MIN_MS,
  VAD_FALLBACK_MAX_MS,
};
