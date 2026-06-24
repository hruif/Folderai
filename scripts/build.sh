#!/bin/bash
# Reproducible FolderAI build. Precompiles the OCR Vision helper and bundles it, so
# nothing is compiled at runtime (swiftc is forbidden by the App Store sandbox).
#
#   scripts/build.sh            → dist/            (regular: system Ollama)
#   scripts/build.sh inprocess  → dist-inprocess/  (in-process llama.cpp, no Ollama)
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${1:-regular}"
STAGE="/tmp/folderai-build"
rm -rf "$STAGE"; mkdir -p "$STAGE"

# Never overwrite a running app bundle (it would kill the running app mid-write).
if pgrep -f "FolderAI.app" >/dev/null 2>&1; then
  echo "ABORT: FolderAI is running — quit it first, then re-run."; exit 1
fi

echo "Compiling OCR helper (Vision)…"
swiftc -O native/ocr.swift -o "$STAGE/ocr-helper"

IGN=(--ignore='^/dist($|/)' --ignore='^/dist-ship($|/)' --ignore='^/dist-inprocess($|/)' --ignore='^/\.git($|/)' --ignore='^/scripts($|/)')
COMMON=(--platform=darwin --arch=arm64 --overwrite --no-asar --app-bundle-id=com.folderai.app --extra-resource="$STAGE/ocr-helper")

if [ "$MODE" = "inprocess" ]; then
  echo "inprocess" > "$STAGE/inprocess.flag"
  npx @electron/packager . FolderAI --out=dist-inprocess "${COMMON[@]}" "${IGN[@]}" --extra-resource="$STAGE/inprocess.flag" | tail -1
  APP="dist-inprocess/FolderAI-darwin-arm64/FolderAI.app"
else
  npx @electron/packager . FolderAI --out=dist "${COMMON[@]}" "${IGN[@]}" | tail -1
  APP="dist/FolderAI-darwin-arm64/FolderAI.app"
fi

echo "Built: $APP ($(du -sh "$APP" | cut -f1))"
[ -f "$APP/Contents/Resources/ocr-helper" ] && echo "OCR helper bundled ✓" || echo "OCR helper MISSING ✗"
rm -rf "$STAGE"
