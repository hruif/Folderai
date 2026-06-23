'use strict';

const fs = require('fs');

// Persisted user settings (JSON file in the app's userData dir).
const DEFAULTS = {
  // When the app forcefully started the Ollama server, stop it again on quit.
  // Only ever affects a server WE started — a user-run server is left alone.
  stopOllamaOnQuit: true,
  // How many classification batches to run in parallel. Higher = faster but more
  // CPU/memory during the run. 1 = lightest (sequential), 4 = fastest.
  aiConcurrency: 2,
  // Learn from the user's overrides and apply them on future runs.
  useLearning: true,
  // Second pass that nests related proposed folders under shared parents.
  condenseFolders: true,
  // Row density in the list/tree: 'comfortable' (default) or 'compact'.
  density: 'comfortable',
};

function loadSettings(file) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    data = {}; // missing or corrupt — fall back to defaults
  }
  return { ...DEFAULTS, ...data };
}

function saveSettings(file, settings) {
  try {
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  } catch {
    /* best-effort */
  }
}

module.exports = { loadSettings, saveSettings, DEFAULTS };
