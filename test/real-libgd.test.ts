import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpError } from '../src/errors.js';

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

  it('Niveau1/Joueur scenario tool by tool, verified by describe', async () => {
    const { loadGdRuntime } = await import('../src/runtime.js');
    const { ProjectStore } = await import('../src/sessions.js');
    const { createProject, describeProject, saveProject, openProject } = await import('../src/commands.js');
    const content = await import('../src/content.js');
    const runtime = await loadGdRuntime({ libgdPath: LIBGD_PATH });
    const deps = { store: new ProjectStore(runtime.engine), engine: runtime.engine };

    const { sessionId } = createProject(deps, { name: 'Real content' });
    content.createScene(deps, { sessionId, name: 'Niveau1' });
    content.addObject(deps, {
      sessionId,
      scene: 'Niveau1',
      type: 'Sprite',
      name: 'Joueur',
      behaviors: [{ type: 'PlatformBehavior::PlatformerObjectBehavior', name: 'Platformer' }],
      variables: { vie: 3 },
    });
    const { instanceId } = content.placeInstance(deps, {
      sessionId,
      scene: 'Niveau1',
      object: 'Joueur',
      x: 100,
      y: 200,
    });
    content.setVariable(deps, { sessionId, target: { scope: 'global' }, name: 'score', value: 0 });

    const summary = describeProject(deps, { sessionId });
    assert.equal(summary.layoutCount, 1);
    assert.equal(summary.objectCount, 1);
    assert.equal(summary.behaviorCount, 1);
    const scene = summary.content.scenes[0];
    assert.equal(scene?.name, 'Niveau1');
    assert.equal(scene?.objects[0]?.behaviors[0]?.type, 'PlatformBehavior::PlatformerObjectBehavior');
    assert.equal(scene?.objects[0]?.behaviors[0]?.properties['gravity'], 1000);
    assert.equal(scene?.instances[0]?.x, 100);
    assert.equal(scene?.instances[0]?.y, 200);
    assert.deepEqual(scene?.objects[0]?.variables, { vie: 3 });
    assert.deepEqual(summary.content.globalVariables, { score: 0 });

    // Behaviors update after creation; bulk instance ops.
    content.updateBehavior(deps, {
      sessionId,
      scene: 'Niveau1',
      object: 'Joueur',
      name: 'Platformer',
      properties: { Gravity: 1500, IgnoreDefaultControls: true },
    });
    assert.equal(
      describeProject(deps, { sessionId }).content.scenes[0]?.objects[0]?.behaviors[0]?.properties['gravity'],
      1500,
    );
    assert.equal(
      describeProject(deps, { sessionId }).content.scenes[0]?.objects[0]?.behaviors[0]?.properties['ignoreDefaultControls'],
      true,
    );
    content.createLayer(deps, { sessionId, scene: 'Niveau1', name: 'Back' });
    content.moveInstancesToLayer(deps, { sessionId, scene: 'Niveau1', sourceLayer: '', targetLayer: 'Back' });
    assert.equal(describeProject(deps, { sessionId }).content.scenes[0]?.instances[0]?.layer, 'Back');
    content.updateInstance(deps, { sessionId, scene: 'Niveau1', instanceId, x: 150 });
    assert.equal(describeProject(deps, { sessionId }).content.scenes[0]?.instances[0]?.x, 150);
    content.renameObject(deps, { sessionId, scene: 'Niveau1', name: 'Joueur', newName: 'Hero' });
    assert.equal(describeProject(deps, { sessionId }).content.scenes[0]?.instances[0]?.object, 'Hero');
    content.removeInstancesOfObject(deps, { sessionId, scene: 'Niveau1', object: 'Hero' });
    assert.deepEqual(describeProject(deps, { sessionId }).content.scenes[0]?.instances, []);

    // Content survives save → reopen.
    const dir = mkdtempSync(join(tmpdir(), 'gd-real-content-'));
    const file = join(dir, 'game.json');
    saveProject(deps, { sessionId, path: file });
    const reopened = new ProjectStore(runtime.engine);
    const opened = openProject({ store: reopened, engine: runtime.engine }, { path: file });
    const again = describeProject({ store: reopened, engine: runtime.engine }, { sessionId: opened.sessionId });
    assert.equal(again.content.scenes[0]?.objects[0]?.name, 'Hero');
    assert.deepEqual(again.content.globalVariables, { score: 0 });
  });

  it('refuses unknown types and properties without changing state', async () => {
    const { loadGdRuntime } = await import('../src/runtime.js');
    const { ProjectStore } = await import('../src/sessions.js');
    const { createProject, describeProject } = await import('../src/commands.js');
    const content = await import('../src/content.js');
    const runtime = await loadGdRuntime({ libgdPath: LIBGD_PATH });
    const deps = { store: new ProjectStore(runtime.engine), engine: runtime.engine };

    const { sessionId } = createProject(deps, { name: 'Refusals' });
    content.createScene(deps, { sessionId, name: 'N' });
    const refuses = (action: () => unknown, pattern: RegExp): void => {
      assert.throws(action, (error: unknown) => error instanceof McpError && pattern.test(error.message));
    };
    refuses(() => content.addObject(deps, { sessionId, scene: 'N', type: 'Nope', name: 'X' }), /Unknown object type/);
    content.addObject(deps, { sessionId, scene: 'N', type: 'Sprite', name: 'O' });
    refuses(
      () => content.attachBehavior(deps, { sessionId, scene: 'N', object: 'O', type: 'Nope::Nope', name: 'B' }),
      /Unknown behavior type/,
    );
    refuses(
      () =>
        content.attachBehavior(deps, {
          sessionId,
          scene: 'N',
          object: 'O',
          type: 'PlatformBehavior::PlatformerObjectBehavior',
          name: 'P',
          properties: { nope: 1 },
        }),
      /Unknown property "nope".*Gravity/,
    );
    // The failed attach left no behavior behind.
    assert.deepEqual(describeProject(deps, { sessionId }).content.scenes[0]?.objects[0]?.behaviors, []);
  });

  it('imports a resource next to the project on the real engine', async () => {
    const { loadGdRuntime } = await import('../src/runtime.js');
    const { ProjectStore } = await import('../src/sessions.js');
    const { createProject, describeProject } = await import('../src/commands.js');
    const content = await import('../src/content.js');
    const runtime = await loadGdRuntime({ libgdPath: LIBGD_PATH });
    const deps = { store: new ProjectStore(runtime.engine), engine: runtime.engine };

    const { sessionId } = createProject(deps, { name: 'Real resource' });
    const sourceDir = mkdtempSync(join(tmpdir(), 'gd-real-src-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'gd-real-proj-'));
    const source = join(sourceDir, 'hero.png');
    writeFileSync(source, 'fake-png-bytes');
    content.importResource(deps, {
      sessionId,
      kind: 'image',
      sourcePath: source,
      targetPath: join(projectDir, 'game.json'),
    });
    assert.deepEqual(describeProject(deps, { sessionId }).content.resources, [
      { name: 'hero', kind: 'image', file: 'hero.png' },
    ]);
  });

  it('appends a Gameplay event tree natively, verified at reload with stable ids', async () => {
    const { loadGdRuntime } = await import('../src/runtime.js');
    const { ProjectStore } = await import('../src/sessions.js');
    const { createProject, describeProject, saveProject, openProject } = await import('../src/commands.js');
    const content = await import('../src/content.js');
    const events = await import('../src/events.js');
    const runtime = await loadGdRuntime({ libgdPath: LIBGD_PATH });
    const deps = { store: new ProjectStore(runtime.engine), engine: runtime.engine };

    const { sessionId } = createProject(deps, { name: 'Real events' });
    content.createScene(deps, { sessionId, name: 'Game' });
    const appended = events.appendSceneEvents(deps, {
      sessionId,
      scene: 'Game',
      events: [
        {
          kind: 'group',
          name: 'Gameplay',
          events: [
            {
              kind: 'standard',
              conditions: [{ type: 'VarScene', parameters: ['Score', '=', '0'] }],
              actions: [{ type: 'ModVarScene', parameters: ['Score', '+', '1'] }],
              events: [{ kind: 'else', actions: [{ type: 'ModVarScene', parameters: ['Score', '+', '1'] }] }],
            },
            { kind: 'repeat', repeatExpression: '3', actions: [{ type: 'ModVarScene', parameters: ['Score', '+', '1'] }] },
            {
              kind: 'while',
              whileConditions: [{ type: 'VarScene', parameters: ['Score', '=', '0'] }],
              actions: [{ type: 'ModVarScene', parameters: ['Score', '+', '1'] }],
            },
            { kind: 'foreach', object: 'Hero', actions: [{ type: 'ModVarScene', parameters: ['Score', '+', '1'] }] },
            { kind: 'link', target: 'External' },
            { kind: 'jscode', inlineCode: '/* gdevelop-mcp:scene-script */ console.log(1);' },
          ],
        },
      ],
    });
    assert.equal(appended.appended, 1);
    assert.ok(appended.ids.length >= 8);
    let scene = describeProject(deps, { sessionId }).content.scenes[0];
    assert.equal(scene?.events.length, 1);
    assert.equal(scene?.events[0]?.kind, 'group');
    const groupId = scene?.events[0]?.id;
    assert.match(groupId ?? '', /^[0-9a-f-]{36}$/);
    const standardId = scene?.events[0]?.events[0]?.id;
    assert.match(standardId ?? '', /^[0-9a-f-]{36}$/);

    // move by id, remove by path, validate without mutation.
    events.moveSceneEvent(deps, { sessionId, scene: 'Game', from: { id: standardId as string }, toPosition: 1 });
    scene = describeProject(deps, { sessionId }).content.scenes[0];
    assert.equal(scene?.events[0]?.events[1]?.id, standardId);
    const validated = events.validateSceneEvents(deps, {
      sessionId,
      scene: 'Game',
      events: [{ kind: 'comment', comment: 'ok' }],
    });
    assert.equal(validated.valid, true);
    events.removeSceneEvent(deps, { sessionId, scene: 'Game', target: { path: [0, 0] } });
    scene = describeProject(deps, { sessionId }).content.scenes[0];
    assert.equal(scene?.events[0]?.events.length, 5);

    // Native round-trip: save → reopen keeps the tree and the stamped ids.
    const dir = mkdtempSync(join(tmpdir(), 'gd-real-events-'));
    const file = join(dir, 'game.json');
    saveProject(deps, { sessionId, path: file });
    const reopened = new ProjectStore(runtime.engine);
    const opened = openProject({ store: reopened, engine: runtime.engine }, { path: file });
    const again = describeProject({ store: reopened, engine: runtime.engine }, { sessionId: opened.sessionId });
    assert.equal(again.content.scenes[0]?.events.length, 1);
    assert.equal(again.content.scenes[0]?.events[0]?.id, groupId);
  });

  it('refuses unknown types (L1), wrong arity (L2) and free JsCode on the real engine', async () => {
    const { loadGdRuntime } = await import('../src/runtime.js');
    const { ProjectStore } = await import('../src/sessions.js');
    const { createProject, describeProject } = await import('../src/commands.js');
    const content = await import('../src/content.js');
    const events = await import('../src/events.js');
    const runtime = await loadGdRuntime({ libgdPath: LIBGD_PATH });
    const deps = { store: new ProjectStore(runtime.engine), engine: runtime.engine };

    const { sessionId } = createProject(deps, { name: 'Real refusals' });
    content.createScene(deps, { sessionId, name: 'G' });
    const refuses = (action: () => unknown, pattern: RegExp): void => {
      assert.throws(action, (error: unknown) => error instanceof McpError && pattern.test(error.message));
    };
    refuses(
      () => events.appendSceneEvents(deps, { sessionId, scene: 'G', events: [{ kind: 'standard', actions: [{ type: 'NopeNope', parameters: [] }] }] }),
      /Unknown action type.*L1/,
    );
    refuses(
      () =>
        events.appendSceneEvents(deps, {
          sessionId,
          scene: 'G',
          events: [{ kind: 'standard', actions: [{ type: 'ModVarScene', parameters: ['only-one'] }] }],
        }),
      /Wrong arity.*L2/,
    );
    refuses(
      () => events.appendSceneEvents(deps, { sessionId, scene: 'G', events: [{ kind: 'jscode', inlineCode: 'alert(1)' }] }),
      /marker/,
    );
    assert.equal(describeProject(deps, { sessionId }).eventCount, 0);
  });
});
