import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/sessions.js';
import { createContentTools, createProjectTools, type ToolDefinition } from '../src/tools.js';
import { createFakeEngine } from './fakeEngine.js';

/**
 * Ticket #36 — Variable de Scène numérique relue en texte (Score 0 -> "0").
 *
 * Repro du ticket : `set_variable` Score=0 (number) en Scène puis `describe`
 * relit {Score:"0"} (string). Enquête (preuve live libGD 5.6.281, tous les
 * scopes et tous les ponts — direct, instance bridge, rename, save→reopen) :
 * le typage survit partout sur le code actuel, l'artefact collector local
 * (non versionné) portait une saisie string antérieure. Ce test fige le
 * comportement attendu au seam convenu (#20, surface MCP des tools
 * uniquement) : 0 (number) se relit 0 (number), en mémoire comme après
 * aller-retour disque, et la forme disque porte {type:"number",value:0} —
 * la garantie données dont `ModVarScene` +1 a besoin en preview.
 *
 * Vocabulaire CONTEXT.md : Session projet, Objet, Instance. Contrats
 * inchangés, typage fidèle.
 */

function handler(
  tools: ToolDefinition[],
  name: string,
): (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[] }> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `tool ${name} enregistré`);
  return tool.handler;
}

function parseText(result: { content: { type: 'text'; text: string }[] }): unknown {
  const first = result.content[0];
  assert.ok(first && first.type === 'text');
  return JSON.parse((first as { text: string }).text) as unknown;
}

interface ProjectView {
  content: {
    scenes: {
      variables: Record<string, unknown>;
      objects: { name: string; variables: Record<string, unknown> }[];
      instances: { id: string; variables: Record<string, unknown> }[];
    }[];
    globalVariables: Record<string, unknown>;
  };
}

describe('issue #36 : typage des variables fidèle au round-trip (seam tools MCP)', () => {
  it('Score=0 (number) en Scène se relit 0 (number), même après rename aller-retour', async () => {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    const deps = { store, engine };
    const tools = [...createProjectTools(deps), ...createContentTools(deps)];
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
      parseText(await handler(tools, name)(args));

    const created = (await call('create_project', { name: 'Typing' })) as { sessionId: string };
    const sessionId = created.sessionId;
    await call('create_scene', { sessionId, name: 'Niveau1' });
    await call('set_variable', { sessionId, target: { scope: 'scene', scene: 'Niveau1' }, name: 'Score', value: 0 });

    // Repro exact du ticket : typeof strict, pas seulement deepEqual.
    let described = (await call('describe_project', { sessionId })) as ProjectView;
    assert.strictEqual(typeof described.content.scenes[0]?.variables['Score'], 'number');
    assert.strictEqual(described.content.scenes[0]?.variables['Score'], 0);

    // Le collector faisait un rename aller-retour (ScoreTmp) : il ne doit
    // pas changer le type.
    await call('rename_variable', {
      sessionId,
      target: { scope: 'scene', scene: 'Niveau1' },
      name: 'Score',
      newName: 'ScoreTmp',
    });
    await call('rename_variable', {
      sessionId,
      target: { scope: 'scene', scene: 'Niveau1' },
      name: 'ScoreTmp',
      newName: 'Score',
    });
    described = (await call('describe_project', { sessionId })) as ProjectView;
    assert.strictEqual(typeof described.content.scenes[0]?.variables['Score'], 'number');
    assert.deepEqual(described.content.scenes[0]?.variables, { Score: 0 });
  });

  it('matrice types × scopes stricte, identique après save→reopen, forme disque typée', async () => {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    const deps = { store, engine };
    const tools = [...createProjectTools(deps), ...createContentTools(deps)];
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
      parseText(await handler(tools, name)(args));

    const created = (await call('create_project', { name: 'Typing' })) as { sessionId: string };
    const sessionId = created.sessionId;
    await call('create_scene', { sessionId, name: 'Niveau1' });
    await call('add_object', { sessionId, scene: 'Niveau1', type: 'Sprite', name: 'Joueur' });
    const placed = (await call('place_instance', {
      sessionId,
      scene: 'Niveau1',
      object: 'Joueur',
      x: 0,
      y: 0,
    })) as { instanceId: string };
    const instanceId = placed.instanceId;

    // 0 (number) n'est pas "0" (string) : les deux doivent survivre tels quels.
    const matrix: { name: string; value: unknown }[] = [
      { name: 'zero', value: 0 },
      { name: 'zeroString', value: '0' },
      { name: 'flag', value: true },
      { name: 'text', value: 'hello' },
      { name: 'nested', value: { hp: 3, tags: ['a', 1] } },
    ];
    for (const { name, value } of matrix) {
      await call('set_variable', { sessionId, target: { scope: 'global' }, name, value });
      await call('set_variable', { sessionId, target: { scope: 'scene', scene: 'Niveau1' }, name, value });
      await call('set_variable', {
        sessionId,
        target: { scope: 'object', scene: 'Niveau1', object: 'Joueur' },
        name,
        value,
      });
      await call('set_variable', {
        sessionId,
        target: { scope: 'instance', scene: 'Niveau1', instanceId },
        name,
        value,
      });
    }

    const expectMatrix = (view: ProjectView): void => {
      const expected: Record<string, unknown> = {
        zero: 0,
        zeroString: '0',
        flag: true,
        text: 'hello',
        nested: { hp: 3, tags: ['a', 1] },
      };
      assert.deepEqual(view.content.globalVariables, expected);
      assert.deepEqual(view.content.scenes[0]?.variables, expected);
      assert.deepEqual(view.content.scenes[0]?.objects[0]?.variables, expected);
      assert.deepEqual(view.content.scenes[0]?.instances[0]?.variables, expected);
      // Strict sur le cas du ticket, dans chaque scope.
      assert.strictEqual(typeof view.content.globalVariables['zero'], 'number');
      assert.strictEqual(typeof view.content.scenes[0]?.variables['zero'], 'number');
      assert.strictEqual(typeof view.content.scenes[0]?.variables['zeroString'], 'string');
      assert.strictEqual(typeof view.content.scenes[0]?.objects[0]?.variables['zero'], 'number');
      assert.strictEqual(typeof view.content.scenes[0]?.instances[0]?.variables['zero'], 'number');
    };

    expectMatrix((await call('describe_project', { sessionId })) as ProjectView);

    // Aller-retour disque au seam tools : save puis reopen dans un registre neuf.
    const dir = mkdtempSync(join(tmpdir(), 'gd-variable-typing-'));
    const file = join(dir, 'game.json');
    await call('save_project', { sessionId, path: file });
    const store2 = new ProjectStore(engine);
    const deps2 = { store: store2, engine };
    const tools2 = [...createProjectTools(deps2), ...createContentTools(deps2)];
    const call2 = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
      parseText(await handler(tools2, name)(args));
    const opened = (await call2('open_project', { path: file })) as { sessionId: string };
    expectMatrix((await call2('describe_project', { sessionId: opened.sessionId })) as ProjectView);

    // Forme disque : la donnée dont ModVarScene +1 a besoin en preview.
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      layouts?: { name?: unknown; variables?: { name?: unknown; type?: unknown; value?: unknown }[] }[];
    };
    const layout = (raw.layouts ?? []).find((candidate) => candidate.name === 'Niveau1');
    const score = (layout?.variables ?? []).find((candidate) => candidate.name === 'zero');
    assert.deepEqual(score, { name: 'zero', type: 'number', value: 0 });
  });
});
