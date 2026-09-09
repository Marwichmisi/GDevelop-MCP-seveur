import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpError } from '../src/errors.js';
import { ProjectStore } from '../src/sessions.js';
import { createProject, describeProject, type CommandDeps } from '../src/commands.js';
import { createFakeEngine } from './fakeEngine.js';

function makeDeps() {
  const engine = createFakeEngine();
  const store = new ProjectStore(engine);
  return { store, engine };
}

function makeSession(deps: CommandDeps, name = 'Events'): string {
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

const cond = { type: 'VarScene', parameters: ['Score', '=', '0'] };
const act = { type: 'ModVarScene', parameters: ['Score', '+', '1'] };

describe('events: append standard (TDD slice 1)', () => {
  it('appends a standard event with condition+action, verified by describe', async () => {
    const { appendSceneEvents } = await import('../src/events.js');
    const { createScene } = await import('../src/content.js');
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'Game' });
    const result = appendSceneEvents(deps, {
      sessionId,
      scene: 'Game',
      events: [
        {
          kind: 'standard',
          conditions: [{ type: 'VarScene', parameters: ['Score', '=', '0'] }],
          actions: [{ type: 'ModVarScene', parameters: ['Score', '+', '1'] }],
        },
      ],
    });
    assert.equal(result.appended, 1);
    assert.equal(result.ids.length, 1);
    const summary = describeProject(deps, { sessionId });
    assert.equal(summary.eventCount, 1);
  });
});

describe('events: full tree all kinds', () => {
  it('appends gameplay tree (standard+else+repeat+while+foreach+link+marker) in one call', async () => {
    const { appendSceneEvents } = await import('../src/events.js');
    const { createScene } = await import('../src/content.js');
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'Game' });
    const result = appendSceneEvents(deps, {
      sessionId,
      scene: 'Game',
      events: [
        {
          kind: 'group',
          name: 'Gameplay',
          events: [
            {
              kind: 'standard',
              conditions: [cond],
              actions: [act],
              events: [{ kind: 'else', actions: [act] }, { kind: 'repeat', repeatExpression: '3', actions: [act] }],
            },
            { kind: 'while', whileConditions: [cond], actions: [act] },
            { kind: 'foreach', object: 'Hero', actions: [act] },
            { kind: 'foreachChildVariable', iterableVariable: 'inv', actions: [act] },
            { kind: 'comment', comment: 'hello' },
            { kind: 'link', target: 'External' },
            { kind: 'jscode', inlineCode: '/* gdevelop-mcp:scene-script */ console.log(1);' },
          ],
        },
      ],
    });
    assert.equal(result.appended, 1);
    // 1 group + 7 children + 2 nested = 10 stamped ids
    assert.equal(result.ids.length, 10);
    const scene = describeProject(deps, { sessionId }).content.scenes[0];
    assert.equal(scene?.events.length, 1);
    assert.equal(scene?.events[0]?.kind, 'group');
    assert.equal(scene?.events[0]?.events.length, 7);
    assert.equal(scene?.events[0]?.events[0]?.kind, 'standard');
    assert.equal(scene?.events[0]?.events[0]?.events.length, 2);
  });

  it('respects position (insert at index, clamped)', async () => {
    const { appendSceneEvents } = await import('../src/events.js');
    const { createScene } = await import('../src/content.js');
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'G' });
    appendSceneEvents(deps, { sessionId, scene: 'G', events: [{ kind: 'comment', comment: 'first' }] });
    appendSceneEvents(deps, { sessionId, scene: 'G', position: 0, events: [{ kind: 'comment', comment: 'zero' }] });
    const events = describeProject(deps, { sessionId }).content.scenes[0]?.events;
    assert.equal(events?.[0]?.comment, 'zero');
    assert.equal(events?.[1]?.comment, 'first');
  });
});

describe('events: L1+L2 + JsCode marker', () => {
  it('refuses unknown instruction type (L1) without changing state', async () => {
    const { appendSceneEvents } = await import('../src/events.js');
    const { createScene } = await import('../src/content.js');
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'G' });
    const before = JSON.stringify(describeProject(deps, { sessionId }).content);
    await assertValidationFailed(
      () =>
        appendSceneEvents(deps, {
          sessionId,
          scene: 'G',
          events: [{ kind: 'standard', actions: [{ type: 'NopeNope', parameters: [] }] }],
        }),
      /Unknown action type.*L1/,
    );
    assert.equal(JSON.stringify(describeProject(deps, { sessionId }).content), before);
  });

  it('refuses wrong arity (L2) without changing state', async () => {
    const { appendSceneEvents } = await import('../src/events.js');
    const { createScene } = await import('../src/content.js');
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'G' });
    await assertValidationFailed(
      () =>
        appendSceneEvents(deps, {
          sessionId,
          scene: 'G',
          events: [{ kind: 'standard', actions: [{ type: 'ModVarScene', parameters: ['only-one'] }] }],
        }),
      /Wrong arity.*L2/,
    );
  });

  it('refuses free JsCode without the marker', async () => {
    const { appendSceneEvents } = await import('../src/events.js');
    const { createScene } = await import('../src/content.js');
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'G' });
    await assertValidationFailed(
      () => appendSceneEvents(deps, { sessionId, scene: 'G', events: [{ kind: 'jscode', inlineCode: 'alert(1)' }] }),
      /marker/,
    );
  });
});

