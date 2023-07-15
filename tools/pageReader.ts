
import fs from "fs";
import path from "path";
import YAML from "yaml";

import "../env";

import { WorkBasic } from "./libs/types";
import { IMAGE_BED, DATA_DIR, IMSLP_FILES_DIR, TORCH_DEVICE, PROCESS_PREDICTOR_DIR, PROCESS_PREDICTOR_CMD } from "./libs/constants";
import ProcessPredictor from "./libs/processPredictor";
import walkDir from "./libs/walkDir";
import { ensureDir } from "./libs/utils";



const SCORE_LAYOUT_WEIGHT = process.env.SCORE_LAYOUT_WEIGHT;


const main = async () => {
	const predictor = new ProcessPredictor({
		command: PROCESS_PREDICTOR_CMD,
		cwd: PROCESS_PREDICTOR_DIR,
		args: ["./streamPredictor.py", SCORE_LAYOUT_WEIGHT, "-m", "scorePage", "-dv", TORCH_DEVICE, "-i"],
	});

	const works = walkDir(DATA_DIR, /\/$/);
	works.sort((d1, d2) => Number(path.basename(d1)) - Number(path.basename(d2)));

	await predictor.waitInitialization();

	for (const work of works) {
		const basic = YAML.parse(fs.readFileSync(path.join(work, "basic.yaml")).toString()) as WorkBasic;
		console.log(basic.id, basic.title);

		const files = basic.files.filter(file => file.ext === "pdf");
		for (const file of files) {
			console.log(String.fromCodePoint(0x1f3bc), `[${file.id}]`, file.path);
			if (file.path.includes("manuscript")) {
				console.log("Skip manuscript.", );
				continue;
			}

			const sourcePath = path.resolve(IMSLP_FILES_DIR, file.path);
			if (!fs.existsSync(sourcePath)) {
				console.log("Source not exist, skipped.");
				continue;
			}

			//console.log("audio:", basic.id, file.path);
			const fileDir = path.join(work, file.id);
			ensureDir(fileDir);

			const layoutPath = path.join(fileDir, "layout.json");
			if (fs.existsSync(layoutPath)) {
				console.log("Pages done, skip.");
				continue;
			}

			console.log("Processing PDF pages...");
			const result = await predictor.predict([], { pdf: sourcePath, output_folder: IMAGE_BED });
			const resultObj = JSON.parse(result);
			if (!resultObj?.semantics || !resultObj?.semantics.filter(Boolean).length) {
				console.log("Layout detection failed.");
				continue;
			}
			const pages = resultObj.semantics.filter(Boolean);

			// save layout heatmap
			const layoutsDir = path.join(fileDir, "layouts");
			ensureDir(layoutsDir);
			pages.forEach((page, i) => {
				const [header, ext] = page.image.match(/^data:image\/(\w+);base64,/);
				const imageBuffer = Buffer.from(page.image.substring(header.length), "base64");

				const filename = `${i}.${ext}`;
				fs.writeFileSync(path.join(layoutsDir, filename), imageBuffer);

				page.image = `layouts/${filename}`;
			});

			fs.writeFileSync(layoutPath, JSON.stringify(pages));
			console.log("Layout saved,", pages.length, "pages.");
		}
	}

	predictor.dispose();
};


main();
