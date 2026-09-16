# Folder-project write (split save + unsplit load) — recherche primaire (issue #19)

> Portée : comment implémenter correctement en Node.js via libGD.js (GDevelop.js) le
> save split d'un `gd.Project` folder-project et le load unsplit, plus le chargement
> des events-functions extensions via `loadProjectEventsFunctionsExtensions(project,
> codeWriter, i18n)`. Chaque affirmation factuelle ci-dessous cite la source primaire
> qui la porte (URL + fichier/ligne), ou le binaire pinné local quand il fait foi.
>
> Recherche menée le 2026-09-16. Sources pinnées : `4ian/GDevelop@master`
> commit `43b3e42236dbe991745bfe3705c788f7ba06c032` (message « Fix condition
> hasJustBeenDragged… (#9107) » — `https://api.github.com/repos/4ian/GDevelop/commits/master`,
> vérifié 2026-09-16) ; `arthuro555/gdcore-tools@master` commit
> `e4bf45e9c332802f770db7a15f0dd8d821d0751f` (même API, vérifié 2026-09-16) ;
> `982945902/gdevelop-mcp-server@main` commit `96ed51ea081beedd7f6948b5516083c5f8fb3c63`
> (vérifié 2026-09-16) ; binaire local `vendor/libGD.js` (pin `master/latest`,
> sha256 js `0dc7920526d191ac0b1ee896dce166a8b175896aa887c7f42315d5c4891a2219`,
> wasm `e4f49a5a630949aa9bc31ba4601cdca7cd81dad9d4cf77cb54d85d11c5301c2a` —
> `vendor/libgd-pin.json`). État local : `src/sessions.ts` refuse les dossiers
> (`folder-project-unsupported`), `src/commands.ts` save mono-fichier atomique,
> `src/runtime.ts` expose `createRealEngine` sans split/unsplit ni codeWriter.
> URLs non résolues (exclues, voir §14) : `Core/GDCore/Project/ObjectSplitter.*`,
> `Core/GDCore/Project/ProjectFileWriter.*` (404 — le splitter est JS-only).

## 0. Cadrage (#19)

- L'issue #19 demande le write folder-project : « split save + unsplit load » (source :
  titre de l'issue — `https://github.com/Marwichmisi/GDevelop-MCP-seveur/issues/19`).
- Le repo local prouve le round-trip single-file mais laisse la question folder ouverte :
  `docs/research/gdevelop-mcp-libgd-research.md` §1.3 dit « Open (folder project —
  REQUIRED for parity)… Neither reference server does this » et §7 Q1–Q2 listent
  « Folder-project write path » et « Events-functions extensions in Node » comme spikes
  (source : `docs/research/gdevelop-mcp-libgd-research.md` L93, L501–506).
- `CONTEXT.md` définit « Folder-project : projet stocké en dossier, scènes et extensions
  éclatées en fichiers avec références, chargé par unsplit » (source : `CONTEXT.md` L59–61).

---

## 1. API map : `split`/`unsplit` sont du JS IDE, pas du C++ libGD

- `Bindings.idl` (4643 lignes, contrat WebIDL) n'expose ni `ObjectSplitter`, ni `split`,
  ni `unsplit` : `rg "ObjectSplitter|unsplit"` ne retourne rien, `Serializer` n'a que
  `STATIC_ToJSON/STATIC_FromJSON` + `SetCanonicalMode` (source :
  `https://github.com/4ian/GDevelop/blob/master/GDevelop.js/Bindings/Bindings.idl`
  L1712–1719 ; vérification locale `rg` sur copie du 2026-09-16).
- `gd.Serializer.fromJSObject` / `toJSObject` ne viennent pas de l'IDL mais de
  `postjs.js` : `elementFromJSObject` récursif (number→`setDoubleValue`,
  string→`setStringValue`, boolean→`setBoolValue`, array→`considerAsArray`+`addChild('')`,
  object→`addChild(name)`) puis `gd.Serializer.fromJSObject = object => { element =
  new gd.SerializerElement(); elementFromJSObject(object, element); return element; }`
  (source : `https://github.com/4ian/GDevelop/blob/master/GDevelop.js/Bindings/postjs.js`
  §« Add gd.Serializer.fromJSObject which is much faster… »).
- Le renommage PascalCase→camelCase (`STATIC_`→statique, `FREE_`→module, `MAP_`/`WRAPPED_`
  strip, `CLONE_`→`clone`) est fait par `adaptNamingConventions` dans le même `postjs.js`
  (source : `.../GDevelop.js/Bindings/postjs.js` L1–60).
- `split`/`unsplit`/`getSlugifiedUniqueNameFromProperty` vivent dans
  `newIDE/app/src/Utils/ObjectSplitter.js` (232 lignes, Flow) (source :
  `https://github.com/4ian/GDevelop/blob/master/newIDE/app/src/Utils/ObjectSplitter.js`).
- `gdcore-tools` ne les réimplémente pas : son `build/loaders.mjs` les ré-exporte depuis
  le checkout GDevelop : `export { split, unsplit, getSlugifiedUniqueNameFromProperty }
  from "../../GDevelop/newIDE/app/src/Utils/ObjectSplitter"` (source :
  `https://github.com/arthuro555/gdcore-tools/blob/master/build/loaders.mjs`),
  aux côtés de `loadProjectEventsFunctionsExtensions`,
  `reloadProjectEventsFunctionsExtensionMetadata` (depuis
  `.../EventsFunctionsExtensionsLoader`), `makeLocalEventsFunctionCodeWriter` (depuis
  `.../CodeWriters/LocalEventsFunctionCodeWriter.js`), `makeExtensionsLoader` (depuis
  `.../JsExtensionsLoader/LocalJsExtensionsLoader`) et `LocalFileSystem` patché (même
  fichier). Le `build/build.mjs` clone `4ian/GDevelop`, build GDJS+GDCore, copie
  `libGD.wasm`/`libGD.js` vers `dist/lib/`, patch `LocalFileSystem.js` (`isURL`/`getUID`/
  `optionalRequire`→`require`) et bundle tout en `dist/loaders.cjs` via esbuild+babel-flow
  (source : `https://github.com/arthuro555/gdcore-tools/blob/master/build/build.mjs`).
- Preuve runtime local : `node -e` sur `vendor/libGD.js` donne `split: undefined,
  unsplit: undefined`, `fromJSObject: function`, `toJSON: function`,
  `isFolderProject/setFolderProject: function`,
  `getEventsFunctionsExtensionsCount: function`, `EventsFunctionsExtensionCodeGenerator/
  MetadataDeclarationHelper/BehaviorCodeGenerator/ObjectCodeGenerator/
  AbstractFileSystemJS` présents (source : binaire local `vendor/libGD.js` + `vendor/libgd-pin.json`,
  probe du 2026-09-16). Donc Node doit importer le splitter JS (copie IDE ou
  `gdcore-tools/dist/loaders.cjs`), pas appeler `gd.*`.

## 2. Format `__REFERENCE_TO_SPLIT_OBJECT` et `splitPathsSet` exact

- `split(object, { pathSeparator, getArrayItemReferenceName, shouldSplit,
  isReferenceMagicPropertyName })` mute `object` et retourne `Array<{ reference, object }>`
  (source : `.../Utils/ObjectSplitter.js` L38–47, L116–118).
- Chaque partie éclatée est remplacée par `{ [isReferenceMagicPropertyName]: true,
  referenceTo: reference }` via `createReference` qui `push({ reference, object })`
  (source : `.../ObjectSplitter.js` L48–59).
- Récursion : tableaux → `itemPath = currentPath + pathSeparator + '*'`, objets →
  `propertyPath = currentPath + pathSeparator + propertyName` ; si `shouldSplit(path)`
  on crée la référence (`itemReference = currentReference + pathSeparator + name`), sinon
  on recurse avec `index` (source : `.../ObjectSplitter.js` L61–114, appel racine
  `splitObject(object, '', '')` L116).
- Le helper `splitPaths(paths: Set<string>)` retourne `path => paths.has(path)` (source :
  `.../ObjectSplitter.js` L185–187).
- L'ensemble exact est construit des deux côtés avec les mêmes 4 dossiers :
  `splittedProjectFolderNames = ['layouts', 'externalLayouts', 'externalEvents',
  'eventsFunctionsExtensions']` (source : IDE
  `https://github.com/4ian/GDevelop/blob/master/newIDE/app/src/ProjectsStorage/LocalFileStorageProvider/LocalProjectWriter.js`
  L35–40 ; `gdcore-tools`
  `https://github.com/arthuro555/gdcore-tools/blob/master/src/open_project.mjs` L67–72),
  puis `new Set(splittedProjectFolderNames.map(folderName => `/${folderName}/*`))`
  (source : `LocalProjectWriter.js` L148–152 ; `open_project.mjs` L73–76 avec
  `splitPaths = path => splitPathsSet.has(path)`).
- Donc seuls les items directs (`/*`) des 4 tableaux racine sont éclatés ; le contenu
  interne des layouts n'est pas re-split (profondeur 1 côté split). Exemple canonique :
  `{ myArray: [{ name: 'A' }, { name: 'B' }] }` + `shouldSplit = splitPaths(['/myArray/*'])`
  → `{ myArray: [{ __REFERENCE_TO_SPLIT_OBJECT: true, referenceTo: '/myArray/A' },
  { __REFERENCE_TO_SPLIT_OBJECT: true, referenceTo: '/myArray/B' }] }` et partials
  `[{ reference: '/myArray/A', object: { name: 'A', … } }, …]` (source :
  `.../Utils/ObjectSplitter.spec.js` §« can split arrays »).
- Objets imbriqués : avec `['/myArray/*', '/myArray/*/innerObject']`, chaque partiel
  `/myArray/A` contient lui-même `{ __REFERENCE_TO_SPLIT_OBJECT: true, referenceTo:
  '/myArray/A/innerObject' }` (source : `.../ObjectSplitter.spec.js` §« can split objects
  inside arrays »). En production ce 2e niveau n'est pas demandé (seul `/*` est dans le
  set), donc les partiels layout restent monolithiques.

