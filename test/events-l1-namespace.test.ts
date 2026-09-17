import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectStore } from '../src/sessions.js';
import { createContentTools, createEventTools, createProjectTools, type ToolDefinition } from '../src/tools.js';
import { createFakeEngine } from './fakeEngine.js';

/**
 * 1.1 #32 : L1 cohérent — namespace BuiltinCommonInstructions optionnel,
 * variables nues canoniques.
 *
 * Règle documentée (moteur juge) :
 * - canonique = nom exact MetadataProvider : `VarScene` / `ModVarScene`
 *   (extensions sans namespace), `BuiltinCommonInstructions::CompareNumbers`,
 *   `::CompareStrings`, `::Once` (extension à namespace) ;
 * - tolérée = l'autre forme, normalisée vers le canonique à l'écriture.
 *
 * Seam convenu #20 : surface MCP des tools uniquement.
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

describe('1.1 #32 : L1 namespace cohérent (seam tools MCP)', () => {
  async function makeSession(): Promise<{
    call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    sessionId: string;
  }> {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    const deps = { store, engine };
    const tools = [...createProjectTools(deps), ...createContentTools(deps), ...createEventTools(deps)];
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
      parseText(await handler(tools, name)(args));
    const created = (await call('create_project', { name: 'L1' })) as { sessionId: string };
    const sessionId = created.sessionId;
    await call('create_scene', { sessionId, name: 'Niveau1' });
    return { call, sessionId };
  }

  const cases: { label: string; type: string; role: 'condition' | 'action'; parameters: string[]; canonical: string }[] = [
    { label: 'VarScene nu (canonique)', type: 'VarScene', role: 'condition', parameters: ['Score', '=', '0'], canonical: 'VarScene' },
    {
      label: 'VarScene préfixé (toléré)',
      type: 'BuiltinVariables::VarScene',
      role: 'condition',
      parameters: ['Score', '=', '0'],
      canonical: 'VarScene',
    },
    { label: 'ModVarScene nu (canonique)', type: 'ModVarScene', role: 'action', parameters: ['Score', '+', '1'], canonical: 'ModVarScene' },
    {
      label: 'ModVarScene préfixé (toléré)',
      type: 'BuiltinVariables::ModVarScene',
      role: 'action',
      parameters: ['Score', '+', '1'],
      canonical: 'ModVarScene',
    },
    {
      label: 'CompareNumbers préfixé (canonique)',
      type: 'BuiltinCommonInstructions::CompareNumbers',
      role: 'condition',
      parameters: ['1', '=', '2'],
      canonical: 'BuiltinCommonInstructions::CompareNumbers',
    },
    {
      label: 'CompareNumbers nu (toléré)',
      type: 'CompareNumbers',
      role: 'condition',
      parameters: ['1', '=', '2'],
      canonical: 'BuiltinCommonInstructions::CompareNumbers',
    },
    {
      label: 'CompareStrings préfixé (canonique)',
      type: 'BuiltinCommonInstructions::CompareStrings',
      role: 'condition',
      parameters: ['a', '=', 'b'],
      canonical: 'BuiltinCommonInstructions::CompareStrings',
    },
    {
      label: 'CompareStrings nu (toléré)',
      type: 'CompareStrings',
      role: 'condition',
      parameters: ['a', '=', 'b'],
      canonical: 'BuiltinCommonInstructions::CompareStrings',
    },
    {
      label: 'Once préfixé (canonique)',
      type: 'BuiltinCommonInstructions::Once',
      role: 'condition',
      parameters: [],
      canonical: 'BuiltinCommonInstructions::Once',
    },
    { label: 'Once nu (toléré)', type: 'Once', role: 'condition', parameters: [], canonical: 'BuiltinCommonInstructions::Once' },
  ];

  for (const entry of cases) {
    it(`validate accepte ${entry.label}`, async () => {
      const { call, sessionId } = await makeSession();
      const events =
        entry.role === 'condition'
          ? [{ kind: 'standard', conditions: [{ type: entry.type, parameters: entry.parameters }] }]
          : [{ kind: 'standard', actions: [{ type: entry.type, parameters: entry.parameters }] }];
      const validated = (await call('validate_scene_events', { sessionId, scene: 'Niveau1', events })) as {
        valid: boolean;
        errors: string[];
      };
      assert.equal(validated.valid, true, `${entry.label} devrait valider, erreurs: ${validated.errors.join('; ')}`);
      assert.deepEqual(validated.errors, []);
    });

    it(`append normalise ${entry.label} vers ${entry.canonical}`, async () => {
      const { call, sessionId } = await makeSession();
      const events =
        entry.role === 'condition'
          ? [{ kind: 'standard', conditions: [{ type: entry.type, parameters: entry.parameters }] }]
          : [{ kind: 'standard', actions: [{ type: entry.type, parameters: entry.parameters }] }];
      const appended = (await call('append_scene_events', { sessionId, scene: 'Niveau1', events })) as {
        appended: number;
      };
      assert.equal(appended.appended, 1);
      const described = (await call('describe_project', { sessionId })) as {
        content: { scenes: { events: { conditions: { type: string }[]; actions: { type: string }[] }[] }[] };
      };
      const stored =
        entry.role === 'condition'
          ? described.content.scenes[0]?.events[0]?.conditions[0]?.type
          : described.content.scenes[0]?.events[0]?.actions[0]?.type;
      assert.equal(stored, entry.canonical);
    });
  }

  it('refuse toujours un type vraiment inconnu (L1)', async () => {
    const { call, sessionId } = await makeSession();
    const validated = (await call('validate_scene_events', {
      sessionId,
      scene: 'Niveau1',
      events: [{ kind: 'standard', actions: [{ type: 'NopeNope', parameters: [] }] }],
    })) as { valid: boolean; errors: string[] };
    assert.equal(validated.valid, false);
    assert.match(validated.errors.join('; '), /L1/);
  });

  it('refuse un namespace arbitraire même quand le suffixe existe (typo non masquée)', async () => {
    const { call, sessionId } = await makeSession();
    const validated = (await call('validate_scene_events', {
      sessionId,
      scene: 'Niveau1',
      events: [{ kind: 'standard', conditions: [{ type: 'Typo::VarScene', parameters: ['Score', '=', '0'] }] }],
    })) as { valid: boolean; errors: string[] };
    assert.equal(validated.valid, false);
    assert.match(validated.errors.join('; '), /L1/);
  });

  const whileCases: { label: string; type: string; parameters: string[]; canonical: string }[] = [
    { label: 'VarScene nu en while', type: 'VarScene', parameters: ['Score', '=', '0'], canonical: 'VarScene' },
    {
      label: 'VarScene préfixé en while',
      type: 'BuiltinVariables::VarScene',
      parameters: ['Score', '=', '0'],
      canonical: 'VarScene',
    },
    {
      label: 'CompareNumbers nu en while',
      type: 'CompareNumbers',
      parameters: ['1', '=', '2'],
      canonical: 'BuiltinCommonInstructions::CompareNumbers',
    },
    {
      label: 'CompareNumbers préfixé en while',
      type: 'BuiltinCommonInstructions::CompareNumbers',
      parameters: ['1', '=', '2'],
      canonical: 'BuiltinCommonInstructions::CompareNumbers',
    },
  ];

  for (const entry of whileCases) {
    it(`validate + append while : ${entry.label} → ${entry.canonical}`, async () => {
      const { call, sessionId } = await makeSession();
      const events = [
        {
          kind: 'while',
          whileConditions: [{ type: entry.type, parameters: entry.parameters }],
          actions: [{ type: 'ModVarScene', parameters: ['Score', '+', '1'] }],
        },
      ];
      const validated = (await call('validate_scene_events', { sessionId, scene: 'Niveau1', events })) as {
        valid: boolean;
        errors: string[];
      };
      assert.equal(validated.valid, true, `${entry.label} devrait valider, erreurs: ${validated.errors.join('; ')}`);
      const appended = (await call('append_scene_events', { sessionId, scene: 'Niveau1', events })) as {
        appended: number;
      };
      assert.equal(appended.appended, 1);
      const described = (await call('describe_project', { sessionId })) as {
        content: { scenes: { events: { whileConditions: { type: string }[] }[] }[] };
      };
      assert.equal(described.content.scenes[0]?.events[0]?.whileConditions[0]?.type, entry.canonical);
    });
  }
});
