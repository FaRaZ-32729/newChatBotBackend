const mongoose = require("mongoose")
const dotenv = require("dotenv");

dotenv.config();

const dbConnection = async () => {

    // const dns = require('node:dns');
    // dns.setServers(['8.8.8.8', '8.8.4.4']); 

    try {
        await mongoose.connect(process.env.MONGODB_URL);
        console.log("DB Connected Successfully");
    } catch (error) {
        console.log("error while connection with mongoDB", error.message);
    }
}

module.exports = dbConnection;  