'use strict';

// ---- State ----
let state = {
  folder: null,
  actions: [],       // array of action objects (the staged plan)
  destinations: [],  // candidate destination folders across locations
  extraRoots: [],    // user-added destination root directories
  sort: 'name',      // default to Finder's default order (name A–Z)
  view: 'preview',   // 'preview' (grouped destination tree, default) | 'list' (flat table)
  folderLabel: '~',  // scanned folder's display label (tree root)
  collapsed: new Set(), // tree folder labels the user has collapsed
  existsCache: {},   // label -> bool, so we don't re-check folder existence every render
  query: '',         // search text (filters name + content + tags + metadata)
  home: '',          // home dir, to resolve "~/…" tree paths to absolute destPaths
  userFolders: [],   // labels of folders the user created in the tree (may be empty)
  selected: new Set(), // multi-selection in the tree: tokens "file:<id>" / "folder:<label>"
  selAnchor: null,     // last item clicked without shift — the range anchor
  clipboard: [],       // cut tokens, awaiting a paste (deferred move — nothing happens until paste)
};

// Build a lowercased searchable blob for an item: name, type, subject, category,
// reason, content excerpt, extension, size, and date (so date/keyword search works).
function searchText(a) {
  const parts = [a.name, a.category, a.reason, a.action, a.ext, a.excerpt];
  if (a.tags) parts.push(a.tags.type, a.tags.subject);
  if (a.size) parts.push(fmtSize(a.size));
  if (a.mtime) {
    const d = new Date(a.mtime);
    parts.push(d.toISOString().slice(0, 10), d.toLocaleString('en-US', { month: 'long' }), String(d.getFullYear()));
  }
  return parts.filter(Boolean).join('  ').toLowerCase();
}
function matchesQuery(a) {
  const tokens = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const hay = searchText(a);
  return tokens.every((t) => hay.includes(t)); // all words must match (AND)
}

const ACTIONS = ['group', 'delete', 'keep'];

// True while an AI classification pass is in flight — disables Execute and
// guards against late progress events re-showing the bar.
let aiRunning = false;
let applyRunning = false; // a plain-language request pass is in flight (shows the progress bar)

// True after a scan with AI on, while the gate is up — we hold the file list
// back (the rule-based plan would just be overwritten by AI). When AI runs, all
// files are cleared from view and stream back in as they're classified.
let awaitingDecision = false;

function destByLabel(label) {
  return state.destinations.find((d) => d.label === label);
}

// A clickable chip showing a file's current destination; opens the folder picker.
function destChip(a) {
  return `<button class="dest-chip" data-pick="${escapeHtml(a.id)}" title="Choose destination folder">` +
    `${escapeHtml(a.category)}/ ▾</button>`;
}
// The single destination control for any row — shows the outcome, opens the picker.
function destControl(a) {
  if (a.action === 'delete') return `<button class="dest-chip dest-del" data-pick="${escapeHtml(a.id)}" title="Choose destination">→ Remove ▾</button>`;
  if (a.action === 'keep') return `<button class="dest-chip dest-keep" data-pick="${escapeHtml(a.id)}" title="Choose destination">Leave here ▾</button>`;
  return destChip(a);
}

// Display order for the "proposed plan" view.
const ACTION_RANK = { group: 0, delete: 1, keep: 2 };

function sortedActions() {
  const a = state.actions.filter(matchesQuery);
  if (state.sort === 'name') {
    a.sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));
  } else if (state.sort === 'date') {
    a.sort((x, y) => y.mtime - x.mtime);
  } else if (state.sort === 'size') {
    a.sort((x, y) => y.size - x.size);
  } else { // proposed: group by action, then destination, then name
    a.sort((x, y) =>
      (ACTION_RANK[x.action] - ACTION_RANK[y.action]) ||
      (x.category || '').localeCompare(y.category || '') ||
      x.name.localeCompare(y.name, undefined, { numeric: true }));
  }
  return a;
}

// ---- Elements ----
const $ = (id) => document.getElementById(id);
const folderInput = $('folder');
const modelSelect = $('model');
let aiAvailable = false; // set from Ollama status — replaces the old "Use AI" toggle
const planBody = $('plan-body');
const tableWrap = document.querySelector('.table-wrap');
const planTable = $('plan');
const previewEl = $('preview');
const summary = $('summary');
// The per-type breakdown in the summary is collapsed by default; this tracks its state.
// Delegated so it survives the summary being re-rendered.
let summaryOpen = false;
summary.addEventListener('click', (e) => {
  const t = e.target.closest('#sum-toggle');
  if (!t) return;
  summaryOpen = !summaryOpen;
  const detail = summary.querySelector('.summary-detail');
  if (detail) detail.classList.toggle('hidden', !summaryOpen);
  t.textContent = summaryOpen ? 'Hide ▴' : 'Details ▾';
});
const statusEl = $('status');
const executeBtn = $('execute');
const badge = $('ollama-badge');

