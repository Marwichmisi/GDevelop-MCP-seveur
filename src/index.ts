import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadGdRuntime } from './runtime.js';
import { ProjectStore } from './sessions.js';
import { Catalog } from './catalog.js';
import { GitHubCatalogSource } from './catalogSource.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const runtime = await loadGdRuntime();
  const store = new ProjectStore(runtime.engine);
  // Lazy read-only catalogue over the pinned GDevelop sources; it fetches
  // nothing until a catalog_* tool is called (ticket #15).
  const catalog = new Catalog(new GitHubCatalogSource({ ref: process.env['GDEVELOP_CATALOG_REF'] }));
  const server = createServer({ store, engine: runtime.engine }, { catalog });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error('gdevelop-mcp-server failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
