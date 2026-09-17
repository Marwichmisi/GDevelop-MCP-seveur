import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpError, validationFailed } from './errors.js';
import { NO_NAMESPACE_EXTENSIONS } from './catalog.js';
import {
  checkObjectType,
  clampPosition,
  containerWhere,
  objectsContainer,
  requireLayout,
  setVariableValue,
} from './engineShared.js';
import { createSceneObjectPorts } from './sceneObjects.js';
import { JSCODE_MARKER_COMMENT, hasJsCodeMarker } from './events.js';
import {
  loadProjectEventsFunctionsExtensionsSync,
  makeNodeEventsFunctionCodeWriter,
  unloadProjectEventsFunctionsExtensionsSync,
} from './eventsFunctions.js';
import {
  BLOCKING_DIAGNOSTIC_TYPES,
  shortBehaviorName,
  type AppendEventsInput,
  type AppendEventsResult,
  type AttachBehaviorInput,
  type CreateObjectInput,
  type EngineDiagnostic,
  type EnginePorts,
  type EngineProject,
  type EventInstructionInput,
  type EventNodeInput,
  type EventSelector,
  type ImportResourceInput,
  type InstallAssetObjectInput,
  type MoveEventInput,
  type PlaceInstanceInput,
  type ProjectSummary,
  type RemoveBehaviorInput,
  type RemoveEventInput,
  type UpdateBehaviorInput,
  type UpdateInstancePatch,
  type VariableTarget,
} from './engine.js';
import {
  readContentView,
  toVariableNode,
  type ContentView,
  type JsonValue,
  type SerializedLayout,
  type SerializedProject,
  type SerializedVariable,
} from './contentView.js';

/**
 * Real libGD.js adapter. Verified against the S3 prebuilt 5.6.281-0 build:
 * CJS initializer, `await init({ locateFile })`, `initializePlatforms()` once
 * per process, `Serializer.toJSON/fromJSObject`, diagnostics via
 * `WholeProjectDiagnosticReport.count/get(i)` with numeric
 * `ProjectDiagnostic.getType()` mapped through the `_emscripten_enum_*`
 * bindings (0..3 = the four blocking types).
 *
 * The structural types below cover only the surface the scaffold needs. They
 * will be replaced by the generated `gd.d.ts` once provisioning pins a build
 * with type generation (see the spec, provisioning decision).
 */

interface GdSerializerElement {
  delete(): void;
}

interface GdDiagnostic {
  getType(): number;
  getMessage(): string;
}

interface GdDiagnosticReport {
  count(): number;
  get(index: number): GdDiagnostic;
  delete(): void;
}

interface GdStringVector {
  size(): number;
  delete(): void;
}

interface GdVectorString extends GdStringVector {
  at(index: number): string;
}

interface GdPropertyDescriptor {
  getValue(): string;
}

interface GdProperties {
  has(name: string): boolean;
  get(name: string): GdPropertyDescriptor;
  keys(): GdVectorString;
}

export interface GdBehaviorHandle {
  getProperties(): GdProperties;
  updateProperty(name: string, value: string): boolean;
}

interface GdVariablesContainer {
  insertNew(name: string, index: number): GdVariableHandle;
  has(name: string): boolean;
  get(name: string): GdVariableHandle;
  remove(name: string): void;
  rename(oldName: string, newName: string): void;
  count(): number;
}

export interface GdVariableHandle {
  setValue(value: number): void;
  setString(value: string): void;
  setBool(value: boolean): void;
  castTo(type: string): void;
  clearChildren(): void;
  getChild(name: string): GdVariableHandle;
  pushNew(): GdVariableHandle;
}

interface GdGroupHandle {
  getName(): string;
  addObject(name: string): void;
  removeObject(name: string): void;
  find(name: string): boolean;
}

interface GdGroupsContainer {
  insertNew(name: string, position: number): GdGroupHandle;
  has(name: string): boolean;
  get(name: string): GdGroupHandle;
  getAt(index: number): GdGroupHandle;
  remove(name: string): void;
  count(): number;
}

interface GdObjectHandle {
  setName(name: string): void;
  unserializeFrom(project: GdProjectHandle, element: GdSerializerElement): void;
  resetPersistentUuid(): void;
  setAssetStoreId(id: string): void;
  addNewBehavior(project: GdProjectHandle, type: string, name: string): GdBehaviorHandle;
  hasBehaviorNamed(name: string): boolean;
  getBehavior(name: string): GdBehaviorHandle;
  removeBehavior(name: string): void;
  getVariables(): GdVariablesContainer;
  getConfiguration(): unknown;
}

export interface GdObjectsContainer {
  insertNewObject(project: GdProjectHandle, type: string, name: string, position: number): GdObjectHandle;
  hasObjectNamed(name: string): boolean;
  getObject(name: string): GdObjectHandle;
  getObjectAt(index: number): { getAllBehaviorNames(): GdVectorString };
  removeObject(name: string): void;
  getObjectsCount(): number;
  getObjectGroups(): GdGroupsContainer;
}

interface GdInstanceHandle {
  getPersistentUuid(): string;
  setObjectName(name: string): void;
  setX(value: number): void;
  setY(value: number): void;
  setZ(value: number): void;
  setLayer(name: string): void;
  setZOrder(value: number): void;
  setAngle(value: number): void;
  setOpacity(value: number): void;
  setCustomWidth(value: number): void;
  setCustomHeight(value: number): void;
  setHasCustomSize(value: boolean): void;
  setShouldKeepRatio(value: boolean): void;
  getVariables(): GdVariablesContainer;
}

interface GdInstancesContainer {
  insertNewInitialInstance(): GdInstanceHandle;
  removeInstance(instance: GdInstanceHandle): void;
  removeInitialInstancesOfObject(name: string): void;
  moveInstancesToLayer(sourceLayer: string, targetLayer: string): void;
  renameInstancesOfObject(oldName: string, newName: string): void;
  getInstancesCount(): number;
  getLayerInstancesCount(layer: string): number;
}

interface GdLayerHandle {
  getName(): string;
  setName(name: string): void;
}

interface GdLayersContainer {
  insertNewLayer(name: string, position: number): void;
  hasLayerNamed(name: string): boolean;
  getLayer(name: string): GdLayerHandle;
  getLayerAt(index: number): GdLayerHandle;
  removeLayer(name: string): void;
  moveLayer(oldIndex: number, newIndex: number): void;
  getLayersCount(): number;
}

interface GdInstructionHandle {
  setType(type: string): void;
  setParametersCount(count: number): void;
  setParameter(index: number, value: string): void;
  setInverted(inverted: boolean): void;
  setAwaited(awaited: boolean): void;
  delete(): void;
}

interface GdInstructionsList {
  insert(instr: GdInstructionHandle, pos: number): void;
  size(): number;
}

interface GdBaseEvent {
  getType(): string;
  getAiGeneratedEventId(): string;
  setAiGeneratedEventId(id: string): void;
  setDisabled(disabled: boolean): void;
  canHaveSubEvents(): boolean;
  getSubEvents(): GdEventsList;
}

interface GdEventsList {
  getEventsCount(): number;
  getEventAt(index: number): GdBaseEvent;
  insertNewEvent(project: GdProjectHandle, type: string, pos: number): GdBaseEvent;
  removeEventAt(pos: number): void;
  moveEventToAnotherEventsList(event: GdBaseEvent, newList: GdEventsList, newPos: number): void;
}

interface GdStandardEvent extends GdBaseEvent {
  getConditions(): GdInstructionsList;
  getActions(): GdInstructionsList;
}

