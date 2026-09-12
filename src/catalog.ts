import { z } from 'zod';
import {
  classifyReceiver,
  parseExtensionSource,
  type CatalogParameter,
  type InstructionKind,
  type ParsedTypeDeclaration,
  type ReceiverKind,
} from './catalogParsers.js';
import type { CatalogSource, CatalogSourceSnapshot } from './catalogSource.js';
import { validationFailed } from './errors.js';

/**
 * Catalogue (ticket #15): read-only registries built from a pinned GDevelop
 * source tree, held live with a 1 h TTL and a `releases/latest` freshness check.
 * The catalogue helps, the engine judges: nothing here validates a write.
 *
 * See `docs/research/gdevelop-mcp-catalogue-research.md` §3 and §5.
 */

export const DEFAULT_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

export interface CatalogPin {
  ref: string;
  sha: string | null;
}

export interface InstructionEntry {
  type: string;
  fullName: string;
  description: string;
  kind: InstructionKind;
  extension: string;
  receiverKind: ReceiverKind;
  receiver: string | null;
  parameters: CatalogParameter[];
  source: 'cpp' | 'js';
  path: string;
}

export interface TypeEntry {
  /** Full engine type, e.g. `Sprite`, `TextObject::Text`, `MyExt::MyObject`. */
  type: string;
  /** Declared name as written in the source. */
  name: string;
  extension: string;
  source: 'cpp' | 'js';
  path: string;
  eventsBased: boolean;
}

export interface ExtensionEntry {
  name: string;
  fullName: string;
  description: string;
  source: 'cpp' | 'js';
  path: string;
  instructions: number;
  objectTypes: number;
  behaviorTypes: number;
  eventsBasedObjects: string[];
  eventsBasedBehaviors: string[];
}

export interface CatalogIndex {
  pin: CatalogPin;
  syncedAt: string;
  builtAt: string;
  files: number;
  instructions: InstructionEntry[];
  objectTypes: TypeEntry[];
  behaviorTypes: TypeEntry[];
  extensions: ExtensionEntry[];
}

export interface CatalogCounts {
  files: number;
  instructions: number;
  objectTypes: number;
  behaviorTypes: number;
  extensions: number;
}

export interface CatalogStatus {
  pin: CatalogPin;
  syncedAt: string;
  builtAt: string;
  stale: boolean;
  latestRef: string | null;
  reason: string;
  counts: CatalogCounts;
}

interface FileDescriptor {
  extension: string;
  source: 'cpp' | 'js';
}

function stripExtensionSuffix(name: string): string {
  return name.endsWith('Extension') ? name.slice(0, -'Extension'.length) : name;
}

/** Which extension a pinned file belongs to, and how to parse it. */
export function describeCatalogFile(path: string): FileDescriptor | null {
  const segments = path.split('/');
  const name = segments.pop() ?? '';
  if (name === '') return null;

  if (path.startsWith('Core/GDCore/Extensions/Builtin/')) {
    const rest = segments.slice(4);
    const directory = rest.length > 0 ? rest[rest.length - 1] : undefined;
    if (directory) return { extension: stripExtensionSuffix(directory), source: 'cpp' };
    return { extension: stripExtensionSuffix(name.replace(/\.cpp$/, '')), source: 'cpp' };
  }
  if (path.startsWith('Extensions/')) {
    const extension = segments[1];
    if (!extension) return null;
    return { extension, source: name === 'JsExtension.js' || name.endsWith('.ts') ? 'js' : 'cpp' };
  }
  return null;
}

/** Full engine type for an extension-declared type (`<extension>::<name>`). */
export function fullTypeName(extension: string, name: string): string {
  return name.includes('::') ? name : `${extension}::${name}`;
}

function instructionRichness(entry: InstructionEntry): number {
  return (entry.fullName !== entry.type ? 1 : 0) + (entry.description ? 1 : 0) + entry.parameters.length;
}

/** Same `kind::type::extension` entries can come from sibling files: keep the richest. */
function dedupeInstructions(entries: InstructionEntry[]): InstructionEntry[] {
  const best = new Map<string, InstructionEntry>();
  for (const entry of entries) {
    const key = `${entry.kind}::${entry.type}::${entry.extension}`;
    const existing = best.get(key);
    if (!existing || instructionRichness(entry) > instructionRichness(existing)) best.set(key, entry);
  }
  return [...best.values()];
}

