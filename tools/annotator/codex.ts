
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";

import {
	type IssueMeasureInfo,
	type BatchResult,
	type AnnotationBackend,
	parseFixes,
	parseArgs,
	runAnnotationPipeline,
	starry,
	ANNOTATION_API_KEY,
	ANNOTATION_BASE_URL,
	DEFAULT_ANNOTATION_MODEL,
} from "./common";
import { SYSTEM_PROMPT, buildAnnotationPrompt } from "./prompt";


const BATCH_SIZE = Number(process.env.ANNOTATION_BATCH_SIZE) || 1;
const CONCURRENCY = Number(process.env.ANNOTATION_CONCURRENCY) || 3;

/** MCP server name used for the evaluate_fix tool */
const MCP_SERVER_NAME = "measure-quality";


// ── MCP server management ────────────────────────────────────────────────────

/** Register the measure-quality MCP server with codex (global config). */
const registerMcpServer = (spartitoPath: string): void => {
	// Remove any existing registration first (ignore errors)
	spawnSync("codex", ["mcp", "remove", MCP_SERVER_NAME], { stdio: "ignore" });

	const mcpCommand = "npx";
	const mcpArgs = ["tsx", path.resolve(__dirname, "measureQualityMcp.ts")];

	const result = spawnSync("codex", [
		"mcp", "add",
		"--env", `SPARTITO_PATH=${spartitoPath}`,
		MCP_SERVER_NAME,
		"--",
		mcpCommand, ...mcpArgs,
	], { stdio: "pipe", encoding: "utf8" });

	if (result.status !== 0) {
		console.warn(`  Warning: failed to register MCP server: ${result.stderr?.slice(0, 200)}`);
	}
};

/** Unregister the measure-quality MCP server from codex. */
const unregisterMcpServer = (): void => {
	spawnSync("codex", ["mcp", "remove", MCP_SERVER_NAME], { stdio: "ignore" });
};


// ── Codex subprocess ─────────────────────────────────────────────────────────

const spawnCodex = (args: string[], input: string, env: Record<string, string>, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> => {
	return new Promise((resolve) => {
		const child = spawn("codex", args, { env, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (d: string) => { stdout += d; });
		child.stderr.on("data", (d: string) => { stderr += d; });
		child.on("error", (err) => { stderr += `\nspawn error: ${err.message}`; });

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
		}, timeoutMs);

		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, code, signal, timedOut });
		});

		child.stdin.end(input);
	});
};


