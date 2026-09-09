import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { McpError } from '../src/errors.js';
import type {
  AppendEventsInput,
  AppendEventsResult,
  AttachBehaviorInput,
  CreateObjectInput,
  EngineDiagnostic,
  EnginePorts,
  EngineProject,
  EventNodeInput,
  ImportResourceInput,
  MoveEventInput,
  PlaceInstanceInput,
  ProjectSummary,
  RemoveBehaviorInput,
  RemoveEventInput,
  UpdateBehaviorInput,
  UpdateInstancePatch,
  VariableTarget,
} from '../src/engine.js';
import type { ContentView, JsonValue } from '../src/contentView.js';
import {
  addObjectToGroup,
  appendSceneEvents,
  attachBehavior,
  blankContentState,
  createGroup,
  createLayer,
  createObject,
  createScene,
  deleteGroup,
  deleteLayer,
  deleteObject,
  deleteScene,
  describeContentState,
  importResource,
  moveInstancesToLayer,
  moveLayer,
  moveScene,
  moveSceneEvent,
  placeInstance,
  removeBehavior,
  removeInstance,
  removeInstancesOfObject,
  removeObjectFromGroup,
  removeResource,
  removeSceneEvent,
  removeVariable,
  renameLayer,
  renameObject,
  renameScene,
  renameVariable,
  setVariable,
  updateBehavior,
  updateInstance,
  validateSceneEvents,
  type FakeContentState,
} from './fakeContent.js';

/** In-memory fake of a gd.Project: state survives serialize/restore as JSON. */
export class FakeProject implements EngineProject {
  state: FakeContentState;
  deleted = false;
  failSerialize = false;

  constructor(state: FakeContentState = blankContentState('')) {
    this.state = structuredClone(state);
  }

