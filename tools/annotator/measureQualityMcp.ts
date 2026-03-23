/**
 * MCP stdio server providing an `evaluate_fix` tool for the spartito annotation agent.
 *
 * Run: SPARTITO_PATH=<path> npx tsx tools/annotator/measureQualityMcp.ts
 *
 * The server is read-only: it deep-clones measures before applying fixes,
 * so the loaded spartito is never mutated.
 */

import fs from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { starry } from "../libs/omr";


// ── Load spartito from env ──────────────────────────────────────────────────

const spartitoPath = process.env.SPARTITO_PATH;
if (!spartitoPath || !fs.existsSync(spartitoPath)) {
	process.stderr.write(`SPARTITO_PATH not set or file not found: ${spartitoPath}\n`);
	process.exit(1);
}

const spartitoJSON = JSON.parse(fs.readFileSync(spartitoPath, "utf-8"));
const spartito = starry.recoverJSON<starry.Spartito>(spartitoJSON, starry);


// ── Helpers ─────────────────────────────────────────────────────────────────

const formatEvaluation = (label: string, ev: any): string => {
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

// Schema mirrors RegulationSolution + measureIndex
const solutionEventSchema = z.object({
	id: z.number(),
	tick: z.number(),
	tickGroup: z.number().nullable(),
	timeWarp: z.object({ numerator: z.number(), denominator: z.number() }).nullable(),
	division: z.number().optional(),
	dots: z.number().optional(),
	beam: z.string().optional(),
	grace: z.boolean().optional(),
});

server.tool(
	"evaluate_fix",
	"Apply a RegulationSolution to a measure (deep-cloned, read-only) and return quality metrics. Use this to test fixes before including them in the final JSON output.",
	{
		measureIndex: z.number().describe("Index of the measure to evaluate"),
		events: z.array(solutionEventSchema).describe("RegulationSolution events: each must have id, tick, tickGroup, timeWarp; optional: division, dots, beam, grace"),
		voices: z.array(z.array(z.number())).describe("Voice arrays (each = array of event IDs)"),
		duration: z.number().describe("Measure duration in ticks"),
	},
	async (fix) => {
		const mi = fix.measureIndex;
		const originalMeasure = spartito.measures[mi];
		if (!originalMeasure) {
			return { content: [{ type: "text" as const, text: `Error: Measure ${mi} not found (valid range: 0-${spartito.measures.length - 1})` }] };
		}

		// Evaluate original
		const evalBefore = starry.evaluateMeasure(originalMeasure);

		// Deep-clone measure via recoverJSON (preserves EventTerm class instances)
		const cloned: starry.SpartitoMeasure = starry.recoverJSON(JSON.parse(JSON.stringify(originalMeasure.toJSON())), starry);
		cloned.staffGroups = originalMeasure.staffGroups;

		// Merge partial fix with base solution so events not in fix keep their ticks
		const base = cloned.asSolution();
		const mergedFix = (() => {
			if (!base) return fix;
			const fixEventMap = new Map<number, any>();
			if ((fix as any).events) {
				for (const e of (fix as any).events) fixEventMap.set(e.id, e);
			}
			const mergedEvents = base.events.map((baseEvent: any) => {
				const fixEvent = fixEventMap.get(baseEvent.id);
				if (fixEvent) return { ...baseEvent, ...fixEvent };
				return baseEvent;
			});
			return { ...base, ...fix, events: mergedEvents };
		})();

		// Apply fix as RegulationSolution via applySolution (includes postRegulate)
		try {
			cloned.applySolution(mergedFix as any);
		}
		catch (err: any) {
			return { content: [{ type: "text" as const, text: `Error applying solution to m${mi}: ${err.message}` }] };
		}

		// Evaluate after fix
		const evalAfter = starry.evaluateMeasure(cloned);

		// Format comparison
		const lines: string[] = [];
		lines.push(formatEvaluation(`BEFORE (m${mi})`, evalBefore));
		lines.push("");
		lines.push(formatEvaluation(`AFTER  (m${mi})`, evalAfter));

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