// ---- Helpers ----
function fmtSize(bytes) {
  if (!bytes) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function setStatus(msg) { statusEl.textContent = msg; }

// ---- Init ----
async function init() {
  const df = await window.api.defaultFolder();
  state.folder = df.folder;
  folderInput.value = df.folder;

  // If launched on a specific folder (Finder Quick Action / CLI), switch to it
  // and scan immediately.
  window.api.onOpenFolder((p) => {
    state.folder = p;
    folderInput.value = p;
    scanBtn.click();
  });

  // Reflect persisted settings.
  const settings = await window.api.getSettings();
  learnedSecPerUnit = settings.secondsPerUnit || 0; // calibrated rate from last run
  $('stop-ollama').checked = settings.stopOllamaOnQuit !== false;
  $('stop-ollama').addEventListener('change', (e) => {
    window.api.setSetting('stopOllamaOnQuit', e.target.checked);
    setStatus(e.target.checked
      ? 'Will stop Ollama on exit (only if this app started it).'
      : 'Will leave Ollama running on exit.');
  });

  $('use-learning').checked = settings.useLearning !== false;
  $('use-learning').addEventListener('change', (e) => {
    window.api.setSetting('useLearning', e.target.checked);
    setStatus(e.target.checked
      ? 'Will learn from your folder changes and apply them to similar files.'
      : 'Will not learn from your changes.');
  });

  $('density').checked = settings.density === 'compact';
  document.body.classList.toggle('compact', settings.density === 'compact');
  $('density').addEventListener('change', (e) => {
    document.body.classList.toggle('compact', e.target.checked);
    window.api.setSetting('density', e.target.checked ? 'compact' : 'comfortable');
  });

  $('condense-folders').checked = settings.condenseFolders !== false;
  $('condense-folders').addEventListener('change', (e) => {
    window.api.setSetting('condenseFolders', e.target.checked);
    setStatus(e.target.checked
      ? 'Will condense related folders under shared parents after classifying.'
      : 'Will leave each folder as proposed (no condensing).');
  });

  $('ai-speed').value = String(settings.aiConcurrency || 2);
  $('ai-speed').addEventListener('change', (e) => {
    const n = Number(e.target.value);
    window.api.setSetting('aiConcurrency', n);
    setStatus(n === 1
      ? 'Speed: Light — one batch at a time (lightest on CPU/memory).'
      : `Speed: ${n === 4 ? 'Fast' : 'Balanced'} — up to ${n} batches in parallel.`);
  });

  await refreshOllama();

  window.api.onProgress((msg) => setStatus(msg));

  // Live updates from the background AI classification pass. Guarded by
  // aiRunning so a late event can't re-show the bar after the run finished.
  window.api.onAiProgress(({ done, total, percent, actions, hits }) => {
    if (!aiRunning) return;
    state.actions = actions;
    render();
    const modelDone = done - (hits || 0);
    if (done >= total) {
      // All files classified — the post-passes (organize/condense folders) run now.
      // Use an animated bar + status so it doesn't look frozen at "N/N".
      showProgress(100, 'Finishing — organizing folders…', true);
      setStatus('Finishing — organizing related folders…');
      return;
    }
    if (modelDone < 1) {
      // Model is still loading (only cache hits so far) — say so, don't look stuck.
      showProgress(0, hits ? `Loading model… (${hits} reused from cache)` : 'Loading model…', true);
      return;
    }
    setStatus(''); // classifying now — clear any stale "Loading the local model…" line
    const eta = computeEta(done, total, hits);
    // ${hits} files were reused from cache and counted done up front — name that so the
    // starting "${hits}/${total}" isn't mysterious.
    const cacheNote = hits ? ` · ${hits} reused from cache` : '';
    showProgress(percent, `AI classifying… ${done}/${total}${cacheNote} · ${eta ? `~${eta} left` : 'estimating…'}`);
  });

  // Determinate progress bar for a plain-language request (it does several model calls).
  window.api.onApplyProgress(({ done, total }) => {
    if (!applyRunning) return;
    const pct = total ? Math.round((done / total) * 100) : 0;
    showProgress(pct, total > 1 ? `Applying your request… (${done}/${total})` : 'Applying your request…');
  });

  // Launched on a folder → scan it without waiting for a click.
  if (df.autoScan) { scanBtn.click(); return; }
  // Otherwise, restore the previous staged plan (with the user's edits) if any.
  await restorePlan();
}

// Reload the last staged plan from disk and re-show it, dropping any files that no
// longer exist (e.g. moved/deleted since). The user can re-scan to refresh.
async function restorePlan() {
  let saved = null;
  try { saved = await window.api.loadPlan(); } catch { /* none */ }
  if (!saved || !Array.isArray(saved.actions) || !saved.actions.length) return;
  const files = saved.actions.filter((a) => !a.isDir).map((a) => a.path);
  let exist = {};
  try { exist = await window.api.pathsExist(files); } catch { /* assume present */ }
  const actions = saved.actions.filter((a) => a.isDir || exist[a.path] !== false);
  if (!actions.length) { window.api.clearPlan(); return; }
  state.actions = actions;
  state.folder = saved.folder || state.folder;
  state.folderLabel = saved.folderLabel || '~';
  state.home = saved.home || '';
  state.destinations = saved.destinations || [];
  state.userFolders = saved.userFolders || [];
  state.sort = saved.sort || 'name';
  state.view = saved.view || 'preview';
  if (state.folder) folderInput.value = state.folder;
  $('sort').value = state.sort;
  awaitingDecision = false;
  setView(state.view); // renders
  const dropped = saved.actions.length - actions.length;
  setStatus(`Restored your previous plan — ${actions.filter((a) => !a.isDir).length} files${dropped ? `, ${dropped} skipped (no longer present)` : ''}. Re-scan to refresh.`);
}

// Query/auto-start the local model server and reflect it in the badge.
async function refreshOllama() {
  badge.textContent = 'starting local model…';
  badge.className = 'badge badge-unknown';
  const status = await window.api.ollamaStatus();
  if (status.available) {
    badge.classList.add('hidden'); // model's fine — no need to clutter the header with a status
    modelSelect.innerHTML = status.models
      .map((m) => `<option value="${m}">${m}</option>`).join('');
    const preferred = status.models.find((m) => /llama3\.2:3b/.test(m))
      || status.models.find((m) => /3b|1b/.test(m)) || status.models[0];
    if (preferred) modelSelect.value = preferred;
    aiAvailable = true;
    modelSelect.disabled = false;
  } else {
    badge.classList.remove('hidden'); // surface a real problem
    badge.textContent = status.installed
      ? 'Ollama not responding — using rules only'
      : 'Ollama not installed — using rules only';
    badge.className = 'badge badge-off';
    badge.title = 'Click to retry';
    aiAvailable = false;
    modelSelect.disabled = true;
  }
}

// Let the user retry by clicking the badge (e.g. after installing/launching).
document.getElementById('ollama-badge').addEventListener('click', refreshOllama);

// ---- Progress bar ----
const progressWrap = $('progress-wrap');
const progressFill = $('progress-fill');
const progressLabel = $('progress-label');

function showProgress(percent, label, indeterminate = false) {
  progressWrap.classList.remove('hidden');
  progressFill.classList.toggle('indeterminate', indeterminate);
  progressFill.style.width = indeterminate ? '' : `${percent}%`; // CSS animates a sliding block when indeterminate
  progressLabel.textContent = label;
}
function hideProgress() {
  progressWrap.classList.add('hidden');
  progressFill.classList.remove('indeterminate');
  progressFill.style.width = '0%';
}

// ---- Rendering ----
function renderSummary() {
  const a = state.actions;
  const counts = { group: 0, delete: 0, keep: 0 };
  let staged = 0;
  let folders = 0;
  let dupes = 0;
  for (const x of a) {
    counts[x.action] = (counts[x.action] || 0) + 1;
    if (x.include) staged++;
    if (x.isDir) folders++;
    if (/^Duplicate of /.test(x.reason || '')) dupes++;
  }
  const files = a.length - folders;
  summary.classList.remove('hidden');
  // Minimal by default: just the scale, with the per-type breakdown tucked behind "Details".
  const fileWord = `${files} file${files !== 1 ? 's' : ''}${folders ? ` · ${folders} folder${folders !== 1 ? 's' : ''}` : ''}`;
  const bits = [];
  if (counts.group) bits.push(`<b>${counts.group}</b> to organize`);
  if (counts.delete) bits.push(`<b style="color:var(--red)">${counts.delete}</b> to remove`);
  if (dupes) bits.push(`<b>${dupes}</b> duplicate${dupes > 1 ? 's' : ''}`);
  if (counts.keep) bits.push(`<b>${counts.keep}</b> left alone`);
  summary.innerHTML =
    `<span class="summary-line">${fileWord}${aiRunning ? ' · <span style="color:var(--amber)">reviewing…</span>' : ''}</span>`
    + (bits.length
      ? `<button id="sum-toggle" class="summary-toggle">${summaryOpen ? 'Hide ▴' : 'Details ▾'}</button>`
        + `<div class="summary-detail${summaryOpen ? '' : ' hidden'}">${bits.join(' · ')}</div>`
      : '');
  // Never allow executing while the AI is mid-run (the plan is still changing).
  executeBtn.disabled = aiRunning || awaitingDecision || staged === 0;
  executeBtn.textContent = staged ? `Clean up · ${staged} change${staged !== 1 ? 's' : ''}` : 'Clean up';
}

// Dispatch to the active view and toggle which container is visible.
async function render() {
  // Preserve scroll: rebuilding the list/tree (innerHTML reset) otherwise collapses
  // the scroll height and the view jumps — annoying when editing deep in a long list.
  const st = tableWrap.scrollTop;
  const preview = state.view === 'preview';
  planTable.classList.toggle('hidden', preview);
  previewEl.classList.toggle('hidden', !preview);
  $('sort-wrap').classList.toggle('hidden', preview); // sort applies to the list only
  if (preview) await renderPreview(); else renderList();
  if (st && tableWrap.scrollTop !== st) tableWrap.scrollTop = st; // keep the view put on in-place edits
  applyAdvanced(); // show the Advanced toggle once there's a plan; honor open/closed state
  persistPlan(); // keep the on-disk plan in sync with any edits
}

// Simple by default: the request box + view/search controls live under "Advanced",
// revealed only when the user asks. The toggle itself appears once there's a plan.
let advancedOpen = false;
function applyAdvanced() {
  const hasPlan = !!state.actions.length;
  $('adv-toggle').classList.toggle('hidden', !hasPlan);
  const show = hasPlan && advancedOpen;
  $('prompt-row').classList.toggle('hidden', !show);
  document.querySelector('.toolbar').classList.toggle('hidden', !show);
  $('adv-toggle').textContent = advancedOpen ? '▾ Advanced' : '▸ Advanced';
}
$('adv-toggle').addEventListener('click', () => { advancedOpen = !advancedOpen; applyAdvanced(); });

// Save the staged plan (with the user's manual edits) so it survives a restart.
// Debounced. Skips mid-run / pre-decision states — the final render persists the
// complete plan; after execute, rescan() re-persists the refreshed folder state.
let persistTimer = null;
function persistPlan() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    if (aiRunning || awaitingDecision || !state.actions.length) return;
    window.api.savePlan({
      folder: state.folder, folderLabel: state.folderLabel, home: state.home,
      destinations: state.destinations, userFolders: state.userFolders,
      sort: state.sort, view: state.view, actions: state.actions,
    });
  }, 400);
}

