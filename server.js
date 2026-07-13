const http = require('http');
const express = require('express');
const dotenv = require('dotenv');
const dbConnection = require('./src/config/dbConnection');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const { initSocketServer } = require('./src/socket');
const { corsOriginDelegate, getAllowedOrigins } = require('./src/utils/corsOrigins');

const centeralRoutes = require('./src/routes/centeralRoutes');

dotenv.config({ path: path.join(__dirname, '.env') });
dbConnection();

const port = process.env.PORT || 5056;
const app = express();

// Required behind Hostinger / Nginx so Secure cookies work over HTTPS
app.set('trust proxy', 1);

app.use(cors({
  origin: corsOriginDelegate,
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
  console.log(`[cors] Allowed origins: ${getAllowedOrigins().join(', ')}`);
});
