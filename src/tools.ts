import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { closeProject, createProject, describeProject, openProject, saveProject, type CommandDeps } from './commands.js';
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

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[] }>;
}

function text(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

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
      description: 'Open an existing single-file .json project into a new session. Folder-projects are refused.',
      inputSchema: { path: z.string().min(1).describe('Absolute path to the .json project file') },
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
      description: 'Close a session. Refuses when dirty unless force:true.',
      inputSchema: {
        sessionId: z.string().uuid().describe('Session UUID'),
        force: z.boolean().optional().describe('Discard unsaved changes'),
      },
      handler: async (args) =>
        text(closeProject(deps, { sessionId: args['sessionId'] as string, force: args['force'] as boolean | undefined })),
    },
  ];
}

export function registerProjectTools(server: McpServer, deps: CommandDeps, catalog?: Catalog): void {
  const tools = [...createProjectTools(deps), ...createContentTools(deps), ...createEventTools(deps)];
  if (catalog) tools.push(...createCatalogTools(catalog));
  for (const tool of tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, tool.handler);
  }
}

function contentTool<K extends keyof typeof contentSchemas>(
  name: string,
  description: string,
  schemaKey: K,
  command: (deps: CommandDeps, args: unknown) => unknown,
  deps: CommandDeps,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: contentSchemas[schemaKey].shape,
    handler: async (args) => text(command(deps, args)),
  };
}

function eventTool<K extends keyof typeof eventsSchemas>(
  name: string,
  description: string,
  schemaKey: K,
  command: (deps: CommandDeps, args: unknown) => unknown,
  deps: CommandDeps,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: eventsSchemas[schemaKey].shape,
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
    ),
    contentTool('rename_object', 'Rename an object (instances and groups follow).', 'renameObject', renameObject, deps),
    contentTool('remove_object', 'Delete an object and purge its instances and group memberships.', 'removeObject', removeObject, deps),
    contentTool('attach_behavior', 'Attach a behavior to an object.', 'attachBehavior', attachBehavior, deps),
    contentTool('update_behavior', 'Update behavior properties (names are case-insensitive).', 'updateBehavior', updateBehavior, deps),
    contentTool('remove_behavior', 'Remove a behavior from an object.', 'removeBehavior', removeBehavior, deps),
    contentTool('place_instance', 'Place an object instance in a scene; returns its instance id.', 'placeInstance', placeInstance, deps),
    contentTool('update_instance', 'Patch an instance by id (position, layer, size, variables…).', 'updateInstance', updateInstance, deps),
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
    contentTool('set_variable', 'Set a free-JSON variable in any scope (global, scene, object, instance).', 'setVariable', setVariable, deps),
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
  ];
}

/** The 4 event tools: one thin wrapper per event command, same payloads as batch (#17). */
export function createEventTools(deps: CommandDeps): ToolDefinition[] {
  return [
    eventTool(
      'append_scene_events',
      'Append a recursive native-event tree (Standard, Else, Repeat, While, ForEach, Group, Comment, Link, JsCode-marker) with L1+L2 validation.',
      'appendSceneEvents',
      appendSceneEvents,
      deps,
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
      'Validate an event tree without mutation (L1+L2 + JsCode marker).',
      'validateSceneEvents',
      validateSceneEvents,
      deps,
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