interface GdRepeatEvent extends GdStandardEvent {
  setRepeatExpressionPlainString(expr: string): void;
  setLoopIndexVariableName(name: string): void;
}

interface GdWhileEvent extends GdStandardEvent {
  getWhileConditions(): GdInstructionsList;
  setLoopIndexVariableName(name: string): void;
}

interface GdForEachEvent extends GdStandardEvent {
  setObjectToPick(object: string): void;
  setLoopIndexVariableName(name: string): void;
}

interface GdForEachChildVariableEvent extends GdStandardEvent {
  setIterableVariableName(name: string): void;
  setKeyIteratorVariableName(name: string): void;
  setValueIteratorVariableName(name: string): void;
  setLoopIndexVariableName(name: string): void;
}

interface GdGroupEvent extends GdBaseEvent {
  setName(name: string): void;
  setSource(source: string): void;
}

interface GdCommentEvent extends GdBaseEvent {
  setComment(comment: string): void;
}

interface GdLinkEvent extends GdBaseEvent {
  setTarget(target: string): void;
  setIncludeAllEvents(): void;
  setIncludeEventsGroup(group: string): void;
  setIncludeStartAndEnd(start: number, end: number): void;
}

interface GdJsCodeEvent extends GdBaseEvent {
  setInlineCode(code: string): void;
  setParameterObjects(objects: string): void;
}

export interface GdLayoutHandle {
  getName(): string;
  setName(name: string): void;
  getObjects(): GdObjectsContainer;
  getInitialInstances(): GdInstancesContainer;
  getVariables(): GdVariablesContainer;
  getLayers(): GdLayersContainer;
  getEvents(): GdEventsList;
  updateBehaviorsSharedData(project: GdProjectHandle): void;
}

interface GdResourcesContainer {
  addResource(resource: GdResourceHandle): boolean;
  hasResource(name: string): boolean;
  removeResource(name: string): void;
}

interface GdResourceHandle {
  setName(name: string): void;
  setFile(file: string): void;
  setKind(kind: string): void;
  setUserAdded(userAdded: boolean): void;
  delete(): void;
}

export interface GdProjectHandle extends EngineProject {
  serializeTo(element: GdSerializerElement): void;
  unserializeFrom(element: GdSerializerElement): void;
  updateBehaviorsSharedData(): void;
  getWholeProjectDiagnosticReport(): GdDiagnosticReport;
  setProjectFile(path: string): void;
  getProjectFile(): string;
  setName(name: string): void;
  getName(): string;
  getLayoutsCount(): number;
  getCurrentPlatform(): unknown;
  hasLayoutNamed(name: string): boolean;
  getLayout(name: string): GdLayoutHandle;
  getLayoutAt(index: number): GdLayoutHandle;
  getLayoutPosition(name: string): number;
  insertNewLayout(name: string, position: number): GdLayoutHandle;
  removeLayout(name: string): void;
  moveLayout(oldIndex: number, newIndex: number): void;
  getObjects(): GdObjectsContainer;
  getResourcesManager(): GdResourcesContainer;
  getVariables(): GdVariablesContainer;
  isFolderProject(): boolean;
  setFolderProject(value: boolean): void;
  getEventsFunctionsExtensionsCount(): number;
  getEventsFunctionsExtensionAt(index: number): unknown;
}

interface GdExtensionModule {
  createExtension: (identity: (text: string) => string, gd: GdNamespace) => { delete(): void };
  runExtensionSanityTests?: (gd: GdNamespace, extension: { delete(): void }) => unknown[];
}

export interface GdNamespace {
  ProjectHelper: {
    initializePlatforms(): void;
    createNewGDJSProject(): GdProjectHandle;
  };
  Serializer: {
    toJSON(element: GdSerializerElement): string;
    fromJSObject(object: unknown): GdSerializerElement;
  };
  SerializerElement: new () => GdSerializerElement;
  Project: new () => GdProjectHandle;
  Instruction: new () => GdInstructionHandle;
  JsPlatform: { get(): { addNewExtension(extension: { delete(): void }): void } };
  PlatformExtension: new () => unknown;
  MetadataProvider: {
    getObjectMetadata(platform: unknown, type: string): unknown;
    isBadObjectMetadata(metadata: unknown): boolean;
    getBehaviorMetadata(platform: unknown, type: string): unknown;
    isBadBehaviorMetadata(metadata: unknown): boolean;
    getActionMetadata(platform: unknown, type: string): { getParametersCount(): number };
    getConditionMetadata(platform: unknown, type: string): { getParametersCount(): number };
    isBadInstructionMetadata(metadata: unknown): boolean;
  };
  asStandardEvent(event: GdBaseEvent): GdStandardEvent;
  asElseEvent(event: GdBaseEvent): GdStandardEvent;
  asRepeatEvent(event: GdBaseEvent): GdRepeatEvent;
  asWhileEvent(event: GdBaseEvent): GdWhileEvent;
  asForEachEvent(event: GdBaseEvent): GdForEachEvent;
  asForEachChildVariableEvent(event: GdBaseEvent): GdForEachChildVariableEvent;
  asGroupEvent(event: GdBaseEvent): GdGroupEvent;
  asCommentEvent(event: GdBaseEvent): GdCommentEvent;
  asLinkEvent(event: GdBaseEvent): GdLinkEvent;
  asJsCodeEvent(event: GdBaseEvent): GdJsCodeEvent;
  asSpriteConfiguration(configuration: unknown): {
    getAnimations(): { setAdaptCollisionMaskAutomatically(value: boolean): void };
  };
  ImageResource: new () => GdResourceHandle;
  AudioResource: new () => GdResourceHandle;
  FontResource: new () => GdResourceHandle;
  BitmapFontResource: new () => GdResourceHandle;
  VideoResource: new () => GdResourceHandle;
  JsonResource: new () => GdResourceHandle;
  AtlasResource: new () => GdResourceHandle;
  TilemapResource: new () => GdResourceHandle;
  TilesetResource: new () => GdResourceHandle;
  SpineResource: new () => GdResourceHandle;
  Model3DResource: new () => GdResourceHandle;
  JavaScriptResource: new () => GdResourceHandle;
  [key: string]: unknown;
}

function readDiagnosticTypeName(gd: GdNamespace, numericType: number): string {
  for (const name of BLOCKING_DIAGNOSTIC_TYPES) {
    const binding = gd[`_emscripten_enum_ProjectDiagnostic_ErrorType_${name}`];
    const value = typeof binding === 'function' ? (binding as () => number)() : binding;
    if (value === numericType) return name;
  }
  return `UnknownDiagnosticType(${numericType})`;
}

/** An instance may point at a scene object or a global one. */
function objectUsableInScene(project: GdProjectHandle, scene: string, name: string): boolean {
  return (
    project.getLayout(scene).getObjects().hasObjectNamed(name) || project.getObjects().hasObjectNamed(name)
  );
}

function liveVariablesContainer(project: GdProjectHandle, target: VariableTarget): GdVariablesContainer {
  switch (target.scope) {
    case 'global':
      return project.getVariables();
    case 'scene': {
      if (target.scene === undefined) throw validationFailed('Variable target "scene" requires a scene name.');
      return requireLayout(project, target.scene).getVariables();
    }
    case 'object': {
      if (target.object === undefined) throw validationFailed('Variable target "object" requires an object name.');
      const container = objectsContainer(project, target.scene);
      if (!container.hasObjectNamed(target.object)) {
        throw validationFailed(`Unknown object "${target.object}" in ${containerWhere(target.scene)}.`);
      }
      return container.getObject(target.object).getVariables();
    }
    case 'instance':
      throw validationFailed('Instance variables travel through the instance bridge (unreachable).');
  }
}

