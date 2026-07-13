/**
 * Lead capture controller — public kiosk submit with validation.
 */
const mongoose = require('mongoose');
const { saveLead } = require('../llm/services/leadService');

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

module.exports = {
  createLead,
  validateLeadPayload,
};
