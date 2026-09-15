import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { z } from 'zod';
import type { CommandDeps } from './commands.js';
import type { EngineProject } from './engine.js';
import { McpError } from './errors.js';
import { renderSceneStaticView, resolveSceneName } from './previewStatic.js';
import type { StaticRenderResult } from './previewStatic.js';
import { startStaticPreviewServer, type StaticPreviewServer } from './previewServer.js';

export type { StaticRenderResult } from './previewStatic.js';

/**
 * Preview double mode (issue #16): `render_scene_static` (instant, pure
 * canvas over `ContentView`) + `build_preview` / `get_preview_status` /
 * `stop_preview` (playable loopback export from the live `gd.Project`
 * memory session, never a save).
 *
 * Primary sources: `docs/research/gdevelop-mcp-preview-research.md`
 * §§1–7 (Exporter `PreviewExportOptions`, static server 982, logs
 * `page.on console/pageerror`, Puppeteer opt-in, global queue, dirty
 * sha256 hash, TTL 30 min, Draco sanitize).
 */

export const PREVIEW_TTL_MS = 30 * 60 * 1000;
export const PREVIEW_LOG_CAP = 200;

export const previewSchemas = {
  renderSceneStatic: z.object({
    sessionId: z.string().uuid().describe('Session UUID'),
    scene: z.string().min(1).optional().describe('Scene name; defaults to the first layout'),
    width: z.number().int().min(64).max(4096).default(800).describe('Static canvas width'),
    height: z.number().int().min(64).max(4096).default(600).describe('Static canvas height'),
  }),
  buildPreview: z.object({
    sessionId: z.string().uuid().describe('Session UUID'),
    scene: z.string().min(1).optional().describe('Scene to preview; defaults to the first layout'),
    withScreenshot: z.boolean().default(false).describe('Capture a PNG screenshot via headless browser (slow, opt-in)'),
    width: z.number().int().min(64).max(4096).default(800).describe('Viewport width for the screenshot'),
    height: z.number().int().min(64).max(4096).default(600).describe('Viewport height for the screenshot'),
    durationMs: z.number().int().min(0).max(30000).default(1000).describe('Delay before screenshot capture'),
  }),
  getPreviewStatus: z.object({
    previewId: z.string().uuid().optional().describe('Preview UUID; absent = newest preview'),
  }),
  stopPreview: z.object({
    previewId: z.string().uuid().describe('Preview UUID'),
  }),
};

export type RenderSceneStaticInput = z.infer<typeof previewSchemas.renderSceneStatic>;
export type BuildPreviewInput = z.infer<typeof previewSchemas.buildPreview>;

export interface PreviewCaptureOptions {
  width: number;
  height: number;
  durationMs: number;
  withScreenshot: boolean;
  outDir: string;
}

export interface PreviewRecord {
  previewId: string;
  sessionId: string;
  scene: string;
  url: string;
  outDir: string;
  dirtyHash: string;
  reused: boolean;
  logs: string[];
  pageErrors: string[];
  screenshotPath: string | null;
  createdAt: string;
}

/** Exporter seam: writes a playable `index.html` from the live session. */
export interface PreviewExporter {
  exportProject(project: EngineProject, outDir: string, sceneName: string): Promise<{ sanitizedDraco: boolean }>;
}

/** Browser seam: captures console logs (+ opt-in screenshot). */
export interface PreviewBrowser {
  capture(
    url: string,
    options: PreviewCaptureOptions,
  ): Promise<{ logs: string[]; pageErrors: string[]; screenshotPath: string | null }>;
}

/**
 * Draco fix (research §6.2): some libGD/GDJS artifact combos list the raw
 * Draco wasm binary as a `<script>` include — it must load via DRACOLoader,
 * never parsed as JS. Shared by the stub and the real exporter.
 */
