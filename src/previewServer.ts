import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

/**
 * Static loopback preview server (issue #16).
 *
 * Primary-source model: `982945902/gdevelop-mcp-server/src/static-preview-server.js`
 * (GET/HEAD only, containment via `path.resolve`, `.wasm → application/wasm`,
 * `Cache-Control: no-store`, `listen(0)` random port) + union MIME table with
 * gb2b `mimeFor` for `.mjs`/fonts. Every claim cites
 * `docs/research/gdevelop-mcp-preview-research.md` §3.2–3.3.
 */

const MIME_TABLE: Record<string, string> = {
  '.css': 'text/css',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export function mimeForPath(filePath: string): string {
  return MIME_TABLE[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export interface StaticPreviewServer {
  url: string;
  port: number;
  root: string;
  close(): Promise<void>;
}

export async function startStaticPreviewServer(options: {
  rootDirectory: string;
  host?: string | undefined;
}): Promise<StaticPreviewServer> {
  const host = options.host ?? '127.0.0.1';
  const resolvedRoot = resolve(options.rootDirectory);
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void serveFile(req, res, resolvedRoot);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://${host}:${port}/`,
    port,
    root: resolvedRoot,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error?: Error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      });
    },
  };
}

async function serveFile(req: IncomingMessage, res: ServerResponse, resolvedRoot: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
    res.end('Method Not Allowed');
    return;
  }
  let pathname: string;
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'Cache-Control': 'no-store' });
    res.end('Bad Request');
    return;
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolvedPath = resolve(resolvedRoot, relative);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + sep)) {
    res.writeHead(403, { 'Cache-Control': 'no-store' });
    res.end('Forbidden');
    return;
  }
  let isFile = false;
  try {
    isFile = statSync(resolvedPath).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    res.writeHead(404, { 'Cache-Control': 'no-store' });
    res.end('Not Found');
    return;
  }
  res.writeHead(200, { 'Content-Type': mimeForPath(resolvedPath), 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(resolvedPath);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500, { 'Cache-Control': 'no-store' });
    res.end();
  });
  stream.pipe(res);
}
