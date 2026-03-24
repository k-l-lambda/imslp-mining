
import fs from "fs";
import path from "path";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import { parseFixes, parseCodexJsonl, compositeMeasureImage, starry, regulateWithBeadSolver, BEAD_PICKER_URL, ORT_SESSION_OPTIONS } from "./common";
import type { Fix, FixEvent } from "./common";
import { SYSTEM_PROMPT } from "./prompt";
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

/** A single turn in the agent conversation */
interface ConversationTurn {
	role: "system" | "assistant" | "user" | "result";
	thinking?: string;
	text?: string;
	toolUse?: { name: string; input: any };
	toolResult?: string;
	imageData?: string; // base64 image in tool result
	model?: string;
	usage?: any;
	costUSD?: number;
	durationMs?: number;
	attachedSvg?: string; // SVG to render inline after this turn
}

interface MeasureReport {
	measureIndex: number;
	prompt: PromptMeasure;
	backgroundBase64?: string;
	fix?: Fix;
	evaluateFixCalls: EvaluateFixCall[];
	summaryText?: string;
	conversation: ConversationTurn[];
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
	const parts = text.split(/^--- Measure /m);
	for (let i = 1; i < parts.length; i++) {
		const part = parts[i];
		const headerMatch = part.match(/^(\d+)\s*\(([^)]*)\)\s*---/);
		if (!headerMatch) continue;
		const measureIndex = parseInt(headerMatch[1]);
		const headerParams = headerMatch[2];
		const statusMatch = headerParams.match(/status=(\d+)/);
		const errorMatch = headerParams.match(/error=(true|false)/);
		const fineMatch = headerParams.match(/fine=(true|false)/);
		const twistMatch = headerParams.match(/tickTwist=([\d.]+)/);
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

/** Parse Claude JSON output into conversation turns + fixes */
function parseClaudeOutput(raw: string): { conversation: ConversationTurn[]; fixes: Fix[]; evaluateFixCalls: EvaluateFixCall[] } {
	const conversation: ConversationTurn[] = [];
	const evaluateFixCalls: EvaluateFixCall[] = [];
	const allTexts: string[] = [];

	try {
		const items = JSON.parse(raw);
		if (!Array.isArray(items)) {
			// Single result object
			const text = items.result || JSON.stringify(items);
			allTexts.push(text);
			conversation.push({ role: "result", text });
			return { conversation, fixes: parseFixes(text), evaluateFixCalls };
		}

		for (const item of items) {
			if (item.type === "system") {
				const parts: string[] = [];
				if (item.model) parts.push(`Model: ${item.model}`);
				if (item.cwd) parts.push(`CWD: ${item.cwd}`);
				if (item.session_id) parts.push(`Session: ${item.session_id}`);
				if (item.tools?.length) parts.push(`Tools: ${item.tools.join(", ")}`);
				if (item.mcp_servers?.length) parts.push(`MCP: ${item.mcp_servers.map((s: any) => `${s.name}(${s.status})`).join(", ")}`);
				conversation.push({
					role: "system",
					text: parts.join("\n"),
					model: item.model,
				});
				continue;
			}

			if (item.type === "assistant" && item.message?.content) {
				for (const block of item.message.content) {
					if (block.type === "thinking" && block.thinking) {
						conversation.push({ role: "assistant", thinking: block.thinking, model: item.message.model });
					}
					if (block.type === "text" && block.text) {
						conversation.push({ role: "assistant", text: block.text, model: item.message.model });
						allTexts.push(block.text);
					}
					if (block.type === "tool_use") {
						conversation.push({ role: "assistant", toolUse: { name: block.name, input: block.input }, model: item.message.model });

						// Collect evaluate_fix calls
						if (block.name === "mcp__measure-quality__evaluate_fix") {
							evaluateFixCalls.push({
								arguments: block.input,
								beforeText: "",
								afterText: "",
								resultText: "", // filled when we see the result
							});
						}
					}
				}
				continue;
			}

			if (item.type === "user" && item.message?.content) {
				for (const block of item.message.content) {
					if (block.type === "tool_result") {
						let resultText = "";
						let imageData: string | undefined;
						const content = block.content;
						if (Array.isArray(content)) {
							for (const c of content) {
								if (c.type === "text") resultText += c.text;
								if (c.type === "image") imageData = c.source?.data;
							}
						} else if (typeof content === "string") {
							resultText = content;
						}
						conversation.push({ role: "user", toolResult: resultText, imageData });

						// Fill evaluate_fix result text
						if (resultText && evaluateFixCalls.length > 0) {
							const lastCall = evaluateFixCalls[evaluateFixCalls.length - 1];
							if (!lastCall.resultText) {
								lastCall.resultText = resultText;
								const beforeMatch = resultText.match(/BEFORE[^:]*:\s*(.*)/);
								const afterMatch = resultText.match(/AFTER[^:]*:\s*(.*)/);
								lastCall.beforeText = beforeMatch ? beforeMatch[1].trim() : "";
								lastCall.afterText = afterMatch ? afterMatch[1].trim() : "";
							}
						}
					}
				}
				continue;
			}

			if (item.type === "result") {
				conversation.push({
					role: "result",
					text: item.result,
					costUSD: item.total_cost_usd,
					durationMs: item.duration_ms,
					usage: item.usage,
				});
				if (item.result) allTexts.push(item.result);
			}
		}
	} catch {
		allTexts.push(raw);
		conversation.push({ role: "result", text: raw });
	}

	const resultText = allTexts.join("\n");
	return { conversation, fixes: parseFixes(resultText), evaluateFixCalls };
}

/** Parse Codex JSONL output into conversation turns + fixes + evaluate_fix calls */
function parseCodexJsonlFull(raw: string): { conversation: ConversationTurn[]; fixes: Fix[]; evaluateFixCalls: EvaluateFixCall[] } {
	const conversation: ConversationTurn[] = [];
	const evaluateFixCalls: EvaluateFixCall[] = [];
	const allTexts: string[] = [];
	const lines = raw.trim().split("\n").filter(Boolean);

	for (const line of lines) {
		try {
			const event = JSON.parse(line);

			if (event.type === "thread.started") {
				conversation.push({ role: "system", text: `Thread: ${event.thread_id}` });
				continue;
			}

			if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
				conversation.push({ role: "assistant", text: event.item.text });
				allTexts.push(event.item.text);
				continue;
			}

			if (event.type === "item.completed" && event.item?.type === "mcp_tool_call") {
				const tool = event.item.tool;
				const args = event.item.arguments;
				const resultContent = event.item.result?.content;
				const resultText = Array.isArray(resultContent)
					? resultContent.map((c: any) => c.text || "").join("\n")
					: (typeof resultContent === "string" ? resultContent : "");

				conversation.push({ role: "assistant", toolUse: { name: `mcp:${event.item.server}/${tool}`, input: args } });
				if (resultText) {
					conversation.push({ role: "user", toolResult: resultText });
				}

				if (tool === "evaluate_fix") {
					const beforeMatch = resultText.match(/BEFORE[^:]*:\s*(.*)/);
					const afterMatch = resultText.match(/AFTER[^:]*:\s*(.*)/);
					evaluateFixCalls.push({
						arguments: args,
						beforeText: beforeMatch ? beforeMatch[1].trim() : "",
						afterText: afterMatch ? afterMatch[1].trim() : "",
						resultText,
					});
				}
				continue;
			}

			if (event.type === "turn.completed" && event.usage) {
				conversation.push({ role: "result", usage: event.usage });
				continue;
			}

			if (event.type === "item.completed" && event.item?.type === "error") {
				conversation.push({ role: "system", text: `Error: ${event.item.message}` });
			}
		} catch {}
	}

