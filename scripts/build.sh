#!/bin/bash
# Reproducible Folderai build. Precompiles the OCR Vision helper and bundles it, so
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
if pgrep -f "Folderai.app" >/dev/null 2>&1; then
  echo "ABORT: Folderai is running — quit it first, then re-run."; exit 1
fi

echo "Compiling OCR helper (Vision)…"
swiftc -O native/ocr.swift -o "$STAGE/ocr-helper"

IGN=(--ignore='^/dist($|/)' --ignore='^/dist-ship($|/)' --ignore='^/dist-inprocess($|/)' --ignore='^/\.git($|/)' --ignore='^/scripts($|/)')
COMMON=(--platform=darwin --arch=arm64 --overwrite --no-asar --app-bundle-id=com.xintechllc.folderai --extra-resource="$STAGE/ocr-helper")
[ -f build/icon.icns ] && COMMON+=(--icon=build/icon.icns) # used automatically once you add build/icon.icns

if [ "$MODE" = "inprocess" ]; then
  echo "inprocess" > "$STAGE/inprocess.flag"
  npx @electron/packager . Folderai --out=dist-inprocess "${COMMON[@]}" "${IGN[@]}" --extra-resource="$STAGE/inprocess.flag" | tail -1
  APP="dist-inprocess/Folderai-darwin-arm64/Folderai.app"
else
  npx @electron/packager . Folderai --out=dist "${COMMON[@]}" "${IGN[@]}" | tail -1
  APP="dist/Folderai-darwin-arm64/Folderai.app"
fi

echo "Built: $APP ($(du -sh "$APP" | cut -f1))"
[ -f "$APP/Contents/Resources/ocr-helper" ] && echo "OCR helper bundled ✓" || echo "OCR helper MISSING ✗"
rm -rf "$STAGE"
