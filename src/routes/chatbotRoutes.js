const express = require('express');
const router = express.Router();
const { createChatbot, deleteChatbot, getChatbotsByUser, getPublicChatbot } = require('../controllers/chatbotController');
const authenticate = require('../middlewares/auth');

router.post('/create', authenticate, createChatbot);
router.delete('/delete/:id', authenticate, deleteChatbot);
router.get('/my', authenticate, getChatbotsByUser);
router.get('/public/:id', getPublicChatbot);


module.exports = router;