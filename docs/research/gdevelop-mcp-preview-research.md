# Preview double mode (statique + jouable + logs) — recherche primaire (issue #16)

> Portée : comment construire, dans `gdevelop-mcp-server`, `render_scene_static`
> (canvas <1s) + `build_preview` / `get_preview_status` / `stop_preview` (Puppeteer
> optionnel) depuis la **session mémoire sans save** : scène paramétrable (défaut
> first layout), rebuild si dirty (hash), logs GDJS toujours retournés (ring buffer) +
> screenshot opt-in, queue d'exports sérialisée globale, flags `PreviewExportOptions` +
> fix Draco, serveur `127.0.0.1` port/dossier random + containment + MIME wasm, TTL
> 30 min, `close_project` stoppe les liées. Chaque affirmation ci-dessous cite la
> source primaire qui la porte (URL + fichier/section/ligne), ou le binaire pinné
> local quand il fait foi.
>
> Recherche menée le 2026-09-15. Sources pinnées : `4ian/GDevelop` release `v5.6.282`
> (publiée le 2026-09-11 — `https://api.github.com/repos/4ian/GDevelop/releases/latest`,
> target `master`) + commit `master@89c44ffe7dc62b2256816dbc07aadf22f9c8d33c`
> (2026-09-15T12:39:06Z) ; binaire local `vendor/libGD.js` (pin `master/latest`,
> sha256 js `0dc7920526d191ac0b1ee896dce166a8b175896aa887c7f42315d5c4891a2219`,
> wasm `e4f49a5a630949aa9bc31ba4601cdca7cd81dad9d4cf77cb54d85d11c5301c2a` —
> `vendor/libgd-pin.json`) ; `982945902/gdevelop-mcp-server@main` (v0.4.0, `package.json`) ;
> `gb2b/gdevelop-mcp@main` (v0.21.0, `package.json`) ; `arthuro555/gdcore-tools@master`
> (`src/index.mjs`, `src/open_project.mjs`) ; Puppeteer docs `25.11.0`
> (`https://pptr.dev/`, vérifiées 2026-09-15) ; Node.js docs `v26.x` (applicables à
> `engines >=20` de `package.json`) ; runtime GDJS local `third-party/GDJS/Runtime/`.
> État local : `src/tools.ts` n'expose aucun outil preview, `src/sessions.ts` `close()`
> ne stoppe rien (pas de preview manager), `src/runtime.ts` n'a ni `Exporter` ni
> `PreviewExportOptions`.

## 0. Rappel du cadrage (#16, parente #11, carte #1)

- L'issue #16 demande `render_scene_static` (canvas <1s) + `build_preview` /
  `get_preview_status` / `stop_preview` (Puppeteer optionnel) : « build depuis la
  session mémoire sans save, scène paramétrable (défaut first layout), rebuild si
  dirty (hash), logs GDJS toujours retournés (ring buffer) + screenshot opt-in, queue
  d'exports sérialisée globale, flags `PreviewExportOptions` + fix Draco, serveur
  `127.0.0.1` port/dossier random + containment + MIME wasm, TTL 30 min,
  `close_project` stoppe les liées » (source : `gh issue view 16`, corps —
  `https://github.com/Marwichmisi/GDevelop-MCP-seveur/issues/16`).
- Critères : « Statique instantané après mutation ; preview jouable servi en loopback
  avec logs sans screenshot (rapide) et   avec screenshot sur demande. Rebuild seulement
  si dirty ; stop + TTL nettoient processus et disque. Tentative de traversal →
  404/403 ; build sans save ne touche pas au disque. Tests avec faux exporter + suite
  opt-in réelle » (source : `gh issue view 16`, Acceptance criteria —
  `https://github.com/Marwichmisi/GDevelop-MCP-seveur/issues/16`).
- Bloqueur déclaré : « Scaffold + première balle traçante (sessions + runtime requis) »
  (source : `gh issue view 16`, Blocked by —
  `https://github.com/Marwichmisi/GDevelop-MCP-seveur/issues/16`) — levé en pratique : `ProjectStore`
  single-file MVP + `createRealEngine` existent (sources : `src/sessions.ts`,
  `src/runtime.ts`), seul le preview manque (`src/tools.ts` L88–144 : 6 outils projet,
  28 contenu, 4 événements, 10 catalogue — zéro preview).
- Spec parente : User Stories 28–30 (« rendu statique <1s », « builder un Preview
  jouable d'une scène (sans save) et relire logs + screenshot opt-in », « stopper un
  preview avec cleanup vérifié et TTL auto ») (source : `gh issue view 11`, §Catalogue,
  assets, preview — `https://github.com/Marwichmisi/GDevelop-MCP-seveur/issues/11`). Carte #1 : contraintes standing « preview loopback `127.0.0.1`
  seule, GET/HEAD, garde anti-traversal ; jamais de handle WASM brut hors process ;
  `initializePlatforms()` une fois par process, exports sérialisés » + décision close
  « double mode (canvas <1s + vrai runtime, Puppeteer optionnel), build sans save +
  rebuild si dirty + TTL 30 min, scène défaut first layout, logs toujours / screenshot
  opt-in, queue sérialisée » (source : `gh issue view 1`, §Contraintes standing,
  §Preview gd.Exporter — `https://github.com/Marwichmisi/GDevelop-MCP-seveur/issues/1`).

## 1. Export sans save depuis la session mémoire (Serializer / Exporter)

### 1.1 L'exporteur prend le `gd.Project` vivant — aucun save requis

- Signature C++ : `bool ExportProjectForPixiPreview(const PreviewExportOptions& options)`
  où `PreviewExportOptions(gd::Project &project_, const gd::String &exportPath_)`
  garde une **référence** au projet (sources :
  `https://raw.githubusercontent.com/4ian/GDevelop/master/GDJS/GDJS/IDE/Exporter.h`
  §`class Exporter`, `§PreviewExportOptions` ctor dans
  `https://raw.githubusercontent.com/4ian/GDevelop/master/GDJS/GDJS/IDE/ExporterHelper.h`
  L~30–60). Le binding IDL expose exactement cela :
  `void PreviewExportOptions([Ref] Project project, [Const] DOMString outputPath)` et
  `boolean ExportProjectForPixiPreview([Const, Ref] PreviewExportOptions options)` +
  `GetLastError`, `SerializeProjectData`, `SerializeRuntimeGameOptions`, `SetCodeOutputDirectory`
  (source : `https://raw.githubusercontent.com/4ian/GDevelop/master/GDevelop.js/Bindings/Bindings.idl`
  L4526–4540, vérifié par `grep -n` le 2026-09-15 ; IDL total 4643 lignes).
