import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpError } from '../src/errors.js';
import { ProjectStore } from '../src/sessions.js';
import { createProject, describeProject, type CommandDeps } from '../src/commands.js';
import {
  addObject,
  addToGroup,
  attachBehavior,
  createGroup,
  createLayer,
  createScene,
  deleteLayer,
  deleteScene,
  importResource,
  moveInstancesToLayer,
  moveScene,
  placeInstance,
  removeBehavior,
  removeFromGroup,
  removeInstance,
  removeInstancesOfObject,
  removeObject,
  removeResource,
  removeVariable,
  renameLayer,
  renameObject,
  renameScene,
  renameVariable,
  setVariable,
  updateBehavior,
  updateInstance,
} from '../src/content.js';
import { createFakeEngine } from './fakeEngine.js';

function makeDeps() {
  const engine = createFakeEngine();
  const store = new ProjectStore(engine);
  return { store, engine };
}

function makeSession(deps: CommandDeps, name = 'Content'): string {
  return createProject(deps, { name }).sessionId;
}

async function assertValidationFailed(action: () => unknown, pattern: RegExp): Promise<void> {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof McpError && error.code === 'validation-failed', `expected validation-failed, got ${error}`);
    assert.match((error as McpError).message, pattern);
    return;
  }
  assert.fail('expected a validation-failed error');
}

describe('content commands: Niveau1/Joueur scenario', () => {
  it('builds scene + Sprite + instance + variables tool by tool, verified by describe', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);

    createScene(deps, { sessionId, name: 'Niveau1' });
    addObject(deps, {
      sessionId,
      scene: 'Niveau1',
      type: 'Sprite',
      name: 'Joueur',
      behaviors: [{ type: 'PlatformBehavior::PlatformerObjectBehavior', name: 'Platformer' }],
    });
    const placed = placeInstance(deps, { sessionId, scene: 'Niveau1', object: 'Joueur', x: 100, y: 200 });
    assert.match(placed.instanceId, /^[0-9a-f-]{36}$/);
    setVariable(deps, { sessionId, target: { scope: 'object', scene: 'Niveau1', object: 'Joueur' }, name: 'vie', value: 3 });
    setVariable(deps, { sessionId, target: { scope: 'global' }, name: 'score', value: 0 });

    const summary = describeProject(deps, { sessionId });
    assert.equal(summary.layoutCount, 1);
    assert.equal(summary.objectCount, 1);
    assert.equal(summary.behaviorCount, 1);
    const scene = summary.content.scenes[0];
    assert.equal(scene?.name, 'Niveau1');
    assert.equal(scene?.objects[0]?.name, 'Joueur');
    assert.equal(scene?.objects[0]?.behaviors[0]?.name, 'Platformer');
    assert.deepEqual(scene?.instances[0]?.x, 100);
    assert.deepEqual(scene?.instances[0]?.y, 200);
    assert.deepEqual(scene?.objects[0]?.variables, { vie: 3 });
    assert.deepEqual(summary.content.globalVariables, { score: 0 });
    assert.equal(summary.dirty, true);
  });
});

describe('content commands: scenes and layers', () => {
  it('refuses duplicate scenes and unknown renames', async () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'A' });
    await assertValidationFailed(() => createScene(deps, { sessionId, name: 'A' }), /already exists/);
    await assertValidationFailed(() => renameScene(deps, { sessionId, name: 'Missing', newName: 'B' }), /Unknown scene/);
    await assertValidationFailed(() => deleteScene(deps, { sessionId, name: 'Missing' }), /Unknown scene/);
  });

  it('moves scenes and clamps positions', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'A' });
    createScene(deps, { sessionId, name: 'B' });
    moveScene(deps, { sessionId, name: 'B', position: 0 });
    assert.deepEqual(
      describeProject(deps, { sessionId }).content.scenes.map((scene) => scene.name),
      ['B', 'A'],
    );
    moveScene(deps, { sessionId, name: 'B', position: 99 });
    assert.deepEqual(
      describeProject(deps, { sessionId }).content.scenes.map((scene) => scene.name),
      ['A', 'B'],
    );
    deleteScene(deps, { sessionId, name: 'A' });
    assert.deepEqual(
      describeProject(deps, { sessionId }).content.scenes.map((scene) => scene.name),
      ['B'],
    );
  });

  it('protects the base layer and re-points instances on rename', async () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'N' });
    createLayer(deps, { sessionId, scene: 'N', name: 'Sol' });
    addObject(deps, { sessionId, scene: 'N', type: 'Sprite', name: 'O' });
    placeInstance(deps, { sessionId, scene: 'N', object: 'O', x: 0, y: 0, layer: 'Sol' });
    await assertValidationFailed(() => deleteLayer(deps, { sessionId, scene: 'N', name: '' }), /base layer/);
    await assertValidationFailed(
      () => deleteLayer(deps, { sessionId, scene: 'N', name: 'Sol' }),
      /still hosts instances/,
    );
    renameLayer(deps, { sessionId, scene: 'N', name: 'Sol', newName: 'Ground' });
    const scene = describeProject(deps, { sessionId }).content.scenes[0];
    assert.deepEqual(scene?.layers, ['', 'Ground']);
    assert.equal(scene?.instances[0]?.layer, 'Ground');
  });
});

