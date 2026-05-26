import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { MIDI } from "@k-l-lambda/music-widgets";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import "../env";


const requireFromStarry = createRequire("/home/camus/work/starry/package.json");

const starry = requireFromStarry("./src/starry");
const lilypondEncoder = requireFromStarry("./src/utils/lilypondEncoder");
const lilyletEncoder = requireFromStarry("./src/utils/lilyletEncoder");
const lilyletSerializer = requireFromStarry("./src/utils/lilyletSerializer");
const React = requireFromStarry("react");
(globalThis as any).React = React;

const FORMAT_EXTENSIONS = {
	ly: ".ly",
	lyl: ".lyl",
	midi: ".midi",
} as const;

type ExportFormat = keyof typeof FORMAT_EXTENSIONS;

const argv = yargs(hideBin(process.argv))
	.command(
		"$0 <input>",
		"Export spartito files to LilyPond, Lilylet, and MIDI.",
		yargs => yargs
			.positional("input", { type: "string", describe: "Input spartito path or glob pattern" })
			.demandOption("input")
			.option("format", { alias: "f", type: "array", string: true, choices: Object.keys(FORMAT_EXTENSIONS), default: ["lyl"], describe: "Output format(s)" })
			.option("out", { alias: "o", type: "string", describe: "Output file path for a single input/format, or output directory for multiple outputs" })
			.option("name", { type: "string", describe: "Output basename without extension" })
			.option("overwrite", { type: "boolean", default: true, describe: "Overwrite existing output files" })
			.option("midi-tempo", { type: "number", default: 120, describe: "Tempo used for LilyPond export" })
	)
	.help()
	.argv as any;

const hasGlob = (value: string) => /[*?\[\]{}]/.test(value);

const globToRegExp = (pattern: string): RegExp => {
	const normalized = path.resolve(pattern).replace(/\\/g, "/");
	let out = "^";
	for (let i = 0; i < normalized.length; ++i) {
		const ch = normalized[i];
		const next = normalized[i + 1];
		if (ch === "*" && next === "*") {
			out += ".*";
			++i;
		} else if (ch === "*") {
			out += "[^/]*";
		} else if (ch === "?") {
			out += "[^/]";
		} else {
			out += ch.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
		}
	}
	return new RegExp(out + "$");
};

const walkFiles = (dir: string): string[] => {
	if (!fs.existsSync(dir))
		return [];
	const files: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory())
			files.push(...walkFiles(file));
		else if (entry.isFile())
			files.push(file);
	}
	return files;
};

const globBase = (pattern: string): string => {
	const resolved = path.resolve(pattern);
	const parts = resolved.split(path.sep);
	const base: string[] = [];
	for (const part of parts) {
		if (hasGlob(part))
			break;
		base.push(part);
	}
	const joined = base.join(path.sep) || path.sep;
	return fs.existsSync(joined) && fs.statSync(joined).isDirectory() ? joined : path.dirname(joined);
};

const resolveInputs = (input: string): string[] => {
	if (!hasGlob(input))
		return [path.resolve(input)];
	const regex = globToRegExp(input);
	return walkFiles(globBase(input)).filter(file => regex.test(path.resolve(file).replace(/\\/g, "/"))).sort();
};

const recoverSpartito = (filePath: string): any => {
	const json = fs.readFileSync(filePath, "utf8");
	return starry.recoverJSON(json, starry);
};

const makeExportSheet = (spartito: any, title: string) => {
	const staffGroups = spartito.staffGroups?.length ? spartito.staffGroups : Array.from({ length: spartito.stavesCount }, (_, i) => [i]);
	return {
		title,
		measureLayout: null,
		staffLayout: {
			staffIds: Array.from({ length: spartito.stavesCount }, (_, i) => i),
			standaloneGroups: staffGroups,
			stavesCount: spartito.stavesCount,
			partGroups: staffGroups.map((group: number[]) => ({ range: group })),
		},
		voiceStaves: spartito.makeVoiceStaves(),
	};
};

const ensureTrailingBlankLine = (data: string): string => data.replace(/\s*$/, "\n\n");

const exportLilylet = (spartito: any, title: string): string => {
	const doc = lilyletEncoder.encode(makeExportSheet(spartito, title));
	return ensureTrailingBlankLine(lilyletSerializer.serializeLilyletDoc(doc));
};

const exportLilypond = async (spartito: any, title: string, midiTempo: number): Promise<string> => {
	return ensureTrailingBlankLine(await lilypondEncoder.encode(makeExportSheet(spartito, title), { midiTempo }));
};

const exportMidi = (spartito: any): Buffer | undefined => {
	const { notation } = spartito.performByEstimation();
	const measureIndices = Array(notation.measures.length).fill(null).map((_, i) => i + 1);
	const midi = notation.toPerformingMIDI(measureIndices);
	if (!midi)
		return undefined;
	return Buffer.from(MIDI.encodeMidiFile(midi));
};

const outputPathFor = (inputPath: string, format: ExportFormat, multiple: boolean): string => {
	const extension = FORMAT_EXTENSIONS[format];
	if (argv.out && !multiple && path.extname(argv.out))
		return path.resolve(argv.out);
	const outputDir = argv.out ? path.resolve(argv.out) : path.dirname(inputPath);
	const basename = argv.name ?? path.basename(inputPath).replace(/\.spartito\.json$|\.json$/i, "");
	return path.join(outputDir, `${basename}${extension}`);
};

const writeOutput = (outputPath: string, data: string | Buffer) => {
	if (!argv.overwrite && fs.existsSync(outputPath)) {
		console.log("Skip existing:", outputPath);
		return;
	}
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(outputPath, data);
	console.log("Wrote:", outputPath);
};

const main = async () => {
	const inputs = resolveInputs(argv.input);
	if (!inputs.length)
		throw new Error(`No inputs matched: ${argv.input}`);
	const formats = [...new Set(argv.format as string[])] as ExportFormat[];
	const multiple = inputs.length > 1 || formats.length > 1;

	for (const inputPath of inputs) {
		const spartito = recoverSpartito(inputPath);
		const title = path.basename(path.dirname(inputPath));
		for (const format of formats) {
			const outputPath = outputPathFor(inputPath, format, multiple);
			if (format === "lyl")
				writeOutput(outputPath, exportLilylet(spartito, title));
			else if (format === "ly")
				writeOutput(outputPath, await exportLilypond(spartito, title, argv.midiTempo));
			else if (format === "midi") {
				const midi = exportMidi(spartito);
				if (midi)
					writeOutput(outputPath, midi);
				else
					console.warn("MIDI skipped: empty spartito", inputPath);
			}
		}
	}
};

main().catch(err => {
	console.error(err.stack || err.message);
	process.exit(1);
});
