'use strict';

// Access scope for Folderai: which folders the app may operate in (grantedRoots) and
// which it must NEVER touch (protectedPaths). Persisted to userData/scope.json.
//
// - grantedRoots: the folders the user has authorized. In the sandboxed (App Store)
//   build each carries a security-scoped bookmark so access survives relaunch; in the
//   direct build the bookmark is null and the path is used as-is.
// - protectedPaths: a "do-not-touch" denylist. Enforced deterministically before any
//   operation — protected files/folders are never moved, renamed, or quarantined, and
//   nothing is ever written into them.

const fs = require('fs');
const path = require('path');

let file = null;
let data = { grantedRoots: [], protectedPaths: [] };

function init(userDataDir) {
  file = path.join(userDataDir, 'scope.json');
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = { grantedRoots: Array.isArray(d.grantedRoots) ? d.grantedRoots : [], protectedPaths: Array.isArray(d.protectedPaths) ? d.protectedPaths : [] };
  } catch { data = { grantedRoots: [], protectedPaths: [] }; }
}
function save() { try { if (file) fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch { /* best-effort */ } }

const norm = (p) => path.resolve(String(p || ''));
const within = (target, root) => { const t = norm(target); const r = norm(root); return t === r || t.startsWith(r + path.sep); };

// ---- protected (do-not-touch) ----
function isProtected(target) { return data.protectedPaths.some((pp) => within(target, pp)); }
function protectedPaths() { return data.protectedPaths.slice(); }
function addProtected(p) { const r = norm(p); if (r && !data.protectedPaths.includes(r)) { data.protectedPaths.push(r); save(); } return protectedPaths(); }
function removeProtected(p) { const r = norm(p); data.protectedPaths = data.protectedPaths.filter((x) => x !== r); save(); return protectedPaths(); }

// ---- granted roots ----
function grantedRoots() { return data.grantedRoots.map((g) => ({ path: g.path, hasBookmark: !!g.bookmark })); }
function addGrant(p, bookmark) { const r = norm(p); data.grantedRoots = data.grantedRoots.filter((g) => g.path !== r); data.grantedRoots.push({ path: r, bookmark: bookmark || null }); save(); return grantedRoots(); }
function removeGrant(p) { const r = norm(p); data.grantedRoots = data.grantedRoots.filter((g) => g.path !== r); save(); return grantedRoots(); }
// The security-scoped bookmark for whichever granted root contains `target` (sandbox).
function bookmarkFor(target) { const g = data.grantedRoots.find((x) => within(target, x.path)); return g ? g.bookmark : null; }

module.exports = {
  init, save, within,
  isProtected, protectedPaths, addProtected, removeProtected,
  grantedRoots, addGrant, removeGrant, bookmarkFor,
};