/** Serialize the live project into plain JSON (read-only; no handles escape). */
function serializeLive(gd: GdNamespace, project: EngineProject): SerializedProject {
  const element = new gd.SerializerElement();
  try {
    (project as GdProjectHandle).serializeTo(element);
    return JSON.parse(gd.Serializer.toJSON(element)) as SerializedProject;
  } finally {
    element.delete();
  }
}

/** Feed engine-produced JSON back through the engine deserializer (instance bridge). */
function unserializeLive(gd: GdNamespace, project: EngineProject, doc: SerializedProject): void {
  const element = gd.Serializer.fromJSObject(doc);
  try {
    (project as GdProjectHandle).unserializeFrom(element);
  } finally {
    element.delete();
  }
}

function requireLayoutDoc(doc: SerializedProject, scene: string): SerializedLayout {
  const layout = (doc.layouts ?? []).find((candidate) => candidate.name === scene);
  if (!layout) throw validationFailed(`Unknown scene "${scene}".`);
  return layout;
}

function requireInstanceIndex(doc: SerializedProject, scene: string, instanceId: string): number {
  const instances = requireLayoutDoc(doc, scene).instances ?? [];
  const index = instances.findIndex((candidate) => candidate.persistentUuid === instanceId);
  if (index === -1) throw validationFailed(`Unknown instance "${instanceId}" in scene "${scene}".`);
  return index;
}

function mergeVariableNodes(
  nodes: SerializedVariable[],
  entries: Record<string, JsonValue>,
): SerializedVariable[] {
  const merged = [...nodes];
  for (const [key, value] of Object.entries(entries)) {
    const node = toVariableNode(key, value);
    const index = merged.findIndex((candidate) => candidate.name === key);
    if (index === -1) merged.push(node);
    else merged[index] = node;
  }
  return merged;
}

const RESOURCE_CONSTRUCTORS = {
  image: 'ImageResource',
  audio: 'AudioResource',
  font: 'FontResource',
  bitmapFont: 'BitmapFontResource',
  video: 'VideoResource',
  json: 'JsonResource',
  atlas: 'AtlasResource',
  tilemap: 'TilemapResource',
  tileset: 'TilesetResource',
  spine: 'SpineResource',
  model3d: 'Model3DResource',
  javascript: 'JavaScriptResource',
} as const;

// --- Native events (ticket #14) ---

const EVENT_TYPE_STRINGS: Record<EventNodeInput['kind'], string> = {
  standard: 'BuiltinCommonInstructions::Standard',
  else: 'BuiltinCommonInstructions::Else',
  repeat: 'BuiltinCommonInstructions::Repeat',
  while: 'BuiltinCommonInstructions::While',
  foreach: 'BuiltinCommonInstructions::ForEach',
  foreachChildVariable: 'BuiltinCommonInstructions::ForEachChildVariable',
  group: 'BuiltinCommonInstructions::Group',
  comment: 'BuiltinCommonInstructions::Comment',
  link: 'BuiltinCommonInstructions::Link',
  jscode: 'BuiltinCommonInstructions::JsCode',
};

/**
 * 1.1 #32 — Règle L1 namespace (le moteur juge, documentée ici).
 *
 * Canonique = nom exact exigé par `MetadataProvider` :
 * - extensions sans namespace (BuiltinVariables, BuiltinKeyboard,
 *   BuiltinMouse, BuiltinTime, BuiltinObject, Sprite, … — cf
 *   `NO_NAMESPACE_EXTENSIONS` dans `catalog.ts`) → nom nu (`VarScene`,
 *   `ModVarScene`, `KeyPressed`, …) ;
 * - extension `BuiltinCommonInstructions` (à namespace) → nom préfixé
 *   (`BuiltinCommonInstructions::CompareNumbers`, `::CompareStrings`,
 *   `::Once`).
 * Sondé live sur libGD 5.6.281 : `VarScene` nu valide mais
 * `BuiltinVariables::VarScene` inconnu ; `CompareNumbers` nu inconnu mais
 * `BuiltinCommonInstructions::CompareNumbers` valide (idem Once).
 *
 * Tolérance L1 : les deux formes sont acceptées et normalisées vers le
 * canonique à l'écriture (`validate` accepte, `append` stocke le canonique).
 */
export const COMMON_INSTRUCTIONS_NAMESPACE = 'BuiltinCommonInstructions::';

function instructionMetadata(
  gd: GdNamespace,
  platform: unknown,
  type: string,
  role: 'condition' | 'action' | 'while-condition',
): { bad: boolean; parametersCount: number } {
  const metadata =
    role === 'action'
      ? gd.MetadataProvider.getActionMetadata(platform, type)
      : gd.MetadataProvider.getConditionMetadata(platform, type);
  if (gd.MetadataProvider.isBadInstructionMetadata(metadata)) return { bad: true, parametersCount: -1 };
  return { bad: false, parametersCount: metadata.getParametersCount() };
}

/** Résout un type d'instruction vers sa forme canonique moteur, ou `null` (L1). */
export function resolveInstructionType(
  gd: GdNamespace,
  project: GdProjectHandle,
  raw: string,
  role: 'condition' | 'action' | 'while-condition',
): string | null {
  const platform = project.getCurrentPlatform();
  // 1. Forme exacte d'abord (canonique, zéro surprise).
  if (!instructionMetadata(gd, platform, raw, role).bad) return raw;
  // 2. Forme préfixée tolérée vers nue, uniquement lorsque le préfixe est
  // une extension sans namespace connue (`BuiltinVariables::VarScene` →
  // `VarScene`). Tout autre préfixe reste un refus (typo non masquée).
  const separator = raw.lastIndexOf('::');
  if (separator > 0) {
    const prefix = raw.slice(0, separator);
    const suffix = raw.slice(separator + 2);
    if (suffix !== '' && NO_NAMESPACE_EXTENSIONS.has(prefix) && !instructionMetadata(gd, platform, suffix, role).bad) {
      return suffix;
    }
    return null;
  }
  // 3. Forme nue tolérée vers `BuiltinCommonInstructions::…`
  // (`CompareNumbers` → `BuiltinCommonInstructions::CompareNumbers`).
  const prefixed = `${COMMON_INSTRUCTIONS_NAMESPACE}${raw}`;
  if (!instructionMetadata(gd, platform, prefixed, role).bad) return prefixed;
  return null;
}

function checkEventInstruction(
  gd: GdNamespace,
  project: GdProjectHandle,
  instr: EventInstructionInput,
  role: 'condition' | 'action' | 'while-condition',
): void {
  const platform = project.getCurrentPlatform();
  const canonical = resolveInstructionType(gd, project, instr.type, role);
  if (canonical === null) {
    throw validationFailed(
      `Unknown ${role} type "${instr.type}" (L1). Règle namespace : nom nu pour les extensions sans namespace ` +
        `(VarScene), préfixé sinon (BuiltinCommonInstructions::CompareNumbers, TextObject::String) ; ` +
        `les deux formes sont acceptées et normalisées quand elles ne sont pas ambiguës.`,
    );
  }
  const expected = instructionMetadata(gd, platform, canonical, role).parametersCount;
  if (instr.parameters.length !== expected) {
    throw validationFailed(
      `Wrong arity for ${role} "${instr.type}": expected ${expected}, got ${instr.parameters.length} (L2).`,
    );
  }
}

