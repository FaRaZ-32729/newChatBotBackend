/**
 * Multer disk upload for visiting-card images (temp files for Mindee PathInput).
 */
const multer = require('multer');
const path = require('path');
const os = require('os');
const fs = require('fs');

const uploadDir = path.join(os.tmpdir(), 'mindee-card-scan');

function ensureUploadDir() {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureUploadDir();
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file?.originalname || '') || '.jpg';
    cb(null, `card_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const cardUpload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype?.startsWith('image/')) {
      return cb(new Error('Only image files are allowed for card scan'));
    }
    cb(null, true);
  },
});

module.exports = {
  cardUpload,
  uploadDir,
  ensureUploadDir,
};
