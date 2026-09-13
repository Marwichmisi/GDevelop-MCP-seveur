import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpError } from '../src/errors.js';
import { ProjectStore } from '../src/sessions.js';
import { createProject, describeProject, saveProject, type CommandDeps } from '../src/commands.js';
import { applyContentBatch, type BatchOpResult } from '../src/batch.js';
import { createFakeEngine } from './fakeEngine.js';

function makeDeps(diags: { type: string; message: string }[] = []) {
  const engine = createFakeEngine({ initialDiagnostics: diags });
  const store = new ProjectStore(engine);
  return { store, engine };
}
function makeSession(deps: CommandDeps, name = 'Batch'): string {
  return createProject(deps, { name }).sessionId;
}
function snap(deps: CommandDeps, sessionId: string): string {
  return JSON.stringify(describeProject(deps, { sessionId }).content);
}


describe('apply_content_batch (ticket #17, spec US17)', () => {
  it('applique scene + objet + instance + variable en un appel avec resumes + diff', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const result = applyContentBatch(deps, {
      sessionId,
      ops: [
        { op: 'create_scene', payload: { sessionId, name: 'Niveau1' } },
        { op: 'add_object', payload: { sessionId, scene: 'Niveau1', type: 'Sprite', name: 'Joueur' } },
        { op: 'place_instance', payload: { sessionId, scene: 'Niveau1', object: 'Joueur', x: 100, y: 200 } },
        { op: 'set_variable', payload: { sessionId, target: { scope: 'object', scene: 'Niveau1', object: 'Joueur' }, name: 'vie', value: 3 } },
      ],
    });
    assert.equal(result.applied, 4);
    assert.equal(result.dryRun, false);
    assert.equal((result.results[0] as BatchOpResult).op, 'create_scene');
    assert.ok(result.results.every((entry: BatchOpResult) => entry.ok === true));
    assert.equal(result.diff.empty, false);
    assert.deepEqual(result.diff.scenes.added, ['Niveau1']);
    assert.equal(deps.store.get(sessionId).dirty, true);
    const scene = describeProject(deps, { sessionId }).content.scenes[0];
    assert.equal(scene?.objects[0]?.name, 'Joueur');
    assert.equal(scene?.instances.length, 1);
    assert.deepEqual(scene?.objects[0]?.variables, { vie: 3 });
  });

  it('annule tout quand la 3e op sur 4 echoue', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const before = snap(deps, sessionId);
    assert.throws(
      () =>
        applyContentBatch(deps, {
          sessionId,
          ops: [
            { op: 'create_scene', payload: { sessionId, name: 'Niveau1' } },
            { op: 'add_object', payload: { sessionId, scene: 'Niveau1', type: 'Sprite', name: 'Joueur' } },
            { op: 'place_instance', payload: { sessionId, scene: 'Niveau1', object: 'Fantome', x: 0, y: 0 } },
            { op: 'set_variable', payload: { sessionId, target: { scope: 'global' }, name: 'score', value: 1 } },
          ],
        }),
      (error: unknown) => {
        assert.ok(error instanceof McpError);
        assert.match(error.message, /3\/4.*place_instance/);
        return true;
      },
    );
    assert.equal(snap(deps, sessionId), before);
    assert.equal(deps.store.get(sessionId).dirty, false);
  });

  it('gate baseline : refuse sans flag, accepte avec allowInvalidBaseline', () => {
    const deps = makeDeps([{ type: 'UnknownObject', message: 'Deja casse.' }]);
    const sessionId = makeSession(deps);
    assert.throws(
      () => applyContentBatch(deps, { sessionId, ops: [{ op: 'create_scene', payload: { sessionId, name: 'A' } }] }),
      (error: unknown) => error instanceof McpError && error.code === 'validation-failed',
    );
    const ok = applyContentBatch(deps, {
      sessionId,
      allowInvalidBaseline: true,
      ops: [{ op: 'create_scene', payload: { sessionId, name: 'A' } }],
    });
    assert.equal(ok.applied, 1);
  });

  it('dryRun rejoue tout puis restaure : memoire + dirty intacts, diff present', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const before = snap(deps, sessionId);
    const result = applyContentBatch(deps, {
      sessionId,
      dryRun: true,
      ops: [
        { op: 'create_scene', payload: { sessionId, name: 'Ghost' } },
        { op: 'add_object', payload: { sessionId, scene: 'Ghost', type: 'Sprite', name: 'Boo' } },
      ],
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.applied, 2);
    assert.equal(result.diff.empty, false);
    assert.deepEqual(result.diff.scenes.added, ['Ghost']);
    assert.equal(snap(deps, sessionId), before);
    assert.equal(deps.store.get(sessionId).dirty, false);
  });

  it('injection : un round-trip casse mid-batch restaure tout en post-apply-failed', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const before = snap(deps, sessionId);
    // Panne injectée après le snapshot global : seule la 1re sérialisation passe.
    const realSerialize = deps.engine.serializeProject.bind(deps.engine);
    let calls = 0;

    deps.engine.serializeProject = ((project: Parameters<typeof realSerialize>[0]): string => {
      calls += 1;
      if (calls > 1) throw new Error('injected serialize failure');
      return realSerialize(project);
    }) as typeof realSerialize;
    try {
      assert.throws(
        () =>
          applyContentBatch(deps, {
            sessionId,
            ops: [{ op: 'create_scene', payload: { sessionId, name: 'Niveau1' } }],
          }),
        (error: unknown) => error instanceof McpError && error.code === 'post-apply-failed',
      );
    } finally {
      deps.engine.serializeProject = realSerialize;
    }
    assert.equal(snap(deps, sessionId), before);
    assert.equal(deps.store.get(sessionId).dirty, false);
  });
});

