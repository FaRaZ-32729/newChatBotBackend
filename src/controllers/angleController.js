/**
 * Speaker angle → MQTT bridge (per chatbotId).
 */
const { sendAngle, getMqttStatus, buildAngleTopic } = require('../mqtt/mqttPublisher');

function postAngle(req, res) {
  const raw = req.body?.angle;
  const chatbotId = req.body?.chatbotId;

  if (raw === undefined || raw === null || Number.isNaN(Number(raw))) {
    return res.status(400).json({
      success: false,
      message: 'angle (number) is required',
    });
  }

  if (!chatbotId || typeof chatbotId !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'chatbotId is required (device must subscribe to that chatbot topic)',
    });
  }

  const angle = parseFloat(Number(raw).toFixed(1));
  console.log(`🔥 Received Angle from Frontend: ${angle}° | chatbotId=${chatbotId}`);

  const result = sendAngle(angle, chatbotId);

  return res.status(200).json({
    success: true,
    message: result.ok
      ? 'Angle published to MQTT'
      : `Angle accepted (${result.reason || 'not published'})`,
    data: {
      angle,
      chatbotId: result.chatbotId || chatbotId,
      topic: result.topic || buildAngleTopic(chatbotId),
      mqtt: getMqttStatus(chatbotId),
      published: Boolean(result.ok),
    },
  });
}

function getAngleHealth(req, res) {
  const chatbotId = req.query?.chatbotId;
  return res.status(200).json({
    success: true,
    data: getMqttStatus(chatbotId),
  });
}

module.exports = {
  postAngle,
  getAngleHealth,
};