- Preuve par l'éditeur : `LocalPreviewLauncher.launchPreview` construit
  `new gd.PreviewExportOptions(project, outputDir)` depuis le **projet ouvert en
  mémoire** puis appelle `exporter.exportProjectForPixiPreview(previewExportOptions)`
  sans jamais sauver (source :
  `https://raw.githubusercontent.com/4ian/GDevelop/master/newIDE/app/src/ExportAndShare/LocalExporters/LocalPreviewLauncher/index.js`
  §`launchPreview`, `prepareExporter` : `new gd.Exporter(fileSystem, gdjsRoot)`).
  L'exporteur clone lui-même le projet en interne (« TODO Try to remove side effects
  to avoid the copy that destroys the AST in cache. `gd::Project exportedProject =
  options.project;` », source :
  `https://raw.githubusercontent.com/4ian/GDevelop/master/GDJS/GDJS/IDE/ExporterHelper.cpp`
  §`ExporterHelper::ExportProjectForPixiPreview`, L111–145).
- Preuve par la référence headless : `GDevelopRuntime.buildPreview(project,
  outputDirectory, { sceneName })` reçoit le handle session et n'écrit que dans le
  dossier de sortie (source :
  `https://raw.githubusercontent.com/982945902/gdevelop-mcp-server/main/src/gdevelop-runtime.js`
  L765–811, §`buildPreview`). Le critère « build sans save ne touche pas au disque
  [projet] » est donc structurel : seul `outputDirectory` (temp random) est écrit.

### 1.2 Sérialisation mémoire : `Serializer.toJSON` / `fromJSObject`

- Le save/load single-file local passe déjà par `serializeTo` → `Serializer.toJSON`
  et `Serializer.fromJSObject` → `unserializeFrom` (sources : `src/runtime.ts`
  L845–891, `createRealEngine.loadProjectFromJson/serializeProject/restoreProject`).
  Le contrat IDL : `Serializer.STATIC_ToJSON / STATIC_FromJSON` (+ `SetCanonicalMode`)
  (source : `Bindings.idl` L1712–1720).
- `fromJSObject` n'est **pas** dans l'IDL : c'est un helper ajouté par
  `postjs.js` (« Add gd.Serializer.fromJSObject which is much faster than manually
  parsing JSON with gd.Serializer.fromJSON », `elementFromJSObject` récursif
  number/string/boolean/array/object, source :
  `https://raw.githubusercontent.com/4ian/GDevelop/master/GDevelop.js/Bindings/postjs.js`
  L192–225). Conséquence impl : le dirty-hash et le snapshot pré-export peuvent
  utiliser `serializeTo` → `toJSON` (string) sans `fromJSObject`, donc sans risque
  parse ; la restauration éventuelle réutilise `restoreProject` existant.
- Renommage camelCase : les symboles WASM bruts sont `PascalCase`
  (`_emscripten_bind_Exporter_ExportProjectForPixiPreview_1`,
  `_emscripten_bind_PreviewExportOptions_SetLayoutName_1`, … — vérifié dans
  `vendor/libGD.js` par `grep _emscripten_bind_`, 61 symboles
  `Exporter|PreviewExportOptions|ExportOptions|AbstractFileSystemJS`), et `postjs.js`
  `adaptNamingConventions` convertit `STATIC_`→statique, `FREE_`→module, `MAP_`/
  `WRAPPED_`→strip, première lettre en minuscule (source : `postjs.js` L1–60). Donc
  côté Node on appelle `exporter.exportProjectForPixiPreview(options)` et
  `options.setLayoutName(…)` (comme `gdevelop-runtime.js` L781–787), jamais les noms
  `PascalCase`.

### 1.3 `AbstractFileSystemJS` : le pont C++ ↔ Node `fs`

- Interface C++ requise : `MkDir, DirExists, FileExists, ClearDir, GetTempDir,
  FileNameFrom, DirNameFrom, MakeAbsolute, MakeRelative, IsAbsolute, CopyFile,
  WriteToFile, ReadFile, ReadDir` (source :
  `https://raw.githubusercontent.com/4ian/GDevelop/master/Core/GDCore/IDE/AbstractFileSystem.h`,
  §`class AbstractFileSystem`). Le binding JS l'expose comme
  `[JSImplementation=AbstractFileSystem] interface AbstractFileSystemJS` (source :
  `Bindings.idl` L3815–3835 ; `MakeAbsolute/MakeRelative` y sont commentées côté IDL
  mais `createNodeFileSystem` les fournit quand même — voir ci-dessous).
- Implémentation Node de référence à réutiliser : `createNodeFileSystem({ gd,
  tempDirectory })` — `mkdirSync recursive`, `rmSync+mkdirSync` pour `clearDir`,
  `getTempDir() → tempDirectory || os.tmpdir()`, normalisation forward-slash,
  passthrough `isUrl` (`/^https?:\/\//i`) pour `copyFile/makeAbsolute` (ressources
  distantes exportées par référence), `readDir` retournant `new gd.VectorString()`
  (source :
  `https://raw.githubusercontent.com/982945902/gdevelop-mcp-server/main/src/node-file-system.js`,
  107 lignes). L'éditeur fait pareil avec `assignIn(new gd.AbstractFileSystemJS(),
  localFileSystem)` (source : `LocalPreviewLauncher/index.js` §`prepareExporter`) et
  `gdcore-tools` avec `loaders.assignIn(new gd.AbstractFileSystemJS(), new
  loaders.LocalFileSystem())` (source :
  `https://raw.githubusercontent.com/arthuro555/gdcore-tools/master/src/index.mjs`
  §`localFileSystem`).
- `getTempDir` côté éditeur : `path.join(os.tmpdir(), 'GDTMP-<uid>')` (source :
  `https://raw.githubusercontent.com/4ian/GDevelop/master/newIDE/app/src/ExportAndShare/LocalExporters/LocalFileSystem.js`
  L100–101). Pour le MCP, le dossier de sortie est imposé par nous (`fs.mkdtemp`
  sous notre racine temp — §5), et `tempDirectory: outputDirectory` est passé au
  file-system (référence : `gdevelop-runtime.js` L774–776).

### 1.4 Scène paramétrable, défaut first layout