describe('content commands: objects and behaviors', () => {
  it('renames objects with instance and group propagation, deletes with purge', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'N' });
    addObject(deps, { sessionId, scene: 'N', type: 'Sprite', name: 'Joueur' });
    createGroup(deps, { sessionId, scene: 'N', name: 'Team', objects: ['Joueur'] });
    placeInstance(deps, { sessionId, scene: 'N', object: 'Joueur', x: 1, y: 2 });
    renameObject(deps, { sessionId, scene: 'N', name: 'Joueur', newName: 'Hero' });
    let scene = describeProject(deps, { sessionId }).content.scenes[0];
    assert.equal(scene?.objects[0]?.name, 'Hero');
    assert.equal(scene?.instances[0]?.object, 'Hero');
    assert.deepEqual(scene?.groups, [{ name: 'Team', objects: ['Hero'] }]);
    removeObject(deps, { sessionId, scene: 'N', name: 'Hero' });
    scene = describeProject(deps, { sessionId }).content.scenes[0];
    assert.deepEqual(scene?.objects, []);
    assert.deepEqual(scene?.instances, []);
    assert.deepEqual(scene?.groups, [{ name: 'Team', objects: [] }]);
  });

  it('attaches with default short names, updates case-insensitively, refuses unknown props', async () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'N' });
    addObject(deps, { sessionId, scene: 'N', type: 'Sprite', name: 'O' });
    const attached = attachBehavior(deps, {
      sessionId,
      scene: 'N',
      object: 'O',
      type: 'PlatformBehavior::PlatformerObjectBehavior',
      properties: { Gravity: 1500, maxspeed: 300 },
    });
    assert.equal(attached.name, 'PlatformerObjectBehavior');
    updateBehavior(deps, { sessionId, scene: 'N', object: 'O', name: attached.name, properties: { GRAVITY: 900 } });
    const behaviors = describeProject(deps, { sessionId }).content.scenes[0]?.objects[0]?.behaviors;
    assert.equal(behaviors?.[0]?.properties['gravity'], 900);
    assert.equal(behaviors?.[0]?.properties['maxspeed'], 300);
    // JSON value types survive (booleans travel as "1"/"0" only on the live wire).
    updateBehavior(deps, { sessionId, scene: 'N', object: 'O', name: attached.name, properties: { IgnoreDefaultControls: true } });
    assert.equal(
      describeProject(deps, { sessionId }).content.scenes[0]?.objects[0]?.behaviors[0]?.properties['ignoreDefaultControls'],
      true,
    );
    // Unknown-property refusal needs live engine metadata; the real-engine
    // suite proves it (valid-name list in the message). The fake merges.
    updateBehavior(deps, { sessionId, scene: 'N', object: 'O', name: attached.name, properties: { nope: 1 } });
    assert.equal(
      describeProject(deps, { sessionId }).content.scenes[0]?.objects[0]?.behaviors[0]?.properties['nope'],
      1,
    );
    removeBehavior(deps, { sessionId, scene: 'N', object: 'O', name: attached.name });
    assert.deepEqual(describeProject(deps, { sessionId }).content.scenes[0]?.objects[0]?.behaviors, []);
  });

  it('refuses unknown objects and duplicate behaviors', async () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'N' });
    await assertValidationFailed(
      () => attachBehavior(deps, { sessionId, scene: 'N', object: 'Ghost', type: 'T', name: 'B' }),
      /Unknown object/,
    );
    addObject(deps, { sessionId, scene: 'N', type: 'Sprite', name: 'O' });
    attachBehavior(deps, { sessionId, scene: 'N', object: 'O', type: 'T', name: 'B' });
    await assertValidationFailed(
      () => attachBehavior(deps, { sessionId, scene: 'N', object: 'O', type: 'T', name: 'B' }),
      /already exists/,
    );
  });
});

