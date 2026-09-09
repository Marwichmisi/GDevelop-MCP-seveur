/**
 * Engine seam. The command layer only ever talks to libGD.js through this
 * port interface — never through raw `gd` handles or the MCP transport.
 *
 * Two implementations exist: the real WASM-backed adapter in `runtime.ts`
 * and the in-memory fakes under `test/`. This file is the contract between
 * them. It deliberately covers only the surface the scaffold needs; later
 * tickets extend it (layouts, objects, events, …).
 */

import type { ContentView, JsonValue } from './contentView.js';
import { validationFailed } from './errors.js';

/** Opaque engine object. Only the engine implementation may touch it. */
export interface EngineProject {
  delete(): void;
}

export type { ContentView, JsonValue };

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

/** Inline behavior declaration for object creation and behavior attach. */
export interface BehaviorInput {
  type: string;
  name?: string | undefined;
  properties?: Record<string, string | number | boolean> | undefined;
}

export interface CreateObjectInput {
  /** Absent = project-level (global) object, present = scene object. */
  scene?: string | undefined;
  type: string;
  name: string;
  behaviors?: BehaviorInput[] | undefined;
  variables?: Record<string, JsonValue> | undefined;
  /** Sprite collision-mask flag; refused on other object types. */
  collisionMaskAutomatic?: boolean | undefined;
}

export interface AttachBehaviorInput {
  scene?: string | undefined;
  object: string;
  type: string;
  name?: string | undefined;
  properties?: Record<string, string | number | boolean> | undefined;
}

export interface UpdateBehaviorInput {
  scene?: string | undefined;
  object: string;
  name: string;
  properties: Record<string, string | number | boolean>;
}

export interface RemoveBehaviorInput {
  scene?: string | undefined;
  object: string;
  name: string;
}

export interface PlaceInstanceInput {
  scene: string;
  object: string;
  x: number;
  y: number;
  z?: number | undefined;
  layer?: string | undefined;
  zOrder?: number | undefined;
  angle?: number | undefined;
  opacity?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  keepRatio?: boolean | undefined;
  variables?: Record<string, JsonValue> | undefined;
}

export interface UpdateInstancePatch {
  object?: string | undefined;
  x?: number | undefined;
  y?: number | undefined;
  z?: number | undefined;
  layer?: string | undefined;
  zOrder?: number | undefined;
  angle?: number | undefined;
  opacity?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  keepRatio?: boolean | undefined;
  /** Merged per key over the instance variables. */
  variables?: Record<string, JsonValue> | undefined;
}

export type VariableScope = 'global' | 'scene' | 'object' | 'instance';

export interface VariableTarget {
  scope: VariableScope;
  scene?: string | undefined;
  object?: string | undefined;
  instanceId?: string | undefined;
}

export interface ImportResourceInput {
  name: string;
  kind: string;
  /** Project-relative file path of the already-copied binary. */
  file: string;
}

/** Single condition/action instruction: positional string parameters, faithful to the engine. */
export interface EventInstructionInput {
  type: string;
  parameters: string[];
  inverted?: boolean | undefined;
  awaited?: boolean | undefined;
}

export type EventKind =
  | 'standard'
  | 'else'
  | 'repeat'
  | 'while'
  | 'foreach'
  | 'foreachChildVariable'
  | 'group'
  | 'comment'
  | 'link'
  | 'jscode';

interface EventNodeBase {
  kind: EventKind;
  conditions?: EventInstructionInput[] | undefined;
  actions?: EventInstructionInput[] | undefined;
  events?: EventNodeInput[] | undefined;
  disabled?: boolean | undefined;
}

export interface StandardEventInput extends EventNodeBase {
  kind: 'standard';
}

export interface ElseEventInput extends EventNodeBase {
  kind: 'else';
}

export interface RepeatEventInput extends EventNodeBase {
  kind: 'repeat';
  repeatExpression: string;
  loopIndexVariable?: string | undefined;
}

export interface WhileEventInput extends EventNodeBase {
  kind: 'while';
  whileConditions: EventInstructionInput[];
}

export interface ForEachEventInput extends EventNodeBase {
  kind: 'foreach';
  object: string;
  loopIndexVariable?: string | undefined;
}

export interface ForEachChildVariableEventInput extends EventNodeBase {
  kind: 'foreachChildVariable';
  iterableVariable: string;
  keyIterator?: string | undefined;
  valueIterator?: string | undefined;
}

export interface GroupEventInput {
  kind: 'group';
  name: string;
  source?: string | undefined;
  events?: EventNodeInput[] | undefined;
  disabled?: boolean | undefined;
}

export interface CommentEventInput {
  kind: 'comment';
  comment: string;
}

export interface LinkEventInput {
  kind: 'link';
  target: string;
  includeAll?: boolean | undefined;
  eventsGroup?: string | undefined;
  includeStart?: number | undefined;
  includeEnd?: number | undefined;
}

export interface JsCodeEventInput {
  kind: 'jscode';
  inlineCode: string;
  parameterObjects?: string | undefined;
}

export type EventNodeInput =
  | StandardEventInput
  | ElseEventInput
  | RepeatEventInput
  | WhileEventInput
  | ForEachEventInput
  | ForEachChildVariableEventInput
  | GroupEventInput
  | CommentEventInput
  | LinkEventInput
  | JsCodeEventInput;

