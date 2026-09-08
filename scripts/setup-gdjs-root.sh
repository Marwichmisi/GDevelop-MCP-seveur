#!/usr/bin/env bash
# Extrait resources/GDJS de l'AppImage GDevelop vers third-party/GDJS.
# Usage: APPIMAGE=/chemin/GDevelop-5-*.AppImage ./scripts/setup-gdjs-root.sh
set -euo pipefail

APPIMAGE="${APPIMAGE:-/home/marwane/Applications/GDevelop-5-5.6.281.AppImage}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/third-party/GDJS"

if [ ! -x "$APPIMAGE" ]; then
  echo "AppImage introuvable ou non exécutable : $APPIMAGE" >&2
  echo "Passez le chemin via APPIMAGE=... $0" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Extraction de l'AppImage (une à deux minutes)..."
(cd "$WORK" && "$APPIMAGE" --appimage-extract >/dev/null)

echo "Copie de resources/GDJS vers $DEST ..."
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -a "$WORK/squashfs-root/resources/GDJS" "$DEST"

echo "Vérification..."
test -f "$DEST/Runtime/Extensions/DialogueTree/JsExtension.js"
# Les JsExtension.js sont CommonJS : le repo étant type:module, ce scope
# force Node à les charger en CJS (sinon `module` est indéfini).
printf '{\n  "type": "commonjs"\n}\n' > "$(dirname "$DEST")/package.json"
echo "OK : $(find "$DEST" -name 'JsExtension.js' | wc -l) JsExtension.js sous $DEST"
