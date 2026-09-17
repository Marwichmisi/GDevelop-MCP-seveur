import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/sessions.js';
import { createContentTools, createPreviewTools, createProjectTools, type ToolDefinition } from '../src/tools.js';
import {
  PreviewManager,
  sanitizeDracoScriptIncludes,
  type PreviewBrowser,
  type PreviewExporter,
} from '../src/preview.js';
import type { EngineProject } from '../src/engine.js';
import { createFakeEngine } from './fakeEngine.js';

/**
 * 1.1 #34 : build_preview écrit hors du fichier projet (assets/, .autosave).
 *
 * Relevé en #27 (validation #26) : build_preview sur Session projet sauvée
 * -> validation-mini-collector/assets/{Coin,Player_TopDown}.png +
 * game.json.autosave créés ; game.json intact (assertUntouched ne couvre
 * que le fichier). Attendu : export purement mémoire+tmp.
 *
 * Seam convenu #20 : surface MCP des tools + seams publics du
 * PreviewManager (exporter injecté). L'absence d'effets disque hors dossier
 * temporaire s'observe au FS du test (c'est l'objet même du contrat,
 * comme preview.test.ts relit déjà le fichier projet).
 */

function handler(
  tools: ToolDefinition[],
  name: string,
): (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[] }> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `tool ${name} enregistré`);
  return tool.handler;
}

function parseText(result: { content: { type: 'text'; text: string }[] }): unknown {
  const first = result.content[0];
  assert.ok(first && first.type === 'text');
  return JSON.parse((first as { text: string }).text) as unknown;
}

/** Exporte index.html dans outDir uniquement : le comportement attendu. */
class StubExporter implements PreviewExporter {
  async exportProject(_project: EngineProject, outDir: string, sceneName: string): Promise<{ sanitizedDraco: boolean }> {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(outDir, { recursive: true });
    const raw = `<html><head><script src="draco_decoder.wasm.js"></script></head><body>${sceneName}</body></html>`;
    const { html, sanitized } = sanitizeDracoScriptIncludes(raw);
    await writeFile(join(outDir, 'index.html'), html, 'utf8');
    return { sanitizedDraco: sanitized };
  }
}

/**
 * Repro exacte de l'issue : export réussi mais fuyard — écrit des
 * ressources + un autosave à côté du projet, hors outDir (contourne même
 * le système de fichiers injecté, pire cas : version libGD qui écrirait
 * près du projectFile).
 */
class LeakyExporter implements PreviewExporter {
  constructor(private readonly projectDir: string) {}
  async exportProject(_project: EngineProject, outDir: string, sceneName: string): Promise<{ sanitizedDraco: boolean }> {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(this.projectDir, 'assets'), { recursive: true });
    await writeFile(join(this.projectDir, 'assets', 'Coin.png'), 'PNG-fuyard', 'utf8');
    await writeFile(join(this.projectDir, 'game.json.autosave'), '{"fuite":true}', 'utf8');
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'index.html'), `<html>${sceneName}</html>`, 'utf8');
    return { sanitizedDraco: false };
  }
}

class FakeBrowser implements PreviewBrowser {
  async capture(): Promise<{ logs: string[]; pageErrors: string[]; screenshotPath: string | null }> {
    return { logs: ['[log] booted'], pageErrors: [], screenshotPath: null };
  }
}

