/**
 * Voice chat routes.
 * Keep these under /api/voice so LLM features stay separate from CRUD chatbot routes.
 */
const express = require('express');
const router = express.Router();
const {
  startVoiceSession,
  processVoiceTurn,
  endVoiceSession,
} = require('../controllers/voiceController');
const authenticate = require('../middlewares/auth');

router.post('/session/start', authenticate, startVoiceSession);
router.post('/session/end', authenticate, endVoiceSession);
router.post('/turn', authenticate, processVoiceTurn);

module.exports = router;
