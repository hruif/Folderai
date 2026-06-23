'use strict';

// Thin client for a local Ollama instance (http://localhost:11434).
// Everything stays on-device — no data leaves the machine. The app also
// manages the Ollama server lifecycle so the user doesn't have to run it.

const { spawn } = require('child_process');
const fs = require('fs');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

let serverProc = null; // the `ollama serve` process WE started (if any)

// Locate the ollama binary across common install locations, falling back to PATH.
function findOllamaBin() {
  const candidates = [
    '/usr/local/bin/ollama',
    '/opt/homebrew/bin/ollama',
    '/usr/bin/ollama',
    `${process.env.HOME || ''}/.ollama/bin/ollama`,
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return 'ollama';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ensure the Ollama server is reachable: if not, try to start it ourselves and
// wait for it to come up. Returns { ok, started, installed }.
async function ensureServer({ timeoutMs = 15000, parallelism } = {}) {
  if (await isAvailable()) return { ok: true, started: false, installed: true };

  const bin = findOllamaBin();
  try {
    // Reserve exactly as many parallel slots as we'll use, so we don't allocate
    // KV-cache memory for nothing. Parallel handling is the throughput win.
    const slots = String(Math.max(1, parallelism || 2));
    const env = { ...process.env, OLLAMA_NUM_PARALLEL: process.env.OLLAMA_NUM_PARALLEL || slots };
    serverProc = spawn(bin, ['serve'], { detached: true, stdio: 'ignore', env });
    serverProc.unref();
    // If the binary is missing, 'error' fires; swallow so we just report not-ok.
    serverProc.on('error', () => { serverProc = null; });
  } catch {
    return { ok: false, started: false, installed: false };
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(500);
    if (await isAvailable()) return { ok: true, started: true, installed: true };
    if (!serverProc) break; // spawn errored (not installed)
  }
  return { ok: false, started: false, installed: !!serverProc };
}

// Ensure the model is actually loaded and /api/chat can serve. A freshly-started
// server answers /api/tags BEFORE it can serve /api/chat (it 404s during init),
// so issue a tiny request and retry until it responds. Without this, the first
// concurrent classification batches 404, get swallowed, and the run silently
// "keeps everything." Returns true once the model responds.
async function warmupModel(model, { retries = 15, signal } = {}) {
  for (let i = 0; i < retries; i += 1) {
    if (signal && signal.aborted) return false;
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: false, options: { num_ctx: 256 }, messages: [{ role: 'user', content: 'ok' }] }),
        signal,
      });
      if (res.ok) { await res.json().catch(() => {}); return true; } // model loaded + serving
      // 404 (server still initializing) / 503 (loading) → wait and retry
    } catch { /* connection not ready yet */ }
    await sleep(1200);
  }
  return false;
}

// Stop the server only if WE started it (leave a user-run server alone).
function stopServer() {
  if (serverProc && serverProc.pid) {
    try { process.kill(-serverProc.pid); } catch { try { serverProc.kill(); } catch { /* ignore */ } }
    serverProc = null;
  }
}

async function isAvailable() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

async function listModels() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map((m) => m.name);
  } catch {
    return [];
  }
}

// Calls /api/chat with format:json and stream:false, returns parsed object.
// Throws on transport/parse failure so callers can fall back to rules.
async function chatJSON({ model, system, prompt, timeoutMs = 120000, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Abort the in-flight request immediately if the caller's signal fires (Stop).
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        options: { temperature: 0, num_ctx: 4096 },
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    const content = data?.message?.content ?? '';
    return parseLooseJSON(content);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// Streaming variant: calls /api/chat with stream:true and invokes onText with
// the full accumulated content after each chunk, so callers can parse JSON
// incrementally and surface results as they're generated. Returns the full text.
async function chatStream({ model, system, prompt, signal, onText, timeoutMs = 300000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let full = '';
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        format: 'json',
        options: { temperature: 0, num_ctx: 4096 },
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const piece = obj?.message?.content || '';
        if (piece) { full += piece; if (onText) onText(full); }
      }
    }
    return full;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// Small models sometimes wrap JSON in prose or code fences. Be forgiving.
function parseLooseJSON(text) {
  if (!text || typeof text !== 'string') throw new Error('empty model response');
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Grab the first {...} or [...] block.
    const start = cleaned.search(/[\[{]/);
    if (start === -1) throw new Error('no JSON found in model response');
    const open = cleaned[start];
    const close = open === '{' ? '}' : ']';
    const end = cleaned.lastIndexOf(close);
    if (end <= start) throw new Error('unbalanced JSON in model response');
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

module.exports = { isAvailable, listModels, chatJSON, chatStream, ensureServer, warmupModel, stopServer, OLLAMA_HOST };
