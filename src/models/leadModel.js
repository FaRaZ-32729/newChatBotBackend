const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: '' },
    company: { type: String, trim: true, default: '' },
    designation: { type: String, trim: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, default: '' },
    chatbotId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Chatbot',
      index: true,
    },
    sessionId: { type: String, default: '' },
    topic_counts: {
      type: Map,
      of: Number,
      default: {},
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Lead', leadSchema);