	const { text } = parseCodexJsonl(raw);
	return { conversation, fixes: parseFixes(text), evaluateFixCalls };
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

const CURVE_ANGLE = -Math.PI / 3;

/** Quadratic Bezier arrow path from SvgArrow.vue */
function bezierPath(sx: number, sy: number, tx: number, ty: number): { path: string; cx: number; cy: number } {
	const dx = tx - sx;
	const dy = ty - sy;
	const cosB = Math.cos(CURVE_ANGLE);
	const sinB = Math.sin(CURVE_ANGLE);
	const cx = sx + (dx * cosB - dy * sinB) * 0.4;
	const cy = sy + (dx * sinB + dy * cosB) * 0.4;
	return { path: `M ${sx} ${sy} Q ${cx} ${cy} ${tx} ${ty}`, cx, cy };
}

/** Arrow tip polygon points, rotated to face from source to target */
function arrowTip(tx: number, ty: number, sx: number, sy: number, scale: number = 6): string {
	const dx = tx - sx;
	const dy = ty - sy;
	const angle = Math.atan2(dy, dx) + 24 * Math.PI / 180;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	// Triangle: tip at (0,0), two points behind
	const points = [
		[0, 0],
		[-scale, scale * 0.35],
		[-scale * 0.65, 0],
	];
	return points.map(([px, py]) => {
		const rx = px * cos - py * sin + tx;
		const ry = px * sin + py * cos + ty;
		return `${rx.toFixed(1)},${ry.toFixed(1)}`;
	}).join(" ");
}

/** Draw a note symbol: head + stem + flags/beam stubs. */
function drawNote(
	x: number, y: number, e: MergedEvent, color: string, lines: string[],
	opts: { lineSpacing: number; isBeamed: boolean },
): void {
	const { lineSpacing, isBeamed } = opts;
	const isRest = e.rest !== null && e.rest !== undefined;
	const isGrace = e.grace !== null && e.grace !== undefined && e.grace !== false;
	const scale = isGrace ? 0.6 : 1;
	const opacity = isGrace ? 0.6 : 1;
	const headRx = 5 * scale;
	const headRy = 3.5 * scale;
	const division = e.division ?? 2;
	const stemDir = e.stemDirection === "d" ? 1 : -1; // 1=down, -1=up
	const stemLen = 3.5 * lineSpacing * scale; // 3.5 staff spaces

	if (isRest) {
		// Rest: filled rectangle
		const s = 4 * scale;
		lines.push(`<rect x="${x - s}" y="${y - s}" width="${s * 2}" height="${s * 2}" fill="${color}" opacity="${opacity}" rx="1"/>`);
	} else {
		// Note heads — draw one per ys value (chord support)
		const ys = e.ys?.length ? e.ys : [0];
		const primaryYs = ys[0];
		for (const yVal of ys) {
			const headY = y + (yVal - primaryYs) * lineSpacing;
			const filled = division >= 2;
			if (filled) {
				lines.push(`<ellipse cx="${x}" cy="${headY}" rx="${headRx}" ry="${headRy}" fill="${color}" opacity="${opacity}" transform="rotate(-15 ${x} ${headY})"/>`);
			} else {
				lines.push(`<ellipse cx="${x}" cy="${headY}" rx="${headRx}" ry="${headRy}" fill="white" stroke="${color}" stroke-width="1.5" opacity="${opacity}" transform="rotate(-15 ${x} ${headY})"/>`);
			}
		}

		// Stem (division >= 1, i.e. half note or shorter)
		if (division >= 1) {
			const stemX = stemDir === -1 ? x + headRx - 0.5 : x - headRx + 0.5;
			const stemEndY = y + stemDir * stemLen;
			lines.push(`<line x1="${stemX}" y1="${y}" x2="${stemX}" y2="${stemEndY}" stroke="${color}" stroke-width="1.2" opacity="${opacity}"/>`);

			if (isBeamed && e.beam && division >= 3) {
				// Beam stubs: short local lines at stem tip (like ScoreCluster ├ ┼ ┤)
				const beamCount = division - 2;
				const stubLen = 8 * scale;
				const flagYDir = -stemDir; // stack toward note head
				for (let bl = 0; bl < beamCount; bl++) {
					const by = stemEndY + flagYDir * bl * 3.5;
					let x1 = stemX, x2 = stemX;
					if (e.beam === "Open")    { x2 = stemX + stubLen; }       // ├ extends right
					else if (e.beam === "Close") { x1 = stemX - stubLen; }    // ┤ extends left
					else /* Continue */        { x1 = stemX - stubLen / 2; x2 = stemX + stubLen / 2; } // ┼ both
					lines.push(`<line x1="${x1}" y1="${by}" x2="${x2}" y2="${by}" stroke="${color}" stroke-width="2.5" opacity="0.8"/>`);
				}
			} else if (!isBeamed && !e.beam && division >= 3) {
				// Flags: curved tails for non-beamed notes
				const flagCount = division - 2;
				const flagYDir = -stemDir;
				for (let f = 0; f < flagCount; f++) {
					const fy = stemEndY + flagYDir * f * 4;
					lines.push(`<path d="M ${stemX} ${fy} Q ${stemX + 8 * scale} ${fy + flagYDir * 8 * scale} ${stemX + 3 * scale} ${fy + flagYDir * 12 * scale}" fill="none" stroke="${color}" stroke-width="1.2" opacity="${opacity}"/>`);
				}
			}
		}
	}

	// Dots — only when actually > 0
	if (e.dots > 0) {
		for (let d = 0; d < e.dots; d++) {
			lines.push(`<circle cx="${x + headRx + 3 + d * 4}" cy="${y - 1}" r="1.2" fill="${color}" opacity="${opacity}"/>`);
		}
	}

	// Event ID label
	const labelY = isRest ? y - 4 * scale - 5 : y - headRy - 4;
	lines.push(`<text x="${x}" y="${labelY}" text-anchor="middle" font-size="7" fill="#666">${e.id}</text>`);

	// Fix marker — use × to avoid confusion with augmentation dots
	if (e.fixApplied) {
		lines.push(`<text x="${x + headRx + 2}" y="${labelY + 1}" font-size="7" fill="#e44" font-weight="bold">×</text>`);
	}

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
	const STAFF_HEIGHT = 70;
	const STAFF_GAP = 24;
	const LEGEND_HEIGHT = 24;
	const STAFF_LINE_COUNT = 5;
	const STAFF_LINE_SPAN = 40;

	const staffSet = new Set(events.map(e => e.staff));
	const staves = [...staffSet].sort();
	const staffCount = staves.length || 1;
	const plotWidth = W - MARGIN_LEFT - MARGIN_RIGHT;
	const plotHeight = staffCount * STAFF_HEIGHT + (staffCount - 1) * STAFF_GAP;
	const totalH = MARGIN_TOP + plotHeight + 20 + LEGEND_HEIGHT;

	const lineSpacing = STAFF_LINE_SPAN / (STAFF_LINE_COUNT - 1); // 10px per staff unit

	const staffY = (staffIdx: number): number => {
		const i = staves.indexOf(staffIdx);
		if (i < 0) return MARGIN_TOP + STAFF_HEIGHT / 2;
		return MARGIN_TOP + i * (STAFF_HEIGHT + STAFF_GAP) + STAFF_HEIGHT / 2;
	};
	const tickToX = (tick: number): number => {
		if (duration <= 0) return MARGIN_LEFT;
		return MARGIN_LEFT + (tick / duration) * plotWidth;
	};

	const lines: string[] = [];
	lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}">`);
	lines.push(`<rect width="${W}" height="${totalH}" fill="white"/>`);

