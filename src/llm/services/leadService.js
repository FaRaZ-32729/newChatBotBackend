const LeadModel = require('../../models/leadModel');

async function saveLead({
  name,
  company,
  designation,
  phone,
  email,
  chatbotId,
  sessionId,
  topic_counts = {},
}) {
  const countsMap = new Map();
  if (topic_counts && typeof topic_counts === 'object') {
    for (const [key, value] of Object.entries(topic_counts)) {
      countsMap.set(key, Number(value) || 0);
    }
  }

  const lead = await LeadModel.create({
    name: name || '',
    company: company || '',
    designation: designation || '',
    phone: phone || '',
    email: email || '',
    chatbotId: chatbotId || undefined,
    sessionId: sessionId || '',
    topic_counts: countsMap,
  });

  return lead;
}

async function getLeadsByChatbotId(chatbotId) {
  return LeadModel.find({ chatbotId })
    .sort({ createdAt: -1 })
    .lean();
}

module.exports = { saveLead, getLeadsByChatbotId };