## 3. Slugification + unicité (`getSlugifiedUniqueNameFromProperty`)

- Save passe `getArrayItemReferenceName: getSlugifiedUniqueNameFromProperty('name')`
  (source : `LocalProjectWriter.js` L147 ; `open_project.mjs` L132).
- Implémentation : `existingNamesForReference = {}` closuré ; par appel :
  `property = object[propertyName]` (throw si non-string), `newName = newNameGenerator(
  slugs(property), name => !!existingNamesForReference[currentReference][name])`,
  mémorise puis retourne (source : `.../Utils/ObjectSplitter.js` L208–232, imports
  `slugs` L4 + `newNameGenerator` L3).
- `slugs` est la dépendance npm `slugs@0.1.3` (source :
  `https://github.com/4ian/GDevelop/blob/master/newIDE/app/package.json`, entrée
  `slugs`) ; `newNameGenerator(name, exists, prefix='')` retourne `name` si libre, sinon
  `radix + (suffix+1)` en incrémentant (`splitNameAndNumberSuffix`) (source :
  `https://github.com/4ian/GDevelop/blob/master/newIDE/app/src/Utils/NewNameGenerator.js`).
- Effet prouvé par spec : `' Hello/\\à '` → `hello`, doublon → `hello2`, `'B'` → `b` ;
  références `/myArray/hello`, `/myArray/b`, `/myArray/hello2` (source :
  `.../ObjectSplitter.spec.js` §« can split objects inside arrays and create unique
  reference names »). L'unicité est scopée par `currentReference` (un compteur par dossier
  parent), pas globale.
- Conséquence save : le nom de fichier partiel est `path.join(projectPath,
  partialObject.reference) + '.json'`, ex. `<dir>/layouts/hello2.json` (source :
  `LocalProjectWriter.js` L157–161 ; `open_project.mjs` L139–144). Les références sont
  donc des chemins relatifs sans extension, résolus par `join(projectPath, referencePath)
  + '.json'` au load.

