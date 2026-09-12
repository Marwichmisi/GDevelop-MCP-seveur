import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/sessions.js';
import { createContentTools, createCatalogTools, createProjectTools } from '../src/tools.js';
import { createServer } from '../src/server.js';
import { Catalog } from '../src/catalog.js';
import { makeFixtureSource } from './catalogFixtures.js';
import { McpError } from '../src/errors.js';
import { createFakeEngine } from './fakeEngine.js';

function makeDeps() {
  const engine = createFakeEngine();
  const store = new ProjectStore(engine);
  return { store, engine };
}

function handler(
  tools: ReturnType<typeof createProjectTools>,
  name: string,
): (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[] }> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `tool ${name} registered`);
  return tool.handler;
}

function contentHandler(
  tools: ReturnType<typeof createContentTools>,
  name: string,
): (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[] }> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `tool ${name} registered`);
  return tool.handler;
}

describe('project tools (command seam, never the transport)', () => {
  it('exposes exactly the five lifecycle tools', () => {
    const tools = createProjectTools(makeDeps());
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['close_project', 'create_project', 'describe_project', 'open_project', 'save_project'],
    );
  });

  it('create_project handler returns JSON text with a session id', async () => {
    const tools = createProjectTools(makeDeps());
    const result = await handler(tools, 'create_project')({ name: 'Agent game' });
    const text = result.content[0];
    assert.ok(text && text.type === 'text');
    const payload = JSON.parse((text as { text: string }).text) as { sessionId: string };
    assert.match(payload.sessionId, /^[0-9a-f-]{36}$/);
  });

  it('handlers surface clean session errors instead of crashing', async () => {
    const tools = createProjectTools(makeDeps());
    await assert.rejects(handler(tools, 'describe_project')({ sessionId: '00000000-0000-0000-0000-000000000000' }), (error: unknown) => {
      return error instanceof McpError && error.code === 'unknown-session';
    });
  });

  it('save_project handler persists through the full tool chain', async () => {
    const deps = makeDeps();
    const tools = createProjectTools(deps);
    const dir = mkdtempSync(join(tmpdir(), 'gd-tools-'));
    const file = join(dir, 'game.json');
    const created = JSON.parse(
      ((await handler(tools, 'create_project')({ name: 'Via tools' })).content[0] as { text: string }).text,
    ) as { sessionId: string };
    const saved = JSON.parse(
      ((await handler(tools, 'save_project')({ sessionId: created.sessionId, path: file })).content[0] as { text: string })
        .text,
    ) as { path: string };
    assert.equal(saved.path, file);
  });

  it('createServer wires the tools without connecting any transport', async () => {
    const server = createServer(makeDeps());
    assert.ok(server);
  });

  it('exposes the 28 content tools with the ticket payloads', () => {
    const tools = createContentTools(makeDeps());
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        'add_object', 'add_to_group', 'attach_behavior', 'create_group', 'create_layer', 'create_scene',
        'delete_group', 'delete_layer', 'delete_scene', 'import_resource', 'move_instances_to_layer',
        'move_layer', 'move_scene', 'place_instance', 'remove_behavior', 'remove_from_group', 'remove_instance',
        'remove_instances_of_object', 'remove_object', 'remove_resource', 'remove_variable', 'rename_layer',
        'rename_object', 'rename_scene', 'rename_variable', 'set_variable', 'update_behavior', 'update_instance',
      ].sort(),
    );
  });

  it('content handlers run the full tool chain (scene → object → instance)', async () => {
    const deps = makeDeps();
    const tools = [...createProjectTools(deps), ...createContentTools(deps)];
    const created = JSON.parse(
      ((await handler(tools, 'create_project')({ name: 'Via tools' })).content[0] as { text: string }).text,
    ) as { sessionId: string };
    const sessionId = created.sessionId;
    await contentHandler(tools, 'create_scene')({ sessionId, name: 'Niveau1' });
    await contentHandler(tools, 'add_object')({ sessionId, scene: 'Niveau1', type: 'Sprite', name: 'Joueur' });
    const placed = JSON.parse(
      ((await contentHandler(tools, 'place_instance')({ sessionId, scene: 'Niveau1', object: 'Joueur', x: 100, y: 200 })).content[0] as { text: string }).text,
    ) as { instanceId: string };
    assert.match(placed.instanceId, /^[0-9a-f-]{36}$/);
    const described = JSON.parse(
      ((await handler(tools, 'describe_project')({ sessionId })).content[0] as { text: string }).text,
    ) as { content: { scenes: { name: string; instances: { x: number }[] }[] } };
    assert.equal(described.content.scenes[0]?.name, 'Niveau1');
    assert.equal(described.content.scenes[0]?.instances[0]?.x, 100);
  });
});

describe('catalogue tools (ticket #15)', () => {
  it('exposes exactly the 10 read-only catalogue tools', () => {
    const catalog = new Catalog(makeFixtureSource());
    assert.deepEqual(
      createCatalogTools(catalog)
        .map((tool) => tool.name)
        .sort(),
      [
        'catalog_status',
        'describe_behavior',
        'describe_extension',
        'describe_instructions',
        'describe_object',
        'list_behavior_types',
        'list_extensions',
        'list_instructions',
        'list_object_types',
        'search_instructions',
      ].sort(),
    );
  });

  it('handlers return JSON text with the pinned ref exposed', async () => {
    const catalog = new Catalog(makeFixtureSource());
    const tools = createCatalogTools(catalog);
    const status = tools.find((tool) => tool.name === 'catalog_status');
    assert.ok(status);
    const payload = JSON.parse(
      ((await status.handler({})).content[0] as { text: string }).text,
    ) as { pin: { ref: string }; stale: boolean };
    assert.equal(payload.pin.ref, 'v5.6.282');
    assert.equal(payload.stale, false);

    const search = tools.find((tool) => tool.name === 'search_instructions');
    assert.ok(search);
    const found = JSON.parse(
      ((await search.handler({ query: 'variable' })).content[0] as { text: string }).text,
    ) as { matched: number };
    assert.equal(found.matched, 4);
  });

  it('createServer registers the catalogue tools when a catalog is provided', () => {
    const deps = makeDeps();
    const server = createServer(deps, { catalog: new Catalog(makeFixtureSource()) });
    assert.ok(server);
  });
});

