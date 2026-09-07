# GDevelop MCP server over libGD.js — primary-source research

> Scope: how to build a Node.js/TypeScript MCP server on `@modelcontextprotocol/sdk` that mutates
> GDevelop projects through the **real engine API (GDevelop.js / libGD.js, `gd.*`)** instead of raw-JSON
> editing. Every factual claim below cites the primary source that owns it (URL + file/section).
> URLs that did not resolve on 2026-09-07 were dropped: `spec.modelcontextprotocol.io` (transport
> error — use `https://modelcontextprotocol.io/specification/latest` instead), `https://api.gdevelop.io/`
> bare root (HTTP 403 — endpoints exist under paths, see §5), `libGD.js-for-tests-only` on npmjs/registry
> (404 — it is **not** an npm package, it is a local directory the IDE's own script creates, see §1.2).
> `https://docs.gdevelop.io/` redirects; the maintained user docs live at `https://wiki.gdevelop.io/`.

## 0. Goal recap

Build a stdio MCP server (TypeScript, `@modelcontextprotocol/sdk`) whose tools hold an **in-memory
`gd.Project` session** (isolated per project ID), mutate it exclusively via libGD.js calls
(`gd.ProjectHelper`, `gd.Serializer`, `ObjectsContainer.insertNewObject`, `EventsList.insertNewEvent`,
`gd.Exporter`, …), validate with engine metadata/diagnostics, save atomically, and serve playable
previews over a loopback HTTP server. Reference points: `gb2b/gdevelop-mcp` (raw-JSON + catalog +
safety know-how to reuse) and `982945902/gdevelop-mcp-server` (libGD.js + `gd.Exporter` skeleton to
extend, with deletion/scene-management gaps to fill).

---

## 1. libGD.js API map

### 1.1 What GDevelop.js / libGD.js is, and where the artifact comes from

- GDevelop.js = Emscripten/WebIDL bindings of the GDevelop Core (+ GDJS + Extensions) to
  WebAssembly+JavaScript, runnable in browser **or Node.js**. The IDL file describing every exposed
  class is the contract; the C++ classes are documented on the GDCore docs site.
  Source: `GDevelop.js/README.md` §"GDevelop.js", "Documentation":
  `https://github.com/4ian/GDevelop` (repo root verified), file
  [`GDevelop.js/README.md`](https://github.com/4ian/GDevelop/blob/master/GDevelop.js/README.md),
  and [`GDevelop.js/Bindings/Bindings.idl`](https://github.com/4ian/GDevelop/blob/master/GDevelop.js/Bindings/Bindings.idl)
  (4639 lines; all interfaces below are from this file unless noted).
- The `GDevelop.js/package.json` (`name: "GDevelop.js"`, `version: "0.0.1"`) has **no publish
  configuration**; the supported distribution paths are: (a) locally built
  `Binaries/embuild/GDevelop.js/libGD.js` (all `GDevelop.js/__tests__/*.js` require exactly this
  path, e.g. [`__tests__/Serializer.js`](https://github.com/4ian/GDevelop/blob/master/GDevelop.js/__tests__/Serializer.js));
  (b) the IDE-imported copies under `newIDE/app` (see §1.2); (c) community bundles of prebuilt
  artifacts such as `gdcore-tools` (`dist/lib/libGD.cjs` + `libGD.wasm`, observed in the published
  `gdcore-tools@2.0.0-gd-v5.6.269-autobuild` tarball, `https://github.com/arthuro555/gdcore-tools`).
- `libGD.js-for-tests-only` is **not** an npm package (404 on both npmjs page and registry API).
  It is a local directory (`newIDE/app/node_modules/libGD.js-for-tests-only/`) created by the IDE's
  own script [`newIDE/app/scripts/import-libGD.js`](https://github.com/4ian/GDevelop/blob/master/newIDE/app/scripts/import-libGD.js),
  which copies a local `Binaries/embuild/GDevelop.js` build or downloads a prebuilt libGD.js from
  `https://s3.amazonaws.com/gdevelop-gdevelop.js` (branch-resolved). `newIDE/app/public/libGD.js` is
  the browser copy served by the editor.

### 1.2 Loading libGD.js in Node.js (initialization sequence)

Verified pattern, identical in the engine's own tests, the reference server, and `gdcore-tools`:

1. `const initializeGDevelopJs = require('<path>/libGD.js')` (CJS initializer module; ESM consumers
   use `createRequire`). Source: [`GDevelop.js/__tests__/GDJSBasicCodeGenerationIntegrationTests.js`](https://github.com/4ian/GDevelop/blob/master/GDevelop.js/__tests__/GDJSBasicCodeGenerationIntegrationTests.js)
   (`require('../../Binaries/embuild/GDevelop.js/libGD.js')`) and
   [`gdevelop-mcp-server/src/gdevelop-runtime.js`](https://github.com/982945902/gdevelop-mcp-server/blob/main/src/gdevelop-runtime.js)
   L217–225 (`initializerModule.default || initializerModule`, must be a function).
2. `const gd = await initializeGDevelopJs()` — resolves to the `gd` namespace. The editor additionally
   passes Emscripten options (`locateFile` for the `.wasm` URL + cache-buster):
   [`newIDE/app/src/index.js`](https://github.com/4ian/GDevelop/blob/master/newIDE/app/src/index.js) L73–99.
3. `gd.ProjectHelper.initializePlatforms()` — **exactly once per process**; a second call logs an
   error and returns (guard `static bool initialized`):
   [`GDevelop.js/Bindings/ProjectHelper.h`](https://github.com/4ian/GDevelop/blob/master/GDevelop.js/Bindings/ProjectHelper.h).
   `ProjectHelper.createNewGDJSProject()` adds the JS platform (`JsPlatform::Get()`) to the new project.
4. Node-specific gotchas (from [`gdcore-tools/src/index.mjs`](https://github.com/arthuro555/gdcore-tools/blob/master/src/index.mjs)):
   temporarily `delete globalThis.fetch` before init (otherwise Emscripten misdetects a browser), restore
   after; expose `global.gd` while loading bundled extension loaders, then delete it.
5. Method naming: Emscripten WebIDL binder emits `PascalCase`; `postjs.js` renames everything to
   **camelCase** at load (`STATIC_`→static, `FREE_`→module fn, `MAP_`/`WRAPPED_` stripped,
   `CLONE_`→`clone`). So C++ docs (`PascalCase`) map to JS (`camelCase`):
   [`GDevelop.js/Bindings/postjs.js`](https://github.com/4ian/GDevelop/blob/master/GDevelop.js/Bindings/postjs.js).
   `gdcore-tools` README states the same rule, pointing at the GDCore namespace docs
   (`https://github.com/arthuro555/gdcore-tools`).
6. Extension (GDJS runtime) registration in Node: iterate `<gdjsRoot>/Runtime/Extensions/*/JsExtension.js`,
   `require` each, call `createExtension(identity, gd)`, optionally run `runExtensionSanityTests(gd, ext)`
   and fail on any truthy entry, then `gd.JsPlatform.get().addNewExtension(ext)` + `extension.delete()`:
   [`gdevelop-mcp-server/src/gdevelop-runtime.js`](https://github.com/982945902/gdevelop-mcp-server/blob/main/src/gdevelop-runtime.js) L231–286.
   Skip directories containing "Example". `GDEVELOP_LOAD_EXTENSIONS=false` escape hatch exists for tests
   whose projects use no standard extensions (README of
   [`982945902/gdevelop-mcp-server`](https://github.com/982945902/gdevelop-mcp-server)).
   Artifact auto-detect order: `Binaries/embuild/GDevelop.js/libGD.js` →
   `newIDE/app/node_modules/libGD.js-for-tests-only/index.js` or `newIDE/app/public/libGD.js` →
   explicit `GDEVELOP_LIBGD_PATH`; GDJS root: `newIDE/app/resources/GDJS` then
   `newIDE/app/node_modules/GDJS-for-web-app-only`, overridable via `GDEVELOP_GDJS_ROOT` (same README).

### 1.3 Project create / open / save / serialize

| Operation | libGD.js calls (JS camelCase; IDL `Bindings.idl` refs) |
|---|---|
| Create | `gd.ProjectHelper.createNewGDJSProject()` (`ProjectHelper`, IDL L144–151); then `project.setName/setDescription/setGameResolutionSize/setAdaptGameResolutionAtRuntime/setMaximumFPS/setMinimumFPS/setFirstLayout/setProjectFile` (`Project`, IDL L570–719); 3D scene = `layout.insertNewLayer('World3D',0)` + `layer.setRenderingType('3d')`, perspective camera + near/far planes. Source: `gdevelop-runtime.js` L312–381 |
| Open (single-file) | `JSON.parse(readFile)` → `gd.Serializer.fromJSObject(obj)` → `project.unserializeFrom(el)` → `project.setProjectFile(absPath)`; `delete()` element on completion, `delete()` project on error. Source: `gdevelop-runtime.js` L288–310 |
| Open (folder project — REQUIRED for parity) | Additionally: set `object.properties.projectFile`, `unsplit()` with `__REFERENCE_TO_SPLIT_OBJECT` refs (max depth 3), then `loadProjectEventsFunctionsExtensions(project, codeWriter, i18n)`. Split folders: `layouts/ externalLayouts/ externalEvents/ eventsFunctionsExtensions/`. Neither reference server does this — both will corrupt/misload folder projects. Source: [`gdcore-tools/src/open_project.mjs`](https://github.com/arthuro555/gdcore-tools/blob/master/src/open_project.mjs) |
| Save | `const el = new gd.SerializerElement(); project.serializeTo(el); writeFile(projectFile, gd.Serializer.toJSON(el))`. `Serializer` static: `toJSON/fromJSON`, canonical mode flag (IDL L1712–1743). Source: `gdevelop-runtime.js` L383–396; round-trip tests in [`__tests__/GDJSProjectSerialization.js`](https://github.com/4ian/GDevelop/blob/master/GDevelop.js/__tests__/GDJSProjectSerialization.js) |
| Memory | Every `new gd.*` must eventually `.delete()` (WASM heap; `EmscriptenObject.delete()`, `gd.d.ts` generated by `GDevelop.js/scripts/generate-dts.js`). Ownership trap: `Animation/Direction` take ownership of added `Sprite` — deleting the wrapper corrupts the project (comment in `gdevelop-runtime.js` L515–519). `Vector*` temporaries (`VectorPolygon2d`, `VectorString`) also need `delete()` |

### 1.4 Scenes (layouts), layers, objects, behaviors, groups

- **Layouts/scenes** (`Layout`, IDL L1027–…): `project.insertNewLayout(name, pos)` / `removeLayout(name)` /
  `hasLayoutNamed/getLayout/getLayoutAt/getLayoutsCount/moveLayout/swapLayouts/setFirstLayout/getFirstLayout`.
  Scene content accessors: `layout.getObjects()`, `layout.getInitialInstances()`, `layout.getEvents()`,
  `layout.getVariables()`, `layout.getLayers()`, plus `layout.updateBehaviorsSharedData(project)`
  (**must** be called after adding behaviors — `gdevelop-runtime.js` L628).
- **Layers**: prefer `layout.getLayers()` (`LayersContainer`, IDL L1243+):
  `insertNewLayer(name,pos) / removeLayer(name) / hasLayerNamed / getLayer / getLayersCount / moveLayer`.
  (`Layout.insertNewLayer` etc. are marked deprecated in IDL.) 982945902's `addSceneLayer` uses
  `layout.insertNewLayer(layerName, layout.getLayersCount())` (`gdevelop-runtime.js` L444–450).
- **Objects** (`ObjectsContainer`, IDL L521–569): `insertNewObject(project, type, name, pos)` where
  `type` is the object-type string (`"Sprite"`, `"TextObject::Text"`, `"SpineObject::SpineObject"`, …);
  `hasObjectNamed/getObject/getObjectAt/getObjectsCount/removeObject/moveObject/getObjectPosition`;
  `getObjectGroups()`; free helpers `GetTypeOfObject / GetTypeOfBehavior / GetBehaviorsOfObject`
  (module-level `gd.getTypeOfObject(containers, name, searchInGroups)` after `FREE_` rename).
- **Object instance** (`gdObject`, IDL L927–…): `addNewBehavior(project, type, name)` /
  `getBehavior(name) / hasBehaviorNamed / removeBehavior / renameBehavior / getAllBehaviorNames()`;
  `getVariables()` (object variables), `getConfiguration()` + typed downcasts
  `gd.asSpriteConfiguration / gd.asTextObjectConfiguration / gd.asTiledSpriteConfiguration / gd.asSpineConfiguration`
  (cast pattern proven in `__tests__/GDJSProjectSerialization.js`).
- **Behavior properties**: `behavior.updateProperty(name, value) → boolean` (all values are strings;
  booleans as `"1"/"0"`); enumerate via `behavior.getProperties()` (`MapStringPropertyDescriptor`,
  `.keys()` + `.at(i)`); case-insensitive name resolution is a client-side convenience implemented in
  `gdevelop-runtime.js` L603–627. `initializeContent()` before first use.
- **Object configuration properties**: `ObjectConfiguration.getProperties()/updateProperty(name,value)`,
  instance-level `getInitialInstanceProperties(instance)/updateInitialInstanceProperty(instance,…)`
  (IDL L887–927); `SanityCheckObjectProperty` helpers exist for tests (`ProjectHelper.h`).
- **Object groups** (`ObjectGroupsContainer`/`ObjectGroup`, IDL L358–431):
  `groups.insertNew(name, groups.count())`, `group.addObject/removeObject/find(name)`,
  `groups.has(name)`, `getAt(i)/count()`. Source usage: `gdevelop-runtime.js` L471–482.

### 1.5 Variables (globals / scene / object / instance; primitive / structure / array)

- `Variable_Type` enum (IDL L~250): `Unknown, MixedTypes, String, Number, Boolean, Structure, Array`.
- `VariablesContainer` (IDL L319–347; source-type enum includes `Global, Scene, Object, Local,
  ExtensionGlobal, ExtensionScene, Parameters, Properties`): `insertNew(name, index)` /
  `has(name) / get(name) / getAt(i) / remove(name) / rename / count()`.
- `Variable` (IDL L261–319): `castTo('array'|'structure'|'string'|'number'|'boolean')`,
  `setValue(double)/setString/setBool`, `clearChildren()`, `getChild(name)` (creates),
  `pushNew()` (array append), `removeAtIndex`, `getAllChildrenNames`. Recursive setter pattern
  (array→cast+clear+pushNew each item; object→cast+clear+recurse; bool/number/string leaves) in
  `gdevelop-runtime.js` L59–84, used for global, scene, object **and instance** variables
  (`instance.getVariables()`, L670–676).
- Containers: `project.getVariables()` (globals), `layout.getVariables()` (scene),
  `object.getVariables()`, `instance.getVariables()`; event-local variables via
  `BaseEvent.getVariables()` (`CanHaveVariables/HasVariables`, IDL `BaseEvent`).

### 1.6 Instances (`InitialInstancesContainer` / `InitialInstance`, IDL L1514–1639)

- `layout.getInitialInstances().insertNewInitialInstance()` → setters `setObjectName/setX/setY/setZ/
  setLayer/setZOrder/setAngle/setRotationX/Y/setFlippedX/Y/Z/setOpacity/setLocked/setSealed/setHidden`;
  custom size: `setHasCustomSize(true)` + `setShouldKeepRatio` + `setCustomWidth/Height/Depth`;
  per-instance `getVariables()`; `removeInstance(inst)`, `removeInitialInstancesOfObject(name)`,
  `renameInstancesOfObject`, `getInstancesCount/getLayerInstancesCount`, `moveInstancesToLayer`.
  Usage: `gdevelop-runtime.js` L640–678. Z-order helpers: `HighestZOrderFinder` (IDL).

### 1.7 Events system

- `EventsList` (IDL L2540–2590): `insertNewEvent(project, type, pos)` (type = full string, e.g.
  `"BuiltinCommonInstructions::Standard"`), `getEventAt/getEventsCount/clear/removeEventAt/
  removeEvent/moveEventToAnotherEventsList/isEmpty`. `BaseEvent`: `getType/isExecutable/
  canHaveSubEvents/getSubEvents/canHaveVariables/getVariables/isDisabled/setDisabled/isFolded/
  setFolded/getInstructionList(label)`, plus `getAiGeneratedEventId/setAiGeneratedEventId`.
- Concrete event classes in IDL (all `implements BaseEvent`): `StandardEvent`
  (`getConditions()/getActions()`, L2590+), `ElseEvent`, `RepeatEvent`
  (`setRepeatExpressionPlainString/getRepeatExpression/loop-index var`), `WhileEvent`
  (`getWhileConditions/getConditions/getActions`), `ForEachEvent`
  (`setObjectToPick/orderBy/order/limit + expression getters`), `ForEachChildVariableEvent`
  (iterable/key/value iterator names), `CommentEvent` (`setComment/setBackgroundColor/setTextColor`),
  `GroupEvent` (`setName/setFolded/setSource`; sub-events via `getSubEvents()`), `LinkEvent`
  (`setTarget/setIncludeAllEvents/setIncludeEventsGroup/setIncludeStartAndEnd`),
  `JsCodeEvent` (`setInlineCode/setParameterObjects`, IDL L4540+; `gd.asJsCodeEvent` cast),
  async variants. Downcast pattern: `gd.asStandardEvent(baseEvent)` etc. (`gdevelop-runtime.js` L101–167).
- `InstructionsList` (IDL L1744–1761): `insert(instr, pos)` — **use explicit `insert` at
  `size()`**, because `push_back` reorders object-creation instructions after configuration ones
  (breaks "Create then configure"; comment in `gdevelop-runtime.js` L95–98); `get(i)/size/remove/
  removeAt/clear`.
- `Instruction` (IDL L1761–1793): `new gd.Instruction(); setType(typeString);
  setParametersCount(n); setParameter(i, String(value)); setInverted(bool); setAwaited(bool);
  getSubInstructions()`. **All parameters are strings** (object names, variable names, operators like
  `'+'/'='`, and free-form expressions). Serialized fixture example
  (`{type:{value:'ModVarObjet'}, parameters:[object,'TestVariable','+','1']}`) in
  `GDJSBasicCodeGenerationIntegrationTests.js` L9–24.
- `Expression` root-node API (`getPlainString/getRootNode`, `ExpressionNode`, `ExpressionParser2`,
  `ExpressionValidator`, `ExpressionCompletionFinder`, IDL L3316–3421) exists for validation/autocomplete
  but neither reference server uses it — adopt for instruction validation (§7).
- `EventsRemover` (batch remove events/instructions then `launch(events)`) and `EventsListUnfolder`
  fold/unfold helpers are in IDL but unused by both reference servers.

### 1.8 Instructions catalog addressing (how conditions/actions/expressions are referenced)

- Instructions are referenced by **opaque type strings**, e.g. `ModVarObjet`, `ModVarScene`,
  `SetNumberObjectVariable` (seen in engine test fixtures). The authoritative resolver at runtime is
  `MetadataProvider` (IDL L3223–3260): `getExtensionAndActionMetadata(p, type) /
  getExtensionAndConditionMetadata / getExtensionAndExpressionMetadata (+ Object/Behavior/Str variants) /
  getActionMetadata / getConditionMetadata / getObjectMetadata / getBehaviorMetadata`, with validity
  predicates `isBadInstructionMetadata / isBadExpressionMetadata / isBadBehaviorMetadata /
  isBadObjectMetadata / isBadEffectMetadata`. **Neither reference server calls `MetadataProvider`** —
  this is the single biggest validation upgrade available to us (see §7).
- Declaration side: C++ `Extension.cpp` (`obj.AddAction/AddCondition/AddExpression/AddStrExpression…`)
  and JS `JsExtension.js` (`addAction/addCondition/addExpression…` + `addParameter`), which is exactly
  what gb2b's `catalog-parsers.ts` regex-parses (§3.1). Behavior switch helpers:
  `VariableInstructionSwitcher` (IDL L244–261) for unified variable instructions.

### 1.9 `gd.Exporter` + preview compilation (how previews are built)

- `Exporter` (IDL L4522–4540): `new gd.Exporter(fileSystem /*AbstractFileSystem*/, gdjsRoot)`;
  `exportProjectForPixiPreview(previewExportOptions) → boolean`;
  `exportWholePixiProject(exportOptions)`; `serializeProjectData / serializeRuntimeGameOptions`;
  `getLastError()`. `PreviewExportOptions(project, outputDir)` setters used by both the editor and the
  reference server: `setLayoutName, setShouldClearExportFolder, setShouldReloadProjectData,
  setShouldReloadLibraries, setShouldGenerateScenesEventsCode, setFullLoadingScreen,
  setIsDevelopmentEnvironment`. Sources: `gdevelop-runtime.js` L765–811 and the editor's own
  [`newIDE/app/src/ExportAndShare/LocalExporters/LocalPreviewLauncher/index.js`](https://github.com/4ian/GDevelop/blob/master/newIDE/app/src/ExportAndShare/LocalExporters/LocalPreviewLauncher/index.js)
  L79 (`new gd.Exporter`), L262–394 (options + `exportProjectForPixiPreview`).
- The C++ side needs an `AbstractFileSystem` implementation: `createNodeFileSystem({gd, tempDirectory})`
  implementing `mkDir/dirExists/clearDir/getTempDir/fileNameFrom/dirNameFrom/makeAbsolute/makeRelative/
  isAbsolute/…` over Node `fs` (forward-slash normalization; `isUrl` passthrough):
  [`gdevelop-mcp-server/src/node-file-system.js`](https://github.com/982945902/gdevelop-mcp-server/blob/main/src/node-file-system.js).
- `gdcore-tools` equivalent: `exportProject(project, outDir, target?)` via `gd.Exporter(localFileSystem,
  distPath)` + `gd.ExportOptions` (`src/index.mjs`).
- Known interop bug to copy: strip `<script …src="….wasm…">` lines the exporter may emit for the raw
  Draco binary (must be fetched by DRACOLoader, never parsed as JS) — `gdevelop-runtime.js` L796–804.
- Serving: loopback-only `http` server (`127.0.0.1`, random port), GET/HEAD only, MIME map incl.
  `application/wasm`, `decodeURIComponent` + `path.resolve` containment check (null → 404/403):
  [`gdevelop-mcp-server/src/static-preview-server.js`](https://github.com/982945902/gdevelop-mcp-server/blob/main/src/static-preview-server.js).
  Export jobs **serialized** (promise-queue) because platform/extension registries are process-global:
  [`ARCHITECTURE.md`](https://github.com/982945902/gdevelop-mcp-server/blob/main/ARCHITECTURE.md) §"Process and safety model".

### 1.10 Project file format (.json round-trip)

- Single-file `.json` = `Serializer.toJSON(project.serializeTo(el))`; load = `Serializer.fromJSObject`
  + `unserializeFrom` (§1.3). Folder projects split `layouts / externalLayouts / externalEvents /
  eventsFunctionsExtensions` into sidecar files with `__REFERENCE_TO_SPLIT_OBJECT` markers
  (`gdcore-tools/src/open_project.mjs`). Editor save/load of split projects lives in React-coupled code
  that `gdcore-tools` deliberately reimplements ("tightly coupled with React… potential point of
  failure" — track upstream changes).
- Whole-project diagnostics: `project.getWholeProjectDiagnosticReport()` with
  `ProjectDiagnostic_ErrorType::{UndeclaredVariable, MissingBehavior, UnknownObject,
  MismatchedObjectType}` (IDL L~3260) — use as post-mutation gate.

---

## 2. Reference project analysis

### 2.1 `gb2b/gdevelop-mcp` — raw-JSON approach (know-how to reuse, engine to replace)

Source: [`https://github.com/gb2b/gdevelop-mcp`](https://github.com/gb2b/gdevelop-mcp) (v0.21.0,
`package.json`; MIT). No libGD dependency (`dependencies`: `@modelcontextprotocol/sdk ^1.12.0`,
`@napi-rs/canvas`, `gdexporter ^4.0.0-beta7`, `puppeteer`, `zod`).

- **Architecture.** Thin stdio entry (`src/index.ts`: `new McpServer({name:'gdevelop-mcp'})`, twelve
  `register*Tools(server)` families, `registerPrompts`, `StdioServerTransport`, `server.connect`).
  One file per tool family in `src/tools/` (`install/discovery/extensions/catalog/editing/safety/
  assets/examples/github/preview/templates/shared`); business logic in `src/core/*.ts` (~30 modules);
  `vitest` tests in `test/`; repo conventions in `CLAUDE.md`/`.claude/`. Canonical GDevelop sources are
  mirrored to `~/.cache/gdevelop-mcp/ref-v<ver>/` (`Core/ Extensions/ GDJS/`, ~900 files/~14 MB) via
  GitHub git-trees API → jsDelivr → raw.githubusercontent fallback (`src/core/cache.ts` L157–202,
  `GD_REPO = "4ian/GDevelop"`).
- **Tool list (as registered in `src/tools/*.ts`; README header says "30 tools" but the files
  register 40 + 5 prompts).** Install/cache 5 (`gdevelop_install_info, sync_gdevelop_sources,
  check_cache_freshness, check_runtime_freshness, gdevelop_overview`); discovery 5
  (`search_gdevelop_code, describe_feature, list_event_types, list_resource_types, list_variable_types`);
  extensions 4 (`list_extensions, read_extension_source, list_dynamic_catalog, describe_extension`);
  catalog 5 (`list_object_types, list_behavior_types, describe_object_schema, list_instructions,
  describe_instruction`); templates 1 (`quick_start_template`); editing 6 (`validate_project,
  edit_project, inspect_project, find_in_events, list_project_dependencies, summarize_events`); safety 3
  (`list_backups, undo_last_edit, diff_projects`); asset store 5 (`list_asset_packs, search_assets,
  get_asset_details, list_asset_filters, import_assets_into_project`); examples 3 (`list_examples,
  get_example_details, list_example_filters`); github 1 (`read_github_source`); preview 2
  (`preview_scene` real runtime via `gdexporter`+puppeteer ~10s, `render_scene_static` canvas <1s);
  prompts 5 (`start-from-example, add-hero, debug-project, browse-store, safe-edit-flow`).
- **Catalog extraction (reuse).** `src/core/catalog-parsers.ts`: regex + bracket-matching parser (not a
  real C++/JS parser — explicitly documented as sufficient for GDevelop's regular builder syntax) over
  `Extension.cpp`/`JsExtension.js`, emitting `{kind: action|condition|expression|strExpression,
  receiver, parameters[]}` from `AddAction/AddCondition/AddExpression/AddStrExpression` (+`addX`
  JS variants, `AddExpressionAndCondition` duals) and chained `AddParameter/AddCodeOnlyParameter`
  (`INSTR_METHODS`/`PARAM_METHODS` maps, `findMatchingParen/splitTopLevelArgs`). Powers the ~1830-entry
  `list_instructions/describe_instruction` catalog. **Reuse as-is** for catalog freshness; validate
  writes against it client-side.
- **Safety system (reuse).** `src/core/edit.ts` (~390 lines): baseline `validateProjectData` gate
  (refuses invalid projects unless `requireBaselineValid=false`); all-or-nothing batch over a
  `z.discriminatedUnion('op', […])` (~25 op schemas across `edit-add-ops/events/efe/
  edit-remove-rename/edit-misc-ops.ts`); timestamped backup (`copyFileSync → <file>.bak-<ISO>`,
  L369–373); post-batch re-validation; crash-safe write (tempfile + `renameSync`, L376–378);
  `dryRun` mode; per-op `EditSummary`. `src/core/backups.ts`: `listBackups` (prefix scan
  `<base>.bak-*`, newest-first) + `restoreBackup` (copies current to `-pre-restore` safety backup
  first, restores via tmp+rename). `src/core/path-safety.ts`: absolute-path + null-byte + optional
  `allowedRoot` containment. `src/core/validation.ts`: zod `ProjectSchema` + cross-reference checks
  (known object/behavior types, resource names, layout object name sets). `src/core/diff.ts`: semantic
  added/removed/modified diff.
- **Asset/example/wiki/GitHub clients (reuse).** Public CDN, no auth:
  `https://resources.gdevelop-app.com/assets-database` (`asset-store.ts`), `…/examples-database`
  (`examples.ts`), 1h TTL in-memory cache; wiki scrape `https://wiki.gdevelop.io` (`wiki.ts`);
  GitHub contents+raw APIs (`github.ts`, `cache.ts`).
- **Limits.** Mutations are blind JSON ops — no engine construction, no codegen check, no
  `MetadataProvider` validation; `gdexporter` is a third-party beta wrapper (README "Limitations");
  wiki scraping depends on current HTML; public CDN only (no premium/private packs).

### 2.2 `982945902/gdevelop-mcp-server` — libGD.js + `gd.Exporter` approach (skeleton to extend)

Source: [`https://github.com/982945902/gdevelop-mcp-server`](https://github.com/982945902/gdevelop-mcp-server)
(v0.4.0, MIT, ESM, Node ≥20, deps `@modelcontextprotocol/sdk ^1.29.0` + `zod`).

- **Architecture** ([`ARCHITECTURE.md`](https://github.com/982945902/gdevelop-mcp-server/blob/main/ARCHITECTURE.md)):
  `Codex → MCP tool call → session orchestration → libGD.js (Wasm: model+serialization+codegen) →
  GDJS files → browser runtime`. Hard split: `gdevelop-runtime.js` (pure libGD/GDJS/exporter adapter,
  no MCP imports — reusable by tests/CLIs/HTTP transports) / `node-file-system.js` (C++ FS interface) /
  `project-session-manager.js` (Wasm handle ownership) / `preview-session-manager.js` (builds, URLs,
  cleanup) / `mcp-server.js` (schemas → service calls) / `static-preview-server.js` (independently
  testable loopback server). Rule for new tools: headless command layer taking explicit
  `(gd, project, args)` → thin validating MCP wrapper → return JSON snapshots/IDs, **never raw
  Embind handles**. Process model: one MCP process owns one libGD instance; exports serialized;
  previews in random temp dirs, loopback random ports; cleanup verifies paths are under the temp root;
  remote deployment needs Streamable HTTP + auth + per-user isolation (never expose stdio server).
- **Tool list (19 × `server.registerTool`, `src/mcp-server.js` L78–550).** `create_project,
  open_project, import_resource, update_project, set_scene_javascript, add_scene_layer,
  set_scene_variable, set_global_variable, add_scene_object, add_object_group, add_object_instance,
  set_scene_events, describe_native_project, export_project, save_project, build_preview,
  get_preview_status, stop_preview, close_project`. Input validation: zod (`z.object`, recursive
  `z.lazy()` event schema with `comment|group|standard` kinds; `instructionSchema {type, parameters[],
  inverted}`), errors caught by `runTool` wrapper → `{content:[{type:'text',text:message}], isError:true}`.
  Sessions: `ProjectSessionManager` (`Map<uuid, {project,…}>`, `randomUUID`, in-memory mutations until
  explicit `save_project`); `PreviewSessionManager` (build queue, `describe()` strips server/promises).
- **Reusable parts.** `GDevelopRuntime` adapter patterns: resource-kind inference from file extension
  + typed constructors (`ImageResource/Model3D/…/Spine/JavaScriptResource`, L30–57); recursive variable
  setter (§1.5); native events appender (`insertNewEvent` + `asCommentEvent/asGroupEvent/asStandardEvent`
  + `appendInstruction`, L86–167); Sprite/Text/Spine object construction incl. collision-mask centering
  fix, text outline/shadow, Spine animation mappings (L484–638); `setSceneJavascript` marker-comment
  (`/* gdevelop-mcp:scene-script */`) upsert for the single managed JsCode event (L730–759);
  `PreviewExportOptions` flag set + Draco-`.wasm`-script sanitization (§1.9); `createNodeFileSystem`;
  traversal-safe static server; `test/` suite shape (`node --test`: fake-exporter protocol/lifecycle
  tests + opt-in `test:runtime`/`real-authoring` with real artifacts via env vars).
- **Gaps (what we must add). No deletion tools** — nothing calls `removeLayout/removeObject/
  removeInstance/removeBehavior/removeLayer`, groups/variables/resources can only be added;
  **no scene create/delete** — `insertNewLayout` is never called, `create_project` makes one scene;
  **events limited** to Standard/Comment/Group (+JsCode via separate tool) — no Else/Repeat/While/
  ForEach/ForEachChildVariable/Link builders, no conditions/actions expression validation, no
  `MetadataProvider` checks, instruction `type` strings unvalidated; **no catalog/asset-store** tools;
  **save is a direct overwrite** (`fs.writeFile`, L391 — no backup, no atomic tmp+rename, no
  validation gate); **open ignores folder projects** (no unsplit, no events-functions loading, §1.3);
  **no undo/diff/dryRun**; `export_project` writes a persistent build with no root containment option.

---

## 3. MCP SDK patterns (TypeScript, stdio, tools, sessions)

Primary sources: SDK v1 line actually used by both servers (`@modelcontextprotocol/sdk@1.20.0`
inspected locally: `dist/esm| cjs/server/{mcp,stdio}.js|.d.ts`); v2 README
(`https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md`);
protocol spec (`https://modelcontextprotocol.io/specification/latest`,
overview `https://modelcontextprotocol.io/`).

- **Pin the v1 SDK line.** Both reference servers build on `@modelcontextprotocol/sdk` v1
  (`^1.12.0`, `^1.29.0`; local `1.20.0`). Upstream `main` is now **v2** (split packages
  `@modelcontextprotocol/server|client`, Standard-Schema tool schemas, zod v4) implementing the
  2026-07-28 spec; v1.x stays on a maintained branch (bug/security fixes ≥6 months). Our server should
  pin a v1.x version — the entire §3 API below is v1.
- **Stdio server skeleton (v1).**
  ```ts
  import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
  import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
  const server = new McpServer({ name: 'gdevelop-libgd', version: '0.1.0' });
  server.registerTool('add_scene_object',
    { description: '…', inputSchema: z.object({ projectId: z.string().uuid(), … }) },
    async (input) => ({ content: [{ type: 'text', text: '…' }], structuredContent: { … } }));
  await server.connect(new StdioServerTransport());
  ```
  Both styles exist in v1: concise `server.tool(name, description?, paramsSchema?, cb)` (gb2b,
  `src/tools/*.ts`) and explicit `server.registerTool(name, {description, inputSchema[, outputSchema,
  annotations]}, cb)` (982945902, `src/mcp-server.js` L73+). Prefer `registerTool` + `outputSchema`
  for machine-readable results. Protocol operations underneath: `ListToolsRequestSchema` /
  `CallToolRequestSchema` handlers (`dist/esm/server/mcp.js` L4,42–73); error type `McpError/ErrorCode`.
- **Schemas with zod.** Recursive inputs (events trees) via `z.lazy(() => z.union([…]))` with
  `.default([])/.default(false)` (982945902 `nativeEventSchema`/`instructionSchema`/`variableValueSchema`,
  `src/mcp-server.js` L21–71). Reuse gb2b's zod `ProjectSchema` for validating imported JSON.
- **Error handling.** Never throw out of a tool: catch → `{ content: [{ type: 'text', text: message }],
  isError: true }` (`runTool`, `src/mcp-server.js` L11–19). Keep `structuredContent` for success payloads
  (`toolResult`, L5–8).
- **Session/state for in-memory isolated projects.** Proven pattern: `Map<string, Record>` keyed by
  `randomUUID()` project/preview IDs; record holds the Wasm `project` handle + metadata; `get(id)`
  throws `Unknown preview/project session` on miss; `describe()` strips non-serializable fields
  (servers, promises, raw handles) before returning. Mutations stay in memory until explicit save, so
  `build_preview` is a side-effect-free feedback loop (`project-session-manager.js`,
  `preview-session-manager.js`). One libGD instance per process; serialize export jobs (promise queue);
  stdio transport = local single-user deployment; remote = Streamable HTTP + auth + per-tenant process
  isolation (`ARCHITECTURE.md` §"Process and safety model"). Prompts (slash-commands) register via
  `registerPrompts(server)` (gb2b `src/prompts.ts`, 5 prompts) — adopt `safe-edit-flow`-style guided flows.

---

## 4. Assets / extensions catalog (first-party endpoints + metadata formats)

Primary sources: editor service clients in
[`newIDE/app/src/Utils/GDevelopServices/`](https://github.com/4ian/GDevelop/tree/master/newIDE/app/src/Utils/GDevelopServices)
(`ApiConfigs.js`, `Asset.js`, `Extension.js`, `Example.js`) — i.e. the exact endpoints the editor calls.

- **Base URLs** (`ApiConfigs.js` L44–145): `https://api.gdevelop.io/{asset,build,usage,release,analytics,
  game,user,play,shop,project,generation}` (+ `-dev` variants); public CDNs
  `https://resources.gdevelop-app.com/{assets-database,staging/assets-database}`,
  `https://asset-resources.gdevelop.io[/staging]` (binary resources),
  `https://public-resources.gdevelop.io/ai` (AI CDN); game services `https://gd.games`,
  `https://game-previews.gdevelop.io`.
- **Extensions registry** (`Extension.js L218+ getExtensionsRegistry`): `GET {assetApi}/extension
  ?environment=live` → `{ databaseUrl }` → `GET databaseUrl` (CDN JSON) → `{ headers|extensionShortHeaders,
  views.default.firstIds|firstExtensionIds }`; normalize legacy `tier:'community'→'experimental'` and
  string tags. Tiers: `experimental|reviewed|installed`. Header fields: `name, fullName, version,
  extensionNamespace, category, tags[], previewIconUrl, url, headerUrl, changelog[], requiredExtensions[]`.
  Behaviors registry: `GET {assetApi}/behavior`. Short headers embed `eventsFunctions[]` (`Action|
  Condition|Expression|ExpressionAndCondition|ActionWithOperator`), `eventsBasedBehaviors[]`,
  `eventsBasedObjects[]`.
- **Asset store** (`Asset.js`): `listAllPublicAssets / getPublicAsset / getPrivateAsset /
  listAllResources / listAllAuthors / listAllLicenses / getPrivateAssetPack / getPrivateGameTemplate`.
  `ObjectAsset = { object (serialized gdObjectConfiguration), resources[] (serialized gdResource),
  variants?[], requiredExtensions?[] }`. Public flow needs no auth; private packs/templates go through
  `Shop.js` authorized URLs + `{private-assets,private-game-templates,project-resources}.gdevelop.io`
  storage. gb2b's client covers only the public CDN surface (documented limitation).
- **Examples** (`Example.js L~40+ listAllExamples`): `GET {assetApi}/example ?environment=live` →
  `{ exampleShortHeadersUrl, filtersUrl }` → fetch both (retry ×2). Fields: `slug, name, license, tags[],
  previewImageUrls[], projectFileUrl, gdevelopVersion, codeSizeLevel…`.
- **Extension file format.** Community/reviewed extensions are **`.json` files** under
  `extensions/{reviewed,community}/` in [`GDevelopApp/GDevelop-extensions`](https://github.com/GDevelopApp/GDevelop-extensions)
  (README: export from GDevelop → submit via issue/PR → review bar → merged; all MIT; community list at
  `GDevelopApp/GDevelop-community-list`). Built-in/compiled extensions live in
  [`4ian/GDevelop/Extensions/`](https://github.com/4ian/GDevelop/tree/master/Extensions)
  (`Extension.cpp` / `JsExtension.js` + `JsExtensionTypes.d.ts`) — the input to gb2b's parsers.
  Runtime loading contract for a JS extension: `createExtension(_, gd)` (+ optional
  `runExtensionSanityTests(gd, ext)`), i.e. `GDJS/Runtime/Extensions/*/JsExtension.js` under the GDJS root.
- **Freshness strategy.** Never snapshot: at startup/refresh, pull live registry (`/extension`,
  `/behavior`, `/example`, asset DB) with a short TTL cache (gb2b: 1h, `asset-store.ts`); pin engine
  truth to a 4ian/GDevelop ref with `check_cache_freshness` against `releases/latest` (gb2b `cache.ts`
  L182; sources via `git/trees?recursive=1` → jsDelivr → raw.githubusercontent fallback, L157–202);
  validate instruction type strings against parsed catalog + `MetadataProvider` at write time.

---

## 5. Safety / validation patterns (observed, reusable)

| Pattern | Reference implementation | Adopt? |
|---|---|---|
| Baseline validation refuses edits on invalid projects (overridable) | gb2b `core/edit.ts` L~150–170 | **Yes** — plus engine `getWholeProjectDiagnosticReport()` |
| Atomic batch: all ops or none (in-memory apply, single write) | gb2b `core/edit.ts` op loop | **Yes** — natural with in-memory `gd.Project` (save only if all succeed) |
| Timestamped auto-backup before write (`<file>.bak-<ISO>`) | gb2b `core/edit.ts` L369–373 | **Yes** (982945902 lacks it) |
| Post-mutation validation gate before write | gb2b `core/edit.ts` | **Yes** — serializer round-trip + `MetadataProvider.isBad*` + diagnostics |
| Crash-safe write (tempfile + rename) | gb2b `core/edit.ts` L376–378; `core/backups.ts` restore | **Yes** (982945902 `saveProject` overwrites directly — fix) |
| Reversible (`undo_last_edit`, pre-restore safety copy) | gb2b `core/backups.ts` `restoreBackup` | **Yes** |
| `dryRun` preview + semantic `diff_projects` | gb2b `core/edit.ts`, `core/diff.ts` | **Yes** (describe-before/after via snapshots) |
| Path validation (absolute, null-byte, allowed-root, temp-root containment on cleanup) | gb2b `core/path-safety.ts`; 982945902 `static-preview-server.js` + ARCHITECTURE.md | **Yes** |
| Cross-ref validation (object/behavior/resource/type existence) | gb2b `core/validation.ts` | **Yes**, superseded by engine metadata where possible |
| Serialized export queue (process-global registries) | 982945902 `preview-session-manager.js`, ARCHITECTURE.md | **Yes** |
| Loopback-only preview (127.0.0.1, random port, GET/HEAD, MIME incl. wasm, traversal guard) | 982945902 `static-preview-server.js` | **Yes** |
| In-memory-until-save (preview without persisting) | 982945902 `project-session-manager.js` | **Yes** |
| Case-insensitive behavior-property resolution, bool→"1"/"0" | 982945902 `gdevelop-runtime.js` L603–627 | **Yes** (DX nicety) |
| Marker-comment managed JsCode event | 982945902 `gdevelop-runtime.js` L730–759 | **Yes**, namespaced marker |

---

## 6. Recommended architecture for our server

```
┌ MCP stdio (McpServer + StdioServerTransport, SDK v1 pinned) ─────────────┐
│ tools (registerTool + zod input/output schemas; runTool isError wrapper) │
│   project:  create/open/save/close/describe (+folder-project support)    │
│   scene:    add/remove/rename/move scene; layers add/remove              │
│   content:  objects CRUD, behaviors attach/update/remove, groups CRUD,    │
│             resources add/remove/rename, variables CRUD (all scopes)      │
│   instances: place/update/move/remove, bulk remove-by-object/layer       │
│   events:   full builders (Standard/Comment/Group/Link/Else/Repeat/      │
│             While/ForEach/ForEachChild/JsCode) + move/remove + validate  │
│   catalog:  instructions/objects/behaviors/extensions search (live+pin)  │
│   assets:   public store search/import (reuse gb2b clients)              │
│   preview:  build/status/stop (+ static thumbnail later)                 │
│   safety:   backups/undo/diff/dryRun                                     │
├ headless command layer (gd, project, args) — NO MCP imports ─────────────┤
│ session Mgr (Map<uuid,handle>) │ mutate fns │ validate fns │ export fns  │
├ libGD.js (single init; initializePlatforms once; extensions loaded) ─────┤
│ Serializer │ MetadataProvider │ Exporter+PreviewExportOptions │ DiagReport│
└ loopback preview server (127.0.0.1, random port, traversal guard) ───────┘
```

- **Session model:** `open_project(path)` → `uuid`; every mutation tool takes `projectId`; Wasm handles
  never leave the process (return `describe()` snapshots). `save_project` = backup + validate + atomic
  write; `close_project` deletes handle + stops its previews. Dirty-flag guard on close.
- **Validation pipeline per mutating call:** (1) zod schema; (2) existence pre-checks (scene/object/
  behavior/resource via container `has*`); (3) instruction `type` against `MetadataProvider`
  `getExtensionAnd{Action,Condition,…}Metadata` + `isBad*` (+ parameter-count/type check from
  `InstructionMetadata`/`ParameterMetadata`); (4) apply in memory; (5) `layout.updateBehaviorsSharedData`;
  (6) serialize→reparse round-trip + `getWholeProjectDiagnosticReport()` zero-new-errors; else roll back
  (project is in-memory: keep a pre-op `serializeTo` snapshot element for restore).
- **Reuse verbatim:** gb2b `catalog-parsers.ts`, `validation.ts` (zod project schema),
  `path-safety.ts`, `backups.ts`, `diff.ts`, asset/example/GitHub/CDN clients, prompt texts;
  982945902 `node-file-system.js`, `static-preview-server.js`, `preview-session-manager.js` shape,
  `GDevelopRuntime` construction snippets (variable setter, Sprite/Text/Spine builders, Draco fix,
  export flags), test layout (`node --test` + fake exporter + `GDEVELOP_*` opt-in real tests).
- **Must newly build:** deletion tools, scene CRUD, full event-type builders, `MetadataProvider`
  validation, backup/atomic/dryRun around `save_project`, folder-project unsplit/split I/O,
  events-functions-extension loading in Node, catalog tools backed by live registries.
- **Tests:** unit (fake gd doubles for session logic) + opt-in real-artifact suite mirroring
  982945902 (`GDEVELOP_LIBGD_PATH/GDEVELOP_GDJS_ROOT/GDEVELOP_TEST_PROJECT`), asserting
  create→mutate→save→reload→export→serve round-trips and backup/undo behavior.

## 7. Open questions (need spikes, in order)

1. **Folder-project write path:** editor split logic is React-coupled; `gdcore-tools` reimplements only
   load (`unsplit` + `loadProjectEventsFunctionsExtensions`). Can we reuse its save (`createProjectSaver`,
   split-paths set) or must we port the editor's splitter? Spike: round-trip a folder project.
2. **Events-functions extensions in Node:** `loadProjectEventsFunctionsExtensions(project, codeWriter,
   i18n)` needs a file-backed code writer — what breaks headless, and does skipping it corrupt
   custom-object projects on save?
3. **WASM memory discipline:** which getters return owned vs borrowed handles (`.delete()` rules for
   `getObject/getBehavior/getLayout` results, `Vector*`, `Map*`)? A wrong `delete()` crashes the
   process; fuzz with ASAN/debug libGD build (`npm run build -- --variant=debug-assertions`, README §Debug).
4. **libGD provisioning pin:** build from source vs `import-libGD.js` S3 prebuilt vs `gdcore-tools`
   bundle — which version do we pin per release, and how do `check_cache_freshness`-style checks map to
   WASM artifacts (no `releases/latest` asset for libGD itself)?
5. **Export concurrency:** process-global registries force serialized exports — acceptable, or one worker
   process per project (memory cost of multiple WASM instances)?
6. **JsCode policy:** allow arbitrary `set_scene_javascript`, restrict to marker-managed event, or forbid
   (XSS-equivalent via preview server is loopback-only, but saved projects execute in the editor)?
7. **Private/premium assets:** out of scope (auth via `Shop.js` + private storage) — confirm with product.
8. **Large-project perf:** `Serializer.toJSON` full-project snapshots per op for undo/dryRun — measure vs
   incremental `EventsRemover`/targeted serialization.
9. **Docs drift:** `docs.gdevelop.io` now redirects and `GDevelop.js` ships no `.d.ts` on npm (types are
   generated at build: `scripts/generate-dts.js`); our TS bindings for `gd.*` must come from a built
   `types.d.ts`/`gd.d.ts`-equivalent checked in per libGD pin.

---

### Source index (primary only, all resolved 2026-09-07)

Engine (`4ian/GDevelop`, `https://github.com/4ian/GDevelop`): `GDevelop.js/README.md`,
`GDevelop.js/package.json`, `GDevelop.js/Bindings/Bindings.idl` (≈§1.3–1.8, L144–151, 244–261, 319–347,
521–719, 830–1030, 1027+, 1243+, 1416+, 1514–1650, 1650–1800, 2540–2730, 3223–3260, 4522–4540),
`GDevelop.js/Bindings/ProjectHelper.h`, `GDevelop.js/Bindings/prejs.js`, `GDevelop.js/Bindings/postjs.js`,
`GDevelop.js/__tests__/{Serializer,GDJSProjectSerialization,GDJSBasicCodeGenerationIntegrationTests}.js`,
`newIDE/app/src/index.js` (L73–99), `newIDE/app/scripts/import-libGD.js`,
`newIDE/app/src/ExportAndShare/LocalExporters/LocalPreviewLauncher/index.js` (L79, 262–394),
`newIDE/app/src/Utils/GDevelopServices/{ApiConfigs.js (L44–145),Asset.js,Extension.js (L218+),Example.js}`,
`newIDE/app/package.json` (`import-resources` script), `Extensions/` (`JsExtensionTypes.d.ts`).
Docs/wiki: `https://wiki.gdevelop.io/` (objects/behaviors/events/variables/asset-store sections),
`https://github.com/GDevelopApp/GDevelop-extensions` (format + review flow),
`https://github.com/arthuro555/gdcore-tools` (`src/{index,open_project}.mjs`).
Reference servers: `https://github.com/gb2b/gdevelop-mcp` (`src/{index,tools/*.ts,core/*.ts, prompts.ts}`),
`https://github.com/982945902/gdevelop-mcp-server` (`ARCHITECTURE.md`, `src/*.js`).
MCP: `https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md`,
`https://modelcontextprotocol.io/`, `https://modelcontextprotocol.io/specification/latest`,
`@modelcontextprotocol/sdk@1.20.0 dist/esm/server/{mcp,mcp.d,stdio}.js`.