function validateEventTree(gd: GdNamespace, project: GdProjectHandle, nodes: EventNodeInput[]): void {
  const visit = (list: EventNodeInput[], where: string): void => {
    list.forEach((node, index) => {
      const at = `${where}[${index}] (${node.kind})`;
      if (node.kind === 'jscode' && !hasJsCodeMarker(node.inlineCode)) {
        throw validationFailed(
          `${at}: JsCode event refused: free JsCode is not allowed; inline code must contain the marker "${JSCODE_MARKER_COMMENT}".`,
        );
      }
      const conditions =
        node.kind === 'standard' ||
        node.kind === 'else' ||
        node.kind === 'repeat' ||
        node.kind === 'while' ||
        node.kind === 'foreach' ||
        node.kind === 'foreachChildVariable'
          ? (node.conditions ?? [])
          : [];
      const actions =
        node.kind === 'standard' ||
        node.kind === 'else' ||
        node.kind === 'repeat' ||
        node.kind === 'while' ||
        node.kind === 'foreach' ||
        node.kind === 'foreachChildVariable'
          ? (node.actions ?? [])
          : [];
      for (const instr of conditions) checkEventInstruction(gd, project, instr, 'condition');
      for (const instr of actions) checkEventInstruction(gd, project, instr, 'action');
      if (node.kind === 'while') {
        for (const instr of node.whileConditions) checkEventInstruction(gd, project, instr, 'while-condition');
      }
      // Required-field checks mirror the fake (zod enforces shape, but direct
      // engine calls must refuse too).
      if (node.kind === 'foreach' && node.object.trim() === '') {
        throw validationFailed(`${at}: object must not be empty.`);
      }
      if (node.kind === 'foreachChildVariable' && node.iterableVariable.trim() === '') {
        throw validationFailed(`${at}: iterableVariable must not be empty.`);
      }
      if (node.kind === 'group' && node.name.trim() === '') {
        throw validationFailed(`${at}: group name must not be empty.`);
      }
      if (node.kind === 'link' && node.target.trim() === '') {
        throw validationFailed(`${at}: link target must not be empty.`);
      }
      if ('events' in node && node.events) visit(node.events, `${at}.events`);
    });
  };
  visit(nodes, 'events');
}

function appendEventInstruction(
  gd: GdNamespace,
  project: GdProjectHandle,
  list: GdInstructionsList,
  instr: EventInstructionInput,
  role: 'condition' | 'action' | 'while-condition',
): void {
  // #32 : la validation a déjà résolu, mais l'écriture re-résout pour
  // garantir le stockage canonique même en appel moteur direct. Un échec
  // ici est inatteignable après `validateEventTree` : il signale un bug
  // interne, jamais une entrée utilisateur (déjà refusée en L1).
  const canonical = resolveInstructionType(gd, project, instr.type, role);
  if (canonical === null) {
    throw validationFailed(`Unknown ${role} type "${instr.type}" (L1). Refus interne après validation : incohérence.`);
  }
  const handle = new gd.Instruction();
  try {
    handle.setType(canonical);
    handle.setParametersCount(instr.parameters.length);
    instr.parameters.forEach((value, i) => handle.setParameter(i, value));
    if (instr.inverted === true) handle.setInverted(true);
    if (instr.awaited === true) handle.setAwaited(true);
    // Never `push_back` (it reorders object-creation instructions): explicit
    // `insert` at `size()`.
    list.insert(handle, list.size());
  } finally {
    handle.delete();
  }
}

function configureEventNode(
  gd: GdNamespace,
  project: GdProjectHandle,
  base: GdBaseEvent,
  node: EventNodeInput,
  newId: string,
): void {
  base.setAiGeneratedEventId(newId);
  if ('disabled' in node && node.disabled !== undefined) base.setDisabled(node.disabled);
  const fillStandard = (
    standard: GdStandardEvent,
    source: { conditions?: EventInstructionInput[] | undefined; actions?: EventInstructionInput[] | undefined },
  ): void => {
    for (const instr of source.conditions ?? []) appendEventInstruction(gd, project, standard.getConditions(), instr, 'condition');
    for (const instr of source.actions ?? []) appendEventInstruction(gd, project, standard.getActions(), instr, 'action');
  };
  switch (node.kind) {
    case 'standard':
      fillStandard(gd.asStandardEvent(base), node);
      break;
    case 'else':
      fillStandard(gd.asElseEvent(base), node);
      break;
    case 'repeat': {
      const repeat = gd.asRepeatEvent(base);
      repeat.setRepeatExpressionPlainString(node.repeatExpression);
      if (node.loopIndexVariable !== undefined) repeat.setLoopIndexVariableName(node.loopIndexVariable);
      fillStandard(repeat, node);
      break;
    }
    case 'while': {
      const whileEvent = gd.asWhileEvent(base);
      for (const instr of node.whileConditions) appendEventInstruction(gd, project, whileEvent.getWhileConditions(), instr, 'while-condition');
      fillStandard(whileEvent, node);
      break;
    }
    case 'foreach': {
      const forEach = gd.asForEachEvent(base);
      forEach.setObjectToPick(node.object);
      if (node.loopIndexVariable !== undefined) forEach.setLoopIndexVariableName(node.loopIndexVariable);
      fillStandard(forEach, node);
      break;
    }
    case 'foreachChildVariable': {
      const forChild = gd.asForEachChildVariableEvent(base);
      forChild.setIterableVariableName(node.iterableVariable);
      if (node.keyIterator !== undefined) forChild.setKeyIteratorVariableName(node.keyIterator);
      if (node.valueIterator !== undefined) forChild.setValueIteratorVariableName(node.valueIterator);
      fillStandard(forChild, node);
      break;
    }
    case 'group': {
      const group = gd.asGroupEvent(base);
      group.setName(node.name);
      if (node.source !== undefined) group.setSource(node.source);
      break;
    }
    case 'comment':
      gd.asCommentEvent(base).setComment(node.comment);
      break;
    case 'link': {
      const link = gd.asLinkEvent(base);
      link.setTarget(node.target);
      if (node.includeAll === false && node.eventsGroup !== undefined) {
        link.setIncludeEventsGroup(node.eventsGroup);
      } else {
        link.setIncludeAllEvents();
      }
      if (node.includeStart !== undefined && node.includeEnd !== undefined) {
        link.setIncludeStartAndEnd(node.includeStart, node.includeEnd);
      }
      break;
    }
    case 'jscode': {
      const js = gd.asJsCodeEvent(base);
      js.setInlineCode(node.inlineCode);
      if (node.parameterObjects !== undefined) js.setParameterObjects(node.parameterObjects);
      break;
    }
  }
}

function appendEventSubtree(
  gd: GdNamespace,
  project: GdProjectHandle,
  parent: GdEventsList,
  node: EventNodeInput,
  collectedIds: string[],
  parentPath: number[],
  collectedPaths: number[][],
): void {
  const type = EVENT_TYPE_STRINGS[node.kind];
  const base = parent.insertNewEvent(project, type, parent.getEventsCount());
  const newId = randomUUID();
  configureEventNode(gd, project, base, node, newId);
  const index = parent.getEventsCount() - 1;
  const path = [...parentPath, index];
  collectedIds.push(newId);
  collectedPaths.push(path);
  if ('events' in node && node.events && node.events.length > 0) {
    const sub = base.getSubEvents();
    for (const child of node.events) appendEventSubtree(gd, project, sub, child, collectedIds, path, collectedPaths);
  }
}

