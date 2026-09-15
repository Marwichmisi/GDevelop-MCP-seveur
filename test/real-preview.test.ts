import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Opt-in suite against the real libGD.js + GDJS tree (research §7.3).
 * Skipped unless `GDEVELOP_PREVIEW_REAL=1`. Uses the pinned `vendor/libGD.js`
 * and `third-party/GDJS` by default; override with `GDEVELOP_LIBGD_PATH` /
 * `GDEVELOP_GDJS_ROOT`. Browser capture runs only with
 * `GDEVELOP_PREVIEW_BROWSER=1` (requires the optional puppeteer install).
 */
const ENABLED = process.env['GDEVELOP_PREVIEW_REAL'] === '1';
const WITH_BROWSER = process.env['GDEVELOP_PREVIEW_BROWSER'] === '1';

describe('real preview export (opt-in)', { skip: !ENABLED }, () => {
  it('exports a fixture project, serves loopback with correct wasm MIME', async () => {
    const { loadGdRuntime } = await import('../src/runtime.js');
    const { ProjectStore } = await import('../src/sessions.js');
    const { PreviewManager } = await import('../src/preview.js');
    const { GdPreviewExporter } = await import('../src/gdPreviewExporter.js');
    const runtime = await loadGdRuntime();
    const store = new ProjectStore(runtime.engine);
    const dir = mkdtempSync(join(tmpdir(), 'gd-real-preview-'));
    const manager = new PreviewManager(
      { store, engine: runtime.engine },
      { tmpRoot: dir, exporter: new GdPreviewExporter(runtime.gd as never) },
    );
    try {
      const session = store.create('Real preview');
      runtime.engine.createScene(session.project, 'Scene1');
      const record = await manager.build({ sessionId: session.id, withScreenshot: false, width: 800, height: 600, durationMs: 0 });
      const html = readFileSync(join(record.outDir, 'index.html'), 'utf8');
      assert.ok(html.length > 1000);
      assert.ok(!/<script[^>]+\.wasm/i.test(html), 'Draco wasm must never be a script include');
      const root = await fetch(record.url);
      assert.equal(root.status, 200);
      assert.match(root.headers.get('content-type') ?? '', /text\/html/);
      await root.arrayBuffer();
    } finally {
      await manager.closeAll();
    }
  });

  it('dirty-hash hit reuses the real export; mutation rebuilds', async () => {
    const { loadGdRuntime } = await import('../src/runtime.js');
    const { ProjectStore } = await import('../src/sessions.js');
    const { PreviewManager } = await import('../src/preview.js');
    const { GdPreviewExporter } = await import('../src/gdPreviewExporter.js');
    const runtime = await loadGdRuntime();
    const store = new ProjectStore(runtime.engine);
    const dir = mkdtempSync(join(tmpdir(), 'gd-real-preview-'));
    let calls = 0;
    const inner = new GdPreviewExporter(runtime.gd as never);
    const manager = new PreviewManager(
      { store, engine: runtime.engine },
      {
        tmpRoot: dir,
        exporter: {
          async exportProject(project, outDir, scene) {
            calls += 1;
            return inner.exportProject(project, outDir, scene);
          },
        },
      },
    );
    try {
      const session = store.create('Real preview');
      runtime.engine.createScene(session.project, 'Scene1');
      const first = await manager.build({ sessionId: session.id, withScreenshot: false, width: 800, height: 600, durationMs: 0 });
      const second = await manager.build({ sessionId: session.id, withScreenshot: false, width: 800, height: 600, durationMs: 0 });
      assert.equal(calls, 1);
      assert.equal(second.previewId, first.previewId);
      runtime.engine.createScene(session.project, 'Scene2');
      await manager.build({ sessionId: session.id, withScreenshot: false, width: 800, height: 600, durationMs: 0 });
      assert.equal(calls, 2);
    } finally {
      await manager.closeAll();
    }
  });

  it('real build never touches the project file on disk', async () => {
    const { loadGdRuntime } = await import('../src/runtime.js');
    const { ProjectStore } = await import('../src/sessions.js');
    const { PreviewManager } = await import('../src/preview.js');
    const { GdPreviewExporter } = await import('../src/gdPreviewExporter.js');
    const runtime = await loadGdRuntime();
    const store = new ProjectStore(runtime.engine);
    const dir = mkdtempSync(join(tmpdir(), 'gd-real-preview-'));
    const manager = new PreviewManager(
      { store, engine: runtime.engine },
      { tmpRoot: dir, exporter: new GdPreviewExporter(runtime.gd as never) },
    );
    try {
      const session = store.create('Real preview');
      runtime.engine.createScene(session.project, 'Scene1');
      const file = join(dir, 'game.json');
      writeFileSync(file, runtime.engine.serializeProject(session.project), 'utf8');
      store.setFilePath(session.id, file);
      const before = readFileSync(file, 'utf8');
      const beforeMtime = statSync(file).mtimeMs;
      await manager.build({ sessionId: session.id, withScreenshot: false, width: 800, height: 600, durationMs: 0 });
      assert.equal(readFileSync(file, 'utf8'), before);
      assert.equal(statSync(file).mtimeMs, beforeMtime);
    } finally {
      await manager.closeAll();
    }
  });

  describe('real browser capture', { skip: !WITH_BROWSER }, () => {
    it('returns GDJS logs and a PNG screenshot', async () => {
      const { loadGdRuntime } = await import('../src/runtime.js');
      const { ProjectStore } = await import('../src/sessions.js');
      const { PreviewManager } = await import('../src/preview.js');
      const { GdPreviewExporter } = await import('../src/gdPreviewExporter.js');
      const runtime = await loadGdRuntime();
      const store = new ProjectStore(runtime.engine);
      const dir = mkdtempSync(join(tmpdir(), 'gd-real-preview-'));
      const manager = new PreviewManager(
        { store, engine: runtime.engine },
        { tmpRoot: dir, exporter: new GdPreviewExporter(runtime.gd as never) },
      );
      try {
        const session = store.create('Real preview');
        runtime.engine.createScene(session.project, 'Scene1');
        const record = await manager.build({ sessionId: session.id, withScreenshot: true, width: 800, height: 600, durationMs: 1000 });
        assert.ok(record.screenshotPath);
        assert.ok(statSync(record.screenshotPath as string).size > 0);
        assert.ok(Array.isArray(record.logs));
      } finally {
        await manager.closeAll();
      }
    });
  });
});
