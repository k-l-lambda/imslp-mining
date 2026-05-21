import fs from "fs";
import os from "os";
import path from "path";
import fetch from "isomorphic-fetch";

import {
	type IssueMeasureInfo,
	type BatchResult,
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
import { startMeasureQualityMcp, type AnthropicToolDefinition } from "./mcpStdioTools";


const BATCH_SIZE = Number(process.env.ANNOTATION_BATCH_SIZE) || 1;
const CONCURRENCY = Number(process.env.ANNOTATION_CONCURRENCY) || 3;
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

const messagesCreate = async (body: any): Promise<MessagesResponse> => {
	if (!ANTHROPIC_AUTH_TOKEN) throw new Error("ANTHROPIC_AUTH_TOKEN is not set");
	const response = await fetch(messagesUrl(), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
			"x-api-key": ANTHROPIC_AUTH_TOKEN,
		},
		body: JSON.stringify(body),
	});
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

const contentForNextTurn = (content: any[]) => content.filter(block => block?.type !== "thinking");

const thinkingConfig = () => {
	const mode = process.env.AGENT_THINKING;
	if (!mode || mode === "default") return undefined;
	if (mode === "off" || mode === "disabled") return { type: "disabled" };
	const budget = Number(mode);
	if (Number.isFinite(budget) && budget > 0) return { type: "enabled", budget_tokens: budget };
	return undefined;
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

	for (let turn = 0; turn < MAX_TURNS; ++turn) {
		const thinking = thinkingConfig();
		const request = {
			model,
			max_tokens: ANNOTATION_MAX_TOKENS,
			temperature: 0,
			system: SYSTEM_PROMPT,
			messages,
			tools,
			...(thinking ? { thinking } : {}),
		};
		const response = await messagesCreate(request);
		lastResponse = response;
		usage = response.usage;
		messages.push({ role: "assistant", content: contentForNextTurn(response.content || []) });

		const toolUses = toolUsesFromContent(response.content || []);
		const toolResults: any[] = [];
		for (const toolUse of toolUses) {
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
		messages.push({ role: "user", content: toolResults });
	}

	return {
		text: textFromContent(lastResponse?.content || []),
		sessionId: lastResponse?.id || `agent-${Date.now()}`,
		turns,
		usage,
	};
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

export const createAgentBackend = (annotationModel: string): AnnotationBackend => ({
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
		await new Promise<void>((resolve) => {
			const tryLaunch = () => {
				while (active < CONCURRENCY && nextBatch < total) {
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
						if (active === 0 && nextBatch >= total) resolve();
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

const main = async () => {
	const argv = parseArgs();
	if (argv.preprocess) console.warn("Direct agent backend does not implement preprocessing yet; continuing with annotation only.");
	const annotationModel = argv.annotationModel || DEFAULT_ANNOTATION_MODEL;
	if (!annotationModel) throw new Error("ANNOTATION_MODEL is not set");
	const backend = createAgentBackend(annotationModel);
	await runAnnotationPipeline(backend, argv);
};

if (require.main === module) {
	main().catch(err => {
		console.error(err.stack || err.message);
		process.exit(1);
	});
}
