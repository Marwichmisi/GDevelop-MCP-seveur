import { z } from 'zod';
import type { EventNodeInput } from './engine.js';
import { validationFailed } from './errors.js';
import { runMutation, type MutationContext } from './pipeline.js';
import type { CommandDeps } from './commands.js';

/**
 * Native events (ticket #14): a single recursive tree discriminated by `kind`
 * travels schema → headless engine call → shared pipeline (snapshot,
 * round-trip, diagnostics gate). The zod schemas are exported so
 * `apply_content_batch` (ticket #17) replays exactly the same payloads.
 *
 * Rules (from the ticket + spec):
 * - `insertNewEvent` typed, `insert` at `size()` never `push_back`.
 * - L1+L2 engine validation at write (unknown type / wrong arity refuse).
 * - JsCode marker only (`gdevelop-mcp:scene-script`); free JsCode refuses.
 * - Selector `{path} | {id}` (`path` immediate, `id` stamped + traversal).
 */

export const JSCODE_MARKER = 'gdevelop-mcp:scene-script';

/** Full namespaced marker comment: the only JsCode the server ever writes. */
export const JSCODE_MARKER_COMMENT = `/* ${JSCODE_MARKER} */`;

export function hasJsCodeMarker(inlineCode: string): boolean {
  return inlineCode.includes(JSCODE_MARKER_COMMENT);
}

const sessionId = z.string().uuid().describe('Session UUID');
const sceneName = z.string().min(1).describe('Scene name');

const instructionInput = z.object({
  type: z.string().min(1).describe('Instruction type, e.g. ModVarScene (action) or VarScene (condition)'),
  parameters: z.array(z.string()).describe('Positional string parameters, faithful to the engine'),
  inverted: z.boolean().optional().describe('Negate the instruction'),
  awaited: z.boolean().optional().describe('Await async completion'),
});

type EventNode = z.infer<typeof eventNodeSchema>;

const baseEventFields = {
  conditions: z.array(instructionInput).optional().describe('Conditions (Standard, Else, Repeat, While, ForEach…)'),
  actions: z.array(instructionInput).optional().describe('Actions (Standard, Else, Repeat, While, ForEach…)'),
  disabled: z.boolean().optional().describe('Disabled flag'),
};

const eventNodeSchema: z.ZodType<EventNodeInput> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('standard'), ...baseEventFields, events: z.array(eventNodeSchema).optional() }),
    z.object({ kind: z.literal('else'), ...baseEventFields, events: z.array(eventNodeSchema).optional() }),
    z.object({
      kind: z.literal('repeat'),
      repeatExpression: z.string().describe('Repeat count expression (plain string)'),
      loopIndexVariable: z.string().optional().describe('Loop index variable name'),
      ...baseEventFields,
      events: z.array(eventNodeSchema).optional(),
    }),
    z.object({
      kind: z.literal('while'),
      whileConditions: z.array(instructionInput).describe('While-loop conditions'),
      ...baseEventFields,
      events: z.array(eventNodeSchema).optional(),
    }),
    z.object({
      kind: z.literal('foreach'),
      object: z.string().min(1).describe('Object to pick'),
      loopIndexVariable: z.string().optional().describe('Loop index variable name'),
      ...baseEventFields,
      events: z.array(eventNodeSchema).optional(),
    }),
    z.object({
      kind: z.literal('foreachChildVariable'),
      iterableVariable: z.string().describe('Iterable variable name'),
      keyIterator: z.string().optional().describe('Key iterator variable name'),
      valueIterator: z.string().optional().describe('Value iterator variable name'),
      ...baseEventFields,
      events: z.array(eventNodeSchema).optional(),
    }),
    z.object({
      kind: z.literal('group'),
      name: z.string().min(1).describe('Group name'),
      source: z.string().optional().describe('Group source'),
      events: z.array(eventNodeSchema).optional().describe('Sub-events'),
      disabled: z.boolean().optional(),
    }),
    z.object({ kind: z.literal('comment'), comment: z.string().describe('Comment text') }),
    z.object({
      kind: z.literal('link'),
      target: z.string().min(1).describe('External events target'),
      includeAll: z.boolean().optional().describe('Include all events (default true)'),
      eventsGroup: z.string().optional().describe('Events group name when not including all'),
      includeStart: z.number().int().optional(),
      includeEnd: z.number().int().optional(),
    }),
    z.object({
      kind: z.literal('jscode'),
      inlineCode: z.string().describe(`Inline JS (must contain the marker ${JSCODE_MARKER})`),
      parameterObjects: z.string().optional().describe('Parameter objects'),
    }),
  ]),
);

const eventSelectorSchema = z
  .union([
    z.object({ path: z.array(z.number().int().nonnegative()).describe('Immediate index path, e.g. [0, 2]') }),
    z.object({ id: z.string().min(1).describe('Stable stamped event id') }),
  ])
  .describe('Event selector: {path} immediate or {id} stable');

