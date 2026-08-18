/**
 * Dedicated Gemini call for wake-word detection (any language).
 * Transcribe → translate meaning → map onto this chatbot's saved keys.
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { geminiConfig, assertGeminiConfigured, getModelCandidates } = require('../config/geminiConfig');
const { withModelFallback } = require('../utils/geminiHelper');
const {
  getActivationKeywords,
  detectActivation,
  matchActivationKey,
  hasGreetingWakeKey,
  isGreetingFamilyKey,
  normalizeForMatch,
} = require('../live/liveActivation');
const { buildWakeDetectPrompt, buildWakeTextPrompt } = require('../live/wakeDetectPrompt');
const { toRomanDisplay } = require('../live/romanizeTranscript');

let client = null;

function getClient() {
  assertGeminiConfigured();
  if (!client) {
    client = new GoogleGenerativeAI(geminiConfig.apiKey);
  }
  return client;
}

function parseWakeJson(raw) {
  const text = String(raw || '').trim();
  const empty = {
    match: false,
    heard: '',
    english: '',
    matchedKey: null,
    parseOk: false,
    raw: text.slice(0, 240),
  };
  if (!text) return empty;

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        match: parsed.match === true || parsed.match === 'true' || parsed.match === 1,
        heard: String(parsed.heard || '').slice(0, 160),
        english: String(parsed.english || parsed.meaning || parsed.translation || '').slice(0, 80),
        matchedKey: parsed.matchedKey ? String(parsed.matchedKey) : null,
        parseOk: true,
        raw: text.slice(0, 240),
      };
    } catch {
      // truncated JSON — fall through
    }
  }

  const matchTrue = /"match"\s*:\s*true/i.test(text) || /^\s*YES\b/i.test(text);
  const matchFalse = /"match"\s*:\s*false/i.test(text) || /^\s*NO\b/i.test(text);
  const heardField = text.match(/"heard"\s*:\s*"((?:\\.|[^"\\])*)"/);
  const englishField = text.match(/"english"\s*:\s*"((?:\\.|[^"\\])*)"/);
  const keyField = text.match(/"matchedKey"\s*:\s*"((?:\\.|[^"\\])*)"/);

  return {
    match: matchTrue && !matchFalse,
    heard: heardField ? heardField[1].slice(0, 160) : text.slice(0, 80),
    english: englishField ? englishField[1].slice(0, 80) : '',
    matchedKey: keyField ? keyField[1] : null,
    parseOk: false,
    raw: text.slice(0, 240),
  };
}

function isShortWakePhrase(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 48) return false;
  return t.split(/\s+/).filter(Boolean).length <= 6;
}

/**
 * Map classifier output onto THIS bot's saved keys.
 * Uses original speech, English meaning, and the model's matchedKey.
 */
function resolveAgainstSavedKeys(parsed, chatbot) {
  const keys = getActivationKeywords(chatbot);
  if (!keys.length) return { ...parsed, match: false, matchedKey: null };

  const candidates = [parsed.matchedKey, parsed.english, parsed.heard]
    .map((v) => String(v || '').trim())
    .filter(Boolean);

  for (const c of candidates) {
    if (!detectActivation(c, chatbot)) continue;
    const key = keys.find((k) => matchActivationKey(c, k)) || keys[0];
    return { ...parsed, match: true, matchedKey: key };
  }

  if (parsed.match && parsed.parseOk) {
    const exact = keys.find((k) => normalizeForMatch(parsed.matchedKey) === k);
    if (exact) return { ...parsed, match: true, matchedKey: exact };

    // LLM said yes — trust it onto the saved list (any future keyword, not hardcoded).
    if (keys.length === 1) {
      return { ...parsed, match: true, matchedKey: keys[0] };
    }

    if (hasGreetingWakeKey(chatbot) && isShortWakePhrase(parsed.english || parsed.heard)) {
      return {
        ...parsed,
        match: true,
        matchedKey: keys.find(isGreetingFamilyKey) || keys[0],
      };
    }
  }

  return { ...parsed, match: false, matchedKey: null };
}

