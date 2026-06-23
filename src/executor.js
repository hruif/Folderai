'use strict';

const fs = require('fs');
const path = require('path');
const { QUARANTINE_DIR } = require('./scanner');

// Move with cross-device fallback (rename fails across volumes).
function moveSafe(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code === 'EXDEV') {
      fs.cpSync(src, dest, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

// The filename to write at the destination — the proposed rename if present and
// different, otherwise the original name.
function targetName(a) {
  return (a.rename && a.rename !== a.name) ? a.rename : a.name;
}

// Pick a non-colliding destination path by appending " (n)" before the ext.
function uniqueDest(dir, name) {
  let dest = path.join(dir, name);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let n = 1;
  do {
    dest = path.join(dir, `${base} (${n})${ext}`);
    n += 1;
  } while (fs.existsSync(dest));
  return dest;
}

// Execute the included actions against `folder`.
// Returns { moved, deleted, kept, skipped, errors[], quarantineManifest }.
function execute(folder, actions) {
  const result = { moved: 0, deleted: 0, kept: 0, skipped: 0, errors: [], operations: [] };
  const quarantineDir = path.join(folder, QUARANTINE_DIR);
  const manifest = []; // for restore: { from, to, ts }

  for (const a of actions) {
    if (!a.include) { result.skipped += 1; continue; }

    try {
      if (a.action === 'keep') {
        // A kept file may still be renamed in place.
        if (a.rename && a.rename !== a.name && fs.existsSync(a.path)) {
          const dir = path.dirname(a.path);
          const dest = uniqueDest(dir, targetName(a));
          moveSafe(a.path, dest);
          result.operations.push({ from: a.path, to: dest });
          result.moved += 1;
        } else {
          result.kept += 1;
        }
        continue;
      }

      if (!fs.existsSync(a.path)) {
        result.errors.push(`Missing, skipped: ${a.name}`);
        continue;
      }

      if (a.action === 'delete') {
        if (!fs.existsSync(quarantineDir)) fs.mkdirSync(quarantineDir, { recursive: true });
        const dest = uniqueDest(quarantineDir, a.name);
        moveSafe(a.path, dest);
        manifest.push({ from: a.path, to: dest });
        result.operations.push({ from: a.path, to: dest });
        result.deleted += 1;
      } else if (a.action === 'group') {
        let categoryDir;
        if (a.destPath && path.isAbsolute(a.destPath)) {
          // Cross-location move into the user's real folder (Documents, Desktop, …).
          categoryDir = path.resolve(a.destPath);
        } else {
          // Relative new folder inside the scanned folder. Confirm it can't
          // escape the working folder via "..".
          categoryDir = path.resolve(folder, a.category || 'Other');
          const root = path.resolve(folder);
          if (categoryDir !== root && !categoryDir.startsWith(root + path.sep)) {
            result.errors.push(`${a.name}: unsafe destination "${a.category}", skipped`);
            continue;
          }
        }
        // Already in its destination dir — rename in place if requested, else keep.
        if (path.dirname(a.path) === categoryDir) {
          if (a.rename && a.rename !== a.name) {
            const dest = uniqueDest(categoryDir, targetName(a));
            moveSafe(a.path, dest);
            result.operations.push({ from: a.path, to: dest });
            result.moved += 1;
          } else { result.kept += 1; }
          continue;
        }
        if (!fs.existsSync(categoryDir)) fs.mkdirSync(categoryDir, { recursive: true });
        const dest = uniqueDest(categoryDir, targetName(a));
        moveSafe(a.path, dest);
        result.operations.push({ from: a.path, to: dest });
        result.moved += 1;
      }
    } catch (err) {
      result.errors.push(`${a.name}: ${err.message}`);
    }
  }

  // Write a restore manifest so quarantined files can be put back.
  if (manifest.length) {
    try {
      const manifestPath = path.join(quarantineDir, 'restore-manifest.json');
      let prev = [];
      if (fs.existsSync(manifestPath)) {
        try { prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { prev = []; }
      }
      fs.writeFileSync(manifestPath, JSON.stringify([...prev, ...manifest], null, 2));
    } catch (err) {
      result.errors.push(`Could not write restore manifest: ${err.message}`);
    }
  }

  return result;
}

// Reverse a set of {from, to} operations (move each `to` back to its `from`).
// Done in reverse order so nested moves unwind correctly.
function undo(operations) {
  const result = { restored: 0, errors: [] };
  for (const op of [...(operations || [])].reverse()) {
    try {
      if (!fs.existsSync(op.to)) { result.errors.push(`Missing: ${path.basename(op.to)}`); continue; }
      const destDir = path.dirname(op.from);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      // If the original name was taken in the meantime, restore beside it.
      const dest = fs.existsSync(op.from) ? uniqueDest(destDir, path.basename(op.from)) : op.from;
      moveSafe(op.to, dest);
      result.restored += 1;
    } catch (err) {
      result.errors.push(`${path.basename(op.to)}: ${err.message}`);
    }
  }
  return result;
}

module.exports = { execute, undo };
