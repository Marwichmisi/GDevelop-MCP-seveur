import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/sessions.js';
import { createContentTools, createEventTools, createPreviewTools, createProjectTools, type ToolDefinition } from '../src/tools.js';
import {
  PreviewManager,
  sanitizeDracoScriptIncludes,
  type PreviewBrowser,
  type PreviewExporter,
} from '../src/preview.js';
import type { EngineProject } from '../src/engine.js';
import { createFakeEngine } from './fakeEngine.js';

/**
 * Ticket #25 — Preview jouable + persistance atomique.
 * Parent #20 (Projet de validation collector), suite de #24.
 *
 * Même seam unique convenu (#20) : la surface MCP des tools uniquement.
 * Le PreviewManager est branché sur ses seams publics (exporter qui
 * écrit index.html + sanitize Draco, browser qui capture logs et page
 * errors) ; aucun navigateur réel, voie rapide sans screenshot (#25
 * n'en exige pas, #20 le réserve à la fin car lent et optionnel). Le
 * loopback réel et l'export GDJS sont prouvés en live MCP (url
 * 127.0.0.1, logs d'export, 0 page error). Le test rejoue le cycle #25
 * isolé en un seul `it` narratif (comme #22/#23) : rendu final lisible,
 * premier save (il faut un fichier existant pour prouver ensuite le
 * non-touché : le build throwrait sinon), build loopback sans toucher
 * le fichier, statut avec url/scene/logs, second save (il prouve le
 * Backup et prépare la copie pre-restore du scénario undo #26), reopen
 * dans un nouveau registre et identité mémoire/disque jusque aux
 * identifiants stables, sans fuite de handles (l'ancienne Session
 * reste ouverte et décrit le même contenu, preuve via describe).
 *
 * Le chemin dédié validation-mini-collector/game.json est prouvé en
 * live ; le test écrit dans un tmp isolé pour ne jamais salir le repo.
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

class StubExporter implements PreviewExporter {
  async exportProject(_project: EngineProject, outDir: string, sceneName: string): Promise<{ sanitizedDraco: boolean }> {
    const { writeFile } = await import('node:fs/promises');
    const raw = `<html><head><script src="draco_decoder.wasm.js"></script></head><body>${sceneName}</body></html>`;
    const { html, sanitized } = sanitizeDracoScriptIncludes(raw);
    await writeFile(join(outDir, 'index.html'), html, 'utf8');
    return { sanitizedDraco: sanitized };
  }
}

class FakeBrowser implements PreviewBrowser {
  async capture(): Promise<{ logs: string[]; pageErrors: string[]; screenshotPath: string | null }> {
    return { logs: ['[log] booted'], pageErrors: [], screenshotPath: null };
  }
}

describe('validation #25 : Preview jouable + persistance atomique (seam tools MCP)', () => {
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

  it('render final, build loopback sans toucher le fichier, statut, double save avec Backup, reopen identique', async () => {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    const deps = { store, engine };
    const tmpRoot = mkdtempSync(join(tmpdir(), 'gd-validation-25-'));
    dirs.push(tmpRoot);
    const manager = new PreviewManager(deps as never, { tmpRoot, exporter: new StubExporter(), browser: new FakeBrowser() });
    managers.push(manager);
    const tools = [
      ...createProjectTools(deps),
      ...createContentTools(deps),
      ...createEventTools(deps),
      ...createPreviewTools(manager),
    ];
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
      parseText(await handler(tools, name)(args));

    // Pré-requis #22+#23+#24 isolé.
    const created = (await call('create_project', { name: 'Validation-Mini-Collector' })) as { sessionId: string };
    const sessionId = created.sessionId;
    await call('create_scene', { sessionId, name: 'Niveau1' });
    await call('create_layer', { sessionId, scene: 'Niveau1', name: 'HUD' });
    await call('add_object', {
      sessionId,
      scene: 'Niveau1',
      type: 'Sprite',
      name: 'Player_TopDown',
      variables: { Vie: 3 },
    });
    await call('add_object', { sessionId, scene: 'Niveau1', type: 'Sprite', name: 'Coin' });
    await call('add_object', { sessionId, scene: 'Niveau1', type: 'TextObject::Text', name: 'ScoreText' });
    await call('set_variable', { sessionId, target: { scope: 'scene', scene: 'Niveau1' }, name: 'Score', value: 0 });
    await call('create_group', { sessionId, scene: 'Niveau1', name: 'Collectibles', objects: ['Coin'] });
    await call('place_instance', { sessionId, scene: 'Niveau1', object: 'Player_TopDown', x: 120, y: 220 });
    await call('place_instance', { sessionId, scene: 'Niveau1', object: 'Coin', x: 300, y: 200 });
    await call('place_instance', { sessionId, scene: 'Niveau1', object: 'Coin', x: 400, y: 300, layer: 'HUD' });
    await call('append_scene_events', {
      sessionId,
      scene: 'Niveau1',
      events: [
        {
          kind: 'standard',
          conditions: [{ type: 'VarScene', parameters: ['Score', '=', '0'] }],
          actions: [{ type: 'ModVarScene', parameters: ['Score', '+', '1'] }],
        },
      ],
    });

    // 1. Rendu final lisible.
    const rendered = (await call('render_scene_static', { sessionId, scene: 'Niveau1' })) as {
      scene: string;
      svg: string;
      objectCount: number;
      instanceCount: number;
    };
    assert.equal(rendered.scene, 'Niveau1');
    assert.match(rendered.svg, /Niveau1 \(3\)/);
    assert.equal(rendered.objectCount, 3);
    assert.equal(rendered.instanceCount, 3);

    // 2. Premier save (pas encore de Backup), puis build : le fichier ne bouge pas.
    const projectDir = mkdtempSync(join(tmpdir(), 'gd-validation-25-proj-'));
    dirs.push(projectDir);
    const file = join(projectDir, 'game.json');
    const firstSave = (await call('save_project', { sessionId, path: file })) as {
      path: string;
      backupPath: string | null;
      bytes: number;
    };
    assert.equal(firstSave.path, file);
    assert.equal(firstSave.backupPath, null);
    assert.ok(firstSave.bytes > 0);
    let described = (await call('describe_project', { sessionId })) as { dirty: boolean };
    assert.equal(described.dirty, false);
    const contentBefore = readFileSync(file, 'utf8');

    const built = (await call('build_preview', { sessionId, scene: 'Niveau1' })) as {
      previewId: string;
      url: string;
      scene: string;
      logs: string[];
      pageErrors: string[];
    };
    assert.match(built.previewId, /^[0-9a-f-]{36}$/);
    assert.match(built.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(built.scene, 'Niveau1');
    assert.ok(built.logs.some((line) => line.startsWith('[export]')));
    assert.deepEqual(built.pageErrors, []);
    // Preuve externe : le contenu disque est inchangé (le manager aurait
    // refusé en preview-export-failed sinon).
    assert.equal(readFileSync(file, 'utf8'), contentBefore);

    // 3. Statut : url, scene, logs, sans erreur bloquante.
    const status = (await call('get_preview_status', {})) as {
      previewId: string;
      url: string;
      scene: string;
      logs: string[];
      pageErrors: string[];
    };
    assert.equal(status.previewId, built.previewId);
    assert.equal(status.url, built.url);
    assert.equal(status.scene, 'Niveau1');
    assert.ok(status.logs.length > 0);
    assert.deepEqual(status.pageErrors, []);

    // 4. Second save : Backup prouvé, toujours dirty faux.
    const secondSave = (await call('save_project', { sessionId, path: file })) as {
      path: string;
      backupPath: string | null;
      preRestorePath: string | null;
    };
    assert.equal(secondSave.path, file);
    assert.ok(secondSave.backupPath !== null);
    assert.ok(secondSave.preRestorePath !== null);
    described = (await call('describe_project', { sessionId })) as { dirty: boolean };
    assert.equal(described.dirty, false);

    // 5. Reopen dans un nouveau registre : identité mémoire/disque, sans fuite.
    const store2 = new ProjectStore(engine);
    const deps2 = { store: store2, engine };
    const tools2 = createProjectTools(deps2);
    const call2 = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
      parseText(await handler(tools2, name)(args));
    const opened = (await call2('open_project', { path: file })) as { sessionId: string; path: string };
    assert.equal(opened.path, file);
    assert.notEqual(opened.sessionId, sessionId);
    const memory = (await call('describe_project', { sessionId })) as {
      name: string;
      layoutCount: number;
      objectCount: number;
      behaviorCount: number;
      eventCount: number;
      dirty: boolean;
      content: {
        scenes: {
          layers: string[];
          instances: { id: string }[];
          events: { id: string }[];
          variables: Record<string, unknown>;
        }[];
        globalVariables: Record<string, unknown>;
      };
    };
    const reloaded = (await call2('describe_project', { sessionId: opened.sessionId })) as typeof memory;
    assert.equal(reloaded.name, memory.name);
    assert.equal(reloaded.layoutCount, memory.layoutCount);
    assert.equal(reloaded.objectCount, memory.objectCount);
    assert.equal(reloaded.behaviorCount, memory.behaviorCount);
    assert.equal(reloaded.eventCount, memory.eventCount);
    assert.deepEqual(reloaded.content.scenes, memory.content.scenes);
    // Identique en tout, jusque aux identifiants stables.
    assert.deepEqual(
      reloaded.content.scenes[0]?.instances.map((instance) => instance.id),
      memory.content.scenes[0]?.instances.map((instance) => instance.id),
    );
    assert.equal(reloaded.content.scenes[0]?.events[0]?.id, memory.content.scenes[0]?.events[0]?.id);
    assert.deepEqual(reloaded.content.scenes[0]?.layers, memory.content.scenes[0]?.layers);
    assert.deepEqual(reloaded.content.scenes[0]?.variables, memory.content.scenes[0]?.variables);
    assert.deepEqual(reloaded.content.globalVariables, memory.content.globalVariables);
    assert.equal(reloaded.dirty, false);
    // Sans fuite de handles : l'ancienne Session projet répond toujours
    // et décrit le même contenu (preuve au seam, via describe).
    const sanityCheck = (await call('describe_project', { sessionId })) as { layoutCount: number; dirty: boolean };
    assert.equal(sanityCheck.layoutCount, 1);
    assert.equal(sanityCheck.dirty, false);
  });
});