interface ResolvedLiveEvent {
  parent: GdEventsList;
  index: number;
  event: GdBaseEvent;
  path: number[];
}

function resolveLiveEventPath(root: GdEventsList, path: number[]): ResolvedLiveEvent {
  let parent = root;
  let event: GdBaseEvent | undefined;
  const resolved: number[] = [];
  for (let depth = 0; depth < path.length; depth++) {
    const index = path[depth] as number;
    if (!Number.isInteger(index) || index < 0 || index >= parent.getEventsCount()) {
      throw validationFailed(`Unknown event path [${path.join(', ')}]: index ${index} out of range at depth ${depth}.`);
    }
    event = parent.getEventAt(index);
    resolved.push(index);
    if (depth < path.length - 1) parent = event.getSubEvents();
  }
  if (!event) throw validationFailed(`Unknown event path [${path.join(', ')}]: empty path.`);
  return { parent, index: path[path.length - 1] as number, event, path: resolved };
}

function findLiveEventById(root: GdEventsList, id: string): ResolvedLiveEvent {
  const visit = (list: GdEventsList, prefix: number[]): ResolvedLiveEvent | null => {
    for (let i = 0; i < list.getEventsCount(); i++) {
      const event = list.getEventAt(i);
      if (event.getAiGeneratedEventId() === id) return { parent: list, index: i, event, path: [...prefix, i] };
      const nested = visit(event.getSubEvents(), [...prefix, i]);
      if (nested) return nested;
    }
    return null;
  };
  const found = visit(root, []);
  if (!found) throw validationFailed(`Unknown event id "${id}".`);
  return found;
}

function resolveLiveEvent(root: GdEventsList, selector: EventSelector): ResolvedLiveEvent {
  if ('path' in selector) return resolveLiveEventPath(root, selector.path);
  return findLiveEventById(root, selector.id);
}

