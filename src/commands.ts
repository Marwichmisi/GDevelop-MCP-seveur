import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { formatDiagnostics, isBlockingDiagnostic, type ContentView, type EnginePorts, type ProjectSummary } from './engine.js';
import { McpError, validationFailed } from './errors.js';
import type { ProjectStore } from './sessions.js';
import {
  MAX_UNSPLIT_DEPTH,
  REFERENCE_MAGIC_PROPERTY,
  backupFolderSync,
  containsSplitReference,
  deleteExistingFilesFromDirsSync,
  folderSplitOptions,
  isFolderProjectJson,
  listFolderProjectFilesSync,
  restoreFolderSync,
  split,
  unsplitSync,
  writeFormattedJsonSync,
} from './folderProject.js';

export interface CommandDeps {
  store: ProjectStore;
  engine: EnginePorts;
  /** Optional preview manager (issue #16): closed sessions stop linked previews first. */
  previews?: { stopForSession(sessionId: string): Promise<unknown> } | undefined;
}

/** Lifecycle commands for empty projects through the real `gd.Project`. Thin
 *  wrappers over the session store; content mutations arrive in later tickets. */

/**
 * Écriture atomique tmp+rename partagée par save_project et undo_last_edit.
 * En cas d'échec : le tmp est nettoyé (best effort) et l'erreur est codée io-error.
 */
function atomicWrite(target: string, contents: string, suffix: string, failureMessage: string): void {
  const tmpPath = `${target}.tmp-${process.pid}-${randomUUID()}${suffix}`;
  try {
    writeFileSync(tmpPath, contents, 'utf8');
    renameSync(tmpPath, target);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best effort: a leftover .tmp file is harmless but never a project.
    }
    throw new McpError('io-error', failureMessage, { cause: error });
  }
}

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

function resolveSaveMain(store: ProjectStore, rawTarget: string): string {
  const candidate = store.resolvePath(rawTarget);
  try {
    if (statSync(candidate).isDirectory()) {
      const main = join(candidate, 'game.json');
      store.resolvePath(main);
      return main;
    }
  } catch {
    // Absent : sans extension `.json` c'est un dossier projet à créer
    // (`dossiers créés si absents`), avec extension c'est un fichier (mkdir-p).
    if (!candidate.endsWith('.json')) {
      const main = join(candidate, 'game.json');
      store.resolvePath(main);
      return main;
    }
  }
  return candidate;
}

