/**
 * Unit test for measureQualityMcp.ts
 *
 * Spawns the MCP server and sends JSON-RPC requests via stdio to verify:
 * 1. Server initializes correctly
 * 2. tools/list returns evaluate_fix
 * 3. evaluate_fix with no-op returns valid evaluation (unchanged)
 * 4. evaluate_fix with a real fix returns before/after comparison
 * 5. evaluate_fix with invalid measureIndex returns error message
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

	const child = spawn("npx", ["tsx", path.resolve(__dirname, "measureQualityMcp.ts")], {
		env: { ...process.env, SPARTITO_PATH },
		stdio: ["pipe", "pipe", "pipe"],
	});

	let buffer = "";
	const responses: Record<number, any> = {};
	const waiters: Record<number, (v: any) => void> = {};

	child.stdout!.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		// MCP uses newline-delimited JSON-RPC
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

	child.stderr!.on("data", (chunk: Buffer) => {
		// Suppress stderr (starry banner etc.)
	});

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
		const notif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
		child.stdin!.write(notif + "\n");

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

		// 3. evaluate_fix — no-op (just measureIndex, no changes)
		console.log("\nTest 3: evaluate_fix no-op");
		send(3, "tools/call", {
			name: "evaluate_fix",
			arguments: { measureIndex: 2 },
		});
		const noopResp = await waitFor(3);
		const noopText = noopResp.result?.content?.[0]?.text || "";
		assert(noopText.includes("BEFORE (m2)"), "output contains BEFORE label");
		assert(noopText.includes("AFTER  (m2)"), "output contains AFTER label");
		assert(noopText.includes("fine="), "output contains fine metric");
		assert(noopText.includes("tickTwist="), "output contains tickTwist metric");
		assert(noopText.includes("unchanged"), "no-op yields 'unchanged' delta");
		console.log("  Output preview:", noopText.split("\n")[0]);

		// 4. evaluate_fix — with actual fix (change voices)
		console.log("\nTest 4: evaluate_fix with voices change");
		send(4, "tools/call", {
			name: "evaluate_fix",
			arguments: {
				measureIndex: 2,
				voices: [[1, 2, 3, 4, 5, 6, 7, 9]],  // merge all into one voice
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
			arguments: { measureIndex: 9999 },
		});
		const errResp = await waitFor(5);
		const errText = errResp.result?.content?.[0]?.text || "";
		assert(errText.includes("Error"), "invalid index returns error message");
		assert(errText.includes("9999"), "error mentions the bad index");
		console.log("  Output:", errText);

		// 6. evaluate_fix — with event patches
		console.log("\nTest 6: evaluate_fix with event patches");
		send(6, "tools/call", {
			name: "evaluate_fix",
			arguments: {
				measureIndex: 2,
				events: [{ id: 1, tick: 0, division: 2, dots: 0 }],
			},
		});
		const patchResp = await waitFor(6);
		const patchText = patchResp.result?.content?.[0]?.text || "";
		assert(patchText.includes("BEFORE") && patchText.includes("AFTER"), "event patch returns comparison");
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