  delete(): void {
    this.deleted = true;
  }
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function normalizeState(parsed: Record<string, unknown>, name: string): FakeContentState {
  // Foreign files (saved by the real engine) carry extra keys and a nested
  // resources container; only the content-view shape is kept.
  const rawResources = parsed['resources'];
  const resources = Array.isArray(rawResources)
    ? rawResources
    : (rawResources as { resources?: unknown } | null)?.resources;
  const layouts = asArray(parsed['layouts']) as unknown as FakeContentState['layouts'];
  for (const layout of layouts) {
    if (!Array.isArray((layout as { events?: unknown }).events)) {
      (layout as { events: unknown }).events = [];
    }
  }
  return {
    name: typeof parsed['name'] === 'string' ? (parsed['name'] as string) : name,
    projectFile: typeof parsed['projectFile'] === 'string' ? (parsed['projectFile'] as string) : '',
    layouts,
    objects: asArray(parsed['objects']) as unknown as FakeContentState['objects'],
    variables: asArray(parsed['variables']) as unknown as FakeContentState['variables'],
    objectsGroups: asArray(parsed['objectsGroups']) as unknown as FakeContentState['objectsGroups'],
    resources: (Array.isArray(resources) ? resources : []) as unknown as FakeContentState['resources'],
  };
}

export interface FakeEngineOptions {
  /** Diagnostics present from the start (baseline). Mutable via `engine.diagnostics`. */
  initialDiagnostics?: EngineDiagnostic[];
}

/** Fake EnginePorts: deterministic, no WASM. Tests mutate `engine.diagnostics`
 *  inside `apply` to simulate post-mutation validation findings. */
export function createFakeEngine(
  options: FakeEngineOptions = {},
): EnginePorts & { projects: FakeProject[]; diagnostics: EngineDiagnostic[] } {
  const projects: FakeProject[] = [];
  const engine: EnginePorts & { projects: FakeProject[]; diagnostics: EngineDiagnostic[] } = {
    projects,
    diagnostics: [...(options.initialDiagnostics ?? [])],
    createProject(name: string): EngineProject {
      const project = new FakeProject(blankContentState(name));
      projects.push(project);
      return project;
    },
    loadProjectFromJson(json: string, _projectFile: string): EngineProject {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        throw new McpError('project-load-failed', 'Project file is not valid JSON.');
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new McpError('project-load-failed', 'Project file does not contain a project object.');
      }
      const project = new FakeProject(normalizeState(parsed as Record<string, unknown>, ''));
      projects.push(project);
      return project;
    },
    serializeProject(project: EngineProject): string {
      const fake = project as FakeProject;
      if (fake.failSerialize) throw new McpError('io-error', 'Fake serialization failure.');
      return JSON.stringify(fake.state);
    },
    restoreProject(project: EngineProject, snapshot: string): void {
      const fake = project as FakeProject;
      fake.state = JSON.parse(snapshot) as FakeContentState;
    },
    listDiagnostics(_project: EngineProject): EngineDiagnostic[] {
      return [...engine.diagnostics];
    },
    updateBehaviorsSharedData(_project: EngineProject): void {},
    describeProject(project: EngineProject): ProjectSummary {
      const state = (project as FakeProject).state;
      let objectCount = state.objects.length;
      let behaviorCount = 0;
      let eventCount = 0;
      for (const object of state.objects) behaviorCount += object.behaviors.length;
      for (const layout of state.layouts) {
        objectCount += layout.objects.length;
        for (const object of layout.objects) behaviorCount += object.behaviors.length;
        eventCount += (layout.events ?? []).length;
      }
      return {
        name: state.name,
        projectFile: state.projectFile,
        layoutCount: state.layouts.length,
        objectCount,
        behaviorCount,
        globalVariableCount: state.variables.length,
        eventCount,
      };
    },
    describeContent(project: EngineProject): ContentView {
      return describeContentState((project as FakeProject).state);
    },
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
    placeInstance(project: EngineProject, input: PlaceInstanceInput): { instanceId: string } {
      return placeInstance((project as FakeProject).state, input);
    },
    updateInstance(project: EngineProject, scene: string, instanceId: string, patch: UpdateInstancePatch): void {
      updateInstance((project as FakeProject).state, scene, instanceId, patch);
    },
    removeInstance(project: EngineProject, scene: string, instanceId: string): void {
      removeInstance((project as FakeProject).state, scene, instanceId);
    },
    removeInstancesOfObject(project: EngineProject, scene: string, object: string): { removed: number } {
      return removeInstancesOfObject((project as FakeProject).state, scene, object);
    },
    moveInstancesToLayer(
      project: EngineProject,
      scene: string,
      sourceLayer: string,
      targetLayer: string,
    ): { moved: number } {
      return moveInstancesToLayer((project as FakeProject).state, scene, sourceLayer, targetLayer);
    },
    setVariable(project: EngineProject, target: VariableTarget, name: string, value: JsonValue): void {
      setVariable((project as FakeProject).state, target, name, value);
    },
    removeVariable(project: EngineProject, target: VariableTarget, name: string): void {
      removeVariable((project as FakeProject).state, target, name);
    },
    renameVariable(project: EngineProject, target: VariableTarget, oldName: string, newName: string): void {
      renameVariable((project as FakeProject).state, target, oldName, newName);
    },
    createGroup(project: EngineProject, scene: string | undefined, name: string, objects: string[]): void {
      createGroup((project as FakeProject).state, scene, name, objects);
    },
    deleteGroup(project: EngineProject, scene: string | undefined, name: string): void {
      deleteGroup((project as FakeProject).state, scene, name);
    },
    addObjectToGroup(project: EngineProject, scene: string | undefined, group: string, object: string): void {
      addObjectToGroup((project as FakeProject).state, scene, group, object);
    },
    removeObjectFromGroup(project: EngineProject, scene: string | undefined, group: string, object: string): void {
      removeObjectFromGroup((project as FakeProject).state, scene, group, object);
    },
    importResource(project: EngineProject, input: ImportResourceInput): { name: string } {
      return importResource((project as FakeProject).state, input);
    },
    removeResource(project: EngineProject, name: string): void {
      removeResource((project as FakeProject).state, name);
    },
    appendSceneEvents(project: EngineProject, input: AppendEventsInput): AppendEventsResult {
      return appendSceneEvents((project as FakeProject).state, input);
    },
    moveSceneEvent(project: EngineProject, input: MoveEventInput): { moved: boolean; dryRun: boolean } {
      return moveSceneEvent((project as FakeProject).state, input);
    },
    removeSceneEvent(project: EngineProject, input: RemoveEventInput): { removed: boolean; dryRun: boolean } {
      return removeSceneEvent((project as FakeProject).state, input);
    },
    validateSceneEvents(
      project: EngineProject,
      scene: string,
      events: EventNodeInput[],
    ): { valid: boolean; errors: string[] } {
      return validateSceneEvents((project as FakeProject).state, scene, events);
    },
    setProjectName(project: EngineProject, name: string): void {
      (project as FakeProject).state.name = name;
    },
    setProjectFile(project: EngineProject, path: string): void {
      (project as FakeProject).state.projectFile = path;
    },
  };
  return engine;
}

describe('fake engine doubles', () => {
  it('round-trips state through serialize/restore', () => {
    const engine = createFakeEngine();
    const project = engine.createProject('Blank');
    const snapshot = engine.serializeProject(project);
    (project as FakeProject).state.name = 'Mutated';
    engine.restoreProject(project, snapshot);
    assert.equal(engine.describeProject(project).name, 'Blank');
  });

  it('rejects non-JSON input on load', () => {
    const engine = createFakeEngine();
    assert.throws(() => engine.loadProjectFromJson('not json', '/tmp/x.json'), (error: unknown) => {
      return error instanceof McpError && error.code === 'project-load-failed';
    });
  });

  it('exposes the zod schema helper used by command tests', () => {
    assert.equal(typeof z.string, 'function');
  });
});
