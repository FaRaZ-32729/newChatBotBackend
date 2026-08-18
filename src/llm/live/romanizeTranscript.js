/**
 * Live STT often writes Hindi/Urdu in native script (and jams spaces).
 * Convert to Roman for logs + map spelled Latin letters (आई ओ टी एफ आई वाई → iotfiy).
 */

const INDEPENDENT_VOWELS = {
  अ: 'a',
  आ: 'aa',
  इ: 'i',
  ई: 'i',
  उ: 'u',
  ऊ: 'u',
  ए: 'e',
  ऐ: 'ai',
  ओ: 'o',
  औ: 'au',
  ऋ: 'ri',
};

const VOWEL_SIGNS = {
  'ा': 'aa',
  'ि': 'i',
  'ी': 'i',
  'ु': 'u',
  'ू': 'u',
  'े': 'e',
  'ै': 'ai',
  'ो': 'o',
  'ौ': 'au',
  'ृ': 'ri',
  'ं': 'n',
  'ँ': 'n',
  'ः': 'h',
  '्': '',
};

const CONSONANTS = {
  क: 'k',
  ख: 'kh',
  ग: 'g',
  घ: 'gh',
  ङ: 'ng',
  च: 'ch',
  छ: 'chh',
  ज: 'j',
  झ: 'jh',
  ञ: 'ny',
  ट: 't',
  ठ: 'th',
  ड: 'd',
  ढ: 'dh',
  ण: 'n',
  त: 't',
  थ: 'th',
  द: 'd',
  ध: 'dh',
  न: 'n',
  प: 'p',
  फ: 'ph',
  ब: 'b',
  भ: 'bh',
  म: 'm',
  य: 'y',
  र: 'r',
  ल: 'l',
  व: 'v',
  श: 'sh',
  ष: 'sh',
  स: 's',
  ह: 'h',
  ळ: 'l',
  ड़: 'd',
  ढ़: 'dh',
  फ़: 'f',
  ज़: 'z',
  क़: 'q',
  ख़: 'kh',
  ग़: 'g',
};

/** Longest-first: Hindi/Urdu names of English letters. */
const LETTER_NAMES = [
  ['डब्ल्यू', 'w'],
  ['डब्लू', 'w'],
  ['डबल्यू', 'w'],
  ['एक्स', 'x'],
  ['वाई', 'y'],
  ['ज़ेड', 'z'],
  ['जेड', 'z'],
  ['क्यू', 'q'],
  ['एच', 'h'],
  ['एफ', 'f'],
  ['एल', 'l'],
  ['एम', 'm'],
  ['एन', 'n'],
  ['आर', 'r'],
  ['एस', 's'],
  ['बी', 'b'],
  ['सी', 'c'],
  ['डी', 'd'],
  ['जी', 'g'],
  ['जे', 'j'],
  ['के', 'k'],
  ['पी', 'p'],
  ['टी', 't'],
  ['वी', 'v'],
  ['यू', 'u'],
  ['ओ', 'o'],
  ['आई', 'i'],
  ['आई', 'i'],
  ['डبلیو', 'w'],
  ['ڈبلو', 'w'],
  ['ایکس', 'x'],
  ['وائی', 'y'],
  ['زیڈ', 'z'],
  ['کیو', 'q'],
  ['ایچ', 'h'],
  ['ایف', 'f'],
  ['ایل', 'l'],
  ['ایم', 'm'],
  ['این', 'n'],
  ['آر', 'r'],
  ['ایس', 's'],
  ['بی', 'b'],
  ['سی', 'c'],
  ['ڈی', 'd'],
  ['جی', 'g'],
  ['جے', 'j'],
  ['کے', 'k'],
  ['پی', 'p'],
  ['ٹی', 't'],
  ['وی', 'v'],
  ['یو', 'u'],
  ['او', 'o'],
  ['آئی', 'i'],
].sort((a, b) => b[0].length - a[0].length);

const URDU_LETTERS = {
  ا: 'a',
  آ: 'aa',
  ب: 'b',
  پ: 'p',
  ت: 't',
  ٹ: 't',
  ث: 's',
  ج: 'j',
  چ: 'ch',
  ح: 'h',
  خ: 'kh',
  د: 'd',
  ڈ: 'd',
  ذ: 'z',
  ر: 'r',
  ڑ: 'r',
  ز: 'z',
  ژ: 'zh',
  س: 's',
  ش: 'sh',
  ص: 's',
  ض: 'z',
  ط: 't',
  ظ: 'z',
  ع: 'a',
  غ: 'gh',
  ف: 'f',
  ق: 'q',
  ک: 'k',
  گ: 'g',
  ل: 'l',
  م: 'm',
  ن: 'n',
  و: 'o',
  ہ: 'h',
  ھ: 'h',
  ء: '',
  ی: 'i',
  ے: 'e',
  ة: 'h',
};