export function createRealEngine(gd: GdNamespace): EnginePorts {
  return {
    createProject(name: string): EngineProject {
      const project = gd.ProjectHelper.createNewGDJSProject();
      project.setName(name);
      return project;
    },
    loadProjectFromJson(json: string, projectFile: string): EngineProject {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (error) {
        throw new McpError('project-load-failed', 'Project file is not valid JSON.', { cause: error });
      }
      const project = new gd.Project();
      const element = gd.Serializer.fromJSObject(parsed);
      try {
        project.unserializeFrom(element);
      } catch (error) {
        project.delete();
        throw new McpError('project-load-failed', 'Project file could not be loaded by the engine.', {
          cause: error,
        });
      } finally {
        element.delete();
      }
      if (projectFile !== '') project.setProjectFile(projectFile);
      return project;
    },
    serializeProject(project: EngineProject): string {
      const element = new gd.SerializerElement();
      try {
        (project as GdProjectHandle).serializeTo(element);
        return gd.Serializer.toJSON(element);
      } finally {
        element.delete();
      }
    },
    restoreProject(project: EngineProject, snapshot: string): void {
      let state: unknown;
      try {
        state = JSON.parse(snapshot);
      } catch (error) {
        throw new McpError('post-apply-failed', 'Memory snapshot is unusable; project left as-is.', {
          cause: error,
        });
      }
      const element = gd.Serializer.fromJSObject(state);
      try {
        (project as GdProjectHandle).unserializeFrom(element);
      } finally {
        element.delete();
      }
    },
    listDiagnostics(project: EngineProject): EngineDiagnostic[] {
      const report = (project as GdProjectHandle).getWholeProjectDiagnosticReport();
      try {
        const found: EngineDiagnostic[] = [];
        for (let i = 0; i < report.count(); i++) {
          const diagnostic = report.get(i);
          found.push({ type: readDiagnosticTypeName(gd, diagnostic.getType()), message: diagnostic.getMessage() });
        }
        return found;
      } finally {
        report.delete();
      }
    },
    updateBehaviorsSharedData(project: EngineProject): void {
      // Per-layout call (research IDL): the project itself exposes no such method.
      const handle = project as GdProjectHandle;
      for (let i = 0; i < handle.getLayoutsCount(); i++) {
        handle.getLayoutAt(i).updateBehaviorsSharedData(handle);
      }
    },
    describeProject(project: EngineProject): ProjectSummary {
      const handle = project as GdProjectHandle;
      let objectCount = 0;
      const countObjects = (objects: GdObjectsContainer): void => {
        objectCount += objects.getObjectsCount();
      };
      countObjects(handle.getObjects());
      let eventCount = 0;
      const layoutCount = handle.getLayoutsCount();
      for (let i = 0; i < layoutCount; i++) {
        const layout = handle.getLayoutAt(i);
        countObjects(layout.getObjects());
        eventCount += layout.getEvents().getEventsCount();
      }
      // getAllBehaviorNames() reports capabilities (Flippable, Scalable, …),
      // not attached behaviors — count the real ones from the content view.
      const view = readContentView(serializeLive(gd, project));
      let behaviorCount = 0;
      for (const object of view.globalObjects) behaviorCount += object.behaviors.length;
      for (const scene of view.scenes) {
        for (const object of scene.objects) behaviorCount += object.behaviors.length;
      }
      return {
        name: handle.getName(),
        projectFile: handle.getProjectFile(),
        layoutCount,
        objectCount,
        behaviorCount,
        globalVariableCount: handle.getVariables().count(),
        eventCount,
      };
    },
    describeContent(project: EngineProject): ContentView {
      return readContentView(serializeLive(gd, project));
    },
    // Famille (a) : scènes, calques, Objets, comportements (module sceneObjects).
    ...createSceneObjectPorts(gd),
    placeInstance(project: EngineProject, input: PlaceInstanceInput): { instanceId: string } {
      const handle = project as GdProjectHandle;
      const layout = requireLayout(handle, input.scene);
      if (!objectUsableInScene(handle, input.scene, input.object)) {
        throw validationFailed(`Unknown object "${input.object}" for scene "${input.scene}".`);
      }
      if (input.layer !== undefined && input.layer !== '' && !layout.getLayers().hasLayerNamed(input.layer)) {
        throw validationFailed(`Unknown layer "${input.layer}" in scene "${input.scene}".`);
      }
      // Variables are validated before the insert so a refusal creates nothing.
      for (const [key, value] of Object.entries(input.variables ?? {})) toVariableNode(key, value);
      const instances = layout.getInitialInstances();
      const instance = instances.insertNewInitialInstance();
      try {
        instance.setObjectName(input.object);
        instance.setX(input.x);
        instance.setY(input.y);
        if (input.z !== undefined) instance.setZ(input.z);
        if (input.layer !== undefined) instance.setLayer(input.layer);
        if (input.zOrder !== undefined) instance.setZOrder(input.zOrder);
        if (input.angle !== undefined) instance.setAngle(input.angle);
        if (input.opacity !== undefined) instance.setOpacity(input.opacity);
        if (input.width !== undefined) {
          instance.setHasCustomSize(true);
          instance.setCustomWidth(input.width);
        }
        if (input.height !== undefined) {
          instance.setHasCustomSize(true);
          instance.setCustomHeight(input.height);
        }
        if (input.keepRatio !== undefined) instance.setShouldKeepRatio(input.keepRatio);
        const variables = instance.getVariables();
        for (const [key, value] of Object.entries(input.variables ?? {})) {
          const variable = variables.has(key) ? variables.get(key) : variables.insertNew(key, variables.count());
          setVariableValue(variable, key, value);
        }
      } catch (error) {
        instances.removeInstance(instance);
        throw error;
      }
      return { instanceId: instance.getPersistentUuid() };
    },
    updateInstance(project: EngineProject, scene: string, instanceId: string, patch: UpdateInstancePatch): void {
      const handle = project as GdProjectHandle;
      const layout = requireLayout(handle, scene);
      if (patch.object !== undefined && !objectUsableInScene(handle, scene, patch.object)) {
        throw validationFailed(`Unknown object "${patch.object}" for scene "${scene}".`);
      }
      if (patch.layer !== undefined && patch.layer !== '' && !layout.getLayers().hasLayerNamed(patch.layer)) {
        throw validationFailed(`Unknown layer "${patch.layer}" in scene "${scene}".`);
      }
      for (const [key, value] of Object.entries(patch.variables ?? {})) toVariableNode(key, value);
      // The build exposes no instance enumeration handles, so targeted edits
      // go through the engine's own deserializer (instance bridge): the JSON
      // is never hand-built, only parsed from the engine and fed back to it.
      const doc = serializeLive(gd, project);
      const node = (requireLayoutDoc(doc, scene).instances ?? [])[requireInstanceIndex(doc, scene, instanceId)];
      if (!node) throw validationFailed(`Unknown instance "${instanceId}" in scene "${scene}".`);
      if (patch.object !== undefined) node.name = patch.object;
      if (patch.x !== undefined) node.x = patch.x;
      if (patch.y !== undefined) node.y = patch.y;
      if (patch.z !== undefined) node.z = patch.z;
      if (patch.layer !== undefined) node.layer = patch.layer;
      if (patch.zOrder !== undefined) node.zOrder = patch.zOrder;
      if (patch.angle !== undefined) node.angle = patch.angle;
      if (patch.opacity !== undefined) node.opacity = patch.opacity;
      if (patch.width !== undefined) {
        node.width = patch.width;
        node.customSize = true;
      }
      if (patch.height !== undefined) {
        node.height = patch.height;
        node.customSize = true;
      }
      if (patch.keepRatio !== undefined) (node as unknown as Record<string, JsonValue>).keepRatio = patch.keepRatio;
      if (patch.variables !== undefined) {
        node.initialVariables = mergeVariableNodes(node.initialVariables ?? [], patch.variables);
      }
      unserializeLive(gd, project, doc);
    },
    removeInstance(project: EngineProject, scene: string, instanceId: string): void {
      const handle = project as GdProjectHandle;
      requireLayout(handle, scene);
      const doc = serializeLive(gd, project);
      const layout = requireLayoutDoc(doc, scene);
      const before = (layout.instances ?? []).length;
      layout.instances = (layout.instances ?? []).filter((candidate) => candidate.persistentUuid !== instanceId);
      if ((layout.instances ?? []).length === before) {
        throw validationFailed(`Unknown instance "${instanceId}" in scene "${scene}".`);
      }
      unserializeLive(gd, project, doc);
    },
    removeInstancesOfObject(project: EngineProject, scene: string, object: string): { removed: number } {
      const handle = project as GdProjectHandle;
      const instances = requireLayout(handle, scene).getInitialInstances();
      const before = instances.getInstancesCount();
      instances.removeInitialInstancesOfObject(object);
      return { removed: before - instances.getInstancesCount() };
    },
    moveInstancesToLayer(
      project: EngineProject,
      scene: string,
      sourceLayer: string,
      targetLayer: string,
    ): { moved: number } {
      const handle = project as GdProjectHandle;
      const layout = requireLayout(handle, scene);
      if (targetLayer !== '' && !layout.getLayers().hasLayerNamed(targetLayer)) {
        throw validationFailed(`Unknown layer "${targetLayer}" in scene "${scene}".`);
      }
      const instances = layout.getInitialInstances();
      const moved = instances.getLayerInstancesCount(sourceLayer);
      instances.moveInstancesToLayer(sourceLayer, targetLayer);
      return { moved };
    },
    setVariable(project: EngineProject, target: VariableTarget, name: string, value: JsonValue): void {
      const handle = project as GdProjectHandle;
      if (target.scope === 'instance') {
        if (target.scene === undefined || target.instanceId === undefined) {
          throw validationFailed('Variable target "instance" requires a scene name and an instance id.');
        }
        toVariableNode(name, value);
        const doc = serializeLive(gd, project);
        const node = (requireLayoutDoc(doc, target.scene).instances ?? [])[
          requireInstanceIndex(doc, target.scene, target.instanceId)
        ];
        if (!node) throw validationFailed(`Unknown instance "${target.instanceId}" in scene "${target.scene}".`);
        node.initialVariables = mergeVariableNodes(node.initialVariables ?? [], { [name]: value });
        unserializeLive(gd, project, doc);
        return;
      }
      const container = liveVariablesContainer(handle, target);
      toVariableNode(name, value);
      const variable = container.has(name) ? container.get(name) : container.insertNew(name, container.count());
      setVariableValue(variable, name, value);
    },
    removeVariable(project: EngineProject, target: VariableTarget, name: string): void {
      const handle = project as GdProjectHandle;
      if (target.scope === 'instance') {
        if (target.scene === undefined || target.instanceId === undefined) {
          throw validationFailed('Variable target "instance" requires a scene name and an instance id.');
        }
        const doc = serializeLive(gd, project);
        const node = (requireLayoutDoc(doc, target.scene).instances ?? [])[
          requireInstanceIndex(doc, target.scene, target.instanceId)
        ];
        if (!node) throw validationFailed(`Unknown instance "${target.instanceId}" in scene "${target.scene}".`);
        const before = (node.initialVariables ?? []).length;
        node.initialVariables = (node.initialVariables ?? []).filter((candidate) => candidate.name !== name);
        if ((node.initialVariables ?? []).length === before) {
          throw validationFailed(`Unknown variable "${name}" on instance "${target.instanceId}".`);
        }
        unserializeLive(gd, project, doc);
        return;
      }
      const container = liveVariablesContainer(handle, target);
      if (!container.has(name)) throw validationFailed(`Unknown variable "${name}".`);
      container.remove(name);
    },
    renameVariable(project: EngineProject, target: VariableTarget, oldName: string, newName: string): void {
      const handle = project as GdProjectHandle;
      if (target.scope === 'instance') {
        if (target.scene === undefined || target.instanceId === undefined) {
          throw validationFailed('Variable target "instance" requires a scene name and an instance id.');
        }
        const doc = serializeLive(gd, project);
        const node = (requireLayoutDoc(doc, target.scene).instances ?? [])[
          requireInstanceIndex(doc, target.scene, target.instanceId)
        ];
        if (!node) throw validationFailed(`Unknown instance "${target.instanceId}" in scene "${target.scene}".`);
        const variables = node.initialVariables ?? [];
        const variable = variables.find((candidate) => candidate.name === oldName);
        if (!variable) throw validationFailed(`Unknown variable "${oldName}" on instance "${target.instanceId}".`);
        if (oldName !== newName && variables.some((candidate) => candidate.name === newName)) {
          throw validationFailed(`Variable "${newName}" already exists on instance "${target.instanceId}".`);
        }
        variable.name = newName;
        unserializeLive(gd, project, doc);
        return;
      }
      const container = liveVariablesContainer(handle, target);
      if (!container.has(oldName)) throw validationFailed(`Unknown variable "${oldName}".`);
      if (oldName !== newName && container.has(newName)) {
        throw validationFailed(`Variable "${newName}" already exists.`);
      }
      container.rename(oldName, newName);
    },
    createGroup(project: EngineProject, scene: string | undefined, name: string, objects: string[]): void {
      const handle = project as GdProjectHandle;
      if (scene !== undefined) requireLayout(handle, scene);
      const groups = objectsContainer(handle, scene).getObjectGroups();
      const where = containerWhere(scene);
      if (groups.has(name)) throw validationFailed(`Group "${name}" already exists in ${where}.`);
      for (const object of objects) {
        const known =
          scene === undefined
            ? handle.getObjects().hasObjectNamed(object)
            : objectUsableInScene(handle, scene, object);
        if (!known) throw validationFailed(`Unknown object "${object}" for ${where}.`);
      }
      const group = groups.insertNew(name, groups.count());
      for (const object of objects) group.addObject(object);
    },
    deleteGroup(project: EngineProject, scene: string | undefined, name: string): void {
      const handle = project as GdProjectHandle;
      if (scene !== undefined) requireLayout(handle, scene);
      const groups = objectsContainer(handle, scene).getObjectGroups();
      if (!groups.has(name)) throw validationFailed(`Unknown group "${name}" in ${containerWhere(scene)}.`);
      groups.remove(name);
    },
    addObjectToGroup(project: EngineProject, scene: string | undefined, group: string, object: string): void {
      const handle = project as GdProjectHandle;
      if (scene !== undefined) requireLayout(handle, scene);
      const groups = objectsContainer(handle, scene).getObjectGroups();
      if (!groups.has(group)) throw validationFailed(`Unknown group "${group}" in ${containerWhere(scene)}.`);
      const known =
        scene === undefined ? handle.getObjects().hasObjectNamed(object) : objectUsableInScene(handle, scene, object);
      if (!known) throw validationFailed(`Unknown object "${object}" for ${containerWhere(scene)}.`);
      const target = groups.get(group);
      if (!target.find(object)) target.addObject(object);
    },
    removeObjectFromGroup(project: EngineProject, scene: string | undefined, group: string, object: string): void {
      const handle = project as GdProjectHandle;
      if (scene !== undefined) requireLayout(handle, scene);
      const groups = objectsContainer(handle, scene).getObjectGroups();
      if (!groups.has(group)) throw validationFailed(`Unknown group "${group}" in ${containerWhere(scene)}.`);
      const target = groups.get(group);
      if (!target.find(object)) throw validationFailed(`Object "${object}" is not in group "${group}".`);
      target.removeObject(object);
    },
    importResource(project: EngineProject, input: ImportResourceInput): { name: string } {
      const handle = project as GdProjectHandle;
      const resources = handle.getResourcesManager();
      const ctorName = (RESOURCE_CONSTRUCTORS as Record<string, string>)[input.kind];
      if (!ctorName || typeof gd[ctorName] !== 'function') {
        throw validationFailed(`Unsupported resource kind "${input.kind}".`);
      }
      if (resources.hasResource(input.name)) throw validationFailed(`Resource "${input.name}" already exists.`);
      const resource = new (gd[ctorName] as new () => GdResourceHandle)();
      try {
        resource.setName(input.name);
        resource.setFile(input.file);
        resource.setKind(input.kind);
        resource.setUserAdded(true);
        resources.addResource(resource);
      } finally {
        resource.delete();
      }
      return { name: input.name };
    },
    removeResource(project: EngineProject, name: string): void {
      const resources = (project as GdProjectHandle).getResourcesManager();
      if (!resources.hasResource(name)) throw validationFailed(`Unknown resource "${name}".`);
      resources.removeResource(name);
    },
    installAssetObject(project: EngineProject, input: InstallAssetObjectInput): void {
      const handle = project as GdProjectHandle;
      const container = objectsContainer(handle, input.scene);
      const where = containerWhere(input.scene);
      if (container.hasObjectNamed(input.name)) {
        throw validationFailed(`Object "${input.name}" already exists in ${where}.`);
      }
      if (typeof input.type !== 'string' || input.type === '') {
        throw validationFailed('Asset object has no type: refusing install.');
      }
      if (typeof input.serializedObject !== 'object' || input.serializedObject === null) {
        throw validationFailed('Asset object payload is not an object: refusing install.');
      }
      checkObjectType(gd, handle, input.type);
      const object = container.insertNewObject(handle, input.type, input.name, container.getObjectsCount());
      try {
        const element = gd.Serializer.fromJSObject(input.serializedObject);
        try {
          object.unserializeFrom(handle, element);
        } finally {
          element.delete();
        }
        // L'unserialize écrase le nom : le restaurer, puis tracer l'origine.
        object.setName(input.name);
        object.resetPersistentUuid();
        if (input.assetStoreId !== undefined) object.setAssetStoreId(input.assetStoreId);
      } catch (error) {
        container.removeObject(input.name);
        throw error;
      }
    },
    appendSceneEvents(project: EngineProject, input: AppendEventsInput): AppendEventsResult {
      const handle = project as GdProjectHandle;
      const layout = requireLayout(handle, input.scene);
      validateEventTree(gd, handle, input.events);
      const root = layout.getEvents();
      const at =
        input.position === undefined ? root.getEventsCount() : clampPosition(input.position, root.getEventsCount());
      // Insert the block one by one at `at + i` so `position` is the index of
      // the first new event (never `push_back` semantics by accident).
      const ids: string[] = [];
      const paths: number[][] = [];
      input.events.forEach((node, offset) => {
        const type = EVENT_TYPE_STRINGS[node.kind];
        const base = root.insertNewEvent(handle, type, at + offset);
        const newId = randomUUID();
        configureEventNode(gd, handle, base, node, newId);
        ids.push(newId);
        paths.push([at + offset]);
        if ('events' in node && node.events && node.events.length > 0) {
          const sub = base.getSubEvents();
          for (const child of node.events) appendEventSubtree(gd, handle, sub, child, ids, [at + offset], paths);
        }
      });
      return { appended: input.events.length, ids, paths, dryRun: false };
    },
    moveSceneEvent(project: EngineProject, input: MoveEventInput): { moved: boolean; dryRun: boolean } {
      const handle = project as GdProjectHandle;
      const layout = requireLayout(handle, input.scene);
      const root = layout.getEvents();
      const source = resolveLiveEvent(root, input.from);
      const destParent: GdEventsList = input.toParent
        ? resolveLiveEvent(layout.getEvents(), input.toParent).event.getSubEvents()
        : source.parent;
      // Refuse to move a parent into its own subtree.
      if (input.toParent) {
        const dest = resolveLiveEvent(layout.getEvents(), input.toParent);
        if (!dest.event.canHaveSubEvents()) {
          throw validationFailed('Destination parent cannot hold sub-events (comment, link and JsCode are leaves).');
        }
        if (
          dest.path.length > source.path.length &&
          dest.path.slice(0, source.path.length).every((value, i) => value === source.path[i])
        ) {
          throw validationFailed('Cannot move an event into its own subtree.');
        }
      }
      const at = clampPosition(input.toPosition, destParent.getEventsCount());
      source.parent.moveEventToAnotherEventsList(source.event, destParent, at);
      return { moved: true, dryRun: false };
    },
    removeSceneEvent(project: EngineProject, input: RemoveEventInput): { removed: boolean; dryRun: boolean } {
      const handle = project as GdProjectHandle;
      const layout = requireLayout(handle, input.scene);
      const resolved = resolveLiveEvent(layout.getEvents(), input.target);
      resolved.parent.removeEventAt(resolved.index);
      return { removed: true, dryRun: false };
    },
    validateSceneEvents(
      project: EngineProject,
      scene: string,
      events: EventNodeInput[],
    ): { valid: boolean; errors: string[] } {
      const handle = project as GdProjectHandle;
      requireLayout(handle, scene);
      try {
        validateEventTree(gd, handle, events);
        return { valid: true, errors: [] };
      } catch (error) {
        if (error instanceof McpError) return { valid: false, errors: [error.message] };
        throw error;
      }
    },
    setProjectName(project: EngineProject, name: string): void {
      (project as GdProjectHandle).setName(name);
    },
    setProjectFile(project: EngineProject, path: string): void {
      (project as GdProjectHandle).setProjectFile(path);
    },
    isFolderProject(project: EngineProject): boolean {
      return (project as GdProjectHandle).isFolderProject();
    },
    setFolderProject(project: EngineProject, value: boolean): void {
      (project as GdProjectHandle).setFolderProject(value);
    },
    getEventsFunctionsExtensionCount(project: EngineProject): number {
      return (project as GdProjectHandle).getEventsFunctionsExtensionsCount();
    },
    loadEventsFunctionsExtensions(project: EngineProject): void {
      const handle = project as GdProjectHandle;
      if (handle.getEventsFunctionsExtensionsCount() === 0) return;
      loadProjectEventsFunctionsExtensionsSync(
        gd as unknown as Parameters<typeof loadProjectEventsFunctionsExtensionsSync>[0],
        handle as unknown as Parameters<typeof loadProjectEventsFunctionsExtensionsSync>[1],
        makeNodeEventsFunctionCodeWriter({ onWriteFile: () => {} }),
        (text: string) => text,
      );
    },
    unloadEventsFunctionsExtensions(project: EngineProject): void {
      const handle = project as GdProjectHandle;
      if (handle.getEventsFunctionsExtensionsCount() === 0) return;
      unloadProjectEventsFunctionsExtensionsSync(
        gd as unknown as Parameters<typeof unloadProjectEventsFunctionsExtensionsSync>[0],
        handle as unknown as Parameters<typeof unloadProjectEventsFunctionsExtensionsSync>[1],
      );
    },
  };
}

