/**
 * MQTT publisher for speaker / webcam angle tracking.
 * Topic is project-specific (not the old home/speaker/angle).
 */
const mqtt = require('mqtt');

const MQTT_CONFIG = {
  brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
  topic: process.env.MQTT_TOPIC || 'iotfiy/chatbot/speaker/angle',
  options: {
    clientId: `iotfiy-chatbot-angle-${Math.random().toString(16).slice(2, 10)}`,
    reconnectPeriod: 5000,
    keepalive: 60,
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
  },
};

let client = null;
let isConnected = false;

function connectMQTT() {
  if (client) return;

  console.log('🔄 Connecting to MQTT Broker:', MQTT_CONFIG.brokerUrl);
  console.log(
    '🔑 Using Username:',
    MQTT_CONFIG.options.username ? 'Yes' : 'No (Anonymous)'
  );

  client = mqtt.connect(MQTT_CONFIG.brokerUrl, MQTT_CONFIG.options);

  client.on('connect', () => {
    isConnected = true;
    console.log('✅ Backend MQTT Connected Successfully!');
    console.log(`📡 Topic: ${MQTT_CONFIG.topic}`);
  });

  client.on('error', (err) => {
    console.error('❌ MQTT Error:', err.message);
    isConnected = false;
  });

  client.on('reconnect', () => {
    console.log('🔄 MQTT Reconnecting...');
  });

  client.on('offline', () => {
    isConnected = false;
    console.warn('⚠️ MQTT Client Offline');
  });

  client.on('close', () => {
    isConnected = false;
  });
}

/**
 * Publish speaker angle to MQTT.
 * @param {number} angle
 * @returns {boolean}
 */
function sendAngle(angle) {
  if (!client) connectMQTT();

  if (!client || !isConnected) {
    console.warn('⚠️ MQTT not connected, angle skipped:', angle);
    return false;
  }

  const numeric = parseFloat(Number(angle).toFixed(1));
  const payload = {
    angle: numeric,
    timestamp: Date.now(),
    source: 'webcam-speaker-angle',
  };

  client.publish(MQTT_CONFIG.topic, JSON.stringify(payload), { qos: 1 }, (err) => {
    if (!err) {
      console.log(`📤 [Backend] Angle Sent: ${numeric}° → ${MQTT_CONFIG.topic}`);
    } else {
      console.error('❌ Publish failed:', err.message);
    }
  });

  return true;
}

function getMqttStatus() {
  return {
    connected: isConnected,
    brokerUrl: MQTT_CONFIG.brokerUrl,
    topic: MQTT_CONFIG.topic,
  };
}

// Connect on module load
connectMQTT();

module.exports = {
  sendAngle,
  connectMQTT,
  getMqttStatus,
};
