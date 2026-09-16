import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/sessions.js';
import { createContentTools, createEventTools, createPreviewTools, createProjectTools, type ToolDefinition } from '../src/tools.js';
import { PreviewManager } from '../src/preview.js';
import { createFakeEngine } from './fakeEngine.js';

/**
 * Ticket #24 — Événements natifs + Sélecteur d'événement.
 * Parent #20 (Projet de validation collector), suite de #23.
 *
 * Même seam unique convenu (#20) : la surface MCP des tools uniquement
 * (`createPreviewTools` sert ici `render_scene_static`, pas
 * `build_preview` qui est #25). Le test recrée le pré-requis #22+#23
 * isolé (Session projet, Scene Niveau1, Calque HUD, 3 Objets, variables
 * Score et Config, Groupe d'objets Collectibles, 3 Instances) puis joue
 * le cycle #24 : validate sans mutation, append, describe, move et
 * remove par identifiant stable comme par chemin, rendu lisible après
 * chaque pas (y compris après le remove final).
 *
 * Le fake ne connaît que VarScene/ModVarScene (L1 refuse le reste, comme
 * MetadataProvider le ferait) : l'arbre ci-dessous couvre donc toutes
 * les structures (group, standard, else, repeat, while, foreach,
 * foreachChildVariable, comment, link) avec ces deux instructions. Les
 * instructions riches (clavier, CollisionNP/Collision, VarObjet, PosX/Y,
 * CompareNumbers/CompareStrings, CompareTimer, ModVarObjet, Delete,
 * Create, ResetTimer, Once) sont calibrées une par une au validate puis
 * prouvées en live MCP sur le vrai moteur. Insuffisances live à
 * reporter en #27 : namespace BuiltinCommonInstructions:: exigé pour
 * certaines instructions mais pas VarScene (L1 incohérent),
 * inverted:true relu false (NON logique non persisté), action texte
 * TextObject introuvable (SetText/SetString Unknown malgré l'objet
 * créé). Uniquement du natif, aucun JsCode (le refus du JsCode libre
 * est asserté, c'est la spec "pas de JS injecté").
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

interface SceneEventView {
  id: string;
  kind: string;
  events?: SceneEventView[] | undefined;
}

function structureTree(): unknown[] {
  return [
    {
      kind: 'group',
      name: 'Gameplay',
      events: [
        {
          kind: 'standard',
          conditions: [{ type: 'VarScene', parameters: ['Score', '=', '0'] }],
          actions: [{ type: 'ModVarScene', parameters: ['Score', '+', '1'] }],
          events: [{ kind: 'else', actions: [{ type: 'ModVarScene', parameters: ['Score', '=', '0'] }] }],
        },
        {
          kind: 'repeat',
          repeatExpression: '3',
          loopIndexVariable: 'i',
          conditions: [{ type: 'VarScene', parameters: ['Score', '>=', '0'] }],
          actions: [{ type: 'ModVarScene', parameters: ['Score', '+', '0'] }],
        },
        {
          kind: 'while',
          whileConditions: [{ type: 'VarScene', parameters: ['Score', '<=', '99'] }],
          actions: [{ type: 'ModVarScene', parameters: ['Score', '+', '0'] }],
        },
        {
          kind: 'foreach',
          object: 'Coin',
          conditions: [{ type: 'VarScene', parameters: ['Score', '>=', '0'] }],
          actions: [{ type: 'ModVarScene', parameters: ['Score', '+', '0'] }],
        },
        {
          kind: 'foreachChildVariable',
          iterableVariable: 'Config',
          keyIterator: 'k',
          valueIterator: 'v',
          actions: [{ type: 'ModVarScene', parameters: ['Score', '+', '0'] }],
        },
        { kind: 'comment', comment: "Pieces = +1 point, collision Groupe d'objets Collectibles" },
        { kind: 'link', target: 'External' },
      ],
    },
  ];
}

describe("validation #24 : Événements natifs + Sélecteur d'événement (seam tools MCP)", () => {
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

  async function makeSession(): Promise<{ call: (name: string, args: Record<string, unknown>) => Promise<unknown>; sessionId: string }> {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    const deps = { store, engine };
    const tools = [...createProjectTools(deps), ...createContentTools(deps), ...createEventTools(deps)];
    const tmpRoot = mkdtempSync(join(tmpdir(), 'gd-validation-24-'));
    dirs.push(tmpRoot);
    const manager = new PreviewManager(deps as never, { tmpRoot });
    managers.push(manager);
    const all = [...tools, ...createPreviewTools(manager)];
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
      parseText(await handler(all, name)(args));
    const created = (await call('create_project', { name: 'Validation-Mini-Collector' })) as { sessionId: string };
    const sessionId = created.sessionId;
    await call('create_scene', { sessionId, name: 'Niveau1' });
    await call('create_layer', { sessionId, scene: 'Niveau1', name: 'HUD' });
    await call('add_object', { sessionId, scene: 'Niveau1', type: 'Sprite', name: 'Player_TopDown' });
    await call('add_object', { sessionId, scene: 'Niveau1', type: 'Sprite', name: 'Coin' });
    await call('add_object', { sessionId, scene: 'Niveau1', type: 'TextObject::Text', name: 'ScoreText' });
    await call('set_variable', { sessionId, target: { scope: 'scene', scene: 'Niveau1' }, name: 'Score', value: 0 });
    await call('set_variable', {
      sessionId,
      target: { scope: 'scene', scene: 'Niveau1' },
      name: 'Config',
      value: { nom: 'Hero', vitesse: 1 },
    });
    await call('create_group', { sessionId, scene: 'Niveau1', name: 'Collectibles', objects: ['Coin'] });
    await call('place_instance', { sessionId, scene: 'Niveau1', object: 'Player_TopDown', x: 120, y: 220 });
    await call('place_instance', { sessionId, scene: 'Niveau1', object: 'Coin', x: 300, y: 200 });
    await call('place_instance', { sessionId, scene: 'Niveau1', object: 'Coin', x: 400, y: 300, layer: 'HUD' });
    return { call, sessionId };
  }

  it('validate sans mutation puis append : compte events coherent et rendu lisible', async () => {
    const { call, sessionId } = await makeSession();
    const validated = (await call('validate_scene_events', { sessionId, scene: 'Niveau1', events: structureTree() })) as {
      valid: boolean;
      errors: string[];
    };
    assert.equal(validated.valid, true);
    assert.deepEqual(validated.errors, []);
    const before = (await call('describe_project', { sessionId })) as { eventCount: number };
    assert.equal(before.eventCount, 0);

    const appended = (await call('append_scene_events', { sessionId, scene: 'Niveau1', events: structureTree() })) as {
      appended: number;
      ids: string[];
    };
    assert.equal(appended.appended, 1);
    assert.ok(appended.ids.length >= 8);
    for (const id of appended.ids) assert.match(id, /^[0-9a-f-]{36}$/);

    const after = (await call('describe_project', { sessionId })) as {
      eventCount: number;
      content: { scenes: { events: SceneEventView[] }[] };
    };
    assert.equal(after.eventCount, 1);
    assert.equal(after.content.scenes[0]?.events.length, 1);
    assert.equal(after.content.scenes[0]?.events[0]?.kind, 'group');
    assert.equal(after.content.scenes[0]?.events[0]?.events?.length, 7);

    const rendered = (await call('render_scene_static', { sessionId, scene: 'Niveau1' })) as {
      scene: string;
      svg: string;
      instanceCount: number;
    };
    assert.equal(rendered.scene, 'Niveau1');
    assert.match(rendered.svg, /Niveau1 \(3\)/);
    assert.equal(rendered.instanceCount, 3);
  });

  it('refuse proprement un type inconnu (L1) et un JsCode sans marqueur', async () => {
    const { call, sessionId } = await makeSession();
    const unknown = (await call('validate_scene_events', {
      sessionId,
      scene: 'Niveau1',
      events: [{ kind: 'standard', actions: [{ type: 'NopeNope', parameters: [] }] }],
    })) as { valid: boolean; errors: string[] };
    assert.equal(unknown.valid, false);
    assert.match(unknown.errors.join('; '), /L1/);
    const freeJs = call('validate_scene_events', {
      sessionId,
      scene: 'Niveau1',
      events: [{ kind: 'jscode', inlineCode: 'alert(1)' }],
    });
    await assert.rejects(freeJs, /marker|JsCode/);
    const after = (await call('describe_project', { sessionId })) as { eventCount: number };
    assert.equal(after.eventCount, 0);
  });

  it('move et remove par identifiant stable comme par chemin sur deux événements natifs dummy', async () => {
    const { call, sessionId } = await makeSession();
    await call('append_scene_events', { sessionId, scene: 'Niveau1', events: structureTree() });
    const dummyA = (await call('append_scene_events', {
      sessionId,
      scene: 'Niveau1',
      events: [{ kind: 'comment', comment: 'Dummy selecteur A' }],
    })) as { appended: number; ids: string[] };
    const dummyB = (await call('append_scene_events', {
      sessionId,
      scene: 'Niveau1',
      events: [{ kind: 'comment', comment: 'Dummy selecteur B' }],
    })) as { appended: number; ids: string[] };
    const dummyAId = dummyA.ids[0] as string;
    const dummyBId = dummyB.ids[0] as string;

    let described = (await call('describe_project', { sessionId })) as {
      eventCount: number;
      content: { scenes: { events: SceneEventView[] }[] };
    };
    assert.equal(described.eventCount, 3);

    // Move par identifiant stable : B en tête.
    const movedById = (await call('move_scene_event', {
      sessionId,
      scene: 'Niveau1',
      from: { id: dummyBId },
      toPosition: 0,
    })) as { moved: boolean };
    assert.equal(movedById.moved, true);
    described = (await call('describe_project', { sessionId })) as typeof described;
    assert.equal(described.content.scenes[0]?.events[0]?.id, dummyBId);

    // Move par chemin : A (en [2]) en position 1.
    const movedByPath = (await call('move_scene_event', {
      sessionId,
      scene: 'Niveau1',
      from: { path: [2] },
      toPosition: 1,
    })) as { moved: boolean };
    assert.equal(movedByPath.moved, true);
    described = (await call('describe_project', { sessionId })) as typeof described;
    assert.equal(described.content.scenes[0]?.events[0]?.id, dummyBId);
    assert.equal(described.content.scenes[0]?.events[1]?.id, dummyAId);
    assert.equal(described.content.scenes[0]?.events[2]?.kind, 'group');

    const rendered = (await call('render_scene_static', { sessionId, scene: 'Niveau1' })) as { svg: string };
    assert.match(rendered.svg, /<svg/);

    // Remove par chemin : B (en [0]).
    const removedByPath = (await call('remove_scene_event', {
      sessionId,
      scene: 'Niveau1',
      target: { path: [0] },
    })) as { removed: boolean };
    assert.equal(removedByPath.removed, true);
    described = (await call('describe_project', { sessionId })) as typeof described;
    assert.equal(described.eventCount, 2);

    // Remove par identifiant stable : A. Le gameplay survit intact.
    const removedById = (await call('remove_scene_event', {
      sessionId,
      scene: 'Niveau1',
      target: { id: dummyAId },
    })) as { removed: boolean };
    assert.equal(removedById.removed, true);
    described = (await call('describe_project', { sessionId })) as typeof described;
    assert.equal(described.eventCount, 1);
    assert.equal(described.content.scenes[0]?.events.length, 1);
    assert.equal(described.content.scenes[0]?.events[0]?.kind, 'group');
    assert.equal(described.content.scenes[0]?.events[0]?.events?.length, 7);

    const finalRender = (await call('render_scene_static', { sessionId, scene: 'Niveau1' })) as {
      scene: string;
      svg: string;
    };
    assert.equal(finalRender.scene, 'Niveau1');
    assert.match(finalRender.svg, /Niveau1 \(3\)/);
  });
});
