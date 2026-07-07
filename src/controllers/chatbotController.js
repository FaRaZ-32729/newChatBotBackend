const ChatbotModel = require('../models/chatbotModel');
const { processPDFImages } = require('../utils/pdfProcessor');
const { upload } = require('../utils/uploadHelper');

const uploadAny = upload.any();

// ====================== CREATE CHATBOT ======================
const createChatbot = async (req, res) => {
    uploadAny(req, res, async (err) => {
        if (err) {
            console.error("Multer Error:", err);
            return res.status(400).json({ success: false, message: err.message });
        }

        console.log("✅ req.body:", req.body);
        console.log("✅ Files Received:", req.files?.map(f => ({ fieldname: f.fieldname, originalname: f.originalname })));

        const {
            name,
            activationKey,
            specificInstructions,
            scanCardRequired = false,
            headMovementMode
        } = req.body;

        const currentUser = req.user;

        if (!name || !activationKey || !specificInstructions) {
            return res.status(400).json({ success: false, message: "Name, Activation Key and Instructions are required" });
        }

        const hasHead = currentUser.access?.includes('head movement') || false;
        const hasHand = currentUser.access?.includes('hand movement') || false;

        // File Validation
        const onboardingFile = req.files?.find(f => f.fieldname === 'onboardingImage');
        const pdfFiles = req.files?.filter(f => f.fieldname === 'knowledgeBasePdfs');   // ← Changed here

        if (!onboardingFile) {
            return res.status(400).json({ success: false, message: "Onboarding image is required" });
        }

        if (!pdfFiles || pdfFiles.length === 0) {
            return res.status(400).json({ success: false, message: "At least one PDF is required" });
        }

        const chatbotFolderName = name.replace(/[^a-zA-Z0-9]/g, '_');

        const knowledgeBasePdfs = [];

        for (const pdfFile of pdfFiles) {
            const pdfNameClean = pdfFile.originalname.replace('.pdf', '');

            // Extract images
            const extractedImages = await processPDFImages(
                pdfFile.path,
                chatbotFolderName,
                pdfNameClean
            );

            knowledgeBasePdfs.push({
                name: pdfFile.originalname,
                url: `/uploads/chatbots/${chatbotFolderName}/${pdfFile.filename}`,
                size: (pdfFile.size / (1024 * 1024)).toFixed(2) + ' MB',
                extractedImages
            });
        }

        const onboardingImageUrl = `/uploads/chatbots/${chatbotFolderName}/${onboardingFile.filename}`;

        // Hand Movements
        let handMovements = null;
        if (hasHand) {
            handMovements = {
                hi: {
                    detects: req.body['handMovements.hi.detects'] === 'true',
                    saysHi: req.body['handMovements.hi.saysHi'] === 'true'
                },
                bye: {
                    chatEnds: req.body['handMovements.bye.chatEnds'] === 'true'
                },
                thumbsUp: {
                    detects: req.body['handMovements.thumbsUp.detects'] === 'true',
                    correctInfo: req.body['handMovements.thumbsUp.correctInfo'] === 'true'
                }
            };
        }

        const newChatbot = new ChatbotModel({
            name: name.trim(),
            onboardingImage: onboardingImageUrl,
            knowledgeBasePdfs,
            activationKey: activationKey.toLowerCase().trim(),
            specificInstructions: specificInstructions.trim(),
            scanCardRequired: scanCardRequired === 'true' || scanCardRequired === true,
            headMovementMode: hasHead ? headMovementMode : null,
            handMovements,
            createdBy: currentUser._id
        });

        await newChatbot.save();

        res.status(201).json({
            success: true,
            message: "Chatbot created successfully!",
            data: newChatbot
        });
    });
};

module.exports = { createChatbot };