const express = require("express");
const dotenv = require("dotenv");
const dbConnection = require("./src/config/dbConnection");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const path = require("path");

// Routers
const centeralRoutes = require("./src/routes/centeralRoutes");

// Utilities
dotenv.config();
dbConnection();


const port = process.env.PORT || 5056;
const app = express();

// Middlewares
const allowedOrigins = [
    "https://iotfiy-ecosystem.vercel.app",
    "http://localhost:5173"
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true); // allow mobile/postman
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    credentials: true
}));

// Make uploads folder public
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));



app.use(express.json());
app.use(cookieParser());



// Routes
app.use("/api", centeralRoutes);


// Start server
app.listen(port, () => {
    console.log(`Express & WebSocket is running on port : ${port}`);
});