/**
 * Dedicated wake-word detector prompt.
 * Listen in any language → translate meaning → map onto this bot's saved keys.
 */

function hintForKey(key) {
  const k = String(key || '').toLowerCase();
  if (/hello|hallo|helo|hullo/.test(k)) {
    return `- ${key}  ←  hello / hi / hey, ہیلو, هلو, हेलो, हैलो, हाय, namaste, bonjour, hola, hallo (any language greeting that means hello)`;
  }
  if (/^(hi|hey|hii|hay)$/.test(k)) {
    return `- ${key}  ←  hi / hey / hello, ہائے, हाय, ہے, ہیلو`;
  }
  if (/salam|salaam|assalam|alaikum|alaykum/.test(k)) {
    return `- ${key}  ←  salam / salaam / assalamualaikum, سلام, السلام عليكم, سلام علیکم, selam`;
  }
  return `- ${key}  ←  "${key}" in any language, script, or accent. STT often misspells it (missing/extra/swapped letters). Hindi/Urdu letter-by-letter reading of "${key}" also counts. Always return matchedKey exactly as "${key}".`;
}

function buildWakeDetectPrompt(activationKeys) {
  const keys = (Array.isArray(activationKeys) ? activationKeys : [])
    .map((k) => String(k || '').trim())
    .filter(Boolean);
  const list = keys.length ? keys.map(hintForKey).join('\n') : '- (none)';

  return `You are a wake-word detector for a kiosk. You do not chat. You do not greet the visitor. You only classify.

SAVED ACTIVATION KEYWORDS (canonical DB values — always return matchedKey as one of these):
${list}

The visitor may speak ANY language (Urdu, Hindi, Arabic, English, Roman Urdu, or other).
Write "heard" and "english" in Latin/Roman letters only (never Hindi Devanagari).

Do this in order:
1. Transcribe what they said, converted to Roman script (field "heard").
2. Translate the MEANING into short English (field "english").
3. Compare that meaning to the saved keywords above (including the listed translations).
4. If it maps to a saved keyword, match=true and matchedKey=the canonical DB keyword (not the STT spelling).

MATCH examples:
- "ہیلو" / "हेलो" / "hi" → heard "hello" → matchedKey "hello" (if hello/hi is saved)
- "سلام علیکم" → heard "salam" → matchedKey "salam" (if salam is saved)
- STT writes a close misspelling of a saved key (1–2 letters missing, extra, or swapped) → MATCH the canonical saved key
- Letter-spelled in Hindi/Urdu → MATCH the saved key

Do NOT match:
- silence, coughs, crowd noise
- unrelated words ("answer brother", "jawab bhai", questions)
- a long sentence that only talks ABOUT the keyword / bot / activation
- a totally different word that just shares 1–2 letters

Return ONLY compact JSON, no markdown, no extra keys:
{"match":true,"heard":"what you heard","english":"canonical key","matchedKey":"canonical-saved-key"}
{"match":false,"heard":"what you heard","english":"short english meaning","matchedKey":null}`;
}

function buildWakeTextPrompt(activationKeys, heard) {
  const keys = (Array.isArray(activationKeys) ? activationKeys : [])
    .map((k) => String(k || '').trim())
    .filter(Boolean);
  const list = keys.length ? keys.map((k) => `- ${k}`).join('\n') : '- (none)';
  const heardRoman = String(heard || '').trim();

  return `You are a wake-word detector for a kiosk. You do not chat. You only classify.

SAVED ACTIVATION KEYWORDS (canonical spellings from the database):
${list}

Speech-to-text heard this (already converted toward Roman):
"${heardRoman}"

The visitor may have said a saved keyword in any language. STT is often wrong: missing letter, extra letter, swapped letters, jammed words, or another script.

MATCH (match=true) if they intended ANY saved keyword, including:
- exact same word
- close misspelling / resemblance of a saved keyword (not a different word)
- same name in another language or script
- letter-by-letter reading of a saved keyword

matchedKey MUST be copied exactly from the saved list above (the canonical spelling), never the STT typo.

Do NOT match unrelated speech, numbers-only junk, or a long sentence that is only talking about the bot.

Return ONLY compact JSON:
{"match":true,"heard":"${heardRoman.replace(/"/g, '')}","english":"canonical meaning","matchedKey":"<one saved key>"}
{"match":false,"heard":"${heardRoman.replace(/"/g, '')}","english":"what they meant","matchedKey":null}`;
}

module.exports = { buildWakeDetectPrompt, buildWakeTextPrompt };
