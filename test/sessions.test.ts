import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/sessions.js';
import { McpError } from '../src/errors.js';
import { createFakeEngine } from './fakeEngine.js';

function makeStore() {
  return new ProjectStore(createFakeEngine());
}

describe('ProjectStore sessions', () => {
  it('creates a session with a UUID and an empty GDJS project', () => {
    const store = makeStore();
    const session = store.create('My game');
    assert.match(session.id, /^[0-9a-f-]{36}$/);
    assert.equal(session.dirty, false);
    assert.equal(session.filePath, null);
  });

  it('throws a clean error for an unknown session id', () => {
    const store = makeStore();
    assert.throws(() => store.get('00000000-0000-0000-0000-000000000000'), (error: unknown) => {
      return error instanceof McpError && error.code === 'unknown-session';
    });
  });

  it('opens an existing project file without touching it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-open-'));
    const file = join(dir, 'game.json');
    writeFileSync(file, JSON.stringify({ name: 'Existing' }));
    const store = makeStore();
    const session = store.open(file);
    assert.equal(session.filePath, file);
    assert.equal(session.dirty, false);
  });

  it('refuses a folder-project with an explicit error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-folder-'));
    mkdirSync(join(dir, 'layouts'));
    const store = makeStore();
    assert.throws(() => store.open(dir), (error: unknown) => {
      return error instanceof McpError && error.code === 'folder-project-unsupported';
    });
  });

  it('refuses relative paths and null bytes', () => {
    const store = makeStore();
    assert.throws(() => store.open('relative/game.json'), (error: unknown) => {
      return error instanceof McpError && error.code === 'path-not-allowed';
    });
    assert.throws(() => store.open('/tmp/ga\0me.json'), (error: unknown) => {
      return error instanceof McpError && error.code === 'path-not-allowed';
    });
  });

  it('close refuses a dirty session unless forced', () => {
    const store = makeStore();
    const session = store.create('Dirty');
    store.markDirty(session.id);
    assert.throws(() => store.close(session.id, {}), (error: unknown) => {
      return error instanceof McpError && error.code === 'session-dirty';
    });
    store.close(session.id, { force: true });
    assert.throws(() => store.get(session.id), (error: unknown) => {
      return error instanceof McpError && error.code === 'unknown-session';
    });
  });

  it('close deletes the project handle', () => {
    const store = makeStore();
    const engine = (store as unknown as { engine: { projects: { deleted: boolean }[] } }).engine;
    const session = store.create('Gone');
    store.close(session.id, {});
    assert.equal(engine.projects[0]?.deleted, true);
  });
});
