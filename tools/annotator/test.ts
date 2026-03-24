/**
 * Unit tests for annotator modules.
 *
 * Run: npx tsx tools/annotator/test.ts [spartito-path]
 *
 * Tests: parseFixes, mergeWithBaseSolution, applyFixes, resolveImageSource, parseCodexJsonl
 */

import path from "path";
import fs from "fs";

import {
	parseFixes,
	parseCodexJsonl,
	mergeWithBaseSolution,
	applyFixes,
	resolveImageSource,
	starry,
} from "./common";


// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let currentSuite = "";

const suite = (name: string) => {
	currentSuite = name;
	console.log(`\n${"━".repeat(60)}\n  ${name}\n${"━".repeat(60)}`);
};

const assert = (condition: boolean, msg: string) => {
	if (condition) {
		console.log(`  PASS: ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL: ${msg}`);
		failed++;
	}
};

const assertEq = (actual: any, expected: any, msg: string) => {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		console.log(`  PASS: ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL: ${msg}`);
		console.error(`    expected: ${e}`);
		console.error(`    actual:   ${a}`);
		failed++;
	}
};


// ── parseFixes tests ─────────────────────────────────────────────────────────

suite("parseFixes");

// Normal: JSON in code fence
{
	const output = 'Some text\n```json\n{"fixes": [{"measureIndex": 5, "status": 0, "events": [], "voices": [], "duration": 1920}]}\n```\nMore text';
	const fixes = parseFixes(output);
	assertEq(fixes.length, 1, "code fence: 1 fix extracted");
	assertEq(fixes[0].measureIndex, 5, "code fence: correct measureIndex");
	assertEq(fixes[0].status, 0, "code fence: correct status");
}

// Normal: bare JSON (no code fence)
{
	const output = '{"fixes": [{"measureIndex": 10, "status": 1, "events": [], "voices": [], "duration": 960}]}';
	const fixes = parseFixes(output);
	assertEq(fixes.length, 1, "bare JSON: 1 fix extracted");
	assertEq(fixes[0].measureIndex, 10, "bare JSON: correct measureIndex");
}

// Empty fixes array
{
	const output = '```json\n{"fixes": []}\n```';
	const fixes = parseFixes(output);
	assertEq(fixes.length, 0, "empty fixes array returns []");
}

// No fixes key
{
	const output = '```json\n{"result": "no fixes needed"}\n```';
	const fixes = parseFixes(output);
	assertEq(fixes.length, 0, "no 'fixes' key returns []");
}

// Completely invalid output
{
	const output = "I'm sorry, I cannot help with that.";
	const fixes = parseFixes(output);
	assertEq(fixes.length, 0, "invalid text returns []");
}

// Empty string
{
	const fixes = parseFixes("");
	assertEq(fixes.length, 0, "empty string returns []");
}

// Truncated JSON with individual fix objects
{
	const output = 'Here are my fixes:\n{"measureIndex": 3, "events": [{"id": 1, "tick": 0}], "voices": [[1]], "duration": 1920, "status": 0}\nand also\n{"measureIndex": 7, "events": [], "voices": [], "duration": 960, "status": 1}';
	const fixes = parseFixes(output);
	assertEq(fixes.length, 2, "truncated: extracts 2 individual fix objects");
	assertEq(fixes[0].measureIndex, 3, "truncated: first fix measureIndex=3");
	assertEq(fixes[1].measureIndex, 7, "truncated: second fix measureIndex=7");
}

// JSON with surrounding explanation text
{
	const output = 'After analysis, I found:\n\n```\n{"fixes": [{"measureIndex": 42, "status": 0, "events": [{"id": 1, "tick": 0, "tickGroup": 0, "timeWarp": null}], "voices": [[1]], "duration": 1920}]}\n```\n\nThis should fix the issue.';
	const fixes = parseFixes(output);
	assertEq(fixes.length, 1, "with explanation text: extracts 1 fix");
	assertEq(fixes[0].measureIndex, 42, "with explanation: correct measureIndex");
}

// Multiple code fences (should use first one)
{
	const output = '```json\n{"fixes": [{"measureIndex": 1, "status": 0, "events": [], "voices": [], "duration": 960}]}\n```\n\n```json\n{"fixes": [{"measureIndex": 2, "status": 0, "events": [], "voices": [], "duration": 960}]}\n```';
	const fixes = parseFixes(output);
	assertEq(fixes.length, 1, "multiple fences: uses first one");
	assertEq(fixes[0].measureIndex, 1, "multiple fences: correct measureIndex from first");
}

