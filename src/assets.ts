import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { CommandDeps } from './commands.js';
import { SUPPORTED_RESOURCE_KINDS, formatDiagnostics, isBlockingDiagnostic } from './engine.js';
import { McpError, validationFailed } from './errors.js';
import { runTransaction } from './transaction.js';
import type {
  AssetDetails,
  AssetPackSummary,
  AssetShortHeader,
  AssetSource,
  ExampleDetails,
  ExampleShortHeader,
} from './assetSource.js';

/**
 * Asset Store ciblé + exemples (ticket #18) : search → details → import
 * `{pack, packVersion, assets}` ciblé par défaut (`"all"` opt-in), exemples
 * en session lecture. Lecture seule sur CDN public pinné en mémoire (TTL 1 h,
 * adapté de gb2b `asset-store/examples` : cache mémoire, recherche en mémoire,
 * retry ×2 côté exemples), écriture toujours via le moteur
 * (`installAssetObject` + `importResource` + pipeline snapshot/round-trip/diagnostics).
 *
 * Pin : le CDN assets n'a pas de ref/sha comme le Catalogue (recherche §8 Q1 :
 * seuls les assets portent `version`) — on trace `{assetId → version}` par
 * asset importé + `packVersion` d'appel, exposés dans le résultat.
 *
 * Voir `docs/research/gdevelop-mcp-assets-research.md` §3-4.
 */

export const DEFAULT_ASSET_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_ASSET_LIMIT = 50;
export const MAX_ASSET_LIMIT = 200;
export const ASSET_PIN_REF = 'asset-cdn-live';

export interface AssetStoreOptions {
  ttlMs?: number | undefined;
  now?: (() => number) | undefined;
}

interface Cached<T> {
  value: T;
  loadedAt: number;
}

/** Index live Asset Store : cache mémoire TTL, jamais de JSON à l'aveugle côté écriture. */
export class AssetStore {
  private packs: Cached<AssetPackSummary[]> | null = null;
  private headers: Cached<AssetShortHeader[]> | null = null;
  private exampleHeaders: Cached<ExampleShortHeader[]> | null = null;
  private readonly now: () => number;

  constructor(
    private readonly source: AssetSource,
    private readonly options: AssetStoreOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  private get ttlMs(): number {
    return this.options.ttlMs ?? DEFAULT_ASSET_TTL_MS;
  }

  private fresh<T>(cached: Cached<T> | null): T | null {
    if (!cached) return null;
    if (this.now() - cached.loadedAt >= this.ttlMs) return null;
    return cached.value;
  }

  async packsCached(force = false): Promise<AssetPackSummary[]> {
    if (!force) {
      const hit = this.fresh(this.packs);
      if (hit) return hit;
    }
    const value = await this.source.listPacks();
    this.packs = { value, loadedAt: this.now() };
    return value;
  }

  async headersCached(force = false): Promise<AssetShortHeader[]> {
    if (!force) {
      const hit = this.fresh(this.headers);
      if (hit) return hit;
    }
    const value = await this.source.listHeaders();
    this.headers = { value, loadedAt: this.now() };
    return value;
  }

  async exampleHeadersCached(force = false): Promise<ExampleShortHeader[]> {
    if (!force) {
      const hit = this.fresh(this.exampleHeaders);
      if (hit) return hit;
    }
    const value = await this.source.listExampleHeaders();
    this.exampleHeaders = { value, loadedAt: this.now() };
    return value;
  }

  get backend(): AssetSource {
    return this.source;
  }
}

const limitSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_ASSET_LIMIT)
  .optional()
  .describe(`Maximum results (default ${DEFAULT_ASSET_LIMIT}, max ${MAX_ASSET_LIMIT})`);

