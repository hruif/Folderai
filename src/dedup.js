'use strict';

const fs = require('fs');
const crypto = require('crypto');

// Deterministic duplicate detection — no AI, fast. Exact-content duplicates only
// (same bytes), found by hashing within same-size groups so we never hash a file
// that can't have a twin.

const FULL_HASH_LIMIT = 8 * 1024 * 1024; // hash whole file up to 8 MB; sample beyond

function fileHash(p, size) {
  const h = crypto.createHash('sha1');
  if (size <= FULL_HASH_LIMIT) {
    h.update(fs.readFileSync(p));
  } else {
    // Large file: sample head + tail + size (collision risk is negligible and it
    // avoids reading multi-GB files in full).
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(65536);
      let n = fs.readSync(fd, buf, 0, 65536, 0);
      h.update(buf.subarray(0, n));
      n = fs.readSync(fd, buf, 0, 65536, Math.max(0, size - 65536));
      h.update(buf.subarray(0, n));
      h.update(String(size));
    } finally {
      fs.closeSync(fd);
    }
  }
  return h.digest('hex');
}

// Which copy to KEEP: prefer a name without "copy"/"(n)" markers, then the oldest
// file, then the shortest name — i.e. the likely original.
const copyScore = (name) => (/\bcopy\b|\(\d+\)|\bduplicate\b/i.test(name) ? 1 : 0);
function primaryCmp(a, b) {
  return copyScore(a.name) - copyScore(b.name) || a.mtime - b.mtime || a.name.length - b.name.length;
}

// Returns Map<duplicateId, primaryItem> for every redundant copy.
function findDuplicates(items) {
  const bySize = new Map();
  for (const it of items) {
    if (it.isDir || it.size === 0) continue; // empties are handled by rules, not dedup
    if (!bySize.has(it.size)) bySize.set(it.size, []);
    bySize.get(it.size).push(it);
  }
  const dupOf = new Map();
  for (const group of bySize.values()) {
    if (group.length < 2) continue;
    const byHash = new Map();
    for (const it of group) {
      let hash;
      try { hash = fileHash(it.path, it.size); } catch { continue; }
      if (!byHash.has(hash)) byHash.set(hash, []);
      byHash.get(hash).push(it);
    }
    for (const dups of byHash.values()) {
      if (dups.length < 2) continue;
      dups.sort(primaryCmp);
      for (let i = 1; i < dups.length; i++) dupOf.set(String(dups[i].id), dups[0]);
    }
  }
  return dupOf;
}

module.exports = { findDuplicates };
