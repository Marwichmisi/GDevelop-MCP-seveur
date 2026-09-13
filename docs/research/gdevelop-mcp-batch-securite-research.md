# Batch + sécurité — recherche primaire (issue #17)

> Sujet : `apply_content_batch` (atomicité, `dryRun`), `undo_last_edit` (copie `-pre-restore`), diff sémantique avant/après, gate baseline (refus si invalide sauf flag explicite), injection d'échec à chaque étage du pipeline.
> Recherche menée le 2026-09-13 contre les sources primaires du repo (code + issues + specs). Chaque affirmation cite sa source.

## Question

Que demande exactement l'issue #17 « Batch + sécurité (atomicité, undo, diff, dryRun, baseline) », sur quoi s'appuie-t-elle (spec parente #11, bloqueur #13 fermé), et que manque-t-il dans le code actuel pour l'implémenter ?

## Résumé

- L'issue #17 est **ouverte**, labellisée `ready-for-agent`, parente #11, bloquée par #13 (désormais **fermée/livrée**) : construire `apply_content_batch` qui **rejoue exactement les payloads granulaires** (Ops de contenu) en **tout-ou-rien avec `dryRun`**, plus `undo_last_edit` (copie `-pre-restore`), **diff sémantique avant/après**, et **gate baseline** (refus si invalide sauf flag explicite). Les 4 critères sont : batch de 4 ops liées avec résumés + diff et annulation totale si la 3e/4 échoue ; `dryRun` sans toucher au disque ; `undo` restaurant l'état précédent après un save ; baseline invalide refusée sauf override ; tests d'injection d'échec à chaque étage (sources : `gh issue view 17`, `gh issue view 13`, `gh issue view 11` §User Stories 8–9, 17).
- Le **socle existe déjà et est prouvé** : pipeline transverse `snapshot → zod → has* → apply → updateBehaviorsSharedData → round-trip + gate zéro-nouvelle-erreur` avec rollback mémoire (`src/pipeline.ts`), save atomique `backup timestampé + tmp+rename` avec gate bloquante (`src/commands.ts`), sessions `dirty/force/close` + politique chemins (`src/sessions.ts`), 28 schémas contenu exportés pour rejeu batch (`src/content.ts`), `dryRun` déjà prouvé sur les 3 outils événements via `withDryRun` (`src/events.ts`), diagnostics bloquants à 4 types (`src/engine.ts`), suite `node --test` + doubles `gd` + opt-in réel (`test/`).
- **Ce qui manque** (périmètre #17) : `apply_content_batch` lui-même (aucune occurrence dans le code), `undo_last_edit` + copie `-pre-restore` (aucune occurrence), diff sémantique avant/après (aucune occurrence — seul `describe`/`contentView` existe comme base), gate baseline avec flag explicite (le pipeline actuel **tolère** la baseline via zéro-nouvelle-erreur, et le save refuse tout état bloquant sans override), et l'extension du `dryRun` aux ops de contenu. L'injection d'échec est partiellement couverte (6 des 7 étages) mais à étendre au batch.

## Détails par axe

### 1. `apply_content_batch` — atomicité tout-ou-rien

**Demande.** « `apply_content_batch` rejouant exactement les payloads granulaires (Ops de contenu) en tout-ou-rien avec `dryRun` » ; critère : « Batch de 4 ops liées appliqué en un appel avec résumés + diff ; une op fautive (3e/4) annule tout, zéro mutation » (source : `gh issue view 17`, corps et critères).

**Base spec.** La User Story 17 de la spec parente exige « enchaîner une séquence liée (scène + objet + instance + variable) en un appel batch tout-ou-rien avec `dryRun`, afin d'éviter 4 allers-retours et les états intermédiaires » (source : `gh issue view 11`, §User Stories, item 17). Le glossaire fige le vocabulaire : « **Op de contenu** : Payload d'une mutation de contenu, identique en appel granulaire et dans `apply_content_batch` » (source : `CONTEXT.md`, §Contenu GDevelop). La synthèse Wayfinder confirme : « outils granulaires EN `snake_case` + `apply_content_batch` rejouant les mêmes payloads » (source : `gh issue view 11`, §Decisions).

**Existe.** Les 28 schémas zod de contenu sont **exportés précisément pour ce rejeu** : « The zod schemas are exported so `apply_content_batch` (ticket #17) replays exactly the same payloads » (source : `src/content.ts`, L11–15). Le registre d'outils confirme « one thin wrapper per content command, same payloads as batch (#17) » pour les 28 outils contenu et « same payloads as batch (#17) » pour les 4 outils événements (source : `src/tools.ts`, L150, L208). Le bloqueur est levé : #13 est `CLOSED`, livrée dans `4eae817` (« 28 outils contenu… schémas exportés pour le batch #17, describe_project enrichi »), ne laissant que la « limite connue : collisionMaskAutomatic (flag Sprite) seul, polygones custom en follow-up » (source : `gh issue view 13`, commentaire de clôture + `git log --oneline` : `4eae817 Contenu granulaire (#13)`).

**Manque.** Aucune occurrence de `apply_content_batch` dans le code (recherche `apply_content_batch|undo_last_edit|dryRun|…` : seul le `dryRun` événementiel et les mentions `#17` en commentaires remontent). Reste à construire : schéma batch (liste d'ops typées `{op, payload}` réutilisant `contentSchemas` + `eventsSchemas`), exécution séquentielle sous **un seul snapshot** (atomicité globale, pas N snapshots), résumés par op, et diff (voir §4).

### 2. `dryRun` — pipeline complet sans écrire

**Demande.** « `dryRun` exécute le pipeline sans toucher au disque » (source : `gh issue view 17`, critères) ; la spec parente veut « `dryRun` (pipeline complet sans écrire) » (source : `gh issue view 11`, User Story 8).

**Existe (événements uniquement).** Les trois mutations d'événements portent `dryRun?: boolean` dans le port moteur (`AppendEventsInput`, `MoveEventInput`, `RemoveEventInput` ; source : `src/engine.ts`, L247–273) et l'implémentent via un wrapper prouvé : « dryRun wrapper: full pipeline, then memory restore + prior dirty flag restore » — snapshot sérialisé + `wasDirty`, `mutate(...)` puis `restoreProject` et restauration du flag dirty en `finally` (source : `src/events.ts`, L169–186, appliqué L188–247 dans `appendSceneEvents`, `moveSceneEvent`, `removeSceneEvent`). Le résultat propage `dryRun: true` (`AppendEventsResult.dryRun` ; source : `src/engine.ts`, L254–259).

**Manque.** Aucune op de contenu n'accepte `dryRun` (les 28 schémas de `src/content.ts`, L42–142, n'en ont pas ; le helper `mutate` de `src/content.ts`, L146–158, ne restaure rien). Le batch devra donc soit généraliser `withDryRun` au niveau batch (un snapshot global + restauration), soit l'étendre op par op. Note de périmètre : le pipeline actuel ne touche déjà jamais le disque (seul `saveProject` écrit), donc « sans toucher au disque » signifie surtout **restaurer la mémoire + le flag dirty**, comme le fait déjà le wrapper événements.

### 3. `undo_last_edit` — copie `-pre-restore`

**Demande.** « `undo_last_edit` (avec copie `-pre-restore`) » ; critère : « `undo` restaure l'état précédent après un save » (sources : `gh issue view 17`, corps et critères ; `gh issue view 11`, User Story 8).

**Manque entièrement.** Zéro occurrence de `undo_last_edit` ou `pre-restore` dans le code (recherche codebase). Réutilisable tel quel :

- Le **rollback mémoire** par snapshot sérialisé : `serializeProject` avant mutation, `restoreProject(session.project, snapshot)` sur échec round-trip ou nouvelles erreurs bloquantes (source : `src/pipeline.ts`, L44–45, L66–85).
- La **sauvegarde disque** `<projet>.bak-<ISO>` (colons/points assainis) avant chaque save atomique `tmp+rename` avec nettoyage du `.tmp` en échec (source : `src/commands.ts`, L60–84 ; test « save writes a timestamped backup and renames atomically », source : `test/commands.test.ts`, L38–48).
- Le cycle dirty : `markDirty` après mutation validée, `clearDirty` après save, refus `close` si dirty sauf `force:true` avec `project.delete()` (sources : `src/pipeline.ts`, L87 ; `src/commands.ts`, L81–93 ; `src/sessions.ts`, L74–96).

**Point de conception.** Le `-pre-restore` de la spec est une **copie disque** (distincte du snapshot mémoire et du `.bak-<ISO>`, cf. glossaire : « **Snapshot** : Copie mémoire pré-opération… _Avoid_: backup » vs « **Backup** : Fichier `<projet>.bak-<ISO>`… » ; source : `CONTEXT.md`, L13–19). L'`undo` devra donc : au `save`, écrire en plus une copie `-pre-restore` de l'état disque précédent (ou du sérialisé pré-save) ; à `undo_last_edit`, recharger cette copie en mémoire (via `loadProjectFromJson`/`restoreProject`) + l'écrire sur disque, et marquer l'état dirty résultant. La fermeture « stoppe ses previews liées » (User Story 7, source : `gh issue view 11`) n'a pas d'objet actuel (pas de preview dans le code) — hors périmètre du batch.

### 4. Diff sémantique avant/après

**Demande.** « diff sémantique avant/après » (corps #17) ; « avec résumés + diff » (critères #17) ; « un diff sémantique avant/après » (User Story 8 de #11).

**Manque, base disponible.** Aucun module diff (recherche `diff` : seuls faux positifs sans rapport). La base toute désignée est le **lecteur pur** `readContentView` : JSON sérialisé moteur vers vue agent (`scenes`, `globalObjects`, `globalVariables`, `globalGroups`, `resources`), partagé par les moteurs réel et factice pour décrire identiquement (source : `src/contentView.ts`, L1–8, L360–376), exposé via `describeContent`/`describeProject` sans fuite de handle WASM (sources : `src/engine.ts`, L305–306 ; `src/commands.ts`, L26–38). Le batch peut donc photographier `describeContent` avant/après le snapshot global et rendre un diff structurel (scènes ajoutées/renommées, objets, instances, variables, groupes, ressources) — « sémantique » au sens : comparé sur la vue, pas sur les octets JSON.

### 5. Gate baseline — refus si invalide sauf flag explicite

**Demande.** « gate baseline (refus si invalide sauf flag explicite) » ; critère : « baseline invalide refuse sauf override » (source : `gh issue view 17`) ; User Story 9 : « qu'un projet invalide en baseline refuse toute mutation sauf flag explicite, afin de ne pas aggraver un projet cassé » (source : `gh issue view 11`).

**Inverse partiel, à inverser.** Le pipeline actuel capture la baseline mais pour la **tolérer**, pas pour la refuser : `baseline = new Set(listDiagnostics(...))` puis gate **zéro-nouvelle-erreur** (seules les bloquantes non présentes en baseline refusent ; source : `src/pipeline.ts`, L46, L77–85). Le test fige ce comportement : « ignores pre-existing baseline diagnostics (zero-new-error gate) » (source : `test/pipeline.test.ts`, L90–103). Parallèlement, le **save refuse tout état bloquant** sans override : « unlike the pipeline's zero-new-error check per mutation, the save refuses any blocking state — nothing invalid ever reaches the disk » (source : `src/commands.ts`, L50–57 ; test `test/commands.test.ts`, L50–60). Les 4 types bloquants sont la source unique de vérité (`UndeclaredVariable`, `MissingBehavior`, `UnknownObject`, `MismatchedObjectType` ; source : `src/engine.ts`, L21–40). Il manque donc : un paramètre explicite d'override (p. ex. `allowInvalidBaseline?: true`) vérifié **avant** le snapshot sur `listDiagnostics(...).filter(isBlockingDiagnostic)`, refusant en `validation-failed` quand la baseline est invalide sans le flag — pour le batch et, selon la spec (User Story 9, « toute mutation »), à propager aux mutations unitaires.

### 6. Injection d'échec à chaque étage du pipeline

**Demande.** « Tests d'injection d'échec à chaque étage du pipeline » (source : `gh issue view 17`, critères). La spec parente exige « couche commande (tout), pipeline de validation (échec à chaque étage : refus pré-mutation vs rollback) » avec « `node --test` + doubles `gd` factices + opt-in réel via `GDEVELOP_*` » (source : `gh issue view 11`, §Testing Decisions).

**Largement couvert, à étendre au batch.** Les 7 étages du pipeline (`snapshot → zod → has* → apply → updateBehaviorsSharedData → round-trip + diagnostics → backup → tmp+rename`, synthèse Wayfinder source : `gh issue view 11`, §Decisions ; `src/pipeline.ts`, L32–38) sont testés ainsi :

- `unknown-session` avant tout contact moteur (source : `test/pipeline.test.ts`, L126–139) ;
- zod invalide → refus pré-mutation, mémoire intacte, `dirty=false` (source : `test/pipeline.test.ts`, L30–46) ;
- précondition `has*` en échec → refus pré-mutation (source : `test/pipeline.test.ts`, L48–67) ;
- nouvelles erreurs bloquantes post-apply → `post-apply-failed` + snapshot restauré, `dirty=false` (source : `test/pipeline.test.ts`, L69–88) ;
- round-trip cassé (`failSerialize`) → `post-apply-failed` + snapshot restauré (source : `test/pipeline.test.ts`, L105–124 ; fake : `FakeProject.failSerialize`, source : `test/fakeEngine.ts`, L64–76) ;
- save avec bloquantes → `validation-failed`, fichier jamais créé (source : `test/commands.test.ts`, L50–60).
- Le fake moteur rend l'injection déterministe : `initialDiagnostics` (baseline) et `engine.diagnostics` mutable dans `apply` (sources : `test/fakeEngine.ts`, L106–109 ; `test/pipeline.test.ts`, L90–103, L69–88).
- Reste à couvrir pour #17 : échec **au milieu d'un batch** (3e op sur 4 → zéro mutation, snapshot global restauré, `dirty` inchangé), échec backup/`tmp+rename` (étages backup et rename aujourd'hui couverts seulement en succès : `test/commands.test.ts`, L18–48), et refus baseline sans override vs succès avec override.

## État actuel du code (ce qui existe déjà vs manque)

### Existe déjà (socle prouvé, réutilisable tel quel)

| Élément | Source |
|---|---|
| Pipeline transverse snapshot → zod → `has*` → apply → `updateBehaviorsSharedData` → round-trip + gate zéro-nouvelle-erreur, rollback mémoire, `markDirty` | `src/pipeline.ts` (L32–89) |
| Save atomique : gate bloquante totale, backup `<projet>.bak-<ISO>`, `tmp+rename`, nettoyage `.tmp`, `setProjectFile` + `clearDirty` | `src/commands.ts` (L40–85) |
| Sessions : UUID, `dirty`/`force`/`close` + `project.delete()`, chemins absolus, null-bytes refusés, `allowedRoot` | `src/sessions.ts` (L24–112) |
| 28 schémas contenu exportés pour rejeu batch + 28 outils thin wrappers « same payloads as batch (#17) » | `src/content.ts` (L11–15, L42–144) ; `src/tools.ts` (L150–206) |
| 4 schémas/outils événements « same payloads as batch (#17) », `dryRun` prouvé via `withDryRun` (snapshot + dirty restaurés) | `src/events.ts` (L7–18, L169–254) ; `src/tools.ts` (L208–240) ; `src/engine.ts` (L247–273) |
| 4 diagnostics bloquants (`UndeclaredVariable`, `MissingBehavior`, `UnknownObject`, `MismatchedObjectType`) + helpers | `src/engine.ts` (L21–45) |
| Lecteur pur `readContentView` (base du futur diff), `describe_project` sans fuite WASM | `src/contentView.ts` ; `src/commands.ts` (L26–38) |
| Erreurs codées (`unknown-session`, `session-dirty`, `validation-failed`, `post-apply-failed`, `io-error`, …) | `src/errors.ts` |
| Suite `node --test` + fake déterministe (`failSerialize`, `initialDiagnostics`, `diagnostics` mutable) + opt-in réel `GDEVELOP_*` | `test/pipeline.test.ts`, `test/commands.test.ts`, `test/sessions.test.ts`, `test/content.test.ts`, `test/tools.test.ts`, `test/fakeEngine.ts`, `test/real-libgd.test.ts` |
| Bloqueur #13 livré/fermé (`4eae817`, 28 outils, `describe` enrichi) | `gh issue view 13` (commentaire de clôture) ; `git log --oneline` |

### Manque (périmètre #17)

| Élément | Preuve d'absence |
|---|---|
| `apply_content_batch` (schéma batch, exécution multi-ops sous un snapshot, résumés) | Zéro occurrence dans la recherche codebase (`apply_content_batch`) |
| `undo_last_edit` + copie disque `-pre-restore` | Zéro occurrence (`undo_last_edit`, `pre-restore`) |
| Diff sémantique avant/après | Zéro module diff ; seul `readContentView`/`describe` existe comme base |
| Gate baseline avec override explicite | Le pipeline **tolère** la baseline (zéro-nouvelle-erreur, `test/pipeline.test.ts` L90–103) au lieu de la refuser ; le save refuse sans override |
| `dryRun` sur les ops de contenu | Réservé aux 3 outils événements (`src/events.ts` L169–247) ; absent des 28 schémas contenu |
| Tests : échec mid-batch (3e/4), échec backup/rename, baseline ± override | Non couverts (succès backup/rename seuls en `test/commands.test.ts` L18–48) |

## Risques / points ouverts

1. **Sémantique `undo` après `save` non tranchée par l'issue.** « Restaure l'état précédent » : état disque pré-save (via `-pre-restore`), état mémoire pré-save, ou les deux avec quel `dirty` résultant ? La spec dit seulement « avec copie `-pre-restore` » (sources : `gh issue view 17` ; `gh issue view 11`, User Story 8). Le glossaire impose de ne pas confondre snapshot (mémoire) et backup (disque) (source : `CONTEXT.md`, L13–19).
2. **Portée du batch : contenu seul ou contenu + événements ?** L'issue dit « Ops de contenu » mais les schémas événements sont eux aussi exportés « so `apply_content_batch` replays exactly the same payloads » et les outils événements annoncent « same payloads as batch (#17) » (sources : `gh issue view 17` ; `src/events.ts`, L7–12 ; `src/tools.ts`, L208). Trancher : batch homogène contenu, ou batch mixte incluant `append/move/remove_scene_event`.
3. **Gate baseline vs tolérance actuelle : changement de comportement.** Inverser le pipeline (refuser par défaut sur baseline invalide) casse le test « ignores pre-existing baseline diagnostics » et la synthèse Wayfinder « zéro-nouvelle-erreur » (sources : `test/pipeline.test.ts`, L90–103 ; `gh issue view 11`, §Decisions). Décider si le refus baseline s'applique au batch seul ou à « toute mutation » (User Story 9), avec quel nom de flag, et quel code d'erreur (`validation-failed` recommandé, cohérent avec les refus pré-mutation).
4. **Diff : format non spécifié.** L'issue exige « résumés + diff » sans format (source : `gh issue view 17`). Le plus sûr : diff structurel sur `ContentView` (déjà versionné par `describe`), pas de diff textuel JSON.
5. **Ressources et disque dans le batch.** `import_resource` copie un binaire **avant** `runMutation` avec compensation manuelle (`unlink` en échec ; source : `src/content.ts`, L380–425). En batch, une op `import_resource` suivie d'un échec doit aussi annuler la copie — prévoir la compensation au niveau batch (le snapshot mémoire ne suffit pas).
6. **`dryRun` et ids d'instances/événements.** `place_instance` retourne un UUID et `appendSceneEvents` des ids estampillés (sources : `src/engine.ts`, L326 ; `src/events.ts`, L188–211). En `dryRun` restauré, ces ids sont consommés pour rien : documenter qu'ils ne sont pas rejouables.
7. **Snapshots complets assumés au MVP** (hors périmètre : « Snapshots incrémentaux / perf gros projets (snapshots complets assumés au MVP) », source : `gh issue view 11`, §Out of Scope) : le batch multi-ops sous un seul snapshot sérialisé complet reste dans ce budget, mais mesurer sur gros projets (question ouverte n° 8 de la recherche libGD : « `Serializer.toJSON` full-project snapshots per op — measure vs incremental », source : `docs/research/gdevelop-mcp-libgd-research.md`, §7.8).

## Recommandations d'implémentation

1. **Batch = un snapshot global + rejeu des commandes existantes.** Nouveau `src/batch.ts` : schéma `applyContentBatch { sessionId, ops: Array<{op, payload}> (union discriminée sur `contentSchemas` + éventuellement `eventsSchemas`), dryRun?, allowInvalidBaseline? }` ; exécution : `get` session → gate baseline (si bloquantes et pas de flag → `validation-failed`) → snapshot global + baseline diagnostics → pour chaque op, valider le sous-schéma puis appeler la **fonction commande existante** (pas le moteur direct) → en cas d'échec (zod, précondition, post-apply) : `restoreProject` global + `dirty` restauré, zéro mutation ; sinon `markDirty` une fois + diff avant/après + résumés. Atomicité prouvée par le scénario « 3e/4 fautive » des critères.
2. **`dryRun` = `withDryRun` généralisé.** Extraire le wrapper de `src/events.ts` (L169–186) en helper partagé (ou l'appliquer au niveau batch : snapshot + `wasDirty`, exécution, restauration en `finally`) ; retourner `dryRun: true` avec résumés + diff sans `markDirty` persistant.
3. **`undo_last_edit` adossé au save.** Dans `saveProject` (`src/commands.ts`), après backup `.bak-<ISO>` réussi, écrire la copie `-pre-restore` (pré-save) ; nouveau `undoLastEdit { sessionId }` : recharger la copie (`loadProjectFromJson`/`restoreProject`), la réécrire atomiquement (`tmp+rename`), `markDirty`, et rendre `{ restoredPath, backupPath }`. Figer : `undo` après `undo` (chaîne ou one-shot), `undo` sans save préalable (erreur propre), et interaction avec `close` dirty/`force`.
4. **Diff sur `ContentView`.** Nouveau `diffContentView(before, after)` pur et testé isolément (scènes/objets/instances/variables/groupes/ressources ajoutés–supprimés–modifiés) ; le batch capture `describeContent` avant/après le snapshot global. En `dryRun`, le diff est calculé avant restauration.
5. **Gate baseline explicite.** Paramètre `allowInvalidBaseline?: boolean` (défaut `false`) sur le batch — et, si on suit la User Story 9 (« toute mutation »), sur `runMutation` lui-même : avant zod, si `listDiagnostics().filter(isBlockingDiagnostic).length > 0` sans flag → `validation-failed` listant les bloquantes. Mettre à jour le test baseline de `test/pipeline.test.ts` (L90–103) en deux cas (± override).
6. **Compensation disque des ressources en batch.** Si le batch inclut `import_resource`, enregistrer chaque binaire copié pendant le batch et les `unlink` sur rollback (généraliser le `try/catch` de `src/content.ts`, L405–425).
7. **Tests d'injection (seam commande, doubles `gd`, pas de transport).** Conformément aux Testing Decisions de la spec (source : `gh issue view 11`) : batch 4 ops OK avec diff ; 3e/4 fautive → `post-apply-failed`/`validation-failed`, mémoire identique (`describe` avant = après), `dirty` inchangé ; `dryRun` → mémoire + `dirty` inchangés, disque intact ; `undo` → contenu post-save restauré ; baseline invalide refusée sans flag / acceptée avec ; échec `failSerialize` mid-batch ; échec backup/rename simulé. Garder le round-trip réel opt-in (`GDEVELOP_*`, pattern `test/real-libgd.test.ts`).

## Sources

- Issues GitHub (via `gh issue view`) :
  - #17 « Batch + sécurité (atomicité, undo, diff, dryRun, baseline) » — `OPEN`, `ready-for-agent`, corps + 4 critères + « Blocked by Contenu granulaire » (zéro commentaire).
  - #11 « Spec — Serveur MCP GDevelop over libGD.js (MVP) » — `OPEN`, `ready-for-agent` : User Stories 8 (`dryRun`, `undo_last_edit` avec copie `-pre-restore`, diff), 9 (gate baseline sauf flag explicite), 17 (batch tout-ou-rien avec `dryRun`) ; §Decisions (pipeline snapshot → … → backup → tmp+rename ; `apply_content_batch` rejouant les mêmes payloads ; sécurité chemins absolus/null-bytes/`allowedRoot`/`.delete()`) ; §Testing Decisions (`node --test` + doubles + opt-in `GDEVELOP_*`, échec à chaque étage) ; §Out of Scope (snapshots complets assumés).
  - #13 « Contenu granulaire… » — `CLOSED` (commentaire : livré dans `4eae817`, 28 outils, schémas exportés pour le batch #17, `describe_project` enrichi ; limite `collisionMaskAutomatic` seul).
- Glossaire : `CONTEXT.md` (§Session projet, Snapshot vs Backup, Op de contenu, Preview, Folder-project).
- Recherche antérieure : `docs/research/gdevelop-mcp-libgd-research.md` (§6 pipeline/backup/tmp+rename, §7 questions ouvertes n° 3 `.delete()`, n° 8 snapshots complets ; §Source index) ; `docs/research/gdevelop-mcp-catalogue-research.md` (hors sujet #17, listé pour exhaustivité du dossier `docs/research/`).
- Code : `src/pipeline.ts` (L32–89) ; `src/commands.ts` (L40–93) ; `src/sessions.ts` (L24–112) ; `src/content.ts` (L11–15, L42–158, L380–432) ; `src/events.ts` (L7–18, L169–254) ; `src/tools.ts` (L150–240) ; `src/engine.ts` (L21–45, L247–273, L298–348) ; `src/errors.ts` ; `src/contentView.ts` (L1–8, L360–376).
- Tests : `test/pipeline.test.ts` (7 cas : succès+dirty, zod, précondition, bloquantes post-apply, baseline tolérée, round-trip cassé, unknown-session) ; `test/commands.test.ts` (byte-identical, backup+rename, gate save, close dirty/force, folder-project) ; `test/sessions.test.ts` (UUID, open, folder-project refusé, chemins, close dirty/force, `delete()`) ; `test/content.test.ts` (scénario Niveau1/Joueur) ; `test/tools.test.ts` (5 lifecycle + 28 contenu + 10 catalogue) ; `test/fakeEngine.ts` (`FakeProject`, `failSerialize`, `initialDiagnostics`) ; `test/real-libgd.test.ts` (opt-in `GDEVELOP_*`).
- Historique : `git log --oneline` (`abf0cc3` catalogue, `989404f` événements #14, `4eae817` contenu #13, `9e9da75` scaffold) ; `git status` propre ; `package.json` (SDK `1.20.1`, `zod`, `node --test`).
