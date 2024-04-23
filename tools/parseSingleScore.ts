
import fs from "fs";
import path from "path";
import YAML from "yaml";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import "../env";

import { PageLayoutResult, LayoutArea } from "./libs/types";
import { IMAGE_BED, SCORE_FILTER_CONDITION, TORCH_DEVICE, PROCESS_PREDICTOR_DIR, PROCESS_PREDICTOR_CMD } from "./libs/constants";
import ProcessPredictor from "./libs/processPredictor";
//import walkDir from "./libs/walkDir";
import { ensureDir } from "./libs/utils";
import { starry } from "./libs/omr";
import { constructSystem } from "./libs/scoreSystem";



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


type ScoreMeta = { title: string } & Record<string, string>;


const readPages = async (sourcePath: string, targetDir: string, predictor: ProcessPredictor): Promise<void> => {
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
};


const initScore = (targetDir: string, meta: ScoreMeta): void => {
	const layoutPath = path.join(targetDir, "layout.json");
	if (!fs.existsSync(layoutPath))
		return;

	const layout = JSON.parse(fs.readFileSync(layoutPath).toString()) as PageLayoutResult[];
	if (!layout?.length)
		return;

	const layoutPages = layout.filter(page => page.detection?.areas?.length);
	if (!layoutPages.length)
		return;

	const staffNumbers = layout.filter(page => page.detection?.areas?.length)
		.map(page => page.detection?.areas).flat(1)
		.filter(area => area.staves?.middleRhos?.length)
		.map(area => area.staves.middleRhos.length)
		.sort((a, b) => a - b);

	const n_staff = Math.max(0, ...staffNumbers);
	const n_staff_90percent = staffNumbers[Math.floor(staffNumbers.length * 0.9)];

	switch (SCORE_FILTER_CONDITION) {
		case "single_piano":
			if (n_staff_90percent > 3)
				return;

			break;
		case "1or2pianos":
			if (n_staff_90percent > 4)
				return;

			break;
	}

	const omrStatePath = path.join(targetDir, "omr.yaml");
	const scorePath = path.join(targetDir, "score.json");

	const omrState = fs.existsSync(omrStatePath) ? YAML.parse(fs.readFileSync(omrStatePath).toString()) : {};
	if (omrState?.score?.init && fs.existsSync(scorePath)) {
		console.log("Score initilization already done, skip");
		return;
	}

	const meanWidth = layoutPages.reduce((sum, page) => sum + page.sourceSize.width, 0) / layoutPages.length;

	const pageRatios = layoutPages.map(page => {
		const staffInterval = Math.min(...page.detection.areas.filter(area => area.staves?.middleRhos?.length).map(area => area.staves.interval));
		return {
			width: page.sourceSize.width / staffInterval,
			aspect: page.sourceSize.height / page.sourceSize.width,
		};
	});

	const maxLogicWidth = pageRatios.sort((a, b) => b.width - a.width)[0].width;
	const maxAspect = Math.max(...pageRatios.map((r) => r.aspect));

	const unitSize = meanWidth / maxLogicWidth;

	// in points
	const pageSize = {
		width: meanWidth,
		height: meanWidth * maxAspect,
	};

	const pages = layoutPages.map(layout => {
		const page = new starry.Page({
			source: {
				url: layout.page_info.url,
				dimensions: { width: layout.page_info.size[0], height: layout.page_info.size[1] },
				matrix: [Math.cos(layout.theta), -Math.sin(layout.theta), Math.sin(layout.theta), Math.cos(layout.theta), 0, 0],
				interval: layout.interval,
				needGauge: true,
			},
			layout: layout.detection,
			width: pageSize.width / unitSize,
			height: pageSize.height / unitSize,
		});

		(page.layout.areas.filter(area => area.staves?.middleRhos?.length) as LayoutArea[]).forEach(area => {
			const sourceCenter = {
				x: layout.sourceSize.width / 2 / layout.interval,
				y: layout.sourceSize.height / 2 / layout.interval,
			};

			const position = {
				x: (area.x + area.staves.phi1) / layout.interval - sourceCenter.x + page.width / 2,
				y: area.y / layout.interval - sourceCenter.y + page.height / 2,
			};

			page.systems.push(constructSystem({
				page,
				area,
				position,
			}));
		});

		if (layout.text)
			page.assignTexts(layout.text, [layout.page_info.size[1], layout.page_info.size[0]]);

		return page;
	});

	const { title, ...headers } = meta;

	const score = new starry.Score({
		title,
		unitSize,
		pageSize,
		headers,
		instrumentDict: {},
		settings: {
			enabledGauge: true,
			semanticConfidenceThreshold: 1,
		},
		pages,
	});

	fs.writeFileSync(scorePath, JSON.stringify(score));

	omrState.score = { init: Date.now() };
	fs.writeFileSync(omrStatePath, YAML.stringify(omrState));

	console.log("Initial score saved:", scorePath);
};


const main = async () => {
	const predictor = new ProcessPredictor({
		command: PROCESS_PREDICTOR_CMD,
		cwd: PROCESS_PREDICTOR_DIR,
		args: ["./streamPredictor.py", SCORE_LAYOUT_WEIGHT, "-m", "scorePage", "-dv", TORCH_DEVICE, "-i"],
	});

	const targetDir = argv.target || path.dirname(argv.source);
	ensureDir(targetDir);

	const sourcePath = argv.source;
	await readPages(sourcePath, targetDir, predictor);

	const title = path.basename(sourcePath, path.extname(sourcePath));
	initScore(targetDir, { title });

	predictor.dispose();

	console.log("Done");
};


main();
