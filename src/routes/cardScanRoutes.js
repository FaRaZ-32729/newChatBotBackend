/**
 * Card scan routes — POST /api/card-scan
 */
const express = require('express');
const router = express.Router();
const { cardUpload, ensureUploadDir } = require('../middlewares/cardUpload');
const { scanVisitingCard } = require('../controllers/cardScanController');

ensureUploadDir();

router.post('/', cardUpload.single('image'), scanVisitingCard);

module.exports = router;
