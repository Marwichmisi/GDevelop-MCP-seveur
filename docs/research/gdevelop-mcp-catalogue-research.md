# Catalogue lecture seule (ticket #15) — recherche primaire

> Portée : comment construire, dans `gdevelop-mcp-server`, un **Catalogue** lecture seule
> (instructions, types d'objets, types de comportements, extensions) à partir de **parsers
> gb2b** appliqués à un **dépôt GDevelop pinné (ref+sha)**, avec registres live + TTL 1 h et
> check de fraîcheur `releases/latest`. Chaque affirmation ci-dessous cite la source primaire
> qui la porte (URL + fichier/section), ou le binaire pinné local quand il fait foi.
>
> Recherche menée le 2026-09-12. Sources pinnables : `4ian/GDevelop@master` (release
> `v5.6.282`, publiée le 2026-09-11 — `https://api.github.com/repos/4ian/GDevelop/releases/latest`),
> `gb2b/gdevelop-mcp@main` (tree `e2ae2358547c97329790b6e7a2f784332e9a7813`).
> Le binaire local `vendor/libGD.js` (pin `master/latest`, sha256 `0dc79205…`) fait foi pour
> vérifier ce que le moteur exposé *réellement* contient.

## 0. Rappel du cadrage (ticket #15)

Outils Catalogue **en lecture seule** : `list/search/describe_instructions` (actions, conditions,
expressions, str-expressions + duals), `list_object_types`, `list_behavior_types`,
`describe_object/behavior`, `list/describe_extensions` (incl. customs `eventsBased*`).
Parsers gb2b réutilisés sur dépôt pinné (ref+sha), registres live + TTL 1 h, check
`releases/latest`, EN brut sans traduction. **Le catalogue aide, le moteur juge** : aucune
validation ici (la validation d'écriture L1+L2 reste dans `src/events.ts` / la couche contenu).

## 1. Surface de parsing des sources GDevelop

### 1.1 Instructions — C++ (`Extension.cpp`)

Déclarations réelles (`Core/GDCore/Extensions/Builtin/AdvancedExtension.cpp`) :

```cpp
extension.AddAction("SetReturnNumber", _("Set number return value"), _("Set the return value …"),
                    _("Set return value to number _PARAM0_"), "", "res/functions/expression_black.svg",
                    "res/functions/expression_black.svg")
    .AddParameter("expression", _("The number to be returned"))
    .SetRelevantForFunctionEventsOnly()
    .MarkAsAdvanced();
extension.AddCondition("CompareArgumentAsNumber", …).AddParameter("functionParameterName", _("Parameter name"), "number,string,boolean");
extension.AddExpression("GetArgumentAsNumber", …).AddParameter("functionParameterName", _("Parameter name"), "number,string,boolean");
extension.AddStrExpression("GetArgumentAsString", …);
```

- Signature utile : `AddAction(type, fullName, description, sentence, group, icon, smallIcon)` ;
  `AddCondition` identique ; `AddExpression(type, fullName, description, group, icon)` ;
  `AddStrExpression` identique. `AddParameter(type, description, extraInfo?, optional?)`.
  Source : fichier ci-dessus (lecture directe) et `Core/GDCore/Extensions/PlatformExtension.h`
  (`AddAction`, `AddCondition`, `AddExpression`, `AddStrExpression`, `AddExpressionAndCondition`,
  `AddExpressionAndConditionAndAction`, `AddParameter`, `AddCodeOnlyParameter` — vérifiés dans la
  liste des méthodes publiques du header).
- Les paramètres sont **enchaînés** sur le builder : le parseur doit rester « courant » entre
  l'appel `AddAction/…` et le prochain appel de déclaration.

### 1.2 Instructions — JS (`JsExtension.js`)

Déclarations réelles (`third-party/GDJS/Runtime/Extensions/ExampleJsExtension/JsExtension.js`,
copie locale du runtime GDJS extrait de l'AppImage) :

```js
extension.addAction('MyMethod', _('Display a dummy text …'), _('Display a dummy text …'),
                    _('Display a dummy text for _PARAM0_, with params: _PARAM1_, _PARAM2_'),
                    '', 'res/conditions/camera24.png', 'res/conditions/camera.png')
  .addParameter('object', _('Object'), 'DummyObject', false)
  .addParameter('expression', _('Number 1'), '', false)
  .addParameter('string', _('Text 1'), '', false);
```

- Mêmes kinds et mêmes positions d'arguments qu'en C++ (`addAction/addCondition/addExpression/
  addStrExpression`), plus les variantes `addScopedAction/addScopedCondition`. Les chaînes sont
  souvent enveloppées en i18n : `_('…')` — le parseur doit déballer `_("…")` comme `"…"`.
- `addParameter(type, _('desc'), '', false)` : 4ᵉ argument `optional`.
- **Duals** : `AddExpressionAndCondition` / `AddExpressionAndConditionAndAction` (C++),
  `addExpressionAndCondition…` (JS) génèrent *plusieurs* entrées (l'expression + la/les
  condition(s)/action(s) miroir) partageant les paramètres accumulés ensuite.
  Vérifié dans la liste des méthodes du bindings pinné (§2.2).
### 1.3 Types d'objets et de comportements

- **JS** : `extension.addObject(name, fullName, description, icon, jsImplementation)` et
  `extension.addBehavior(name, fullName, behaviorName, description, …)`.
  Sources vérifiées : `ExampleJsExtension/JsExtension.js` L.188–205, L.266–285, L.379–391 ;
  et 20+ JsExtension.js locaux (`3D`, `BBText`, `TileMap`, `TextInput`, `Video`, …).
  Le **type complet** d'un type déclaré par extension est `<extension>::<name>`
  (convention de nommage gb2b, `src/core/catalog-dynamic.ts`).
- **C++** : `PlatformExtension` expose `GetExtensionObjectsTypes()` et `GetBehaviorsTypes()`
  (bindings pinnés, §2.2) ; le header expose les méthodes de déclaration (`AddObject` /
  `AddBehavior` selon l'overload). Le parsing C++ des types est **best-effort** dans notre
  catalogue (les builtins sont réellement listés par le moteur, pas par un regex).
- **`eventsBased*`** : marqueurs de types/comportements « custom » définis par événements
  (clés JSON `eventsBasedObject` / `eventsBasedBehavior`, classes C++/TS
  `EventsBasedObject` / `EventsBasedBehavior`). Le catalogue les **détecte par marqueur** dans
  les sources scannées et les expose à part, sans jamais prétendre les valider.

### 1.4 Extensions — informations de tête

- C++ : `SetExtensionInformation(name, fullName, description, author, license)` +
  `SetShortDescription(...)`, `SetCategory(...)`, `SetTags(...)`, `SetExtensionHelpPath(...)`
  (`AdvancedExtension.cpp`, `PlatformExtension.h`).
- JS : mêmes noms en camelCase (`setExtensionInformation(...)`, `setShortDescription(...)`).
- Le bindings pinné expose ces getters sur `PlatformExtension` (`GetName`, `GetFullName`,
  `GetDescription`, `GetShortDescription`, `GetCategory`, `GetAuthor`, `GetLicense`, `GetTags`,
  `GetHelpPath`, `GetIconUrl`, `IsDeprecated`) — §2.2.

## 2. APIs moteur disponibles (vérifiées sur le binaire pinné)

### 2.1 `MetadataProvider` (le juge au write, pas le catalogue)

Le binaire `vendor/libGD.js` expose (noms réels des wrappers, `grep` sur le fichier) :

```
STATIC_GetExtensionAndActionMetadata / …AndConditionMetadata / …AndExpressionMetadata
STATIC_GetExtensionAndObjectMetadata / …AndBehaviorMetadata / …AndEffectMetadata
STATIC_GetActionMetadata / GetConditionMetadata / GetExpressionMetadata / GetStrExpressionMetadata
STATIC_GetObjectMetadata / GetBehaviorMetadata
STATIC_IsBadInstructionMetadata / IsBadExpressionMetadata / IsBadObjectMetadata
     / IsBadBehaviorMetadata / IsBadEffectMetadata
```

Elles prennent `(platform, type)` et sont **déjà utilisées** par `src/runtime.ts`
(`getObjectMetadata(project.getCurrentPlatform(), type)`, L.419/426) pour valider les types
d'objets/comportements au write. Le catalogue ne les appelle **pas** (ticket : « aucune
validation ici ») ; elles restent la source de vérité à l'écriture.

### 2.2 `Platform` / `PlatformExtension` — énumération live (alternative documentée)

Le binaire pinné expose aussi une **énumération** complète :

```
Platform.prototype["GetAllPlatformExtensions"]              → VectorPlatformExtension
PlatformExtension.prototype["GetAllActions" | "GetAllConditions" | "GetAllExpressions"
  | "GetAllStrExpressions" | "GetAllActionsForObject" | "GetAllActionsForBehavior"
  | "GetAllConditionsForObject" | "GetAllConditionsForBehavior"
  | "GetAllExpressionsForObject" | "GetAllExpressionsForBehavior"
  | "GetAllStrExpressionsForObject" | "GetAllStrExpressionsForBehavior"
  | "GetAllEvents" | "GetExtensionObjectsTypes" | "GetBehaviorsTypes"
  | "GetAllProperties" | "GetAllSourceFiles" | "GetAllDependencies"]
```

C'est une **alternative sans réseau** au catalogue (le moteur sait déjà tout), mais elle ne
fournit ni le texte EN des paramètres au format source ni l'historique pin/ref. Décision : le
catalogue de #15 suit le ticket (parsers sur dépôt pinné) ; l'énumération moteur est notée ici
comme piste de « registre live » future, hors périmètre.



## 3. Le design gb2b réutilisé

### 3.1 Parsers (`gb2b/gdevelop-mcp@main:src/core/catalog-parsers.ts`)

- Parseur **regex + bracket-matching**, explicitement documenté comme suffisant pour la syntaxe
  régulière des builders GDevelop (pas un vrai parseur C++/JS).
- Helpers : `findMatchingParen` (gère chaînes, `//` et `/* */`), `splitTopLevelArgs` (profondeur),
  `extractString` (`"…"`, `'…'`, `_(…)`, `` `…` ``), `receiverBefore` (token avant le `.` → permet
  `receiverKind` extension/object/behavior).
- `INSTR_METHODS` : `AddAction/AddScopedAction/addAction/addScopedAction` → `action` ;
  `AddCondition/…` → `condition` ; `AddExpression/addExpression` → `expression` ;
  `AddStrExpression/addStrExpression` → `strExpression`.
- `PARAM_METHODS` : `AddParameter/addParameter/AddCodeOnlyParameter/addCodeOnlyParameter`.
- `AddExpressionAndCondition*` → une entrée `expression` (ou `strExpression` si le 1ᵉʳ argument
  vaut `"string"`) **et** une entrée `condition` miroir ; les `AddParameter` suivants alimentent
  les deux (`mirror.parameters.push(param)`).

### 3.2 Catalogue d'instructions (`gb2b/gdevelop-mcp@main:src/core/catalog-actions.ts`)

- `InstructionSpec = { type, fullName, description, kind, extension, source, receiver,
  receiverKind, parameters }` ; `receiverKind` dérivé du token (`extension|object|behavior|unknown`).
- Indexation : un fichier par extension (`JsExtension.js` + tous les `.cpp` du dossier), plus
  `Core/GDCore/Extensions/Builtin/` (dossiers `*Extension/` et fichiers `*Extension.cpp`,
  nom d'extension = nom de fichier sans `Extension`).
- **Dédoublonnage** par clé `kind::type::extension`, en gardant l'entrée la plus riche
  (fullName ≠ type, description non vide, plus de paramètres).
- `findInstructions(catalog, {kind, extension, receiverKind, query, limit=100})` : filtre
  insensible à la casse sur `type fullName description extension`.

### 3.3 Types d'objets/comportements (`gb2b/gdevelop-mcp@main:src/core/catalog-dynamic.ts`)

- JS : `.addObject('Name'` → `typeName = "<extension>::<Name>"`, `.addBehavior('Name'` → idem.
- TS : champs `content: { … }` de `*runtimeobject.ts` extraits par regex (le `.js` compilé perd
  les types) ; `*runtimebehavior.ts` → comportements.
- Sorties : `objectsByExtension`, `behaviorsByExtension`, `allObjects`, `allBehaviors`.

### 3.4 Pin + fraîcheur + TTL (`gb2b/gdevelop-mcp@main:src/core/cache.ts`, `src/tools/install.ts`)

- Dépôt pinné : `4ian/GDevelop`. Cache `~/.cache/gdevelop-mcp/ref-<ref>/` + `manifest.json`
  `{ ref, sha, syncedAt, lastFreshnessCheck, filesCount, totalBytes, includedPaths }`.
- Arbre récupéré via `GET https://api.github.com/repos/{repo}/git/trees/{ref}?recursive=1`
  (le `sha` de l'arbre est le sha pinné) ; fichiers en `raw.githubusercontent.com` ; concurrence
  bornée ; `truncated: true` → erreur explicite.
- **TTL fraîcheur = 1 h** (`FRESHNESS_CHECK_TTL_MS = 60 * 60 * 1000`) : si
  `lastFreshnessCheck` a moins d'1 h, on répond « assumed fresh » sans appel réseau ; sinon
  `fetchLatestRef()` (dernière release) puis comparaison `ref` puis `sha`.
- Purge d'inclusion : `Core/GDCore/Extensions/Builtin/`, `Extensions/`, extensions `.h/.cpp/.ts/.js`,
  taille < 1 Mo, exclusions `tests/`, `node_modules/`, binaires.

## 4. Vérifications locales (binaire pinné + runtime GDJS)

| Fait | Source |
|---|---|
| `MetadataProvider` + `IsBad*` présents | `vendor/libGD.js` (grep des wrappers `STATIC_*`) |
| `Platform.GetAllPlatformExtensions` + getters `PlatformExtension.GetAll*` présents | `vendor/libGD.js` (grep `Platform.prototype[…]`, `PlatformExtension.prototype[…]`) |
| `AddObject/addObject`, `addBehavior` réels dans les JsExtension | `third-party/GDJS/Runtime/Extensions/*/JsExtension.js` (20+ occurrences) |
| Chargement des extensions GDJS depuis `GDEVELOP_GDJS_ROOT` | `src/runtime.ts` `loadJsExtensions` (L.1513–1545) |
| Versions : libGD pin `master/latest`, GDJS runtime AppImage | `vendor/libgd-pin.json`, `README.md`, `opencode.json` |

## 5. Décisions d'implémentation (ce ticket)

1. **Source unique = dépôt pinné.** Un port `CatalogSource` (`load()` → snapshot
   `{ref, sha, syncedAt, files[]}` + `latestReleaseRef()`) ; l'implémentation réelle
   (`GitHubCatalogSource`) parle à GitHub et **met en cache sur disque** (`manifest.json`,
   TTL de fraîcheur 1 h) ; les tests injectent une source à fixtures (**aucun réseau requis**,
   critère d'acceptation).
2. **Parsers portés** depuis gb2b (règles §3.1–3.3), purs et testables isolément, sans aucune
   dépendance moteur ni réseau.
3. **Registre live + TTL.** `Catalog` construit l'index en mémoire au premier appel et le
   garde **1 h** (`dataTtlMs`) ; `status({refresh:true})` force la reconstruction et le check de
   fraîcheur ; un pin périmé est exposé (`stale: true`, `latestRef`).
4. **EN brut, aucune traduction** ; les payloads exposent le pin (`ref`, `sha`, `syncedAt`) pour
   que l'agent sache *quelle version* il lit.
5. **Le catalogue n'écrit jamais** : aucune session, aucune mutation, aucun appel
   `MetadataProvider` ; la validation d'écriture reste dans les couches existantes.

## 6. Limites connues / suite

- Le parsing C++ des **types d'objets builtins** (`Sprite`, `TextObject::Text`, …) est
  best-effort : `SpriteExtension/` est un **dossier** dans `Builtin/`, et les types builtins
  sont surtout listés par le moteur. `describe_object` reste utile (extension d'origine, source,
  marqueurs `eventsBased*`) mais ne remplace pas `MetadataProvider`.
- Les parsers sont des regex/`bracket-matching` : une syntaxe de builder non régulière échappe.
  Fixtures de test alignées sur les sources réelles ci-dessus.
- Pas de wiki, pas de CDN, pas de GitHub « fallback » dans ce ticket (réservés à #18) ; pas de
  validation L3 (#5 fog).