describe('events: move/remove by path and id', () => {
  it('moves by path and removes by id', async () => {
    const { appendSceneEvents, moveSceneEvent, removeSceneEvent } = await import('../src/events.js');
    const { createScene } = await import('../src/content.js');
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'G' });
    const appended = appendSceneEvents(deps, {
      sessionId,
      scene: 'G',
      events: [{ kind: 'comment', comment: 'a' }, { kind: 'comment', comment: 'b' }, { kind: 'comment', comment: 'c' }],
    });
    moveSceneEvent(deps, { sessionId, scene: 'G', from: { path: [0] }, toPosition: 2 });
    let events = describeProject(deps, { sessionId }).content.scenes[0]?.events;
    assert.deepEqual(events?.map((e) => e.comment), ['b', 'c', 'a']);
    // Remove the middle one by id
    const middleId = appended.ids[1] as string;
    // After the move, ids moved with events: find 'c' by comment then remove by its id
    events = describeProject(deps, { sessionId }).content.scenes[0]?.events;
    const c = events?.find((e) => e.comment === 'c');
    assert.ok(c?.id);
    removeSceneEvent(deps, { sessionId, scene: 'G', target: { id: c?.id as string } });
    events = describeProject(deps, { sessionId }).content.scenes[0]?.events;
    assert.deepEqual(events?.map((e) => e.comment), ['b', 'a']);
    void middleId;
  });

  it('refuses unknown path and id', async () => {
    const { moveSceneEvent, removeSceneEvent, appendSceneEvents } = await import('../src/events.js');
    const { createScene } = await import('../src/content.js');
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'G' });
    appendSceneEvents(deps, { sessionId, scene: 'G', events: [{ kind: 'comment', comment: 'a' }] });
    await assertValidationFailed(
      () => moveSceneEvent(deps, { sessionId, scene: 'G', from: { path: [9] }, toPosition: 0 }),
      /Unknown event path/,
    );
    await assertValidationFailed(
      () => removeSceneEvent(deps, { sessionId, scene: 'G', target: { id: 'nope' } }),
      /Unknown event id/,
    );
  });
});

describe('events: validate + dryRun', () => {
  it('validates without mutation', async () => {
    const { validateSceneEvents } = await import('../src/events.js');
    const { createScene } = await import('../src/content.js');
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'G' });
    const ok = validateSceneEvents(deps, { sessionId, scene: 'G', events: [{ kind: 'comment', comment: 'x' }] });
    assert.equal(ok.valid, true);
    const bad = validateSceneEvents(deps, {
      sessionId,
      scene: 'G',
      events: [{ kind: 'standard', actions: [{ type: 'Nope', parameters: [] }] }],
    });
    assert.equal(bad.valid, false);
    assert.ok(bad.errors.length > 0);
    assert.equal(describeProject(deps, { sessionId }).eventCount, 0);
  });

  it('dryRun appends nothing and leaves the session clean', async () => {
    const { appendSceneEvents } = await import('../src/events.js');
    const { createScene } = await import('../src/content.js');
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    createScene(deps, { sessionId, name: 'G' });
    const result = appendSceneEvents(deps, {
      sessionId,
      scene: 'G',
      dryRun: true,
      events: [{ kind: 'comment', comment: 'ghost' }],
    });
    assert.equal(result.dryRun, true);
    assert.equal(describeProject(deps, { sessionId }).eventCount, 0);
    assert.equal(deps.store.get(sessionId).dirty, true); // scene creation dirtied; dryRun adds nothing
  });
});

describe('event tools (thin wrappers over the command seam)', () => {
  it('exposes exactly the 4 event tools', async () => {
    const { createEventTools } = await import('../src/tools.js');
    const deps = makeDeps();
    const tools = createEventTools(deps);
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['append_scene_events', 'move_scene_event', 'remove_scene_event', 'validate_scene_events'],
    );
  });

  it('append/move/remove/validate run through the full tool chain', async () => {
    const { createEventTools, createContentTools, createProjectTools } = await import('../src/tools.js');
    const deps = makeDeps();
    const tools = [...createProjectTools(deps), ...createContentTools(deps), ...createEventTools(deps)];
    const find = (name: string): ((args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[] }>) => {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `tool ${name} registered`);
      return tool.handler;
    };
    const created = JSON.parse(
      ((await find('create_project')({ name: 'Via tools' })).content[0] as { text: string }).text,
    ) as { sessionId: string };
    const sessionId = created.sessionId;
    await find('create_scene')({ sessionId, name: 'G' });
    const appended = JSON.parse(
      (
        (
          await find('append_scene_events')({
            sessionId,
            scene: 'G',
            events: [
              { kind: 'comment', comment: 'a' },
              { kind: 'comment', comment: 'b' },
            ],
          })
        ).content[0] as { text: string }
      ).text,
    ) as { appended: number; ids: string[] };
    assert.equal(appended.appended, 2);
    assert.equal(appended.ids.length, 2);
    await find('move_scene_event')({ sessionId, scene: 'G', from: { path: [0] }, toPosition: 1 });
    const validated = JSON.parse(
      ((await find('validate_scene_events')({ sessionId, scene: 'G', events: [{ kind: 'comment', comment: 'x' }] })).content[0] as { text: string }).text,
    ) as { valid: boolean };
    assert.equal(validated.valid, true);
    await find('remove_scene_event')({ sessionId, scene: 'G', target: { path: [0] } });
    const described = JSON.parse(
      ((await find('describe_project')({ sessionId })).content[0] as { text: string }).text,
    ) as { eventCount: number };
    assert.equal(described.eventCount, 1);
  });
});
