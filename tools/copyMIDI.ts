
import fs from "fs";
import path from "path";
import YAML from "yaml";

import "../env";
import walkDir from "./libs/walkDir";
import { DATA_DIR } from "./libs/constants";
import { WorkBasic } from "./libs/types";
import { ensureDir } from "./libs/utils";



const IMSLP_FILES_DIR = process.env.IMSLP_FILES_DIR;


const main = async () => {
	const works = walkDir(DATA_DIR, /\/$/);
	works.sort((d1, d2) => Number(path.basename(d1)) - Number(path.basename(d2)));

	for (const work of works) {
		const basic = YAML.parse(fs.readFileSync(path.join(work, "basic.yaml")).toString()) as WorkBasic;
		console.log(basic.id, basic.title);

		const files = basic.files.filter(file => file.ext === "mid");
		for (const file of files) {
			const sourcePath = path.join(IMSLP_FILES_DIR, file.path);
			if (!fs.existsSync(sourcePath)) {
				console.log("Source not exist, skipped.", file.id, file.path);
				continue;
			}

			console.log("Copy:", file.id, file.path);
			const fileDir = path.join(work, file.id);
			ensureDir(fileDir);

			fs.copyFileSync(sourcePath, path.join(fileDir, "origin.midi"));
		};
	};
};

main();
