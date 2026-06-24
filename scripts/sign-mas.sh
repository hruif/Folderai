#!/bin/bash
# Build + sign + package Folderai for the Mac App Store. This is the LAST step toward
# submission; it needs YOUR Apple Developer credentials (see MAS.md for setup).
#
# Required env vars:
#   APPLE_TEAM_ID        e.g. AB12CD34EF
#   MAS_APP_CERT         "3rd Party Mac Developer Application: Your Name (TEAMID)"
#   MAS_INSTALLER_CERT   "3rd Party Mac Developer Installer: Your Name (TEAMID)"
#   PROVISION_PROFILE    path to your Mac App Store embedded.provisionprofile
#
# Output: a signed Folderai.pkg ready to upload via Transporter / notarytool.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID}"
: "${MAS_APP_CERT:?set MAS_APP_CERT (3rd Party Mac Developer Application: …)}"
: "${MAS_INSTALLER_CERT:?set MAS_INSTALLER_CERT (3rd Party Mac Developer Installer: …)}"
: "${PROVISION_PROFILE:?set PROVISION_PROFILE (path to .provisionprofile)}"
[ -f "$PROVISION_PROFILE" ] || { echo "Provisioning profile not found: $PROVISION_PROFILE"; exit 1; }

STAGE="/tmp/folderai-mas"; rm -rf "$STAGE"; mkdir -p "$STAGE"
VERSION="$(node -p "require('./package.json').version || '1.0.0'")"

# 1) Precompile the OCR helper + set the in-process backend marker (App Store = no Ollama).
echo "› compiling OCR helper…"
swiftc -O native/ocr.swift -o "$STAGE/ocr-helper"
echo "inprocess" > "$STAGE/inprocess.flag"

# 1b) Bundle the model so the sandboxed app works offline with no download (Apple hosts
#     the binary). The sandbox can't reach ~/.ollama, so the model must ship inside.
#     Source: the local Ollama gguf blob (set FA_GGUF_SRC to override with another gguf).
echo "› bundling model…"
mkdir -p "$STAGE/models"
MODEL_SRC="${FA_GGUF_SRC:-$(ls -S "$HOME"/.ollama/models/blobs/sha256-* 2>/dev/null | head -1)}"
[ -n "$MODEL_SRC" ] && [ -f "$MODEL_SRC" ] || { echo "No gguf to bundle (set FA_GGUF_SRC=/path/to/model.gguf)"; exit 1; }
cp "$MODEL_SRC" "$STAGE/models/llama3.2-3b.gguf"

# 2) Build the MAS target (the App Store variant of Electron). --no-asar so the native
#    modules (node-llama-cpp, ocr-helper) are real files that can be signed.
echo "› packaging (mas target)…"
npx --yes @electron/packager . Folderai \
  --platform=mas --arch=arm64 --out="$STAGE/out" --overwrite --no-asar \
  --app-bundle-id=com.xintechllc.folderai --app-version="$VERSION" --build-version="$VERSION" \
  --extra-resource="$STAGE/ocr-helper" --extra-resource="$STAGE/inprocess.flag" --extra-resource="$STAGE/models" \
  --ignore='^/dist' --ignore='^/dist-ship' --ignore='^/dist-inprocess' --ignore='^/scripts' --ignore='^/build' --ignore='^/\.git'
APP="$STAGE/out/Folderai-mas-arm64/Folderai.app"
[ -d "$APP" ] || { echo "build failed: $APP missing"; exit 1; }

# 3) Embed the provisioning profile.
cp "$PROVISION_PROFILE" "$APP/Contents/embedded.provisionprofile"

# 4) Bake the real Team ID into the parent entitlements (application-groups).
sed "s/__TEAMID__/$APPLE_TEAM_ID/g" build/entitlements.mas.plist > "$STAGE/parent.plist"

# 5) Sign everything inside-out — helpers + ocr-helper + node-llama-cpp .node get the
#    inherit entitlements. @electron/osx-sign knows the Electron helper layout.
echo "› signing…"
npx --yes @electron/osx-sign "$APP" \
  --platform=mas \
  --type=distribution \
  --identity="$MAS_APP_CERT" \
  --provisioning-profile="$PROVISION_PROFILE" \
  --entitlements="$STAGE/parent.plist" \
  --entitlements-inherit=build/entitlements.mas.inherit.plist \
  --gatekeeper-assess=false

# 6) Build the signed installer package for App Store Connect.
PKG="$STAGE/Folderai-$VERSION.pkg"
echo "› building signed installer…"
productbuild --component "$APP" /Applications --sign "$MAS_INSTALLER_CERT" "$PKG"

echo
echo "✅ Signed package: $PKG"
echo "   Upload it with the Transporter app, or:"
echo "   xcrun altool --upload-app --type osx --file \"$PKG\" --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>"
echo "   (verify entitlements first:  codesign -d --entitlements - \"$APP\")"
