import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineProject } from '../src/engine.js';

/**
 * Non-régression opt-in du round-trip folder réel (issue #19, spike #8 figé).
 * Skipped sauf `GDEVELOP_LIBGD_PATH` (pattern `real-libgd.test.ts`).
 */
const LIBGD_PATH = process.env['GDEVELOP_LIBGD_PATH'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asRealProject(project: EngineProject): any {
  return project;
}

function listFiles(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(full.slice(base.length + 1));
  }
  return out.sort();
}

function normalizedSingle(json: string): string {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  delete parsed['projectFile'];
  const properties = parsed['properties'] as Record<string, unknown> | undefined;
  if (properties) {
    delete properties['projectFile'];
    delete properties['folderProject'];
  }
  return JSON.stringify(parsed);
}

describe('real folder-project round-trip (opt-in, issue #19)', { skip: !LIBGD_PATH }, () => {
  it('single(folder)single identique sauf flag, dossiers crees si absents', async () => {
    const { loadGdRuntime } = await import('../src/runtime.js');
    const { ProjectStore } = await import('../src/sessions.js');
    const { createProject, openProject, saveProject, describeProject } = await import('../src/commands.js');
    const content = await import('../src/content.js');
    const runtime = await loadGdRuntime({ libgdPath: LIBGD_PATH });
    const deps = { store: new ProjectStore(runtime.engine), engine: runtime.engine };
    const { sessionId } = createProject(deps, { name: 'FolderRT' });
    content.createScene(deps, { sessionId, name: 'Niveau1' });
    content.addObject(deps, { sessionId, scene: 'Niveau1', type: 'Sprite', name: 'Joueur' });
    const dir = mkdtempSync(join(tmpdir(), 'gd-real-folder-'));
    const singleFile = join(dir, 'single.json');
    saveProject(deps, { sessionId, path: singleFile });
    const singleBytes = readFileSync(singleFile, 'utf8');
    asRealProject(deps.store.get(sessionId).project).setFolderProject(true);
    const folderDir = join(dir, 'nested', 'game');
    const saved = saveProject(deps, { sessionId, path: folderDir });
    assert.equal(saved.path, join(folderDir, 'game.json'));
    const files = listFiles(folderDir);
    assert.ok(files.includes('game.json'));
    assert.ok(files.includes(join('layouts', 'niveau1.json')));
    const main = JSON.parse(readFileSync(saved.path, 'utf8')) as Record<string, Record<string, unknown>>;
    assert.equal(main['properties']?.['folderProject'], true);
    assert.deepEqual(main['layouts'], [{ __REFERENCE_TO_SPLIT_OBJECT: true, referenceTo: '/layouts/niveau1' }]);
    const reopened = new ProjectStore(runtime.engine);
    const opened = openProject({ store: reopened, engine: runtime.engine }, { path: folderDir });
    assert.equal(reopened.get(opened.sessionId).kind, 'folder');
    await runtime.loadFolderExtensions(reopened.get(opened.sessionId).project);
    asRealProject(reopened.get(opened.sessionId).project).setFolderProject(false);
    const singleFile2 = join(dir, 'single2.json');
    saveProject({ store: reopened, engine: runtime.engine }, { sessionId: opened.sessionId, path: singleFile2 });
    assert.equal(normalizedSingle(readFileSync(singleFile2, 'utf8')), normalizedSingle(singleBytes));
    assert.equal(
      describeProject({ store: reopened, engine: runtime.engine }, { sessionId: opened.sessionId }).layoutCount,
      1,
    );
  });

  it('projet a behaviors custom : extensions chargees, diagnostics sans faux positifs', async () => {
    const { loadGdRuntime } = await import('../src/runtime.js');
    const { ProjectStore } = await import('../src/sessions.js');
    const { createProject, openProject, saveProject } = await import('../src/commands.js');
    const content = await import('../src/content.js');
    const runtime = await loadGdRuntime({ libgdPath: LIBGD_PATH });
    const deps = { store: new ProjectStore(runtime.engine), engine: runtime.engine };
    const { sessionId } = createProject(deps, { name: 'FolderCustom' });
    const project = deps.store.get(sessionId).project;
    const real = asRealProject(project);
    runtime.engine.createScene(project, 'Game');
    const ext = real.insertNewEventsFunctionsExtension('MyCustomExt', 0);
    const behavior = ext.getEventsBasedBehaviors().insertNew('MyCustomBehavior', 0);
    behavior.setFullName('My custom behavior');
    behavior.setDescription('Custom for folder round-trip');
    behavior.setObjectType('Sprite');
    await runtime.loadFolderExtensions(project);
    content.addObject(deps, {
      sessionId,
      scene: 'Game',
      type: 'Sprite',
      name: 'Hero',
      behaviors: [{ type: 'MyCustomExt::MyCustomBehavior' }],
    });
    real.setFolderProject(true);
    const dir = mkdtempSync(join(tmpdir(), 'gd-real-folder-custom-'));
    const folderDir = join(dir, 'game');
    saveProject(deps, { sessionId, path: folderDir });
    const reopened = new ProjectStore(runtime.engine);
    const opened = openProject({ store: reopened, engine: runtime.engine }, { path: folderDir });
    const project2 = reopened.get(opened.sessionId).project;
    const real2 = asRealProject(project2);
    await runtime.loadFolderExtensions(project2);
    assert.equal(real2.getEventsFunctionsExtensionsCount(), 1);
    assert.equal(runtime.engine.listDiagnostics(project2).length, 0);
    const scene = runtime.engine.describeContent(project2).scenes[0];
    assert.equal(scene?.objects[0]?.behaviors[0]?.type, 'MyCustomExt::MyCustomBehavior');
  });
});
