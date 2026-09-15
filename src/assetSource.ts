import { McpError } from './errors.js';

/**
 * Source Asset Store + exemples (ticket #18) : lecture seule du CDN public
 * GDevelop, calquée sur `GitHubCatalogSource` (ticket #15). La production
 * lit le CDN live ; les tests injectent la fixture mémoire
 * (`test/assetFixtures.ts`), donc la suite unit n'a jamais besoin du réseau.
 *
 * Voir `docs/research/gdevelop-mcp-assets-research.md` §1-2.
 */

export interface AssetPackSummary {
  name: string;
  tag: string;
  thumbnailUrl: string;
  assetsCount: number;
  categories: string[];
  authors: { name: string; website: string }[];
  licenses: { name: string; website: string }[];
}

export interface AssetShortHeader {
  id: string;
  name: string;
  shortDescription: string;
  previewImageUrls: string[];
  tags: string[];
  license: string;
  objectType: string;
  animationsCount: number;
  maxFramesCount: number;
  width: number;
  height: number;
  dominantColors: number[];
  assetPackId?: string | undefined;
}

export interface AssetExtensionDependency {
  extensionName: string;
  extensionVersion: string;
}

export interface AssetSerializedResource {
  name: string;
  file: string;
  kind: string;
  metadata?: string | undefined;
  smoothed?: boolean | undefined;
  userAdded?: boolean | undefined;
  origin?: { name: string; identifier: string } | undefined;
}

export interface AssetObjectAsset {
  object: Record<string, unknown> & { type?: unknown; name?: unknown };
  customization?: unknown[];
  requiredExtensions?: AssetExtensionDependency[];
  resources?: AssetSerializedResource[];
  variants?: unknown[] | undefined;
}

export interface AssetDetails {
  id: string;
  name: string;
  authors: string[];
  license: string;
  shortDescription: string;
  description: string;
  tags: string[];
  objectAssets: AssetObjectAsset[];
  gdevelopVersion: string;
  version: string;
  animationsCount: number;
  maxFramesCount: number;
  objectType: string;
  previewImageUrls: string[];
  dominantColors: number[];
  width: number;
  height: number;
}

export interface ExampleShortHeader {
  id: string;
  slug: string;
  name: string;
  shortDescription: string;
  description: string;
  license: string;
  tags: string[];
  previewImageUrls: string[];
  difficultyLevel?: string | undefined;
  codeSizeLevel?: string | undefined;
  gdevelopVersion?: string | undefined;
}

export interface ExampleDetails extends ExampleShortHeader {
  authors: string[];
  projectFileUrl: string;
  usedExtensions: string[];
  eventsBasedExtensions: string[];
}

/** Contrat minimal : chaque méthode lit le CDN public (jamais de privé/premium). */
export interface AssetSource {
  listPacks(): Promise<AssetPackSummary[]>;
  listHeaders(): Promise<AssetShortHeader[]>;
  listFilters(): Promise<{ allTags: string[]; defaultTags: string[]; tagsTree: unknown[] }>;
  getDetails(id: string): Promise<AssetDetails>;
  listExampleHeaders(): Promise<ExampleShortHeader[]>;
  listExampleFilters(): Promise<{ allTags: string[]; defaultTags: string[]; tagsTree: unknown[] }>;
  getExample(idOrSlug: string): Promise<ExampleDetails>;
  fetchProjectJson(url: string): Promise<unknown>;
  downloadBinary(url: string): Promise<Uint8Array>;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<FetchResponseLike>;

function assetError(message: string, options?: ErrorOptions): McpError {
  return new McpError('asset-unavailable', message, options);
}

const UA = { 'User-Agent': 'Mozilla/5.0 (gdevelop-mcp-server)' };

async function fetchJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  let response: FetchResponseLike;
  try {
    response = await fetchImpl(url, { headers: { ...UA } });
  } catch (error) {
    throw assetError(`Asset CDN unreachable: ${url} (${error instanceof Error ? error.message : String(error)}).`, { cause: error });
  }
  if (!response.ok) throw assetError(`Asset CDN error (${response.status}) for ${url}.`);
  try {
    return await response.json();
  } catch (error) {
    throw assetError(`Asset CDN returned invalid JSON: ${url}.`, { cause: error });
  }
}

async function fetchBinary(fetchImpl: FetchLike, url: string): Promise<Uint8Array> {
  let response: FetchResponseLike;
  try {
    response = await fetchImpl(url, { headers: { ...UA } });
  } catch (error) {
    throw assetError(`Asset CDN unreachable: ${url} (${error instanceof Error ? error.message : String(error)}).`, { cause: error });
  }
  if (!response.ok) throw assetError(`Asset CDN error (${response.status}) for ${url}.`);
  return new Uint8Array(await response.arrayBuffer());
}

