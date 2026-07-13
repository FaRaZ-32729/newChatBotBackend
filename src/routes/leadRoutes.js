/**
 * Lead routes — POST /api/leads (public kiosk)
 *            — GET  /api/leads/chatbot/:chatbotId (auth)
 */
const express = require('express');
const router = express.Router();
const authenticate = require('../middlewares/auth');
const { createLead, getLeadsByChatbot } = require('../controllers/leadController');

router.post('/', createLead);
router.get('/chatbot/:chatbotId', authenticate, getLeadsByChatbot);

module.exports = router;
