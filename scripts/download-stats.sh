#!/bin/bash
# Snapshot GitHub release asset download counts into an ignored local JSONL file.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="${1:-hruif/Folderai}"
OUT_DIR="${FA_STATS_DIR:-.release-stats}"
OUT_FILE="$OUT_DIR/downloads.jsonl"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$OUT_DIR"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

gh api "repos/$REPO/releases?per_page=100" > "$TMP"

node - "$STAMP" "$REPO" "$TMP" >> "$OUT_FILE" <<'NODE'
const fs = require('fs');

const stamp = process.argv[2];
const repo = process.argv[3];
const file = process.argv[4];
const releases = JSON.parse(fs.readFileSync(file, 'utf8'));

for (const release of releases) {
  for (const asset of release.assets || []) {
    process.stdout.write(JSON.stringify({
      captured_at: stamp,
      repo,
      release: release.tag_name,
      release_name: release.name || '',
      asset: asset.name,
      download_count: asset.download_count || 0,
      size: asset.size || 0,
      state: asset.state || '',
      url: asset.browser_download_url || ''
    }) + '\n');
  }
}
NODE

echo "Wrote download stats to $OUT_FILE"
