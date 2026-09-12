import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { McpError } from './errors.js';

/**
 * Pinned catalogue source (ticket #15). The catalogue never reads the local
 * project or the engine: it parses the pinned GDevelop source tree, exactly like
 * `gb2b/gdevelop-mcp` (`src/core/cache.ts`). The real implementation caches the
 * tree on disk and only checks `releases/latest` for freshness; tests inject a
 * fixture source, so the unit suite needs no network.
 *
 * See `docs/research/gdevelop-mcp-catalogue-research.md` §3.4 and §5.
 */

export interface CatalogSourceFile {
  /** Repository-relative path, e.g. `Extensions/DialogueTree/JsExtension.js`. */
  path: string;
  source: string;
}

export interface CatalogSourceSnapshot {
  /** Pinned ref (tag/branch/sha) the files were read from. */
  ref: string;
  /** Tree sha resolved for that ref, when the source can provide one. */
  sha: string | null;
  syncedAt: string;
  files: CatalogSourceFile[];
}

export interface CatalogSource {
  load(options?: { refresh?: boolean | undefined }): Promise<CatalogSourceSnapshot>;
  /** Latest `4ian/GDevelop` release tag, for the staleness check. */
  latestReleaseRef(): Promise<string | null>;
}

const EXCLUDED_SEGMENTS = [
  '/tests/',
  '/benchmarks/',
  '/__tests__/',
  '/node_modules/',
  '/.github/',
  '/locale/',
  '/locales/',
  '/Translations/',
  '/dist/',
  '/build/',
];

const MAX_FILE_BYTES = 1_000_000;

/**
 * Paths the catalogue parses: builtin C++ extensions, plus extension C++/JS/TS
 * sources. `.ts` files are kept for `eventsBased*` markers.
 */
export function isCatalogSourcePath(path: string, size = 0): boolean {
  if (size > MAX_FILE_BYTES) return false;
  if (EXCLUDED_SEGMENTS.some((segment) => path.includes(segment))) return false;
  const name = path.split('/').pop() ?? '';
  if (name.endsWith('.d.ts')) return false;
  if (path.startsWith('Core/GDCore/Extensions/Builtin/')) return name.endsWith('.cpp');
  if (!path.startsWith('Extensions/')) return false;
  return name === 'JsExtension.js' || name.endsWith('.cpp') || name.endsWith('.ts');
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string) => Promise<FetchResponseLike>;

export interface GitHubCatalogSourceOptions {
  /** `owner/repo` of the canonical sources. Defaults to `4ian/GDevelop`. */
  repo?: string | undefined;
  /** Pinned ref (tag/branch/sha). Defaults to the latest release tag, then `master`. */
  ref?: string | undefined;
  /** Cache root. Defaults to `GDEVELOP_CATALOG_CACHE` or `~/.cache/gdevelop-mcp`. */
  cacheDir?: string | undefined;
  /** Injected fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: FetchLike | undefined;
  /** Injected clock (tests). */
  now?: (() => Date) | undefined;
  /** Parallel downloads. Defaults to 8. */
  concurrency?: number | undefined;
}

interface GitHubTreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
}

interface CatalogManifest {
  ref: string;
  sha: string | null;
  syncedAt: string;
  files: { path: string; size: number }[];
}

function safeRef(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9._-]/g, '_');
}


/**
 * GitHub-backed pinned source: tree listing via the GitHub API, file contents via
 * `raw.githubusercontent.com`, cached under `<cacheDir>/ref-<ref>/`.
 */
export class GitHubCatalogSource implements CatalogSource {
  private readonly repo: string;
  private readonly ref: string | undefined;
  private readonly cacheDir: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly concurrency: number;

