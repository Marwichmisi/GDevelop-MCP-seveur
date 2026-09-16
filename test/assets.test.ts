import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpError } from '../src/errors.js';
import { ProjectStore } from '../src/sessions.js';
import { createProject, describeProject, saveProject } from '../src/commands.js';
import { createFakeEngine } from './fakeEngine.js';
import {
  FIXTURE_COIN_DETAILS,
  FIXTURE_EXAMPLE_DETAILS,
  makeFixtureAssetSource,
} from './assetFixtures.js';
import {
  AssetStore,
  assetStatus,
  getAssetDetails,
  getExampleDetails,
  importAssetsIntoProject,
  listExamples,
  openExample,
  searchAssets,
} from '../src/assets.js';

function makeDeps() {
  const engine = createFakeEngine();
  const store = new ProjectStore(engine);
  return { store, engine };
}

function makeSessionWithFile(deps: ReturnType<typeof makeDeps>): { sessionId: string; dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gd-asset-'));
  const file = join(dir, 'game.json');
  writeFileSync(file, JSON.stringify({ name: 'AssetGame', layouts: [], objects: [], variables: [], objectsGroups: [], resources: [] }));
  const { sessionId } = createProject(deps, { name: 'AssetGame' });
  deps.store.setFilePath(sessionId, file);
  return { sessionId, dir, file };
}

describe('asset store ciblé (ticket #18) : lecture sur fixtures', () => {
  it('search_assets filtre par query/tags/objectType/license + expose licences', async () => {
    const assets = new AssetStore(makeFixtureAssetSource());
    const all = await searchAssets(assets, {});
    assert.equal(all.matched, 3);
    assert.equal(all.pin.ref, 'asset-cdn-live');

    const coin = await searchAssets(assets, { query: 'coin' });
    assert.equal(coin.matched, 1);
    assert.equal(coin.assets[0]?.name, 'Bronze Coin');
    assert.equal(coin.assets[0]?.license, 'CC0 (public domain)');

    const sprite = await searchAssets(assets, { objectType: 'sprite' });
    assert.equal(sprite.matched, 3);

    const armor = await searchAssets(assets, { tags: ['armor'] });
    assert.equal(armor.matched, 1);
    assert.equal(armor.assets[0]?.name, 'Bronze Shield');

    const none = await searchAssets(assets, { license: 'MIT' });
    assert.equal(none.matched, 0);
  });

  it('search_assets tolère les fiches incomplètes (ticket #28) : pas de TypeError', async () => {
    const source = makeFixtureAssetSource();
    const original = source.listHeaders.bind(source);
    source.listHeaders = (async () => {
      const headers = (await original()) as unknown as Record<string, unknown>[];
      return [
        ...headers,
        { id: 'incomplete000000000000000000000001' },
        { id: 'incomplete000000000000000000000002', name: 'Broken coin', tags: 'not-an-array' },
        { id: 'incomplete000000000000000000000003', name: 'Empty tags coin', tags: [] },
      ];
    }) as unknown as typeof source.listHeaders;
    const assets = new AssetStore(source);

    const coin = await searchAssets(assets, { query: 'coin' });
    assert.equal(coin.assets[0]?.name, 'Bronze Coin');
    assert.ok(
      coin.matched >= 1,
      `attendu au moins Bronze Coin, reçu ${coin.matched}`,
    );

    const none = await searchAssets(assets, { query: 'zzz-no-such-asset' });
    assert.equal(none.matched, 0);
    assert.deepEqual(none.assets, []);
  });

  it('search_assets avec pack sans tag (ticket #28) : aucun faux-positif', async () => {
    const source = makeFixtureAssetSource();
    const origHeaders = source.listHeaders.bind(source);
    source.listHeaders = (async () => {
      const headers = (await origHeaders()) as unknown as Record<string, unknown>[];
      return [...headers, { id: 'notag0000000000000000000000000001' }];
    }) as unknown as typeof source.listHeaders;
    const origPacks = source.listPacks.bind(source);
    source.listPacks = (async () => {
      const packs = (await origPacks()) as unknown as Record<string, unknown>[];
      return [...packs, { name: 'Ghost pack' }];
    }) as unknown as typeof source.listPacks;
    const assets = new AssetStore(source);

    const ghost = await searchAssets(assets, { pack: 'ghost pack' });
    assert.equal(ghost.matched, 0);
    assert.deepEqual(ghost.assets, []);
  });

  it('garde le cache en mémoire pendant le TTL puis recharge', async () => {
    let now = 1_000;
    const source = makeFixtureAssetSource();
    const assets = new AssetStore(source, { ttlMs: 60_000, now: () => now });
    await searchAssets(assets, {});
    await searchAssets(assets, {});
    assert.equal(source.state.headerLoads, 1);
    now += 60_001;
    await searchAssets(assets, {});
    assert.equal(source.state.headerLoads, 2);
  });

  it('get_asset_details expose version, extensions, ressources (Bronze Coin)', async () => {
    const assets = new AssetStore(makeFixtureAssetSource());
    const details = await getAssetDetails(assets, { id: FIXTURE_COIN_DETAILS.id });
    assert.equal(details.name, 'Bronze Coin');
    assert.equal(details.version, '1.0.0');
    assert.equal(details.license, 'CC0 (public domain)');
    assert.deepEqual(details.objectAssets[0]?.requiredExtensions ?? [], []);
    assert.equal(details.objectAssets.length, 1);
    assert.equal((details.objectAssets[0]?.object as { type?: string }).type, 'Sprite');
    assert.equal(details.objectAssets[0]?.resources?.[0]?.kind, 'image');
  });

  it('get_asset_details inconnu remonte le status + URL (actionnable)', async () => {
    const assets = new AssetStore(makeFixtureAssetSource());
    await assert.rejects(getAssetDetails(assets, { id: 'deadbeef'.padEnd(32, '0') }), (error: unknown) => {
      return error instanceof McpError && error.code === 'asset-unavailable' && /404/.test(error.message);
    });
  });

  it('asset_status expose pin + counts', async () => {
    const assets = new AssetStore(makeFixtureAssetSource());
    const status = await assetStatus(assets, {});
    assert.equal(status.pin.ref, 'asset-cdn-live');
    assert.equal(status.counts.assets, 3);
    assert.equal(status.counts.packs, 2);
    assert.equal(status.counts.examples, 1);
    assert.equal(status.stale, false);
  });
});

