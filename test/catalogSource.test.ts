import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubCatalogSource, isCatalogSourcePath, type FetchLike } from '../src/catalogSource.js';
import { FIXTURE_CPP, FIXTURE_CPP_PATH, FIXTURE_JS, FIXTURE_JS_PATH, FIXTURE_TS, FIXTURE_TS_PATH } from './catalogFixtures.js';

interface FakeFetchOptions {
  treeSha?: string | null;
  releaseTag?: string;
  raw?: Record<string, string>;
}

function makeFakeFetch(options: FakeFetchOptions = {}): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const raw = options.raw ?? { [FIXTURE_CPP_PATH]: FIXTURE_CPP, [FIXTURE_JS_PATH]: FIXTURE_JS, [FIXTURE_TS_PATH]: FIXTURE_TS };
  const fetchImpl: FetchLike & { urls: string[] } = Object.assign(
    async (url: string) => {
      urls.push(url);
      if (url.endsWith('/releases/latest')) {
        return { ok: true, status: 200, text: async () => '', json: async () => ({ tag_name: options.releaseTag ?? 'v5.6.282' }) };
      }
      if (url.includes('/git/trees/')) {
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({
            sha: options.treeSha === undefined ? 'treesha123' : options.treeSha,
            tree: [
              ...Object.keys(raw).map((path) => ({ path, type: 'blob', size: 120 })),
              { path: 'Core/GDCore/Project/Project.cpp', type: 'blob', size: 120 },
              { path: 'Extensions/DialogueTree/tests/dialogue.test.ts', type: 'blob', size: 120 },
              { path: 'Extensions/Huge/tool.ts', type: 'blob', size: 5_000_000 },
              { path: 'GDJS/Runtime/gd.js', type: 'blob', size: 120 },
            ],
          }),
        };
      }
      const body = raw[url.split('/v5.6.282/')[1] as string];
      if (body === undefined) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
      return { ok: true, status: 200, text: async () => body, json: async () => ({}) };
    },
    { urls },
  );
  return fetchImpl;
}

describe('catalogue pinned source (ticket #15)', () => {
  it('keeps only the catalogue-relevant paths', () => {
    assert.equal(isCatalogSourcePath(FIXTURE_CPP_PATH), true);
    assert.equal(isCatalogSourcePath(FIXTURE_JS_PATH), true);
    assert.equal(isCatalogSourcePath(FIXTURE_TS_PATH), true);
    assert.equal(isCatalogSourcePath('Core/GDCore/Extensions/Builtin/SpriteExtension/SpriteExtension.cpp'), true);
    assert.equal(isCatalogSourcePath('Core/GDCore/Extensions/Builtin/Capabilities/Capability.h'), false);
    assert.equal(isCatalogSourcePath('Core/GDCore/Project/Project.cpp'), false);
    assert.equal(isCatalogSourcePath('Extensions/DialogueTree/tests/dialogue.test.ts'), false);
    assert.equal(isCatalogSourcePath('Extensions/DialogueTree/types.d.ts'), false);
    assert.equal(isCatalogSourcePath('GDJS/Runtime/gd.js'), false);
    assert.equal(isCatalogSourcePath(FIXTURE_JS_PATH, 5_000_000), false);
  });

  it('syncs the pinned tree to disk and reuses the cache without refetching', async () => {
    const fetchImpl = makeFakeFetch();
    const source = new GitHubCatalogSource({
      ref: 'v5.6.282',
      cacheDir: mkdtempSync(join(tmpdir(), 'gd-catalog-')),
      fetchImpl,
      now: () => new Date('2026-09-12T00:00:00.000Z'),
      concurrency: 2,
    });

    const snapshot = await source.load();
    assert.equal(snapshot.ref, 'v5.6.282');
    assert.equal(snapshot.sha, 'treesha123');
    assert.deepEqual(snapshot.files.map((file) => file.path).sort(), [FIXTURE_CPP_PATH, FIXTURE_JS_PATH, FIXTURE_TS_PATH]);

    const before = fetchImpl.urls.length;
    assert.ok(before > 0);
    const cached = await source.load();
    assert.equal(cached.files.length, 3);
    assert.equal(fetchImpl.urls.length, before);

    const refreshed = await source.load({ refresh: true });
    assert.equal(refreshed.files.length, 3);
    assert.ok(fetchImpl.urls.length > before);
  });

  it('resolves the pin to the latest release tag when no ref is pinned', async () => {
    const fetchImpl = makeFakeFetch({ releaseTag: 'v5.6.282' });
    const source = new GitHubCatalogSource({
      cacheDir: mkdtempSync(join(tmpdir(), 'gd-catalog-ref-')),
      fetchImpl,
      now: () => new Date('2026-09-12T00:00:00.000Z'),
    });
    assert.equal(await source.latestReleaseRef(), 'v5.6.282');
    const snapshot = await source.load();
    assert.equal(snapshot.ref, 'v5.6.282');
  });

  it('fails cleanly with a catalog code when the tree cannot be read', async () => {
    const failing: FetchLike = async (url: string) => {
      void url;
      return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
    };
    const source = new GitHubCatalogSource({
      ref: 'v5.6.282',
      cacheDir: mkdtempSync(join(tmpdir(), 'gd-catalog-fail-')),
      fetchImpl: failing,
    });
    const { McpError } = await import('../src/errors.js');
    await assert.rejects(source.load(), (error: unknown) => error instanceof McpError && error.code === 'catalog-unavailable');
  });
});
