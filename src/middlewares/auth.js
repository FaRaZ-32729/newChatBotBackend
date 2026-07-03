// src/middleware/auth.js
const jwt = require("jsonwebtoken");
const UserModel = require("../models/userModel");   // ← Changed to UserModel

const authenticate = async (req, res, next) => {
    try {
        let token;

        if (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
            token = req.headers.authorization.split(" ")[1];
        } else if (req.cookies?.token) {
            token = req.cookies.token;
        }

        if (!token) {
            return res.status(401).json({ success: false, message: "Access denied. Please login first." });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const user = await UserModel.findById(decoded.id)   // ← Changed from decoded._id to decoded.id
            .select("-password");

        if (!user) {
            return res.status(401).json({ success: false, message: "User not found" });
        }

        if (!user.isActive) {
            return res.status(401).json({ success: false, message: "Account is deactivated" });
        }

        req.user = user;
        next();
    } catch (error) {
        console.error("Auth Error:", error);
        return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }
};

module.exports = authenticate;