describe('batch: compensation disque import_resource (ticket #17)', () => {
  it('compense le binaire sur rollback (fichier supprime)', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const sourceDir = mkdtempSync(join(tmpdir(), 'gd-batch-src-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'gd-batch-proj-'));
    const source = join(sourceDir, 'hero.png');
    writeFileSync(source, 'fake-png-bytes');
    const target = join(projectDir, 'game.json');
    const before = snap(deps, sessionId);
    assert.throws(
      () =>
        applyContentBatch(deps, {
          sessionId,
          ops: [
            { op: 'import_resource', payload: { sessionId, kind: 'image', sourcePath: source, targetPath: target } },
            { op: 'place_instance', payload: { sessionId, scene: 'Nullepart', object: 'Fantome', x: 0, y: 0 } },
          ],
        }),
      (error: unknown) => error instanceof McpError,
    );
    assert.equal(snap(deps, sessionId), before);
    assert.ok(!existsSync(join(projectDir, 'hero.png')));
    assert.equal(describeProject(deps, { sessionId }).content.resources.length, 0);
  });

  it('dryRun avec import_resource ne laisse aucun binaire sur disque', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const sourceDir = mkdtempSync(join(tmpdir(), 'gd-dry-src-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'gd-dry-proj-'));
    const source = join(sourceDir, 'hero.png');
    writeFileSync(source, 'fake-png-bytes');
    const target = join(projectDir, 'game.json');
    const result = applyContentBatch(deps, {
      sessionId,
      dryRun: true,
      ops: [{ op: 'import_resource', payload: { sessionId, kind: 'image', sourcePath: source, targetPath: target } }],
    });
    assert.equal(result.dryRun, true);
    assert.ok(!existsSync(join(projectDir, 'hero.png')));
    assert.equal(deps.store.get(sessionId).dirty, false);
  });
});
describe('injections d échec à chaque étage du pipeline (AC #4, ticket #17)', () => {
  const listDir = (dir: string): string[] => readdirSync(dir).sort();

  it('étage pré-batch : échec du snapshot global refuse avant la première op', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const before = snap(deps, sessionId);
    const realSerialize = deps.engine.serializeProject.bind(deps.engine);
    deps.engine.serializeProject = ((): string => {
      throw new Error('injected pre-batch snapshot failure');
    }) as typeof realSerialize;
    try {
      assert.throws(
        () =>
          applyContentBatch(deps, {
            sessionId,
            ops: [{ op: 'create_scene', payload: { sessionId, name: 'Niveau1' } }],
          }),
        (error: unknown) => {
          assert.ok(error instanceof McpError);
          assert.match(error.message, /before any op ran/);
          return true;
        },
      );
    } finally {
      deps.engine.serializeProject = realSerialize;
    }
    assert.equal(snap(deps, sessionId), before);
    assert.equal(deps.store.get(sessionId).dirty, false);
  });

  it('étage gate post-apply : une NOUVELLE bloquante annule tout ; la baseline connue passe avec override', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const before = snap(deps, sessionId);
    const realList = deps.engine.listDiagnostics.bind(deps.engine);
    const realCreateScene = deps.engine.createScene.bind(deps.engine);
    let injected = false;
    deps.engine.listDiagnostics = ((project: Parameters<typeof realList>[0]) => {
      const base = realList(project);
      return injected ? [...base, { type: 'UndeclaredVariable', message: 'Injected by the batch.' }] : base;
    }) as typeof realList;
    deps.engine.createScene = ((project: Parameters<typeof realCreateScene>[0], name: string): void => {
      realCreateScene(project, name);
      injected = true;
    }) as typeof realCreateScene;
    try {
      // La 1re op injecte la bloquante : le gate post-apply doit tout annuler.
      assert.throws(
        () =>
          applyContentBatch(deps, {
            sessionId,
            ops: [
              { op: 'create_scene', payload: { sessionId, name: 'Niveau1' } },
              { op: 'set_variable', payload: { sessionId, target: { scope: 'global' }, name: 'score', value: 1 } },
            ],
          }),
        (error: unknown) => {
          assert.ok(error instanceof McpError);
          assert.match(error.message, /introduced blocking errors/);
          return true;
        },
      );
      assert.equal(snap(deps, sessionId), before);
      assert.equal(deps.store.get(sessionId).dirty, false);
      // Override explicite : la même panne passe quand allowInvalidBaseline:true.
      const ok = applyContentBatch(deps, {
        sessionId,
        allowInvalidBaseline: true,
        ops: [
          { op: 'create_scene', payload: { sessionId, name: 'Niveau2' } },
          { op: 'set_variable', payload: { sessionId, target: { scope: 'global' }, name: 'score', value: 2 } },
        ],
      });
      assert.equal(ok.applied, 2);
      assert.equal(deps.store.get(sessionId).dirty, true);
    } finally {
      deps.engine.listDiagnostics = realList;
      deps.engine.createScene = realCreateScene;
    }
  });

  it('étage updateBehaviorsSharedData : un échec après les ops restaure tout', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const before = snap(deps, sessionId);
    const realUpdate = deps.engine.updateBehaviorsSharedData.bind(deps.engine);
    deps.engine.updateBehaviorsSharedData = (): void => {
      throw new Error('injected shared-data failure');
    };
    try {
      assert.throws(
        () =>
          applyContentBatch(deps, {
            sessionId,
            ops: [{ op: 'create_scene', payload: { sessionId, name: 'Niveau1' } }],
          }),
        (error: unknown) => error instanceof McpError && error.code === 'post-apply-failed',
      );
    } finally {
      deps.engine.updateBehaviorsSharedData = realUpdate;
    }
    assert.equal(snap(deps, sessionId), before);
    assert.equal(deps.store.get(sessionId).dirty, false);
  });

  it('étage disque en dryRun : fichier inchangé, aucun .bak- ni .pre-restore- créé', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const dir = mkdtempSync(join(tmpdir(), 'gd-dry-save-'));
    const file = join(dir, 'game.json');
    saveProject(deps, { sessionId, path: file });
    const beforeDisk = readFileSync(file, 'utf8');
    const result = applyContentBatch(deps, {
      sessionId,
      dryRun: true,
      ops: [{ op: 'create_scene', payload: { sessionId, name: 'Niveau1' } }],
    });
    assert.equal(result.dryRun, true);
    assert.equal(readFileSync(file, 'utf8'), beforeDisk);
    assert.deepEqual(listDir(dir), ['game.json']);
  });
});