## 4. Load unsplit : profondeur max 3 + injection `projectFile`

- IDE opener `onOpen(fileMetadata)` : `projectPath = path.dirname(filePath)`,
  `readJSONFile(filePath).then(object => unsplit(object, { getReferencePartialObject:
  referencePath => readJSONFile(path.join(projectPath, referencePath) + '.json'),
  isReferenceMagicPropertyName: '__REFERENCE_TO_SPLIT_OBJECT', maxUnsplitDepth: 3 }))`
  puis `{ content: object }` (source :
  `https://github.com/4ian/GDevelop/blob/master/newIDE/app/src/ProjectsStorage/LocalFileStorageProvider/LocalProjectOpener.js`
  L20–41, commentaire L33–35 : « Limit unsplitting to depth 3 (which would allow properties
  of layouts/external layouts/external events to be un-splitted, but not the content of
  these properties), to avoid very slow processing of large game files »).
- `gdcore-tools` loader est identique à l'injection `projectFile` près :
  `object.properties.projectFile = projectFilePath` avant `unsplit`, même
  `getReferencePartialObject: referencePath => readJSONFile(join(projectPath,
  referencePath) + '.json')`, même `maxUnsplitDepth: 3` et même commentaire (source :
  `.../gdcore-tools/.../src/open_project.mjs` L25–44, commentaire L39–41).
- Sémantique `unsplit` : `isReference = object[magic] === true` ; `unsplitObject(
  currentObject, depth )` stoppe si `maxUnsplitDepth !== undefined && depth >=
  maxUnsplitDepth`, sinon `Promise.all(keys.map(...))` : si référence → fetch puis
  remplace puis recurse `depth+1`, sinon recurse `depth+1` (source :
  `.../Utils/ObjectSplitter.js` L127–180, garde L147–149).
- Preuve du cutoff : avec `maxUnsplitDepth: 2`, les `innerObject` restent
  `{ __REFERENCE_TO_SPLIT_OBJECT: true, … }` après unsplit (source :
  `.../ObjectSplitter.spec.js` §« can unsplit with a maximum depth »). Avec 3, le load
  projet résout racine(0)→tableau(1)→item layout(2) mais pas le contenu interne des
  layouts — exactement ce que le commentaire annonce. Erreur si partiel manquant :
  rejet `Can't find <reference>` (source : même spec §« can report error while
  unsplitting ») — en Node cela correspond à un `ENOENT` sur `<ref>.json`.
- Après unsplit, `gdcore-tools` fait : `gdSerializer = gd.Serializer.fromJSObject(object)`,
  `project = gd.ProjectHelper.createNewGDJSProject()`, `project.unserializeFrom(
  gdSerializer)`, `gdSerializer.delete()`, `project.setProjectFile(projectFilePath)`
  (source : `open_project.mjs` L46–52). L'IDE sépare les étapes (opener retourne le JS
  unsplitté, la désérialisation a lieu dans le caller), mais `setProjectFile` reste
  obligatoire : `Project::SetProjectFile/GetProjectFile` existent dans l'IDL (source :
  `Bindings.idl` L603–604, JS `setProjectFile/getProjectFile`), et les deux runtimes
  l'appellent systématiquement (`gdevelop-runtime.js` `openProject` L299,
  `createProject` L339 ; local `src/runtime.ts` `loadProjectFromJson` L868).
- `Project.cpp` confirme `folderProject` comme attribut booléen sérialisé :
  défaut `folderProject(false)` (L51), `SetFolderProject(propElement.GetBoolAttribute(
  "folderProject"))` au load (L733), `SetAttribute("folderProject", folderProject)` au
  save (L1078) (source :
  `https://github.com/4ian/GDevelop/blob/master/Core/GDCore/Project/Project.cpp`
  L51, L733, L1078). Le flag survit donc au round-trip et gate le split au save.

## 5. Save split : séquence exacte + `mkdir -p` + tmp-dotfile + reparse + rename

- Sérialisation : `serializeToJSObject(project, 'serializeTo', { canonicalEventSerialization })`
  (IDE) soit `new gd.SerializerElement(); project.serializeTo(el); JSON.parse(
  gd.Serializer.toJSON(el)); el.delete()` (`gdcore-tools`) (sources :
  `LocalProjectWriter.js` L130–141 ; `open_project.mjs` L121–127). L'IDE note que le mode
  canonique n'est pas propagé au worker background (hardcodé off en prod) (source :
  `LocalProjectWriter.js` L132–136) ; le helper `withSerializationOptions` set/reset le
  flag global `gd.Serializer.setCanonicalMode` autour du callback (source :
  `https://github.com/4ian/GDevelop/blob/master/newIDE/app/src/Utils/Serializer.js`
  §`withSerializationOptions`, `serializeToJSObject`, `addFinalNewline`).
- Gate : `if (project.isFolderProject()) { split(...) }`, sinon écriture mono-fichier
  directe (sources : `LocalProjectWriter.js` L144, L175–177 ; `open_project.mjs` L129).
  L'IDL expose `SetFolderProject/IsFolderProject` (source : `Bindings.idl` L614–615).
- Appel split identique des deux côtés : `{ pathSeparator: '/', getArrayItemReferenceName:
  getSlugifiedUniqueNameFromProperty('name'), shouldSplit: splitPaths(...),
  isReferenceMagicPropertyName: '__REFERENCE_TO_SPLIT_OBJECT' }` (sources :
  `LocalProjectWriter.js` L145–154 ; `open_project.mjs` L130–135).
- Écriture partiels puis principal : `Promise.all(partialObjects.map(p =>
  writeFormatted(p.object, join(projectPath, p.reference) + '.json'))).then(() =>
  writeFormatted(serializedProjectObject, filePath))` (sources : `LocalProjectWriter.js`
  L156–174 ; `open_project.mjs` L137–147). Le corps principal garde les
  `{ __REFERENCE_TO_SPLIT_OBJECT: true, referenceTo }` à la place des contenus.
