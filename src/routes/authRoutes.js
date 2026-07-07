const express = require('express');
const router = express.Router();
const {
    createAdmin,
    createUser,
    verifyOTP,
    forgotPassword,
    regenerateOTP,
    setPassword,
    login,
    logout,
    toggleUserStatus
} = require('../controllers/authController');
const authenticate = require('../middlewares/auth');

// Public routes
router.post('/create-admin', createAdmin);
router.post('/create', authenticate, createUser);
router.post('/verify-otp', verifyOTP);
router.post('/forgot-password', forgotPassword);
router.post('/regenerate-otp', regenerateOTP);
router.post('/set-password', setPassword);
router.put('/toggle-status', authenticate, toggleUserStatus);
router.post('/login', login);
router.post('/logout', logout);

module.exports = router;