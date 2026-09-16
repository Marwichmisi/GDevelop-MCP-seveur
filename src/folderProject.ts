/**
 * Folder-project split/unsplit (port fidèle de
 * `newIDE/app/src/Utils/ObjectSplitter.js` + `NewNameGenerator.js` +
 * dépendance `slugs@0.1.3`) + I/O dossier (`mkdir -p`, tmp-dotfile +
 * reparse + rename, cleanup orphelins, backup/restore).
 *
 * Le split/unsplit est du JS IDE pur, absent de `Bindings.idl`/libGD
 * (voir `docs/research/gdevelop-mcp-folder-write-research.md` §1) :
 * ce module est la seule source de vérité côté MCP.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { McpError } from './errors.js';

export const SPLITTED_FOLDER_NAMES = [
  'layouts',
  'externalLayouts',
  'externalEvents',
  'eventsFunctionsExtensions',
] as const;

export const SPLIT_PATHS_SET: ReadonlySet<string> = new Set(
  SPLITTED_FOLDER_NAMES.map((folder) => `/${folder}/*`),
);

export const REFERENCE_MAGIC_PROPERTY = '__REFERENCE_TO_SPLIT_OBJECT';
export const MAX_UNSPLIT_DEPTH = 3;

export interface PartialObject {
  reference: string;
  object: unknown;
}

export interface SplitOptions {
  pathSeparator: string;
  getArrayItemReferenceName: (object: Record<string, unknown>, currentReference: string) => string;
  shouldSplit: (path: string) => boolean;
  isReferenceMagicPropertyName: string;
}

export interface UnsplitOptions {
  isReferenceMagicPropertyName: string;
  getReferencePartialObject: (referencePath: string) => Promise<unknown>;
  maxUnsplitDepth?: number | undefined;
}

export interface UnsplitSyncOptions {
  isReferenceMagicPropertyName: string;
  getReferencePartialObjectSync: (referencePath: string) => unknown;
  maxUnsplitDepth?: number | undefined;
}

/** Port exact de `slugs@0.1.3` (`package/slugs.js`). */
export function slugify(input: string, separator = '-', preserved: string[] = ['.', '=', '-']): string {
  const escaped = preserved.map((c) => (c === '-' ? '\\-' : c === '.' ? '\\.' : c)).join('');
  let out = input.toLowerCase();
  out = out.replace(/ü/g, 'ue').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ß/g, 'ss');
  out = out.replace(new RegExp(`[${escaped}]`, 'g'), ' ');
  out = out.replace(/-{2,}/g, ' ');
  out = out.replace(/^\s\s*/, '').replace(/\s\s*$/, '');
  out = out.replace(/[^\w\ ]/gi, '');
  out = out.replace(/[ ]/gi, separator);
  return out;
}

/**
 * Slugifié pour les noms de layouts/fichiers : `slugs` + translittération
 * des accents (NFD) + repli `item` quand le slug est vide (ex. `---`).
 * `Scene One` → `scene-one`, `Événements Spéciaux!` → `evenements-speciaux`.
 */
export function slugifyName(input: string, separator = '-'): string {
  let out = input.toLowerCase();
  out = out.replace(/\u00fc/g, 'ue').replace(/\u00e4/g, 'ae').replace(/\u00f6/g, 'oe').replace(/\u00df/g, 'ss');
  out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  out = out.replace(/[.=-]/g, ' ');
  out = out.replace(/-{2,}/g, ' ');
  out = out.replace(/^\s\s*/, '').replace(/\s\s*$/, '');
  out = out.replace(/[^\w\ ]/gi, '');
  out = out.replace(/[ ]/gi, separator);
  out = out.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return out === '' ? 'item' : out;
}

/** Port de `NewNameGenerator.js` (`splitNameAndNumberSuffix` + `newNameGenerator`). */
export function splitNameAndNumberSuffix(text: string): [string, number | null] {
  for (let i = 0; i < text.length; i++) {
    const suffix = text.slice(i, text.length);
    if (suffix.startsWith('0')) continue;
    const numberSuffix = Number(suffix);
    if (numberSuffix === Math.floor(numberSuffix)) {
      return [text.slice(0, i), numberSuffix];
    }
  }
  return [text, null];
}

