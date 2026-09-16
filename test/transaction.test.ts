import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpError } from '../src/errors.js';
import { ProjectStore } from '../src/sessions.js';
import { createProject, type CommandDeps } from '../src/commands.js';
import { runTransaction, runTransactionSync } from '../src/transaction.js';
import { createFakeEngine } from './fakeEngine.js';
import type { FakeProject } from './fakeEngine.js';

function makeDeps(diags: { type: string; message: string }[] = []) {
  const engine = createFakeEngine({ initialDiagnostics: diags });
  const store = new ProjectStore(engine);
  return { store, engine };
}

function makeSession(deps: CommandDeps, name = 'Txn'): string {
  return createProject(deps, { name }).sessionId;
}

describe('module Transaction (seam runTransaction/Sync)', () => {
  it('committe une mutation sync et marque dirty', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const outcome = runTransactionSync(deps, sessionId, (ctx) => {
      deps.engine.createScene(ctx.project, 'Niveau1');
      return { name: 'Niveau1' };
    });
    assert.deepEqual(outcome.result, { name: 'Niveau1' });
    assert.equal(outcome.committed, true);
    assert.equal(outcome.dryRun, false);
    assert.equal(outcome.diff, null);
    assert.equal(deps.store.get(sessionId).dirty, true);
    assert.ok(deps.engine.describeContent(deps.store.get(sessionId).project).scenes.some((s) => s.name === 'Niveau1'));
  });

  it('capture le diff quand diff:true', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const outcome = runTransactionSync(
      deps,
      sessionId,
      (ctx) => {
        deps.engine.createScene(ctx.project, 'Niveau1');
        return 'ok';
      },
      { diff: true },
    );
    assert.ok(outcome.diff !== null);
    assert.deepEqual(outcome.diff.scenes.added, ['Niveau1']);
  });

  it('restaure mémoire + dirty quand le body throw', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const before = deps.engine.serializeProject(deps.store.get(sessionId).project);
    assert.throws(
      () =>
        runTransactionSync(deps, sessionId, (ctx) => {
          deps.engine.createScene(ctx.project, 'Fantome');
          throw new McpError('validation-failed', 'Boom.');
        }),
      (error: unknown) => error instanceof McpError && error.code === 'validation-failed',
    );
    assert.equal(deps.engine.serializeProject(deps.store.get(sessionId).project), before);
    assert.equal(deps.store.get(sessionId).dirty, false);
  });

  it('compense les fichiers : création supprimée, écrasement restauré', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const dir = mkdtempSync(join(tmpdir(), 'txn-'));
    const created = join(dir, 'nouveau.bin');
    const overwritten = join(dir, 'existant.bin');
    writeFileSync(overwritten, 'original');
    assert.throws(
      () =>
        runTransactionSync(deps, sessionId, (ctx) => {
          ctx.declareFile(created);
          writeFileSync(created, 'brouillon');
          ctx.declareFile(overwritten);
          writeFileSync(overwritten, 'écrasé');
          throw new McpError('validation-failed', 'Boom.');
        }),
      (error: unknown) => error instanceof McpError,
    );
    assert.equal(existsSync(created), false);
    assert.equal(readFileSync(overwritten, 'utf8'), 'original');
  });

  it('nettoie les compensations au succès', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const dir = mkdtempSync(join(tmpdir(), 'txn-'));
    const target = join(dir, 'asset.bin');
    writeFileSync(target, 'v1');
    runTransactionSync(deps, sessionId, (ctx) => {
      ctx.declareFile(target);
      writeFileSync(target, 'v2');
      return 'ok';
    });
    assert.equal(readFileSync(target, 'utf8'), 'v2');
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.includes('.txn-comp-')),
      [],
    );
  });

  it('dryRun : succès apparent, mémoire + dirty intacts', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const before = deps.engine.serializeProject(deps.store.get(sessionId).project);
    const outcome = runTransactionSync(
      deps,
      sessionId,
      (ctx) => {
        deps.engine.createScene(ctx.project, 'Ghost');
        return 3;
      },
      { dryRun: true, diff: true },
    );
    assert.equal(outcome.result, 3);
    assert.equal(outcome.dryRun, true);
    assert.ok(outcome.diff !== null);
    assert.deepEqual(outcome.diff.scenes.added, ['Ghost']);
    assert.equal(deps.engine.serializeProject(deps.store.get(sessionId).project), before);
    assert.equal(deps.store.get(sessionId).dirty, false);
  });

  it('gate round-trip : restaure quand le projet ne repasse plus', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    assert.throws(
      () =>
        runTransactionSync(deps, sessionId, (ctx) => {
          (ctx.project as FakeProject).failSerialize = true;
          return 'ok';
        }),
      (error: unknown) => error instanceof McpError && error.code === 'post-apply-failed',
    );
    (deps.store.get(sessionId).project as FakeProject).failSerialize = false;
    assert.equal(deps.store.get(sessionId).dirty, false);
  });

  it('gate zéro-nouvelle-erreur : restaure sur blocante introduite', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const before = deps.engine.serializeProject(deps.store.get(sessionId).project);
    assert.throws(
      () =>
        runTransactionSync(deps, sessionId, (ctx) => {
          deps.engine.createScene(ctx.project, 'Casse');
          deps.engine.diagnostics.push({ type: 'UnknownObject', message: 'Missing sprite.' });
          return 'ok';
        }),
      (error: unknown) =>
        error instanceof McpError && error.code === 'post-apply-failed' && /introduced blocking errors/.test(error.message),
    );
    // Le Snapshot restaure le projet (les diagnostics du fake sont un état
    // harness hors Snapshot : le gate a vu la blocante, le projet est revenu).
    assert.equal(deps.engine.serializeProject(deps.store.get(sessionId).project), before);
    assert.equal(deps.store.get(sessionId).dirty, false);
  });

  it('refuse une baseline bloquante sans flag, avant tout Snapshot', () => {
    const deps = makeDeps([{ type: 'UnknownObject', message: 'Deja casse.' }]);
    const sessionId = makeSession(deps);
    let ran = false;
    assert.throws(
      () =>
        runTransactionSync(deps, sessionId, () => {
          ran = true;
          return 'ok';
        }),
      (error: unknown) => error instanceof McpError && error.code === 'validation-failed',
    );
    assert.equal(ran, false);
    const outcome = runTransactionSync(deps, sessionId, () => 'ok', { allowInvalidBaseline: true });
    assert.equal(outcome.result, 'ok');
  });

  it('rejoint ambiant : inner sans Snapshot, outer committe une fois', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const outcome = runTransactionSync(deps, sessionId, (ctx) => {
      deps.engine.createScene(ctx.project, 'A');
      const inner = runTransactionSync(deps, sessionId, (innerCtx) => {
        innerCtx.declareFile(join(tmpdir(), 'txn-never-written.bin'));
        deps.engine.createScene(innerCtx.project, 'B');
        return 'inner';
      });
      assert.equal(inner.committed, false);
      return inner.result;
    });
    assert.equal(outcome.result, 'inner');
    assert.equal(outcome.committed, true);
    const names = deps.engine.describeContent(deps.store.get(sessionId).project).scenes.map((s) => s.name);
    assert.ok(names.includes('A') && names.includes('B'));
  });

  it('échec inner en rejoint : outer restaure tout', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const before = deps.engine.serializeProject(deps.store.get(sessionId).project);
    assert.throws(
      () =>
        runTransactionSync(deps, sessionId, (ctx) => {
          deps.engine.createScene(ctx.project, 'A');
          return runTransactionSync(deps, sessionId, () => {
            throw new McpError('validation-failed', 'Op 2 cassee.');
          }).result;
        }),
      (error: unknown) => error instanceof McpError && /Op 2 cassee/.test(error.message),
    );
    assert.equal(deps.engine.serializeProject(deps.store.get(sessionId).project), before);
    assert.equal(deps.store.get(sessionId).dirty, false);
  });

  it('refuse un work async dans le wrapper sync', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    assert.throws(
      () =>
        runTransactionSync(deps, sessionId, (() => Promise.resolve('nope')) as unknown as import('../src/transaction.js').TransactionWorkSync<string>),
      (error: unknown) => error instanceof McpError && error.code === 'validation-failed',
    );
    assert.equal(deps.store.get(sessionId).dirty, false);
  });

  it('cœur async : committe après await et compense en échec', async () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    const dir = mkdtempSync(join(tmpdir(), 'txn-'));
    const target = join(dir, 'async.bin');
    const outcome = await runTransaction(deps, sessionId, async (ctx) => {
      await Promise.resolve();
      ctx.declareFile(target);
      writeFileSync(target, 'v1');
      deps.engine.createScene(ctx.project, 'Async');
      return 'done';
    });
    assert.equal(outcome.result, 'done');
    assert.equal(outcome.committed, true);
    assert.equal(existsSync(target), true);

    const doomed = join(dir, 'doomed.bin');
    await assert.rejects(
      runTransaction(deps, sessionId, async (ctx) => {
        await Promise.resolve();
        ctx.declareFile(doomed);
        writeFileSync(doomed, 'x');
        throw new McpError('validation-failed', 'Async boom.');
      }),
      (error: unknown) => error instanceof McpError && error.code === 'validation-failed',
    );
    assert.equal(existsSync(doomed), false);
  });

  it('refuse readOnly et session inconnue avant tout write', () => {
    const deps = makeDeps();
    const sessionId = makeSession(deps);
    deps.store.get(sessionId).readOnly = true;
    assert.throws(
      () => runTransactionSync(deps, sessionId, () => 'ok'),
      (error: unknown) => error instanceof McpError && error.code === 'validation-failed',
    );
    assert.throws(
      () => runTransactionSync(deps, '00000000-0000-0000-0000-000000000000', () => 'ok'),
      (error: unknown) => error instanceof McpError && error.code === 'unknown-session',
    );
  });
});
