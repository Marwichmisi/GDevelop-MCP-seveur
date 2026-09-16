import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  identityI18n,
  loadProjectEventsFunctionsExtensions,
  makeLocalEventsFunctionCodeWriter,
} from '../src/eventsFunctionsLoader.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = any;

function makeGd(calls: string[]): AnyRecord {
  const ext = { deleteCalled: false };
  return {
    PlatformExtension: class {
      delete(): void {
        ext.deleteCalled = true;
      }
    },
    MetadataDeclarationHelper: {
      declareExtension(): void {
        calls.push('declare');
      },
      generateBehaviorMetadata: () => ({ addIncludeFile: () => {}, delete: () => {} }),
      generateObjectMetadata: () => ({ addIncludeFile: () => {}, delete: () => {} }),
      getExtensionCodeNamespacePrefix(): string {
        return 'Ext';
      },
      getFreeFunctionCodeName(_ext: unknown, fn: { getName(): string }): string {
        return `Ext::${fn.getName()}`;
      },
      getFreeFunctionCodeNamespace(fn: { getName(): string }, prefix: string): string {
        return `${prefix}${fn.getName()}`;
      },
      getBehaviorFunctionCodeNamespace(b: { getName(): string }, prefix: string): string {
        return `${prefix}${b.getName()}`;
      },
      getObjectFunctionCodeNamespace(o: { getName(): string }, prefix: string): string {
        return `${prefix}${o.getName()}`;
      },
    },
    MapStringString: class {
      delete(): void {}
    },
    SetString: class {
      toNewVectorString(): { toJSArray: () => string[]; delete: () => void } {
        return { toJSArray: () => [], delete: () => {} };
      }
      delete(): void {}
    },
    BehaviorCodeGenerator: class {
      constructor(_project: unknown) {}
      generateRuntimeBehaviorCompleteCode(): string {
        calls.push('behavior-code');
        return '// behavior';
      }
      delete(): void {}
    },
    ObjectCodeGenerator: class {
      constructor(_project: unknown) {}
      generateRuntimeObjectCompleteCode(): string {
        calls.push('object-code');
        return '// object';
      }
      delete(): void {}
    },
    EventsFunctionsExtensionCodeGenerator: class {
      constructor(_project: unknown) {}
      generateFreeEventsFunctionCompleteCode(): string {
        calls.push('free-code');
        return '// free';
      }
      delete(): void {}
    },
    MetadataDeclarationHelperInstance: class {
      generateFreeFunctionMetadata(): { addIncludeFile: () => void; delete: () => void } {
        return { addIncludeFile: () => {}, delete: () => {} };
      }
      delete(): void {}
    },
    JsPlatform: {
      get: () => ({
        addNewExtension(): void {
          calls.push('addExtension');
        },
      }),
    },
  };
}

function makeProject(): AnyRecord {
  return {
    getEventsFunctionsExtensionsCount: () => 1,
    getEventsFunctionsExtensionAt: () => ({
      getName: () => 'MyExt',
      getEventsFunctions: () => ({
        getEventsFunctionsCount: () => 1,
        getEventsFunctionAt: () => ({ getName: () => 'DoThing' }),
      }),
      getEventsBasedBehaviors: () => ({
        size: () => 1,
        at: () => ({ getName: () => 'MyBeh' }),
        delete: () => {},
      }),
      getEventsBasedObjects: () => ({
        size: () => 1,
        at: () => ({ getName: () => 'MyObj' }),
        delete: () => {},
      }),
    }),
  };
}

describe('events-functions loader Node (issue #19)', () => {
  it('i18n identite : jamais de traduction au chargement', () => {
    assert.equal(identityI18n('Hello'), 'Hello');
  });

  it('codeWriter fichier : 4 methodes, fichiers sous GDGeneratedEventsFunctions-<uid>', async () => {
    const seen: string[] = [];
    const writer = makeLocalEventsFunctionCodeWriter({
      onWriteFile: (f) => seen.push(f.includeFile),
    });
    assert.equal(typeof writer.getIncludeFileFor, 'function');
    assert.equal(typeof writer.writeFunctionCode, 'function');
    assert.equal(typeof writer.writeBehaviorCode, 'function');
    assert.equal(typeof writer.writeObjectCode, 'function');
    const dir = writer.getIncludeFileFor('MyNamespace');
    assert.match(dir, /GDGeneratedEventsFunctions-/);
    assert.match(dir, /mynamespace\.js$/);
    await writer.writeFunctionCode('MyNamespace', '// code');
    assert.equal(readFileSync(dir, 'utf8'), '// code');
    assert.deepEqual(
      seen.map((s) => s.endsWith('.js')),
      [true],
    );
  });

  it('deux passes metadata puis codegen : code genere une seule fois, extension ajoutee deux fois', async () => {
    const calls: string[] = [];
    const writer = {
      getIncludeFileFor: () => '/tmp/x.js',
      writeFunctionCode: () => Promise.resolve(),
      writeBehaviorCode: () => Promise.resolve(),
      writeObjectCode: () => Promise.resolve(),
    };
    await loadProjectEventsFunctionsExtensions(makeGd(calls), makeProject(), writer, identityI18n);
    assert.deepEqual(
      calls.filter((c) => c === 'addExtension'),
      ['addExtension', 'addExtension'],
    );
    assert.equal(calls.filter((c) => c === 'free-code').length, 1);
    assert.equal(calls.filter((c) => c === 'behavior-code').length, 1);
    assert.equal(calls.filter((c) => c === 'object-code').length, 1);
  });

  it('sans extension : ne fait rien (pas derreur, pas decriture)', async () => {
    const calls: string[] = [];
    let writes = 0;
    const writer = {
      getIncludeFileFor: () => '/tmp/x.js',
      writeFunctionCode: () => {
        writes++;
        return Promise.resolve();
      },
      writeBehaviorCode: () => {
        writes++;
        return Promise.resolve();
      },
      writeObjectCode: () => {
        writes++;
        return Promise.resolve();
      },
    };
    const empty = {
      getEventsFunctionsExtensionsCount: () => 0,
      getEventsFunctionsExtensionAt: () => {
        throw new Error('must not be called');
      },
    };
    await loadProjectEventsFunctionsExtensions(makeGd(calls), empty, writer, identityI18n);
    assert.deepEqual(calls, []);
    assert.equal(writes, 0);
  });

  it('erreur codegen : extension delete() quand meme (discipline memoire)', async () => {
    let deleted = false;
    const gd = makeGd([]);
    gd.PlatformExtension = class {
      delete(): void {
        deleted = true;
      }
    };
    gd.EventsFunctionsExtensionCodeGenerator = class {
      constructor(_project: unknown) {}
      generateFreeEventsFunctionCompleteCode(): string {
        throw new Error('codegen boom');
      }
      delete(): void {}
    };
    await assert.rejects(() =>
      loadProjectEventsFunctionsExtensions(
        gd,
        makeProject(),
        {
          getIncludeFileFor: () => '/tmp/x.js',
          writeFunctionCode: () => Promise.resolve(),
          writeBehaviorCode: () => Promise.resolve(),
          writeObjectCode: () => Promise.resolve(),
        },
        identityI18n,
      ),
    );
    assert.equal(deleted, true);
  });
});
