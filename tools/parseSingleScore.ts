
import fs from "fs";
import path from "path";
import YAML from "yaml";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import * as skc from "skia-canvas";
import sharp from "sharp";
import { MIDI } from "@k-l-lambda/music-widgets";

import "../env";

import { PageLayoutResult, LayoutArea } from "./libs/types";
import {
	IMAGE_BED, TORCH_DEVICE, PROCESS_PREDICTOR_DIR, PROCESS_PREDICTOR_CMD, VIEWPORT_UNIT,
	STAFF_PADDING_LEFT, GAUGE_VISION_SPEC, SEMANTIC_VISION_SPEC, BEAD_PICKER_URL,
} from "./libs/constants";
import ProcessPredictor from "./libs/processPredictor";
//import walkDir from "./libs/walkDir";
import { ensureDir, loadImage, saveImage } from "./libs/utils";
import { starry, beadSolver, measureLayout } from "./libs/omr";
import { constructSystem } from "./libs/scoreSystem";
import pyClients from "./libs/pyClients";
import { shootPageCanvas, shootStaffCanvas } from "./libs/canvasUtilities";
import OnnxBeadPicker from "./libs/onnxBeadPicker";



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


const ocr = async (targetDir: string): Promise<void> => {
	const layoutPath = path.join(targetDir, "layout.json");
	if (!fs.existsSync(layoutPath))
		return;

	const layout = JSON.parse(fs.readFileSync(layoutPath).toString()) as PageLayoutResult[];
	if (!layout || !layout.length)
		return;

	console.log("OCR...");

	const omrStatePath = path.join(targetDir, "omr.yaml");
	const omrState = fs.existsSync(omrStatePath) ? YAML.parse(fs.readFileSync(omrStatePath).toString()) : {};
	if (omrState?.ocr?.done) {
		console.log("OCR already done, skip");
		return;
	}

	let i = 0;
	for (const page of layout) {
		console.log(`Page ${i++}/${layout.length}`);

		const image = await loadImage(page.page_info.url);
		const resultLoc = await pyClients.predictScoreImages("textLoc", [image]);
		const location = resultLoc[0].filter((box) => box.score > 0);
		//console.log("location:", location);

		if (location.length > 0) {
			page.text = [];
			for (let ii = 0; ii < location.length; ii += 100) {
				const [resultOCR] = await pyClients.predictScoreImages("textOcr", {
					buffers: [image],
					location: location.slice(ii, ii + 100),
				});
				//console.log("resultOCR:", resultOCR?.areas?.filter(x => x.text));
				page.text.push(...resultOCR?.areas);
			}
		}
	}

	fs.writeFileSync(layoutPath, JSON.stringify(layout));

	const n_text = layout.reduce((n, page) => n + (page?.text?.length ?? 0), 0);
	console.log(`${n_text} texts of ${layout.length} pages.`);

	omrState.ocr = omrState.ocr || { done: true, logs: [] };
	omrState.ocr.done = true;
	omrState.ocr.logs.push(`[${new Date().toLocaleString()}] ${n_text} texts of ${layout.length} pages.`);
	fs.writeFileSync(omrStatePath, YAML.stringify(omrState));
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


const scoreVision = async (targetDir: string): Promise<void> => {
	const omrStatePath = path.join(targetDir, "omr.yaml");
	const scorePath = path.join(targetDir, "score.json");
	if (!fs.existsSync(scorePath))
		return;

	const omrState = fs.existsSync(omrStatePath) ? YAML.parse(fs.readFileSync(omrStatePath).toString()) : {};
	if (omrState?.score?.semantic) {
		console.log("Score vision already done, skip.");
		return;
	}

	const scoreJSON = fs.readFileSync(scorePath).toString();
	const score = starry.recoverJSON<starry.Score>(scoreJSON, starry);

	const saveScore = async () => {
		await score.replaceImageKeys(key => Promise.resolve(Buffer.isBuffer(key) || ArrayBuffer.isView(key) ? undefined : key));
		fs.writeFileSync(scorePath, JSON.stringify(score));
	};

	console.log("Runing scoreVision...");

	try {
		if (!omrState.score?.brackets) {
			// brackets prediction
			const pageCanvases = await Promise.all(score.pages.map(async page => {
				const buffer = await loadImage(page.source.url);
				const pngBuffer = await sharp(buffer).toFormat("png").toBuffer();
				const image = await skc.loadImage(pngBuffer);
				const pageCanvas = await shootPageCanvas({ page, source: image });	// also prepare system background images

				return { page, pageCanvas };
			}));

			for (const { page, pageCanvas } of pageCanvases) {
				const areas = page.layout.areas.filter(area => area.staves?.middleRhos?.length);
				const interval = page.source.interval;

				const bracketImages = page.systems.map((system, systemIndex) => {
					const {
						x,
						y,
						staves: { middleRhos, phi1 },
					} = areas[systemIndex];

					const topMid = middleRhos[0];
					const bottomMid = middleRhos[middleRhos.length - 1];

					const sourceRect = {
						x: x + phi1 - 4 * interval,
						y: y + topMid - 4 * interval,
						width: 8 * interval,
						height: bottomMid - topMid + 8 * interval,
					};

					const canvas = new skc.Canvas(VIEWPORT_UNIT * 8, (sourceRect.height / interval) * VIEWPORT_UNIT);

					const context = canvas.getContext("2d");
					context.drawImage(pageCanvas, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height, 0, 0, canvas.width, canvas.height);

					return {
						system,
						buffer: canvas.toBufferSync("png"),
					};
				});

				const bracketsRes = await pyClients.predictScoreImages("brackets", { buffers: bracketImages.map(x => x.buffer) });

				bracketImages.forEach(({ system }, index) => {
					if (bracketsRes[index]) {
						system.bracketsAppearance = bracketsRes[index];
						//console.log("res:", system.bracketsAppearance);
					}
				});
			}

			score.inferenceStaffLayout();
			console.log("Score staffLayout:", score.staffLayoutCode);

			omrState.score.staffLayoutCode = score.staffLayoutCode;
			omrState.score.brackets = Date.now();
			fs.writeFileSync(omrStatePath, YAML.stringify(omrState));
		}

		// straightification & semantic prediction
		let pageIndex = 0;
		for (const page of score.pages) {
			console.log(`Page ${pageIndex++}/${score.pages.length}...`);

			const staves = await Promise.all(page.systems.map(system => system.staves.map(async (staff, staffIndex) => {
				let image: Buffer;
				let strightBuffer: Buffer;
				if (score.settings.enabledGauge) {
					const sourceCanvas = await shootStaffCanvas(system, staffIndex, {
						paddingLeft: STAFF_PADDING_LEFT,
						spec: GAUGE_VISION_SPEC,
					});
					image = sourceCanvas.toBufferSync("png");
				}
				else
					strightBuffer = await loadImage(staff.backgroundImage as string);

				return {
					gauge: undefined as Buffer,
					image,
					strightBuffer,
					system,
					staff, staffIndex,
				};
			})).flat(1));

			if (score.settings.enabledGauge) {
				const gaugeRes = await pyClients.predictScoreImages("gauge", staves.map(staff => staff.image));
				console.assert(gaugeRes.length === staves.length, "invalid gauge response:", gaugeRes);
				if (gaugeRes?.length !== staves.length)
					throw new Error("invalid gauge response");

				staves.forEach((staff, i) => staff.gauge = gaugeRes[i].image);

				for (const staffItem of staves) {
					const { gauge, system, staff, staffIndex } = staffItem;

					const sourceCanvas = await shootStaffCanvas(system, staffIndex, {
						paddingLeft: STAFF_PADDING_LEFT,
						spec: GAUGE_VISION_SPEC,
						scaling: 2,
					});

					const sourceBuffer = sourceCanvas.toBufferSync("png");
					//fs.writeFileSync("./test/sourceBuffer.png", sourceBuffer);
					//fs.writeFileSync("./test/gauge.png", gauge);

					const baseY = (system.middleY - (staff.top + staff.staffY)) * GAUGE_VISION_SPEC.viewportUnit + GAUGE_VISION_SPEC.viewportHeight / 2;

					const { buffer, size } = await pyClients.predictScoreImages("gaugeRenderer", [sourceBuffer, gauge, baseY]);
					//fs.writeFileSync("./test/afterGauge.png", buffer);
					//process.exit(0);
					const webpBuffer = await sharp(buffer).toFormat("webp").toBuffer();

					staff.backgroundImage = await saveImage(webpBuffer, "webp");
					staff.maskImage = undefined;

					staff.imagePosition = {
						x: -STAFF_PADDING_LEFT / GAUGE_VISION_SPEC.viewportUnit,
						y: staff.staffY - size.height / GAUGE_VISION_SPEC.viewportUnit / 2,
						width: size.width / GAUGE_VISION_SPEC.viewportUnit,
						height: size.height / GAUGE_VISION_SPEC.viewportUnit,
					};

					staffItem.strightBuffer = buffer;
				}

				console.log("staves straightification done:", staves.length);
			}

			page.systems.forEach(system => system.clearTokens());

			const semanticRes = await pyClients.predictScoreImages("semantic", staves.map(staff => staff.strightBuffer));
			console.assert(semanticRes.length === staves.length, "invalid semantic response:", semanticRes);
			if (semanticRes?.length !== staves.length)
				throw new Error("invalid semantic response");

			staves.forEach(({ system, staff, staffIndex }, i) => {
				const graph = starry.recoverJSON<starry.SemanticGraph>(semanticRes[i], starry);
				graph.offset(-STAFF_PADDING_LEFT / SEMANTIC_VISION_SPEC.viewportUnit, 0);

				system.assignSemantics(staffIndex, graph);

				staff.assignSemantics(graph);
				staff.clearPredictedTokens();

				score.assembleSystem(system, score.settings?.semanticConfidenceThreshold);
			});
		}

		omrState.score.semantic = Date.now();

		await saveScore();

		score.assemble();
		const n_measure = score.systems.reduce((sum, system) => sum + system.measureCount, 0);
		omrState.score.n_measure = n_measure;

		fs.writeFileSync(omrStatePath, YAML.stringify(omrState));
		console.log("Score saved.");
	}
	catch (err) {
		omrState.score.lastError = err.toString();
		fs.writeFileSync(omrStatePath, YAML.stringify(omrState));
		console.warn("Interrupted by exception:", err);
	}
};


const constructSpartitos = async (targetDir: string, beadPicker: OnnxBeadPicker): Promise<void> => {
	const omrStatePath = path.join(targetDir, "omr.yaml");
	const scorePath = path.join(targetDir, "score.json");
	if (!fs.existsSync(scorePath))
		return;

	const omrState = fs.existsSync(omrStatePath) ? YAML.parse(fs.readFileSync(omrStatePath).toString()) : {};
	if (!omrState?.score?.semantic)
		return;

	if (!argv.renew && omrState.spartito) {
		console.log("Spartito already constructed, skip.");
		return;
	}

	const scoreJSON = fs.readFileSync(scorePath).toString();
	const score = starry.recoverJSON<starry.Score>(scoreJSON, starry);

	console.log("Constructing spartitos...");;

	if (score.systems.some(system => !system.semantics)) {
		const ns = score.systems.filter(system => !system.semantics).length;
		console.warn("invalid score, null system semantics:", `${ns}/${score.systems.length}`);
		return;
	}

	omrState.spartito = [];
	omrState.glimpseModel = BEAD_PICKER_URL.replace(/\\/g, "/").split("/").slice(-2).join("/");

	const pageCounting = {} as Record<number, number>;

	for (const singleScore of score.splitToSingleScoresGen()) {
		//console.debug("singleScore:", singleScore.pages.length);
		const spartito = singleScore.makeSpartito();

		spartito.measures.forEach((measure) => singleScore.assignBackgroundForMeasure(measure));
		singleScore.makeTimewiseGraph({ store: true });

		for (const measure of spartito.measures)
			if (measure.events.length + 1 < beadPicker.n_seq) {
				//console.debug("glimpse:", `${measure.measureIndex}/${spartito.measures.length}`);
				await beadSolver.glimpseMeasure(measure, { picker: beadPicker });
			}

		const { notation } = spartito.performByEstimation();
		const mlayout = singleScore.getMeasureLayout()
		const measureIndices = mlayout?.serialize(measureLayout.LayoutType.Full)
			?? Array(notation.measures.length).fill(null).map((_, i) => i + 1);
		const midi = notation.toPerformingMIDI(measureIndices);

		// ignore empty spartito
		if (!midi)
			continue;

		const headPageIndex = singleScore.headers.SubScorePage ? Number(singleScore.headers.SubScorePage.match(/^\d+/)[0]) : 0;
		console.assert(Number.isInteger(headPageIndex) && score.pages[headPageIndex],
			"invalid headPageIndex:", singleScore.headers.SubScorePage, score.pages.length);

		const subId = pageCounting[headPageIndex] ? `p${headPageIndex}-${pageCounting[headPageIndex]}` : `p${headPageIndex}`;

		pageCounting[headPageIndex] = pageCounting[headPageIndex] || 0;
		++pageCounting[headPageIndex];

		const headPage = score.pages[headPageIndex];
		const title = (headPage.tokens ?? [])
			.filter((token: starry.TextToken) => token.textType === starry.TextType.Title)
			.sort((t1, t2) => t1.y - t2.y)
			.map((token: starry.TextToken) => token.text)
			.join("\n");

		const spartitoPath = path.join(targetDir, `${subId}.spartito.json`);
		fs.writeFileSync(spartitoPath, JSON.stringify(spartito));
		const subScorePath = path.join(targetDir, `${subId}.score.json`);
		fs.writeFileSync(subScorePath, JSON.stringify(singleScore));
		console.log("Spartito saved:", singleScore.headers.SubScorePage ? `page[${singleScore.headers.SubScorePage}]` : "entire");

		const midiPath = path.join(targetDir, `${subId}.spartito.midi`);
		fs.writeFileSync(midiPath, Buffer.from(MIDI.encodeMidiFile(midi)));

		omrState.spartito.push({
			id: subId,
			index: omrState.spartito.length,
			time: Date.now(),
			title,
			systemRange: singleScore.headers.SubScoreSystem || "all",
			pageRange: singleScore.headers.SubScorePage || "all",
		});
	}

	fs.writeFileSync(omrStatePath, YAML.stringify(omrState));
};


const main = async () => {
	const t0 = Date.now();

	const predictor = new ProcessPredictor({
		command: PROCESS_PREDICTOR_CMD,
		cwd: PROCESS_PREDICTOR_DIR,
		args: ["./streamPredictor.py", SCORE_LAYOUT_WEIGHT, "-m", "scorePage", "-dv", TORCH_DEVICE, "-i"],
	});

	let pickerLoading;
	const beadPicker = new OnnxBeadPicker(BEAD_PICKER_URL, {
		n_seq: 128,
		usePivotX: true,
		onLoad: promise => pickerLoading = promise,
	});

	const targetDir = argv.target || path.dirname(argv.source);
	ensureDir(targetDir);

	const sourcePath = argv.source;
	await readPages(sourcePath, targetDir, predictor);

	await ocr(targetDir);

	const title = path.basename(sourcePath, path.extname(sourcePath));
	initScore(targetDir, { title });

	await scoreVision(targetDir);

	await pickerLoading;
	constructSpartitos(targetDir, beadPicker);

	//predictor.dispose();

	console.log(`parseSingleScore Done in ${(Date.now() - t0) * 1e-3}s`);
};


main();
