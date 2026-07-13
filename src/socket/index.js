/**
 * Bootstraps Socket.IO on the same HTTP server as Express.
 */
const { Server } = require('socket.io');
const { authenticateSocket } = require('./socketAuth');
const { registerVoiceSocketHandlers } = require('./voiceSocketHandler');
const { registerLiveSocketHandlers } = require('./liveSocketHandler');
const { getAllowedOrigins } = require('../utils/corsOrigins');

function initSocketServer(httpServer) {
  const allowedOrigins = getAllowedOrigins();
  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
    maxHttpBufferSize: 12e6, // 12 MB audio chunks
    // Stronger keepalive for long voice sessions
    pingTimeout: 120000,
    pingInterval: 20000,
    connectTimeout: 30000,
    // Lower CPU / latency for frequent small PCM frames
    perMessageDeflate: false,
    httpCompression: false,
    transports: ['websocket', 'polling'],
    allowUpgrades: true,
  });

  io.use(authenticateSocket);
  registerLiveSocketHandlers(io);
  registerVoiceSocketHandlers(io);

  io.engine.on('connection_error', (err) => {
    console.warn('[socket] engine connection_error:', err.message);
  });

  return io;
}

module.exports = { initSocketServer };
