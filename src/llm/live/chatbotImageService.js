/**
 * Per-chatbot image catalog.
 * Slideshow is driven by LLM response (markers + spoken answer), not the user question:
 *   [[TOPIC: pdfKey]]  → prepare PDF image pool
 *   [[SHOW_IMAGE:N]]   → show related section cluster for that image
 */

function slugifyPdfKey(name) {
  return String(name || 'document')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'document';
}

function normalizeKey(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildNumberedImageCatalog(chatbot) {
  const pdfs = chatbot.knowledgeBasePdfs || [];
  const topics = [];
  const catalog = [];
  let index = 1;

  for (const pdf of pdfs) {
    const pdfKey = slugifyPdfKey(pdf.name);
    const pdfName = pdf.name || 'Document';

    topics.push({ pdfKey, displayName: pdfName });

    const images = pdf.extractedImages || [];
    for (const img of images) {
      const topic = [img.mainHeading, img.sectionHeading, img.subHeading]
        .filter(Boolean)
        .join(' — ') || img.contextText?.slice(0, 80) || pdfName;

      const imageUrl = img.imageUrl || '';
      if (!imageUrl) continue;

      catalog.push({
        id: index,
        pdfKey,
        pdfName,
        topic,
        imageUrl,
        pageNumber: img.pageNumber || null,
        contextText: img.contextText || '',
        alt: topic,
      });
      index += 1;
    }
  }

  return { catalog, topics };
}

function resolveSlideshowForTopicKey(catalog, topics, pdfKey) {
  const key = String(pdfKey || '').trim().toLowerCase();

  if (!key || key === 'general') {
    return { matched: false, pdfKey: key, pdfName: null, images: [] };
  }

  const topic = topics.find(
    (t) =>
      t.pdfKey.toLowerCase() === key
      || normalizeKey(t.pdfKey) === normalizeKey(key)
      || normalizeKey(t.displayName) === normalizeKey(key)
  );

  if (!topic) {
    const fuzzy = topics.find(
      (t) =>
        normalizeKey(t.pdfKey).includes(normalizeKey(key))
        || normalizeKey(key).includes(normalizeKey(t.pdfKey))
    );
    if (!fuzzy) {
      return { matched: false, pdfKey: key, pdfName: null, images: [] };
    }
    const images = catalog
      .filter((img) => img.pdfKey === fuzzy.pdfKey)
      .sort((a, b) => a.id - b.id);
    return {
      matched: images.length > 0,
      pdfKey: fuzzy.pdfKey,
      pdfName: fuzzy.displayName,
      images,
    };
  }

  const images = catalog
    .filter((img) => img.pdfKey === topic.pdfKey)
    .sort((a, b) => a.id - b.id);

  return {
    matched: images.length > 0,
    pdfKey: topic.pdfKey,
    pdfName: topic.displayName,
    images,
  };
}

function findCatalogImageById(catalog, imageId) {
  const id = Number(imageId);
  if (!Number.isFinite(id)) return null;
  return catalog.find((img) => img.id === id) || null;
}

function formatImageForFrontend(img) {
  return {
    id: img.id,
    url: img.imageUrl,
    topic: img.topic,
    pdfName: img.pdfName,
    pdfKey: img.pdfKey,
    pageNumber: img.pageNumber,
    alt: img.alt || img.topic,
  };
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'you', 'are', 'was',
  'have', 'has', 'had', 'will', 'can', 'our', 'their', 'they', 'them', 'its', 'into',
  'about', 'when', 'what', 'which', 'while', 'also', 'very', 'more', 'most', 'than',
  'hai', 'hain', 'ka', 'ki', 'ke', 'ko', 'se', 'mein', 'main', 'aur', 'yeh', 'woh',
  'kya', 'aap', 'hum', 'par', 'per', 'ek', 'jo', 'to', 'bhi', 'nahi', 'nahin',
  'bata', 'batao', 'bataye', 'please', 'like', 'just',
]);

