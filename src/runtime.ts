import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpError } from './errors.js';
import {
  BLOCKING_DIAGNOSTIC_TYPES,
  type EngineDiagnostic,
  type EnginePorts,
  type EngineProject,
  type ProjectSummary,
} from './engine.js';

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
  getLayoutAt(index: number): {
    getObjects(): { getObjectsCount(): number; getObjectAt(index: number): { getAllBehaviorNames(): GdStringVector } };
    getEvents(): { getEventsCount(): number };
  };
  getVariables(): { count(): number };
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
      (project as GdProjectHandle).updateBehaviorsSharedData();
    },
    describeProject(project: EngineProject): ProjectSummary {
      const handle = project as GdProjectHandle;
      let objectCount = 0;
      let behaviorCount = 0;
      let eventCount = 0;
      const layoutCount = handle.getLayoutsCount();
      for (let i = 0; i < layoutCount; i++) {
        const layout = handle.getLayoutAt(i);
        const objects = layout.getObjects();
        const count = objects.getObjectsCount();
        objectCount += count;
        for (let j = 0; j < count; j++) {
          const names = objects.getObjectAt(j).getAllBehaviorNames();
          try {
            behaviorCount += names.size();
          } finally {
            names.delete();
          }
        }
        eventCount += layout.getEvents().getEventsCount();
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
  const shouldLoadExtensions = options.loadExtensions ?? process.env['GDEVELOP_LOAD_EXTENSIONS'] !== 'false';
  const gdjsRoot = options.gdjsRoot ?? process.env['GDEVELOP_GDJS_ROOT'];
  if (shouldLoadExtensions && gdjsRoot) loadJsExtensions(require, gd, gdjsRoot);
  return { gd, engine: createRealEngine(gd) };
}
