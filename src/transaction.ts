import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { diffContentView, type ContentDiff } from './contentDiff.js';
import {
  formatDiagnostics,
  isBlockingDiagnostic,
  type EnginePorts,
  type EngineProject,
} from './engine.js';
import { McpError, validationFailed } from './errors.js';
import type { ProjectStore, Session } from './sessions.js';

/**
 * Transaction (module profond) : exécution atomique d'une ou plusieurs Ops de
 * contenu sur une Session projet. Seul propriétaire du Snapshot mémoire, de la
 * compensation fichiers et des gates (round-trip + zéro-nouvelle-erreur).
 *
 * Remplace le triplon pipeline.ts / batch.ts / assets.ts : un seul seam,
 * un cœur async + un wrapper sync qui partagent la même implementation.
 * Tout est in-process (mémoire + fs local) : aucun adapter injecté, les tests
 * traversent ce seam avec le moteur fake et un dossier temporaire réel.
 */

export interface TransactionDeps {
  store: ProjectStore;
  engine: EnginePorts;
}

export interface TransactionOptions {
  /** Rejoue tout puis restaure : résumés + diff sans mutation ni dirty. */
  dryRun?: boolean | undefined;
  /** Tolère une baseline déjà bloquante (défaut : refus avant tout Snapshot). */
  allowInvalidBaseline?: boolean | undefined;
  /** Capture describeContent avant/après + diff sémantique. */
  diff?: boolean | undefined;
}

export interface TransactionContext {
  session: Session;
  project: EngineProject;
  /** Déclare une sortie fichier AVANT de l'écrire ; le module la compense. */
  declareFile(path: string): void;
}

export interface TransactionOutcome<T> {
  result: T;
  /** Faux quand l'appel a rejoint une Transaction ambiante (l'externe committe). */
  committed: boolean;
  dryRun: boolean;
  /** Non-null ssi options.diff (et appel externe, jamais en rejoint). */
  diff: ContentDiff | null;
}

export type TransactionWork<T> = (ctx: TransactionContext) => T | Promise<T>;
export type TransactionWorkSync<T> = (ctx: TransactionContext) => T;

interface TrackedFile {
  path: string;
  existed: boolean;
  compensationPath: string | null;
}

interface Ambient {
  ctx: TransactionContext;
  tracked: TrackedFile[];
  dryRun: boolean;
}

/** Transactions ambiantes par session : un appel rejoint au lieu d'imbriquer. */
const ambientBySession = new Map<string, Ambient>();

function diagnosticKey(diagnostic: { type: string; message: string }): string {
  return `${diagnostic.type}::${diagnostic.message}`;
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then: unknown }).then === 'function'
  );
}

function declareFileInto(tracked: TrackedFile[], path: string): void {
  if (tracked.some((entry) => entry.path === path)) return;
  if (!existsSync(path)) {
    tracked.push({ path, existed: false, compensationPath: null });
    return;
  }
  const compensationPath = `${path}.txn-comp-${process.pid}-${Date.now()}`;
  writeFileSync(compensationPath, readFileSync(path));
  tracked.push({ path, existed: true, compensationPath });
}

function rollbackFiles(tracked: TrackedFile[]): void {
  for (let i = tracked.length - 1; i >= 0; i -= 1) {
    const file = tracked[i];
    if (!file) continue;
    try {
      if (!file.existed) {
        if (existsSync(file.path)) unlinkSync(file.path);
      } else if (file.compensationPath !== null && existsSync(file.compensationPath)) {
        writeFileSync(file.path, readFileSync(file.compensationPath));
        unlinkSync(file.compensationPath);
      }
    } catch {
      // Best effort : la restauration mémoire reste la garantie d'atomicité.
    }
  }
}

function cleanupCompensations(tracked: TrackedFile[]): void {
  for (const file of tracked) {
    if (file.compensationPath !== null) {
      try {
        if (existsSync(file.compensationPath)) unlinkSync(file.compensationPath);
      } catch {
        // Best effort.
      }
    }
  }
}

interface OpenedOuter {
  session: Session;
  baselineKeys: Set<string>;
  snapshot: string;
  wasDirty: boolean;
  before: ReturnType<EnginePorts['describeContent']> | null;
  tracked: TrackedFile[];
  ctx: TransactionContext;
  isDryRun: boolean;
  wantDiff: boolean;
}

/** Étage pré-transaction : lectures seules avant le premier write. */
function openOuter(deps: TransactionDeps, sessionId: string, options: TransactionOptions | undefined): OpenedOuter {
  const opts = options ?? {};
  const isDryRun = opts.dryRun === true;
  const wantDiff = opts.diff === true;
  const session = deps.store.get(sessionId);
  if (session.readOnly === true) {
    throw validationFailed(
      `Session ${sessionId} is read-only (example opened in read mode): describe only, no mutation, no save.`,
    );
  }
  let baselineBlocking;
  let snapshot: string;
  let before: ReturnType<EnginePorts['describeContent']> | null = null;
  try {
    baselineBlocking = deps.engine.listDiagnostics(session.project).filter(isBlockingDiagnostic);
    if (wantDiff) before = deps.engine.describeContent(session.project);
    snapshot = deps.engine.serializeProject(session.project);
  } catch (error) {
    throw new McpError(
      'post-apply-failed',
      `Transaction failed before any op ran (${error instanceof Error ? error.message : String(error)}); nothing was applied.`,
      { cause: error },
    );
  }
  if (baselineBlocking.length > 0 && opts.allowInvalidBaseline !== true) {
    throw validationFailed(
      `Refusing transaction: project baseline has blocking errors (${formatDiagnostics(baselineBlocking)}). Pass allowInvalidBaseline:true to override.`,
    );
  }
  const tracked: TrackedFile[] = [];
  const ctx: TransactionContext = {
    session,
    project: session.project,
    declareFile: (path: string) => declareFileInto(tracked, path),
  };
  return {
    session,
    baselineKeys: new Set(baselineBlocking.map(diagnosticKey)),
    snapshot,
    wasDirty: session.dirty,
    before,
    tracked,
    ctx,
    isDryRun,
    wantDiff,
  };
}