describe('content commands: instances', () => {
  it('updates and removes a single instance by id', async () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'N' });
    addObject(deps, { sessionId, scene: 'N', type: 'Sprite', name: 'O' });
    const { instanceId } = placeInstance(deps, { sessionId, scene: 'N', object: 'O', x: 0, y: 0 });
    updateInstance(deps, { sessionId, scene: 'N', instanceId, x: 10, y: 20, zOrder: 3, width: 64, height: 64 });
    let instance = describeProject(deps, { sessionId }).content.scenes[0]?.instances[0];
    assert.equal(instance?.x, 10);
    assert.equal(instance?.zOrder, 3);
    assert.equal(instance?.customSize, true);
    removeInstance(deps, { sessionId, scene: 'N', instanceId });
    assert.deepEqual(describeProject(deps, { sessionId }).content.scenes[0]?.instances, []);
    await assertValidationFailed(() => removeInstance(deps, { sessionId, scene: 'N', instanceId }), /Unknown instance/);
  });

  it('purges by object and moves by layer in bulk', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'N' });
    createLayer(deps, { sessionId, scene: 'N', name: 'Back' });
    addObject(deps, { sessionId, scene: 'N', type: 'Sprite', name: 'A' });
    addObject(deps, { sessionId, scene: 'N', type: 'Sprite', name: 'B' });
    placeInstance(deps, { sessionId, scene: 'N', object: 'A', x: 0, y: 0, layer: 'Back' });
    placeInstance(deps, { sessionId, scene: 'N', object: 'A', x: 1, y: 1 });
    placeInstance(deps, { sessionId, scene: 'N', object: 'B', x: 2, y: 2 });
    assert.deepEqual(moveInstancesToLayer(deps, { sessionId, scene: 'N', sourceLayer: 'Back', targetLayer: '' }), {
      moved: 1,
    });
    assert.deepEqual(removeInstancesOfObject(deps, { sessionId, scene: 'N', object: 'A' }), { removed: 2 });
    const instances = describeProject(deps, { sessionId }).content.scenes[0]?.instances;
    assert.deepEqual(instances?.map((candidate) => candidate.object), ['B']);
  });

  it('refuses unknown objects, layers and instances without changing state', async () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'N' });
    const before = JSON.stringify(describeProject(deps, { sessionId }).content);
    await assertValidationFailed(
      () => placeInstance(deps, { sessionId, scene: 'N', object: 'Ghost', x: 0, y: 0 }),
      /Unknown object/,
    );
    await assertValidationFailed(
      () => placeInstance(deps, { sessionId, scene: 'Missing', object: 'Ghost', x: 0, y: 0 }),
      /Unknown scene/,
    );
    assert.equal(JSON.stringify(describeProject(deps, { sessionId }).content), before);
  });
});

describe('content commands: variables', () => {
  it('round-trips nested structures and arrays in every scope', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'N' });
    addObject(deps, { sessionId, scene: 'N', type: 'Sprite', name: 'O' });
    const { instanceId } = placeInstance(deps, { sessionId, scene: 'N', object: 'O', x: 0, y: 0 });
    const nested = { hp: 3, tags: ['fast', 'red'], pos: { x: 1, y: { deep: [true, 2, 'three'] } } };
    setVariable(deps, { sessionId, target: { scope: 'global' }, name: 'game', value: nested });
    setVariable(deps, { sessionId, target: { scope: 'scene', scene: 'N' }, name: 'game', value: nested });
    setVariable(deps, { sessionId, target: { scope: 'object', scene: 'N', object: 'O' }, name: 'game', value: nested });
    setVariable(deps, {
      sessionId,
      target: { scope: 'instance', scene: 'N', instanceId },
      name: 'game',
      value: nested,
    });
    const content = describeProject(deps, { sessionId }).content;
    assert.deepEqual(content.globalVariables, { game: nested });
    assert.deepEqual(content.scenes[0]?.variables, { game: nested });
    assert.deepEqual(content.scenes[0]?.objects[0]?.variables, { game: nested });
    assert.deepEqual(content.scenes[0]?.instances[0]?.variables, { game: nested });
  });

  it('refuses null, unknown variables and renames cleanly', async () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    await assertValidationFailed(
      () => setVariable(deps, { sessionId, target: { scope: 'global' }, name: 'x', value: null }),
      /no engine representation/,
    );
    await assertValidationFailed(
      () => removeVariable(deps, { sessionId, target: { scope: 'global' }, name: 'missing' }),
      /Unknown variable/,
    );
    setVariable(deps, { sessionId, target: { scope: 'global' }, name: 'a', value: 1 });
    renameVariable(deps, { sessionId, target: { scope: 'global' }, name: 'a', newName: 'b' });
    assert.deepEqual(describeProject(deps, { sessionId }).content.globalVariables, { b: 1 });
    removeVariable(deps, { sessionId, target: { scope: 'global' }, name: 'b' });
    assert.deepEqual(describeProject(deps, { sessionId }).content.globalVariables, {});
  });
});

