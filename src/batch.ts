import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { CommandDeps } from './commands.js';
import * as contentCmds from './content.js';
import { diffContentView, type ContentDiff } from './contentDiff.js';
import { formatDiagnostics, isBlockingDiagnostic, type EngineDiagnostic } from './engine.js';
import { McpError, validationFailed } from './errors.js';
import * as eventCmds from './events.js';

/**
 * Batch + sécurité (ticket #17) : rejoue exactement les payloads granulaires
 * (Ops de contenu + événements mutantes) en tout-ou-rien sous un snapshot
 * global, avec dryRun, diff sémantique et gate baseline explicite.
 * Les ids d'instances/événements rendus en dryRun sont consommés pour rien :
 * ils ne sont pas rejouables.
 */

const batchOpValues = [
  'create_scene', 'rename_scene', 'move_scene', 'delete_scene',
  'create_layer', 'rename_layer', 'move_layer', 'delete_layer',
  'add_object', 'rename_object', 'remove_object',
  'attach_behavior', 'update_behavior', 'remove_behavior',
  'place_instance', 'update_instance', 'remove_instance',
  'remove_instances_of_object', 'move_instances_to_layer',
  'set_variable', 'remove_variable', 'rename_variable',
  'create_group', 'delete_group', 'add_to_group', 'remove_from_group',
  'import_resource', 'remove_resource',
  'append_scene_events', 'move_scene_event', 'remove_scene_event',
] as const;

export type BatchOpName = (typeof batchOpValues)[number];

export const batchSchema = z.object({
  sessionId: z.string().uuid().describe('Session UUID (toutes les ops partagent cette session)'),
  ops: z
    .array(z.object({ op: z.enum(batchOpValues as unknown as [string, ...string[]]), payload: z.unknown() }))
    .min(1)
    .max(50)
    .describe('Ops rejouées dans l ordre, mêmes payloads qu en appel granulaire'),
  dryRun: z.boolean().optional().describe('Rejoue tout puis restaure : résumés + diff sans mutation ni dirty'),
  allowInvalidBaseline: z.boolean().optional().describe('Autorise malgré une baseline bloquante (défaut : refus)'),
});

export interface BatchOpResult {
  op: string;
  ok: true;
  summary: unknown;
}

export interface BatchApplyResult {
  applied: number;
  results: BatchOpResult[];
  diff: ContentDiff;
  dryRun: boolean;
}

type OpHandler = (deps: CommandDeps, payload: unknown) => unknown;

// Registre : chaque op rejoue la commande granulaire existante (même payload).
const OP_HANDLERS: Record<BatchOpName, OpHandler> = {
  create_scene: contentCmds.createScene,
  rename_scene: contentCmds.renameScene,
  move_scene: contentCmds.moveScene,
  delete_scene: contentCmds.deleteScene,
  create_layer: contentCmds.createLayer,
  rename_layer: contentCmds.renameLayer,
  move_layer: contentCmds.moveLayer,
  delete_layer: contentCmds.deleteLayer,
  add_object: contentCmds.addObject,
  rename_object: contentCmds.renameObject,
  remove_object: contentCmds.removeObject,
  attach_behavior: contentCmds.attachBehavior,
  update_behavior: contentCmds.updateBehavior,
  remove_behavior: contentCmds.removeBehavior,
  place_instance: contentCmds.placeInstance,
  update_instance: contentCmds.updateInstance,
  remove_instance: contentCmds.removeInstance,
  remove_instances_of_object: contentCmds.removeInstancesOfObject,
  move_instances_to_layer: contentCmds.moveInstancesToLayer,
  set_variable: contentCmds.setVariable,
  remove_variable: contentCmds.removeVariable,
  rename_variable: contentCmds.renameVariable,
  create_group: contentCmds.createGroup,
  delete_group: contentCmds.deleteGroup,
  add_to_group: contentCmds.addToGroup,
  remove_from_group: contentCmds.removeFromGroup,
  import_resource: contentCmds.importResource,
  remove_resource: contentCmds.removeResource,
  append_scene_events: eventCmds.appendSceneEvents,
  move_scene_event: eventCmds.moveSceneEvent,
  remove_scene_event: eventCmds.removeSceneEvent,
};

function failAt(index: number, total: number, op: string, error: unknown): never {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof McpError) {
    throw new McpError(error.code, `Batch op ${index + 1}/${total} (${op}) failed: ${error.message}`, { cause: error });
  }
  throw new McpError('post-apply-failed', `Batch op ${index + 1}/${total} (${op}) failed: ${detail}`, { cause: error });
}

interface TrackedFile {
  path: string;
  existed: boolean;
  /** Copie de compensation du binaire écrasé (null si le fichier n'existait pas). */
  compensationPath: string | null;
}

// import_resource copie un binaire avant runMutation : suivi pour compensation batch.
function trackImportFile(deps: CommandDeps, sessionId: string, payload: unknown): TrackedFile | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const session = deps.store.get(sessionId);
  const rawTarget = typeof record['targetPath'] === 'string' ? (record['targetPath'] as string) : session.filePath;
  if (!rawTarget) return null;
  const target = deps.store.resolvePath(rawTarget);
  const source = typeof record['sourcePath'] === 'string' ? (record['sourcePath'] as string) : null;
  if (!source) return null;
  const destination = join(dirname(target), basename(deps.store.resolvePath(source)));
  if (!existsSync(destination)) return { path: destination, existed: false, compensationPath: null };
  // Copie de compensation d'une ressource importée — distincte du Backup projet
  // `<projet>.bak-<ISO>` : elle annule l'écrasement du binaire si le batch rollback.
  const compensationPath = `${destination}.batch-comp-${process.pid}-${Date.now()}`;
  writeFileSync(compensationPath, readFileSync(destination));
  return { path: destination, existed: true, compensationPath };
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

