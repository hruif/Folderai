'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile, execFileSync } = require('child_process');

// The App Store (sandboxed) build ships an `inprocess.flag` so the app uses the
// in-process llama.cpp backend instead of the external Ollama server. Detect it HERE,
// before ./src/inference is required (which reads FA_BACKEND at load time).
try { if (fs.existsSync(path.join(process.resourcesPath || '', 'inprocess.flag'))) process.env.FA_BACKEND = 'llama'; } catch { /* */ }

// ---- Crash safety net ----------------------------------------------------
// Electron's main process exits on an unhandled promise rejection or uncaught
// exception. Some dependencies (pdfjs under pdf-parse, the OCR helper) can emit
// errors in BACKGROUND async work that escape the awaits that call them — which
// would silently kill the whole app mid-run. Catch them: log to a file the user
// can share, and keep running instead of vanishing.
function errorLogPath() {
  try { return path.join(app.getPath('userData'), 'folderai-errors.log'); }
  catch { return path.join(os.tmpdir(), 'folderai-errors.log'); }
}
function logError(tag, info) {
  try { fs.appendFileSync(errorLogPath(), `[${new Date().toISOString()}] ${tag}: ${info}\n`); } catch { /* best-effort */ }
}
process.on('uncaughtException', (err) => logError('uncaughtException', (err && err.stack) || String(err)));
process.on('unhandledRejection', (reason) => logError('unhandledRejection', (reason && reason.stack) || String(reason)));

// A folder the app was launched ON (from a Finder Quick Action / CLI / open-file),
// so it opens straight to that folder instead of the default Downloads.
let launchFolder = null;
function noteFolderArg(p) {
  try {
    const resolved = path.resolve(p);
    if (resolved === path.resolve(__dirname)) return; // the "." project dir, not a target
    const st = fs.statSync(resolved);
    launchFolder = st.isDirectory() ? resolved : path.dirname(resolved);
  } catch { /* not a path */ }
}
for (const arg of process.argv.slice(1)) {
  if (arg === '.' || arg.startsWith('-')) continue;
  noteFolderArg(arg);
}
// macOS "open -a FolderAI <folder>" / drag-onto-icon delivers the path here.
app.on('open-file', (e, p) => {
  e.preventDefault();
  noteFolderArg(p);
  if (win && !win.isDestroyed()) { win.webContents.send('open-folder', launchFolder); win.focus(); }
});

// Single instance: if the Finder Quick Action launches us again with a folder
// while we're already open, forward that folder to the running window instead
// of spawning a second app.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    for (const arg of argv.slice(1)) {
      if (arg === '.' || arg.startsWith('-')) continue;
      noteFolderArg(arg);
    }
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (launchFolder) win.webContents.send('open-folder', launchFolder);
    } else {
      createWindow();
    }
  });
}

const { scanFolder, gatherDestinations, labelFor, listSubfolders } = require('./src/scanner');
const { planByRules, refineWithModel, applyPrompt, applyRuleRequest, consolidateFolders } = require('./src/planner');
const { execute, undo } = require('./src/executor');
const { findDuplicates } = require('./src/dedup');
const { loadCache, saveCache, pruneCache, clearCache, cacheKey } = require('./src/cache');
const { loadLearning, clearLearning, recordCorrections } = require('./src/learning');
const { loadSettings, saveSettings, DEFAULTS } = require('./src/settings');
const { detectFinderSort } = require('./src/finderSort');
const scope = require('./src/scope'); // granted folders + do-not-touch protected paths
const ollama = require('./src/inference'); // swappable: system Ollama (dev) or in-process llama.cpp (App Store)
const modelDelivery = require('./src/model');

