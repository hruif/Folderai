'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, explicit surface exposed to the renderer. No raw fs/ipc access.
contextBridge.exposeInMainWorld('api', {
  defaultFolder: () => ipcRenderer.invoke('default-folder'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', { key, value }),
  ollamaStatus: () => ipcRenderer.invoke('ollama-status'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),
  showFileMenu: (p) => ipcRenderer.invoke('show-file-menu', p),
  pathsExist: (paths) => ipcRenderer.invoke('paths-exist', paths),
  labelsExist: (labels) => ipcRenderer.invoke('labels-exist', labels),
  destRoots: (extraRoots) => ipcRenderer.invoke('dest-roots', extraRoots),
  listSubfolders: (dirPath) => ipcRenderer.invoke('list-subfolders', dirPath),
  scan: (args) => ipcRenderer.invoke('scan', args),
  classifyAI: (args) => ipcRenderer.invoke('classify-ai', args),
  cancelAI: () => ipcRenderer.invoke('cancel-ai'),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  clearLearning: () => ipcRenderer.invoke('clear-learning'),
  savePlan: (plan) => ipcRenderer.invoke('save-plan', plan),
  loadPlan: () => ipcRenderer.invoke('load-plan'),
  clearPlan: () => ipcRenderer.invoke('clear-plan'),
  applyPrompt: (args) => ipcRenderer.invoke('apply-prompt', args),
  execute: (args) => ipcRenderer.invoke('execute', args),
  undo: () => ipcRenderer.invoke('undo'),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, msg) => cb(msg)),
  onOpenFolder: (cb) => ipcRenderer.on('open-folder', (_e, p) => cb(p)),
  onAiProgress: (cb) => ipcRenderer.on('ai-progress', (_e, payload) => cb(payload)),
});
