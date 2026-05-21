import fs from "fs";
import path from "path";
import fetch from "isomorphic-fetch";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import "../../env";
import { ANTHROPIC_AUTH_TOKEN, ANNOTATION_BASE_URL, ANNOTATION_MAX_TOKENS, ANNOTATION_MODEL as DEFAULT_ANNOTATION_MODEL } from "../libs/constants";
import { starry } from "../libs/omr";
import { startMeasureQualityMcp, type AnthropicToolDefinition } from "./mcpStdioTools";


type MessageContent = string | any[];

interface AgentMessage {
	role: "user" | "assistant";
	content: MessageContent;
}

interface MessagesRequest {
	model: string;
	max_tokens: number;
	system?: string;
	messages: AgentMessage[];
	tools?: AnthropicToolDefinition[];
	temperature?: number;
	thinking?: any;
}

interface MessagesResponse {
	id?: string;
	type?: string;
	role?: string;
	content: any[];
	model?: string;
	stop_reason?: string;
	usage?: any;
}

const baseUrl = () => {
	const base = ANNOTATION_BASE_URL;
	if (!base) throw new Error("ANNOTATION_BASE_URL is not set");
	return `${base.replace(/\/$/, "")}/v1/messages`;
};

const modelName = () => {
	if (!DEFAULT_ANNOTATION_MODEL) throw new Error("ANNOTATION_MODEL is not set");
	return DEFAULT_ANNOTATION_MODEL;
};

const authToken = () => {
	if (!ANTHROPIC_AUTH_TOKEN) throw new Error("ANTHROPIC_AUTH_TOKEN is not set");
	return ANTHROPIC_AUTH_TOKEN;
};

const messagesCreate = async (request: Omit<MessagesRequest, "model"> & { model?: string }): Promise<MessagesResponse> => {
	const body: MessagesRequest = {
		model: request.model || modelName(),
		...request,
	};
	const response = await fetch(baseUrl(), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
			"x-api-key": authToken(),
		},
		body: JSON.stringify(body),
	});
	const text = await response.text();
	let parsed: any;
	try { parsed = JSON.parse(text); }
	catch { parsed = { raw: text }; }
	if (!response.ok) {
		throw new Error(`Messages API ${response.status}: ${JSON.stringify(parsed).slice(0, 1000)}`);
	}
	return parsed as MessagesResponse;
};

const textFromContent = (content: any[]): string => content
	.filter(block => block?.type === "text")
	.map(block => block.text || "")
	.join("\n");

const toolUsesFromContent = (content: any[]): any[] => content.filter(block => block?.type === "tool_use");

const printResponseSummary = (response: MessagesResponse) => {
	const text = textFromContent(response.content || []);
	const thinkingChars = (response.content || [])
		.filter(block => block?.type === "thinking")
		.reduce((sum, block) => sum + (block.thinking || "").length, 0);
	console.log(JSON.stringify({
		model: response.model,
		stop_reason: response.stop_reason,
		content_types: (response.content || []).map(block => block.type),
		text_preview: text.slice(0, 500),
		text_chars: text.length,
		thinking_chars: thinkingChars,
		usage: response.usage,
	}, null, 2));
};

const loadSpartito = (spartitoPath: string): starry.Spartito => {
	const json = JSON.parse(fs.readFileSync(spartitoPath, "utf-8"));
	return starry.recoverJSON<starry.Spartito>(json, starry);
};

const normalizeFixEvent = (event: any) => ({
	id: event.id,
	tick: Number.isFinite(event.tick) ? event.tick : 0,
	tickGroup: Number.isFinite(event.tickGroup) ? event.tickGroup : null,
	timeWarp: event.timeWarp && typeof event.timeWarp === "object" ? event.timeWarp : null,
	division: Number.isFinite(event.division) ? event.division : undefined,
	dots: Number.isFinite(event.dots) ? event.dots : undefined,
	beam: event.beam || undefined,
	grace: event.grace === "grace" ? true : event.grace || undefined,
});

