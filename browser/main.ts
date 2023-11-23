
import express from "express";
import http from "http";
import ip from "ip";
import path from "path";
import fs from "fs";

import "../env"


const app = express();


// CORS header
app.use("*", (req, res, next) => {
	if (req.headers.origin) {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "*");
		res.setHeader("Access-Control-Allow-Headers", "*");
	}

	next();
});


console.log("root", fs.realpathSync(__dirname));
const staticDir = dir => express.static(path.resolve(fs.realpathSync(__dirname), dir));

app.use("/", staticDir("./public"));


const httpServer = http.createServer(app);
const port = Number(process.env.BROWSER_PORT);
const ipAddress = ip.address();


httpServer.listen(port, process.env.BROWSER_HOST, () => {
	console.log("imslp-browser server online:", `http://${ipAddress}:${port}`);
});