describe('asset store ciblé (ticket #18) : import moteur tout-ou-rien', () => {
  it('import Hero + Coin pinnés : objets moteur + ressources locales, version tracée', async () => {
    const deps = makeDeps();
    const { sessionId, dir } = makeSessionWithFile(deps);
    const assets = new AssetStore(makeFixtureAssetSource());

    const result = await importAssetsIntoProject(deps, assets, {
      sessionId,
      pack: 'collectable',
      packVersion: '1.0.0',
      assets: [{ id: 'aa11bb22cc33dd44ee55ff0011223344' }, { id: '0d22d5d4aa7a4b3c9d8e1f2a3b4c5d6e' }],
    });

    assert.equal(result.pack, 'collectable');
    assert.equal(result.packVersion, '1.0.0');
    assert.equal(result.imported.length, 2);
    assert.deepEqual(
      result.assetVersions.map((v: { version: string }) => v.version).sort(),
      ['1.0.0', '1.0.0'],
    );
    // Objets vraiment dans le moteur (pas du JSON à l'aveugle).
    const view = describeProject(deps, { sessionId });
    const names = [...view.content.globalObjects.map((o) => o.name)];
    assert.ok(names.includes('Hero'));
    assert.ok(names.includes('Bronze Coin'));
    // Ressources locales copiées près du projet.
    assert.ok(result.resources.length >= 2);
    for (const file of result.resources) {
      assert.ok(existsSync(join(dir, file)), `missing local resource ${file}`);
    }
    assert.equal(deps.store.get(sessionId).dirty, true);
  });

  it('import "all" opt-in importe tout le pack', async () => {
    const deps = makeDeps();
    const { sessionId } = makeSessionWithFile(deps);
    const assets = new AssetStore(makeFixtureAssetSource());
    const result = await importAssetsIntoProject(deps, assets, {
      sessionId,
      pack: 'collectable',
      packVersion: '1.0.0',
      assets: 'all',
    });
    assert.equal(result.imported.length, 3);
  });

  it('extensions manquantes → refus explicite listant les manquantes, sans mutation', async () => {
    const deps = makeDeps();
    const { sessionId } = makeSessionWithFile(deps);
    const assets = new AssetStore(makeFixtureAssetSource());
    const before = JSON.stringify(describeProject(deps, { sessionId }).content);
    await assert.rejects(
      importAssetsIntoProject(deps, assets, {
        sessionId,
        pack: 'collectable',
        packVersion: '1.0.0',
        assets: [{ id: 'bb22cc33dd44ee55ff00112233445566' }],
      }),
      (error: unknown) => {
        return (
          error instanceof McpError &&
          error.code === 'validation-failed' &&
          /Spine/.test(error.message) &&
          /1\.0\.0/.test(error.message)
        );
      },
    );
    assert.equal(JSON.stringify(describeProject(deps, { sessionId }).content), before);
    assert.equal(deps.store.get(sessionId).dirty, false);
  });

  it('collision de nom → renommage as (Coin → Coin_2) tracé', async () => {
    const deps = makeDeps();
    const { sessionId } = makeSessionWithFile(deps);
    const assets = new AssetStore(makeFixtureAssetSource());
    await importAssetsIntoProject(deps, assets, {
      sessionId,
      pack: 'collectable',
      packVersion: '1.0.0',
      assets: [{ id: '0d22d5d4aa7a4b3c9d8e1f2a3b4c5d6e' }],
    });
    const second = await importAssetsIntoProject(deps, assets, {
      sessionId,
      pack: 'collectable',
      packVersion: '1.0.0',
      assets: [{ id: '0d22d5d4aa7a4b3c9d8e1f2a3b4c5d6e' }],
    });
    assert.equal(second.imported[0]?.name, 'Bronze Coin');
    assert.equal(second.imported[0]?.as, 'Bronze Coin_2');
    const names = describeProject(deps, { sessionId }).content.globalObjects.map((o) => o.name);
    assert.ok(names.includes('Bronze Coin'));
    assert.ok(names.includes('Bronze Coin_2'));
  });

  it('as explicite en collision → refus (jamais d écrasement)', async () => {
    const deps = makeDeps();
    const { sessionId } = makeSessionWithFile(deps);
    const assets = new AssetStore(makeFixtureAssetSource());
    await importAssetsIntoProject(deps, assets, {
      sessionId,
      pack: 'collectable',
      packVersion: '1.0.0',
      assets: [{ id: '0d22d5d4aa7a4b3c9d8e1f2a3b4c5d6e' }],
    });
    await assert.rejects(
      importAssetsIntoProject(deps, assets, {
        sessionId,
        pack: 'collectable',
        packVersion: '1.0.0',
        assets: [{ id: 'fd002c68aa7a4b3c9d8e1f2a3b4c5d6f', as: 'Bronze Coin' }],
      }),
      /already exists/,
    );
  });

  it('pack privé → refus propre hors-scope (CDN public seul)', async () => {
    const deps = makeDeps();
    const { sessionId } = makeSessionWithFile(deps);
    const assets = new AssetStore(makeFixtureAssetSource());
    await assert.rejects(
      importAssetsIntoProject(deps, assets, {
        sessionId,
        pack: 'collectable',
        packVersion: '1.0.0',
        assets: [{ id: 'cc33dd44ee55ff001122334455667788' }],
      }),
      (error: unknown) => {
        return error instanceof McpError && error.code === 'validation-failed' && /privé|private|hors périmètre/i.test(error.message);
      },
    );
  });

  it('asset à variantes → refus propre hors-scope MVP', async () => {
    const deps = makeDeps();
    const { sessionId } = makeSessionWithFile(deps);
    const assets = new AssetStore(makeFixtureAssetSource());
    await assert.rejects(
      importAssetsIntoProject(deps, assets, {
        sessionId,
        pack: 'collectable',
        packVersion: '1.0.0',
        assets: [{ id: 'dd44ee55ff0011223344556677889900' }],
      }),
      /variante/i,
    );
  });

  it('kind ressource inconnu → validation-failed sans deviner par extension', async () => {
    const deps = makeDeps();
    const { sessionId } = makeSessionWithFile(deps);
    const source = makeFixtureAssetSource();
    const original = source.getDetails.bind(source);
    source.getDetails = (async (id: string) => {
      const details = (await original(id)) as unknown as Record<string, unknown>;
      const clone = structuredClone(details) as unknown as {
        objectAssets: { resources: { kind: string }[] }[];
      };
      const first = clone.objectAssets[0];
      const res = first?.resources[0];
      if (first && res) res.kind = 'nope-kind';
      return clone;
    }) as typeof source.getDetails;
    const assets = new AssetStore(source);
    await assert.rejects(
      importAssetsIntoProject(deps, assets, {
        sessionId,
        pack: 'collectable',
        packVersion: '1.0.0',
        assets: [{ id: '0d22d5d4aa7a4b3c9d8e1f2a3b4c5d6e' }],
      }),
      /kind "nope-kind" is not supported/,
    );
  });
  it('list_examples tolère les fiches incomplètes (ticket #28) : pas de TypeError', async () => {
    const source = makeFixtureAssetSource();
    const original = source.listExampleHeaders.bind(source);
    source.listExampleHeaders = (async () => {
      const headers = (await original()) as unknown as Record<string, unknown>[];
      return [...headers, { id: 'incomplete-example' }, { id: 'incomplete-example-2', name: 'Broken', tags: 'x' }];
    }) as unknown as typeof source.listExampleHeaders;
    const assets = new AssetStore(source);

    const found = await listExamples(assets, { query: 'platform' });
    assert.equal(found.examples[0]?.slug, 'platformer');

    const none = await listExamples(assets, { query: 'zzz-no-such-example' });
    assert.equal(none.matched, 0);
    assert.deepEqual(none.examples, []);
  });
});