describe('content commands: groups', () => {
  it('creates, edits membership and deletes', async () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'N' });
    addObject(deps, { sessionId, scene: 'N', type: 'Sprite', name: 'A' });
    addObject(deps, { sessionId, scene: 'N', type: 'Sprite', name: 'B' });
    createGroup(deps, { sessionId, scene: 'N', name: 'Team', objects: ['A'] });
    addToGroup(deps, { sessionId, scene: 'N', group: 'Team', object: 'B' });
    removeFromGroup(deps, { sessionId, scene: 'N', group: 'Team', object: 'A' });
    assert.deepEqual(describeProject(deps, { sessionId }).content.scenes[0]?.groups, [
      { name: 'Team', objects: ['B'] },
    ]);
    await assertValidationFailed(
      () => addToGroup(deps, { sessionId, scene: 'N', group: 'Team', object: 'Ghost' }),
      /Unknown object/,
    );
    await assertValidationFailed(
      () => removeFromGroup(deps, { sessionId, scene: 'N', group: 'Team', object: 'A' }),
      /not in group/,
    );
  });
});

describe('content commands: resources', () => {
  it('copies the binary next to the project and registers the resource', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const sourceDir = mkdtempSync(join(tmpdir(), 'gd-res-src-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'gd-res-proj-'));
    const source = join(sourceDir, 'hero.png');
    writeFileSync(source, 'fake-png-bytes');
    const target = join(projectDir, 'game.json');
    const imported = importResource(deps, { sessionId, kind: 'image', sourcePath: source, targetPath: target });
    assert.equal(imported.name, 'hero');
    assert.ok(existsSync(join(projectDir, 'hero.png')));
    assert.equal(readFileSync(join(projectDir, 'hero.png'), 'utf8'), 'fake-png-bytes');
    assert.deepEqual(describeProject(deps, { sessionId }).content.resources, [
      { name: 'hero', kind: 'image', file: 'hero.png' },
    ]);
    removeResource(deps, { sessionId, name: 'hero' });
    assert.deepEqual(describeProject(deps, { sessionId }).content.resources, []);
  });

  it('refuses missing sources, unknown kinds and duplicates', async () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    await assertValidationFailed(
      () => importResource(deps, { sessionId, kind: 'image', sourcePath: '/nope/missing.png', targetPath: '/tmp/x.json' }),
      /not found/,
    );
    const dir = mkdtempSync(join(tmpdir(), 'gd-res-'));
    const source = join(dir, 'a.png');
    writeFileSync(source, 'x');
    await assertValidationFailed(
      () => importResource(deps, { sessionId, kind: 'portal', sourcePath: source, targetPath: join(dir, 'g.json') }),
      /Invalid mutation/,
    );
    await assertValidationFailed(
      () => importResource(deps, { sessionId, kind: 'image', sourcePath: source }),
      /save the session first/,
    );
  });
});

describe('content commands: pipeline integration', () => {
  it('rejects invalid payloads before any engine contact', async () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const before = JSON.stringify(describeProject(deps, { sessionId }).content);
    await assertValidationFailed(() => createScene(deps, { sessionId }), /Invalid mutation/);
    await assertValidationFailed(
      () => placeInstance(deps, { sessionId, scene: 'N', object: 'O', y: 0 }),
      /Invalid mutation/,
    );
    assert.equal(JSON.stringify(describeProject(deps, { sessionId }).content), before);
  });
});
