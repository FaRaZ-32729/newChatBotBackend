const UserModel = require('../models/userModel');
const sendEmail = require('../utils/emailService');
const jwt = require('jsonwebtoken');
const bcrypt = require("bcryptjs");
const { getAuthCookieOptions, getClearAuthCookieOptions } = require('../utils/authCookie');

// Helper: Generate JWT Token
const generateToken = (user) => {
    return jwt.sign(
        { id: user._id, role: user.role, email: user.email },   // ← 'id' not '_id'
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );
};

// Helper: Generate Unique 6-digit Session ID
const generateSessionId = async () => {
    let sessionId;
    let isUnique = false;

    while (!isUnique) {
        // Generate 6 digit random number (100000 - 999999)
        sessionId = Math.floor(100000 + Math.random() * 900000).toString();

        const existing = await UserModel.findOne({ sessionId });
        if (!existing) {
            isUnique = true;
        }
    }

    return sessionId;
};

// Password Strength Regex: Minimum 8 chars, 1 uppercase, 1 lowercase, 1 number, 1 special char
const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

// ====================== CREATE ADMIN ======================
const createAdmin = async (req, res) => {
    try {
        const { name, email, password } = req.body;

        // Basic field check
        if (!name || !email || !password) {
            return res.status(400).json({ success: false, message: "Name, email and password are required" });
        }

        // Email validation
        const emailRegex = /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ success: false, message: "Please provide a valid email address" });
        }

        // Strong password validation
        if (!passwordRegex.test(password)) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 8 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special character (@$!%*?&)"
            });
        }

        const existingUser = await UserModel.findOne({ email });
        if (existingUser) {
            return res.status(409).json({ success: false, message: "Email already exists" });
        }

        // generates unique session id
        const sessionId = await generateSessionId();

        // Hash password
        const salt = await bcrypt.genSalt(12);
        const hashedPassword = await bcrypt.hash(password, salt);

        const admin = new UserModel({
            name: name.trim(),
            email: email.toLowerCase().trim(),
            password: hashedPassword,
            role: 'admin',
            createdBy: null,
            isActive: true,
            verified: true,
            sessionId: sessionId,
            access: null
        });

        await admin.save();

        res.status(201).json({
            success: true,
            message: "Admin created successfully",
            data: { userId: admin._id, email: admin.email }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

// ====================== CREATE USER (Manager/User) ======================
const createUser = async (req, res) => {
    try {
        const { name, email, access } = req.body;   // ← access added
        const creator = req.user;

        if (!name || !email) {
            return res.status(400).json({ success: false, message: "Name and email are required" });
        }

        // Email validation
        const emailRegex = /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ success: false, message: "Please provide a valid email address" });
        }

        const existingUser = await UserModel.findOne({ email });
        if (existingUser) {
            return res.status(409).json({ success: false, message: "Email already registered" });
        }

        let roleToAssign = creator.role === 'admin' ? 'manager' : 'user';

        if (creator.role !== 'admin' && creator.role !== 'manager') {
            return res.status(403).json({ success: false, message: "Unauthorized to create users" });
        }

        // Access Validation & Inheritance Logic
        let userAccess = null;

        if (creator.role === 'admin') {
            const validAccess = ['head movement', 'hand movement'];

            if (access !== undefined && access !== null) {
                const accessList = Array.isArray(access) ? access : [access];

                if (accessList.length > 0) {
                    const invalid = accessList.filter((item) => !validAccess.includes(item));
                    if (invalid.length > 0) {
                        return res.status(400).json({
                            success: false,
                            message: "Access must be 'head movement' and/or 'hand movement'"
                        });
                    }
                    userAccess = [...new Set(accessList)];
                }
            }
        }
        else if (creator.role === 'manager') {
            // Manager's users inherit the same access as manager
            userAccess = creator.access;
        }

        // generate unique session id
        const sessionId = await generateSessionId();

        // Create user object
        const newUser = new UserModel({
            name: name.trim(),
            email: email.toLowerCase().trim(),
            role: roleToAssign,
            createdBy: creator._id,
            isActive: false,
            verified: false,
            access: userAccess,
            sessionId: sessionId
        });

        const otp = newUser.generateOTP();

        // Prepare Email
        const verificationLink = `${process.env.FRONTEND_URL}/verify-otp?email=${email.toLowerCase()}`;

        const emailHTML = `
            <h2>Welcome to Chatbot</h2>
            <p>Hello ${name},</p>
            <p>Your account has been created by ${creator.name} (${creator.role}).</p>
            <p>Your OTP is: <strong>${otp}</strong></p>
            <p>This OTP expires in 15 minutes.</p>
            <p><a href="${verificationLink}" style="padding:12px 24px; background:#007bff; color:white; text-decoration:none; border-radius:4px;">Verify Account</a></p>
        `;

        // Send Email FIRST
        await sendEmail(email, "Verify Your Chatbot Account", emailHTML);

        // Save to database after email success
        await newUser.save();

        res.status(201).json({
            success: true,
            message: `New ${roleToAssign} created successfully. Verification email sent.`,
            data: {
                userId: newUser._id,
                email: newUser.email,
                access: newUser.access
            }
        });

    } catch (error) {
        console.error("Create User Error:", error);

        if (error.code === 'EAUTH' || error.message.includes('SMTP')) {
            return res.status(500).json({
                success: false,
                message: "Failed to send verification email. Please check SMTP settings."
            });
        }

        res.status(500).json({ success: false, message: "Server error while creating user" });
    }
};

