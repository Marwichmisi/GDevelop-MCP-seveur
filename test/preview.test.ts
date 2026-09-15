import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/sessions.js';
import { PreviewManager, PREVIEW_LOG_CAP, sanitizeDracoScriptIncludes, type PreviewBrowser, type PreviewExporter } from '../src/preview.js';
import { createPreviewTools } from '../src/tools.js';
import { closeProjectWithPreviews } from '../src/commands.js';
import { createFakeEngine } from './fakeEngine.js';
import type { EngineProject } from '../src/engine.js';

function makeDeps() {
  const engine = createFakeEngine();
  const store = new ProjectStore(engine);
  return { store, engine };
}

class CountingExporter implements PreviewExporter {
  calls = 0;
  async exportProject(_project: EngineProject, outDir: string, sceneName: string): Promise<{ sanitizedDraco: boolean }> {
    this.calls += 1;
    const { writeFile } = await import('node:fs/promises');
    const raw = `<html><head><script src="draco_decoder.wasm.js"></script></head><body>${sceneName}</body></html>`;
    const { html, sanitized } = sanitizeDracoScriptIncludes(raw);
    await writeFile(join(outDir, 'index.html'), html, 'utf8');
    return { sanitizedDraco: sanitized };
  }
}

class FakeBrowser implements PreviewBrowser {
  logs: string[];
  constructor(logs: string[] = ['[log] booted']) {
    this.logs = logs;
  }
  async capture(
    _url: string,
    options: { withScreenshot: boolean; outDir: string },
  ): Promise<{ logs: string[]; pageErrors: string[]; screenshotPath: string | null }> {
    if (options.withScreenshot) {
      const shot = join(options.outDir, 'shot.png');
      const { writeFile } = await import('node:fs/promises');
      // Minimal 1x1 PNG.
      await writeFile(shot, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex'));
      return { logs: this.logs, pageErrors: [], screenshotPath: shot };
    }
    return { logs: this.logs, pageErrors: [], screenshotPath: null };
  }
}

describe('preview double mode (issue #16)', () => {
  let dirs: string[] = [];
  let managers: PreviewManager[] = [];

  beforeEach(() => {
    dirs = [];
    managers = [];
  });

  afterEach(async () => {
    for (const manager of managers) await manager.closeAll().catch(() => undefined);
    const { rm } = await import('node:fs/promises');
    for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  function makeManager(overrides: ConstructorParameters<typeof PreviewManager>[1] = {}): { manager: PreviewManager; exporter: CountingExporter; deps: ReturnType<typeof makeDeps> } {
    const deps = makeDeps();
    const dir = mkdtempSync(join(tmpdir(), 'gd-preview-'));
    dirs.push(dir);
    const exporter = new CountingExporter();
    const manager = new PreviewManager({ ...deps, previews: undefined } as never, {
      tmpRoot: dir,
      ttlMs: 30 * 60 * 1000,
      exporter,
      browser: new FakeBrowser(),
      ...overrides,
    });
    // Wire the manager back so close_project semantics can be tested via stopForSession.
    (deps as { previews?: PreviewManager }).previews = manager;
    managers.push(manager);
    return { manager, exporter, deps };
  }

  function createSession(deps: ReturnType<typeof makeDeps>): string {
    const session = deps.store.create('Preview game');
    deps.engine.createScene(session.project, 'Scene1');
    deps.store.markDirty(session.id);
    return session.id;
  }

  it('render_scene_static is instant and reflects mutations', () => {
    const { manager, deps } = makeManager();
    const sessionId = createSession(deps);
    const first = manager.renderStatic({ sessionId, width: 800, height: 600 });
    assert.equal(first.scene, 'Scene1');
    assert.match(first.svg, /<svg/);
    deps.engine.createObject(deps.store.get(sessionId).project, { scene: 'Scene1', type: 'Sprite', name: 'Hero' });
    deps.engine.placeInstance(deps.store.get(sessionId).project, { scene: 'Scene1', object: 'Hero', x: 10, y: 20 });
    const second = manager.renderStatic({ sessionId, width: 800, height: 600 });
    assert.equal(second.instanceCount, 1);
    assert.equal(second.objectCount, 1);
  });

  it('build_preview serves loopback with logs and no screenshot (fast path)', async () => {
    const { manager, deps } = makeManager();
    const sessionId = createSession(deps);
    const record = await manager.build({ sessionId, withScreenshot: false, width: 800, height: 600, durationMs: 0 });
    assert.match(record.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    // Export lines are always present; GDJS console entries need a browser run.
    assert.deepEqual(record.logs, [
      '[export] scene "Scene1" exported',
      '[export] draco wasm companion removed from index.html',
      '[log] booted',
    ]);
    assert.equal(record.screenshotPath, null);
    const response = await fetch(record.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    await response.arrayBuffer();
  });

  it('second identical build reuses the export (dirty hash hit)', async () => {
    const { manager, exporter, deps } = makeManager();
    const sessionId = createSession(deps);
    const first = await manager.build({ sessionId, withScreenshot: false, width: 800, height: 600, durationMs: 0 });
    const second = await manager.build({ sessionId, withScreenshot: false, width: 800, height: 600, durationMs: 0 });
    assert.equal(exporter.calls, 1);
    assert.equal(second.reused, true);
    assert.equal(second.previewId, first.previewId);
  });

  it('mutation after build triggers a fresh export', async () => {
    const { manager, exporter, deps } = makeManager();
    const sessionId = createSession(deps);
    await manager.build({ sessionId, withScreenshot: false, width: 800, height: 600, durationMs: 0 });
    deps.engine.createScene(deps.store.get(sessionId).project, 'Scene2');
    const rebuilt = await manager.build({ sessionId, withScreenshot: false, width: 800, height: 600, durationMs: 0 });
    assert.equal(exporter.calls, 2);
    assert.equal(rebuilt.reused, false);
  });

  it('build without save does not touch the project file', async () => {
    const { manager, deps } = makeManager();
    const dir = mkdtempSync(join(tmpdir(), 'gd-proj-'));
    dirs.push(dir);
    const file = join(dir, 'game.json');
    const session = deps.store.create('Saved game');
    deps.engine.createScene(session.project, 'Scene1');
    writeFileSync(file, deps.engine.serializeProject(session.project), 'utf8');
    deps.store.setFilePath(session.id, file);
    const before = readFileSync(file, 'utf8');
    const beforeMtime = statSync(file).mtimeMs;
    await manager.build({ sessionId: session.id, withScreenshot: false, width: 800, height: 600, durationMs: 0 });
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(statSync(file).mtimeMs, beforeMtime);
  });

  it('screenshot opt-in writes a PNG via the browser seam', async () => {
    const { manager, deps } = makeManager();
    const sessionId = createSession(deps);
    const record = await manager.build({ sessionId, withScreenshot: true, width: 800, height: 600, durationMs: 0 });
    assert.ok(record.screenshotPath);
    assert.ok(statSync(record.screenshotPath as string).size > 0);
  });

  it('screenshot on a live export reuses it instead of a second export', async () => {
    const { manager, exporter, deps } = makeManager();
    const sessionId = createSession(deps);
    const fast = await manager.build({ sessionId, withScreenshot: false, width: 800, height: 600, durationMs: 0 });
    assert.equal(fast.screenshotPath, null);
    const shot = await manager.build({ sessionId, withScreenshot: true, width: 800, height: 600, durationMs: 0 });
    assert.equal(exporter.calls, 1);
    assert.equal(shot.previewId, fast.previewId);
    assert.equal(shot.outDir, fast.outDir);
    assert.equal(shot.reused, true);
    assert.ok(shot.screenshotPath);
    assert.ok(shot.logs.some((line) => line.startsWith('[export]')));
    assert.ok(shot.logs.includes('[log] booted'));
  });

  it('static render clips out-of-bounds instances and reports skipped dots', () => {
    const { manager, deps } = makeManager();
    const sessionId = createSession(deps);
    const project = deps.store.get(sessionId).project;
    deps.engine.createObject(project, { scene: 'Scene1', type: 'Sprite', name: 'Hero' });
    deps.engine.placeInstance(project, { scene: 'Scene1', object: 'Hero', x: 5000, y: 20 });
    const rendered = manager.renderStatic({ sessionId, width: 800, height: 600 });
    assert.match(rendered.svg, /cx="5000\.0"/);
    assert.equal(rendered.skipped, 0);
    for (let i = 0; i < 505; i++) {
      deps.engine.placeInstance(project, { scene: 'Scene1', object: 'Hero', x: i, y: i });
    }
    const crowded = manager.renderStatic({ sessionId, width: 800, height: 600 });
    assert.equal(crowded.instanceCount, 506);
    assert.equal(crowded.skipped, 6);
  });

  it('screenshot without a browser refuses cleanly', async () => {
    const deps = makeDeps();
    const dir = mkdtempSync(join(tmpdir(), 'gd-preview-'));
    dirs.push(dir);
    const session = deps.store.create('Preview game');
    deps.engine.createScene(session.project, 'Scene1');
    const { NullPreviewBrowser } = await import('../src/preview.js');
    const manager = new PreviewManager(deps as never, { tmpRoot: dir, exporter: new CountingExporter(), browser: new NullPreviewBrowser() });
    managers.push(manager);
    await assert.rejects(manager.build({ sessionId: session.id, withScreenshot: true, width: 800, height: 600, durationMs: 0 }), (error: unknown) => {
      return error instanceof Error && (error as { code?: string }).code === 'preview-puppeteer-unavailable';
    });
  });

  it('traversal and method guards return 404/403/405 and wasm MIME is correct', async () => {
    const { manager, deps } = makeManager();
    const sessionId = createSession(deps);
    const record = await manager.build({ sessionId, withScreenshot: false, width: 800, height: 600, durationMs: 0 });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(record.outDir, 'draco_decoder.wasm'), Buffer.from([0, 1, 2, 3]));
    const wasm = await fetch(new URL('draco_decoder.wasm', record.url));
    assert.equal(wasm.headers.get('content-type'), 'application/wasm');
    await wasm.arrayBuffer();
    const traversal = await fetch(new URL('/..%2fpackage.json', record.url));
    assert.ok([403, 404].includes(traversal.status));
    await traversal.arrayBuffer();
    const post = await fetch(record.url, { method: 'POST' });
    assert.equal(post.status, 405);
    await post.arrayBuffer();
    const missing = await fetch(new URL('/nope.html', record.url));
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
  });

  it('draco companion script is sanitized from index.html', async () => {
    const { manager, deps } = makeManager();
    const sessionId = createSession(deps);
    const record = await manager.build({ sessionId, withScreenshot: false, width: 800, height: 600, durationMs: 0 });
    const html = readFileSync(join(record.outDir, 'index.html'), 'utf8');
    assert.ok(!html.includes('draco_decoder.wasm'));
  });

  it('stop removes the port and the temp dir; TTL sweeps automatically', async () => {
    const { manager, deps } = makeManager({ ttlMs: 25 });
    const sessionId = createSession(deps);
    const record = await manager.build({ sessionId, withScreenshot: false, width: 800, height: 600, durationMs: 0 });
    const outDir = record.outDir;
    await manager.stop(record.previewId);
    await assert.rejects(fetch(record.url), () => true);
    const { stat } = await import('node:fs/promises');
    await assert.rejects(stat(outDir));
    const fresh = await manager.build({ sessionId, withScreenshot: false, width: 800, height: 600, durationMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    await assert.rejects(stat(fresh.outDir));
  });

  it('close_project stops linked previews (stopForSession)', async () => {
    const { manager, deps } = makeManager();
    const sessionId = createSession(deps);
    await manager.build({ sessionId, withScreenshot: false, width: 800, height: 600, durationMs: 0 });
    const stopped = await manager.stopForSession(sessionId);
    assert.equal(stopped.stopped, 1);
    assert.throws(() => manager.status(), (error: unknown) => {
      return error instanceof Error && (error as { code?: string }).code === 'preview-not-found';
    });
  });

  it('dirty close refusal stops nothing: linked previews survive', async () => {
    const { manager, deps } = makeManager();
    const sessionId = createSession(deps);
    await manager.build({ sessionId, withScreenshot: false, width: 800, height: 600, durationMs: 0 });
    await assert.rejects(closeProjectWithPreviews(deps, { sessionId }), (error: unknown) => {
      return error instanceof Error && (error as { code?: string }).code === 'session-dirty';
    });
    const alive = manager.status();
    assert.match(alive.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const closed = await closeProjectWithPreviews(deps, { sessionId, force: true });
    assert.deepEqual(closed, { closed: true, stoppedPreviews: 1 });
    assert.throws(() => manager.status(), /No active previews/);
  });

  it('get_preview_status slides the TTL window', async () => {
    const { manager, deps } = makeManager({ ttlMs: 100 });
    const sessionId = createSession(deps);
    await manager.build({ sessionId, withScreenshot: false, width: 800, height: 600, durationMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    manager.status();
    await new Promise((resolve) => setTimeout(resolve, 60));
    // 120ms past the build: dead without the status refresh, alive with it.
    assert.ok(manager.status().previewId);
  });

  it('concurrent builds serialize through the global queue', async () => {
    const order: string[] = [];
    const slowExporter: PreviewExporter = {
      async exportProject(_project: EngineProject, outDir: string, sceneName: string) {
        order.push(`start:${sceneName}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(outDir, 'index.html'), `<html>${sceneName}</html>`, 'utf8');
        order.push(`end:${sceneName}`);
        return { sanitizedDraco: false };
      },
    };
    const deps = makeDeps();
    const dir = mkdtempSync(join(tmpdir(), 'gd-preview-'));
    dirs.push(dir);
    const manager = new PreviewManager(deps as never, { tmpRoot: dir, exporter: slowExporter, browser: new FakeBrowser() });
    managers.push(manager);
    const session = deps.store.create('Preview game');
    deps.engine.createScene(session.project, 'A');
    deps.engine.createScene(session.project, 'B');
    const [a, b] = await Promise.all([
      manager.build({ sessionId: session.id, scene: 'A', withScreenshot: false, width: 800, height: 600, durationMs: 0 }),
      manager.build({ sessionId: session.id, scene: 'B', withScreenshot: false, width: 800, height: 600, durationMs: 0 }),
    ]);
    assert.notEqual(a.previewId, b.previewId);
    assert.deepEqual(order, ['start:A', 'end:A', 'start:B', 'end:B']);
  });

  it('exposes exactly the 4 preview tools with strict schemas and no $ref', async () => {
    const { manager } = makeManager();
    const tools = createPreviewTools(manager);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['build_preview', 'get_preview_status', 'render_scene_static', 'stop_preview']);
    const { z } = await import('zod');
    const { zodToJsonSchema } = await import('zod-to-json-schema');
    for (const tool of tools) {
      const json = zodToJsonSchema(z.object(tool.inputSchema), { strictUnions: true });
      assert.ok(!JSON.stringify(json).includes('$ref'), `tool ${tool.name} must stay provider-safe`);
    }
    assert.equal(PREVIEW_LOG_CAP, 200);
  });

  it('unknown scene and unknown preview refuse with actionable errors', async () => {
    const { manager, deps } = makeManager();
    const sessionId = createSession(deps);
    assert.throws(() => manager.renderStatic({ sessionId, scene: 'Nope', width: 800, height: 600 }), /Unknown scene/);
    await assert.rejects(manager.build({ sessionId, scene: 'Nope', withScreenshot: false, width: 800, height: 600, durationMs: 0 }), /Unknown scene/);
    await assert.rejects(manager.stop('00000000-0000-0000-0000-000000000000'), (error: unknown) => {
      return error instanceof Error && (error as { code?: string }).code === 'preview-not-found';
    });
  });
});