export interface LoadGdRuntimeOptions {
  libgdPath?: string | undefined;
  gdjsRoot?: string | undefined;
  loadExtensions?: boolean | undefined;
}

export interface GdRuntime {
  gd: GdNamespace;
  engine: EnginePorts;
  /** Charge les events-functions d'un projet (2 passes, i18n identité, tmp codeWriter). */
  loadFolderExtensions(project: EngineProject): Promise<void>;
}

/** `initializePlatforms()` must run exactly once per process (static guard engine-side). */
let platformsInitialized = false;

/**
 * libGD.js keeps process-global state (platform registry), so loading it
 * twice in one process is meaningless and harmful (the second namespace
 * misses platform initialization). Memoize per resolved inputs instead.
 */
const runtimeCache = new Map<string, GdRuntime>();

function defaultLibgdPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'vendor', 'libGD.js');
}

/**
 * Load JsExtension.js loaders from a GDJS root (verified layout: the AppImage
 * `resources/GDJS` tree works). Skips directories containing "Example".
 */
function loadJsExtensions(require: NodeRequire, gd: GdNamespace, gdjsRoot: string): void {
  const extensionsDir = join(gdjsRoot, 'Runtime', 'Extensions');
  const entries = readdirSync(extensionsDir, { withFileTypes: true });
  const previousGlobalGd = (globalThis as Record<string, unknown>)['gd'];
  (globalThis as Record<string, unknown>)['gd'] = gd;
  try {
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.includes('Example')) continue;
      const loader = join(extensionsDir, entry.name, 'JsExtension.js');
      if (!existsSync(loader)) continue;
      let module: GdExtensionModule;
      try {
        module = require(loader) as GdExtensionModule;
      } catch (error) {
        throw new McpError('libgd-unavailable', `Cannot load extension ${entry.name} from ${loader}.`, {
          cause: error,
        });
      }
      const extension = module.createExtension((text: string) => text, gd);
      try {
        const failures = (module.runExtensionSanityTests?.(gd, extension) ?? []).filter((entry) => !!entry);
        if (failures.length > 0) {
          throw new McpError('libgd-unavailable', `Extension ${entry.name} failed its sanity tests: ${failures.join('; ')}`);
        }
        gd.JsPlatform.get().addNewExtension(extension);
      } finally {
        extension.delete();
      }
    }
  } finally {
    if (previousGlobalGd === undefined) delete (globalThis as Record<string, unknown>)['gd'];
    else (globalThis as Record<string, unknown>)['gd'] = previousGlobalGd;
  }
}

