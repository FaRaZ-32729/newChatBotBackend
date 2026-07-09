/**
 * Socket.IO auth middleware.
 * Uses JWT from cookie or handshake auth token.
 * Guests (public chatbot URL) get a guest id tied to their socket.
 */
const jwt = require('jsonwebtoken');
const UserModel = require('../models/userModel');

async function authenticateSocket(socket, next) {
  try {
    const cookieHeader = socket.handshake.headers.cookie || '';
    const cookies = Object.fromEntries(
      cookieHeader.split(';').map((c) => {
        const [k, ...v] = c.trim().split('=');
        return [k, v.join('=')];
      }).filter(([k]) => k)
    );

    const token =
      socket.handshake.auth?.token ||
      cookies.token ||
      (socket.handshake.headers.authorization || '').replace(/^Bearer\s+/i, '');

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await UserModel.findById(decoded.id).select('-password');

      if (user && user.isActive) {
        socket.data.user = user;
        socket.data.userId = user._id.toString();
        socket.data.isGuest = false;
        return next();
      }
    }

    // Public chatbot page — guest session isolated by socket id
    socket.data.user = null;
    socket.data.userId = `guest_${socket.id}`;
    socket.data.isGuest = true;
    return next();
  } catch (error) {
    socket.data.user = null;
    socket.data.userId = `guest_${socket.id}`;
    socket.data.isGuest = true;
    return next();
  }
}

module.exports = { authenticateSocket };
