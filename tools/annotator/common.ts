
import fs from "fs";
import os from "os";
import path from "path";
import fetch from "isomorphic-fetch";
import sharp from "sharp";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import "../../env";

import { ANNOTATION_API_KEY, ANNOTATION_BASE_URL, ANNOTATION_MAX_TOKENS, ANNOTATION_MODEL as DEFAULT_ANNOTATION_MODEL, BEAD_PICKER_URL, IMAGE_BED, OMR_API_BASE, ORT_SESSION_OPTIONS } from "../libs/constants";
import { starry, regulateWithBeadSolver } from "../libs/omr";
import OnnxBeadPicker from "../libs/onnxBeadPicker";
import remoteSolutionStore from "../libs/remoteSolutionStore";


// ── Re-exports for entry points ──────────────────────────────────────────────
export { starry, regulateWithBeadSolver };
export { ANNOTATION_API_KEY, ANNOTATION_BASE_URL, ANNOTATION_MAX_TOKENS, DEFAULT_ANNOTATION_MODEL, BEAD_PICKER_URL, IMAGE_BED, ORT_SESSION_OPTIONS };


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

export interface AnnotationBackend {
	callAnnotation(
		issues: IssueMeasureInfo[],
		spartito: starry.Spartito,
		round: number,
		logDir?: string,
	): Promise<{ fixes: Fix[]; batchResults: BatchResult[] }>;

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
	forceRegulate: boolean;
	annotationModel?: string;
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
				.option("force-regulate", { type: "boolean", describe: "Force re-regulation even if already regulated" })
				.option("annotation-model", { type: "string", describe: "Model for annotation (overrides ANNOTATION_MODEL env)" })
				.option("max-rounds", { type: "number", default: 1, describe: "Max annotation rounds" })
				.option("measures", { type: "string", describe: "Comma-separated measure indices to annotate (e.g. '16,70,83')" })
			,
		).help().argv;

	return argv as unknown as ParsedArgs;
};


// ── Constants ────────────────────────────────────────────────────────────────

const PICKER_SEQS = [32, 64, 128, 512];

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

export const parseFixes = (output: string): Fix[] => {
	// Try to extract JSON block from markdown code fence
	const jsonMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[1]);
			return parsed.fixes || [];
		}
		catch {}
	}

	// Fallback: try to parse the entire output as JSON
	try {
		const parsed = JSON.parse(output.trim());
		return parsed.fixes || [];
	}
	catch {}

	// Fallback: find the last complete { ... } block that contains "fixes"
	// Use non-greedy to prefer smaller matches first, then pick the one with "fixes"
	const braceMatch = output.match(/\{[^{}]*"fixes"\s*:\s*\[[\s\S]*?\]\s*\}/)
		|| output.match(/\{[\s\S]*"fixes"\s*:\s*\[[\s\S]*?\]\s*\}/);
	if (braceMatch) {
		try {
			const parsed = JSON.parse(braceMatch[0]);
			return parsed.fixes || [];
		}
		catch {}
	}

	// Fallback for truncated output: extract individual fix objects
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


export const applyFixes = (spartito: starry.Spartito, fixes: Fix[]): Set<number> => {
	const appliedIndices = new Set<number>();

	for (const fix of fixes) {
		const mi = fix.measureIndex;
		const measure = spartito.measures[mi];
		if (!measure) {
			console.warn(`Measure ${mi} not found, skipping fix`);
			continue;
		}

		// Basic fix validation
		if (!isValidFix(fix)) {
			console.warn(`  m${mi}: invalid fix shape, skipping`);
			continue;
		}

		// Evaluate before fix
		const evalBefore = starry.evaluateMeasure(measure);
		const twistBefore = evalBefore?.tickTwist ?? Infinity;

		// Save original solution for rollback
		const snapshot = measure.asSolution();

		// Merge partial fix with base solution so events not in fix keep their ticks
		const mergedFix = mergeWithBaseSolution(measure, fix);

		// Apply fix as RegulationSolution (includes postRegulate)
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
		const statusLabel = fix.status === 0 ? "Solved" : fix.status === -1 ? "Discard" : "Issue";

		// Decide whether to keep the fix:
		// - Accept only if fine=true after fix
		// - Revert otherwise (fine=false means the fix didn't solve the problem)
		const fineAfter = evalAfter?.fine ?? false;

		if (!fineAfter && snapshot) {
			try { measure.applySolution(snapshot); } catch {}
			const reason = evalAfter?.error
				? "introduced error"
				: `fine=false, tickTwist=${twistBefore.toFixed(3)}→${twistAfter.toFixed(3)}`;
			console.log(`  m${mi}: REVERTED (${reason})`);
			continue;
		}

		appliedIndices.add(mi);
		console.log(`  m${mi}: ${statusLabel}, fine=${fineAfter}, error=${evalAfter?.error}, tickTwist=${twistBefore.toFixed(3)}→${twistAfter.toFixed(3)}`);
	}

	return appliedIndices;
};


