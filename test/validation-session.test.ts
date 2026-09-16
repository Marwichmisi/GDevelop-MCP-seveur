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
 * Ticket #22 — Session projet + Scene Niveau1 + Calque HUD.
 * Parent #20 (Projet de validation collector), suite de #21.
 *
 * Seam unique convenu (#20) : la surface MCP des tools uniquement
 * (projet, contenu, preview statique). Aucun appel direct aux couches
 * internes, sinon le câblage zod et l'enregistrement des tools ne
 * seraient pas prouvés. Preuve externe via describe + rendu statique,
 * jamais de lecture JSON à l'aveugle. Vocabulaire CONTEXT.md respecté :
 * Session projet, Objet, Instance, Événement natif, Preview, Couverture.
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

describe('validation #22 : Session projet + Scene Niveau1 + Calque HUD (seam tools MCP)', () => {
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

  it('create_project + describe cohérent, cycle scene Niveau1, cycle calque HUD, rendu lisible après chaque mutation', async () => {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    const deps = { store, engine };
    const projectTools = createProjectTools(deps);
    const contentTools = createContentTools(deps);
    const tmpRoot = mkdtempSync(join(tmpdir(), 'gd-validation-22-'));
    dirs.push(tmpRoot);
    const manager = new PreviewManager(deps as never, { tmpRoot });
    managers.push(manager);
    const previewTools = createPreviewTools(manager);
    const all = [...projectTools, ...contentTools, ...previewTools];
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
      parseText(await handler(all, name)(args));

    // 1. Session projet isolée.
    const created = (await call('create_project', { name: 'Validation-Mini-Collector' })) as { sessionId: string; name: string };
    assert.match(created.sessionId, /^[0-9a-f-]{36}$/);
    const sessionId = created.sessionId;
    assert.equal(created.name, 'Validation-Mini-Collector');

    const describedEmpty = (await call('describe_project', { sessionId })) as {
      name: string;
      layoutCount: number;
      dirty: boolean;
      content: { scenes: unknown[] };
    };
    assert.equal(describedEmpty.name, 'Validation-Mini-Collector');
    assert.equal(describedEmpty.layoutCount, 0);
    assert.equal(describedEmpty.dirty, false);
    assert.deepEqual(describedEmpty.content.scenes, []);
    // Gate preuve #20 : pas de diagnostic bloquant = describe cohérent +
    // mutations acceptées par le pipeline (refus en validation-failed sinon).
    // Pas d'appel interne listDiagnostics : seule la surface tools tranche.

    // 2. Scene Niveau1 : création + preuve.
    await call('create_scene', { sessionId, name: 'Niveau1' });
    let described = (await call('describe_project', { sessionId })) as {
      layoutCount: number;
      dirty: boolean;
      content: { scenes: { name: string; layers: string[] }[] };
    };
    assert.equal(described.layoutCount, 1);
    assert.equal(described.content.scenes[0]?.name, 'Niveau1');
    assert.equal(described.dirty, true);
    let rendered = (await call('render_scene_static', { sessionId, scene: 'Niveau1' })) as {
      scene: string;
      svg: string;
      layers: string[];
      objectCount: number;
      instanceCount: number;
    };
    assert.equal(rendered.scene, 'Niveau1');
    assert.match(rendered.svg, /<svg/);
    assert.match(rendered.svg, /Niveau1/);
    assert.deepEqual(rendered.layers, ['']);

    // 3. Cycle rename_scene (aller-retour pour garder Niveau1 en final).
    await call('rename_scene', { sessionId, name: 'Niveau1', newName: 'Niveau1Tmp' });
    described = (await call('describe_project', { sessionId })) as typeof described;
    assert.equal(described.content.scenes[0]?.name, 'Niveau1Tmp');
    rendered = (await call('render_scene_static', { sessionId, scene: 'Niveau1Tmp' })) as typeof rendered;
    assert.equal(rendered.scene, 'Niveau1Tmp');
    assert.match(rendered.svg, /Niveau1Tmp/);
    await call('rename_scene', { sessionId, name: 'Niveau1Tmp', newName: 'Niveau1' });
    described = (await call('describe_project', { sessionId })) as typeof described;
    assert.equal(described.content.scenes[0]?.name, 'Niveau1');
    rendered = (await call('render_scene_static', { sessionId })) as typeof rendered;
    assert.equal(rendered.scene, 'Niveau1');

    // 4. Cycle move_scene (position clampée, une seule scène : reste stable).
    await call('move_scene', { sessionId, name: 'Niveau1', position: 0 });
    described = (await call('describe_project', { sessionId })) as typeof described;
    assert.equal(described.content.scenes[0]?.name, 'Niveau1');
    await call('move_scene', { sessionId, name: 'Niveau1', position: 99 });
    described = (await call('describe_project', { sessionId })) as typeof described;
    assert.equal(described.content.scenes[0]?.name, 'Niveau1');
    rendered = (await call('render_scene_static', { sessionId, scene: 'Niveau1' })) as typeof rendered;
    assert.match(rendered.svg, /<svg/);

    // 5. Calque HUD : création + preuve.
    await call('create_layer', { sessionId, scene: 'Niveau1', name: 'HUD' });
    described = (await call('describe_project', { sessionId })) as typeof described;
    assert.deepEqual(described.content.scenes[0]?.layers, ['', 'HUD']);
    rendered = (await call('render_scene_static', { sessionId, scene: 'Niveau1' })) as typeof rendered;
    assert.deepEqual(rendered.layers, ['', 'HUD']);
    assert.match(rendered.svg, /Niveau1/);

    // 6. Cycle rename_layer (aller-retour pour garder HUD en final).
    await call('rename_layer', { sessionId, scene: 'Niveau1', name: 'HUD', newName: 'HUDTmp' });
    described = (await call('describe_project', { sessionId })) as typeof described;
    assert.deepEqual(described.content.scenes[0]?.layers, ['', 'HUDTmp']);
    rendered = (await call('render_scene_static', { sessionId, scene: 'Niveau1' })) as typeof rendered;
    assert.deepEqual(rendered.layers, ['', 'HUDTmp']);
    await call('rename_layer', { sessionId, scene: 'Niveau1', name: 'HUDTmp', newName: 'HUD' });
    described = (await call('describe_project', { sessionId })) as typeof described;
    assert.deepEqual(described.content.scenes[0]?.layers, ['', 'HUD']);
    // Rendu manquant relevé en revue Spec : preuve lisible aussi sur le retour.
    rendered = (await call('render_scene_static', { sessionId, scene: 'Niveau1' })) as typeof rendered;
    assert.deepEqual(rendered.layers, ['', 'HUD']);
    assert.match(rendered.svg, /Niveau1/);

    // 7. Cycle move_layer (aller-retour, final ['', 'HUD'] pour la suite #23).
    await call('move_layer', { sessionId, scene: 'Niveau1', name: 'HUD', position: 0 });
    described = (await call('describe_project', { sessionId })) as typeof described;
    assert.deepEqual(described.content.scenes[0]?.layers, ['HUD', '']);
    rendered = (await call('render_scene_static', { sessionId, scene: 'Niveau1' })) as typeof rendered;
    assert.deepEqual(rendered.layers, ['HUD', '']);
    await call('move_layer', { sessionId, scene: 'Niveau1', name: 'HUD', position: 1 });
    described = (await call('describe_project', { sessionId })) as typeof described;
    assert.deepEqual(described.content.scenes[0]?.layers, ['', 'HUD']);
    rendered = (await call('render_scene_static', { sessionId, scene: 'Niveau1' })) as typeof rendered;
    assert.deepEqual(rendered.layers, ['', 'HUD']);
    assert.equal(rendered.objectCount, 0);
    assert.equal(rendered.instanceCount, 0);

    // 8. État final cohérent sans diagnostic bloquant (gate preuve #20).
    // Calque Base = "" (moteur) : l'état ['', 'HUD'] couvre "Base et HUD" de la spec.
    const final = (await call('describe_project', { sessionId })) as {
      name: string;
      layoutCount: number;
      objectCount: number;
      eventCount: number;
      dirty: boolean;
      content: { scenes: { name: string; layers: string[] }[] };
    };
    assert.equal(final.name, 'Validation-Mini-Collector');
    assert.equal(final.layoutCount, 1);
    assert.equal(final.objectCount, 0);
    assert.equal(final.eventCount, 0);
    assert.equal(final.content.scenes[0]?.name, 'Niveau1');
    assert.deepEqual(final.content.scenes[0]?.layers, ['', 'HUD']);
    assert.equal(final.dirty, true);
    // Même gate qu'en (1) : cohérence describe + pipeline, sans interne.
  });
});
