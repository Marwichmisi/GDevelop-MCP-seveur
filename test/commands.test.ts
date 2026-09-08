import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/sessions.js';
import { closeProject, createProject, describeProject, openProject, saveProject } from '../src/commands.js';
import { McpError } from '../src/errors.js';
import { createFakeEngine } from './fakeEngine.js';

function makeDeps() {
  const engine = createFakeEngine();
  const store = new ProjectStore(engine);
  return { store, engine };
}

describe('project lifecycle commands', () => {
  it('create → describe → save → reopen is byte-identical', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-life-'));
    const file = join(dir, 'game.json');
    const first = makeDeps();
    const created = createProject(first, { name: 'Tracer' });
    const summary = describeProject(first, { sessionId: created.sessionId });
    assert.equal(summary.name, 'Tracer');
    assert.equal(summary.layoutCount, 0);
    const saved = saveProject(first, { sessionId: created.sessionId, path: file });
    assert.equal(saved.backupPath, null);
    const bytes = readFileSync(file, 'utf8');

    const second = makeDeps();
    openProject(second, { path: file });
    const reopened = second.store.list()[0];
    assert.ok(reopened);
    saveProject(second, { sessionId: reopened.id });
    assert.equal(readFileSync(file, 'utf8'), bytes);
  });

  it('save writes a timestamped backup and renames atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-backup-'));
    const file = join(dir, 'game.json');
    writeFileSync(file, JSON.stringify({ name: 'v1' }));
    const deps = makeDeps();
    const opened = openProject(deps, { path: file });
    const saved = saveProject(deps, { sessionId: opened.sessionId });
    assert.ok(saved.backupPath);
    assert.equal(readFileSync(saved.backupPath as string, 'utf8'), JSON.stringify({ name: 'v1' }));
    assert.ok(!saved.backupPath?.includes(':'));
  });

  it('save refuses when blocking diagnostics are present and leaves the file alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-savegate-'));
    const file = join(dir, 'game.json');
    const deps = makeDeps();
    const created = createProject(deps, { name: 'Broken' });
    deps.engine.diagnostics.push({ type: 'MismatchedObjectType', message: 'Bad.' });
    assert.throws(() => saveProject(deps, { sessionId: created.sessionId, path: file }), (error: unknown) => {
      return error instanceof McpError && error.code === 'validation-failed';
    });
    assert.throws(() => readFileSync(file), /ENOENT/);
  });

  it('close refuses a dirty session without force, then closes with force', () => {
    const deps = makeDeps();
    const created = createProject(deps, { name: 'Work' });
    deps.store.markDirty(created.sessionId);
    assert.throws(() => closeProject(deps, { sessionId: created.sessionId }), (error: unknown) => {
      return error instanceof McpError && error.code === 'session-dirty';
    });
    const closed = closeProject(deps, { sessionId: created.sessionId, force: true });
    assert.equal(closed.closed, true);
  });

  it('every command rejects unknown session ids cleanly', () => {
    const deps = makeDeps();
    const unknown = '00000000-0000-0000-0000-000000000000';
    for (const call of [
      () => describeProject(deps, { sessionId: unknown }),
      () => saveProject(deps, { sessionId: unknown, path: join(tmpdir(), 'nope.json') }),
      () => closeProject(deps, { sessionId: unknown, force: true }),
    ]) {
      assert.throws(call, (error: unknown) => error instanceof McpError && error.code === 'unknown-session');
    }
  });

  it('open refuses a folder-project without creating a session', () => {
    const deps = makeDeps();
    assert.throws(() => openProject(deps, { path: tmpdir() }), (error: unknown) => {
      return error instanceof McpError && error.code === 'folder-project-unsupported';
    });
    assert.equal(deps.store.list().length, 0);
  });
});
