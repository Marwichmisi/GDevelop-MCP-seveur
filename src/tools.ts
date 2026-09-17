import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { closeProjectWithPreviews, createProject, describeProject, openProject, saveProject, undoLastEdit, type CommandDeps } from './commands.js';
import {
  addObject,
  addToGroup,
  attachBehavior,
  contentSchemas,
  createGroup,
  createLayer,
  createScene,
  deleteGroup,
  deleteLayer,
  deleteScene,
  importResource,
  moveInstancesToLayer,
  moveLayer,
  moveScene,
  placeInstance,
  removeBehavior,
  removeFromGroup,
  removeInstance,
  removeInstancesOfObject,
  removeObject,
  removeResource,
  removeVariable,
  renameLayer,
  renameObject,
  renameScene,
  renameVariable,
  setVariable,
  updateBehavior,
  updateInstance,
} from './content.js';
import {
  appendSceneEvents,
  eventsSchemas,
  moveSceneEvent,
  removeSceneEvent,
  validateSceneEvents,
} from './events.js';
import { applyContentBatch, batchSchema } from './batch.js';
import {
  catalogSchemas,
  catalogStatus,
  describeBehavior,
  describeExtension,
  describeInstructions,
  describeObject,
  listBehaviorTypes,
  listExtensions,
  listInstructions,
  listObjectTypes,
  searchInstructions,
  type Catalog,
} from './catalog.js';
import {
  assetSchemas,
  assetStatus,
  getAssetDetails,
  getExampleDetails,
  importAssetsIntoProject,
  listExamples,
  openExample,
  searchAssets,
  type AssetStore,
} from './assets.js';
import {
  previewSchemas,
  type PreviewRecord,
  type StaticRenderResult,
} from './preview.js';

export interface ToolDefinition {
  name: string;
  title?: string | undefined;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  annotations?: {
    readOnlyHint?: boolean | undefined;
    destructiveHint?: boolean | undefined;
    idempotentHint?: boolean | undefined;
    openWorldHint?: boolean | undefined;
  } | undefined;
  handler: (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[] }>;
}

