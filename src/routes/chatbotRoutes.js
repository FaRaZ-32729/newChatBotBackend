const express = require('express');
const router = express.Router();
const { createChatbot, deleteChatbot, getChatbotsByUser,  } = require('../controllers/chatbotController');
const authenticate = require('../middlewares/auth');

router.post('/create', authenticate, createChatbot);
router.delete('/delete/:id', authenticate, deleteChatbot);
router.get('/my', authenticate, getChatbotsByUser);


module.exports = router;