// In-process build: ensure our own gguf exists (copy from a local Ollama blob, or
// download) and point the backend at it — before the first model load. No-op for the
// Ollama backend. Memoized so concurrent callers share one acquisition.
let modelReady = null;
function prepareModel(send) {
  if (process.env.FA_BACKEND !== 'llama') return Promise.resolve();
  if (process.env.FA_GGUF && fs.existsSync(process.env.FA_GGUF)) return Promise.resolve();
  if (!modelReady) {
    modelReady = modelDelivery.ensureModel(app.getPath('userData'), ({ phase, pct }) => send && send(`${phase}… ${pct}%`))
      .then((mp) => { process.env.FA_GGUF = mp; })
      .catch((e) => { modelReady = null; throw e; });
  }
  return modelReady;
}

// Persisted settings, loaded once userData is available.
let settings = { ...DEFAULTS };
let settingsFile = null;
function getSettings() {
  if (!settingsFile) {
    settingsFile = path.join(app.getPath('userData'), 'settings.json');
    settings = loadSettings(settingsFile);
  }
  return settings;
}

// Access scope (granted folders + protected paths), loaded lazily once userData exists.
let scopeInited = false;
function ensureScope() {
  if (!scopeInited) { scope.init(app.getPath('userData')); scopeInited = true; }
  return scope;
}

// Sandbox: hold the security-scoped bookmark covering `target` while fn runs, so the
// sandboxed build can actually read/write the granted folder. In the direct build
// there are no bookmarks, so this is a pure pass-through (no behavior change).
async function withAccess(target, fn) {
  ensureScope();
  let stop = null;
  const bm = scope.bookmarkFor(target);
  if (bm && typeof app.startAccessingSecurityScopedResource === 'function') {
    try { stop = app.startAccessingSecurityScopedResource(bm); } catch { /* */ }
  }
  try { return await fn(); } finally { if (typeof stop === 'function') { try { stop(); } catch { /* */ } } }
}

// AI classification cache, loaded lazily once userData path is available.
let cache = null;
function getCache() {
  if (!cache) {
    cache = loadCache(path.join(app.getPath('userData'), 'classification-cache.json'));
    const removed = pruneCache(cache); // drop entries for files that no longer exist
    if (removed) saveCache(cache);
  }
  return cache;
}

// Learned corrections (the user's overrides), loaded lazily.
let learning = null;
function getLearning() {
  if (!learning) learning = loadLearning(path.join(app.getPath('userData'), 'learning.json'));
  return learning;
}

// Default destination roots, plus any extra directories the user adds.
function destinationRoots(extraRoots = []) {
  const home = os.homedir();
  const defaults = ['Downloads', 'Documents', 'Desktop'].map((d) => path.join(home, d));
  return [...new Set([...defaults, ...extraRoots])];
}

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    title: 'FolderAI — Downloads Cleaner',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  getSettings(); // load early so it's available at quit time
  createWindow();
  // Bring the local model server up on launch so the user never has to.
  ollama.ensureServer({ parallelism: getSettings().aiConcurrency }).catch(() => {});
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Closing the window quits the app entirely (incl. macOS) — the user prefers no
// lingering background process, so "x-ing out" fully quits.
app.on('window-all-closed', () => {
  app.quit();
});

// Shut down the server only if we started it AND the setting allows it.
app.on('will-quit', () => {
  if (getSettings().stopOllamaOnQuit !== false) ollama.stopServer();
});

// Log (don't silently swallow) a renderer or helper-process death so a real crash
// leaves a trace instead of just disappearing.
// Full memory snapshot at a helper death — distinguishes OS memory-kill (low
// reclaimable / high pressure level) from a plain GPU/helper crash (memory fine).
function memNote() {
  const { level, availGB } = assessMemory();
  return `freeMem=${Math.round(os.freemem() / 1048576)}MB reclaimable=${availGB.toFixed(1)}GB pressureLevel=${level} mainRSS=${Math.round(process.memoryUsage().rss / 1048576)}MB`;
}
app.on('render-process-gone', (_e, _wc, d) => logError('render-process-gone', `${d.reason} exitCode=${d.exitCode} · ${memNote()}`));
app.on('child-process-gone', (_e, d) => logError('child-process-gone', `${d.type}/${d.name || ''} ${d.reason} · ${memNote()}`));