async function withRetry<T>(times: number, action: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < times; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

/**
 * Source HTTP live : CDN public seul (`resources.gdevelop-app.com` +
 * `api.gdevelop.io/asset`), jamais de stockages privés (Spec #11 hors-scope).
 */
export class HttpAssetSource implements AssetSource {
  private readonly fetchImpl: FetchLike;

  constructor(fetchImpl?: FetchLike) {
    const impl = fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!impl) throw assetError('No fetch implementation available: Node.js 20+ is required.');
    this.fetchImpl = impl;
  }

  async listPacks(): Promise<AssetPackSummary[]> {
    const data = (await fetchJson(
      this.fetchImpl,
      'https://resources.gdevelop-app.com/assets-database/assetPacks.json',
    )) as { starterPacks?: unknown };
    if (!Array.isArray(data.starterPacks)) throw assetError('Asset CDN returned an unexpected packs shape.');
    return data.starterPacks as AssetPackSummary[];
  }

  async listHeaders(): Promise<AssetShortHeader[]> {
    // Gros fichier (plusieurs Mo) : un seul fetch, retry 1 (pas de retry éditeur).
    const data = (await fetchJson(
      this.fetchImpl,
      'https://resources.gdevelop-app.com/assets-database/assetShortHeaders.json',
    )) as unknown;
    if (!Array.isArray(data)) throw assetError('Asset CDN returned an unexpected headers shape.');
    return data as AssetShortHeader[];
  }

  async listFilters(): Promise<{ allTags: string[]; defaultTags: string[]; tagsTree: unknown[] }> {
    const data = (await fetchJson(
      this.fetchImpl,
      'https://resources.gdevelop-app.com/assets-database/assetFilters.json',
    )) as { allTags?: unknown; defaultTags?: unknown; tagsTree?: unknown };
    return {
      allTags: Array.isArray(data.allTags) ? (data.allTags as string[]) : [],
      defaultTags: Array.isArray(data.defaultTags) ? (data.defaultTags as string[]) : [],
      tagsTree: Array.isArray(data.tagsTree) ? (data.tagsTree as unknown[]) : [],
    };
  }

  async getDetails(id: string): Promise<AssetDetails> {
    if (!/^[0-9a-f]{16,64}$/i.test(id)) throw assetError(`Invalid asset id "${id}": expected an hex id.`);
    const url = `https://resources.gdevelop-app.com/assets-database/assets/${id}.json`;
    return (await fetchJson(this.fetchImpl, url)) as AssetDetails;
  }

  async listExampleHeaders(): Promise<ExampleShortHeader[]> {
    const data = (await withRetry(2, () =>
      fetchJson(this.fetchImpl, 'https://resources.gdevelop-app.com/examples-database/examples-database-v2.json'),
    )) as { exampleShortHeaders?: unknown };
    if (!Array.isArray(data.exampleShortHeaders)) throw assetError('Asset CDN returned an unexpected examples shape.');
    return data.exampleShortHeaders as ExampleShortHeader[];
  }

  async listExampleFilters(): Promise<{ allTags: string[]; defaultTags: string[]; tagsTree: unknown[] }> {
    const data = (await withRetry(2, () =>
      fetchJson(this.fetchImpl, 'https://resources.gdevelop-app.com/examples-database/filters.json'),
    )) as { allTags?: unknown; defaultTags?: unknown; tagsTree?: unknown };
    return {
      allTags: Array.isArray(data.allTags) ? (data.allTags as string[]) : [],
      defaultTags: Array.isArray(data.defaultTags) ? (data.defaultTags as string[]) : [],
      tagsTree: Array.isArray(data.tagsTree) ? (data.tagsTree as unknown[]) : [],
    };
  }

  async getExample(idOrSlug: string): Promise<ExampleDetails> {
    // L'API exige l'id (le slug seul répond "Couldn't retrieve the example.").
    // On résout d'abord via les headers (comme gb2b findExampleBySlugOrId).
    const headers = await this.listExampleHeaders();
    const header = headers.find((h) => h.id === idOrSlug || h.slug === idOrSlug) ?? null;
    if (!header) throw assetError(`Couldn't retrieve the example.`);
    const url = `https://api.gdevelop.io/asset/example-v2/${header.id}`;
    return (await withRetry(2, () => fetchJson(this.fetchImpl, url))) as ExampleDetails;
  }

  async fetchProjectJson(url: string): Promise<unknown> {
    return fetchJson(this.fetchImpl, url);
  }

  async downloadBinary(url: string): Promise<Uint8Array> {
    return fetchBinary(this.fetchImpl, url);
  }
}
