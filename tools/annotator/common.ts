
import fs from "fs";
import os from "os";
import path from "path";
import fetch from "isomorphic-fetch";
import sharp from "sharp";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import "../../env";

import { ANTHROPIC_AUTH_TOKEN, ANNOTATION_BASE_URL, ANNOTATION_MAX_TOKENS, ANNOTATION_MODEL as DEFAULT_ANNOTATION_MODEL, BEAD_PICKER_URL, IMAGE_BED, OMR_API_BASE, ORT_SESSION_OPTIONS } from "../libs/constants";
import { starry, regulateWithBeadSolver } from "../libs/omr";
import OnnxBeadPicker from "../libs/onnxBeadPicker";
import solutionStore from "../libs/solutionStore";
import { type PreprocessPatch, readMidiMeasureContexts, applyPreprocessPatchToMeasure } from "./preprocess";


// ── Re-exports for entry points ──────────────────────────────────────────────
export { starry, regulateWithBeadSolver };
export { ANTHROPIC_AUTH_TOKEN, ANNOTATION_BASE_URL, ANNOTATION_MAX_TOKENS, DEFAULT_ANNOTATION_MODEL, BEAD_PICKER_URL, IMAGE_BED, ORT_SESSION_OPTIONS };


// ── Types ────────────────────────────────────────────────────────────────────

export interface IssueMeasureInfo {
	measureIndex: number;
	status: number;
	measure: starry.SpartitoMeasure;
}

export interface BatchResult {
	fixes: Fix[];
	sessionId: string;
	measureIndices: number[];
	env: Record<string, string>;
}

export interface PreprocessBatchResult {
	patches: PreprocessPatch[];
	sessionId: string;
	measureIndices: number[];
	env: Record<string, string>;
}

export interface FixEvent {
	id: number;
	tick: number;
	tickGroup: number | null;
	timeWarp: { numerator: number; denominator: number } | null;
	division?: number;
	dots?: number;
	beam?: string;
	grace?: boolean;
}

export interface Fix {
	measureIndex: number;
	events: FixEvent[];
	voices: number[][];
	duration: number;
	status: number;
}

export interface StageFailure {
	measureIndex: number;
	batchLabel: string;
	error: string;
}

export interface AnnotationBackend {
	callPreprocess?(
		issues: IssueMeasureInfo[],
		spartito: starry.Spartito,
		logDir?: string,
		midiContexts?: Map<number, any>,
		measureImagesDir?: string,
	): Promise<{ patches: PreprocessPatch[]; batchResults: PreprocessBatchResult[]; failedMeasures?: StageFailure[] }>;

	callAnnotation(
		issues: IssueMeasureInfo[],
		spartito: starry.Spartito,
		round: number,
		logDir?: string,
	): Promise<{ fixes: Fix[]; batchResults: BatchResult[]; failedMeasures?: StageFailure[] }>;

	requestSummary(
		br: BatchResult,
		summaryPrompt: string,
	): Promise<string>;
}

export interface ParsedArgs {
	input: string;
	output?: string;
	fetchServer: boolean;
	logger: boolean;
	skipAnnotation: boolean;
	preprocessRegulateOnly: boolean;
	forceRegulate: boolean;
	annotationModel?: string;
	preprocess: boolean;
	preprocessModel?: string;
	midi?: string;
	midiSegmentation?: string;
	measureImages?: string;
	renew: boolean;
	regulationConcurrency: number;
	annotationConcurrency: number;
	maxRounds: number;
	measures?: string;
}


// ── CLI argument parsing ─────────────────────────────────────────────────────

export const parseArgs = (): ParsedArgs => {
	const argv = yargs(hideBin(process.argv))
		.command(
			"$0 <input> [options]",
			"Regulate and annotate a single spartito file.",
			yargs => yargs
				.positional("input", { type: "string", demandOption: true, describe: "Path to .spartito.json file" })
				.option("output", { alias: "o", type: "string", describe: "Output path (no file written if omitted)" })
				.option("fetch-server", { type: "boolean", default: false, describe: "Fetch existing server annotations before annotating" })
				.option("logger", { alias: "l", type: "boolean", describe: "Enable verbose logging" })
				.option("skip-annotation", { type: "boolean", describe: "Skip the annotation step" })
				.option("preprocess-regulate-only", { type: "boolean", default: false, describe: "Run preprocessing and regulation only, write solved.spartito.json, and skip annotation" })
				.option("force-regulate", { type: "boolean", describe: "Force re-regulation even if already regulated" })
				.option("annotation-model", { type: "string", describe: "Model for annotation (overrides ANNOTATION_MODEL env)" })
				.option("preprocess", { type: "boolean", default: false, describe: "Run agent preprocessing for pitch/basic/accessory recognition fixes before annotation" })
				.option("preprocess-model", { type: "string", describe: "Model for preprocessing (defaults to annotation model)" })
				.option("midi", { type: "string", describe: "Optional MIDI file for preprocessing context" })
				.option("midi-segmentation", { type: "string", describe: "Optional YAML segmentation for MIDI preprocessing context" })
				.option("measure-images", { type: "string", describe: "Optional directory containing pre-rendered measure images (mNNN.webp) for preprocessing" })
				.option("renew", { type: "boolean", default: false, describe: "Ignore preprocess checkpoints and rerun preprocessing" })
				.option("regulation-concurrency", { type: "number", default: 1, describe: "Concurrent per-measure regulation window jobs" })
				.option("annotation-concurrency", { type: "number", default: 1, describe: "Concurrent per-measure annotation jobs" })
				.option("max-rounds", { type: "number", default: 1, describe: "Max annotation rounds" })
				.option("measures", { type: "string", describe: "Comma-separated measure indices to annotate (e.g. '16,70,83')" })
			,
		).help().argv;

	return argv as unknown as ParsedArgs;
};


