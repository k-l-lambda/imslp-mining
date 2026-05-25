import fs from "fs";
import os from "os";
import path from "path";
import fetch from "isomorphic-fetch";

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
	ANTHROPIC_AUTH_TOKEN,
	ANNOTATION_BASE_URL,
	ANNOTATION_MAX_TOKENS,
	DEFAULT_ANNOTATION_MODEL,
} from "./common";
import { SYSTEM_PROMPT, buildAnnotationPrompt } from "./prompt";
import { PREPROCESS_SYSTEM_PROMPT, PREPROCESS_ALIGNMENT_SYSTEM_PROMPT, PREPROCESS_FINAL_SYSTEM_PROMPT, buildPreprocessPrompt, type PreprocessCarryContext } from "./preprocessPrompt";
import { type PreprocessPatch, type PreprocessMidiMeasureContext, parsePreprocessPatches, applyPreprocessPatchToMeasure } from "./preprocess";
import { startMeasureQualityMcp, type AnthropicToolDefinition } from "./mcpStdioTools";


const BATCH_SIZE = Number(process.env.ANNOTATION_BATCH_SIZE) || 1;
const CONCURRENCY = Number(process.env.ANNOTATION_CONCURRENCY) || 1;
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS) || 8;


type AgentMessage = { role: "user" | "assistant"; content: string | any[] };

interface MessagesResponse {
	id?: string;
	model?: string;
	content: any[];
	stop_reason?: string;
	usage?: any;
}

interface AgentTurnLog {
	request: {
		messages: AgentMessage[];
		tools?: AnthropicToolDefinition[];
		max_tokens: number;
	};
	response: MessagesResponse;
	toolResults: any[];
}

const messagesUrl = () => {
	if (!ANNOTATION_BASE_URL) throw new Error("ANNOTATION_BASE_URL is not set");
	return `${ANNOTATION_BASE_URL.replace(/\/$/, "")}/v1/messages`;
};

const MESSAGES_TIMEOUT_MS = Number(process.env.ANNOTATION_REQUEST_TIMEOUT_MS) || 10 * 60 * 1000;

const messagesCreate = async (body: any): Promise<MessagesResponse> => {
	if (!ANTHROPIC_AUTH_TOKEN) throw new Error("ANTHROPIC_AUTH_TOKEN is not set");
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), MESSAGES_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(messagesUrl(), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				"x-api-key": ANTHROPIC_AUTH_TOKEN,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} catch (err: any) {
		if (err?.name === "AbortError") throw new Error(`Messages API timed out after ${MESSAGES_TIMEOUT_MS}ms`);
		throw err;
	} finally {
		clearTimeout(timeout);
	}
	const text = await response.text();
	let parsed: any;
	try { parsed = JSON.parse(text); }
	catch { parsed = { raw: text }; }
	if (!response.ok) throw new Error(`Messages API ${response.status}: ${JSON.stringify(parsed).slice(0, 1000)}`);
	return parsed as MessagesResponse;
};

const textFromContent = (content: any[]) => content
	.filter(block => block?.type === "text")
	.map(block => block.text || "")
	.join("\n");

const toolUsesFromContent = (content: any[]) => content.filter(block => block?.type === "tool_use");

const stripInlineThinking = (text: string) => {
	const end = text.indexOf("</think>");
	if (end < 0) return text;
	return text.slice(end + "</think>".length).trimStart();
};

const contentForNextTurn = (content: any[]) => content.flatMap(block => {
	if (block?.type === "thinking") return [];
	if (block?.type !== "text") return [block];
	const text = stripInlineThinking(block.text || "");
	return text ? [{ ...block, text }] : [];
});

const thinkingConfig = () => {
	const mode = process.env.AGENT_THINKING;
	if (mode === "off" || mode === "disabled") return { type: "disabled" };
	const budget = Number(mode || 8192);
	if (Number.isFinite(budget) && budget > 0) return { type: "enabled", budget_tokens: Math.min(budget, ANNOTATION_MAX_TOKENS - 1) };
	return undefined;
};

