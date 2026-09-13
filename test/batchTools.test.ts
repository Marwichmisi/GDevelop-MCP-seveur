import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpError } from '../src/errors.js';
import { ProjectStore } from '../src/sessions.js';
import { createProject, describeProject, type CommandDeps } from '../src/commands.js';
import { createContentTools, createProjectTools } from '../src/tools.js';
import { createFakeEngine } from './fakeEngine.js';

function makeDeps() {
  const engine = createFakeEngine();
  const store = new ProjectStore(engine);
  return { store, engine };
}

describe('batch + undo via outils (ticket #17)', () => {
  it('apply_content_batch + undo_last_edit traversent la chaine outils', async () => {
    const deps = makeDeps();
    const tools = [...createProjectTools(deps), ...createContentTools(deps)];
    const find = (name: string) => {
      const tool = tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `outil ${name} enregistré`);
      return tool.handler;
    };
    const created = JSON.parse(
      ((await find('create_project')({ name: 'Via batch' })).content[0] as { text: string }).text,
    ) as { sessionId: string };
    const sessionId = created.sessionId;
    const result = JSON.parse(
      (
        (
          await find('apply_content_batch')({
            sessionId,
            ops: [
              { op: 'create_scene', payload: { sessionId, name: 'Niveau1' } },
              { op: 'add_object', payload: { sessionId, scene: 'Niveau1', type: 'Sprite', name: 'Joueur' } },
              { op: 'place_instance', payload: { sessionId, scene: 'Niveau1', object: 'Joueur', x: 10, y: 20 } },
              { op: 'set_variable', payload: { sessionId, target: { scope: 'global' }, name: 'score', value: 0 } },
            ],
          })
        ).content[0] as { text: string }
      ).text,
    ) as { applied: number; diff: { empty: boolean }; dryRun: boolean };
    assert.equal(result.applied, 4);
    assert.equal(result.dryRun, false);
    assert.equal(result.diff.empty, false);
    await assert.rejects(find('undo_last_edit')({ sessionId }), (error: unknown) => {
      return error instanceof McpError && error.code === 'validation-failed';
    });
    assert.equal((describeProject(deps, { sessionId }) as { content: { scenes: unknown[] } }).content.scenes.length, 1);
  });
});