function dedupeTypes(entries: TypeEntry[]): TypeEntry[] {
  const seen = new Map<string, TypeEntry>();
  for (const entry of entries) {
    const key = `${entry.type}`;
    const existing = seen.get(key);
    if (!existing || (existing.eventsBased && !entry.eventsBased)) seen.set(key, entry);
  }
  return [...seen.values()];
}

function declarationToType(
  declaration: ParsedTypeDeclaration,
  extension: string,
  source: 'cpp' | 'js',
  path: string,
): TypeEntry {
  const name = declaration.name;
  return {
    type: fullTypeName(extension, name),
    name,
    extension,
    source,
    path,
    eventsBased: declaration.kind === 'eventsBasedObject' || declaration.kind === 'eventsBasedBehavior',
  };
}

/** Index the pinned snapshot: instructions, object types, behavior types, extensions. */
export function buildCatalogIndex(snapshot: CatalogSourceSnapshot, builtAt: string): CatalogIndex {
  const instructions: InstructionEntry[] = [];
  const objectTypes: TypeEntry[] = [];
  const behaviorTypes: TypeEntry[] = [];
  const aggregate = new Map<string, ExtensionEntry>();

  for (const file of snapshot.files) {
    const descriptor = describeCatalogFile(file.path);
    if (!descriptor) continue;
    const parsed = parseExtensionSource(file.source);
    const extension = parsed.name ?? descriptor.extension;
    const aggregateEntry: ExtensionEntry =
      aggregate.get(extension) ??
      ({
        name: extension,
        fullName: parsed.fullName ?? extension,
        description: parsed.description ?? '',
        source: descriptor.source,
        path: file.path,
        instructions: 0,
        objectTypes: 0,
        behaviorTypes: 0,
        eventsBasedObjects: [],
        eventsBasedBehaviors: [],
      } satisfies ExtensionEntry);

    for (const instruction of parsed.instructions) {
      instructions.push({
        type: instruction.type,
        fullName: instruction.fullName ?? instruction.type,
        description: instruction.description ?? '',
        kind: instruction.kind,
        extension,
        receiverKind: classifyReceiver(instruction.receiver),
        receiver: instruction.receiver ?? null,
        parameters: instruction.parameters,
        source: descriptor.source,
        path: file.path,
      });
      aggregateEntry.instructions += 1;
    }

    for (const declaration of parsed.typeDeclarations) {
      const entry = declarationToType(declaration, extension, descriptor.source, file.path);
      if (declaration.kind === 'object') {
        objectTypes.push(entry);
        aggregateEntry.objectTypes += 1;
      } else if (declaration.kind === 'behavior') {
        behaviorTypes.push(entry);
        aggregateEntry.behaviorTypes += 1;
      } else if (declaration.kind === 'eventsBasedObject') {
        objectTypes.push(entry);
        aggregateEntry.objectTypes += 1;
        if (declaration.name !== '<events-based>') aggregateEntry.eventsBasedObjects.push(entry.type);
      } else {
        behaviorTypes.push(entry);
        aggregateEntry.behaviorTypes += 1;
        if (declaration.name !== '<events-based>') aggregateEntry.eventsBasedBehaviors.push(entry.type);
      }
    }

    aggregate.set(extension, aggregateEntry);
  }

  return {
    pin: { ref: snapshot.ref, sha: snapshot.sha },
    syncedAt: snapshot.syncedAt,
    builtAt,
    files: snapshot.files.length,
    instructions: dedupeInstructions(instructions),
    objectTypes: dedupeTypes(objectTypes),
    behaviorTypes: dedupeTypes(behaviorTypes),
    extensions: [...aggregate.values()].sort((left, right) => (left.name < right.name ? -1 : 1)),
  };
}

function matchesQuery(query: string, fields: string[]): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return fields.some((field) => field.toLowerCase().includes(needle));
}

export interface CatalogOptions {
  /** Live registry TTL. Defaults to 1 h. */
  ttlMs?: number | undefined;
  /** Freshness-check TTL. Defaults to 1 h. */
  freshnessTtlMs?: number | undefined;
  /** Injected clock in ms (tests). */
  now?: (() => number) | undefined;
}

/**
 * Live catalogue registry: builds the index on first use, keeps it for `ttlMs`,
 * and answers every read-only query. It never mutates anything and never talks to
 * the engine or to a project session.
 */