const chatTemplateKwargs = () => {
	const mode = process.env.AGENT_THINKING;
	if (mode === "off" || mode === "disabled") return { thinking: false, preserve_thinking: false };
	return { thinking: true, preserve_thinking: true };
};

const PREPROCESS_MAX_TOKENS = Math.max(1, Number(process.env.AGENT_PREPROCESS_MAX_TOKENS) || 65536);

const preprocessThinkingConfig = () => {
	const mode = process.env.AGENT_PREPROCESS_THINKING;
	if (mode === "off" || mode === "disabled") return { type: "disabled" };
	const budget = Number(mode || 8192);
	if (Number.isFinite(budget) && budget > 0) return { type: "enabled", budget_tokens: Math.min(budget, PREPROCESS_MAX_TOKENS - 1) };
	return undefined;
};

const preprocessChatTemplateKwargs = () => {
	const mode = process.env.AGENT_PREPROCESS_THINKING;
	if (mode === "off" || mode === "disabled") return { thinking: false, preserve_thinking: false };
	return { thinking: true, preserve_thinking: true };
};

const reasoningEffortPrompt = () => {
	if (process.env.AGENT_REASONING_EFFORT === "low") return "Reasoning Effort: Low. Use minimal reasoning. Think briefly and avoid unnecessary intermediate steps. Do not write analysis text. Either call evaluate_fix or output ONLY the final JSON fixes block.";
	return "";
};

const systemPrompt = () => {
	if (process.env.AGENT_REASONING_EFFORT === "low") return [reasoningEffortPrompt(), SYSTEM_PROMPT.replace("Think deeply and analyze each measure carefully before proposing fixes.", "Analyze privately and keep the response minimal.")].filter(Boolean).join("\n\n");
	return SYSTEM_PROMPT;
};

const mediaTypeForImage = (imagePath: string) => {
	const ext = path.extname(imagePath).toLowerCase();
	if (ext === ".png") return "image/png";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".webp") return "image/webp";
	return "application/octet-stream";
};

const buildUserContent = (prompt: string, imagePaths: string[]) => {
	const content: any[] = [{ type: "text", text: prompt }];
	for (const imagePath of imagePaths) {
		content.push({
			type: "image",
			source: {
				type: "base64",
				media_type: mediaTypeForImage(imagePath),
				data: fs.readFileSync(imagePath).toString("base64"),
			},
		});
	}
	return content;
};

const redactForLog = (value: any): any => {
	if (Array.isArray(value)) return value.map(redactForLog);
	if (!value || typeof value !== "object") return value;
	if (value.type === "image" && value.source?.data) {
		return {
			...value,
			source: {
				...value.source,
				data: `[base64:${value.source.data.length} chars]`,
			},
		};
	}
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactForLog(entry)]));
};

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

const PREPROCESS_MIDI_ALIGNMENT_PROMPT = `Align MIDI evidence to score events for the following measures.`;
const PREPROCESS_FINAL_WITH_ALIGNMENT_PROMPT = `Using the first-pass event/onset alignment plus the original measure image/data in this session, output final sparse preprocessing patches only.`;

const preprocessSystemPrompt = () => {
	const low = process.env.AGENT_REASONING_EFFORT === "low" ? "Reasoning Effort: Low. Use minimal reasoning. Think briefly and avoid unnecessary intermediate steps. Output ONLY the sparse JSON patches block." : "";
	const prompt = process.env.AGENT_REASONING_EFFORT === "low"
		? PREPROCESS_SYSTEM_PROMPT.replace("Think step by step, and inspect the image carefully before producing patches.", "Inspect the image carefully, but keep the response minimal.")
		: PREPROCESS_SYSTEM_PROMPT;
	return [low, prompt, "Accessory type tokens must be valid STARRY tokens: use prefixes scripts-, pedal-, arpeggio, fermata, wedge, accidentals-, dynamics-, clefs-, octave-, |slur, |tie, or exact tokens f/p/m/r/s/z. For dynamics text, output dynamics-* (for example dynamics-espr), never bare dynamics or subtype fields. Do not add or preserve numeric fingering/internal tokens such as one|n1, two|n2, three|n3, or four|n4 in accessory patch payloads; leave existing numeric fingering tokens unchanged unless the image clearly proves they are wrong."].filter(Boolean).join("\n\n");
};

