'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

// On-device OCR using the macOS Vision framework via a tiny Swift helper.
// SANDBOX-SAFE: packaged builds bundle a PRECOMPILED helper binary (built at package
// time — see scripts/build.sh), so nothing is compiled at runtime (`swiftc` is
// forbidden by the App Store sandbox). In dev (unpackaged) we fall back to compiling
// once. If no helper is available, OCR degrades to empty (no crash).

const SRC = path.join(__dirname, '..', 'native', 'ocr.swift');
const DEV_BIN = path.join(os.tmpdir(), 'folderai-imgproc-v2'); // dev-only compiled cache

// Resolve the helper binary, preferring a bundled precompiled one over any compile.
function locate() {
  if (process.platform !== 'darwin') return null;
  // 1) Bundled in a packaged build (Resources/ocr-helper) — the App Store path.
  try { const p = path.join(process.resourcesPath || '', 'ocr-helper'); if (fs.existsSync(p)) return p; } catch { /* */ }
  // 2) A precompiled helper committed/placed next to the source (optional dev convenience).
  try { const p = path.join(__dirname, '..', 'native', 'ocr-helper'); if (fs.existsSync(p)) return p; } catch { /* */ }
  // 3) Dev fallback: compile once to tmp. NOT reached in the sandboxed build (a bundled
  //    binary is always present there), so no swiftc runs under the sandbox.
  try { if (fs.existsSync(DEV_BIN)) return DEV_BIN; } catch { /* */ }
  try { execFileSync('swiftc', ['-O', SRC, '-o', DEV_BIN], { stdio: 'ignore', timeout: 90000 }); if (fs.existsSync(DEV_BIN)) return DEV_BIN; } catch { /* no toolchain */ }
  return null;
}

let resolved; // undefined = not attempted; string path | null after
function ensureBinary() {
  if (resolved === undefined) resolved = locate();
  return resolved;
}

// Returns { text, labels } for an image — text from OCR, labels from scene/object
// classification. Never throws (degrades to empty).
function analyzeImage(filePath) {
  const empty = { text: '', labels: [] };
  const bin = ensureBinary();
  if (!bin) return Promise.resolve(empty);
  return new Promise((resolve) => {
    execFile(bin, [filePath], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(empty);
      try {
        const o = JSON.parse(String(stdout || '').trim());
        resolve({ text: String(o.text || '').trim(), labels: Array.isArray(o.labels) ? o.labels : [] });
      } catch { resolve(empty); }
    });
  });
}

module.exports = { analyzeImage };
