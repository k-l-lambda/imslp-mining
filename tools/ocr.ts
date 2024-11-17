
import fs from "fs";
import path from "path";
import YAML from "yaml";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import "../env";

import { WorkBasic, PageLayoutResult } from "./libs/types";
import { DATA_DIR } from "./libs/constants";
import walkDir from "./libs/walkDir";
import { loadImage, idRange2Filter, datetime } from "./libs/utils";
import pyClients from "./libs/pyClients";



const argv = yargs(hideBin(process.argv))
	.command(
		"$0 [options]",
		"Run OCR on layouts",
		yargs => yargs
			.option("ids", { alias: "i", type: "string" })
		,
	).help().argv;


const main = async () => {
	let works = walkDir(DATA_DIR, /\/$/);
	works.sort((d1, d2) => Number(path.basename(d1)) - Number(path.basename(d2)));

	if (argv.ids) {
		const goodId = idRange2Filter(argv.ids);
		works = works.filter(work => goodId(Number(path.basename(work))));
	}

	console.log("pyClients warming up");
	await pyClients.warmup();

	for (const work of works) {
		const workId = path.basename(work);

		const basic = YAML.parse(fs.readFileSync(path.join(work, "basic.yaml")).toString()) as WorkBasic;
		console.log(basic.id, basic.title);

		const files = basic.files.filter(file => file.ext === "pdf");
		for (const file of files) {
			const layoutPath = path.join(work, file.id, "layout.json");
			if (!fs.existsSync(layoutPath))
				continue;

			const layout = JSON.parse(fs.readFileSync(layoutPath).toString()) as PageLayoutResult[];
			if (!layout || !layout.length)
				continue;

			console.log(datetime(), String.fromCodePoint(0x1f3bc), `[${workId}/${file.id}]`, file.path);

			const omrStatePath = path.join(work, file.id, "omr.yaml");
			const omrState = fs.existsSync(omrStatePath) ? YAML.parse(fs.readFileSync(omrStatePath).toString()) : {};
			if (omrState?.ocr?.done) {
				console.log("OCR already done, skip");
				continue;
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
					for (let ii = 0; ii < location.length; ii +=100) {
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

			omrState.ocr = omrState.ocr || {done: true, logs: []};
			omrState.ocr.done = true;
			omrState.ocr.logs.push(`[${datetime()}] ${n_text} texts of ${layout.length} pages.`);
			fs.writeFileSync(omrStatePath, YAML.stringify(omrState));
		}
	}

	console.log("All works done.");
	process.exit(0);
};


main();