const preprocessAlignmentSystemPrompt = () => {
	const low = process.env.AGENT_REASONING_EFFORT === "low" ? "Reasoning Effort: Low. Use minimal reasoning. Output ONLY the compact alignment JSON block." : "";
	return [low, PREPROCESS_ALIGNMENT_SYSTEM_PROMPT].filter(Boolean).join("\n\n");
};

const preprocessFinalSystemPrompt = () => {
	const low = process.env.AGENT_REASONING_EFFORT === "low" ? "Reasoning Effort: Low. Use minimal reasoning. Output ONLY the sparse JSON patches block." : "";
	return [low, PREPROCESS_FINAL_SYSTEM_PROMPT, "Accessory type tokens must be valid STARRY tokens: use prefixes scripts-, pedal-, arpeggio, fermata, wedge, accidentals-, dynamics-, clefs-, octave-, |slur, |tie, or exact tokens f/p/m/r/s/z. For dynamics text, output dynamics-* (for example dynamics-espr), never bare dynamics or subtype fields. Do not add or preserve numeric fingering/internal tokens such as one|n1, two|n2, three|n3, or four|n4 in accessory patch payloads; leave existing numeric fingering tokens unchanged unless the image clearly proves they are wrong."].filter(Boolean).join("\n\n");
};

const runAgentToolLoop = async (
	userContent: string | any[],
	model: string,
	tools: AnthropicToolDefinition[],
	callTool: (name: string, input: unknown) => Promise<string>,
): Promise<{ text: string; sessionId: string; turns: AgentTurnLog[]; usage: any }> => {
	const messages: AgentMessage[] = [{ role: "user", content: userContent }];
	const turns: AgentTurnLog[] = [];
	let usage: any;
	let lastResponse: MessagesResponse | undefined;
	const seenToolCalls = new Set<string>();

	for (let turn = 0; turn < MAX_TURNS; ++turn) {
		const thinking = thinkingConfig();
		const templateKwargs = chatTemplateKwargs();
		const request = {
			model,
			max_tokens: ANNOTATION_MAX_TOKENS,
			temperature: 0,
			system: systemPrompt(),
			messages,
			tools,
			...(thinking ? { thinking } : {}),
			...(templateKwargs ? { chat_template_kwargs: templateKwargs } : {}),
		};
		const response = await messagesCreate(request);
		lastResponse = response;
		usage = response.usage;
		messages.push({ role: "assistant", content: contentForNextTurn(response.content || []) });

		const toolUses = toolUsesFromContent(response.content || []);
		const repeatedToolUse = toolUses.length > 0 && toolUses.every(toolUse => seenToolCalls.has(`${toolUse.name}:${JSON.stringify(toolUse.input || {})}`));
		if (repeatedToolUse) {
			turns.push({
				request: { messages: redactForLog([...messages]), tools, max_tokens: ANNOTATION_MAX_TOKENS },
				response,
				toolResults: toolUses.map(toolUse => ({
					type: "tool_result",
					tool_use_id: toolUse.id,
					content: "This exact evaluate_fix call was already evaluated and rejected as worse.",
					is_error: true,
				})),
			});
			return {
				text: "[]",
				sessionId: response.id || `agent-${Date.now()}`,
				turns,
				usage,
			};
		}
		const toolResults: any[] = [];
		for (const toolUse of toolUses) {
			seenToolCalls.add(`${toolUse.name}:${JSON.stringify(toolUse.input || {})}`);
			try {
				const result = await callTool(toolUse.name, toolUse.input || {});
				toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
			}
			catch (err: any) {
				toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: err.message, is_error: true });
			}
		}


		turns.push({
			request: { messages: redactForLog([...messages]), tools, max_tokens: ANNOTATION_MAX_TOKENS },
			response,
			toolResults,
		});

		if (!toolUses.length) {
			return {
				text: textFromContent(response.content || []),
				sessionId: response.id || `agent-${Date.now()}`,
				turns,
				usage,
			};
		}
		messages.push({
			role: "user",
			content: repeatedToolUse
				? [{ type: "text", text: "You repeated the same evaluate_fix call. Do not call tools again. Use the previous evaluation result and output ONLY the final JSON fixes block now." }]
				: [
					...toolResults,
					{ type: "text", text: "Use the evaluation result above. If the fix is acceptable, stop calling tools and output ONLY the final JSON fixes block." },
				],
		});
	}

	return {
		text: textFromContent(lastResponse?.content || []),
		sessionId: lastResponse?.id || `agent-${Date.now()}`,
		turns,
		usage,
	};
};