	// Arrow marker defs
	lines.push(`<defs>`);
	for (let vi = 0; vi < voices.length; vi++) {
		const c = voiceColor(vi);
		lines.push(`<marker id="ah${vi}" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="${c}" opacity="0.6"/></marker>`);
	}
	lines.push(`</defs>`);

	if (options.title) {
		lines.push(`<text x="${W / 2}" y="14" text-anchor="middle" font-size="11" font-weight="bold" fill="#333">${escXml(options.title)}</text>`);
	}

	// Staff lines
	for (const si of staves) {
		const cy = staffY(si);
		const lineSpacing = STAFF_LINE_SPAN / (STAFF_LINE_COUNT - 1);
		const topLine = cy - STAFF_LINE_SPAN / 2;
		for (let l = 0; l < STAFF_LINE_COUNT; l++) {
			const y = topLine + l * lineSpacing;
			lines.push(`<line x1="${MARGIN_LEFT}" y1="${y}" x2="${W - MARGIN_RIGHT}" y2="${y}" stroke="#ddd" stroke-width="0.5"/>`);
		}
		lines.push(`<text x="${MARGIN_LEFT - 4}" y="${cy + 4}" text-anchor="end" font-size="9" fill="#999">S${si}</text>`);
	}

	// Beat grid
	const beatTicks = 1920 / timeSig.denominator;
	for (let beat = 0; beat <= timeSig.numerator; beat++) {
		const tick = beat * beatTicks;
		if (tick > duration) break;
		const x = tickToX(tick);
		const isEdge = beat === 0 || tick === duration;
		lines.push(`<line x1="${x}" y1="${MARGIN_TOP}" x2="${x}" y2="${MARGIN_TOP + plotHeight}" stroke="#eee" stroke-width="${isEdge ? 1 : 0.5}" stroke-dasharray="${isEdge ? "" : "3,3"}"/>`);
		if (beat < timeSig.numerator) {
			lines.push(`<text x="${x + 2}" y="${MARGIN_TOP - 3}" font-size="7" fill="#bbb">${beat + 1}</text>`);
		}
	}

