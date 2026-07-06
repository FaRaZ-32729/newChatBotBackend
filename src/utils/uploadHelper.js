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
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    if (file.fieldname === 'onboardingImage') {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed!'), false);
        }
    } else if (file.fieldname === 'pdfs') {
        if (!file.originalname.toLowerCase().endsWith('.pdf')) {
            return cb(new Error('Only PDF files are allowed!'), false);
        }
    }
    cb(null, true);
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 20 * 1024 * 1024 } // 10MB
});

module.exports = { upload, ensureDir }; 