describe('exemples (ticket #18) : session lecture', () => {
  it('list/get_example_details + recherche mémoire', async () => {
    const assets = new AssetStore(makeFixtureAssetSource());
    const listed = await listExamples(assets, {});
    assert.equal(listed.matched, 1);
    assert.equal(listed.examples[0]?.slug, 'platformer');

    const searched = await listExamples(assets, { query: 'platform' });
    assert.equal(searched.matched, 1);

    const details = await getExampleDetails(assets, { id: 'platformer' });
    assert.equal(details.slug, 'platformer');
    assert.equal(details.license, 'MIT');
    assert.equal(details.projectFileUrl, FIXTURE_EXAMPLE_DETAILS.projectFileUrl);
  });

  it('open_example ouvre une session lecture inspectable (describe OK, save refusé)', async () => {
    const deps = makeDeps();
    const assets = new AssetStore(makeFixtureAssetSource());
    const opened = await openExample(deps, assets, { id: 'platformer' });
    assert.match(opened.sessionId, /^[0-9a-f-]{36}$/);
    assert.equal(opened.readOnly, true);

    const described = describeProject(deps, { sessionId: opened.sessionId });
    assert.ok(described.layoutCount >= 1);

    assert.throws(
      () => saveProject(deps, { sessionId: opened.sessionId, path: join(tmpdir(), 'should-not-save.json') }),
      (error: unknown) => error instanceof McpError && error.code === 'validation-failed',
    );
    // Mutation refusée aussi : la session lecture ne marque jamais dirty.
    const { setVariable } = await import('../src/content.js');
    assert.throws(
      () => setVariable(deps, { sessionId: opened.sessionId, target: { scope: 'global' }, name: 'x', value: 1 }),
      (error: unknown) => error instanceof McpError && error.code === 'validation-failed',
    );
    assert.equal(deps.store.get(opened.sessionId).dirty, false);
  });

  it('exemple inconnu → erreur actionnable', async () => {
    const deps = makeDeps();
    const assets = new AssetStore(makeFixtureAssetSource());
    await assert.rejects(openExample(deps, assets, { id: 'nope' }), /Couldn't retrieve the example/);
  });
});