	// Build event position lookup (ys[0] in staff-line units → pixel offset)
	const eventPos = new Map<number, { x: number; y: number }>();
	for (const e of events) {
		const primaryYs = e.ys?.length ? e.ys[0] : 0;
		eventPos.set(e.id, { x: tickToX(e.tick), y: staffY(e.staff) + primaryYs * lineSpacing });
	}

	// Collect beamed event IDs (any event with beam !== null)
	const beamedIds = new Set<number>();
	for (const e of events) {
		if (e.beam) beamedIds.add(e.id);
	}

	// Voice connections: quadratic Bezier curves with arrows between adjacent events
	for (let vi = 0; vi < voices.length; vi++) {
		const voiceEventIds = voices[vi];
		if (voiceEventIds.length < 2) continue;

		const color = voiceColor(vi);

		// Sort events in this voice by tick
		const sorted = voiceEventIds
			.map(id => events.find(e => e.id === id))
			.filter((e): e is MergedEvent => !!e)
			.sort((a, b) => a.tick - b.tick || a.index - b.index);

		for (let j = 0; j < sorted.length - 1; j++) {
			const a = sorted[j];
			const b = sorted[j + 1];
			const ap = eventPos.get(a.id)!;
			const bp = eventPos.get(b.id)!;

			const { path: d } = bezierPath(ap.x, ap.y, bp.x, bp.y);
			lines.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.45" marker-end="url(#ah${vi})"/>`);
		}
	}

	// Draw events (notes/rests)
	for (const e of events) {
		const pos = eventPos.get(e.id)!;
		const color = e.voiceIndex >= 0 ? voiceColor(e.voiceIndex) : UNVOICED_COLOR;
		drawNote(pos.x, pos.y, e, color, lines, { lineSpacing, isBeamed: beamedIds.has(e.id) });
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
			n_seq, usePivotX: true,
			onLoad: (promise: Promise<void>) => loadings.push(promise.catch(err => console.warn("error to load BeadPicker:", err))),
			sessionOptions: ORT_SESSION_OPTIONS,
		}));
		await Promise.all(loadings);
		const dummyScore = {
			assemble() {},
			makeSpartito() { return spartito; },
			assignBackgroundForMeasure(_: starry.SpartitoMeasure) {},
		} as starry.Score;
		await regulateWithBeadSolver(dummyScore, { pickers, solutionStore: remoteSolutionStore });
	}
	return spartito;
}

