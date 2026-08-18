/**
 * Socket.IO handlers for Gemini Live voice.
 */
const { loadChatbotForVoice } = require('../llm/services/voiceTurnService');
const { getChatbotKnowledge } = require('../llm/services/knowledgeService');
const { extractCardFromBase64 } = require('../services/cardScanService');
const {
  startGeminiLiveForSocket,
  sendLiveAudio,
  sendLiveText,
  endLiveAudioStream,
  handleUserSpeechEnd,
  handleWakeAttempt,
  handleClientLatencyMark,
  stopGeminiLiveForSocket,
  scheduleDelayedStopGemini,
  mergeLeadDraft,
  emitLeadForm,
  getSessionEntry,
  setMicEnabled,
  interruptLiveSession,
  endLiveConversation,
} = require('../llm/live/geminiLiveBridge');

function registerLiveSocketHandlers(io) {
  io.on('connection', (socket) => {
    const user = socket.data.user;

    socket.on('live:start', async (payload, ack) => {
      const t0 = Date.now();
      try {
        const { chatbotId } = payload || {};
        if (!chatbotId) {
          return ack?.({ success: false, message: 'chatbotId is required' });
        }

        const { chatbot, error } = await loadChatbotForVoice(chatbotId, user);
        if (error) {
          return ack?.({ success: false, message: error.message });
        }

        console.log(
          `[live] Starting for bot "${chatbot.name}" (${chatbotId}) `
          + `| activationKey="${chatbot.activationKey || ''}"`
        );
        const tLive = Date.now();
        const { model, reused } = await startGeminiLiveForSocket(socket, chatbot, async () => {
          const tKnow = Date.now();
          const knowledgeText = await getChatbotKnowledge(chatbot);
          console.log(`[LATENCY][BE] knowledge ready in ${Date.now() - tKnow}ms`);
          return knowledgeText;
        });
        console.log(
          `[LATENCY][BE] Gemini Live ${reused ? 'reused' : 'connected'} in ${Date.now() - tLive}ms`
          + ` | total start ${Date.now() - t0}ms`
        );

        socket.data.liveChatbotId = String(chatbotId);

        ack?.({
          success: true,
          data: {
            chatbotId: String(chatbot._id),
            chatbotName: chatbot.name,
            activationKey: chatbot.activationKey,
            scanCardRequired: Boolean(chatbot.scanCardRequired),
            model,
            startMs: Date.now() - t0,
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
      const { data, mimeType, clientT } = payload || {};
      if (!data) return;
      sendLiveAudio(socket.id, { data, mimeType, clientT });
    });

    socket.on('live:audio_end', () => {
      handleUserSpeechEnd(socket.id);
    });

    socket.on('live:wake', (payload) => {
      Promise.resolve(handleWakeAttempt(socket.id, payload || {})).catch((err) => {
        console.error('[live] wake handler error:', err.message);
      });
    });

    socket.on('live:latency_mark', (payload) => {
      handleClientLatencyMark(socket.id, payload || {});
    });

    socket.on('live:text', (payload) => {
      const { text } = payload || {};
      if (!text?.trim()) return;

      const entry = getSessionEntry(socket.id);
      const trimmed = text.trim();

      if (entry?.meta) {
        if (/\[CARD_SCANNED\]/i.test(trimmed)) {
          try {
            const m = trimmed.match(/Extracted Data:\s*(\{[\s\S]*?\})\s*(?:\n|$)/i);
            if (m) {
              const lead = JSON.parse(m[1]);
              entry.meta.cameraOpened = true;
              emitLeadForm(entry.meta, lead, { editable: false, lock: true });
            }
          } catch (err) {
            console.warn('[live] CARD_SCANNED parse failed:', err.message);
          }
        } else if (/\[CARD_SCAN_FAILED\]/i.test(trimmed)) {
          entry.meta.cameraOpened = false;
          entry.meta.leadDraftLocked = false;
        } else if (!/\[ACTIVATE_CAMERA\]/i.test(trimmed)) {
          mergeLeadDraft(entry.meta, trimmed);
        }
      }

      sendLiveText(socket.id, trimmed);
    });

    socket.on('live:inactivity_check', () => {
      sendLiveText(socket.id, '[INACTIVITY_CHECK]');
    });

    /** Prefer REST /api/card-scan from frontend; Mindee fallback via socket */
    socket.on('live:card_scan', async (payload, ack) => {
      try {
        const { imageBase64, mimeType } = payload || {};
        if (!imageBase64) {
          return ack?.({ success: false, message: 'imageBase64 is required' });
        }

        console.log('[live] Scanning visiting card via Mindee…');
        const extracted = await extractCardFromBase64(
          imageBase64,
          mimeType || 'image/jpeg'
        );

        if (extracted.noData) {
          return ack?.({
            success: false,
            message: extracted.displayText || 'No data extracted. Try a clearer photo.',
            data: extracted,
          });
        }

        const lead = {
          name: extracted.name || '',
          company: extracted.company || '',
          designation: extracted.designation || '',
          phone: extracted.phone || '',
          email: extracted.email || '',
        };

        const entry = getSessionEntry(socket.id);
        if (entry?.meta) {
          entry.meta.cameraOpened = true;
          emitLeadForm(entry.meta, lead, { editable: false, lock: true });
        }

        const cardMessage = `[CARD_SCANNED]
Extracted Data: ${JSON.stringify(lead)}
Form is on screen. Read Name, Company, Designation, Phone, Email once in the SAME voice. Ask "Kya yeh details sahi hain?" On YES call submitLead with these EXACT fields. On NO ask what to fix — do not open camera again.`;

        sendLiveText(socket.id, cardMessage);

        ack?.({ success: true, data: { ...extracted, ...lead } });
      } catch (err) {
        console.error('[live] card scan error:', err.message);
        ack?.({ success: false, message: err.message || 'Card scan failed' });
      }
    });

    socket.on('live:interrupt', () => {
      interruptLiveSession(socket.id);
    });

    socket.on('live:end_chat', () => {
      endLiveConversation(socket.id);
    });

    socket.on('live:stop', async (payload, ack) => {
      await stopGeminiLiveForSocket(socket.id);
      ack?.({ success: true });
    });

    socket.on('disconnect', () => {
      scheduleDelayedStopGemini(socket.id, 8000);
    });
  });
}

module.exports = { registerLiveSocketHandlers };
