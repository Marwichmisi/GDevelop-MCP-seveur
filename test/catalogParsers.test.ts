import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyReceiver,
  detectEventsBasedDeclarations,
  extractString,
  parseExtensionSource,
} from '../src/catalogParsers.js';
import { FIXTURE_CPP, FIXTURE_JS, FIXTURE_TS } from './catalogFixtures.js';

describe('catalogue parsers (ticket #15)', () => {
  it('parses C++ actions, expressions and chained parameters', () => {
    const parsed = parseExtensionSource(FIXTURE_CPP);
    assert.equal(parsed.name, 'BuiltinVariables');
    assert.equal(parsed.fullName, 'Variables');

    const action = parsed.instructions.find((entry) => entry.type === 'ModVarScene');
    assert.ok(action);
    assert.equal(action.kind, 'action');
    assert.equal(action.fullName, 'Modify the value of a scene variable');
    assert.equal(action.description, 'Change the value of the specified scene variable.');
    assert.deepEqual(
      action.parameters.map((parameter) => parameter.type),
      ['scenevar', 'operator', 'expression'],
    );
    assert.equal(action.receiver, 'extension');
  });

  it('expands expression-and-condition duals into mirrored entries sharing parameters', () => {
    const parsed = parseExtensionSource(FIXTURE_CPP);
    const entries = parsed.instructions.filter((entry) => entry.type === 'VariableBranch');
    assert.deepEqual(entries.map((entry) => entry.kind).sort(), ['condition', 'strExpression']);
    for (const entry of entries) {
      assert.deepEqual(
        entry.parameters.map((parameter) => [parameter.type, parameter.description]),
        [['scenevar', 'Variable']],
      );
    }
  });

  it('parses JS actions, object/behavior declarations and code-only parameters', () => {
    const parsed = parseExtensionSource(FIXTURE_JS);
    assert.equal(parsed.name, 'DialogueTree');

    const action = parsed.instructions.find((entry) => entry.type === 'ChangeDialogueBranch');
    assert.ok(action);
    assert.equal(action?.kind, 'action');
    assert.deepEqual(
      action?.parameters.map((parameter) => ({ type: parameter.type, optional: parameter.optional })),
      [
        { type: 'scenevar', optional: false },
        { type: 'currentScene', optional: false },
      ],
    );

    const scoped = parsed.instructions.find((entry) => entry.type === 'SetQuestDone');
    assert.equal(scoped?.receiver, 'hero');
    assert.deepEqual(
      scoped?.parameters.map((parameter) => [parameter.type, parameter.extraInfo]),
      [['object', 'Hero']],
    );

    const declarations = parsed.typeDeclarations;
    const object = declarations.find((entry) => entry.kind === 'object');
    assert.equal(object?.name, 'Hero');
    const behavior = declarations.find((entry) => entry.kind === 'behavior');
    assert.equal(behavior?.name, 'QuestTracker');
  });

  it('flags chained parameters of one declaration onto the right instruction', () => {
    const parsed = parseExtensionSource(FIXTURE_CPP);
    const strExpression = parsed.instructions.find((entry) => entry.type === 'VariableString');
    assert.equal(strExpression?.kind, 'strExpression');
    assert.deepEqual(
      strExpression?.parameters.map((parameter) => parameter.type),
      ['scenevar'],
    );
  });

  it('detects events-based markers in TS sources', () => {
    const declarations = detectEventsBasedDeclarations(FIXTURE_TS);
    assert.deepEqual(declarations, [{ name: 'Companion', kind: 'eventsBasedObject' }]);
  });

  it('unpacks plain, i18n and template strings', () => {
    assert.equal(extractString('"plain"'), 'plain');
    assert.equal(extractString("'single'"), 'single');
    assert.equal(extractString('_("i18n")'), 'i18n');
    assert.equal(extractString("_('i18n-single')"), 'i18n-single');
    assert.equal(extractString('`template`'), 'template');
    assert.equal(extractString('not-a-string'), undefined);
  });

  it('classifies receiver tokens into kinds', () => {
    assert.equal(classifyReceiver('extension'), 'extension');
    assert.equal(classifyReceiver('obj'), 'object');
    assert.equal(classifyReceiver('aut'), 'behavior');
    assert.equal(classifyReceiver('spriteRuntimeObject'), 'object');
    assert.equal(classifyReceiver('platformerBehavior'), 'behavior');
    assert.equal(classifyReceiver(undefined), 'unknown');
    assert.equal(classifyReceiver('foo'), 'unknown');
  });

  it('1.1 #31: parses C++ AddObject<T> template declarations (Sprite, Text)', () => {
    const source = `
namespace gd {
void ImplementsSpriteExtension(gd::PlatformExtension& extension) {
  extension.SetExtensionInformation("Sprite", "Sprite", "Sprites.", "Florian", "MIT");
  gd::ObjectMetadata& obj =
      extension
          .AddObject<SpriteObject>("Sprite",
                                   _("Sprite"),
                                   _("Animated object."),
                                   "CppPlatform/Extensions/spriteicon.png");
}
void DeclareTextObjectExtension(gd::PlatformExtension& extension) {
  extension.SetExtensionInformation("TextObject", "Text object", "Text.", "Florian", "MIT");
  gd::ObjectMetadata& obj =
      extension
          .AddObject<TextObject>("Text",
                                 _("Text"),
                                 _("Displays text."),
                                 "CppPlatform/Extensions/texticon.png");
}
}  // namespace gd
`;
    const parsed = parseExtensionSource(source);
    const names = parsed.typeDeclarations.map((entry) => entry.name).sort();
    assert.deepEqual(names, ['Sprite', 'Text']);
    assert.ok(parsed.typeDeclarations.every((entry) => entry.kind === 'object'));
  });

  it('1.1 #31: exposes real engine arity for UseStandardRelationalOperatorParameters (VarScene x3)', () => {
    const source = `
namespace gd {
void ImplementsVariablesExtension(gd::PlatformExtension& extension) {
  extension.SetExtensionInformation("BuiltinVariables", "Variables", "Vars.", "Florian", "MIT");
  extension
      .AddCondition("VarScene",
                    _("Number variable"),
                    _("Compare the number value of a scene variable."),
                    _("The number of scene variable _PARAM0_"),
                    _("Scene variables"),
                    "res/conditions/var24.png",
                    "res/conditions/var.png")
      .AddParameter("scenevar", _("Variable"))
      .UseStandardRelationalOperatorParameters(
          "number", ParameterOptions::MakeNewOptions());
}
}  // namespace gd
`;
    const parsed = parseExtensionSource(source);
    const cond = parsed.instructions.find((entry) => entry.type === 'VarScene');
    assert.ok(cond);
    assert.deepEqual(
      cond.parameters.map((parameter) => parameter.type),
      ['scenevar', 'relationalOperator', 'number'],
    );
  });

  it('1.1 #31: exposes real engine arity for UseStandardOperatorParameters (ModVarScene x3)', () => {
    const source = `
namespace gd {
void ImplementsVariablesExtension(gd::PlatformExtension& extension) {
  extension.SetExtensionInformation("BuiltinVariables", "Variables", "Vars.", "Florian", "MIT");
  extension
      .AddAction("ModVarScene",
                 _("Change number variable"),
                 _("Modify the number value of a scene variable."),
                 _("the scene variable _PARAM0_"),
                 _("Scene variables"),
                 "res/actions/var24.png",
                 "res/actions/var.png")
      .AddParameter("scenevar", _("Variable"))
      .UseStandardOperatorParameters("number",
                                     ParameterOptions::MakeNewOptions());
}
}  // namespace gd
`;
    const parsed = parseExtensionSource(source);
    const action = parsed.instructions.find((entry) => entry.type === 'ModVarScene');
    assert.ok(action);
    assert.deepEqual(
      action.parameters.map((parameter) => parameter.type),
      ['scenevar', 'operator', 'number'],
    );
  });

  it('1.1 #31: UseStandardParameters feeds condition/action but not the expression (FontSize)', () => {
    const source = `
namespace gd {
void DeclareTextObjectExtension(gd::PlatformExtension& extension) {
  extension.SetExtensionInformation("TextObject", "Text object", "Text.", "Florian", "MIT");
  gd::ObjectMetadata& obj = extension.AddObject<TextObject>("Text", _("Text"), _("Displays text."), "icon.png");
  obj.AddExpressionAndConditionAndAction("number", "FontSize",
                                        _("Font size"),
                                        _("the font size of a text object"),
                                        _("the font size"),
                                        "", "res/conditions/characterSize24.png")
      .AddParameter("object", _("Object"), "Text")
      .UseStandardParameters("number", gd::ParameterOptions::MakeNewOptions());
}
}  // namespace gd
`;
    const parsed = parseExtensionSource(source);
    const expression = parsed.instructions.find(
      (entry) => entry.type === 'FontSize' && entry.kind === 'expression',
    );
    const condition = parsed.instructions.find(
      (entry) => entry.type === 'FontSize' && entry.kind === 'condition',
    );
    const action = parsed.instructions.find((entry) => entry.type === 'FontSize' && entry.kind === 'action');
    assert.ok(expression && condition && action);
    assert.deepEqual(
      expression.parameters.map((parameter) => parameter.type),
      ['object'],
    );
    assert.deepEqual(
      condition.parameters.map((parameter) => parameter.type),
      ['object', 'relationalOperator', 'number'],
    );
    assert.deepEqual(
      action.parameters.map((parameter) => parameter.type),
      ['object', 'operator', 'number'],
    );
  });

  it('1.1 #31: JS useStandardRelationalOperatorParameters expands too (TileMap style)', () => {
    const source = `
module.exports = {
  createExtension: function (_, gd) {
    const extension = new gd.PlatformExtension();
    extension.setExtensionInformation('TileMap', _('Tile Map'), _('Tiles.'), 'GDevelop', 'MIT');
    extension.addCondition('CompareTileSize',
                           _('Tile size'),
                           _('Compare tile size.'),
                           _('the tile size'),
                           '', 'res/conditions/tile.png', 'res/conditions/tile.png')
      .addParameter('object', _('Object'), 'TileMap::TileMap', false)
      .useStandardRelationalOperatorParameters('number', gd.ParameterOptions.makeNewOptions());
  },
};
`;
    const parsed = parseExtensionSource(source);
    const cond = parsed.instructions.find((entry) => entry.type === 'CompareTileSize');
    assert.ok(cond);
    assert.deepEqual(
      cond.parameters.map((parameter) => parameter.type),
      ['object', 'relationalOperator', 'number'],
    );
  });
});
