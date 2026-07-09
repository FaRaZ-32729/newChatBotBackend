/**
 * In-memory voice session store.
 *
 * Why this exists:
 * Many users can talk to many chatbots at the same time.
 * Each pair (userId + chatbotId + browser sessionId) gets its OWN session state:
 * activation flag, short chat history, and last activity time.
 * Sessions never share memory, so answers do not mix between bots or users.
 */

const { geminiConfig } = require('../config/geminiConfig');
const { randomUUID } = require('crypto');

/** @type {Map<string, object>} */
const sessions = new Map();

function makeKey(userId, chatbotId, sessionId) {
  return `${String(userId)}::${String(chatbotId)}::${String(sessionId)}`;
}

/**
 * Create or return an existing voice session for this user + chatbot.
 */
function getOrCreateSession({ userId, chatbotId, sessionId, chatbotName, activationKey }) {
  const id = sessionId || randomUUID();
  const key = makeKey(userId, chatbotId, id);

  if (sessions.has(key)) {
    const existing = sessions.get(key);
    existing.lastActiveAt = Date.now();
    return existing;
  }

  const session = {
    sessionId: id,
    userId: String(userId),
    chatbotId: String(chatbotId),
    chatbotName: chatbotName || '',
    activationKey: (activationKey || '').toLowerCase().trim(),
    isActivated: false,
    // Short history kept only for this session (no cross-session bleed)
    history: [],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };

  sessions.set(key, session);
  return session;
}

function getSession(userId, chatbotId, sessionId) {
  if (!sessionId) return null;
  return sessions.get(makeKey(userId, chatbotId, sessionId)) || null;
}

function touchSession(session) {
  if (session) session.lastActiveAt = Date.now();
}

function pushHistory(session, role, text) {
  session.history.push({ role, text, at: Date.now() });
  // Keep last 12 turns so prompts stay small
  if (session.history.length > 12) {
    session.history = session.history.slice(-12);
  }
  touchSession(session);
}

function endSession(userId, chatbotId, sessionId) {
  const key = makeKey(userId, chatbotId, sessionId);
  return sessions.delete(key);
}

/**
 * Remove sessions that have been idle too long.
 * Safe for multi-user load — only deletes expired entries.
 */
function cleanupIdleSessions() {
  const now = Date.now();
  const idleMs = geminiConfig.sessionIdleMs;
  let removed = 0;

  for (const [key, session] of sessions.entries()) {
    if (now - session.lastActiveAt > idleMs) {
      sessions.delete(key);
      removed += 1;
    }
  }

  return removed;
}

// Run cleanup every 5 minutes
setInterval(() => {
  const removed = cleanupIdleSessions();
  if (removed > 0) {
    console.log(`[voice-sessions] cleaned ${removed} idle session(s)`);
  }
}, 5 * 60 * 1000).unref?.();

module.exports = {
  getOrCreateSession,
  getSession,
  touchSession,
  pushHistory,
  endSession,
  cleanupIdleSessions,
};
