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
});
