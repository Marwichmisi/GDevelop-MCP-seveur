import type { z } from 'zod';
import {
  formatDiagnostics,
  isBlockingDiagnostic,
  type EngineDiagnostic,
  type EnginePorts,
  type EngineProject,
} from './engine.js';
import { McpError, postApplyFailed, validationFailed } from './errors.js';
import type { ProjectStore, Session } from './sessions.js';

export interface MutationContext<TArgs> {
  session: Session;
  project: EngineProject;
  args: TArgs;
}

export interface Mutation<TArgs, TResult = void> {
  sessionId: string;
  /** zod schema: parsing failures refuse the mutation before any write. */
  schema: z.ZodType<TArgs>;
  args: unknown;
  /** `has*` prechecks. Throw `validation-failed` to refuse before apply. */
  preconditions?: (context: MutationContext<TArgs>) => void;
  apply: (context: MutationContext<TArgs>) => TResult;
}

function diagnosticKey(diagnostic: EngineDiagnostic): string {
  return `${diagnostic.type}::${diagnostic.message}`;
}

/**
 * Transverse validation pipeline shared by every mutation (adopted by the
 * content ops from T2 on; the scaffold proves it on the seam itself):
 * snapshot → zod → `has*` preconditions → apply → `updateBehaviorsSharedData`
 * → serialize→reparse round-trip + zero-new-error diagnostics gate.
 * Any post-apply failure restores the memory snapshot and refuses the write.
 */
export function runMutation<TArgs, TResult>(
  store: ProjectStore,
  engine: EnginePorts,
  mutation: Mutation<TArgs, TResult>,
): TResult {
  const session = store.get(mutation.sessionId);
  const snapshot = engine.serializeProject(session.project);
  const baseline = new Set(engine.listDiagnostics(session.project).map(diagnosticKey));

  let args: TArgs;
  try {
    args = mutation.schema.parse(mutation.args);
  } catch (error) {
    throw validationFailed('Invalid mutation arguments.', { cause: error });
  }
  const context: MutationContext<TArgs> = { session, project: session.project, args };

  try {
    mutation.preconditions?.(context);
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw validationFailed('Mutation precondition failed.', { cause: error });
  }

  const result = mutation.apply(context);
  engine.updateBehaviorsSharedData(session.project);

  try {
    const serialized = engine.serializeProject(session.project);
    const reparsed = engine.loadProjectFromJson(serialized, '');
    reparsed.delete();
  } catch (error) {
    engine.restoreProject(session.project, snapshot);
    throw postApplyFailed('Mutation produced a project that no longer round-trips; memory snapshot restored.', {
      cause: error,
    });
  }

  const newBlocking = engine
    .listDiagnostics(session.project)
    .filter((diagnostic) => !baseline.has(diagnosticKey(diagnostic)) && isBlockingDiagnostic(diagnostic));
  if (newBlocking.length > 0) {
    engine.restoreProject(session.project, snapshot);
    throw postApplyFailed(
      `Mutation introduced blocking errors (${formatDiagnostics(newBlocking)}); memory snapshot restored.`,
    );
  }

  store.markDirty(session.id);
  return result;
}