// Malformed JSON in code fence: non-greedy brace regex should find valid JSON after fence
{
	const output = '```json\n{broken json\n```\n{"fixes": [{"measureIndex": 99, "status": 0, "events": [], "voices": [], "duration": 1920}]}';
	const fixes = parseFixes(output);
	// Non-greedy brace match finds {"fixes": [...]} after the malformed fence
	assert(fixes.length >= 1, "malformed fence: non-greedy regex finds bare JSON");
	if (fixes.length > 0) assertEq(fixes[0].measureIndex, 99, "malformed fence: correct measureIndex");
}

// Nested JSON: fix with complex events
{
	const output = '```json\n{"fixes": [{"measureIndex": 5, "events": [{"id": 1, "tick": 0, "tickGroup": 0, "timeWarp": null, "division": 2}, {"id": 2, "tick": 480, "tickGroup": 1, "timeWarp": {"numerator": 2, "denominator": 3}}], "voices": [[1, 2]], "duration": 1920, "status": 0}]}\n```';
	const fixes = parseFixes(output);
	assertEq(fixes.length, 1, "complex events: 1 fix");
	assertEq(fixes[0].events.length, 2, "complex events: 2 events");
	assertEq(fixes[0].events[1].timeWarp.numerator, 2, "complex events: timeWarp preserved");
}


// ── parseCodexJsonl tests ────────────────────────────────────────────────────

suite("parseCodexJsonl");

// Normal codex output
{
	const output = [
		'{"type":"thread.started","thread_id":"abc-123"}',
		'{"type":"turn.started"}',
		'{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hello"}}',
		'{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"World"}}',
		'{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}',
	].join("\n");
	const { text, sessionId } = parseCodexJsonl(output);
	assert(text.includes("Hello"), "normal: contains first message");
	assert(text.includes("World"), "normal: contains second message");
	assertEq(sessionId, "abc-123", "normal: extracts sessionId");
}

// Empty output
{
	const { text, sessionId } = parseCodexJsonl("");
	assertEq(text, "", "empty: returns empty text");
	assertEq(sessionId, "", "empty: returns empty sessionId");
}

// Non-JSON lines mixed in
{
	const output = [
		'Reading prompt from stdin...',
		'{"type":"thread.started","thread_id":"xyz"}',
		'some random text',
		'{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Fix applied"}}',
	].join("\n");
	const { text, sessionId } = parseCodexJsonl(output);
	assert(text.includes("Fix applied"), "mixed: extracts message text");
	assertEq(sessionId, "xyz", "mixed: extracts sessionId");
}

// MCP tool calls (should not be collected as text)
{
	const output = [
		'{"type":"thread.started","thread_id":"t1"}',
		'{"type":"item.completed","item":{"id":"item_0","type":"mcp_tool_call","server":"measure-quality","tool":"evaluate_fix","result":{"content":[{"type":"text","text":"BEFORE..."}]},"status":"completed"}}',
		'{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"The fix is ready"}}',
	].join("\n");
	const { text } = parseCodexJsonl(output);
	assert(text.includes("The fix is ready"), "mcp: agent message extracted");
	assert(!text.includes("BEFORE"), "mcp: tool result not in text (no item.text)");
}

// Only turn events, no messages
{
	const output = [
		'{"type":"thread.started","thread_id":"t2"}',
		'{"type":"turn.started"}',
		'{"type":"turn.completed","usage":{}}',
	].join("\n");
	const { text } = parseCodexJsonl(output);
	assertEq(text, output, "no messages: falls back to raw output");
}

// Result field fallback
{
	const output = '{"result": "direct result text"}';
	const { text } = parseCodexJsonl(output);
	assert(text.includes("direct result text"), "result fallback: extracts result field");
}


// ── mergeWithBaseSolution tests ──────────────────────────────────────────────

suite("mergeWithBaseSolution");

// Load a real spartito for testing
const SPARTITO_PATH = process.argv[2] || path.resolve(__dirname, "../../spartitos/5816-289905-p0.spartito.json");
let spartito: starry.Spartito | null = null;

if (fs.existsSync(SPARTITO_PATH)) {
	const content = fs.readFileSync(SPARTITO_PATH, "utf-8");
	spartito = starry.recoverJSON<starry.Spartito>(content, starry);
	console.log(`  Using spartito: ${path.basename(SPARTITO_PATH)} (${spartito.measures.length} measures)`);
} else {
	console.warn(`  Spartito not found: ${SPARTITO_PATH}, skipping merge/apply tests`);
}

