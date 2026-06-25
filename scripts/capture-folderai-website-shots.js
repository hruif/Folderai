'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { app, BrowserWindow, ipcMain } = require('electron');

const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'docs', 'assets');
const home = '/Users/you';
const folder = `${home}/Downloads`;

function action(id, name, category, reason, opts = {}) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return {
    id,
    name,
    path: `${folder}/${name}`,
    ext,
    size: opts.size || 128000,
    action: opts.action || 'group',
    category: category || 'Other',
    reason,
    include: opts.include !== false,
    source: opts.source || 'ai',
    rename: opts.rename || null,
    isDir: false,
  };
}

const actions = [
  action('a1', 'Invoice April 2026.pdf', '~/Documents/Finance/Invoices', 'Invoice content and vendor terms found in the PDF.', { size: 842000 }),
  action('a2', 'IMG_4921.png', 'Screenshots', 'Screenshot-style image with visible text.', { size: 1800000 }),
  action('a3', 'Chrome Installer.dmg', 'Junk', 'Installer disk image; safe to quarantine after install.', { action: 'delete', size: 95000000 }),
  action('a4', 'Launch notes draft.md', 'Projects/Folderai', 'Project notes and release checklist language.', { size: 42000, rename: 'folderai-launch-notes.md' }),
  action('a5', 'receipt-coffee.jpeg', '~/Documents/Finance/Receipts', 'OCR found receipt text and a transaction total.', { size: 390000 }),
  action('a6', 'Budget copy.xlsx', '~/Documents/Finance', 'Duplicate of Budget.xlsx.', { action: 'delete', size: 620000 }),
  action('a7', 'Resume 2024.docx', '~/Documents/Career', 'Resume document.', { size: 118000 }),
  action('a8', 'meeting-recording.m4a', 'Audio', 'Audio recording file.', { size: 12400000 }),
  action('a9', 'Tax form W-9.pdf', '~/Documents/Finance/Taxes', 'Tax form content detected in PDF.', { size: 510000 }),
  action('a10', 'Untitled Folder', 'Other', 'Existing folder left where it is.', { action: 'keep', size: 0 }),
];

const savedPlan = {
  folder,
  folderLabel: '~/Downloads',
  home,
  destinations: [
    `${home}/Downloads`,
    `${home}/Documents`,
    `${home}/Desktop`,
  ],
  userFolders: ['~/Documents/Finance/Invoices', '~/Documents/Finance/Receipts'],
  sort: 'name',
  view: 'preview',
  actions,
};

function installMocks() {
  ipcMain.handle('default-folder', () => ({ folder, autoScan: false }));
  ipcMain.handle('get-settings', () => ({
    secondsPerUnit: 0,
    stopOllamaOnQuit: true,
    useLearning: true,
    density: 'comfortable',
    condenseFolders: true,
    aiConcurrency: 2,
  }));
  ipcMain.handle('set-setting', () => ({ ok: true }));
  ipcMain.handle('ollama-status', () => ({ available: true, installed: true, models: ['llama3.2:3b'] }));
  ipcMain.handle('select-folder', () => folder);
  ipcMain.handle('open-path', () => ({ ok: true }));
  ipcMain.handle('reveal-path', () => ({ ok: true }));
  ipcMain.handle('show-file-menu', () => ({ ok: true }));
  ipcMain.handle('paths-exist', (_event, paths = []) => Object.fromEntries(paths.map((p) => [p, true])));
  ipcMain.handle('labels-exist', (_event, labels = []) => {
    const existing = new Set(['~', '~/Downloads', '~/Documents', '~/Desktop', '~/Documents/Finance']);
    return Object.fromEntries(labels.map((label) => [label, existing.has(label)]));
  });
  ipcMain.handle('dest-roots', () => [
    { label: 'Downloads', path: `${home}/Downloads` },
    { label: 'Documents', path: `${home}/Documents` },
    { label: 'Desktop', path: `${home}/Desktop` },
  ]);
  ipcMain.handle('list-subfolders', () => []);
  ipcMain.handle('scan', () => ({
    count: actions.length,
    actions,
    destinations: savedPlan.destinations,
    folderLabel: savedPlan.folderLabel,
    home,
    finderSort: 'name',
  }));
  ipcMain.handle('classify-ai', () => ({ actions, hits: 0, classified: actions.length, cancelled: false }));
  ipcMain.handle('cancel-ai', () => ({ ok: true }));
  ipcMain.handle('clear-cache', () => ({ ok: true }));
  ipcMain.handle('clear-learning', () => ({ ok: true }));
  ipcMain.handle('save-plan', () => ({ ok: true }));
  ipcMain.handle('load-plan', () => savedPlan);
  ipcMain.handle('clear-plan', () => ({ ok: true }));
  ipcMain.handle('apply-prompt', () => ({ actions, summary: [] }));
  ipcMain.handle('get-scope', () => ({ grants: [], protected: [] }));
  ipcMain.handle('grant-folder', () => null);
  ipcMain.handle('remove-grant', () => ({ ok: true }));
  ipcMain.handle('add-protected', () => null);
  ipcMain.handle('remove-protected', () => ({ ok: true }));
  ipcMain.handle('open-licenses', () => ({ ok: true }));
  ipcMain.handle('execute', () => ({ ok: true, moved: 6, deleted: 2 }));
  ipcMain.handle('undo', () => ({ ok: true }));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function capture(win, filename) {
  const image = await win.capturePage();
  fs.writeFileSync(path.join(outDir, filename), image.toPNG());
}

function renderHero() {
  const binary = process.env.RSVG_CONVERT || (fs.existsSync('/opt/homebrew/bin/rsvg-convert') ? '/opt/homebrew/bin/rsvg-convert' : 'rsvg-convert');
  childProcess.execFileSync(binary, [
    '-w', '2400',
    '-h', '1500',
    path.join(outDir, 'hero-folderai.svg'),
    '-o', path.join(outDir, 'hero-folderai.png'),
  ], { stdio: 'inherit' });
}

app.whenReady().then(async () => {
  installMocks();

  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    show: false,
    backgroundColor: '#0f1218',
    webPreferences: {
      preload: path.join(repoRoot, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadFile(path.join(repoRoot, 'renderer', 'index.html'));
  await wait(900);
  await win.webContents.executeJavaScript(`
    document.getElementById('scan')?.click();
  `);
  await wait(800);
  await win.webContents.executeJavaScript(`
    document.getElementById('ai-skip')?.click();
  `);
  await wait(800);
  await win.webContents.executeJavaScript(`
    if (document.getElementById('adv-toggle') && document.getElementById('adv-toggle').textContent.trim().startsWith('▸')) {
      document.getElementById('adv-toggle').click();
    }
    document.getElementById('status').textContent = 'Restored your previous plan — 10 files.';
  `);
  await wait(500);
  await capture(win, 'review-screenshot.png');

  await win.webContents.executeJavaScript(`
    document.getElementById('ai-gate-info').textContent = 'up to 10 files — about a minute of local compute.';
    document.getElementById('ai-guidance').value = 'put invoices in Finance, keep resumes, remove old installers';
    document.getElementById('ai-rename').checked = true;
    document.getElementById('ai-gate').classList.remove('hidden');
  `);
  await wait(300);
  await capture(win, 'refine-screenshot.png');

  renderHero();

  win.close();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
