import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpError, validationFailed } from './errors.js';
import {
  BLOCKING_DIAGNOSTIC_TYPES,
  shortBehaviorName,
  type AttachBehaviorInput,
  type CreateObjectInput,
  type EngineDiagnostic,
  type EnginePorts,
  type EngineProject,
  type ImportResourceInput,
  type PlaceInstanceInput,
  type ProjectSummary,
  type RemoveBehaviorInput,
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

interface GdBehaviorHandle {
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

interface GdVariableHandle {
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
  addNewBehavior(project: GdProjectHandle, type: string, name: string): GdBehaviorHandle;
  hasBehaviorNamed(name: string): boolean;
  getBehavior(name: string): GdBehaviorHandle;
  removeBehavior(name: string): void;
  getVariables(): GdVariablesContainer;
  getConfiguration(): unknown;
}

interface GdObjectsContainer {
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

interface GdLayoutHandle {
  getName(): string;
  setName(name: string): void;
  getObjects(): GdObjectsContainer;
  getInitialInstances(): GdInstancesContainer;
  getVariables(): GdVariablesContainer;
  getLayers(): GdLayersContainer;
  getEvents(): { getEventsCount(): number };
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

interface GdProjectHandle extends EngineProject {
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
  JsPlatform: { get(): { addNewExtension(extension: { delete(): void }): void } };
  PlatformExtension: new () => unknown;
  MetadataProvider: {
    getObjectMetadata(platform: unknown, type: string): unknown;
    isBadObjectMetadata(metadata: unknown): boolean;
    getBehaviorMetadata(platform: unknown, type: string): unknown;
    isBadBehaviorMetadata(metadata: unknown): boolean;
  };
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

function clampPosition(position: number, count: number): number {
  if (!Number.isInteger(position)) throw validationFailed(`Position must be an integer, got: ${position}.`);
  return Math.min(Math.max(position, 0), count);
}

function sceneNames(project: GdProjectHandle): string[] {
  const names: string[] = [];
  for (let i = 0; i < project.getLayoutsCount(); i++) names.push(project.getLayoutAt(i).getName());
  return names;
}

function requireLayout(project: GdProjectHandle, scene: string): GdLayoutHandle {
  if (!project.hasLayoutNamed(scene)) {
    const known = sceneNames(project);
    throw validationFailed(
      `Unknown scene "${scene}".${known.length > 0 ? ` Known scenes: ${known.join(', ')}.` : ' The project has no scenes yet.'}`,
    );
  }
  return project.getLayout(scene);
}

function objectsContainer(project: GdProjectHandle, scene: string | undefined): GdObjectsContainer {
  return scene === undefined ? project.getObjects() : requireLayout(project, scene).getObjects();
}

function containerWhere(scene: string | undefined): string {
  return scene === undefined ? 'project' : `scene "${scene}"`;
}

/** An instance may point at a scene object or a global one. */
function objectUsableInScene(project: GdProjectHandle, scene: string, name: string): boolean {
  return (
    project.getLayout(scene).getObjects().hasObjectNamed(name) || project.getObjects().hasObjectNamed(name)
  );
}

function checkObjectType(gd: GdNamespace, project: GdProjectHandle, type: string): void {
  const metadata = gd.MetadataProvider.getObjectMetadata(project.getCurrentPlatform(), type);
  if (gd.MetadataProvider.isBadObjectMetadata(metadata)) {
    throw validationFailed(`Unknown object type "${type}".`);
  }
}

function checkBehaviorType(gd: GdNamespace, project: GdProjectHandle, type: string): void {
  const metadata = gd.MetadataProvider.getBehaviorMetadata(project.getCurrentPlatform(), type);
  if (gd.MetadataProvider.isBadBehaviorMetadata(metadata)) {
    throw validationFailed(`Unknown behavior type "${type}".`);
  }
}

function listPropertyNames(behavior: GdBehaviorHandle): string[] {
  // keys() returns a non-owned reference: deleting it corrupts the WASM heap
  // (proven by probe). The wrapper itself is left for GC; the C++ vector lives on.
  const keys = behavior.getProperties().keys();
  const names: string[] = [];
  for (let i = 0; i < keys.size(); i++) names.push(keys.at(i));
  return names;
}

/** Live property names are case-sensitive ("Gravity"); resolve case-insensitively for agents. */
function resolveBehaviorProperty(behavior: GdBehaviorHandle, behaviorName: string, name: string): string {
  const properties = behavior.getProperties();
  if (properties.has(name)) return name;
  const wanted = name.toLowerCase();
  const match = listPropertyNames(behavior).find((candidate) => candidate.toLowerCase() === wanted);
  if (!match) {
    throw validationFailed(
      `Unknown property "${name}" on behavior "${behaviorName}". Valid: ${listPropertyNames(behavior).join(', ') || '(none)'}.`,
    );
  }
  return match;
}

/** Live behavior values are strings; booleans travel as "1"/"0" (ticket #13). */
function toWireValue(value: string | number | boolean): string {
  return typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
}

function applyBehaviorProperties(
  behavior: GdBehaviorHandle,
  behaviorName: string,
  properties: Record<string, string | number | boolean>,
): void {
  for (const [name, value] of Object.entries(properties)) {
    const resolved = resolveBehaviorProperty(behavior, behaviorName, name);
    // Live values are strings; booleans travel as "1"/"0" (ticket #13).
    const wire = toWireValue(value);
    if (!behavior.updateProperty(resolved, wire)) {
      throw validationFailed(`Cannot set property "${name}" on behavior "${behaviorName}".`);
    }
  }
}

/** Recursive free-JSON setter over a live variable (replaces any previous content). */
function setVariableValue(variable: GdVariableHandle, name: string, value: JsonValue): void {
  if (value === null) {
    throw validationFailed(`Variable "${name}": null has no engine representation; use "", 0 or false.`);
  }
  if (typeof value === 'number') {
    variable.castTo('number');
    variable.setValue(value);
  } else if (typeof value === 'string') {
    variable.castTo('string');
    variable.setString(value);
  } else if (typeof value === 'boolean') {
    variable.castTo('boolean');
    variable.setBool(value);
  } else if (Array.isArray(value)) {
    variable.castTo('array');
    variable.clearChildren();
    for (const item of value) setVariableValue(variable.pushNew(), '', item);
  } else {
    variable.castTo('structure');
    variable.clearChildren();
    for (const [key, item] of Object.entries(value)) setVariableValue(variable.getChild(key), key, item);
  }
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
    createScene(project: EngineProject, name: string): void {
      const handle = project as GdProjectHandle;
      if (handle.hasLayoutNamed(name)) throw validationFailed(`Scene "${name}" already exists.`);
      handle.insertNewLayout(name, handle.getLayoutsCount());
    },
    renameScene(project: EngineProject, oldName: string, newName: string): void {
      const handle = project as GdProjectHandle;
      const layout = requireLayout(handle, oldName);
      if (oldName !== newName && handle.hasLayoutNamed(newName)) {
        throw validationFailed(`Scene "${newName}" already exists.`);
      }
      layout.setName(newName);
    },
    moveScene(project: EngineProject, name: string, position: number): void {
      const handle = project as GdProjectHandle;
      requireLayout(handle, name);
      const from = handle.getLayoutPosition(name);
      handle.moveLayout(from, clampPosition(position, handle.getLayoutsCount() - 1));
    },
    deleteScene(project: EngineProject, name: string): void {
      const handle = project as GdProjectHandle;
      requireLayout(handle, name);
      handle.removeLayout(name);
    },
    createLayer(project: EngineProject, scene: string, name: string): void {
      const layers = requireLayout(project as GdProjectHandle, scene).getLayers();
      if (name === '') throw validationFailed('The base layer ("") always exists; it cannot be created.');
      if (layers.hasLayerNamed(name)) throw validationFailed(`Layer "${name}" already exists in scene "${scene}".`);
      layers.insertNewLayer(name, layers.getLayersCount());
    },
    renameLayer(project: EngineProject, scene: string, oldName: string, newName: string): void {
      const handle = project as GdProjectHandle;
      const layers = requireLayout(handle, scene).getLayers();
      if (oldName === '') throw validationFailed('The base layer ("") cannot be renamed.');
      if (!layers.hasLayerNamed(oldName)) throw validationFailed(`Unknown layer "${oldName}" in scene "${scene}".`);
      if (oldName !== newName && layers.hasLayerNamed(newName)) {
        throw validationFailed(`Layer "${newName}" already exists in scene "${scene}".`);
      }
      layers.getLayer(oldName).setName(newName);
      // Instances point at layers by name: re-point them onto the renamed layer.
      handle.getLayout(scene).getInitialInstances().moveInstancesToLayer(oldName, newName);
    },
    moveLayer(project: EngineProject, scene: string, name: string, position: number): void {
      const layers = requireLayout(project as GdProjectHandle, scene).getLayers();
      let from = -1;
      for (let i = 0; i < layers.getLayersCount(); i++) {
        if (layers.getLayerAt(i).getName() === name) from = i;
      }
      if (from === -1) throw validationFailed(`Unknown layer "${name}" in scene "${scene}".`);
      layers.moveLayer(from, clampPosition(position, layers.getLayersCount() - 1));
    },
    deleteLayer(project: EngineProject, scene: string, name: string): void {
      const handle = project as GdProjectHandle;
      const layers = requireLayout(handle, scene).getLayers();
      if (name === '') throw validationFailed('The base layer ("") cannot be deleted.');
      if (!layers.hasLayerNamed(name)) throw validationFailed(`Unknown layer "${name}" in scene "${scene}".`);
      if (handle.getLayout(scene).getInitialInstances().getLayerInstancesCount(name) > 0) {
        throw validationFailed(`Layer "${name}" still hosts instances; move or remove them first.`);
      }
      layers.removeLayer(name);
    },
    createObject(project: EngineProject, input: CreateObjectInput): void {
      const handle = project as GdProjectHandle;
      const container = objectsContainer(handle, input.scene);
      const where = containerWhere(input.scene);
      if (container.hasObjectNamed(input.name)) {
        throw validationFailed(`Object "${input.name}" already exists in ${where}.`);
      }
      checkObjectType(gd, handle, input.type);
      if (input.collisionMaskAutomatic !== undefined && input.type !== 'Sprite') {
        throw validationFailed(`collisionMaskAutomatic only applies to Sprite objects, not "${input.type}".`);
      }
      const object = container.insertNewObject(handle, input.type, input.name, container.getObjectsCount());
      try {
        for (const behavior of input.behaviors ?? []) {
          const behaviorName = behavior.name ?? shortBehaviorName(behavior.type);
          if (object.hasBehaviorNamed(behaviorName)) {
            throw validationFailed(`Duplicate behavior name "${behaviorName}" on object "${input.name}".`);
          }
          checkBehaviorType(gd, handle, behavior.type);
          const attached = object.addNewBehavior(handle, behavior.type, behaviorName);
          try {
            applyBehaviorProperties(attached, behaviorName, behavior.properties ?? {});
          } catch (error) {
            object.removeBehavior(behaviorName);
            throw error;
          }
        }
      } catch (error) {
        container.removeObject(input.name);
        throw error;
      }
      const variables = object.getVariables();
      for (const [key, value] of Object.entries(input.variables ?? {})) {
        const variable = variables.has(key) ? variables.get(key) : variables.insertNew(key, variables.count());
        setVariableValue(variable, key, value);
      }
      if (input.collisionMaskAutomatic !== undefined) {
        gd.asSpriteConfiguration(object.getConfiguration())
          .getAnimations()
          .setAdaptCollisionMaskAutomatically(input.collisionMaskAutomatic);
      }
    },
    renameObject(project: EngineProject, scene: string | undefined, oldName: string, newName: string): void {
      const handle = project as GdProjectHandle;
      const container = objectsContainer(handle, scene);
      const where = containerWhere(scene);
      if (!container.hasObjectNamed(oldName)) throw validationFailed(`Unknown object "${oldName}" in ${where}.`);
      if (oldName !== newName && container.hasObjectNamed(newName)) {
        throw validationFailed(`Object "${newName}" already exists in ${where}.`);
      }
      container.getObject(oldName).setName(newName);
      // Instances and groups point at objects by name: follow the rename.
      const layouts =
        scene === undefined
          ? Array.from({ length: handle.getLayoutsCount() }, (_, i) => handle.getLayoutAt(i))
          : [requireLayout(handle, scene)];
      for (const layout of layouts) {
        layout.getInitialInstances().renameInstancesOfObject(oldName, newName);
        const groups = scene === undefined ? handle.getObjects().getObjectGroups() : layout.getObjects().getObjectGroups();
        for (let i = 0; i < groups.count(); i++) {
          const group = groups.getAt(i);
          if (group.find(oldName)) {
            group.removeObject(oldName);
            group.addObject(newName);
          }
        }
      }
    },
    deleteObject(project: EngineProject, scene: string | undefined, name: string): void {
      const handle = project as GdProjectHandle;
      const container = objectsContainer(handle, scene);
      const where = containerWhere(scene);
      if (!container.hasObjectNamed(name)) throw validationFailed(`Unknown object "${name}" in ${where}.`);
      container.removeObject(name);
      // Purge dangling references: instances of the object and group memberships.
      const layouts =
        scene === undefined
          ? Array.from({ length: handle.getLayoutsCount() }, (_, i) => handle.getLayoutAt(i))
          : [requireLayout(handle, scene)];
      for (const layout of layouts) {
        layout.getInitialInstances().removeInitialInstancesOfObject(name);
        const groups =
          scene === undefined ? handle.getObjects().getObjectGroups() : layout.getObjects().getObjectGroups();
        for (let i = 0; i < groups.count(); i++) {
          const group = groups.getAt(i);
          if (group.find(name)) group.removeObject(name);
        }
      }
    },
    attachBehavior(project: EngineProject, input: AttachBehaviorInput): { name: string } {
      const handle = project as GdProjectHandle;
      const container = objectsContainer(handle, input.scene);
      if (!container.hasObjectNamed(input.object)) {
        throw validationFailed(`Unknown object "${input.object}" in ${containerWhere(input.scene)}.`);
      }
      const name = input.name ?? shortBehaviorName(input.type);
      const object = container.getObject(input.object);
      if (object.hasBehaviorNamed(name)) {
        throw validationFailed(`Behavior "${name}" already exists on object "${input.object}".`);
      }
      checkBehaviorType(gd, handle, input.type);
      const attached = object.addNewBehavior(handle, input.type, name);
      try {
        applyBehaviorProperties(attached, name, input.properties ?? {});
      } catch (error) {
        object.removeBehavior(name);
        throw error;
      }
      return { name };
    },
    updateBehavior(project: EngineProject, input: UpdateBehaviorInput): void {
      const handle = project as GdProjectHandle;
      const container = objectsContainer(handle, input.scene);
      if (!container.hasObjectNamed(input.object)) {
        throw validationFailed(`Unknown object "${input.object}" in ${containerWhere(input.scene)}.`);
      }
      const object = container.getObject(input.object);
      if (!object.hasBehaviorNamed(input.name)) {
        throw validationFailed(`Unknown behavior "${input.name}" on object "${input.object}".`);
      }
      // Resolve every property before applying any, so a refusal changes nothing.
      const behavior = container.getObject(input.object).getBehavior(input.name);
      const resolved = Object.entries(input.properties).map(
        ([key, value]) => [resolveBehaviorProperty(behavior, input.name, key), toWireValue(value)] as const,
      );
      for (const [key, value] of resolved) {
        if (!behavior.updateProperty(key, value)) {
          throw validationFailed(`Cannot set property "${key}" on behavior "${input.name}".`);
        }
      }
    },
    removeBehavior(project: EngineProject, input: RemoveBehaviorInput): void {
      const handle = project as GdProjectHandle;
      const container = objectsContainer(handle, input.scene);
      if (!container.hasObjectNamed(input.object)) {
        throw validationFailed(`Unknown object "${input.object}" in ${containerWhere(input.scene)}.`);
      }
      const object = container.getObject(input.object);
      if (!object.hasBehaviorNamed(input.name)) {
        throw validationFailed(`Unknown behavior "${input.name}" on object "${input.object}".`);
      }
      object.removeBehavior(input.name);
    },
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
    setProjectName(project: EngineProject, name: string): void {
      (project as GdProjectHandle).setName(name);
    },
    setProjectFile(project: EngineProject, path: string): void {
      (project as GdProjectHandle).setProjectFile(path);
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
  const runtime: GdRuntime = { gd, engine: createRealEngine(gd) };
  runtimeCache.set(cacheKey, runtime);
  return runtime;
}
