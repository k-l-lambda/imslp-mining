
import express from "express";
import http from "http";
import ip from "ip";

import "../env"


const app = express();


const httpServer = http.createServer(app);
const port = Number(process.env.BROWSER_PORT);
const ipAddress = ip.address();


httpServer.listen(port, process.env.BROWSER_HOST, () => {
	console.log("imslp-browser server online:", `http://${ipAddress}:${port}`);
});
