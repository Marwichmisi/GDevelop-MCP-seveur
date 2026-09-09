import { randomUUID } from 'node:crypto';
import { validationFailed } from '../src/errors.js';
import { JSCODE_MARKER_COMMENT, hasJsCodeMarker } from '../src/events.js';
import type {
  AppendEventsInput,
  AppendEventsResult,
  AttachBehaviorInput,
  CreateObjectInput,
  EngineProject,
  EventInstructionInput,
  EventNodeInput,
  EventSelector,
  ImportResourceInput,
  MoveEventInput,
  PlaceInstanceInput,
  RemoveBehaviorInput,
  RemoveEventInput,
  UpdateBehaviorInput,
  UpdateInstancePatch,
  VariableTarget,
} from '../src/engine.js';
import { SUPPORTED_RESOURCE_KINDS, shortBehaviorName } from '../src/engine.js';
import { readContentView, toVariableNode, type JsonValue, type SerializedVariable } from '../src/contentView.js';

export interface FakeEventState {
  id: string;
  kind: string;
  conditions: { type: string; parameters: string[]; inverted?: boolean; awaited?: boolean }[];
  actions: { type: string; parameters: string[]; inverted?: boolean; awaited?: boolean }[];
  events: FakeEventState[];
  // Type-specific fields (mirrors the serialized engine shape).
  repeatExpression?: string;
  loopIndexVariable?: string;
  whileConditions?: { type: string; parameters: string[]; inverted?: boolean; awaited?: boolean }[];
  object?: string;
  iterableVariable?: string;
  keyIterator?: string;
  valueIterator?: string;
  name?: string;
  source?: string;
  comment?: string;
  target?: string;
  includeAll?: boolean;
  eventsGroup?: string;
  includeStart?: number;
  includeEnd?: number;
  inlineCode?: string;
  parameterObjects?: string;
  disabled?: boolean;
}

export interface FakeLayoutState {
  name: string;
  layers: { name: string }[];
  objects: FakeObjectState[];
  instances: FakeInstanceState[];
  variables: SerializedVariable[];
  objectsGroups: FakeGroupState[];
  events: FakeEventState[];
}

export interface FakeObjectState {
  name: string;
  type: string;
  variables: SerializedVariable[];
  behaviors: FakeBehaviorState[];
}

export interface FakeBehaviorState {
  name: string;
  type: string;
  properties: Record<string, string | number | boolean>;
}

export interface FakeInstanceState {
  persistentUuid: string;
  name: string;
  x: number;
  y: number;
  z: number;
  layer: string;
  zOrder: number;
  angle: number;
  opacity: number;
  customSize: boolean;
  width: number;
  height: number;
  initialVariables: SerializedVariable[];
}

export interface FakeGroupState {
  name: string;
  objects: string[];
}

export interface FakeContentState {
  name: string;
  projectFile: string;
  layouts: FakeLayoutState[];
  objects: FakeObjectState[];
  variables: SerializedVariable[];
  objectsGroups: FakeGroupState[];
  resources: { name: string; kind: string; file: string }[];
}

export function blankContentState(name: string): FakeContentState {
  return { name, projectFile: '', layouts: [], objects: [], variables: [], objectsGroups: [], resources: [] };
}

function clampPosition(position: number, count: number): number {
  if (!Number.isInteger(position)) throw validationFailed(`Position must be an integer, got: ${position}.`);
  return Math.min(Math.max(position, 0), count);
}

/** JSON value → serialized variable node. Refuses null (no engine null). */

function findLayout(state: FakeContentState, scene: string): FakeLayoutState {
  const layout = state.layouts.find((candidate) => candidate.name === scene);
  if (!layout) {
    const known = state.layouts.map((candidate) => candidate.name);
    throw validationFailed(`Unknown scene "${scene}".${known.length > 0 ? ` Known scenes: ${known.join(', ')}.` : ' The project has no scenes yet.'}`);
  }
  return layout;
}

function objectContainer(state: FakeContentState, scene: string | undefined): { objects: FakeObjectState[]; where: string } {
  if (scene === undefined) return { objects: state.objects, where: 'project' };
  return { objects: findLayout(state, scene).objects, where: `scene "${scene}"` };
}

function findObject(state: FakeContentState, scene: string | undefined, name: string): FakeObjectState {
  const { objects, where } = objectContainer(state, scene);
  const object = objects.find((candidate) => candidate.name === name);
  if (!object) throw validationFailed(`Unknown object "${name}" in ${where}.`);
  return object;
}

