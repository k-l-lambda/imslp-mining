
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";

import {
	type IssueMeasureInfo,
	type BatchResult,
	type Fix,
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


// ── Claude subprocess ────────────────────────────────────────────────────────

const spawnClaude = (args: string[], input: string, env: Record<string, string>, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> => {
	return new Promise((resolve) => {
		const child = spawn("claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });
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


/** Run one batch (one or more measures) through claude -p. */
const runOneBatch = async (
	batch: IssueMeasureInfo[],
	spartito: starry.Spartito,
	roundNum: number,
	batchLabel: string,
	annotationModel: string,
	logDir?: string,
): Promise<{ fixes: Fix[]; sessionId: string; measureIndices: number[]; sessionEnv: Record<string, string>; ok: boolean; hasFixes: boolean }> => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spartito-annotate-"));
	try {
		const { text: prompt } = await buildAnnotationPrompt(batch, tmpDir, { imageMode: "path" });

		if (logDir) {
			fs.writeFileSync(path.join(logDir, `r${roundNum}_${batchLabel}_prompt.txt`), prompt);
		}

		fs.writeFileSync(path.join(tmpDir, "spartito.json"), JSON.stringify(spartito));

		const mcpConfig = {
			mcpServers: {
				"measure-quality": {
					command: "npx",
					args: [
					"tsx",
					"--require", path.resolve(__dirname, "suppressBanner.cjs"),
					path.resolve(__dirname, "measureQualityMcp.ts"),
				],
					env: { SPARTITO_PATH: path.join(tmpDir, "spartito.json") },
				},
			},
		};
		const mcpConfigPath = path.join(tmpDir, "mcp.json");
		fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));

		const env: Record<string, string> = {
			...process.env as Record<string, string>,
			ANTHROPIC_BASE_URL: ANNOTATION_BASE_URL,
			ANTHROPIC_AUTH_TOKEN: ANNOTATION_API_KEY!,
			ANTHROPIC_MODEL: annotationModel,
			ANTHROPIC_SMALL_FAST_MODEL: annotationModel,
		};

		const { stdout: rawOutput, stderr, code, signal, timedOut } = await spawnClaude([
			"-p",
			"--output-format", "json",
			"--append-system-prompt", SYSTEM_PROMPT,
			"--allowedTools", "Read,mcp__measure-quality__evaluate_fix",
			"--mcp-config", mcpConfigPath,
			"--effort", "max",
			"--verbose",
		], prompt, env, 20 * 60 * 1000);

		if (logDir) {
			fs.writeFileSync(path.join(logDir, `r${roundNum}_${batchLabel}.json`), rawOutput);
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

		let textOutput = "";
		let sessionId = "";
		try {
			const jsonResult = JSON.parse(rawOutput);
			if (Array.isArray(jsonResult)) {
				const lastItem = jsonResult[jsonResult.length - 1];
				textOutput = lastItem?.result || "";
				sessionId = lastItem?.session_id || "";
				if (lastItem?.usage) {
					const u = lastItem.usage;
					console.log(`  [${batchLabel}] Tokens: ${u.input_tokens || 0} in / ${u.output_tokens || 0} out, Cost: $${lastItem.total_cost_usd?.toFixed(4) ?? "?"}`);
				}
			} else {
				textOutput = jsonResult.result || "";
				sessionId = jsonResult.session_id || "";
				if (jsonResult.usage) {
					const u = jsonResult.usage;
					console.log(`  [${batchLabel}] Tokens: ${u.input_tokens || 0} in / ${u.output_tokens || 0} out`);
				}
			}
		} catch {
			textOutput = rawOutput;
		}

		if (rawOutput.includes("usage limit") || stderr.includes("usage limit")) {
			console.error(`\n  FATAL: API usage limit hit. Aborting.`);
			process.exit(1);
		}

		if (code !== 0) {
			console.warn(`  [${batchLabel}] claude exited with code ${code}`);
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
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
};


// ── Claude AnnotationBackend ─────────────────────────────────────────────────

const createClaudeBackend = (annotationModel: string): AnnotationBackend => ({
	async callAnnotation(
		issueMeasures: IssueMeasureInfo[],
		spartito: starry.Spartito,
		roundNum: number,
		logDir?: string,
	): Promise<{ fixes: Fix[]; batchResults: BatchResult[] }> {
		if (!ANNOTATION_API_KEY) {
			console.warn("ANNOTATION_API_KEY not set, skipping annotation.");
			return { fixes: [], batchResults: [] };
		}

		const allFixes: Fix[] = [];
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
		const { stdout: summaryStdout } = await spawnClaude([
			"-p",
			"--output-format", "json",
			"--resume", br.sessionId,
			"--verbose",
		], summaryPrompt, br.env, 3 * 60 * 1000);

		let summaryText = "";
		try {
			const summaryJson = JSON.parse(summaryStdout || "");
			if (Array.isArray(summaryJson)) {
				summaryText = summaryJson[summaryJson.length - 1]?.result || "";
			} else {
				summaryText = summaryJson.result || "";
			}
		} catch {
			summaryText = summaryStdout || "";
		}

		return summaryText;
	},
});


// ── Main ─────────────────────────────────────────────────────────────────────

const main = async () => {
	const argv = parseArgs();
	const annotationModel = argv.annotationModel || DEFAULT_ANNOTATION_MODEL;
	const backend = createClaudeBackend(annotationModel as string);
	await runAnnotationPipeline(backend, argv);
};

main();
