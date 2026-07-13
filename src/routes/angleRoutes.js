const express = require('express');
const router = express.Router();
const { postAngle, getAngleHealth } = require('../controllers/angleController');

router.post('/send-angle', postAngle);
router.get('/angle/health', getAngleHealth);

module.exports = router;
