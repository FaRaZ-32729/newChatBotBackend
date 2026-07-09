/**
 * Bootstraps Socket.IO on the same HTTP server as Express.
 */
const { Server } = require('socket.io');
const { authenticateSocket } = require('./socketAuth');
const { registerVoiceSocketHandlers } = require('./voiceSocketHandler');
const { registerLiveSocketHandlers } = require('./liveSocketHandler');

const allowedOrigins = [
  'https://iotfiy-ecosystem.vercel.app',
  'http://localhost:5173',
];

function initSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
    maxHttpBufferSize: 12e6, // 12 MB audio chunks
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  io.use(authenticateSocket);
  registerLiveSocketHandlers(io);
  registerVoiceSocketHandlers(io);

  return io;
}

module.exports = { initSocketServer };