- Champs projet : `GetFirstLayout/SetFirstLayout`, `GetLayoutsCount/GetLayoutAt/
  HasLayoutNamed` (source : `Bindings.idl` §`interface Project`, vérifié ; localement
  `src/runtime.ts` L303–311 les utilise déjà). Résolution de référence :
  `sceneName || (getLayoutsCount() > 0 ? getLayoutAt(0).getName() : "")`, refus si
  vide (« The project has no scene to preview. », source : `gdevelop-runtime.js`
  L766–772). L'éditeur passe `previewExportOptions.setLayoutName(sceneName)` depuis
  `previewOptions.sceneName` (source : `LocalPreviewLauncher/index.js`
  §`launchPreview`). gb2b fait pareil mais en **réécrivant le JSON** (`firstLayout =
  sceneName` dans un fichier temp `.preview-<uuid>.json` quand override — source :
  `https://raw.githubusercontent.com/gb2b/gdevelop-mcp/main/src/core/preview-runtime.ts`
  §`prepareProjectFile`) : à NE PAS copier — nous passons le handle mémoire +
  `setLayoutName`, zéro écriture projet.
- Validation scène inconnue : refuser avant l'export via `hasLayoutNamed` (déjà le
  pattern local `requireLayout`, `src/runtime.ts` L393–401) ; message listant les
  scènes connues (cf. gb2b : `Scene "X" not found. Available: …`, même fichier).

### 1.5 Ce que le binaire local prouve (fait foi en dernier ressort)

- `vendor/libGD.js` (2 126 693 octets, sha256 `0dc79205…`) contient les 61 symboles
  embind : `Exporter_Exporter_2`, `Exporter_ExportProjectForPixiPreview_1`,
  `Exporter_ExportWholePixiProject_1`, `Exporter_GetLastError_0`,
  `Exporter_SerializeProjectData_3`, `Exporter_SerializeRuntimeGameOptions_2`,
  `Exporter_SetCodeOutputDirectory_1`, les 30+ setters `PreviewExportOptions_*`
  (dont `SetLayoutName`, `SetShouldClearExportFolder`, `SetShouldReloadProjectData`,
  `SetShouldReloadLibraries`, `SetShouldGenerateScenesEventsCode`,
  `SetFullLoadingScreen`, `SetIsDevelopmentEnvironment`, `UseMinimalDebuggerClient`,
  `UseWindowMessageDebuggerClient`, `UseWebsocketDebuggerClientWithServerAddress`,
  `AddScreenshotCapture`, `SetExternalLayoutName`, `SetPreviewContext`, …) et les 14
  méthodes `AbstractFileSystemJS_*` (source : `vendor/libGD.js`, inventaire par
  `python3 -c "re.findall(r'_emscripten_bind_…')"` le 2026-09-15 ; pin
  `vendor/libgd-pin.json`).
- Donc le MVP peut appeler toute la surface §6 sans condition de version ; les
  setters non-MVP (`SetEditorCameraState3D`, `SetInGameEditorSettingsJson`,
  `AddScreenshotCapture`, …) existent mais restent hors périmètre (capture native
  par upload signée — §4).

## 2. Render statique canvas <1s

- Référence gb2b `render_scene_static` : « Render a static preview WITHOUT running
  the game. Reads the project JSON, composes a PNG with sprites/texts placed at
  their instance positions. Sub-second per scene, no Chromium, no gdexporter »
  (source :
  `https://raw.githubusercontent.com/gb2b/gdevelop-mcp/main/src/tools/preview.ts`
  §`registerPreviewTools`, tool `render_scene_static`). Règles de rendu (source :
  `https://raw.githubusercontent.com/gb2b/gdevelop-mcp/main/src/core/render-static.ts`) :
  Sprite = première frame de la première animation (`animations[0].directions[0].
  sprites[0]`, `loadImage` du resource-map, taille custom si `customSize`, rotation
  `angle`) ; TextObject = texte + gras/italique/couleur/taille ; TiledSprite = fill
  pattern ; `Scene3D::Cube3DObject` = face avant si ressource sinon wireframe ;
  `Scene3D::Model3DObject` = wireframe (3D non supportée en statique) ; autres types
  = wireframe cyan pointillée + nom. Limites assumées : « no animations beyond frame
  0, no behaviors (positions are initial only), no effects, no real 3D » (même
  fichier, description de l'outil).
- Moteur de canvas : `@napi-rs/canvas` (`createCanvas`, `loadImage`,
  `SKRSContext2D`) (sources : `render-static.ts` L1–8 ; dépendance
  `"@napi-rs/canvas": "^1.0.0"` dans
  `https://raw.githubusercontent.com/gb2b/gdevelop-mcp/main/package.json`
  §dependencies). Pas de Chromium, pas de gdexporter, sorties `RenderStats`
  (`outputPath, sizeBytes, width, height, scene, instancesRendered,
  instancesSkipped, byType, missingObjects, missingResources, notes`).
- Adaptation à notre architecture (session mémoire, pas de fichier) : la source
  n'est plus `readFileSync(projectPath)` mais `serializeLive` → `readContentView`
  existants (`src/runtime.ts` L522–530 `serializeLive`, `src/contentView.ts`
  `readContentView`, exposés via `describeContent` sans fuite de handle —
  `src/engine.ts` L305–306). Le resource-map se construit depuis la vue
  (`resources`) + résolution relative au `filePath` de session (ou `allowedRoot`) ;
  les objets/instances depuis `view.scenes` (scène = `sceneName ?? firstLayout`).
  Le critère « statique instantané après mutation » tient car aucun export ni
  navigateur n'est lancé — appel synchrone pur après `markDirty`.
- Décision d'implémentation recommandée : nouveau module `src/previewStatic.ts`
  (pur, testable sans engine : entrée `ContentView`, comme `readContentView`), dépendance
  `@napi-rs/canvas` ajoutée (binaire natif — vérifier `npm install` CI ; sinon repli
  : PNG minimal ou refus explicite `preview-static-unavailable`). Le contraste avec
  le preview jouable (§3–4) doit figurer dans la description d'outil (reprendre le
  texte gb2b « Use this to iterate fast on layout; use preview_scene/build_preview
  when you need real runtime »).

## 3. Preview jouable : build + serveur loopback + containment + MIME

### 3.1 Pipeline d'export HTML5/GDJS (`ExporterHelper.cpp`)

- Séquence `ExportProjectForPixiPreview` (source :
  `https://raw.githubusercontent.com/4ian/GDevelop/master/GDJS/GDJS/IDE/ExporterHelper.cpp`
  §`ExporterHelper::ExportProjectForPixiPreview`, L111–~370) : `MkDir(exportPath)` ;
  `ClearDir` **si** `shouldClearExportFolder` ; `ExportResources` (avant la codegen
  car des noms de ressources peuvent changer) ; `AddLibsInclude` (moteur +
  debugger-client selon options) ; export du code événements ; `ExportIncludesAndLibs`
  ; `ExportIndexFile(exportedProject, gdjsRoot + "/Runtime/index.html",
  exportPath, includesFiles, usedSourceFiles, …)` ; `WriteToFile` de `index.html`.
  Retour `bool` + `GetLastError()` (source : `Exporter.h`, §`class Exporter`).
