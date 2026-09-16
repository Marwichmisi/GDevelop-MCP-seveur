import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { CommandDeps } from './commands.js';
import * as contentCmds from './content.js';
import type { ContentDiff } from './contentDiff.js';
import { McpError, validationFailed } from './errors.js';
import * as eventCmds from './events.js';
import { runTransactionSync } from './transaction.js';

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

// import_resource écrit un binaire : résout sa destination pour declareFile.
// La compensation elle-même appartient au module Transaction.
function resolveImportDestination(deps: CommandDeps, sessionId: string, payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const session = deps.store.get(sessionId);
  const rawTarget = typeof record['targetPath'] === 'string' ? (record['targetPath'] as string) : session.filePath;
  if (!rawTarget) return null;
  const target = deps.store.resolvePath(rawTarget);
  const source = typeof record['sourcePath'] === 'string' ? (record['sourcePath'] as string) : null;
  if (!source) return null;
  return join(dirname(target), basename(deps.store.resolvePath(source)));
}

/**
 * Rejoue les ops dans une seule Transaction externe : tout-ou-rien.
 * - gate baseline : refuse si bloquantes sauf allowInvalidBaseline ;
 * - chaque op est validée via sa commande (zod + préconditions), en rejoint
 *   de la Transaction ambiante (ni Snapshot ni gates par op) ;
 * - tout échec restaure mémoire + dirty + fichiers importés ;
 * - dryRun restaure aussi en succès, avec résumés + diff.
 */
export function applyContentBatch(deps: CommandDeps, args: unknown): BatchApplyResult {
  const parsed = batchSchema.parse(args);

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

  const outcome = runTransactionSync<BatchOpResult[]>(
    deps,
    parsed.sessionId,
    (ctx) => {
      const results: BatchOpResult[] = [];
      for (let i = 0; i < parsed.ops.length; i += 1) {
        const entry = parsed.ops[i];
        if (!entry) continue;
        const handler = OP_HANDLERS[entry.op as BatchOpName];
        if (!handler) {
          throw validationFailed(`Unknown batch op: ${String(entry.op)}.`);
        }
        if (entry.op === 'import_resource') {
          const destination = resolveImportDestination(deps, parsed.sessionId, entry.payload);
          if (destination) ctx.declareFile(destination);
        }
        try {
          const summary = handler(deps, entry.payload);
          results.push({ op: entry.op, ok: true, summary });
        } catch (error) {
          failAt(i, parsed.ops.length, entry.op, error);
        }
      }
      return results;
    },
    { dryRun: parsed.dryRun, allowInvalidBaseline: parsed.allowInvalidBaseline, diff: true },
  );
  const diff = outcome.diff;
  if (!diff) throw new McpError('post-apply-failed', 'Batch diff was not captured.');
  return { applied: parsed.ops.length, results: outcome.result, diff, dryRun: outcome.dryRun };
}
