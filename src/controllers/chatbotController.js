const ChatbotModel = require('../models/chatbotModel');
const { upload } = require('../utils/uploadHelper');
const { processPDFImages } = require('../utils/pdfProcessor');
const fs = require('fs');
const path = require('path');

const uploadAny = upload.any();

const cleanupChatbotUploads = (folderPaths = [], files = []) => {
    for (const folder of folderPaths) {
        try {
            if (folder && fs.existsSync(folder)) {
                fs.rmSync(folder, { recursive: true, force: true });
            }
        } catch (e) {
            console.error('Failed to remove chatbot folder:', folder, e);
        }
    }

    for (const file of files) {
        try {
            if (file?.path && fs.existsSync(file.path)) {
                fs.unlinkSync(file.path);
            }
        } catch (e) {
            console.error('Failed to remove uploaded file:', file?.path, e);
        }
    }
};

const createChatbot = async (req, res) => {
    let createdFolders = [];

    uploadAny(req, res, async (err) => {
        try {
            if (err) {
                console.error("Multer Error:", err);
                cleanupChatbotUploads([], req.files || []);
                return res.status(400).json({ success: false, message: err.message });
            }

            const { name, activationKey, specificInstructions, scanCardRequired = false, headMovementMode, handMovements: handMovementsRaw } = req.body;
            const currentUser = req.user;

            const chatbotFolderName = name
                ? name.replace(/[^a-zA-Z0-9]/g, '_')
                : null;
            const uploadBasePath = chatbotFolderName
                ? path.join(__dirname, '../../uploads/chatbots', chatbotFolderName)
                : null;

            if (uploadBasePath) {
                createdFolders.push(uploadBasePath);
            }

            if (!name || !activationKey || !specificInstructions) {
                cleanupChatbotUploads(createdFolders, req.files || []);
                return res.status(400).json({ success: false, message: "Name, Activation Key and Instructions are required" });
            }

            // Manager/admin own their chatbots.
            // Client (role=user) creates under their manager's id.
            let ownerId = currentUser._id;
            if (currentUser.role === 'user') {
                if (!currentUser.createdBy) {
                    cleanupChatbotUploads(createdFolders, req.files || []);
                    return res.status(400).json({
                        success: false,
                        message: "Your account is not linked to a manager. Contact support."
                    });
                }
                ownerId = currentUser.createdBy;
            }

            // === NAME CHECK (unique within manager/owner pool) ===
            const existing = await ChatbotModel.findOne({
                name: name.trim(),
                createdBy: ownerId
            });

            if (existing) {
                cleanupChatbotUploads(createdFolders, req.files || []);
                return res.status(409).json({
                    success: false,
                    message: "A chatbot with this name already exists for your team. Please choose a different name."
                });
            }

            const hasHead = currentUser.access?.includes('head movement') || false;
            const hasHand = currentUser.access?.includes('hand movement') || false;

            const onboardingFile = req.files?.find(f => f.fieldname === 'onboardingImage');
            const pdfFiles = req.files?.filter(f => f.fieldname === 'knowledgeBasePdfs');

            if (!onboardingFile) {
                cleanupChatbotUploads(createdFolders, req.files || []);
                return res.status(400).json({ success: false, message: "Onboarding image is required" });
            }

            if (!pdfFiles || pdfFiles.length === 0) {
                cleanupChatbotUploads(createdFolders, req.files || []);
                return res.status(400).json({ success: false, message: "At least one PDF is required" });
            }

            const knowledgeBasePdfs = [];

            for (const pdfFile of pdfFiles) {
                const pdfNameClean = pdfFile.originalname.replace('.pdf', '').replace(/[^a-zA-Z0-9]/g, '_');

                // Throws on extraction failure — triggers full rollback below
                const extractedImages = await processPDFImages(pdfFile.path, chatbotFolderName, pdfNameClean);

                knowledgeBasePdfs.push({
                    name: pdfFile.originalname,
                    url: `/uploads/chatbots/${chatbotFolderName}/${pdfFile.filename}`,
                    size: (pdfFile.size / (1024 * 1024)).toFixed(2) + ' MB',
                    extractedImages
                });
            }

            const onboardingImageUrl = `/uploads/chatbots/${chatbotFolderName}/${onboardingFile.filename}`;

            let handMovements = null;
            if (hasHand) {
                let parsed = handMovementsRaw;
                if (typeof handMovementsRaw === 'string') {
                    try {
                        parsed = JSON.parse(handMovementsRaw);
                    } catch (e) {
                        parsed = null;
                    }
                }

                handMovements = parsed || {
                    hi: { detects: true, saysHi: true },
                    bye: { chatEnds: true },
                    thumbsUp: { detects: true, correctInfo: true }
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
                createdBy: ownerId
            });

            const saved = await newChatbot.save();

            // Build PDF text cache in the background so first voice call is faster
            setImmediate(async () => {
                try {
                    const { getChatbotKnowledge } = require('../llm/services/knowledgeService');
                    await getChatbotKnowledge(saved);
                } catch (cacheErr) {
                    console.error('[chatbot] knowledge cache warm-up failed:', cacheErr.message);
                }
            });

            res.status(201).json({
                success: true,
                message: "Chatbot created successfully!",
                data: saved
            });

        } catch (error) {
            console.error("Create Chatbot Error:", error);

            // Full rollback: no DB save if we never reached save; delete all related uploads
            cleanupChatbotUploads(createdFolders, req.files || []);

            const message = error.message || "Failed to create chatbot. All uploaded files were removed.";
            const status = /extraction failed/i.test(message) ? 422 : 500;

            res.status(status).json({
                success: false,
                message
            });
        }
    });
};