export function saveProject(
  deps: CommandDeps,
  args: { sessionId: string; path?: string | undefined },
): { path: string; backupPath: string | null; preRestorePath: string | null; bytes: number } {
  const session = deps.store.get(args.sessionId);
  if (session.readOnly === true) {
    throw validationFailed(
      `Session ${args.sessionId} is read-only (example opened in read mode): describe only, no save.`,
    );
  }
  const rawTarget = args.path ?? session.filePath;
  if (!rawTarget) {
    throw validationFailed('No target path: pass an explicit path or open the session from a file first.');
  }
  const main = resolveSaveMain(deps.store, rawTarget);
  const dir = dirname(main);
  // Save gate: unlike the pipeline's zero-new-error check per mutation, the
  // save refuses any blocking state — nothing invalid ever reaches the disk.
  const blocking = deps.engine.listDiagnostics(session.project).filter(isBlockingDiagnostic);
  if (blocking.length > 0) {
    throw validationFailed(
      `Refusing to save: project has blocking errors (${formatDiagnostics(blocking)}). Nothing was written.`,
    );
  }
  const isFolder = deps.engine.isFolderProject(session.project);
  if (!isFolder) {
    const serialized = deps.engine.serializeProject(session.project);

    let backupPath: string | null = null;
    if (existsSync(main)) {
      backupPath = `${main}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try {
        copyFileSync(main, backupPath);
      } catch (error) {
        throw new McpError('io-error', `Cannot write backup at ${backupPath}. Nothing was written.`, { cause: error });
      }
    }
    atomicWrite(main, serialized, '', `Atomic save to ${main} failed.`);

    // Copie -pre-restore : état disque pré-save pour undo_last_edit (one-shot).
    // Écrite après le save réussi ; un échec ici n'invalide pas le save.
    // Rétention : même cycle que les .bak-<ISO> (une copie par save horodatée).
    let preRestorePath: string | null = null;
    if (backupPath !== null) {
      preRestorePath = `${main}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try {
        copyFileSync(backupPath, preRestorePath);
      } catch {
        preRestorePath = null;
      }
    }

    deps.engine.setProjectFile(session.project, main);
    deps.store.setFilePath(session.id, main);
    deps.store.clearDirty(session.id);
    deps.store.setPreRestore(session.id, preRestorePath);
    deps.store.setKind(session.id, 'single');
    return { path: main, backupPath, preRestorePath, bytes: Buffer.byteLength(serialized, 'utf8') };
  }
  // --- Folder-project save (split) ---
  const serialized = deps.engine.serializeProject(session.project);
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new McpError('io-error', `Cannot serialize folder-project to ${main}.`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new McpError('io-error', `Cannot serialize folder-project to ${main}.`);
  }
  const doc = parsed as Record<string, unknown>;
  const partials = split(doc, folderSplitOptions());

  const hadDiskState = existsSync(main) || listFolderProjectFilesSync(dir, main).length > 0;
  let backupPath: string | null = null;
  if (existsSync(main)) {
    backupPath = `${main}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      copyFileSync(main, backupPath);
    } catch (error) {
      throw new McpError('io-error', `Cannot write backup at ${backupPath}. Nothing was written.`, { cause: error });
    }
  }
  let preRestorePath: string | null = null;
  if (hadDiskState) {
    preRestorePath = `${main}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      mkdirSync(preRestorePath, { recursive: true });
      backupFolderSync(dir, main, preRestorePath);
    } catch {
      preRestorePath = null;
    }
  }

  try {
    deleteExistingFilesFromDirsSync(dir);
  } catch (error) {
    console.warn('Unable to clean project folder before saving project: ', error);
  }
  try {
    for (const { object, reference } of partials) {
      if (reference.includes('..')) {
        throw new McpError('io-error', `Invalid split reference ${reference}. Nothing was written.`);
      }
      const partialPath = join(dir, reference) + '.json';
      if (!resolve(partialPath).startsWith(resolve(dir))) {
        throw new McpError('io-error', `Split reference escapes project folder: ${reference}. Nothing was written.`);
      }
      writeFormattedJsonSync(object, partialPath);
    }
    writeFormattedJsonSync(doc, main);
  } catch (error) {
    // Échec à mi-split : le cleanup préalable a déjà supprimé les partiels.
    // Restaurer le snapshot pré-save (best effort) pour ne jamais laisser
    // un dossier à moitié écrit.
    if (preRestorePath !== null) {
      try {
        restoreFolderSync(preRestorePath, dir, main);
      } catch {
        // Best effort : l'erreur d'origine prime.
      }
    }
    if (error instanceof McpError) throw error;
    throw new McpError('io-error', `Atomic folder save to ${main} failed.`, { cause: error });
  }

  deps.engine.setProjectFile(session.project, main);
  deps.store.setFilePath(session.id, main);
  deps.store.clearDirty(session.id);
  deps.store.setPreRestore(session.id, preRestorePath);
  deps.store.setKind(session.id, 'folder');
  return { path: main, backupPath, preRestorePath, bytes: Buffer.byteLength(serialized, 'utf8') };
}

export function closeProject(
  deps: CommandDeps,
  args: { sessionId: string; force?: boolean | undefined },
): { closed: true } {
  // Sync headless seam: closes the session only. Preview cleanup lives in
  // `closeProjectWithPreviews` below (ports + temp dirs must be released
  // first); the `close_project` tool awaits that async entry point.
  deps.store.close(args.sessionId, { force: args.force });
  return { closed: true };
}

export async function closeProjectWithPreviews(
  deps: CommandDeps,
  args: { sessionId: string; force?: boolean | undefined },
): Promise<{ closed: true; stoppedPreviews: number }> {
  // Dirty gate first (same rule as ProjectStore.close, the canonical owner):
  // a refusal must have no side effects, so linked previews keep running.
  const session = deps.store.get(args.sessionId);
  if (session.dirty && args.force !== true) {
    throw new McpError(
      'session-dirty',
      `Session ${args.sessionId} has unsaved changes. Save it first or close with force:true to discard them.`,
    );
  }
  let stopped = 0;
  if (deps.previews) {
    stopped = ((await deps.previews.stopForSession(args.sessionId)) as { stopped: number }).stopped ?? 0;
  }
  deps.store.close(args.sessionId, { force: args.force });
  return { closed: true, stoppedPreviews: stopped };
}