// @desc    Verify OTP
const verifyOTP = async (req, res) => {
    try {
        const { email, otp } = req.body;

        if (!email || !otp) {
            return res.status(400).json({ success: false, message: "Email and OTP are required" });
        }

        const user = await UserModel.findOne({ email }).select('+otp +otpExpiry');

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (!user.otp || !user.otpExpiry || Date.now() > user.otpExpiry) {
            return res.status(400).json({ success: false, message: "OTP expired" });
        }

        if (user.otp !== otp) {
            return res.status(400).json({ success: false, message: "Invalid OTP" });
        }

        user.otp = undefined;
        user.otpExpiry = undefined;

        if (!user.verified) {
            user.verified = true;
        }

        await user.save();

        res.status(200).json({
            success: true,
            message: "OTP verified successfully. You can now set your password."
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

// @desc    Forgot Password - send OTP to verified active users
const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ success: false, message: "Email is required" });
        }

        const user = await UserModel.findOne({ email: email.toLowerCase().trim() });

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (!user.verified || !user.isActive) {
            return res.status(400).json({ success: false, message: "Account is not active." });
        }

        const otp = user.generateOTP();
        await user.save();

        const verificationLink = `${process.env.FRONTEND_URL}/verify-otp?email=${user.email}`;

        const emailHTML = `
            <h2>Password Reset Request</h2>
            <p>Hello ${user.name},</p>
            <p>Your password reset OTP is: <strong>${otp}</strong></p>
            <p>This OTP expires in 15 minutes.</p>
            <p><a href="${verificationLink}" style="padding:12px 24px; background:#007bff; color:white; text-decoration:none; border-radius:4px;">Verify OTP & Set New Password</a></p>
        `;

        await sendEmail(user.email, "Password Reset OTP", emailHTML);

        res.status(200).json({
            success: true,
            message: "Password reset OTP sent to your email."
        });
    } catch (error) {
        console.error("Forgot Password Error:", error);

        if (error.code === 'EAUTH' || error.message.includes('SMTP')) {
            return res.status(500).json({
                success: false,
                message: "Failed to send password reset email. Please check SMTP settings."
            });
        }

        res.status(500).json({ success: false, message: "Server error" });
    }
};