export async function loadGdRuntime(options: LoadGdRuntimeOptions = {}): Promise<GdRuntime> {
  const libgdPath = options.libgdPath ?? process.env['GDEVELOP_LIBGD_PATH'] ?? defaultLibgdPath();
  const gdjsRoot = options.gdjsRoot ?? process.env['GDEVELOP_GDJS_ROOT'];
  const shouldLoadExtensions = options.loadExtensions ?? process.env['GDEVELOP_LOAD_EXTENSIONS'] !== 'false';
  const cacheKey = `${libgdPath}::${gdjsRoot ?? ''}::${shouldLoadExtensions}`;
  const cached = runtimeCache.get(cacheKey);
  if (cached) return cached;
  if (!existsSync(libgdPath)) {
    throw new McpError(
      'libgd-unavailable',
      `libGD.js not found at ${libgdPath}. Run \`npm run provision:libgd\` or set GDEVELOP_LIBGD_PATH.`,
    );
  }
  const require = createRequire(import.meta.url);
  let initializerModule: { default?: unknown } | ((...args: unknown[]) => Promise<GdNamespace>);
  try {
    initializerModule = require(libgdPath) as { default?: unknown };
  } catch (error) {
    throw new McpError('libgd-unavailable', `Cannot require libGD.js at ${libgdPath}.`, { cause: error });
  }
  const initialize =
    typeof initializerModule === 'function'
      ? (initializerModule as (...args: unknown[]) => Promise<GdNamespace>)
      : ((initializerModule as { default?: unknown }).default as (...args: unknown[]) => Promise<GdNamespace>);
  if (typeof initialize !== 'function') {
    throw new McpError('libgd-unavailable', `libGD.js at ${libgdPath} does not export an initializer function.`);
  }
  const gd = await initialize({ locateFile: (file: string) => join(dirname(libgdPath), file) });
  if (!platformsInitialized) {
    gd.ProjectHelper.initializePlatforms();
    platformsInitialized = true;
  }
  if (shouldLoadExtensions && gdjsRoot) loadJsExtensions(require, gd, gdjsRoot);
  const engine = createRealEngine(gd);
  const runtime: GdRuntime = {
    gd,
    engine,
    loadFolderExtensions: async (project: EngineProject): Promise<void> => {
      const { loadProjectEventsFunctionsExtensions, makeLocalEventsFunctionCodeWriter } =
        await import('./eventsFunctionsLoader.js');
      await loadProjectEventsFunctionsExtensions(
        gd as unknown as Parameters<typeof loadProjectEventsFunctionsExtensions>[0],
        project as unknown as Parameters<typeof loadProjectEventsFunctionsExtensions>[1],
        makeLocalEventsFunctionCodeWriter({ onWriteFile: () => {} }),
        (text: string) => text,
      );
    },
  };
  runtimeCache.set(cacheKey, runtime);
  return runtime;
}