export class Catalog {
  private cached: { index: CatalogIndex; loadedAt: number } | null = null;
  private freshness: { checkedAt: number; latestRef: string | null } | null = null;
  private inflight: Promise<CatalogIndex> | null = null;
  private readonly now: () => number;

  constructor(
    private readonly source: CatalogSource,
    private readonly options: CatalogOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  private get ttlMs(): number {
    return this.options.ttlMs ?? DEFAULT_TTL_MS;
  }

  private get freshnessTtlMs(): number {
    return this.options.freshnessTtlMs ?? DEFAULT_TTL_MS;
  }

  /** Build (or return the cached) index. `force` re-reads the pinned source. */
  async index(force = false): Promise<CatalogIndex> {
    if (!force && this.cached && this.now() - this.cached.loadedAt < this.ttlMs) return this.cached.index;
    if (!force && this.inflight) return this.inflight;
    const build = (async (): Promise<CatalogIndex> => {
      const snapshot = await this.source.load({ refresh: force });
      const index = buildCatalogIndex(snapshot, new Date(this.now()).toISOString());
      this.cached = { index, loadedAt: this.now() };
      return index;
    })();
    this.inflight = build;
    try {
      return await build;
    } finally {
      this.inflight = null;
    }
  }

  private async checkFreshness(force: boolean): Promise<{ checkedAt: number; latestRef: string | null }> {
    const current = this.freshness;
    if (!force && current && this.now() - current.checkedAt < this.freshnessTtlMs) return current;
    let latestRef: string | null = null;
    try {
      latestRef = await this.source.latestReleaseRef();
    } catch {
      // Freshness is best-effort: a network failure never fails a read-only tool.
      latestRef = null;
    }
    const next = { checkedAt: this.now(), latestRef };
    this.freshness = next;
    return next;
  }

  private counts(index: CatalogIndex): CatalogCounts {
    return {
      files: index.files,
      instructions: index.instructions.length,
      objectTypes: index.objectTypes.length,
      behaviorTypes: index.behaviorTypes.length,
      extensions: index.extensions.length,
    };
  }

  async status(options: { refresh?: boolean | undefined } = {}): Promise<CatalogStatus> {
    const refresh = options.refresh === true;
    const index = await this.index(refresh);
    const freshness = await this.checkFreshness(refresh);
    const stale = freshness.latestRef !== null && freshness.latestRef !== index.pin.ref;
    const reason =
      freshness.latestRef === null
        ? 'Freshness could not be checked (no GitHub response); the pinned ref is used as-is.'
        : stale
          ? `A newer GDevelop ref is available (pinned: ${index.pin.ref}, latest: ${freshness.latestRef}). Call catalog_status with refresh:true to re-read the pinned sources.`
          : 'Pinned ref is up to date with the latest GDevelop release.';
    return {
      pin: index.pin,
      syncedAt: index.syncedAt,
      builtAt: index.builtAt,
      stale,
      latestRef: freshness.latestRef,
      reason,
      counts: this.counts(index),
    };
  }
}

const kindSchema = z.enum(['action', 'condition', 'expression', 'strExpression']);
const receiverKindSchema = z.enum(['extension', 'object', 'behavior', 'unknown']);
const extensionFilter = z.string().min(1).describe('Extension name filter, e.g. PlatformBehavior');
const limitSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_LIMIT)
  .optional()
  .describe(`Maximum results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`);

