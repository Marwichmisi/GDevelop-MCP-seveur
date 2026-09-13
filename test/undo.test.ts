import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpError } from '../src/errors.js';
import { ProjectStore } from '../src/sessions.js';
import { createProject, describeProject, saveProject, undoLastEdit, type CommandDeps } from '../src/commands.js';
import { applyContentBatch } from '../src/batch.js';
import { createFakeEngine } from './fakeEngine.js';

function makeDeps() {
  const engine = createFakeEngine();
  const store = new ProjectStore(engine);
  return { store, engine };
}
function makeSession(deps: CommandDeps): string {
  return createProject(deps, { name: 'Undo' }).sessionId;
}

describe('undo_last_edit (ticket #17, spec US8)', () => {
  it('ecrit une copie -pre-restore au save et restaure l etat precedent', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const dir = mkdtempSync(join(tmpdir(), 'gd-undo-'));
    const file = join(dir, 'game.json');
    saveProject(deps, { sessionId, path: file });
    applyContentBatch(deps, { sessionId, ops: [{ op: 'create_scene', payload: { sessionId, name: 'Niveau1' } }] });
    assert.equal(deps.store.get(sessionId).dirty, true);
    const saved = saveProject(deps, { sessionId });
    assert.ok(saved.preRestorePath);
    assert.ok(existsSync(saved.preRestorePath as string));
    assert.equal(deps.store.get(sessionId).dirty, false);
    const undone = undoLastEdit(deps, { sessionId });
    assert.equal(undone.restoredPath, file);
    assert.equal(describeProject(deps, { sessionId }).content.scenes.length, 0);
    assert.equal(readFileSync(file, 'utf8'), readFileSync(undone.preRestorePath, 'utf8'));
  });

  it('refuse sans save prealable et apres consommation', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    assert.throws(
      () => undoLastEdit(deps, { sessionId }),
      (error: unknown) => error instanceof McpError && error.code === 'validation-failed',
    );
    const dir = mkdtempSync(join(tmpdir(), 'gd-undo-once-'));
    const file = join(dir, 'game.json');
    saveProject(deps, { sessionId, path: file });
    // 1er save sans backup → pas de pre-restore ; 2e save → pre-restore disponible.
    saveProject(deps, { sessionId });
    undoLastEdit(deps, { sessionId });
    assert.throws(
      () => undoLastEdit(deps, { sessionId }),
      (error: unknown) => error instanceof McpError && error.code === 'validation-failed',
    );
  });
});