function pcm16kToWavBase64(pcmBase64) {
  const pcm = Buffer.from(String(pcmBase64 || ''), 'base64');
  if (!pcm.length) return '';

  const sampleRate = 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]).toString('base64');
}

function wakeGenerationConfig() {
  return {
    temperature: 0,
    maxOutputTokens: 1024,
    responseMimeType: 'application/json',
    thinkingConfig: { thinkingBudget: 0 },
  };
}

function wakeClassifierModels() {
  const primary = geminiConfig.sttModel || 'gemini-2.5-flash';
  return [primary, 'gemini-2.5-flash', 'gemini-2.5-flash-lite'].filter(
    (name, idx, arr) => name && !/gemini-1\.5|gemini-2\.0-flash|gemini-3/i.test(name) && arr.indexOf(name) === idx
  );
}

async function generateWakeRaw(modelName, parts) {
  const configs = [
    wakeGenerationConfig(),
    { temperature: 0, maxOutputTokens: 1024, responseMimeType: 'application/json' },
    { temperature: 0, maxOutputTokens: 1024 },
  ];

  let lastError;
  for (const generationConfig of configs) {
    try {
      const model = getClient().getGenerativeModel({ model: modelName, generationConfig });
      const result = await model.generateContent(parts);
      return (result.response?.text?.() || '').trim();
    } catch (err) {
      lastError = err;
      const msg = String(err?.message || '');
      if (/thinkingconfig|responsemimetype|invalid/i.test(msg)) continue;
      throw err;
    }
  }
  throw lastError;
}

function isWakeTextCandidate(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 80) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 8;
}

async function classifyWakeText({ chatbot, heard } = {}) {
  const keys = getActivationKeywords(chatbot);
  const roman = toRomanDisplay(heard);
  if (!keys.length || !isWakeTextCandidate(roman || heard)) {
    return { match: false, heard: roman || '', english: '', matchedKey: null, parseOk: false };
  }

  const prompt = buildWakeTextPrompt(keys, roman || heard);
  const t0 = Date.now();
  const raw = await withModelFallback(wakeClassifierModels(), async (modelName) => {
    console.log(`[wake] Text resemblance using ${modelName}`);
    return generateWakeRaw(modelName, prompt);
  });

  const parsed = resolveAgainstSavedKeys(parseWakeJson(raw), chatbot);
  console.log(
    `[wake] text-classify ${Date.now() - t0}ms match=${parsed.match}`
    + ` heard="${toRomanDisplay(parsed.heard || roman)}" key=${parsed.matchedKey || '—'}`
  );
  return parsed;
}

async function classifyWakeUtterance({ chatbot, base64Audio, mimeType = 'audio/pcm;rate=16000' } = {}) {
  const keys = getActivationKeywords(chatbot);
  if (!keys.length || !base64Audio) {
    return { match: false, heard: '', english: '', matchedKey: null, parseOk: false };
  }

  const isPcm = /pcm/i.test(String(mimeType || ''));
  const audioData = isPcm ? pcm16kToWavBase64(base64Audio) : base64Audio;
  const sendMime = isPcm ? 'audio/wav' : (mimeType || 'audio/wav');
  if (!audioData) return { match: false, heard: '', english: '', matchedKey: null, parseOk: false };

  const prompt = buildWakeDetectPrompt(keys);
  const t0 = Date.now();

  const raw = await withModelFallback(wakeClassifierModels(), async (modelName) => {
    console.log(`[wake] Classifier using ${modelName}`);
    return generateWakeRaw(modelName, [
      { inlineData: { data: audioData, mimeType: sendMime } },
      { text: prompt },
    ]);
  });

  const parsed = resolveAgainstSavedKeys(parseWakeJson(raw), chatbot);
  console.log(
    `[wake] classify ${Date.now() - t0}ms match=${parsed.match}`
    + ` heard="${toRomanDisplay(parsed.heard)}" en="${parsed.english}" key=${parsed.matchedKey || '—'}`
    + ` parseOk=${parsed.parseOk}`
  );
  if (!parsed.parseOk) {
    console.warn(`[wake] classifier JSON incomplete: ${parsed.raw}`);
  }
  return parsed;
}

module.exports = { classifyWakeUtterance, classifyWakeText, isWakeTextCandidate };
