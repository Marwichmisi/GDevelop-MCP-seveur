import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ProjectStore } from '../src/sessions.js';
import { runMutation } from '../src/pipeline.js';
import { McpError } from '../src/errors.js';
import { createFakeEngine, FakeProject } from './fakeEngine.js';

const renameSchema = z.object({ name: z.string().min(1) });

describe('runMutation pipeline', () => {
  it('applies a valid mutation and marks the session dirty', () => {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    const session = store.create('Before');
    const result = runMutation(store, engine, {
      sessionId: session.id,
      schema: renameSchema,
      args: { name: 'After' },
      apply: ({ project, args }) => {
        engine.setProjectName(project, args.name);
        return args.name;
      },
    });
    assert.equal(result, 'After');
    assert.equal(store.get(session.id).dirty, true);
    assert.equal(engine.describeProject(session.project).name, 'After');
  });

  it('refuses invalid args before any mutation (memory untouched)', () => {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    const session = store.create('Before');
    assert.throws(
      () =>
        runMutation(store, engine, {
          sessionId: session.id,
          schema: renameSchema,
          args: { name: '' },
          apply: ({ project, args }) => engine.setProjectName(project, args.name),
        }),
      (error: unknown) => error instanceof McpError && error.code === 'validation-failed',
    );
    assert.equal(engine.describeProject(session.project).name, 'Before');
    assert.equal(store.get(session.id).dirty, false);
  });

  it('refuses a failed precondition before any mutation', () => {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    const session = store.create('Before');
    assert.throws(
      () =>
        runMutation(store, engine, {
          sessionId: session.id,
          schema: renameSchema,
          args: { name: 'After' },
          preconditions: () => {
            throw new McpError('validation-failed', 'No such layout.');
          },
          apply: ({ project, args }) => engine.setProjectName(project, args.name),
        }),
      (error: unknown) => error instanceof McpError && error.code === 'validation-failed',
    );
    assert.equal(engine.describeProject(session.project).name, 'Before');
    assert.equal(store.get(session.id).dirty, false);
  });

  it('restores the memory snapshot when post-apply diagnostics report new blocking errors', () => {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    const session = store.create('Before');
    assert.throws(
      () =>
        runMutation(store, engine, {
          sessionId: session.id,
          schema: renameSchema,
          args: { name: 'After' },
          apply: ({ project, args }) => {
            engine.setProjectName(project, args.name);
            engine.diagnostics.push({ type: 'UnknownObject', message: 'Missing sprite.' });
          },
        }),
      (error: unknown) => error instanceof McpError && error.code === 'post-apply-failed',
    );
    assert.equal(engine.describeProject(session.project).name, 'Before');
    assert.equal(store.get(session.id).dirty, false);
  });

  it('ignores pre-existing baseline diagnostics (zero-new-error gate)', () => {
    const engine = createFakeEngine({
      initialDiagnostics: [{ type: 'MissingBehavior', message: 'Already broken.' }],
    });
    const store = new ProjectStore(engine);
    const session = store.create('Before');
    runMutation(store, engine, {
      sessionId: session.id,
      schema: renameSchema,
      args: { name: 'After' },
      apply: ({ project, args }) => engine.setProjectName(project, args.name),
    });
    assert.equal(engine.describeProject(session.project).name, 'After');
  });

  it('restores the snapshot when the project no longer round-trips', () => {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    const session = store.create('Before');
    assert.throws(
      () =>
        runMutation(store, engine, {
          sessionId: session.id,
          schema: renameSchema,
          args: { name: 'After' },
          apply: ({ project, args }) => {
            engine.setProjectName(project, args.name);
            (project as FakeProject).failSerialize = true;
          },
        }),
      (error: unknown) => error instanceof McpError && error.code === 'post-apply-failed',
    );
    (session.project as FakeProject).failSerialize = false;
    assert.equal(engine.describeProject(session.project).name, 'Before');
  });

  it('throws unknown-session before touching the engine', () => {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    assert.throws(
      () =>
        runMutation(store, engine, {
          sessionId: '00000000-0000-0000-0000-000000000000',
          schema: renameSchema,
          args: { name: 'After' },
          apply: () => {},
        }),
      (error: unknown) => error instanceof McpError && error.code === 'unknown-session',
    );
  });
});
