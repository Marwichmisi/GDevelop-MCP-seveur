import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
 * Ticket #26 — Transaction tout-ou-rien + Snapshot + Backup + fin de Session
 * (titre ticket : "Batch + rollback + destructeurs + fin de vie", Phase B).
 * Parent #20 (Projet de validation collector), suite de #25.
 *
 * Même seam unique convenu (#20) : la surface MCP des tools uniquement ;
 * le PreviewManager est branché sur ses seams publics (exporter factice,
 * browser factice, voie rapide sans screenshot) et l'injection de
 * diagnostic passe par l'état du faux moteur (même pattern que
 * undo.test.ts, seul écart au seam, réservé au gate baseline
 * improuvable autrement), jamais par les couches internes. Chaque `it`
 * recrée son pré-requis isolé (Session projet, Scene Niveau1, Calque
 * HUD, Objets Player_TopDown + Coin, Groupe d'objets Collectibles,
 * Instances) puis joue sa tranche : Ops de contenu atomiques,
 * scénario rollback avec gate baseline, renommages, déplacements et
 * suppressions avec refus garde-fou, ressources locales, fermeture
 * (Previews puis Session). Vocabulaire CONTEXT.md : "mutation cassée"
 * = mutation valide à annuler (une mutation invalide ne s'appliquerait
 * jamais et l'undo n'aurait rien à restaurer).
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

