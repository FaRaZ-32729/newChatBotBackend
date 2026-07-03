// src/routes/centralRoutes.js
const express = require("express");
const router = express.Router();

// Import all module routes
const authRoutes = require("./authRoutes");
const sendEmail = require("../utils/emailService");


// Mount all routes with proper prefixes
router.use("/auth", authRoutes);


// Health check route
router.get("/health", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Hellow FaRaZ your CHATBOT Backend is healthy",
        timestamp: new Date().toISOString()
    });
});

router.get('/test-email', async (req, res) => {
    try {
        await sendEmail("farazthedev@gmail.com", "Test Email", "<h1>Hello, this is a test</h1>");
        res.json({ success: true, message: "Test email sent" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;