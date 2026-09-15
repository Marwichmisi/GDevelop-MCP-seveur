import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadGdRuntime } from './runtime.js';
import { ProjectStore } from './sessions.js';
import { Catalog } from './catalog.js';
import { GitHubCatalogSource } from './catalogSource.js';
import { AssetStore } from './assets.js';
import { HttpAssetSource } from './assetSource.js';
import { PreviewManager } from './preview.js';
import { GdPreviewExporter } from './gdPreviewExporter.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const runtime = await loadGdRuntime();
  const store = new ProjectStore(runtime.engine);
  // Lazy read-only catalogue over the pinned GDevelop sources; it fetches
  // nothing until a catalog_* tool is called (ticket #15).
  const catalog = new Catalog(new GitHubCatalogSource({ ref: process.env['GDEVELOP_CATALOG_REF'] }));
  // Lazy read-only Asset Store over the public CDN (TTL 1 h, ticket #18).
  const assets = new AssetStore(new HttpAssetSource());
  const deps = { store, engine: runtime.engine } as { store: ProjectStore; engine: typeof runtime.engine; previews?: PreviewManager };
  // Production path: real gd.Exporter over the pinned GDJS tree (research
  // §1/§3.1/§6). Unit tests keep the stub default (no WASM, no GDJS).
  deps.previews = new PreviewManager(deps, {
    exporter: new GdPreviewExporter(runtime.gd as never),
  });
  const server = createServer(deps, { catalog, assets });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error('gdevelop-mcp-server failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