function imageSearchBlob(img) {
  const file = String(img.imageUrl || '').split(/[/\\]/).pop() || '';
  return `${img.topic || ''} ${img.contextText || ''} ${img.alt || ''} ${file}`
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
}

/** Groups Overview_2 with Overview, Lost Assistance variants, etc. */
function sectionKeyFromImage(img) {
  const file = String(img.imageUrl || '')
    .split(/[/\\]/)
    .pop()
    .replace(/\.[a-z0-9]+$/i, '');
  const fromFile = file
    .replace(/_?\d+$/g, '')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
  const fromTopic = String(img.topic || '')
    .toLowerCase()
    .replace(/—/g, ' ')
    .replace(/\b(mushaba|the|and|in|detail|of|for|with)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const raw = fromFile.length >= 4 ? fromFile : fromTopic;
  return raw.replace(/\s+/g, ' ').slice(0, 80) || `img_${img.id}`;
}

function sectionKeysRelated(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const ta = new Set(a.split(' ').filter((w) => w.length > 2));
  const tb = b.split(' ').filter((w) => w.length > 2);
  if (!tb.length) return false;
  const overlap = tb.filter((w) => ta.has(w)).length;
  return overlap >= Math.min(2, tb.length) || (tb.length === 1 && ta.has(tb[0]));
}

/**
 * Related slides for one section: same PDF + same section family.
 * 1 match → single; many → carousel (not the whole PDF dump).
 */
function getRelatedImageCluster(pool, target) {
  if (!target) return [];
  const list = (Array.isArray(pool) ? pool : []).filter(
    (img) => img.pdfKey === target.pdfKey
  );
  if (!list.length) return [target];

  const key = sectionKeyFromImage(target);
  const related = list.filter((img) => sectionKeysRelated(sectionKeyFromImage(img), key));
  return (related.length ? related : [target]).sort((a, b) => a.id - b.id);
}

function tokenizeSpeech(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function isIdentitySpeech(text) {
  return /\b(hajj|umrah|pilgrim|companion|overview|problem|worship|tawaf|arafat|mina|kya\s*hai|what\s+is|batao|bataye)\b/i
    .test(String(text || ''));
}

function isFeatureSpeech(text) {
  return /\b(lost\s*(mode|assistance)|tracking|navigation|qr\s*band|offline|chat|sos|floor\s*level|group\s*creation)\b/i
    .test(String(text || ''));
}

function isBusinessSpeech(text) {
  return /\b(b2b|b2c|saas|agency|agencies|premium\s*plan|pricing|partner|operator|tour\s*operator|business\s*model)\b/i
    .test(String(text || ''));
}

function scoreImageAgainstSpeech(img, spokenText) {
  const speech = String(spokenText || '').toLowerCase();
  const tokens = tokenizeSpeech(speech);
  const hay = imageSearchBlob(img);
  const section = sectionKeyFromImage(img);
  const sectionWords = section.split(' ').filter((w) => w.length > 2);
  let score = 0;

  for (const t of tokens) {
    if (hay.includes(t) || section.includes(t)) {
      score += t.length > 5 ? 3 : 2;
    }
  }

  // Strong boost when speech hits distinctive section words (exact topic match)
  let sectionHits = 0;
  for (const w of sectionWords) {
    if (w.length < 4) continue;
    if (speech.includes(w)) {
      sectionHits += 1;
      score += 4;
    }
  }
  if (sectionHits >= 2) score += 6;
  if (sectionHits >= 3) score += 4;

  for (let i = 0; i < tokens.length - 1; i += 1) {
    const bigram = `${tokens[i]} ${tokens[i + 1]}`;
    if (hay.includes(bigram) || section.includes(bigram)) score += 6;
    const compact = `${tokens[i]}${tokens[i + 1]}`;
    if (hay.replace(/\s+/g, '').includes(compact) || section.replace(/\s+/g, '').includes(compact)) {
      score += 5;
    }
  }

  const identity = isIdentitySpeech(speech) && !isBusinessSpeech(speech);
  const feature = isFeatureSpeech(speech);
  if (identity && !feature) {
    if (/\boverview\b/i.test(hay)) score += 14;
    else if (/problem|key\s*features/i.test(hay)) score += 8;
    else if (/lost\s*assistance|location\s*tracking|qr\s*(safety\s*)?band|offline|group\s*creation|companion|hajj|umrah|pilgrim/i.test(hay)) {
      score += 3;
    }
    if (/\bb2b\b|saas|premium\s*plan|geographic\s*focus|tour\s*operator|travel\s*agenc/i.test(hay)) {
      score -= 10;
    }
  } else if (identity) {
    if (/\boverview\b/i.test(hay)) score += 4;
    else if (/problem|key\s*features|lost\s*assistance|location\s*tracking|qr\s*(safety\s*)?band|offline|group\s*creation/i.test(hay)) {
      score += 6;
    }
    if (/\bb2b\b|saas|premium\s*plan|geographic\s*focus|tour\s*operator|travel\s*agenc/i.test(hay)) {
      score -= 8;
    }
  }

  if (isBusinessSpeech(speech)) {
    if (/\bb2b\b|saas|premium|geographic|tour\s*operator|travel\s*agenc/i.test(hay)) {
      score += 8;
    }
  }

  return score;
}

function resolveImageIdForSpeech(preferredId, pool, spokenText, minScore = 2) {
  const list = Array.isArray(pool) && pool.length ? pool : [];
  if (!list.length) return preferredId;

  const preferred = list.find((img) => img.id === Number(preferredId)) || null;
  const preferredScore = preferred
    ? scoreImageAgainstSpeech(preferred, spokenText)
    : -999;

  let best = preferred;
  let bestScore = preferredScore;

  for (const img of list) {
    const s = scoreImageAgainstSpeech(img, spokenText);
    if (s > bestScore) {
      best = img;
      bestScore = s;
    }
  }

  if (preferred && preferredScore >= minScore && preferredScore >= bestScore - 2) {
    return preferred.id;
  }
  if (best && bestScore >= minScore) return best.id;
  return preferredId;
}

function pickBestImageForSpeech(pool, spokenText) {
  const list = Array.isArray(pool) && pool.length ? pool : [];
  if (!list.length) return null;

  let best = list[0];
  let bestScore = scoreImageAgainstSpeech(best, spokenText);

  for (let i = 1; i < list.length; i += 1) {
    const s = scoreImageAgainstSpeech(list[i], spokenText);
    if (s > bestScore) {
      best = list[i];
      bestScore = s;
    }
  }

  return bestScore >= 2 ? best : list[0];
}

/**
 * Best image for LLM speech + related section cluster (1 = single, N = carousel).
 */
function pickClusterForSpeech(pool, spokenText, preferredId = null) {
  const list = Array.isArray(pool) && pool.length ? pool : [];
  if (!list.length) return null;

  let focus = null;
  if (preferredId != null) {
    const resolvedId = resolveImageIdForSpeech(preferredId, list, spokenText);
    focus = list.find((img) => img.id === Number(resolvedId)) || null;
  }

  const speechBest = pickBestImageForSpeech(list, spokenText);
  if (!focus) {
    focus = speechBest;
  } else if (speechBest) {
    const speechScore = scoreImageAgainstSpeech(speechBest, spokenText);
    const focusScore = scoreImageAgainstSpeech(focus, spokenText);
    if (speechScore >= focusScore + 3) focus = speechBest;
  }

  if (!focus) return null;
  return { focus, cluster: getRelatedImageCluster(list, focus) };
}

module.exports = {
  slugifyPdfKey,
  buildNumberedImageCatalog,
  resolveSlideshowForTopicKey,
  findCatalogImageById,
  formatImageForFrontend,
  sectionKeyFromImage,
  getRelatedImageCluster,
  scoreImageAgainstSpeech,
  resolveImageIdForSpeech,
  pickBestImageForSpeech,
  pickClusterForSpeech,
};