function objectExists(state: FakeContentState, scene: string, name: string): boolean {
  const layout = findLayout(state, scene);
  return (
    layout.objects.some((candidate) => candidate.name === name) ||
    state.objects.some((candidate) => candidate.name === name)
  );
}

function groupContainer(state: FakeContentState, scene: string | undefined): { groups: FakeGroupState[]; where: string } {
  if (scene === undefined) return { groups: state.objectsGroups, where: 'project' };
  return { groups: findLayout(state, scene).objectsGroups, where: `scene "${scene}"` };
}

function instanceList(state: FakeContentState, scene: string): FakeInstanceState[] {
  return findLayout(state, scene).instances;
}

function findInstance(state: FakeContentState, scene: string, instanceId: string): FakeInstanceState {
  const instance = instanceList(state, scene).find((candidate) => candidate.persistentUuid === instanceId);
  if (!instance) throw validationFailed(`Unknown instance "${instanceId}" in scene "${scene}".`);
  return instance;
}

function variablesOf(state: FakeContentState, target: VariableTarget): { variables: SerializedVariable[]; where: string } {
  switch (target.scope) {
    case 'global':
      return { variables: state.variables, where: 'project' };
    case 'scene': {
      if (target.scene === undefined) throw validationFailed('Variable target "scene" requires a scene name.');
      return { variables: findLayout(state, target.scene).variables, where: `scene "${target.scene}"` };
    }
    case 'object': {
      if (target.object === undefined) throw validationFailed('Variable target "object" requires an object name.');
      const object = findObject(state, target.scene, target.object);
      return { variables: object.variables, where: `object "${target.object}"` };
    }
    case 'instance': {
      if (target.scene === undefined || target.instanceId === undefined) {
        throw validationFailed('Variable target "instance" requires a scene name and an instance id.');
      }
      const instance = findInstance(state, target.scene, target.instanceId);
      return { variables: instance.initialVariables, where: `instance "${target.instanceId}"` };
    }
  }
}

function setVariableNode(variables: SerializedVariable[], name: string, value: JsonValue): void {
  const index = variables.findIndex((candidate) => candidate.name === name);
  const node = toVariableNode(name, value);
  if (index === -1) variables.push(node);
  else variables[index] = node;
}

/** All content mutations on a fake state. Each validates before mutating. */
export function createScene(state: FakeContentState, name: string): void {
  if (state.layouts.some((layout) => layout.name === name)) throw validationFailed(`Scene "${name}" already exists.`);
  state.layouts.push({ name, layers: [{ name: '' }], objects: [], instances: [], variables: [], objectsGroups: [], events: [] });
}

export function renameScene(state: FakeContentState, oldName: string, newName: string): void {
  const layout = findLayout(state, oldName);
  if (oldName !== newName && state.layouts.some((candidate) => candidate.name === newName)) {
    throw validationFailed(`Scene "${newName}" already exists.`);
  }
  layout.name = newName;
}

export function moveScene(state: FakeContentState, name: string, position: number): void {
  const from = state.layouts.findIndex((layout) => layout.name === name);
  if (from === -1) throw validationFailed(`Unknown scene "${name}".`);
  const [layout] = state.layouts.splice(from, 1) as [FakeLayoutState];
  state.layouts.splice(clampPosition(position, state.layouts.length), 0, layout);
}

export function deleteScene(state: FakeContentState, name: string): void {
  const index = state.layouts.findIndex((layout) => layout.name === name);
  if (index === -1) throw validationFailed(`Unknown scene "${name}".`);
  state.layouts.splice(index, 1);
}

export function createLayer(state: FakeContentState, scene: string, name: string): void {
  const layout = findLayout(state, scene);
  if (name === '') throw validationFailed('The base layer ("") always exists; it cannot be created.');
  if (layout.layers.some((layer) => layer.name === name)) {
    throw validationFailed(`Layer "${name}" already exists in scene "${scene}".`);
  }
  layout.layers.push({ name });
}

export function renameLayer(state: FakeContentState, scene: string, oldName: string, newName: string): void {
  const layout = findLayout(state, scene);
  if (oldName === '') throw validationFailed('The base layer ("") cannot be renamed.');
  const layer = layout.layers.find((candidate) => candidate.name === oldName);
  if (!layer) throw validationFailed(`Unknown layer "${oldName}" in scene "${scene}".`);
  if (oldName !== newName && layout.layers.some((candidate) => candidate.name === newName)) {
    throw validationFailed(`Layer "${newName}" already exists in scene "${scene}".`);
  }
  layer.name = newName;
  for (const instance of layout.instances) {
    if (instance.layer === oldName) instance.layer = newName;
  }
}

