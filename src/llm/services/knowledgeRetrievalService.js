/**
 * Retrieve relevant PDF chunks for a chatbot via MongoDB Atlas Vector Search.
 *
 * =============================================================================
 * ATLAS VECTOR SEARCH INDEX (must be created manually — cannot be done in code)
 * =============================================================================
 *
 * 1. Open MongoDB Atlas → your cluster → Atlas Search (or "Search & Vector Search")
 * 2. Click Create Search Index
 * 3. Choose Atlas Vector Search → JSON Editor
 * 4. Database: the same DB as MONGODB_URL
 * 5. Collection: knowledgechunks
 * 6. Index name (must match VECTOR_INDEX_NAME below): knowledge_chunks_vector_index
 * 7. Paste this definition (numDimensions MUST match embeddingService — 768):
 *
 * {
 *   "fields": [
 *     {
 *       "type": "vector",
 *       "path": "embedding",
 *       "numDimensions": 768,
 *       "similarity": "cosine"
 *     },
 *     {
 *       "type": "filter",
 *       "path": "chatbotId"
 *     },
 *     {
 *       "type": "filter",
 *       "path": "pdfKey"
 *     }
 *   ]
 * }
 *
 * 8. Create the index and wait until Status = Active before relying on live RAG.
 *
 * Model: gemini-embedding-001  |  Dimensions: 768  |  Similarity: cosine
 * =============================================================================
 */
const mongoose = require('mongoose');
const KnowledgeChunk = require('../../models/knowledgeChunkModel');
const { embedText, EMBEDDING_DIMENSIONS } = require('./embeddingService');
const { toRomanDisplay } = require('../live/romanizeTranscript');

const VECTOR_INDEX_NAME = 'knowledge_chunks_vector_index';

let warnedMissingIndex = false;

function toObjectId(id) {
  if (id instanceof mongoose.Types.ObjectId) return id;
  return new mongoose.Types.ObjectId(String(id));
}

function shapeChunk(doc) {
  return {
    text: doc.text || '',
    pdfKey: doc.pdfKey || '',
    pdfName: doc.pdfName || '',
    sectionHeading: doc.sectionHeading || '',
    relatedImageIds: Array.isArray(doc.relatedImageIds) ? doc.relatedImageIds : [],
    pageNumber: doc.pageNumber ?? null,
    score: typeof doc.score === 'number' ? doc.score : 0,
  };
}