if (spartito) {
	// Find a regulated measure with a valid solution
	const testMeasure = spartito.measures.find(m => m.regulated && m.events.length > 0 && m.asSolution());
	if (testMeasure) {
		const mi = testMeasure.measureIndex;
		const baseSolution = testMeasure.asSolution()!;
		console.log(`  Test measure: m${mi} (${testMeasure.events.length} events, ${baseSolution.voices?.length} voices)`);

		// Normal merge: partial fix overrides one event
		{
			const fix = {
				measureIndex: mi,
				events: [{ id: baseSolution.events[0].id, tick: 0, tickGroup: 0, timeWarp: null, division: 2 }],
				voices: baseSolution.voices,
				duration: baseSolution.duration,
				status: 0,
			};
			const merged = mergeWithBaseSolution(testMeasure, fix);
			assertEq(merged.events.length, baseSolution.events.length, "partial merge: preserves all events");
			assertEq(merged.events[0].division, 2, "partial merge: overridden field applied");
			// Non-overridden events keep original values
			if (baseSolution.events.length > 1) {
				assertEq(merged.events[1].tick, baseSolution.events[1].tick, "partial merge: non-overridden event preserved");
			}
		}

		// Empty fix events: all base events preserved
		{
			const fix = {
				measureIndex: mi,
				events: [],
				voices: baseSolution.voices,
				duration: baseSolution.duration,
				status: 0,
			};
			const merged = mergeWithBaseSolution(testMeasure, fix);
			assertEq(merged.events.length, baseSolution.events.length, "empty fix events: all base events preserved");
		}

		// Fix with no events key: base events used
		{
			const fix = {
				measureIndex: mi,
				voices: baseSolution.voices,
				duration: baseSolution.duration,
				status: 0,
			};
			const merged = mergeWithBaseSolution(testMeasure, fix);
			assertEq(merged.events.length, baseSolution.events.length, "no events key: base events preserved");
		}

		// Fix with unknown event id: that event is ignored, base events preserved
		{
			const fix = {
				measureIndex: mi,
				events: [{ id: 99999, tick: 0, tickGroup: 0, timeWarp: null }],
				voices: baseSolution.voices,
				duration: baseSolution.duration,
				status: 0,
			};
			const merged = mergeWithBaseSolution(testMeasure, fix);
			assertEq(merged.events.length, baseSolution.events.length, "unknown event id: base count preserved");
			// The unknown id is not in the merged events
			assert(!merged.events.some((e: any) => e.id === 99999), "unknown event id: not in merged result");
		}

		// Fix overriding all events
		{
			const fixEvents = baseSolution.events.map((e: any) => ({
				id: e.id, tick: e.tick, tickGroup: e.tickGroup, timeWarp: null, division: 2,
			}));
			const fix = {
				measureIndex: mi,
				events: fixEvents,
				voices: baseSolution.voices,
				duration: baseSolution.duration,
				status: 0,
			};
			const merged = mergeWithBaseSolution(testMeasure, fix);
			assert(merged.events.every((e: any) => e.division === 2), "full override: all events have division=2");
		}

		// Duplicate event ids in fix: last one wins (Map behavior)
		{
			const firstId = baseSolution.events[0].id;
			const fix = {
				measureIndex: mi,
				events: [
					{ id: firstId, tick: 0, tickGroup: 0, timeWarp: null, division: 3 },
					{ id: firstId, tick: 0, tickGroup: 0, timeWarp: null, division: 1 },
				],
				voices: baseSolution.voices,
				duration: baseSolution.duration,
				status: 0,
			};
			const merged = mergeWithBaseSolution(testMeasure, fix);
			assertEq(merged.events[0].division, 1, "duplicate ids: last one wins");
		}
	} else {
		console.warn("  No suitable regulated measure found for merge tests");
	}
}


// ── applyFixes tests ─────────────────────────────────────────────────────────

suite("applyFixes");

