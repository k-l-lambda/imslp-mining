/**
 * Unit test for measureQualityMcp.ts
 *
 * Spawns the MCP server and sends JSON-RPC requests via stdio to verify:
 * 1. Server initializes correctly
 * 2. tools/list returns evaluate_fix with RegulationSolution schema
 * 3. evaluate_fix with original solution returns unchanged
 * 4. evaluate_fix with modified voices returns comparison
 * 5. evaluate_fix with invalid measureIndex returns error message
 * 6. evaluate_fix with division override returns comparison
 */

import { spawn } from "child_process";
import path from "path";

const SPARTITO_PATH = process.argv[2] || path.resolve(__dirname, "../spartitos/5816-289905-p0.spartito.json");

let passed = 0;
let failed = 0;

const assert = (condition: boolean, msg: string) => {
	if (condition) {
		console.log(`  PASS: ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL: ${msg}`);
		failed++;
	}
};

const run = async () => {
	console.log(`Using spartito: ${SPARTITO_PATH}\n`);

	const child = spawn("npx", ["tsx", path.resolve(__dirname, "annotator/measureQualityMcp.ts")], {
		env: { ...process.env, SPARTITO_PATH },
		stdio: ["pipe", "pipe", "pipe"],
	});

	let buffer = "";
	const responses: Record<number, any> = {};
	const waiters: Record<number, (v: any) => void> = {};

	child.stdout!.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line) continue;
			try {
				const msg = JSON.parse(line);
				if (msg.id !== undefined) {
					responses[msg.id] = msg;
					if (waiters[msg.id]) {
						waiters[msg.id](msg);
						delete waiters[msg.id];
					}
				}
			} catch {}
		}
	});

	child.stderr!.on("data", () => {});

	const send = (id: number, method: string, params: any = {}) => {
		const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		child.stdin!.write(msg + "\n");
	};

	const waitFor = (id: number, timeoutMs = 10000): Promise<any> => {
		if (responses[id]) return Promise.resolve(responses[id]);
		return new Promise((resolve, reject) => {
			waiters[id] = resolve;
			setTimeout(() => reject(new Error(`Timeout waiting for response ${id}`)), timeoutMs);
		});
	};

	// Original solution for m2 (from asSolution)
	const m2Solution = {
		events: [
			{ id: 1, tick: 0, tickGroup: 0, timeWarp: null },
			{ id: 2, tick: 480, tickGroup: 1, timeWarp: null },
			{ id: 3, tick: 960, tickGroup: 2, timeWarp: null },
			{ id: 4, tick: 1320, tickGroup: 3, timeWarp: null },
			{ id: 5, tick: 0, tickGroup: 0, timeWarp: null },
			{ id: 6, tick: 480, tickGroup: 1, timeWarp: null },
			{ id: 7, tick: 960, tickGroup: 2, timeWarp: null },
			{ id: 9, tick: 1320, tickGroup: 3, timeWarp: null },
		],
		voices: [[1, 2, 3, 4], [5, 6, 7, 9]],
		duration: 1440,
	};

	try {
		// 1. Initialize
		console.log("Test 1: Initialize");
		send(1, "initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "test", version: "1.0" },
		});
		const initResp = await waitFor(1);
		assert(initResp.result?.serverInfo?.name === "measure-quality", "server name is 'measure-quality'");
		assert(!initResp.error, "no error on initialize");

		// Send initialized notification
		child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

		// 2. List tools
		console.log("\nTest 2: tools/list");
		send(2, "tools/list", {});
		const listResp = await waitFor(2);
		const toolNames = listResp.result?.tools?.map((t: any) => t.name) || [];
		assert(toolNames.includes("evaluate_fix"), "evaluate_fix tool is listed");
		const evalTool = listResp.result?.tools?.find((t: any) => t.name === "evaluate_fix");
		assert(!!evalTool?.inputSchema?.properties?.measureIndex, "tool has measureIndex param");
		assert(!!evalTool?.inputSchema?.properties?.voices, "tool has voices param");
		assert(!!evalTool?.inputSchema?.properties?.events, "tool has events param");
		assert(!!evalTool?.inputSchema?.properties?.duration, "tool has duration param");

		// 3. evaluate_fix — original solution (should be unchanged)
		console.log("\nTest 3: evaluate_fix with original solution");
		send(3, "tools/call", {
			name: "evaluate_fix",
			arguments: { measureIndex: 2, ...m2Solution },
		});
		const noopResp = await waitFor(3);
		const noopText = noopResp.result?.content?.[0]?.text || "";
		assert(noopText.includes("BEFORE (m2)"), "output contains BEFORE label");
		assert(noopText.includes("AFTER  (m2)"), "output contains AFTER label");
		assert(noopText.includes("fine="), "output contains fine metric");
		assert(noopText.includes("tickTwist="), "output contains tickTwist metric");
		assert(noopText.includes("unchanged"), "original solution yields 'unchanged' delta");
		assert(!noopText.includes("N/A"), "no N/A in output (qualityScore computed)");
		console.log("  Output preview:", noopText.split("\n")[0]);

		// 4. evaluate_fix — merge all into one voice
		console.log("\nTest 4: evaluate_fix with modified voices");
		send(4, "tools/call", {
			name: "evaluate_fix",
			arguments: {
				measureIndex: 2,
				events: m2Solution.events,
				voices: [[1, 2, 3, 4, 5, 6, 7, 9]],
				duration: 1440,
			},
		});
		const fixResp = await waitFor(4);
		const fixText = fixResp.result?.content?.[0]?.text || "";
		assert(fixText.includes("BEFORE (m2)"), "fix output contains BEFORE");
		assert(fixText.includes("AFTER  (m2)"), "fix output contains AFTER");
		assert(fixText.includes("Δ tickTwist="), "fix output contains delta summary");
		console.log("  Output preview:", fixText.split("\n").slice(-1)[0]);

		// 5. evaluate_fix — invalid measure index
		console.log("\nTest 5: evaluate_fix invalid measureIndex");
		send(5, "tools/call", {
			name: "evaluate_fix",
			arguments: { measureIndex: 9999, events: [], voices: [], duration: 0 },
		});
		const errResp = await waitFor(5);
		const errText = errResp.result?.content?.[0]?.text || "";
		assert(errText.includes("Error"), "invalid index returns error message");
		assert(errText.includes("9999"), "error mentions the bad index");
		console.log("  Output:", errText);

		// 6. evaluate_fix — with division override (grace: false to clear false grace)
		console.log("\nTest 6: evaluate_fix with division override");
		const modifiedEvents = m2Solution.events.map(e =>
			e.id === 1 ? { ...e, division: 2, dots: 0 } : e
		);
		send(6, "tools/call", {
			name: "evaluate_fix",
			arguments: {
				measureIndex: 2,
				events: modifiedEvents,
				voices: m2Solution.voices,
				duration: 1440,
			},
		});
		const patchResp = await waitFor(6);
		const patchText = patchResp.result?.content?.[0]?.text || "";
		assert(patchText.includes("BEFORE") && patchText.includes("AFTER"), "division override returns comparison");
		assert(!patchText.includes("N/A"), "no N/A in division override output");
		console.log("  Output preview:", patchText.split("\n").slice(-1)[0]);

	} catch (err: any) {
		console.error("Test error:", err.message);
		failed++;
	} finally {
		child.kill();
		console.log(`\n${"=".repeat(40)}`);
		console.log(`Results: ${passed} passed, ${failed} failed`);
		process.exit(failed > 0 ? 1 : 0);
	}
};

run();
