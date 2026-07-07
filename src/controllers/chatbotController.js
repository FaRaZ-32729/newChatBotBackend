const ChatbotModel = require('../models/chatbotModel');
const { upload } = require('../utils/uploadHelper');
const { processPDFImages } = require('../utils/pdfProcessor');
const fs = require('fs');
const path = require('path');

const uploadAny = upload.any();

const createChatbot = async (req, res) => {
    let createdFolders = [];

    uploadAny(req, res, async (err) => {
        try {
            if (err) {
                console.error("Multer Error:", err);
                return res.status(400).json({ success: false, message: err.message });
            }

            const { name, activationKey, specificInstructions, scanCardRequired = false, headMovementMode } = req.body;
            const currentUser = req.user;

            if (!name || !activationKey || !specificInstructions) {
                return res.status(400).json({ success: false, message: "Name, Activation Key and Instructions are required" });
            }

            // === NAME CHECK ===
            const existing = await ChatbotModel.findOne({
                name: name.trim(),
                createdBy: currentUser._id
            });

            if (existing) {
                // Delete uploaded files immediately
                for (const file of req.files || []) {
                    try {
                        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
                    } catch (e) { }
                }
                return res.status(409).json({
                    success: false,
                    message: "You already have a chatbot with this name. Please choose a different name."
                });
            }

            const hasHead = currentUser.access?.includes('head movement') || false;
            const hasHand = currentUser.access?.includes('hand movement') || false;

            const onboardingFile = req.files?.find(f => f.fieldname === 'onboardingImage');
            const pdfFiles = req.files?.filter(f => f.fieldname === 'knowledgeBasePdfs');

            if (!onboardingFile) return res.status(400).json({ success: false, message: "Onboarding image is required" });
            if (!pdfFiles || pdfFiles.length === 0) return res.status(400).json({ success: false, message: "At least one PDF is required" });

            const chatbotFolderName = name.replace(/[^a-zA-Z0-9]/g, '_');
            const uploadBasePath = path.join(__dirname, '../uploads/chatbots', chatbotFolderName);
            createdFolders.push(uploadBasePath);

            const knowledgeBasePdfs = [];

            for (const pdfFile of pdfFiles) {
                const pdfNameClean = pdfFile.originalname.replace('.pdf', '').replace(/[^a-zA-Z0-9]/g, '_');

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
                handMovements = { /* your hand movements code */ };
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

            const saved = await newChatbot.save();

            res.status(201).json({
                success: true,
                message: "Chatbot created successfully!",
                data: saved
            });

        } catch (error) {
            console.error("Error:", error);

            // Cleanup on any error
            for (const folder of createdFolders) {
                try {
                    if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
                } catch (e) { }
            }

            res.status(500).json({ success: false, message: "Failed. Rolled back." });
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

        // Only owner or admin can delete
        if (chatbot.createdBy.toString() !== currentUser._id.toString() && currentUser.role !== 'admin') {
            return res.status(403).json({ success: false, message: "You can only delete your own chatbots" });
        }

        const chatbotFolderName = chatbot.name.replace(/[^a-zA-Z0-9]/g, '_');
        const folderPath = path.join(__dirname, '../uploads/chatbots', chatbotFolderName);

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

// ====================== GET CHATBOTS BY USER (Creator) ======================
const getChatbotsByUser = async (req, res) => {
    try {
        const currentUser = req.user;

        const chatbots = await ChatbotModel.find({
            createdBy: currentUser._id
        })
            .sort({ createdAt: -1 })
            .populate('createdBy', 'name email'); // Optional: creator details

        if (chatbots.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No chatbots found"
            });
        }

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

module.exports = {
    createChatbot,
    deleteChatbot,
    getChatbotsByUser
};



