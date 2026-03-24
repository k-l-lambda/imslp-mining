
import fs from "fs";
import path from "path";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import { parseFixes, parseCodexJsonl, compositeMeasureImage, starry, regulateWithBeadSolver, BEAD_PICKER_URL, ORT_SESSION_OPTIONS } from "./common";
import type { Fix, FixEvent } from "./common";
import OnnxBeadPicker from "../libs/onnxBeadPicker";
import remoteSolutionStore from "../libs/remoteSolutionStore";

import "../../env";


// ── Types ────────────────────────────────────────────────────────────────────

interface PromptEvent {
	index: number;
	id: number;
	staff: number;
	x: number;
	ys: number[];
	rest: any;
	division: number;
	dots: number;
	grace: any;
	beam: string | null;
	stemDirection: string;
	tick: number;
	timeWarp?: any;
	feature?: any;
}

interface PromptMeasure {
	measureIndex: number;
	staffMask: number;
	timeSignature: { numerator: number; denominator: number };
	duration: number;
	voices: number[][];
	events: PromptEvent[];
	evaluation?: any;
	// Parsed from header
	status?: number;
	error?: boolean;
	fine?: boolean;
	tickTwist?: number;
}

interface EvaluateFixCall {
	arguments: any;
	beforeText: string;
	afterText: string;
	resultText: string;
}

interface MeasureReport {
	measureIndex: number;
	prompt: PromptMeasure;
	backgroundBase64?: string;
	fix?: Fix;
	fixStatus?: string;
	evaluateFixCalls: EvaluateFixCall[];
	summaryText?: string;
}

interface LogReport {
	scoreId: string;
	backend: "claude" | "codex";
	timestamp: string;
	logDir: string;
	measures: MeasureReport[];
}


// ── Color functions (golden-ratio HSV, ported from ScoreCluster.vue) ─────────

function hsvToHex(h: number, s: number, v: number): string {
	h = ((h % 360) + 360) % 360;
	s = s / 100;
	v = v / 100;
	const c = v * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = v - c;
	let r: number, g: number, b: number;
	if (h < 60) { r = c; g = x; b = 0; }
	else if (h < 120) { r = x; g = c; b = 0; }
	else if (h < 180) { r = 0; g = c; b = x; }
	else if (h < 240) { r = 0; g = x; b = c; }
	else if (h < 300) { r = x; g = 0; b = c; }
	else { r = c; g = 0; b = x; }
	const toHex = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function voiceColor(i: number): string {
	const GOLDEN = (3 - Math.sqrt(5)) / 2;
	const phase = ((GOLDEN * i) % 1 + 1) % 1;
	const sat = (1 - Math.tanh(i * 0.05)) * 100;
	return hsvToHex(phase * 360, sat, 80);
}

const UNVOICED_COLOR = "#ccc";


// ── Prompt parsing ───────────────────────────────────────────────────────────

function parsePromptFile(text: string): PromptMeasure[] {
	const measures: PromptMeasure[] = [];
	// Split on "--- Measure N (...) ---"
	const parts = text.split(/^--- Measure /m);
	for (let i = 1; i < parts.length; i++) {
		const part = parts[i];
		// Parse header line: "28 (status=1, error=false, fine=false, tickTwist=0.006) ---"
		const headerMatch = part.match(/^(\d+)\s*\(([^)]*)\)\s*---/);
		if (!headerMatch) continue;

		const measureIndex = parseInt(headerMatch[1]);
		const headerParams = headerMatch[2];

		// Extract header fields
		const statusMatch = headerParams.match(/status=(\d+)/);
		const errorMatch = headerParams.match(/error=(true|false)/);
		const fineMatch = headerParams.match(/fine=(true|false)/);
		const twistMatch = headerParams.match(/tickTwist=([\d.]+)/);

		// Extract JSON block
		const jsonMatch = part.match(/```json\s*\n([\s\S]*?)\n```/);
		if (!jsonMatch) continue;

		try {
			const data = JSON.parse(jsonMatch[1]) as PromptMeasure;
			data.status = statusMatch ? parseInt(statusMatch[1]) : undefined;
			data.error = errorMatch ? errorMatch[1] === "true" : undefined;
			data.fine = fineMatch ? fineMatch[1] === "true" : undefined;
			data.tickTwist = twistMatch ? parseFloat(twistMatch[1]) : undefined;
			measures.push(data);
		} catch {
			console.warn(`  Failed to parse JSON for measure ${measureIndex}`);
		}
	}
	return measures;
}


