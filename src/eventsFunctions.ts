import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { slugifyName } from './folderProject.js';

/**
 * Port Node sync de `LocalEventsFunctionCodeWriter.js` +
 * `EventsFunctionsExtensionsLoader/index.js` (deux passes, voir
 * `docs/research/gdevelop-mcp-folder-write-research.md` §6–§8).
 *
 * Sources primaires : `newIDE/app/src/EventsFunctionsExtensionsLoader/index.js`
 * (L41–74 deux passes, L94–118 par-extension, L318–408 free, L452–518 behavior,
 * L555–621 object, L662–672 unload), `CodeWriters/LocalEventsFunctionCodeWriter.js`
 * (L34–52 outputDir + slug, L53–104 writers), `Bindings.idl`
 * (MetadataDeclarationHelper L4579+, Behavior/Object/EventsFunctionsExtensionCodeGenerator).
 */

export interface NodeCodeWriter {
  getIncludeFileFor(codeNamespace: string): string;
  writeFunctionCode(functionName: string, code: string): void;
  writeBehaviorCode(behaviorName: string, code: string): void;
  writeObjectCode(objectName: string, code: string): void;
}

export function makeNodeEventsFunctionCodeWriter(options: {
  outputDir?: string | undefined;
  onWriteFile?: ((info: { includeFile: string; content: string }) => void) | undefined;
} = {}): NodeCodeWriter {
  const outputDir = options.outputDir ?? join(tmpdir(), `GDGeneratedEventsFunctions-${randomUUID()}`);
  try {
    mkdirSync(outputDir, { recursive: true });
  } catch (error) {
    console.error('Unable to create the directory where to output events functions generated code: ', error);
  }
  const getPathFor = (codeNamespace: string): string => join(outputDir, `${slugifyName(codeNamespace)}.js`);
  const onWriteFile = options.onWriteFile ?? ((): void => {});
  const writeSync = (namespace: string, code: string): void => {
    const includeFile = getPathFor(namespace);
    onWriteFile({ includeFile, content: code });
    writeFileSync(includeFile, code, 'utf8');
  };
  return {
    getIncludeFileFor: getPathFor,
    writeFunctionCode: (functionName: string, code: string): void => {
      writeSync(functionName, code);
    },
    writeBehaviorCode: (behaviorName: string, code: string): void => {
      writeSync(behaviorName, code);
    },
    writeObjectCode: (objectName: string, code: string): void => {
      writeSync(objectName, code);
    },
  };
}

export function identityI18n(text: string): string {
  return text;
}

interface GdLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

