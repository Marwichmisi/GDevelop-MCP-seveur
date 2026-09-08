# Serveur MCP GDevelop over libGD.js

Serveur MCP qui expose un projet GDevelop comme une session manipulée via le vrai moteur (`gd.Project` en mémoire), jamais comme du JSON édité à l'aveugle.

## Language

### Sessions et persistance

**Session projet**:
Handle `gd.Project` en mémoire identifié par un UUID, isolé jusqu'au save explicite.
_Avoid_: projet ouvert, handle

**Snapshot**:
Copie mémoire pré-opération d'une session, servant au rollback en cas d'échec validé après application.
_Avoid_: backup

**Backup**:
Fichier `<projet>.bak-<ISO>` écrit avant chaque save atomique, restaurant l'état disque précédent.
_Avoid_: snapshot, sauvegarde

### Contenu GDevelop

**Objet**:
Définition typée posée dans un conteneur (scène ou projet), par exemple Sprite ou Text.
_Avoid_: instance, sprite (comme générique)

**Instance**:
Placement d'un objet dans une scène, avec position, calque et variables propres.
_Avoid_: objet

**Groupe d'objets**:
Ensemble nommé d'objets réutilisable dans les événements.
_Avoid_: groupe (tout court), dossier

**Événement natif**:
Logique construite via `EventsList` et `Instruction` typée du moteur, par opposition au JavaScript injecté.
_Avoid_: event JSON, JsCode (sauf le fallback marqueur managé)

**Op de contenu**:
Payload d'une mutation de contenu, identique en appel granulaire et dans `apply_content_batch`.
_Avoid_: commande, opération

**Sélecteur d'événement**:
Désignation d'un événement par chemin d'index ou identifiant stable, acceptée par les outils move/remove.
_Avoid_: index, id

**Preview**:
Export jouable d'une session mémoire servi en loopback, avec logs capturés et screenshot optionnel.
_Avoid_: export, build

**Import d'asset**:
Import ciblé d'assets d'un pack pinné vers une session, objets désérialisés moteur et ressources locales.
_Avoid_: téléchargement

**Catalogue**:
Index en lecture seule des instructions, objets, comportements et extensions, pinné et rafraîchi en TTL, qui aide l'écriture sans jamais la valider.
_Avoid_: documentation, registre

**Folder-project**:
Projet stocké en dossier, scènes et extensions éclatées en fichiers avec références, chargé par unsplit.
_Avoid_: projet dossier, split
