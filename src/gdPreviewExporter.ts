import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpError } from './errors.js';
import type { EngineProject } from './engine.js';
import type { PreviewExporter } from './preview.js';

/**
 * Real GDJS preview exporter over libGD.js (issue #16, research §1 + §3.1 + §6).
 *
 * Primary-source model: `982945902/gdevelop-mcp-server/src/node-file-system.js`
 * (`Object.assign(new gd.AbstractFileSystemJS(), implementation)`, forward-slash
 * paths) + `src/gdevelop-runtime.js#buildPreview` (7 `PreviewExportOptions`
 * flags, single-arg `exportProjectForPixiPreview(options)`, Draco sanitize).
 * Verified against the pinned `vendor/libGD.js` (friendly `Exporter`,
 * `PreviewExportOptions`, `AbstractFileSystemJS`, `VectorString.push_back`).
 */

interface GdLike {
  AbstractFileSystemJS: new () => Record<string, unknown> & { delete(): void };
  Exporter: new (fs: unknown, gdjsRoot: string) => {
    exportProjectForPixiPreview(options: unknown): boolean;
    getLastError(): string;
    delete(): void;
  };
  PreviewExportOptions: new (project: unknown, outDir: string) => Record<string, (...args: never[]) => unknown> & {
    delete(): void;
  };
  VectorString: new () => { push_back(value: string): void; delete(): void };
}

const isUrl = (value: string): boolean => /^https?:\/\//i.test(value);
const toPosix = (value: string): string => normalize(value).replace(/\\/g, '/');

function defaultGdjsRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'third-party', 'GDJS');
}

export function resolveGdjsRoot(): string {
  return process.env['GDEVELOP_GDJS_ROOT'] ?? defaultGdjsRoot();
}

/** JS implementation of the abstract WASM filesystem (forward-slash contract). */
export function createNodeFileSystem(gd: GdLike, tempDirectory: string): { handle: { delete(): void } } {
  const implementation = {
    mkDir(directory: string): boolean {
      if (isUrl(directory)) return true;
      mkdirSync(directory, { recursive: true });
      return true;
    },
    dirExists(directory: string): boolean {
      if (isUrl(directory)) return true;
      try {
        return statSync(directory).isDirectory();
      } catch {
        return false;
      }
    },
    clearDir(directory: string): boolean {
      rmSync(directory, { recursive: true, force: true });
      mkdirSync(directory, { recursive: true });
      return true;
    },
    getTempDir(): string {
      return tempDirectory || tmpdir();
    },
    fileNameFrom(fullPath: string): string {
      return isUrl(fullPath) ? fullPath : basename(fullPath);
    },
    dirNameFrom(fullPath: string): string {
      return isUrl(fullPath) ? fullPath : toPosix(dirname(fullPath));
    },
    makeAbsolute(filename: string, baseDirectory: string): string {
      if (isUrl(filename)) return filename;
      if (isUrl(baseDirectory)) return `${baseDirectory}/${filename}`;
      return toPosix(resolve(baseDirectory, filename));
    },
    makeRelative(filename: string, baseDirectory: string): string {
      if (isUrl(filename)) return filename;
      return toPosix(relative(baseDirectory, filename));
    },
    isAbsolute(fullPath: string): boolean {
      return isUrl(fullPath) || fullPath.length === 0 || isAbsolute(fullPath);
    },
    copyFile(source: string, destination: string): boolean {
      if (isUrl(source)) return true;
      mkdirSync(dirname(destination), { recursive: true });
      if (resolve(source) !== resolve(destination)) copyFileSync(source, destination);
      return true;
    },
    writeToFile(filename: string, contents: string): boolean {
      mkdirSync(dirname(filename), { recursive: true });
      writeFileSync(filename, contents);
      return true;
    },
    readFile(filename: string): string {
      return readFileSync(filename, 'utf8');
    },
    readDir(directory: string, extension = ''): unknown {
      const output = new gd.VectorString();
      if (!existsSync(directory)) return output;
      const wanted = extension.toUpperCase();
      for (const filename of readdirSync(directory)) {
        if (!wanted || filename.toUpperCase().endsWith(wanted)) {
          output.push_back(toPosix(join(directory, filename)));
        }
      }
      return output;
    },
    fileExists(filename: string): boolean {
      if (isUrl(filename)) return true;
      try {
        return statSync(filename).isFile();
      } catch {
        return false;
      }
    },
  };
  return { handle: Object.assign(new gd.AbstractFileSystemJS(), implementation) as { delete(): void } };
}

export class GdPreviewExporter implements PreviewExporter {
  constructor(
    private readonly gd: GdLike,
    private readonly gdjsRoot: string = resolveGdjsRoot(),
  ) {}

  async exportProject(project: EngineProject, outDir: string, sceneName: string): Promise<{ sanitizedDraco: boolean }> {
    if (!existsSync(join(this.gdjsRoot, 'Runtime'))) {
      throw new McpError(
        'preview-export-failed',
        `GDJS runtime not found at ${this.gdjsRoot}. Set GDEVELOP_GDJS_ROOT to a built GDJS tree.`,
      );
    }
    const { handle: fileSystem } = createNodeFileSystem(this.gd, outDir);
    const exporter = new this.gd.Exporter(fileSystem, resolve(this.gdjsRoot));
    const options = new this.gd.PreviewExportOptions(project, outDir);
    const call = (name: string, ...args: never[]): void => {
      const method = (options as Record<string, unknown>)[name];
      if (typeof method === 'function') (method as (...callArgs: never[]) => void).apply(options, args);
    };
    try {
      // Exact flag set of the reference buildPreview (research §6.1): layout
      // override, clean folder, fresh codegen, no full loading screen, dev env,
      // minimal debugger client (never the websocket one).
      call('setLayoutName', sceneName as never);
      call('setShouldClearExportFolder', true as never);
      call('setShouldReloadProjectData', true as never);
      call('setShouldReloadLibraries', true as never);
      call('setShouldGenerateScenesEventsCode', true as never);
      call('setFullLoadingScreen', false as never);
      call('setIsDevelopmentEnvironment', true as never);
      call('useMinimalDebuggerClient', undefined as never);
      let succeeded = false;
      try {
        succeeded = exporter.exportProjectForPixiPreview(options);
      } catch (error) {
        throw new McpError('preview-export-failed', `GDJS preview export threw: ${error instanceof Error ? error.message : String(error)}.`, {
          cause: error,
        });
      }
      if (!succeeded) {
        let detail = '';
        try {
          detail = exporter.getLastError() ?? '';
        } catch {
          detail = '';
        }
        throw new McpError('preview-export-failed', `GDJS preview export failed${detail ? `: ${detail}` : '.'}`);
      }
      // Draco fix (research §6.2): some artifact combos list the raw Draco
      // wasm as a script include — it must load via DRACOLoader, never as JS.
      const indexFile = join(outDir, 'index.html');
      const html = readFileSync(indexFile, 'utf8');
      const sanitized = html.replace(/^\s*<script[^>]+src=["'][^"']+\.wasm["'][^>]*><\/script>\s*$/gm, '');
      if (sanitized !== html) writeFileSync(indexFile, sanitized);
      return { sanitizedDraco: sanitized !== html };
    } finally {
      for (const handle of [options, exporter, fileSystem] as { delete(): void }[]) {
        try {
          handle.delete();
        } catch {
          // Best effort: WASM handles must not break the export result.
        }
      }
    }
  }
}