/**
 * undo_last_edit (spec US8) : restaure l'état pré-save (copie -pre-restore
 * écrite au save) en mémoire ET sur disque, atomiquement (tmp+rename).
 * One-shot : la copie est consommée ; un 2e undo refuse proprement.
 * L'état restauré redevient dirty=false (il converge avec le disque).
 * Folder-project : `preRestorePath` est un dossier backup (main + partiels),
 * restauré via cleanup + copie (même gate diagnostics après unsplit).
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
  let preIsDir = false;
  try {
    preIsDir = statSync(preRestorePath).isDirectory();
  } catch {
    preIsDir = false;
  }
  if (preIsDir) {
    return undoFolderLastEdit(deps, session.id, target, preRestorePath);
  }
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
  atomicWrite(target, preRestoreJson, '-undo', `Atomic undo restore to ${target} failed.`);
  try {
    deps.engine.restoreProject(session.project, preRestoreJson);
  } catch (error) {
    throw new McpError('post-apply-failed', 'Undo wrote the disk copy but memory restore failed.', { cause: error });
  }
  deps.store.clearDirty(session.id);
  try {
    deps.store.setKind(session.id, deps.engine.isFolderProject(session.project) ? 'folder' : 'single');
  } catch {
    // Best effort.
  }
  return { restoredPath: target, preRestorePath, backupPath: undoBackupPath ?? preRestorePath };
}

function undoFolderLastEdit(
  deps: CommandDeps,
  sessionId: string,
  target: string,
  preRestoreDir: string,
): { restoredPath: string; preRestorePath: string; backupPath: string } {
  const session = deps.store.get(sessionId);
  const dir = dirname(target);
  const base = basename(target);
  let preMain = join(preRestoreDir, base);
  if (!existsSync(preMain)) {
    const fallback = join(preRestoreDir, 'game.json');
    if (existsSync(fallback)) preMain = fallback;
    else {
      throw new McpError('io-error', `Cannot read pre-restore copy at ${preMain}.`);
    }
  }
  let preRaw: string;
  try {
    preRaw = readFileSync(preMain, 'utf8');
  } catch (error) {
    throw new McpError('io-error', `Cannot read pre-restore copy at ${preMain}.`, { cause: error });
  }
  let preParsed: unknown;
  try {
    preParsed = JSON.parse(preRaw);
  } catch (error) {
    throw new McpError('project-load-failed', `Pre-restore copy at ${preMain} could not be loaded.`, { cause: error });
  }
  let unsplitJson = preRaw;
  if (
    typeof preParsed === 'object' &&
    preParsed !== null &&
    !Array.isArray(preParsed) &&
    (isFolderProjectJson(preParsed) || containsSplitReference(preParsed))
  ) {
    const doc = preParsed as Record<string, unknown>;
    try {
      unsplitSync(doc, {
        isReferenceMagicPropertyName: REFERENCE_MAGIC_PROPERTY,
        maxUnsplitDepth: MAX_UNSPLIT_DEPTH,
        getReferencePartialObjectSync: (reference: string) => {
          if (reference.includes('..')) throw new Error(`Invalid reference ${reference}`);
          const partialPath = join(preRestoreDir, reference) + '.json';
          if (!resolve(partialPath).startsWith(resolve(preRestoreDir))) {
            throw new Error(`Reference escapes backup folder: ${reference}`);
          }
          return JSON.parse(readFileSync(partialPath, 'utf8')) as unknown;
        },
      });
    } catch (error) {
      throw new McpError('project-load-failed', `Pre-restore copy at ${preMain} could not be loaded.`, {
        cause: error,
      });
    }
    unsplitJson = JSON.stringify(doc);
  }
  let staged;
  try {
    staged = deps.engine.loadProjectFromJson(unsplitJson, target);
  } catch (error) {
    throw new McpError('project-load-failed', `Pre-restore copy at ${preMain} could not be loaded.`, {
      cause: error,
    });
  }
  // Les extensions custom du pre-restore doivent charger pour éviter les faux positifs.
  try {
    deps.engine.loadEventsFunctionsExtensions(staged);
  } catch {
    try {
      staged.delete();
    } catch {
      // Best effort.
    }
    throw new McpError('project-load-failed', `Pre-restore copy at ${preMain} could not be loaded.`);
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
  try {
    deps.engine.unloadEventsFunctionsExtensions(staged);
  } catch {
    // Best effort.
  }
  staged.delete();
  let undoBackupDir: string | null = null;
  if (existsSync(target) || listFolderProjectFilesSync(dir, target).length > 0) {
    undoBackupDir = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}-undo`;
    try {
      mkdirSync(undoBackupDir, { recursive: true });
      backupFolderSync(dir, target, undoBackupDir);
    } catch (error) {
      throw new McpError('io-error', `Cannot write undo backup at ${undoBackupDir}. Nothing was restored.`, {
        cause: error,
      });
    }
  }
  try {
    restoreFolderSync(preRestoreDir, dir, target);
  } catch (error) {
    throw new McpError('io-error', `Atomic undo restore to ${target} failed.`, { cause: error });
  }
  try {
    deps.engine.restoreProject(session.project, unsplitJson);
  } catch (error) {
    throw new McpError('post-apply-failed', 'Undo wrote the disk copy but memory restore failed.', { cause: error });
  }
  // Recharger les extensions de l'état restauré (custom objects).
  try {
    deps.engine.loadEventsFunctionsExtensions(session.project);
  } catch {
    // Best effort : diagnostics au prochain save trancheront.
  }
  deps.store.clearDirty(session.id);
  try {
    deps.store.setKind(session.id, deps.engine.isFolderProject(session.project) ? 'folder' : 'single');
  } catch {
    // Best effort.
  }
  return { restoredPath: target, preRestorePath: preRestoreDir, backupPath: undoBackupDir ?? preRestoreDir };
}
