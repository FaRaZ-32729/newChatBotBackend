/**
 * Socket.IO handlers for Gemini Live voice.
 */
const { loadChatbotForVoice } = require('../llm/services/voiceTurnService');
const { getChatbotKnowledge } = require('../llm/services/knowledgeService');
const { extractCardFromImage } = require('../llm/services/cardScanService');
const {
  startGeminiLiveForSocket,
  sendLiveAudio,
  sendLiveText,
  endLiveAudioStream,
  handleUserSpeechEnd,
  stopGeminiLiveForSocket,
  mergeLeadDraft,
  getSessionEntry,
  setMicEnabled,
  interruptLiveSession,
} = require('../llm/live/geminiLiveBridge');

function registerLiveSocketHandlers(io) {
  io.on('connection', (socket) => {
    const user = socket.data.user;

    socket.on('live:start', async (payload, ack) => {
      try {
        const { chatbotId } = payload || {};
        if (!chatbotId) {
          return ack?.({ success: false, message: 'chatbotId is required' });
        }

        const { chatbot, error } = await loadChatbotForVoice(chatbotId, user);
        if (error) {
          return ack?.({ success: false, message: error.message });
        }

        console.log(`[live] Starting for bot "${chatbot.name}" (${chatbotId})`);
        const knowledgeText = await getChatbotKnowledge(chatbot);
        const { model } = await startGeminiLiveForSocket(socket, chatbot, knowledgeText);

        socket.data.liveChatbotId = String(chatbotId);

        ack?.({
          success: true,
          data: {
            chatbotId: String(chatbot._id),
            chatbotName: chatbot.name,
            activationKey: chatbot.activationKey,
            scanCardRequired: Boolean(chatbot.scanCardRequired),
            model,
          },
        });
      } catch (err) {
        console.error('[live] start error:', err.message);
        ack?.({ success: false, message: err.message || 'Failed to start live session' });
      }
    });

    socket.on('live:mic_on', () => {
      setMicEnabled(socket.id, true);
      console.log(`[live] Mic enabled (socket ${socket.id})`);
    });

    socket.on('live:mic_off', () => {
      setMicEnabled(socket.id, false);
      endLiveAudioStream(socket.id);
      console.log(`[live] Mic disabled (socket ${socket.id})`);
    });

    socket.on('live:audio', (payload) => {
      const { data, mimeType } = payload || {};
      if (!data) return;
      sendLiveAudio(socket.id, { data, mimeType });
    });

    socket.on('live:audio_end', () => {
      handleUserSpeechEnd(socket.id);
    });

    socket.on('live:text', (payload) => {
      const { text } = payload || {};
      if (!text?.trim()) return;

      const entry = getSessionEntry(socket.id);
      if (entry?.meta) {
        mergeLeadDraft(entry.meta, text);
      }

      sendLiveText(socket.id, text.trim());
    });

    socket.on('live:inactivity_check', () => {
      sendLiveText(socket.id, '[INACTIVITY_CHECK]');
    });

    socket.on('live:card_scan', async (payload, ack) => {
      try {
        const { imageBase64, mimeType } = payload || {};
        if (!imageBase64) {
          return ack?.({ success: false, message: 'imageBase64 is required' });
        }

        console.log('[live] Scanning visiting card…');
        const extracted = await extractCardFromImage(imageBase64, mimeType || 'image/jpeg');

        const cardMessage = `[CARD_SCANNED]
Raw Text: ${extracted.rawText}
Extracted Data: ${JSON.stringify({
          name: extracted.name,
          company: extracted.company,
          designation: extracted.designation,
          phone: extracted.phone,
          email: extracted.email,
        })}`;

        sendLiveText(socket.id, cardMessage);

        ack?.({ success: true, data: extracted });
      } catch (err) {
        console.error('[live] card scan error:', err.message);
        ack?.({ success: false, message: err.message || 'Card scan failed' });
      }
    });

    socket.on('live:interrupt', () => {
      interruptLiveSession(socket.id);
    });

    socket.on('live:stop', async (payload, ack) => {
      await stopGeminiLiveForSocket(socket.id);
      ack?.({ success: true });
    });

    socket.on('disconnect', async () => {
      await stopGeminiLiveForSocket(socket.id);
    });
  });
}

module.exports = { registerLiveSocketHandlers };
