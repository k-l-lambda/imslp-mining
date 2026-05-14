import fs from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';


type NoteOnPoint = [number, number, number];

const onsetsPath = process.env.ONSETS_PATH;
if (!onsetsPath || !fs.existsSync(onsetsPath)) {
	process.stderr.write(`ONSETS_PATH not set or file not found: ${onsetsPath}\n`);
	process.exit(1);
}

const onsets = JSON.parse(fs.readFileSync(onsetsPath, 'utf8')) as NoteOnPoint[];
const tau1 = (tau: number) => Number(tau.toFixed(1));

const server = new McpServer({
	name: 'midi-onsets',
	version: '1.0.0',
});

const querySchema: any = {
	offset: z.coerce.number().int().min(0).describe('Absolute onset index to start from'),
	count: z.coerce.number().int().min(1).max(500).describe('Number of onset elements to return'),
};

(server as any).tool(
	'get_onsets',
	'Query target MIDI onset elements by absolute onset index offset and count. Returns objects with index, pitch, tick, and tau rounded to 1 decimal.',
	querySchema,
	async ({ offset, count }: any) => {
		const items = onsets.slice(offset, offset + count).map(([pitch, tick, tau], i) => ({
			index: offset + i,
			pitch,
			tick,
			tau: tau1(tau),
		}));
		return {
			content: [{
				type: 'text' as const,
				text: JSON.stringify({ offset, count: items.length, total: onsets.length, onsets: items }, null, '\t'),
			}],
		};
	},
);

const transport = new StdioServerTransport();
server.connect(transport);
