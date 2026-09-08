import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadGdRuntime } from './runtime.js';
import { ProjectStore } from './sessions.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const runtime = await loadGdRuntime();
  const store = new ProjectStore(runtime.engine);
  const server = createServer({ store, engine: runtime.engine });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error('gdevelop-mcp-server failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
