// Pre-require hook: intercept stdout to suppress the starry-omr banner.
// The omr bundle prints a version banner to stdout via console.info on import,
// which corrupts the JSON-RPC stdio stream used by MCP.
const origWrite = process.stdout.write.bind(process.stdout);
let suppress = true;
process.stdout.write = function (chunk, ...args) {
	if (suppress) {
		const str = typeof chunk === "string" ? chunk : chunk.toString();
		if (!str.startsWith("{")) {
			return process.stderr.write(chunk, ...args);
		}
		suppress = false;
	}
	return origWrite(chunk, ...args);
};
