import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/sessions.js';
import {
  createAssetTools,
  createContentTools,
  createPreviewTools,
  createProjectTools,
  type ToolDefinition,
} from '../src/tools.js';
import { PreviewManager } from '../src/preview.js';
import { AssetStore } from '../src/assets.js';
import { McpError } from '../src/errors.js';
import { createFakeEngine } from './fakeEngine.js';
import { FIXTURE_COIN_DETAILS, makeFixtureAssetSource } from './assetFixtures.js';

/**
 * Spec #37 : Télécharger des assets du Store dans son jeu via le MCP.
 *
 * Seam unique convenu (#20, repris en #37) : la surface MCP des tools
 * uniquement. Preuve externe observable : recherche -> détails -> import
 * ciblé -> Objet utilisable en Scène (Instance posée + rendu statique).
 * Aucun réseau : source fixture déterministe.
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

describe('spec #37 : chaîne Asset Store bout-en-bout au seam tools MCP', () => {
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

  it('search -> details -> import ciblé en Scène -> Instance posée + rendu statique', async () => {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    const deps = { store, engine };
    const assets = new AssetStore(makeFixtureAssetSource());
    const tmpRoot = mkdtempSync(join(tmpdir(), 'gd-asset-e2e-'));
    dirs.push(tmpRoot);
    const manager = new PreviewManager(deps as never, { tmpRoot });
    managers.push(manager);
    const tools = [
      ...createProjectTools(deps),
      ...createContentTools(deps),
      ...createAssetTools(deps, assets),
      ...createPreviewTools(manager),
    ];
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
      parseText(await handler(tools, name)(args));

    const created = (await call('create_project', { name: 'Asset-E2E' })) as { sessionId: string };
    const sessionId = created.sessionId;
    await call('save_project', { sessionId, path: join(tmpRoot, 'game.json') });
    await call('create_scene', { sessionId, name: 'Niveau1' });

    const searched = (await call('search_assets', { query: 'coin' })) as {
      matched: number;
      assets: { id: string; name: string }[];
    };
    assert.ok(searched.matched >= 1);
    assert.ok(searched.assets.some((a) => a.id === FIXTURE_COIN_DETAILS.id));

    const details = (await call('get_asset_details', { id: FIXTURE_COIN_DETAILS.id })) as {
      name: string;
      version: string;
      objectAssets: unknown[];
    };
    assert.equal(details.name, 'Bronze Coin');
    assert.equal(details.version, '1.0.0');
    assert.equal(details.objectAssets.length, 1);

    const result = (await call('import_assets_into_project', {
      sessionId,
      scene: 'Niveau1',
      pack: 'collectable',
      packVersion: '1.0.0',
      assets: [{ id: FIXTURE_COIN_DETAILS.id }],
    })) as { imported: { id: string; as: string }[]; pack: string };
    assert.equal(result.pack, 'collectable');
    assert.equal(result.imported[0]?.id, FIXTURE_COIN_DETAILS.id);
    const objectName = result.imported[0]?.as;
    assert.ok(typeof objectName === 'string' && objectName.length > 0);

    const placed = (await call('place_instance', {
      sessionId,
      scene: 'Niveau1',
      object: objectName,
      x: 300,
      y: 200,
    })) as { instanceId: string };
    assert.match(placed.instanceId, /^[0-9a-f-]{36}$/);

    const rendered = (await call('render_scene_static', { sessionId, scene: 'Niveau1' })) as {
      scene: string;
      svg: string;
      objectCount: number;
      instanceCount: number;
    };
    assert.equal(rendered.scene, 'Niveau1');
    assert.equal(rendered.instanceCount, 1);
    assert.ok(rendered.objectCount >= 1);
    assert.match(rendered.svg, /<svg/);
    assert.ok(rendered.svg.includes(objectName), `rendu sans ${objectName}`);

    const described = (await call('describe_project', { sessionId })) as {
      content: { scenes: { name: string; objects: { name: string }[]; instances: { object: string }[] }[] };
    };
    const scene = described.content.scenes.find((s) => s.name === 'Niveau1');
    assert.ok(scene);
    assert.ok(scene.objects.some((o) => o.name === objectName));
    assert.ok(scene.instances.some((i) => i.object === objectName));
  });

  it('panne CDN -> refus explicite asset-unavailable, sans crash', async () => {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    const deps = { store, engine };
    const failing = makeFixtureAssetSource();
    failing.listHeaders = (async () => {
      throw new Error('CDN down');
    }) as typeof failing.listHeaders;
    const assets = new AssetStore(failing);
    const tools = [...createAssetTools(deps, assets)];
    await assert.rejects(handler(tools, 'search_assets')({ query: 'coin' }), (error: unknown) => {
      return (
        error instanceof McpError &&
        error.code === 'asset-unavailable' &&
        /Asset CDN unavailable while listing headers/.test(error.message)
      );
    });
  });
});
