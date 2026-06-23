'use strict';

const fs = require('fs');
const path = require('path');

// Folders this app creates — never scan or touch them as candidates.
const QUARANTINE_DIR = '_CleanupQuarantine';
const RESERVED = new Set([QUARANTINE_DIR]);

// Markers/extensions that signal a folder is a code project (so we don't let
// the model dump documents/essays into it).
const PROJECT_MARKERS = new Set(['.git', 'package.json', 'Cargo.toml', 'go.mod', 'pom.xml',
  'requirements.txt', 'pyproject.toml', 'Gemfile', 'Makefile', 'tsconfig.json', 'node_modules']);
const CODE_EXTS = new Set(['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs',
  'rb', 'php', 'swift', 'kt', 'cs', 'sh', 'html', 'css']);

// Shallow peek at a folder's immediate children so the model can understand
// how the user already organizes it (e.g. "Documents holds only subfolders").
function summarizeFolder(folderPath) {
  let files = 0, dirs = 0, codeFiles = 0;
  let isProject = false;
  const subfolders = [];
  const sampleFiles = [];
  try {
    for (const ent of fs.readdirSync(folderPath, { withFileTypes: true })) {
      if (PROJECT_MARKERS.has(ent.name)) isProject = true; // incl. dotfiles like .git
      if (ent.name.startsWith('.')) continue;
      if (ent.isDirectory()) {
        dirs += 1;
        if (subfolders.length < 25) subfolders.push(ent.name);
      } else {
        files += 1;
        const ext = ent.name.split('.').pop().toLowerCase();
        if (CODE_EXTS.has(ext)) codeFiles += 1;
        if (sampleFiles.length < 6) sampleFiles.push(ent.name);
      }
    }
  } catch {
    /* unreadable — leave counts at 0 */
  }
  // A project if it has a marker, or code files dominate its files.
  if (codeFiles >= 3 && codeFiles >= files * 0.4) isProject = true;
  let layout;
  if (dirs > 0 && files === 0) layout = 'subfolders-only';
  else if (dirs === 0 && files > 0) layout = 'files-only';
  else if (dirs > 0 && files > 0) layout = 'mixed';
  else layout = 'empty';
  return { files, dirs, subfolders, sampleFiles, layout, isProject };
}

// Reads the top level of `folder`. Returns:
//   items:   every top-level entry with light metadata (the things to organize)
//   folders: a summary of each existing top-level folder (candidate destinations)
// Non-recursive on purpose: we organize the top level and leave nested trees be.
function scanFolder(folder) {
  const entries = fs.readdirSync(folder, { withFileTypes: true });
  const items = [];
  const folders = [];
  for (const ent of entries) {
    const name = ent.name;
    if (RESERVED.has(name)) continue;
    const full = path.join(folder, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue; // broken symlink, permissions, etc.
    }
    const isDir = stat.isDirectory();
    items.push({
      id: name, // unique within a single top-level folder
      name,
      path: full,
      isDir,
      size: isDir ? 0 : stat.size,
      mtime: stat.mtimeMs,
    });
    if (isDir) folders.push({ name, ...summarizeFolder(full) });
  }
  // Folders first, then files, alphabetical — stable, predictable order.
  items.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  return { items, folders };
}

// A friendly, location-revealing label for an absolute path (e.g. "~/Documents/Taxes").
function labelFor(absPath, homedir) {
  if (homedir && absPath.startsWith(homedir + path.sep)) {
    return '~/' + path.relative(homedir, absPath).split(path.sep).join('/');
  }
  return absPath;
}

// Immediate subfolders of a directory: [{ name, path }]. Safe on permission errors.
function listSubfolders(dirPath) {
  const out = [];
  try {
    for (const ent of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || RESERVED.has(ent.name)) continue;
      if (ent.isDirectory()) out.push({ name: ent.name, path: path.join(dirPath, ent.name) });
    }
  } catch {
    /* unreadable (e.g. TCC denied) — return what we have */
  }
  return out;
}

// Gather candidate destination folders across the given root paths, one level
// deep (immediate subfolders). Deeper matching happens on demand at assignment
// time. Returns [{ label, name, root, path, layout, subfolders, ... }].
function gatherDestinations(rootPaths, homedir) {
  const dests = [];
  const seen = new Set();
  for (const root of rootPaths) {
    const rootLabel = labelFor(root, homedir);
    for (const sub of listSubfolders(root)) {
      if (seen.has(sub.path)) continue;
      seen.add(sub.path);
      dests.push({
        label: labelFor(sub.path, homedir),
        name: sub.name,
        root: rootLabel,
        path: sub.path,
        ...summarizeFolder(sub.path),
      });
    }
  }
  return dests;
}

module.exports = { scanFolder, gatherDestinations, listSubfolders, labelFor, QUARANTINE_DIR };