export function moveLayer(state: FakeContentState, scene: string, name: string, position: number): void {
  const layout = findLayout(state, scene);
  const from = layout.layers.findIndex((layer) => layer.name === name);
  if (from === -1) throw validationFailed(`Unknown layer "${name}" in scene "${scene}".`);
  const [layer] = layout.layers.splice(from, 1) as [{ name: string }];
  layout.layers.splice(clampPosition(position, layout.layers.length), 0, layer);
}

export function deleteLayer(state: FakeContentState, scene: string, name: string): void {
  const layout = findLayout(state, scene);
  if (name === '') throw validationFailed('The base layer ("") cannot be deleted.');
  const index = layout.layers.findIndex((layer) => layer.name === name);
  if (index === -1) throw validationFailed(`Unknown layer "${name}" in scene "${scene}".`);
  if (layout.instances.some((instance) => instance.layer === name)) {
    throw validationFailed(`Layer "${name}" still hosts instances; move or remove them first.`);
  }
  layout.layers.splice(index, 1);
}

function checkBehaviorType(_type: string): void {
  // The fake has no platform metadata; type checking is the real engine's job
  // (isBadObjectMetadata/isBadBehaviorMetadata preconditions). The fake only
  // enforces naming and structural coherence.
}

export function createObject(state: FakeContentState, input: CreateObjectInput): void {
  const { objects, where } = objectContainer(state, input.scene);
  if (objects.some((candidate) => candidate.name === input.name)) {
    throw validationFailed(`Object "${input.name}" already exists in ${where}.`);
  }
  checkBehaviorType(input.type);
  if (input.collisionMaskAutomatic !== undefined && input.type !== 'Sprite') {
    throw validationFailed(`collisionMaskAutomatic only applies to Sprite objects, not "${input.type}".`);
  }
  const seen = new Set<string>();
  const behaviors = (input.behaviors ?? []).map((behavior) => {
    const name = behavior.name ?? shortBehaviorName(behavior.type);
    if (seen.has(name)) throw validationFailed(`Duplicate behavior name "${name}" on object "${input.name}".`);
    seen.add(name);
    return { name, type: behavior.type, properties: normalizeProperties(behavior.properties ?? {}) };
  });
  const variables = Object.entries(input.variables ?? {}).map(([key, value]) => toVariableNode(key, value));
  objects.push({ name: input.name, type: input.type, variables, behaviors });
}

export function normalizeProperties(
  properties: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  // Mirror the serialized shape: keys lower-first (live "Gravity" → saved
  // "gravity"), JSON value types preserved so the fake describes identical
  // projects identically to the real engine. String "1"/"0" for boolean
  // props is a live-wire coercion the fake cannot know — send JSON booleans.
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [key.slice(0, 1).toLowerCase() + key.slice(1), value]),
  );
}

export function renameObject(state: FakeContentState, scene: string | undefined, oldName: string, newName: string): void {
  const { objects, where } = objectContainer(state, scene);
  const object = objects.find((candidate) => candidate.name === oldName);
  if (!object) throw validationFailed(`Unknown object "${oldName}" in ${where}.`);
  if (oldName !== newName && objects.some((candidate) => candidate.name === newName)) {
    throw validationFailed(`Object "${newName}" already exists in ${where}.`);
  }
  object.name = newName;
  const layouts = scene === undefined ? state.layouts : [findLayout(state, scene)];
  for (const layout of layouts) {
    for (const instance of layout.instances) {
      if (instance.name === oldName) instance.name = newName;
    }
    const groups = scene === undefined ? state.objectsGroups : layout.objectsGroups;
    for (const group of groups) {
      const index = group.objects.indexOf(oldName);
      if (index !== -1) group.objects[index] = newName;
    }
  }
}

export function deleteObject(state: FakeContentState, scene: string | undefined, name: string): void {
  const { objects, where } = objectContainer(state, scene);
  const index = objects.findIndex((candidate) => candidate.name === name);
  if (index === -1) throw validationFailed(`Unknown object "${name}" in ${where}.`);
  objects.splice(index, 1);
  const layouts = scene === undefined ? state.layouts : [findLayout(state, scene)];
  for (const layout of layouts) {
    layout.instances = layout.instances.filter((instance) => instance.name !== name);
    const groups = scene === undefined ? state.objectsGroups : layout.objectsGroups;
    for (const group of groups) group.objects = group.objects.filter((member) => member !== name);
  }
}

