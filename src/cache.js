'use strict';

const fs = require('fs');

// BUMP THIS whenever classification logic changes (prompts, canonicalization,
// routing, consolidation…). The cache is keyed on the FILE, not the logic, so
// without a version a code improvement would keep serving stale verdicts for
// unchanged files. A version bump auto-invalidates the whole cache on next load.
const CACHE_VERSION = 3;

// A tiny JSON-file cache of AI classification results, keyed by file identity
// so re-scans don't re-classify unchanged files. Persisted across sessions.

// Cache validity ties to the file's identity AND the guidance used, since
// different guidance can produce different routing. Folder-structure changes
// are not part of the key — destinations stay reviewable and the executor
// creates any missing folder, so a slightly stale dest is harmless.
function cacheKey(item, guidance = '') {
  return `${item.path}|${item.size}|${Math.round(item.mtime)}|${guidance.trim()}`;
}

function loadCache(file) {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    parsed = {}; // missing or corrupt — start fresh
  }
  // Honor the version: a flat/old file or a version mismatch starts fresh, so
  // logic improvements take effect without the user clearing the cache.
  const data = (parsed.__version === CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object')
    ? parsed.entries : {};
  // Purge "not classified" fallbacks a past bug cached as permanent keeps — drop
  // them so those files get re-classified instead of staying stuck as kept forever.
  for (const k of Object.keys(data)) {
    if (data[k] && data[k].keep && data[k].reason === 'Kept (not classified)') delete data[k];
  }
  const cache = { file, data };
  cache.get = (key) => cache.data[key];
  cache.set = (key, val) => { cache.data[key] = val; };
  return cache;
}

// Drop cached entries whose source file no longer exists. Returns count removed.
function pruneCache(cache) {
  if (!cache || !cache.data) return 0;
  let removed = 0;
  for (const [key, val] of Object.entries(cache.data)) {
    const p = val && val._path;
    if (p && !fs.existsSync(p)) { delete cache.data[key]; removed += 1; }
  }
  return removed;
}

function clearCache(cache) {
  if (cache) cache.data = {};
}

function saveCache(cache) {
  if (!cache || !cache.file) return;
  try {
    fs.writeFileSync(cache.file, JSON.stringify({ __version: CACHE_VERSION, entries: cache.data }));
  } catch {
    /* best-effort; a failed cache write must never break a run */
  }
}

module.exports = { loadCache, saveCache, pruneCache, clearCache, cacheKey };