async function generateMeasureBackgroundBase64(spartito: starry.Spartito, measureIndex: number, tmpDir: string): Promise<string | null> {
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

	const summaryPattern = /^r(\d+)_summary_m(.+)\.txt$/;
	for (const f of files) {
		const m = f.match(summaryPattern);
		if (!m) continue;
		summaries.set(m[2], fs.readFileSync(path.join(logDir, f), "utf-8"));
	}

	batches.sort((a, b) => a.round - b.round || a.batch - b.batch);
	return { batches, summaries, backend };
}


// ── Conversation rendering ───────────────────────────────────────────────────

function renderConversation(turns: ConversationTurn[]): string {
	const out: string[] = [];

	for (const turn of turns) {
		if (turn.role === "system") {
			const text = turn.text || "";
			const lines = text.split("\n");
			if (lines.length > 10) {
				// Long system prompt — collapsible
				const preview = escMd(lines[0]);
				out.push(`<details><summary><b>[System]</b> ${preview}…</summary>`);
				out.push("");
				out.push(text);
				out.push("");
				out.push(`</details>`);
			} else {
				out.push(`**[System Init]**`);
				out.push("");
				for (const line of lines) {
					out.push(`> ${escMd(line)}`);
				}
			}
			out.push("");
			continue;
		}

		if (turn.role === "assistant") {
			if (turn.thinking) {
				out.push(`<details><summary><i>💭 Thinking</i></summary>`);
				out.push("");
				out.push("```");
				out.push(turn.thinking);
				out.push("```");
				out.push("");
				out.push(`</details>`);
				out.push("");
			}
			if (turn.text) {
				out.push(`**[Assistant]**`);
				out.push("");
				out.push(turn.text);
				out.push("");
			}
			if (turn.toolUse) {
				const argStr = JSON.stringify(turn.toolUse.input, null, 2);
				out.push(`**[Tool Call]** \`${turn.toolUse.name}\``);
				out.push(`<details><summary>Arguments</summary>`);
				out.push("");
				out.push("```json");
				out.push(argStr.length > 2000 ? argStr.substring(0, 2000) + "\n..." : argStr);
				out.push("```");
				out.push("");
				out.push(`</details>`);
				out.push("");
			}
			if (turn.attachedSvg) {
				out.push(turn.attachedSvg);
				out.push("");
			}
			continue;
		}

		if (turn.role === "user") {
			if (turn.toolResult) {
				out.push(`**[Tool Result]**`);
				out.push("```");
				out.push(turn.toolResult.length > 2000 ? turn.toolResult.substring(0, 2000) + "\n..." : turn.toolResult);
				out.push("```");
				out.push("");
			}
			if (turn.attachedSvg) {
				out.push(turn.attachedSvg);
				out.push("");
			}
			if (turn.imageData) {
				out.push(`![tool-result-image](data:image/webp;base64,${turn.imageData})`);
				out.push("");
			}
			continue;
		}

		if (turn.role === "result") {
			const parts: string[] = [];
			if (turn.durationMs) parts.push(`${(turn.durationMs / 1000).toFixed(1)}s`);
			if (turn.costUSD) parts.push(`$${turn.costUSD.toFixed(4)}`);
			if (turn.usage?.input_tokens) parts.push(`${turn.usage.input_tokens} in`);
			if (turn.usage?.output_tokens) parts.push(`${turn.usage.output_tokens} out`);
			if (parts.length) {
				out.push(`> **[Result]** ${parts.join(", ")}`);
				out.push("");
			}
		}
	}

	return out.join("\n");
}