function sendProgress(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('progress', msg);
}

// ---- IPC ----

ipcMain.handle('default-folder', () => ({
  folder: launchFolder || path.join(os.homedir(), 'Downloads'),
  autoScan: !!launchFolder, // launched on a specific folder → scan it right away
}));

// Open a file/folder in its default app, or reveal it in Finder.
ipcMain.handle('open-path', async (_e, p) => {
  const err = await shell.openPath(p);
  return { ok: !err, error: err };
});
ipcMain.handle('reveal-path', (_e, p) => { shell.showItemInFolder(p); });

// Which of these destination paths already exist (vs. would be newly created)?
ipcMain.handle('paths-exist', (_e, paths) => {
  const out = {};
  for (const p of paths || []) {
    try { out[p] = fs.existsSync(p); } catch { out[p] = false; }
  }
  return out;
});

// Same, but for "~/…" labels (resolve ~ to the home dir). Used by the tree view
// to flag folders that don't exist yet.
ipcMain.handle('labels-exist', (_e, labels) => {
  const home = os.homedir();
  const out = {};
  for (const label of labels || []) {
    try {
      const abs = label.startsWith('~/') ? path.join(home, label.slice(2)) : label;
      out[label] = fs.existsSync(abs);
    } catch { out[label] = false; }
  }
  return out;
});

// "Get Info" isn't a public API — but Finder can open its own info window via
// AppleScript. (First use may prompt to allow controlling Finder.)
function finderGetInfo(p) {
  const script = `tell application "Finder"\nactivate\nopen information window of (POSIX file ${JSON.stringify(p)} as alias)\nend tell`;
  execFile('osascript', ['-e', script], () => { /* ignore errors / denied permission */ });
}

// Native right-click menu for a file row.
ipcMain.handle('show-file-menu', (e, p) => {
  const menu = Menu.buildFromTemplate([
    { label: 'Open', click: () => shell.openPath(p) },
    { label: 'Reveal in Finder', click: () => shell.showItemInFolder(p) },
    { type: 'separator' },
    { label: 'Get Info', click: () => finderGetInfo(p) },
  ]);
  menu.popup({ window: BrowserWindow.fromWebContents(e.sender) });
});

// Folder-picker support: the destination root locations, and lazy subfolder listing.
ipcMain.handle('dest-roots', (_e, extraRoots) =>
  destinationRoots(extraRoots || []).map((p) => ({ label: labelFor(p, os.homedir()), path: p })));
ipcMain.handle('list-subfolders', (_e, dirPath) => listSubfolders(dirPath)); // [{ name, path }]

ipcMain.handle('get-settings', () => getSettings());
ipcMain.handle('set-setting', async (_e, { key, value }) => {
  const s = getSettings();
  s[key] = value;
  saveSettings(settingsFile, s);
  // Parallelism is fixed when the server starts — restart it (if we own it) so
  // a change takes effect immediately rather than next launch.
  if (key === 'aiConcurrency') {
    ollama.stopServer();
    await ollama.ensureServer({ parallelism: value });
  }
  return s;
});

ipcMain.handle('ollama-status', async () => {
  // Try to (re)start the server before reporting — covers the case where the
  // user quit Ollama after launch.
  const res = await ollama.ensureServer({ parallelism: getSettings().aiConcurrency });
  return {
    available: res.ok,
    installed: res.installed,
    inProcess: process.env.FA_BACKEND === 'llama', // built-in model, no external Ollama
    models: res.ok ? await ollama.listModels() : [],
  };
});