- Fichier `index.html` : template `GDJS/Runtime/index.html` avec placeholders
  `<!-- GDJS_CODE_FILES -->` (remplacé par les `<script src="…" crossorigin=
  "anonymous"></script>`), `/* GDJS_CUSTOM_STYLE */`, `<!-- GDJS_CUSTOM_HTML -->`,
  `{}/*GDJS_ADDITIONAL_SPEC*/`, et bootstrap `new gdjs.RuntimeGame(gdjs.projectData,
  …)` → `createStandardCanvas` → `bindStandardEvents` → `loadAllAssets(cb)` →
  `startGameLoop()` (sources :
  `https://raw.githubusercontent.com/4ian/GDevelop/master/GDJS/Runtime/index.html` ;
  `ExporterHelper.cpp` §`CompleteIndexFile`, L~1130–1170, avec garde `FileExists`
  + `Warning: Unable to find …` + skip si include manquant).
- Racine GDJS : l'exporteur copie depuis `gdjsRoot` (2e arg de `new gd.Exporter
  (fileSystem, gdjsRoot)`). En local, `third-party/GDJS/Runtime/` existe déjà
  (vérifié : `affinetransformation.js`, `capturemanager.js`, `debugger-client/`,
  `Extensions/`, `index.html`, … — `ls third-party/GDJS/Runtime`). Override prévu
  par la carte : `GDEVELOP_GDJS_ROOT` (source : `gh issue view 1`, §provisioning ;
  référence 982 : `gdjsRoot` auto-détecté `newIDE/app/resources/GDJS` puis
  `node_modules/GDJS-for-web-app-only`, overridable `GDEVELOP_GDJS_ROOT` — libgd
  research §1.2).

### 3.2 Serveur statique loopback (référence à copier)

- Implémentation de référence 107 lignes, indépendamment testable (source :
  `https://raw.githubusercontent.com/982945902/gdevelop-mcp-server/main/src/static-preview-server.js`,
  `startStaticPreviewServer({ rootDirectory, host = "127.0.0.1" })`) :
  `http.createServer` ; méthodes **GET/HEAD seules** (`405 + Allow: GET, HEAD`
  sinon) ; `decodeURIComponent(url.pathname)` dans try/catch (→ 400), `/` →
  `index.html` ; containment `path.resolve(resolvedRoot, relativePath)` +
  `resolvedPath !== resolvedRoot && !startsWith(root + sep)` → rejet ; `fs.stat`
  + `isFile()` → 404 ; `Cache-Control: no-store` ; `Content-Type` par extension
  avec **`.wasm → application/wasm`** (table : css/gif/html/ico/jpeg/jpg/js/json/
  mp3/ogg/png/svg/wasm/wav/webm/webp ; défaut `application/octet-stream`) ;
  `fs.createReadStream().pipe(response)` (HEAD : `end()` + `stream.destroy()`) ;
  `server.listen(0, host)` (port random, `server.address().port`) ; `close()` via
  `server.close(cb)` + `server.closeAllConnections?.()`.
- Variante gb2b (source : `preview-runtime.ts` §`startStaticServer`,
  §`mimeFor`) : même `listen(0, "127.0.0.1")`, garde `url.includes("..")` → 403 +
  `!path.startsWith(rootDir)` → 403, mais **sans** `.wasm` dans sa table MIME
  (défaut `application/octet-stream`) et avec en-têtes `Cross-Origin-Opener-Policy:
  same-origin` + `Cross-Origin-Embedder-Policy: require-corp`. Recommandation : base
  982 (MIME wasm correct — critique car `WebAssembly.instantiateStreaming` exige
  `application/wasm`), et **ajouter** COOP/COEP de gb2b si les builds 3D/Draco
  exigent l'isolation cross-origin (à valider en suite réelle, §7).
- Socle Node officiel : `http.createServer([options][, requestListener])`,
  `server.listen()` (port `0` = assignation aléatoire), `server.close([callback])`,
  `server.closeAllConnections()`, `server.address()` (sources :
  `https://nodejs.org/api/http.html` §`http.createServer`, §`server.listen()`,
  §`server.close([callback])`, §`server.closeAllConnections()`). Dossiers temp :
  `fsPromises.mkdtemp(prefix)` + `fsPromises.rm(path, { recursive: true, force:
  true })` (source : `https://nodejs.org/api/fs.html` §`fspromises.mkdtemp`,
  §`fspromises.rm`) ; résolution/containment : `path.resolve`, `path.relative`,
  `path.sep`, `path.extname` (source : `https://nodejs.org/api/path.html`).

### 3.3 MIME `application/wasm` : pourquoi c'est bloquant

- Le mapping `.wasm → application/wasm` de la référence 982 est l'exigence du
  streaming WebAssembly (le navigateur refuse `instantiateStreaming` sous un MIME
  générique). La table 982 couvre aussi `.mjs` ? Non — elle mappe `.js →
  text/javascript` mais pas `.mjs` (gb2b mappe `.js`+`.mjs`). Recommandation : table
  = union 982 + `.mjs → text/javascript`, `.json → application/json`,
  `.woff2 → font/woff2`, etc. (reprendre `mimeFor` gb2b pour les fonts), défaut
  `application/octet-stream`.
- Test critère « traversal → 404/403 » : la suite `static-preview-server.test.js`
  de la référence couvre le serveur isolément (source : inventaire
  `https://api.github.com/repos/982945902/gdevelop-mcp-server/contents/test?ref=main`
  : `static-preview-server.test.js`, `gdevelop-runtime.test.js`, `mcp-flow.test.js`,
  `real-*.test.js`). À reproduire : `GET /../package.json`, `GET /%2e%2e/secret`,
  `POST /`, `GET /index.html` + `Content-Type` du `.wasm`.

## 4. Logs GDJS (ring buffer) + screenshot opt-in via Puppeteer optionnel

### 4.1 D'où viennent les logs : `console.*` + `gdjs.Logger`

- Le runtime GDJS logue via la console du navigateur : `gdjs.Logger` mappe
  `info → console.log, warning → console.warn, error → console.error` avec préfixe
  `[group] message`, groupes désactivables (`discardGroup`) (source :
  `third-party/GDJS/Runtime/logger.js`, 1ère ligne — `class Logger`,
  `getDefaultConsoleLoggerOutput`, `setLoggerOutput`). `gd.js` ajoute le fallback
  `console.warn = console.warn || console.log, console.error = console.error ||
  console.log` (source : `third-party/GDJS/Runtime/gd.js`, queue du bundle).
