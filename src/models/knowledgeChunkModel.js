const mongoose = require('mongoose');

const knowledgeChunkSchema = new mongoose.Schema({
  chatbotId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chatbot',
    required: true,
    index: true,
  },
  pdfKey: {
    type: String,
    default: '',
    index: true,
  },
  pdfName: {
    type: String,
    default: '',
  },
  sectionHeading: {
    type: String,
    default: '',
  },
  text: {
    type: String,
    required: true,
  },
  // Dimension is set by embeddingService (gemini-embedding-001 → 768).
  embedding: {
    type: [Number],
    default: [],
  },
  relatedImageIds: {
    type: [Number],
    default: [],
  },
  isOverview: {
    type: Boolean,
    default: false,
    index: true,
  },
  pageNumber: {
    type: Number,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

knowledgeChunkSchema.index({ chatbotId: 1, pdfKey: 1 });
knowledgeChunkSchema.index({ chatbotId: 1, isOverview: 1 });

module.exports = mongoose.model('KnowledgeChunk', knowledgeChunkSchema);