/** Roman + STT fixes so embeddings/keyword match English PDF chunks. */
function normalizeRagQuery(query, options = {}) {
  let q = toRomanDisplay(String(query || ''))
    .replace(/\s+/g, ' ')
    .trim();

  q = q
    .replace(/\bi\s*g\s+solar\b/gi, 'easy solar')
    .replace(/\bi\s*g\b/gi, 'iotfiy')
    .replace(/\bmen\b/gi, 'mein')
    .replace(/\bditelamen\b/gi, 'detail mein')
    .replace(/\bbata ana\b/gi, 'batao')
    .replace(/\bmujhe\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const compact = q.replace(/\s+/g, '').toLowerCase();
  if (/sikt|ackit|acki?t/.test(compact) || /\bac[\s-]?kit\b/i.test(q)) {
    q = `AC Kit ${q}`.trim();
  }
  if (
    /solosistam|solarsystem|solarpanel|autoclean/.test(compact)
    || /\b(solar|cleaning|panel clean|faayada)\b/i.test(q)
  ) {
    q = `Easy Solar ${q}`.trim();
  }
  if (
    /ecosystem|dashboard|machinery|centralized|multimach/.test(compact)
    || /\b(machinery|machines|dashboard|centralized|ecosystem|venue)\b/i.test(q)
  ) {
    q = `IOTFIY Ecosystem ${q}`.trim();
  }

  const topics = Array.isArray(options.topics) ? options.topics : [];
  const qPad = ` ${q.toLowerCase()} `;
  for (const t of topics) {
    const name = String(t.displayName || '').replace(/\.pdf$/i, '').trim();
    const key = String(t.pdfKey || '').replace(/_/g, ' ');
    if (!name) continue;
    const nameNorm = name.toLowerCase();
    const qNorm = q.toLowerCase();
    const nameRe = new RegExp(`(?:^|[^a-z0-9])${nameNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`, 'i');
    const keyRe = key.length >= 4
      ? new RegExp(`(?:^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`, 'i')
      : null;
    if (
      (nameNorm.length >= 4 && nameRe.test(qPad))
      || (keyRe && keyRe.test(qPad))
      || (/\bsolar\b/i.test(qNorm) && /solar/i.test(name))
      || (/\bgateway\b/i.test(qNorm) && /gateway/i.test(name))
      || (/\b(ac|cooling|sikt|kit)\b/i.test(qNorm) && /ac|cooling|kit/i.test(name))
    ) {
      if (!nameRe.test(qPad)) {
        q = `${name} ${q}`.trim();
      }
      break;
    }
  }

  const pdfName = String(options.pdfName || '').replace(/\.pdf$/i, '').trim();
  if (pdfName && !q.toLowerCase().includes(pdfName.toLowerCase().slice(0, 4))) {
    q = `${pdfName} ${q}`.trim();
  }

  return q || String(query || '').trim();
}

async function vectorSearchRows({ chatbotObjectId, queryVector, pdfKey, topK }) {
  const filter = { chatbotId: { $eq: chatbotObjectId } };
  if (pdfKey) filter.pdfKey = { $eq: String(pdfKey) };

  return KnowledgeChunk.aggregate([
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: 'embedding',
        queryVector,
        numCandidates: Math.max(40, Number(topK) * 10),
        limit: Number(topK) || 4,
        filter,
      },
    },
    {
      $project: {
        text: 1,
        pdfKey: 1,
        pdfName: 1,
        sectionHeading: 1,
        relatedImageIds: 1,
        pageNumber: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ]);
}

async function getPdfFallbackChunks(chatbotObjectId, pdfKey, topK = 4) {
  if (!pdfKey) return [];
  const docs = await KnowledgeChunk.find({
    chatbotId: chatbotObjectId,
    pdfKey: String(pdfKey),
  })
    .select('text pdfKey pdfName sectionHeading relatedImageIds pageNumber isOverview')
    .sort({ isOverview: -1, pageNumber: 1 })
    .limit(Number(topK) || 4)
    .lean();

  return docs.map((d) => shapeChunk({ ...d, score: 0.5 }));
}

function warnAboutIndex(err) {
  if (warnedMissingIndex) return;
  warnedMissingIndex = true;
  console.warn(
    '[rag] Atlas Vector Search index may be missing or not Active.\n'
    + `       Create "${VECTOR_INDEX_NAME}" on collection "knowledgechunks",\n`
    + `       field "embedding", numDimensions=${EMBEDDING_DIMENSIONS}, cosine.\n`
    + `       See the comment block at the top of knowledgeRetrievalService.js.\n`
    + `       Error: ${err?.message || err}`
  );
}

async function fallbackKeywordSearch({ chatbotId, query, pdfKey, topK }) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2);
  const filter = { chatbotId };
  if (pdfKey) filter.pdfKey = pdfKey;

  const docs = await KnowledgeChunk.find(filter)
    .select('text pdfKey pdfName sectionHeading relatedImageIds pageNumber')
    .lean()
    .limit(250);

  const scored = docs
    .map((d) => {
      const hay = `${d.sectionHeading || ''} ${d.text || ''}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (hay.includes(t)) score += 1;
      }
      return { ...d, score };
    })
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored.map(shapeChunk);
}

async function searchKnowledgeChunks({
  chatbotId,
  query,
  pdfKey,
  topK = 4,
  topics,
  pdfName,
} = {}) {
  if (!chatbotId || !String(query || '').trim()) return [];

  const t0 = Date.now();
  const chatbotObjectId = toObjectId(chatbotId);
  const normalizedQuery = normalizeRagQuery(query, { topics, pdfName, pdfKey });
  const queryVector = await embedText(normalizedQuery);
  if (!queryVector.length) return [];
  const embedMs = Date.now() - t0;
  const resolvedPdfKey = pdfKey ? String(pdfKey) : undefined;
  const limit = Number(topK) || 4;

  const finish = (rows, via) => {
    console.log(
      `[LATENCY][RAG] raw="${String(query).slice(0, 40)}" norm="${normalizedQuery.slice(0, 50)}"`
      + ` embed ${embedMs}ms | ${via} | hits ${rows.length}`
      + (resolvedPdfKey ? ` pdfKey=${resolvedPdfKey}` : '')
    );
    return rows.map(shapeChunk);
  };

  try {
    const tSearch = Date.now();
    let rows = await vectorSearchRows({
      chatbotObjectId,
      queryVector,
      pdfKey: resolvedPdfKey,
      topK: limit,
    });

    if (!rows.length && resolvedPdfKey) {
      rows = await vectorSearchRows({
        chatbotObjectId,
        queryVector,
        topK: limit,
      });
    }

    if (rows.length) {
      console.log(`[LATENCY][RAG] vectorSearch ${Date.now() - tSearch}ms`);
      return finish(rows, 'vector');
    }

    let keyword = await fallbackKeywordSearch({
      chatbotId: chatbotObjectId,
      query: normalizedQuery,
      pdfKey: resolvedPdfKey,
      topK: limit,
    });
    if (!keyword.length && resolvedPdfKey) {
      keyword = await fallbackKeywordSearch({
        chatbotId: chatbotObjectId,
        query: normalizedQuery,
        topK: limit,
      });
    }
    if (keyword.length) {
      return finish(keyword, 'keyword');
    }

    if (resolvedPdfKey) {
      const pdfRows = await getPdfFallbackChunks(chatbotObjectId, resolvedPdfKey, limit);
      if (pdfRows.length) return finish(pdfRows, 'pdf_fallback');
    }

    return finish([], 'none');
  } catch (err) {
    warnAboutIndex(err);
    let fallback = await fallbackKeywordSearch({
      chatbotId: chatbotObjectId,
      query: normalizedQuery,
      pdfKey: resolvedPdfKey,
      topK: limit,
    });
    if (!fallback.length && resolvedPdfKey) {
      fallback = await fallbackKeywordSearch({
        chatbotId: chatbotObjectId,
        query: normalizedQuery,
        topK: limit,
      });
    }
    if (!fallback.length && resolvedPdfKey) {
      fallback = await getPdfFallbackChunks(chatbotObjectId, resolvedPdfKey, limit);
    }
    console.log(
      `[LATENCY][RAG] index error fallback "${normalizedQuery.slice(0, 50)}"`
      + ` | total ${Date.now() - t0}ms | hits ${fallback.length}`
    );
    return fallback.map(shapeChunk);
  }
}

async function getOverviewChunks(chatbotId) {
  if (!chatbotId) return [];
  const docs = await KnowledgeChunk.find({
    chatbotId: toObjectId(chatbotId),
    isOverview: true,
  })
    .select('text pdfKey pdfName sectionHeading relatedImageIds pageNumber')
    .lean();

  return docs.map((d) => shapeChunk({ ...d, score: 1 }));
}

function formatChunksForPrompt(chunks) {
  if (!Array.isArray(chunks) || !chunks.length) return '';
  return chunks
    .map((c, i) => {
      const heading = c.sectionHeading ? ` / ${c.sectionHeading}` : '';
      return `[${i + 1}] ${c.pdfName}${heading}:\n${c.text}`;
    })
    .join('\n\n');
}

module.exports = {
  searchKnowledgeChunks,
  getOverviewChunks,
  formatChunksForPrompt,
  normalizeRagQuery,
  VECTOR_INDEX_NAME,
};