- Donc **aucune API GDJS à appeler** pour les logs : il suffit de capter la console
  de la page. Pattern éprouvé gb2b (source : `preview-runtime.ts`
  §`previewScene`) :
  `page.on("console", msg => consoleLogs.push(`[${msg.type()}] ${msg.text()}`))` ;
  `page.on("pageerror", err => pageErrors.push(err.message))` ; retour
  `consoleLogs.slice(-50), pageErrors`. Pour #16 : ring buffer **toujours** rempli
  (cap recommandé 200, retour tronqué aux N dernières), screenshot **seulement si
  demandé** (rapide sans, complet avec).
- À NE PAS confondre avec la capture native : `PreviewExportOptions.
  AddScreenshotCapture(delayTimeInSeconds, signedUrl, publicUrl)` + `capturemanager.js`
  (`takeAndUploadScreenshot` : `canvas.toDataURL("image/png")` → `PUT signedUrl`)
  servent aux captures uploadées S3 de l'éditeur (sources : `Bindings.idl` L4515 ;
  `third-party/GDJS/Runtime/capturemanager.js`). Hors périmètre MCP : notre
  screenshot est local via Puppeteer (`page.screenshot`), pas d'URL signée.

### 4.2 Puppeteer officiel (dépendance optionnelle)

- Lancement/fermeture : `puppeteer.launch()` puis `browser.close()` (sources :
  `https://pptr.dev/guides/browser-management` §Launching/Closing a browser ;
  API `https://pptr.dev/api/puppeteer.puppeteernode.launch`,
  `https://pptr.dev/api/puppeteer.browser.close` — 200 vérifiés le 2026-09-15).
  Options de référence : `puppeteer.launch({ headless: true, args:
  ["--no-sandbox", "--disable-setuid-sandbox"] })` (source : `preview-runtime.ts`
  §`previewScene` ; gb2b `package.json` : `"puppeteer": "^25.0.4"`).
- Navigation : `page.goto(url, { waitUntil: "networkidle0", timeout: 30_000 })`
  (même source). Screenshot : `page.screenshot({ path, type: "png" })` après
  `page.setViewport({ width, height })` et attente `durationMs` (défaut gb2b 3000,
  max 30000) (sources : `preview-runtime.ts` ; API
  `https://pptr.dev/api/puppeteer.page.screenshot`,
  `https://pptr.dev/api/puppeteer.page.goto` — 200 vérifiés). Messages console :
  type `ConsoleMessage` (API `https://pptr.dev/api/puppeteer.consolemessage` —
  200 vérifié ; `msg.type()`, `msg.text()`).
- Recommandations #16 : `puppeteer` en `optionalDependencies` + `import("puppeteer")`
  dynamique (pattern gb2b : `await import("puppeteer")`), refus propre
  `preview-puppeteer-unavailable` si absent ; **toujours** `browser.close()` en
  `finally` + `server.close()` + `rm` export sauf `keepExport` debug (pattern
  `try/finally` de `previewScene`) ; timeout global du `goto` + de l'attente ;
  logs retournés même en échec (remplir le ring avant de throw) ; screenshot =
  PNG sous le dossier du preview (pas `/tmp` global) ou `screenshotPath` explicite.

## 5. Queue sérialisée + dirty hash + TTL 30 min + stop + close_project

### 5.1 Queue d'exports sérialisée globale

- Exigence amont : « One MCP process owns one libGD instance. Exports are
  serialized because GDevelop platform and extension registries are
  process-global » (source :
  `https://raw.githubusercontent.com/982945902/gdevelop-mcp-server/main/ARCHITECTURE.md`
  §Process and safety model). Mécanisme : `this.exportQueue = Promise.resolve()` ;
  chaque `build()` enchaîne `this.exportQueue.then(build, build)` et réassigne
  `this.exportQueue = queuedBuild.catch(() => {})` pour que la chaîne survive aux
  échecs (source :
  `https://raw.githubusercontent.com/982945902/gdevelop-mcp-server/main/src/preview-session-manager.js`
  §`build`). `describe()` strippe `server/buildPromise` avant retour ; `get()`
  throw `Unknown preview session` ; `list()` mappe `describe` (même fichier).
- À reprendre tel quel (queue **globale** au manager, pas par projet), en
  l'étendant : entrée `{ sessionId, sceneName?, withScreenshot?, width?, height?,
  durationMs? }`, sortie `{ previewId, url, sceneName, status, logs, … }`.

### 5.2 Dossiers/ports random + cleanup vérifié

- Dossier : `await fs.mkdir(tempRoot, { recursive: true })` puis `await
  fs.mkdtemp(path.join(tempRoot, "preview-"))`, `previewId = randomUUID()`
  (source : `preview-session-manager.js` §`build`, §ctor `tempRoot =
  path.join(os.tmpdir(), "gdevelop-mcp")`). Port : `serverFactory({ rootDirectory:
  outputDirectory })` → `listen(0)` (§3.2).
- Stop : si `building`, `await buildPromise.catch(() => {})` ; `await
  server.close()` ; `#removeOutputDirectory` **avec garde** `resolvedOutput.
  startsWith(tempRoot + sep)` sinon throw `Refusing to remove preview outside temp
  root` ; `status = "stopped"`, `url = null`, `stoppedAt` (source : même fichier,
  §`stop`, §`#removeOutputDirectory`). `stopForProject(projectId)` filtre les non-
  `stopped` ; `closeAll()` en `Promise.allSettled` (même fichier).
- `close_project` stoppe les liées **avant** de libérer le handle :
  `await previews.stopForProject(projectId); projects.close(projectId)` (source :
  `https://raw.githubusercontent.com/982945902/gdevelop-mcp-server/main/src/mcp-server.js`
  §`close_project`, L~530–545 ; `build_preview` L469–493, `get_preview_status`
  L494–509 readOnly, `stop_preview` L511–528 destructive). Localement, `close()`
  refuse si dirty sauf `force:true` puis `project.delete()` (source :
  `src/sessions.ts` L105–115) — y brancher `previewManager.stopForSession(id)`.

### 5.3 Dirty hash (rebuild seulement si dirty) — pas de précédent, spec à figer