function renderList() {
  if (!state.actions.length) {
    planBody.innerHTML = '<tr class="empty"><td colspan="4">No items found.</td></tr>';
    summary.classList.add('hidden');
    executeBtn.disabled = true;
    return;
  }

  // While the AI runs, show ONLY files it has already classified — the rest are
  // "in processing" and stream in as they're finished.
  let rows = sortedActions();
  if (aiRunning) {
    rows = rows.filter((a) => a.source === 'ai' || a.source === 'prompt');
    if (!rows.length) {
      planBody.innerHTML = '<tr class="empty"><td colspan="4">Classifying… newly sorted files appear here as the AI finishes them.</td></tr>';
      renderSummary();
      return;
    }
  }

  planBody.innerHTML = '';
  if (aiRunning) {
    const note = document.createElement('tr');
    note.className = 'provisional-note';
    note.innerHTML = '<td colspan="4">Classifying… results are provisional and folders finalize at the end — review &amp; edits unlock when done.</td>';
    planBody.appendChild(note);
  }
  rows.forEach((a) => {
    const tr = document.createElement('tr');
    tr.className = (a.include ? '' : 'excluded ') + (a.action === 'delete' ? 'row-delete' : '');
    tr.dataset.rowId = a.id; // for double-click open + right-click menu

    tr.innerHTML = `
      <td class="c-inc"><input type="checkbox" data-id="${escapeHtml(a.id)}" data-f="include" ${a.include ? 'checked' : ''}/></td>
      <td class="c-name">
        <div class="name-main">${a.isDir ? '📁 ' : ''}<span class="fname" title="Double-click to open · right-click for more">${escapeHtml(a.name)}</span>
          ${a.source === 'ai' ? '<span class="ai-tag">AI</span>' : ''}
          ${a.source === 'prompt' ? '<span class="ai-tag">request</span>' : ''}
        </div>
        <div class="name-meta">${a.isDir ? 'folder' : fmtSize(a.size)}</div>
        ${a.rename ? `<div class="rename-row" title="Proposed new name — edit it, or × to keep the original">↳ <input class="rename-input" data-id="${escapeHtml(a.id)}" data-f="rename" value="${escapeHtml(a.rename)}"/><button class="pv-rename-deny" data-deny="${escapeHtml(a.id)}" title="Keep the original name">×</button></div>` : ''}
      </td>
      <td class="c-cat">${destControl(a)}</td>
      <td class="c-reason name-meta">${escapeHtml(a.reason || '')}</td>`;
    planBody.appendChild(tr);
  });
  renderSummary();
}

// Resolve a grouped action's absolute destination dir (for existence checks).
// The folder-path segments where a file will end up (rooted at the home "~").
function segmentsFor(a) {
  const folderSegs = state.folderLabel.split('/'); // e.g. ['~','Downloads']
  if (a.action === 'delete') return [...folderSegs, '_CleanupQuarantine'];
  if (a.action === 'keep') return folderSegs; // stays in the scanned folder itself
  const cat = a.category || 'Other';
  if (cat.startsWith('~/')) return cat.split('/');         // cross-location, e.g. ~/Documents/Taxes
  if (cat.startsWith('/')) return cat.split('/').filter(Boolean); // absolute (custom root)
  return [...folderSegs, ...cat.split('/')];               // new folder under the scanned folder
}

// "After" view: a real, collapsible folder tree showing where every file lands,
// with not-yet-existing folders flagged NEW. Editing controls live on each file.
async function renderPreview() {
  if (!state.actions.length) {
    previewEl.innerHTML = `<div class="pv-empty">${state.folder ? 'No items found.' : 'Choose a folder and scan to see the plan.'}</div>`;
    summary.classList.add('hidden'); executeBtn.disabled = true; return;
  }
  // The folder tree reshuffles when the final organize/consolidation pass runs, so
  // don't show a half-built tree mid-run — watch the live List instead; the settled
  // tree appears when classification finishes.
  if (aiRunning) {
    previewEl.innerHTML = '<div class="pv-empty">Organizing… the final folder tree appears when classification finishes. Watch progress in the List view.</div>';
    renderSummary(); return;
  }

  const visible = state.actions
    .filter((a) => !(a.isDir && a.action === 'keep')) // existing folders staying put aren't "placed"
    .filter(matchesQuery); // search filter

  // Build the tree.
  const root = { seg: '', label: '', children: new Map(), files: [], kind: 'dir' };
  for (const a of visible) {
    const segs = segmentsFor(a);
    let node = root;
    const acc = [];
    for (const s of segs) {
      acc.push(s);
      const label = acc[0] === '~' ? acc.join('/') : `/${acc.join('/')}`;
      if (!node.children.has(s)) {
        node.children.set(s, { seg: s, label, children: new Map(), files: [], kind: s === '_CleanupQuarantine' ? 'quarantine' : 'dir' });
      }
      node = node.children.get(s);
    }
    node.files.push(a);
  }

  // Inject user-created folders so they show (and are drop targets) even when empty.
  for (const label of state.userFolders) {
    const segs = label.startsWith('~') ? label.split('/') : label.split('/').filter(Boolean);
    let node = root; const acc = [];
    for (const s of segs) {
      acc.push(s);
      const lbl = acc[0] === '~' ? acc.join('/') : `/${acc.join('/')}`;
      if (!node.children.has(s)) node.children.set(s, { seg: s, label: lbl, children: new Map(), files: [], kind: 'dir' });
      node = node.children.get(s);
    }
  }

  // Flag folders that don't exist yet (→ NEW). Cache results so re-renders and
  // (especially) collapse toggles don't repeat the IPC. Skip quarantine.
  const allLabels = [];
  (function collect(n) { for (const c of n.children.values()) { if (c.kind !== 'quarantine') allLabels.push(c.label); collect(c); } })(root);
  const unknown = allLabels.filter((l) => !(l in state.existsCache));
  if (unknown.length) {
    try { Object.assign(state.existsCache, await window.api.labelsExist(unknown)); } catch { /* offline */ }
  }
  const exists = state.existsCache;

  // Build the tree as NESTED DOM: each folder is a .pv-node holding its header
  // plus a .pv-children container. Collapsing just toggles a class on the node
  // (CSS hides the children) — no rebuild, no IPC, so it's instant.
  const folderEl = (node, depth) => {
    const wrap = document.createElement('div');
    wrap.className = 'pv-node' + (state.collapsed.has(node.label) ? ' collapsed' : '');
    const isNew = node.kind !== 'quarantine' && exists[node.label] === false;
    const head = document.createElement('div');
    head.className = `pv-folder${isNew ? ' pv-new' : ''}${node.kind === 'quarantine' ? ' pv-quarantine' : ''}`
      + (state.selected.has(`folder:${node.label}`) ? ' selected' : '')
      + (state.clipboard.includes(`folder:${node.label}`) ? ' cut' : '');
    head.style.paddingLeft = `${8 + depth * 16}px`;
    head.dataset.folder = node.label;
    // Draggable to reparent the whole subtree — but not the scanned root or quarantine.
    if (node.kind !== 'quarantine' && node.label !== state.folderLabel) head.setAttribute('draggable', 'true');
    head.innerHTML =
      `<span class="pv-disc">▾</span>` +
      `<span class="pv-ficon">${node.kind === 'quarantine' ? '🗑' : '📁'}</span>` +
      `<span class="pv-label">${escapeHtml(node.seg)}</span>` +
      `<span class="pv-count">${countFiles(node)}</span>` +
      (isNew ? '<span class="pv-badge">NEW</span>' : '');
    wrap.appendChild(head);
    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'pv-children';
    const kids = [...node.children.values()].sort((a, b) => a.seg.localeCompare(b.seg, undefined, { numeric: true }));
    for (const c of kids) childrenWrap.appendChild(folderEl(c, depth + 1));
    node.files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const a of node.files) childrenWrap.appendChild(fileRow(a, depth + 1));
    wrap.appendChild(childrenWrap);
    return wrap;
  };

  previewEl.innerHTML = '';
  // Sticky breadcrumb pinned at the top — updated on scroll to the folder you're
  // currently inside, so deep scrolling never loses your place.
  const crumb = document.createElement('div');
  crumb.id = 'pv-crumb';
  crumb.className = 'pv-crumb hidden';
  previewEl.appendChild(crumb);
  const top = [...root.children.values()].sort((a, b) => a.seg.localeCompare(b.seg, undefined, { numeric: true }));
  for (const c of top) previewEl.appendChild(folderEl(c, 0));
  for (const a of root.files) previewEl.appendChild(fileRow(a, 0));
  renderSummary();
  requestAnimationFrame(updateCrumb); // reflect the current scroll position right away
}

