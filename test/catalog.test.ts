import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Catalog,
  describeCatalogFile,
  describeInstructions,
  fullTypeName,
  listInstructions,
  searchInstructions,
  type CatalogIndex,
} from '../src/catalog.js';
import { makeFixtureSource } from './catalogFixtures.js';

describe('catalogue registry (ticket #15)', () => {
  it('indexes instructions, types and extensions from the pinned snapshot', async () => {
    const catalog = new Catalog(makeFixtureSource());
    const index: CatalogIndex = await catalog.index();
    assert.equal(index.pin.ref, 'v5.6.282');
    assert.equal(index.pin.sha, 'abc123tree');
    assert.deepEqual(
      index.instructions.map((entry) => entry.type).sort(),
      ['ChangeDialogueBranch', 'ModVarScene', 'SetQuestDone', 'VariableBranch', 'VariableBranch', 'VariableString'],
    );
    assert.deepEqual(
      index.objectTypes.map((entry) => entry.type).sort(),
      ['DialogueTree::Companion', 'DialogueTree::Hero'],
    );
    assert.deepEqual(
      index.behaviorTypes.map((entry) => entry.type),
      ['DialogueTree::QuestTracker'],
    );
    assert.deepEqual(
      index.extensions.map((entry) => entry.name).sort(),
      ['BuiltinVariables', 'DialogueTree'],
    );
    const builtin = index.extensions.find((entry) => entry.name === 'BuiltinVariables');
    assert.equal(builtin?.instructions, 3 + 1); // ModVarScene + VariableString + dual pair
    const dialogue = index.extensions.find((entry) => entry.name === 'DialogueTree');
    assert.equal(dialogue?.objectTypes, 2);
    assert.deepEqual(dialogue?.eventsBasedObjects, ['DialogueTree::Companion']);
  });

  it('keeps the live registry for the TTL and rebuilds afterwards', async () => {
    let now = 1_000;
    const source = makeFixtureSource();
    const catalog = new Catalog(source, { ttlMs: 60_000, now: () => now });
    const first = await catalog.index();
    const second = await catalog.index();
    assert.equal(second, first);
    assert.equal(source.loads, 1);

    now += 60_001;
    const third = await catalog.index();
    assert.notEqual(third, first);
    assert.equal(source.loads, 2);
  });

  it('exposes a fresh pin and detects a stale pin via releases/latest', async () => {
    const fresh = new Catalog(makeFixtureSource({ ref: 'v5.6.282', latestRef: 'v5.6.282' }));
    const freshStatus = await fresh.status();
    assert.equal(freshStatus.stale, false);
    assert.equal(freshStatus.latestRef, 'v5.6.282');
    assert.equal(freshStatus.counts.instructions, 6);

    const staleSource = makeFixtureSource({ ref: 'v5.6.269', latestRef: 'v5.6.282' });
    const stale = new Catalog(staleSource);
    const staleStatus = await stale.status();
    assert.equal(staleStatus.stale, true);
    assert.equal(staleStatus.latestRef, 'v5.6.282');
    assert.match(staleStatus.reason, /newer GDevelop ref/);
    assert.equal(staleSource.latestChecks, 1);

    // The freshness check itself is cached for the TTL: no extra network call.
    await stale.status();
    assert.equal(staleSource.latestChecks, 1);
  });

  it('survives a failing freshness check without failing the status', async () => {
    const source = makeFixtureSource();
    source.latestReleaseRef = async () => {
      throw new Error('offline');
    };
    const catalog = new Catalog(source);
    const status = await catalog.status();
    assert.equal(status.latestRef, null);
    assert.equal(status.stale, false);
    assert.match(status.reason, /could not be checked/);
  });
});


