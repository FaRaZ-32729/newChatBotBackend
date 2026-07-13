/**
 * Shared CORS allow-list for Express + Socket.IO.
 * Set FRONTEND_URL and optional ALLOWED_ORIGINS (comma-separated) on the VPS.
 */
function getAllowedOrigins() {
  const fromEnv = String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const defaults = [
    process.env.FRONTEND_URL,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'https://iotfiy-virtual-asistant.vercel.app',
    'https://iotfiy-ecosystem.vercel.app',
  ].filter(Boolean);

  return [...new Set([...defaults, ...fromEnv])];
}

function corsOriginDelegate(origin, callback) {
  if (!origin) return callback(null, true);
  const allowed = getAllowedOrigins();
  if (allowed.includes(origin)) return callback(null, true);
  console.warn(`[cors] Blocked origin: ${origin}`);
  return callback(new Error(`Not allowed by CORS: ${origin}`));
}

module.exports = {
  getAllowedOrigins,
  corsOriginDelegate,
};