// @desc    Regenerate OTP
const regenerateOTP = async (req, res) => {
    try {
        const { email } = req.body;

        const user = await UserModel.findOne({ email });
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (user.verified && !user.isActive) {
            return res.status(400).json({ success: false, message: "Account is not active." });
        }

        const otp = user.generateOTP();
        await user.save();

        const verificationLink = `${process.env.FRONTEND_URL}/verify-otp?email=${user.email}`;
        const emailSubject = user.verified ? "New Password Reset OTP" : "New OTP - LuckyOneMall";
        const emailHTML = user.verified
            ? `
            <h2>New Password Reset OTP</h2>
            <p>Hello ${user.name},</p>
            <p>Your new password reset OTP is: <strong>${otp}</strong></p>
            <p>This OTP is valid for 15 minutes.</p>
            <p><a href="${verificationLink}">Verify OTP & Set New Password</a></p>
        `
            : `
            <h2>New OTP Request</h2>
            <p>Your new OTP is: <strong>${otp}</strong></p>
            <p>This OTP is valid for 15 minutes.</p>
            <p><a href="${verificationLink}">Verify Account</a></p>
        `;

        await sendEmail(email, emailSubject, emailHTML);

        res.status(200).json({ success: true, message: "New OTP sent successfully" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

// ====================== SET PASSWORD ======================
const setPassword = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password || password.length < 8) {
            return res.status(400).json({ success: false, message: "Valid email and password (min 8 chars) required" });
        }

        const user = await UserModel.findOne({ email });
        if (!user) return res.status(404).json({ success: false, message: "User not found" });

        if (!user.verified) {
            return res.status(400).json({ success: false, message: "Please verify OTP first" });
        }

        // Hash password manually
        const salt = await bcrypt.genSalt(12);
        const hashedPassword = await bcrypt.hash(password, salt);

        user.password = hashedPassword;
        user.isActive = true;
        await user.save();

        res.status(200).json({
            success: true,
            message: "Password set successfully. You can now login."
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

// @desc    Toggle User Active Status (Admin Only)
const toggleUserStatus = async (req, res) => {
    try {
        const { userId, isActive, suspensionReason } = req.body;

        if (!userId || typeof isActive !== 'boolean') {
            return res.status(400).json({
                success: false,
                message: "userId and isActive (true/false) are required"
            });
        }

        if (req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                message: "Only admin can activate or deactivate users"
            });
        }

        const user = await UserModel.findById(userId);

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        // Prevent self deactivation
        if (user._id.toString() === req.user._id.toString()) {
            return res.status(400).json({
                success: false,
                message: "You cannot deactivate your own account"
            });
        }

        if (!isActive && !suspensionReason) {
            return res.status(400).json({
                success: false,
                message: "Suspension reason is required when deactivating user"
            });
        }

        // === Main Logic ===
        user.isActive = isActive;

        if (isActive) {
            user.suspensionReason = null;
        } else {
            user.suspensionReason = suspensionReason.trim();
        }

        await user.save();

        // If deactivating a Manager → Also deactivate all his users
        if (!isActive && user.role === 'manager') {
            await UserModel.updateMany(
                { createdBy: user._id, role: 'user' },
                {
                    isActive: false,
                    suspensionReason: `Deactivated because your manager (${user.name}) was suspended`
                }
            );
        }

        // Send Email Notification
        let emailSubject, emailHTML;

        if (isActive) {
            emailSubject = "Your Account Has Been Activated";
            emailHTML = `
                <h2>Account Activated</h2>
                <p>Hello ${user.name},</p>
                <p>Your account has been activated by the Admin.</p>
                <p>You can now login and use the system.</p>
            `;
        } else {
            emailSubject = "Your Account Has Been Suspended";
            emailHTML = `
                <h2>Account Suspended</h2>
                <p>Hello ${user.name},</p>
                <p>Your account has been deactivated by the Admin.</p>
                <p><strong>Reason:</strong> ${suspensionReason}</p>
                <p>Please contact support if you have any questions.</p>
            `;
        }

        await sendEmail(user.email, emailSubject, emailHTML);

        res.status(200).json({
            success: true,
            message: `User ${isActive ? 'activated' : 'deactivated'} successfully`,
            data: {
                userId: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
                isActive: user.isActive,
                suspensionReason: user.suspensionReason
            }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

// @desc    Login User
const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await UserModel.findOne({ email }).select('+password');
        if (!user) {
            return res.status(401).json({ success: false, message: "Invalid credentials" });
        }

        if (!user.isActive || !user.verified) {
            return res.status(401).json({ success: false, message: "Account is not active." });
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: "Invalid credentials" });
        }

        // Update last login
        user.lastLogin = Date.now();
        await user.save();

        const token = generateToken(user);

        // httpOnly cookie — SameSite=None + Secure when frontend is on another domain (Vercel)
        res.cookie('token', token, getAuthCookieOptions());

        res.status(200).json({
            success: true,
            message: "Login successful",
            data: {
                user: {
                    id: user._id,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    access: user.access,
                    createdBy: user.createdBy
                }
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

// logout user 
const logout = async (req, res) => {
    try {
        res.clearCookie('token', getClearAuthCookieOptions());
        res.status(200).json({ success: true, message: "Logged out successfully" });
    } catch (error) {
        console.error("Error in logout:", error);
        res.status(500).json({ success: false, message: "Logout failed" });
    }
};

module.exports = {
    createAdmin,
    createUser,
    verifyOTP,
    forgotPassword,
    regenerateOTP,
    setPassword,
    login,
    toggleUserStatus,
    logout
};