  constructor(options: GitHubCatalogSourceOptions = {}) {
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!fetchImpl) {
      throw catalogError('No fetch implementation available: Node.js 20+ is required.');
    }
    this.fetchImpl = fetchImpl;
    this.repo = options.repo ?? '4ian/GDevelop';
    this.ref = options.ref;
    this.cacheDir =
      options.cacheDir ?? process.env['GDEVELOP_CATALOG_CACHE'] ?? join(homedir(), '.cache', 'gdevelop-mcp');
    this.now = options.now ?? (() => new Date());
    this.concurrency = options.concurrency ?? 8;
  }

  private refRoot(ref: string): string {
    return join(this.cacheDir, `ref-${safeRef(ref)}`);
  }

  private async json(url: string): Promise<unknown> {
    const response = await this.fetchImpl(url);
    if (!response.ok) throw catalogError(`GitHub request failed (${response.status}): ${url}`);
    return response.json();
  }

  async latestReleaseRef(): Promise<string | null> {
    const data = (await this.json(`https://api.github.com/repos/${this.repo}/releases/latest`)) as {
      tag_name?: unknown;
    };
    return typeof data.tag_name === 'string' && data.tag_name !== '' ? data.tag_name : null;
  }

  private readCache(ref: string): CatalogSourceSnapshot | null {
    const root = this.refRoot(ref);
    const manifestPath = join(root, 'manifest.json');
    if (!existsSync(manifestPath)) return null;
    let manifest: CatalogManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CatalogManifest;
    } catch {
      return null;
    }
    const files: CatalogSourceFile[] = [];
    for (const entry of manifest.files ?? []) {
      const filePath = join(root, 'sources', entry.path);
      if (!existsSync(filePath)) return null;
      files.push({ path: entry.path, source: readFileSync(filePath, 'utf8') });
    }
    return { ref: manifest.ref, sha: manifest.sha, syncedAt: manifest.syncedAt, files };
  }

  private async fetchTree(ref: string): Promise<{ sha: string | null; entries: GitHubTreeEntry[] }> {
    const url = `https://api.github.com/repos/${this.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
    const data = (await this.json(url)) as { sha?: unknown; tree?: unknown; truncated?: unknown };
    if (data.truncated === true) {
      throw catalogError(`GitHub tree for ${ref} is truncated; pin a commit instead of a branch.`);
    }
    const entries = Array.isArray(data.tree) ? (data.tree as GitHubTreeEntry[]) : [];
    return { sha: typeof data.sha === 'string' ? data.sha : null, entries };
  }

  private async download(ref: string, path: string): Promise<string> {
    const url = `https://raw.githubusercontent.com/${this.repo}/${encodeURIComponent(ref)}/${path}`;
    const response = await this.fetchImpl(url);
    if (!response.ok) throw catalogError(`Cannot download ${path}@${ref} (${response.status}).`);
    return response.text();
  }

  private eligible(entries: GitHubTreeEntry[]): GitHubTreeEntry[] {
    return entries
      .filter((entry) => entry.type === 'blob')
      .filter((entry) => isCatalogSourcePath(entry.path, entry.size ?? 0));
  }

  async load(options: { refresh?: boolean | undefined } = {}): Promise<CatalogSourceSnapshot> {
    const ref = this.ref ?? (await this.latestReleaseRef()) ?? 'master';
    if (options.refresh !== true) {
      const cached = this.readCache(ref);
      if (cached) return cached;
    }

    const { sha, entries } = await this.fetchTree(ref);
    const eligible = this.eligible(entries);
    const root = this.refRoot(ref);
    mkdirSync(join(root, 'sources'), { recursive: true });

    const files: CatalogSourceFile[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < eligible.length) {
        const entry = eligible[cursor];
        cursor += 1;
        if (!entry) continue;
        const source = await this.download(ref, entry.path);
        const target = join(root, 'sources', entry.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, source, 'utf8');
        files.push({ path: entry.path, source });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.concurrency, eligible.length)) }, worker));

    files.sort((left, right) => (left.path < right.path ? -1 : 1));
    const syncedAt = this.now().toISOString();
    const manifest: CatalogManifest = {
      ref,
      sha,
      syncedAt,
      files: files.map((file) => ({ path: file.path, size: Buffer.byteLength(file.source, 'utf8') })),
    };
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return { ref, sha, syncedAt, files };
  }
}

function catalogError(message: string, options?: ErrorOptions): McpError {
  return new McpError('catalog-unavailable', message, options);
}
