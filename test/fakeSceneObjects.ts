import type {
  AttachBehaviorInput,
  CreateObjectInput,
  EngineProject,
  RemoveBehaviorInput,
  SceneObjectPorts,
  UpdateBehaviorInput,
} from '../src/engine.js';
import {
  attachBehavior,
  createLayer,
  createObject,
  createScene,
  deleteLayer,
  deleteObject,
  deleteScene,
  moveLayer,
  moveScene,
  removeBehavior,
  renameLayer,
  renameObject,
  renameScene,
  updateBehavior,
} from './fakeContent.js';
import type { FakeProject } from './fakeEngine.js';

/**
 * Fake famille (a) du chantier C1 : Scènes, calques, Objets, comportements.
 * Second adapter au même seam (le réel vit dans src/sceneObjects.ts).
 * Assemblé en façade dans createFakeEngine ; les tests existants ne changent pas.
 */
export function createFakeSceneObjectPorts(): SceneObjectPorts {
  return {
    createScene(project: EngineProject, name: string): void {
      createScene((project as FakeProject).state, name);
    },
    renameScene(project: EngineProject, oldName: string, newName: string): void {
      renameScene((project as FakeProject).state, oldName, newName);
    },
    moveScene(project: EngineProject, name: string, position: number): void {
      moveScene((project as FakeProject).state, name, position);
    },
    deleteScene(project: EngineProject, name: string): void {
      deleteScene((project as FakeProject).state, name);
    },
    createLayer(project: EngineProject, scene: string, name: string): void {
      createLayer((project as FakeProject).state, scene, name);
    },
    renameLayer(project: EngineProject, scene: string, oldName: string, newName: string): void {
      renameLayer((project as FakeProject).state, scene, oldName, newName);
    },
    moveLayer(project: EngineProject, scene: string, name: string, position: number): void {
      moveLayer((project as FakeProject).state, scene, name, position);
    },
    deleteLayer(project: EngineProject, scene: string, name: string): void {
      deleteLayer((project as FakeProject).state, scene, name);
    },
    createObject(project: EngineProject, input: CreateObjectInput): void {
      createObject((project as FakeProject).state, input);
    },
    renameObject(project: EngineProject, scene: string | undefined, oldName: string, newName: string): void {
      renameObject((project as FakeProject).state, scene, oldName, newName);
    },
    deleteObject(project: EngineProject, scene: string | undefined, name: string): void {
      deleteObject((project as FakeProject).state, scene, name);
    },
    attachBehavior(project: EngineProject, input: AttachBehaviorInput): { name: string } {
      return attachBehavior((project as FakeProject).state, input);
    },
    updateBehavior(project: EngineProject, input: UpdateBehaviorInput): void {
      updateBehavior((project as FakeProject).state, input);
    },
    removeBehavior(project: EngineProject, input: RemoveBehaviorInput): void {
      removeBehavior((project as FakeProject).state, input);
    },
  };
}