// Show the folder currently scrolled to the top of the tree as a readable path.
function prettyPath(label) {
  return String(label).replace(/^~\//, '').replace(/^\//, '').split('/').filter(Boolean).join('  ›  ');
}
let crumbRAF = 0;
function updateCrumb() {
  crumbRAF = 0;
  const crumb = document.getElementById('pv-crumb');
  if (!crumb || state.view !== 'preview') return;
  if (tableWrap.scrollTop < 8) { crumb.classList.add('hidden'); return; } // at the top — no need
  const cTop = tableWrap.getBoundingClientRect().top;
  let current = null;
  for (const head of previewEl.querySelectorAll('.pv-folder')) {
    if (head.offsetParent === null) continue; // inside a collapsed folder
    if (head.getBoundingClientRect().top - cTop <= 30) current = head; else break; // last header at/above the top edge
  }
  if (current && current.dataset.folder) { crumb.textContent = prettyPath(current.dataset.folder); crumb.classList.remove('hidden'); }
  else crumb.classList.add('hidden');
}
tableWrap.addEventListener('scroll', () => { if (!crumbRAF) crumbRAF = requestAnimationFrame(updateCrumb); });

function countFiles(node) {
  let n = node.files.length;
  for (const c of node.children.values()) n += countFiles(c);
  return n;
}

function fileRow(a, depth) {
  const row = document.createElement('div');
  row.className = `pv-file${a.include ? '' : ' excluded'}${state.selected.has(`file:${a.id}`) ? ' selected' : ''}${state.clipboard.includes(`file:${a.id}`) ? ' cut' : ''}`;
  row.style.paddingLeft = `${8 + depth * 16 + 18}px`;
  row.dataset.rowId = a.id;
  row.setAttribute('draggable', 'true'); // drag onto a folder to reparent
  row.innerHTML = `
    <input type="checkbox" data-id="${escapeHtml(a.id)}" data-f="include" ${a.include ? 'checked' : ''}/>
    <span class="fname" title="Double-click to open · right-click for more">${escapeHtml(a.name)}</span>
    ${a.rename ? `<span class="pv-rename" title="Will be renamed to this">↳ <span class="pv-rename-name">${escapeHtml(a.rename)}</span><button class="pv-rename-deny" data-deny="${escapeHtml(a.id)}" title="Keep the original name">×</button></span>` : ''}
    <span class="pv-meta">${a.isDir ? 'folder' : fmtSize(a.size)}</span>
    <span class="pv-controls">${destControl(a)}</span>`;
  return row;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Delegated handlers live on the table-wrap so they work in BOTH the list table
// and the preview tree.
tableWrap.addEventListener('change', (e) => {
  if (aiRunning) return; // edits are futile mid-run — the next stream update overwrites them
  const t = e.target;
  const id = t.dataset.id;
  if (id == null) return;
  const a = state.actions.find((x) => String(x.id) === id);
  if (!a) return;
  const f = t.dataset.f;
  if (f === 'include') a.include = t.checked;
  else if (f === 'rename') { const v = t.value.trim(); a.rename = (v && v !== a.name) ? v : null; }
  else if (f === 'action') a.action = t.value;
  else if (f === 'category') {
    a.category = t.value;
    const d = destByLabel(t.value);
    a.destPath = d ? d.path : null; // absolute target for known locations; else relative new folder
  }
  render(); // re-render to reflect dest label / row styling / regrouping
});

function rowAction(target) {
  const row = target.closest('[data-row-id]');
  if (!row) return null;
  return state.actions.find((x) => String(x.id) === row.dataset.rowId) || null;
}

// Double-click a filename to open it (single-click would be too easy to misfire).
tableWrap.addEventListener('dblclick', (e) => {
  if (!e.target.closest('.fname')) return;
  const a = rowAction(e.target);
  if (a) window.api.openPath(a.path).then((r) => { if (r && !r.ok) setStatus(`Couldn't open ${a.name}: ${r.error}`); });
});

// Right-click a row for the native Open / Reveal in Finder / Get Info menu.
tableWrap.addEventListener('contextmenu', (e) => {
  const a = rowAction(e.target);
  if (!a) return;
  e.preventDefault();
  window.api.showFileMenu(a.path);
});

// Reflect state.selected onto the DOM without a full re-render (keeps scroll/collapse).
function applySelectionClasses() {
  previewEl.querySelectorAll('.pv-file').forEach((el) => el.classList.toggle('selected', state.selected.has(`file:${el.dataset.rowId}`)));
  previewEl.querySelectorAll('.pv-folder').forEach((el) => el.classList.toggle('selected', state.selected.has(`folder:${el.dataset.folder}`)));
}
const rowToken = (el) => (el.classList.contains('pv-file') ? `file:${el.dataset.rowId}` : `folder:${el.dataset.folder}`);
function toggleCollapse(head) {
  const node = head.parentElement; const label = head.dataset.folder;
  const collapse = !node.classList.contains('collapsed');
  node.classList.toggle('collapsed', collapse);
  if (collapse) state.collapsed.add(label); else state.collapsed.delete(label);
}

// Finder-like clicks: the disclosure triangle expands/collapses; clicking a row
// SELECTS it (plain = just it, ⌘/Ctrl = toggle, Shift = range from the anchor).
previewEl.addEventListener('click', (e) => {
  if (e.target.closest('.pv-disc')) { const head = e.target.closest('.pv-folder'); if (head) toggleCollapse(head); return; }
  if (e.target.closest('input, select, button, .dest-chip')) return; // let controls work
  const row = e.target.closest('.pv-file, .pv-folder');
  if (!row) { state.selected.clear(); state.selAnchor = null; applySelectionClasses(); return; }
  const tok = rowToken(row);
  if (e.shiftKey && state.selAnchor) {
    // Range select across the visible rows, in display order.
    const rows = [...previewEl.querySelectorAll('.pv-file, .pv-folder')].filter((el) => el.offsetParent !== null);
    const toks = rows.map(rowToken);
    const i = toks.indexOf(state.selAnchor); const j = toks.indexOf(tok);
    if (i >= 0 && j >= 0) {
      if (!(e.metaKey || e.ctrlKey)) state.selected.clear();
      const [lo, hi] = i < j ? [i, j] : [j, i];
      for (let k = lo; k <= hi; k += 1) state.selected.add(toks[k]);
    }
  } else if (e.metaKey || e.ctrlKey) {
    state.selected.has(tok) ? state.selected.delete(tok) : state.selected.add(tok);
    state.selAnchor = tok;
  } else {
    state.selected = new Set([tok]); state.selAnchor = tok;
  }
  applySelectionClasses();
});

// Double-click: open a file; toggle a folder (Finder convenience).
previewEl.addEventListener('dblclick', (e) => {
  if (e.target.closest('.pv-disc, input, select, button, .dest-chip')) return;
  const head = e.target.closest('.pv-folder');
  if (head) { toggleCollapse(head); return; }
  const file = e.target.closest('.pv-file');
  if (file) {
    const a = state.actions.find((x) => String(x.id) === file.dataset.rowId);
    if (a) window.api.openPath(a.path).then((r) => { if (r && !r.ok) setStatus(`Couldn't open ${a.name}: ${r.error}`); });
  }
});

// ---- Drag a file onto a folder to reparent it (Finder-like) ----
// Resolve a tree folder's label to a {action, category, destPath} destination.
function nodeDest(label) {
  const root = state.folderLabel;
  if (label.endsWith('/_CleanupQuarantine') || label === `${root}/_CleanupQuarantine`) return { action: 'delete' };
  if (label === root) return { action: 'keep' }; // the scanned folder itself → leave in place
  if (label.startsWith(`${root}/`)) return { action: 'group', category: label.slice(root.length + 1), destPath: null };
  if (label.startsWith('~/')) return { action: 'group', category: label, destPath: state.home + label.slice(1) };
  if (label.startsWith('/')) return { action: 'group', category: label, destPath: label };
  return { action: 'group', category: label, destPath: null };
}
function applyDest(a, d) {
  a.action = d.action;
  a.category = d.action === 'group' ? d.category : (d.action === 'delete' ? 'Junk' : 'Other');
  a.destPath = d.destPath || null;
  a.source = 'prompt'; // a manual move — feeds learning on execute
}
// --- batchable cores (no render/status; the drop handler does that once) ---
function reparentFileCore(id, label) {
  const a = state.actions.find((x) => String(x.id) === id);
  if (a) applyDest(a, nodeDest(label));
}
const labelOf = (segs) => (segs[0] === '~' ? segs.join('/') : `/${segs.join('/')}`);
// Reparent a whole folder subtree: every file under srcLabel moves under destLabel/<leaf>.
function reparentFolderCore(srcLabel, destLabel) {
  if (destLabel === srcLabel || destLabel.startsWith(`${srcLabel}/`)) return false; // can't nest into itself
  const toQuarantine = nodeDest(destLabel).action === 'delete';
  const leaf = srcLabel.split('/').pop();
  for (const a of state.actions) {
    if (a.isDir) continue;
    const aLabel = labelOf(segmentsFor(a));
    if (aLabel !== srcLabel && !aLabel.startsWith(`${srcLabel}/`)) continue;
    applyDest(a, toQuarantine ? { action: 'delete' } : nodeDest(`${destLabel}/${leaf}${aLabel.slice(srcLabel.length)}`));
  }
  if (!toQuarantine) {
    state.userFolders = state.userFolders.map((l) =>
      (l === srcLabel || l.startsWith(`${srcLabel}/`)) ? `${destLabel}/${leaf}${l.slice(srcLabel.length)}` : l);
  }
  return true;
}
// Move everything currently selected (or a single dragged token) into a folder.
function moveTokensTo(tokens, destLabel) {
  let files = 0; let folders = 0; let rejected = 0;
  for (const tok of tokens) {
    if (tok.startsWith('file:')) { reparentFileCore(tok.slice(5), destLabel); files += 1; }
    else if (tok.startsWith('folder:')) { reparentFolderCore(tok.slice(7), destLabel) ? (folders += 1) : (rejected += 1); }
  }
  state.selected.clear();
  render();
  const parts = [];
  if (files) parts.push(`${files} file${files === 1 ? '' : 's'}`);
  if (folders) parts.push(`${folders} folder${folders === 1 ? '' : 's'}`);
  setStatus(`Moved ${parts.join(' + ') || '0 items'} → ${destLabel}${rejected ? ` (${rejected} skipped — can’t nest into itself)` : ''}.`);
}

previewEl.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.pv-file');
  const head = !row && e.target.closest('.pv-folder');
  const tok = row ? `file:${row.dataset.rowId}`
    : (head && head.getAttribute('draggable') === 'true' ? `folder:${head.dataset.folder}` : null);
  if (!tok) return;
  // Dragging an item that isn't in the selection drags just it; otherwise the whole selection moves.
  if (!state.selected.has(tok)) { state.selected = new Set([tok]); applySelectionClasses(); }
  e.dataTransfer.setData('text/plain', tok);
  e.dataTransfer.effectAllowed = 'move';
  previewEl.querySelectorAll('.pv-file.selected, .pv-folder.selected').forEach((el) => el.classList.add('dragging'));
});
previewEl.addEventListener('dragend', () => {
  previewEl.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  previewEl.querySelectorAll('.pv-folder.drop-target').forEach((x) => x.classList.remove('drop-target'));
});
previewEl.addEventListener('dragover', (e) => {
  const head = e.target.closest('.pv-folder');
  if (!head) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!head.classList.contains('drop-target')) {
    previewEl.querySelectorAll('.pv-folder.drop-target').forEach((el) => el.classList.remove('drop-target'));
    head.classList.add('drop-target');
  }
});
previewEl.addEventListener('drop', (e) => {
  const head = e.target.closest('.pv-folder');
  if (!head) return;
  e.preventDefault();
  head.classList.remove('drop-target');
  const target = head.dataset.folder;
  // Move the whole selection (which includes the dragged item); fall back to the
  // single dragged token if selection was somehow cleared.
  const tokens = state.selected.size ? [...state.selected] : [e.dataTransfer.getData('text/plain')].filter(Boolean);
  // Don't drop a folder onto itself when it's also the target.
  if (tokens.length) moveTokensTo(tokens.filter((t) => t !== `folder:${target}`), target);
});

