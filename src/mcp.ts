import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLogger } from "./helpers/logger.ts";
import { server } from "./server.ts";

const logger = createLogger("mcp-server");

// --------------------------------------------------------------------------
// Import tool files to trigger their registration on the McpServer instance
// --------------------------------------------------------------------------
import "./tools/market.ts";

// --------------------------------------------------------------------------
// Main Server Transport Bootstrapper
// --------------------------------------------------------------------------
async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	logger.success(
		"Options Trading & Insights MCP Server is listening on Stdio!",
	);
}

main().catch((error) => {
	logger.fatal("MCP Server crashed during startup:", error);
	process.exit(1);
});
