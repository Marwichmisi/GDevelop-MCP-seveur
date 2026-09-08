import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Opt-in suite against the real libGD.js build. Skipped unless GDEVELOP_LIBGD_PATH is set. */
const LIBGD_PATH = process.env['GDEVELOP_LIBGD_PATH'];

describe('real libGD.js runtime', { skip: !LIBGD_PATH }, () => {
  it('create → save → reopen is byte-identical', async () => {
    const { loadGdRuntime } = await import('../src/runtime.js');
    const { ProjectStore } = await import('../src/sessions.js');
    const { createProject, describeProject, saveProject, openProject } = await import('../src/commands.js');
    const runtime = await loadGdRuntime({ libgdPath: LIBGD_PATH });
    const dir = mkdtempSync(join(tmpdir(), 'gd-real-'));
    const file = join(dir, 'game.json');

    const first = new ProjectStore(runtime.engine);
    const created = createProject({ store: first, engine: runtime.engine }, { name: 'Real' });
    assert.equal(describeProject({ store: first, engine: runtime.engine }, { sessionId: created.sessionId }).name, 'Real');
    assert.equal(runtime.engine.listDiagnostics(first.get(created.sessionId).project).length, 0);
    saveProject({ store: first, engine: runtime.engine }, { sessionId: created.sessionId, path: file });
    const bytes = readFileSync(file, 'utf8');

    const second = new ProjectStore(runtime.engine);
    const opened = openProject({ store: second, engine: runtime.engine }, { path: file });
    saveProject({ store: second, engine: runtime.engine }, { sessionId: opened.sessionId });
    assert.equal(readFileSync(file, 'utf8'), bytes);
  });
});
