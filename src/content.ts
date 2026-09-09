import { copyFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { SUPPORTED_RESOURCE_KINDS } from './engine.js';
import type { JsonValue } from './contentView.js';
import { validationFailed } from './errors.js';
import { runMutation, type MutationContext } from './pipeline.js';
import type { CommandDeps } from './commands.js';

/**
 * Content ops (ticket #13): every mutation travels schema → headless
 * engine call → shared pipeline (snapshot, round-trip, diagnostics gate).
 * The zod schemas are exported so `apply_content_batch` (ticket #17) replays
 * exactly the same payloads.
 */

const sessionId = z.string().uuid().describe('Session UUID');
const sceneName = z.string().min(1).describe('Scene name');
const optionalScene = z.string().min(1).optional().describe('Scene name; absent = project-level (global)');
const objectName = z.string().min(1).describe('Object name');
const propertyMap = z
  .record(z.union([z.string(), z.number(), z.boolean()]))
  .describe('Behavior properties as strings; booleans use "1"/"0"');

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(jsonValueSchema)]),
);

const behaviorInput = z.object({
  type: z.string().min(1).describe('Behavior type, e.g. PlatformBehavior::PlatformerObjectBehavior'),
  name: z.string().min(1).optional().describe('Behavior name; defaults to the short type name'),
  properties: propertyMap.optional().describe('Initial behavior properties'),
});

const variableTarget = z.object({
  scope: z.enum(['global', 'scene', 'object', 'instance']).describe('Variable scope'),
  scene: z.string().min(1).optional().describe('Scene (scopes scene, object, instance)'),
  object: z.string().min(1).optional().describe('Object (scope object)'),
  instanceId: z.string().min(1).optional().describe('Instance id (scope instance)'),
});

export const contentSchemas = {
  createScene: z.object({ sessionId, name: sceneName }),
  renameScene: z.object({ sessionId, name: sceneName, newName: z.string().min(1) }),
  moveScene: z.object({ sessionId, name: sceneName, position: z.number().int() }),
  deleteScene: z.object({ sessionId, name: sceneName }),
  createLayer: z.object({ sessionId, scene: sceneName, name: z.string().describe('Layer name') }),
  renameLayer: z.object({
    sessionId,
    scene: sceneName,
    name: z.string().describe('Current layer name ("" = base layer, protected)'),
    newName: z.string().min(1),
  }),
  moveLayer: z.object({ sessionId, scene: sceneName, name: z.string(), position: z.number().int() }),
  deleteLayer: z.object({
    sessionId,
    scene: sceneName,
    name: z.string().describe('Layer name ("" = base layer, protected)'),
  }),
  addObject: z.object({
    sessionId,
    scene: optionalScene,
    type: z.string().min(1).describe('Object type, e.g. Sprite or TextObject::Text'),
    name: objectName,
    behaviors: z.array(behaviorInput).optional(),
    variables: z.record(jsonValueSchema).optional().describe('Initial object variables as free JSON'),
    collisionMaskAutomatic: z.boolean().optional().describe('Sprite collision-mask flag (Sprite only)'),
  }),
  renameObject: z.object({ sessionId, scene: optionalScene, name: objectName, newName: z.string().min(1) }),
  removeObject: z.object({ sessionId, scene: optionalScene, name: objectName }),
  attachBehavior: z.object({
    sessionId,
    scene: optionalScene,
    object: objectName,
    type: z.string().min(1),
    name: z.string().min(1).optional(),
    properties: propertyMap.optional(),
  }),
  updateBehavior: z.object({ sessionId, scene: optionalScene, object: objectName, name: z.string().min(1), properties: propertyMap }),
  removeBehavior: z.object({ sessionId, scene: optionalScene, object: objectName, name: z.string().min(1) }),
  placeInstance: z.object({
    sessionId,
    scene: sceneName,
    object: objectName,
    x: z.number(),
    y: z.number(),
    z: z.number().optional(),
    layer: z.string().optional().describe('Layer name; absent = base layer'),
    zOrder: z.number().int().optional(),
    angle: z.number().optional(),
    opacity: z.number().int().min(0).max(255).optional(),
    width: z.number().nonnegative().optional(),
    height: z.number().nonnegative().optional(),
    keepRatio: z.boolean().optional(),
    variables: z.record(jsonValueSchema).optional().describe('Per-instance variables as free JSON'),
  }),
  updateInstance: z.object({
    sessionId,
    scene: sceneName,
    instanceId: z.string().min(1).describe('Instance id returned by place_instance'),
    object: objectName.optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    z: z.number().optional(),
    layer: z.string().optional(),
    zOrder: z.number().int().optional(),
    angle: z.number().optional(),
    opacity: z.number().int().min(0).max(255).optional(),
    width: z.number().nonnegative().optional(),
    height: z.number().nonnegative().optional(),
    keepRatio: z.boolean().optional(),
    variables: z.record(jsonValueSchema).optional().describe('Merged per key over the instance variables'),
  }),
  removeInstance: z.object({ sessionId, scene: sceneName, instanceId: z.string().min(1) }),
  removeInstancesOfObject: z.object({ sessionId, scene: sceneName, object: objectName }),
  moveInstancesToLayer: z.object({ sessionId, scene: sceneName, sourceLayer: z.string(), targetLayer: z.string() }),
  setVariable: z.object({
    sessionId,
    target: variableTarget,
    name: z.string().min(1).describe('Variable name'),
    value: jsonValueSchema.describe('Free JSON value (primitives, structures, arrays; no null)'),
  }),
  removeVariable: z.object({ sessionId, target: variableTarget, name: z.string().min(1) }),
  renameVariable: z.object({ sessionId, target: variableTarget, name: z.string().min(1), newName: z.string().min(1) }),
  createGroup: z.object({
    sessionId,
    scene: optionalScene,
    name: z.string().min(1).describe('Group name'),
    objects: z.array(z.string().min(1)).optional().describe('Initial member object names'),
  }),
  deleteGroup: z.object({ sessionId, scene: optionalScene, name: z.string().min(1) }),
  addToGroup: z.object({ sessionId, scene: optionalScene, group: z.string().min(1), object: objectName }),
  removeFromGroup: z.object({ sessionId, scene: optionalScene, group: z.string().min(1), object: objectName }),
  importResource: z.object({
    sessionId,
    name: z.string().min(1).optional().describe('Resource name; defaults to the file base name without extension'),
    kind: z.enum(SUPPORTED_RESOURCE_KINDS as unknown as [string, ...string[]]).describe('Resource kind'),
    sourcePath: z.string().min(1).describe('Absolute path of the binary to copy next to the project'),
    targetPath: z.string().min(1).optional().describe('Absolute save path (defaults to the session file)'),
  }),
  removeResource: z.object({ sessionId, name: z.string().min(1) }),
};