function text(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/**
 * Exposed MCP schemas must stay non-recursive: most providers reject
 * recursive JSON Schemas entirely (one bad tool breaks every request).
 * Internal validation still uses the full recursive `contentSchemas` /
 * `eventsSchemas`; what follows is only the LLM-facing shape.
 */
const freeJsonValue = z.unknown().describe('Free JSON value (string, number, boolean, null, array, object; validated server-side)');
const freeVariables = z
  .record(freeJsonValue)
  .optional()
  .describe('Variables as free JSON (objects, arrays, primitives; validated server-side)');
const exposedEventTree = z
  .array(z.unknown())
  .min(1)
  .describe(
    'Event tree: array of {kind,...} nodes (standard, else, repeat, while, foreach, foreachChildVariable, group, comment, link, jscode with gdevelop-mcp:scene-script marker). Sub-events nest under `events`. Fully validated server-side (L1+L2).',
  );

/** Tool = thin zod wrapper over the headless command layer. */
export function createProjectTools(deps: CommandDeps): ToolDefinition[] {
  return [
    {
      name: 'create_project',
      description: 'Create a new empty GDJS project session and receive its UUID.',
      inputSchema: { name: z.string().min(1).optional().describe('Project name') },
      handler: async (args) => text(createProject(deps, { name: args['name'] as string | undefined })),
    },
    {
      name: 'open_project',
      description: 'Open an existing project into a new session: single-file .json or folder-project directory (unsplit + events-functions extensions loaded).',
      inputSchema: { path: z.string().min(1).describe('Absolute path to the .json project file or folder-project directory') },
      handler: async (args) => text(openProject(deps, { path: args['path'] as string })),
    },
    {
      name: 'describe_project',
      description: 'Describe a session (scenes, objects, behaviors, variables, event counts) as JSON. No WASM handles leak.',
      inputSchema: { sessionId: z.string().uuid().describe('Session UUID') },
      handler: async (args) => text(describeProject(deps, { sessionId: args['sessionId'] as string })),
    },
    {
      name: 'save_project',
      description: 'Save a session atomically (timestamped backup + tmp+rename). Refuses when blocking diagnostics exist.',
      inputSchema: {
        sessionId: z.string().uuid().describe('Session UUID'),
        path: z.string().min(1).optional().describe('Absolute target path (defaults to the opened file)'),
      },
      handler: async (args) =>
        text(saveProject(deps, { sessionId: args['sessionId'] as string, path: args['path'] as string | undefined })),
    },
    {
      name: 'close_project',
      title: 'Close project session',
      description: 'Close a session. Refuses when dirty unless force:true. Stops linked previews first.',
      inputSchema: {
        sessionId: z.string().uuid().describe('Session UUID'),
        force: z.boolean().optional().describe('Discard unsaved changes'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) =>
        text(await closeProjectWithPreviews(deps, { sessionId: args['sessionId'] as string, force: args['force'] as boolean | undefined })),
    },
    {
      name: 'undo_last_edit',
      description:
        'Restore the pre-save state (memory + disk, atomic tmp+rename) from the -pre-restore copy written at save. One-shot per save.',
      inputSchema: { sessionId: z.string().uuid().describe('Session UUID') },
      handler: async (args) => text(undoLastEdit(deps, { sessionId: args['sessionId'] as string })),
    },
  ];
}

export function registerProjectTools(server: McpServer, deps: CommandDeps, catalog?: Catalog, assets?: AssetStore): void {
  const tools = [...createProjectTools(deps), ...createContentTools(deps), ...createEventTools(deps)];
  if (catalog) tools.push(...createCatalogTools(catalog));
  if (assets) tools.push(...createAssetTools(deps, assets));
  if (deps.previews) tools.push(...createPreviewTools(deps.previews as unknown as PreviewPorts));
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { ...(tool.title ? { title: tool.title } : {}), description: tool.description, inputSchema: tool.inputSchema, ...(tool.annotations ? { annotations: tool.annotations } : {}) },
      tool.handler,
    );
  }
}

function contentTool<K extends keyof typeof contentSchemas>(
  name: string,
  description: string,
  schemaKey: K,
  command: (deps: CommandDeps, args: unknown) => unknown,
  deps: CommandDeps,
  exposedOverride?: Record<string, z.ZodTypeAny>,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { ...contentSchemas[schemaKey].shape, ...exposedOverride },
    handler: async (args) => text(command(deps, args)),
  };
}

function eventTool<K extends keyof typeof eventsSchemas>(
  name: string,
  description: string,
  schemaKey: K,
  command: (deps: CommandDeps, args: unknown) => unknown,
  deps: CommandDeps,
  exposedOverride?: Record<string, z.ZodTypeAny>,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { ...eventsSchemas[schemaKey].shape, ...exposedOverride },
    handler: async (args) => text(command(deps, args)),
  };
}

