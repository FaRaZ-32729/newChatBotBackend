const http = require('http');
const express = require('express');
const dotenv = require('dotenv');
const dbConnection = require('./src/config/dbConnection');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const { initSocketServer } = require('./src/socket');

const centeralRoutes = require('./src/routes/centeralRoutes');

dotenv.config();
dbConnection();

const port = process.env.PORT || 5056;
const app = express();

const allowedOrigins = [
  'https://iotfiy-ecosystem.vercel.app',
  'http://localhost:5173',
];

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.json());
app.use(cookieParser());
app.use('/api', centeralRoutes);

// HTTP + Socket.IO on same port for real-time voice
const httpServer = http.createServer(app);
initSocketServer(httpServer);

httpServer.listen(port, () => {
  console.log(`Express + Socket.IO running on port ${port}`);
});