/** Catalogue argument schemas — the single source of truth for the catalogue tools. */
export const catalogSchemas = {
  status: z.object({ refresh: z.boolean().optional().describe('Force a re-read of the pinned sources') }),
  listInstructions: z.object({
    kind: kindSchema.optional().describe('Instruction kind'),
    extension: extensionFilter.optional(),
    receiverKind: receiverKindSchema.optional().describe('What the instruction is attached to'),
    query: z.string().min(1).optional().describe('Case-insensitive substring over type/fullName/description'),
    limit: limitSchema,
  }),
  searchInstructions: z.object({
    query: z.string().min(1).describe('Case-insensitive substring over type/fullName/description/extension'),
    kind: kindSchema.optional(),
    extension: extensionFilter.optional(),
    receiverKind: receiverKindSchema.optional(),
    limit: limitSchema,
  }),
  describeInstructions: z.object({
    type: z.string().min(1).describe('Instruction type, e.g. SetReturnNumber or KeyPressed'),
    kind: kindSchema.optional().describe('Restrict to one kind (duals share the same type)'),
    extension: extensionFilter.optional(),
  }),
  listObjectTypes: z.object({ extension: extensionFilter.optional(), query: z.string().min(1).optional(), limit: limitSchema }),
  listBehaviorTypes: z.object({ extension: extensionFilter.optional(), query: z.string().min(1).optional(), limit: limitSchema }),
  describeObject: z.object({ type: z.string().min(1).describe('Object type, e.g. Sprite or PanelSpriteObject::PanelSprite') }),
  describeBehavior: z.object({ type: z.string().min(1).describe('Behavior type, e.g. PlatformBehavior::PlatformerObjectBehavior') }),
  listExtensions: z.object({ query: z.string().min(1).optional(), limit: limitSchema }),
  describeExtension: z.object({ name: z.string().min(1).describe('Extension name, e.g. BuiltinAdvanced or DialogueTree') }),
};

function parseArgs<T>(schema: z.ZodType<T>, args: unknown): T {
  try {
    return schema.parse(args);
  } catch (error) {
    throw validationFailed('Invalid catalogue arguments.', { cause: error });
  }
}

interface InstructionFilters {
  kind?: InstructionKind | undefined;
  extension?: string | undefined;
  receiverKind?: ReceiverKind | undefined;
  query?: string | undefined;
}

function instructionMatches(entry: InstructionEntry, filters: InstructionFilters): boolean {
  if (filters.kind && entry.kind !== filters.kind) return false;
  if (filters.extension && entry.extension !== filters.extension) return false;
  if (filters.receiverKind && entry.receiverKind !== filters.receiverKind) return false;
  if (filters.query && !matchesQuery(filters.query, [entry.type, entry.fullName, entry.description, entry.extension])) {
    return false;
  }
  return true;
}

export async function catalogStatus(catalog: Catalog, args: unknown): Promise<CatalogStatus> {
  return catalog.status(parseArgs(catalogSchemas.status, args));
}

export async function listInstructions(catalog: Catalog, args: unknown): Promise<{
  pin: CatalogPin;
  totalIndexed: number;
  matched: number;
  instructions: InstructionEntry[];
}> {
  const parsed = parseArgs(catalogSchemas.listInstructions, args);
  const index = await catalog.index();
  const matched = index.instructions.filter((entry) => instructionMatches(entry, parsed));
  return {
    pin: index.pin,
    totalIndexed: index.instructions.length,
    matched: matched.length,
    instructions: matched.slice(0, parsed.limit ?? DEFAULT_LIMIT),
  };
}

export async function searchInstructions(catalog: Catalog, args: unknown): Promise<{
  pin: CatalogPin;
  totalIndexed: number;
  matched: number;
  instructions: InstructionEntry[];
}> {
  const parsed = parseArgs(catalogSchemas.searchInstructions, args);
  return listInstructions(catalog, { ...parsed, limit: parsed.limit ?? DEFAULT_LIMIT });
}

export async function describeInstructions(catalog: Catalog, args: unknown): Promise<{
  pin: CatalogPin;
  type: string;
  found: boolean;
  matches: InstructionEntry[];
  hint?: string | undefined;
}> {
  const parsed = parseArgs(catalogSchemas.describeInstructions, args);
  const index = await catalog.index();
  const matches = index.instructions.filter(
    (entry) =>
      entry.type === parsed.type &&
      (parsed.kind === undefined || entry.kind === parsed.kind) &&
      (parsed.extension === undefined || entry.extension === parsed.extension),
  );
  const result: { pin: CatalogPin; type: string; found: boolean; matches: InstructionEntry[]; hint?: string | undefined } = {
    pin: index.pin,
    type: parsed.type,
    found: matches.length > 0,
    matches,
  };
  if (matches.length === 0) {
    result.hint = 'Not in the pinned catalogue. Try list_instructions with a query, or search_instructions.';
  }
  return result;
}


interface TypeFilters {
  extension?: string | undefined;
  query?: string | undefined;
}

function typeMatches(entry: TypeEntry, filters: TypeFilters): boolean {
  if (filters.extension && entry.extension !== filters.extension) return false;
  if (filters.query && !matchesQuery(filters.query, [entry.type, entry.name, entry.extension])) return false;
  return true;
}