/** Event selector: immediate index path or stable stamped id (resolved by traversal). */
export type EventSelector = { path: number[] } | { id: string };

export interface AppendEventsInput {
  scene: string;
  events: EventNodeInput[];
  position?: number | undefined;
  dryRun?: boolean | undefined;
}

export interface AppendEventsResult {
  appended: number;
  ids: string[];
  paths: number[][];
  dryRun: boolean;
}

export interface MoveEventInput {
  scene: string;
  from: EventSelector;
  toPosition: number;
  toParent?: EventSelector | undefined;
  dryRun?: boolean | undefined;
}

export interface RemoveEventInput {
  scene: string;
  target: EventSelector;
  dryRun?: boolean | undefined;
}

/** Default behavior name: short type name (after the last `::`). */
export function shortBehaviorName(type: string): string {
  const short = type.split('::').pop() ?? type;
  if (short === '') throw validationFailed(`Behavior type must not be empty.`);
  return short;
}

/** Resource kinds accepted by import_resource (each maps to an engine resource class). */
export const SUPPORTED_RESOURCE_KINDS = [
  'image',
  'audio',
  'font',
  'bitmapFont',
  'video',
  'json',
  'atlas',
  'tilemap',
  'tileset',
  'spine',
  'model3d',
  'javascript',
] as const;

export interface EnginePorts {
  createProject(name: string): EngineProject;
  loadProjectFromJson(json: string, projectFile: string): EngineProject;
  serializeProject(project: EngineProject): string;
  restoreProject(project: EngineProject, snapshot: string): void;
  listDiagnostics(project: EngineProject): EngineDiagnostic[];
  updateBehaviorsSharedData(project: EngineProject): void;
  describeProject(project: EngineProject): ProjectSummary;
  describeContent(project: EngineProject): ContentView;
  setProjectName(project: EngineProject, name: string): void;
  setProjectFile(project: EngineProject, path: string): void;
  // --- Content (ticket #13). Every method validates everything before
  // mutating anything and throws `validation-failed` on refusal, so a
  // rejected call leaves the project untouched. ---
  createScene(project: EngineProject, name: string): void;
  renameScene(project: EngineProject, oldName: string, newName: string): void;
  moveScene(project: EngineProject, name: string, position: number): void;
  deleteScene(project: EngineProject, name: string): void;
  createLayer(project: EngineProject, scene: string, name: string): void;
  renameLayer(project: EngineProject, scene: string, oldName: string, newName: string): void;
  moveLayer(project: EngineProject, scene: string, name: string, position: number): void;
  deleteLayer(project: EngineProject, scene: string, name: string): void;
  createObject(project: EngineProject, input: CreateObjectInput): void;
  renameObject(project: EngineProject, scene: string | undefined, oldName: string, newName: string): void;
  deleteObject(project: EngineProject, scene: string | undefined, name: string): void;
  attachBehavior(project: EngineProject, input: AttachBehaviorInput): { name: string };
  updateBehavior(project: EngineProject, input: UpdateBehaviorInput): void;
  removeBehavior(project: EngineProject, input: RemoveBehaviorInput): void;
  placeInstance(project: EngineProject, input: PlaceInstanceInput): { instanceId: string };
  updateInstance(project: EngineProject, scene: string, instanceId: string, patch: UpdateInstancePatch): void;
  removeInstance(project: EngineProject, scene: string, instanceId: string): void;
  removeInstancesOfObject(project: EngineProject, scene: string, object: string): { removed: number };
  moveInstancesToLayer(project: EngineProject, scene: string, sourceLayer: string, targetLayer: string): { moved: number };
  setVariable(project: EngineProject, target: VariableTarget, name: string, value: JsonValue): void;
  removeVariable(project: EngineProject, target: VariableTarget, name: string): void;
  renameVariable(project: EngineProject, target: VariableTarget, oldName: string, newName: string): void;
  createGroup(project: EngineProject, scene: string | undefined, name: string, objects: string[]): void;
  deleteGroup(project: EngineProject, scene: string | undefined, name: string): void;
  addObjectToGroup(project: EngineProject, scene: string | undefined, group: string, object: string): void;
  removeObjectFromGroup(project: EngineProject, scene: string | undefined, group: string, object: string): void;
  importResource(project: EngineProject, input: ImportResourceInput): { name: string };
  removeResource(project: EngineProject, name: string): void;
  // --- Events (ticket #14). Every method validates everything before
  // mutating anything and throws `validation-failed` on refusal, so a
  // rejected call leaves the project untouched. Ids are stamped at creation
  // via `setAiGeneratedEventId` and resolved by traversal. ---
  appendSceneEvents(project: EngineProject, input: AppendEventsInput): AppendEventsResult;
  moveSceneEvent(project: EngineProject, input: MoveEventInput): { moved: boolean; dryRun: boolean };
  removeSceneEvent(project: EngineProject, input: RemoveEventInput): { removed: boolean; dryRun: boolean };
  validateSceneEvents(project: EngineProject, scene: string, events: EventNodeInput[]): { valid: boolean; errors: string[] };
}
