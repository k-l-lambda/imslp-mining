
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";

import {
	type IssueMeasureInfo,
	type BatchResult,
	type PreprocessBatchResult,
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
import { type PreprocessPatch, type PreprocessMidiMeasureContext, parsePreprocessPatches, applyPreprocessPatchToMeasure } from "./preprocess";
import { SYSTEM_PROMPT, buildAnnotationPrompt } from "./prompt";
import { PREPROCESS_SYSTEM_PROMPT, PREPROCESS_ALIGNMENT_SYSTEM_PROMPT, PREPROCESS_FINAL_SYSTEM_PROMPT, buildPreprocessPrompt, type PreprocessCarryContext } from "./preprocessPrompt";


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


const parseClaudeJsonOutput = (rawOutput: string): { textOutput: string; sessionId: string } => {
	try {
		const jsonResult = JSON.parse(rawOutput);
		if (Array.isArray(jsonResult)) {
			const lastItem = jsonResult[jsonResult.length - 1];
			return { textOutput: lastItem?.result || "", sessionId: lastItem?.session_id || "" };
		}
		return { textOutput: jsonResult.result || "", sessionId: jsonResult.session_id || "" };
	} catch {
		return { textOutput: rawOutput, sessionId: "" };
	}
};

const hasMidiForBatch = (batch: IssueMeasureInfo[], midiContexts?: Map<number, PreprocessMidiMeasureContext>) =>
	!!midiContexts && batch.some(issue => midiContexts.has(issue.measureIndex));

const PREPROCESS_MIDI_ALIGNMENT_PROMPT = `Align MIDI evidence to score events for the following measures.`;

const PREPROCESS_FINAL_WITH_ALIGNMENT_PROMPT = `Using the first-pass event/onset alignment plus the original measure image/data in this session, output final sparse preprocessing patches only.`;

const tokenOctaveShift = (tokenType?: string): number | undefined => {
	if (tokenType === "octave-a") return -1;
	if (tokenType === "octave-b") return 1;
	if (tokenType === "octave-0") return 0;
	return undefined;
};

const preprocessCarryContextFromMeasure = (measure: starry.SpartitoMeasure): PreprocessCarryContext => ({
	measureIndex: measure.measureIndex,
	timeSignature: measure.timeSignature,
	timeSigNumeric: measure.basics?.find((basic: any) => basic?.timeSigNumeric !== undefined)?.timeSigNumeric,
	keySignature: measure.keySignature,
	staffOctaveShifts: (measure.contexts || []).map((contexts, staff) => {
		const octaveTerms = (contexts || [])
			.filter((term: any) => typeof term?.tokenType === "string" && term.tokenType.startsWith("octave-"))
			.sort((a: any, b: any) => (a.tick ?? 0) - (b.tick ?? 0));
		const last = octaveTerms[octaveTerms.length - 1];
		return {
			staff,
			tokenType: last?.tokenType,
			octaveShift: last ? tokenOctaveShift(last.tokenType) : 0,
			tick: last?.tick,
			x: last?.x,
			y: last?.y,
		};
	}),
});

const preprocessPatchesTouchCarryContext = (patches: PreprocessPatch[]): boolean => patches.some(patch =>
	!!patch.basics?.timeSignature
	|| patch.basics?.timeSigNumeric !== undefined
	|| patch.basics?.keySignature !== undefined
	|| (patch.contexts || []).some(contextPatch => {
		const tokenType = contextPatch.term?.tokenType ?? contextPatch.match?.tokenType;
		return typeof tokenType === "string" && (tokenType.startsWith("octave-") || tokenType.startsWith("accidentals-") || tokenType.startsWith("timesig-"));
	}),
);


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
			"--effort", "high",
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

/** Run one preprocessing batch through claude -p. */
const runOnePreprocessBatch = async (
	batch: IssueMeasureInfo[],
	spartito: starry.Spartito,
	batchLabel: string,
	preprocessModel: string,
	logDir?: string,
	midiContexts?: Map<number, PreprocessMidiMeasureContext>,
	measureImagesDir?: string,
	previousContext?: PreprocessCarryContext,
): Promise<{ patches: PreprocessPatch[]; sessionId: string; measureIndices: number[]; sessionEnv: Record<string, string>; ok: boolean; hasPatches: boolean }> => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spartito-preprocess-"));
	try {
		const hasMidi = hasMidiForBatch(batch, midiContexts);
		const { text: prompt } = await buildPreprocessPrompt(batch, tmpDir, { imageMode: "path", midiContexts, measureImagesDir, previousContext });
		const { text: alignmentPrompt } = hasMidi
			? await buildPreprocessPrompt(batch, tmpDir, { imageMode: "path", midiContexts, measureImagesDir, alignmentOnly: true })
			: { text: prompt };

		if (logDir) {
			fs.writeFileSync(path.join(logDir, `pre_${batchLabel}_prompt.txt`), prompt);
			if (hasMidi) fs.writeFileSync(path.join(logDir, `pre_${batchLabel}_alignment_prompt.txt`), alignmentPrompt);
		}

		fs.writeFileSync(path.join(tmpDir, "spartito.json"), JSON.stringify(spartito));

		const env: Record<string, string> = {
			...process.env as Record<string, string>,
			ANTHROPIC_BASE_URL: ANNOTATION_BASE_URL,
			ANTHROPIC_AUTH_TOKEN: ANNOTATION_API_KEY!,
			ANTHROPIC_MODEL: preprocessModel,
			ANTHROPIC_SMALL_FAST_MODEL: preprocessModel,
		};

		const firstSystemPrompt = hasMidi ? PREPROCESS_ALIGNMENT_SYSTEM_PROMPT : PREPROCESS_SYSTEM_PROMPT;
		const firstPrompt = hasMidi ? `${PREPROCESS_MIDI_ALIGNMENT_PROMPT}\n\n${alignmentPrompt}` : prompt;

		const { stdout: rawOutput, stderr, code, signal, timedOut } = await spawnClaude([
			"-p",
			"--output-format", "json",
			"--append-system-prompt", firstSystemPrompt,
			"--allowedTools", "Read",
			"--effort", "low",
			"--verbose",
		], firstPrompt, env, 20 * 60 * 1000);

		if (logDir) {
			fs.writeFileSync(path.join(logDir, `pre_${batchLabel}.json`), rawOutput);
			if (stderr) fs.writeFileSync(path.join(logDir, `pre_${batchLabel}.stderr.txt`), stderr);
		}

		if (timedOut) {
			console.warn(`  [pre ${batchLabel}] timed out`);
			return { patches: [], sessionId: "", measureIndices: batch.map(m => m.measureIndex), sessionEnv: env, ok: false, hasPatches: false };
		}
		if (signal) {
			console.warn(`  [pre ${batchLabel}] killed by signal ${signal}`);
			return { patches: [], sessionId: "", measureIndices: batch.map(m => m.measureIndex), sessionEnv: env, ok: false, hasPatches: false };
		}

		let textOutput = "";
		let sessionId = "";
		({ textOutput, sessionId } = parseClaudeJsonOutput(rawOutput));

		if (hasMidi && sessionId && textOutput) {
			if (logDir)
				fs.writeFileSync(path.join(logDir, `pre_${batchLabel}_alignments.txt`), textOutput);
			const { stdout: finalRawOutput, stderr: finalStderr, code: finalCode, signal: finalSignal, timedOut: finalTimedOut } = await spawnClaude([
				"-p",
				"--output-format", "json",
				"--resume", sessionId,
				"--append-system-prompt", PREPROCESS_FINAL_SYSTEM_PROMPT,
				"--effort", "low",
				"--verbose",
			], `${PREPROCESS_FINAL_WITH_ALIGNMENT_PROMPT}\n\n${prompt}`, env, 20 * 60 * 1000);
			if (logDir) {
				fs.writeFileSync(path.join(logDir, `pre_${batchLabel}_final.json`), finalRawOutput);
				if (finalStderr) fs.writeFileSync(path.join(logDir, `pre_${batchLabel}_final.stderr.txt`), finalStderr);
			}
			if (finalTimedOut) {
				console.warn(`  [pre ${batchLabel}] final pass timed out`);
				return { patches: [], sessionId, measureIndices: batch.map(m => m.measureIndex), sessionEnv: env, ok: false, hasPatches: false };
			}
			if (finalSignal) {
				console.warn(`  [pre ${batchLabel}] final pass killed by signal ${finalSignal}`);
				return { patches: [], sessionId, measureIndices: batch.map(m => m.measureIndex), sessionEnv: env, ok: false, hasPatches: false };
			}
			if (finalRawOutput.includes("usage limit") || finalStderr.includes("usage limit")) {
				console.error(`\n  FATAL: API usage limit hit. Aborting.`);
				process.exit(1);
			}
			if (finalCode !== 0) {
				console.warn(`  [pre ${batchLabel}] final claude exited with code ${finalCode}`);
				if (finalStderr) console.warn(`  final stderr: ${finalStderr.slice(0, 500)}`);
			}
			const parsedFinal = parseClaudeJsonOutput(finalRawOutput);
			textOutput = parsedFinal.textOutput;
			sessionId = parsedFinal.sessionId || sessionId;
		}

		if (rawOutput.includes("usage limit") || stderr.includes("usage limit")) {
			console.error(`\n  FATAL: API usage limit hit. Aborting.`);
			process.exit(1);
		}

		if (code !== 0) {
			console.warn(`  [pre ${batchLabel}] claude exited with code ${code}`);
			if (stderr) console.warn(`  stderr: ${stderr.slice(0, 500)}`);
		}

		if (!textOutput) {
			console.warn(`  [pre ${batchLabel}] empty result`);
			return { patches: [], sessionId, measureIndices: batch.map(m => m.measureIndex), sessionEnv: env, ok: false, hasPatches: false };
		}

		console.log(`  [pre ${batchLabel}] Result text: ${textOutput.length} chars`);
		const patches = parsePreprocessPatches(textOutput);
		return { patches, sessionId, measureIndices: batch.map(m => m.measureIndex), sessionEnv: env, ok: true, hasPatches: patches.length > 0 };
	} catch (err: any) {
		console.warn(`  [pre ${batchLabel}] failed: ${err.message?.slice(0, 200)}`);
		return { patches: [], sessionId: "", measureIndices: batch.map(m => m.measureIndex), sessionEnv: {}, ok: false, hasPatches: false };
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
};


const createClaudeBackend = (annotationModel: string, preprocessModel = annotationModel): AnnotationBackend => {
	let preprocessCarryContext: PreprocessCarryContext | undefined;
	let preprocessBatchCounter = 0;
	return ({
	async callPreprocess(
		issueMeasures: IssueMeasureInfo[],
		spartito: starry.Spartito,
		logDir?: string,
		midiContexts?: Map<number, PreprocessMidiMeasureContext>,
		measureImagesDir?: string,
	): Promise<{ patches: PreprocessPatch[]; batchResults: PreprocessBatchResult[] }> {
		if (!ANNOTATION_API_KEY) {
			console.warn("ANNOTATION_API_KEY not set, skipping preprocessing.");
			return { patches: [], batchResults: [] };
		}

		const allPatches: PreprocessPatch[] = [];
		const batchResults: PreprocessBatchResult[] = [];
		const orderedMeasures = [...issueMeasures].sort((a, b) => a.measureIndex - b.measureIndex);
			const batches: IssueMeasureInfo[][] = orderedMeasures.map(measure => [measure]);

		const total = batches.length;
		console.log(`  ${total} preprocess batches, concurrency=1 (context carry-over enabled)`);

		let previousContext: PreprocessCarryContext | undefined;
		for (let bi = 0; bi < total; ++bi) {
			const batch = batches[bi];
			const label = `b${bi + 1}`;
			const measureIds = batch.map(m => `m${m.measureIndex}`).join(",");
			console.log(`\n  Preprocess batch ${bi + 1}/${total} [${measureIds}] starting...`);

			const r = await runOnePreprocessBatch(batch, spartito, label, preprocessModel, logDir, midiContexts, measureImagesDir, previousContext);
			allPatches.push(...r.patches);
			if (r.sessionId && r.hasPatches) {
				batchResults.push({
					patches: r.patches,
					sessionId: r.sessionId,
					measureIndices: r.measureIndices,
					env: r.sessionEnv,
				});
			}

			let contextChanged = preprocessPatchesTouchCarryContext(r.patches);
			for (const patch of r.patches) {
				const measure = spartito.measures[patch.measureIndex];
				if (!measure) {
					console.warn(`  m${patch.measureIndex}: measure not found, skipping preprocessing patch`);
					continue;
				}
				const result = applyPreprocessPatchToMeasure(measure, patch);
				for (const warning of result.warnings) console.warn(`  m${patch.measureIndex}: ${warning}`);
				if (result.applied) console.log(`  m${patch.measureIndex}: preprocessing patch applied`);
			}

			const lastMeasure = batch[batch.length - 1]?.measure;
			if (lastMeasure && (contextChanged || previousContext))
				previousContext = preprocessCarryContextFromMeasure(lastMeasure);
		}

		preprocessCarryContext = previousContext;
		return { patches: allPatches, batchResults };
	},

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
};


// ── Main ─────────────────────────────────────────────────────────────────────

const main = async () => {
	const argv = parseArgs();
	const annotationModel = argv.annotationModel || DEFAULT_ANNOTATION_MODEL;
	const preprocessModel = argv.preprocessModel || annotationModel;
	const backend = createClaudeBackend(annotationModel as string, preprocessModel as string);
	await runAnnotationPipeline(backend, argv);
};

main();