// ====================== DELETE CHATBOT ======================
const deleteChatbot = async (req, res) => {
    try {
        const { id } = req.params;
        const currentUser = req.user;

        const chatbot = await ChatbotModel.findById(id);

        if (!chatbot) {
            return res.status(404).json({ success: false, message: "Chatbot not found" });
        }

        const chatbotOwnerId = chatbot.createdBy.toString();
        const isOwner = chatbotOwnerId === currentUser._id.toString();
        const isTeamMember =
            currentUser.role === 'user' &&
            currentUser.createdBy?.toString() === chatbotOwnerId;
        const isAdmin = currentUser.role === 'admin';

        if (!isOwner && !isTeamMember && !isAdmin) {
            return res.status(403).json({ success: false, message: "You can only delete your team's chatbots" });
        }

        const chatbotFolderName = chatbot.name.replace(/[^a-zA-Z0-9]/g, '_');
        const folderPath = path.join(__dirname, '../../uploads/chatbots', chatbotFolderName);

        // Delete folder from disk
        if (fs.existsSync(folderPath)) {
            fs.rmSync(folderPath, { recursive: true, force: true });
            console.log(`🗑️ Folder deleted: ${chatbotFolderName}`);
        }

        // Delete from database
        await ChatbotModel.findByIdAndDelete(id);

        res.status(200).json({
            success: true,
            message: "Chatbot and all associated files deleted successfully"
        });

    } catch (error) {
        console.error("Delete Chatbot Error:", error);
        res.status(500).json({ success: false, message: "Server error while deleting chatbot" });
    }
};

// ====================== GET CHATBOTS FOR CURRENT USER ======================
// Manager/admin: own chatbots
// Client (role=user): chatbots created by their manager
const getChatbotsByUser = async (req, res) => {
    try {
        const currentUser = req.user;

        let ownerId = currentUser._id;

        if (currentUser.role === 'user') {
            if (!currentUser.createdBy) {
                return res.status(200).json({
                    success: true,
                    count: 0,
                    data: []
                });
            }
            ownerId = currentUser.createdBy;
        }

        const chatbots = await ChatbotModel.find({
            createdBy: ownerId
        })
            .sort({ createdAt: -1 })
            .populate('createdBy', 'name email role');

        res.status(200).json({
            success: true,
            count: chatbots.length,
            data: chatbots
        });

    } catch (error) {
        console.error("Get Chatbots Error:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

// ====================== GET PUBLIC CHATBOT (shareable URL) ======================
// No login required — used when opening /chatbot/:id link
const getPublicChatbot = async (req, res) => {
    try {
        const { id } = req.params;
        const chatbot = await ChatbotModel.findById(id).select('name onboardingImage isActive');

        if (!chatbot || chatbot.isActive === false) {
            return res.status(404).json({ success: false, message: 'Chatbot not found or inactive' });
        }

        res.status(200).json({
            success: true,
            data: {
                _id: chatbot._id,
                name: chatbot.name,
                onboardingImage: chatbot.onboardingImage,
            },
        });
    } catch (error) {
        console.error('Get Public Chatbot Error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

module.exports = {
    createChatbot,
    deleteChatbot,
    getChatbotsByUser,
    getPublicChatbot,
};



