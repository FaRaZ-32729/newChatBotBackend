/**
 * Lead capture controller — public create + authenticated list by chatbot.
 */
const mongoose = require('mongoose');
const ChatbotModel = require('../models/chatbotModel');
const { saveLead, getLeadsByChatbotId } = require('../llm/services/leadService');

function clean(value) {
  return String(value || '').trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

function validateLeadPayload(body) {
  const name = clean(body.name);
  const company = clean(body.company);
  const designation = clean(body.designation);
  const phone = clean(body.phone);
  const email = clean(body.email);
  const chatbotId = clean(body.chatbotId);
  const sessionId = clean(body.sessionId);

  const errors = [];

  if (!name || name.length < 2) errors.push('Name is required (min 2 characters)');
  if (!phone) errors.push('Phone is required');
  else if (!isValidPhone(phone)) errors.push('Phone number looks invalid');
  if (!email) errors.push('Email is required');
  else if (!isValidEmail(email)) errors.push('Email looks invalid');
  if (!chatbotId || !mongoose.Types.ObjectId.isValid(chatbotId)) {
    errors.push('Valid chatbotId is required');
  }

  return {
    errors,
    data: {
      name,
      company,
      designation,
      phone,
      email,
      chatbotId,
      sessionId,
      topic_counts: body.topic_counts || {},
    },
  };
}

function canAccessChatbot(user, chatbot) {
  const ownerId = chatbot.createdBy?.toString?.() || String(chatbot.createdBy);
  const userId = user._id.toString();
  const isOwner = ownerId === userId;
  const isTeamMember =
    user.role === 'user' && user.createdBy?.toString() === ownerId;
  const isAdmin = user.role === 'admin';
  return isOwner || isTeamMember || isAdmin;
}

function topicCountsToObject(topicCounts) {
  if (!topicCounts) return {};
  if (topicCounts instanceof Map) {
    return Object.fromEntries(topicCounts);
  }
  if (typeof topicCounts === 'object') {
    // Mongoose Map lean() can be plain object
    return { ...topicCounts };
  }
  return {};
}

function serializeLead(lead) {
  return {
    id: lead._id,
    name: lead.name || '',
    company: lead.company || '',
    designation: lead.designation || '',
    phone: lead.phone || '',
    email: lead.email || '',
    chatbotId: lead.chatbotId,
    sessionId: lead.sessionId || '',
    topic_counts: topicCountsToObject(lead.topic_counts),
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
  };
}

async function createLead(req, res) {
  try {
    const { errors, data } = validateLeadPayload(req.body || {});
    if (errors.length) {
      return res.status(400).json({
        success: false,
        message: errors[0],
        errors,
      });
    }

    const lead = await saveLead(data);

    return res.status(201).json({
      success: true,
      message: 'Lead saved successfully',
      data: {
        id: lead._id,
        name: lead.name,
        company: lead.company,
        designation: lead.designation,
        phone: lead.phone,
        email: lead.email,
      },
    });
  } catch (err) {
    console.error('[lead] create error:', err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to save lead',
    });
  }
}

/**
 * GET /api/leads/chatbot/:chatbotId
 * Returns only leads for that chatbot (auth + ownership required).
 */
async function getLeadsByChatbot(req, res) {
  try {
    const { chatbotId } = req.params;

    if (!chatbotId || !mongoose.Types.ObjectId.isValid(chatbotId)) {
      return res.status(400).json({
        success: false,
        message: 'Valid chatbotId is required',
      });
    }

    const chatbot = await ChatbotModel.findById(chatbotId).select('name createdBy isActive');
    if (!chatbot) {
      return res.status(404).json({ success: false, message: 'Chatbot not found' });
    }

    if (!canAccessChatbot(req.user, chatbot)) {
      return res.status(403).json({
        success: false,
        message: 'You can only view leads for your team chatbots',
      });
    }

    const leads = await getLeadsByChatbotId(chatbotId);

    return res.status(200).json({
      success: true,
      count: leads.length,
      data: {
        chatbot: {
          id: chatbot._id,
          name: chatbot.name,
        },
        leads: leads.map(serializeLead),
      },
    });
  } catch (err) {
    console.error('[lead] list by chatbot error:', err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to fetch leads',
    });
  }
}

module.exports = {
  createLead,
  getLeadsByChatbot,
  validateLeadPayload,
};