export function newNameGenerator(
  name: string,
  exists: (candidate: string) => boolean,
  prefix = '',
): string {
  if (!exists(name)) return name;
  if (prefix && !exists(prefix + name)) return prefix + name;
  const [radix, numberSuffix] = splitNameAndNumberSuffix(prefix + name);
  const startingNumberSuffix = numberSuffix === null ? 2 : numberSuffix + 1;
  let potentialName = radix + String(startingNumberSuffix);
  for (let i = startingNumberSuffix + 1; exists(potentialName); ++i) {
    potentialName = radix + String(i);
  }
  return potentialName;
}

export function splitPaths(paths: Set<string> | ReadonlySet<string>): (path: string) => boolean {
  return (path: string) => paths.has(path);
}

export function shouldSplitFolderPath(path: string): boolean {
  return SPLIT_PATHS_SET.has(path);
}

/** Alias attendu par la recette (`folderProject.test.js`) : même ensemble exact. */
export function shouldSplitPath(path: string): boolean {
  return shouldSplitFolderPath(path);
}

export function getNameFromProperty(
  propertyName: string,
): (object: Record<string, unknown>) => string {
  return (object: Record<string, unknown>): string => {
    const property = object[propertyName];
    if (typeof property !== 'string') {
      throw new Error(`Property ${propertyName} is not a string`);
    }
    return property;
  };
}

/** Port de `getSlugifiedUniqueNameFromProperty` (unicité scopée par dossier parent). */
export function getSlugifiedUniqueNameFromProperty(
  propertyName: string,
): (object: Record<string, unknown>, currentReference: string) => string {
  const existingNamesForReference: Record<string, Record<string, boolean>> = {};
  return (object: Record<string, unknown>, currentReference: string): string => {
    const property = object[propertyName];
    if (typeof property !== 'string') {
      throw new Error(`Property ${propertyName} is not a string`);
    }
    existingNamesForReference[currentReference] = existingNamesForReference[currentReference] ?? {};
    const taken = existingNamesForReference[currentReference] as Record<string, boolean>;
    const base = slugifyName(property);
    const newName = newNameGenerator(base, (name) => !!taken[name]);
    taken[newName] = true;
    return newName;
  };
}

/**
 * Mutate `object` pour éclater les tableaux racine listés dans `shouldSplit`.
 * Retourne les partiels `{ reference, object }` (référence sans extension,
 * ex. `/layouts/menu`). Fidèle à `ObjectSplitter.split` (mutation + récursion
 * dans les partiels pour le 2e niveau, inactif en prod car seul `/*` est demandé).
 */
export function split(
  object: Record<string, unknown>,
  options: SplitOptions,
): PartialObject[] {
  const partialObjects: PartialObject[] = [];
  const { pathSeparator, getArrayItemReferenceName, shouldSplit, isReferenceMagicPropertyName } = options;

  const createReference = (reference: string, target: unknown): Record<string, unknown> => {
    partialObjects.push({ reference, object: target });
    return { [isReferenceMagicPropertyName]: true, referenceTo: reference };
  };

  const splitObject = (currentObject: unknown, currentPath: string, currentReference: string): void => {
    if (currentObject === null || typeof currentObject !== 'object') return;
    if (Array.isArray(currentObject)) {
      for (const index in currentObject) {
        const itemPath = currentPath + pathSeparator + '*';
        if (shouldSplit(itemPath)) {
          const partialObject = (currentObject as unknown[])[index];
          const name = getArrayItemReferenceName(
            partialObject as Record<string, unknown>,
            currentReference,
          );
          const itemReference = currentReference + pathSeparator + name;
          (currentObject as unknown[])[index] = createReference(itemReference, partialObject);
          splitObject(partialObject, itemPath, itemReference);
        } else {
          const itemReference = currentReference + pathSeparator + index;
          splitObject((currentObject as unknown[])[index], itemPath, itemReference);
        }
      }
      return;
    }
    const record = currentObject as Record<string, unknown>;
    for (const propertyName in record) {
      const propertyPath = currentPath + pathSeparator + propertyName;
      const propertyReference = currentReference + pathSeparator + propertyName;
      if (shouldSplit(propertyPath)) {
        const partialObject = record[propertyName];
        record[propertyName] = createReference(propertyReference, partialObject);
        splitObject(partialObject, propertyPath, propertyReference);
      } else {
        splitObject(record[propertyName], propertyPath, propertyReference);
      }
    }
  };

  splitObject(object, '', '');
  return partialObjects;
}

