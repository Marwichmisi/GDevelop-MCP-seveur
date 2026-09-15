import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { McpError, unknownSession } from './errors.js';
import type { EnginePorts, EngineProject } from './engine.js';

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
    const session: Session = { id: randomUUID(), project, filePath: null, dirty: false, preRestorePath: null, readOnly: false };
    this.sessions.set(session.id, session);
    return session;
  }

  open(path: string): Session {
    const absolute = this.resolvePath(path);    let stat;
    try {
      stat = statSync(absolute);
    } catch (error) {
      throw new McpError('io-error', `Cannot open project at ${absolute}: file not found.`, { cause: error });
    }
    if (stat.isDirectory()) {
      throw new McpError(
        'folder-project-unsupported',
        `Folder-project at ${absolute} is not supported yet (single-file .json only). It was left untouched.`,
      );
    }
    let json: string;
    try {
      json = readFileSync(absolute, 'utf8');
    } catch (error) {
      throw new McpError('io-error', `Cannot read project file at ${absolute}.`, { cause: error });
    }
    const project = this.engine.loadProjectFromJson(json, absolute);
    const session: Session = { id: randomUUID(), project, filePath: absolute, dirty: false, preRestorePath: null, readOnly: false };
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Ouvre un projet déjà parsé (JSON example) en session lecture :
   * dirty jamais marqué, save refusé, mutations refusées par le pipeline.
   */
  openFromJson(json: string, label: string): Session {
    const project = this.engine.loadProjectFromJson(json, label);
    const session: Session = { id: randomUUID(), project, filePath: null, dirty: false, preRestorePath: null, readOnly: true };
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