- Ni l'éditeur (hot-reload par flags `shouldReload*`, source :
  `LocalPreviewLauncher/index.js` §`shouldHotReload`) ni 982 (rebuild à chaque
  `build()`) ne hashent. Recommandation : `sha256(Serializer.toJSON(
  serializeTo(element)))` via `node:crypto.createHash("sha256")` (source :
  `https://nodejs.org/api/crypto.html` §`crypto.createHash`) ; stocker
  `{ sceneName, projectHash, exportHash?, status, readyAt }` par preview ; au
  `build_preview` même `(sessionId, sceneName)` : si `session.dirty === false` ET
  `hash === record.projectHash` ET dossier/serveur vivants → retourner le record
  (compteur `hits++`, `lastAccess = now`) sans réexporter ; sinon réexporter
  (avec `setShouldClearExportFolder(true)` plein, pas de hot-reload partiel au
  MVP). Marquer `session.dirty` ne suffit pas seul (mutations externes via batch) —
  le hash est la garde, le flag un fast-path.
- Coût : `toJSON` full-project par build (même coût que le snapshot pipeline
  `src/pipeline.ts` ; acceptable au MVP, cf. fog perf #1 « snapshots
  Serializer.toJSON par op » — source : `gh issue view 1`, §Not yet specified).

### 5.4 TTL 30 min — pas de précédent, spec à figer

- Aucun TTL dans 982/gb2b/éditeur. Recommandation : `TTL_MS = 30 * 60 * 1000` ;
  `expiresAt = lastAccess + TTL` ; timer `setTimeout(stop, ttl).unref()` par
  preview + `refresh()` sur `get_preview_status`/`build_preview` (même scène) ;
  `stop()` idempotent (garde `status === "stopped"`) ; `closeAll()` à l'arrêt
  process. Citer `https://nodejs.org/api/timers.html` §`setTimeout`,
  §`timeout.unref()` (le timer ne doit pas retenir le process). Le critère « stop
  + TTL nettoient processus et disque » se teste avec TTL court injecté (fake
  timers) + `lsof`/port fermé + dossier supprimé.

## 6. Flags PreviewExportOptions + fix Draco

### 6.1 Table des flags (IDL + éditeur + référence)

Références de la table : IDL
`https://raw.githubusercontent.com/4ian/GDevelop/master/GDevelop.js/Bindings/Bindings.idl`
L4475–4515 ; usages éditeur
`https://raw.githubusercontent.com/4ian/GDevelop/master/newIDE/app/src/ExportAndShare/LocalExporters/LocalPreviewLauncher/index.js`
§`launchPreview` ; usages headless
`https://raw.githubusercontent.com/982945902/gdevelop-mcp-server/main/src/gdevelop-runtime.js`
L781–787 ; sémantique C++
`https://raw.githubusercontent.com/4ian/GDevelop/master/GDJS/GDJS/IDE/ExporterHelper.cpp`
§`ExporterHelper::ExportProjectForPixiPreview`.

| Setter (JS camelCase, via `postjs.js`) | IDL (`Bindings.idl` L4475–4515) | Valeur MVP recommandée | Source usage |
|---|---|---|---|
| `setLayoutName` | L4481 | scène résolue (défaut first layout) | `LocalPreviewLauncher` (`setLayoutName(sceneName)`), `gdevelop-runtime.js` L781 |
| `setShouldClearExportFolder` | L4488 | `true` (rebuild plein ; hot-reload partiel hors MVP) | `LocalPreviewLauncher` (hot-reload conditionnel), `gdevelop-runtime.js` L782 |
| `setShouldReloadProjectData` | L4489 | `true` | idem L783 |
| `setShouldReloadLibraries` | L4490 | `true` | idem L784 |
| `setShouldGenerateScenesEventsCode` | L4491 | `true` | idem L785 |
| `setFullLoadingScreen` | L4493 | `false` (skip durée mini + logo, feedback rapide) | `LocalPreviewLauncher` (`setFullLoadingScreen(previewOptions.fullLoadingScreen)`), `gdevelop-runtime.js` L786 |
| `setIsDevelopmentEnvironment` | L4494 | `true` (APIs dev GDevelop) | idem L787 |
| `useMinimalDebuggerClient` | L4479 | `true` en headless (pas de serveur debugger) | 982 ne l'appelle pas (lacune) ; éditeur choisit websocket/window-message selon contexte — en MCP headless, minimal évite le serveur |
| `setPreviewContext`, `setSourceGameId`, `setGDevelopVersionWithHash`, `setProjectTemplateSlug` | L4511–4514 | non settés au MVP (défauts) | `LocalPreviewLauncher` les sette depuis props éditeur ; inutiles headless |
| `setExternalLayoutName`, `setEventsBasedObjectType/Variant`, `setEditorCameraState3D`, `setInGameEditorSettingsJson`, `addScreenshotCapture`, `setIncludeFileHash`, `setElectronRemoteRequirePath`, auth/players | L4484–4487, L4496–4510, L4515 | hors MVP | mêmes fichiers ; `AddScreenshotCapture` = upload S3 natif, pas notre screenshot Puppeteer (§4.1) |

- Sémantique hot-reload à connaître (même si non reprise au MVP) : si
  `isInGameEdition && !shouldReloadProjectData && !shouldReloadLibraries &&
  !shouldGenerateScenesEventsCode && !shouldClearExportFolder` → export **skippé**
  (`LogStatus("Skip project export entirely")`, source :
  `https://raw.githubusercontent.com/4ian/GDevelop/master/GDJS/GDJS/IDE/ExporterHelper.cpp`
  L111–120) ; sinon `ClearDir` seulement si `shouldClearExportFolder`. Notre MVP :
  toujours les 4 à `true` + `ClearDir`, donc export complet déterministe.
- Erreurs : `exportProjectForPixiPreview` retourne `bool` ; en `false`, lire
  `exporter.getLastError()` (source :
  `https://raw.githubusercontent.com/4ian/GDevelop/master/GDJS/GDJS/IDE/Exporter.h`
  §`GetLastError` ; pattern 982 L788–794 dans
  `https://raw.githubusercontent.com/982945902/gdevelop-mcp-server/main/src/gdevelop-runtime.js` :
  `` `GDevelop preview export failed${detail ? `: ${detail}` : "."}` ``).
  Toujours `delete()` options/exporter/fileSystem en `finally` (pattern 982
  L795–799 ; discipline WASM : `EmscriptenObject.delete()`, libgd research §1.3).

### 6.2 Fix Draco (à conserver tel quel)