export function attachBehavior(state: FakeContentState, input: AttachBehaviorInput): { name: string } {
  const object = findObject(state, input.scene, input.object);
  const name = input.name ?? shortBehaviorName(input.type);
  if (object.behaviors.some((behavior) => behavior.name === name)) {
    throw validationFailed(`Behavior "${name}" already exists on object "${input.object}".`);
  }
  object.behaviors.push({ name, type: input.type, properties: normalizeProperties(input.properties ?? {}) });
  return { name };
}

export function updateBehavior(state: FakeContentState, input: UpdateBehaviorInput): void {
  const object = findObject(state, input.scene, input.object);
  const behavior = object.behaviors.find((candidate) => candidate.name === input.name);
  if (!behavior) throw validationFailed(`Unknown behavior "${input.name}" on object "${input.object}".`);
  // Case-insensitive key resolution like the real engine; unknown keys merge
  // (only live metadata can refuse them — proven in the real-engine suite).
  for (const [key, value] of Object.entries(normalizeProperties(input.properties))) {
    const existing = Object.keys(behavior.properties).find(
      (candidate) => candidate.toLowerCase() === key.toLowerCase(),
    );
    behavior.properties[existing ?? key] = value;
  }
}

export function removeBehavior(state: FakeContentState, input: RemoveBehaviorInput): void {
  const object = findObject(state, input.scene, input.object);
  const index = object.behaviors.findIndex((candidate) => candidate.name === input.name);
  if (index === -1) throw validationFailed(`Unknown behavior "${input.name}" on object "${input.object}".`);
  object.behaviors.splice(index, 1);
}

export function placeInstance(state: FakeContentState, input: PlaceInstanceInput): { instanceId: string } {
  const layout = findLayout(state, input.scene);
  if (!objectExists(state, input.scene, input.object)) {
    throw validationFailed(`Unknown object "${input.object}" for scene "${input.scene}".`);
  }
  if (input.layer !== undefined && input.layer !== '' && !layout.layers.some((layer) => layer.name === input.layer)) {
    throw validationFailed(`Unknown layer "${input.layer}" in scene "${input.scene}".`);
  }
  const hasCustomSize = input.width !== undefined || input.height !== undefined;
  const instance: FakeInstanceState = {
    persistentUuid: randomUUID(),
    name: input.object,
    x: input.x,
    y: input.y,
    z: input.z ?? 0,
    layer: input.layer ?? '',
    zOrder: input.zOrder ?? 0,
    angle: input.angle ?? 0,
    opacity: input.opacity ?? 255,
    customSize: hasCustomSize,
    width: input.width ?? 0,
    height: input.height ?? 0,
    initialVariables: Object.entries(input.variables ?? {}).map(([key, value]) => toVariableNode(key, value)),
  };
  layout.instances.push(instance);
  return { instanceId: instance.persistentUuid };
}

export function updateInstance(
  state: FakeContentState,
  scene: string,
  instanceId: string,
  patch: UpdateInstancePatch,
): void {
  const layout = findLayout(state, scene);
  const instance = findInstance(state, scene, instanceId);
  if (patch.object !== undefined) {
    if (!objectExists(state, scene, patch.object)) throw validationFailed(`Unknown object "${patch.object}".`);
    instance.name = patch.object;
  }
  if (patch.layer !== undefined) {
    if (patch.layer !== '' && !layout.layers.some((layer) => layer.name === patch.layer)) {
      throw validationFailed(`Unknown layer "${patch.layer}" in scene "${scene}".`);
    }
    instance.layer = patch.layer;
  }
  if (patch.x !== undefined) instance.x = patch.x;
  if (patch.y !== undefined) instance.y = patch.y;
  if (patch.z !== undefined) instance.z = patch.z;
  if (patch.zOrder !== undefined) instance.zOrder = patch.zOrder;
  if (patch.angle !== undefined) instance.angle = patch.angle;
  if (patch.opacity !== undefined) instance.opacity = patch.opacity;
  if (patch.width !== undefined) {
    instance.width = patch.width;
    instance.customSize = true;
  }
  if (patch.height !== undefined) {
    instance.height = patch.height;
    instance.customSize = true;
  }
  if (patch.keepRatio !== undefined && !patch.keepRatio) {
    // kept for payload parity with the engine; the fake has no ratio math.
  }
  for (const [key, value] of Object.entries(patch.variables ?? {})) {
    setVariableNode(instance.initialVariables, key, value);
  }
}

export function removeInstance(state: FakeContentState, scene: string, instanceId: string): void {
  const layout = findLayout(state, scene);
  findInstance(state, scene, instanceId);
  layout.instances = layout.instances.filter((instance) => instance.persistentUuid !== instanceId);
}

