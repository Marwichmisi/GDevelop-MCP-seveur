import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { closeProject, createProject, describeProject, openProject, saveProject, type CommandDeps } from './commands.js';

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
  for (const tool of createProjectTools(deps)) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, tool.handler);
  }
}