// ---- Right-click menu in the tree: rename, cut/paste, open ----
const ctx = $('ctx');
function closeCtx() { ctx.classList.add('hidden'); ctx.innerHTML = ''; }
function applyClipboardClasses() {
  const set = new Set(state.clipboard);
  previewEl.querySelectorAll('.pv-file').forEach((el) => el.classList.toggle('cut', set.has(`file:${el.dataset.rowId}`)));
  previewEl.querySelectorAll('.pv-folder').forEach((el) => el.classList.toggle('cut', set.has(`folder:${el.dataset.folder}`)));
}

// Rename a file = set its proposed name (applied on execute), keeping the extension.
function renameFileTo(id, raw) {
  const a = state.actions.find((x) => String(x.id) === id);
  if (!a) return;
  let v = raw.trim().replace(/[\\/:*?"<>|]/g, '');
  const ext = a.name.includes('.') ? a.name.slice(a.name.lastIndexOf('.')) : '';
  if (ext && !v.toLowerCase().endsWith(ext.toLowerCase())) v += ext;
  a.rename = (v && v !== a.name) ? v : null;
  render();
}
// Rename a folder = re-leaf it (same parent), moving every file under it.
function renameFolderTo(srcLabel, rawLeaf) {
  const leaf = rawLeaf.trim().replace(/[\\/:*?"<>|]/g, '');
  if (!leaf) { render(); return; }
  const destBase = `${srcLabel.split('/').slice(0, -1).join('/')}/${leaf}`;
  if (destBase === srcLabel) { render(); return; }
  for (const a of state.actions) {
    if (a.isDir) continue;
    const aLabel = labelOf(segmentsFor(a));
    if (aLabel !== srcLabel && !aLabel.startsWith(`${srcLabel}/`)) continue;
    applyDest(a, nodeDest(destBase + aLabel.slice(srcLabel.length)));
  }
  state.userFolders = state.userFolders.map((l) => (l === srcLabel || l.startsWith(`${srcLabel}/`)) ? destBase + l.slice(srcLabel.length) : l);
  render();
}
// Inline-edit a label span/element in place.
function inlineEdit(el, initial, onCommit) {
  const input = document.createElement('input');
  input.className = 'inline-rename';
  input.value = initial;
  el.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = (commit) => { if (done) return; done = true; if (commit) onCommit(input.value); else render(); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
  input.addEventListener('blur', () => finish(true));
}
function startRename(token) {
  if (token.startsWith('file:')) {
    const row = previewEl.querySelector(`.pv-file[data-row-id="${CSS.escape(token.slice(5))}"]`);
    const a = state.actions.find((x) => String(x.id) === token.slice(5));
    if (row && a) inlineEdit(row.querySelector('.fname'), a.rename || a.name, (v) => renameFileTo(token.slice(5), v));
  } else {
    const label = token.slice(7);
    const head = previewEl.querySelector(`.pv-folder[data-folder="${CSS.escape(label)}"]`);
    if (head) inlineEdit(head.querySelector('.pv-label'), label.split('/').pop(), (v) => renameFolderTo(label, v));
  }
}

previewEl.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.pv-file, .pv-folder');
  if (!row) return;
  e.preventDefault();
  e.stopPropagation(); // the preview sits inside .table-wrap — don't also fire its native menu
  const tok = rowToken(row);
  if (!state.selected.has(tok)) { state.selected = new Set([tok]); state.selAnchor = tok; applySelectionClasses(); }
  const isFolder = tok.startsWith('folder:');
  const a = isFolder ? null : state.actions.find((x) => String(x.id) === tok.slice(5));
  const n = state.selected.size;
  const items = [];
  if (a) { items.push(['Open', () => window.api.openPath(a.path)]); items.push(['Reveal in Finder', () => window.api.revealPath(a.path)]); }
  if (n === 1) items.push(['Rename…', () => startRename(tok)]);
  items.push([`Cut${n > 1 ? ` (${n})` : ''}`, () => { state.clipboard = [...state.selected]; applyClipboardClasses(); setStatus(`Cut ${n} item${n === 1 ? '' : 's'} — right-click a folder to paste.`); }]);
  if (isFolder && state.clipboard.length) {
    const c = state.clipboard.filter((t) => t !== tok);
    items.push([`Paste ${c.length} here`, () => { moveTokensTo(c, row.dataset.folder); state.clipboard = []; }]);
  }
  if (isFolder) items.push(['New folder here', () => { const base = row.dataset.folder; const name = 'New Folder'; const lbl = `${base}/${name}`; if (!state.userFolders.includes(lbl)) state.userFolders.push(lbl); render(); startRename(`folder:${lbl}`); }]);
  ctx.innerHTML = '';
  for (const [label, fn] of items) {
    const it = document.createElement('div');
    it.className = 'ctx-item';
    it.textContent = label;
    it.addEventListener('click', () => { closeCtx(); fn(); });
    ctx.appendChild(it);
  }
  ctx.style.left = `${e.clientX}px`;
  ctx.style.top = `${e.clientY}px`;
  ctx.classList.remove('hidden');
});
// A click outside the context menu just dismisses it — swallow that click (capture
// phase) so it doesn't also collapse a folder or clear the selection underneath.
window.addEventListener('click', (e) => {
  if (!ctx.classList.contains('hidden') && !ctx.contains(e.target)) {
    closeCtx();
    e.stopPropagation();
    e.preventDefault();
  }
}, true);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); });

