'use strict';

const fs = require('fs');
const path = require('path');

// Plain-text-ish formats we can read directly (no parser needed).
const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'rtf', 'csv', 'tsv', 'json', 'xml',
  'html', 'htm', 'log', 'yml', 'yaml', 'tex',
  'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'rb', 'php',
  'swift', 'kt', 'cs', 'sh', 'sql']);

// Images we OCR on-device (Vision) to read any text they contain — screenshots,
// scanned documents, photos of receipts, etc.
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'heic', 'heif', 'tiff', 'tif', 'bmp', 'gif', 'webp']);

const MAX_CHARS = 500; // excerpt length per file — keep prompts/context manageable
// Don't load huge files into memory to parse (PDF/DOCX/image read the WHOLE file).
// A handful parsed in parallel can spike memory enough to get the app OS-killed;
// over this size we classify by name only.
const MAX_BYTES = 25 * 1024 * 1024;

function squeeze(s) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  // Reject binary/garbage misread as text (e.g. a non-text file with a text-like
  // extension): require the text to be mostly ordinary printable characters.
  if (s) {
    const printable = (s.match(/[\x20-\x7e]/g) || []).length;
    if (printable / s.length < 0.6) return '';
  }
  return s.slice(0, MAX_CHARS);
}
function stripRtf(s) {
  return s.replace(/\\par[d]?/g, '\n').replace(/\{\\\*[^}]*\}/g, '')
    .replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '');
}

// Read just the head of a file (avoid loading huge text files entirely).
function readHead(filePath, bytes = 4000) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Return a short text excerpt of a file's CONTENTS, or '' if not text-bearing /
// unreadable. PDF and .docx use lazily-required parsers so a missing/broken lib
// degrades gracefully instead of crashing.
async function extractText(filePath, nameOrExt) {
  const ext = (nameOrExt ? nameOrExt.split('.').pop() : path.extname(filePath).slice(1)).toLowerCase();
  try {
    if (TEXT_EXTS.has(ext)) {
      const head = readHead(filePath); // text files read only a head, so size is bounded
      return squeeze(ext === 'rtf' ? stripRtf(head) : head);
    }
    // PDF/DOCX/image parsers below read the whole file — skip the oversized ones.
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch { /* ignore */ }
    if (size > MAX_BYTES) return '';
    if (ext === 'pdf') {
      const { PDFParse } = require('pdf-parse'); // v2 API: a class with getText()
      const parser = new PDFParse({ data: fs.readFileSync(filePath) });
      const r = await parser.getText();
      const text = r.text || (r.pages || []).map((p) => p.text).join(' ');
      return squeeze(text);
    }
    if (ext === 'docx') {
      const mammoth = require('mammoth');
      const r = await mammoth.extractRawText({ path: filePath });
      return squeeze(r && r.value);
    }
    if (IMAGE_EXTS.has(ext)) {
      const { analyzeImage } = require('./ocr'); // lazy: only loads Swift helper when needed
      const { text, labels } = await analyzeImage(filePath);
      // Substantial text → it's a document/screenshot/receipt; use the text.
      if (text.replace(/\s/g, '').length >= 12) return squeeze(text);
      // Otherwise a photo — hand the model what it depicts (scene/object labels).
      if (labels.length) return `[image contents: ${labels.join(', ')}]`;
      return '';
    }
  } catch {
    /* unreadable / parse error / lib missing — no excerpt */
  }
  return '';
}

module.exports = { extractText, TEXT_EXTS };