- Format fichier : `addFinalNewline(JSON.stringify(object, null, 2))` côté IDE (source :
  `LocalProjectWriter.js` L107–113, `Serializer.js` §`addFinalNewline` : ajoute `\n`
  final POSIX) ; `JSON.stringify(content, null, 2)` sans newline final côté
  `gdcore-tools` (source : `open_project.mjs` L87).
- `mkdir -p` : IDE `writeAndCheckFile` fait `await fs.ensureDir(path.dirname(filePath))`
  avant `writeFile`, puis `checkFileContent` (relecture + comparaison stricte, rejet si
  vide ou différent) (source : `LocalProjectWriter.js` L93–105, L68–91). `gdcore-tools`
  `writeAndCheckFile(content, path)` ne fait PAS `ensureDir` : `tmp =
  dirname(path)/.basename`, `await writeFile(tmp, str)`, `JSON.parse(await readFile(tmp))`
  (reparse, `rm(tmp)` + throw si invalide), `await rm(path)`, `await rename(tmp, path)`
  (source : `open_project.mjs` L79–102). Donc le tmp-dotfile + reparse + rename vient de
  `gdcore-tools`, le `mkdir -p` + vérification byte-égale vient de l'IDE — une implémentation
  Node correcte doit combiner les deux (voir §10).
- Nettoyage des renommés/supprimés : IDE `deleteExistingFilesFromDirs(project, projectPath)`
  avant écriture — si `isFolderProject()`, liste chaque dossier de
  `splittedProjectFolderNames` sous `projectPath` et `unlinkSync` tous les fichiers
  (source : `LocalProjectWriter.js` L42–66, appel L224–227 avec `console.warn` si échec).
  `gdcore-tools` ne nettoie rien : un layout renommé laisse son ancien `<slug>.json`
  orphelin, qui ne sera plus référencé mais pollue le dossier. Piège à corriger côté MCP.
- `onSaveProjectAs` (`LocalProjectWriter.js` L329–380) montre aussi `project.setProjectFile(
  filePath)` avant `writeProjectFiles` (L364) et la copie des ressources avant le save
  (L362) — hors scope MCP mais à noter pour la stratégie `save as`.

## 6. `codeWriter` : les 4 méthodes + signatures + implémentation locale

- Type exact (Flow) : `EventsFunctionCodeWriter = {| getIncludeFileFor: (functionName:
  string) => string, writeFunctionCode: (functionName: string, code: string) =>
  Promise<void>, writeBehaviorCode: (behaviorName: string, code: string) =>
  Promise<void>, writeObjectCode: (objectName: string, code: string) => Promise<void> |}`
  + `EventsFunctionCodeWriterCallbacks = {| onWriteFile: IncludeFileContent => void |}`
  où `IncludeFileContent = {| includeFile: string, content: string |}` (source :
  `https://github.com/4ian/GDevelop/blob/master/newIDE/app/src/EventsFunctionsExtensionsLoader/index.js`
  L7–21).
- Fabrique locale : `makeLocalEventsFunctionCodeWriter({ onWriteFile })` (source :
  `https://github.com/4ian/GDevelop/blob/master/newIDE/app/src/EventsFunctionsExtensionsLoader/CodeWriters/LocalEventsFunctionCodeWriter.js`
  L29–32).
- Dossier de sortie : `outputDir = path.join(os.tmpdir(), 'GDGeneratedEventsFunctions-' +
  getUID())`, `fs.mkdirSync(outputDir, { recursive: true })` avec `console.error` si
  échec (source : même fichier L34–45 ; `getUID` vient de `Utils/LocalUserInfo`,
  `gdcore-tools` le patche en constante `"gdcore-tools"` — source : `build/build.mjs`
  §« Patching & importing LocalFileSystem »).
- Mapping namespace→fichier : `getPathFor = codeNamespace => outputDir + '/' +
  slugs(codeNamespace) + '.js'` ; `getIncludeFileFor = codeNamespace => getPathFor(
  codeNamespace)` (source : même fichier L47–52). Même lib `slugs` qu'au §3.
- Les 3 writers sont symétriques : `safelyDoFsOperation(() => new Promise((resolve,
  reject) => { includeFile = getPathFor(name); onWriteFile({ includeFile, content: code });
  fs.writeFile(includeFile, code, err => err ? reject(err) : resolve()); }))` (source :
  même fichier L53–104, un bloc par méthode). `safelyDoFsOperation` sérialise les FS ops
  contre la fermeture Electron (source : même fichier L10–19, import de
  `Utils/ElectronConflictingOperationsMutex`) — en Node pur, remplacer par une file
  d'écriture ou `fs/promises` séquentiel.
