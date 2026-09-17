import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectStore } from '../src/sessions.js';
import { createContentTools, createEventTools, createProjectTools, type ToolDefinition } from '../src/tools.js';
import { Catalog, describeInstructions } from '../src/catalog.js';
import { makeFixtureSource } from './catalogFixtures.js';
import { createFakeEngine } from './fakeEngine.js';

/**
 * 1.1 #33 : Action texte TextObject introuvable (SetText/SetString Unknown L1).
 *
 * Cause prouvée live libGD 5.6.281 : `SetText`/`SetString` n'existent pas.
 * Le vrai nom moteur est `TextObject::String` (action 3 params
 * [objet, opérateur, texte], ex. ["ScoreText", "=", "Score: 0"]).
 * Le catalogue stocke le type nu (`String`, extension `TextObject`) mais
 * `describe_instructions("TextObject::String")` ne le trouvait pas.
 *
 * Seam convenu #20 : surface MCP des tools + lecture catalogue uniquement.
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

const TEXTOBJECT_FIXTURE = `
void DeclareTextObjectExtension(gd::PlatformExtension& extension) {
  extension.SetExtensionInformation("TextObject", _("Text object"), _("Text."), "Florian", "MIT");
  gd::ObjectMetadata& obj = extension.AddObject<TextObject>("Text", _("Text"), _("Displays."), "icon.png");
  obj.AddAction("String", _("Modify the text"), _("Modify the text of a Text object."), _("Do _PARAM1_ _PARAM2_ to the text of _PARAM0_"), "", "", "")
    .AddParameter("object", _("Object"))
    .AddParameter("operator", _("Modification's sign"))
    .AddParameter("string", _("Text"));
  obj.AddCondition("String", _("Text"), _("Compare the text of a Text object."), _("The text of _PARAM0_ _PARAM1_ _PARAM2_"), "", "", "")
    .AddParameter("object", _("Object"))
    .AddParameter("relationalOperator", _("Sign of the test"))
    .AddParameter("string", _("Value to compare"));
}
`;

describe('1.1 #33 : TextObject::String documenté et valide (seam tools MCP + catalogue)', () => {
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
    const created = (await call('create_project', { name: 'Text33' })) as { sessionId: string };
    const sessionId = created.sessionId;
    await call('create_scene', { sessionId, name: 'Niveau1' });
    await call('add_object', { sessionId, scene: 'Niveau1', type: 'TextObject::Text', name: 'ScoreText' });
    return { call, sessionId };
  }

  it('validate accepte TextObject::String (action texte réelle, 3 params)', async () => {
    const { call, sessionId } = await makeSession();
    const validated = (await call('validate_scene_events', {
      sessionId,
      scene: 'Niveau1',
      events: [{ kind: 'standard', actions: [{ type: 'TextObject::String', parameters: ['ScoreText', '=', 'Score: 0'] }] }],
    })) as { valid: boolean; errors: string[] };
    assert.equal(validated.valid, true, `TextObject::String devrait valider, erreurs: ${validated.errors.join('; ')}`);
    assert.deepEqual(validated.errors, []);
  });

  it('append stocke le canonique TextObject::String et describe le relit', async () => {
    const { call, sessionId } = await makeSession();
    const appended = (await call('append_scene_events', {
      sessionId,
      scene: 'Niveau1',
      events: [{ kind: 'standard', actions: [{ type: 'TextObject::String', parameters: ['ScoreText', '=', 'Score: 0'] }] }],
    })) as { appended: number };
    assert.equal(appended.appended, 1);
    const described = (await call('describe_project', { sessionId })) as {
      content: { scenes: { events: { actions: { type: string; parameters: string[] }[] }[] }[] };
    };
    assert.equal(described.content.scenes[0]?.events[0]?.actions[0]?.type, 'TextObject::String');
    assert.deepEqual(described.content.scenes[0]?.events[0]?.actions[0]?.parameters, ['ScoreText', '=', 'Score: 0']);
  });

  it('refuse toujours SetText/SetString (noms devinés, L1)', async () => {
    const { call, sessionId } = await makeSession();
    for (const guessed of ['SetText', 'SetString', 'TextObject::SetText', 'TextObject::SetString']) {
      const validated = (await call('validate_scene_events', {
        sessionId,
        scene: 'Niveau1',
        events: [{ kind: 'standard', actions: [{ type: guessed, parameters: ['ScoreText', '=', 'x'] }] }],
      })) as { valid: boolean; errors: string[] };
      assert.equal(validated.valid, false, `${guessed} devrait être refusé`);
      assert.match(validated.errors.join('; '), /L1/);
    }
  });

  it('catalogue : describe TextObject::String retrouve String de TextObject', async () => {
    const catalog = new Catalog(
      makeFixtureSource({
        files: [{ path: 'Extensions/TextObject/Extension.cpp', source: TEXTOBJECT_FIXTURE }],
      }),
    );
    const described = await describeInstructions(catalog, { type: 'TextObject::String' });
    assert.equal(described.found, true, `hint: ${described.hint ?? '(aucun)'}`);
    assert.ok(described.matches.some((entry) => entry.extension === 'TextObject' && entry.type === 'String'));
  });
});