function escMd(s: string): string {
	return s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

		const pm = mr.prompt;
		const evalFields = pm.evaluation
			? `fine=${pm.evaluation.fine}, error=${pm.evaluation.error}, tickTwist=${(pm.evaluation.tickTwist ?? 0).toFixed(3)}, beamBroken=${pm.evaluation.beamBroken}, qualityScore=${(pm.evaluation.qualityScore ?? 0).toFixed(3)}`
			: `fine=${pm.fine}, error=${pm.error}, tickTwist=${(pm.tickTwist ?? 0).toFixed(3)}`;

		// Pre-generate SVGs
		const { events: beforeEvents, voices: beforeVoices } = mergeEventsWithFix(pm);
		const beforeSvg = generateTopologySvg(beforeEvents, beforeVoices, pm.duration, pm.timeSignature, { title: `Before — M${mr.measureIndex}` });
		let afterSvg: string | undefined;
		let afterHeader = "";
		if (mr.fix) {
			const statusLabel = mr.fix.status === 0 ? "Solved" : mr.fix.status === -1 ? "Discard" : `Issue(${mr.fix.status})`;
			afterHeader = `**Fix (status=${mr.fix.status} ${statusLabel})** Voices: ${JSON.stringify(mr.fix.voices)}`;
			const { events: afterEvents, voices: afterVoices } = mergeEventsWithFix(pm, mr.fix);
			afterSvg = generateTopologySvg(afterEvents, afterVoices, mr.fix.duration || pm.duration, pm.timeSignature, { title: `After — M${mr.measureIndex}` });
		}

		if (report.backend === "codex") {
			// Codex: images passed at init → show background + Before/After upfront
			if (mr.backgroundBase64) {
				lines.push(`![background](${mr.backgroundBase64})`);
				lines.push("");
			}
			lines.push(`### Before (status=${pm.status ?? "?"})`);
			lines.push(`| ${evalFields} |`);
			lines.push("");
			lines.push(beforeSvg);
			lines.push("");
			if (afterSvg) {
				lines.push(`### ${afterHeader}`);
				lines.push("");
				lines.push(afterSvg);
				lines.push("");
			}
		}
		// Claude: no upfront diagrams — Before/After SVGs are inlined in conversation

		// Annotate conversation turns with inline SVGs
		if (mr.conversation.length > 0) {
			// Attach Before SVG after the first image tool result (Claude reads measure image)
			// Attach After SVG after the last assistant text containing the fix JSON
			if (report.backend === "claude") {
				let beforeAttached = false;
				let lastFixTextIdx = -1;
				for (let i = 0; i < mr.conversation.length; i++) {
					const turn = mr.conversation[i];
					// Attach Before SVG + background after first image read result
					if (!beforeAttached && turn.role === "user" && turn.imageData) {
						turn.attachedSvg = `| ${evalFields} |\n\n` + beforeSvg;
						beforeAttached = true;
					}
					// Track last assistant text that looks like it contains the fix JSON
					if (turn.role === "assistant" && turn.text?.includes('"fixes"')) {
						lastFixTextIdx = i;
					}
				}
				// If no image read found, attach Before SVG after first tool result
				if (!beforeAttached) {
					for (let i = 0; i < mr.conversation.length; i++) {
						if (mr.conversation[i].role === "user" && mr.conversation[i].toolResult) {
							mr.conversation[i].attachedSvg = `| ${evalFields} |\n\n` + beforeSvg;
							break;
						}
					}
				}
				// Attach After SVG after the last fix text
				if (afterSvg && lastFixTextIdx >= 0) {
					const turn = mr.conversation[lastFixTextIdx];
					turn.attachedSvg = (turn.attachedSvg ? turn.attachedSvg + "\n\n" : "") + afterHeader + "\n\n" + afterSvg;
				}
			}

			// Attach evaluate_fix attempt SVGs
			let efIdx = 0;
			for (let i = 0; i < mr.conversation.length; i++) {
				const turn = mr.conversation[i];
				if (turn.role === "user" && turn.toolResult && efIdx < mr.evaluateFixCalls.length) {
					const prev = i > 0 ? mr.conversation[i - 1] : null;
					if (prev?.toolUse?.name?.includes("evaluate_fix")) {
						const call = mr.evaluateFixCalls[efIdx++];
						if (call.arguments) {
							try {
								const attemptFix: Fix = {
									measureIndex: pm.measureIndex,
									events: call.arguments.events || [],
									voices: call.arguments.voices || pm.voices,
									duration: call.arguments.duration || pm.duration,
									status: 0,
								};
								const { events: ae, voices: av } = mergeEventsWithFix(pm, attemptFix);
								const svg = generateTopologySvg(ae, av, attemptFix.duration, pm.timeSignature, { title: `Attempt ${efIdx}`, width: 500 });
								turn.attachedSvg = (turn.attachedSvg ? turn.attachedSvg + "\n\n" : "") + svg;
							} catch {}
						}
					}
				}
			}
		}

		// Render conversation (prepend system prompt from prompt.ts)
		if (mr.conversation.length > 0) {
			const fullConv: ConversationTurn[] = [
				{ role: "system", text: SYSTEM_PROMPT },
				...mr.conversation,
			];
			lines.push("### Conversation");
			lines.push("");
			lines.push(renderConversation(fullConv));
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

	const dirName = path.basename(logDir);
	const dirMatch = dirName.match(/^(\d{4}-\d{2}-\d{2}T[\d-]+)_(.+)$/);
	const timestamp = dirMatch ? dirMatch[1] : dirName;
	const scoreId = dirMatch ? dirMatch[2] : dirName;

	console.log(`Scanning log directory: ${logDir}`);
	const { batches, summaries, backend } = scanLogDir(logDir);
	console.log(`Backend: ${backend}, ${batches.length} batches found`);

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

	const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "viz-"));
	const measureReports = new Map<number, MeasureReport>();

	for (const batch of batches) {
		console.log(`Processing r${batch.round}_b${batch.batch}...`);

		const promptText = fs.readFileSync(batch.promptFile, "utf-8");
		const promptMeasures = parsePromptFile(promptText);

		const outputRaw = fs.readFileSync(batch.outputFile, "utf-8");
		let fixes: Fix[] = [];
		let evaluateFixCalls: EvaluateFixCall[] = [];
		let conversation: ConversationTurn[] = [];

		if (backend === "codex") {
			const result = parseCodexJsonlFull(outputRaw);
			fixes = result.fixes;
			evaluateFixCalls = result.evaluateFixCalls;
			conversation = result.conversation;
		} else {
			const result = parseClaudeOutput(outputRaw);
			fixes = result.fixes;
			evaluateFixCalls = result.evaluateFixCalls;
			conversation = result.conversation;
		}

		for (const pm of promptMeasures) {
			const mi = pm.measureIndex;
			const fix = fixes.find(f => f.measureIndex === mi);
			const mCalls = evaluateFixCalls.filter(c => c.arguments?.measureIndex === mi);
			const summaryKey = [...summaries.keys()].find(k => k.split("_").includes(String(mi)));
			const summaryText = summaryKey ? summaries.get(summaryKey) : undefined;

			let backgroundBase64: string | undefined;
			if (spartito && !argv["no-images"]) {
				try {
					backgroundBase64 = (await generateMeasureBackgroundBase64(spartito, mi, tmpDir)) ?? undefined;
				} catch {}
			}

			const existing = measureReports.get(mi);
			if (existing) {
				if (fix) existing.fix = fix;
				if (mCalls.length) existing.evaluateFixCalls.push(...mCalls);
				if (summaryText) existing.summaryText = summaryText;
				if (backgroundBase64) existing.backgroundBase64 = backgroundBase64;
				if (conversation.length) existing.conversation.push(...conversation);
			} else {
				measureReports.set(mi, {
					measureIndex: mi,
					prompt: pm,
					fix,
					evaluateFixCalls: mCalls,
					summaryText,
					backgroundBase64,
					conversation,
				});
			}
		}
	}

	const report: LogReport = {
		scoreId, backend, timestamp, logDir,
		measures: [...measureReports.values()].sort((a, b) => a.measureIndex - b.measureIndex),
	};

	const markdown = renderMarkdownReport(report);
	const outputPath = argv.o || path.join(logDir, "report.md");
	fs.writeFileSync(outputPath, markdown);
	console.log(`Report written to: ${outputPath}`);
	console.log(`${report.measures.length} measures visualized`);

	try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