function hasIndicOrArabic(text) {
  return /[\u0900-\u097F\u0600-\u06FF]/.test(String(text || ''));
}

function matchLetterName(text, index) {
  for (const [name, letter] of LETTER_NAMES) {
    if (text.startsWith(name, index)) {
      return { letter, len: name.length };
    }
  }
  return null;
}

function decodeSpelledLatin(text) {
  const raw = String(text || '');
  let i = 0;
  let out = '';
  while (i < raw.length) {
    const hit = matchLetterName(raw, i);
    if (hit) {
      out += hit.letter;
      i += hit.len;
    } else {
      i += 1;
    }
  }
  return out.toLowerCase();
}

function consumeDevanagari(text, i) {
  const ch = text[i];
  if (INDEPENDENT_VOWELS[ch]) {
    let roman = INDEPENDENT_VOWELS[ch];
    let len = 1;
    if (text[i + 1] === 'ं' || text[i + 1] === 'ँ') {
      roman += 'n';
      len = 2;
    }
    return { roman, len };
  }

  const cons = CONSONANTS[ch];
  if (cons) {
    let len = 1;
    let roman = cons;
    const n1 = text[i + 1];
    if (n1 === '्') {
      const nested = text[i + 2] && CONSONANTS[text[i + 2]]
        ? consumeDevanagari(text, i + 2)
        : { roman: '', len: 0 };
      return { roman: roman + nested.roman, len: 2 + nested.len };
    }
    if (VOWEL_SIGNS[n1] !== undefined) {
      roman += VOWEL_SIGNS[n1];
      len = 2;
      if (text[i + 2] === 'ं' || text[i + 2] === 'ँ') {
        roman += 'n';
        len = 3;
      }
      return { roman, len };
    }
    roman += 'a';
    if (n1 === 'ं' || n1 === 'ँ') {
      roman += 'n';
      len = 2;
    }
    return { roman, len };
  }

  if (VOWEL_SIGNS[ch] !== undefined) {
    return { roman: VOWEL_SIGNS[ch], len: 1 };
  }
  return null;
}

function toRoman(text) {
  const raw = String(text || '');
  if (!raw) return '';
  if (!hasIndicOrArabic(raw)) return raw;

  let i = 0;
  let out = '';
  let inSpelled = false;

  while (i < raw.length) {
    const spelled = matchLetterName(raw, i);
    if (spelled) {
      if (!inSpelled && out && !out.endsWith(' ')) out += ' ';
      out += spelled.letter;
      inSpelled = true;
      i += spelled.len;
      continue;
    }

    if (inSpelled) {
      out += ' ';
      inSpelled = false;
    }

    if (/\s/.test(raw[i])) {
      out += ' ';
      i += 1;
      continue;
    }

    const deva = consumeDevanagari(raw, i);
    if (deva) {
      out += deva.roman;
      i += deva.len;
      continue;
    }

    const ur = URDU_LETTERS[raw[i]];
    if (ur !== undefined) {
      out += ur;
      i += 1;
      continue;
    }

    out += raw[i];
    i += 1;
  }

  return out
    .replace(/a(?=\s|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function addHindiWordSpaces(roman) {
  const common = [
    'mujhe', 'pahale', 'pehle', 'apane', 'apne', 'baare', 'men', 'mein', 'kuchh', 'kuch',
    'bata', 'batao', 'plij', 'please', 'achchha', 'accha', 'theek', 'kaun', 'kaunsa',
    'solution', 'provide', 'karta', 'karti', 'hai', 'hain', 'aap', 'main', 'mera', 'naam',
    'nahi', 'nahin', 'kyon', 'kyun', 'kya', 'aur', 'ye', 'yeh', 'wo', 'us', 'ke', 'ki', 'ka',
    'ko', 'se', 'par', 'pe', 'thoda', 'detail', 'english', 'roman', 'hindi', 'urdu',
  ];
  let out = String(roman || '');
  for (const word of common.sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(${word})(?=[a-z])`, 'gi');
    out = out.replace(re, '$1 ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

function toRomanDisplay(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const roman = toRoman(raw);
  const spaced = addHindiWordSpaces(roman || raw);
  return spaced || raw;
}

function compactLatin(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** All forms to test against a saved activation key. */
function wakeMatchForms(text) {
  const raw = String(text || '').trim();
  const roman = toRomanDisplay(raw);
  const spelled = decodeSpelledLatin(raw);
  return [...new Set([raw, roman, spelled, compactLatin(roman), compactLatin(spelled)].filter(Boolean))];
}

module.exports = {
  toRoman,
  toRomanDisplay,
  decodeSpelledLatin,
  wakeMatchForms,
  hasIndicOrArabic,
  compactLatin,
};