export const eventsSchemas = {
  appendSceneEvents: z.object({
    sessionId,
    scene: sceneName,
    position: z.number().int().optional().describe('Insert position in the root list (default: append)'),
    dryRun: z.boolean().optional().describe('Validate + simulate without mutating memory'),
    events: z.array(eventNodeSchema).min(1).describe('Event tree to append'),
  }),
  moveSceneEvent: z.object({
    sessionId,
    scene: sceneName,
    from: eventSelectorSchema,
    toPosition: z.number().int().describe('Destination position in the destination parent list'),
    toParent: eventSelectorSchema.optional().describe('Destination parent (absent = same parent as source)'),
    dryRun: z.boolean().optional(),
  }),
  removeSceneEvent: z.object({
    sessionId,
    scene: sceneName,
    target: eventSelectorSchema,
    dryRun: z.boolean().optional(),
  }),
  validateSceneEvents: z.object({
    sessionId,
    scene: sceneName,
    events: z.array(eventNodeSchema).min(1).describe('Event tree to validate without mutation'),
  }),
};

export type EventsSchemas = typeof eventsSchemas;

function mutate<TArgs, TResult>(
  deps: CommandDeps,
  schema: z.ZodType<TArgs>,
  args: unknown,
  apply: (context: MutationContext<TArgs>) => TResult,
): TResult {
  return runMutation(deps.store, deps.engine, {
    sessionId: (args as { sessionId: string }).sessionId,
    schema,
    args,
    apply,
  });
}

function checkJsCodeMarker(events: EventNodeInput[]): void {
  const visit = (nodes: EventNodeInput[]): void => {
    for (const node of nodes) {
      if (node.kind === 'jscode' && !hasJsCodeMarker(node.inlineCode)) {
        throw validationFailed(
          `JsCode event refused: free JsCode is not allowed; inline code must contain the marker "${JSCODE_MARKER_COMMENT}".`,
        );
      }
      if ('events' in node && node.events) visit(node.events);
    }
  };
  visit(events);
}

/** dryRun wrapper: full pipeline, then memory restore + prior dirty flag restore. */
function withDryRun<TArgs, TResult>(
  deps: CommandDeps,
  schema: z.ZodType<TArgs>,
  args: unknown,
  apply: (context: MutationContext<TArgs>) => TResult,
): TResult {
  const session = deps.store.get((args as { sessionId: string }).sessionId);
  const snapshot = deps.engine.serializeProject(session.project);
  const wasDirty = session.dirty;
  try {
    return mutate(deps, schema, args, apply);
  } finally {
    deps.engine.restoreProject(session.project, snapshot);
    if (wasDirty) deps.store.markDirty(session.id);
    else deps.store.clearDirty(session.id);
  }
}

export function appendSceneEvents(
  deps: CommandDeps,
  args: unknown,
): { appended: number; ids: string[]; paths: number[][]; dryRun: boolean } {
  const parsed = eventsSchemas.appendSceneEvents.parse(args);
  checkJsCodeMarker(parsed.events);
  if (parsed.dryRun === true) {
    const result = withDryRun(deps, eventsSchemas.appendSceneEvents, args, ({ project, args: inner }) => {
      return deps.engine.appendSceneEvents(project, {
        scene: inner.scene,
        events: inner.events,
        position: inner.position,
      });
    });
    return { ...result, dryRun: true };
  }
  return mutate(deps, eventsSchemas.appendSceneEvents, args, ({ project, args: inner }) => {
    return deps.engine.appendSceneEvents(project, {
      scene: inner.scene,
      events: inner.events,
      position: inner.position,
    });
  });
}

export function moveSceneEvent(deps: CommandDeps, args: unknown): { moved: boolean; dryRun: boolean } {
  const parsed = eventsSchemas.moveSceneEvent.parse(args);
  if (parsed.dryRun === true) {
    const result = withDryRun(deps, eventsSchemas.moveSceneEvent, args, ({ project, args: inner }) => {
      return deps.engine.moveSceneEvent(project, {
        scene: inner.scene,
        from: inner.from,
        toPosition: inner.toPosition,
        toParent: inner.toParent,
      });
    });
    return { ...result, dryRun: true };
  }
  return mutate(deps, eventsSchemas.moveSceneEvent, args, ({ project, args: inner }) => {
    return deps.engine.moveSceneEvent(project, {
      scene: inner.scene,
      from: inner.from,
      toPosition: inner.toPosition,
      toParent: inner.toParent,
    });
  });
}

export function removeSceneEvent(deps: CommandDeps, args: unknown): { removed: boolean; dryRun: boolean } {
  const parsed = eventsSchemas.removeSceneEvent.parse(args);
  if (parsed.dryRun === true) {
    const result = withDryRun(deps, eventsSchemas.removeSceneEvent, args, ({ project, args: inner }) => {
      return deps.engine.removeSceneEvent(project, { scene: inner.scene, target: inner.target });
    });
    return { ...result, dryRun: true };
  }
  return mutate(deps, eventsSchemas.removeSceneEvent, args, ({ project, args: inner }) => {
    return deps.engine.removeSceneEvent(project, { scene: inner.scene, target: inner.target });
  });
}

export function validateSceneEvents(deps: CommandDeps, args: unknown): { valid: boolean; errors: string[] } {
  const parsed = eventsSchemas.validateSceneEvents.parse(args);
  checkJsCodeMarker(parsed.events);
  const session = deps.store.get(parsed.sessionId);
  return deps.engine.validateSceneEvents(session.project, parsed.scene, parsed.events);
}
