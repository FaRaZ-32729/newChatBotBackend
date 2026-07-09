/**
 * Voice chat HTTP controller (kept for fallback / testing).
 * Main real-time path is Socket.IO — see src/socket/voiceSocketHandler.js
 */
const multer = require('multer');
const {
  startVoiceSessionForUser,
  processVoiceTurnForUser,
  endVoiceSessionForUser,
} = require('../llm/services/voiceTurnService');

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
}).single('audio');

const startVoiceSession = async (req, res) => {
  try {
    const { chatbotId, sessionId } = req.body || {};
    if (!chatbotId) {
      return res.status(400).json({ success: false, message: 'chatbotId is required' });
    }

    const result = await startVoiceSessionForUser({
      userId: req.user._id,
      chatbotId,
      sessionId,
      user: req.user,
    });

    if (result.error) {
      const status = result.error.code === 'FORBIDDEN' ? 403 : 404;
      return res.status(status).json({ success: false, message: result.error.message });
    }

    const { session, chatbot, knowledgeReady } = result;

    return res.status(200).json({
      success: true,
      message: 'Voice session ready',
      data: {
        sessionId: session.sessionId,
        chatbotId: String(chatbot._id),
        chatbotName: chatbot.name,
        activationKey: chatbot.activationKey,
        isActivated: session.isActivated,
        knowledgeReady,
        voiceHint: `Say "${chatbot.activationKey}" to activate ${chatbot.name}.`,
      },
    });
  } catch (error) {
    console.error('[voice] start session error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to start voice session' });
  }
};

const processVoiceTurn = (req, res) => {
  uploadAudio(req, res, async (err) => {
    try {
      if (err) {
        return res.status(400).json({ success: false, message: err.message || 'Audio upload failed' });
      }

      const chatbotId = req.body?.chatbotId;
      const sessionId = req.body?.sessionId;

      if (!chatbotId || !sessionId) {
        return res.status(400).json({ success: false, message: 'chatbotId and sessionId are required' });
      }

      if (!req.file?.buffer) {
        return res.status(400).json({ success: false, message: 'audio file is required' });
      }

      const result = await processVoiceTurnForUser({
        userId: req.user._id,
        chatbotId,
        sessionId,
        base64Audio: req.file.buffer.toString('base64'),
        mimeType: req.file.mimetype || 'audio/webm',
        user: req.user,
      });

      if (result.error) {
        const status = result.error.code === 'FORBIDDEN' ? 403 : 404;
        return res.status(status).json({ success: false, message: result.error.message });
      }

      return res.status(200).json({ success: true, message: 'Voice turn completed', data: result.data });
    } catch (error) {
      console.error('[voice] turn error:', error);
      return res.status(500).json({ success: false, message: error.message || 'Failed to process voice turn' });
    }
  });
};

const endVoiceSession = async (req, res) => {
  try {
    const { chatbotId, sessionId } = req.body || {};
    if (!chatbotId || !sessionId) {
      return res.status(400).json({ success: false, message: 'chatbotId and sessionId are required' });
    }

    endVoiceSessionForUser({ userId: req.user._id, chatbotId, sessionId });

    return res.status(200).json({
      success: true,
      message: 'Voice session ended',
      data: { sessionId, chatbotId },
    });
  } catch (error) {
    console.error('[voice] end session error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to end voice session' });
  }
};

module.exports = {
  startVoiceSession,
  processVoiceTurn,
  endVoiceSession,
};