function isReferenceNode(value: unknown, magic: string): { referenceTo: string } | null {
  if (value !== null && typeof value === 'object' && (value as Record<string, unknown>)[magic] === true) {
    return value as { referenceTo: string };
  }
  return null;
}

/**
 * Version async fidèle à l'IDE (`Promise.all` par niveau, cutoff `depth >= max`).
 * Mutates `object` en place.
 */
export async function unsplit(object: unknown, options: UnsplitOptions): Promise<void> {
  const { isReferenceMagicPropertyName, getReferencePartialObject, maxUnsplitDepth } = options;

  const unsplitObject = async (currentObject: unknown, depth: number): Promise<void> => {
    if (maxUnsplitDepth !== undefined && depth >= maxUnsplitDepth) return;
    if (currentObject === null || typeof currentObject !== 'object') return;
    const keys = Object.keys(currentObject);
    if (!keys) return;
    await Promise.all(
      keys.map(async (key) => {
        const child = (currentObject as Record<string, unknown>)[key];
        const reference = isReferenceNode(child, isReferenceMagicPropertyName);
        if (reference) {
          let partial: unknown;
          try {
            partial = await getReferencePartialObject(reference.referenceTo);
          } catch (error) {
            throw new Error(`Can't find ${reference.referenceTo}: ${(error as Error).message}`);
          }
          (currentObject as Record<string, unknown>)[key] = partial;
          await unsplitObject((currentObject as Record<string, unknown>)[key], depth + 1);
          return;
        }
        await unsplitObject(child, depth + 1);
      }),
    );
  };

  await unsplitObject(object, 0);
}

/** Variante sync pour `ProjectStore.open` (lecture `readFileSync`, même cutoff). */
export function unsplitSync(object: unknown, options: UnsplitSyncOptions): void {
  const { isReferenceMagicPropertyName, getReferencePartialObjectSync, maxUnsplitDepth } = options;

  const unsplitObject = (currentObject: unknown, depth: number): void => {
    if (maxUnsplitDepth !== undefined && depth >= maxUnsplitDepth) return;
    if (currentObject === null || typeof currentObject !== 'object') return;
    for (const key of Object.keys(currentObject)) {
      const child = (currentObject as Record<string, unknown>)[key];
      const reference = isReferenceNode(child, isReferenceMagicPropertyName);
      if (reference) {
        let partial: unknown;
        try {
          partial = getReferencePartialObjectSync(reference.referenceTo);
        } catch (error) {
          throw new Error(`Can't find ${reference.referenceTo}: ${(error as Error).message}`);
        }
        (currentObject as Record<string, unknown>)[key] = partial;
        unsplitObject((currentObject as Record<string, unknown>)[key], depth + 1);
        continue;
      }
      unsplitObject(child, depth + 1);
    }
  };

  unsplitObject(object, 0);
}

/** Options canoniques du folder-project (mêmes des deux côtés, voir §2 de la recherche). */
export function folderSplitOptions(): SplitOptions {
  return {
    pathSeparator: '/',
    getArrayItemReferenceName: getSlugifiedUniqueNameFromProperty('name'),
    shouldSplit: shouldSplitFolderPath,
    isReferenceMagicPropertyName: REFERENCE_MAGIC_PROPERTY,
  };
}

/** Alias recette : `splitProjectObject(project, options)` = `split` (mute + retourne les partiels). */
export function splitProjectObject(
  object: Record<string, unknown>,
  options: SplitOptions,
): PartialObject[] {
  return split(object, options);
}

/** Alias recette : `unsplitProjectObject` async = `unsplit` (Promise.all par niveau, cutoff). */
export async function unsplitProjectObject(object: unknown, options: UnsplitOptions): Promise<void> {
  await unsplit(object, options);
}

/** Détecte un JSON principal folder (flag `properties.folderProject`). */
export function isFolderProjectJson(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const properties = (parsed as { properties?: unknown }).properties;
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return false;
  return (properties as { folderProject?: unknown }).folderProject === true;
}