const hasMidiForBatch = (batch: IssueMeasureInfo[], midiContexts?: Map<number, PreprocessMidiMeasureContext>) =>
	!!midiContexts && batch.some(issue => midiContexts.has(issue.measureIndex));

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
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spartito-agent-preprocess-"));
	try {
		const hasMidi = hasMidiForBatch(batch, midiContexts);
		const { text: prompt, imagePaths } = await buildPreprocessPrompt(batch, tmpDir, { imageMode: "attached", midiContexts, measureImagesDir, previousContext });
		const { text: alignmentPrompt, imagePaths: alignmentImagePaths } = hasMidi
			? await buildPreprocessPrompt(batch, tmpDir, { imageMode: "attached", midiContexts, measureImagesDir, alignmentOnly: true })
			: { text: prompt, imagePaths };
		if (logDir) {
			fs.writeFileSync(path.join(logDir, `pre_${batchLabel}_prompt.txt`), prompt);
			if (hasMidi) fs.writeFileSync(path.join(logDir, `pre_${batchLabel}_alignment_prompt.txt`), alignmentPrompt);
		}

		const thinking = preprocessThinkingConfig();
		const templateKwargs = preprocessChatTemplateKwargs();
		const firstMessages: AgentMessage[] = [{
			role: "user",
			content: buildUserContent(hasMidi ? `${PREPROCESS_MIDI_ALIGNMENT_PROMPT}\n\n${alignmentPrompt}` : prompt, hasMidi ? alignmentImagePaths : imagePaths),
		}];
		const firstRequest = {
			model: preprocessModel,
			max_tokens: PREPROCESS_MAX_TOKENS,
			temperature: 0,
			system: hasMidi ? preprocessAlignmentSystemPrompt() : preprocessSystemPrompt(),
			messages: firstMessages,
			...(thinking ? { thinking } : {}),
			...(templateKwargs ? { chat_template_kwargs: templateKwargs } : {}),
		};
		const firstResponse = await messagesCreate(firstRequest);
		const firstText = textFromContent(firstResponse.content || []);
		if (logDir) fs.writeFileSync(path.join(logDir, `pre_${batchLabel}.json`), JSON.stringify({ request: redactForLog(firstRequest), response: firstResponse }, null, 2));

		let text = firstText;
		let sessionId = firstResponse.id || `pre-${Date.now()}`;
		let usage = firstResponse.usage;
		if (hasMidi && firstText) {
			if (logDir) fs.writeFileSync(path.join(logDir, `pre_${batchLabel}_alignments.txt`), firstText);
			const finalMessages: AgentMessage[] = [
				...firstMessages,
				{ role: "assistant", content: contentForNextTurn(firstResponse.content || []) },
				{ role: "user", content: buildUserContent(`${PREPROCESS_FINAL_WITH_ALIGNMENT_PROMPT}\n\n${prompt}`, imagePaths) },
			];
			const finalRequest = {
				model: preprocessModel,
				max_tokens: PREPROCESS_MAX_TOKENS,
				temperature: 0,
				system: preprocessFinalSystemPrompt(),
				messages: finalMessages,
				...(thinking ? { thinking } : {}),
				...(templateKwargs ? { chat_template_kwargs: templateKwargs } : {}),
			};
			const finalResponse = await messagesCreate(finalRequest);
			text = textFromContent(finalResponse.content || []);
			sessionId = finalResponse.id || sessionId;
			usage = finalResponse.usage;
			if (logDir) fs.writeFileSync(path.join(logDir, `pre_${batchLabel}_final.json`), JSON.stringify({ request: redactForLog(finalRequest), response: finalResponse }, null, 2));
		}

		if (usage) console.log(`  [pre ${batchLabel}] Tokens: ${usage.input_tokens || 0} in / ${usage.output_tokens || 0} out`);
		if (!text) {
			console.warn(`  [pre ${batchLabel}] empty result`);
			return { patches: [], sessionId, measureIndices: batch.map(m => m.measureIndex), sessionEnv: {}, ok: false, hasPatches: false };
		}

		console.log(`  [pre ${batchLabel}] Result text: ${text.length} chars`);
		const patches = parsePreprocessPatches(text);
		return { patches, sessionId, measureIndices: batch.map(m => m.measureIndex), sessionEnv: {}, ok: true, hasPatches: patches.length > 0 };
	} catch (err: any) {
		console.warn(`  [pre ${batchLabel}] failed: ${err.message?.slice(0, 300)}`);
		return { patches: [], sessionId: "", measureIndices: batch.map(m => m.measureIndex), sessionEnv: {}, ok: false, hasPatches: false };
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
};