ipcMain.handle('select-folder', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    defaultPath: path.join(os.homedir(), 'Downloads'),
    securityScopedBookmarks: true, // sandbox: remember access; no-op in the direct build
  });
  if (res.canceled || !res.filePaths.length) return null;
  ensureScope();
  scope.addGrant(res.filePaths[0], (res.bookmarks && res.bookmarks[0]) || null);
  return res.filePaths[0];
});

// ---- Access scope: granted folders + do-not-touch protected paths ----
ipcMain.handle('get-scope', () => { ensureScope(); return { granted: scope.grantedRoots(), protected: scope.protectedPaths() }; });
ipcMain.handle('grant-folder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'], securityScopedBookmarks: true, title: 'Grant FolderAI access to a folder' });
  if (res.canceled || !res.filePaths.length) return ensureScope().grantedRoots();
  ensureScope().addGrant(res.filePaths[0], (res.bookmarks && res.bookmarks[0]) || null);
  return scope.grantedRoots();
});
ipcMain.handle('remove-grant', (_e, p) => ensureScope().removeGrant(p));
ipcMain.handle('add-protected', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose a folder FolderAI must NEVER touch' });
  if (res.canceled || !res.filePaths.length) return ensureScope().protectedPaths();
  return ensureScope().addProtected(res.filePaths[0]);
});
ipcMain.handle('remove-protected', (_e, p) => ensureScope().removeProtected(p));

// Open the bundled third-party licenses (Llama 3.2 Community License + AUP + NOTICE).
ipcMain.handle('open-licenses', () => { try { return shell.openPath(path.join(__dirname, 'licenses', 'llama')); } catch { return null; } });

// Cache of the last scan's destination folders (across locations), so the AI
// passes can route files into the user's real structure.
let lastScan = { folder: null, destinations: [] };

// Scan is always instant: rule-based plan only. AI refinement is a separate,
// cancellable step so the user sees results immediately on large folders.
ipcMain.handle('scan', async (_e, { folder, extraRoots }) => withAccess(folder, async () => {
  const { items } = scanFolder(folder);
  const roots = destinationRoots(extraRoots || []);
  const destinations = gatherDestinations(roots, os.homedir());
  lastScan = { folder, destinations };

  const actions = planByRules(items);
  // Deterministic de-duplication: flag exact-content copies for quarantine.
  const dupOf = findDuplicates(items);
  let dupes = 0;
  for (const a of actions) {
    const primary = dupOf.get(String(a.id));
    if (primary) { a.action = 'delete'; a.category = 'Junk'; a.reason = `Duplicate of "${primary.name}"`; dupes += 1; }
  }
  // Do-not-touch: anything under a protected path is locked to "keep" and never proposed.
  ensureScope();
  for (const a of actions) {
    if (scope.isProtected(a.path)) { a.action = 'keep'; a.category = 'Other'; a.destPath = null; a.rename = null; a.protected = true; a.reason = 'Protected — never touched'; }
  }

  return {
    folder,
    folderLabel: labelFor(folder, os.homedir()), // e.g. "~/Downloads" for the tree root
    home: os.homedir(),                          // to resolve "~/…" drop targets in the tree
    count: items.length,
    dupes,
    actions,
    destinations,
    finderSort: detectFinderSort(folder), // how this folder is sorted in Finder
  };
}));

let aiCancelled = false;
let aiAbort = null;
ipcMain.handle('cancel-ai', () => {
  aiCancelled = true;
  if (aiAbort) aiAbort.abort(); // abort any in-flight model request immediately
});

// Read how much memory headroom we actually have. On macOS, raw "free" is
// misleading (inactive memory is reclaimable), so use the kernel's jetsam
// pressure level plus reclaimable pages — the same signal that decides whether
// the OS will kill us. Returns { level: 1|2|4, availGB }.
function assessMemory() {
  let level = 1;
  let availGB = os.freemem() / 1e9;
  if (process.platform === 'darwin') {
    try { level = parseInt(String(execFileSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])).trim(), 10) || 1; } catch { /* keep default */ }
    try {
      const vm = String(execFileSync('vm_stat'));
      const pg = 16384;
      const pages = (re) => { const m = vm.match(re); return m ? parseInt(m[1], 10) : 0; };
      const reclaimable = pages(/Pages free:\s+(\d+)/) + pages(/Pages inactive:\s+(\d+)/) + pages(/Pages purgeable:\s+(\d+)/);
      availGB = (reclaimable * pg) / 1e9;
    } catch { /* fall back to os.freemem */ }
  }
  return { level, availGB };
}