- Amont : `AddLibsInclude(pixiInThreeRenderers || isInGameEdition)` ajoute
  `pixi-renderers/three.js`, `ThreeAddons.js`, objets 3D… et met
  `pixi-renderers/draco/gltf/draco_decoder.wasm` + `draco_wasm_wrapper.js` dans
  **`resourcesFiles`** (copiés, pas scriptés) avec le commentaire : « The Draco
  decoder files are not included with a script tag: they are fetched by the
  DRACOLoader (of ThreeAddons.js) when a 3D model compressed with Draco must be
  read » (source :
  `https://raw.githubusercontent.com/4ian/GDevelop/master/GDJS/GDJS/IDE/ExporterHelper.cpp`
  §`AddLibsInclude`, L~1260–1290).
- Bug observé : « Some libGD/GDJS artifact combinations list the raw Draco binary
  as an include file. It must be fetched by DRACOLoader, never parsed as JS »
  → sanitize post-export : `html.replace(/^\s*<script[^>]+src=["'][^"']+\.wasm
  ["'][^>]*><\/script>\s*$/gm, "")`, réécrire `index.html` si différent (source :
  `https://raw.githubusercontent.com/982945902/gdevelop-mcp-server/main/src/gdevelop-runtime.js`
  L796–804). Recommandation : garder ce fix + assertion
  post-export « aucun `<script … .wasm …>` » en test réel ; servir le `.wasm`
  copié avec `application/wasm` (§3.3) pour que `DRACOLoader` le fetche.

## 7. Risques, lacunes et recommandations d'implémentation + plan de tests

### 7.1 Risques / lacunes

1. **Puppeteer absent par défaut** : 982 n'a ni logs ni screenshot (ses records
   n'ont que `previewId/projectId/status/sceneName/outputDirectory/url/error/
   startedAt/readyAt` — source : `preview-session-manager.js` §`build`). gb2b a
   les deux mais via `gdexporter` tiers (banni par la carte : libGD réel non
   négociable). Risque poids/IR : Chromium (~150 Mo) — d'où `optionalDependencies`
   + import dynamique + refus propre.
2. **`--no-sandbox` en CI/root** : requis dans les conteneurs (source :
   `preview-runtime.ts`), mais élargit la surface — acceptable car navigateur
   éphémère pointant uniquement sur `127.0.0.1:<port>` (jamais d'URL externe).
3. **Discipline WASM** : tout `new gd.*` doit être `delete()` ; `keys()` retourne
   une référence non-owned (piège documenté `src/runtime.ts` L432–439). Étendre la
   règle à `PreviewExportOptions/Exporter/AbstractFileSystemJS/SerializerElement`
   (`try/finally`, pattern 982 L795–799).
4. **Debugger client** : ne pas copier le `useWebsocketDebuggerClientWithServerAddress`
   de l'éditeur (il suppose `LocalPreviewDebuggerServer.startServer`, source :
   `LocalPreviewLauncher/index.js` + `LocalPreviewDebuggerServer.js`) ;
   `useMinimalDebuggerClient()` suffit (flag IDL L4479, `includeMinimalDebuggerClient`
   → `debugger-client/minimal-debugger-client.js`, source : `ExporterHelper.cpp`
   L~1255–1265).
5. **Ressources absolues vs relatives** : `ExportResources` résout depuis
   `project.GetProjectFile()` (`DirNameFrom` + `ResourcesMergingHelper`, source :
   `ExporterHelper.cpp` L~130–160). Sessions sans fichier (`create_project` non
   sauvé) : exiger `import_resource` avec fichiers copiés à côté d'un chemin
   projet ou refuser le preview `resources-unresolved` (à trancher à l'implé).
6. **Folder-project** : refusé au MVP (`src/sessions.ts` L48–54
   `folder-project-unsupported`) — le preview hérite du refus (pas d'unsplit).
7. **Charge** : export plein + `toJSON` hash à chaque build ; queue globale = un
   seul export à la fois ( feedback lent sur gros projets — fog #1, source :
   `gh issue view 1`).
8. **Isolation réseau** : COOP/COEP (gb2b) vs pas (982) — trancher en suite réelle
   avec un projet 3D+Draco (§6.2) ; par défaut reprendre 982 + `no-store`.

### 7.2 Recommandations d'implémentation (ordre)

1. `src/preview.ts` : `PreviewPorts { buildPreview(project, outDir, { sceneName }) }`
   étendant `EnginePorts` (flags §6.1 + fix Draco §6.2 + `getLastError`), avec
   `createPreviewEngine(gd, gdjsRoot)` dans `src/runtime.ts` (même `createNodeFileSystem`
   porté depuis la référence, chemins forward-slash).
2. `src/previewManager.ts` : `PreviewManager { build(sessionId, opts),
   status(id?), stop(id), stopForSession(sessionId), closeAll(), sweep() }` —
   queue globale (§5.1), `mkdtemp preview-` + `randomUUID` (§5.2), dirty-hash §5.3,
   TTL 30 min + `unref` §5.4, ring buffer logs (cap 200) §4.1, screenshot opt-in
   §4.2, `describe()` sans `server/buildPromise/browser`.
3. `src/previewStatic.ts` : rendu canvas pur depuis `ContentView` (§2), sans engine.
4. Outils `render_scene_static`, `build_preview { sessionId, scene?,
   withScreenshot?, width?, height?, durationMs? }`, `get_preview_status
   { previewId? }` (readOnly), `stop_preview { previewId }` (destructive) ;
   `close_project` → `stopForSession` avant `sessions.close` (§5.2). zod partout,
   erreurs `isError:true` (pattern `src/tools.ts` + `runTool` 982).
5. Serveur : copier `static-preview-server.js` (GET/HEAD, MIME + wasm/mjs, containment
   `resolve`, `no-store`, `closeAllConnections`) (§3.2) ; table MIME union 982+gb2b.

### 7.3 Plan de tests (faux exporter + suite opt-in réelle)

- **Faux exporter (toujours verts)** — miroir de
  `https://raw.githubusercontent.com/982945902/gdevelop-mcp-server/main/test/gdevelop-runtime.test.js`
  (fake `gd` : `FakePreviewOptions` setters no-op + `delete()`, `FakeExporter.
  exportProjectForPixiPreview` écrivant `index.html`, asserts `optionsDeleted/
  exporterDeleted/fileSystemDeleted`) et de `static-preview-server.test.js` :
  (a) build sans save ne touche pas au fichier projet (mtime/hash inchangés) ;
  (b) défaut first layout + override + scène inconnue refusée ; (c) rebuild
  seulement si dirty (2e build même hash → `hits === 1`, exporteur non rappelé) ;
  (d) logs sans screenshot rapides (pas de browser lancé — factory Puppeteer fake) ;
  avec screenshot (fake `page.screenshot` écrit un PNG 1×1) ; (e) traversal
  `/%2e%2e/`, `/..%2f`, méthode POST → 404/403/405, `.wasm` servi en
  `application/wasm` ; (f) `stop` + TTL court (fake timers) suppriment dossier +
  ferment port ; (g) `close_project` stoppe les liées ; (h) Draco : `index.html`
  avec `<script src="…draco….wasm">` est sanitizé ; (i) queue : 2 builds
  concurrents s'exécutent en série (ordre vérifié).