/** Schémas Asset Store — source unique de vérité pour les outils MCP. */
export const assetSchemas = {
  status: z.object({ refresh: z.boolean().optional().describe('Force a re-read of the cached CDN lists') }),
  searchAssets: z.object({
    query: z.string().min(1).optional().describe('Case-insensitive substring over name/description/tags'),
    tags: z.array(z.string().min(1)).optional().describe('Every tag must be present (case-insensitive)'),
    objectType: z.string().min(1).optional().describe('Object type filter, e.g. sprite'),
    license: z.string().min(1).optional().describe('Exact license filter, e.g. CC0 (public domain)'),
    pack: z.string().min(1).optional().describe('Pack tag or name filter'),
    limit: limitSchema,
  }),
  getAssetDetails: z.object({ id: z.string().min(1).describe('Asset hex id, e.g. Bronze Coin id') }),
  importAssets: z.object({
    sessionId: z.string().uuid().describe('Session UUID'),
    scene: z.string().min(1).optional().describe('Target scene; absent = project-level (global) objects'),
    pack: z.string().min(1).describe('Pack tag or name (pinned)'),
    packVersion: z.string().min(1).describe('Traced pack version (each asset version is traced too)'),
    assets: z
      .union([
        z.literal('all').describe('Opt-in: import every asset of the pack'),
        z
          .array(z.object({ id: z.string().min(1).describe('Asset hex id'), as: z.string().min(1).optional().describe('Rename on collision (never overwrites)') }))
          .min(1),
      ])
      .describe('Targeted assets by default; "all" is opt-in'),
  }),
  listExamples: z.object({
    query: z.string().min(1).optional().describe('Case-insensitive substring over name/description/tags'),
    tags: z.array(z.string().min(1)).optional().describe('Every tag must be present (case-insensitive)'),
    license: z.string().min(1).optional().describe('Exact license filter, e.g. MIT'),
    difficulty: z.string().min(1).optional().describe('Difficulty filter, e.g. simple'),
    limit: limitSchema,
  }),
  getExampleDetails: z.object({ id: z.string().min(1).describe('Example id or slug, e.g. platformer') }),
  openExample: z.object({ id: z.string().min(1).describe('Example id or slug to open in a read-only session') }),
};

function parseArgs<T>(schema: z.ZodType<T>, args: unknown): T {
  try {
    return schema.parse(args);
  } catch (error) {
    throw validationFailed('Invalid asset arguments.', { cause: error });
  }
}

/**
 * Tolérance aux fiches CDN incomplètes (ticket #28) : un champ manquant ou
 * mal typé vaut chaîne vide / liste vide au lieu de lever un TypeError.
 * Seule une panne réseau/CDN avérée donne un refus `asset-unavailable`.
 */
function searchText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function tagList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((t): t is string => typeof t === 'string');
}

function matchesQuery(query: string | undefined, fields: unknown[]): boolean {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return fields.some((field) => typeof field === 'string' && field.toLowerCase().includes(needle));
}

function matchesTags(wanted: string[] | undefined, actual: unknown): boolean {
  if (!wanted || wanted.length === 0) return true;
  const lower = tagList(actual).map((t) => t.toLowerCase());
  return wanted.every((tag) => lower.includes(tag.toLowerCase()));
}

/** Détection privé/premium : preview sous private-assets (recherche §4). */
export function isPrivateAsset(header: { previewImageUrls?: string[] }): boolean {
  const first = header.previewImageUrls?.[0] ?? '';
  return first.startsWith('https://private-assets.gdevelop.io/');
}

function assetUnavailable(error: unknown, fallback: string): McpError {
  if (error instanceof McpError) return error;
  const detail = error instanceof Error ? `: ${error.message}` : '';
  return new McpError('asset-unavailable', `${fallback}${detail}`, { cause: error });
}

/** `Coin` → `Coin_2` (comme NewNameGenerator, suffixe 2,3…). */
export function uniqueObjectName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base;
  let counter = 2;
  while (taken(`${base}_${counter}`)) counter += 1;
  return `${base}_${counter}`;
}

/** Nom de fichier décodé depuis une URL `asset-resources` (recherche §3.4). */
export function decodedAssetFilename(url: string): string {
  const last = url.split('/').pop() ?? 'asset';
  const withoutHash = last.replace(/^[a-f0-9]{64}_/, '');
  try {
    return decodeURIComponent(withoutHash);
  } catch {
    return withoutHash;
  }
}

function resolvePack(packs: AssetPackSummary[], wanted: string): AssetPackSummary | null {
  const needle = wanted.trim().toLowerCase();
  return (
    packs.find((p) => searchText(p.tag).toLowerCase() === needle) ??
    packs.find((p) => searchText(p.name).toLowerCase() === needle) ??
    null
  );
}

function headersOfPack(headers: AssetShortHeader[], pack: AssetPackSummary): AssetShortHeader[] {
  const tag = searchText(pack.tag).toLowerCase();
  if (tag === '') return [];
  return headers.filter(
    (h) => searchText(h.assetPackId).toLowerCase() === tag || tagList(h.tags).some((t) => t.toLowerCase() === tag),
  );
}

