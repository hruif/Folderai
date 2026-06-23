'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

// On-device OCR using the macOS Vision framework via a tiny Swift helper.
// The helper is compiled once (lazily) into a cached binary; if Swift isn't
// available or compilation fails, OCR degrades to '' (no crash).

const SRC = path.join(__dirname, '..', 'native', 'ocr.swift');
// Write the binary somewhere always-writable (the app bundle may be read-only).
// Versioned name → bumping it forces a recompile when the Swift source changes.
const BIN = path.join(os.tmpdir(), 'folderai-imgproc-v2');

let ready = null; // null = not attempted, true/false after
function ensureBinary() {
  if (ready !== null) return ready;
  try { if (fs.existsSync(BIN)) { ready = true; return true; } } catch { /* ignore */ }
  try {
    execFileSync('swiftc', ['-O', SRC, '-o', BIN], { stdio: 'ignore', timeout: 90000 });
    ready = fs.existsSync(BIN);
  } catch {
    ready = false; // no Swift toolchain / build failed → OCR unavailable
  }
  return ready;
}

// Returns { text, labels } for an image — text from OCR, labels from scene/object
// classification. Never throws (degrades to empty).
function analyzeImage(filePath) {
  const empty = { text: '', labels: [] };
  if (process.platform !== 'darwin' || !ensureBinary()) return Promise.resolve(empty);
  return new Promise((resolve) => {
    execFile(BIN, [filePath], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(empty);
      try {
        const o = JSON.parse(String(stdout || '').trim());
        resolve({ text: String(o.text || '').trim(), labels: Array.isArray(o.labels) ? o.labels : [] });
      } catch { resolve(empty); }
    });
  });
}

module.exports = { analyzeImage };