// True if any file still needs the model (not already cached for this guidance).
function modelNeeded(actions, cache, guidance, ignoreCache) {
  if (ignoreCache || !cache) return true;
  for (const a of actions) {
    if (a.isDir || a.action === 'delete') continue; // folders / junk don't use the model
    if (!cache.get(cacheKey(a, guidance))) return true;
  }
  return false;
}

ipcMain.handle('classify-ai', async (_e, { actions, model, guidance, ignoreCache, rename }) => {
  const concurrency = getSettings().aiConcurrency; // respect the user's Speed setting
  aiCancelled = false;
  aiAbort = new AbortController();
  const c = getCache();
  // If everything's already classified (all cache hits) and there's no new guidance,
  // there's nothing for the model to do — skip loading it entirely (instant re-run).
  const needModel = modelNeeded(actions, c, guidance || '', !!ignoreCache);
  if (needModel) {
    // In-process build: fetch/locate our own gguf before loading it (first run only).
    try { await prepareModel((m) => sendProgress(m)); }
    catch (e) { return { actions, cancelled: false, hits: 0, classified: 0, error: `Couldn't prepare the local model: ${e.message}` }; }
    await ollama.ensureServer({ parallelism: concurrency });
    // Wait until the model can actually serve /api/chat (a cold server 404s during
    // init). Otherwise the first concurrent batches error and the run silently keeps
    // everything. If it never comes up, report it instead of a no-op success.
    sendProgress('Loading the local model…');
    const ready = await ollama.warmupModel(model, { signal: aiAbort.signal });
    if (!ready && !aiCancelled) {
      return { actions, cancelled: false, hits: 0, classified: 0, error: `Couldn't start the local model "${model}". Make sure it's installed (ollama pull ${model}) and try again.` };
    }
  }
  const { actions: refined, hits, classified } = await refineWithModel(
    actions,
    lastScan.destinations,
    model,
    ({ done, total, actions: cur, hits }) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('ai-progress', {
          done, total, hits,
          percent: total ? Math.round((done / total) * 100) : 100,
          actions: cur,
        });
      }
    },
    () => aiCancelled,
    guidance || '',
    c,
    !!ignoreCache,
    aiAbort.signal,
    concurrency,
    !!rename,
    getSettings().useLearning !== false ? getLearning() : null,
  );
  saveCache(c); // persist newly classified results

  // Second pass: nest related NEW folders under shared parents (deeper, tidier tree).
  // Skip on a fully-cached re-run (needModel false) — the cache already holds the final,
  // consolidated placement from last time, so there's nothing new to organize.
  if (getSettings().condenseFolders !== false && needModel && !aiCancelled) {
    try {
      const { changed } = await consolidateFolders(refined, model, aiAbort.signal, (msg) => sendProgress(msg));
      if (changed && win && !win.isDestroyed()) {
        win.webContents.send('ai-progress', { done: classified, total: classified, hits, percent: 100, actions: refined });
      }
    } catch { /* non-fatal */ }
    // Re-cache the FINAL (post-consolidation) placement so a future re-run is fully
    // cached and never has to load the model again.
    for (const a of refined) {
      if (a.isDir || a.action === 'delete') continue;
      const val = a.action === 'keep'
        ? { keep: true, reason: a.reason, tags: a.tags, excerpt: a.excerpt, rename: a.rename }
        : { category: a.category, destPath: a.destPath, reason: a.reason, tags: a.tags, excerpt: a.excerpt, rename: a.rename };
      c.set(cacheKey(a, guidance || ''), { ...val, _path: a.path });
    }
    saveCache(c);
  }
  // The guidance box is also applied as a request at the end via the full pipeline:
  // deterministic rules are instant; a fuzzy instruction runs the per-item match,
  // shown as its own progress phase so the extra time isn't a surprise.
  if (guidance && guidance.trim() && !aiCancelled) {
    try {
      await applyPrompt(refined, guidance, model, lastScan.destinations, aiAbort.signal,
        ({ done, total }) => { if (total > 1) sendProgress(`Applying your guidance… (${done}/${total})`); });
    } catch { /* non-fatal */ }
  }
  // Re-assert do-not-touch: the model/guidance must never re-route a protected item.
  ensureScope();
  for (const a of refined) {
    if (a.protected || scope.isProtected(a.path)) { a.action = 'keep'; a.category = 'Other'; a.destPath = null; a.rename = null; a.protected = true; a.reason = 'Protected — never touched'; }
  }
  return { actions: refined, cancelled: aiCancelled, hits, classified };
});

