/**
 * MCP stdio server providing an `evaluate_fix` tool for the spartito annotation agent.
 *
 * Run: SPARTITO_PATH=<path> npx tsx tools/measureQualityMcp.ts
 *
 * The server is read-only: it deep-clones measures before applying fixes,
 * so the loaded spartito is never mutated.
 */

import fs from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { starry } from "./libs/omr";


// ── Load spartito from env ──────────────────────────────────────────────────

const spartitoPath = process.env.SPARTITO_PATH;
if (!spartitoPath || !fs.existsSync(spartitoPath)) {
	process.stderr.write(`SPARTITO_PATH not set or file not found: ${spartitoPath}\n`);
	process.exit(1);
}

const spartitoJSON = JSON.parse(fs.readFileSync(spartitoPath, "utf-8"));
const spartito = starry.recoverJSON<starry.Spartito>(spartitoJSON, starry);


// ── Fix application logic (mirrors applyFixes in spartitoAnnotate.ts) ───────

const applyFixToMeasure = (measure: starry.SpartitoMeasure, fix: any): void => {
	// Clear grace flags (by array index)
	if (fix.clearGrace?.length) {
		for (const idx of fix.clearGrace) {
			if (measure.events[idx])
				measure.events[idx].grace = null as any;
		}
	}

	// Set division/dots (by array index)
	if (fix.setDivision) {
		for (const [idx, val] of Object.entries(fix.setDivision)) {
			const event = measure.events[Number(idx)];
			if (event && val) {
				event.division = (val as any).division;
				event.dots = (val as any).dots;
			}
		}
	}

	// Apply event patches (by event id)
	if (fix.events?.length) {
		const eventMap = new Map(measure.events.map(e => [e.id, e]));
		for (const patch of fix.events) {
			const event = eventMap.get(patch.id);
			if (!event) continue;
			if (patch.tick !== undefined) event.tick = patch.tick;
			if (patch.division !== undefined) event.division = patch.division;
			if (patch.dots !== undefined) event.dots = patch.dots;
			if (patch.timeWarp !== undefined) event.timeWarp = patch.timeWarp;
		}
	}

	// Set voices
	if (fix.voices) {
		measure.voices = fix.voices;
	}

	// Set duration
	if (fix.duration !== undefined) {
		measure.duration = fix.duration;
	}

	// Post-regulate to update computed fields
	try {
		measure.postRegulate();
	}
	catch {}
};


const formatEvaluation = (label: string, ev: any, measure: starry.SpartitoMeasure): string => {
	if (!ev) return `${label}: (no evaluation)`;
	const lines: string[] = [];
	lines.push(`${label}: fine=${ev.fine}, error=${ev.error}, tickTwist=${ev.tickTwist?.toFixed(3)}`);
	const qs = Number.isFinite(ev.qualityScore) ? ev.qualityScore.toFixed(3) : "N/A";
	lines.push(`  qualityScore=${qs}, spaceTime=${ev.spaceTime}, surplusTime=${ev.surplusTime}, beamBroken=${ev.beamBroken}`);
	lines.push(`  Events: ${ev.events} total, ${ev.validEvents} valid, ${ev.fakeEvents} fake, ${ev.nullEvents} null`);
	if (ev.voiceRugged) lines.push(`  voiceRugged=true`);
	if (ev.tickOverlapped) lines.push(`  tickOverlapped=true`);
	if (ev.graceInVoice) lines.push(`  graceInVoice=true (${ev.graceN} grace notes)`);
	return lines.join("\n");
};


// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
	name: "measure-quality",
	version: "1.0.0",
});

server.tool(
	"evaluate_fix",
	"Apply a proposed fix to a measure (deep-cloned, read-only) and return quality metrics. Use this to test fixes before including them in the final JSON output.",
	{
		measureIndex: z.number().describe("Index of the measure to evaluate"),
		clearGrace: z.array(z.number()).optional().describe("0-based event array indices to clear grace flag"),
		setDivision: z.record(z.string(), z.object({
			division: z.number(),
			dots: z.number(),
		})).optional().describe("Map of 0-based event array index → {division, dots}"),
		voices: z.array(z.array(z.number())).optional().describe("Voice arrays (each = array of event IDs)"),
		events: z.array(z.object({
			id: z.number(),
			tick: z.number().optional(),
			division: z.number().optional(),
			dots: z.number().optional(),
			timeWarp: z.any().optional(),
		})).optional().describe("Event patches matched by event id"),
		duration: z.number().optional().describe("Corrected measure duration"),
	},
	async (fix) => {
		const mi = fix.measureIndex;
		const originalMeasure = spartito.measures[mi];
		if (!originalMeasure) {
			return { content: [{ type: "text" as const, text: `Error: Measure ${mi} not found (valid range: 0-${spartito.measures.length - 1})` }] };
		}

		// Evaluate original
		const evalBefore = starry.evaluateMeasure(originalMeasure);

		// Deep-clone measure via JSON round-trip, preserving staffGroups (needed by tickTwist)
		const cloned = new starry.SpartitoMeasure(JSON.parse(JSON.stringify(originalMeasure.toJSON())));
		cloned.staffGroups = originalMeasure.staffGroups;

		// Apply fix to clone
		applyFixToMeasure(cloned, fix);

		// Evaluate after fix
		const evalAfter = starry.evaluateMeasure(cloned);

		// Format comparison
		const lines: string[] = [];
		lines.push(formatEvaluation(`BEFORE (m${mi})`, evalBefore, originalMeasure));
		lines.push("");
		lines.push(formatEvaluation(`AFTER  (m${mi})`, evalAfter, cloned));

		// Summary delta
		if (evalBefore && evalAfter) {
			lines.push("");
			const twistDelta = evalAfter.tickTwist - evalBefore.tickTwist;
			const improved = evalAfter.fine && !evalBefore.fine ? "FIXED!" :
				twistDelta < 0 ? "improved" :
				twistDelta > 0 ? "WORSE" : "unchanged";
			lines.push(`Δ tickTwist=${twistDelta >= 0 ? "+" : ""}${twistDelta.toFixed(3)} → ${improved}`);
		}

		return { content: [{ type: "text" as const, text: lines.join("\n") }] };
	},
);

// Start
const transport = new StdioServerTransport();
server.connect(transport);