export type ContentSchemas = typeof contentSchemas;

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

export function createScene(deps: CommandDeps, args: unknown): { name: string } {
  return mutate(deps, contentSchemas.createScene, args, ({ project, args: parsed }) => {
    deps.engine.createScene(project, parsed.name);
    return { name: parsed.name };
  });
}

export function renameScene(deps: CommandDeps, args: unknown): { name: string } {
  return mutate(deps, contentSchemas.renameScene, args, ({ project, args: parsed }) => {
    deps.engine.renameScene(project, parsed.name, parsed.newName);
    return { name: parsed.newName };
  });
}

export function moveScene(deps: CommandDeps, args: unknown): { name: string; position: number } {
  return mutate(deps, contentSchemas.moveScene, args, ({ project, args: parsed }) => {
    deps.engine.moveScene(project, parsed.name, parsed.position);
    return { name: parsed.name, position: parsed.position };
  });
}

export function deleteScene(deps: CommandDeps, args: unknown): { name: string } {
  return mutate(deps, contentSchemas.deleteScene, args, ({ project, args: parsed }) => {
    deps.engine.deleteScene(project, parsed.name);
    return { name: parsed.name };
  });
}

export function createLayer(deps: CommandDeps, args: unknown): { scene: string; name: string } {
  return mutate(deps, contentSchemas.createLayer, args, ({ project, args: parsed }) => {
    deps.engine.createLayer(project, parsed.scene, parsed.name);
    return { scene: parsed.scene, name: parsed.name };
  });
}

export function renameLayer(deps: CommandDeps, args: unknown): { scene: string; name: string } {
  return mutate(deps, contentSchemas.renameLayer, args, ({ project, args: parsed }) => {
    deps.engine.renameLayer(project, parsed.scene, parsed.name, parsed.newName);
    return { scene: parsed.scene, name: parsed.newName };
  });
}

export function moveLayer(deps: CommandDeps, args: unknown): { scene: string; name: string; position: number } {
  return mutate(deps, contentSchemas.moveLayer, args, ({ project, args: parsed }) => {
    deps.engine.moveLayer(project, parsed.scene, parsed.name, parsed.position);
    return { scene: parsed.scene, name: parsed.name, position: parsed.position };
  });
}

