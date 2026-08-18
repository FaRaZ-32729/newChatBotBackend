/**
 * Split chatbot PDFs into heading-aware chunks, embed them, and store in Mongo.
 */
const KnowledgeChunk = require('../../models/knowledgeChunkModel');
const ChatbotModel = require('../../models/chatbotModel');
const { extractTextFromPdfFile } = require('./knowledgeService');
const { embedTexts } = require('./embeddingService');
const {
  slugifyPdfKey,
  buildNumberedImageCatalog,
} = require('../live/chatbotImageService');
const path = require('path');

const TARGET_CHARS = 2200; // ~400–600 tokens
const OVERLAP_CHARS = Math.floor(TARGET_CHARS * 0.15);
const OVERVIEW_RE = /\b(overview|introduction|about (this|the)|what is|purpose|tagline)\b/i;

function resolveUploadPath(urlPath) {
  if (!urlPath) return null;
  const relative = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath;
  return path.join(__dirname, '../../../', relative);
}

function uniqueHeadings(images) {
  const seen = new Set();
  const list = [];
  for (const img of images || []) {
    for (const h of [img.mainHeading, img.sectionHeading, img.subHeading]) {
      const heading = String(h || '').trim();
      if (heading.length < 4) continue;
      const key = heading.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(heading);
    }
  }
  return list;
}

function splitByHeadings(fullText, images) {
  const text = String(fullText || '');
  if (!text.trim()) return [];

  const lower = text.toLowerCase();
  const hits = [];
  for (const heading of uniqueHeadings(images)) {
    const idx = lower.indexOf(heading.toLowerCase());
    if (idx < 0) continue;
    hits.push({ heading, index: idx });
  }
  hits.sort((a, b) => a.index - b.index);

  const deduped = [];
  let lastIdx = -1;
  for (const hit of hits) {
    if (hit.index === lastIdx) continue;
    lastIdx = hit.index;
    deduped.push(hit);
  }

  if (!deduped.length) {
    return [{ heading: '', text, pageNumber: null }];
  }

  const sections = [];
  if (deduped[0].index > 40) {
    sections.push({
      heading: '',
      text: text.slice(0, deduped[0].index).trim(),
      pageNumber: null,
    });
  }

  for (let i = 0; i < deduped.length; i += 1) {
    const start = deduped[i].index;
    const end = i + 1 < deduped.length ? deduped[i + 1].index : text.length;
    const nearestImg = (images || []).find((img) => {
      const bits = [img.mainHeading, img.sectionHeading, img.subHeading].filter(Boolean);
      return bits.some((h) => String(h).toLowerCase() === deduped[i].heading.toLowerCase());
    });
    sections.push({
      heading: deduped[i].heading,
      text: text.slice(start, end).trim(),
      pageNumber: nearestImg?.pageNumber || null,
    });
  }

  return sections.filter((s) => s.text.length > 40);
}

function windowSection(section) {
  const cleaned = String(section.text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  if (cleaned.length <= TARGET_CHARS * 1.15) {
    return [{
      text: cleaned,
      sectionHeading: section.heading || '',
      pageNumber: section.pageNumber || null,
    }];
  }

  const chunks = [];
  let start = 0;
  while (start < cleaned.length) {
    let end = Math.min(cleaned.length, start + TARGET_CHARS);
    if (end < cleaned.length) {
      const snap = cleaned.lastIndexOf('. ', end);
      if (snap > start + TARGET_CHARS * 0.5) end = snap + 1;
    }
    chunks.push({
      text: cleaned.slice(start, end).trim(),
      sectionHeading: section.heading || '',
      pageNumber: section.pageNumber || null,
    });
    if (end >= cleaned.length) break;
    start = Math.max(start + 1, end - OVERLAP_CHARS);
  }
  return chunks.filter((c) => c.text.length > 30);
}

function relatedImageIdsForChunk(catalog, pdfKey, chunkText, sectionHeading) {
  const hay = `${sectionHeading || ''} ${chunkText || ''}`.toLowerCase();
  const ids = [];

  for (const img of catalog || []) {
    if (img.pdfKey !== pdfKey) continue;
    const bits = [img.topic, img.contextText]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!bits) continue;

    if (sectionHeading && bits.includes(String(sectionHeading).toLowerCase().slice(0, 48))) {
      ids.push(img.id);
      continue;
    }

    const words = bits.split(/\W+/).filter((w) => w.length > 4);
    let hits = 0;
    for (const w of words.slice(0, 14)) {
      if (hay.includes(w)) hits += 1;
    }
    if (hits >= 2) ids.push(img.id);
  }

  return [...new Set(ids)];
}

