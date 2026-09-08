import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerProjectTools } from './tools.js';
import type { CommandDeps } from './commands.js';

export const SERVER_NAME = 'gdevelop-mcp-server';
export const SERVER_VERSION = '0.1.0';

/** Build the MCP server and register tools. Transport connects in `index.ts`. */
export function createServer(deps: CommandDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerProjectTools(server, deps);
  return server;
}
