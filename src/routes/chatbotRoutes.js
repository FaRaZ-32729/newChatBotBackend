const express = require('express');
const router = express.Router();
const {
  createChatbot,
  createDemoChatbot,
  heartbeatDemoChatbot,
  disconnectDemoChatbot,
  updateChatbot,
  deleteChatbot,
  getChatbotsByUser,
  getPublicChatbot,
} = require('../controllers/chatbotController');
const authenticate = require('../middlewares/auth');

router.post('/create', authenticate, createChatbot);
router.post('/demo', createDemoChatbot);
router.post('/demo/:id/heartbeat', heartbeatDemoChatbot);
router.post('/demo/:id/disconnect', disconnectDemoChatbot);
router.put('/update/:id', authenticate, updateChatbot);
router.delete('/delete/:id', authenticate, deleteChatbot);
router.get('/my', authenticate, getChatbotsByUser);
router.get('/public/:id', getPublicChatbot);

module.exports = router;
