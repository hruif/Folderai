'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Detect how a folder is currently sorted in Finder, mapping onto our view
// orders: 'name' | 'date' | 'size' | null (unknown / unsupported).
//
// A folder's OWN view settings live in its PARENT's .DS_Store, keyed by the
// folder name. We extract the relevant binary-plist blob and convert it with
// macOS `plutil`. Everything is best-effort with a fallback chain:
//   per-folder .DS_Store  ->  global Finder default  ->  null.

const VIEW_CODES = { Nlsv: 'list', clmv: 'column', icnv: 'icon', glyv: 'gallery', Flwv: 'coverflow' };

// Map a Finder sortColumn / arrangeBy key to one of our view orders.
function mapKey(key) {
  if (!key || key === 'none') return null;
  if (key === 'name') return 'name';
  if (key === 'size') return 'size';
  if (/^date/i.test(key)) return 'date'; // dateModified/Created/Added/LastOpened
  return null; // kind, label, comments, version → no clean mapping
}

// Decode a length-prefixed UTF-16BE name ending just before `end`.
function readNameBefore(buf, end) {
  for (let L = 1; L <= 255; L++) {
    const p = end - 2 * L - 4;
    if (p < 0) break;
    if (buf.readUInt32BE(p) === L) {
      return Buffer.from(buf.slice(p + 4, end)).swap16().toString('utf16le');
    }
  }
  return null;
}

const DATA_TYPES = new Set(['blob', 'type', 'long', 'shor', 'bool', 'ustr', 'comp', 'dutc']);

// Scan a .DS_Store buffer for a record (name, structId) and return its raw value.
// Returns { blob } or { code } depending on the record's data type.
function findRecord(buf, name, structId) {
  let i = buf.indexOf(structId);
  while (i !== -1) {
    const dtype = buf.toString('latin1', i + 4, i + 8);
    if (DATA_TYPES.has(dtype) && readNameBefore(buf, i) === name) {
      if (dtype === 'blob') {
        const len = buf.readUInt32BE(i + 8);
        if (len > 0 && len < buf.length) return { blob: buf.slice(i + 12, i + 12 + len) };
      } else if (dtype === 'type') {
        return { code: buf.toString('latin1', i + 8, i + 12) };
      }
    }
    i = buf.indexOf(structId, i + 1);
  }
  return null;
}

// Convert a binary-plist blob to a JS object via macOS plutil.
function plistToObject(blob) {
  const tmp = path.join(os.tmpdir(), `folderai-${blob.length}-${blob[8] || 0}.plist`);
  try {
    fs.writeFileSync(tmp, blob);
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', tmp], { encoding: 'utf8' });
    return JSON.parse(json);
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// The user's global default sort (applies to un-customized folders).
function globalDefault() {
  let view = 'Nlsv';
  try { view = execFileSync('defaults', ['read', 'com.apple.finder', 'FXPreferredViewStyle'], { encoding: 'utf8' }).trim(); } catch { /* default */ }
  let text = '';
  try { text = execFileSync('defaults', ['read', 'com.apple.finder', 'FK_StandardViewSettings'], { encoding: 'utf8' }); } catch { /* none */ }
  if (VIEW_CODES[view] === 'icon') {
    const m = text.match(/arrangeBy\s*=\s*"?(\w+)"?/);
    return mapKey(m && m[1]);
  }
  const m = text.match(/sortColumn\s*=\s*"?(\w+)"?/);
  return mapKey(m && m[1]);
}

function detectFinderSort(folder) {
  try {
    const parent = path.dirname(folder);
    const name = path.basename(folder);
    let perFolder = null;
    try {
      const buf = fs.readFileSync(path.join(parent, '.DS_Store'));
      // Determine the active view (per-folder override, else global preference).
      const vstl = findRecord(buf, name, 'vstl');
      let view = vstl && vstl.code;
      if (!view) { try { view = execFileSync('defaults', ['read', 'com.apple.finder', 'FXPreferredViewStyle'], { encoding: 'utf8' }).trim(); } catch { view = 'Nlsv'; } }

      if (VIEW_CODES[view] === 'icon' || VIEW_CODES[view] === 'gallery') {
        const rec = findRecord(buf, name, 'icvp');
        const obj = rec && rec.blob && plistToObject(rec.blob);
        perFolder = mapKey(obj && obj.arrangeBy); // 'none' → null → fall through
      } else {
        const rec = findRecord(buf, name, 'lsvp');
        const obj = rec && rec.blob && plistToObject(rec.blob);
        perFolder = mapKey(obj && obj.sortColumn);
      }
    } catch { /* no/unreadable parent .DS_Store */ }

    const detected = perFolder || globalDefault() || null;
    // Downloads' useful (and Finder's modern smart-default) order is newest-first.
    // The on-disk .DS_Store often still says "name" from a stale list view, so prefer
    // date there unless the user explicitly chose size or a date column themselves.
    if (path.basename(folder) === 'Downloads' && (detected === 'name' || detected === null)) return 'date';
    return detected;
  } catch {
    return null;
  }
}

module.exports = { detectFinderSort };
