import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/sessions.js';
import { createProjectTools } from '../src/tools.js';
import { createServer } from '../src/server.js';
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
});
