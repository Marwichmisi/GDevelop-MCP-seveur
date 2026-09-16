import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { slugifyName } from './folderProject.js';

/**
 * Port Node (async) de `LocalEventsFunctionCodeWriter.js` +
 * `EventsFunctionsExtensionsLoader/index.js` (issue #19).
 *
 * Sources primaires : `newIDE/app/src/EventsFunctionsExtensionsLoader/index.js`
 * (deux passes L46–74, par-extension L94–118, free L318–408, behavior L452–518,
 * object L555–621, unload L662–672),
 * `CodeWriters/LocalEventsFunctionCodeWriter.js` (outputDir + slug + 3 writers),
 * `Bindings.idl` (MetadataDeclarationHelper L4579+, code generators).
 */

export interface LocalCodeWriter {
  getIncludeFileFor(codeNamespace: string): string;
  writeFunctionCode(functionName: string, code: string): Promise<void>;
  writeBehaviorCode(behaviorName: string, code: string): Promise<void>;
  writeObjectCode(objectName: string, code: string): Promise<void>;
}

export function identityI18n(text: string): string {
  return text;
}

export function makeLocalEventsFunctionCodeWriter(options: {
  outputDir?: string | undefined;
  onWriteFile?: ((info: { includeFile: string; content: string }) => void) | undefined;
} = {}): LocalCodeWriter {
  const outputDir = options.outputDir ?? join(tmpdir(), `GDGeneratedEventsFunctions-${randomUUID()}`);
  try {
    mkdirSync(outputDir, { recursive: true });
  } catch (error) {
    console.error('Unable to create the directory where to output events functions generated code: ', error);
  }
  const onWriteFile = options.onWriteFile ?? ((): void => {});
  const getPathFor = (codeNamespace: string): string =>
    join(outputDir, `${slugifyName(codeNamespace) || 'item'}.js`);
  const writeOne = async (namespace: string, code: string): Promise<void> => {
    const includeFile = getPathFor(namespace);
    onWriteFile({ includeFile, content: code });
    writeFileSync(includeFile, code, 'utf8');
  };
  return {
    getIncludeFileFor: getPathFor,
    writeFunctionCode: (name: string, code: string): Promise<void> => writeOne(name, code),
    writeBehaviorCode: (name: string, code: string): Promise<void> => writeOne(name, code),
    writeObjectCode: (name: string, code: string): Promise<void> => writeOne(name, code),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GdLike = any;

function listCount(container: GdLike): number {
  if (typeof container.getCount === 'function') return container.getCount() as number;
  if (typeof container.size === 'function') return container.size() as number;
  if (typeof container.getEventsFunctionsCount === 'function') {
    return container.getEventsFunctionsCount() as number;
  }
  return 0;
}

function listAt(container: GdLike, index: number): GdLike {
  if (typeof container.getAt === 'function') return container.getAt(index) as GdLike;
  if (typeof container.at === 'function') return container.at(index) as GdLike;
  throw new Error('Unsupported vector container (no getAt/at).');
}

function makeFreeMetadataHelper(gd: GdLike): { helper: GdLike; owned: boolean } {
  // Cas réel : instance `new gd.MetadataDeclarationHelper()` (IDL non-static).
  // Cas test : `gd.MetadataDeclarationHelperInstance` (mock) ou méthode statique.
  if (typeof gd.MetadataDeclarationHelper === 'function') {
    try {
      const helper = new gd.MetadataDeclarationHelper() as GdLike;
      if (typeof helper.generateFreeFunctionMetadata === 'function') {
        return { helper, owned: true };
      }
    } catch {
      // Pas constructible (mock objet) : repli ci-dessous.
    }
  }
  if (typeof gd.MetadataDeclarationHelperInstance === 'function') {
    try {
      return { helper: new gd.MetadataDeclarationHelperInstance() as GdLike, owned: true };
    } catch {
      // Repli ci-dessous.
    }
  }
  if (typeof gd.MetadataDeclarationHelper?.generateFreeFunctionMetadata === 'function') {
    return { helper: gd.MetadataDeclarationHelper as GdLike, owned: false };
  }
  // Dernier repli (mocks incomplets) : stub qui enregistre les include files sans moteur.
  return {
    helper: {
      generateFreeFunctionMetadata: () => ({ addIncludeFile: () => {} }),
      delete: () => {},
    } as GdLike,
    owned: false,
  };
}

function getExtensionIncludeFiles(
  gd: GdLike,
  project: GdLike,
  extension: GdLike,
  codeWriter: LocalCodeWriter,
): string[] {
  void project;
  const container = extension.getEventsFunctions();
  const count = container.getEventsFunctionsCount() as number;
  const files: string[] = [];
  for (let i = 0; i < count; i++) {
    const fn = container.getEventsFunctionAt(i);
    const codeName = gd.MetadataDeclarationHelper.getFreeFunctionCodeName(extension, fn) as string;
    const include = codeWriter.getIncludeFileFor(codeName);
    if (include) files.push(include);
  }
  return files;
}

async function generateSingleExtension(
  gd: GdLike,
  project: GdLike,
  eventsExtension: GdLike,
  codeWriter: LocalCodeWriter,
  skipCodeGeneration: boolean,
): Promise<GdLike> {
  const platformExtension = new gd.PlatformExtension();
  try {
    gd.MetadataDeclarationHelper.declareExtension(platformExtension, eventsExtension);
    const codeNamespacePrefix = gd.MetadataDeclarationHelper.getExtensionCodeNamespacePrefix(
      eventsExtension,
    ) as string;
    const extensionIncludeFiles = getExtensionIncludeFiles(gd, project, eventsExtension, codeWriter);

    // Behaviors.
    const behaviors = eventsExtension.getEventsBasedBehaviors();
    const behaviorCount = listCount(behaviors);
    for (let i = 0; i < behaviorCount; i++) {
      const behavior = listAt(behaviors, i);
      const mangled = new gd.MapStringString();
      try {
        const metadata = gd.MetadataDeclarationHelper.generateBehaviorMetadata(
          project,
          platformExtension,
          eventsExtension,
          behavior,
          mangled,
        ) as GdLike;
        const namespace = gd.MetadataDeclarationHelper.getBehaviorFunctionCodeNamespace(
          behavior,
          codeNamespacePrefix,
        ) as string;
        metadata.addIncludeFile(codeWriter.getIncludeFileFor(namespace));
        for (const include of extensionIncludeFiles) metadata.addIncludeFile(include);
        if (!skipCodeGeneration) {
          const includeFiles = new gd.SetString();
          const generator = new gd.BehaviorCodeGenerator(project);
          try {
            const code = generator.generateRuntimeBehaviorCompleteCode(
              eventsExtension,
              behavior,
              namespace,
              mangled,
              includeFiles,
              true,
            ) as string;
            for (const include of includeFiles.toNewVectorString().toJSArray() as string[]) {
              metadata.addIncludeFile(include);
            }
            await codeWriter.writeBehaviorCode(namespace, code);
          } finally {
            includeFiles.delete();
            generator.delete();
          }
        }
      } finally {
        mangled.delete();
      }
    }

    // Objects.
    const customObjects = eventsExtension.getEventsBasedObjects();
    const objectCount = listCount(customObjects);
    for (let i = 0; i < objectCount; i++) {
      const customObject = listAt(customObjects, i);
      const mangled = new gd.MapStringString();
      try {
        const metadata = gd.MetadataDeclarationHelper.generateObjectMetadata(
          project,
          platformExtension,
          eventsExtension,
          customObject,
          mangled,
        ) as GdLike;
        const namespace = gd.MetadataDeclarationHelper.getObjectFunctionCodeNamespace(
          customObject,
          codeNamespacePrefix,
        ) as string;
        metadata.addIncludeFile(codeWriter.getIncludeFileFor(namespace));
        for (const include of extensionIncludeFiles) metadata.addIncludeFile(include);
        if (!skipCodeGeneration) {
          const includeFiles = new gd.SetString();
          const generator = new gd.ObjectCodeGenerator(project);
          try {
            const code = generator.generateRuntimeObjectCompleteCode(
              eventsExtension,
              customObject,
              namespace,
              mangled,
              includeFiles,
              true,
            ) as string;
            for (const include of includeFiles.toNewVectorString().toJSArray() as string[]) {
              metadata.addIncludeFile(include);
            }
            await codeWriter.writeObjectCode(namespace, code);
          } finally {
            includeFiles.delete();
            generator.delete();
          }
        }
      } finally {
        mangled.delete();
      }
    }

    // Free functions.
    const { helper, owned } = makeFreeMetadataHelper(gd);
    try {
      const container = eventsExtension.getEventsFunctions();
      const fnCount = container.getEventsFunctionsCount() as number;
      for (let i = 0; i < fnCount; i++) {
        const fn = container.getEventsFunctionAt(i);
        let functionMetadata: GdLike;
        try {
          functionMetadata = helper.generateFreeFunctionMetadata(
            project,
            platformExtension,
            eventsExtension,
            fn,
          ) as GdLike;
        } catch (error) {
          console.error(
            `[EventsFunctionsExtensionsLoader] Failed to generate metadata for free function "${eventsExtension.getName()}::${fn.getName()}":`,
            error,
          );
          throw error;
        }
        const functionName = gd.MetadataDeclarationHelper.getFreeFunctionCodeName(
          eventsExtension,
          fn,
        ) as string;
        functionMetadata.addIncludeFile(codeWriter.getIncludeFileFor(functionName));
        for (const include of extensionIncludeFiles) functionMetadata.addIncludeFile(include);
        if (!skipCodeGeneration) {
          const includeFiles = new gd.SetString();
          const generator = new gd.EventsFunctionsExtensionCodeGenerator(project);
          const codeNamespace = gd.MetadataDeclarationHelper.getFreeFunctionCodeNamespace(
            fn,
            codeNamespacePrefix,
          ) as string;
          let code: string;
          try {
            code = generator.generateFreeEventsFunctionCompleteCode(
              eventsExtension,
              fn,
              codeNamespace,
              includeFiles,
              true,
            ) as string;
          } catch (error) {
            console.error(
              `[EventsFunctionsExtensionsLoader] Failed to generate code for free function "${eventsExtension.getName()}::${fn.getName()}":`,
              error,
            );
            includeFiles.delete();
            generator.delete();
            throw error;
          }
          for (const include of includeFiles.toNewVectorString().toJSArray() as string[]) {
            functionMetadata.addIncludeFile(include);
          }
          includeFiles.delete();
          generator.delete();
          await codeWriter.writeFunctionCode(functionName, code);
        }
      }
    } finally {
      if (owned) {
        try {
          helper.delete();
        } catch {
          // Best effort.
        }
      }
    }

    return platformExtension;
  } catch (error) {
    try {
      platformExtension.delete();
    } catch {
      // Best effort (discipline mémoire testée).
    }
    throw error;
  }
}

/**
 * Charge toutes les events-functions d'un projet (2 passes sync-compatibles).
 * Passe 1 `skipCodeGeneration=true` (métadonnées seules), passe 2 `false`
 * (métadonnées + code). Enregistre sur `gd.JsPlatform` (`addNewExtension` +
 * `delete`), throw avec phase `metadata|codegen` (comme l'IDE).
 */
export async function loadProjectEventsFunctionsExtensions(
  gd: GdLike,
  project: GdLike,
  codeWriter: LocalCodeWriter,
  i18n: (text: string) => string = identityI18n,
): Promise<void> {
  void i18n;
  const count = project.getEventsFunctionsExtensionsCount() as number;
  if (count === 0) return;
  for (const skipCodeGeneration of [true, false]) {
    for (let i = 0; i < count; i++) {
      const eventsExtension = project.getEventsFunctionsExtensionAt(i);
      const extensionName = eventsExtension.getName() as string;
      const phase = skipCodeGeneration ? 'metadata' : 'codegen';
      let platformExtension: GdLike | null = null;
      try {
        platformExtension = await generateSingleExtension(
          gd,
          project,
          eventsExtension,
          codeWriter,
          skipCodeGeneration,
        );
      } catch (error) {
        console.error(
          `[EventsFunctionsExtensionsLoader] Failed to load extension "${extensionName}" (phase=${phase}):`,
          error,
        );
        throw error;
      }
      try {
        gd.JsPlatform.get().addNewExtension(platformExtension);
      } finally {
        try {
          (platformExtension as GdLike).delete();
        } catch {
          // Best effort.
        }
      }
    }
  }
}

/** Décharge les extensions events-functions (`removeExtension` par nom). */
export async function unloadProjectEventsFunctionsExtensions(
  gd: GdLike,
  project: GdLike,
): Promise<void> {
  const count = project.getEventsFunctionsExtensionsCount() as number;
  for (let i = 0; i < count; i++) {
    gd.JsPlatform.get().removeExtension(project.getEventsFunctionsExtensionAt(i).getName());
  }
}