// Persist the staged plan (incl. the user's manual edits) so it survives a restart.
const planFile = () => path.join(app.getPath('userData'), 'staged-plan.json');
ipcMain.handle('save-plan', (_e, plan) => { try { fs.writeFileSync(planFile(), JSON.stringify(plan)); } catch { /* best-effort */ } });
ipcMain.handle('load-plan', () => { try { return JSON.parse(fs.readFileSync(planFile(), 'utf8')); } catch { return null; } });
ipcMain.handle('clear-plan', () => { try { fs.unlinkSync(planFile()); } catch { /* none */ } });

ipcMain.handle('clear-cache', () => {
  const c = getCache();
  const count = Object.keys(c.data).length;
  clearCache(c);
  saveCache(c);
  return { cleared: count };
});

ipcMain.handle('apply-prompt', async (_e, { actions, prompt, model }) => {
  // NOTE: deterministic handling of clear bulk patterns ("all 3-digit codes into
  // CSE", "delete all screenshots") was built and intentionally REMOVED for now —
  // we want to gauge the model's real limits on these requests first. Full impl +
  // re-add steps are in the memory note "deterministic-request-rules". Every
  // plain-language request currently goes to the model.
  aiCancelled = false;
  aiAbort = new AbortController(); // so the Stop button can cancel a long multi-batch pass
  await ollama.ensureServer({ parallelism: getSettings().aiConcurrency });
  // (No status text here — the renderer's progress bar shows "loading"/"applying"
  //  so the footer doesn't get stuck on a stale "Loading the local model…".)
  const ready = await ollama.warmupModel(model, { signal: aiAbort.signal });
  if (!ready) return { actions, changed: 0, error: `Couldn't start the local model "${model}".` };
  return applyPrompt(actions, prompt, model, lastScan.destinations, aiAbort.signal,
    ({ done, total }) => { if (win && !win.isDestroyed()) win.webContents.send('apply-progress', { done, total }); });
});

let lastOperations = []; // moves from the most recent execute, for one-step undo
ipcMain.handle('execute', async (_e, { folder, actions }) => withAccess(folder, async () => {
  // Learn from any overrides the user made before executing.
  if (getSettings().useLearning !== false) {
    try { recordCorrections(getLearning(), actions); } catch { /* non-fatal */ }
  }
  ensureScope();
  const result = execute(folder, actions, { isProtected: (p) => scope.isProtected(p) });
  lastOperations = result.operations || [];
  return result;
}));

ipcMain.handle('clear-learning', () => {
  const l = getLearning();
  const count = Object.keys(l.data).length;
  clearLearning(l);
  return { cleared: count };
});

ipcMain.handle('undo', () => {
  const r = undo(lastOperations);
  lastOperations = []; // single-level undo
  return r;
});