/**
 * Rejoue les ops sous un snapshot global unique : tout-ou-rien.
 * - gate baseline : refuse si bloquantes sauf allowInvalidBaseline ;
 * - chaque op est validée via sa commande (zod + pipeline) ;
 * - tout échec restaure mémoire + dirty + fichiers importés ;
 * - dryRun restaure aussi en succès, avec résumés + diff.
 */
export function applyContentBatch(deps: CommandDeps, args: unknown): BatchApplyResult {
  const parsed = batchSchema.parse(args);
  const session = deps.store.get(parsed.sessionId);

  // Étage pré-batch : lecture baseline + snapshot global. Toute panne ici
  // survient avant la première op : rien n'a été appliqué, ni mémoire ni disque.
  let baselineBlocking: EngineDiagnostic[];
  let snapshot: string;
  try {
    baselineBlocking = deps.engine.listDiagnostics(session.project).filter(isBlockingDiagnostic);
    snapshot = deps.engine.serializeProject(session.project);
  } catch (error) {
    throw new McpError(
      'post-apply-failed',
      `Batch failed before any op ran (${error instanceof Error ? error.message : String(error)}); nothing was applied.`,
      { cause: error },
    );
  }
  if (baselineBlocking.length > 0 && parsed.allowInvalidBaseline !== true) {
    throw validationFailed(
      `Refusing batch: project baseline has blocking errors (${formatDiagnostics(baselineBlocking)}). Pass allowInvalidBaseline:true to override.`,
    );
  }

  // Cohérence : chaque payload porte le sessionId de la session du batch.
  for (let i = 0; i < parsed.ops.length; i += 1) {
    const entry = parsed.ops[i];
    if (!entry) continue;
    const payload = entry.payload as Record<string, unknown> | null;
    if (typeof payload !== 'object' || payload === null || payload['sessionId'] !== parsed.sessionId) {
      throw validationFailed(`Batch op ${i + 1}/${parsed.ops.length} (${entry.op}): payload.sessionId must equal the batch sessionId.`);
    }
    if ('dryRun' in payload && (payload as Record<string, unknown>)['dryRun'] === true) {
      throw validationFailed(`Batch op ${i + 1}/${parsed.ops.length} (${entry.op}): per-op dryRun is forbidden; use the batch-level dryRun flag.`);
    }
  }

  const before = deps.engine.describeContent(session.project);
  const wasDirty = session.dirty;
  const tracked: TrackedFile[] = [];
  const results: BatchOpResult[] = [];
  const isDryRun = parsed.dryRun === true;

  const restoreMemory = (): void => {
    deps.engine.restoreProject(session.project, snapshot);
    if (wasDirty) deps.store.markDirty(session.id);
    else deps.store.clearDirty(session.id);
  };

  // Tout-ou-rien : restaure la mémoire + dirty + les fichiers de ressources suivis.
  const undoEverything = (): void => {
    rollbackFiles(tracked);
    restoreMemory();
  };

  try {
    for (let i = 0; i < parsed.ops.length; i += 1) {
      const entry = parsed.ops[i];
      if (!entry) continue;
      const handler = OP_HANDLERS[entry.op as BatchOpName];
      if (!handler) {
        throw validationFailed(`Unknown batch op: ${String(entry.op)}.`);
      }
      if (entry.op === 'import_resource') {
        const trackedFile = trackImportFile(deps, parsed.sessionId, entry.payload);
        if (trackedFile) tracked.push(trackedFile);
      }
      try {
        const summary = handler(deps, entry.payload);
        results.push({ op: entry.op, ok: true, summary });
      } catch (error) {
        undoEverything();
        failAt(i, parsed.ops.length, entry.op, error);
      }
    }

    deps.engine.updateBehaviorsSharedData(session.project);
    let serialized: string;
    try {
      serialized = deps.engine.serializeProject(session.project);
      const reparsed = deps.engine.loadProjectFromJson(serialized, '');
      reparsed.delete();
    } catch (error) {
      undoEverything();
      if (error instanceof McpError) {
        throw new McpError(error.code, `Batch produced a project that no longer round-trips; everything was restored.`, { cause: error });
      }
      throw new McpError('post-apply-failed', 'Batch produced a project that no longer round-trips; everything was restored.', { cause: error });
    }

    const baselineKeys = new Set(baselineBlocking.map((d) => `${d.type}::${d.message}`));
    const newBlocking = deps.engine
      .listDiagnostics(session.project)
      .filter((d) => !baselineKeys.has(`${d.type}::${d.message}`) && isBlockingDiagnostic(d));
    if (newBlocking.length > 0) {
      undoEverything();
      throw new McpError(
        'post-apply-failed',
        `Batch introduced blocking errors (${formatDiagnostics(newBlocking)}); everything was restored.`,
      );
    }

    const after = deps.engine.describeContent(session.project);
    const diff = diffContentView(before, after);

    if (isDryRun) {
      // dryRun : même en cas d'import_resource, la copie disque est immédiatement
      // compensée — aucun binaire ne subsiste, ni mutation ni dirty.
      undoEverything();
      return { applied: parsed.ops.length, results, diff, dryRun: true };
    }

    cleanupCompensations(tracked);
    deps.store.markDirty(session.id);
    return { applied: parsed.ops.length, results, diff, dryRun: false };
  } catch (error) {
    if (error instanceof McpError) throw error;
    undoEverything();
    throw new McpError('post-apply-failed', `Batch failed (${error instanceof Error ? error.message : String(error)}); everything was restored.`, { cause: error });
  }
}