export async function assetStatus(store: AssetStore, args: unknown): Promise<{
  pin: { ref: string };
  stale: boolean;
  counts: { packs: number; assets: number; examples: number };
}> {
  const parsed = parseArgs(assetSchemas.status, args);
  const refresh = parsed.refresh === true;
  const [packs, headers, examples] = await Promise.all([
    store.packsCached(refresh),
    store.headersCached(refresh),
    store.exampleHeadersCached(refresh),
  ]);
  return {
    pin: { ref: ASSET_PIN_REF },
    stale: false,
    counts: { packs: packs.length, assets: headers.length, examples: examples.length },
  };
}

export async function searchAssets(store: AssetStore, args: unknown): Promise<{
  pin: { ref: string };
  totalIndexed: number;
  matched: number;
  assets: AssetShortHeader[];
}> {
  const parsed = parseArgs(assetSchemas.searchAssets, args);
  let headers: AssetShortHeader[];
  try {
    headers = await store.headersCached();
  } catch (error) {
    throw assetUnavailable(error, 'Asset CDN unavailable while listing headers.');
  }
  let packs: AssetPackSummary[] | null = null;
  if (parsed.pack !== undefined) {
    try {
      packs = await store.packsCached();
    } catch (error) {
      throw assetUnavailable(error, 'Asset CDN unavailable while listing packs.');
    }
    const pack = resolvePack(packs, parsed.pack);
    if (!pack) {
      const known = packs.map((p) => p.tag).join(', ');
      throw validationFailed(`Unknown asset pack "${parsed.pack}". Known packs: ${known || '(none)'}.`);
    }
    headers = headersOfPack(headers, pack);
  }
  const matched = headers.filter(
    (h) =>
      matchesQuery(parsed.query, [searchText(h.name), searchText(h.shortDescription), ...tagList(h.tags)]) &&
      matchesTags(parsed.tags, h.tags) &&
      (parsed.objectType === undefined || searchText(h.objectType).toLowerCase() === parsed.objectType.toLowerCase()) &&
      (parsed.license === undefined || h.license === parsed.license),
  );
  return {
    pin: { ref: ASSET_PIN_REF },
    totalIndexed: headers.length,
    matched: matched.length,
    assets: matched.slice(0, parsed.limit ?? DEFAULT_ASSET_LIMIT),
  };
}

export async function getAssetDetails(store: AssetStore, args: unknown): Promise<AssetDetails> {
  const parsed = parseArgs(assetSchemas.getAssetDetails, args);
  try {
    return (await store.backend.getDetails(parsed.id)) as AssetDetails;
  } catch (error) {
    throw assetUnavailable(error, `Cannot fetch asset details for "${parsed.id}".`);
  }
}

export async function listExamples(store: AssetStore, args: unknown): Promise<{
  pin: { ref: string };
  totalIndexed: number;
  matched: number;
  examples: ExampleShortHeader[];
}> {
  const parsed = parseArgs(assetSchemas.listExamples, args);
  let headers: ExampleShortHeader[];
  try {
    headers = await store.exampleHeadersCached();
  } catch (error) {
    throw assetUnavailable(error, 'Asset CDN unavailable while listing examples.');
  }
  const matched = headers.filter(
    (h) =>
      matchesQuery(parsed.query, [searchText(h.name), searchText(h.shortDescription), ...tagList(h.tags)]) &&
      matchesTags(parsed.tags, h.tags) &&
      (parsed.license === undefined || h.license === parsed.license) &&
      (parsed.difficulty === undefined ||
        searchText(h.difficultyLevel).toLowerCase() === parsed.difficulty.toLowerCase()),
  );
  return {
    pin: { ref: ASSET_PIN_REF },
    totalIndexed: headers.length,
    matched: matched.length,
    examples: matched.slice(0, parsed.limit ?? DEFAULT_ASSET_LIMIT),
  };
}

export async function getExampleDetails(store: AssetStore, args: unknown): Promise<ExampleDetails> {
  const parsed = parseArgs(assetSchemas.getExampleDetails, args);
  try {
    return (await store.backend.getExample(parsed.id)) as ExampleDetails;
  } catch (error) {
    throw assetUnavailable(error, `Couldn't retrieve the example.`);
  }
}

export async function openExample(
  deps: CommandDeps,
  store: AssetStore,
  args: unknown,
): Promise<{ sessionId: string; slug: string; readOnly: true }> {
  const parsed = parseArgs(assetSchemas.openExample, args);
  let details: ExampleDetails;
  try {
    details = (await store.backend.getExample(parsed.id)) as ExampleDetails;
  } catch (error) {
    throw assetUnavailable(error, `Couldn't retrieve the example.`);
  }
  let projectJson: unknown;
  try {
    projectJson = await store.backend.fetchProjectJson(details.projectFileUrl);
  } catch (error) {
    throw assetUnavailable(error, `Asset CDN error while fetching example project ${details.projectFileUrl}.`);
  }
  const session = deps.store.openFromJson(JSON.stringify(projectJson), `example:${details.slug}`);
  return { sessionId: session.id, slug: details.slug, readOnly: true };
}

