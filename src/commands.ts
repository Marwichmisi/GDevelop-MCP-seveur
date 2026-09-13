import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { formatDiagnostics, isBlockingDiagnostic, type ContentView, type EnginePorts, type ProjectSummary } from './engine.js';
import { McpError, validationFailed } from './errors.js';
import type { ProjectStore } from './sessions.js';

export interface CommandDeps {
  store: ProjectStore;
  engine: EnginePorts;
}

/** Lifecycle commands for empty projects through the real `gd.Project`. Thin
 *  wrappers over the session store; content mutations arrive in later tickets. */

export function createProject(deps: CommandDeps, args: { name?: string | undefined }): { sessionId: string; name: string } {
  const name = args.name ?? 'Untitled game';
  const session = deps.store.create(name);
  return { sessionId: session.id, name };
}

export function openProject(deps: CommandDeps, args: { path: string }): { sessionId: string; path: string } {
  const session = deps.store.open(args.path);
  return { sessionId: session.id, path: session.filePath as string };
}

export function describeProject(
  deps: CommandDeps,
  args: { sessionId: string },
): ProjectSummary & { sessionId: string; dirty: boolean; filePath: string | null; content: ContentView } {
  const session = deps.store.get(args.sessionId);
  return {
    sessionId: session.id,
    dirty: session.dirty,
    filePath: session.filePath,
    ...deps.engine.describeProject(session.project),
    content: deps.engine.describeContent(session.project),
  };
}

export function saveProject(
  deps: CommandDeps,
  args: { sessionId: string; path?: string | undefined },
): { path: string; backupPath: string | null; preRestorePath: string | null; bytes: number } {
  const session = deps.store.get(args.sessionId);
  const rawTarget = args.path ?? session.filePath;
  if (!rawTarget) {
    throw validationFailed('No target path: pass an explicit path or open the session from a file first.');
  }
  const target = deps.store.resolvePath(rawTarget);
  // Save gate: unlike the pipeline's zero-new-error check per mutation, the
  // save refuses any blocking state — nothing invalid ever reaches the disk.
  const blocking = deps.engine.listDiagnostics(session.project).filter(isBlockingDiagnostic);
  if (blocking.length > 0) {
    throw validationFailed(
      `Refusing to save: project has blocking errors (${formatDiagnostics(blocking)}). Nothing was written.`,
    );
  }
  const serialized = deps.engine.serializeProject(session.project);

  let backupPath: string | null = null;
  if (existsSync(target)) {
    backupPath = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      copyFileSync(target, backupPath);
    } catch (error) {
      throw new McpError('io-error', `Cannot write backup at ${backupPath}. Nothing was written.`, { cause: error });
    }
  }
  const tmpPath = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmpPath, serialized, 'utf8');
    renameSync(tmpPath, target);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best effort: a leftover .tmp file is harmless but never a project.
    }
    throw new McpError('io-error', `Atomic save to ${target} failed.`, { cause: error });
  }

  // Copie -pre-restore : état disque pré-save pour undo_last_edit (one-shot).
  // Écrite après le save réussi ; un échec ici n'invalide pas le save.
  let preRestorePath: string | null = null;
  if (backupPath !== null) {
    preRestorePath = `${target}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      copyFileSync(backupPath, preRestorePath);
    } catch {
      preRestorePath = null;
    }
  }

  deps.engine.setProjectFile(session.project, target);
  deps.store.setFilePath(session.id, target);
  deps.store.clearDirty(session.id);
  deps.store.setPreRestore(session.id, preRestorePath);
  return { path: target, backupPath, preRestorePath, bytes: Buffer.byteLength(serialized, 'utf8') };
}

export function closeProject(
  deps: CommandDeps,
  args: { sessionId: string; force?: boolean | undefined },
): { closed: true } {
  deps.store.close(args.sessionId, { force: args.force });
  return { closed: true };
}

/**
 * undo_last_edit (spec US8) : restaure l'état pré-save (copie -pre-restore
 * écrite au save) en mémoire ET sur disque, atomiquement (tmp+rename).
 * One-shot : la copie est consommée ; un 2e undo refuse proprement.
 * L'état restauré redevient dirty=false (il converge avec le disque).
 */
export function undoLastEdit(
  deps: CommandDeps,
  args: { sessionId: string },
): { restoredPath: string; preRestorePath: string; backupPath: string } {
  const session = deps.store.get(args.sessionId);
  const target = session.filePath;
  if (!target) {
    throw validationFailed('No project file: save the session once before undoing.');
  }
  const preRestorePath = deps.store.consumePreRestore(session.id);
  let preRestoreJson: string;
  try {
    preRestoreJson = readFileSync(preRestorePath, 'utf8');
  } catch (error) {
    throw new McpError('io-error', `Cannot read pre-restore copy at ${preRestorePath}.`, { cause: error });
  }
  // Gate mémoire : refuser plutôt que charger un état bloquant.
  let staged;
  try {
    staged = deps.engine.loadProjectFromJson(preRestoreJson, target);
  } catch (error) {
    throw new McpError('project-load-failed', `Pre-restore copy at ${preRestorePath} could not be loaded.`, {
      cause: error,
    });
  }
  const blocking = deps.engine.listDiagnostics(staged).filter(isBlockingDiagnostic);
  if (blocking.length > 0) {
    try {
      staged.delete();
    } catch {
      // Best effort.
    }
    throw validationFailed(
      `Refusing undo: pre-restore state has blocking errors (${formatDiagnostics(blocking)}).`,
    );
  }
  staged.delete();
  // Disque d'abord (tmp+rename), avec backup de sécurité, puis mémoire.
  let undoBackupPath: string | null = null;
  if (existsSync(target)) {
    undoBackupPath = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}-undo`;
    try {
      copyFileSync(target, undoBackupPath);
    } catch (error) {
      throw new McpError('io-error', `Cannot write undo backup at ${undoBackupPath}. Nothing was restored.`, {
        cause: error,
      });
    }
  }
  const tmpPath = `${target}.tmp-${process.pid}-${randomUUID()}-undo`;
  try {
    writeFileSync(tmpPath, preRestoreJson, 'utf8');
    renameSync(tmpPath, target);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best effort.
    }
    throw new McpError('io-error', `Atomic undo restore to ${target} failed.`, { cause: error });
  }
  try {
    deps.engine.restoreProject(session.project, preRestoreJson);
  } catch (error) {
    throw new McpError('post-apply-failed', 'Undo wrote the disk copy but memory restore failed.', { cause: error });
  }
  deps.store.clearDirty(session.id);
  return { restoredPath: target, preRestorePath, backupPath: undoBackupPath ?? preRestorePath };
}
