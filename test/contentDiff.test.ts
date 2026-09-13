import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentView } from '../src/contentView.js';
import { diffContentView } from '../src/contentDiff.js';

function blankView(): ContentView {
  return { scenes: [], globalObjects: [], globalVariables: {}, globalGroups: [], resources: [] };
}

function sceneView(name: string): ContentView['scenes'][number] {
  return { name, layers: [''], objects: [], instances: [], variables: {}, groups: [], events: [] };
}

describe('diffContentView (securite edition, ticket #17)', () => {
  it('rapporte un diff vide sur des vues identiques', () => {
    const before = blankView();
    const diff = diffContentView(before, structuredClone(before));
    assert.equal(diff.empty, true);
    assert.deepEqual(diff.scenes.added, []);
    assert.deepEqual(diff.scenes.removed, []);
  });

  it('detecte les scenes ajoutees et supprimees', () => {
    const before = blankView();
    const after = blankView();
    after.scenes.push(sceneView('Niveau1'));
    const diff = diffContentView(before, after);
    assert.equal(diff.empty, false);
    assert.deepEqual(diff.scenes.added, ['Niveau1']);
    assert.deepEqual(diff.scenes.removed, []);
    const back = diffContentView(after, before);
    assert.deepEqual(back.scenes.removed, ['Niveau1']);
  });

  it('detecte les variables globales et de scene modifiees', () => {
    const before = blankView();
    before.globalVariables = { score: 0 };
    before.scenes.push({ ...sceneView('N'), variables: { lives: 3 } });
    const after = structuredClone(before);
    after.globalVariables = { score: 10 };
    const scene = after.scenes[0];
    if (scene) scene.variables = {};
    const diff = diffContentView(before, after);
    assert.equal(diff.empty, false);
    assert.deepEqual(diff.variables.modified, ['global/score']);
    assert.deepEqual(diff.variables.removed, ['scene/N/lives']);
  });
});