// ── Backend detection & output parsing ───────────────────────────────────────

function detectBackend(files: string[]): "claude" | "codex" {
	if (files.some(f => f.endsWith(".jsonl"))) return "codex";
	return "claude";
}

function parseClaudeOutput(raw: string): { resultText: string; fixes: Fix[] } {
	// Claude output is a JSON array of messages or a single JSON object
	try {
		const parsed = JSON.parse(raw);
		// Format: array with {type, content} or single object with .result
		if (Array.isArray(parsed)) {
			// Look for the last assistant message with text
			const texts: string[] = [];
			for (const item of parsed) {
				if (item.type === "assistant" && item.message?.content) {
					for (const block of item.message.content) {
						if (block.type === "text" && block.text) texts.push(block.text);
					}
				}
				if (item.type === "result" && item.result) texts.push(item.result);
			}
			const resultText = texts.join("\n");
			return { resultText, fixes: parseFixes(resultText) };
		}
		if (parsed.result) {
			return { resultText: parsed.result, fixes: parseFixes(parsed.result) };
		}
		const text = JSON.stringify(parsed);
		return { resultText: text, fixes: parseFixes(text) };
	} catch {
		return { resultText: raw, fixes: parseFixes(raw) };
	}
}

function parseCodexJsonlFull(raw: string): { resultText: string; fixes: Fix[]; evaluateFixCalls: EvaluateFixCall[] } {
	const { text, sessionId } = parseCodexJsonl(raw);
	const fixes = parseFixes(text);
	const evaluateFixCalls: EvaluateFixCall[] = [];

	// Extract evaluate_fix MCP tool calls with results
	const lines = raw.trim().split("\n").filter(Boolean);
	for (const line of lines) {
		try {
			const event = JSON.parse(line);
			if (event.type === "item.completed" && event.item?.type === "mcp_tool_call" && event.item?.tool === "evaluate_fix") {
				const resultContent = event.item.result?.content;
				const resultText = Array.isArray(resultContent)
					? resultContent.map((c: any) => c.text || "").join("\n")
					: (typeof resultContent === "string" ? resultContent : "");

				// Parse BEFORE/AFTER from result text
				const beforeMatch = resultText.match(/BEFORE[^:]*:\s*(.*)/);
				const afterMatch = resultText.match(/AFTER[^:]*:\s*(.*)/);

				evaluateFixCalls.push({
					arguments: event.item.arguments,
					beforeText: beforeMatch ? beforeMatch[1].trim() : "",
					afterText: afterMatch ? afterMatch[1].trim() : "",
					resultText,
				});
			}
		} catch {}
	}

	return { resultText: text, fixes, evaluateFixCalls };
}


// ── Merge events with fix ────────────────────────────────────────────────────

interface MergedEvent extends PromptEvent {
	voiceIndex: number;
	fixApplied: boolean;
}

function mergeEventsWithFix(promptMeasure: PromptMeasure, fix?: Fix): { events: MergedEvent[]; voices: number[][] } {
	const voices = fix?.voices ?? promptMeasure.voices;
	const fixEventMap = new Map<number, FixEvent>();
	if (fix?.events) {
		for (const e of fix.events) fixEventMap.set(e.id, e);
	}

	// Build voice lookup: eventId -> voiceIndex
	const voiceLookup = new Map<number, number>();
	for (let vi = 0; vi < voices.length; vi++) {
		for (const eid of voices[vi]) voiceLookup.set(eid, vi);
	}

	const events: MergedEvent[] = promptMeasure.events.map(pe => {
		const fe = fixEventMap.get(pe.id);
		const merged: MergedEvent = {
			...pe,
			voiceIndex: voiceLookup.get(pe.id) ?? -1,
			fixApplied: !!fe,
		};
		if (fe) {
			if (fe.tick !== undefined) merged.tick = fe.tick;
			if (fe.division !== undefined) merged.division = fe.division;
			if (fe.dots !== undefined) merged.dots = fe.dots;
			if (fe.beam !== undefined) merged.beam = fe.beam;
			if (fe.grace !== undefined) merged.grace = fe.grace;
		}
		return merged;
	});

	return { events, voices };
}