// Finder-like keyboard shortcuts on the tree selection (Preview view).
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (state.selected.size) { state.selected.clear(); applySelectionClasses(); } return; }
  if (e.target.matches('input, textarea, select')) return; // don't hijack typing
  if (state.view !== 'preview' || aiRunning) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'a') { // select all visible rows
    e.preventDefault();
    state.selected = new Set([...previewEl.querySelectorAll('.pv-file, .pv-folder')].map(rowToken));
    applySelectionClasses();
  } else if ((e.key === 'Backspace' || e.key === 'Delete') && state.selected.size) { // quarantine selection
    e.preventDefault();
    moveTokensTo([...state.selected], `${state.folderLabel}/_CleanupQuarantine`);
  } else if ((e.key === 'Enter' || e.key === 'F2') && state.selected.size === 1) { // rename
    e.preventDefault();
    startRename([...state.selected][0]);
  }
});
previewEl.addEventListener('scroll', closeCtx, true);

// ---- Destination folder picker (browse a tree instead of a giant dropdown) ----
const pickerOverlay = $('picker-overlay');
const pickerTree = $('picker-tree');
const pickerFilter = $('picker-filter');
let pickTarget = null;             // file id being assigned
let pickerRoots = null;            // cached [{label, path}]
const pickerChildren = new Map();  // path -> [{name, path}]
const pickerExpanded = new Set();

// Open the picker when a destination chip is clicked (works in list + tree).
tableWrap.addEventListener('click', (e) => {
  if (aiRunning) return; // destinations are still settling — wait until the run finishes
  const deny = e.target.closest('[data-deny]'); // "×" next to a proposed rename → keep original
  if (deny) { const a = state.actions.find((x) => String(x.id) === deny.dataset.deny); if (a) { a.rename = null; render(); } return; }
  const chip = e.target.closest('[data-pick]');
  if (chip) openPicker(chip.dataset.pick);
});

async function openPicker(id) {
  const a = state.actions.find((x) => String(x.id) === id);
  if (!a) return;
  pickTarget = id;
  $('picker-target').textContent = a.name;
  pickerFilter.value = '';
  pickerOverlay.classList.remove('hidden'); // show immediately
  pickerTree.innerHTML = '<div class="pk-empty">Loading folders…</div>';
  pickerFilter.focus();
  if (!pickerRoots) { try { pickerRoots = await window.api.destRoots(state.extraRoots); } catch { pickerRoots = []; } }
  if (pickTarget === id) renderPickerTree(); // still open on the same file
}
function closePicker() { pickerOverlay.classList.add('hidden'); pickTarget = null; }

function assignDest(label, path) {
  const a = state.actions.find((x) => String(x.id) === pickTarget);
  if (a) { a.action = 'group'; a.category = label; a.destPath = path; a.source = 'prompt'; }
  closePicker();
  render();
}

async function expandPicker(path) {
  if (!pickerChildren.has(path)) {
    try { pickerChildren.set(path, await window.api.listSubfolders(path)); } catch { pickerChildren.set(path, []); }
  }
  pickerExpanded.add(path);
  renderPickerTree();
}

function renderPickerTree() {
  const q = pickerFilter.value.trim().toLowerCase();
  pickerTree.innerHTML = '';
  if (q) {
    // Typing → quick flat shortlist from the gathered destinations.
    const matches = state.destinations.filter((d) => d.label.toLowerCase().includes(q)).slice(0, 100);
    if (!matches.length) { pickerTree.innerHTML = '<div class="pk-empty">No matching folders.</div>'; return; }
    for (const d of matches) pickerTree.appendChild(pickerRow(d.label, d.path, 0, false));
    return;
  }
  for (const r of (pickerRoots || [])) pickerTree.appendChild(pickerNode(r.label, r.path, 0));
}

function pickerNode(label, path, depth) {
  const wrap = document.createElement('div');
  wrap.appendChild(pickerRow(label, path, depth, true));
  if (pickerExpanded.has(path)) {
    for (const c of (pickerChildren.get(path) || [])) wrap.appendChild(pickerNode(`${label}/${c.name}`, c.path, depth + 1));
  }
  return wrap;
}

function pickerRow(label, path, depth, expandable) {
  const seg = label.split('/').pop();
  const row = document.createElement('div');
  row.className = 'pk-row' + (expandable ? ' pk-expandable' : '');
  row.style.paddingLeft = `${8 + depth * 16}px`;
  row.dataset.path = path;
  row.dataset.label = label;
  if (expandable) row.dataset.expandable = '1';
  const expanded = pickerExpanded.has(path);
  row.innerHTML =
    `<span class="pk-disc">${expandable ? (expanded ? '▾' : '▸') : '·'}</span>` +
    `<span class="pk-name">📁 ${escapeHtml(seg)}</span>` +
    `<button class="pk-use small" data-use title="Move the file into this folder">Move here</button>` +
    `<button class="pk-new small" data-new title="New subfolder here">＋</button>`;
  return row;
}

// Clicking a folder row expands/browses it; the buttons select or create.
pickerTree.addEventListener('click', (e) => {
  const row = e.target.closest('.pk-row');
  if (!row) return;
  const { label, path } = row.dataset;
  if (e.target.closest('[data-use]')) { assignDest(label, path); return; }
  if (e.target.closest('[data-new]')) {
    const name = prompt('New subfolder name:');
    const clean = (name || '').replace(/[\/:*?"<>|]/g, '').trim();
    if (clean) assignDest(`${label}/${clean}`, `${path}/${clean}`);
    return;
  }
  if (!row.dataset.expandable) return;
  if (pickerExpanded.has(path)) { pickerExpanded.delete(path); renderPickerTree(); } else expandPicker(path);
});
pickerFilter.addEventListener('input', renderPickerTree);
$('picker-close').addEventListener('click', closePicker);
$('pick-keep').addEventListener('click', () => {
  const a = state.actions.find((x) => String(x.id) === pickTarget);
  if (a) { a.action = 'keep'; a.category = 'Other'; a.destPath = null; a.source = 'prompt'; }
  closePicker(); render();
});
$('pick-quarantine').addEventListener('click', () => {
  const a = state.actions.find((x) => String(x.id) === pickTarget);
  if (a) { a.action = 'delete'; a.category = 'Junk'; a.destPath = null; a.source = 'prompt'; }
  closePicker(); render();
});
pickerOverlay.addEventListener('click', (e) => { if (e.target === pickerOverlay) closePicker(); });

// View toggle (List ⇄ Preview).
function setView(v) {
  state.view = v;
  $('view-list').classList.toggle('active', v === 'list');
  $('view-preview').classList.toggle('active', v === 'preview');
  render();
}
$('view-list').addEventListener('click', () => setView('list'));
$('view-preview').addEventListener('click', () => setView('preview'));

// Report of exactly what a plain-language request changed, so the user can see
// what the model did (and, by omission, what it left alone).
const changeReport = $('change-report');
function showChangeReport(moves) {
  const body = $('change-report-body');
  body.innerHTML = moves.length
    ? moves.map((m) => `<div class="cr-row">${escapeHtml(m)}</div>`).join('')
    : '<div class="cr-empty">No changes.</div>';
  changeReport.classList.remove('hidden');
}
const closeChangeReport = () => changeReport.classList.add('hidden');
$('change-report-close').addEventListener('click', closeChangeReport);
changeReport.addEventListener('click', (e) => { if (e.target === changeReport) closeChangeReport(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !changeReport.classList.contains('hidden')) closeChangeReport(); });

// Settings modal (Speed, Learn, Condense, Stop-Ollama, Clear cache, Forget learned
// live here now — moved out of the main bar to declutter).
const settingsOverlay = $('settings-overlay');
const closeSettings = () => settingsOverlay.classList.add('hidden');
$('open-settings').addEventListener('click', () => { settingsOverlay.classList.remove('hidden'); renderScope(); });
$('settings-close').addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !settingsOverlay.classList.contains('hidden')) closeSettings(); });

// ---- Access scope: protected (do-not-touch) + granted folders ----
async function renderScope() {
  let s;
  try { s = await window.api.getScope(); } catch { return; }
  const tilde = (p) => String(p).replace(/^\/Users\/[^/]+/, '~');
  const fill = (el, paths, removeFn, emptyMsg) => {
    el.innerHTML = paths.length
      ? paths.map((it) => { const p = typeof it === 'string' ? it : it.path; return `<li><span class="scope-path" title="${p}">${tilde(p)}</span><button class="scope-rm" data-path="${p}">Remove</button></li>`; }).join('')
      : `<li class="scope-empty">${emptyMsg}</li>`;
    el.querySelectorAll('.scope-rm').forEach((b) => b.addEventListener('click', async () => { await removeFn(b.dataset.path); renderScope(); }));
  };
  fill($('protected-list'), s.protected || [], (p) => window.api.removeProtected(p), 'Nothing protected yet.');
  fill($('granted-list'), s.granted || [], (p) => window.api.removeGrant(p), 'No folders granted yet.');
}
$('add-protected').addEventListener('click', async () => { await window.api.addProtected(); renderScope(); });
$('grant-folder').addEventListener('click', async () => { await window.api.grantFolder(); renderScope(); });
$('view-licenses').addEventListener('click', () => window.api.openLicenses());