const existingFixForMeasure = (spartitoPath: string, measureIndex: number) => {
	const spartito = loadSpartito(spartitoPath);
	let actualMeasureIndex = measureIndex;
	let measure = spartito.measures[actualMeasureIndex];
	if (!measure) throw new Error(`Measure ${measureIndex} not found`);
	let solution = measure.asSolution();
	if (!solution) {
		const fallbackIndex = spartito.measures.findIndex(m => !!m.asSolution());
		if (fallbackIndex < 0) throw new Error(`No measures have a current solution in ${spartitoPath}`);
		actualMeasureIndex = fallbackIndex;
		measure = spartito.measures[actualMeasureIndex];
		solution = measure.asSolution();
		console.warn(`Measure ${measureIndex} has no current solution; using m${actualMeasureIndex} for MCP smoke test.`);
	}
	return {
		measureIndex: actualMeasureIndex,
		events: solution!.events.map(normalizeFixEvent),
		voices: solution!.voices,
		duration: solution!.duration,
	};
};

const runToolLoop = async (prompt: string, tools: AnthropicToolDefinition[], callTool: (name: string, input: unknown) => Promise<string>, maxTokens: number) => {
	const messages: AgentMessage[] = [{ role: "user", content: prompt }];
	let lastResponse: MessagesResponse | undefined;
	for (let turn = 0; turn < 8; turn++) {
		const response = await messagesCreate({
			max_tokens: maxTokens,
			temperature: 0,
			messages,
			tools,
		});
		lastResponse = response;
		messages.push({ role: "assistant", content: response.content });
		const toolUses = toolUsesFromContent(response.content || []);
		if (!toolUses.length) return { response, messages, turns: turn + 1 };

		const toolResults = [];
		for (const toolUse of toolUses) {
			try {
				const result = await callTool(toolUse.name, toolUse.input || {});
				toolResults.push({
					type: "tool_result",
					tool_use_id: toolUse.id,
					content: result,
				});
			}
			catch (err: any) {
				toolResults.push({
					type: "tool_result",
					tool_use_id: toolUse.id,
					content: err.message,
					is_error: true,
				});
			}
		}
		messages.push({ role: "user", content: toolResults });
	}
	throw new Error(`Tool loop exceeded max turns; last stop_reason=${lastResponse?.stop_reason}`);
};

const main = async () => {
	const argv = yargs(hideBin(process.argv))
		.command("ping", "Call the Messages API without tools")
		.command("list-tools", "Start measure-quality MCP and list tools")
		.command("call-evaluate-fix", "Call evaluate_fix directly through MCP")
		.command("ask-tool", "Ask the configured model to call evaluate_fix")
		.option("spartito", { type: "string", describe: "Path to spartito JSON" })
		.option("measure", { type: "number", default: 0, describe: "Measure index" })
		.option("max-tokens", { type: "number", default: Math.min(ANNOTATION_MAX_TOKENS || 4096, 8192), describe: "Messages API max_tokens" })
		.demandCommand(1)
		.help()
		.argv as any;

	const command = argv._[0];

	if (command === "ping") {
		const response = await messagesCreate({
			max_tokens: argv.maxTokens,
			temperature: 0,
			messages: [{ role: "user", content: "Reply with exactly OK." }],
		});
		printResponseSummary(response);
		return;
	}

	if (!argv.spartito) throw new Error("--spartito is required");
	const spartitoPath = path.resolve(argv.spartito);
	const mcp = await startMeasureQualityMcp(spartitoPath);
	try {
		if (command === "list-tools") {
			const tools = await mcp.listTools();
			console.log(JSON.stringify(tools, null, 2));
			return;
		}

		if (command === "call-evaluate-fix") {
			const fix = existingFixForMeasure(spartitoPath, argv.measure);
			const result = await mcp.callTool("evaluate_fix", fix);
			console.log(result);
			return;
		}

		if (command === "ask-tool") {
			const fix = existingFixForMeasure(spartitoPath, argv.measure);
			const tools = await mcp.anthropicTools();
			const prompt = [
				"Call the evaluate_fix tool exactly once with this candidate fix, then summarize whether it improves the measure.",
				"Do not modify the fix before calling the tool.",
				JSON.stringify(fix),
			].join("\n\n");
			const { response, turns } = await runToolLoop(prompt, tools, (name, input) => mcp.callTool(name, input), argv.maxTokens);
			console.log(JSON.stringify({ turns }, null, 2));
			printResponseSummary(response);
			return;
		}

		throw new Error(`Unknown command: ${command}`);
	}
	finally {
		await mcp.close();
	}
};

main().catch(err => {
	console.error(err.stack || err.message);
	process.exit(1);
});
