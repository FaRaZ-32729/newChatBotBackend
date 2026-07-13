/**
 * MQTT publisher for speaker / webcam angle tracking.
 * Each chatbot publishes to its own topic so devices can subscribe per bot:
 *   {prefix}/{chatbotId}/speaker/angle
 * Default: iotfiy/chatbot/<chatbotId>/speaker/angle
 */
const mqtt = require('mqtt');

const MQTT_CONFIG = {
  brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
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

/** Sanitize Mongo ObjectId / any id for safe MQTT topic segment. */
function sanitizeChatbotId(chatbotId) {
  const id = String(chatbotId || '').trim();
  if (!/^[a-fA-F0-9]{24}$/.test(id) && !/^[a-zA-Z0-9_-]{3,64}$/.test(id)) {
    return '';
  }
  return id;
}

/**
 * Topic per chatbot.
 * MQTT_TOPIC_PREFIX=iotfiy/chatbot  →  iotfiy/chatbot/<id>/speaker/angle
 * Legacy MQTT_TOPIC=iotfiy/chatbot/speaker/angle is treated as prefix iotfiy/chatbot.
 */
function buildAngleTopic(chatbotId) {
  const id = sanitizeChatbotId(chatbotId);
  let prefix = String(process.env.MQTT_TOPIC_PREFIX || '').trim().replace(/\/+$/, '');

  if (!prefix) {
    const legacy = String(process.env.MQTT_TOPIC || 'iotfiy/chatbot').trim();
    prefix = legacy.replace(/\/speaker\/angle\/?$/i, '').replace(/\/+$/, '') || 'iotfiy/chatbot';
  }

  return `${prefix}/${id}/speaker/angle`;
}

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
    console.log('📡 Angle topics: {prefix}/{chatbotId}/speaker/angle');
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
 * Publish speaker angle for one chatbot.
 * @param {number} angle
 * @param {string} chatbotId - MongoDB _id of the chatbot (device registers this id)
 * @returns {{ ok: boolean, topic?: string, chatbotId?: string, reason?: string }}
 */
function sendAngle(angle, chatbotId) {
  if (!client) connectMQTT();

  const id = sanitizeChatbotId(chatbotId);
  if (!id) {
    console.warn('⚠️ MQTT angle skipped — missing/invalid chatbotId');
    return { ok: false, reason: 'invalid_chatbotId' };
  }

  if (!client || !isConnected) {
    console.warn('⚠️ MQTT not connected, angle skipped:', angle, 'bot:', id);
    return { ok: false, reason: 'mqtt_offline', chatbotId: id };
  }

  const topic = buildAngleTopic(id);
  const numeric = parseFloat(Number(angle).toFixed(1));
  const payload = {
    chatbotId: id,
    angle: numeric,
    timestamp: Date.now(),
    source: 'webcam-speaker-angle',
  };

  client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
    if (!err) {
      console.log(`📤 [Backend] Angle ${numeric}° → ${topic}`);
    } else {
      console.error('❌ Publish failed:', err.message);
    }
  });

  return { ok: true, topic, chatbotId: id };
}

function getMqttStatus(chatbotId) {
  const id = sanitizeChatbotId(chatbotId);
  return {
    connected: isConnected,
    brokerUrl: MQTT_CONFIG.brokerUrl,
    topicExample: id
      ? buildAngleTopic(id)
      : 'iotfiy/chatbot/{chatbotId}/speaker/angle',
    chatbotId: id || null,
  };
}

connectMQTT();

module.exports = {
  sendAngle,
  connectMQTT,
  getMqttStatus,
  buildAngleTopic,
  sanitizeChatbotId,
};
