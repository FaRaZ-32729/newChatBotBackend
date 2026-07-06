const express = require('express');
const   router = express.Router();
const { createChatbot } = require('../controllers/chatbotController');
const authenticate = require('../middlewares/auth');

router.post('/create', authenticate, createChatbot);

module.exports = router;