export function sanitizeDracoScriptIncludes(html: string): { html: string; sanitized: boolean } {
  const cleaned = html.replace(/<script[^>]*draco[^>]*\.wasm[^>]*>\s*<\/script>\s*/gi, '');
  return { html: cleaned, sanitized: cleaned !== html };
}

/**
 * Default exporter: serializes nothing to the project file (memory only) and
 * writes a minimal playable `index.html` stub into a fresh temp dir. The real
 * `gd.Exporter` path plugs in here once `GDEVELOP_GDJS_ROOT` is provisioned;
 * the manager contract (no save, scene default, Draco sanitize) is identical.
 */
export class StubPreviewExporter implements PreviewExporter {
  async exportProject(project: EngineProject, outDir: string, sceneName: string): Promise<{ sanitizedDraco: boolean }> {
    void project;
    await mkdir(outDir, { recursive: true });
    // Simulate an upstream template that sometimes references a Draco wasm
    // companion script: strip it (research §6.2 fix Draco).
    const raw = [
      '<!doctype html><html><head><meta charset="utf-8"></head><body>',
      '<script src="draco_decoder.wasm.js"></script>',
      `<div id="scene">${sceneName.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`,
      '<script>window.gdjsPreview = true;</script>',
      '</body></html>',
    ].join('\n');
    const { html, sanitized } = sanitizeDracoScriptIncludes(raw);
    await writeFile(join(outDir, 'index.html'), html, 'utf8');
    return { sanitizedDraco: sanitized };
  }
}

/**
 * Null-object browser: the fast log-only path. GDJS console logs require a
 * real page run, so without a browser only export lines are reported (see
 * `buildInner`); use `withScreenshot:true` (or an injected browser) for the
 * full console capture.
 */
export class NullPreviewBrowser implements PreviewBrowser {
  async capture(): Promise<{ logs: string[]; pageErrors: string[]; screenshotPath: string | null }> {
    return { logs: [], pageErrors: [], screenshotPath: null };
  }
}

interface ManagedPreview extends PreviewRecord {
  server: StaticPreviewServer | null;
  timer: NodeJS.Timeout | null;
  status: 'ready' | 'stopped' | 'failed';
}

export interface PreviewManagerOptions {
  tmpRoot?: string | undefined;
  ttlMs?: number | undefined;
  exporter?: PreviewExporter | undefined;
  browser?: PreviewBrowser | undefined;
  startServer?: typeof startStaticPreviewServer | undefined;
}

export class PreviewManager {
  private readonly previews = new Map<string, ManagedPreview>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly tmpRoot: string;
  private readonly ttlMs: number;
  private readonly exporter: PreviewExporter;
  private readonly browser: PreviewBrowser;
  private readonly startServer: typeof startStaticPreviewServer;

  constructor(
    private readonly deps: CommandDeps,
    options: PreviewManagerOptions = {},
  ) {
    this.tmpRoot = options.tmpRoot ?? tmpdir();
    this.ttlMs = options.ttlMs ?? PREVIEW_TTL_MS;
    this.exporter = options.exporter ?? new StubPreviewExporter();
    this.browser = options.browser ?? new NullPreviewBrowser();
    this.startServer = options.startServer ?? startStaticPreviewServer;
  }

  renderStatic(input: RenderSceneStaticInput): StaticRenderResult {
    const parsed = previewSchemas.renderSceneStatic.parse(input);
    const session = this.deps.store.get(parsed.sessionId);
    const view = this.deps.engine.describeContent(session.project);
    return renderSceneStaticView(parsed.sessionId, view, { scene: parsed.scene, width: parsed.width, height: parsed.height });
  }

  /** Serialized global export queue: a single GDJS export at a time. */
  build(input: BuildPreviewInput): Promise<PreviewRecord> {
    const parsed = previewSchemas.buildPreview.parse(input);
    const task = this.queue.then(() => this.buildInner(parsed));
    // Keep the chain alive across failures; the caller still sees the error.
    this.queue = task.catch(() => undefined);
    return task;
  }

