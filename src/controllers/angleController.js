/**
 * Speaker angle → MQTT bridge.
 */
const { sendAngle, getMqttStatus } = require('../mqtt/mqttPublisher');

function postAngle(req, res) {
  const raw = req.body?.angle;

  if (raw === undefined || raw === null || Number.isNaN(Number(raw))) {
    return res.status(400).json({
      success: false,
      message: 'angle (number) is required',
    });
  }

  const angle = parseFloat(Number(raw).toFixed(1));
  console.log(`🔥 Received Angle from Frontend: ${angle}°`);

  const published = sendAngle(angle);

  return res.status(200).json({
    success: true,
    message: published ? 'Angle published to MQTT' : 'Angle accepted (MQTT offline — skipped publish)',
    data: {
      angle,
      mqtt: getMqttStatus(),
      published,
    },
  });
}

function getAngleHealth(_req, res) {
  return res.status(200).json({
    success: true,
    data: getMqttStatus(),
  });
}

module.exports = {
  postAngle,
  getAngleHealth,
};
