/**
 * Visiting-card scan controller — Mindee OCR.
 */
const fs = require('fs/promises');
const { extractCardFromFile } = require('../services/cardScanService');

async function scanVisitingCard(req, res) {
  let tempFilePath = null;

  try {
    const file = req.file;
    if (!file?.path) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided. Send multipart field "image".',
      });
    }

    if (!file.size || file.size <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Uploaded image is empty.',
      });
    }

    tempFilePath = file.path;

    const data = await extractCardFromFile({
      filePath: file.path,
      mimeType: file.mimetype,
      originalName: file.originalname,
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (err) {
    console.error('[card-scan] error:', err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Card scan failed',
    });
  } finally {
    if (tempFilePath) {
      try {
        await fs.unlink(tempFilePath);
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = {
  scanVisitingCard,
};
