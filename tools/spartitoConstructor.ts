
import fs from "fs";
import path from "path";
import YAML from "yaml";
import { MIDI } from "@k-l-lambda/music-widgets";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import "../env";

import { WorkBasic } from "./libs/types";
import { DATA_DIR, BEAD_PICKER_URL, PRIMARY_CATEGORIES } from "./libs/constants";
import walkDir from "./libs/walkDir";
import { starry, beadSolver, measureLayout } from "./libs/omr";
import OnnxBeadPicker from "./libs/onnxBeadPicker";
import { idRange2Filter } from "./libs/utils";



const argv = yargs(hideBin(process.argv))
	.command(
		"$0 [options]",
		"Construct spartito files.",
		yargs => yargs
			.option("renew", { alias: "r", type: "boolean" })
			.option("ids", { alias: "i", type: "string" })
		,
	).help().argv;


const main = async () => {
	let pickerLoading;

	const beadPicker = new OnnxBeadPicker(BEAD_PICKER_URL, {
		n_seq: 128,
		usePivotX: true,
		onLoad: promise => pickerLoading = promise,
	});

	let works = walkDir(DATA_DIR, /\/$/);
	works.sort((d1, d2) => Number(path.basename(d1)) - Number(path.basename(d2)));

	if (argv.ids) {
		const goodId = idRange2Filter(argv.ids);
		works = works.filter(work => goodId(Number(path.basename(work))));
	}

	const modelName = BEAD_PICKER_URL.replace(/\\/g, "/").split("/").slice(-2).join("/");

	let n_work = 0;
	let n_score = 0;
	let n_spartito = 0;

	await pickerLoading;
	console.log("beadPicker loaded:", BEAD_PICKER_URL);

	for (const work of works) {
		const workId = path.basename(work);

		const basic = YAML.parse(fs.readFileSync(path.join(work, "basic.yaml")).toString()) as WorkBasic;
		console.log(basic.id, basic.title);

		const tags = [];
		const author = basic.author.match(/^[^,\s]+/)?.[0].toLocaleLowerCase();
		if (author)
			tags.push(author)
		basic.categories.forEach(category => {
			const tag = PRIMARY_CATEGORIES[category];
			if (tag)
				tags.push(tag);
		});

		let workCount = false;

		const files = basic.files.filter(file => file.ext === "pdf");
		for (const file of files) {
			const omrStatePath = path.join(work, file.id, "omr.yaml");
			const scorePath = path.join(work, file.id, "score.json");
			if (!fs.existsSync(scorePath))
				continue;

			const omrState = fs.existsSync(omrStatePath) ? YAML.parse(fs.readFileSync(omrStatePath).toString()) : {};
			if (!omrState?.score?.semantic)
				continue;

			if (!argv.renew && omrState.spartito) {
				console.log("Spartito already constructed, skip.");
				continue;
			}

			const scoreJSON = fs.readFileSync(scorePath).toString();
			const score = starry.recoverJSON<starry.Score>(scoreJSON, starry);

			console.log(String.fromCodePoint(0x1f3bc), `[${workId}/${file.id}]`, score.title, `(${score.pages.length}p)`);

			if (score.systems.some(system => !system.semantics)) {
				const ns = score.systems.filter(system => !system.semantics).length;
				console.warn("invalid score, null system semantics:", `${ns}/${score.systems.length}`);
				continue;
			}

			omrState.spartito = [];
			omrState.glimpseModel = modelName;

			const pageCounting = {} as Record<number, number>;

			for (const singleScore of score.splitToSingleScoresGen()) {
				//console.debug("singleScore:", singleScore.pages.length);
				const spartito = singleScore.makeSpartito();

				spartito.tags = tags;

				spartito.measures.forEach((measure) => singleScore.assignBackgroundForMeasure(measure));
				singleScore.makeTimewiseGraph({ store: true });

				for (const measure of spartito.measures)
					if (measure.events.length + 1 < beadPicker.n_seq) {
						//console.debug("glimpse:", `${measure.measureIndex}/${spartito.measures.length}`);
						await beadSolver.glimpseMeasure(measure, beadPicker);
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

				const spartitoPath = path.join(work, file.id, `${subId}.spartito.json`);
				fs.writeFileSync(spartitoPath, JSON.stringify(spartito));
				console.log("Spartito saved:", singleScore.headers.SubScorePage ? `page[${singleScore.headers.SubScorePage}]` : "entire");

				const midiPath = path.join(work, file.id, `${subId}.spartito.midi`);
				fs.writeFileSync(midiPath, Buffer.from(MIDI.encodeMidiFile(midi)));

				omrState.spartito.push({
					id: subId,
					index: omrState.spartito.length,
					time: Date.now(),
					title,
					systemRange: singleScore.headers.SubScoreSystem || "all",
					pageRange: singleScore.headers.SubScorePage || "all",
				});

				++n_spartito;
			}

			fs.writeFileSync(omrStatePath, YAML.stringify(omrState));

			++n_score;
			if (!workCount) {
				++n_work;
				workCount = true;
			}
		}
	}

	console.log("All works done,", n_work, "works, ", n_score, "scores, ", n_spartito, "spartitos.");
	process.exit(0);
};


main();