const parseMeasureFilter = (spec?: string): Set<number> | null => {
	if (!spec) return null;
	const values = new Set<number>();
	for (const part of spec.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
		if (range) {
			const start = Number(range[1]);
			const end = Number(range[2]);
			for (let value = Math.min(start, end); value <= Math.max(start, end); ++value)
				values.add(value);
			continue;
		}
		const value = Number(trimmed);
		if (Number.isFinite(value)) values.add(value);
	}
	return values.size ? values : null;
};

// ── Constants ────────────────────────────────────────────────────────────────

const PICKER_SEQS = [32, 64, 128, 512];

const stageCheckpointPath = (logDir: string, stage: "pre" | "reg" | "ann", measureIndex: number): string => path.join(logDir, `${stage}_m${measureIndex.toString().padStart(3, "0")}_result.json`);

const preprocessCheckpointPath = (logDir: string, measureIndex: number): string => stageCheckpointPath(logDir, "pre", measureIndex);
const regulationCheckpointPath = (logDir: string, measureIndex: number): string => stageCheckpointPath(logDir, "reg", measureIndex);
const annotationCheckpointPath = (logDir: string, measureIndex: number): string => stageCheckpointPath(logDir, "ann", measureIndex);

const regulationLogRoot = (inputPath: string): string => path.join(path.dirname(inputPath), ".regulation");

const findLatestPreprocessCheckpointDir = (inputPath: string): string | undefined => {
	const logsRoot = regulationLogRoot(inputPath);
	if (!fs.existsSync(logsRoot)) return undefined;
	const dirs = fs.readdirSync(logsRoot, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => path.join(logsRoot, entry.name))
		.filter(dir => fs.readdirSync(dir).some(name => /^(pre|reg|ann)_m\d+_result\.json$/.test(name)))
		.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
	return dirs[0];
};

const readJsonFile = <T = any>(filePath: string): T | undefined => {
	if (!fs.existsSync(filePath)) return undefined;
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (err: any) {
		console.warn(`  failed to read checkpoint ${path.basename(filePath)}: ${err.message}`);
		return undefined;
	}
};

const writeJsonAtomic = (filePath: string, value: any) => {
	const tmpPath = `${filePath}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
	fs.renameSync(tmpPath, filePath);
};

const applyPreprocessPatchesWithWarnings = (spartito: starry.Spartito, patches: PreprocessPatch[]): number => {
	let applied = 0;
	for (const patch of patches) {
		const measure = spartito.measures[patch.measureIndex];
		if (!measure) {
			console.warn(`  m${patch.measureIndex}: measure not found, skipping preprocessing checkpoint patch`);
			continue;
		}
		const result = applyPreprocessPatchToMeasure(measure, patch);
		for (const warning of result.warnings) console.warn(`  m${patch.measureIndex}: ${warning}`);
		if (result.applied) applied++;
	}
	return applied;
};

const readPreprocessCheckpoint = (logDir: string, measureIndex: number): { patches: PreprocessPatch[] } | undefined => {
	const checkpointPath = preprocessCheckpointPath(logDir, measureIndex);
	if (!fs.existsSync(checkpointPath)) return undefined;
	try {
		const data = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
		if (data?.measureIndex !== measureIndex || !Array.isArray(data?.patches)) return undefined;
		return { patches: data.patches };
	} catch (err: any) {
		console.warn(`  m${measureIndex}: failed to read preprocess checkpoint: ${err.message}`);
		return undefined;
	}
};

const writePreprocessCheckpoint = (logDir: string, measureIndex: number, patches: PreprocessPatch[], source: Record<string, any>) => {
	writeJsonAtomic(preprocessCheckpointPath(logDir, measureIndex), {
		version: 2,
		kind: "stage-checkpoint",
		stage: "preprocess",
		measureIndex,
		patches,
		patchCount: patches.length,
		createdAt: new Date().toISOString(),
		...source,
	});
};

const readRegulationCheckpoint = (logDir: string, measureIndex: number): { measure: any; issue?: any; stat?: any; windowMeasureIndices?: number[] } | undefined => {
	const data = readJsonFile(regulationCheckpointPath(logDir, measureIndex));
	if (data?.measureIndex !== measureIndex || !data?.measure) return undefined;
	return data;
};

const readAnnotationCheckpoint = (logDir: string, measureIndex: number): { fixes: Fix[]; applied: number[] } | undefined => {
	const data = readJsonFile(annotationCheckpointPath(logDir, measureIndex));
	if (data?.measureIndex !== measureIndex || !Array.isArray(data?.fixes)) return undefined;
	return { fixes: data.fixes, applied: Array.isArray(data.applied) ? data.applied.filter((value: any) => Number.isInteger(value)) : [] };
};

const contiguousCheckpointPrefixEnd = (logDir: string, stage: "pre" | "reg", targets: IssueMeasureInfo[]): number => {
	let end = targets[0]?.measureIndex ?? -1;
	end--;
	for (const target of targets) {
		const mi = target.measureIndex;
		if (mi !== end + 1) break;
		const checkpointPath = stageCheckpointPath(logDir, stage, mi);
		if (!fs.existsSync(checkpointPath)) break;
		end = mi;
	}
	return end;
};

const writeRegulationCheckpoint = (logDir: string, measureIndex: number, measure: starry.SpartitoMeasure, source: Record<string, any>) => {
	writeJsonAtomic(regulationCheckpointPath(logDir, measureIndex), {
		version: 2,
		kind: "stage-checkpoint",
		stage: "regulation",
		measureIndex,
		measure: measure.toJSON ? measure.toJSON() : measure,
		createdAt: new Date().toISOString(),
		...source,
	});
};

const writeAnnotationCheckpoint = (logDir: string, measureIndex: number, fixes: Fix[], applied: Set<number>, source: Record<string, any>) => {
	writeJsonAtomic(annotationCheckpointPath(logDir, measureIndex), {
		version: 2,
		kind: "stage-checkpoint",
		stage: "annotation",
		measureIndex,
		fixes,
		applied: [...applied],
		createdAt: new Date().toISOString(),
		...source,
	});
};

const runRegulation = async (spartito: starry.Spartito, argv: ParsedArgs, issueMeasures?: IssueMeasureInfo[]) => {
	const loadings = [] as Promise<void>[];
	const pickers = PICKER_SEQS.map(n_seq => new OnnxBeadPicker(BEAD_PICKER_URL.replace(/seq\d+/, `seq${n_seq}`), {
		n_seq,
		usePivotX: true,
		onLoad: promise => loadings.push(promise.catch(err => console.warn("error to load BeadPicker:", err))),
		sessionOptions: ORT_SESSION_OPTIONS,
	}));

	await Promise.all(loadings);

	const dummyScore = {
		assemble () {},
		makeSpartito () { return spartito },
		assignBackgroundForMeasure (_: starry.SpartitoMeasure) {},
	} as starry.Score;

	return regulateWithBeadSolver(dummyScore, {
		logger: argv.logger ? console : undefined,
		pickers,
		solutionStore,
		onSaveIssueMeasure: issueMeasures ? (data) => {
			issueMeasures.push({
				measureIndex: data.measureIndex,
				status: data.status,
				measure: data.measure,
			});
		} : undefined,
	});
};

const recoverMeasure = (value: any): starry.SpartitoMeasure => new starry.SpartitoMeasure(starry.recoverJSON(value, starry));

const cloneSpartito = (spartito: starry.Spartito): starry.Spartito => starry.recoverJSON<starry.Spartito>(JSON.stringify(spartito), starry);

const measureWindowIndices = (measureIndex: number, measureCount: number): number[] => [measureIndex - 1, measureIndex, measureIndex + 1]
	.filter(index => index >= 0 && index < measureCount);

const runRegulationMeasureWindow = async (spartito: starry.Spartito, measureIndex: number, argv: ParsedArgs): Promise<{ measure: starry.SpartitoMeasure; issue?: IssueMeasureInfo; stat: any; windowMeasureIndices: number[] }> => {
	const windowMeasureIndices = measureWindowIndices(measureIndex, spartito.measures.length);
	const target = spartito.measures[measureIndex];
	if (target?.events?.length === 0)
		return { measure: target, stat: { skipped: true, reason: "empty measure" }, windowMeasureIndices };
	const windowSpartito = cloneSpartito(spartito);
	windowSpartito.measures = windowMeasureIndices.map(index => windowSpartito.measures[index]);
	windowSpartito.measures.forEach((measure, index) => {
		measure.measureIndex = index;
		measure.voices = undefined;
	});

	const windowIssues: IssueMeasureInfo[] = [];
	const stat = await runRegulation(windowSpartito, argv, windowIssues);
	const localIndex = windowMeasureIndices.indexOf(measureIndex);
	const measure = windowSpartito.measures[localIndex];
	measure.measureIndex = measureIndex;
	const issue = windowIssues.find(item => item.measureIndex === localIndex);
	if (issue) {
		issue.measureIndex = measureIndex;
		issue.measure = measure;
	}
	return { measure, issue, stat, windowMeasureIndices };
};

// Image API for fetching staff images when local IMAGE_BED is unavailable
const IMAGE_API_BASE = process.env.IMAGE_API_BASE;

// API integration
const API_BASE = OMR_API_BASE;


// ── API helper ───────────────────────────────────────────────────────────────

const API_TIMEOUT_MS = 30_000;

/** Fetch JSON from the OMR service API. */
const apiFetch = async (endpoint: string, options: RequestInit = {}): Promise<any> => {
	const url = `${API_BASE}${endpoint}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
	const headers: Record<string, string> = { ...(options.headers as Record<string, string>) };
	if (options.body) headers["Content-Type"] = "application/json";
	try {
		const res = await fetch(url, { ...options, headers, signal: controller.signal });
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`API ${options.method ?? "GET"} ${endpoint} → ${res.status}: ${text.substring(0, 200)}`);
		}
		const json: any = await res.json();
		// Unwrap { code, data } envelope if present
		return json?.data !== undefined ? json.data : json;
	} finally {
		clearTimeout(timer);
	}
};


