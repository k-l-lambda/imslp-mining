
import fs from "fs";
import path from "path";
import YAML from "yaml";
import { MIDI } from "@k-l-lambda/music-widgets";

import "../env";

import { WorkBasic } from "./libs/types";
import { DATA_DIR, BEAD_PICKER_URL } from "./libs/constants";
import walkDir from "./libs/walkDir";
import { starry, beadSolver, measureLayout } from "./libs/omr";
import OnnxBeadPicker from "./libs/onnxBeadPicker";



const main = async () => {
	let pickerLoading;

	const beadPicker = new OnnxBeadPicker(BEAD_PICKER_URL, {
		n_seq: 128,
		usePivotX: BEAD_PICKER_URL.includes("pivotx"),
		onLoad: promise => pickerLoading = promise,
	});

	const works = walkDir(DATA_DIR, /\/$/);
	works.sort((d1, d2) => Number(path.basename(d1)) - Number(path.basename(d2)));

	let n_work = 0;
	let n_score = 0;
	let n_spartito = 0;

	await pickerLoading;
	console.log("beadPicker loaded:", BEAD_PICKER_URL);

	for (const work of works) {
		const workId = path.basename(work);

		const basic = YAML.parse(fs.readFileSync(path.join(work, "basic.yaml")).toString()) as WorkBasic;
		console.log(basic.id, basic.title);

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

			if (omrState.spartito) {
				console.log("Spartito already constructed, skip.");
				continue;
			}

			const scoreJSON = fs.readFileSync(scorePath).toString();
			const score = starry.recoverJSON<starry.Score>(scoreJSON, starry);

			console.log(String.fromCodePoint(0x1f3bc), `[${workId}/${file.id}]`, score.title);

			if (score.systems.some(system => !system.semantics)) {
				const ns = score.systems.filter(system => !system.semantics).length;
				console.warn("invalid score, null system semantics:", `${ns}/${score.systems.length}`);
				continue;
			}

			omrState.spartito = [];

			const subScores = score.splitToSingleScores();
			for (const [index, singleScore] of subScores.entries()) {
				const spartito = singleScore.makeSpartito();

				for (const measure of spartito.measures)
					if (measure.events.length + 1 < beadPicker.n_seq)
						await beadSolver.glimpseMeasure(measure, beadPicker);

				const { notation } = spartito.performByEstimation();
				const mlayout = singleScore.getMeasureLayout()
				const measureIndices = mlayout?.serialize(measureLayout.LayoutType.Full)
					?? Array(notation.measures.length).fill(null).map((_, i) => i + 1);
				const midi = notation.toPerformingMIDI(measureIndices);

				const spartitoPath = path.join(work, file.id, `${index}.spartito.json`);
				fs.writeFileSync(spartitoPath, JSON.stringify(spartito));
				console.log("Spartito saved:", singleScore.headers.SubScorePage ? `page[${singleScore.headers.SubScorePage}]` : "entire");

				if (midi) {
					const midiPath = path.join(work, file.id, `${index}.spartito.midi`);
					fs.writeFileSync(midiPath, Buffer.from(MIDI.encodeMidiFile(midi)));
				}

				omrState.spartito.push({
					index: omrState.spartito.length,
					time: Date.now(),
					range: singleScore.headers.SubScoreSystem || "all",
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
