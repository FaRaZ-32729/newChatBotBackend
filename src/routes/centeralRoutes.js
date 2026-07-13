// src/routes/centralRoutes.js
const express = require("express");
const router = express.Router();

// Import all module routes
const authRoutes = require("./authRoutes");
const userRoutes = require("./userRoutes");
const chatbotRoutes = require("./chatbotRoutes");
const voiceRoutes = require("./voiceRoutes");
const cardScanRoutes = require("./cardScanRoutes");
const leadRoutes = require("./leadRoutes");
const angleRoutes = require("./angleRoutes");


// Mount all routes with proper prefixes
router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/chatbot", chatbotRoutes);
// Voice / LLM routes live in their own folder tree under /api/voice
router.use("/voice", voiceRoutes);
router.use("/card-scan", cardScanRoutes);
router.use("/leads", leadRoutes);
router.use("/", angleRoutes);


// Health check route
router.get("/health", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Hellow FaRaZ your CHATBOT Backend is healthy",
        timestamp: new Date().toISOString()
    });
});

module.exports = router;