function restoreMemory(deps: TransactionDeps, opened: OpenedOuter): void {
  deps.engine.restoreProject(opened.session.project, opened.snapshot);
  if (opened.wasDirty) deps.store.markDirty(opened.session.id);
  else deps.store.clearDirty(opened.session.id);
}

function undoEverything(deps: TransactionDeps, opened: OpenedOuter): void {
  rollbackFiles(opened.tracked);
  restoreMemory(deps, opened);
}

function failureSuffix(dryRun: boolean): string {
  return dryRun ? '; dry-run changes were discarded' : '; everything was restored';
}

/** Gates partagés : round-trip, zéro-nouvelle-erreur, diff, dryRun, dirty. */
function commitGates<T>(deps: TransactionDeps, opened: OpenedOuter, result: T): TransactionOutcome<T> {
  try {
    deps.engine.updateBehaviorsSharedData(opened.session.project);
  } catch (error) {
    undoEverything(deps, opened);
    if (error instanceof McpError) throw error;
    throw new McpError(
      'post-apply-failed',
      `Transaction failed after apply (${error instanceof Error ? error.message : String(error)}); everything was restored.`,
      { cause: error },
    );
  }
  try {
    const serialized = deps.engine.serializeProject(opened.session.project);
    const reparsed = deps.engine.loadProjectFromJson(serialized, '');
    reparsed.delete();
  } catch (error) {
    undoEverything(deps, opened);
    throw new McpError(
      'post-apply-failed',
      `Transaction produced a project that no longer round-trips${failureSuffix(opened.isDryRun)}.`,
      { cause: error },
    );
  }

  const newBlocking = deps.engine
    .listDiagnostics(opened.session.project)
    .filter((d) => !opened.baselineKeys.has(diagnosticKey(d)) && isBlockingDiagnostic(d));
  if (newBlocking.length > 0) {
    undoEverything(deps, opened);
    throw new McpError(
      'post-apply-failed',
      `Transaction introduced blocking errors (${formatDiagnostics(newBlocking)})${failureSuffix(opened.isDryRun)}.`,
    );
  }

  let diff: ContentDiff | null = null;
  if (opened.wantDiff) {
    const after = deps.engine.describeContent(opened.session.project);
    diff = diffContentView(opened.before as ReturnType<EnginePorts['describeContent']>, after);
  }

  if (opened.isDryRun) {
    undoEverything(deps, opened);
    return { result, committed: true, dryRun: true, diff };
  }
  cleanupCompensations(opened.tracked);
  deps.store.markDirty(opened.session.id);
  return { result, committed: true, dryRun: false, diff };
}

/**
 * Cœur async : rejoint la Transaction ambiante de la session quand il y en a
 * une (le batch rejoue ses Ops granulaires dedans), sinon ouvre une externe.
 * En rejoint, le body s'exécute sans Snapshot ni gates : l'externe committe.
 */
export async function runTransaction<T>(
  deps: TransactionDeps,
  sessionId: string,
  body: TransactionWork<T>,
  options?: TransactionOptions,
): Promise<TransactionOutcome<T>> {
  const ambient = ambientBySession.get(sessionId);
  if (ambient !== undefined) {
    const result = (await body(ambient.ctx)) as T;
    return { result, committed: false, dryRun: ambient.dryRun, diff: null };
  }
  const opened = openOuter(deps, sessionId, options);
  ambientBySession.set(sessionId, { ctx: opened.ctx, tracked: opened.tracked, dryRun: opened.isDryRun });
  try {
    const result = (await body(opened.ctx)) as T;
    return commitGates(deps, opened, result);
  } catch (error) {
    // Échec du body ou gate déjà restauré par commitGates (idempotent) :
    // restaure puis rejoue l'erreur d'origine telle quelle ; l'appelant
    // l'enrichit (contexte op, import) avec son vocabulaire.
    undoEverything(deps, opened);
    throw error;
  } finally {
    ambientBySession.delete(sessionId);
  }
}

/** Wrapper sync : même seam, mêmes gates ; un work async y est refusé. */
export function runTransactionSync<T>(
  deps: TransactionDeps,
  sessionId: string,
  body: TransactionWorkSync<T>,
  options?: TransactionOptions,
): TransactionOutcome<T> {
  const ambient = ambientBySession.get(sessionId);
  if (ambient !== undefined) {
    const result = body(ambient.ctx);
    if (isThenable(result)) {
      throw validationFailed('Transaction body returned a Promise in a sync transaction: use the async entry point.');
    }
    return { result, committed: false, dryRun: ambient.dryRun, diff: null };
  }
  const opened = openOuter(deps, sessionId, options);
  ambientBySession.set(sessionId, { ctx: opened.ctx, tracked: opened.tracked, dryRun: opened.isDryRun });
  try {
    const result = body(opened.ctx);
    if (isThenable(result)) {
      undoEverything(deps, opened);
      throw validationFailed('Transaction body returned a Promise in a sync transaction: use the async entry point.');
    }
    return commitGates(deps, opened, result);
  } catch (error) {
    undoEverything(deps, opened);
    throw error;
  } finally {
    ambientBySession.delete(sessionId);
  }
}
