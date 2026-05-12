import fs from "fs";
import path from "path";
import YAML from "yaml";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";
import * as skc from "skia-canvas";
import sharp from "sharp";

import "../env";

import { SEMANTIC_VISION_SPEC, GAUGE_VISION_SPEC, STAFF_PADDING_LEFT } from "./libs/constants";
import md5 from "spark-md5";


(globalThis as any).window = (globalThis as any).window || globalThis;

const { starry, PyClients } = require("./libs/omr");
const { constructSystem } = require("./libs/scoreSystem");
const { shootStaffCanvas } = require("./libs/canvasUtilities");
const { pyclients } = require("./libs/config");
const pyClients = new PyClients({
	...pyclients,
	gauge: pyclients.gauge || "tcp://localhost:12023",
	gaugeRenderer: pyclients.gaugeRenderer || "tcp://localhost:15656",
}, {
	info: (data) => console.log("PyClients info:", data),
	error: (err) => console.log("PyClients error:", err),
});

type LayoutArea = any;

type YTMeta = {
	video_id: string;
	staffLayout?: string;
	staff_n?: number;
	layout: {
		frame_size: { width: number; height: number };
		score_grid_rows: number;
		frames: YTFrame[];
	};
};

type YTFrame = {
	segment_index: number;
	start_seconds?: number;
	start_time?: string;
	snapshot_seconds?: number;
	sourceSize: { width: number; height: number };
	theta?: number;
	interval: number;
	areas: YTArea[];
};

type YTArea = {
	x: number;
	y: number;
	width: number;
	height: number;
	staff_detection: {
		interval: number;
		phi1: number;
		phi2: number;
		middleRhos: number[];
	};
	bracketsAppearance?: string;
	staffMask?: number;
};


const argv = yargs(hideBin(process.argv))
	.command(
		"$0 source",
		"Parse one youtube-piano-score sample directory or score.webp.",
		yargs => yargs
			.positional("source", { type: "string" })
			.demandOption("source")
			.option("renew", { alias: "r", type: "boolean", description: "overwrite existing score.json" })
	)
	.help()
	.argv;


const sampleDirOf = (source: string): string => fs.statSync(source).isDirectory() ? source : path.dirname(source);

const imageDirOf = (sampleDir: string): string => path.join(sampleDir, ".yt-score-images");

const saveLocalImage = async (sampleDir: string, data: Buffer, ext: string): Promise<string> => {
	const dir = imageDirOf(sampleDir);
	if (!fs.existsSync(dir))
		fs.mkdirSync(dir, { recursive: true });

	const hash = md5.ArrayBuffer.hash(data);
	const file = path.join(dir, `${hash}.${ext}`);
	if (!fs.existsSync(file))
		await fs.promises.writeFile(file, data);
	return file;
};

const imageDataUrl = (data: Buffer, mime: string): string => `data:${mime};base64,${data.toString("base64")}`;

const framePath = (sampleDir: string, index: number): string => path.join(sampleDir, ".yt-score-frames", `${index}.webp`);

const buildArea = (area: YTArea): LayoutArea => ({
	x: area.x,
	y: area.y,
	width: area.width,
	height: area.height,
	staves: {
		...area.staff_detection,
	},
	staff_images: area.staff_detection.middleRhos.map(() => ({
		hash: undefined,
		position: {
			x: 0,
			y: 0,
			width: area.width,
			height: area.height,
		},
	})),
} as LayoutArea);

const extractFrames = async (sampleDir: string, meta: YTMeta): Promise<string[]> => {
	const scoreImagePath = path.join(sampleDir, "score.webp");
	if (!fs.existsSync(scoreImagePath))
		throw new Error(`score.webp not found: ${scoreImagePath}`);

	const framesDir = path.join(sampleDir, ".yt-score-frames");
	if (!fs.existsSync(framesDir))
		fs.mkdirSync(framesDir);

	const { width, height } = meta.layout.frame_size;
	const rows = meta.layout.score_grid_rows;

	return Promise.all(meta.layout.frames.map(async (_, index) => {
		const file = framePath(sampleDir, index);
		if (!fs.existsSync(file)) {
			const left = Math.floor(index / rows) * width;
			const top = (index % rows) * height;
			await sharp(scoreImagePath)
				.extract({ left, top, width, height })
				.toFile(file);
		}
		return file;
	}));
};