// ── SVG topology generation ──────────────────────────────────────────────────

interface SvgOptions {
	width?: number;
	title?: string;
}

function generateTopologySvg(
	events: MergedEvent[],
	voices: number[][],
	duration: number,
	timeSig: { numerator: number; denominator: number },
	options: SvgOptions = {},
): string {
	const W = options.width ?? 600;
	const MARGIN_LEFT = 40;
	const MARGIN_RIGHT = 20;
	const MARGIN_TOP = 30;
	const STAFF_HEIGHT = 60;
	const STAFF_GAP = 20;
	const LEGEND_HEIGHT = 24;
	const STAFF_LINE_COUNT = 5;
	const STAFF_LINE_SPAN = 40; // pixels for 5 lines

	// Determine staves
	const staffSet = new Set(events.map(e => e.staff));
	const staves = [...staffSet].sort();
	const staffCount = staves.length || 1;

	const plotWidth = W - MARGIN_LEFT - MARGIN_RIGHT;
	const plotHeight = staffCount * STAFF_HEIGHT + (staffCount - 1) * STAFF_GAP;
	const totalH = MARGIN_TOP + plotHeight + 20 + LEGEND_HEIGHT;

	// Staff Y center for each staff index
	const staffY = (staffIdx: number): number => {
		const i = staves.indexOf(staffIdx);
		if (i < 0) return MARGIN_TOP + STAFF_HEIGHT / 2;
		return MARGIN_TOP + i * (STAFF_HEIGHT + STAFF_GAP) + STAFF_HEIGHT / 2;
	};

	// Tick to X
	const tickToX = (tick: number): number => {
		if (duration <= 0) return MARGIN_LEFT;
		return MARGIN_LEFT + (tick / duration) * plotWidth;
	};

	// Ys offset within staff (pitch position, smaller = higher)
	const ysToOffset = (ys: number[]): number => {
		if (!ys?.length) return 0;
		const avg = ys.reduce((a, b) => a + b, 0) / ys.length;
		return avg * 3; // scale: each step ~3px
	};

	const lines: string[] = [];
	lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}">`);
	lines.push(`<rect width="${W}" height="${totalH}" fill="white"/>`);

	// Title
	if (options.title) {
		lines.push(`<text x="${W / 2}" y="14" text-anchor="middle" font-size="11" font-weight="bold" fill="#333">${escXml(options.title)}</text>`);
	}

	// Draw staff lines
	for (const si of staves) {
		const cy = staffY(si);
		const lineSpacing = STAFF_LINE_SPAN / (STAFF_LINE_COUNT - 1);
		const topLine = cy - STAFF_LINE_SPAN / 2;
		for (let l = 0; l < STAFF_LINE_COUNT; l++) {
			const y = topLine + l * lineSpacing;
			lines.push(`<line x1="${MARGIN_LEFT}" y1="${y}" x2="${W - MARGIN_RIGHT}" y2="${y}" stroke="#ddd" stroke-width="0.5"/>`);
		}
		// Staff label
		lines.push(`<text x="${MARGIN_LEFT - 4}" y="${cy + 4}" text-anchor="end" font-size="9" fill="#999">S${si}</text>`);
	}

	// Beat grid (dashed vertical lines)
	const beatTicks = 1920 / timeSig.denominator;
	for (let beat = 0; beat <= timeSig.numerator; beat++) {
		const tick = beat * beatTicks;
		if (tick > duration) break;
		const x = tickToX(tick);
		lines.push(`<line x1="${x}" y1="${MARGIN_TOP}" x2="${x}" y2="${MARGIN_TOP + plotHeight}" stroke="#eee" stroke-width="${beat === 0 || tick === duration ? 1 : 0.5}" stroke-dasharray="${beat === 0 || tick === duration ? "" : "3,3"}"/>`);
		if (beat < timeSig.numerator) {
			lines.push(`<text x="${x + 2}" y="${MARGIN_TOP - 3}" font-size="7" fill="#bbb">${beat + 1}</text>`);
		}
	}

	// Beam connections: draw lines between Open→Continue→Close events within each voice
	for (let vi = 0; vi < voices.length; vi++) {
		const voiceEvents = events
			.filter(e => e.voiceIndex === vi && e.beam)
			.sort((a, b) => a.tick - b.tick);

		const color = voiceColor(vi);
		let beamGroup: MergedEvent[] = [];

		for (const e of voiceEvents) {
			if (e.beam === "Open") {
				beamGroup = [e];
			} else if (e.beam === "Continue" || e.beam === "Close") {
				beamGroup.push(e);
				if (e.beam === "Close") {
					// Draw beam group
					for (let j = 0; j < beamGroup.length - 1; j++) {
						const a = beamGroup[j];
						const b = beamGroup[j + 1];
						const ax = tickToX(a.tick);
						const ay = staffY(a.staff) + ysToOffset(a.ys);
						const bx = tickToX(b.tick);
						const by = staffY(b.staff) + ysToOffset(b.ys);
						lines.push(`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${color}" stroke-width="2" opacity="0.5"/>`);
					}
					beamGroup = [];
				}
			}
		}
		// Broken beam (no Close) — still draw what we have
		if (beamGroup.length > 1) {
			for (let j = 0; j < beamGroup.length - 1; j++) {
				const a = beamGroup[j];
				const b = beamGroup[j + 1];
				const ax = tickToX(a.tick);
				const ay = staffY(a.staff) + ysToOffset(a.ys);
				const bx = tickToX(b.tick);
				const by = staffY(b.staff) + ysToOffset(b.ys);
				lines.push(`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${color}" stroke-width="2" opacity="0.3" stroke-dasharray="3,2"/>`);
			}
		}
	}

	// Draw events
	for (const e of events) {
		const x = tickToX(e.tick);
		const y = staffY(e.staff) + ysToOffset(e.ys);
		const color = e.voiceIndex >= 0 ? voiceColor(e.voiceIndex) : UNVOICED_COLOR;
		const isRest = e.rest !== null && e.rest !== undefined;
		const isGrace = e.grace !== null && e.grace !== undefined && e.grace !== false;
		const r = isGrace ? 3 : 5;
		const opacity = isGrace ? 0.6 : 1;

		if (isRest) {
			lines.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${color}" stroke-width="1.5" opacity="${opacity}"/>`);
		} else {
			lines.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="${opacity}"/>`);
		}

		// Event ID label
		lines.push(`<text x="${x}" y="${y - r - 2}" text-anchor="middle" font-size="7" fill="#666">${e.id}</text>`);

		// Mark fixed events with a small dot
		if (e.fixApplied) {
			lines.push(`<circle cx="${x + r + 2}" cy="${y - r}" r="1.5" fill="#e44"/>`);
		}
	}

	// Legend
	const legendY = MARGIN_TOP + plotHeight + 14;
	let legendX = MARGIN_LEFT;
	for (let vi = 0; vi < voices.length; vi++) {
		const color = voiceColor(vi);
		lines.push(`<rect x="${legendX}" y="${legendY - 6}" width="10" height="10" fill="${color}" rx="2"/>`);
		const label = `V${vi} [${voices[vi].join(",")}]`;
		lines.push(`<text x="${legendX + 13}" y="${legendY + 3}" font-size="8" fill="#555">${label}</text>`);
		legendX += 13 + label.length * 5 + 8;
	}

	lines.push("</svg>");
	return lines.join("\n");
}

function escXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}


// ── Background image generation ──────────────────────────────────────────────

const PICKER_SEQS = [32, 64, 128, 512];

async function loadSpartito(spartitoPath: string, skipRegulate = false): Promise<starry.Spartito> {
	const content = fs.readFileSync(spartitoPath).toString();
	const spartito = starry.recoverJSON<starry.Spartito>(content, starry);

	if (!skipRegulate && !spartito.measures.some(m => m.regulated)) {
		console.log("Regulating spartito...");
		const loadings: Promise<void>[] = [];
		const pickers = PICKER_SEQS.map(n_seq => new OnnxBeadPicker(BEAD_PICKER_URL.replace(/seq\d+/, `seq${n_seq}`), {
			n_seq,
			usePivotX: true,
			onLoad: (promise: Promise<void>) => loadings.push(promise.catch(err => console.warn("error to load BeadPicker:", err))),
			sessionOptions: ORT_SESSION_OPTIONS,
		}));
		await Promise.all(loadings);

		const dummyScore = {
			assemble() {},
			makeSpartito() { return spartito; },
			assignBackgroundForMeasure(_: starry.SpartitoMeasure) {},
		} as starry.Score;

		await regulateWithBeadSolver(dummyScore, {
			pickers,
			solutionStore: remoteSolutionStore,
		});
	}

	return spartito;
}

async function generateMeasureBackgroundBase64(
	spartito: starry.Spartito,
	measureIndex: number,
	tmpDir: string,
): Promise<string | null> {
	const measure = spartito.measures[measureIndex];
	if (!measure) return null;

	const destPath = path.join(tmpDir, `m${measureIndex}.webp`);
	const result = await compositeMeasureImage(measure, destPath);
	if (!result) return null;

	const buf = fs.readFileSync(destPath);
	return `data:image/webp;base64,${buf.toString("base64")}`;
}


// ── Log directory scanning ───────────────────────────────────────────────────

interface LogBatch {
	round: number;
	batch: number;
	promptFile: string;
	outputFile: string;
	stderrFile?: string;
}

function scanLogDir(logDir: string): { batches: LogBatch[]; summaries: Map<string, string>; backend: "claude" | "codex" } {
	const files = fs.readdirSync(logDir);
	const backend = detectBackend(files);

	const batches: LogBatch[] = [];
	const summaries = new Map<string, string>();

	// Match r{R}_b{B}_prompt.txt
	const promptPattern = /^r(\d+)_b(\d+)_prompt\.txt$/;
	for (const f of files) {
		const m = f.match(promptPattern);
		if (!m) continue;
		const round = parseInt(m[1]);
		const batch = parseInt(m[2]);
		const ext = backend === "codex" ? ".jsonl" : ".json";
		const outputFile = `r${round}_b${batch}${ext}`;
		if (!files.includes(outputFile)) continue;

		const stderrFile = `r${round}_b${batch}.stderr.txt`;
		batches.push({
			round, batch,
			promptFile: path.join(logDir, f),
			outputFile: path.join(logDir, outputFile),
			stderrFile: files.includes(stderrFile) ? path.join(logDir, stderrFile) : undefined,
		});
	}

	// Summaries: r{R}_summary_m{N}.txt
	const summaryPattern = /^r(\d+)_summary_m(.+)\.txt$/;
	for (const f of files) {
		const m = f.match(summaryPattern);
		if (!m) continue;
		const indices = m[2]; // e.g. "28" or "28_30"
		summaries.set(indices, fs.readFileSync(path.join(logDir, f), "utf-8"));
	}

	batches.sort((a, b) => a.round - b.round || a.batch - b.batch);
	return { batches, summaries, backend };
}


// ── Markdown report rendering ────────────────────────────────────────────────

function renderMarkdownReport(report: LogReport): string {
	const lines: string[] = [];
	lines.push(`# Annotation Report: ${report.scoreId}`);
	lines.push(`- **Backend**: ${report.backend}`);
	lines.push(`- **Timestamp**: ${report.timestamp}`);
	lines.push(`- **Log dir**: \`${report.logDir}\``);
	lines.push("");

	for (const mr of report.measures) {
		lines.push(`## Measure ${mr.measureIndex}`);
		lines.push("");

		// Background image
		if (mr.backgroundBase64) {
			lines.push(`![background](${mr.backgroundBase64})`);
			lines.push("");
		}

		const pm = mr.prompt;
		const evalFields = pm.evaluation
			? `fine=${pm.evaluation.fine}, error=${pm.evaluation.error}, tickTwist=${(pm.evaluation.tickTwist ?? 0).toFixed(3)}, beamBroken=${pm.evaluation.beamBroken}, qualityScore=${(pm.evaluation.qualityScore ?? 0).toFixed(3)}`
			: `fine=${pm.fine}, error=${pm.error}, tickTwist=${(pm.tickTwist ?? 0).toFixed(3)}`;

		// BEFORE
		lines.push(`### Before (status=${pm.status ?? "?"})`);
		lines.push(`| ${evalFields} |`);
		lines.push("");

		const { events: beforeEvents, voices: beforeVoices } = mergeEventsWithFix(pm);
		lines.push(generateTopologySvg(beforeEvents, beforeVoices, pm.duration, pm.timeSignature, { title: `Before — M${mr.measureIndex}` }));
		lines.push("");

		// FIX (AFTER)
		if (mr.fix) {
			const statusLabel = mr.fix.status === 0 ? "Solved" : mr.fix.status === -1 ? "Discard" : `Issue(${mr.fix.status})`;
			lines.push(`### Fix (status=${mr.fix.status} ${statusLabel})`);
			lines.push(`Voices: ${JSON.stringify(mr.fix.voices)}`);
			lines.push("");

			const { events: afterEvents, voices: afterVoices } = mergeEventsWithFix(pm, mr.fix);
			lines.push(generateTopologySvg(afterEvents, afterVoices, mr.fix.duration || pm.duration, pm.timeSignature, { title: `After — M${mr.measureIndex}` }));
			lines.push("");
		} else {
			lines.push("### Fix");
			lines.push("_No fix produced._");
			lines.push("");
		}

		// Evaluate fix attempts (Codex)
		if (mr.evaluateFixCalls.length > 0) {
			lines.push("### Evaluate Fix Attempts");
			lines.push("");
			for (let i = 0; i < mr.evaluateFixCalls.length; i++) {
				const call = mr.evaluateFixCalls[i];
				lines.push(`**Attempt ${i + 1}**`);
				lines.push("");
				lines.push("```");
				lines.push(call.resultText);
				lines.push("```");
				lines.push("");

				// Try to render SVG for this attempt
				if (call.arguments) {
					try {
						const attemptFix: Fix = {
							measureIndex: pm.measureIndex,
							events: call.arguments.events || [],
							voices: call.arguments.voices || pm.voices,
							duration: call.arguments.duration || pm.duration,
							status: 0,
						};
						const { events: attemptEvents, voices: attemptVoices } = mergeEventsWithFix(pm, attemptFix);
						lines.push(generateTopologySvg(attemptEvents, attemptVoices, attemptFix.duration, pm.timeSignature, { title: `Attempt ${i + 1}`, width: 500 }));
						lines.push("");
					} catch {}
				}
			}
		}

		// Summary
		if (mr.summaryText) {
			lines.push("### Agent Feedback");
			lines.push("");
			for (const line of mr.summaryText.split("\n")) {
				lines.push(`> ${line}`);
			}
			lines.push("");
		}

		lines.push("---");
		lines.push("");
	}

	return lines.join("\n");
}


// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	const argv = yargs(hideBin(process.argv))
		.command("$0 <logDir>", "Visualize annotation logs as Markdown with SVG topology diagrams", y => y
			.positional("logDir", { type: "string", demandOption: true, describe: "Path to annotation log directory" })
			.option("spartito", { type: "string", describe: "Path to .spartito.json for background images" })
			.option("o", { alias: "output", type: "string", describe: "Output markdown file path" })
			.option("no-images", { type: "boolean", default: false, describe: "Skip background image generation" })
			.option("svg-width", { type: "number", default: 600, describe: "SVG diagram width" })
		)
		.help()
		.argv as any;

	const logDir = path.resolve(argv.logDir);
	if (!fs.existsSync(logDir)) {
		console.error("Log directory not found:", logDir);
		process.exit(1);
	}

	// Extract score ID and timestamp from dir name
	const dirName = path.basename(logDir);
	const dirMatch = dirName.match(/^(\d{4}-\d{2}-\d{2}T[\d-]+)_(.+)$/);
	const timestamp = dirMatch ? dirMatch[1] : dirName;
	const scoreId = dirMatch ? dirMatch[2] : dirName;

	console.log(`Scanning log directory: ${logDir}`);
	const { batches, summaries, backend } = scanLogDir(logDir);
	console.log(`Backend: ${backend}, ${batches.length} batches found`);

	// Load spartito for background images
	let spartito: starry.Spartito | null = null;
	if (argv.spartito && !argv["no-images"]) {
		try {
			console.log(`Loading spartito: ${argv.spartito}`);
			spartito = await loadSpartito(path.resolve(argv.spartito), true);
			console.log(`Spartito loaded: ${spartito.measures.length} measures`);
		} catch (err: any) {
			console.warn(`Failed to load spartito: ${err.message}`);
		}
	}

	// Temp dir for background images
	const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "viz-"));

	// Process batches
	const measureReports = new Map<number, MeasureReport>();

	for (const batch of batches) {
		console.log(`Processing r${batch.round}_b${batch.batch}...`);

		// Parse prompt
		const promptText = fs.readFileSync(batch.promptFile, "utf-8");
		const promptMeasures = parsePromptFile(promptText);

		// Parse output
		const outputRaw = fs.readFileSync(batch.outputFile, "utf-8");
		let fixes: Fix[] = [];
		let evaluateFixCalls: EvaluateFixCall[] = [];

		if (backend === "codex") {
			const result = parseCodexJsonlFull(outputRaw);
			fixes = result.fixes;
			evaluateFixCalls = result.evaluateFixCalls;
		} else {
			const result = parseClaudeOutput(outputRaw);
			fixes = result.fixes;
		}

		// Match fixes to prompt measures
		for (const pm of promptMeasures) {
			const mi = pm.measureIndex;
			const fix = fixes.find(f => f.measureIndex === mi);

			// Filter evaluate_fix calls for this measure
			const mCalls = evaluateFixCalls.filter(c => c.arguments?.measureIndex === mi);

			// Find summary
			const summaryKey = [...summaries.keys()].find(k => k.split("_").includes(String(mi)));
			const summaryText = summaryKey ? summaries.get(summaryKey) : undefined;

			// Background image
			let backgroundBase64: string | undefined;
			if (spartito && !argv["no-images"]) {
				try {
					backgroundBase64 = (await generateMeasureBackgroundBase64(spartito, mi, tmpDir)) ?? undefined;
				} catch {}
			}

			// Merge if already exists from previous round
			const existing = measureReports.get(mi);
			if (existing) {
				// Later round overrides
				if (fix) existing.fix = fix;
				if (mCalls.length) existing.evaluateFixCalls.push(...mCalls);
				if (summaryText) existing.summaryText = summaryText;
				if (backgroundBase64) existing.backgroundBase64 = backgroundBase64;
			} else {
				measureReports.set(mi, {
					measureIndex: mi,
					prompt: pm,
					fix,
					evaluateFixCalls: mCalls,
					summaryText,
					backgroundBase64,
				});
			}
		}
	}

	// Build report
	const report: LogReport = {
		scoreId,
		backend,
		timestamp,
		logDir,
		measures: [...measureReports.values()].sort((a, b) => a.measureIndex - b.measureIndex),
	};

	const markdown = renderMarkdownReport(report);

	// Output
	const outputPath = argv.o || path.join(logDir, "report.md");
	fs.writeFileSync(outputPath, markdown);
	console.log(`Report written to: ${outputPath}`);
	console.log(`${report.measures.length} measures visualized`);

	// Cleanup tmp
	try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
