import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/sessions.js';
import { createContentTools, createPreviewTools, createProjectTools, type ToolDefinition } from '../src/tools.js';
import { PreviewManager } from '../src/preview.js';
import { createFakeEngine } from './fakeEngine.js';

/**
 * Ticket #23 — Objets + Comportement + Variables + Groupe d'objets + Instances.
 * Parent #20 (Projet de validation collector), suite de #22.
 *
 * Même seam unique convenu (#20) que #22 : la surface MCP des tools
 * uniquement (`createPreviewTools` sert ici `render_scene_static`, pas
 * `build_preview` qui est #25). Le test recrée le pré-requis #22 (Session
 * projet, Scene Niveau1, Calque HUD) pour rester isolé, puis joue le
 * cycle #23. Types figés par la spec : Player_TopDown + Coin (Sprite),
 * ScoreText (TextObject::Text — absent du Catalogue pinné, le moteur
 * tranche à l'écriture en live MCP ; Insuffisance à logger pour #27),
 * comportement TopDownMovementBehavior::TopDownMovementBehavior, Groupe
 * d'objets Collectibles, variables Score (Scene Niveau1) et Vie (Objet
 * Player_TopDown). Preuve externe via describe + rendu statique.
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

describe("validation #23 : Objets + Comportement + Variables + Groupe d'objets + Instances (seam tools MCP)", () => {
  let dirs: string[] = [];
  let managers: PreviewManager[] = [];

  beforeEach(() => {
    dirs = [];
    managers = [];
  });

  afterEach(async () => {
    for (const manager of managers) await manager.closeAll().catch(() => undefined);
    const { rm } = await import('node:fs/promises');
    for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('Player_TopDown + Coin + ScoreText, TopDown, Score/Vie, Collectibles, Instances posées et patchées', async () => {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    const deps = { store, engine };
    const all = [...createProjectTools(deps), ...createContentTools(deps)];
    const tmpRoot = mkdtempSync(join(tmpdir(), 'gd-validation-23-'));
    dirs.push(tmpRoot);
    const manager = new PreviewManager(deps as never, { tmpRoot });
    managers.push(manager);
    const withPreview = [...all, ...createPreviewTools(manager)];
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
      parseText(await handler(withPreview, name)(args));

    // Pré-requis #22 isolé dans ce test.
    const created = (await call('create_project', { name: 'Validation-Mini-Collector' })) as { sessionId: string };
    const sessionId = created.sessionId;
    await call('create_scene', { sessionId, name: 'Niveau1' });
    await call('create_layer', { sessionId, scene: 'Niveau1', name: 'HUD' });

    // 1. Trois Objets natifs avec variables initiales.
    await call('add_object', {
      sessionId,
      scene: 'Niveau1',
      type: 'Sprite',
      name: 'Player_TopDown',
      variables: { Vie: 3 },
    });
    await call('add_object', { sessionId, scene: 'Niveau1', type: 'Sprite', name: 'Coin' });
    await call('add_object', { sessionId, scene: 'Niveau1', type: 'TextObject::Text', name: 'ScoreText' });
    let rendered = (await call('render_scene_static', { sessionId, scene: 'Niveau1' })) as {
      scene: string;
      svg: string;
      objectCount: number;
      instanceCount: number;
    };
    assert.equal(rendered.scene, 'Niveau1');
    assert.match(rendered.svg, /<svg/);
    assert.equal(rendered.objectCount, 3);

    // 2. Comportement TopDown : attach puis update.
    const attached = (await call('attach_behavior', {
      sessionId,
      scene: 'Niveau1',
      object: 'Player_TopDown',
      type: 'TopDownMovementBehavior::TopDownMovementBehavior',
    })) as { name: string };
    assert.ok(attached.name.length > 0);
    await call('update_behavior', {
      sessionId,
      scene: 'Niveau1',
      object: 'Player_TopDown',
      name: attached.name,
      properties: { MaxSpeed: 250 },
    });
    const afterBehavior = (await call('describe_project', { sessionId })) as {
      behaviorCount: number;
      content: {
        scenes: { objects: { name: string; behaviors: { name: string; properties: Record<string, unknown> }[] }[] }[];
      };
    };
    assert.equal(afterBehavior.behaviorCount, 1);
    assert.equal(afterBehavior.content.scenes[0]?.objects[0]?.name, 'Player_TopDown');
    assert.equal(afterBehavior.content.scenes[0]?.objects[0]?.behaviors[0]?.name, attached.name);
    assert.equal(afterBehavior.content.scenes[0]?.objects[0]?.behaviors[0]?.properties['maxSpeed'], 250);
    rendered = (await call('render_scene_static', { sessionId, scene: 'Niveau1' })) as typeof rendered;
    assert.match(rendered.svg, /Niveau1/);

    // 3. Variables : Score en Scene (rename aller-retour), Vie en Objet
    // via set_variable, rename + remove sur une même variable de test.
    await call('set_variable', { sessionId, target: { scope: 'scene', scene: 'Niveau1' }, name: 'Score', value: 0 });
    await call('set_variable', {
      sessionId,
      target: { scope: 'object', scene: 'Niveau1', object: 'Player_TopDown' },
      name: 'Vie',
      value: 3,
    });
    await call('rename_variable', {
      sessionId,
      target: { scope: 'scene', scene: 'Niveau1' },
      name: 'Score',
      newName: 'ScoreTmp',
    });
    const afterRename = (await call('describe_project', { sessionId })) as {
      content: { scenes: { variables: Record<string, unknown> }[] };
    };
    assert.deepEqual(afterRename.content.scenes[0]?.variables, { ScoreTmp: 0 });
    await call('rename_variable', {
      sessionId,
      target: { scope: 'scene', scene: 'Niveau1' },
      name: 'ScoreTmp',
      newName: 'Score',
    });
    await call('set_variable', { sessionId, target: { scope: 'scene', scene: 'Niveau1' }, name: 'Temp', value: 1 });
    await call('rename_variable', {
      sessionId,
      target: { scope: 'scene', scene: 'Niveau1' },
      name: 'Temp',
      newName: 'TempTmp',
    });
    const afterTempRename = (await call('describe_project', { sessionId })) as {
      content: { scenes: { variables: Record<string, unknown> }[] };
    };
    assert.deepEqual(afterTempRename.content.scenes[0]?.variables, { Score: 0, TempTmp: 1 });
    await call('remove_variable', { sessionId, target: { scope: 'scene', scene: 'Niveau1' }, name: 'TempTmp' });
    const afterVariables = (await call('describe_project', { sessionId })) as {
      content: {
        scenes: { variables: Record<string, unknown>; objects: { variables: Record<string, unknown> }[] }[];
      };
    };
    assert.deepEqual(afterVariables.content.scenes[0]?.variables, { Score: 0 });
    assert.deepEqual(afterVariables.content.scenes[0]?.objects[0]?.variables, { Vie: 3 });
    rendered = (await call('render_scene_static', { sessionId, scene: 'Niveau1' })) as typeof rendered;
    assert.match(rendered.svg, /<svg/);

    // 4. Groupe d'objets Collectibles + Coin dedans.
    await call('create_group', { sessionId, scene: 'Niveau1', name: 'Collectibles' });
    await call('add_to_group', { sessionId, scene: 'Niveau1', group: 'Collectibles', object: 'Coin' });
    const afterGroup = (await call('describe_project', { sessionId })) as {
      content: { scenes: { groups: { name: string; objects: string[] }[] }[] };
    };
    assert.deepEqual(afterGroup.content.scenes[0]?.groups, [{ name: 'Collectibles', objects: ['Coin'] }]);
    rendered = (await call('render_scene_static', { sessionId, scene: 'Niveau1' })) as typeof rendered;
    assert.match(rendered.svg, /Niveau1/);

    // 5. Instances posées puis patchées.
    const player = (await call('place_instance', {
      sessionId,
      scene: 'Niveau1',
      object: 'Player_TopDown',
      x: 100,
      y: 200,
    })) as { instanceId: string };
    assert.match(player.instanceId, /^[0-9a-f-]{36}$/);
    await call('place_instance', { sessionId, scene: 'Niveau1', object: 'Coin', x: 300, y: 200 });
    await call('place_instance', { sessionId, scene: 'Niveau1', object: 'Coin', x: 400, y: 300, layer: 'HUD' });
    await call('update_instance', { sessionId, scene: 'Niveau1', instanceId: player.instanceId, x: 120, y: 220 });
    rendered = (await call('render_scene_static', { sessionId, scene: 'Niveau1' })) as typeof rendered;
    assert.equal(rendered.instanceCount, 3);
    assert.equal(rendered.objectCount, 3);
    assert.match(rendered.svg, /Niveau1 \(3\)/);
    assert.match(rendered.svg, /Player_TopDown/);
    assert.match(rendered.svg, /Coin/);

    // 6. État final cohérent (Score + Collectibles + joueur prêts pour les Événements natifs).
    // Calque Base = "" (moteur) : l'état ['', 'HUD'] couvre "Base et HUD" de la spec.
    const final = (await call('describe_project', { sessionId })) as {
      layoutCount: number;
      objectCount: number;
      behaviorCount: number;
      dirty: boolean;
      content: {
        scenes: {
          name: string;
          layers: string[];
          objects: { name: string; variables: Record<string, unknown> }[];
          instances: { object: string; x: number; y: number }[];
          variables: Record<string, unknown>;
          groups: { name: string; objects: string[] }[];
        }[];
      };
    };
    assert.equal(final.layoutCount, 1);
    assert.equal(final.objectCount, 3);
    assert.equal(final.behaviorCount, 1);
    assert.deepEqual(
      final.content.scenes[0]?.objects.map((object) => object.name),
      ['Player_TopDown', 'Coin', 'ScoreText'],
    );
    assert.deepEqual(final.content.scenes[0]?.variables, { Score: 0 });
    assert.deepEqual(final.content.scenes[0]?.objects[0]?.variables, { Vie: 3 });
    assert.deepEqual(final.content.scenes[0]?.layers, ['', 'HUD']);
    assert.deepEqual(final.content.scenes[0]?.groups, [{ name: 'Collectibles', objects: ['Coin'] }]);
    assert.equal(final.content.scenes[0]?.instances.length, 3);
    assert.equal(final.content.scenes[0]?.instances[0]?.object, 'Player_TopDown');
    assert.equal(final.content.scenes[0]?.instances[0]?.x, 120);
    assert.equal(final.content.scenes[0]?.instances[0]?.y, 220);
    assert.equal(final.dirty, true);
  });
});