const runOneBatch = async (
	batch: IssueMeasureInfo[],
	spartito: starry.Spartito,
	roundNum: number,
	batchLabel: string,
	annotationModel: string,
	logDir?: string,
): Promise<{ fixes: Fix[]; sessionId: string; measureIndices: number[]; sessionEnv: Record<string, string>; ok: boolean }> => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spartito-agent-"));
	let mcp: Awaited<ReturnType<typeof startMeasureQualityMcp>> | undefined;
	try {
		const { text: prompt, imagePaths } = await buildAnnotationPrompt(batch, tmpDir, { imageMode: "attached" });
		if (logDir) fs.writeFileSync(path.join(logDir, `r${roundNum}_${batchLabel}_prompt.txt`), prompt);

		const spartitoPath = path.join(tmpDir, "spartito.json");
		fs.writeFileSync(spartitoPath, JSON.stringify(spartito));
		mcp = await startMeasureQualityMcp(spartitoPath);
		const tools = await mcp.anthropicTools();

		const userContent = buildUserContent(prompt, imagePaths);
		const result = await runAgentToolLoop(userContent, annotationModel, tools, (name, input) => mcp!.callTool(name, input));
		if (logDir) fs.writeFileSync(path.join(logDir, `r${roundNum}_${batchLabel}.json`), JSON.stringify(result.turns, null, 2));

		if (result.usage) {
			console.log(`  [${batchLabel}] Tokens: ${result.usage.input_tokens || 0} in / ${result.usage.output_tokens || 0} out`);
		}

		if (!result.text) {
			console.warn(`  [${batchLabel}] empty result`);
			return { fixes: [], sessionId: result.sessionId, measureIndices: batch.map(m => m.measureIndex), sessionEnv: {}, ok: false };
		}

		console.log(`  [${batchLabel}] Result text: ${result.text.length} chars`);
		const fixes = parseFixes(result.text);
		return { fixes, sessionId: result.sessionId, measureIndices: batch.map(m => m.measureIndex), sessionEnv: {}, ok: true };
	} catch (err: any) {
		console.warn(`  [${batchLabel}] failed: ${err.message?.slice(0, 300)}`);
		return { fixes: [], sessionId: "", measureIndices: batch.map(m => m.measureIndex), sessionEnv: {}, ok: false };
	} finally {
		if (mcp) await mcp.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
};

