import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerProjectTools } from './tools.js';
import type { CommandDeps } from './commands.js';
import type { Catalog } from './catalog.js';

export const SERVER_NAME = 'gdevelop-mcp-server';
export const SERVER_VERSION = '0.1.0';

export interface ServerOptions {
  /** Read-only catalogue (ticket #15). Omitted in unit tests that do not need it. */
  catalog?: Catalog | undefined;
}

/** Build the MCP server and register tools. Transport connects in `index.ts`. */
export function createServer(deps: CommandDeps, options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerProjectTools(server, deps, options.catalog);
  return server;
}