// ── Image helpers ────────────────────────────────────────────────────────────

export const resolveImageSource = (url: string): { type: "local"; path: string } | { type: "remote"; url: string } | null => {
	if (!url)
		return null;
	const match = url.match(/^(\w+):(.*)/);
	if (match?.[1] === "md5") {
		const filename = match[2];
		// Path traversal protection: reject filenames with directory components
		if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
			console.warn(`  resolveImageSource: rejecting suspicious md5 filename: ${filename}`);
			return null;
		}
		// Try local IMAGE_BED first
		if (IMAGE_BED) {
			const localPath = path.join(IMAGE_BED, filename);
			if (fs.existsSync(localPath))
				return { type: "local", path: localPath };
		}
		// Fallback to remote API
		if (IMAGE_API_BASE)
			return { type: "remote", url: `${IMAGE_API_BASE}/${filename}` };
		return null;
	}
	if (fs.existsSync(url))
		return { type: "local", path: url };
	return null;
};


/** Download a remote image to a local file. Returns null if already local. */
export const downloadImageToFile = async (
	source: { type: "local"; path: string } | { type: "remote"; url: string },
	destPath: string,
): Promise<string | null> => {
	if (source.type === "local")
		return source.path;
	try {
		const resp = await fetch(source.url);
		if (!resp.ok)
			return null;
		const buf = Buffer.from(await resp.arrayBuffer());
		fs.writeFileSync(destPath, buf);
		return destPath;
	}
	catch {
		return null;
	}
};


export const MEASURE_IMAGE_PADDING = 2; // interval units on each side

const FETCH_RETRIES = 3;
const FETCH_RETRY_DELAY = 500; // ms

