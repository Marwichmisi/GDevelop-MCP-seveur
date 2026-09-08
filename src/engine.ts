/**
 * Engine seam. The command layer only ever talks to libGD.js through this
 * port interface — never through raw `gd` handles or the MCP transport.
 *
 * Two implementations exist: the real WASM-backed adapter in `runtime.ts`
 * and the in-memory fakes under `test/`. This file is the contract between
 * them. It deliberately covers only the surface the scaffold needs; later
 * tickets extend it (layouts, objects, events, …).
 */

/** Opaque engine object. Only the engine implementation may touch it. */
export interface EngineProject {
  delete(): void;
}

/** The four blocking diagnostic types (ProjectDiagnostic_ErrorType). Any new
 *  error of these kinds after a mutation refuses the write. Single source of
 *  truth for the names; `runtime.ts` maps the numeric engine enum onto these. */
export const BLOCKING_DIAGNOSTIC_TYPES = [
  'UndeclaredVariable',
  'MissingBehavior',
  'UnknownObject',
  'MismatchedObjectType',
] as const;

export type BlockingDiagnosticType = (typeof BLOCKING_DIAGNOSTIC_TYPES)[number];

export interface EngineDiagnostic {
  type: string;
  message: string;
}

export function isBlockingDiagnostic(diagnostic: EngineDiagnostic): boolean {
  return (BLOCKING_DIAGNOSTIC_TYPES as readonly string[]).includes(diagnostic.type);
}

/** "Type: message; …" rendering shared by the pipeline and save gates. */
export function formatDiagnostics(diagnostics: EngineDiagnostic[]): string {
  return diagnostics.map((diagnostic) => `${diagnostic.type}: ${diagnostic.message}`).join('; ');
}

export interface ProjectSummary {
  name: string;
  projectFile: string;
  layoutCount: number;
  objectCount: number;
  behaviorCount: number;
  globalVariableCount: number;
  eventCount: number;
}

export interface EnginePorts {
  createProject(name: string): EngineProject;
  loadProjectFromJson(json: string, projectFile: string): EngineProject;
  serializeProject(project: EngineProject): string;
  restoreProject(project: EngineProject, snapshot: string): void;
  listDiagnostics(project: EngineProject): EngineDiagnostic[];
  updateBehaviorsSharedData(project: EngineProject): void;
  describeProject(project: EngineProject): ProjectSummary;
  setProjectName(project: EngineProject, name: string): void;
  setProjectFile(project: EngineProject, path: string): void;
}
