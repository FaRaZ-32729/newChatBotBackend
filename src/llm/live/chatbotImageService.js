/**
 * Per-chatbot image catalog.
 * Slideshow is driven by LLM [[TOPIC: pdfKey]] — not raw user text.
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

/**
 * Build numbered image catalog + topic list for ONE chatbot.
 */
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

/**
 * Resolve slideshow from LLM [[TOPIC: pdfKey]] marker.
 * General or unknown topic → no images (frontend shows onboarding).
 */
function resolveSlideshowForTopicKey(catalog, topics, pdfKey, limit = 16) {
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
    return { matched: false, pdfKey: key, pdfName: null, images: [] };
  }

  const images = catalog
    .filter((img) => img.pdfKey === topic.pdfKey)
    .sort((a, b) => (a.pageNumber || 0) - (b.pageNumber || 0))
    .slice(0, limit);

  return {
    matched: images.length > 0,
    pdfKey: topic.pdfKey,
    pdfName: topic.displayName,
    images,
  };
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

module.exports = {
  slugifyPdfKey,
  buildNumberedImageCatalog,
  resolveSlideshowForTopicKey,
  formatImageForFrontend,
};
