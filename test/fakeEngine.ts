import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { McpError } from '../src/errors.js';
import type { EngineDiagnostic, EnginePorts, EngineProject, ProjectSummary } from '../src/engine.js';

/** In-memory fake of a gd.Project: state survives serialize/restore as JSON. */
export class FakeProject implements EngineProject {
  state: Record<string, unknown>;
  deleted = false;
  failSerialize = false;

  constructor(state: Record<string, unknown> = {}) {
    this.state = structuredClone(state);
  }

  delete(): void {
    this.deleted = true;
  }
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
      const project = new FakeProject({ name, layouts: [] });
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
      const project = new FakeProject(parsed as Record<string, unknown>);
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
      fake.state = JSON.parse(snapshot) as Record<string, unknown>;
    },
    listDiagnostics(_project: EngineProject): EngineDiagnostic[] {
      return [...engine.diagnostics];
    },
    updateBehaviorsSharedData(_project: EngineProject): void {},
    describeProject(project: EngineProject): ProjectSummary {
      const fake = project as FakeProject;
      const layouts = Array.isArray(fake.state['layouts']) ? fake.state['layouts'] : [];
      return {
        name: typeof fake.state['name'] === 'string' ? (fake.state['name'] as string) : '',
        projectFile: typeof fake.state['projectFile'] === 'string' ? (fake.state['projectFile'] as string) : '',
        layoutCount: layouts.length,
        objectCount: 0,
        behaviorCount: 0,
        globalVariableCount: 0,
        eventCount: 0,
      };
    },
    setProjectName(project: EngineProject, name: string): void {
      (project as FakeProject).state['name'] = name;
    },
    setProjectFile(project: EngineProject, path: string): void {
      (project as FakeProject).state['projectFile'] = path;
    },
  };
  return engine;
}

describe('fake engine doubles', () => {
  it('round-trips state through serialize/restore', () => {
    const engine = createFakeEngine();
    const project = engine.createProject('Blank');
    const snapshot = engine.serializeProject(project);
    (project as FakeProject).state['name'] = 'Mutated';
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
