/**
 * Gemini text embeddings for RAG.
 * Model: gemini-embedding-001 (text-embedding-004 was shut down Jan 2026).
 * Requested output dimensionality: 768 (Google-recommended). Truncated
 * gemini-embedding-001 vectors are L2-normalized here so cosine search works.
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { geminiConfig, assertGeminiConfigured } = require('../config/geminiConfig');

const EMBEDDING_MODEL = geminiConfig.embeddingModel;
const EMBEDDING_DIMENSIONS = geminiConfig.embeddingDimensions;
const BATCH_SIZE = 16;

let client = null;
let loggedDimension = false;

function getClient() {
  assertGeminiConfigured();
  if (!client) {
    client = new GoogleGenerativeAI(geminiConfig.apiKey);
  }
  return client;
}

function l2Normalize(values) {
  if (!Array.isArray(values) || !values.length) return [];
  let mag = 0;
  for (const n of values) mag += n * n;
  mag = Math.sqrt(mag) || 1;
  return values.map((n) => n / mag);
}

function extractValues(embedding) {
  const values = embedding?.values || embedding;
  if (!Array.isArray(values)) return [];
  return values.map(Number).filter((n) => Number.isFinite(n));
}

function confirmDimension(values, context) {
  if (!values.length) {
    throw new Error(`[embed] Empty embedding from ${EMBEDDING_MODEL} (${context})`);
  }
  if (!loggedDimension) {
    loggedDimension = true;
    console.log(
      `[embed] ${EMBEDDING_MODEL} returned ${values.length} dims `
      + `(requested ${EMBEDDING_DIMENSIONS})`
    );
  }
  if (values.length !== EMBEDDING_DIMENSIONS) {
    console.warn(
      `[embed] Dimension mismatch: got ${values.length}, expected ${EMBEDDING_DIMENSIONS}. `
      + 'Atlas Vector Search index numDimensions must match stored vectors.'
    );
  }
  return values;
}

async function embedOne(text, taskType) {
  const input = String(text || '').trim();
  if (!input) return [];

  const model = getClient().getGenerativeModel({ model: EMBEDDING_MODEL });
  const result = await model.embedContent({
    content: { parts: [{ text: input.slice(0, 8000) }] },
    taskType,
    outputDimensionality: EMBEDDING_DIMENSIONS,
  });

  const raw = extractValues(result?.embedding);
  return l2Normalize(confirmDimension(raw, taskType));
}

/**
 * Embed a single query/document string. Returns a number[].
 */
async function embedText(text) {
  return embedOne(text, 'RETRIEVAL_QUERY');
}

/**
 * Batch-embed document chunks. Returns number[][].
 */
async function embedTexts(textArray) {
  const inputs = Array.isArray(textArray) ? textArray : [];
  if (!inputs.length) return [];

  const model = getClient().getGenerativeModel({ model: EMBEDDING_MODEL });
  const out = [];

  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const slice = inputs.slice(i, i + BATCH_SIZE);
    const requests = slice.map((text) => ({
      content: { parts: [{ text: String(text || '').slice(0, 8000) }] },
      taskType: 'RETRIEVAL_DOCUMENT',
      outputDimensionality: EMBEDDING_DIMENSIONS,
    }));

    let embeddings = [];
    try {
      const result = await model.batchEmbedContents({ requests });
      embeddings = result?.embeddings || [];
    } catch (err) {
      console.warn(`[embed] batchEmbedContents failed, falling back per-text: ${err.message}`);
      embeddings = [];
    }

    if (embeddings.length !== slice.length) {
      for (const text of slice) {
        out.push(await embedOne(text, 'RETRIEVAL_DOCUMENT'));
      }
    } else {
      for (const emb of embeddings) {
        const raw = extractValues(emb);
        out.push(l2Normalize(confirmDimension(raw, 'RETRIEVAL_DOCUMENT')));
      }
    }

    if (i + BATCH_SIZE < inputs.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return out;
}

module.exports = {
  embedText,
  embedTexts,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
};
