import { validationFailed } from './errors.js';
import {
  shortBehaviorName,
  type AttachBehaviorInput,
  type CreateObjectInput,
  type EngineProject,
  type RemoveBehaviorInput,
  type SceneObjectPorts,
  type UpdateBehaviorInput,
} from './engine.js';
import {
  checkBehaviorType,
  checkObjectType,
  clampPosition,
  containerWhere,
  objectsContainer,
  requireLayout,
  setVariableValue,
} from './engineShared.js';
import type { GdBehaviorHandle, GdNamespace, GdProjectHandle } from './runtime.js';

/**
 * Famille (a) du chantier C1 : Scènes, calques, Objets, comportements.
 * Premier module extrait du monolithe createRealEngine ; les gardes partagés
 * vivent dans engineShared.ts, les helpers comportements ci-dessous sont
 * locaux (famille (a) seule). EnginePorts reste la façade composite.
 */

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

export function createSceneObjectPorts(gd: GdNamespace): SceneObjectPorts {
  return {
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
  };
}
