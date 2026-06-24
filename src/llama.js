'use strict';

// In-process inference via node-llama-cpp (llama.cpp). NO server, NO subprocess, NO
// bundled executable — it's a linked native library, so it satisfies the macOS App
// Store sandbox where the external Ollama server cannot. This is a drop-in for the
// ollama.js surface the app uses (chatJSON / chatStream / warmup / ensureServer /
// listModels / stopServer). node-llama-cpp is ESM, so we load it via dynamic import.

let _nlcPromise = null;
const nlc = () => (_nlcPromise || (_nlcPromise = import('node-llama-cpp')));

let _llama = null;
let _model = null;
let _modelPath = null;
let _ctx = null;
let _pool = [];          // free ContextSequence objects
const _waiters = [];     // queued sequence acquirers
let _parallel = 2;
let _loadPromise = null;

// Resolve a model NAME ("llama3.2:3b") or a path to a .gguf file. The shipping app
// points FA_GGUF at the model downloaded into userData; tests point it at a gguf.
function resolveModelPath(model) {
  if (model && /\.gguf$/i.test(model)) return model;
  if (process.env.FA_GGUF) return process.env.FA_GGUF;
  return _modelPath;
}

async function loadModel(modelPath) {
  const { getLlama } = await nlc();
  if (!_llama) _llama = await getLlama();
  if (_model && _modelPath === modelPath) return;
  if (_model) { try { await _model.dispose(); } catch { /* */ } _model = null; _ctx = null; _pool = []; }
  _model = await _llama.loadModel({ modelPath });
  _modelPath = modelPath;
  _ctx = await _model.createContext({ contextSize: 4096, sequences: _parallel });
  _pool = [];
  for (let i = 0; i < _parallel; i += 1) _pool.push(_ctx.getSequence());
}

function ensureLoaded(model) {
  const mp = resolveModelPath(model);
  if (!mp) return Promise.reject(new Error('no gguf model path (set FA_GGUF)'));
  if (_model && _modelPath === mp) return Promise.resolve();
  if (!_loadPromise) _loadPromise = loadModel(mp).finally(() => { _loadPromise = null; });
  return _loadPromise;
}

function acquire() {
  if (_pool.length) return Promise.resolve(_pool.pop());
  return new Promise((resolve) => _waiters.push(resolve));
}
function release(seq) {
  const w = _waiters.shift();
  if (w) w(seq); else _pool.push(seq);
}

// Small models sometimes wrap JSON in prose or code fences — be forgiving (mirrors
// ollama.js parseLooseJSON so callers get identical behavior).
function parseLooseJSON(text) {
  if (!text || typeof text !== 'string') throw new Error('empty model response');
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const start = cleaned.search(/[[{]/);
  if (start === -1) throw new Error('no JSON found in model response');
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  const end = cleaned.lastIndexOf(close);
  if (end <= start) throw new Error('unbalanced JSON in model response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// One independent completion on a pooled sequence (cleared first so calls don't leak
// state into each other). temperature 0 + num_ctx 4096 to match the Ollama path.
async function runPrompt({ model, system, prompt, signal, onText }) {
  await ensureLoaded(model);
  const { LlamaChatSession } = await nlc();
  const seq = await acquire();
  try {
    try { await seq.clearHistory(); } catch { /* fresh sequence */ }
    const session = new LlamaChatSession({ contextSequence: seq, systemPrompt: system || '' });
    let full = '';
    const opts = { temperature: 0, maxTokens: 1400 };
    if (signal) opts.signal = signal;
    if (onText) opts.onTextChunk = (t) => { full += t; onText(full); };
    const res = await session.prompt(prompt, opts);
    return onText ? full : res;
  } finally { release(seq); }
}

async function chatJSON({ model, system, prompt, signal }) {
  return parseLooseJSON(await runPrompt({ model, system, prompt, signal }));
}
async function chatStream({ model, system, prompt, signal, onText }) {
  return runPrompt({ model, system, prompt, signal, onText });
}
async function warmupModel(model) { await ensureLoaded(model); return true; }
async function ensureServer({ parallelism } = {}) {
  if (parallelism) _parallel = Math.max(1, parallelism);
  return { ok: true, started: false, installed: true }; // in-process: always available
}
async function isAvailable() { return !!resolveModelPath(''); }
async function listModels() { return resolveModelPath('') ? [{ name: 'llama3.2:3b' }] : []; }

// Free the model + GPU context. MUST run before the process exits or llama.cpp's
// Metal teardown aborts (the crash dump seen on abrupt exit). Wired to app quit.
async function dispose() {
  _waiters.length = 0; _pool = [];
  try { if (_ctx) await _ctx.dispose(); } catch { /* */ }
  try { if (_model) await _model.dispose(); } catch { /* */ }
  _ctx = null; _model = null; _modelPath = null;
}
// Parity with ollama.stopServer (the "Stop model" action / quit) — unload to free RAM.
function stopServer() { dispose().catch(() => {}); }

module.exports = { isAvailable, listModels, chatJSON, chatStream, ensureServer, warmupModel, stopServer, dispose, OLLAMA_HOST: 'in-process' };
