
import fs from "fs";
import path from "path";
import type { Express } from "express";
import YAML from "yaml";



const DATA_DIR = path.resolve(__dirname, "../data");


export const mountService = (app: Express): void => {
	app.get("/workid-list", (req, res) => {
		const list = fs.readdirSync(DATA_DIR).filter(name => /\d+/.test(name)).sort((n1, n2) => parseInt(n1) - parseInt(n2));

		res.json(list);
	});


	app.get("/work-basic", (req, res) => {
		const workId = req.query.id as string;
		if (!workId) {
			res.json(null);
			return;
		}

		const basicPath = path.join(DATA_DIR, workId, "basic.yaml");
		if (!fs.existsSync(basicPath)) {
			res.json(null);
			return;
		}

		const basicText = fs.readFileSync(basicPath).toString();
		const basic = YAML.parse(basicText);

		res.json(basic);
	});
};
