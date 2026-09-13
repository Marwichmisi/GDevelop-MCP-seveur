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
  it('detecte les objets, instances et evenements modifies', () => {
    const before = blankView();
    const scene = sceneView('N');
    scene.objects.push({ name: 'Joueur', type: 'Sprite', behaviors: [], variables: {} });
    scene.instances.push({
      id: 'i1',
      object: 'Joueur',
      x: 0,
      y: 0,
      z: 0,
      layer: '',
      zOrder: 0,
      angle: 0,
      opacity: 255,
      customSize: false,
      width: 0,
      height: 0,
      variables: {},
    });
    scene.events.push({ id: 'e1', kind: 'standard', disabled: false, conditions: [], actions: [], events: [] });
    before.scenes.push(scene);
    const after = structuredClone(before);
    const afterScene = after.scenes[0];
    if (!afterScene) throw new Error('missing scene');
    const player = afterScene.objects[0];
    if (player) player.variables = { hp: 3 };
    const inst = afterScene.instances[0];
    if (inst) inst.x = 42;
    const evt = afterScene.events[0];
    if (evt) evt.disabled = true;
    const diff = diffContentView(before, after);
    assert.deepEqual(diff.objects.modified, ['scene/N/Joueur']);
    assert.deepEqual(diff.instances.modified, ['scene/N/i1']);
    assert.deepEqual(diff.events.modified, ['scene/N/0:e1']);
    const back = diffContentView(after, before);
    assert.equal(back.empty, false);
  });

  it('detecte les groupes et ressources ajoutees', () => {
    const before = blankView();
    const after = blankView();
    after.globalGroups.push({ name: 'Ennemis', objects: ['Blob'] });
    after.resources.push({ name: 'hero.png', kind: 'image', file: 'hero.png' });
    const diff = diffContentView(before, after);
    assert.deepEqual(diff.groups.added, ['global/Ennemis']);
    assert.deepEqual(diff.resources.added, ['hero.png']);
  });