const initScore = async (sampleDir: string, meta: YTMeta, imagePaths: string[]): Promise<any> => {
	const frames = meta.layout.frames
		.map((frame, index) => ({ frame, imagePath: imagePaths[index] }))
		.filter(({ frame }) => frame.areas?.some(area => area.staff_detection?.middleRhos?.length));
	if (!frames.length)
		throw new Error("No layout frames found in meta.yaml");

	const meanWidth = frames.reduce((sum, { frame }) => sum + frame.sourceSize.width, 0) / frames.length;
	const pageRatios = frames.map(({ frame }) => {
		const staffInterval = Math.min(...frame.areas.filter(area => area.staff_detection?.middleRhos?.length).map(area => area.staff_detection.interval));
		return {
			width: frame.sourceSize.width / staffInterval,
			aspect: frame.sourceSize.height / frame.sourceSize.width,
		};
	});
	const maxLogicWidth = pageRatios.sort((a, b) => b.width - a.width)[0].width;
	const maxAspect = Math.max(...pageRatios.map(r => r.aspect));
	const unitSize = meanWidth / maxLogicWidth;
	const pageSize = {
		width: meanWidth,
		height: meanWidth * maxAspect,
	};

	const skippedPages = meta.layout.frames.length - frames.length;
	if (skippedPages > 0)
		console.log(`Skipping ${skippedPages} frame(s) without layout areas.`);

	const pages = frames.map(({ frame, imagePath }) => {
		const page = new starry.Page({
			source: {
				url: imagePath,
				dimensions: { width: frame.sourceSize.width, height: frame.sourceSize.height },
				matrix: [1, 0, 0, 1, 0, 0],
				interval: frame.interval,
				needGauge: true,
			},
			layout: { areas: frame.areas.map(buildArea) },
			width: pageSize.width / unitSize,
			height: pageSize.height / unitSize,
		});

		(page.layout.areas.filter(area => area.staves?.middleRhos?.length) as LayoutArea[]).forEach((area, systemIndex) => {
			const sourceCenter = {
				x: frame.sourceSize.width / 2 / frame.interval,
				y: frame.sourceSize.height / 2 / frame.interval,
			};
			const position = {
				x: (area.x + area.staves.phi1) / frame.interval - sourceCenter.x + page.width / 2,
				y: area.y / frame.interval - sourceCenter.y + page.height / 2,
			};
			const system = constructSystem({ page, area, position });
			const sourceArea = frame.areas[systemIndex];
			system.bracketsAppearance = sourceArea.bracketsAppearance;
			system.staffMaskChanged = sourceArea.staffMask;
			page.systems.push(system);
		});

		return page;
	});

	const score = new starry.Score({
		title: meta.video_id || path.basename(sampleDir),
		unitSize,
		pageSize,
		headers: {
			Source: "youtube-piano-score",
			VideoId: meta.video_id,
		},
		instrumentDict: {},
		staffLayoutCode: meta.staffLayout,
		settings: {
			enabledGauge: true,
			semanticConfidenceThreshold: 1,
		},
		pages,
	});

	if (!meta.staffLayout)
		score.inferenceStaffLayout();

	return score;
};

