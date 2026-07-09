/**
 * Reads text out of a chatbot's uploaded PDF files.
 * We cache the result on the chatbot document so we do not re-parse every voice turn.
 */
const fs = require('fs');
const path = require('path');
const PDFParser = require('pdf2json');
const ChatbotModel = require('../../models/chatbotModel');
const { geminiConfig } = require('../config/geminiConfig');

/**
 * pdf2json prints many harmless warnings for complex PDFs (Type3 fonts, images).
 * We hide those during parsing so the backend terminal stays readable.
 */
function withSuppressedPdfWarnings(fn) {
  const originalWarn = console.warn;
  const originalError = console.error;

  const shouldHide = (args) => {
    const msg = args.map(String).join(' ');
    return (
      msg.includes('Type3 font') ||
      msg.includes("isn't resolved yet") ||
      msg.includes('trying to decode') ||
      msg.includes('Unsupported: field.type of Link') ||
      msg.includes('NOT valid form element')
    );
  };

  console.warn = (...args) => {
    if (!shouldHide(args)) originalWarn.apply(console, args);
  };
  console.error = (...args) => {
    if (!shouldHide(args)) originalError.apply(console, args);
  };

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.warn = originalWarn;
      console.error = originalError;
    });
}

/**
 * Convert one PDF file on disk into plain text.
 */
function extractTextFromPdfFile(absolutePath) {
  return withSuppressedPdfWarnings(() => new Promise((resolve, reject) => {
    if (!fs.existsSync(absolutePath)) {
      return reject(new Error(`PDF file not found: ${absolutePath}`));
    }

    const pdfParser = new PDFParser(null, 1);

    pdfParser.on('pdfParser_dataError', (err) => {
      reject(err?.parserError || err);
    });

    pdfParser.on('pdfParser_dataReady', () => {
      try {
        const text = pdfParser.getRawTextContent();
        resolve(typeof text === 'string' ? text : '');
      } catch (error) {
        reject(error);
      }
    });

    pdfParser.loadPDF(absolutePath);
  }));
}

/**
 * Resolve a stored /uploads/... URL to an absolute disk path.
 */
function resolveUploadPath(urlPath) {
  if (!urlPath) return null;
  const relative = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath;
  return path.join(__dirname, '../../../', relative);
}

/**
 * Build one knowledge string from all PDFs of this chatbot.
 * Also uses image contextText from extraction when useful.
 */
async function buildKnowledgeFromPdfs(chatbot) {
  const parts = [];
  const pdfs = chatbot.knowledgeBasePdfs || [];

  for (const pdf of pdfs) {
    parts.push(`\n===== DOCUMENT: ${pdf.name} =====\n`);

    const diskPath = resolveUploadPath(pdf.url);
    if (diskPath) {
      try {
        const text = await extractTextFromPdfFile(diskPath);
        if (text.trim()) {
          parts.push(text.trim());
          console.log(`[knowledge] Extracted ${text.trim().length} chars from "${pdf.name}"`);
        } else {
          console.log(`[knowledge] No plain text in "${pdf.name}" — using image notes if available`);
          parts.push('(No extractable text found in this PDF.)');
        }
      } catch (error) {
        console.error(`[knowledge] Failed to read PDF "${pdf.name}":`, error.message);
        parts.push(`(Could not read text from ${pdf.name}.)`);
      }
    }

    // Extra context saved when images were extracted from the PDF
    const images = pdf.extractedImages || [];
    if (images.length > 0) {
      parts.push('\n--- Image / section notes from this document ---');
      for (const img of images) {
        const bits = [
          img.mainHeading,
          img.sectionHeading,
          img.subHeading,
          img.contextText,
        ].filter(Boolean);
        if (bits.length) {
          parts.push(bits.join(' | '));
        }
      }
    }
  }

  let full = parts.join('\n').replace(/\s+\n/g, '\n').trim();

  // Soft trim so the Gemini prompt stays within a safe size
  if (full.length > geminiConfig.maxKnowledgeChars) {
    full = `${full.slice(0, geminiConfig.maxKnowledgeChars)}\n\n[Knowledge truncated for size.]`;
  }

  return full;
}

/**
 * Get knowledge for a chatbot.
 * Uses cached text on the DB document when present; otherwise extracts and saves it.
 */
async function getChatbotKnowledge(chatbot) {
  if (chatbot.knowledgeTextCache && chatbot.knowledgeTextCache.trim()) {
    console.log(`[knowledge] Using cached knowledge for bot "${chatbot.name}" (${chatbot.knowledgeTextCache.length} chars)`);
    return chatbot.knowledgeTextCache;
  }

  console.log(`[knowledge] Building knowledge cache for bot "${chatbot.name}"…`);
  const knowledge = await buildKnowledgeFromPdfs(chatbot);

  // Save cache so the next caller (another user on same bot) is fast
  try {
    await ChatbotModel.findByIdAndUpdate(chatbot._id, {
      knowledgeTextCache: knowledge,
      knowledgeCachedAt: new Date(),
    });
  } catch (error) {
    console.error('[knowledge] Failed to save knowledge cache:', error.message);
  }

  return knowledge;
}

module.exports = {
  extractTextFromPdfFile,
  buildKnowledgeFromPdfs,
  getChatbotKnowledge,
};
