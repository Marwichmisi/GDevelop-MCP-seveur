import type { JsonValue } from './contentView.js';
import { validationFailed } from './errors.js';
import type {
  GdLayoutHandle,
  GdNamespace,
  GdObjectsContainer,
  GdProjectHandle,
  GdVariableHandle,
} from './runtime.js';

/**
 * Internes partagés des adapters moteur (chantier C1) : gardes répétés
 * (requireLayout, objectsContainer, checkObjectType/BehaviorType) et pont
 * JSON des variables. Utilisé par ≥2 familles ; jamais importé par
 * content.ts / events.ts / batch.ts (pas un seam, un détail d'adapter).
 */

export function clampPosition(position: number, count: number): number {
  if (!Number.isInteger(position)) throw validationFailed(`Position must be an integer, got: ${position}.`);
  return Math.min(Math.max(position, 0), count);
}

export function sceneNames(project: GdProjectHandle): string[] {
  const names: string[] = [];
  for (let i = 0; i < project.getLayoutsCount(); i++) names.push(project.getLayoutAt(i).getName());
  return names;
}

export function requireLayout(project: GdProjectHandle, scene: string): GdLayoutHandle {
  if (!project.hasLayoutNamed(scene)) {
    const known = sceneNames(project);
    throw validationFailed(
      `Unknown scene "${scene}".${known.length > 0 ? ` Known scenes: ${known.join(', ')}.` : ' The project has no scenes yet.'}`,
    );
  }
  return project.getLayout(scene);
}

export function objectsContainer(project: GdProjectHandle, scene: string | undefined): GdObjectsContainer {
  return scene === undefined ? project.getObjects() : requireLayout(project, scene).getObjects();
}

export function containerWhere(scene: string | undefined): string {
  return scene === undefined ? 'project' : `scene "${scene}"`;
}

export function checkObjectType(gd: GdNamespace, project: GdProjectHandle, type: string): void {
  const metadata = gd.MetadataProvider.getObjectMetadata(project.getCurrentPlatform(), type);
  if (gd.MetadataProvider.isBadObjectMetadata(metadata)) {
    throw validationFailed(`Unknown object type "${type}".`);
  }
}

export function checkBehaviorType(gd: GdNamespace, project: GdProjectHandle, type: string): void {
  const metadata = gd.MetadataProvider.getBehaviorMetadata(project.getCurrentPlatform(), type);
  if (gd.MetadataProvider.isBadBehaviorMetadata(metadata)) {
    throw validationFailed(`Unknown behavior type "${type}".`);
  }
}

/** Recursive free-JSON setter over a live variable (replaces any previous content). */
export function setVariableValue(variable: GdVariableHandle, name: string, value: JsonValue): void {
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
