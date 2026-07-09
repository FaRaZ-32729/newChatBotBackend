/**
 * Socket.IO voice events — real-time chatbot conversation.
 *
 * Events:
 * - voice:session:start  → create isolated session for this user + chatbot
 * - voice:turn           → send audio, get reply + spoken audio back
 * - voice:session:end    → clean up session on page close
 *
 * Status events (server → client) for instant UI feedback:
 * - voice:status         → { stage: 'transcribing' | 'thinking' | 'speaking' }
 */
const {
  startVoiceSessionForUser,
  processVoiceTurnForUserSafe,
  endVoiceSessionForUser,
} = require('../llm/services/voiceTurnService');

function registerVoiceSocketHandlers(io) {
  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    const user = socket.data.user;

    console.log(`[socket] connected ${socket.id} as ${userId}`);

    // Start voice session when user opens chatbot page
    socket.on('voice:session:start', async (payload, ack) => {
      try {
        const { chatbotId, sessionId } = payload || {};
        if (!chatbotId) {
          return ack?.({ success: false, message: 'chatbotId is required' });
        }

        const result = await startVoiceSessionForUser({
          userId,
          chatbotId,
          sessionId,
          user,
        });

        if (result.error) {
          return ack?.({ success: false, message: result.error.message });
        }

        const { session, chatbot, knowledgeReady } = result;

        socket.join(`chatbot:${chatbotId}`);
        socket.data.activeChatbotId = String(chatbotId);
        socket.data.activeSessionId = session.sessionId;

        ack?.({
          success: true,
          data: {
            sessionId: session.sessionId,
            chatbotId: String(chatbot._id),
            chatbotName: chatbot.name,
            activationKey: chatbot.activationKey,
            isActivated: session.isActivated,
            knowledgeReady,
          },
        });

        console.log(`[socket] voice session started — bot: "${chatbot.name}", session: ${session.sessionId}`);
      } catch (error) {
        console.error('[socket] voice:session:start', error);
        ack?.({ success: false, message: error.message || 'Failed to start session' });
      }
    });

    // One voice turn — audio in, reply + TTS out (low latency over persistent socket)
    socket.on('voice:turn', async (payload, ack) => {
      try {
        const { chatbotId, sessionId, audioBase64, mimeType } = payload || {};

        if (!chatbotId || !sessionId || !audioBase64) {
          return ack?.({ success: false, message: 'chatbotId, sessionId and audioBase64 are required' });
        }

        console.log(`[socket] voice:turn received — bot: ${chatbotId}, audio: ${Math.round(audioBase64.length / 1024)}KB`);

        socket.emit('voice:status', { stage: 'transcribing' });

        const result = await processVoiceTurnForUserSafe({
          userId,
          chatbotId,
          sessionId,
          base64Audio: audioBase64,
          mimeType: mimeType || 'audio/webm',
          user,
        });

        if (result.error) {
          return ack?.({ success: false, message: result.error.message });
        }

        socket.emit('voice:status', { stage: 'speaking' });

        ack?.({ success: true, data: result.data });
      } catch (error) {
        console.error('[socket] voice:turn', error.message);
        ack?.({ success: false, message: error.message || 'Voice turn failed' });
      }
    });

    // End session when user leaves chatbot page
    socket.on('voice:session:end', (payload, ack) => {
      try {
        const { chatbotId, sessionId } = payload || {};
        if (chatbotId && sessionId) {
          endVoiceSessionForUser({ userId, chatbotId, sessionId });
        }
        ack?.({ success: true });
      } catch (error) {
        ack?.({ success: false, message: error.message });
      }
    });

    socket.on('disconnect', () => {
      const chatbotId = socket.data.activeChatbotId;
      const sessionId = socket.data.activeSessionId;
      if (chatbotId && sessionId) {
        endVoiceSessionForUser({ userId, chatbotId, sessionId });
      }
      console.log(`[socket] disconnected ${socket.id}`);
    });
  });
}

module.exports = { registerVoiceSocketHandlers };
