import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRealEngine } from '../src/runtime.js';
import type { EngineProject } from '../src/engine.js';

/**
 * #35 — listDiagnostics lit le rapport à deux niveaux.
 * Le moteur retourne un WholeProjectDiagnosticReport qui compte des
 * sous-rapports par scène (getSceneName/count/get(j)), chacun portant les
 * vrais ProjectDiagnostic (getType/getMessage). L'ancien code lisait
 * get(i).getType() au premier niveau et levait
 * `diagnostic.getType is not a function` dès qu'un rapport était non vide
 * (y compris un sous-rapport vide transitoire post-export).
 */

function makeGd() {
  return {
    _emscripten_enum_ProjectDiagnostic_ErrorType_UndeclaredVariable: 0,
    _emscripten_enum_ProjectDiagnostic_ErrorType_MissingBehavior: 1,
    _emscripten_enum_ProjectDiagnostic_ErrorType_UnknownObject: 2,
    _emscripten_enum_ProjectDiagnostic_ErrorType_MismatchedObjectType: 3,
  } as unknown as Parameters<typeof createRealEngine>[0];
}

function makeProject(report: unknown): EngineProject {
  return {
    delete() {},
    getWholeProjectDiagnosticReport: () => report,
  } as unknown as EngineProject;
}

function wholeReport(scenes: { name: string; diags: { type: number; message: string }[] }[]): unknown {
  return {
    delete() {},
    count: () => scenes.length,
    get: (i: number) => {
      const scene = scenes[i] as { name: string; diags: { type: number; message: string }[] };
      return {
        getSceneName: () => scene.name,
        count: () => scene.diags.length,
        get: (j: number) => {
          const diag = scene.diags[j] as { type: number; message: string };
          return {
            getType: () => diag.type,
            getMessage: () => diag.message,
          };
        },
      };
    },
  };
}

describe('#35 listDiagnostics à deux niveaux', () => {
  it('retourne [] sur rapport vide (pas de régression)', () => {
    const engine = createRealEngine(makeGd());
    const found = engine.listDiagnostics(makeProject(wholeReport([])));
    assert.deepEqual(found, []);
  });

  it('retourne [] sur sous-rapport vide transitoire post-export, sans lever', () => {
    const engine = createRealEngine(makeGd());
    const found = engine.listDiagnostics(makeProject(wholeReport([{ name: 'Niveau1', diags: [] }])));
    assert.deepEqual(found, []);
  });

  it('lit scène, type et message sur rapport non vide', () => {
    const engine = createRealEngine(makeGd());
    const found = engine.listDiagnostics(
      makeProject(
        wholeReport([{ name: 'Niveau1', diags: [{ type: 2, message: 'Unknown object Coin.' }] }]),
      ),
    );
    assert.equal(found.length, 1);
    assert.equal(found[0]?.type, 'UnknownObject');
    assert.equal(found[0]?.message, 'Unknown object Coin.');
    assert.equal(found[0]?.scene, 'Niveau1');
  });

  it('mappe les types inconnus sans lever', () => {
    const engine = createRealEngine(makeGd());
    const found = engine.listDiagnostics(
      makeProject(wholeReport([{ name: 'Niveau1', diags: [{ type: 99, message: 'Futur.' }] }])),
    );
    assert.equal(found[0]?.type, 'UnknownDiagnosticType(99)');
  });

  it('retourne [] quand le rapport transitoire lève sur count/get, sans lever', () => {
    const engine = createRealEngine(makeGd());
    const hostile = {
      delete() {},
      count: () => {
        throw new TypeError('transitoire');
      },
      get: (_i: number): unknown => {
        throw new TypeError('transitoire');
      },
    };
    assert.deepEqual(engine.listDiagnostics(makeProject(hostile)), []);
  });
});
