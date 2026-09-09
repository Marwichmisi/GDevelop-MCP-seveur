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

export interface SerializedLayout {
  name?: unknown;
  layers?: { name?: unknown }[] | undefined;
  objects?: SerializedObject[] | undefined;
  instances?: SerializedInstance[] | undefined;
  variables?: SerializedVariable[] | undefined;
  objectsGroups?: SerializedGroup[] | undefined;
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

export interface SceneView {
  name: string;
  layers: string[];
  objects: ObjectView[];
  instances: InstanceView[];
  variables: Record<string, JsonValue>;
  groups: GroupView[];
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

function readScene(node: SerializedLayout): SceneView {
  return {
    name: asString(node.name),
    layers: asArray(node.layers).map((layer) => asString(layer?.name)),
    objects: asArray(node.objects).map(readObject),
    instances: asArray(node.instances).map(readInstance),
    variables: readVariables(node.variables),
    groups: asArray(node.objectsGroups).map(readGroup),
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
