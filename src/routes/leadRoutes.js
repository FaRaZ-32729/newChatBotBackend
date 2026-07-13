/**
 * Lead routes — POST /api/leads
 */
const express = require('express');
const router = express.Router();
const { createLead } = require('../controllers/leadController');

router.post('/', createLead);

module.exports = router;
