# gdevelop-mcp-server

Serveur MCP GDevelop over libGD.js — chaque session projet est un vrai
`gd.Project` en mémoire, jamais du JSON édité à l'aveugle. La sérialisation
vers le `.json` n'intervient qu'au save final.

Ticket : [#12 Scaffold + première balle traçante](https://github.com/Marwichmisi/GDevelop-MCP-seveur/issues/12) ·
Spec : [#11](https://github.com/Marwichmisi/GDevelop-MCP-seveur/issues/11).

## Prérequis

Node.js ≥ 20.

## Provisioning libGD.js

```sh
npm install
npm run build        # requis avant le provisioning (helpers dans dist/)
npm run provision:libgd
```

Télécharge le build précompilé pinné (`vendor/libgd-pin.json` : branche,
commit, sha256) depuis S3 dans `vendor/` et vérifie les hashes.
Équivalent manuel : copier `libGD.js` + `libGD.wasm` dans `vendor/`.

Note : le pin actuel suit `master/latest` avec les sha256 relevés au
téléchargement — reproductible tant que `latest` ne bouge pas. En CI,
pinner un commit explicite (`branch/commit/<hash>` + sha256).

## Build, tests, run

```sh
npm run typecheck
npm test             # build + suite unit (doubles gd factices)
npm start            # serveur MCP sur stdio
```

Suite opt-in contre le vrai moteur :

```sh
GDEVELOP_LIBGD_PATH=vendor/libGD.js npm test
```

## Utilisation dans opencode

`opencode.json` (à la racine) déclare le serveur `gdevelop` : commande
`node dist/src/index.js` avec `vendor/libGD.js` + les extensions GDJS
extraites de l'AppImage (`third-party/GDJS`, ignoré par git).

Reproduire l'extraction (AppImage GDevelop 5.x) :

```sh
APPIMAGE=/chemin/GDevelop-5-*.AppImage ./scripts/setup-gdjs-root.sh
```

Après `npm run build`, quitter puis relancer opencode (config chargée au
démarrage). Exemple de premier prompt : « Crée un projet GDevelop nommé
"Test", décris-le, sauve-le dans /tmp/test-agent/game.json ».

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `GDEVELOP_LIBGD_PATH` | `vendor/libGD.js` | Build libGD.js à charger |
| `GDEVELOP_GDJS_ROOT` | — | Racine GDJS (charge les `JsExtension.js`, ex. AppImage `resources/GDJS`) |
| `GDEVELOP_LOAD_EXTENSIONS` | `true` | `false` pour sauter le chargement des extensions |
| `GDEVELOP_LIBGD_PIN` | `vendor/libgd-pin.json` | Fichier pin du provisioning |
| `GDEVELOP_VENDOR_DIR` | `vendor/` | Destination du provisioning |

## Outils (scaffold)

`create_project`, `open_project`, `describe_project`, `save_project`,
`close_project`. Couche commande headless `(store, engine, args)` testée via
doubles factices ; les outils sont de fins wrappers zod.