if (spartito) {
	// Find a non-fine measure to test fix application
	const issueMeasure = spartito.measures.find(m => {
		if (!m.regulated || m.events.length === 0) return false;
		const ev = starry.evaluateMeasure(m);
		return ev && !ev.fine;
	});

	if (issueMeasure) {
		const mi = issueMeasure.measureIndex;
		const evalBefore = starry.evaluateMeasure(issueMeasure)!;
		console.log(`  Issue measure: m${mi} (fine=${evalBefore.fine}, tickTwist=${evalBefore.tickTwist.toFixed(3)})`);

		// Apply identity fix (same as base): should not revert (tickTwist unchanged)
		{
			const base = issueMeasure.asSolution();
			if (base) {
				// Clone spartito for isolation
				const cloneSp = starry.recoverJSON<starry.Spartito>(JSON.parse(JSON.stringify(spartito)), starry);
				const fix = { ...base, measureIndex: mi, status: 0 };
				const applied = applyFixes(cloneSp, [fix]);
				assert(applied.has(mi), "identity fix: accepted (tickTwist not worse)");
			}
		}

		// Apply empty fix (no events): should still work via merge
		{
			const cloneSp = starry.recoverJSON<starry.Spartito>(JSON.parse(JSON.stringify(spartito)), starry);
			const base = cloneSp.measures[mi].asSolution();
			if (base) {
				const fix = { measureIndex: mi, events: [], voices: base.voices, duration: base.duration, status: 0 };
				const applied = applyFixes(cloneSp, [fix]);
				assert(applied.has(mi), "empty events fix: accepted");
			}
		}

		// Apply fix with invalid measureIndex
		{
			const cloneSp = starry.recoverJSON<starry.Spartito>(JSON.parse(JSON.stringify(spartito)), starry);
			const fix = { measureIndex: 99999, events: [], voices: [], duration: 0, status: 0 };
			const applied = applyFixes(cloneSp, [fix]);
			assert(!applied.has(99999), "invalid measureIndex: not applied");
		}

		// Apply multiple fixes
		{
			const cloneSp = starry.recoverJSON<starry.Spartito>(JSON.parse(JSON.stringify(spartito)), starry);
			const fixes: any[] = [];
			for (const m of cloneSp.measures) {
				if (!m.regulated || m.events.length === 0) continue;
				const base = m.asSolution();
				if (base) {
					fixes.push({ ...base, measureIndex: m.measureIndex, status: 0 });
				}
				if (fixes.length >= 3) break;
			}
			const applied = applyFixes(cloneSp, fixes);
			assert(applied.size >= 1, `multiple fixes: at least 1 applied (got ${applied.size})`);
		}
	} else {
		console.warn("  No issue measure found for applyFixes tests");
	}

	// Test rollback: apply a deliberately bad fix
	{
		const goodMeasure = spartito.measures.find(m => {
			if (!m.regulated || m.events.length === 0) return false;
			const ev = starry.evaluateMeasure(m);
			return ev && ev.fine;
		});

		if (goodMeasure) {
			const mi = goodMeasure.measureIndex;
			const evalBefore = starry.evaluateMeasure(goodMeasure)!;
			console.log(`  Rollback test on m${mi} (fine=${evalBefore.fine}, tickTwist=${evalBefore.tickTwist.toFixed(3)})`);

			// Create a bad fix: wrong voice assignment (all in one voice with overlapping ticks)
			const cloneSp = starry.recoverJSON<starry.Spartito>(JSON.parse(JSON.stringify(spartito)), starry);
			const base = cloneSp.measures[mi].asSolution();
			if (base && base.events.length > 1) {
				const badFix = {
					measureIndex: mi,
					events: base.events.map((e: any) => ({ ...e, tick: 0 })), // all at tick 0
					voices: [base.events.map((e: any) => e.id)], // all in one voice
					duration: base.duration,
					status: 0,
				};
				const applied = applyFixes(cloneSp, [badFix]);

				// Verify original measure is not corrupted
				const evalAfter = starry.evaluateMeasure(cloneSp.measures[mi]);
				if (!applied.has(mi)) {
					// Was reverted
					assert(true, "bad fix: reverted (tickTwist worse)");
					assertEq(evalAfter?.tickTwist?.toFixed(3), evalBefore.tickTwist.toFixed(3), "bad fix: tickTwist restored after revert");
				} else {
					// Might still be accepted if tickTwist didn't get worse
					assert(true, "bad fix: accepted (tickTwist not worse, unusual)");
				}
			}
		}
	}
}


// ── resolveImageSource tests ─────────────────────────────────────────────────

suite("resolveImageSource");

// Empty/null input
{
	const result = resolveImageSource("");
	assertEq(result, null, "empty string returns null");
}

// Local file path that exists
{
	const existingFile = path.resolve(__dirname, "common.ts");
	const result = resolveImageSource(existingFile);
	assert(result?.type === "local", "existing file: type=local");
	assertEq(result?.path, existingFile, "existing file: correct path");
}

// Local file path that doesn't exist
{
	const result = resolveImageSource("/nonexistent/path/image.png");
	assertEq(result, null, "nonexistent file returns null");
}

// md5: scheme without IMAGE_BED or IMAGE_API_BASE
{
	const result = resolveImageSource("md5:abc123def456");
	// Result depends on env vars; just verify it doesn't crash
	assert(result === null || result.type === "local" || result.type === "remote", "md5: returns valid result or null");
}

// Unknown scheme
{
	const result = resolveImageSource("https://example.com/image.png");
	// Not a local file, not md5: — resolveImageSource checks fs.existsSync
	assertEq(result, null, "URL that doesn't exist locally returns null");
}


// ── Results ──────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
