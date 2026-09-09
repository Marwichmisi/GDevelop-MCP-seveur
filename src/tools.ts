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

export function registerProjectTools(server: McpServer, deps: CommandDeps): void {
  for (const tool of [...createProjectTools(deps), ...createContentTools(deps)]) {
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