export function removeInstancesOfObject(state: FakeContentState, scene: string, object: string): { removed: number } {
  const layout = findLayout(state, scene);
  const before = layout.instances.length;
  layout.instances = layout.instances.filter((instance) => instance.name !== object);
  return { removed: before - layout.instances.length };
}

export function moveInstancesToLayer(
  state: FakeContentState,
  scene: string,
  sourceLayer: string,
  targetLayer: string,
): { moved: number } {
  const layout = findLayout(state, scene);
  if (targetLayer !== '' && !layout.layers.some((layer) => layer.name === targetLayer)) {
    throw validationFailed(`Unknown layer "${targetLayer}" in scene "${scene}".`);
  }
  let moved = 0;
  for (const instance of layout.instances) {
    if (instance.layer === sourceLayer) {
      instance.layer = targetLayer;
      moved++;
    }
  }
  return { moved };
}

export function setVariable(state: FakeContentState, target: VariableTarget, name: string, value: JsonValue): void {
  const { variables } = variablesOf(state, target);
  setVariableNode(variables, name, value);
}

export function removeVariable(state: FakeContentState, target: VariableTarget, name: string): void {
  const { variables, where } = variablesOf(state, target);
  const index = variables.findIndex((candidate) => candidate.name === name);
  if (index === -1) throw validationFailed(`Unknown variable "${name}" in ${where}.`);
  variables.splice(index, 1);
}

export function renameVariable(state: FakeContentState, target: VariableTarget, oldName: string, newName: string): void {
  const { variables, where } = variablesOf(state, target);
  const node = variables.find((candidate) => candidate.name === oldName);
  if (!node) throw validationFailed(`Unknown variable "${oldName}" in ${where}.`);
  if (oldName !== newName && variables.some((candidate) => candidate.name === newName)) {
    throw validationFailed(`Variable "${newName}" already exists in ${where}.`);
  }
  node.name = newName;
}

export function createGroup(state: FakeContentState, scene: string | undefined, name: string, objects: string[]): void {
  const { groups, where } = groupContainer(state, scene);
  if (groups.some((group) => group.name === name)) throw validationFailed(`Group "${name}" already exists in ${where}.`);
  for (const object of objects) {
    if (scene === undefined) {
      if (!state.objects.some((candidate) => candidate.name === object)) {
        throw validationFailed(`Unknown object "${object}" in project.`);
      }
    } else if (!objectExists(state, scene, object)) {
      throw validationFailed(`Unknown object "${object}" for scene "${scene}".`);
    }
  }
  groups.push({ name, objects: [...objects] });
}

export function deleteGroup(state: FakeContentState, scene: string | undefined, name: string): void {
  const { groups, where } = groupContainer(state, scene);
  const index = groups.findIndex((group) => group.name === name);
  if (index === -1) throw validationFailed(`Unknown group "${name}" in ${where}.`);
  groups.splice(index, 1);
}

export function addObjectToGroup(
  state: FakeContentState,
  scene: string | undefined,
  group: string,
  object: string,
): void {
  const { groups, where } = groupContainer(state, scene);
  const target = groups.find((candidate) => candidate.name === group);
  if (!target) throw validationFailed(`Unknown group "${group}" in ${where}.`);
  if (scene === undefined) {
    if (!state.objects.some((candidate) => candidate.name === object)) {
      throw validationFailed(`Unknown object "${object}" in project.`);
    }
  } else if (!objectExists(state, scene, object)) {
    throw validationFailed(`Unknown object "${object}" for scene "${scene}".`);
  }
  if (!target.objects.includes(object)) target.objects.push(object);
}

export function removeObjectFromGroup(
  state: FakeContentState,
  scene: string | undefined,
  group: string,
  object: string,
): void {
  const { groups, where } = groupContainer(state, scene);
  const target = groups.find((candidate) => candidate.name === group);
  if (!target) throw validationFailed(`Unknown group "${group}" in ${where}.`);
  if (!target.objects.includes(object)) throw validationFailed(`Object "${object}" is not in group "${group}".`);
  target.objects = target.objects.filter((member) => member !== object);
}

export function importResource(state: FakeContentState, input: ImportResourceInput): { name: string } {
  if (!(SUPPORTED_RESOURCE_KINDS as readonly string[]).includes(input.kind)) {
    throw validationFailed(`Unsupported resource kind "${input.kind}". Supported: ${SUPPORTED_RESOURCE_KINDS.join(', ')}.`);
  }
  if (state.resources.some((resource) => resource.name === input.name)) {
    throw validationFailed(`Resource "${input.name}" already exists.`);
  }
  state.resources.push({ name: input.name, kind: input.kind, file: input.file });
  return { name: input.name };
}