// Quick collapse/expand all folders in the tree.
$('collapse-all').addEventListener('click', () => {
  if (state.view !== 'preview') setView('preview');
  const labels = [...previewEl.querySelectorAll('.pv-folder')].map((el) => el.dataset.folder);
  if (!labels.length) return;
  const anyExpanded = labels.some((l) => !state.collapsed.has(l));
  if (anyExpanded) labels.forEach((l) => state.collapsed.add(l)); else state.collapsed.clear();
  render();
});

// Create an empty folder (under ~/Documents) the user can then drag files into.
// Uses an inline input — Electron renderers don't support window.prompt().
$('new-folder').addEventListener('click', () => {
  if (aiRunning) { setStatus('Wait for classification to finish before adding folders.'); return; }
  if (!state.actions.length) { setStatus('Scan a folder first.'); return; }
  if (state.view !== 'preview') setView('preview');
  if ($('nf-bar')) { $('nf-input').focus(); return; }
  const bar = document.createElement('div');
  bar.id = 'nf-bar';
  bar.className = 'pv-newfolder';
  bar.innerHTML = '<span class="pv-ficon">📁</span><input id="nf-input" placeholder="New folder name" autocomplete="off" />'
    + '<button id="nf-ok" class="small primary">Create</button><button id="nf-cancel" class="small">Cancel</button>';
  previewEl.prepend(bar);
  const input = $('nf-input'); input.focus();
  const create = () => {
    const name = input.value.trim().replace(/[\\/:*?"<>|]/g, '').slice(0, 60);
    if (!name) { bar.remove(); return; }
    const label = `~/Documents/${name}`;
    if (!state.userFolders.includes(label)) state.userFolders.push(label);
    render(); // rebuilds the tree (removes the bar) with the new empty folder
    setStatus(`Created “${label}”. Drag files onto it to move them there.`);
  };
  $('nf-ok').addEventListener('click', create);
  $('nf-cancel').addEventListener('click', () => bar.remove());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); else if (e.key === 'Escape') bar.remove(); });
});

$('sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  render();
});

$('search').addEventListener('input', (e) => {
  state.query = e.target.value;
  render();
  updateSearchCount();
});
function updateSearchCount() {
  const el = $('search-count');
  if (!state.query.trim()) { el.textContent = ''; return; }
  const n = state.actions.filter((a) => !a.isDir && matchesQuery(a)).length;
  el.textContent = `${n} match${n === 1 ? '' : 'es'}`;
}

// ---- Actions ----
$('choose').addEventListener('click', async () => {
  const f = await window.api.selectFolder();
  if (f) { state.folder = f; folderInput.value = f; }
});

const scanBtn = $('scan');

const aiGate = $('ai-gate');

// Upfront estimate is composition-WEIGHTED: an image costs more than a plain doc
// (OCR + 2 Vision passes), so we count "weighted units", not raw files. The rate
// (sec per unit) is calibrated against the FULL wall-clock of the last run —
// including model load, OCR, and the folder-consolidation pass — so it captures
// everything, not just the per-file model time.
const DEFAULT_SEC_PER_UNIT = 4;
const IMAGE_EXTS_RE = /\.(png|jpe?g|heic|heif|tiff?|bmp|gif|webp)$/i;
const IMAGE_WEIGHT = 1.8;     // an image ≈ 1.8× a text/doc file (OCR is the surcharge)
const PARSE_CAP_BYTES = 25 * 1024 * 1024; // matches content.js: files larger are NOT parsed
const SIZE_SURCHARGE_MAX = 1.0;           // a file near the cap ≈ +1 unit of parse time
let learnedSecPerUnit = 0;    // loaded from settings; 0 = none yet
function fmtDuration(secs) {
  secs = Math.max(1, Math.round(secs));
  if (secs < 90) return `${secs}s`;
  return `${Math.round(secs / 60)} min`;
}
// Weighted units across the (non-folder) files: images weigh more (OCR), and
// bigger files take longer to PARSE — but only up to the 25MB cap, since past it
// we skip parsing and classify by name (fast), so those get no size surcharge.
function fileUnits(actions) {
  let files = 0; let units = 0;
  for (const a of actions) {
    if (a.isDir) continue;
    files += 1;
    const base = IMAGE_EXTS_RE.test(a.name) ? IMAGE_WEIGHT : 1;
    const size = a.size || 0;
    const sizeSurcharge = size > PARSE_CAP_BYTES ? 0 : (size / PARSE_CAP_BYTES) * SIZE_SURCHARGE_MAX;
    units += base + sizeSurcharge;
  }
  return { files, units };
}
function estimateMinutes() {
  const per = learnedSecPerUnit || DEFAULT_SEC_PER_UNIT;
  return `about ${fmtDuration(fileUnits(state.actions).units * per)}`;
}

// Live ETA tuned for STABILITY + OVERESTIMATION — a wildly swinging number is far
// worse than a steady, slightly-high one. Design:
//  - rate is the CUMULATIVE average since the first real classification (cache burst
//    excluded), which smooths the per-batch bursts that made a short window spike to
//    absurd values (e.g. 269 min when a 90s window caught a stall),
//  - padded so we lean high,
//  - SEEDED from the upfront estimate so it starts conservative, and
//  - clamped: it drops freely toward the truth but can only creep UP gently — never a jump.
const ETA_PAD = 1.3;
let etaT0 = 0;            // time of first model progress (cache burst excluded)
let etaD0 = 0;            // modelDone at that point
let etaShown = Infinity;  // last displayed seconds (seeded at run start)
let etaReseeded = false;  // discounted the cached portion yet?
let runStartedAt = 0;
function computeEta(done, total, hits) {
  // The seed counted ALL files; once we know how many were reused from cache,
  // discount them — otherwise a 472-of-500-cached run still shows the full estimate.
  if (!etaReseeded && total > 0 && etaShown !== Infinity) {
    etaShown = Math.max(1, etaShown * (total - (hits || 0)) / total);
    etaReseeded = true;
  }
  const md = Math.max(0, done - (hits || 0));
  const now = Date.now();
  if (md >= 1) {
    if (!etaT0) { etaT0 = now; etaD0 = md; }
    const dT = (now - etaT0) / 1000;
    const dD = md - etaD0;
    if (dT >= 8 && dD >= 3) {
      const rate = dD / dT;                                  // cumulative — stable
      const live = ((total - done) / rate) * ETA_PAD;        // padded — lean high
      if (live < etaShown) etaShown = live;                  // drop freely toward the truth
      else etaShown = Math.min(live, etaShown * 1.08 + 5);   // creep up gently — no spikes
    }
  }
  return etaShown === Infinity ? '' : fmtDuration(etaShown);
}

scanBtn.addEventListener('click', async () => {
  setStatus('Scanning…');
  scanBtn.disabled = true;
  aiGate.classList.add('hidden');
  try {
    // Instant rule-based plan — always fast, even for thousands of files.
    const res = await window.api.scan({ folder: state.folder, extraRoots: state.extraRoots });
    state.actions = res.actions;
    state.destinations = res.destinations || [];
    state.folderLabel = res.folderLabel || '~';
    state.home = res.home || '';
    state.userFolders = [];
    state.selected.clear();
    state.selAnchor = null;
    state.clipboard = [];
    state.existsCache = {}; // folders may have changed since last scan
    // Match the order this folder is sorted by in Finder (falls back to name).
    if (res.finderSort) { state.sort = res.finderSort; $('sort').value = res.finderSort; }

    const fileCount = state.actions.filter((a) => !a.isDir).length;
    const sortNote = res.finderSort ? ` · sorted by ${res.finderSort} (from Finder)` : '';
    setStatus(`Found ${res.count} items — ${fileCount} files, ${state.destinations.length} destination folders${sortNote}.`);

    // Gate the expensive AI pass: show the time cost and let the user add
    // guidance before committing.
    if (aiAvailable && fileCount > 0) {
      // Don't show the rule-based plan — AI would just overwrite it. Hold the
      // list back behind a placeholder until the user decides.
      awaitingDecision = true;
      render();
      $('ai-gate-info').textContent =
        `up to ${fileCount} files — ${estimateMinutes()} of local compute ` +
        `(unchanged files since a previous run are reused instantly).`;
      aiGate.classList.remove('hidden');
    } else {
      awaitingDecision = false;
      render(); // no AI — show the rule-based plan directly
    }
  } catch (err) {
    setStatus(`Scan failed: ${err.message}`);
  } finally {
    scanBtn.disabled = false;
  }
});

