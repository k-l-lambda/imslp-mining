
import fs from "fs";
import path from "path";
import YAML from "yaml";
import * as skc from "skia-canvas";
import sharp from "sharp";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import "../env";

import { WorkBasic } from "./libs/types";
import { DATA_DIR, SCORE_FILTER_CONDITION, VIEWPORT_UNIT, GAUGE_VISION_SPEC, SEMANTIC_VISION_SPEC, STAFF_PADDING_LEFT } from "./libs/constants";
import walkDir from "./libs/walkDir";
import { loadImage, saveImage, idRange2Filter, datetime } from "./libs/utils";
import { starry } from "./libs/omr";
import pyClients from "./libs/pyClients";
import { shootPageCanvas, shootStaffCanvas } from "./libs/canvasUtilities";



const argv = yargs(hideBin(process.argv))
	.command(
		"$0 [options]",
		"Run vision prediction on starry score files.",
		yargs => yargs
			.option("ids", { alias: "i", type: "string" })
		,
	).help().argv;


const main = async () => {
	let works = walkDir(DATA_DIR, /\/$/);
	works.sort((d1, d2) => Number(path.basename(d1)) - Number(path.basename(d2)));

	console.log("pyClients warming up");
	await pyClients.warmup();

	let n_work = 0;
	let n_score = 0;

	if (argv.ids) {
		const goodId = idRange2Filter(argv.ids);
		works = works.filter(work => goodId(Number(path.basename(work))));
	}

	for (const work of works) {
		const workId = path.basename(work);

		const basic = YAML.parse(fs.readFileSync(path.join(work, "basic.yaml")).toString()) as WorkBasic;
		console.log(basic.id, basic.title);

		let zeroScores = true;

		const files = basic.files.filter(file => file.ext === "pdf");
		for (const file of files) {
			const omrStatePath = path.join(work, file.id, "omr.yaml");
			const scorePath = path.join(work, file.id, "score.json");
			if (!fs.existsSync(scorePath))
				continue;

			const omrState = fs.existsSync(omrStatePath) ? YAML.parse(fs.readFileSync(omrStatePath).toString()) : {};
			if (omrState?.score?.semantic) {
				console.log("Score vision already done, skip.");
				continue;
			}

			const scoreJSON = fs.readFileSync(scorePath).toString();
			const score = starry.recoverJSON<starry.Score>(scoreJSON, starry);

			const saveScore = async () => {
				await score.replaceImageKeys(key => Promise.resolve(Buffer.isBuffer(key) || ArrayBuffer.isView(key) ? undefined : key));
				fs.writeFileSync(scorePath, JSON.stringify(score));
			};

			console.log(datetime(), String.fromCodePoint(0x1f3bc), `[${workId}/${file.id}]`, score.title);

			try {
				const pageCanvases = await Promise.all(score.pages.map(async page => {
					const buffer = await loadImage(page.source.url);
					const pngBuffer = await sharp(buffer).toFormat("png").toBuffer();
					const image = await skc.loadImage(pngBuffer);
					const pageCanvas = await shootPageCanvas({ page, source: image });	// also prepare system background images

					return { page, pageCanvas };
				}));

				if (!omrState.score?.brackets) {
					// brackets prediction
					for (const {page, pageCanvas} of pageCanvases) {
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
						/*bracketImages.forEach((img, i) => {
							fs.writeFileSync(`./test/sys-${i}.png`, img.buffer);
						});*/

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

				let proceed = true;
				switch (SCORE_FILTER_CONDITION) {
				case "single_piano":
					proceed = ["{,}", "{-}", "{,,}", "{--}"].includes(score.staffLayoutCode);

					break;
				case "1or2pianos":
					proceed = [
						"{,}", "{-}", "{,,}", "{--}",
						"{,},{,}", "{-},{-}", "{-}{-}", "{,}{,}",
					].includes(score.staffLayoutCode);

					break;
				}

				if (!proceed) {
					saveScore();
					console.log("Not expected staff layout, skip:", score.staffLayoutCode);
					continue;
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
						else {
							const sourceCanvas = await shootStaffCanvas(system, staffIndex, {
								paddingLeft: STAFF_PADDING_LEFT,
								spec: SEMANTIC_VISION_SPEC,
							});
							strightBuffer = sourceCanvas.toBufferSync("png");
							staff.imagePosition = {
								x: -STAFF_PADDING_LEFT / SEMANTIC_VISION_SPEC.viewportUnit,
								y: staff.staffY - sourceCanvas.height / SEMANTIC_VISION_SPEC.viewportUnit / 2,
								width: sourceCanvas.width / SEMANTIC_VISION_SPEC.viewportUnit,
								height: sourceCanvas.height / SEMANTIC_VISION_SPEC.viewportUnit,
							};
						}

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
							const {gauge, system, staff, staffIndex} = staffItem;

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

					// TODO: predict mask if ENABLED_VISION_MASK on

					const semanticRes = await pyClients.predictScoreImages("semantic", staves.map(staff => staff.strightBuffer));
					console.assert(semanticRes.length === staves.length, "invalid semantic response:", semanticRes);
					if (semanticRes?.length !== staves.length)
						throw new Error("invalid semantic response");

					staves.forEach(({system, staff, staffIndex}, i) => {
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

				++n_score;

				if (zeroScores) {
					++n_work;
					zeroScores = false;
				}
			}
			catch (err) {
				omrState.score.lastError = err.toString();
				fs.writeFileSync(omrStatePath, YAML.stringify(omrState));
				console.warn("Interrupted by exception:", err);
			}
		}
	}

	console.log("All works done,", n_work, "works, ", n_score, "scores.");
	process.exit(0);
};


main();
