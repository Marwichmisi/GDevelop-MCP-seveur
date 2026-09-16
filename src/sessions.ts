import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { McpError, unknownSession } from './errors.js';
import type { EnginePorts, EngineProject } from './engine.js';
import {
  MAX_UNSPLIT_DEPTH,
  REFERENCE_MAGIC_PROPERTY,
  containsSplitReference,
  isFolderProjectJson,
  unsplitSync,
} from './folderProject.js';

/** A project session: a `gd.Project` living in memory, isolated until an explicit save. */
export interface Session {
  id: string;
  project: EngineProject;
  filePath: string | null;
  dirty: boolean;
  /** Copie disque `-pre-restore` (état pré-save) pour undo_last_edit one-shot. */
  preRestorePath: string | null;
  /** Session lecture (exemple) : describe seul, save et mutations refusés. */
  readOnly: boolean;
  /** Stratégie disque : `single` (mono-fichier) ou `folder` (dossier éclaté). */
  kind: 'single' | 'folder';
}

export interface ProjectStoreOptions {
  /** When set, project files must live under this root. */
  allowedRoot?: string;
}

/**
 * In-memory session registry (`Map<uuid, session>`). Owns the dirty/force
 * lifecycle; the engine port owns (de)serialization.
 */
export class ProjectStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly engine: EnginePorts,
    private readonly options: ProjectStoreOptions = {},
  ) {}

  create(name: string): Session {
    const project = this.engine.createProject(name);
    const kind = this.engine.isFolderProject(project) ? 'folder' : 'single';
    const session: Session = { id: randomUUID(), project, filePath: null, dirty: false, preRestorePath: null, readOnly: false, kind };
    this.sessions.set(session.id, session);
    return session;
  }

  open(path: string): Session {
    const absolute = this.resolvePath(path);
    let stat;
    try {
      stat = statSync(absolute);
    } catch (error) {
      throw new McpError('io-error', `Cannot open project at ${absolute}: file not found.`, { cause: error });
    }
    let main: string;
    if (stat.isDirectory()) {
      main = join(absolute, 'game.json');
      try {
        statSync(main);
      } catch (error) {
        throw new McpError('project-load-failed', `Folder-project at ${absolute} has no game.json.`, { cause: error });
      }
      // Containment déjà garantie par resolvePath sur le dossier ; re-valider le main.
      this.resolvePath(main);
    } else {
      main = absolute;
    }
    let raw: string;
    try {
      raw = readFileSync(main, 'utf8');
    } catch (error) {
      throw new McpError('io-error', `Cannot read project file at ${main}.`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new McpError('project-load-failed', 'Project file is not valid JSON.', { cause: error });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new McpError('project-load-failed', 'Project file does not contain a project object.');
    }
    const folder = isFolderProjectJson(parsed) || containsSplitReference(parsed);
    if (!folder) {
      const project = this.engine.loadProjectFromJson(raw, main);
      try {
        this.engine.loadEventsFunctionsExtensions(project);
      } catch (error) {
        try {
          project.delete();
        } catch {
          // Best effort.
        }
        throw new McpError('project-load-failed', `Project at ${main}: events-functions extensions failed to load.`, {
          cause: error,
        });
      }
      const session: Session = { id: randomUUID(), project, filePath: main, dirty: false, preRestorePath: null, readOnly: false, kind: 'single' };
      this.sessions.set(session.id, session);
      return session;
    }
    const dir = dirname(main);
    const doc = parsed as Record<string, unknown>;
    const properties = (doc['properties'] as Record<string, unknown> | undefined) ?? {};
    doc['properties'] = { ...properties, projectFile: main };
    try {
      unsplitSync(doc, {
        isReferenceMagicPropertyName: REFERENCE_MAGIC_PROPERTY,
        maxUnsplitDepth: MAX_UNSPLIT_DEPTH,
        getReferencePartialObjectSync: (reference: string) => {
          if (reference.includes('..')) {
            throw new Error(`Invalid reference ${reference}`);
          }
          const partialPath = join(dir, reference) + '.json';
          const resolved = resolve(partialPath);
          if (!resolved.startsWith(resolve(dir))) {
            throw new Error(`Reference escapes project folder: ${reference}`);
          }
          const text = readFileSync(resolved, 'utf8');
          return JSON.parse(text) as unknown;
        },
      });
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(
        'project-load-failed',
        `Folder-project at ${main} could not be loaded: ${(error as Error).message}`,
        { cause: error },
      );
    }
    let project: EngineProject;
    try {
      project = this.engine.loadProjectFromJson(JSON.stringify(doc), main);
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError('project-load-failed', `Folder-project at ${main} could not be loaded by the engine.`, {
        cause: error,
      });
    }
    try {
      this.engine.loadEventsFunctionsExtensions(project);
    } catch (error) {
      try {
        project.delete();
      } catch {
        // Best effort.
      }
      throw new McpError('project-load-failed', `Folder-project at ${main}: events-functions extensions failed to load.`, {
        cause: error,
      });
    }
    const session: Session = { id: randomUUID(), project, filePath: main, dirty: false, preRestorePath: null, readOnly: false, kind: 'folder' };
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Ouvre un projet déjà parsé (JSON example) en session lecture :
   * dirty jamais marqué, save refusé, mutations refusées par le pipeline.
   */
  openFromJson(json: string, label: string): Session {
    const project = this.engine.loadProjectFromJson(json, label);
    const session: Session = { id: randomUUID(), project, filePath: null, dirty: false, preRestorePath: null, readOnly: true, kind: 'single' };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw unknownSession(id);
    return session;
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  markDirty(id: string): void {
    this.get(id).dirty = true;
  }

  setFilePath(id: string, path: string): void {
    this.get(id).filePath = path;
  }

  setKind(id: string, kind: 'single' | 'folder'): void {
    this.get(id).kind = kind;
  }

  clearDirty(id: string): void {
    this.get(id).dirty = false;
  }

  setPreRestore(id: string, path: string | null): void {
    this.get(id).preRestorePath = path;
  }

  consumePreRestore(id: string): string {
    const session = this.get(id);
    const path = session.preRestorePath;
    if (!path) {
      throw new McpError(
        'validation-failed',
        `No undo available for session ${id}: save the session first, then undo once per save.`,
      );
    }
    session.preRestorePath = null;
    return path;
  }

  close(id: string, options: { force?: boolean | undefined } = {}): void {
    const session = this.get(id);
    if (session.dirty && options.force !== true) {
      throw new McpError(
        'session-dirty',
        `Session ${id} has unsaved changes. Save it first or close with force:true to discard them.`,
      );
    }
    this.sessions.delete(id);
    try {
      this.engine.unloadEventsFunctionsExtensions(session.project);
    } catch {
      // Best effort : le registre JsPlatform est global, un unload raté ne doit pas bloquer le close.
    }
    session.project.delete();
  }

  /** Absolute-path policy shared by open and save: absolute, no null bytes, inside allowedRoot. */
  resolvePath(input: string): string {
    if (input.includes('\0')) {
      throw new McpError('path-not-allowed', 'Project paths must not contain null bytes.');
    }
    if (!isAbsolute(input)) {
      throw new McpError('path-not-allowed', `Project path must be absolute, got: ${input}`);
    }
    const resolved = resolve(input);
    if (this.options.allowedRoot !== undefined && !resolved.startsWith(resolve(this.options.allowedRoot))) {
      throw new McpError('path-not-allowed', `Project path escapes the allowed root: ${input}`);
    }
    return resolved;
  }
}