export function deleteLayer(deps: CommandDeps, args: unknown): { scene: string; name: string } {
  return mutate(deps, contentSchemas.deleteLayer, args, ({ project, args: parsed }) => {
    deps.engine.deleteLayer(project, parsed.scene, parsed.name);
    return { scene: parsed.scene, name: parsed.name };
  });
}

export function addObject(deps: CommandDeps, args: unknown): { name: string; type: string } {
  return mutate(deps, contentSchemas.addObject, args, ({ project, args: parsed }) => {
    deps.engine.createObject(project, {
      scene: parsed.scene,
      type: parsed.type,
      name: parsed.name,
      behaviors: parsed.behaviors,
      variables: parsed.variables as Record<string, JsonValue> | undefined,
      collisionMaskAutomatic: parsed.collisionMaskAutomatic,
    });
    return { name: parsed.name, type: parsed.type };
  });
}

export function renameObject(deps: CommandDeps, args: unknown): { name: string } {
  return mutate(deps, contentSchemas.renameObject, args, ({ project, args: parsed }) => {
    deps.engine.renameObject(project, parsed.scene, parsed.name, parsed.newName);
    return { name: parsed.newName };
  });
}

export function removeObject(deps: CommandDeps, args: unknown): { name: string } {
  return mutate(deps, contentSchemas.removeObject, args, ({ project, args: parsed }) => {
    deps.engine.deleteObject(project, parsed.scene, parsed.name);
    return { name: parsed.name };
  });
}

export function attachBehavior(deps: CommandDeps, args: unknown): { name: string } {
  return mutate(deps, contentSchemas.attachBehavior, args, ({ project, args: parsed }) => {
    return deps.engine.attachBehavior(project, {
      scene: parsed.scene,
      object: parsed.object,
      type: parsed.type,
      name: parsed.name,
      properties: parsed.properties,
    });
  });
}

export function updateBehavior(deps: CommandDeps, args: unknown): { name: string } {
  return mutate(deps, contentSchemas.updateBehavior, args, ({ project, args: parsed }) => {
    deps.engine.updateBehavior(project, {
      scene: parsed.scene,
      object: parsed.object,
      name: parsed.name,
      properties: parsed.properties,
    });
    return { name: parsed.name };
  });
}

export function removeBehavior(deps: CommandDeps, args: unknown): { name: string } {
  return mutate(deps, contentSchemas.removeBehavior, args, ({ project, args: parsed }) => {
    deps.engine.removeBehavior(project, { scene: parsed.scene, object: parsed.object, name: parsed.name });
    return { name: parsed.name };
  });
}

export function placeInstance(deps: CommandDeps, args: unknown): { instanceId: string } {
  return mutate(deps, contentSchemas.placeInstance, args, ({ project, args: parsed }) => {
    return deps.engine.placeInstance(project, {
      scene: parsed.scene,
      object: parsed.object,
      x: parsed.x,
      y: parsed.y,
      z: parsed.z,
      layer: parsed.layer,
      zOrder: parsed.zOrder,
      angle: parsed.angle,
      opacity: parsed.opacity,
      width: parsed.width,
      height: parsed.height,
      keepRatio: parsed.keepRatio,
      variables: parsed.variables as Record<string, JsonValue> | undefined,
    });
  });
}

export function updateInstance(deps: CommandDeps, args: unknown): { instanceId: string } {
  return mutate(deps, contentSchemas.updateInstance, args, ({ project, args: parsed }) => {
    const { sessionId: _sessionId, scene, instanceId, ...patch } = parsed;
    void _sessionId;
    deps.engine.updateInstance(project, scene, instanceId, {
      ...patch,
      variables: patch.variables as Record<string, JsonValue> | undefined,
    });
    return { instanceId };
  });
}

export function removeInstance(deps: CommandDeps, args: unknown): { instanceId: string } {
  return mutate(deps, contentSchemas.removeInstance, args, ({ project, args: parsed }) => {
    deps.engine.removeInstance(project, parsed.scene, parsed.instanceId);
    return { instanceId: parsed.instanceId };
  });
}

export function removeInstancesOfObject(deps: CommandDeps, args: unknown): { removed: number } {
  return mutate(deps, contentSchemas.removeInstancesOfObject, args, ({ project, args: parsed }) => {
    return deps.engine.removeInstancesOfObject(project, parsed.scene, parsed.object);
  });
}