export const fetchImageBuffer = async (
	source: { type: "local"; path: string } | { type: "remote"; url: string },
): Promise<Buffer | null> => {
	if (source.type === "local")
		return fs.readFileSync(source.path);
	for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
		try {
			const resp = await fetch(source.url);
			if (!resp.ok) {
				console.warn(`    fetch failed (${resp.status}): ${source.url} [attempt ${attempt}/${FETCH_RETRIES}]`);
				if (attempt < FETCH_RETRIES)
					await new Promise(r => setTimeout(r, FETCH_RETRY_DELAY * attempt));
				continue;
			}
			return Buffer.from(await resp.arrayBuffer());
		}
		catch (err: any) {
			console.warn(`    fetch error: ${source.url} — ${err.message} [attempt ${attempt}/${FETCH_RETRIES}]`);
			if (attempt < FETCH_RETRIES)
				await new Promise(r => setTimeout(r, FETCH_RETRY_DELAY * attempt));
		}
	}
	return null;
};

export const compositeMeasureImage = async (
	measure: starry.SpartitoMeasure,
	destPath: string,
): Promise<string | null> => {
	if (!measure.backgroundImages?.length || !measure.position)
		return null;

	const pos = measure.position;
	const bgImgs = measure.backgroundImages;

	// Measure crop range in unit coords
	const padUnits = MEASURE_IMAGE_PADDING;
	const cropLeftUnit = pos.left - padUnits;
	const cropRightUnit = pos.right + padUnits;

	// Process each staff image: crop to measure range
	const crops: { buffer: Buffer; width: number; height: number; yUnit: number; ppuY: number }[] = [];

	for (const bgImg of bgImgs) {
		const source = resolveImageSource(bgImg.url);
		if (!source)
			continue;

		const buf = await fetchImageBuffer(source);
		if (!buf)
			continue;

		const meta = await sharp(buf).metadata();
		if (!meta.width || !meta.height)
			continue;

		const imgPpu = meta.width / bgImg.position.width;

		// Crop coordinates in pixels (relative to this image)
		const leftPx = Math.max(0, Math.round((cropLeftUnit - bgImg.position.x) * imgPpu));
		const rightPx = Math.min(meta.width, Math.round((cropRightUnit - bgImg.position.x) * imgPpu));
		const w = rightPx - leftPx;
		if (w <= 0)
			continue;

		const cropped = await sharp(buf)
			.extract({ left: leftPx, top: 0, width: w, height: meta.height })
			.toBuffer();

		const ppuY = meta.height / bgImg.position.height;
		crops.push({ buffer: cropped, width: w, height: meta.height, yUnit: bgImg.position.y, ppuY });
	}

	if (crops.length === 0)
		return null;

	// Composite using y-offset from position data to handle overlapping staff images.
	// Background images are fixed-height windows centered on each staff, often with
	// significant overlap. Use their unit y-coordinates to place them correctly.
	const minY = Math.min(...crops.map(c => c.yUnit));
	const ppuY = crops[0].ppuY;
	const totalWidth = Math.max(...crops.map(c => c.width));
	const totalHeight = Math.round(Math.max(...crops.map(c => (c.yUnit - minY) * ppuY + c.height)));

	const compositeInputs: sharp.OverlayOptions[] = [];
	for (const crop of crops) {
		const top = Math.round((crop.yUnit - minY) * ppuY);
		compositeInputs.push({ input: crop.buffer, left: 0, top });
	}

	await sharp({
		create: { width: totalWidth, height: totalHeight, channels: 3, background: { r: 255, g: 255, b: 255 } },
	})
		.composite(compositeInputs)
		.webp({ quality: 90 })
		.toFile(destPath);

	return destPath;
};


// ── Measure data serialization ──────────────────────────────────────────────

export const serializeMeasureForAnnotation = (measure: starry.SpartitoMeasure) => {
	const events = measure.events.map((e, i) => ({
		index: i,
		id: e.id,
		staff: e.staff,
		x: e.x,
		ys: e.ys,
		rest: e.rest,
		division: e.division,
		dots: e.dots,
		grace: e.grace,
		beam: e.beam,
		stemDirection: e.stemDirection,
		tipY: e.tip ? e.tip.y : e.ys?.[0] ?? 0,
		tick: e.tick,
		timeWarp: e.timeWarp,
		tremolo: e.tremolo,
		tremoloLink: e.tremoloLink,
		feature: e.feature ? {
			divisions: e.feature.divisions,
			dots: e.feature.dots,
			grace: e.feature.grace,
			beams: e.feature.beams,
		} : undefined,
	}));

	const evaluation = measure.regulated ? starry.evaluateMeasure(measure) : undefined;

	return {
		measureIndex: measure.measureIndex,
		staffMask: measure.staffMask,
		timeSignature: measure.timeSignature,
		duration: measure.duration,
		voices: measure.voices,
		events,
		evaluation,
	};
};


// ── Fix processing ──────────────────────────────────────────────────────────

/** Validate that a parsed fix object has the required shape. */
const isValidFix = (fix: any): fix is Fix =>
	typeof fix?.measureIndex === "number"
	&& Array.isArray(fix.events)
	&& Array.isArray(fix.voices)
	&& typeof fix.duration === "number"
	&& typeof fix.status === "number";

const extractBalancedJsonObjects = (output: string): string[] => {
	const objects: string[] = [];
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < output.length; ++i) {
		const ch = output[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === "\"") inString = false;
			continue;
		}
		if (ch === "\"") {
			inString = true;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		}
		else if (ch === "}" && depth > 0) {
			depth--;
			if (depth === 0 && start >= 0) objects.push(output.slice(start, i + 1));
		}
	}
	return objects;
};

