import { copyFileSync, existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
): { path: string; backupPath: string | null; bytes: number } {
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
  deps.engine.setProjectFile(session.project, target);
  deps.store.setFilePath(session.id, target);
  deps.store.clearDirty(session.id);
  return { path: target, backupPath, bytes: Buffer.byteLength(serialized, 'utf8') };
}

export function closeProject(
  deps: CommandDeps,
  args: { sessionId: string; force?: boolean | undefined },
): { closed: true } {
  deps.store.close(args.sessionId, { force: args.force });
  return { closed: true };
}