async function runAI() {
  aiGate.classList.add('hidden');
  awaitingDecision = false;
  const guidance = $('ai-guidance').value;
  const fileCount = state.actions.filter((a) => !a.isDir).length;
  aiRunning = true;
  // Seed the live ETA from the conservative upfront estimate so it starts HIGH and
  // ratchets toward the truth — overestimate-and-converge, never wild swings.
  etaT0 = 0; etaD0 = 0; etaReseeded = false;
  etaShown = Math.max(1, fileUnits(state.actions).units * (learnedSecPerUnit || DEFAULT_SEC_PER_UNIT));
  runStartedAt = Date.now(); // for full-wall-clock calibration of the estimate
  state.selected.clear();    // a new plan invalidates any tree selection
  state.clipboard = [];
  $('stop-ai').disabled = false;
  // Clear files from view (unstage); they stream back in as they're classified.
  state.actions.forEach((a) => { if (!a.isDir) a.include = false; });
  setView('list'); // watch the stable live stream here; the tree settles at the end
  render();
  showProgress(0, 'Loading model…', true); // first response covers model load + warm-up
  scanBtn.disabled = true;
  try {
    const result = await window.api.classifyAI({
      actions: state.actions, model: modelSelect.value, guidance,
      ignoreCache: $('ignore-cache').checked,
      rename: $('ai-rename').checked,
    });
    const elapsedSec = (Date.now() - runStartedAt) / 1000;
    state.actions = result.actions;
    if (result.error) { setStatus(result.error); return; } // finally re-renders & resets UI
    // Calibrate against the FULL wall-clock over the weighted units actually
    // processed (cache hits cost ~nothing, so scale by classified/total).
    if (!result.cancelled && result.classified >= 6) {
      const { files, units } = fileUnits(state.actions);
      const unitsProcessed = units * (result.classified / Math.max(1, files));
      if (unitsProcessed > 0) {
        learnedSecPerUnit = elapsedSec / unitsProcessed;
        window.api.setSetting('secondsPerUnit', learnedSecPerUnit);
      }
    }
    const reused = result.hits ? ` (${result.hits} reused, ${result.classified} newly reviewed)` : '';
    setStatus(result.cancelled
      ? `Stopped — only the files reviewed so far are included; the rest are left as-is.${reused}`
      : `Reviewed ${fileCount} files.${reused}`);
  } catch (err) {
    setStatus(`Couldn't finish reviewing: ${err.message}`);
  } finally {
    aiRunning = false;   // clear before hide/render so late events are ignored
    hideProgress();
    scanBtn.disabled = false;
    setView('preview');  // settle into the grouped folder view now the run is done
  }
}

$('ai-start').addEventListener('click', runAI);
// Dismiss the gate and just show the scanned files (no AI). Used by Skip, the
// Esc key, and clicking outside the card — never clears the plan.
function dismissGate() {
  if (aiGate.classList.contains('hidden')) return;
  aiGate.classList.add('hidden');
  awaitingDecision = false;
  render(); // reveal the rule-based plan (your files, in Finder order)
  setStatus('Showing your files. Run AI anytime, or edit/execute the plan directly.');
}
$('ai-skip').addEventListener('click', dismissGate);
aiGate.addEventListener('click', (e) => { if (e.target === aiGate) dismissGate(); }); // click outside the card
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !aiGate.classList.contains('hidden')) dismissGate(); });

$('stop-ai').addEventListener('click', () => {
  window.api.cancelAI(); // aborts the in-flight model call (classify OR apply)
  $('stop-ai').disabled = true;
  hideProgress();
  if (applyRunning) { // a plain-language request — leave the plan as it was
    applyRunning = false;
    setStatus('Stopped applying the request — plan unchanged.');
    return;
  }
  // Always tear down the UI, even if the run technically just finished — the bar
  // must never linger. aiRunning=false also guards out any late progress event.
  aiRunning = false;
  render(); // re-enable Execute for the already-classified files, drop "AI working" pill
  setStatus('Stopped — keeping what was already classified; the rest stay unstaged.');
});

$('add-location').addEventListener('click', async () => {
  const dir = await window.api.selectFolder();
  if (!dir) return;
  if (!state.extraRoots.includes(dir)) state.extraRoots.push(dir);
  $('dest-summary').textContent =
    `Destinations: Downloads, Documents, Desktop${state.extraRoots.length ? ', ' + state.extraRoots.join(', ') : ''}`;
  setStatus(`Added destination location: ${dir}. Re-scan to include its folders.`);
});

$('clear-cache').addEventListener('click', async () => {
  closeSettings(); // reveal the footer confirmation
  const { cleared } = await window.api.clearCache();
  setStatus(`Cleared AI cache (${cleared} entries). Next AI run re-classifies from scratch.`);
});

$('clear-learning').addEventListener('click', async () => {
  closeSettings();
  const { cleared } = await window.api.clearLearning();
  setStatus(`Forgot ${cleared} learned preference${cleared === 1 ? '' : 's'}.`);
});

// Enter makes a new line (so you can't fire a half-typed request); ⌘/Ctrl-Enter applies.
$('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('apply-prompt').click(); }
});
$('apply-prompt').addEventListener('click', async () => {
  const prompt = $('prompt').value.trim();
  if (!prompt) return;
  if (!state.actions.length) { setStatus('Scan a folder first.'); return; }
  if (!aiAvailable) { setStatus('Ollama offline — natural-language requests need a local model.'); return; }
  applyRunning = true;
  $('stop-ai').disabled = false;
  showProgress(0, 'Working on your request…', true); // covers model load + folder pass; batches make it determinate
  setStatus('Working on your request…');
  try {
    const res = await window.api.applyPrompt({
      actions: state.actions, prompt, model: modelSelect.value,
    });
    if (!applyRunning) return; // stopped mid-way — leave the plan untouched
    state.actions = res.actions;
    render();
    if (res.error) setStatus(res.error);
    else if (res.changed) {
      const moves = res.summary || [];
      const shown = moves.slice(0, 5).join('  ·  ');
      const more = moves.length > 5 ? `  ·  +${moves.length - 5} more` : '';
      setStatus(`Applied — ${res.changed} item(s): ${shown}${more}. Review before executing.`);
      showChangeReport(moves); // full "what the model did" list
    } else setStatus('No items matched that request — try rephrasing (e.g. "move all PDFs into Finance", "delete all screenshots").');
  } catch (err) {
    setStatus(`Request failed: ${err.message}`);
  } finally {
    applyRunning = false;
    $('stop-ai').disabled = true;
    hideProgress();
  }
});

$('execute').addEventListener('click', async () => {
  const staged = state.actions.filter((a) => a.include);
  const dels = staged.filter((a) => a.action === 'delete').length;
  const moves = staged.filter((a) => a.action === 'group').length;
  const ok = confirm(
    `Clean up now?\n\n` +
    `• ${moves} item(s) organized into folders\n` +
    `• ${dels} item(s) moved to a Removed folder you can undo\n\n` +
    `Nothing is permanently deleted.`);
  if (!ok) return;
  setStatus('Cleaning up…');
  try {
    const r = await window.api.execute({ folder: state.folder, actions: state.actions });
    setStatus(`Done — ${r.moved} moved, ${r.deleted} removed, ${r.kept} left alone` +
      (r.errors.length ? `, ${r.errors.length} error(s): ${r.errors.join('; ')}` : ''));
    // Offer to undo this cleanup.
    $('undo').classList.toggle('hidden', !(r.operations && r.operations.length));
    await rescan();
  } catch (err) {
    setStatus(`Execution failed: ${err.message}`);
  }
});

// Re-scan the current folder and refresh state (used after execute/undo).
async function rescan() {
  const res = await window.api.scan({ folder: state.folder, extraRoots: state.extraRoots });
  state.actions = res.actions;
  state.destinations = res.destinations || [];
  state.folderLabel = res.folderLabel || '~';
  state.existsCache = {};
  awaitingDecision = false;
  render();
}

$('undo').addEventListener('click', async () => {
  if (!confirm('Undo the last cleanup? Files moved/quarantined will be put back where they were.')) return;
  setStatus('Undoing…');
  try {
    const r = await window.api.undo();
    $('undo').classList.add('hidden');
    setStatus(`Undone — ${r.restored} item(s) put back` +
      (r.errors.length ? `, ${r.errors.length} error(s): ${r.errors.join('; ')}` : ''));
    await rescan();
  } catch (err) {
    setStatus(`Undo failed: ${err.message}`);
  }
});

init();
