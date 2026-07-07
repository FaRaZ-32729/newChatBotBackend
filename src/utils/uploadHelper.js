const multer = require('multer');
const path = require('path');
const fs = require('fs');

const ensureDir = (dirPath) => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
};

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const chatbotName = req.body.name ? req.body.name.replace(/[^a-zA-Z0-9]/g, '_') : 'default';
        const uploadPath = path.join(__dirname, '../uploads/chatbots', chatbotName);
        ensureDir(uploadPath);
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        // Keep original name but add timestamp to avoid conflicts
        const originalName = file.originalname.replace(/\s+/g, '_');
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(originalName);
        const baseName = path.basename(originalName, ext);

        cb(null, `${baseName}-${uniqueSuffix}${ext}`);
    }
});

const fileFilter = (req, file, cb) => {
    if (file.fieldname === 'onboardingImage') {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed for avatar!'), false);
        }
    } else if (file.fieldname === 'knowledgeBasePdfs') {
        if (!file.originalname.toLowerCase().endsWith('.pdf')) {
            return cb(new Error('Only PDF files are allowed!'), false);
        }
    }
    cb(null, true);
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 15 * 1024 * 1024 } // Increased to 15MB
});

module.exports = { upload, ensureDir };