- `gdcore-tools` instancie avec `makeLocalEventsFunctionCodeWriter({ onWriteFile: () => null })`
  : les fichiers sont écrits sur disque mais le callback est ignoré (source :
  `open_project.mjs` L54–57). En Node headless c'est suffisant pour enregistrer les
  métadonnées ; pour un preview/export il faut conserver les `includeFile` (le loader les
  ajoute aux métadonnées d'instruction, voir §8).

## 7. `i18n` identité

- Signature loader : `loadProjectEventsFunctionsExtensions(project: gdProject,
  eventsFunctionCodeWriter: EventsFunctionCodeWriter, i18n: I18nType) =>
  Promise<Array<void>>` (source : `EventsFunctionsExtensionsLoader/index.js` L41–45).
- `gdcore-tools/src/index.mjs` charge les extensions JS natives avec
  `extensionsLoader.loadAllExtensions((str) => str)` (source :
  `https://github.com/arthuro555/gdcore-tools/blob/master/src/index.mjs` L48) et le
  project loader avec `(str) => str` en 3e argument (source : `open_project.mjs` L54–57).
- Côté IDE, `i18n` est `@lingui/core` et `TranslationFunction` est `(msg) => string` ;
  `LocalJsExtensionsLoader.loadAllExtensions(_: TranslationFunction)` prend le même
  callback (source :
  `https://github.com/4ian/GDevelop/blob/master/newIDE/app/src/JsExtensionsLoader/LocalJsExtensionsLoader.js`,
  paramètre `_`). Donc en Node : `(s: string) => s` est le substitut documenté ; ne jamais
  passer `undefined` (le loader appelle `_(...)` sur les erreurs d'extension).
- Piège : `delete globalThis.fetch` avant `init`, restore après, + `global.gd` exposé
  pendant le chargement des loaders puis supprimé (source : `index.mjs` L9–27, L29–36).
  Sans cela Emscripten détecte un navigateur et les loaders Flow ne trouvent pas `gd`.

## 8. `loadProjectEventsFunctionsExtensions` : séquence exacte

- Deux passes sur `project.getEventsFunctionsExtensionsCount()` : passe 1
  `skipCodeGeneration: true` (métadonnées seules, car « events in functions could
  themselves be using functions that are not yet available »), passe 2
  `skipCodeGeneration: false` (métadonnées + code), chaque passe en `Promise.all(
  mapFor(0, count, i => loadProjectEventsFunctionsExtension(project,
  project.getEventsFunctionsExtensionAt(i), {...})))` (source :
  `EventsFunctionsExtensionsLoader/index.js` L46–74, commentaire L47–50).
- Par extension : `generateEventsFunctionExtension(project, eventsFunctionsExtension,
  options).then(extension => { gd.JsPlatform.get().addNewExtension(extension);
  extension.delete(); }, error => { console.error('[EventsFunctionsExtensionsLoader]
  Failed to load extension "<name>" (phase=metadata|codegen):', error); throw error; })`
  (source : même fichier L94–118).
- `generateEventsFunctionExtension` : `new gd.PlatformExtension()` +
  `MetadataDeclarationHelper.declareExtension`, `getExtensionCodeNamespacePrefix`,
  `getExtensionIncludeFiles` (les `getIncludeFileFor(freeFunctionCodeName)`), puis en
  chaîne : `Promise.all(behaviors.map(generateBehavior))` → `Promise.all(objects.map(
  generateObject))` → `Promise.all(freeFunctions.map(generateFreeFunction))` → `extension`
  (source : même fichier L145–232).
- Free function : `generateFreeFunctionMetadata` (déclare via `MetadataDeclarationHelper`,
  `addIncludeFile(getIncludeFileFor(codeName))` + extension include files) puis si
  `!skipCodeGeneration` : `new gd.EventsFunctionsExtensionCodeGenerator(project)`,
  `generateFreeEventsFunctionCompleteCode(extension, fn, codeNamespace, includeFiles,
  /* forRuntime */ true)`, rattache les include files transitifs à la métadonnée,
  `codeWriter.writeFunctionCode(codeName, code)` (sources : même fichier L318–408,
  codegen L348–400). IDL : `EventsFunctionsExtensionCodeGenerator(project)` +
  `generateFreeEventsFunctionCompleteCode` (source : `Bindings.idl` L4469+).
- Behavior : `generateBehaviorMetadata` + `new gd.BehaviorCodeGenerator(project)` +
  `generateRuntimeBehaviorCompleteCode(..., behaviorMethodMangledNames, includeFiles, true)`
  + `codeWriter.writeBehaviorCode(codeNamespace, code)` (source : même fichier L452–518 ;
  IDL `BehaviorCodeGenerator` L4436+). Object : `generateObjectMetadata` + `new
  gd.ObjectCodeGenerator(project)` + `generateRuntimeObjectCompleteCode` +
  `codeWriter.writeObjectCode(codeNamespace, code)` (source : même fichier L555–621 ;
  IDL `ObjectCodeGenerator` L4454+).
- Métadonnées seules (`reloadProjectEventsFunctionsExtensionMetadata`) : même déclaration
  sans codegen, `addNewExtension` + `delete` (source : même fichier L79–92).
- Déchargement : `unloadProjectEventsFunctionsExtensions(project)` =
  `Promise.all(mapFor(... JsPlatform.get().removeExtension(getEventsFunctionsExtensionAt(i)
  .getName())))` (source : même fichier L662–672). Indispensable avant `project.delete()`
  ou re-load dans le même process (registre `JsPlatform` global — même contrainte que les
  exports sérialisés côté `982945902`).

## 9. Projets à objets/behaviors custom : que se passe-t-il sans le load ?

- Sans `loadProjectEventsFunctionsExtensions`, les types events-based (`Extension::Behavior`,
  `Extension::Object`, fonctions libres `Extension::Fonction`) ne sont jamais enregistrés
  sur `gd.JsPlatform` (enregistrement = `addNewExtension` au §8). `MetadataProvider`
  les verra donc comme bad metadata et `getWholeProjectDiagnosticReport()` remontera
  `MissingBehavior` / `UnknownObject` / `MismatchedObjectType` (énum
  `ProjectDiagnostic_ErrorType` : `UndeclaredVariable, MissingBehavior, UnknownObject,
  MismatchedObjectType` — source : `Bindings.idl` L3259–3264 ; rapport
  `Project.GetWholeProjectDiagnosticReport` L706, `WholeProjectDiagnosticReport` L3281+).
- Le load lui-même ne corrompt rien s'il est skippé : `unserializeFrom` réussit (les
  `eventsFunctionsExtensions` sont des données), mais toute validation `isBad*`,
  tout export/preview générant du code, et tout `updateBehaviorsSharedData` sur ces
  behaviors échoueront ou produiront des diagnostics bloquants. Le loader échoue bruyamment
  plutôt que silencieusement : `console.error(... phase=...)` + `throw` (source : §8).
- `982945902` et le runtime local actuel sont dans ce cas : `openProject` fait
  `JSON.parse → fromJSObject → createNewGDJSProject().unserializeFrom → setProjectFile`
  sans unsplit ni events-functions load (source :
  `https://github.com/982945902/gdevelop-mcp-server/blob/main/src/gdevelop-runtime.js`
  L288–310 ; local `src/runtime.ts` L849–870). Le doc de recherche l'avait anticipé :
  « Neither reference server does this — both will corrupt/misload folder projects »
  (source : `docs/research/gdevelop-mcp-libgd-research.md` L93).
- Règle : si `project.getEventsFunctionsExtensionsCount() > 0`, le load DOIT appeler le
  loader ; sinon les diagnostics post-mutation (§11) refuseront à tort les projets sains.
  Inversement, un échec du loader doit refuser l'open (pas de session partielle).

## 10. Pièges Node : `mkdir -p`, tmp-rename, reparse, diagnostics

| Piège | Fait primaire | Action Node |
|---|---|---|
| Pas de `mkdir -p` côté `gdcore-tools` | `writeAndCheckFile` écrit `dirname/.basename` sans `ensureDir` (source : `open_project.mjs` L79–89) vs IDE `ensureDir(dirname)` (source : `LocalProjectWriter.js` L101) | `await fs.mkdir(path.dirname(file), { recursive: true })` avant chaque `writeFile` (partiels + principal). |
| Écrasement direct vs atomique | IDE écrit direct + vérifie byte-égal (source : `LocalProjectWriter.js` L93–105) ; `gdcore-tools` fait tmp-dotfile + reparse + `rm`+`rename` (source : `open_project.mjs` L85–101) ; local `src/commands.ts` fait déjà tmp-`renameSync` avec suffixe pid+uuid (L21–34) | Réutiliser `atomicWrite` locale mais avec le reparse JSON avant rename (échec → `rm` tmp + throw, l'original reste intact). |
| Reparse oublié | Les deux implémentations relisent avant de valider : IDE compare la string exacte (source : `LocalProjectWriter.js` L68–91), `gdcore-tools` fait `JSON.parse(readFile(tmp))` (source : `open_project.mjs` L92–97) | Toujours `JSON.parse` le tmp ; à l'échec, `rm` le tmp et throw `io-error`. |
| Fichiers orphelins après rename | IDE `deleteExistingFilesFromDirs` supprime tous les fichiers des 4 dossiers avant réécriture (source : `LocalProjectWriter.js` L42–66, L224) ; `gdcore-tools` n'a rien | Implémenter le cleanup IDE (unlink par dossier listé, best-effort warn) avant d'écrire les partiels. |
| Newline final | IDE `addFinalNewline(JSON.stringify(o, null, 2))` (source : `LocalProjectWriter.js` L111, `Serializer.js` §`addFinalNewline`) | Écrire avec `\n` final pour des diffs git stables. |
| `projectFile` non injecté | `object.properties.projectFile = projectFilePath` avant unsplit (source : `open_project.mjs` L33) | Reproduire avant `unsplit`, puis `project.setProjectFile(absPath)` après `unserializeFrom`. |
| `fetch` global casse Emscripten | `delete globalThis.fetch` avant init, restore après (source : `gdcore-tools/src/index.mjs` L9–27) | Copier le hack dans le runtime Node. |
| `global.gd` requis par les loaders | Exposé pendant `import loaders.cjs` puis supprimé (source : même fichier L29–36) | Idem si on bundle les loaders IDE. |
| `fromJSObject` plus rapide que `fromJSON` | Commentaire `postjs.js` : « much faster than manually parsing JSON with `fromJSON` » ; `serializeToJSObject` note « `JSON.parse + toJSON` is 30% faster than `toJSObject` » (sources : `postjs.js` §fromJSObject ; `Serializer.js` §`serializeToJSObject`) | Load : `fromJSObject(JSON.parse(text))` ; oid du round-trip pipeline : `serializeTo → toJSON → JSON.parse` (déjà fait en `src/runtime.ts` L530, L849+). |
| Mode canonique global | `gd.Serializer.setCanonicalMode` est global, doit être reset (source : `Serializer.js` §`withSerializationOptions`) | Ne pas l'activer pour le folder-write sauf option explicite, et toujours restaurer. |
| Registre `JsPlatform` global | `addNewExtension`/`removeExtension` par load/unload (source : §8) ; exports sérialisés car registres process-globaux (source : `982945902/ARCHITECTURE.md` §« Process and safety model », cité dans `gdevelop-mcp-libgd-research.md` §1.9) | Sérialiser les loads folder-project comme les exports ; `unloadProjectEventsFunctionsExtensions` au `close_project`. |

## 11. Gaps actuels à combler (preuves locales)

- `src/sessions.ts` `open()` : `statSync`, si `isDirectory()` → throw
  `folder-project-unsupported` « Folder-project … is not supported yet (single-file .json
  only). It was left untouched. » (source : `src/sessions.ts` L43–55). `resolvePath`
  (absolu, pas de null-byte, `allowedRoot`) est déjà partagé open/save (source : même
  fichier L131–143).
- `src/commands.ts` `saveProject` : gate diagnostics bloquants, `serializeProject`,
  backup `<target>.bak-<ISO>`, `atomicWrite(target, serialized, …)`, copie
  `-pre-restore`, `setProjectFile` + `clearDirty` (source : `src/commands.ts` L61–115).
  Mono-fichier uniquement : aucun `split`, aucun `isFolderProject()`, aucun partiel.
- `src/runtime.ts` `loadProjectFromJson` / `serializeProject` / `restoreProject` :
  `JSON.parse → fromJSObject → new gd.Project().unserializeFrom → setProjectFile` ;
  jamais `unsplit` ni `loadProjectEventsFunctionsExtensions` (source : `src/runtime.ts`
  L849–895). `createRealEngine` expose `setProjectFile` (même fichier, queue) mais pas
  de codeWriter.
- `982945902` a les mêmes gaps : `openProject` single-file L288–310
  (`createNewGDJSProject`, `fromJSObject`, `unserializeFrom`, `setProjectFile`,
  `delete` on error), `createProject` L312+ (`mkdir recursive` du dossier parent puis
  `writeFile` direct), `saveProject` L383–396 (`writeFile(projectFile, toJSON)` direct,
  sans backup ni tmp+rename ni gate) (source :
  `https://github.com/982945902/gdevelop-mcp-server/blob/main/src/gdevelop-runtime.js`
  L288–310, L383–396). Son `node-file-system.js` (`mkDir/dirExists/clearDir/getTempDir/
  fileNameFrom/dirNameFrom/makeAbsolute/makeRelative/isAbsolute/copyFile/writeToFile/
  readFile/readDir/fileExists`, forward-slash normalize, `isUrl` passthrough) reste
  réutilisable pour l'export mais pas pour le folder-write (source :
  `https://github.com/982945902/gdevelop-mcp-server/blob/main/src/node-file-system.js`).

## 12. Table de décision : stratégie `ProjectStore` folder

| Cas | Détection | Open | Session | Save | Backup/undo |
|---|---|---|---|---|---|
| Fichier `.json` single-file | `stat.isFile()`, `folderProject` absent/faux après parse | `readFile → JSON.parse → fromJSObject → unserializeFrom → setProjectFile(abs)` (actuel) | `filePath = abs` | `serialize → gate diagnostics → backup `.bak` → atomicWrite` (actuel `src/commands.ts`) | `.bak-<ISO>` + `-pre-restore` actuels |
| Dossier folder-project (`game.json` + `layouts/…`) | `stat.isDirectory()` → résoudre `<dir>/game.json` (ou l'entrée explicite si open pointe le `.json` dont le dossier contient `layouts/`) ; confirmer `isFolderProject() === true` après unsplit+load | `readJSON(main) → properties.projectFile = absMain → unsplit(depth 3, join(dir, ref)+'.json') → fromJSObject → createNewGDJSProject().unserializeFrom → setProjectFile(absMain) → loadProjectEventsFunctionsExtensions(writer tmp, (s)=>s)` ; refus si partiel manquant ou loader throw | `filePath = absMain`, `dir = dirname`, flag `isFolder = true` | `serialize → gate → backup main + snapshot partiels → deleteExistingFilesFromDirs → mkdir -p par fichier → split(slug) → writeAndCheck chaque partiel (tmp-dotfile+reparse+rename, `\n` final) → writeAndCheck principal → setProjectFile` | Backup : copie du main + des partiels écrasés (ou zip horodaté du dossier) ; `undo` restaure l'ensemble puis `restoreProject` mémoire. Sans cleanup préalable, refuser si partiels orphelins détectés est une alternative conservatrice. |
| Dossier sans `game.json` / main illisible | `ENOENT` / `JSON.parse` throw | Refus `io-error` / `project-load-failed`, rien en mémoire (pattern `delete()` on error de `982945902` L288–310) | — | — | — |
| Projet avec extensions mais loader KO | `getEventsFunctionsExtensionsCount() > 0` et `load…` throw | Refus `project-load-failed` (log phase metadata/codegen), pas de session partielle | — | — | — |
| `save as` vers dossier vide | target résolu sous `allowedRoot` | — | `setProjectFile(target)` avant écriture (cf. `onSaveProjectAs` L364) | Même séquence folder (mkdir -p du dossier cible d'abord) | Backup seulement si cible existante |

- Règle `allowedRoot`/`resolvePath` inchangée : le containment doit couvrir le dossier
  entier (`resolved.startsWith(resolve(allowedRoot))`), pas seulement le main (source :
  `src/sessions.ts` L131–143). Les partiels ne doivent jamais sortir de `dir` :
  `referenceTo` commençant par `/` + `join(dir, ref)` garantit le confinement tant qu'on
  refuse les `..` (les slugs ne produisent jamais de séparateur — §3).
- Concurrence : sérialiser les open/save folder comme les exports (registre `JsPlatform`
  global, §10).

## 13. Squelette Node recommandé (portage direct, pas de React)

```ts
// OPEN (folder) — porte open_project.mjs L25–58 + LocalProjectOpener.js L20–41
const raw = await fs.readFile(mainAbs, 'utf8');           // readJSONFile
const obj = JSON.parse(raw);                              // throw project-load-failed si invalide
obj.properties.projectFile = mainAbs;                     // injection gdcore-tools L33
await unsplit(obj, {                                      // importé de newIDE ObjectSplitter.js
  getReferencePartialObject: (ref) =>                     // LocalProjectOpener.js L29–31
    fs.readFile(path.join(dir, ref) + '.json', 'utf8').then(JSON.parse),
  isReferenceMagicPropertyName: '__REFERENCE_TO_SPLIT_OBJECT',
  maxUnsplitDepth: 3,
});
const el = gd.Serializer.fromJSObject(obj);               // postjs.js §fromJSObject
const project = gd.ProjectHelper.createNewGDJSProject(); // open_project.mjs L47
try { project.unserializeFrom(el); } catch (e) { project.delete(); throw ...; }
finally { el.delete(); }
project.setProjectFile(mainAbs);                          // open_project.mjs L52
await loadProjectEventsFunctionsExtensions(               // EventsFunctionsExtensionsLoader/index.js L41–45
  project, makeLocalEventsFunctionCodeWriter({ onWriteFile: () => null }), (s) => s);

// SAVE (folder) — porte LocalProjectWriter.js L115–185 + open_project.mjs L79–147
if (!project.isFolderProject()) { /* save mono-fichier actuel */ return; }
const serialized = JSON.parse(gd.Serializer.toJSON(el(project))); // LocalProjectWriter.js L138
const partials = split(serialized, {                      // LocalProjectWriter.js L145–154
  pathSeparator: '/',
  getArrayItemReferenceName: getSlugifiedUniqueNameFromProperty('name'),
  shouldSplit: splitPaths(new Set(['/layouts/*','/externalLayouts/*',
    '/externalEvents/*','/eventsFunctionsExtensions/*'])),
  isReferenceMagicPropertyName: '__REFERENCE_TO_SPLIT_OBJECT',
});
deleteExistingFilesFromDirs(project, dir);                // LocalProjectWriter.js L42–66
for (const { object, reference } of partials) {
  await mkdir(path.dirname(path.join(dir, reference)), { recursive: true }); // ensureDir L101
  await writeAndCheckFile(object, path.join(dir, reference) + '.json');
  // writeAndCheckFile = tmp-dotfile + JSON.stringify(o,null,2)+'\n' + reparse + rm+rename
  // (open_project.mjs L79–102 + addFinalNewline de Serializer.js)
}
await writeAndCheckFile(serialized, mainAbs);
```

- `unsplit`/`split`/`getSlugifiedUniqueNameFromProperty` : copier
  `newIDE/app/src/Utils/ObjectSplitter.js` (+ `NewNameGenerator.js`, dépendance
  `slugs`) ou dépendre de `gdcore-tools/dist/loaders.cjs` (qui les bundle, §1).
- `loadProjectEventsFunctionsExtensions` + `makeLocalEventsFunctionCodeWriter` : même
  choix (copie IDE vs `loaders.cjs`) ; dans les deux cas fournir le codeWriter §6 et
  l'i18n identité §7, avec les hacks `fetch`/`global.gd` de `index.mjs` si on passe par
  `loaders.cjs`.
- Ne pas oublier `unloadProjectEventsFunctionsExtensions` au close (source : §8) et le
  `delete()` des `SerializerElement`/projets en erreur (pattern `982945902` L288–310,
  local `src/runtime.ts` L849–870).

---

### Source index (primaires, toutes résolues le 2026-09-16 sauf §14)

Engine (`4ian/GDevelop@43b3e42`) : `GDevelop.js/Bindings/Bindings.idl` (L144–151
`ProjectHelper`, L570–719 `Project` dont `SetProjectFile/GetProjectFile`,
`IsFolderProject/SetFolderProject`, `GetEventsFunctionsExtensionsCount`,
`GetWholeProjectDiagnosticReport`, L1712–1719 `Serializer`, L3259–3281 diagnostics,
L4436+ code generators), `GDevelop.js/Bindings/postjs.js` (§`adaptNamingConventions`,
§`fromJSObject`/`toJSObject`), `Core/GDCore/Project/Project.cpp` (L51 défaut,
L733 load, L1078 save du flag `folderProject`), `GDevelop.js/__tests__/Serializer.js`
(round-trip `toJSON/fromJSON`), `GDevelop.js/__tests__/GDJSProjectSerialization.js`
(round-trip `serializeTo/unserializeFrom`), `newIDE/app/src/Utils/ObjectSplitter.js`
(232 lignes), `newIDE/app/src/Utils/ObjectSplitter.spec.js` (format, slug, depth),
`newIDE/app/src/Utils/NewNameGenerator.js`, `newIDE/app/src/Utils/Serializer.js`
(`withSerializationOptions`, `serializeToJSObject`, `addFinalNewline`),
`newIDE/app/src/ProjectsStorage/LocalFileStorageProvider/LocalProjectWriter.js`
(521 lignes), `.../LocalProjectOpener.js` (83 lignes),
`newIDE/app/src/EventsFunctionsExtensionsLoader/index.js` (748 lignes, type L7–21,
deux passes L46–74, par-extension L94–118, free L318–408, behavior L452–518, object
L555–621, unload L662–682),
`newIDE/app/src/EventsFunctionsExtensionsLoader/CodeWriters/LocalEventsFunctionCodeWriter.js`
(105 lignes), `newIDE/app/scripts/import-libGD.js` (distribution `libGD.js-for-tests-only`
vs S3 `https://s3.amazonaws.com/gdevelop-gdevelop.js`), `newIDE/app/package.json`
(`slugs@0.1.3`).
Outillage (`arthuro555/gdcore-tools@e4bf45e`) : `src/open_project.mjs`
(`createProjectLoader` L25–58, `splittedProjectFolderNames/splitPathsSet/splitPaths`
L67–76, `writeAndCheckFile` L79–102, `createProjectSaver` L106–147),
`src/index.mjs` (hack `fetch` L9–27, `global.gd` L29–36, `loadAllExtensions((s)=>s)`
L48, `loadProject/saveProject` L64/86), `build/loaders.mjs` (ré-exports IDE),
`build/build.mjs` (clone+build+bundle `loaders.cjs`).
Référence (`982945902/gdevelop-mcp-server@96ed51e`) : `src/gdevelop-runtime.js`
(`openProject` L288–310, `createProject` L312+, `saveProject` L383–396),
`src/node-file-system.js` (impl `AbstractFileSystemJS`), `ARCHITECTURE.md`
(registres globaux, exports sérialisés).
Local : `src/sessions.ts` (L43–55 refus dossier, L131–143 `resolvePath`),
`src/commands.ts` (L21–34 `atomicWrite`, L61–115 `saveProject`),
`src/runtime.ts` (L849–895 load/serialize/restore, L530 `serializeLive`),
`src/pipeline.ts` (round-trip + diagnostics gate),
`docs/research/gdevelop-mcp-libgd-research.md` (§1.3, §7 Q1–Q2),
`CONTEXT.md` (définition folder-project), `vendor/libgd-pin.json` (pin binaire).

## 14. URLs non résolues (signalées, exclues des findings)

- `https://raw.githubusercontent.com/4ian/GDevelop/master/Core/GDCore/Project/ObjectSplitter.h`
  / `.cpp` → HTTP 404 (vérifié 2026-09-16). Il n'y a pas de splitter C++ : le split est
  purement JS IDE (`ObjectSplitter.js`).
- `https://raw.githubusercontent.com/4ian/GDevelop/master/Core/GDCore/Project/ProjectFileWriter.h`
  / `.cpp`, `Core/GDCore/Serialization/Splitter.*`, `GDevelop.js/Bindings/ObjectSplitter.idl`
  → HTTP 404 (même vérification). La persistance projet côté C++ est dans
  `Core/GDCore/Project/Project.cpp` (`SerializeTo/UnserializeFrom` + flag
  `folderProject`), l'éclatement dans l'IDE JS.
- `https://api.github.com/search/code?...` → HTTP 401 `Requires authentication`
  (vérifié 2026-09-16) : la recherche de code GitHub exige un token ; remplacée par
  `git/trees?recursive=1` (7293 entrées, `truncated: false`) + `raw.githubusercontent`
  directs, tous résolus ci-dessus.
