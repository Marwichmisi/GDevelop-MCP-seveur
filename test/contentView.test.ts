import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readContentView, type SerializedProject } from '../src/contentView.js';

const FIXTURE: SerializedProject = {
  variables: [
    { name: 'score', type: 'number', value: 0 },
    {
      name: 'pos',
      type: 'structure',
      children: [
        { name: 'x', type: 'number', value: 10 },
        { name: 'tags', type: 'array', children: [{ type: 'string', value: 'a' }] },
      ],
    },
  ],
  // Real engine shape: resources live in a container node.
  resources: { resources: [{ name: 'hero', kind: 'image', file: 'hero.png' }] },
  objects: [{ name: 'Global', type: 'Sprite', variables: [], behaviors: [] }],
  objectsGroups: [{ name: 'All', objects: [{ name: 'Global' }] }],
  layouts: [
    {
      name: 'Niveau1',
      layers: [{ name: '' }, { name: 'Sol' }],
      objects: [
        {
          name: 'Joueur',
          type: 'Sprite',
          variables: [{ name: 'vie', type: 'number', value: 3 }],
          behaviors: [{ name: 'Auto', type: 'PlatformBehavior::PlatformerObjectBehavior', Gravity: '1000' }],
        },
      ],
      instances: [
        {
          persistentUuid: 'uuid-1',
          name: 'Joueur',
          x: 100,
          y: 200,
          z: 0,
          layer: 'Sol',
          zOrder: 5,
          angle: 0,
          opacity: 255,
          customSize: false,
          width: 0,
          height: 0,
          initialVariables: [{ name: 'pv', type: 'number', value: 9 }],
        },
      ],
      variables: [{ name: 'timer', type: 'number', value: 60 }],
      objectsGroups: [{ name: 'Team', objects: [{ name: 'Joueur' }] }],
    },
  ],
};

describe('content view reader', () => {
  it('reconstructs nested variables to logical JSON values', () => {
    const view = readContentView(FIXTURE);
    assert.deepEqual(view.globalVariables, { score: 0, pos: { x: 10, tags: ['a'] } });
    assert.deepEqual(view.scenes[0]?.variables, { timer: 60 });
    assert.deepEqual(view.scenes[0]?.objects[0]?.variables, { vie: 3 });
    assert.deepEqual(view.scenes[0]?.instances[0]?.variables, { pv: 9 });
  });

  it('lists scenes with layers, objects, behaviors, instances and groups', () => {
    const view = readContentView(FIXTURE);
    assert.equal(view.scenes.length, 1);
    assert.deepEqual(view.scenes[0]?.layers, ['', 'Sol']);
    assert.equal(view.scenes[0]?.objects[0]?.name, 'Joueur');
    assert.deepEqual(view.scenes[0]?.objects[0]?.behaviors, [
      { name: 'Auto', type: 'PlatformBehavior::PlatformerObjectBehavior', properties: { Gravity: '1000' } },
    ]);
    assert.deepEqual(view.scenes[0]?.instances[0], {
      id: 'uuid-1',
      object: 'Joueur',
      x: 100,
      y: 200,
      z: 0,
      layer: 'Sol',
      zOrder: 5,
      angle: 0,
      opacity: 255,
      customSize: false,
      width: 0,
      height: 0,
      variables: { pv: 9 },
    });
    assert.deepEqual(view.scenes[0]?.groups, [{ name: 'Team', objects: ['Joueur'] }]);
  });

  it('lists global objects, groups and resources', () => {
    const view = readContentView(FIXTURE);
    assert.equal(view.globalObjects[0]?.name, 'Global');
    assert.deepEqual(view.globalGroups, [{ name: 'All', objects: ['Global'] }]);
    assert.deepEqual(view.resources, [{ name: 'hero', kind: 'image', file: 'hero.png' }]);
  });

  it('tolerates missing sections on hand-built states', () => {
    const view = readContentView({});
    assert.deepEqual(view, { scenes: [], globalObjects: [], globalVariables: {}, globalGroups: [], resources: [] });
  });

  it('also reads a flat resources array (fake state shape)', () => {
    const view = readContentView({ resources: [{ name: 'a', kind: 'audio', file: 'a.wav' }] });
    assert.deepEqual(view.resources, [{ name: 'a', kind: 'audio', file: 'a.wav' }]);
  });
});
