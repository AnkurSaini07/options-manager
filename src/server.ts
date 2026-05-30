import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Shared high-level MCP Server instance.
 * Located in a dedicated file to prevent ESM circular dependency evaluation issues.
 */
export const server = new McpServer({
	name: "options-manager-mcp-server",
	version: "1.0.0",
});
