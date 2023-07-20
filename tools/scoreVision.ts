
import fs from "fs";
import path from "path";
import YAML from "yaml";
import * as skc from "skia-canvas";
import sharp from "sharp";

import "../env";

import { WorkBasic } from "./libs/types";
import { DATA_DIR, SCORE_FILTER_CONDITION, VIEWPORT_UNIT } from "./libs/constants";
import walkDir from "./libs/walkDir";
import { loadImage } from "./libs/utils";
import { starry } from "./libs/omr";
import pyClients from "./libs/pyClients";
import { shootPageCanvas } from "./libs/canvasUtilities";



const main = async () => {
	const works = walkDir(DATA_DIR, /\/$/);
	works.sort((d1, d2) => Number(path.basename(d1)) - Number(path.basename(d2)));

	console.log("pyClients warming up");
	await pyClients.warmup();

	let n_work = 0;
	let n_score = 0;

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

			console.log(String.fromCodePoint(0x1f3bc), `[${workId}/${file.id}]`, score.title);

			// brackets prediction
			if (!omrState.score?.brackets) {
				const pageCanvases = await Promise.all(score.pages.map(async page => {
					const buffer = await loadImage(page.source.url);
					const pngBuffer = await sharp(buffer).toFormat("png").toBuffer();
					const image = await skc.loadImage(pngBuffer);
					const pageCanvas = shootPageCanvas({ page, source: image });
	
					return {page, pageCanvas};
				}));
	
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
				fs.writeFileSync(scorePath, JSON.stringify(score));
				console.log("Not expected staff layout, skip:", score.staffLayoutCode);
				continue;
			}

			++n_score;

			if (zeroScores) {
				++n_work;
				zeroScores = false;
			}

			//break;	// temp
		}
		//break;	// temp
	}

	console.log("All works done,", n_work, "works, ", n_score, "scores.");
	process.exit(0);
};


main();
