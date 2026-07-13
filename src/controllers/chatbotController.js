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

// ====================== UPDATE CHATBOT ======================
/**
 * Partial update. Only sent fields change.
 * PDFs: send retainedPdfUrls (JSON array of existing urls to KEEP).
 * Any existing PDF not listed is removed AFTER successful save (DB + disk + images).
 * New PDFs: knowledgeBasePdfs files — same extract flow as create.
 * On any error before successful DB save: leave chatbot exactly as before; delete only new uploads.
 */
function userHasAccess(accessList, key) {
    const list = Array.isArray(accessList) ? accessList : [];
    const want = String(key).toLowerCase();
    return list.some((a) => String(a).toLowerCase() === want);
}

function normalizeUploadUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    try {
        if (raw.startsWith('http://') || raw.startsWith('https://')) {
            const u = new URL(raw);
            return u.pathname;
        }
    } catch {
        /* ignore */
    }
    return raw.startsWith('/') ? raw : `/${raw}`;
}

function resolveUploadFsPath(urlPath) {
    const normalized = normalizeUploadUrl(urlPath).replace(/^\//, '');
    return path.join(__dirname, '../..', normalized);
}

function getChatbotFolderName(chatbot) {
    const fromUrl = normalizeUploadUrl(chatbot.onboardingImage || chatbot.knowledgeBasePdfs?.[0]?.url || '');
    const match = fromUrl.match(/\/uploads\/chatbots\/([^/]+)\//);
    if (match?.[1]) return match[1];
    return String(chatbot.name || 'default').replace(/[^a-zA-Z0-9]/g, '_');
}

function pdfImagesDir(folderName, pdfOriginalName) {
    const pdfNameClean = String(pdfOriginalName || '')
        .replace(/\.pdf$/i, '')
        .replace(/[^a-zA-Z0-9]/g, '_');
    return path.join(__dirname, '../../uploads/chatbots', folderName, pdfNameClean);
}

function removePdfArtifactsFromDisk(pdfEntry, folderName) {
    try {
        if (pdfEntry?.url) {
            const pdfPath = resolveUploadFsPath(pdfEntry.url);
            if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
        }
    } catch (e) {
        console.error('Failed to remove PDF file:', pdfEntry?.url, e.message);
    }

    try {
        const imgDir = pdfImagesDir(folderName, pdfEntry?.name);
        if (fs.existsSync(imgDir)) {
            fs.rmSync(imgDir, { recursive: true, force: true });
        }
    } catch (e) {
        console.error('Failed to remove PDF images folder:', pdfEntry?.name, e.message);
    }
}

function canManageChatbot(user, chatbot) {
    const ownerId = chatbot.createdBy.toString();
    const isOwner = ownerId === user._id.toString();
    const isTeamMember =
        user.role === 'user' && user.createdBy?.toString() === ownerId;
    const isAdmin = user.role === 'admin';
    return isOwner || isTeamMember || isAdmin;
}

const updateChatbot = async (req, res) => {
    const { id } = req.params;
    const currentUser = req.user;

    let chatbot;
    try {
        chatbot = await ChatbotModel.findById(id);
    } catch (error) {
        return res.status(400).json({ success: false, message: 'Invalid chatbot id' });
    }

    if (!chatbot) {
        return res.status(404).json({ success: false, message: 'Chatbot not found' });
    }

    if (!canManageChatbot(currentUser, chatbot)) {
        return res.status(403).json({
            success: false,
            message: 'You can only update your team chatbots',
        });
    }

    const folderName = getChatbotFolderName(chatbot);
    req.uploadFolderName = folderName;

    // Track only NEW artifacts for rollback (never touch existing until DB save succeeds)
    const newUploadFiles = [];
    const newImageFolders = [];

    uploadAny(req, res, async (err) => {
        try {
            if (err) {
                console.error('Multer Error (update):', err);
                return res.status(400).json({ success: false, message: err.message });
            }

            const files = req.files || [];
            newUploadFiles.push(...files);

            const body = req.body || {};
            const hasHead = userHasAccess(currentUser.access, 'head movement');
            const hasHand = userHasAccess(currentUser.access, 'hand movement');

            // --- Parse retained PDF urls (keep list). If omitted, keep all existing. ---
            let retainedPdfUrls = null;
            if (body.retainedPdfUrls !== undefined && body.retainedPdfUrls !== '') {
                try {
                    retainedPdfUrls = typeof body.retainedPdfUrls === 'string'
                        ? JSON.parse(body.retainedPdfUrls)
                        : body.retainedPdfUrls;
                    if (!Array.isArray(retainedPdfUrls)) {
                        throw new Error('retainedPdfUrls must be an array');
                    }
                    retainedPdfUrls = retainedPdfUrls.map(normalizeUploadUrl).filter(Boolean);
                } catch (parseErr) {
                    cleanupChatbotUploads([], newUploadFiles);
                    return res.status(400).json({
                        success: false,
                        message: 'retainedPdfUrls must be a JSON array of PDF urls to keep',
                    });
                }
            }

            const existingPdfs = Array.isArray(chatbot.knowledgeBasePdfs)
                ? chatbot.knowledgeBasePdfs.map((p) => p.toObject?.() || p)
                : [];

            const retainedSet = retainedPdfUrls
                ? new Set(retainedPdfUrls)
                : new Set(existingPdfs.map((p) => normalizeUploadUrl(p.url)));

            const keptPdfs = existingPdfs.filter((p) => retainedSet.has(normalizeUploadUrl(p.url)));
            const removedPdfs = existingPdfs.filter((p) => !retainedSet.has(normalizeUploadUrl(p.url)));

            // --- Process NEW PDFs (create-style extraction) ---
            const newPdfFiles = files.filter((f) => f.fieldname === 'knowledgeBasePdfs');
            const addedPdfs = [];

            for (const pdfFile of newPdfFiles) {
                const pdfNameClean = pdfFile.originalname
                    .replace(/\.pdf$/i, '')
                    .replace(/[^a-zA-Z0-9]/g, '_');
                const imagesFolder = pdfImagesDir(folderName, pdfFile.originalname);
                newImageFolders.push(imagesFolder);

                const extractedImages = await processPDFImages(
                    pdfFile.path,
                    folderName,
                    pdfNameClean
                );

                addedPdfs.push({
                    name: pdfFile.originalname,
                    url: `/uploads/chatbots/${folderName}/${pdfFile.filename}`,
                    size: `${(pdfFile.size / (1024 * 1024)).toFixed(2)} MB`,
                    extractedImages,
                });
            }

            const nextPdfs = [...keptPdfs, ...addedPdfs];
            if (nextPdfs.length === 0) {
                cleanupChatbotUploads(newImageFolders, newUploadFiles);
                return res.status(400).json({
                    success: false,
                    message: 'At least one knowledge base PDF is required',
                });
            }

            // --- Optional field updates (only if provided) ---
            const nextName = body.name !== undefined ? String(body.name).trim() : chatbot.name;
            const nextActivationKey = body.activationKey !== undefined
                ? String(body.activationKey).toLowerCase().trim()
                : chatbot.activationKey;
            const nextInstructions = body.specificInstructions !== undefined
                ? String(body.specificInstructions).trim()
                : chatbot.specificInstructions;

            if (!nextName || !nextActivationKey || !nextInstructions) {
                cleanupChatbotUploads(newImageFolders, newUploadFiles);
                return res.status(400).json({
                    success: false,
                    message: 'Name, Activation Key and Instructions are required',
                });
            }

            // Unique name within owner pool (exclude self)
            if (nextName !== chatbot.name) {
                const ownerId = chatbot.createdBy;
                const clash = await ChatbotModel.findOne({
                    name: nextName,
                    createdBy: ownerId,
                    _id: { $ne: chatbot._id },
                });
                if (clash) {
                    cleanupChatbotUploads(newImageFolders, newUploadFiles);
                    return res.status(409).json({
                        success: false,
                        message: 'A chatbot with this name already exists for your team. Please choose a different name.',
                    });
                }
            }

            let nextScanCard = chatbot.scanCardRequired;
            if (body.scanCardRequired !== undefined) {
                nextScanCard = body.scanCardRequired === 'true' || body.scanCardRequired === true;
            }

            let nextHead = chatbot.headMovementMode;
            if (hasHead && body.headMovementMode !== undefined) {
                nextHead = body.headMovementMode || null;
            } else if (!hasHead) {
                nextHead = chatbot.headMovementMode;
            }

            let nextHand = chatbot.handMovements;
            if (hasHand && body.handMovements !== undefined) {
                let parsed = body.handMovements;
                if (typeof parsed === 'string') {
                    try {
                        parsed = JSON.parse(parsed);
                    } catch {
                        parsed = null;
                    }
                }
                nextHand = parsed;
            }

            const onboardingFile = files.find((f) => f.fieldname === 'onboardingImage');
            let nextOnboarding = chatbot.onboardingImage;
            let oldOnboardingToDelete = null;
            if (onboardingFile) {
                nextOnboarding = `/uploads/chatbots/${folderName}/${onboardingFile.filename}`;
                oldOnboardingToDelete = chatbot.onboardingImage;
            }

            const pdfsChanged = removedPdfs.length > 0 || addedPdfs.length > 0;

            // Apply updates in memory then save — if save fails, nothing persisted
            chatbot.name = nextName;
            chatbot.activationKey = nextActivationKey;
            chatbot.specificInstructions = nextInstructions;
            chatbot.scanCardRequired = nextScanCard;
            chatbot.headMovementMode = nextHead;
            chatbot.handMovements = nextHand;
            chatbot.onboardingImage = nextOnboarding;
            chatbot.knowledgeBasePdfs = nextPdfs;

            if (pdfsChanged) {
                chatbot.knowledgeTextCache = '';
                chatbot.knowledgeCachedAt = undefined;
            }

            const saved = await chatbot.save();

            // DB saved — now safe to delete removed PDF files / old avatar from disk
            for (const pdf of removedPdfs) {
                removePdfArtifactsFromDisk(pdf, folderName);
            }
            if (oldOnboardingToDelete && oldOnboardingToDelete !== nextOnboarding) {
                try {
                    const oldPath = resolveUploadFsPath(oldOnboardingToDelete);
                    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
                } catch (e) {
                    console.error('Failed to remove old onboarding image:', e.message);
                }
            }

            if (pdfsChanged) {
                setImmediate(async () => {
                    try {
                        const { getChatbotKnowledge } = require('../llm/services/knowledgeService');
                        await getChatbotKnowledge(saved);
                    } catch (cacheErr) {
                        console.error('[chatbot] knowledge cache rebuild failed:', cacheErr.message);
                    }
                });
            }

            return res.status(200).json({
                success: true,
                message: 'Chatbot updated successfully!',
                data: saved,
            });
        } catch (error) {
            console.error('Update Chatbot Error:', error);

            // Rollback new uploads only — existing DB + files untouched
            cleanupChatbotUploads(newImageFolders, newUploadFiles);

            // Reload original doc state is automatic since we never saved on failure
            // (if save() partially ran it would throw before commit — mongoose save is atomic per doc)

            const message = error.message || 'Failed to update chatbot. No changes were applied.';
            const status = /extraction failed/i.test(message) ? 422 : 500;

            return res.status(status).json({
                success: false,
                message,
            });
        }
    });
};

// ====================== GET PUBLIC CHATBOT (shareable URL) ======================
// No login required — used when opening /chatbot/:id link
const getPublicChatbot = async (req, res) => {
    try {
        const { id } = req.params;
        const chatbot = await ChatbotModel.findById(id).select('name onboardingImage isActive activationKey');

        if (!chatbot || chatbot.isActive === false) {
            return res.status(404).json({ success: false, message: 'Chatbot not found or inactive' });
        }

        res.status(200).json({
            success: true,
            data: {
                _id: chatbot._id,
                name: chatbot.name,
                onboardingImage: chatbot.onboardingImage,
                activationKey: chatbot.activationKey || '',
            },
        });
    } catch (error) {
        console.error('Get Public Chatbot Error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

module.exports = {
    createChatbot,
    updateChatbot,
    deleteChatbot,
    getChatbotsByUser,
    getPublicChatbot,
};



