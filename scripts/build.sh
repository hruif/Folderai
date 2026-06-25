#!/bin/bash
# Reproducible Folderai build. Precompiles the OCR Vision helper and bundles it, so
# nothing is compiled at runtime (swiftc is forbidden by the App Store sandbox).
#
#   scripts/build.sh            → dist/            (regular: system Ollama)
#   scripts/build.sh inprocess  → dist-inprocess/  (in-process llama.cpp + bundled model)
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

resolve_model_src() {
  if [ -n "${FA_GGUF_SRC:-}" ]; then
    echo "$FA_GGUF_SRC"
    return
  fi

  local manifest="$HOME/.ollama/models/manifests/registry.ollama.ai/library/llama3.2/3b"
  if [ -f "$manifest" ]; then
    local digest
    digest="$(node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const layer=m.layers.find((l)=>l.mediaType==='application/vnd.ollama.image.model'); if (!layer) process.exit(1); process.stdout.write(layer.digest.replace(/^sha256:/, ''));" "$manifest")"
    local blob="$HOME/.ollama/models/blobs/sha256-$digest"
    if [ -f "$blob" ]; then
      echo "$blob"
      return
    fi
  fi

  ls -S "$HOME"/.ollama/models/blobs/sha256-* 2>/dev/null | head -1
}

IGN=(--ignore='^/dist($|/)' --ignore='^/dist-ship($|/)' --ignore='^/dist-inprocess($|/)' --ignore='^/\.git($|/)' --ignore='^/scripts($|/)')
COMMON=(--platform=darwin --arch=arm64 --overwrite --no-asar --app-bundle-id=com.xintechllc.folderai --extra-resource="$STAGE/ocr-helper")
[ -f build/icon.icns ] && COMMON+=(--icon=build/icon) # packager auto-completes .icns on macOS

if [ "$MODE" = "inprocess" ]; then
  echo "inprocess" > "$STAGE/inprocess.flag"
  echo "Bundling llama3.2:3b model…"
  mkdir -p "$STAGE/models"
  MODEL_SRC="$(resolve_model_src)"
  [ -n "$MODEL_SRC" ] && [ -f "$MODEL_SRC" ] || { echo "No gguf to bundle (set FA_GGUF_SRC=/path/to/model.gguf)"; exit 1; }
  cp "$MODEL_SRC" "$STAGE/models/llama3.2-3b.gguf"
  rm -rf dist-inprocess/Folderai-darwin-arm64 2>/dev/null || true # avoid case-insensitive-FS ENOTEMPTY
  npx @electron/packager . Folderai --out=dist-inprocess "${COMMON[@]}" "${IGN[@]}" --extra-resource="$STAGE/inprocess.flag" --extra-resource="$STAGE/models" | tail -1
  APP="dist-inprocess/Folderai-darwin-arm64/Folderai.app"
else
  rm -rf dist/Folderai-darwin-arm64 2>/dev/null || true
  npx @electron/packager . Folderai --out=dist "${COMMON[@]}" "${IGN[@]}" | tail -1
  APP="dist/Folderai-darwin-arm64/Folderai.app"
fi

echo "Built: $APP ($(du -sh "$APP" | cut -f1))"
[ -f "$APP/Contents/Resources/ocr-helper" ] && echo "OCR helper bundled ✓" || echo "OCR helper MISSING ✗"
[ "$MODE" != "inprocess" ] || { [ -f "$APP/Contents/Resources/models/llama3.2-3b.gguf" ] && echo "Model bundled ✓" || echo "Model MISSING ✗"; }
rm -rf "$STAGE"
