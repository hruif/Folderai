'use strict';

// Model delivery for the in-process (App Store) build. The gguf is DATA, which the
// App Store sandbox permits downloading on first launch (unlike the Ollama binary).
// We keep our own copy under userData/models so the app is self-sufficient.
//
// Acquisition order:
//   1) already present in userData  → use it
//   2) a local Ollama gguf blob     → fast copy (no network; for dev machines / testing)
//   3) FA_MODEL_URL                 → download with progress (the release path)

const fs = require('fs');
const path = require('path');
const os = require('os');

const MODEL_FILE = 'llama3.2-3b.gguf';
// TODO(release): host the gguf and set this (or FA_MODEL_URL). Must comply with the
// Llama 3.2 license. Until then the local-blob copy covers dev/testing.
const DEFAULT_URL = process.env.FA_MODEL_URL || '';

function modelDir(userData) { return path.join(userData, 'models'); }
function modelPath(userData) { return path.join(modelDir(userData), MODEL_FILE); }

function isGGUF(file) {
  try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd); return b.toString('latin1') === 'GGUF'; }
  catch { return false; }
}

// Find the user's existing Ollama gguf blob (largest GGUF in the blob store).
function findOllamaBlob() {
  try {
    const dir = path.join(os.homedir(), '.ollama', 'models', 'blobs');
    let best = null; let bestSize = 0;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      if (st.isFile() && st.size > bestSize && st.size > 1e9 && isGGUF(full)) { best = full; bestSize = st.size; }
    }
    return best;
  } catch { return null; }
}

function copyWithProgress(src, dst, onPct) {
  return new Promise((resolve, reject) => {
    const total = fs.statSync(src).size; let done = 0; let last = -1;
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(`${dst}.part`);
    rs.on('data', (c) => { done += c.length; const p = Math.floor((done / total) * 100); if (p !== last) { last = p; onPct(p); } });
    rs.on('error', reject); ws.on('error', reject);
    ws.on('finish', () => { try { fs.renameSync(`${dst}.part`, dst); resolve(); } catch (e) { reject(e); } });
    rs.pipe(ws);
  });
}

async function downloadWithProgress(url, dst, onPct) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const ws = fs.createWriteStream(`${dst}.part`);
  const reader = res.body.getReader();
  let got = 0; let last = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    ws.write(Buffer.from(value));
    got += value.length;
    if (total) { const p = Math.floor((got / total) * 100); if (p !== last) { last = p; onPct(p); } }
  }
  await new Promise((r) => ws.end(r));
  fs.renameSync(`${dst}.part`, dst);
}

// Ensure the gguf exists in userData; acquire it if missing. onProgress({phase, pct}).
async function ensureModel(userData, onProgress = () => {}) {
  const dst = modelPath(userData);
  if (fs.existsSync(dst) && fs.statSync(dst).size > 1e9) return dst;
  fs.mkdirSync(modelDir(userData), { recursive: true });
  const blob = findOllamaBlob();
  if (blob) {
    onProgress({ phase: 'Preparing model', pct: 0 });
    await copyWithProgress(blob, dst, (pct) => onProgress({ phase: 'Preparing model', pct }));
    return dst;
  }
  if (DEFAULT_URL) {
    onProgress({ phase: 'Downloading model', pct: 0 });
    await downloadWithProgress(DEFAULT_URL, dst, (pct) => onProgress({ phase: 'Downloading model', pct }));
    return dst;
  }
  throw new Error('no model source: no local Ollama gguf and FA_MODEL_URL is unset');
}

module.exports = { modelPath, ensureModel, findOllamaBlob };
