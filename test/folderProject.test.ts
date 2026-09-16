import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFERENCE_MAGIC_PROPERTY,
  folderSplitOptions,
  getSlugifiedUniqueNameFromProperty,
  isFolderProjectJson,
  shouldSplitPath,
  slugifyName,
  splitProjectObject,
  unsplitProjectObject,
} from '../src/folderProject.js';

describe('folder-project split/unsplit (recette ObjectSplitter + gdcore-tools)', () => {
  it('splitPathsSet exact : seuls /<dossier>/* splittent', () => {
    for (const folder of ['layouts', 'externalLayouts', 'externalEvents', 'eventsFunctionsExtensions']) {
      assert.equal(shouldSplitPath(`/${folder}/*`), true);
    }
    assert.equal(shouldSplitPath('/layouts'), false);
    assert.equal(shouldSplitPath('/layouts/*'), true);
    assert.equal(shouldSplitPath('/layouts/*/events'), false);
    assert.equal(shouldSplitPath('/objects/*'), false);
    assert.equal(shouldSplitPath('/properties'), false);
  });

  it('split remplace les layouts par des references slugifiees, unsplit profondeur 3 les restaure', async () => {
    const project: Record<string, unknown> = {
      properties: { name: 'G', folderProject: true },
      layouts: [
        { name: 'Scene One', events: [{ type: 'Standard' }] },
        { name: 'Scene One', events: [] },
      ],
      objects: [{ name: 'Kept' }],
    };
    const partials = splitProjectObject(project, folderSplitOptions());
    assert.equal(partials.length, 2);
    assert.deepEqual(
      partials.map((p) => p.reference).sort(),
      ['/layouts/scene-one', '/layouts/scene-one2'],
    );
    for (const layout of project['layouts'] as Record<string, unknown>[]) {
      assert.equal(layout[REFERENCE_MAGIC_PROPERTY], true);
      assert.equal(typeof layout['referenceTo'], 'string');
    }
    assert.equal((project['objects'] as unknown[]).length, 1);
    const byRef = new Map(partials.map((p) => [p.reference, p.object]));
    await unsplitProjectObject(project, {
      isReferenceMagicPropertyName: REFERENCE_MAGIC_PROPERTY,
      getReferencePartialObject: (ref: string) => Promise.resolve(byRef.get(ref)),
      maxUnsplitDepth: 3,
    });
    assert.equal((project['layouts'] as unknown[]).length, 2);
    assert.equal((project['layouts'] as { name: string }[])[0]?.['name'], 'Scene One');
  });

  it('slugifie comme slugs (accents, casse, ponctuation) et unicifie', () => {
    assert.equal(slugifyName('Scene One'), 'scene-one');
    assert.equal(slugifyName('Événements Spéciaux!'), 'evenements-speciaux');
    assert.equal(slugifyName('---'), 'item');
    const namer = getSlugifiedUniqueNameFromProperty('name');
    assert.equal(namer({ name: 'A' }, '/layouts'), 'a');
    assert.equal(namer({ name: 'A' }, '/layouts'), 'a2');
    assert.equal(namer({ name: 'A' }, '/externalLayouts'), 'a');
    assert.throws(() => namer({ name: 3 } as unknown as Record<string, unknown>, '/layouts'), /not a string/);
  });

  it('unsplit respecte maxUnsplitDepth (profondeur 0 = rien)', async () => {
    const project: Record<string, unknown> = {
      layouts: [{ [REFERENCE_MAGIC_PROPERTY]: true, referenceTo: '/layouts/a' }],
    };
    let calls = 0;
    await unsplitProjectObject(project, {
      isReferenceMagicPropertyName: REFERENCE_MAGIC_PROPERTY,
      getReferencePartialObject: () => {
        calls++;
        return Promise.resolve({ name: 'A' });
      },
      maxUnsplitDepth: 0,
    });
    assert.equal(calls, 0);
  });

  it('detecte un folder-project via properties.folderProject', () => {
    assert.equal(isFolderProjectJson({ properties: { folderProject: true } }), true);
    assert.equal(isFolderProjectJson({ properties: { folderProject: false } }), false);
    assert.equal(isFolderProjectJson({ properties: {} }), false);
    assert.equal(isFolderProjectJson({}), false);
    assert.equal(isFolderProjectJson(null), false);
  });
});