export function removeResource(state: FakeContentState, name: string): void {
  const index = state.resources.findIndex((resource) => resource.name === name);
  if (index === -1) throw validationFailed(`Unknown resource "${name}".`);
  state.resources.splice(index, 1);
}

// --- Events (ticket #14, fake side of the engine seam) ---

/** Minimal instruction catalog for the fake: mirrors the real arity for the
 *  two instructions the suites use (ModVarScene action / VarScene condition).
 *  Anything else is an L1 refusal, like MetadataProvider would report. */
const FAKE_ACTION_ARITY: Record<string, number> = { ModVarScene: 3 };
const FAKE_CONDITION_ARITY: Record<string, number> = { VarScene: 3 };

function checkFakeInstructions(
  list: EventInstructionInput[] | undefined,
  role: 'condition' | 'action' | 'while-condition',
  errors: string[],
): void {
  for (const instr of list ?? []) {
    const catalog = role === 'action' ? FAKE_ACTION_ARITY : FAKE_CONDITION_ARITY;
    const expected = catalog[instr.type];
    if (expected === undefined) {
      errors.push(`Unknown ${role} type "${instr.type}" (L1).`);
      continue;
    }
    if (instr.parameters.length !== expected) {
      errors.push(
        `Wrong arity for ${role} "${instr.type}": expected ${expected}, got ${instr.parameters.length} (L2).`,
      );
    }
  }
}

function collectEventErrors(nodes: EventNodeInput[], errors: string[], where = 'events'): void {
  nodes.forEach((node, index) => {
    const at = `${where}[${index}] (${node.kind})`;
    switch (node.kind) {
      case 'standard':
      case 'else':
      case 'repeat':
      case 'while':
      case 'foreach':
      case 'foreachChildVariable':
        checkFakeInstructions(node.conditions, 'condition', errors);
        checkFakeInstructions(node.actions, 'action', errors);
        break;
      default:
        break;
    }
    switch (node.kind) {
      case 'repeat':
        if (typeof node.repeatExpression !== 'string') errors.push(`${at}: repeatExpression must be a string.`);
        break;
      case 'while':
        checkFakeInstructions(node.whileConditions, 'while-condition', errors);
        break;
      case 'foreach':
        if (node.object.trim() === '') errors.push(`${at}: object must not be empty.`);
        break;
      case 'foreachChildVariable':
        if (node.iterableVariable.trim() === '') errors.push(`${at}: iterableVariable must not be empty.`);
        break;
      case 'group':
        if (node.name.trim() === '') errors.push(`${at}: group name must not be empty.`);
        break;
      case 'comment':
        if (typeof node.comment !== 'string') errors.push(`${at}: comment must be a string.`);
        break;
      case 'link':
        if (node.target.trim() === '') errors.push(`${at}: link target must not be empty.`);
        break;
      case 'jscode':
        if (!hasJsCodeMarker(node.inlineCode)) {
          errors.push(`${at}: JsCode without the marker "${JSCODE_MARKER_COMMENT}" is refused.`);
        }
        break;
    }
    if ('events' in node && node.events) collectEventErrors(node.events, errors, `${at}.events`);
  });
}

function throwOnEventErrors(nodes: EventNodeInput[]): void {
  const errors: string[] = [];
  collectEventErrors(nodes, errors);
  if (errors.length > 0) throw validationFailed(`Invalid events: ${errors.join('; ')}`);
}

function toFakeInstruction(instr: EventInstructionInput): FakeEventState['conditions'][number] {
  return {
    type: instr.type,
    parameters: [...instr.parameters],
    ...(instr.inverted !== undefined ? { inverted: instr.inverted } : {}),
    ...(instr.awaited !== undefined ? { awaited: instr.awaited } : {}),
  };
}

