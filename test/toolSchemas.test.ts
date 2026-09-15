import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ProjectStore } from '../src/sessions.js';
import { createAssetTools, createCatalogTools, createContentTools, createEventTools, createProjectTools } from '../src/tools.js';
import { Catalog } from '../src/catalog.js';
import { makeFixtureSource } from './catalogFixtures.js';
import { AssetStore } from '../src/assets.js';
import { makeFixtureAssetSource } from './assetFixtures.js';
import { createFakeEngine } from './fakeEngine.js';
import { contentSchemas } from '../src/content.js';
import { eventsSchemas } from '../src/events.js';

function makeDeps() {
  const engine = createFakeEngine();
  const store = new ProjectStore(engine);
  return { store, engine };
}

describe('tool schemas stay provider-safe (no recursive $ref)', () => {
  it('exposes zero $ref across project+content+event+catalog tools (same conversion as the SDK)', () => {
    const deps = makeDeps();
    const catalog = new Catalog(makeFixtureSource());
    const assets = new AssetStore(makeFixtureAssetSource());
    const tools = [
      ...createProjectTools(deps),
      ...createContentTools(deps),
      ...createEventTools(deps),
      ...createCatalogTools(catalog),
      ...createAssetTools(deps, assets),
    ];
    assert.ok(tools.length > 30);
    const offenders: string[] = [];
    for (const tool of tools) {
      const json = zodToJsonSchema(z.object(tool.inputSchema), { strictUnions: true });
      if (JSON.stringify(json).includes('$ref')) offenders.push(tool.name);
    }
    assert.deepEqual(offenders, [], `recursive tool schemas rejected by providers: ${offenders.join(', ')}`);
  });

  it('internal validation still accepts nested free-JSON and nested sub-events', () => {
    const sessionId = '00000000-0000-0000-0000-000000000000';
    const variable = contentSchemas.setVariable.parse({
      sessionId,
      target: { scope: 'global' },
      name: 'nested',
      value: { a: [1, { b: true }], c: { d: null } },
    });
    assert.deepEqual((variable.value as { a: unknown[] }).a[0], 1);
    const tree = eventsSchemas.appendSceneEvents.parse({
      sessionId,
      scene: 'Scene',
      events: [
        { kind: 'standard', actions: [], events: [{ kind: 'comment', comment: 'nested' }] },
      ],
    });
    assert.equal(tree.events.length, 1);
  });
});
