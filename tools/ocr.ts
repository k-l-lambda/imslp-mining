
import fs from "fs";
import path from "path";
import YAML from "yaml";

import "../env";

import { WorkBasic } from "./libs/types";
import { IMAGE_BED, DATA_DIR, IMSLP_FILES_DIR, TORCH_DEVICE, PROCESS_PREDICTOR_DIR, PROCESS_PREDICTOR_CMD } from "./libs/constants";
import walkDir from "./libs/walkDir";
//import { ensureDir } from "./libs/utils";



const main = async () => {
	const works = walkDir(DATA_DIR, /\/$/);
	works.sort((d1, d2) => Number(path.basename(d1)) - Number(path.basename(d2)));

	for (const work of works) {
		const workId = path.basename(work);

		const basic = YAML.parse(fs.readFileSync(path.join(work, "basic.yaml")).toString()) as WorkBasic;
		console.log(basic.id, basic.title);

		const files = basic.files.filter(file => file.ext === "pdf");
		for (const file of files) {
			const layoutPath = path.join(work, file.id, "layout.json");
			if (!fs.existsSync(layoutPath))
				continue;

			const layout = JSON.parse(fs.readFileSync(layoutPath).toString());
			if (!layout || !layout.length)
				continue;

			console.log(String.fromCodePoint(0x1f3bc), `[${workId}/${file.id}]`, file.path);

			const omrStatePath = path.join(work, file.id, "omr.yaml");
			const omrState = fs.existsSync(omrStatePath) ? YAML.parse(fs.readFileSync(omrStatePath).toString()) : {};
			if (omrState && omrState.ocr) {
				console.log("OCR already done, skip");
				continue;
			}

		}
	}
};


main();
