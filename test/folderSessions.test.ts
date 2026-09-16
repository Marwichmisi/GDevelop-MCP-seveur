import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/sessions.js';
import { createProject, openProject, saveProject } from '../src/commands.js';
import { McpError } from '../src/errors.js';
import { createFakeEngine } from './fakeEngine.js';

function makeDeps() {
  const engine = createFakeEngine();
  const store = new ProjectStore(engine);
  return { store, engine };
}

/** Ecrit un folder-project minimal a la main (game.json + partiel). */
function writeFolderProject(dir: string, sceneName: string): string {
  mkdirSync(join(dir, 'layouts'), { recursive: true });
  const slug = sceneName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  writeFileSync(join(dir, 'layouts', `${slug}.json`), JSON.stringify({ name: sceneName, events: [] }));
  const main = {
    name: 'Folder',
    projectFile: '',
    layouts: [{ __REFERENCE_TO_SPLIT_OBJECT: true, referenceTo: `/layouts/${slug}` }],
    objects: [],
    variables: [],
    objectsGroups: [],
    resources: [],
    properties: { folderProject: true },
  };
  writeFileSync(join(dir, 'game.json'), JSON.stringify(main));
  return join(dir, 'game.json');
}

describe('folder-project sessions (issue #19)', () => {
  it('open dossier : unsplit + projectFile, session kind folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-folder-open-'));
    writeFolderProject(dir, 'Scene One');
    const deps = makeDeps();
    const opened = openProject(deps, { path: dir });
    assert.equal(opened.path, join(dir, 'game.json'));
    const session = deps.store.get(opened.sessionId);
    assert.equal(session.kind, 'folder');
    assert.equal(session.filePath, join(dir, 'game.json'));
  });

  it('open dossier sans game.json : erreur propre project-load-failed, sans session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-folder-nomain-'));
    const deps = makeDeps();
    assert.throws(
      () => openProject(deps, { path: dir }),
      (error: unknown) => error instanceof McpError && error.code === 'project-load-failed',
    );
    assert.equal(deps.store.list().length, 0);
  });

  it('open dossier a reference manquante : erreur propre, sans session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-folder-badref-'));
    writeFileSync(
      join(dir, 'game.json'),
      JSON.stringify({
        name: 'Bad',
        layouts: [{ __REFERENCE_TO_SPLIT_OBJECT: true, referenceTo: '/layouts/missing' }],
        objects: [],
        variables: [],
        objectsGroups: [],
        resources: [],
      }),
    );
    const deps = makeDeps();
    assert.throws(
      () => openProject(deps, { path: dir }),
      (error: unknown) => error instanceof McpError && error.code === 'project-load-failed',
    );
    assert.equal(deps.store.list().length, 0);
  });

  it('undo refuse proprement sur session folder (pas de restauration partielle)', async () => {
    const { undoLastEdit } = await import('../src/commands.js');
    const dir = mkdtempSync(join(tmpdir(), 'gd-folder-undo-'));
    writeFolderProject(dir, 'Scene One');
    const deps = makeDeps();
    const opened = openProject(deps, { path: dir });
    assert.throws(
      () => undoLastEdit(deps, { sessionId: opened.sessionId }),
      (error: unknown) => error instanceof McpError && error.code === 'validation-failed',
    );
  });

  it('save single inchangé : game.json seul, pas de dossier layouts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-folder-single-'));
    const file = join(dir, 'game.json');
    const deps = makeDeps();
    const created = createProject(deps, { name: 'Single' });
    const saved = saveProject(deps, { sessionId: created.sessionId, path: file });
    assert.equal(saved.path, file);
    assert.equal(deps.store.get(created.sessionId).kind, 'single');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.equal('layouts' in parsed, true);
  });
});
