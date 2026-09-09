/**
 * Pure reader: serialized project JSON (the engine's own save shape) into the
 * agent-facing content view. Shared by the real engine (which serializes the
 * live `gd.Project` first) and the fake (whose state already has this shape),
 * so both implementations describe identical projects identically.
 *
 * Only known keys are picked; anything else the engine writes is ignored.
 */

import { validationFailed } from './errors.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface SerializedVariable {
  name?: unknown;
  type?: unknown;
  value?: JsonValue;
  children?: SerializedVariable[] | undefined;
}

export interface SerializedBehavior {
  name?: unknown;
  type?: unknown;
  [property: string]: unknown;
}

export interface SerializedObject {
  name?: unknown;
  type?: unknown;
  variables?: SerializedVariable[] | undefined;
  behaviors?: SerializedBehavior[] | undefined;
}

export interface SerializedInstance {
  persistentUuid?: unknown;
  name?: unknown;
  x?: unknown;
  y?: unknown;
  z?: unknown;
  layer?: unknown;
  zOrder?: unknown;
  angle?: unknown;
  opacity?: unknown;
  customSize?: unknown;
  width?: unknown;
  height?: unknown;
  initialVariables?: SerializedVariable[] | undefined;
}

export interface SerializedGroup {
  name?: unknown;
  objects?: { name?: unknown }[] | undefined;
}

export interface SerializedInstruction {
  type?: unknown;
  parameters?: unknown;
  inverted?: unknown;
  awaited?: unknown;
}

export interface SerializedEvent {
  type?: unknown;
  aiGeneratedEventId?: unknown;
  conditions?: SerializedInstruction[] | undefined;
  actions?: SerializedInstruction[] | undefined;
  events?: SerializedEvent[] | undefined;
  disabled?: unknown;
  repeatExpression?: unknown;
  loopIndexVariable?: unknown;
  whileConditions?: SerializedInstruction[] | undefined;
  object?: unknown;
  iterableVariableName?: unknown;
  keyIteratorVariableName?: unknown;
  valueIteratorVariableName?: unknown;
  name?: unknown;
  source?: unknown;
  comment?: unknown;
  target?: unknown;
  inlineCode?: unknown;
  parameterObjects?: unknown;
}

export interface SerializedLayout {
  name?: unknown;
  layers?: { name?: unknown }[] | undefined;
  objects?: SerializedObject[] | undefined;
  instances?: SerializedInstance[] | undefined;
  variables?: SerializedVariable[] | undefined;
  objectsGroups?: SerializedGroup[] | undefined;
  events?: SerializedEvent[] | undefined;
}

export interface SerializedProject {
  layouts?: SerializedLayout[] | undefined;
  objects?: SerializedObject[] | undefined;
  variables?: SerializedVariable[] | undefined;
  objectsGroups?: SerializedGroup[] | undefined;
  /** Real shape is `{ resources: [...] }` (container); the fake keeps a flat array. */
  resources?: { name?: unknown; kind?: unknown; file?: unknown }[] | { resources?: unknown } | undefined;
}

export interface BehaviorView {
  name: string;
  type: string;
  properties: Record<string, JsonValue>;
}

export interface ObjectView {
  name: string;
  type: string;
  behaviors: BehaviorView[];
  variables: Record<string, JsonValue>;
}

export interface InstanceView {
  id: string;
  object: string;
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
  variables: Record<string, JsonValue>;
}

export interface GroupView {
  name: string;
  objects: string[];
}

export interface InstructionView {
  type: string;
  parameters: string[];
  inverted: boolean;
  awaited: boolean;
}

export interface EventView {
  id: string;
  kind: string;
  disabled: boolean;
  conditions: InstructionView[];
  actions: InstructionView[];
  events: EventView[];
  repeatExpression?: string;
  loopIndexVariable?: string;
  whileConditions?: InstructionView[];
  object?: string;
  iterableVariable?: string;
  keyIterator?: string;
  valueIterator?: string;
  name?: string;
  source?: string;
  comment?: string;
  target?: string;
  inlineCode?: string;
  parameterObjects?: string;
}

export interface SceneView {
  name: string;
  layers: string[];
  objects: ObjectView[];
  instances: InstanceView[];
  variables: Record<string, JsonValue>;
  groups: GroupView[];
  events: EventView[];
}

export interface ResourceView {
  name: string;
  kind: string;
  file: string;
}

export interface ContentView {
  scenes: SceneView[];
  globalObjects: ObjectView[];
  globalVariables: Record<string, JsonValue>;
  globalGroups: GroupView[];
  resources: ResourceView[];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/** Rebuild the logical JSON value of a serialized variable node. */
export function readVariableValue(node: SerializedVariable): JsonValue {
  switch (node.type) {
    case 'number':
      return asNumber(node.value);
    case 'string':
      return typeof node.value === 'string' ? node.value : '';
    case 'boolean':
      return node.value === true;
    case 'array':
      return asArray(node.children).map(readVariableValue);
    case 'structure': {
      const out: Record<string, JsonValue> = {};
      for (const child of asArray(node.children)) {
        if (typeof child.name === 'string') out[child.name] = readVariableValue(child);
      }
      return out;
    }
    default:
      return null;
  }
}

export function readVariables(nodes: SerializedVariable[] | undefined): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const node of asArray(nodes)) {
    if (typeof node.name === 'string') out[node.name] = readVariableValue(node);
  }
  return out;
}

/**
 * Free JSON value → serialized variable node. Refuses null: the engine has
 * no null variable, so failing loudly beats inventing a mapping.
 */