/** The 28 content tools: one thin wrapper per content command, same payloads as batch (#17). */
export function createContentTools(deps: CommandDeps): ToolDefinition[] {
  return [
    contentTool('create_scene', 'Create a scene (layout) appended at the end.', 'createScene', createScene, deps),
    contentTool('rename_scene', 'Rename a scene.', 'renameScene', renameScene, deps),
    contentTool('move_scene', 'Move a scene to a position (clamped).', 'moveScene', moveScene, deps),
    contentTool('delete_scene', 'Delete a scene and all its content.', 'deleteScene', deleteScene, deps),
    contentTool('create_layer', 'Create a layer in a scene.', 'createLayer', createLayer, deps),
    contentTool('rename_layer', 'Rename a layer (instances follow).', 'renameLayer', renameLayer, deps),
    contentTool('move_layer', 'Move a layer to a position (clamped).', 'moveLayer', moveLayer, deps),
    contentTool('delete_layer', 'Delete a layer. Refuses when instances still use it.', 'deleteLayer', deleteLayer, deps),
    contentTool(
      'add_object',
      'Create a native object (Sprite, Text, …) with inline behaviors, variables and collision flag.',
      'addObject',
      addObject,
      deps,
      { variables: freeVariables },
    ),
    contentTool('rename_object', 'Rename an object (instances and groups follow).', 'renameObject', renameObject, deps),
    contentTool('remove_object', 'Delete an object and purge its instances and group memberships.', 'removeObject', removeObject, deps),
    contentTool('attach_behavior', 'Attach a behavior to an object.', 'attachBehavior', attachBehavior, deps),
    contentTool('update_behavior', 'Update behavior properties (names are case-insensitive).', 'updateBehavior', updateBehavior, deps),
    contentTool('remove_behavior', 'Remove a behavior from an object.', 'removeBehavior', removeBehavior, deps),
    contentTool('place_instance', 'Place an object instance in a scene; returns its instance id.', 'placeInstance', placeInstance, deps, {
      variables: freeVariables,
    }),
    contentTool('update_instance', 'Patch an instance by id (position, layer, size, variables…).', 'updateInstance', updateInstance, deps, {
      variables: freeVariables,
    }),
    contentTool('remove_instance', 'Remove a single instance by id.', 'removeInstance', removeInstance, deps),
    contentTool(
      'remove_instances_of_object',
      'Bulk-remove every instance of an object in a scene.',
      'removeInstancesOfObject',
      removeInstancesOfObject,
      deps,
    ),
    contentTool(
      'move_instances_to_layer',
      'Bulk-move every instance from one layer to another.',
      'moveInstancesToLayer',
      moveInstancesToLayer,
      deps,
    ),
    contentTool('set_variable', 'Set a free-JSON variable in any scope (global, scene, object, instance).', 'setVariable', setVariable, deps, {
      value: freeJsonValue,
    }),
    contentTool('remove_variable', 'Remove a variable in any scope.', 'removeVariable', removeVariable, deps),
    contentTool('rename_variable', 'Rename a variable in any scope.', 'renameVariable', renameVariable, deps),
    contentTool('create_group', 'Create an object group with optional members.', 'createGroup', createGroup, deps),
    contentTool('delete_group', 'Delete an object group.', 'deleteGroup', deleteGroup, deps),
    contentTool('add_to_group', 'Add an object to a group.', 'addToGroup', addToGroup, deps),
    contentTool('remove_from_group', 'Remove an object from a group.', 'removeFromGroup', removeFromGroup, deps),
    contentTool(
      'import_resource',
      'Copy a binary next to the project and register it as a resource.',
      'importResource',
      importResource,
      deps,
    ),
    contentTool('remove_resource', 'Unregister a resource (the file stays on disk).', 'removeResource', removeResource, deps),
    {
      name: 'apply_content_batch',
      description:
        'Replay granular content+event payloads all-or-nothing (snapshot global + gate baseline + dryRun + semantic diff). Per-op dryRun is forbidden.',
      inputSchema: batchSchema.shape,
      handler: async (args) => text(applyContentBatch(deps, args)),
    },
  ];
}

/** The 4 event tools: one thin wrapper per event command, same payloads as batch (#17). */
export function createEventTools(deps: CommandDeps): ToolDefinition[] {
  return [
    eventTool(
      'append_scene_events',
      'Append a recursive native-event tree (Standard, Else, Repeat, While, ForEach, Group, Comment, Link, JsCode-marker) with L1+L2 validation. L1 namespace rule: bare name for no-namespace extensions (VarScene), prefixed otherwise (BuiltinCommonInstructions::CompareNumbers); both forms accepted and normalized to canonical.',
      'appendSceneEvents',
      appendSceneEvents,
      deps,
      { events: exposedEventTree },
    ),
    eventTool(
      'move_scene_event',
      'Move an event by {path}|{id} selector to a new position (same or different parent).',
      'moveSceneEvent',
      moveSceneEvent,
      deps,
    ),
    eventTool(
      'remove_scene_event',
      'Remove an event by {path}|{id} selector.',
      'removeSceneEvent',
      removeSceneEvent,
      deps,
    ),
    eventTool(
      'validate_scene_events',
      'Validate an event tree without mutation (L1+L2 + JsCode marker). L1 namespace rule: bare name for no-namespace extensions (VarScene), prefixed otherwise (BuiltinCommonInstructions::CompareNumbers); both forms accepted.',
      'validateSceneEvents',
      validateSceneEvents,
      deps,
      { events: exposedEventTree },
    ),
  ];
}

