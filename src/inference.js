'use strict';

// Swappable inference backend so the same app code runs two ways:
//   - dev / direct-download build  → system Ollama server (ollama.js)
//   - App Store (sandboxed) build   → in-process llama.cpp (llama.js)
// Selected at launch via FA_BACKEND ("llama" for in-process, anything else = Ollama).
// All callers should require THIS module, never ollama.js / llama.js directly.

module.exports = process.env.FA_BACKEND === 'llama' ? require('./llama') : require('./ollama');
