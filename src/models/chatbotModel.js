const mongoose = require('mongoose');

const chatbotSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Chatbot name is required'],
        trim: true,
        minlength: 2,
        maxlength: 100
    },

    onboardingImage: {
        type: String,
        required: [true, 'Onboarding image is required']
    },

    knowledgeBasePdfs: [{
        name: String,
        url: String,           // Backend uploaded file ka URL
        size: String,
        uploadedAt: {
            type: Date,
            default: Date.now
        },
        extractedImages: [{                     // ← Yeh field add kiya
            imageName: String,
            imageUrl: String,
            pageNumber: Number,
            mainHeading: String,
            sectionHeading: String,
            subHeading: String,
            contextText: String,
        }]
    }],

    activationKey: {
        type: String,
        required: [true, 'Activation keyword is required'],
        trim: true,
        lowercase: true
    },

    specificInstructions: {
        type: String,
        required: [true, 'Specific instructions are required'],
        trim: true,
        minlength: 10
    },

    scanCardRequired: {
        type: Boolean,
        default: false
    },

    headMovementMode: {
        type: String,
        enum: ['detecting', 'talking', 'both'],
        default: 'both'
    },

    handMovements: {
        type: {
            hi: {
                detects: { type: Boolean, default: true },
                saysHi: { type: Boolean, default: true }
            },
            bye: {
                chatEnds: { type: Boolean, default: true }
            },
            thumbsUp: {
                detects: { type: Boolean, default: true },
                correctInfo: { type: Boolean, default: true }
            }
        },
        default: null
    },

    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },

    isActive: {
        type: Boolean,
        default: true
    }

}, {
    timestamps: true
});

const ChatbotModel = mongoose.model('Chatbot', chatbotSchema);

module.exports = ChatbotModel;