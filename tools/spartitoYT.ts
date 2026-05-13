import fs from "fs";
import path from "path";
import { MIDI } from "@k-l-lambda/music-widgets";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import "../env";

import { BEAD_PICKER_URL, ORT_SESSION_OPTIONS } from "./libs/constants";
import { starry, measureLayout } from "./libs/omr";
import OnnxBeadPicker from "./libs/onnxBeadPicker";


const argv = yargs(hideBin(process.argv))
	.command(
		"$0 source",
		"Construct spartito files for all score.json files under a YouTube score directory tree.",
		yargs => yargs
			.positional("source", { type: "string" })
			.demandOption("source")
			.option("renew", { alias: "r", type: "boolean", description: "overwrite existing spartito.json" })
			.option("midi", { type: "boolean", description: "also export spartito.midi" })
	)
	.help()
	.argv;


const BEAD_PICKER_N_SEQ = Number(BEAD_PICKER_URL.match(/seq(\d+)/)?.[1] ?? 128);


const walkScoreFiles = (dir: string): string[] => {
	const files: string[] = [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walkScoreFiles(file).forEach(scorePath => files.push(scorePath));
		} else if (entry.isFile() && entry.name === "score.json") {
			files.push(file);
		}
	}
	return files;
};


const exportMidi = (score: starry.Score, spartito: starry.Spartito, midiPath: string): boolean => {
	const { notation } = spartito.performByEstimation();
	const mlayout = score.getMeasureLayout();
	const measureIndices = mlayout?.serialize(measureLayout.LayoutType.Full)
		?? Array(notation.measures.length).fill(null).map((_, i) => i + 1);
	const midi = notation.toPerformingMIDI(measureIndices);

	if (!midi)
		return false;

	fs.writeFileSync(midiPath, Buffer.from(MIDI.encodeMidiFile(midi)));
	return true;
};


const constructSpartito = async (scorePath: string, beadPicker: OnnxBeadPicker): Promise<boolean> => {
	const dir = path.dirname(scorePath);
	const spartitoPath = path.join(dir, "spartito.json");
	if (!argv.renew && fs.existsSync(spartitoPath)) {
		console.log("Spartito exists, skip:", spartitoPath);
		return false;
	}

	const score = starry.recoverJSON<starry.Score>(fs.readFileSync(scorePath).toString(), starry);
	console.log(String.fromCodePoint(0x1f3bc), path.relative(process.cwd(), scorePath), score.title, `(${score.pages.length}p)`);

	if (score.systems.some(system => !system.semantics)) {
		const ns = score.systems.filter(system => !system.semantics).length;
		console.warn("invalid score, null system semantics:", `${ns}/${score.systems.length}`, scorePath);
		return false;
	}

	score.assemble();
	const spartito = score.makeSpartito();
	spartito.measures.forEach(measure => score.assignBackgroundForMeasure(measure));
	score.makeTimewiseGraph({ store: true });

	let glimpsed = 0;
	for (const measure of spartito.measures) {
		if (measure.events.length + 1 < beadPicker.n_seq) {
			await (starry as any).beadSolver.glimpseMeasure(measure, { picker: beadPicker });
			++glimpsed;
		}
	}

	fs.writeFileSync(spartitoPath, JSON.stringify(spartito));
	console.log("Spartito saved:", spartitoPath, `measures=${spartito.measures.length}`, `glimpsed=${glimpsed}`);

	if (argv.midi) {
		const midiPath = path.join(dir, "spartito.midi");
		if (exportMidi(score, spartito, midiPath))
			console.log("MIDI saved:", midiPath);
		else
			console.log("MIDI skipped: empty spartito", scorePath);
	}

	return true;
};


const main = async () => {
	const source = path.resolve(argv.source);
	if (!fs.existsSync(source) || !fs.statSync(source).isDirectory())
		throw new Error(`source directory not found: ${source}`);

	let pickerLoading: Promise<void>;
	const beadPicker = new OnnxBeadPicker(BEAD_PICKER_URL, {
		n_seq: BEAD_PICKER_N_SEQ,
		usePivotX: true,
		onLoad: promise => pickerLoading = promise,
		sessionOptions: ORT_SESSION_OPTIONS,
	});

	await pickerLoading;
	console.log("beadPicker loaded:", BEAD_PICKER_URL);

	const scorePaths = walkScoreFiles(source).sort();
	console.log("score files:", scorePaths.length);

	let constructed = 0;
	let index = 0;
	for (const scorePath of scorePaths) {
		console.log(`\n===== [${++index}/${scorePaths.length}] ${path.basename(path.dirname(scorePath))} =====`);
		if (await constructSpartito(scorePath, beadPicker))
			++constructed;
	}

	console.log("All scores done,", scorePaths.length, "scores,", constructed, "spartitos constructed.");
	process.exit(0);
};


main().catch(err => {
	console.error(err);
	process.exit(1);
});
