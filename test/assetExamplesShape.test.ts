import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpAssetSource, type FetchLike } from '../src/assetSource.js';
import { AssetStore, assetStatus, listExamples } from '../src/assets.js';
import { McpError } from '../src/errors.js';

/**
 * Ticket #29 : le CDN exemples renvoie désormais un tableau brut
 * (examples-database-v2.json = [...] 285 entrées, vérifié live 2026-09-16),
 * alors que HttpAssetSource exigeait { exampleShortHeaders: [...] }.
 * Repro : asset_status {} et list_examples { limit: 5 } levaient
 * "Asset CDN returned an unexpected examples shape."
 */

const EXAMPLE_ENTRY = {
  id: 'd260466ba96262fd00930eb950ae486209a828f851add1c1c5bbc2a2d020f868',
  slug: 'platformer',
  name: 'Platformer',
  shortDescription: 'Simple platformer starter',
  description: 'Starter platformer.',
  license: 'MIT',
  tags: ['platformer', 'game'],
  previewImageUrls: ['https://resources.gdevelop-app.com/examples/platformer/preview.png'],
  difficultyLevel: 'simple',
  codeSizeLevel: 'small',
  gdevelopVersion: '5.6.280',
};

function makeFetch(examplesPayload: unknown): FetchLike {
  return (async (url: string) => {
    if (url.includes('examples-database-v2.json')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(examplesPayload),
        json: async () => examplesPayload,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    if (url.includes('examples-database/filters.json')) {
      const filters = { allTags: [], defaultTags: ['Sprite'], tagsTree: [] };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(filters),
        json: async () => filters,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    if (url.includes('assetPacks.json')) {
      const packs = { starterPacks: [] };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(packs),
        json: async () => packs,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    if (url.includes('assetShortHeaders.json')) {
      const headers: unknown[] = [];
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(headers),
        json: async () => headers,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as FetchLike;
}

describe('ticket #29 : forme CDN exemples tolérante', () => {
  it('listExampleHeaders accepte le tableau brut live', async () => {
    const source = new HttpAssetSource(makeFetch([EXAMPLE_ENTRY]));
    const headers = await source.listExampleHeaders();
    assert.equal(headers.length, 1);
    assert.equal(headers[0]?.slug, 'platformer');
  });

  it('listExampleHeaders garde la compatibilité enveloppe legacy', async () => {
    const source = new HttpAssetSource(makeFetch({ exampleShortHeaders: [EXAMPLE_ENTRY] }));
    const headers = await source.listExampleHeaders();
    assert.equal(headers.length, 1);
    assert.equal(headers[0]?.slug, 'platformer');
  });

  it('listExampleHeaders refuse proprement une charge inutilisable', async () => {
    const source = new HttpAssetSource(makeFetch({}));
    await assert.rejects(source.listExampleHeaders(), (error: unknown) => {
      return (
        error instanceof McpError &&
        error.code === 'asset-unavailable' &&
        /unexpected examples shape/.test(error.message)
      );
    });
  });

  it('asset_status répond versions et comptes sans erreur de forme', async () => {
    const store = new AssetStore(new HttpAssetSource(makeFetch([EXAMPLE_ENTRY])));
    const status = await assetStatus(store, {});
    assert.equal(status.counts.examples, 1);
    assert.equal(status.stale, false);
  });

  it('list_examples répond une liste exploitable (ids/slugs)', async () => {
    const store = new AssetStore(new HttpAssetSource(makeFetch([EXAMPLE_ENTRY])));
    const listed = await listExamples(store, { limit: 5 });
    assert.equal(listed.matched, 1);
    assert.equal(listed.examples[0]?.slug, 'platformer');
    assert.ok(typeof listed.examples[0]?.id === 'string' && listed.examples[0]?.id.length > 0);
  });

  it('listExampleHeaders filtre les entrées non-objets (revue Spec) : pas de TypeError aval', async () => {
    const source = new HttpAssetSource(makeFetch([EXAMPLE_ENTRY, null, 'oops', 42, { id: 'incomplete' }]));
    const headers = await source.listExampleHeaders();
    assert.equal(headers.length, 2);
    assert.equal(headers[0]?.slug, 'platformer');
    const store = new AssetStore(new HttpAssetSource(makeFetch([EXAMPLE_ENTRY, null])));
    const listed = await listExamples(store, { limit: 5 });
    assert.equal(listed.matched, 1);
    assert.equal(listed.examples[0]?.slug, 'platformer');
  });
});