export async function listObjectTypes(catalog: Catalog, args: unknown): Promise<{
  pin: CatalogPin;
  totalIndexed: number;
  matched: number;
  types: TypeEntry[];
}> {
  const parsed = parseArgs(catalogSchemas.listObjectTypes, args);
  const index = await catalog.index();
  const matched = index.objectTypes.filter((entry) => typeMatches(entry, parsed));
  return {
    pin: index.pin,
    totalIndexed: index.objectTypes.length,
    matched: matched.length,
    types: matched.slice(0, parsed.limit ?? DEFAULT_LIMIT),
  };
}

export async function listBehaviorTypes(catalog: Catalog, args: unknown): Promise<{
  pin: CatalogPin;
  totalIndexed: number;
  matched: number;
  behaviors: TypeEntry[];
}> {
  const parsed = parseArgs(catalogSchemas.listBehaviorTypes, args);
  const index = await catalog.index();
  const matched = index.behaviorTypes.filter((entry) => typeMatches(entry, parsed));
  return {
    pin: index.pin,
    totalIndexed: index.behaviorTypes.length,
    matched: matched.length,
    behaviors: matched.slice(0, parsed.limit ?? DEFAULT_LIMIT),
  };
}

interface TypeLookupResult {
  pin: CatalogPin;
  type: string;
  found: boolean;
  entry?: TypeEntry | undefined;
  knownTypesInExtension?: string[] | undefined;
  hint?: string | undefined;
}

async function lookupType(index: CatalogIndex, collection: TypeEntry[], type: string): Promise<TypeLookupResult> {
  const entry = collection.find((candidate) => candidate.type === type);
  if (entry) return { pin: index.pin, type, found: true, entry };
  const result: TypeLookupResult = { pin: index.pin, type, found: false };
  if (type.includes('::')) {
    const extension = type.split('::')[0] as string;
    const known = collection.filter((candidate) => candidate.extension === extension).map((candidate) => candidate.type);
    if (known.length > 0) {
      result.knownTypesInExtension = known;
      result.hint = `Exact type not in the pinned catalogue, but extension ${extension} declares other types. Use list_object_types/list_behavior_types with extension:${extension}.`;
      return result;
    }
  }
  result.hint = 'Not in the pinned catalogue. The engine remains the judge at write time.';
  return result;
}

export async function describeObject(catalog: Catalog, args: unknown): Promise<TypeLookupResult> {
  const parsed = parseArgs(catalogSchemas.describeObject, args);
  const index = await catalog.index();
  return lookupType(index, index.objectTypes, parsed.type);
}

export async function describeBehavior(catalog: Catalog, args: unknown): Promise<TypeLookupResult> {
  const parsed = parseArgs(catalogSchemas.describeBehavior, args);
  const index = await catalog.index();
  return lookupType(index, index.behaviorTypes, parsed.type);
}

export async function listExtensions(catalog: Catalog, args: unknown): Promise<{
  pin: CatalogPin;
  totalIndexed: number;
  matched: number;
  extensions: ExtensionEntry[];
}> {
  const parsed = parseArgs(catalogSchemas.listExtensions, args);
  const index = await catalog.index();
  const matched = index.extensions.filter((entry) => {
    if (!parsed.query) return true;
    return matchesQuery(parsed.query, [entry.name, entry.fullName, entry.description]);
  });
  return {
    pin: index.pin,
    totalIndexed: index.extensions.length,
    matched: matched.length,
    extensions: matched.slice(0, parsed.limit ?? DEFAULT_LIMIT),
  };
}

export async function describeExtension(catalog: Catalog, args: unknown): Promise<{
  pin: CatalogPin;
  name: string;
  found: boolean;
  extension?: ExtensionEntry | undefined;
  hint?: string | undefined;
}> {
  const parsed = parseArgs(catalogSchemas.describeExtension, args);
  const index = await catalog.index();
  const extension = index.extensions.find((entry) => entry.name === parsed.name);
  if (extension) return { pin: index.pin, name: parsed.name, found: true, extension };
  const result: { pin: CatalogPin; name: string; found: boolean; extension?: ExtensionEntry | undefined; hint?: string | undefined } = {
    pin: index.pin,
    name: parsed.name,
    found: false,
    hint: 'Not in the pinned catalogue. Use list_extensions to discover available extension names.',
  };
  return result;
}