/** Parse JSONL output from codex --json. Collects all agent_message texts and returns them concatenated. */
const parseCodexJsonl = (output: string): { text: string; sessionId: string } => {
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


/** Run one batch through codex exec. */
const runOneBatch = async (
	batch: IssueMeasureInfo[],
	spartito: starry.Spartito,
	roundNum: number,
	batchLabel: string,
	annotationModel: string,
	logDir?: string,
): Promise<{ fixes: any[]; sessionId: string; measureIndices: number[]; sessionEnv: Record<string, string>; ok: boolean; hasFixes: boolean }> => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spartito-annotate-codex-"));
	try {
		const { text: prompt, imagePaths } = await buildAnnotationPrompt(batch, tmpDir, { imageMode: "attached" });

		if (logDir) {
			fs.writeFileSync(path.join(logDir, `r${roundNum}_${batchLabel}_prompt.txt`), prompt);
		}

		// Write spartito for MCP server
		const spartitoPath = path.join(tmpDir, "spartito.json");
		fs.writeFileSync(spartitoPath, JSON.stringify(spartito));

		// Register MCP server with this batch's spartito path
		registerMcpServer(spartitoPath);

		const env: Record<string, string> = {
			...process.env as Record<string, string>,
		};

		// Codex model: use CODEX_MODEL env or default from config.toml
		const codexModel = process.env.CODEX_MODEL || annotationModel;

		// Build codex args — prepend system prompt to user prompt
		const fullPrompt = SYSTEM_PROMPT + "\n\n---\n\n" + prompt;

		const codexArgs: string[] = [
			"exec",
			"--json",
			"--dangerously-bypass-approvals-and-sandbox",
			// Set high reasoning effort for deeper analysis
			"-c", 'model_reasoning_effort="high"',
		];

		// Add model if specified and not a third-party model
		if (codexModel && !codexModel.includes("/")) {
			codexArgs.push("-m", codexModel);
		}

		// Attach images via -i flags
		for (const imgPath of imagePaths) {
			codexArgs.push("-i", imgPath);
		}

		const { stdout: rawOutput, stderr, code, signal, timedOut } = await spawnCodex(
			codexArgs, fullPrompt, env, 20 * 60 * 1000,
		);

		if (logDir) {
			fs.writeFileSync(path.join(logDir, `r${roundNum}_${batchLabel}.jsonl`), rawOutput);
			if (stderr) fs.writeFileSync(path.join(logDir, `r${roundNum}_${batchLabel}.stderr.txt`), stderr);
		}

		if (timedOut) {
			console.warn(`  [${batchLabel}] timed out`);
			return { fixes: [], sessionId: "", measureIndices: batch.map(m => m.measureIndex), sessionEnv: env, ok: false, hasFixes: false };
		}
		if (signal) {
			console.warn(`  [${batchLabel}] killed by signal ${signal}`);
			return { fixes: [], sessionId: "", measureIndices: batch.map(m => m.measureIndex), sessionEnv: env, ok: false, hasFixes: false };
		}

		const { text: textOutput, sessionId } = parseCodexJsonl(rawOutput);

		if (code !== 0) {
			console.warn(`  [${batchLabel}] codex exited with code ${code}`);
			if (stderr) console.warn(`  stderr: ${stderr.slice(0, 500)}`);
		}

		if (!textOutput) {
			console.warn(`  [${batchLabel}] empty result`);
			return { fixes: [], sessionId, measureIndices: batch.map(m => m.measureIndex), sessionEnv: env, ok: false, hasFixes: false };
		}

		console.log(`  [${batchLabel}] Result text: ${textOutput.length} chars`);
		const fixes = parseFixes(textOutput);
		return { fixes, sessionId, measureIndices: batch.map(m => m.measureIndex), sessionEnv: env, ok: true, hasFixes: fixes.length > 0 };
	} catch (err: any) {
		console.warn(`  [${batchLabel}] failed: ${err.message?.slice(0, 200)}`);
		return { fixes: [], sessionId: "", measureIndices: batch.map(m => m.measureIndex), sessionEnv: {}, ok: false, hasFixes: false };
	} finally {
		// Clean up MCP server registration and temp dir
		unregisterMcpServer();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
};


// ── Codex AnnotationBackend ──────────────────────────────────────────────────

const createCodexBackend = (annotationModel: string): AnnotationBackend => ({
	async callAnnotation(
		issueMeasures: IssueMeasureInfo[],
		spartito: starry.Spartito,
		roundNum: number,
		logDir?: string,
	): Promise<{ fixes: any[]; batchResults: BatchResult[] }> {
		const allFixes: any[] = [];
		const batchResults: BatchResult[] = [];
		const batches: IssueMeasureInfo[][] = [];
		for (let i = 0; i < issueMeasures.length; i += BATCH_SIZE)
			batches.push(issueMeasures.slice(i, i + BATCH_SIZE));

		const total = batches.length;
		console.log(`  ${total} batches, concurrency=${CONCURRENCY}`);

		// Concurrency pool
		let consecutiveHardFails = 0;
		let aborted = false;
		let active = 0;
		let nextBatch = 0;

		await new Promise<void>((resolve) => {
			const tryLaunch = () => {
				while (!aborted && active < CONCURRENCY && nextBatch < total) {
					const bi = nextBatch++;
					const batch = batches[bi];
					const label = `b${bi + 1}`;
					const measureIds = batch.map(m => `m${m.measureIndex}`).join(",");
					console.log(`\n  Batch ${bi + 1}/${total} [${measureIds}] starting...`);
					active++;

					runOneBatch(batch, spartito, roundNum, label, annotationModel, logDir).then((r) => {
						active--;

						if (!r.ok) {
							consecutiveHardFails++;
							if (consecutiveHardFails >= CONCURRENCY * 2) {
								console.warn(`  ${consecutiveHardFails} consecutive hard failures, aborting remaining batches.`);
								aborted = true;
							}
						} else {
							consecutiveHardFails = 0;
							allFixes.push(...r.fixes);
							if (r.sessionId && r.fixes.some(f => f.status === 0)) {
								batchResults.push({
									fixes: r.fixes,
									sessionId: r.sessionId,
									measureIndices: r.measureIndices,
									env: r.sessionEnv,
								});
							}
						}

						if (active === 0 && (nextBatch >= total || aborted)) {
							resolve();
						} else {
							tryLaunch();
						}
					});
				}

				if (active === 0 && nextBatch >= total) resolve();
			};

			tryLaunch();
		});

		return { fixes: allFixes, batchResults };
	},

	async requestSummary(br: BatchResult, summaryPrompt: string): Promise<string> {
		if (!br.sessionId) return "";

		const { stdout: summaryStdout } = await spawnCodex([
			"exec",
			"resume", br.sessionId,
			"--json",
		], summaryPrompt, br.env, 3 * 60 * 1000);

		const { text } = parseCodexJsonl(summaryStdout);
		return text;
	},
});


// ── Main ─────────────────────────────────────────────────────────────────────

const main = async () => {
	const argv = parseArgs();
	const annotationModel = argv.annotationModel || DEFAULT_ANNOTATION_MODEL;
	const backend = createCodexBackend(annotationModel as string);
	await runAnnotationPipeline(backend, argv);
};

main();