  status(previewId?: string): PreviewRecord {
    const parsed = previewSchemas.getPreviewStatus.parse(previewId === undefined ? {} : { previewId });
    if (parsed.previewId !== undefined) {
      const found = this.previews.get(parsed.previewId);
      if (!found || found.status === 'stopped') {
        throw new McpError('preview-not-found', `Unknown preview: ${parsed.previewId}.`);
      }
      // Reading a preview proves it is still wanted: slide the TTL window.
      this.refreshTtl(found);
      return this.toRecord(found);
    }
    const newest = [...this.previews.values()].filter((candidate) => candidate.status !== 'stopped').pop();
    if (!newest) throw new McpError('preview-not-found', 'No active previews.');
    this.refreshTtl(newest);
    return this.toRecord(newest);
  }

  async stop(previewId: string): Promise<{ stopped: true; previewId: string }> {
    const parsed = previewSchemas.stopPreview.parse({ previewId });
    const found = this.previews.get(parsed.previewId);
    if (!found) throw new McpError('preview-not-found', `Unknown preview: ${parsed.previewId}.`);
    await this.destroy(found);
    return { stopped: true, previewId: parsed.previewId };
  }

  /** `close_project` stops every linked preview before the session closes. */
  async stopForSession(sessionId: string): Promise<{ stopped: number }> {
    const linked = [...this.previews.values()].filter((candidate) => candidate.sessionId === sessionId);
    for (const preview of linked) await this.destroy(preview);
    return { stopped: linked.length };
  }

  async closeAll(): Promise<{ stopped: number }> {
    const all = [...this.previews.values()];
    for (const preview of all) await this.destroy(preview);
    return { stopped: all.length };
  }

  private dirtyHash(sessionId: string): string {
    const session = this.deps.store.get(sessionId);
    // Memory-only: serialize the live project, never touch the project file.
    const serialized = this.deps.engine.serializeProject(session.project);
    return createHash('sha256').update(serialized, 'utf8').digest('hex');
  }

  private resolveScene(sessionId: string, wanted?: string): string {
    const session = this.deps.store.get(sessionId);
    return resolveSceneName(this.deps.engine.describeContent(session.project), wanted);
  }