describe('validation #26 : Transaction + Snapshot + Backup + fin de Session (seam tools MCP)', () => {
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

  interface Harness {
    call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    sessionId: string;
    file: string;
  }

  async function makeSession(): Promise<Harness> {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    const deps = { store, engine };
    const tmpRoot = mkdtempSync(join(tmpdir(), 'gd-validation-26-'));
    dirs.push(tmpRoot);
    const manager = new PreviewManager({ ...deps, previews: undefined } as never, {
      tmpRoot,
      exporter: new StubExporter(),
      browser: new FakeBrowser(),
    });
    (deps as { previews?: PreviewManager }).previews = manager;
    managers.push(manager);
    const tools = [
      ...createProjectTools(deps),
      ...createContentTools(deps),
      ...createEventTools(deps),
      ...createPreviewTools(manager),
    ];
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
      parseText(await handler(tools, name)(args));
    const created = (await call('create_project', { name: 'Validation-Mini-Collector' })) as { sessionId: string };
    const sessionId = created.sessionId;
    await call('create_scene', { sessionId, name: 'Niveau1' });
    await call('create_layer', { sessionId, scene: 'Niveau1', name: 'HUD' });
    await call('add_object', { sessionId, scene: 'Niveau1', type: 'Sprite', name: 'Player_TopDown' });
    await call('attach_behavior', {
      sessionId,
      scene: 'Niveau1',
      object: 'Player_TopDown',
      type: 'TopDownMovementBehavior::TopDownMovementBehavior',
      name: 'TopDown',
    });
    await call('add_object', { sessionId, scene: 'Niveau1', type: 'Sprite', name: 'Coin' });
    await call('set_variable', { sessionId, target: { scope: 'scene', scene: 'Niveau1' }, name: 'Score', value: 0 });
    await call('create_group', { sessionId, scene: 'Niveau1', name: 'Collectibles', objects: ['Coin'] });
    await call('place_instance', { sessionId, scene: 'Niveau1', object: 'Player_TopDown', x: 120, y: 220 });
    await call('place_instance', { sessionId, scene: 'Niveau1', object: 'Coin', x: 400, y: 300, layer: 'HUD' });
    const projectDir = mkdtempSync(join(tmpdir(), 'gd-validation-26-proj-'));
    dirs.push(projectDir);
    return { call, sessionId, file: join(projectDir, 'game.json') };
  }

  async function viewProject(call: Harness['call'], sessionId: string): Promise<{
    dirty: boolean;
    content: {
      scenes: {
        name: string;
        layers: string[];
        objects: { name: string; behaviors: { name: string }[] }[];
        instances: { object: string; layer: string }[];
        variables: Record<string, unknown>;
        groups: { name: string; objects: string[] }[];
      }[];
    };
  }> {
    return (await call('describe_project', { sessionId })) as Awaited<ReturnType<typeof viewProject>>;
  }

  it('apply_content_batch tout-ou-rien : dryRun global, réel avec diff, cassé sans effet', async () => {
    const { call, sessionId } = await makeSession();

    const dry = (await call('apply_content_batch', {
      sessionId,
      dryRun: true,
      ops: [{ op: 'set_variable', payload: { sessionId, target: { scope: 'global' }, name: 'Dry', value: 1 } }],
    })) as { applied: number; dryRun: boolean; diff: { empty: boolean } };
    assert.equal(dry.applied, 1);
    assert.equal(dry.dryRun, true);
    // Le diff montre ce que le batch aurait changé ; l'état, lui, est intact.
    assert.equal(dry.diff.empty, false);
    assert.deepEqual((await viewProject(call, sessionId)).content.scenes[0]?.variables, { Score: 0 });

    const real = (await call('apply_content_batch', {
      sessionId,
      ops: [
        { op: 'set_variable', payload: { sessionId, target: { scope: 'global' }, name: 'Batch', value: 2 } },
        { op: 'rename_variable', payload: { sessionId, target: { scope: 'global' }, name: 'Batch', newName: 'BatchOk' } },
        { op: 'create_scene', payload: { sessionId, name: 'Annexe' } },
      ],
    })) as {
      applied: number;
      dryRun: boolean;
      diff: { empty: boolean; variables: { added: string[] } };
    };
    assert.equal(real.applied, 3);
    assert.equal(real.dryRun, false);
    assert.equal(real.diff.empty, false);
    assert.deepEqual(real.diff.variables.added, ['global/BatchOk']);

    const before = JSON.stringify((await viewProject(call, sessionId)).content);
    await assert.rejects(
      call('apply_content_batch', {
        sessionId,
        ops: [
          { op: 'set_variable', payload: { sessionId, target: { scope: 'global' }, name: 'Rollback', value: 3 } },
          { op: 'remove_variable', payload: { sessionId, target: { scope: 'global' }, name: 'Fantome' } },
        ],
      }),
      /Unknown variable|validation-failed/,
    );
    assert.equal(JSON.stringify((await viewProject(call, sessionId)).content), before);
    const rendered = (await call('render_scene_static', { sessionId, scene: 'Niveau1' })) as { svg: string };
    assert.match(rendered.svg, /<svg/);
  });

  it('rollback : double save, mutation, undo identique, refus one-shot et gate baseline', async () => {
    const { call, sessionId, file } = await makeSession();
    const { readFileSync } = await import('node:fs');
    await call('save_project', { sessionId, path: file });
    const second = (await call('save_project', { sessionId, path: file })) as { preRestorePath: string | null };
    assert.ok(second.preRestorePath !== null);
    const savedContent = JSON.stringify((await viewProject(call, sessionId)).content);

    await call('set_variable', { sessionId, target: { scope: 'global' }, name: 'Casse', value: 9 });
    let seen = await viewProject(call, sessionId);
    assert.equal(seen.dirty, true);
    const undone = (await call('undo_last_edit', { sessionId })) as {
      restoredPath: string;
      preRestorePath: string;
      backupPath: string;
    };
    assert.equal(undone.restoredPath, file);
    seen = await viewProject(call, sessionId);
    assert.equal(seen.dirty, false);
    // Mémoire identique au pré-save + disque identique à la copie pre-restore.
    assert.equal(JSON.stringify(seen.content), savedContent);
    assert.equal(readFileSync(file, 'utf8'), readFileSync(undone.preRestorePath, 'utf8'));

    await assert.rejects(call('undo_last_edit', { sessionId }), /save the session first|undo/);
    await assert.rejects(call('undo_last_edit', { sessionId: '00000000-0000-0000-0000-000000000000' }), /Unknown session/);
  });

  it('gate baseline : undo refuse quand une bloquante survient, disque intact', async () => {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    const deps = { store, engine };
    const tools = [...createProjectTools(deps), ...createContentTools(deps)];
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
      parseText(await handler(tools, name)(args));
    const created = (await call('create_project', { name: 'Gate' })) as { sessionId: string };
    const sessionId = created.sessionId;
    const dir = mkdtempSync(join(tmpdir(), 'gd-validation-26-gate-'));
    dirs.push(dir);
    const file = join(dir, 'game.json');
    const { readFileSync } = await import('node:fs');
    await call('save_project', { sessionId, path: file });
    await call('save_project', { sessionId, path: file });
    const diskBefore = readFileSync(file, 'utf8');
    engine.diagnostics.push({ type: 'UnknownObject', message: 'Casse apres save.' });
    await assert.rejects(call('undo_last_edit', { sessionId }), /blocking errors/);
    assert.equal(readFileSync(file, 'utf8'), diskBefore);
    // Même baseline : le batch est refusé avant toute Op de contenu.
    await assert.rejects(
      call('apply_content_batch', {
        sessionId,
        ops: [{ op: 'set_variable', payload: { sessionId, target: { scope: 'global' }, name: 'X', value: 1 } }],
      }),
      /Refusing transaction/,
    );
    assert.equal(readFileSync(file, 'utf8'), diskBefore);
  });

  it('renommages, déplacements puis suppressions avec refus garde-fou, rendu lisible avant la fin', async () => {
    const { call, sessionId } = await makeSession();

    await call('rename_scene', { sessionId, name: 'Niveau1', newName: 'Niveau1Tmp' });
    await call('rename_scene', { sessionId, name: 'Niveau1Tmp', newName: 'Niveau1' });
    await call('move_scene', { sessionId, name: 'Niveau1', position: 0 });
    await call('rename_layer', { sessionId, scene: 'Niveau1', name: 'HUD', newName: 'HUDTmp' });
    await call('rename_layer', { sessionId, scene: 'Niveau1', name: 'HUDTmp', newName: 'HUD' });
    await call('move_layer', { sessionId, scene: 'Niveau1', name: 'HUD', position: 1 });
    await call('rename_object', { sessionId, scene: 'Niveau1', name: 'Coin', newName: 'CoinTmp' });
    await call('rename_object', { sessionId, scene: 'Niveau1', name: 'CoinTmp', newName: 'Coin' });
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
    let seen = await viewProject(call, sessionId);
    assert.deepEqual(seen.content.scenes[0]?.layers, ['', 'HUD']);
    assert.deepEqual(
      seen.content.scenes[0]?.objects.map((object) => object.name),
      ['Player_TopDown', 'Coin'],
    );

    // Garde-fou : suppression d'un calque qui héberge encore des Instances.
    await assert.rejects(call('delete_layer', { sessionId, scene: 'Niveau1', name: 'HUD' }), /still hosts instances/);
    const moved = (await call('move_instances_to_layer', {
      sessionId,
      scene: 'Niveau1',
      sourceLayer: 'HUD',
      targetLayer: '',
    })) as { moved: number };
    assert.equal(moved.moved, 1);
    await call('delete_layer', { sessionId, scene: 'Niveau1', name: 'HUD' });
    seen = await viewProject(call, sessionId);
    assert.deepEqual(seen.content.scenes[0]?.layers, ['']);

    const removed = (await call('remove_instances_of_object', {
      sessionId,
      scene: 'Niveau1',
      object: 'Coin',
    })) as { removed: number };
    assert.equal(removed.removed, 1);
    await call('remove_from_group', { sessionId, scene: 'Niveau1', group: 'Collectibles', object: 'Coin' });
    await call('delete_group', { sessionId, scene: 'Niveau1', name: 'Collectibles' });
    await call('remove_behavior', { sessionId, scene: 'Niveau1', object: 'Player_TopDown', name: 'TopDown' });
    await call('remove_object', { sessionId, scene: 'Niveau1', name: 'Coin' });
    seen = await viewProject(call, sessionId);
    assert.deepEqual(
      seen.content.scenes[0]?.objects.map((object) => object.name),
      ['Player_TopDown'],
    );
    assert.deepEqual(seen.content.scenes[0]?.instances.map((instance) => instance.object), ['Player_TopDown']);
    const rendered = (await call('render_scene_static', { sessionId, scene: 'Niveau1' })) as {
      svg: string;
      instanceCount: number;
    };
    assert.match(rendered.svg, /Niveau1 \(1\)/);
    assert.equal(rendered.instanceCount, 1);

    await call('remove_object', { sessionId, scene: 'Niveau1', name: 'Player_TopDown' });
    await call('delete_scene', { sessionId, name: 'Niveau1' });
    const final = (await call('describe_project', { sessionId })) as { layoutCount: number };
    assert.equal(final.layoutCount, 0);
  });

  it('ressources locales puis fermeture : Previews et Session nettoyés', async () => {
    const { call, sessionId, file } = await makeSession();
    const sourceDir = mkdtempSync(join(tmpdir(), 'gd-validation-26-src-'));
    dirs.push(sourceDir);
    const source = join(sourceDir, 'hero.png');
    writeFileSync(source, 'fake-png-bytes');
    await call('save_project', { sessionId, path: file });
    const imported = (await call('import_resource', {
      sessionId,
      kind: 'image',
      sourcePath: source,
      targetPath: file,
    })) as { name: string };
    assert.equal(imported.name, 'hero');
    const { existsSync, readFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const destFile = join(dirname(file), 'hero.png');
    assert.ok(existsSync(destFile));
    assert.equal(readFileSync(destFile, 'utf8'), 'fake-png-bytes');
    let seen = await viewProject(call, sessionId);
    assert.equal(seen.content.scenes[0]?.instances.length, 2);
    await call('remove_resource', { sessionId, name: 'hero' });

    const built = (await call('build_preview', { sessionId, scene: 'Niveau1' })) as {
      previewId: string;
      url: string;
    };
    assert.match(built.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const status = (await call('get_preview_status', { previewId: built.previewId })) as { previewId: string };
    assert.equal(status.previewId, built.previewId);
    const stopped = (await call('stop_preview', { previewId: built.previewId })) as { stopped: boolean };
    assert.equal(stopped.stopped, true);
    await assert.rejects(call('get_preview_status', { previewId: built.previewId }), /Unknown preview/);

    await assert.rejects(call('close_project', { sessionId }), /unsaved changes/);
    const closed = (await call('close_project', { sessionId, force: true })) as {
      closed: boolean;
      stoppedPreviews: number;
    };
    assert.equal(closed.closed, true);
    await assert.rejects(call('describe_project', { sessionId }), /Unknown session/);
  });
});