interface ImportedEntry {
  id: string;
  name: string;
  as: string;
}

/**
 * Import ciblé tout-ou-rien : snapshot mémoire global + compensation binaires,
 * gate baseline (sauf baseline déjà bloquante → refus comme le batch sans
 * allowInvalidBaseline), refus privés/extensions/variantes avant toute mutation.
 */
export async function importAssetsIntoProject(
  deps: CommandDeps,
  store: AssetStore,
  args: unknown,
): Promise<{
  pack: string;
  packVersion: string;
  imported: ImportedEntry[];
  resources: string[];
  assetVersions: { id: string; version: string }[];
}> {
  const parsed = parseArgs(assetSchemas.importAssets, args);
  const session = deps.store.get(parsed.sessionId);
  if (session.readOnly === true) {
    throw validationFailed(
      `Session ${parsed.sessionId} is read-only (example opened in read mode): describe only, no mutation, no save.`,
    );
  }
  if (!session.filePath) {
    throw validationFailed('No project location: save the session first so asset binaries land next to the project file.');
  }
  if (parsed.scene !== undefined) {
    const scenes = deps.engine.describeContent(session.project).scenes.map((s) => s.name);
    if (!scenes.includes(parsed.scene)) {
      throw validationFailed(`Unknown scene "${parsed.scene}". Known scenes: ${scenes.join(', ') || '(none)'}.`);
    }
  }

  let packs: AssetPackSummary[];
  let headers: AssetShortHeader[];
  try {
    [packs, headers] = await Promise.all([store.packsCached(), store.headersCached()]);
  } catch (error) {
    throw assetUnavailable(error, 'Asset CDN unavailable while resolving the pack.');
  }
  const pack = resolvePack(packs, parsed.pack);
  if (!pack) {
    const known = packs.map((p) => p.tag).join(', ');
    throw validationFailed(`Unknown asset pack "${parsed.pack}". Known packs: ${known || '(none)'}.`);
  }

  const wanted: { id: string; as?: string | undefined }[] =
    parsed.assets === 'all'
      ? headersOfPack(headers, pack).map((h) => ({ id: h.id }))
      : (parsed.assets as { id: string; as?: string | undefined }[]);
  if (wanted.length === 0) {
    throw validationFailed(`Pack "${pack.tag}" has no assets to import.`);
  }

  // Pré-checks avant toute mutation : détails + refus privés/extensions/variantes.
  const detailsList: AssetDetails[] = [];
  for (const entry of wanted) {
    let details: AssetDetails;
    try {
      details = (await store.backend.getDetails(entry.id)) as AssetDetails;
    } catch (error) {
      throw assetUnavailable(error, `Cannot fetch asset details for "${entry.id}".`);
    }
    if (isPrivateAsset({ previewImageUrls: details.previewImageUrls })) {
      throw validationFailed(
        `Asset "${details.name}" is private/premium: hors périmètre MVP (CDN public seul, auth Shop non supportée). Nothing was imported.`,
      );
    }
    const required = details.objectAssets.flatMap((oa) => oa.requiredExtensions ?? []);
    if (required.length > 0) {
      const missing = required.map((r) => `${r.extensionName}@${r.extensionVersion}`).join(', ');
      throw validationFailed(
        `Asset "${details.name}" requires extensions (${missing}): extension install is out of MVP scope, refusing import before any mutation. Nothing was imported.`,
      );
    }
    const hasVariants = details.objectAssets.some((oa) => Array.isArray(oa.variants) && oa.variants.length > 0);
    if (hasVariants) {
      throw validationFailed(
        `Asset "${details.name}" carries custom variants: asset à variantes hors-scope MVP. Nothing was imported.`,
      );
    }
    if (details.objectAssets.length === 0) {
      throw validationFailed(`Asset "${details.name}" has no importable object. Nothing was imported.`);
    }
    detailsList.push(details);
  }

  // as explicite déjà pris → refus immédiat (jamais d'écrasement).
  const view0 = deps.engine.describeContent(session.project);
  const taken0 = new Set([
    ...view0.globalObjects.map((o) => o.name),
    ...view0.scenes.flatMap((s) => s.objects.map((o) => o.name)),
  ]);
  for (const entry of wanted) {
    if (entry.as !== undefined && taken0.has(entry.as)) {
      throw validationFailed(`Object "${entry.as}" already exists in ${parsed.scene === undefined ? 'project' : `scene "${parsed.scene}"`}.`);
    }
  }

  // Gate baseline avant la Transaction (message d'import préservé ; le module
  // la revérifie à l'entrée avec la même issue).
  const baselineBlocking = deps.engine.listDiagnostics(session.project).filter(isBlockingDiagnostic);
  if (baselineBlocking.length > 0) {
    throw validationFailed(
      `Refusing import: project baseline has blocking errors (${formatDiagnostics(baselineBlocking)}). Nothing was imported.`,
    );
  }
  const projectDir = dirname(session.filePath);

  try {
    return (
      await runTransaction(deps, parsed.sessionId, async (ctx) => {
        const imported: ImportedEntry[] = [];
        const resources: string[] = [];
        const assetVersions: { id: string; version: string }[] = [];
        const taken = new Set(taken0);

        for (let i = 0; i < detailsList.length; i += 1) {
          const details = detailsList[i] as AssetDetails;
          const entry = wanted[i] as { id: string; as?: string | undefined };

          for (const objectAsset of details.objectAssets) {
            for (const res of objectAsset.resources ?? []) {
              if (!(SUPPORTED_RESOURCE_KINDS as readonly string[]).includes(res.kind)) {
                throw validationFailed(`Resource of kind "${res.kind}" is not supported. Nothing was imported.`);
              }
              const filename = decodedAssetFilename(res.file);
              if (filename === '') throw validationFailed('Asset resource has an empty file name: refusing import.');
              const assetsDir = join(projectDir, 'assets');
              mkdirSync(assetsDir, { recursive: true });
              const destination = join(assetsDir, basename(filename));
              const relative = `assets/${basename(filename)}`;
              const resourceName = res.name && res.name !== '' ? res.name : basename(filename, '.png');

              const already = deps.engine.describeContent(session.project).resources.some((r) => r.name === resourceName);
              if (already) {
                if (!resources.includes(relative) && existsSync(destination)) resources.push(relative);
                continue;
              }
              let bytes: Uint8Array;
              try {
                bytes = await store.backend.downloadBinary(res.file);
              } catch (error) {
                throw assetUnavailable(error, `Asset CDN error while downloading ${res.file}.`);
              }
              ctx.declareFile(destination);
              try {
                writeFileSync(destination, bytes);
              } catch (error) {
                throw new McpError('io-error', `Cannot write asset binary at ${destination}.`, { cause: error });
              }
              deps.engine.importResource(session.project, { name: resourceName, kind: res.kind, file: relative });
              resources.push(relative);
            }
          }

          for (let oaIndex = 0; oaIndex < details.objectAssets.length; oaIndex += 1) {
            const objectAsset = details.objectAssets[oaIndex] as AssetDetails['objectAssets'][number];
            const rawObject = objectAsset.object as Record<string, unknown>;
            const type = typeof rawObject['type'] === 'string' ? (rawObject['type'] as string) : '';
            const baseName =
              typeof rawObject['name'] === 'string' && (rawObject['name'] as string) !== ''
                ? (rawObject['name'] as string)
                : details.objectAssets.length > 1
                  ? `${details.name}_${oaIndex + 1}`
                  : details.name;
            if (type === '') throw validationFailed(`Asset "${details.name}" has no object type: refusing import.`);
            // `as` ne vaut que pour un asset mono-objet ; en multi-objets chaque
            // objet garde son nom (auto-renommé si collision).
            const requested = details.objectAssets.length === 1 ? (entry.as ?? baseName) : baseName;
            if (entry.as !== undefined && details.objectAssets.length === 1 && taken.has(requested)) {
              throw validationFailed(
                `Object "${requested}" already exists in ${parsed.scene === undefined ? 'project' : `scene "${parsed.scene}"`}.`,
              );
            }
            const finalName =
              details.objectAssets.length === 1 && entry.as !== undefined
                ? requested
                : uniqueObjectName(requested, (n) => taken.has(n));
            deps.engine.installAssetObject(session.project, {
              scene: parsed.scene,
              type,
              name: finalName,
              serializedObject: rawObject,
              assetStoreId: details.id,
            });
            taken.add(finalName);
            imported.push({ id: details.id, name: baseName, as: finalName });
          }
          assetVersions.push({ id: details.id, version: details.version });
        }
        return { pack: pack.tag, packVersion: parsed.packVersion, imported, resources, assetVersions };
      })
    ).result;
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError('post-apply-failed', `Import failed (${error instanceof Error ? error.message : String(error)}); everything was restored.`, {
      cause: error,
    });
  }
}