function getExtensionIncludeFiles(gd: GdLike, project: GdLike, extension: GdLike, codeWriter: NodeCodeWriter): string[] {
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

function generateFreeFunctionMetadata(
  gd: GdLike,
  project: GdLike,
  platformExtension: GdLike,
  eventsExtension: GdLike,
  eventsFunction: GdLike,
  codeWriter: NodeCodeWriter,
  extensionIncludeFiles: string[],
  helper: GdLike,
): GdLike {
  const metadata = helper.generateFreeFunctionMetadata(
    project,
    platformExtension,
    eventsExtension,
    eventsFunction,
  ) as GdLike;
  const functionName = gd.MetadataDeclarationHelper.getFreeFunctionCodeName(
    eventsExtension,
    eventsFunction,
  ) as string;
  metadata.addIncludeFile(codeWriter.getIncludeFileFor(functionName));
  for (const include of extensionIncludeFiles) metadata.addIncludeFile(include);
  return metadata;
}

function generateBehaviorMetadata(
  gd: GdLike,
  project: GdLike,
  platformExtension: GdLike,
  eventsExtension: GdLike,
  behavior: GdLike,
  codeWriter: NodeCodeWriter,
  extensionIncludeFiles: string[],
  mangled: GdLike,
): GdLike {
  const metadata = gd.MetadataDeclarationHelper.generateBehaviorMetadata(
    project,
    platformExtension,
    eventsExtension,
    behavior,
    mangled,
  ) as GdLike;
  const namespace = gd.MetadataDeclarationHelper.getBehaviorFunctionCodeNamespace(
    behavior,
    gd.MetadataDeclarationHelper.getExtensionCodeNamespacePrefix(eventsExtension),
  ) as string;
  metadata.addIncludeFile(codeWriter.getIncludeFileFor(namespace));
  for (const include of extensionIncludeFiles) metadata.addIncludeFile(include);
  return metadata;
}

function generateObjectMetadata(
  gd: GdLike,
  project: GdLike,
  platformExtension: GdLike,
  eventsExtension: GdLike,
  customObject: GdLike,
  codeWriter: NodeCodeWriter,
  extensionIncludeFiles: string[],
  mangled: GdLike,
): GdLike {
  const metadata = gd.MetadataDeclarationHelper.generateObjectMetadata(
    project,
    platformExtension,
    eventsExtension,
    customObject,
    mangled,
  ) as GdLike;
  const namespace = gd.MetadataDeclarationHelper.getObjectFunctionCodeNamespace(
    customObject,
    gd.MetadataDeclarationHelper.getExtensionCodeNamespacePrefix(eventsExtension),
  ) as string;
  metadata.addIncludeFile(codeWriter.getIncludeFileFor(namespace));
  for (const include of extensionIncludeFiles) metadata.addIncludeFile(include);
  return metadata;
}

function generateSingleExtension(
  gd: GdLike,
  project: GdLike,
  eventsExtension: GdLike,
  codeWriter: NodeCodeWriter,
  skipCodeGeneration: boolean,
): GdLike {
  const platformExtension = new gd.PlatformExtension();
  try {
    gd.MetadataDeclarationHelper.declareExtension(platformExtension, eventsExtension);
    const codeNamespacePrefix = gd.MetadataDeclarationHelper.getExtensionCodeNamespacePrefix(
      eventsExtension,
    ) as string;
    const extensionIncludeFiles = getExtensionIncludeFiles(gd, project, eventsExtension, codeWriter);
    const context = { codeNamespacePrefix, extensionIncludeFiles };

    // Behaviors.
    const behaviors = eventsExtension.getEventsBasedBehaviors();
    const behaviorCount = behaviors.getCount() as number;
    for (let i = 0; i < behaviorCount; i++) {
      const behavior = behaviors.getAt(i);
      const mangled = new gd.MapStringString();
      try {
        const metadata = generateBehaviorMetadata(
          gd,
          project,
          platformExtension,
          eventsExtension,
          behavior,
          codeWriter,
          context.extensionIncludeFiles,
          mangled,
        );
        if (!skipCodeGeneration) {
          const codeNamespace = gd.MetadataDeclarationHelper.getBehaviorFunctionCodeNamespace(
            behavior,
            context.codeNamespacePrefix,
          ) as string;
          const includeFiles = new gd.SetString();
          const generator = new gd.BehaviorCodeGenerator(project);
          try {
            const code = generator.generateRuntimeBehaviorCompleteCode(
              eventsExtension,
              behavior,
              codeNamespace,
              mangled,
              includeFiles,
              true,
            ) as string;
            for (const include of includeFiles.toNewVectorString().toJSArray() as string[]) {
              metadata.addIncludeFile(include);
            }
            codeWriter.writeBehaviorCode(codeNamespace, code);
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
    const objectCount = customObjects.getCount() as number;
    for (let i = 0; i < objectCount; i++) {
      const customObject = customObjects.getAt(i);
      const mangled = new gd.MapStringString();
      try {
        const metadata = generateObjectMetadata(
          gd,
          project,
          platformExtension,
          eventsExtension,
          customObject,
          codeWriter,
          context.extensionIncludeFiles,
          mangled,
        );
        if (!skipCodeGeneration) {
          const codeNamespace = gd.MetadataDeclarationHelper.getObjectFunctionCodeNamespace(
            customObject,
            context.codeNamespacePrefix,
          ) as string;
          const includeFiles = new gd.SetString();
          const generator = new gd.ObjectCodeGenerator(project);
          try {
            const code = generator.generateRuntimeObjectCompleteCode(
              eventsExtension,
              customObject,
              codeNamespace,
              mangled,
              includeFiles,
              true,
            ) as string;
            for (const include of includeFiles.toNewVectorString().toJSArray() as string[]) {
              metadata.addIncludeFile(include);
            }
            codeWriter.writeObjectCode(codeNamespace, code);
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
    const helper = new gd.MetadataDeclarationHelper();
    try {
      const container = eventsExtension.getEventsFunctions();
      const fnCount = container.getEventsFunctionsCount() as number;
      for (let i = 0; i < fnCount; i++) {
        const fn = container.getEventsFunctionAt(i);
        let functionMetadata: GdLike;
        try {
          functionMetadata = generateFreeFunctionMetadata(
            gd,
            project,
            platformExtension,
            eventsExtension,
            fn,
            codeWriter,
            context.extensionIncludeFiles,
            helper,
          );
        } catch (error) {
          console.error(
            `[EventsFunctionsExtensionsLoader] Failed to generate metadata for free function "${eventsExtension.getName()}::${fn.getName()}":`,
            error,
          );
          throw error;
        }
        if (!skipCodeGeneration) {
          const includeFiles = new gd.SetString();
          const generator = new gd.EventsFunctionsExtensionCodeGenerator(project);
          const codeNamespace = gd.MetadataDeclarationHelper.getFreeFunctionCodeNamespace(
            fn,
            context.codeNamespacePrefix,
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
          const functionName = gd.MetadataDeclarationHelper.getFreeFunctionCodeName(
            eventsExtension,
            fn,
          ) as string;
          codeWriter.writeFunctionCode(functionName, code);
        }
      }
    } finally {
      helper.delete();
    }

    const out = platformExtension;
    // Transfer ownership: caller adds + deletes. Prevent finally from deleting.
    return out;
  } catch (error) {
    try {
      platformExtension.delete();
    } catch {
      // Best effort.
    }
    throw error;
  }
}

/**
 * Charge toutes les events-functions d'un projet (2 passes, sync).
 * `skipCodeGeneration=true` d'abord (métadonnées seules, car les fonctions
 * peuvent s'utiliser entre elles), puis `false` (métadonnées + code).
 * Enregistre chaque extension sur `gd.JsPlatform` (`addNewExtension` + `delete`),
 * throw avec phase `metadata|codegen` en cas d'échec (comme l'IDE).
 */
export function loadProjectEventsFunctionsExtensionsSync(
  gd: GdLike,
  project: GdLike,
  codeWriter: NodeCodeWriter = makeNodeEventsFunctionCodeWriter({ onWriteFile: () => {} }),
  i18n: (text: string) => string = identityI18n,
): void {
  void i18n;
  const count = project.getEventsFunctionsExtensionsCount() as number;
  for (const skipCodeGeneration of [true, false]) {
    for (let i = 0; i < count; i++) {
      const eventsExtension = project.getEventsFunctionsExtensionAt(i);
      const extensionName = eventsExtension.getName() as string;
      const phase = skipCodeGeneration ? 'metadata' : 'codegen';
      let platformExtension: GdLike | null = null;
      try {
        platformExtension = generateSingleExtension(gd, project, eventsExtension, codeWriter, skipCodeGeneration);
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
export function unloadProjectEventsFunctionsExtensionsSync(gd: GdLike, project: GdLike): void {
  const count = project.getEventsFunctionsExtensionsCount() as number;
  for (let i = 0; i < count; i++) {
    const name = project.getEventsFunctionsExtensionAt(i).getName() as string;
    gd.JsPlatform.get().removeExtension(name);
  }
}