export function toVariableNode(name: string, value: JsonValue): SerializedVariable {
  if (value === null) {
    throw validationFailed(`Variable "${name}": null has no engine representation; use "", 0 or false.`);
  }
  if (typeof value === 'number') return { name, type: 'number', value };
  if (typeof value === 'string') return { name, type: 'string', value };
  if (typeof value === 'boolean') return { name, type: 'boolean', value };
  if (Array.isArray(value)) {
    return { name, type: 'array', children: value.map((item) => toVariableNode('', item)) };
  }
  return { name, type: 'structure', children: Object.entries(value).map(([key, item]) => toVariableNode(key, item)) };
}

function readBehavior(node: SerializedBehavior): BehaviorView {
  const { name, type, ...properties } = node;
  return { name: asString(name), type: asString(type), properties: properties as Record<string, JsonValue> };
}

function readObject(node: SerializedObject): ObjectView {
  return {
    name: asString(node.name),
    type: asString(node.type),
    behaviors: asArray(node.behaviors).map(readBehavior),
    variables: readVariables(node.variables),
  };
}

function readInstance(node: SerializedInstance): InstanceView {
  return {
    id: asString(node.persistentUuid),
    object: asString(node.name),
    x: asNumber(node.x),
    y: asNumber(node.y),
    z: asNumber(node.z),
    layer: asString(node.layer),
    zOrder: asNumber(node.zOrder),
    angle: asNumber(node.angle),
    opacity: typeof node.opacity === 'number' ? node.opacity : 255,
    customSize: node.customSize === true,
    width: asNumber(node.width),
    height: asNumber(node.height),
    variables: readVariables(node.initialVariables),
  };
}

function readGroup(node: SerializedGroup): GroupView {
  return {
    name: asString(node.name),
    objects: asArray(node.objects).map((entry) => asString(entry?.name)),
  };
}

const EVENT_KINDS: Record<string, string> = {
  'BuiltinCommonInstructions::Standard': 'standard',
  'BuiltinCommonInstructions::Else': 'else',
  'BuiltinCommonInstructions::Repeat': 'repeat',
  'BuiltinCommonInstructions::While': 'while',
  'BuiltinCommonInstructions::ForEach': 'foreach',
  'BuiltinCommonInstructions::ForEachChildVariable': 'foreachChildVariable',
  'BuiltinCommonInstructions::Group': 'group',
  'BuiltinCommonInstructions::Comment': 'comment',
  'BuiltinCommonInstructions::Link': 'link',
  'BuiltinCommonInstructions::JsCode': 'jscode',
};

function readInstructionType(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && raw !== null && 'value' in raw) {
    const value = (raw as { value?: unknown }).value;
    if (typeof value === 'string') return value;
  }
  return '';
}

function readInstruction(node: SerializedInstruction): InstructionView {
  const parameters = Array.isArray(node.parameters) ? node.parameters.map((p) => String(p)) : [];
  return {
    type: readInstructionType(node.type),
    parameters,
    inverted: node.inverted === true,
    awaited: node.awaited === true,
  };
}

function readEvent(node: SerializedEvent): EventView {
  const rawType = asString(node.type);
  const kind = EVENT_KINDS[rawType] ?? rawType;
  const view: EventView = {
    id: asString(node.aiGeneratedEventId),
    kind,
    disabled: node.disabled === true,
    conditions: asArray(node.conditions).map(readInstruction),
    actions: asArray(node.actions).map(readInstruction),
    events: asArray(node.events).map(readEvent),
  };
  if (node.repeatExpression !== undefined) view.repeatExpression = String(node.repeatExpression);
  if (node.loopIndexVariable !== undefined) view.loopIndexVariable = asString(node.loopIndexVariable);
  if (node.whileConditions !== undefined) view.whileConditions = asArray(node.whileConditions).map(readInstruction);
  if (node.object !== undefined) view.object = asString(node.object);
  if (node.iterableVariableName !== undefined) view.iterableVariable = asString(node.iterableVariableName);
  if (node.keyIteratorVariableName !== undefined) view.keyIterator = asString(node.keyIteratorVariableName);
  if (node.valueIteratorVariableName !== undefined) view.valueIterator = asString(node.valueIteratorVariableName);
  if (node.name !== undefined) view.name = asString(node.name);
  if (node.source !== undefined) view.source = asString(node.source);
  if (node.comment !== undefined) view.comment = String(node.comment);
  if (node.target !== undefined) view.target = asString(node.target);
  if (node.inlineCode !== undefined) view.inlineCode = String(node.inlineCode);
  if (node.parameterObjects !== undefined) view.parameterObjects = asString(node.parameterObjects);
  return view;
}

function readScene(node: SerializedLayout): SceneView {
  return {
    name: asString(node.name),
    layers: asArray(node.layers).map((layer) => asString(layer?.name)),
    objects: asArray(node.objects).map(readObject),
    instances: asArray(node.instances).map(readInstance),
    variables: readVariables(node.variables),
    groups: asArray(node.objectsGroups).map(readGroup),
    events: asArray(node.events).map(readEvent),
  };
}

export function readContentView(project: SerializedProject): ContentView {
  const resourcesValue = project.resources;
  const resourceList = Array.isArray(resourcesValue)
    ? resourcesValue
    : (resourcesValue as { resources?: unknown } | undefined)?.resources;
  return {
    scenes: asArray(project.layouts).map(readScene),
    globalObjects: asArray(project.objects).map(readObject),
    globalVariables: readVariables(project.variables),
    globalGroups: asArray(project.objectsGroups).map(readGroup),
    resources: asArray(resourceList as { name?: unknown; kind?: unknown; file?: unknown }[]).map((resource) => ({
      name: asString(resource?.name),
      kind: asString(resource?.kind),
      file: asString(resource?.file),
    })),
  };
}
