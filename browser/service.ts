
import fs from "fs";
import path from "path";
import type { Express } from "express"



const DATA_DIR = path.resolve(__dirname, "../data");


export const mountService = (app: Express): void => {
	app.get("/workid-list", (req, res) => {
		const list = fs.readdirSync(DATA_DIR).filter(name => /\d+/.test(name)).sort((n1, n2) => parseInt(n1) - parseInt(n2));

		res.json(list);
	});
};