describe('catalogue queries (ticket #15)', () => {
  it('answers instruction queries with the pinned versions exposed', async () => {
    const catalog = new Catalog(makeFixtureSource());

    const listed = await listInstructions(catalog, { kind: 'action' });
    assert.equal(listed.pin.ref, 'v5.6.282');
    assert.equal(listed.totalIndexed, 6);
    assert.equal(listed.matched, 3);
    assert.deepEqual(
      listed.instructions.map((entry) => entry.type).sort(),
      ['ChangeDialogueBranch', 'ModVarScene', 'SetQuestDone'],
    );

    const searched = await searchInstructions(catalog, { query: 'variable' });
    assert.deepEqual(searched.instructions.map((entry) => entry.type).sort(), [
      'ModVarScene',
      'VariableBranch',
      'VariableBranch',
      'VariableString',
    ]);

    const described = await describeInstructions(catalog, { type: 'VariableBranch' });
    assert.equal(described.found, true);
    assert.deepEqual(described.matches.map((entry) => entry.kind).sort(), ['condition', 'strExpression']);
    assert.equal(described.matches[0]?.parameters[0]?.type, 'scenevar');

    const missing = await describeInstructions(catalog, { type: 'Nope' });
    assert.equal(missing.found, false);
    assert.match(missing.hint ?? '', /list_instructions/);
  });

  it('answers type and extension queries with extension-scoped hints', async () => {
    const { describeBehavior, describeExtension, describeObject, listBehaviorTypes, listExtensions, listObjectTypes } =
      await import('../src/catalog.js');
    const catalog = new Catalog(makeFixtureSource());

    const objects = await listObjectTypes(catalog, { extension: 'DialogueTree' });
    assert.equal(objects.matched, 2);

    const described = await describeObject(catalog, { type: 'DialogueTree::Hero' });
    assert.equal(described.found, true);
    assert.equal(described.entry?.extension, 'DialogueTree');

    const shadowed = await describeObject(catalog, { type: 'DialogueTree::Missing' });
    assert.equal(shadowed.found, false);
    assert.deepEqual(shadowed.knownTypesInExtension?.sort(), ['DialogueTree::Companion', 'DialogueTree::Hero']);

    const behavior = await describeBehavior(catalog, { type: 'DialogueTree::QuestTracker' });
    assert.equal(behavior.found, true);

    const behaviors = await listBehaviorTypes(catalog, { query: 'quest' });
    assert.equal(behaviors.matched, 1);

    const extensions = await listExtensions(catalog, {});
    assert.deepEqual(
      extensions.extensions.map((entry) => entry.name).sort(),
      ['BuiltinVariables', 'DialogueTree'],
    );
    const extension = await describeExtension(catalog, { name: 'DialogueTree' });
    assert.equal(extension.found, true);
    assert.equal(extension.extension?.objectTypes, 2);
  });

  it('refuses invalid catalogue arguments and caps result sizes', async () => {
    const catalog = new Catalog(makeFixtureSource());
    await assert.rejects(listInstructions(catalog, { kind: 'not-a-kind' }));
    await assert.rejects(listInstructions(catalog, { limit: 10_000 }));
    const capped = await listInstructions(catalog, { limit: 2 });
    assert.equal(capped.instructions.length, 2);
    assert.equal(capped.matched, 6);
  });

  it('maps pinned paths to the right extension and language', () => {
    assert.deepEqual(describeCatalogFile('Extensions/DialogueTree/JsExtension.js'), {
      extension: 'DialogueTree',
      source: 'js',
    });
    assert.deepEqual(describeCatalogFile('Extensions/DialogueTree/dialoguetools.ts'), {
      extension: 'DialogueTree',
      source: 'js',
    });
    assert.deepEqual(describeCatalogFile('Core/GDCore/Extensions/Builtin/VariablesExtension.cpp'), {
      extension: 'Variables',
      source: 'cpp',
    });
    assert.deepEqual(describeCatalogFile('Core/GDCore/Extensions/Builtin/SpriteExtension/SpriteExtension.cpp'), {
      extension: 'Sprite',
      source: 'cpp',
    });
    assert.equal(describeCatalogFile('GDJS/Runtime/gd.js'), null);
    assert.equal(fullTypeName('DialogueTree', 'Hero'), 'DialogueTree::Hero');
    assert.equal(fullTypeName('DialogueTree', 'BuiltinAdvanced::X'), 'BuiltinAdvanced::X');
  });
});