/** Détecte une référence split résiduelle (utile quand le flag ment). */
export function containsSplitReference(value: unknown, magic = REFERENCE_MAGIC_PROPERTY): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (isReferenceNode(value, magic) !== null) return true;
  return Object.values(value).some((child) => containsSplitReference(child, magic));
}

// --- I/O dossier (port de LocalProjectWriter.js + open_project.mjs, combinés) ---

/** Écriture JSON formatée (`stringify 2` + `\n` final) atomique : mkdir-p + tmp + reparse + rename. */
export function writeFormattedJsonSync(object: unknown, filePath: string): void {
  if (object === undefined) {
    throw new McpError('io-error', `Cannot write ${filePath}: content is empty.`);
  }
  const content = `${JSON.stringify(object, null, 2)}\n`;
  if (content === '') {
    throw new McpError('io-error', `Cannot write ${filePath}: content is empty.`);
  }
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch (error) {
    throw new McpError('io-error', `Cannot create directory for ${filePath}.`, { cause: error });
  }
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmpPath, content, 'utf8');
    const roundTrip = readFileSync(tmpPath, 'utf8');
    if (roundTrip === '') {
      throw new Error('Written file is empty, did the write fail?');
    }
    JSON.parse(roundTrip);
    if (roundTrip !== content) {
      throw new Error('Written file is not containing the expected content, did the write fail?');
    }
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best effort.
    }
    if (error instanceof McpError) throw error;
    throw new McpError('io-error', `Atomic save to ${filePath} failed.`, { cause: error });
  }
}

/**
 * Supprime les fichiers des 4 dossiers éclatés avant réécriture
 * (`deleteExistingFilesFromDirs`, best-effort warn comme l'IDE).
 */
export function deleteExistingFilesFromDirsSync(projectDir: string): void {
  for (const entry of SPLITTED_FOLDER_NAMES) {
    const dirPath = join(projectDir, entry);
    let stat;
    try {
      stat = statSync(dirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let filenames: string[];
    try {
      filenames = readdirSync(dirPath);
    } catch (error) {
      console.warn('Unable to clean project folder before saving project: ', error);
      continue;
    }
    for (const file of filenames) {
      const full = join(dirPath, file);
      try {
        const child = statSync(full);
        if (!child.isFile()) continue;
        unlinkSync(full);
      } catch (error) {
        console.warn('Unable to clean project folder before saving project: ', error);
      }
    }
  }
}

/** Liste le main + tous les partiels existants (pour backup/restore). */
export function listFolderProjectFilesSync(projectDir: string, main: string): string[] {
  const found: string[] = [];
  if (existsSync(main)) found.push(main);
  for (const entry of SPLITTED_FOLDER_NAMES) {
    const dirPath = join(projectDir, entry);
    let stat;
    try {
      stat = statSync(dirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const file of readdirSync(dirPath)) {
      const full = join(dirPath, file);
      try {
        if (statSync(full).isFile()) found.push(full);
      } catch {
        continue;
      }
    }
  }
  return found;
}

/** Copie l'état dossier (main + partiels) vers un dossier backup (mkdir-p). */
export function backupFolderSync(projectDir: string, main: string, backupDir: string): string[] {
  const files = listFolderProjectFilesSync(projectDir, main);
  mkdirSync(backupDir, { recursive: true });
  const copied: string[] = [];
  for (const file of files) {
    const rel = relative(projectDir, file);
    // Le main vit dans projectDir : rel = basename ; les partiels : layouts/x.json.
    const dest = rel.startsWith('..') || rel === '' ? join(backupDir, 'game.json') : join(backupDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file, dest);
    copied.push(file);
  }
  // Toujours copier le main même s'il manque ? Non : absent = rien à restaurer.
  return copied;
}

/** Restaure un dossier backup vers le projet (cleanup préalable + copie). */
export function restoreFolderSync(backupDir: string, projectDir: string, main: string): void {
  deleteExistingFilesFromDirsSync(projectDir);
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) out.push(...walk(full));
        else if (st.isFile()) out.push(full);
      } catch {
        continue;
      }
    }
    return out;
  };
  for (const backupFile of walk(backupDir)) {
    const rel = relative(backupDir, backupFile);
    const dest = rel === 'game.json' && !rel.includes(sep) ? main : join(projectDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(backupFile, dest);
  }
}