/** Snapshot du dossier projet : chemins relatifs -> taille + mtime. */
function snapshotDir(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        found.set(`${rel}/`, 'dir');
        walk(full, rel);
      } else {
        const stat = statSync(full);
        found.set(rel, `file:${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  walk(dir, '');
  return found;
}

describe('1.1 #34 : build_preview purement mémoire+tmp (seam tools MCP)', () => {
  let dirs: string[] = [];
  let managers: PreviewManager[] = [];

  beforeEach(() => {
    dirs = [];
    managers = [];
  });

  afterEach(async () => {
    for (const manager of managers) await manager.closeAll().catch(() => undefined);
    const { rm } = await import('node:fs/promises');
    for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('build_preview sur Session projet sauvée ne crée ni dossier ni fichier à côté du projet', async () => {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    const deps = { store, engine };
    const tmpRoot = mkdtempSync(join(tmpdir(), 'gd-preview34-'));
    dirs.push(tmpRoot);
    const manager = new PreviewManager(deps as never, { tmpRoot, exporter: new StubExporter(), browser: new FakeBrowser() });
    managers.push(manager);
    const tools = [...createProjectTools(deps), ...createContentTools(deps), ...createPreviewTools(manager)];
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
      parseText(await handler(tools, name)(args));

    const created = (await call('create_project', { name: 'Disque34' })) as { sessionId: string };
    const sessionId = created.sessionId;
    await call('create_scene', { sessionId, name: 'Niveau1' });
    const projectDir = mkdtempSync(join(tmpdir(), 'gd-proj34-'));
    dirs.push(projectDir);
    const file = join(projectDir, 'game.json');
    await call('save_project', { sessionId, path: file });
    const contentBefore = readFileSync(file, 'utf8');
    const dirBefore = snapshotDir(projectDir);

    const built = (await call('build_preview', { sessionId, scene: 'Niveau1' })) as { url: string };
    assert.match(built.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.deepEqual(snapshotDir(projectDir), dirBefore);
    assert.equal(readFileSync(file, 'utf8'), contentBefore);
  });

  it('un exporter fuyard (assets/ + .autosave hors tmp) fait refuser le build et laisse le dossier propre', async () => {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    const deps = { store, engine };
    const projectDir = mkdtempSync(join(tmpdir(), 'gd-proj34-leak-'));
    dirs.push(projectDir);
    const tmpRoot = mkdtempSync(join(tmpdir(), 'gd-preview34-'));
    dirs.push(tmpRoot);
    const manager = new PreviewManager(deps as never, {
      tmpRoot,
      exporter: new LeakyExporter(projectDir),
      browser: new FakeBrowser(),
    });
    managers.push(manager);
    const tools = [...createProjectTools(deps), ...createContentTools(deps), ...createPreviewTools(manager)];
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
      parseText(await handler(tools, name)(args));

    const created = (await call('create_project', { name: 'Fuite34' })) as { sessionId: string };
    const sessionId = created.sessionId;
    await call('create_scene', { sessionId, name: 'Niveau1' });
    const file = join(projectDir, 'game.json');
    await call('save_project', { sessionId, path: file });
    const contentBefore = readFileSync(file, 'utf8');
    const dirBefore = snapshotDir(projectDir);

    await assert.rejects(call('build_preview', { sessionId, scene: 'Niveau1' }), (error: unknown) => {
      return error instanceof Error && /hors du dossier temporaire|outside|fuite|intouché|untouched|tmp/i.test(error.message);
    });
    // Le garde-fou nettoie les intrus : le dossier retrouve son état, le fichier est bit-identique.
    assert.deepEqual(snapshotDir(projectDir), dirBefore);
    assert.equal(readFileSync(file, 'utf8'), contentBefore);
  });

  it('le dossier d\'export légitime dans le projet (tmpRoot: dir) n\'est pas une fuite, le reste reste gelé', async () => {
    const engine = createFakeEngine();
    const store = new ProjectStore(engine);
    const deps = { store, engine };
    const projectDir = mkdtempSync(join(tmpdir(), 'gd-proj34-tmp-'));
    dirs.push(projectDir);
    // tmpRoot DANS le dossier projet, comme les suites existantes : seul
    // outDir/preview-* est exclu du gel, pas le reste.
    const manager = new PreviewManager(deps as never, {
      tmpRoot: projectDir,
      exporter: new LeakyExporter(projectDir),
      browser: new FakeBrowser(),
    });
    managers.push(manager);
    const tools = [...createProjectTools(deps), ...createContentTools(deps), ...createPreviewTools(manager)];
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
      parseText(await handler(tools, name)(args));

    const created = (await call('create_project', { name: 'Tmp34' })) as { sessionId: string };
    const sessionId = created.sessionId;
    await call('create_scene', { sessionId, name: 'Niveau1' });
    const file = join(projectDir, 'game.json');
    await call('save_project', { sessionId, path: file });
    const contentBefore = readFileSync(file, 'utf8');

    await assert.rejects(call('build_preview', { sessionId, scene: 'Niveau1' }), (error: unknown) => {
      if (!(error instanceof Error)) return false;
      // La fuite est signalée (assets/, .autosave), pas l'export légitime (preview-*/).
      return /outside its tmp folder/.test(error.message) && !/preview-[^/]*\//.test(error.message);
    });
    const remaining = [...snapshotDir(projectDir).keys()].filter((rel) => !rel.startsWith('preview-'));
    assert.deepEqual(remaining, ['game.json']);
    assert.equal(readFileSync(file, 'utf8'), contentBefore);
  });
});

describe('1.1 #34 : système de fichiers injecté confiné au dossier temporaire', () => {
  let dirs: string[] = [];

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    dirs = [];
  });

  it('refuse les écritures hors dossier temporaire sans rien créer, autorise lectures et écritures dedans', async () => {
    const { createNodeFileSystem } = await import('../src/gdPreviewExporter.js');
    class FakeAbstractFs {
      delete(): void {}
    }
    class FakeVectorString {
      private readonly items: string[] = [];
      push_back(value: string): void {
        this.items.push(value);
      }
      delete(): void {}
    }
    const outDir = mkdtempSync(join(tmpdir(), 'gd-fs-out-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'gd-fs-proj-'));
    dirs.push(outDir, projectDir);
    writeFileSync(join(projectDir, 'game.json'), '{"nom":"Faux"}', 'utf8');
    const { handle } = createNodeFileSystem(
      { AbstractFileSystemJS: FakeAbstractFs, VectorString: FakeVectorString } as never,
      outDir,
      { allowedWriteDirs: [outDir] },
    );
    const fs = handle as unknown as Record<string, (...args: string[]) => boolean | string | unknown>;

    // Écritures dans le dossier temporaire : autorisées.
    assert.equal(fs['writeToFile']?.(join(outDir, 'index.html'), '<html></html>'), true);
    assert.equal(readFileSync(join(outDir, 'index.html'), 'utf8'), '<html></html>');
    assert.equal(fs['mkDir']?.(join(outDir, 'sous')), true);

    // Lectures hors dossier temporaire : autorisées (ressources projet, runtime GDJS).
    assert.equal(fs['readFile']?.(join(projectDir, 'game.json')), '{"nom":"Faux"}');
    assert.equal(fs['fileExists']?.(join(projectDir, 'game.json')), true);
    assert.equal(fs['dirExists']?.(projectDir), true);

    // Copie depuis le dossier projet vers le temporaire : autorisée.
    assert.equal(fs['copyFile']?.(join(projectDir, 'game.json'), join(outDir, 'copie.json')), true);
    assert.equal(readFileSync(join(outDir, 'copie.json'), 'utf8'), '{"nom":"Faux"}');

    // Écritures hors dossier temporaire : refusées, sans effet disque.
    assert.equal(fs['writeToFile']?.(join(projectDir, 'game.json.autosave'), '{"fuite":true}'), false);
    assert.equal(fs['mkDir']?.(join(projectDir, 'assets')), false);
    assert.equal(fs['copyFile']?.(join(outDir, 'index.html'), join(projectDir, 'assets', 'Coin.png')), false);
    assert.equal(fs['clearDir']?.(projectDir), false);
    assert.equal(fs['writeToFile']?.('https://example.com/loin.txt', 'x'), false);
    assert.deepEqual(readdirSync(projectDir), ['game.json']);
  });
});