  private async buildInner(parsed: BuildPreviewInput): Promise<PreviewRecord> {
    const session = this.deps.store.get(parsed.sessionId);
    const beforeMtime = projectFileSignature(session.filePath);
    const scene = this.resolveScene(parsed.sessionId, parsed.scene);
    const hash = this.dirtyHash(parsed.sessionId);

    const existing = [...this.previews.values()].find(
      (candidate) =>
        candidate.status !== 'stopped' && candidate.sessionId === parsed.sessionId && candidate.scene === scene && candidate.dirtyHash === hash,
    );
    if (existing) {
      if (!parsed.withScreenshot) {
        existing.reused = true;
        this.refreshTtl(existing);
        this.assertUntouched(session.filePath, beforeMtime);
        return this.toRecord(existing);
      }
      // Same project hash, screenshot now requested: capture into the live
      // export instead of a second one (no leaked server or temp dir).
      if (existing.server) {
        const effectiveBrowser = await this.resolveBrowser(true);
        const captured = await effectiveBrowser.capture(existing.url, {
          width: parsed.width,
          height: parsed.height,
          durationMs: parsed.durationMs,
          withScreenshot: true,
          outDir: existing.outDir,
        });
        existing.logs = [...existing.logs, ...captured.logs].slice(-PREVIEW_LOG_CAP);
        existing.pageErrors = [...existing.pageErrors, ...captured.pageErrors].slice(-PREVIEW_LOG_CAP);
        existing.screenshotPath = captured.screenshotPath;
        existing.reused = true;
        this.refreshTtl(existing);
        this.assertUntouched(session.filePath, beforeMtime);
        return this.toRecord(existing);
      }
    }

    const outDir = await mkdtemp(join(this.tmpRoot + sep, 'preview-'));
    const previewId = randomUUID();
    let server: StaticPreviewServer | null = null;
    try {
      const { sanitizedDraco } = await this.exporter.exportProject(session.project, outDir, scene);
      server = await this.startServer({ rootDirectory: outDir, host: '127.0.0.1' });
      const effectiveBrowser = await this.resolveBrowser(parsed.withScreenshot);
      const captured = await effectiveBrowser.capture(server.url, {
        width: parsed.width,
        height: parsed.height,
        durationMs: parsed.durationMs,
        withScreenshot: parsed.withScreenshot,
        outDir,
      });
      // The fast path runs no page, so GDJS console entries only exist after
      // a browser capture; export lines keep `logs` always informative.
      const exportLines = [
        `[export] scene "${scene}" exported`,
        ...(sanitizedDraco ? ['[export] draco wasm companion removed from index.html'] : []),
      ];
      const record: ManagedPreview = {
        previewId,
        sessionId: parsed.sessionId,
        scene,
        url: server.url,
        outDir,
        dirtyHash: hash,
        reused: false,
        logs: [...exportLines, ...captured.logs].slice(-PREVIEW_LOG_CAP),
        pageErrors: captured.pageErrors.slice(-PREVIEW_LOG_CAP),
        screenshotPath: captured.screenshotPath,
        createdAt: new Date().toISOString(),
        server,
        timer: null,
        status: 'ready',
      };
      this.previews.set(previewId, record);
      this.refreshTtl(record);
      this.assertUntouched(session.filePath, beforeMtime);
      return this.toRecord(record);
    } catch (error) {
      if (server) await server.close().catch(() => undefined);
      await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof McpError) throw error;
      throw new McpError('preview-export-failed', `Preview export failed: ${error instanceof Error ? error.message : String(error)}.`, {
        cause: error,
      });
    }
  }

  private async resolveBrowser(withScreenshot: boolean): Promise<PreviewBrowser> {
    if (withScreenshot && this.browser instanceof NullPreviewBrowser) {
      const { PuppeteerBrowser } = await import('./previewBrowser.js');
      return new PuppeteerBrowser();
    }
    return this.browser;
  }

  private refreshTtl(record: ManagedPreview): void {
    if (record.timer) clearTimeout(record.timer);
    record.timer = setTimeout(() => {
      void this.destroy(record).catch(() => undefined);
    }, this.ttlMs);
    // Don't keep the process alive for preview TTL alone.
    record.timer.unref?.();
  }

  private async destroy(record: ManagedPreview): Promise<void> {
    if (record.timer) {
      clearTimeout(record.timer);
      record.timer = null;
    }
    record.status = 'stopped';
    this.previews.delete(record.previewId);
    if (record.server) {
      await record.server.close().catch(() => undefined);
      record.server = null;
    }
    await rm(record.outDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private toRecord(record: ManagedPreview): PreviewRecord {
    return {
      previewId: record.previewId,
      sessionId: record.sessionId,
      scene: record.scene,
      url: record.url,
      outDir: record.outDir,
      dirtyHash: record.dirtyHash,
      reused: record.reused,
      logs: [...record.logs],
      pageErrors: [...record.pageErrors],
      screenshotPath: record.screenshotPath,
      createdAt: record.createdAt,
    };
  }

  private assertUntouched(filePath: string | null, before: string | null): void {
    if (filePath === null || before === null) return;
    const after = projectFileSignature(filePath);
    if (after !== before) {
      throw new McpError('preview-export-failed', 'Preview build touched the project file on disk; expected memory-only.');
    }
  }
}

function projectFileSignature(filePath: string | null): string | null {
  if (filePath === null) return null;
  try {
    const stat = statSync(filePath);
    const content = readFileSync(filePath);
    return `${stat.mtimeMs}:${createHash('sha256').update(content).digest('hex')}`;
  } catch {
    return null;
  }
}
