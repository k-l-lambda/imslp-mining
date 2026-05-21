import path from "path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";


export interface AnthropicToolDefinition {
	name: string;
	description?: string;
	input_schema: Record<string, unknown>;
}

export interface McpToolBridge {
	listTools(): Promise<any[]>;
	anthropicTools(): Promise<AnthropicToolDefinition[]>;
	callTool(name: string, input: unknown): Promise<string>;
	close(): Promise<void>;
}

const repoRoot = path.resolve(__dirname, "../..");
const suppressBannerPath = path.resolve(__dirname, "suppressBanner.cjs");
const measureQualityMcpPath = path.resolve(__dirname, "measureQualityMcp.ts");

const stringifyMcpContent = (content: any[]): string => content.map(item => {
	if (item.type === "text") return item.text;
	if (item.type === "image") return `[image:${item.mimeType || "unknown"}]`;
	if (item.type === "audio") return `[audio:${item.mimeType || "unknown"}]`;
	if (item.type === "resource") return item.resource?.text || item.resource?.uri || JSON.stringify(item.resource);
	return JSON.stringify(item);
}).join("\n");

export const startMeasureQualityMcp = async (spartitoPath: string): Promise<McpToolBridge> => {
	const client = new Client({ name: "agent-harness", version: "1.0.0" });
	const transport = new StdioClientTransport({
		command: "npx",
		args: ["tsx", "--require", suppressBannerPath, measureQualityMcpPath],
		cwd: repoRoot,
		env: {
			...process.env as Record<string, string>,
			SPARTITO_PATH: spartitoPath,
		},
		stderr: "pipe",
	});

	const stderr = transport.stderr;
	if (stderr) {
		stderr.on("data", chunk => {
			const text = chunk.toString();
			if (text.trim()) process.stderr.write(`[measure-quality] ${text}`);
		});
	}

	await client.connect(transport);

	return {
		async listTools() {
			const result = await client.listTools();
			return result.tools;
		},

		async anthropicTools() {
			const result = await client.listTools();
			return result.tools.map(tool => ({
				name: tool.name,
				description: tool.description,
				input_schema: tool.inputSchema,
			}));
		},

		async callTool(name: string, input: unknown) {
			const result = await client.callTool({ name, arguments: input as any });
			return stringifyMcpContent(result.content as any[] || []);
		},

		async close() {
			await client.close();
		},
	};
};