- **Suite opt-in réelle** (`GDEVELOP_LIBGD_PATH`/`GDEVELOP_GDJS_ROOT`/
  `GDEVELOP_TEST_PROJECT`, miroir de `test/real-runtime.test.js` + `test:runtime`
  `node --test test/real-runtime.test.js`, source : `package.json` §scripts de
  982 ; localement `test/real-libgd.test.ts`) : export vrai d'un projet fixture
  (1 scène, 1 sprite), `index.html` sans script-wasm, serveur loopback réel
  (`GET /` 200, `Content-Type` wasm correct sur `draco_decoder.wasm` si projet 3D),
  Puppeteer réel **seulement si** `GDEVELOP_PREVIEW_BROWSER=1` (logs GDJS non vides,
  screenshot PNG >0 octets) ; sinon la suite réelle couvre tout sauf le screenshot.
- Modèle local à suivre : doubles `gd` sous `test/fakeEngine.ts`, runner
  `node --test` sur `dist/test/**/*.test.js` (`package.json` §scripts), baseline
  `npm run build` d'abord.

### Index des sources primaires (toutes résolues le 2026-09-15)

- Moteur (`4ian/GDevelop@master`, release `v5.6.282` du 2026-09-11,
  `https://api.github.com/repos/4ian/GDevelop/releases/latest` ; commit
  `89c44ffe7dc62b2256816dbc07aadf22f9c8d33c`) :
  `GDevelop.js/Bindings/Bindings.idl` (L1712–1720 Serializer, L3815–3835
  AbstractFileSystemJS, L4475–4540 PreviewExportOptions/ExportOptions/Exporter),
  `GDevelop.js/Bindings/postjs.js` (L1–60 `adaptNamingConventions`, L192–225
  `fromJSObject`), `GDevelop.js/Bindings/prejs.js`,
  `GDJS/GDJS/IDE/Exporter.h` (§`class Exporter`),
  `GDJS/GDJS/IDE/ExporterHelper.h` (§`struct PreviewExportOptions`),
  `GDJS/GDJS/IDE/ExporterHelper.cpp` (§`ExportProjectForPixiPreview` L111–145,
  §`CompleteIndexFile`, §`AddLibsInclude` Draco L~1260–1290),
  `Core/GDCore/IDE/AbstractFileSystem.h` (§`class AbstractFileSystem`),
  `GDJS/Runtime/index.html` (template + `RuntimeGame/loadAllAssets/startGameLoop`),
  `GDJS/Runtime/logger.js` (`gdjs.Logger` → console), `GDJS/Runtime/gd.js`
  (fallback console), `GDJS/Runtime/capturemanager.js` (upload signé — hors périmètre),
  `newIDE/app/src/ExportAndShare/LocalExporters/LocalPreviewLauncher/index.js`
  (§`prepareExporter`, §`launchPreview`), `newIDE/app/src/ExportAndShare/
  LocalExporters/LocalFileSystem.js` (L100–101 `getTempDir`),
  `newIDE/app/src/ExportAndShare/LocalExporters/LocalPreviewLauncher/
  LocalPreviewDebuggerServer.js`, `newIDE/app/src/ExportAndShare/PreviewLauncher.flow.js`
  (types `PreviewOptions/CaptureOptions`).
- Binaire local : `vendor/libGD.js` (61 symboles embind `Exporter/
  PreviewExportOptions/ExportOptions/AbstractFileSystemJS`, §1.5),
  `vendor/libgd-pin.json`, `third-party/GDJS/Runtime/`.
- Références : `982945902/gdevelop-mcp-server@main` (v0.4.0) :
  `src/gdevelop-runtime.js` (L765–811 `buildPreview`, L796–804 fix Draco),
  `src/node-file-system.js`, `src/static-preview-server.js` (107 lignes),
  `src/preview-session-manager.js` (queue, mkdtemp, stop, containment),
  `src/mcp-server.js` (L469–545 `build_preview/get_preview_status/stop_preview/
  close_project`), `ARCHITECTURE.md` (§Process and safety model),
  `test/` (`gdevelop-runtime.test.js` fake, `static-preview-server.test.js`,
  `real-runtime.test.js`, `package.json` §`test:runtime`) ;
  `gb2b/gdevelop-mcp@main` (v0.21.0) : `src/tools/preview.ts`
  (`preview_scene` ~10s vs `render_scene_static` <1s), `src/core/preview-runtime.ts`
  (`prepareProjectFile`, `startStaticServer`, `runExport`, `page.on console/pageerror`,
  `--no-sandbox`, `networkidle0` 30s, `slice(-50)`), `src/core/render-static.ts`
  (`@napi-rs/canvas`, règles par type), `package.json` (`@napi-rs/canvas`,
  `gdexporter`, `puppeteer ^25.0.4`) ; `arthuro555/gdcore-tools@master` :
  `src/index.mjs` (init no-fetch, `initializePlatforms×1`, `localFileSystem`,
  `exportProject`), `src/open_project.mjs` (unsplit depth 3, split paths).
- Docs officielles : `https://pptr.dev/guides/browser-management` (launch/close),
  `https://pptr.dev/guides/page-interactions`, API `puppeteer.puppeteernode.launch`,
  `puppeteer.page.screenshot`, `puppeteer.page.goto`, `puppeteer.browser.close`,
  `puppeteer.consolemessage` (200 vérifiés) ; `https://nodejs.org/api/http.html`
  (`createServer`, `server.listen/close/closeAllConnections`), `…/fs.html`
  (`mkdtemp`, `rm`), `…/crypto.html` (`createHash`), `…/path.html`, `…/timers.html`.
- Repo local : `src/tools.ts` (zéro outil preview), `src/sessions.ts` (L48–54 refus
  folder, L105–115 `close`), `src/runtime.ts` (L845–891 Serializer, L393–401
  `requireLayout`), `src/engine.ts`, `src/contentView.ts`, `src/pipeline.ts`,
  `scripts/provision-libgd.mjs`, `src/libgdPin.ts`, `test/`, `package.json`
  (`engines >=20`), `docs/research/gdevelop-mcp-libgd-research.md` (§ Exporter).