function fallbackTextFromImages(pdf) {
  const lines = [];
  for (const img of pdf.extractedImages || []) {
    const bits = [img.mainHeading, img.sectionHeading, img.subHeading, img.contextText]
      .filter(Boolean);
    if (bits.length) lines.push(bits.join(' | '));
  }
  return lines.join('\n');
}

async function buildKnowledgeChunksForChatbot(chatbot) {
  if (!chatbot?._id) {
    throw new Error('buildKnowledgeChunksForChatbot requires a chatbot document');
  }

  const pdfs = chatbot.knowledgeBasePdfs || [];
  const { catalog } = buildNumberedImageCatalog(chatbot);
  const pending = [];
  const counts = [];

  for (const pdf of pdfs) {
    const pdfKey = slugifyPdfKey(pdf.name);
    const pdfName = pdf.name || 'Document';
    const diskPath = resolveUploadPath(pdf.url);

    let rawText = '';
    if (diskPath) {
      try {
        rawText = await extractTextFromPdfFile(diskPath);
      } catch (err) {
        console.error(`[chunks] Failed to read PDF "${pdfName}":`, err.message);
      }
    }
    if (!String(rawText).trim()) {
      rawText = fallbackTextFromImages(pdf);
    }

    const sections = splitByHeadings(rawText, pdf.extractedImages || []);
    const windows = sections.flatMap(windowSection);
    const usable = windows.length ? windows : [{
      text: String(rawText || '').replace(/\s+/g, ' ').trim().slice(0, TARGET_CHARS),
      sectionHeading: '',
      pageNumber: null,
    }].filter((c) => c.text);

    usable.forEach((chunk, idx) => {
      const isOverview = idx === 0 || (idx <= 1 && OVERVIEW_RE.test(chunk.text.slice(0, 400)));
      pending.push({
        chatbotId: chatbot._id,
        pdfKey,
        pdfName,
        sectionHeading: chunk.sectionHeading || '',
        text: chunk.text,
        relatedImageIds: relatedImageIdsForChunk(
          catalog,
          pdfKey,
          chunk.text,
          chunk.sectionHeading
        ),
        isOverview,
        pageNumber: chunk.pageNumber || null,
      });
    });

    counts.push({ pdfName, chunks: usable.length });
  }

  if (!pending.length) {
    console.warn(`[chunks] No text to chunk for bot "${chatbot.name}"`);
    await KnowledgeChunk.deleteMany({ chatbotId: chatbot._id });
    await ChatbotModel.findByIdAndUpdate(chatbot._id, {
      knowledgeChunksBuilt: true,
      knowledgeChunksBuiltAt: new Date(),
    });
    chatbot.knowledgeChunksBuilt = true;
    chatbot.knowledgeChunksBuiltAt = new Date();
    return { chatbotId: chatbot._id, total: 0, counts };
  }

  console.log(`[chunks] Embedding ${pending.length} chunk(s) for bot "${chatbot.name}"…`);
  const embeddings = await embedTexts(pending.map((c) => c.text));

  const docs = [];
  for (let i = 0; i < pending.length; i += 1) {
    if (!Array.isArray(embeddings[i]) || !embeddings[i].length) {
      console.warn(`[chunks] Skipping chunk ${i} — empty embedding`);
      continue;
    }
    docs.push({ ...pending[i], embedding: embeddings[i], createdAt: new Date() });
  }

  await KnowledgeChunk.deleteMany({ chatbotId: chatbot._id });
  if (docs.length) {
    await KnowledgeChunk.insertMany(docs);
  }

  await ChatbotModel.findByIdAndUpdate(chatbot._id, {
    knowledgeChunksBuilt: true,
    knowledgeChunksBuiltAt: new Date(),
  });
  chatbot.knowledgeChunksBuilt = true;
  chatbot.knowledgeChunksBuiltAt = new Date();

  for (const row of counts) {
    console.log(`[chunks] "${row.pdfName}" → ${row.chunks} chunk(s)`);
  }
  console.log(`[chunks] Stored ${docs.length} chunk(s) for bot "${chatbot.name}"`);

  return { chatbotId: chatbot._id, total: docs.length, counts };
}

/** Remove all RAG / vector embeddings for a chatbot (Atlas vector index uses this collection). */
async function deleteKnowledgeChunksForChatbot(chatbotId) {
  if (!chatbotId) return { deletedCount: 0 };
  const result = await KnowledgeChunk.deleteMany({ chatbotId });
  const deletedCount = result?.deletedCount ?? 0;
  if (deletedCount > 0) {
    console.log(`[chunks] Deleted ${deletedCount} embedding chunk(s) for chatbot ${chatbotId}`);
  }
  return { deletedCount };
}

module.exports = {
  buildKnowledgeChunksForChatbot,
  deleteKnowledgeChunksForChatbot,
};