const runVision = async (score: any, sampleDir: string): Promise<void> => {
	let pageIndex = 0;
	for (const page of score.pages) {
		console.log(`Page ${++pageIndex}/${score.pages.length}...`);
		const sourceBuffer = await fs.promises.readFile(page.source.url);
		const pngBuffer = await sharp(sourceBuffer).toFormat("png").toBuffer();
		const sourceImage = await skc.loadImage(pngBuffer);

		await Promise.all(page.systems.map(async (system) => {
			const sourceRect = {
				x: -system.imagePosition.x * page.source.interval,
				y: system.imagePosition.y * page.source.interval,
				width: system.imagePosition.width * page.source.interval,
				height: system.imagePosition.height * page.source.interval,
			};
			const canvas = new skc.Canvas(sourceRect.width, sourceRect.height);
			const context = canvas.getContext("2d");
			context.drawImage(sourceImage, sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height, 0, 0, canvas.width, canvas.height);
			system.backgroundImage = canvas.toBufferSync("png") as any;
		}));

		const staves = (await Promise.all(page.systems.map(async system => {
			return Promise.all(system.staves.map(async (staff, staffIndex) => {
				const sourceCanvas = await shootStaffCanvas(system, staffIndex, {
					paddingLeft: STAFF_PADDING_LEFT,
					spec: GAUGE_VISION_SPEC,
				});

				return {
					gauge: undefined as Buffer,
					image: sourceCanvas.toBufferSync("png"),
					strightBuffer: undefined as Buffer,
					system,
					staff,
					staffIndex,
				};
			}));
		}))).flat(1);

		const gaugeRes = await pyClients.predictScoreImages("gauge", staves.map(staff => staff.image));
		console.assert(gaugeRes.length === staves.length, "invalid gauge response:", gaugeRes);
		if (gaugeRes?.length !== staves.length)
			throw new Error("invalid gauge response");
		staves.forEach((staff, index) => staff.gauge = gaugeRes[index].image);

		for (const staffItem of staves) {
			const { gauge, system, staff, staffIndex } = staffItem;
			const sourceCanvas = await shootStaffCanvas(system, staffIndex, {
				paddingLeft: STAFF_PADDING_LEFT,
				spec: GAUGE_VISION_SPEC,
				scaling: 2,
			});
			const sourceBuffer = sourceCanvas.toBufferSync("png");
			const baseY = (system.middleY - (staff.top + staff.staffY)) * GAUGE_VISION_SPEC.viewportUnit + GAUGE_VISION_SPEC.viewportHeight / 2;
			const { buffer, size } = await pyClients.predictScoreImages("gaugeRenderer", [sourceBuffer, gauge, baseY]);
			const webpBuffer = await sharp(buffer).toFormat("webp").toBuffer();

			staff.backgroundImage = await saveLocalImage(sampleDir, webpBuffer, "webp");
			staff.maskImage = undefined;
			staff.imagePosition = {
				x: -STAFF_PADDING_LEFT / GAUGE_VISION_SPEC.viewportUnit,
				y: staff.staffY - size.height / GAUGE_VISION_SPEC.viewportUnit / 2,
				width: size.width / GAUGE_VISION_SPEC.viewportUnit,
				height: size.height / GAUGE_VISION_SPEC.viewportUnit,
			};
			staffItem.strightBuffer = buffer;
		}

		page.systems.forEach(system => system.clearTokens());

		const [semanticRes, maskRes] = await Promise.all([
			pyClients.predictScoreImages("semantic", staves.map(staff => staff.strightBuffer)),
			pyClients.predictScoreImages("mask", staves.map(staff => staff.strightBuffer)),
		]);
		console.assert(semanticRes.length === staves.length, "invalid semantic response:", semanticRes);
		console.assert(maskRes.length === staves.length, "invalid mask response:", semanticRes);
		if (semanticRes?.length !== staves.length)
			throw new Error("invalid semantic response");
		if (maskRes?.length !== staves.length)
			throw new Error("invalid mask response");

		for (let i = 0; i < staves.length; i++) {
			const { system, staff, staffIndex } = staves[i];
			const webpMaskBuffer = await sharp(maskRes[i].image).toFormat("webp").toBuffer();
			staff.maskImage = imageDataUrl(webpMaskBuffer, "image/webp");

			const graph = starry.recoverJSON(semanticRes[i], starry);
			graph.offset(-STAFF_PADDING_LEFT / SEMANTIC_VISION_SPEC.viewportUnit, 0);
			system.assignSemantics(staffIndex, graph);
			staff.assignSemantics(graph);
			staff.clearPredictedTokens();
			score.assembleSystem(system, score.settings?.semanticConfidenceThreshold);
		}
	}

	score.assemble();
	await score.replaceImageKeys(key => Promise.resolve(Buffer.isBuffer(key) || ArrayBuffer.isView(key) ? undefined : key));
};

const main = async () => {
	const source = path.resolve(argv.source);
	const sampleDir = sampleDirOf(source);
	const scorePath = path.join(sampleDir, "score.json");
	if (!argv.renew && fs.existsSync(scorePath)) {
		console.log("score.json exists, skip. Use --renew to overwrite.");
		return;
	}

	const metaPath = path.join(sampleDir, "meta.yaml");
	if (!fs.existsSync(metaPath))
		throw new Error(`meta.yaml not found: ${metaPath}`);

	const meta = YAML.parse(fs.readFileSync(metaPath).toString()) as YTMeta;
	const imagePaths = await extractFrames(sampleDir, meta);
	const score = await initScore(sampleDir, meta, imagePaths);
	await runVision(score, sampleDir);

	fs.writeFileSync(scorePath, JSON.stringify(score));
	console.log("Score saved:", scorePath);
};

main().catch(err => {
	console.error(err);
	process.exit(1);
});
