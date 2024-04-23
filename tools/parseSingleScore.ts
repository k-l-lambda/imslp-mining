
import fs from "fs";
import path from "path";
import YAML from "yaml";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import "../env";

import { WorkBasic } from "./libs/types";
import { IMAGE_BED, DATA_DIR, IMSLP_FILES_DIR, TORCH_DEVICE, PROCESS_PREDICTOR_DIR, PROCESS_PREDICTOR_CMD } from "./libs/constants";
import ProcessPredictor from "./libs/processPredictor";
import walkDir from "./libs/walkDir";
import { ensureDir } from "./libs/utils";



const SCORE_LAYOUT_WEIGHT = process.env.SCORE_LAYOUT_WEIGHT;


const argv = yargs(hideBin(process.argv))
	.command(
		"$0 source [target]",
		"Parse a single score from pdf or images.",
		yargs => yargs
			.positional("source", {
				type: "string",
			})
			.demandOption("source")
			.positional("target", {
				type: "string",
			})
		,
	).help().argv;


const main = async () => {
	const predictor = new ProcessPredictor({
		command: PROCESS_PREDICTOR_CMD,
		cwd: PROCESS_PREDICTOR_DIR,
		args: ["./streamPredictor.py", SCORE_LAYOUT_WEIGHT, "-m", "scorePage", "-dv", TORCH_DEVICE, "-i"],
	});

	const targetDir = argv.target || path.dirname(argv.source);
	ensureDir(targetDir);

	const sourcePath = argv.source;
	if (path.extname(sourcePath).toLowerCase() !== ".pdf") {
		// TODO:
		console.warn("not PDF:", path.extname(sourcePath));
		return;
	}
	if (!fs.existsSync(sourcePath)) {
		console.warn("Source not exist.");
		return;
	}

	const layoutPath = path.join(targetDir, "layout.json");
	if (fs.existsSync(layoutPath)) {
		console.log("Pages done, skip.");
		return;
	}

	await predictor.waitInitialization();

	console.log("Processing PDF pages...");
	const result = await predictor.predict([], { pdf: sourcePath, output_folder: IMAGE_BED });
	const resultObj = JSON.parse(result);
	if (!resultObj?.semantics || !resultObj?.semantics.filter(Boolean).length) {
		console.log("Layout detection failed.");
		return;
	}
	const pages = resultObj.semantics.filter(Boolean);

	// save layout heatmap
	const layoutsDir = path.join(targetDir, "layouts");
	ensureDir(layoutsDir);
	pages.forEach((page, i) => {
		const [header, ext] = page.image.match(/^data:image\/(\w+);base64,/);
		const imageBuffer = Buffer.from(page.image.substring(header.length), "base64");

		const filename = `${i}.${ext}`;
		fs.writeFileSync(path.join(layoutsDir, filename), imageBuffer);

		page.image = `layouts/${filename}`;
	});

	fs.writeFileSync(layoutPath, JSON.stringify(pages));

	predictor.dispose();

	console.log("Done");
};


main();