export const createAgentBackend = (annotationModel: string, preprocessModel = annotationModel): AnnotationBackend => {
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
			if (!ANTHROPIC_AUTH_TOKEN) {
				console.warn("ANTHROPIC_AUTH_TOKEN not set, skipping preprocessing.");
				return { patches: [], batchResults: [] };
			}

			const allPatches: PreprocessPatch[] = [];
			const batchResults: PreprocessBatchResult[] = [];
			const batches = [...issueMeasures].sort((a, b) => a.measureIndex - b.measureIndex).map(measure => [measure]);
			console.log(`  ${batches.length} preprocess batches, concurrency=1 (context carry-over enabled)`);

			let previousContext = preprocessCarryContext;
			for (let bi = 0; bi < batches.length; ++bi) {
				const batch = batches[bi];
				const label = `b${++preprocessBatchCounter}`;
				const measureIds = batch.map(m => `m${m.measureIndex}`).join(",");
				console.log(`\n  Preprocess batch ${bi + 1}/${batches.length} [${measureIds}] starting...`);

				const r = await runOnePreprocessBatch(batch, spartito, label, preprocessModel, logDir, midiContexts, measureImagesDir, previousContext);
				if (!r.ok) throw new Error(`Preprocess batch ${label} failed for ${measureIds}`);
					allPatches.push(...r.patches);
				if (r.sessionId && r.hasPatches) batchResults.push({ patches: r.patches, sessionId: r.sessionId, measureIndices: r.measureIndices, env: r.sessionEnv });

				const contextChanged = preprocessPatchesTouchCarryContext(r.patches);
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
				if (lastMeasure && (contextChanged || previousContext)) previousContext = preprocessCarryContextFromMeasure(lastMeasure);
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
		if (!ANTHROPIC_AUTH_TOKEN) {
			console.warn("ANTHROPIC_AUTH_TOKEN not set, skipping annotation.");
			return { fixes: [], batchResults: [] };
		}

		const allFixes: Fix[] = [];
		const batchResults: BatchResult[] = [];
		const batches: IssueMeasureInfo[][] = [];
		for (let i = 0; i < issueMeasures.length; i += BATCH_SIZE)
			batches.push(issueMeasures.slice(i, i + BATCH_SIZE));

		const total = batches.length;
		console.log(`  ${total} batches, concurrency=${CONCURRENCY}`);

		let active = 0;
		let nextBatch = 0;
			let failedBatch = "";
		await new Promise<void>((resolve) => {
			const tryLaunch = () => {
				while (!failedBatch && active < CONCURRENCY && nextBatch < total) {
					const bi = nextBatch++;
					const batch = batches[bi];
					const label = `b${bi + 1}`;
					const measureIds = batch.map(m => `m${m.measureIndex}`).join(",");
					console.log(`\n  Batch ${bi + 1}/${total} [${measureIds}] starting...`);
					active++;

					runOneBatch(batch, spartito, roundNum, label, annotationModel, logDir).then((r) => {
						active--;
						if (r.ok) {
							allFixes.push(...r.fixes);
							if (r.sessionId && r.fixes.some(f => f.status === 0)) {
								batchResults.push({ fixes: r.fixes, sessionId: r.sessionId, measureIndices: r.measureIndices, env: r.sessionEnv });
							}
						}
						if (active === 0 && (nextBatch >= total || failedBatch)) resolve();
						else tryLaunch();
					});
				}
				if (active === 0 && nextBatch >= total) resolve();
			};
			tryLaunch();
		});

		return { fixes: allFixes, batchResults };
	},

	async requestSummary(): Promise<string> {
		return "Summary is not implemented for the direct agent backend yet.";
	},
	});
};

const main = async () => {
	const argv = parseArgs();
	const annotationModel = argv.annotationModel || DEFAULT_ANNOTATION_MODEL;
	if (!annotationModel) throw new Error("ANNOTATION_MODEL is not set");
	const preprocessModel = argv.preprocessModel || annotationModel;
	const backend = createAgentBackend(annotationModel, preprocessModel);
	await runAnnotationPipeline(backend, argv);
};

if (require.main === module) {
	main().catch(err => {
		console.error(err.stack || err.message);
		process.exit(1);
	});
}