function catalogTool<K extends keyof typeof catalogSchemas>(
  name: string,
  description: string,
  schemaKey: K,
  command: (catalog: Catalog, args: unknown) => unknown,
  catalog: Catalog,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: catalogSchemas[schemaKey].shape,
    handler: async (args) => text(await command(catalog, args)),
  };
}

/**
 * The 10 read-only catalogue tools (ticket #15). They never touch a session:
 * they read the pinned GDevelop sources through `Catalog` and expose the pinned
 * ref/sha on every payload. The engine still judges every write.
 */
export function createCatalogTools(catalog: Catalog): ToolDefinition[] {
  return [
    catalogTool(
      'catalog_status',
      'Show the pinned catalogue versions (ref, sha, syncedAt), staleness vs the latest GDevelop release, and indexed counts. refresh:true re-reads the pinned sources.',
      'status',
      catalogStatus,
      catalog,
    ),
    catalogTool(
      'list_instructions',
      'List pinned GDevelop instructions (actions, conditions, expressions, str-expressions) with parameters. English as written in the sources; the engine judges at write time.',
      'listInstructions',
      listInstructions,
      catalog,
    ),
    catalogTool(
      'search_instructions',
      'Search pinned GDevelop instructions by case-insensitive query over type, full name, description and extension.',
      'searchInstructions',
      searchInstructions,
      catalog,
    ),
    catalogTool(
      'describe_instructions',
      'Describe every pinned catalogue entry matching an instruction type (duals share a type across kinds).',
      'describeInstructions',
      describeInstructions,
      catalog,
    ),
    catalogTool(
      'list_object_types',
      'List object types declared by the pinned GDevelop extensions, with their full engine type (Extension::Name).',
      'listObjectTypes',
      listObjectTypes,
      catalog,
    ),
    catalogTool(
      'list_behavior_types',
      'List behavior types declared by the pinned GDevelop extensions, with their full engine type (Extension::Name).',
      'listBehaviorTypes',
      listBehaviorTypes,
      catalog,
    ),
    catalogTool(
      'describe_object',
      'Describe an object type from the pinned catalogue (extension, source file, events-based flag).',
      'describeObject',
      describeObject,
      catalog,
    ),
    catalogTool(
      'describe_behavior',
      'Describe a behavior type from the pinned catalogue (extension, source file, events-based flag).',
      'describeBehavior',
      describeBehavior,
      catalog,
    ),
    catalogTool(
      'list_extensions',
      'List extensions found in the pinned GDevelop sources with their instruction/object/behavior counts and events-based declarations.',
      'listExtensions',
      listExtensions,
      catalog,
    ),
    catalogTool(
      'describe_extension',
      'Describe one pinned extension by name (full name, description, counts, events-based objects/behaviors).',
      'describeExtension',
      describeExtension,
      catalog,
    ),
  ];
}

function assetTool<K extends keyof typeof assetSchemas>(
  name: string,
  description: string,
  schemaKey: K,
  action: (store: AssetStore, args: unknown) => unknown,
  store: AssetStore,
  annotations?: ToolDefinition['annotations'],
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: assetSchemas[schemaKey].shape,
    ...(annotations ? { annotations } : {}),
    handler: async (args) => text(await action(store, args)),
  };
}

/**
 * The 7 Asset Store tools (issue #18). Read-only search/details plus the
 * targeted import (moteur, tout-ou-rien) and read-only example sessions.
 * Private/premium packs are refused cleanly (public CDN only).
 */