// ── Main pipeline ───────────────────────────────────────────────────────────

export async function runAnnotationPipeline(backend: AnnotationBackend, argv: ParsedArgs): Promise<void> {
	const ANNOTATION_MODEL = argv.annotationModel || DEFAULT_ANNOTATION_MODEL;

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

	// Check if already regulated
	const alreadyRegulated = spartito.measures.some(m => m.regulated);

	// Collect issue measures
	const issueMeasures: IssueMeasureInfo[] = [];

	if (!alreadyRegulated || argv.forceRegulate) {
		if (alreadyRegulated)
			console.log("Force re-regulation requested.");

		// Load bead picker models
		const loadings = [] as Promise<void>[];
		const pickers = PICKER_SEQS.map(n_seq => new OnnxBeadPicker(BEAD_PICKER_URL.replace(/seq\d+/, `seq${n_seq}`), {
			n_seq,
			usePivotX: true,
			onLoad: promise => loadings.push(promise.catch(err => console.warn("error to load BeadPicker:", err))),
			sessionOptions: ORT_SESSION_OPTIONS,
		}));

		await Promise.all(loadings);

		// Create dummy score wrapper
		const dummyScore = {
			assemble () {},
			makeSpartito () { return spartito },
			assignBackgroundForMeasure (_: starry.SpartitoMeasure) {},
		} as starry.Score;

		// Run regulation
		const stat = await regulateWithBeadSolver(dummyScore, {
			logger: argv.logger ? console : undefined,
			pickers,
			solutionStore: remoteSolutionStore,
			onSaveIssueMeasure: (data) => {
				issueMeasures.push({
					measureIndex: data.measureIndex,
					status: data.status,
					measure: data.measure,
				});
			},
		});

		// Print regulation stats
		console.log("\n--- Regulation Stats ---");
		console.log("measures:", `(${stat.measures.cached})${stat.measures.simple}->${stat.measures.solved}->${stat.measures.issue}->${stat.measures.fatal}/${spartito.measures.length}`);
		console.log("qualityScore:", spartito.qualityScore);
		console.log("totalCost:", stat.totalCost, "ms");
		console.log("pickerCost:", stat.pickerCost, "ms");
	}
	else {
		console.log("Spartito already regulated, skipping regulation (use --force-regulate to override).");

		// Collect issue measures from existing regulation
		for (const m of spartito.measures) {
			if (!m.regulated || m.events.length === 0)
				continue;
			const ev = starry.evaluateMeasure(m);
			if (ev && !ev.fine) {
				issueMeasures.push({
					measureIndex: m.measureIndex,
					status: ev.error ? 2 : 1,
					measure: m,
				});
			}
		}

		console.log(`\n--- Existing Regulation ---`);
		const solved = spartito.measures.filter(m => m.regulated && m.events.length > 0 && starry.evaluateMeasure(m)?.fine).length;
		console.log(`Solved: ${solved}, Issue: ${issueMeasures.filter(m => m.status === 1).length}, Fatal: ${issueMeasures.filter(m => m.status === 2).length}`);
	}

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
	const measureFilter = argv.measures ? new Set(argv.measures.split(",").map(Number)) : null;
	if (measureFilter) {
		const before = issueMeasures.length;
		issueMeasures.splice(0, issueMeasures.length, ...issueMeasures.filter(m => measureFilter.has(m.measureIndex)));
		console.log(`\nFiltered measures: ${[...measureFilter].join(",")} (${before} → ${issueMeasures.length})`);
	}

	// Track which measures were actually modified by annotation
	let annotatedMeasures = new Set<number>();

	if (!argv.skipAnnotation && issueMeasures.length > 0) {
		console.log(`\n--- Annotation Phase ---`);
		console.log(`${issueMeasures.length} issue measures to annotate`);
		console.log(`Model: ${ANNOTATION_MODEL}`);

		// Create log directory for this run
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const inputBasename = path.basename(inputPath, ".spartito.json");
		const runLogDir = path.join(__dirname, "..", "..", "logs", `${timestamp}_${inputBasename}`);
		fs.mkdirSync(runLogDir, { recursive: true });
		console.log(`Log dir: ${runLogDir}`);

		const maxRounds = argv.maxRounds!;

		for (let round = 1; round <= maxRounds; round++) {
			// Re-evaluate which measures still need annotation
			const currentIssues = round === 1
				? issueMeasures
				: spartito.measures
					.filter(m => {
						if (!m.regulated || m.events.length === 0)
							return false;
						const ev = starry.evaluateMeasure(m);
						return ev && !ev.fine;
					})
					.map(m => ({ measureIndex: m.measureIndex, status: 1, measure: m }));

			if (currentIssues.length === 0) {
				console.log("All issue measures resolved!");
				break;
			}

			console.log(`\nRound ${round}/${maxRounds}: ${currentIssues.length} measures to annotate`);

			// Call backend for annotation
			const { fixes, batchResults } = await backend.callAnnotation(currentIssues, spartito, round, runLogDir);

			if (fixes.length === 0) {
				console.log("No fixes returned, stopping annotation.");
				break;
			}

			// Apply fixes
			console.log(`\nApplying ${fixes.length} fixes:`);
			const appliedIndices = applyFixes(spartito, fixes);
			annotatedMeasures = new Set([...annotatedMeasures, ...appliedIndices]);
			console.log(`Applied ${appliedIndices.size} fixes.`);

			// Post-apply summaries: only for batches where fixes actually achieved fine=true
			for (const br of batchResults) {
				const anyFixed = br.measureIndices.some(mi => {
					const ev = starry.evaluateMeasure(spartito.measures[mi]);
					return ev && ev.fine;
				});
				if (!anyFixed) continue;

				const fixedIndices = br.measureIndices.filter(mi => {
					const ev = starry.evaluateMeasure(spartito.measures[mi]);
					return ev && ev.fine;
				});

				const summaryPrompt = [
					`The following measures were successfully fixed (fine=true): ${fixedIndices.map(i => "m" + i).join(", ")}.`,
					"Based on your annotation experience just now, please provide a brief summary:",
					"1. Which principles in the system prompt were most helpful for your annotation work?",
					"2. What additional guidelines or tips would you suggest adding to the system prompt that are not currently covered?",
					"3. What common patterns or pitfalls did you encounter during this annotation session?",
					"Keep it concise and actionable.",
				].join("\n");

				console.log(`  Requesting summary for ${fixedIndices.map(i => "m" + i).join(",")}...`);
				const summaryText = await backend.requestSummary(br, summaryPrompt);

				if (summaryText) {
					console.log("\n  ── Agent Summary ──");
					console.log(summaryText.split("\n").map((l: string) => "  " + l).join("\n"));
					console.log("  ──────────────────\n");

					if (runLogDir) {
						const summaryFile = path.join(runLogDir, `r${round}_summary_m${fixedIndices.join("_")}.txt`);
						fs.writeFileSync(summaryFile, summaryText);
					}
				}
			}
		}

		// Final evaluation
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

		// Auto-visualize logs
		try {
			const vizScript = path.join(__dirname, "visualize.ts");
			if (fs.existsSync(vizScript)) {
				const { execSync } = await import("child_process");
				const cmd = `npx tsx ${vizScript} ${runLogDir} --spartito ${inputPath}`;
				execSync(cmd, { stdio: "inherit", cwd: path.join(__dirname, "..", "..") });
			}
		} catch (err: any) {
			console.warn(`Visualization failed: ${err.message}`);
		}
	}
	else if (issueMeasures.length === 0) {
		console.log("\nNo issue measures found, skipping annotation.");
	}
	else {
		console.log(`\nSkipping annotation (${issueMeasures.length} issue measures).`);
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
