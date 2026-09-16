import type { z } from 'zod';
import type { EnginePorts, EngineProject } from './engine.js';
import { McpError, validationFailed } from './errors.js';
import type { ProjectStore, Session } from './sessions.js';
import { runTransactionSync } from './transaction.js';

export interface MutationContext<TArgs> {
  session: Session;
  project: EngineProject;
  args: TArgs;
  /** Déclare une sortie fichier AVANT de l'écrire ; la Transaction la compense. */
  declareFile(path: string): void;
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

/**
 * Façade mince sur le module Transaction : snapshot → zod → `has*`
 * préconditions → apply → gates partagés (round-trip + zéro-nouvelle-erreur).
 * Signature inchangée : les ~30 Ops de contenu ne churnent pas.
 * `allowInvalidBaseline:true` préserve la sémantique historique des ops
 * unitaires (gate relatif ; cf. pipeline.test.ts « baseline »).
 */
export function runMutation<TArgs, TResult>(
  store: ProjectStore,
  engine: EnginePorts,
  mutation: Mutation<TArgs, TResult>,
): TResult {
  return runTransactionSync(
    { store, engine },
    mutation.sessionId,
    (ctx) => {
      let args: TArgs;
      try {
        args = mutation.schema.parse(mutation.args);
      } catch (error) {
        throw validationFailed('Invalid mutation arguments.', { cause: error });
      }
      const context: MutationContext<TArgs> = {
        session: ctx.session,
        project: ctx.project,
        args,
        declareFile: ctx.declareFile,
      };
      try {
        mutation.preconditions?.(context);
      } catch (error) {
        if (error instanceof McpError) throw error;
        throw validationFailed('Mutation precondition failed.', { cause: error });
      }
      return mutation.apply(context);
    },
    { allowInvalidBaseline: true },
  ).result;
}