export const parseFixes = (output: string): Fix[] => {
	const jsonMatches = [...output.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?```/g)];
	for (const jsonMatch of jsonMatches.reverse()) {
		try {
			const parsed = JSON.parse(jsonMatch[1]);
			return parsed.fixes || [];
		}
		catch {}
	}

	try {
		const parsed = JSON.parse(output.trim());
		if (Array.isArray(parsed)) return parsed;
		return parsed.fixes || [];
	}
	catch {}

	for (const candidate of extractBalancedJsonObjects(output).reverse()) {
		if (!candidate.includes('"fixes"')) continue;
		try {
			const parsed = JSON.parse(candidate);
			return parsed.fixes || [];
		}
		catch {}
	}

	const fixObjects: any[] = [];
	const fixPattern = /\{\s*"measureIndex"\s*:\s*\d+[\s\S]*?"status"\s*:\s*-?\d+\s*\}/g;
	let match;
	while ((match = fixPattern.exec(output)) !== null) {
		try {
			fixObjects.push(JSON.parse(match[0]));
		}
		catch {}
	}
	if (fixObjects.length > 0) {
		console.log(`  Parsed ${fixObjects.length} fixes from truncated output`);
		return fixObjects;
	}

	console.warn("Failed to parse annotation fixes from output");
	return [];
};


/** Parse JSONL output from codex --json. Collects all agent_message texts and returns them concatenated. */
export const parseCodexJsonl = (output: string): { text: string; sessionId: string } => {
	const lines = output.trim().split("\n").filter(Boolean);
	const texts: string[] = [];
	let sessionId = "";

	for (const line of lines) {
		try {
			const event = JSON.parse(line);

			// codex JSONL: item.completed with item.type === "agent_message"
			if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
				texts.push(event.item.text);
			}

			// thread.started has thread_id (usable as session ID for resume)
			if (event.type === "thread.started" && event.thread_id) {
				sessionId = event.thread_id;
			}

			// Fallback: some formats use "result" directly
			if (event.result) {
				texts.push(event.result);
			}
		} catch {
			// Not JSON, might be raw text
		}
	}

	// Concatenate all message texts; if nothing parsed, fall back to raw output
	const text = texts.length > 0 ? texts.join("\n") : output;

	return { text, sessionId };
};


/** Merge a partial fix (from annotation agent) with the base solution from the original measure.
 *  Events in the fix override the base; events only in the base are preserved as-is. */
export const mergeWithBaseSolution = (measure: starry.SpartitoMeasure, fix: Partial<Fix> & { measureIndex: number }): any => {
	const base = measure.asSolution();
	if (!base) return fix;

	const fixEventMap = new Map<number, any>();
	if (fix.events) {
		for (const e of fix.events) fixEventMap.set(e.id, e);
	}

	const mergedEvents = base.events.map((baseEvent: any) => {
		const fixEvent = fixEventMap.get(baseEvent.id);
		if (fixEvent) return { ...baseEvent, ...fixEvent };
		return baseEvent;
	});

	return { ...base, ...fix, events: mergedEvents };
};


const writeImprovedSolutionCache = async (origin: starry.SpartitoMeasure, current: starry.SpartitoMeasure) => {
	const priority = -current?.solutionStat?.loss;
	const originSolution = current.asSolution(origin);
	if (originSolution)
		await solutionStore.set(origin.regulationHash0, { ...originSolution, priority });
	if (current.regulationHash !== origin.regulationHash0) {
		const currentSolution = current.asSolution();
		if (currentSolution)
			await solutionStore.set(current.regulationHash, { ...currentSolution, priority });
	}
};


export const applyFixes = async (spartito: starry.Spartito, fixes: Fix[]): Promise<Set<number>> => {
	const appliedIndices = new Set<number>();

	for (const fix of fixes) {
		const mi = fix.measureIndex;
		const measure = spartito.measures[mi];
		if (!measure) {
			console.warn(`Measure ${mi} not found, skipping fix`);
			continue;
		}

		if (!isValidFix(fix)) {
			console.warn(`  m${mi}: invalid fix shape, skipping`);
			continue;
		}

		const origin = new starry.SpartitoMeasure(measure);
		const evalBefore = starry.evaluateMeasure(measure);
		const twistBefore = evalBefore?.tickTwist ?? Infinity;
		const qualityBefore = evalBefore?.qualityScore ?? 0;
		const snapshot = measure.asSolution();

		const mergedFix = mergeWithBaseSolution(measure, fix);

		try {
			measure.applySolution(mergedFix);
		}
		catch (err: any) {
			console.warn(`  m${mi}: applySolution failed: ${err.message}`);
			if (snapshot) {
				try { measure.applySolution(snapshot); } catch {}
			}
			continue;
		}

		let evalAfter: any;
		try {
			evalAfter = starry.evaluateMeasure(measure);
		} catch (err: any) {
			console.warn(`  m${mi}: evaluateMeasure crashed after fix: ${err.message}, reverting`);
			if (snapshot) {
				try { measure.applySolution(snapshot); } catch {}
			}
			continue;
		}
		const twistAfter = evalAfter?.tickTwist ?? Infinity;
		const qualityAfter = evalAfter?.qualityScore ?? 0;
		const statusLabel = fix.status === 0 ? "Solved" : fix.status === -1 ? "Discard" : "Issue";
		const fineAfter = evalAfter?.fine ?? false;

		if (!fineAfter && snapshot) {
			try { measure.applySolution(snapshot); } catch {}
			const reason = evalAfter?.error
				? "introduced error"
				: `fine=false, tickTwist=${twistBefore.toFixed(3)}→${twistAfter.toFixed(3)}`;
			console.log(`  m${mi}: REVERTED (${reason})`);
			continue;
		}

		if (fineAfter && (qualityAfter > qualityBefore || !qualityBefore)) {
			try {
				await writeImprovedSolutionCache(origin, measure);
				console.log(`  m${mi}: solution cache updated, quality=${qualityBefore.toFixed(6)}→${qualityAfter.toFixed(6)}`);
			} catch (err: any) {
				console.warn(`  m${mi}: failed to update solution cache: ${err.message}`);
			}
		}

		appliedIndices.add(mi);
		console.log(`  m${mi}: ${statusLabel}, fine=${fineAfter}, error=${evalAfter?.error}, tickTwist=${twistBefore.toFixed(3)}→${twistAfter.toFixed(3)}`);
	}

	return appliedIndices;
};


// ── Main pipeline ───────────────────────────────────────────────────────────

export async function runAnnotationPipeline(backend: AnnotationBackend, argv: ParsedArgs): Promise<void> {
	const ANNOTATION_MODEL = argv.annotationModel || DEFAULT_ANNOTATION_MODEL;
	if (argv.preprocessRegulateOnly)
		argv.skipAnnotation = true;

	const inputPath = path.resolve(argv.input!);
	const outputPath = argv.output ? path.resolve(argv.output) : null;
	const scoreId = path.basename(inputPath).replace(/\.spartito\.json$/i, "").replace(/\.json$/i, "");

	if (!fs.existsSync(inputPath)) {
		console.error("Input file not found:", inputPath);
		process.exit(1);
	}

	// Read and deserialize spartito
	const content = fs.readFileSync(inputPath).toString();
	const spartito = starry.recoverJSON<starry.Spartito>(content, starry);

	console.log("Input:", inputPath);
	console.log("Measures:", spartito.measures.length);

	const alreadyRegulated = spartito.measures.some(m => m.regulated);

	// Collect issue measures
	const issueMeasures: IssueMeasureInfo[] = [];

	if (alreadyRegulated && argv.forceRegulate)
		console.log("Force per-measure re-regulation requested.");

	// ── Pre-annotation: fetch existing server annotations ────────────────────
	if (API_BASE && argv.fetchServer) {
		const hashes = spartito.measures
			.filter(m => m.regulated && m.regulationHash0)
			.map(m => m.regulationHash0!);

		if (hashes.length > 0) {
			try {
				const fetched: any[] = await apiFetch("/issueMeasures/batchGet", {
					method: "POST",
					body: JSON.stringify({ hashes }),
				});

				let serverResolved = 0;
				if (fetched?.length) {
					for (const remote of fetched) {
						if (!remote.hash || !remote.measure) continue;

						const localIdx = spartito.measures.findIndex(m => m.regulationHash0 === remote.hash);
						if (localIdx < 0) continue;

						if (remote.status === 0) {
							const serverMeasure = starry.recoverJSON(remote.measure, starry);
							spartito.measures[localIdx] = new starry.SpartitoMeasure(serverMeasure);
							serverResolved++;

							const issueIdx = issueMeasures.findIndex(im => im.measureIndex === spartito.measures[localIdx].measureIndex);
							if (issueIdx >= 0) issueMeasures.splice(issueIdx, 1);
						}
					}
					console.log(`\nServer: ${fetched.length} records fetched, ${serverResolved} solved measures applied`);
					if (serverResolved > 0)
						console.log(`Remaining issues: ${issueMeasures.length}`);
				}
			} catch (err: any) {
				console.warn("Failed to fetch server annotations:", err.message);
			}
		}
	}

	// ── Annotation phase ────────────────────────────────────────────────────

	// Filter by --measures if specified
	const measureFilter = parseMeasureFilter(argv.measures);
	if (measureFilter) {
		const before = issueMeasures.length;
		issueMeasures.splice(0, issueMeasures.length, ...issueMeasures.filter(m => measureFilter.has(m.measureIndex)));
		console.log(`\nFiltered measures: ${[...measureFilter].join(",")} (${before} → ${issueMeasures.length})`);
	}

	// Create log directory for agent phases when needed
	let runLogDir: string | undefined;
	if (true) {
		const resumeLogDir = argv.renew ? undefined : findLatestPreprocessCheckpointDir(inputPath);
		if (argv.preprocess && resumeLogDir) {
			runLogDir = resumeLogDir;
			console.log(`Log dir: ${runLogDir} (resuming preprocess checkpoints)`);
		} else {
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			runLogDir = path.join(regulationLogRoot(inputPath), timestamp);
			fs.mkdirSync(runLogDir, { recursive: true });
			console.log(`Log dir: ${runLogDir}${argv.renew ? " (renew)" : ""}`);
		}
	}

	// Track which measures were actually modified by annotation
	let annotatedMeasures = new Set<number>();

	if (true) {
		const preprocessEnabled = argv.preprocess && !!backend.callPreprocess;
		const annotationEnabled = !argv.skipAnnotation && !argv.preprocessRegulateOnly;
		if (argv.preprocess && !backend.callPreprocess)
			console.warn("Preprocessing requested, but backend does not support preprocessing; skipping preprocessing.");

		console.log(`\n--- Streaming Measure Pipeline ---`);
		const targets = (measureFilter
			? spartito.measures.filter(m => measureFilter.has(m.measureIndex) && m.events.length > 0).map(m => ({ measureIndex: m.measureIndex, status: 0, measure: m }))
			: spartito.measures.filter(m => m.events.length > 0).map(m => ({ measureIndex: m.measureIndex, status: 0, measure: m })))
			.sort((a, b) => a.measureIndex - b.measureIndex);
		console.log(`${targets.length} measures to ${preprocessEnabled ? "preprocess / " : ""}regulate${annotationEnabled ? " / annotate if needed" : ""}`);

		const midiContexts = readMidiMeasureContexts(argv.midi, argv.midiSegmentation);
		if (midiContexts.size > 0)
			console.log(`MIDI context loaded for ${midiContexts.size} measures. Image evidence takes precedence on conflicts.`);

		let totalPreprocessPatches = 0;
		let annotationCallIndex = 0;
		const maxRounds = argv.maxRounds!;
		const preprocessed = new Set<number>();
		const regulated = new Set<number>();
		const regulationStarted = new Set<number>();
		const annotationStarted = new Set<number>();
		const annotationCompleted = new Set<number>();
		const postPipelineIssues: IssueMeasureInfo[] = [];
		const runningRegulations: Promise<void>[] = [];
		const runningAnnotations: Promise<void>[] = [];
		const regulationConcurrency = Math.max(1, argv.regulationConcurrency || 1);
		const annotationConcurrency = Math.max(1, argv.annotationConcurrency || 1);
		let fastForwardEnd = -1;

		if (runLogDir && !argv.renew && !measureFilter) {
			const prePrefixEnd = preprocessEnabled ? contiguousCheckpointPrefixEnd(runLogDir, "pre", targets) : targets[0]?.measureIndex - 1;
			const regPrefixEnd = contiguousCheckpointPrefixEnd(runLogDir, "reg", targets);
			fastForwardEnd = Math.min(prePrefixEnd, regPrefixEnd);
			if (fastForwardEnd >= 0) {
				console.log(`Fast-forwarding sequential checkpoints through m${fastForwardEnd}.`);
				let restoredPre = 0, restoredPrePatches = 0, restoredReg = 0, restoredAnn = 0;
				for (const target of targets) {
					const mi = target.measureIndex;
					if (mi > fastForwardEnd) break;
					if (preprocessEnabled) {
						const checkpoint = readPreprocessCheckpoint(runLogDir, mi);
						if (checkpoint) {
							restoredPre++;
							restoredPrePatches += checkpoint.patches.length;
							applyPreprocessPatchesWithWarnings(spartito, checkpoint.patches);
						}
					}
					preprocessed.add(mi);
					const regulationCheckpoint = readRegulationCheckpoint(runLogDir, mi);
					if (regulationCheckpoint) {
						spartito.measures[mi] = recoverMeasure(regulationCheckpoint.measure);
						regulated.add(mi);
						regulationStarted.add(mi);
						restoredReg++;
						if (regulationCheckpoint.issue) postPipelineIssues.push({ measureIndex: mi, status: regulationCheckpoint.issue.status, measure: spartito.measures[mi] });
					}
				}
				for (const target of targets) {
					const mi = target.measureIndex;
					if (mi > fastForwardEnd) break;
					const annotationCheckpoint = readAnnotationCheckpoint(runLogDir, mi);
					if (!annotationCheckpoint) continue;
					restoredAnn++;
					annotationStarted.add(mi);
					annotationCompleted.add(mi);
					if (annotationCheckpoint.fixes.length > 0) {
						const appliedIndices = await applyFixes(spartito, annotationCheckpoint.fixes);
						annotatedMeasures = new Set([...annotatedMeasures, ...appliedIndices]);
					} else {
						annotatedMeasures = new Set([...annotatedMeasures, ...annotationCheckpoint.applied]);
					}
				}
				totalPreprocessPatches += restoredPrePatches;
				console.log(`Fast-forward restored ${restoredPre} preprocess checkpoints (${restoredPrePatches} patches), ${restoredReg} regulation checkpoints, ${restoredAnn} annotation checkpoints.`);
			}
		}

		const throttle = async (running: Promise<void>[], limit: number) => {
			while (running.length >= limit)
				await Promise.race(running);
		};

		const scheduleAnnotation = async (target: IssueMeasureInfo) => {
			const mi = target.measureIndex;
			if (!annotationEnabled || annotationStarted.has(mi) || annotationCompleted.has(mi)) return;
			const measure = spartito.measures[mi];
			if (!measure?.regulated || measure.events.length === 0) return;
			const ev = starry.evaluateMeasure(measure);
			if (!ev || ev.fine) {
				console.log(`m${mi}: fine after regulation; skip annotation.`);
				annotationCompleted.add(mi);
				return;
			}

			await throttle(runningAnnotations, annotationConcurrency);
			annotationStarted.add(mi);
			const task = (async () => {
				try {
					for (let round = 1; round <= maxRounds; ++round) {
						const currentMeasure = spartito.measures[mi];
						if (!currentMeasure?.regulated || currentMeasure.events.length === 0)
							break;
						const currentEval = starry.evaluateMeasure(currentMeasure);
						if (currentEval?.fine) {
							if (round > 1) console.log(`m${mi}: fine after annotation round ${round - 1}; stop annotation.`);
							break;
						}

						const annotationTarget = { measureIndex: currentMeasure.measureIndex, status: currentEval?.error ? 2 : 1, measure: currentMeasure };
						annotationCallIndex++;
						console.log(`m${mi}: annotation round ${round}/${maxRounds}`);
						const { fixes, failedMeasures } = await backend.callAnnotation([annotationTarget], spartito, annotationCallIndex, runLogDir);
						const failure = failedMeasures?.find(item => item.measureIndex === mi);
						if (failure) {
							console.warn(`m${mi}: annotation failed; skipping measure: ${failure.error}`);
							if (runLogDir)
								writeAnnotationCheckpoint(runLogDir, mi, [], new Set<number>(), { round, source: "agent", failed: true, error: failure.error, batchLabel: failure.batchLabel });
							break;
						}
						if (fixes.length === 0) {
							console.log(`m${mi}: no annotation fixes returned.`);
							if (runLogDir)
								writeAnnotationCheckpoint(runLogDir, mi, fixes, new Set<number>(), { round, source: "agent", noFixes: true });
							break;
						}

						console.log(`Applying ${fixes.length} fixes for m${mi}:`);
						const appliedIndices = await applyFixes(spartito, fixes);
						if (runLogDir)
							writeAnnotationCheckpoint(runLogDir, mi, fixes, appliedIndices, { round, source: "agent" });
						annotatedMeasures = new Set([...annotatedMeasures, ...appliedIndices]);
						console.log(`Applied ${appliedIndices.size} fixes for m${mi}.`);
						if (!appliedIndices.has(mi))
							break;
					}
				} finally {
					annotationCompleted.add(mi);
				}
			})();
			runningAnnotations.push(task);
			task.then(() => {
				const index = runningAnnotations.indexOf(task);
				if (index >= 0) runningAnnotations.splice(index, 1);
			}, () => {
				const index = runningAnnotations.indexOf(task);
				if (index >= 0) runningAnnotations.splice(index, 1);
			});
		};

		const scheduleRegulations = async (force = false) => {
			for (const target of targets) {
				const mi = target.measureIndex;
				if (regulated.has(mi) || regulationStarted.has(mi) || !preprocessed.has(mi)) continue;
				const nextIndex = targets.find(item => item.measureIndex > mi)?.measureIndex;
				if (!force && nextIndex !== undefined && !preprocessed.has(nextIndex)) continue;

				await throttle(runningRegulations, regulationConcurrency);
				regulationStarted.add(mi);
				const task = (async () => {
					const checkpoint = runLogDir && !argv.renew ? readRegulationCheckpoint(runLogDir, mi) : undefined;
					if (checkpoint) {
						spartito.measures[mi] = recoverMeasure(checkpoint.measure);
						regulated.add(mi);
						if (checkpoint.issue) postPipelineIssues.push({ measureIndex: mi, status: checkpoint.issue.status, measure: spartito.measures[mi] });
						console.log(`m${mi}: restored regulation from checkpoint.`);
						await scheduleAnnotation(target);
						return;
					}

					console.log(`m${mi}: regulating window [${measureWindowIndices(mi, spartito.measures.length).map(index => `m${index}`).join(", ")}]`);
					const result = await runRegulationMeasureWindow(spartito, mi, argv);
					spartito.measures[mi] = result.measure;
					regulated.add(mi);
					if (result.issue) postPipelineIssues.push(result.issue);
					if (runLogDir)
						writeRegulationCheckpoint(runLogDir, mi, result.measure, {
							windowMeasureIndices: result.windowMeasureIndices,
							issue: result.issue ? { measureIndex: mi, status: result.issue.status } : undefined,
							stat: result.stat,
						});
					await scheduleAnnotation(target);
				})();
				runningRegulations.push(task);
				task.then(() => {
					const index = runningRegulations.indexOf(task);
					if (index >= 0) runningRegulations.splice(index, 1);
				}, () => {
					const index = runningRegulations.indexOf(task);
					if (index >= 0) runningRegulations.splice(index, 1);
				});
			}
		};

		for (const target of targets) {
			if (target.measureIndex <= fastForwardEnd) continue;
			console.log(`\n--- Measure m${target.measureIndex} ---`);
			if (preprocessEnabled) {
				let patches: PreprocessPatch[];
				const checkpoint = runLogDir && !argv.renew ? readPreprocessCheckpoint(runLogDir, target.measureIndex) : undefined;
				if (checkpoint) {
					patches = checkpoint.patches;
					const applied = applyPreprocessPatchesWithWarnings(spartito, patches);
					console.log(`m${target.measureIndex}: restored ${patches.length} preprocessing patches from checkpoint (${applied} applied).`);
				} else {
					const result = await backend.callPreprocess!([target], spartito, runLogDir, midiContexts, argv.measureImages ? path.resolve(argv.measureImages) : undefined);
					patches = result.patches;
					const failure = result.failedMeasures?.find(item => item.measureIndex === target.measureIndex);
					if (runLogDir)
						writePreprocessCheckpoint(runLogDir, target.measureIndex, patches, {
							source: "agent",
							batchResults: result.batchResults,
							...(failure ? { failed: true, error: failure.error, batchLabel: failure.batchLabel } : {}),
						});
					if (failure) console.warn(`m${target.measureIndex}: preprocessing failed; continuing with empty patches: ${failure.error}`);
					console.log(`m${target.measureIndex}: preprocessing returned ${patches.length} patches.`);
				}
				totalPreprocessPatches += patches.length;
			}
			preprocessed.add(target.measureIndex);
			await scheduleRegulations();
		}
		await scheduleRegulations(true);
		await Promise.all([...runningRegulations]);
		await Promise.all([...runningAnnotations]);

		if (argv.preprocess)
			console.log(`\nStreaming preprocessing returned ${totalPreprocessPatches} patches.`);
		console.log(`Streaming regulation completed ${regulated.size}/${targets.length} measures, issue candidates: ${postPipelineIssues.length}.`);

		if (argv.preprocessRegulateOnly) {
			const solvedName = measureFilter ? "solved.partial.spartito.json" : "solved.spartito.json";
			const solvedPath = path.join(path.dirname(inputPath), solvedName);
			if (measureFilter)
				console.log("Partial measures requested; writing partial solved output.");
			fs.writeFileSync(solvedPath, JSON.stringify(spartito));
			console.log("Output:", solvedPath);
			return;
		}
	}
	if (true) {
		let solved = 0, issue = 0, fatal = 0;
		for (const m of spartito.measures) {
			if (m.events.length === 0)
				continue;
			const ev = starry.evaluateMeasure(m);
			if (!ev)
				continue;
			if (ev.error) fatal++;
			else if (!ev.fine) issue++;
			else solved++;
		}
		console.log(`\n--- Post-Annotation Stats ---`);
		console.log(`Solved: ${solved}, Issue: ${issue}, Fatal: ${fatal}`);

		try {
			const vizScript = path.join(__dirname, "visualize.ts");
			if (fs.existsSync(vizScript) && runLogDir) {
				const { execSync } = await import("child_process");
				const cmd = `npx tsx ${vizScript} ${runLogDir} --spartito ${inputPath}`;
				execSync(cmd, { stdio: "inherit", cwd: path.join(__dirname, "..", "..") });
			}
		} catch (err: any) {
			console.warn(`Visualization failed: ${err.message}`);
		}
	}

	// ── Post-annotation: save only annotated measures to API ──────────────────
	if (API_BASE && annotatedMeasures.size > 0) {
		console.log(`\n--- Saving to API (scoreId=${scoreId}, ${annotatedMeasures.size} annotated measures) ---`);
		let saved = 0, errors = 0;
		for (const mi of annotatedMeasures) {
			const m = spartito.measures[mi];
			if (!m?.regulated || !m.events?.length) continue;
			const ev = starry.evaluateMeasure(m);
			const status = !ev ? 1 : ev.error ? 2 : ev.fine ? 0 : 1;
			try {
				await apiFetch(`/scores/${scoreId}/issueMeasures`, {
					method: "PUT",
					body: JSON.stringify({
						measureIndex: m.measureIndex,
						measure: m.toJSON(),
						status,
						annotator: ANNOTATION_MODEL,
					}),
				});
				saved++;
			} catch (err: any) {
				console.warn(`  Failed to save measure ${m.measureIndex}: ${err.message}`);
				errors++;
			}
		}
		console.log(`Saved: ${saved} measures${errors > 0 ? ` (${errors} errors)` : ""}`);
	}

	// Write output (optional)
	if (outputPath) {
		fs.writeFileSync(outputPath, JSON.stringify(spartito));
		console.log("\nOutput:", outputPath);
	}
}