export function createAssetTools(deps: CommandDeps, store: AssetStore): ToolDefinition[] {
  return [
    assetTool(
      'asset_status',
      'Show the pinned Asset Store versions (public CDN, TTL 1h) and indexed counts. refresh:true re-reads the cached lists.',
      'status',
      assetStatus,
      store,
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    ),
    assetTool(
      'search_assets',
      'Search public Asset Store headers by query/tags/objectType/license/pack. Exposes licenses and preview URLs; the engine judges at import time.',
      'searchAssets',
      searchAssets,
      store,
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    ),
    assetTool(
      'get_asset_details',
      'Show one public asset (version, authors, license, objectAssets with type/resources/requiredExtensions). Private assets are refused at import time.',
      'getAssetDetails',
      getAssetDetails,
      store,
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    ),
    {
      name: 'import_assets_into_project',
      description:
        'Import targeted assets into a session ({pack, packVersion, assets} targeted by default, "all" opt-in): required-extension check with explicit refusal, local copy + import_resource, engine deserialization via Serializer.fromJSObject with `as` rename on collision. Private/premium refused. All-or-nothing.',
      inputSchema: assetSchemas.importAssets.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: async (args) => text(await importAssetsIntoProject(deps, store, args)),
    },
    assetTool(
      'list_examples',
      'List public GDevelop examples by query/tags/license/difficulty. Read-only.',
      'listExamples',
      listExamples,
      store,
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    ),
    assetTool(
      'get_example_details',
      'Show one public example by id or slug (license, projectFileUrl, usedExtensions). Read-only.',
      'getExampleDetails',
      getExampleDetails,
      store,
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    ),
    {
      name: 'open_example',
      description: 'Open a public example projectFileUrl in a read-only session (describe only, no save, no mutation).',
      inputSchema: assetSchemas.openExample.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: async (args) => text(await openExample(deps, store, args)),
    },
  ];
}

/** Minimal structural seam for the preview manager (avoids a tools↔preview import cycle). */
export interface PreviewPorts {
  renderStatic(input: unknown): StaticRenderResult;
  build(input: unknown): Promise<PreviewRecord>;
  status(previewId?: string | undefined): PreviewRecord;
  stop(previewId: string): Promise<{ stopped: true; previewId: string }>;
}

/**
 * The 4 preview tools (issue #16). Schemas are strict zod (`.strict()` is
 * enforced at call time via `previewSchemas` parse); annotations follow the
 * mcp-builder checklist so clients can reason about side effects.
 */
export function createPreviewTools(previews: PreviewPorts): ToolDefinition[] {
  return [
    {
      name: 'render_scene_static',
      title: 'Render scene (static)',
      description:
        'Instant static render of a scene (<1s, pure SVG over the content view, no browser). Use after each mutation for a fast visual check; use build_preview for the playable build.',
      inputSchema: previewSchemas.renderSceneStatic.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => text(previews.renderStatic(args)),
    },
    {
      name: 'build_preview',
      title: 'Build playable preview',
      description:
        'Build a playable GDJS preview from the live memory session (no save, project file untouched) and serve it on 127.0.0.1. Rebuilds only when dirty (sha256); same-hash builds reuse the live export. Logs always carry export lines; GDJS console entries appear after a browser capture (withScreenshot). Screenshot is opt-in and slow.',
      inputSchema: previewSchemas.buildPreview.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => text(await previews.build(args)),
    },
    {
      name: 'get_preview_status',
      title: 'Get preview status',
      description: 'Show a preview record (url, scene, logs, screenshot). No previewId = newest active preview.',
      inputSchema: previewSchemas.getPreviewStatus.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args) => text(previews.status(args['previewId'] as string | undefined)),
    },
    {
      name: 'stop_preview',
      title: 'Stop preview',
      description: 'Stop a preview: close its loopback server and delete its temp dir. TTL (30 min) does the same automatically.',
      inputSchema: previewSchemas.stopPreview.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      handler: async (args) => text(await previews.stop(args['previewId'] as string)),
    },
  ];
}