function buildFakeEvent(node: EventNodeInput): FakeEventState {
  const base: FakeEventState = {
    id: randomUUID(),
    kind: node.kind,
    conditions: [],
    actions: [],
    events: [],
  };
  if (node.kind === 'standard' || node.kind === 'else' || node.kind === 'repeat' || node.kind === 'while' || node.kind === 'foreach' || node.kind === 'foreachChildVariable') {
    base.conditions = (node.conditions ?? []).map(toFakeInstruction);
    base.actions = (node.actions ?? []).map(toFakeInstruction);
    base.events = (node.events ?? []).map(buildFakeEvent);
    if (node.disabled !== undefined) base.disabled = node.disabled;
  }
  switch (node.kind) {
    case 'repeat':
      base.repeatExpression = node.repeatExpression;
      if (node.loopIndexVariable !== undefined) base.loopIndexVariable = node.loopIndexVariable;
      break;
    case 'while':
      base.whileConditions = node.whileConditions.map(toFakeInstruction);
      break;
    case 'foreach':
      base.object = node.object;
      if (node.loopIndexVariable !== undefined) base.loopIndexVariable = node.loopIndexVariable;
      break;
    case 'foreachChildVariable':
      base.iterableVariable = node.iterableVariable;
      if (node.keyIterator !== undefined) base.keyIterator = node.keyIterator;
      if (node.valueIterator !== undefined) base.valueIterator = node.valueIterator;
      break;
    case 'group':
      base.name = node.name;
      if (node.source !== undefined) base.source = node.source;
      base.events = (node.events ?? []).map(buildFakeEvent);
      if (node.disabled !== undefined) base.disabled = node.disabled;
      break;
    case 'comment':
      base.comment = node.comment;
      break;
    case 'link':
      base.target = node.target;
      if (node.includeAll !== undefined) base.includeAll = node.includeAll;
      if (node.eventsGroup !== undefined) base.eventsGroup = node.eventsGroup;
      if (node.includeStart !== undefined) base.includeStart = node.includeStart;
      if (node.includeEnd !== undefined) base.includeEnd = node.includeEnd;
      break;
    case 'jscode':
      base.inlineCode = node.inlineCode;
      if (node.parameterObjects !== undefined) base.parameterObjects = node.parameterObjects;
      break;
  }
  return base;
}

interface ResolvedEvent {
  parent: FakeEventState[];
  index: number;
  event: FakeEventState;
  path: number[];
}

function resolveEventPath(root: FakeEventState[], path: number[]): ResolvedEvent {
  let parent: FakeEventState[] = root;
  let event: FakeEventState | undefined;
  const resolved: number[] = [];
  for (let depth = 0; depth < path.length; depth++) {
    const index = path[depth] as number;
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
      throw validationFailed(`Unknown event path [${path.join(', ')}]: index ${index} out of range at depth ${depth}.`);
    }
    event = parent[index] as FakeEventState;
    resolved.push(index);
    if (depth < path.length - 1) parent = event.events;
  }
  if (!event) throw validationFailed(`Unknown event path [${path.join(', ')}]: empty path.`);
  return { parent, index: path[path.length - 1] as number, event, path: resolved };
}

function findEventById(root: FakeEventState[], id: string): ResolvedEvent {
  const visit = (list: FakeEventState[], prefix: number[]): ResolvedEvent | null => {
    for (let i = 0; i < list.length; i++) {
      const event = list[i] as FakeEventState;
      if (event.id === id) return { parent: list, index: i, event, path: [...prefix, i] };
      const nested = visit(event.events, [...prefix, i]);
      if (nested) return nested;
    }
    return null;
  };
  const found = visit(root, []);
  if (!found) throw validationFailed(`Unknown event id "${id}".`);
  return found;
}

function resolveEventSelector(root: FakeEventState[], selector: EventSelector): ResolvedEvent {
  if ('path' in selector) return resolveEventPath(root, selector.path);
  return findEventById(root, selector.id);
}

export function appendSceneEvents(state: FakeContentState, input: AppendEventsInput): AppendEventsResult {
  const layout = findLayout(state, input.scene);
  throwOnEventErrors(input.events);
  const built = input.events.map(buildFakeEvent);
  const at = input.position === undefined ? layout.events.length : clampPosition(input.position, layout.events.length);
  layout.events.splice(at, 0, ...built);
  // Report every stamped id (root + nested, DFS order) so agents can address
  // sub-events by stable id without a second describe.
  const ids: string[] = [];
  const paths: number[][] = [];
  const collect = (event: FakeEventState, path: number[]): void => {
    ids.push(event.id);
    paths.push(path);
    event.events.forEach((child, i) => collect(child, [...path, i]));
  };
  built.forEach((event, offset) => collect(event, [at + offset]));
  return { appended: built.length, ids, paths, dryRun: false };
}

export function moveSceneEvent(state: FakeContentState, input: MoveEventInput): { moved: boolean; dryRun: boolean } {
  const layout = findLayout(state, input.scene);
  const source = resolveEventSelector(layout.events, input.from);
  const destParentList: FakeEventState[] = input.toParent
    ? resolveEventSelector(layout.events, input.toParent).event.events
    : source.parent;
  // Refuse to move a parent into its own subtree (would orphan the tree).
  if (input.toParent) {
    const dest = resolveEventSelector(layout.events, input.toParent);
    if (dest.event.kind === 'comment' || dest.event.kind === 'link' || dest.event.kind === 'jscode') {
      throw validationFailed('Destination parent cannot hold sub-events (comment, link and JsCode are leaves).');
    }
    if (dest.path.length > source.path.length && dest.path.slice(0, source.path.length).every((v, i) => v === source.path[i])) {
      throw validationFailed('Cannot move an event into its own subtree.');
    }
  }
  const [moved] = source.parent.splice(source.index, 1) as [FakeEventState];
  const at = clampPosition(input.toPosition, destParentList.length);
  // When moving inside the same list, the splice above already shifted indices;
  // `at` is the final position in the shortened list (clamped).
  destParentList.splice(at, 0, moved as FakeEventState);
  return { moved: true, dryRun: false };
}