export function moveInstancesToLayer(deps: CommandDeps, args: unknown): { moved: number } {
  return mutate(deps, contentSchemas.moveInstancesToLayer, args, ({ project, args: parsed }) => {
    return deps.engine.moveInstancesToLayer(project, parsed.scene, parsed.sourceLayer, parsed.targetLayer);
  });
}

export function setVariable(deps: CommandDeps, args: unknown): { name: string } {
  return mutate(deps, contentSchemas.setVariable, args, ({ project, args: parsed }) => {
    deps.engine.setVariable(
      project,
      parsed.target,
      parsed.name,
      parsed.value as JsonValue,
    );
    return { name: parsed.name };
  });
}

export function removeVariable(deps: CommandDeps, args: unknown): { name: string } {
  return mutate(deps, contentSchemas.removeVariable, args, ({ project, args: parsed }) => {
    deps.engine.removeVariable(project, parsed.target, parsed.name);
    return { name: parsed.name };
  });
}

export function renameVariable(deps: CommandDeps, args: unknown): { name: string } {
  return mutate(deps, contentSchemas.renameVariable, args, ({ project, args: parsed }) => {
    deps.engine.renameVariable(project, parsed.target, parsed.name, parsed.newName);
    return { name: parsed.newName };
  });
}

export function createGroup(deps: CommandDeps, args: unknown): { name: string } {
  return mutate(deps, contentSchemas.createGroup, args, ({ project, args: parsed }) => {
    deps.engine.createGroup(project, parsed.scene, parsed.name, parsed.objects ?? []);
    return { name: parsed.name };
  });
}

export function deleteGroup(deps: CommandDeps, args: unknown): { name: string } {
  return mutate(deps, contentSchemas.deleteGroup, args, ({ project, args: parsed }) => {
    deps.engine.deleteGroup(project, parsed.scene, parsed.name);
    return { name: parsed.name };
  });
}

export function addToGroup(deps: CommandDeps, args: unknown): { group: string; object: string } {
  return mutate(deps, contentSchemas.addToGroup, args, ({ project, args: parsed }) => {
    deps.engine.addObjectToGroup(project, parsed.scene, parsed.group, parsed.object);
    return { group: parsed.group, object: parsed.object };
  });
}

export function removeFromGroup(deps: CommandDeps, args: unknown): { group: string; object: string } {
  return mutate(deps, contentSchemas.removeFromGroup, args, ({ project, args: parsed }) => {
    deps.engine.removeObjectFromGroup(project, parsed.scene, parsed.group, parsed.object);
    return { group: parsed.group, object: parsed.object };
  });
}

export function importResource(deps: CommandDeps, args: unknown): { name: string } {
  let parsed: z.infer<typeof contentSchemas.importResource>;
  try {
    parsed = contentSchemas.importResource.parse(args);
  } catch (error) {
    throw validationFailed('Invalid mutation arguments.', { cause: error });
  }
  const session = deps.store.get(parsed.sessionId);
  const source = deps.store.resolvePath(parsed.sourcePath);
  let sourceStat;
  try {
    sourceStat = statSync(source);
  } catch {
    throw validationFailed(`Resource source not found: ${source}.`);
  }
  if (!sourceStat.isFile()) throw validationFailed(`Resource source is not a file: ${source}.`);
  const rawTarget = parsed.targetPath ?? session.filePath;
  if (!rawTarget) {
    throw validationFailed('No project location: save the session first or pass targetPath.');
  }
  const target = deps.store.resolvePath(rawTarget);
  const fileName = basename(source);
  const destination = join(dirname(target), fileName);
  const name = parsed.name ?? fileName.replace(/\.[^.]*$/, '') ?? fileName;
  if (name === '') throw validationFailed(`Cannot derive a resource name from ${fileName}; pass name explicitly.`);
  let copied = false;
  try {
    copyFileSync(source, destination);
    copied = true;
    return runMutation(deps.store, deps.engine, {
      sessionId: parsed.sessionId,
      schema: contentSchemas.importResource,
      args,
      apply: ({ project }) => deps.engine.importResource(project, { name, kind: parsed.kind, file: fileName }),
    });
  } catch (error) {
    if (copied && existsSync(destination)) {
      try {
        unlinkSync(destination);
      } catch {
        // Best effort: the failed import must not leave a stray binary behind.
      }
    }
    throw error;
  }
}

export function removeResource(deps: CommandDeps, args: unknown): { name: string } {
  return mutate(deps, contentSchemas.removeResource, args, ({ project, args: parsed }) => {
    deps.engine.removeResource(project, parsed.name);
    return { name: parsed.name };
  });
}
