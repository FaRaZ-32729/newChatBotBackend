const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Name is required'],
        trim: true,
        minlength: 2,
        maxlength: 100
    },

    email: {
        type: String,
        required: [true, 'Email is required'],
        unique: true,
        lowercase: true,
        trim: true
    },

    password: {
        type: String,
        minlength: 8,
        select: false,
        default: null
    },

    role: {
        type: String,
        enum: ['admin', 'manager', 'user'],
        required: true
    },

    access: {
        type: [String],
        enum: [null, 'head movement', 'hand movement'],
        default: null
    },

    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },

    sessionId: {
        type: String,
        unique: true,
        sparse: true,
        index: true
    },

    isActive: {
        type: Boolean,
        default: false
    },

    verified: {
        type: Boolean,
        default: false
    },

    suspensionReason: {
        type: String,
        default: null
    },

    otp: {
        type: String,
        select: false
    },

    otpExpiry: {
        type: Date,
        select: false
    },

    lastLogin: {
        type: Date,
        default: null
    }

}, {
    timestamps: true
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
    if (!this.password) return false;
    return bcrypt.compare(candidatePassword, this.password);
};

// Generate OTP
userSchema.methods.generateOTP = function () {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    this.otp = otp;
    this.otpExpiry = Date.now() + 15 * 60 * 1000;
    return otp;
};

const UserModel = mongoose.model('User', userSchema);

module.exports = UserModel;