export function removeSceneEvent(state: FakeContentState, input: RemoveEventInput): { removed: boolean; dryRun: boolean } {
  const layout = findLayout(state, input.scene);
  const resolved = resolveEventSelector(layout.events, input.target);
  resolved.parent.splice(resolved.index, 1);
  return { removed: true, dryRun: false };
}

export function validateSceneEvents(
  state: FakeContentState,
  scene: string,
  events: EventNodeInput[],
): { valid: boolean; errors: string[] } {
  findLayout(state, scene);
  const errors: string[] = [];
  collectEventErrors(events, errors);
  return { valid: errors.length === 0, errors };
}

function toSerializedObject(object: FakeObjectState): {
  name: string;
  type: string;
  variables: SerializedVariable[];
  behaviors: { name: string; type: string }[];
} {
  return {
    name: object.name,
    type: object.type,
    variables: object.variables,
    behaviors: object.behaviors.map((behavior) => ({ name: behavior.name, type: behavior.type, ...behavior.properties })),
  };
}

function toEventView(event: FakeEventState): ReturnType<typeof readContentView>['scenes'][number]['events'][number] {
  return {
    id: event.id,
    kind: event.kind,
    disabled: event.disabled === true,
    conditions: event.conditions.map((c) => ({
      type: c.type,
      parameters: [...c.parameters],
      inverted: c.inverted === true,
      awaited: c.awaited === true,
    })),
    actions: event.actions.map((a) => ({
      type: a.type,
      parameters: [...a.parameters],
      inverted: a.inverted === true,
      awaited: a.awaited === true,
    })),
    events: event.events.map(toEventView),
    ...(event.repeatExpression !== undefined ? { repeatExpression: event.repeatExpression } : {}),
    ...(event.loopIndexVariable !== undefined ? { loopIndexVariable: event.loopIndexVariable } : {}),
    ...(event.whileConditions !== undefined
      ? {
          whileConditions: event.whileConditions.map((c) => ({
            type: c.type,
            parameters: [...c.parameters],
            inverted: c.inverted === true,
            awaited: c.awaited === true,
          })),
        }
      : {}),
    ...(event.object !== undefined ? { object: event.object } : {}),
    ...(event.iterableVariable !== undefined ? { iterableVariable: event.iterableVariable } : {}),
    ...(event.keyIterator !== undefined ? { keyIterator: event.keyIterator } : {}),
    ...(event.valueIterator !== undefined ? { valueIterator: event.valueIterator } : {}),
    ...(event.name !== undefined ? { name: event.name } : {}),
    ...(event.source !== undefined ? { source: event.source } : {}),
    ...(event.comment !== undefined ? { comment: event.comment } : {}),
    ...(event.target !== undefined ? { target: event.target } : {}),
    ...(event.inlineCode !== undefined ? { inlineCode: event.inlineCode } : {}),
    ...(event.parameterObjects !== undefined ? { parameterObjects: event.parameterObjects } : {}),
  };
}

/** Fake state already mirrors the serialized shape the reader expects. */
export function describeContentState(state: FakeContentState): ReturnType<typeof readContentView> {
  const view = readContentView({
    layouts: state.layouts.map((layout) => ({
      name: layout.name,
      layers: layout.layers,
      objects: layout.objects.map(toSerializedObject),
      instances: layout.instances,
      variables: layout.variables,
      objectsGroups: layout.objectsGroups.map((group) => ({
        name: group.name,
        objects: group.objects.map((name) => ({ name })),
      })),
    })),
    objects: state.objects.map(toSerializedObject),
    variables: state.variables,
    objectsGroups: state.objectsGroups.map((group) => ({
      name: group.name,
      objects: group.objects.map((name) => ({ name })),
    })),
    resources: state.resources,
  });
  state.layouts.forEach((layout, i) => {
    const scene = view.scenes[i];
    if (scene) scene.events = (layout.events ?? []).map(toEventView);
  });
  return view;
}

export type { EngineProject };
