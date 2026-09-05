'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { classifyByRules } = require('./classifier');
const { cacheKey } = require('./cache');
const { listSubfolders } = require('./scanner');
const { extractText } = require('./content');
const { lookup: lookupLearning } = require('./learning');
const ollama = require('./inference'); // swappable: system Ollama (dev) or in-process llama.cpp (App Store)

const DOC_KINDS = new Set(['homework', 'assignment', 'essay', 'paper', 'notes', 'reading', 'document', 'report']);
const OMIT_RETRIES = 2; // re-ask the model for files it skipped in a batch before keeping them as-is
// Summarize-then-classify: distill long document excerpts before tagging so the tagger
// judges by subject, not by boilerplate/headers/OCR noise.
const SUMMARIZE_MIN_CHARS = 280; // only excerpts at least this long are worth a summary call
const MAX_SUMMARY_CHARS = 200;


// --- Tag-based grouping (stage 1: tag each file; stage 2: cluster + place) ---

// Ask the model to OBJECTIVELY identify what each file IS and the semantic
// facets around it. The grouping decision (which folder) is then made by
// deterministic rules, not by the model. Excerpts let it judge by content.
// This is the objective half; folder choice is the conventions half.
function buildTagPrompt(items, guidance = '', content = new Map(), wantName = false) {
  const system =
    'You IDENTIFY what each downloaded file IS — objectively. You do not decide where it goes. ' +
    'When an "excerpt" of contents is given, judge from the CONTENTS, not just the filename. ' +
    'Respond ONLY with JSON.';
  const list = items.map((it) => {
    const o = { id: it.id, name: it.name, sizeBytes: it.size };
    const ex = content.get(String(it.id));
    if (ex) o.excerpt = ex;
    return o;
  });
  const g = guidance.trim() ? `User guidance — take into account: "${guidance.trim()}"\n\n` : '';
  const prompt = g +
    'For each item output OBJECTIVE facts:\n' +
    '  "type": what kind of document/file it is — be specific and factual. Examples: resume, ' +
    'cover letter, invoice, receipt, bank statement, tax document, transcript, contract, ' +
    'certificate, ticket, research paper, thesis, homework, assignment, essay, lecture notes, ' +
    'reading, exam, slides, syllabus, screenshot, photo, music, video, installer, archive, note.\n' +
    '  "subject": the course / topic / project / matter it is ABOUT — e.g. "CSE 446", ' +
    '"French Revolution", "Kitchen Remodel". The BROAD subject only (no dates/quarters/' +
    'assignment numbers). Empty "" if it has no specific subject.\n' +
    '  "domain": a broad life area when clear: taxes, career, finance, school, travel, ' +
    'health, legal, home, insurance, identity, research, software, media. Empty "" if unclear.\n' +
    '  "entity": a named person/company/agency/school/vendor connected to the file, e.g. ' +
    '"IRS", "Acme Corp", "United Airlines", "University of Washington". Empty "" if none.\n' +
    '  "year": a 4-digit year if clearly part of the document period/filing/trip/course, else "".\n' +
    (wantName
      ? '  "name": a clean, descriptive filename (NO extension) from the contents — e.g. ' +
        '"Acme Invoice March 2024", "CSE 446 Homework 3", "Frost Close Reading". Concise, no path.\n'
      : '') +
    'When the name or contents EXPLICITLY name the document type, use that EXACT type — do not ' +
    'swap in a near-synonym: a "Bank Statement" is type "statement" (not "receipt"); a "Bill" ' +
    'is type "bill"; an "Invoice" is "invoice". But a genuinely generic or ambiguous name ' +
    '("document", "untitled", "scan", "file", "new") has NO clear type — leave its subject ' +
    'empty so it stays put; do NOT force a category onto it.\n' +
    'IMPORTANT: a resume that lists skills is still type "resume" (the type is what it IS, not ' +
    'what it mentions). Identify the type from the contents/structure, not surface keywords. ' +
    'If a screenshot or image SHOWS a document (an invoice, receipt, homework, form), use that ' +
    'document\'s type (e.g. "invoice"), NOT "image" or "screenshot".\n' +
    'An excerpt like "[image contents: …]" lists what a photo DEPICTS. If those contents are ' +
    'a document/receipt/screenshot/text, type it as that document. Otherwise it is a personal ' +
    'photo — type "photo" with an EMPTY subject (it should be kept, not split into folders per ' +
    'object or animal).\n' +
    `Return JSON: {"items":[{"id":"...","type":"...","subject":"...","domain":"...","entity":"...","year":"..."${wantName ? ',"name":"..."' : ''}}]}\n\n` +
    'Items:\n' + JSON.stringify(list);
  return { system, prompt };
}

function mapTagRow(row) {
  if (!row || row.id == null) return null;
  return {
    id: String(row.id),
    type: String(row.type || '').trim(),
    subject: String(row.subject || '').trim(),
    domain: String(row.domain || '').trim(),
    entity: String(row.entity || '').trim(),
    year: String(row.year || '').match(/\b(19|20)\d{2}\b/) ? String(row.year || '').match(/\b(19|20)\d{2}\b/)[0] : '',
    name: String(row.name || '').trim(),
    reason: row.reason || '',
  };
}

// Canonicalize a model "group" to a broad, consistent subject so variants merge
// into one cluster: "CSE 446 Spring 2024 Midterm" / "CSE 446546 Winter" -> "CSE 446".
function canonicalGroup(g) {
  let s = String(g || '').trim().replace(/[_\-]+/g, ' '); // normalize separators FIRST so
  if (!s) return '';                                       // "421_HW1_P" tokenizes ("HW1" strippable)
  // Course code wins: 2-5 letters + 3 digits (handles cross-listed "446/546" or
  // "446546" by keeping the first 3; the trailing \b avoids matching years).
  const code = s.match(/\b([A-Za-z]{2,5})\s?-?\s?(\d{3})(?:\d{3}|\/\d{3})?\b/);
  if (code) return `${code[1].toUpperCase()} ${code[2]}`;
  s = s.replace(/\b(spring|summer|fall|autumn|winter)\b/gi, '')
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/gi, '')
    // assignment / sub-part markers (incl. lone "P"/"Q" from "P1"/"Q2" once the index is stripped)
    .replace(/\b(midterm|final|finals|exam|quiz|test|hw|homework|assignment|pset|problem|prob|lecture|module|week|part|chapter|section|unit|page|pg|p|q)\s*\d*\b/gi, '')
    .replace(/\s+\d+\s*$/, '') // a trailing index number ("Close Reading 14" -> "Close Reading")
    .replace(/\s+/g, ' ').trim();
  return s || String(g).trim();
}
// Research papers have distinctive filename FORMATS even with no readable content —
// an arXiv id ("2210.01241", "2210.01241v2"), an old-style arXiv id ("hep-th_9901001"),
// or a DOI-ish name. Group these as "Research Papers" regardless of topic.
function looksLikePaper(name) {
  const stem = name.replace(/\.[^.]+$/, '').trim();
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(stem)) return true;            // modern arXiv
  if (/^[a-z]+(-[a-z]+)?(\.[A-Za-z]{2})?[_/]?\d{7}$/i.test(stem)) return true; // legacy arXiv
  if (/\b10\.\d{4,9}[/_]\S+/.test(stem)) return true;               // DOI
  return false;
}

// Generic/device tokens that carry no information of their own.
const RENAME_GENERIC = new Set(['document', 'documents', 'untitled', 'unnamed', 'file', 'files',
  'copy', 'download', 'downloaded', 'export', 'output', 'final', 'draft', 'new', 'doc', 'scan',
  'scanned', 'image', 'images', 'img', 'photo', 'photos', 'picture', 'pictures', 'screenshot',
  'screenshots', 'capture', 'version', 'temp', 'tmp', 'page', 'pages', 'dsc', 'dscf', 'pxl',
  'dcim', 'vid', 'mov', 'gopr', 'dji', 'pano', 'cimg', 'the', 'and', 'for', 'with', 'of']);
const STRUCT_MARKER = /\b(hw|homework|assignment|pset|problem|reading|readings|lecture|exam|quiz|midterm|finals?|notes?|essay|lab|labs|syllabus|chapter|week|unit|paper|thesis|dissertation|project|review|report|resume|cv|invoice|receipt|statement|bill|tax|contract|agreement|lease|policy|manual|warranty|transcript|cover\s*letter|memo|minutes|agenda|proposal|brief|recipe|itinerary|ticket)\b/;

// A filename already carries STRUCTURE — an arXiv id, a course/code number, an
// assignment/doc-type marker, or ≥2 descriptive words. We leave these alone and
// only propose renames for genuinely random / device / placeholder names.
function looksStructured(name) {
  if (looksLikePaper(name)) return true;
  const norm = name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Pure device/scanner/placeholder name (prefix + digits) → uninformative → DO rename.
  if (/^(img|dsc|dscf|dcim|pxl|mvimg|vid|mov|gopr|dji|pano|cimg|scan|scanned|screenshot|photo|image|picture|document|untitled|unnamed|file|copy|capture|export|download|output|new|final|draft)\s*\d*\s*(\(\d+\))?$/.test(norm)) return false;
  if (/\b\d{3}\b/.test(norm)) return true;                          // course/code number (312, 421)
  if (STRUCT_MARKER.test(norm)) return true;                        // assignment / doc-type marker
  const words = (norm.match(/[a-z]{3,}/g) || []).filter((w) => !RENAME_GENERIC.has(w));
  return words.length >= 2;                                          // ≥2 descriptive words
}

function seriesBase(name) {
  const stem = name.replace(/\.[^.]+$/, '').trim();
  const m = stem.match(/^(.*?[A-Za-z].*?)[\s_\-#(]*\(?\s*\d+\s*\)?\s*$/); // base + trailing number/(n)
  if (m) { const base = m[1].replace(/[\s_\-#(]+$/, '').trim(); if (base.length >= 4) return base; }
  return null;
}

// Turn a model-proposed name into a safe filename BASE (no extension).
function sanitizeName(raw) {
  let s = String(raw || '').trim()
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')          // drop an extension the model appended
    .replace(/[\\/:*?"<>|\n\r\t]+/g, ' ')        // illegal path chars
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');             // no leading/trailing dot or space
  return s.slice(0, 80);
}
// Build the renamed filename (proposed base + ORIGINAL extension), or null when
// the model gave nothing usable or the name wouldn't actually change.
function buildRename(originalName, proposedBase) {
  const ext = path.extname(originalName); // ".pdf"
  let base = sanitizeName(proposedBase);
  if (!base) return null;
  // The model often tacks the extension onto the name ("thing pdf", "thing.pdf");
  // strip a trailing copy of it so we don't produce "thing pdf.pdf".
  const extWord = ext.replace(/^\./, '');
  if (extWord) base = base.replace(new RegExp(`[\\s._-]+${extWord}\\s*$`, 'i'), '').trim();
  if (!base) return null;
  const newName = base + ext;
  // Skip no-ops: same as the original ignoring case, spacing, and punctuation.
  const norm = (s) => String(s).toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '');
  if (norm(newName) === norm(originalName)) return null;
  return newName;
}

const wordRe = (kw) => new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');

// Universal organizing conventions over the model's OBJECTIVE "type" field.
// These are general (how people commonly file things), not per-user.

// Types organized BY TYPE — grouped together regardless of their subject/content.
const TYPE_FOLDERS = [
  ['cover letter', 'Cover Letters'],
  ['curriculum vitae', 'Resume'], ['resume', 'Resume'], ['cv', 'Resume'],
  ['transcript', 'Transcripts'],
  ['invoice', 'Invoices'], ['receipt', 'Receipts'],
  ['bank statement', 'Statements'], ['statement', 'Statements'], ['payslip', 'Statements'], ['pay stub', 'Statements'],
  ['utility bill', 'Bills'], ['bill', 'Bills'],
  ['tax', 'Taxes'],
  ['contract', 'Contracts'], ['agreement', 'Contracts'], ['lease', 'Contracts'], ['nda', 'Contracts'],
  ['boarding pass', 'Tickets'], ['ticket', 'Tickets'], ['itinerary', 'Travel'],
  ['certificate', 'Certificates'], ['diploma', 'Certificates'],
  ['passport', 'IDs'], ['license', 'IDs'], ['id card', 'IDs'],
  ['warranty', 'Warranties'], ['manual', 'Manuals'],
  ['dissertation', 'Research Papers'], ['thesis', 'Research Papers'],
  ['research paper', 'Research Papers'], ['paper', 'Research Papers'],
];
function typeToFolder(type) {
  const n = String(type || '').toLowerCase();
  for (const [kw, f] of TYPE_FOLDERS) if (wordRe(kw).test(n)) return f;
  return null;
}

// Types organized BY SUBJECT (course/topic). Fall back to this bucket if no subject.
const SUBJECT_TYPE_BUCKET = [
  ['close reading', 'Close Readings'],
  ['problem set', 'Homework'], ['pset', 'Homework'], ['homework', 'Homework'],
  ['assignment', 'Homework'], ['worksheet', 'Homework'],
  ['lecture notes', 'Notes'], ['lecture', 'Notes'], ['notes', 'Notes'],
  ['midterm', 'Exams'], ['final exam', 'Exams'], ['exam', 'Exams'], ['quiz', 'Exams'],
  ['essay', 'Essays'], ['reading', 'Readings'],
  ['slides', 'Slides'], ['presentation', 'Slides'], ['syllabus', 'Syllabi'],
  ['study guide', 'Study Guides'], ['lab report', 'Labs'], ['lab', 'Labs'], ['report', 'Reports'],
];
function subjectTypeBucket(type) {
  const n = String(type || '').toLowerCase();
  for (const [kw, f] of SUBJECT_TYPE_BUCKET) if (wordRe(kw).test(n)) return f;
  return null;
}

// Broad preset vocabulary. These are semantic hints and fallbacks, not first
// choice destinations: existing specific folders still win before these labels.
const DOMAIN_FOLDERS = [
  ['tax', 'Taxes'], ['taxes', 'Taxes'], ['irs', 'Taxes'], ['filing', 'Taxes'],
  ['career', 'Career'], ['job', 'Career'], ['employment', 'Career'], ['hiring', 'Career'],
  ['finance', 'Finance'], ['financial', 'Finance'], ['banking', 'Finance'], ['money', 'Finance'],
  ['school', 'School'], ['education', 'School'], ['course', 'School'], ['class', 'School'],
  ['travel', 'Travel'], ['trip', 'Travel'], ['flight', 'Travel'],
  ['health', 'Health'], ['medical', 'Health'], ['doctor', 'Health'],
  ['legal', 'Legal'], ['law', 'Legal'],
  ['home', 'Home'], ['house', 'Home'], ['rent', 'Home'], ['utilities', 'Home'],
  ['insurance', 'Insurance'],
  ['identity', 'IDs'], ['id', 'IDs'],
  ['research', 'Research Papers'],
  ['software', 'Software'],
  ['media', 'Media'],
];
function domainToFolder(domain) {
  const n = String(domain || '').toLowerCase();
  for (const [kw, f] of DOMAIN_FOLDERS) if (wordRe(kw).test(n)) return f;
  return null;
}

// Media / disposable types that have no natural subject grouping.
const MEDIA_RE = /\b(screenshot|photo|image|picture|wallpaper|meme|video|movie|clip|music|audio|song|podcast|installer|application|archive|backup|icon|font|gif|sticker)\b/;
const isMedia = (type) => MEDIA_RE.test(String(type || '').toLowerCase());

const normGroup = (g) => String(g || '').trim().replace(/\s+/g, ' ').toLowerCase();
const TOKEN_ALIASES = new Map([
  ['taxes', 'tax'], ['ids', 'id'], ['resumes', 'resume'], ['invoices', 'invoice'],
  ['receipts', 'receipt'], ['statements', 'statement'], ['bills', 'bill'],
  ['contracts', 'contract'], ['certificates', 'certificate'], ['tickets', 'ticket'],
  ['manuals', 'manual'], ['warranties', 'warranty'], ['transcripts', 'transcript'],
  ['readings', 'reading'], ['notes', 'note'], ['slides', 'slide'], ['exams', 'exam'],
  ['essays', 'essay'], ['reports', 'report'], ['papers', 'paper'], ['photos', 'photo'],
  ['images', 'image'], ['pictures', 'picture'], ['screenshots', 'screenshot'],
]);
const normToken = (t) => TOKEN_ALIASES.get(t) || t;
const tokenSet = (s) => new Set((String(s).toLowerCase().match(/[a-z0-9]+/g) || []).map(normToken));
function jaccard(a, b) {
  const A = tokenSet(a), B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

// Character-level similarity (normalized Levenshtein) over the alnum skeleton of two
// labels. Catches near-identical names that TOKEN overlap misses — plurals/typos/
// spacing the hand-kept alias map doesn't cover ("Finance"↔"Finances", "Machine
// Learning"↔"MachineLearning", "Reciepts"↔"Receipts"). Borrowed from ai-file-sorter's
// taxonomy de-duplication (it snaps the model's label to an existing one at sim≥0.85).
function editSim(a, b) {
  const x = String(a || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const y = String(b || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  const m = x.length, n = y.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return 1 - prev[n] / Math.max(m, n);
}
// editSim, but only when both labels are long enough that a high score is meaningful
// — so a one-char diff on a short word ("Taxes"↔"Faxes") can't masquerade as a folder
// match. Returns 0 below the gates; otherwise the raw similarity.
const EDIT_SIM_MIN = 0.86;
const EDIT_SIM_MIN_LEN = 5;
function gatedEditSim(a, b) {
  const la = String(a || '').replace(/[^a-z0-9]/gi, '').length;
  const lb = String(b || '').replace(/[^a-z0-9]/gi, '').length;
  if (Math.min(la, lb) < EDIT_SIM_MIN_LEN) return 0;
  const s = editSim(a, b);
  return s >= EDIT_SIM_MIN ? s : 0;
}

// Decide ONE destination for a whole cluster (a subject group). Route to an
// existing folder ONLY on real token overlap (so unrelated folders aren't
// grabbed); otherwise propose a new, well-named folder.
// Distinctive identifiers in a name: standalone 3-digit course codes (444) and
// letter+digit course codes (cse444). Deliberately NOT bare 4-digit numbers, so
// years (2024) don't cause false matches.
function codesOf(s) {
  const out = new Set();
  const n = String(s || '').toLowerCase();
  for (const m of n.matchAll(/(?<!\d)\d{3}(?!\d)/g)) out.add(m[0]);
  for (const m of n.matchAll(/[a-z]{2,6}\d{3,4}/g)) out.add(m[0]);
  return out;
}
function sharesCode(codes, name) {
  if (!codes.size) return false;
  const other = codesOf(name);
  for (const c of codes) if (other.has(c)) return true;
  return false;
}

const GENERIC_MATCH_TOKENS = new Set(['new', 'misc', 'other', 'general', 'document', 'documents',
  'file', 'files', 'folder', 'folders', 'personal', 'stuff', 'items', 'item']);
function subsetScore(group, name) {
  const A = tokenSet(group), B = tokenSet(name);
  if (!A.size || !B.size) return 0;
  let contained = true;
  for (const x of A) if (!B.has(x)) contained = false;
  if (!contained) return 0;
  const meaningful = [...A].filter((x) => !GENERIC_MATCH_TOKENS.has(x));
  if (!meaningful.length) return 0;
  return A.size === B.size ? 1 : 0.72;
}

function folderMatchScore(group, name) {
  return Math.max(jaccard(group, name), subsetScore(group, name), gatedEditSim(group, name));
}

function cleanGroupLabel(group) {
  return String(group || '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60) || 'Misc';
}

// Strip the prose a model sometimes wraps around a label so "the Taxes folder" /
// "Category: CSE 446" collapse to the bare subject. Conservative: removes leading
// articles, a structural "Category:/Folder:" prefix, a trailing "folder/directory"
// word, and illegal path chars — never trailing content words like "Documents"/
// "Papers" (those are real folder names). Mirrors ai-file-sorter's label cleanup,
// adapted to our structured tags. May return '' (caller drops empty labels).
const LABEL_LEAD = /^(the|a|an|my|our|your)\s+/i;
const LABEL_TRAIL = /\s+(folder|directory|subfolder)$/i;
function sanitizeLabel(raw) {
  let s = String(raw || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(sub-?category|category|folder|topic|subject)\s*[:\-]\s*/i, '').trim();
  let prev;
  do { prev = s; s = s.replace(LABEL_LEAD, '').replace(LABEL_TRAIL, '').trim(); } while (s !== prev);
  return s;
}

function findExistingDestForGroup(group, dests, minScore = 0.6) {
  const gcodes = codesOf(group);
  let best = null, bestScore = 0, bestSub = null;
  for (const d of dests || []) {
    const name = d.label.split('/').pop();
    let score = folderMatchScore(group, name);
    if (sharesCode(gcodes, name)) score = Math.max(score, 0.9);          // "444" ↔ "cse444"
    if (score > bestScore) { bestScore = score; best = d; bestSub = null; }
    // Also match the folder's EXISTING subfolders (one level deeper), so "444" lands
    // in the user's ~/Documents/CSE/444 rather than a fresh folder.
    for (const sf of (d.subfolders || [])) {
      let ss = Math.max(folderMatchScore(group, sf), folderMatchScore(group, `${name} ${sf}`));
      if (sharesCode(gcodes, sf)) ss = Math.max(ss, 0.95);
      if (ss > bestScore) { bestScore = ss; best = d; bestSub = sf; }
    }
  }
  if (!best || bestScore < minScore) return null;
  if (bestSub) return { category: `${best.label}/${bestSub}`, destPath: path.join(best.path, bestSub), score: bestScore };
  return { category: best.label, destPath: best.path, score: bestScore };
}

function bestExistingDestination(groups, dests) {
  let best = null;
  for (const g of groups || []) {
    if (!g || !g.label) continue;
    const found = findExistingDestForGroup(g.label, dests);
    if (!found) continue;
    const scored = { ...found, label: g.label, basis: g.basis, score: found.score || 0 };
    if (!best || scored.score > best.score) best = scored;
  }
  return best;
}

function newDocumentsDestination(label) {
  const clean = cleanGroupLabel(label);
  // Only document-type files reach grouping (media is kept), so a new folder goes
  // under ~/Documents by default.
  return { category: `~/Documents/${clean}`, destPath: path.join(os.homedir(), 'Documents', clean) };
}

function destForGroup(group, kind, dests) {
  const existing = findExistingDestForGroup(group, dests);
  if (existing) return { category: existing.category, destPath: existing.destPath };
  return newDocumentsDestination(group);
}

// Clean a model-proposed destination into a safe relative path. Allows nested
// folders ("Documents/Taxes") but strips traversal and illegal characters.
function cleanDest(raw) {
  return String(raw || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => sanitizeLabel(s))
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/')
    .slice(0, 120);
}

// Build a staged action for one item.
// c may carry: category (display label/relative path), destPath (absolute target
// dir, for cross-location moves), deleteSuggested | keep, reason, source.
function toAction(item, c) {
  const category = c.category || 'Other';
  const action = c.deleteSuggested ? 'delete' : c.keep ? 'keep' : 'group';
  return {
    id: item.id,
    name: item.name,
    path: item.path,
    isDir: item.isDir,
    size: item.size,
    mtime: item.mtime,
    category,                       // display label, e.g. "~/Documents/Taxes"
    destPath: c.destPath || null,   // absolute target dir when moving across locations
    action,                         // 'group' | 'delete' | 'keep'
    reason: c.reason || '',
    rename: c.rename || null,        // proposed new filename (with ext), or null to keep name
    tags: c.tags || null,            // semantic facets + basis — for learning from corrections
    excerpt: c.excerpt || '',        // content excerpt (text/OCR/labels) — for search
    ext: (item.name.includes('.') ? item.name.split('.').pop().toLowerCase() : ''),
    proposed: { action, category, destPath: c.destPath || null }, // what we suggested (vs user's final)
    include: true,                  // staged-in by default; user can deselect
    source: c.source || 'rules',
  };
}

const MIN_FILES_FOR_NEW_FOLDER = 2;

function pathExists(absPath) {
  try { return fs.existsSync(absPath); } catch { return false; }
}

function destPathForAction(a, scanRoot = '') {
  if (!a || a.action !== 'group') return null;
  if (a.destPath && path.isAbsolute(a.destPath)) return path.resolve(a.destPath);
  const category = String(a.category || '').trim();
  if (!category || category === 'Other') return null;
  if (category.startsWith('~/')) return path.resolve(os.homedir(), category.slice(2));
  if (path.isAbsolute(category)) return path.resolve(category);
  if (scanRoot) return path.resolve(scanRoot, category);
  return null;
}

function categoryForPath(absPath, scanRoot = '') {
  const home = os.homedir();
  const resolved = path.resolve(absPath);
  if (resolved === home) return '~';
  if (resolved.startsWith(home + path.sep)) {
    return '~/' + path.relative(home, resolved).split(path.sep).join('/');
  }
  if (scanRoot) {
    const root = path.resolve(scanRoot);
    if (resolved.startsWith(root + path.sep)) {
      return path.relative(root, resolved).split(path.sep).join('/');
    }
  }
  return resolved;
}

function knownExistingFolderPaths(actions, dests = []) {
  const out = new Set();
  for (const d of dests || []) {
    if (!d || !d.path) continue;
    const base = path.resolve(d.path);
    out.add(base);
    for (const sf of d.subfolders || []) out.add(path.resolve(base, sf));
  }
  for (const a of actions || []) {
    if (a && a.isDir && a.path) out.add(path.resolve(a.path));
  }
  return out;
}

function isUserDirectedMove(a) {
  return a && a.source === 'prompt';
}

// Avoid the product smell of creating a brand-new folder for one lonely file.
// Existing destination folders are still fine, and explicit user/manual moves
// are left alone. If several singleton leaf folders share a new parent, collapse
// those files up to the parent so we still create one useful grouping folder.
function avoidSingletonNewFolders(actions, dests = [], scanRoot = '') {
  const knownExisting = knownExistingFolderPaths(actions, dests);
  const existsCache = new Map();
  const isExisting = (p) => {
    const key = path.resolve(p);
    if (knownExisting.has(key)) return true;
    if (!existsCache.has(key)) existsCache.set(key, pathExists(key));
    return existsCache.get(key);
  };

  const candidates = [];
  const descendantCounts = new Map();
  for (const a of actions || []) {
    if (!a || a.isDir || a.action !== 'group' || isUserDirectedMove(a)) continue;
    const dest = destPathForAction(a, scanRoot);
    if (!dest || isExisting(dest)) continue;
    candidates.push({ action: a, dest });
    let cur = dest;
    while (cur && !isExisting(cur)) {
      descendantCounts.set(cur, (descendantCounts.get(cur) || 0) + 1);
      const parent = path.dirname(cur);
      if (!parent || parent === cur) break;
      cur = parent;
    }
  }

  let kept = 0;
  let collapsed = 0;
  for (const { action, dest } of candidates) {
    if ((descendantCounts.get(dest) || 0) >= MIN_FILES_FOR_NEW_FOLDER) continue;

    let collapseTo = null;
    let parent = path.dirname(dest);
    while (parent && parent !== dest && !isExisting(parent)) {
      if ((descendantCounts.get(parent) || 0) >= MIN_FILES_FOR_NEW_FOLDER) {
        collapseTo = parent;
        break;
      }
      const next = path.dirname(parent);
      if (!next || next === parent) break;
      parent = next;
    }

    if (collapseTo) {
      action.category = categoryForPath(collapseTo, scanRoot);
      action.destPath = collapseTo;
      action.reason = 'Grouped together; skipped a one-file subfolder';
      action.proposed = { action: action.action, category: action.category, destPath: action.destPath };
      collapsed += 1;
    } else {
      action.action = 'keep';
      action.category = 'Other';
      action.destPath = null;
      action.rename = null;
      action.reason = 'Left here; new folders need at least 2 files';
      action.include = true;
      action.proposed = { action: 'keep', category: 'Other', destPath: null };
      kept += 1;
    }
  }
  return { kept, collapsed, changed: kept + collapsed };
}

function addPlacementGroup(out, label, basis, kind = 'document') {
  const clean = sanitizeLabel(label);
  if (!clean) return;
  const preserveYear = basis.endsWith('Year') || /\b(19|20)\d{2}\b/.test(clean);
  const canon = preserveYear ? cleanGroupLabel(clean) : canonicalGroup(clean);
  if (!canon) return;
  const key = `${basis}:${normGroup(canon)}`;
  if (out.some((g) => g.key === key)) return;
  out.push({ key, label: canon, basis, kind });
}

// Similarity at/above which two NEW-folder labels are treated as the same folder
// (within-run convergence and the post-hoc harmonization merge). subsetScore's 0.72
// stays below this on purpose, so a generic label isn't merged into a specific one.
const NEW_FOLDER_MERGE_MIN = 0.8;

function routeNewGroup(group, clusterDest) {
  const key = `${group.basis}:${normGroup(group.label)}`;
  const existing = clusterDest.get(key);
  if (existing) return existing;
  // Within-run consistency: if an earlier file this run already opened a new folder
  // for a near-identical subject ("Receipts"↔"Receipt", "Machine Learning"↔
  // "MachineLearning"), reuse it instead of forking a second folder. ai-file-sorter
  // biases toward prior same-session assignments for exactly this reason.
  for (const prior of clusterDest.values()) {
    if (prior.label && folderMatchScore(group.label, prior.label) >= NEW_FOLDER_MERGE_MIN) {
      clusterDest.set(key, prior); // alias this label onto the folder already chosen
      return prior;
    }
  }
  const dest = { ...newDocumentsDestination(group.label), label: group.label };
  clusterDest.set(key, dest);
  return dest;
}

function actionForPlacement(dest, tags, basis, reason) {
  const placedTags = { ...tags, basis };
  return {
    category: dest.category,
    destPath: dest.destPath,
    reason,
    tags: placedTags,
  };
}

function choosePlacementForTag(item, tag = {}, dests = [], clusterDest = new Map()) {
  const t = {
    type: String(tag.type || '').trim(),
    subject: String(tag.subject || '').trim(),
    domain: String(tag.domain || '').trim(),
    entity: String(tag.entity || '').trim(),
    year: String(tag.year || '').trim(),
  };
  const tags = { ...t, basis: '' };
  const typeFolder = (looksLikePaper(item.name) ? 'Research Papers' : null) || typeToFolder(t.type);
  const domainFolder = domainToFolder(t.domain);
  const bucket = subjectTypeBucket(t.type);

  // Keep generic/personal media unless another facet makes it meaningfully fileable.
  if (isMedia(t.type) && !t.subject && !t.entity && (!domainFolder || domainFolder === 'Media')) {
    return { keep: true, reason: t.type || 'Media file', tags };
  }

  const specific = [];
  const series = seriesBase(item.name);
  if (t.subject) addPlacementGroup(specific, t.subject, 'subject', t.type || 'document');
  if (domainFolder && t.year) addPlacementGroup(specific, `${domainFolder} ${t.year}`, 'domainYear', t.type || 'document');
  if (typeFolder && t.year) addPlacementGroup(specific, `${typeFolder} ${t.year}`, 'typeYear', t.type || 'document');
  if (t.entity && t.year) addPlacementGroup(specific, `${t.entity} ${t.year}`, 'entityYear', t.type || 'document');
  if (t.entity) addPlacementGroup(specific, t.entity, 'entity', t.type || 'document');
  if (series && !typeFolder) addPlacementGroup(specific, series, 'series', t.type || 'document');

  const broad = [];
  if (domainFolder) addPlacementGroup(broad, domainFolder, 'domain', t.type || 'document');
  if (typeFolder) addPlacementGroup(broad, typeFolder, 'type', t.type || 'document');
  if (bucket) addPlacementGroup(broad, bucket, 'bucket', t.type || 'document');

  const existingSpecific = bestExistingDestination(specific, dests);
  if (existingSpecific) {
    return actionForPlacement(existingSpecific, tags, existingSpecific.basis, t.type || existingSpecific.label);
  }

  const existingBroad = bestExistingDestination(broad, dests);
  if (existingBroad) {
    return actionForPlacement(existingBroad, tags, existingBroad.basis, t.type || existingBroad.label);
  }

  // If no existing folder fits, create the most specific useful cluster first.
  // Broad presets are only fallbacks; singleton-new-folder cleanup can still
  // keep one-off files from creating clutter.
  const newSpecific = specific[0];
  if (newSpecific) {
    return actionForPlacement(routeNewGroup(newSpecific, clusterDest), tags, newSpecific.basis, t.type || newSpecific.label);
  }

  const broadFallback = broad[0];
  if (broadFallback) {
    return actionForPlacement(routeNewGroup(broadFallback, clusterDest), tags, broadFallback.basis, t.type || broadFallback.label);
  }

  return { keep: true, reason: t.type || 'No clear subject', tags };
}

// Rules-only plan — instant, always works.
function planByRules(items) {
  return items.map((it) => toAction(it, { ...classifyByRules(it), source: 'rules' }));
}

// Describe candidate destinations (across Downloads/Documents/Desktop/…) so the
// model can route INTO the user's real folders, respecting how each is organized.
function describeDestinations(dests) {
  if (!dests || !dests.length) return '(no existing destination folders found)';
  return dests.map((d) => {
    const bits = [];
    if (d.isProject) bits.push('CODE/PROJECT folder — code only, do NOT put documents/essays/media here');
    if (d.layout === 'subfolders-only') {
      bits.push('holds ONLY subfolders — never place a file directly here; it will be ' +
        'drilled into the right subfolder');
      if (d.subfolders && d.subfolders.length) bits.push(`subfolders: ${d.subfolders.slice(0, 12).join(', ')}`);
    } else if (d.layout === 'files-only') {
      bits.push('holds files');
      if (d.sampleFiles && d.sampleFiles.length) bits.push(`e.g. ${d.sampleFiles.slice(0, 3).join(', ')}`);
    } else if (d.layout === 'mixed') {
      bits.push('holds files and subfolders');
    } else {
      bits.push('empty');
    }
    return `- "${d.label}": ${bits.join('; ')}`;
  }).join('\n');
}

// Build the classification prompt for a batch of files. `content` maps an item
// id to a short excerpt of its actual contents (for text-bearing files).
function buildClassifyPrompt(items, dests, guidance = '', content = new Map()) {
  const system =
    'You tidy downloaded files into the user\'s EXISTING folders across their system ' +
    '(Downloads, Documents, Desktop, …). Do not impose generic type-based folders. Pick ' +
    'the destination that best matches where the user already keeps such things. When an ' +
    'item includes an "excerpt" of its contents, judge by the SUBJECT of that text, not the ' +
    'filename. Respond ONLY with JSON.';

  const list = items.map((it) => {
    const o = { id: it.id, name: it.name, type: it.isDir ? 'folder' : 'file', sizeBytes: it.size };
    const ex = content.get(String(it.id));
    if (ex) o.excerpt = ex;
    return o;
  });
  const guidanceBlock = guidance.trim()
    ? `The user gave this guidance — follow it closely:\n"${guidance.trim()}"\n\n` : '';

  const prompt =
    guidanceBlock +
    'Candidate destination folders (use the EXACT label):\n' +
    describeDestinations(dests) + '\n\n' +
    'Many items include an "excerpt" of their contents. When the filename is vague (e.g. an ' +
    'essay or assignment), use the excerpt\'s topic to decide where it belongs.\n' +
    'For each item choose "dest":\n' +
    '  - an exact label from the list above (preferred), OR\n' +
    '  - "keep" to leave it in place, OR\n' +
    '  - "delete" for clearly disposable clutter (temp/incomplete downloads, empties, junk), OR\n' +
    '  - "new:<Label>/<Name>" to propose a new folder under an existing location.\n' +
    'When the name or contents clearly indicate a subject/category:\n' +
    '  - route to an EXISTING folder that matches it (the most specific one), OR\n' +
    '  - if NO existing folder matches, PROPOSE A NEW FOLDER named after that subject, e.g. ' +
    '"new:~/Documents/CSE 451" for that course\'s materials or "new:~/Documents/History" for ' +
    'a history essay. Grouping related files into a new, well-named folder is GOOD — do it ' +
    'rather than leaving them loose.\n' +
    '  - use the SAME new-folder name for every file of the same subject.\n' +
    'Choose "keep" ONLY when the subject is genuinely unclear (e.g. a vague personal note, ' +
    '"misc", a screenshot with no context). Do NOT keep a file just because no folder exists yet.\n' +
    'NEVER place documents, essays, homework, PDFs, or images into a CODE/PROJECT folder.\n' +
    'Files that share a base name (a numbered/dated series like "Close Reading 1", ' +
    '"Close Reading 2") MUST get the SAME destination — never split a series.\n' +
    'ALWAYS include a short "reason" (a few words) so the choice is understandable.\n\n' +
    'Return JSON: {"items":[{"id":"...","dest":"...","reason":"..."}]}\n\n' +
    'Items:\n' + JSON.stringify(list);

  return { system, prompt };
}

// Map one model row to a classification result. byLabel resolves a destination
// label to its absolute path (and folder object, for deep-drilling).
function mapClassifyRow(row, byLabel) {
  if (!row || row.id == null) return null;
  const dest = String(row.dest || '').trim();
  const low = dest.toLowerCase();
  let m;
  if (low === 'delete') {
    m = { deleteSuggested: true, reason: row.reason || '' };
  } else if (low === 'keep' || !dest) {
    m = { keep: true, reason: row.reason || 'Kept in place' };
  } else if (low.startsWith('new:')) {
    const label = cleanDest(dest.slice(4));
    m = label ? { category: label, destPath: null, isNew: true, reason: row.reason || '' }
      : { keep: true, reason: 'Kept (unclear new folder)' };
  } else if (byLabel.has(dest)) {
    const d = byLabel.get(dest);
    m = { category: d.label, destPath: d.path, dest: d, reason: row.reason || '' };
  } else {
    m = { keep: true, reason: row.reason || 'Kept (no matching destination)' };
  }
  return { id: String(row.id), m };
}

// A "series key" for a filename — its base name with a trailing number/counter
// stripped, so "Close Reading 1", "Close Reading 2", "Close Reading (3)" share one key.
function seriesKey(name) {
  let s = name.replace(/\.[^.]+$/, '');               // drop extension
  s = s.replace(/[\s_().\-]*\d+\)?\s*$/, '');          // drop trailing number/counter
  return s.trim().toLowerCase();
}

// Enforce consistency across same-series files (which batching can scatter): for
// any series of >=3 files, send them all to the plurality destination. Never
// forces deletion. Returns how many actions were changed.
function reconcileSeries(actions) {
  const groups = new Map();
  for (const a of actions) {
    if (a.isDir || a.action === 'delete') continue;
    const k = seriesKey(a.name);
    if (k.length < 4) continue; // too short to be a meaningful series name
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  let changed = 0;
  for (const [k, list] of groups) {
    if (list.length < 3) continue;
    const tally = new Map(); // destKey -> { count, category, destPath }
    for (const a of list) {
      if (a.action !== 'group') continue;
      const dk = `${a.category}|${a.destPath || ''}`;
      const e = tally.get(dk) || { count: 0, category: a.category, destPath: a.destPath || null };
      e.count += 1; tally.set(dk, e);
    }
    let best = null;
    for (const e of tally.values()) if (!best || e.count > best.count) best = e;
    if (!best || best.count < 2) continue; // no clear common destination
    for (const a of list) {
      if (a.action === 'group' && a.category === best.category && (a.destPath || null) === best.destPath) continue;
      a.action = 'group';
      a.category = best.category;
      a.destPath = best.destPath;
      a.reason = `Grouped with the "${k.trim()}" series`;
      a.source = 'ai';
      changed += 1;
    }
  }
  return changed;
}

// Incremental parser: fed the growing model output, returns any newly-completed
// top-level objects inside the "items" array as soon as each one closes. Stateful
// across calls (a fresh streamer per request). Respects strings/escapes.
function makeItemStreamer() {
  let i = 0, started = false, depth = 0, objStart = -1, inStr = false, esc = false;
  return function push(text) {
    const out = [];
    while (i < text.length) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (!started) {
        if (c === '[') started = true; // enter the items array
      } else if (c === '"') {
        inStr = true;
      } else if (c === '{') {
        if (depth === 0) objStart = i;
        depth += 1;
      } else if (c === '}') {
        depth -= 1;
        if (depth === 0 && objStart !== -1) {
          try { out.push(JSON.parse(text.slice(objStart, i + 1))); } catch { /* skip malformed */ }
          objStart = -1;
        }
      }
      i += 1;
    }
    return out;
  };
}

// Drill into a chosen destination's subtree to find the most specific folder for
// `file`. One follow-up model call, reading subfolders on demand (depth-capped).
async function resolveDeepDest(file, dest, model, guidance, signal) {
  const subs = listSubfolders(dest.path);
  if (!subs.length) return { category: dest.label, destPath: dest.path };

  // Gather descendant subfolders (relative labels) up to a small depth/count cap.
  const rels = [];
  const walk = (dir, rel, depth) => {
    if (depth > 3 || rels.length >= 60) return;
    for (const s of listSubfolders(dir)) {
      const r = rel ? `${rel}/${s.name}` : s.name;
      rels.push(r);
      walk(s.path, r, depth + 1);
    }
  };
  walk(dest.path, '', 1);

  const subfoldersOnly = dest.layout === 'subfolders-only';
  const system = 'You place a file into the most specific subfolder of a chosen area, ' +
    'respecting the user\'s structure. Respond ONLY with JSON.';
  const prompt =
    (guidance.trim() ? `User guidance: "${guidance.trim()}"\n\n` : '') +
    `File: "${file.name}"\nChosen area: "${dest.label}"\n` +
    `Subfolders (relative to the area):\n${rels.map((r) => `- ${r}`).join('\n')}\n\n` +
    'Choose "choice":\n  - a relative subfolder path from the list (most specific match), OR\n' +
    (subfoldersOnly
      ? '  - "new:<relative path>" to create a new subfolder (this area holds only subfolders, so do NOT choose "here").\n'
      : '  - "here" to place it directly in the area, OR\n  - "new:<relative path>" for a new subfolder.\n') +
    'Return JSON {"choice":"...","reason":"..."}';

  let choice = '';
  try {
    const data = await ollama.chatJSON({ model, system, prompt, signal });
    choice = String(data?.choice || '').trim();
  } catch (err) {
    if (signal && signal.aborted) throw err; // propagate cancellation, don't swallow
    choice = '';
  }

  const low = choice.toLowerCase();
  if (low === 'here' || !choice) {
    if (subfoldersOnly) {
      // Don't drop a naked file into a subfolders-only area.
      return { category: `${dest.label}/Unsorted`, destPath: `${dest.path}/Unsorted` };
    }
    return { category: dest.label, destPath: dest.path };
  }
  const rel = low.startsWith('new:') ? cleanDest(choice.slice(4)) : cleanDest(choice);
  if (!rel) return { category: dest.label, destPath: dest.path };
  return { category: `${dest.label}/${rel}`, destPath: `${dest.path}/${rel}` };
}

// Apply one model classification result `m` to the plan, with the deletion
// guardrail: the model may organize (move/keep) freely, but must NOT invent
// deletions of real content. Only honor an AI delete if the deterministic
// rules already flagged this item for deletion; otherwise downgrade to keep.
function applyModelResult(actions, idx, it, m) {
  if (m.deleteSuggested && actions[idx].action !== 'delete') {
    actions[idx] = toAction(it, {
      keep: true, source: 'ai',
      reason: 'Kept (AI suggested deletion, but deletion is left to rules / your request)',
    });
  } else {
    actions[idx] = toAction(it, { ...m, source: 'ai' });
  }
}

// Distill a batch of document excerpts into one short factual line each (type +
// subject), ignoring boilerplate. One model call for the whole batch keeps the extra
// cost to ~1 call per BATCH. Returns Map<id, summary>. ai-file-sorter summarizes per
// file before categorizing; batching is our concession to a small local model's speed.
async function summarizeExcerpts(items, content, model, signal) {
  const list = items.map((it) => ({ id: it.id, name: it.name, excerpt: content.get(String(it.id)) }));
  const system = 'You distill each document into ONE short factual line: what it IS and ' +
    'what it is ABOUT (its subject/topic). Ignore boilerplate, headers, page numbers, and ' +
    'navigation text. No preamble. Respond ONLY with JSON.';
  const prompt =
    'For each item write "summary": a single concise sentence capturing the document type ' +
    'and its subject, based on the excerpt.\n' +
    'Return JSON: {"items":[{"id":"...","summary":"..."}]}\n\n' +
    'Items:\n' + JSON.stringify(list);
  const out = new Map();
  try {
    const data = await ollama.chatJSON({ model, system, prompt, signal });
    const rows = (data && Array.isArray(data.items)) ? data.items : [];
    for (const r of rows) {
      if (!r || r.id == null) continue;
      out.set(String(r.id), String(r.summary || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_CHARS));
    }
  } catch (err) {
    if (signal && signal.aborted) throw err; // propagate cancellation; otherwise keep raw excerpts
  }
  return out;
}

// Refine an existing rule-based plan with the model, one batch at a time.
// Calls onBatch({ done, total, actions, hits }) after each batch so the UI can show
// progress and update rows live. `shouldStop()` lets the caller cancel.
// `cache` (optional, from src/cache.js) reuses results for unchanged files.
async function refineWithModel(actions, dests, model, onBatch = () => {}, shouldStop = () => false, guidance = '', cache = null, ignoreCache = false, signal, concurrency = 2, rename = false, learning = null, summarize = false) {
  const idById = new Map(actions.map((a, i) => [String(a.id), i]));
  // Only classify loose top-level FILES. Existing folders are the structure
  // (and inform destinations); we never try to reorganize them.
  const files = actions.filter((a) => !a.isDir);
  const total = files.length;
  let done = 0;
  let hits = 0;

  // Unstage every file the AI will touch; each re-stages (via toAction) the
  // moment it's classified. This prevents executing half-classified plans and
  // lets the user watch decisions land as the model works.
  for (const a of files) a.include = false;

  // 0) Deterministic deletions already decided (junk + duplicates) are final —
  //    keep them staged, count them done, and exclude them from cache/AI.
  for (const it of files) {
    const idx = idById.get(String(it.id));
    if (actions[idx].action === 'delete') { actions[idx].include = true; done += 1; }
  }

  // 1) Apply cache hits for unchanged files instantly — no model call.
  const misses = [];
  for (const it of files) {
    if (actions[idById.get(String(it.id))].action === 'delete') continue; // already final
    const cached = (cache && !ignoreCache) ? cache.get(cacheKey(it, guidance)) : undefined;
    if (cached) {
      // Don't apply a cached rename when renaming is off this run.
      applyModelResult(actions, idById.get(String(it.id)), it, rename ? cached : { ...cached, rename: null });
      hits += 1; done += 1;
    } else {
      misses.push(it);
    }
  }
  if (done) onBatch({ done, total, actions, hits });

  // 2) Misses go to the model in STREAMED batches. Several batches run
  //    concurrently (CONCURRENCY) — Ollama processes them in parallel for a big
  //    throughput win. Shared state (done, actions, cache) is safe to mutate
  //    since JS runs cooperatively (no true parallel writes).
  const BATCH = Math.max(1, Number(process.env.FA_BATCH) || 12); // files per model call (tunable)
  const CONCURRENCY = Math.max(1, concurrency | 0);
  const cacheFinal = (it, m) => {
    if (!cache) return;
    const { dest, ...stored } = m;
    cache.set(cacheKey(it, guidance), { ...stored, _path: it.path });
  };

  // Shared across all batches/workers: each new semantic group -> its single
  // destination. The FIRST file of a group decides it; the rest follow — so a
  // group is never split and never lands in two places.
  const clusterDest = new Map();
  function placeByTag(it, t) {
    return choosePlacementForTag(it, t, dests, clusterDest);
  }

  // Process one batch: tag each file (streamed), then cluster-place it.
  async function processBatch(batch) {
    const batchById = new Map(batch.map((it) => [String(it.id), it]));
    const seen = new Set();

    // Excerpt of each file's CONTENTS so the model tags by subject, not name.
    // (Huge files are skipped inside extractText, so this stays memory-bounded.)
    const content = new Map();
    await Promise.all(batch.map(async (it) => {
      if (it.isDir) return;
      try {
        const ex = await extractText(it.path, it.name);
        if (ex) content.set(String(it.id), ex);
      } catch { /* unreadable/corrupt/locked file — classify by name only */ }
    }));

    // For TAGGING, optionally distill long/noisy document excerpts into a one-line
    // summary (one model call for the whole batch). The RAW excerpt is still stored
    // on the action for content search — only the tag prompt sees the summary.
    const tagContent = new Map(content);
    if (summarize) {
      const longOnes = batch.filter((it) => {
        const ex = content.get(String(it.id));
        return ex && ex.length >= SUMMARIZE_MIN_CHARS && !ex.startsWith('[image contents:');
      });
      if (longOnes.length) {
        try {
          const sums = await summarizeExcerpts(longOnes, content, model, signal);
          for (const [id, s] of sums) if (s) tagContent.set(id, s);
        } catch { /* aborted or model error — fall back to raw excerpts */ }
      }
    }

    const finalize = (it, m, cache = true) => {
      applyModelResult(actions, idById.get(String(it.id)), it, m);
      done += 1;
      if (cache) cacheFinal(it, m); // a "not classified" fallback is NOT cached — retry next run
      onBatch({ done, total, actions, hits });
    };

    // Run the model over a set of items, finalizing each one it returns.
    const classify = async (items) => {
      if (!items.length) return;
      try {
        const { system, prompt } = buildTagPrompt(items, guidance, tagContent, rename);
        const streamer = makeItemStreamer();
        await ollama.chatStream({
          model, system, prompt, signal,
          onText: (full) => {
            for (const row of streamer(full)) {
              const t = mapTagRow(row);
              if (!t) continue;
              const it = batchById.get(t.id);
              if (!it || seen.has(t.id)) continue;
              seen.add(t.id);
              // Preserve a junk deletion the deterministic rules already flagged.
              if (actions[idById.get(t.id)].action === 'delete') { done += 1; onBatch({ done, total, actions, hits }); continue; }
              const m = placeByTag(it, t);
              // Only rename genuinely random/placeholder names — leave structured ones
              // (homeworks, close readings, papers, descriptive names) untouched.
              if (rename && t.name && !looksStructured(it.name)) m.rename = buildRename(it.name, t.name);
              m.excerpt = content.get(t.id) || ''; // keep the content excerpt for search
              finalize(it, m);
            }
          },
        });
      } catch { /* aborted / model error */ }
    };

    await classify(batch);
    // A model can drop items from a batch response (or truncate). Re-ask for just
    // the skipped ones — a smaller prompt usually succeeds — before giving up.
    const stillMissing = () => batch.filter((it) => !seen.has(String(it.id)) && actions[idById.get(String(it.id))].action !== 'delete');
    for (let r = 0; r < OMIT_RETRIES && !shouldStop(); r += 1) {
      const missing = stillMissing();
      if (!missing.length) break;
      await classify(missing);
    }
    if (shouldStop()) return;

    for (const it of batch) { // model skipped this file even after retries
      if (seen.has(String(it.id))) continue;
      const idx = idById.get(String(it.id));
      if (actions[idx].action === 'delete') { done += 1; continue; }
      // DETERMINISTIC RESCUE: run placeByTag with empty tags so an omitted file still
      // groups via the deterministic filename rules (arXiv id / course-series / "Close
      // Reading 3"). Without this the 3B's ~30% omission rate strands course files.
      const m = placeByTag(it, { type: '', subject: '', domain: '', entity: '', year: '' });
      m.excerpt = content.get(String(it.id)) || '';
      if (m.keep) finalize(it, { keep: true, reason: 'Kept (not classified)', excerpt: m.excerpt }, false); // truly nameless → retry next run
      else { m.reason = 'Grouped by filename'; finalize(it, m, true); } // deterministic group → cache it
    }
  }

  // Build the batch list, then drain it with CONCURRENCY workers.
  const batches = [];
  for (let i = 0; i < misses.length; i += BATCH) batches.push(misses.slice(i, i + BATCH));
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      if (shouldStop()) return;
      const batch = batches[next++];
      // One batch failing must never reject the pool — that would orphan the other
      // concurrent workers' rejections and crash the process.
      try { await processBatch(batch); } catch { /* skip this batch, keep going */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));

  // Apply learned corrections as a post-pass — overrides both fresh and cached
  // placements when a rule matches the file's tags. (Junk/dupes left alone.)
  if (learning && !shouldStop()) {
    let applied = 0;
    for (const a of actions) { // the live, post-classification objects (not the stale `files` snapshot)
      if (a.isDir || a.action === 'delete') continue;
      const ov = lookupLearning(learning, a.tags);
      if (!ov) continue;
      if (ov.action === 'keep') { a.action = 'keep'; a.category = 'Other'; a.destPath = null; }
      else if (ov.action === 'group') { a.action = 'group'; a.category = ov.category || 'Other'; a.destPath = ov.destPath || null; }
      else continue;
      a.reason = 'Learned from your past changes';
      a.proposed = { action: a.action, category: a.category, destPath: a.destPath }; // so it's not re-learned
      a.include = true;
      applied += 1;
    }
    if (applied) onBatch({ done, total, actions, hits });
  }

  return { actions, hits, classified: total - hits };
}

// Common "all <ext>" words → file extensions, for the deterministic matcher.
const EXT_WORDS = {
  pdf: ['pdf'], doc: ['doc', 'docx'], docx: ['docx'], word: ['doc', 'docx'],
  txt: ['txt'], text: ['txt', 'md'], csv: ['csv'], zip: ['zip'], spreadsheet: ['csv', 'xlsx', 'xls'],
  png: ['png'], jpg: ['jpg', 'jpeg'], jpeg: ['jpeg', 'jpg'], gif: ['gif'], video: ['mp4', 'mov', 'avi', 'mkv'],
};
const IMG_EXT_RE = /\.(png|jpe?g|heic|heif|gif|webp|tiff?|bmp)$/i;

// DETERMINISTIC matcher for clear bulk patterns ("all 3-digit codes into CSE",
// "delete all screenshots", "move all PDFs to Finance"). Mutates `actions`, adds
// changed ids to `changedIds`. Returns { handled } — true if a recognized pattern
// matched (so we DON'T fall to the model, which can't enumerate reliably).
function applyRuleRequest(actions, userPrompt, dests, changedIds) {
  const orig = String(userPrompt || '').trim();
  const p = orig.toLowerCase();
  if (!p) return { handled: false };
  let action = 'group';
  if (/\b(delete|remove|trash|get rid of|discard)\b/.test(p)) action = 'delete';
  else if (/\b(keep|leave|don'?t touch|do not touch|ignore)\b/.test(p)) action = 'keep';
  let target = '';
  const mt = orig.match(/\b(?:into|in ?to|to|under|in)\s+(?:the\s+|a\s+|my\s+)?(.+?)(?:\s+folder)?\s*$/i);
  if (mt) { target = mt[1].trim(); if (/^[a-z]{2,4}$/.test(target)) target = target.toUpperCase(); }
  let pred = null; let codeNest = false;
  if (/\b(?:3|three)[\s-]?digit\b|course\s*code|class\s*(?:code|number)/.test(p)) {
    pred = (name) => /(?<!\d)\d{3}(?!\d)/.test(name); codeNest = true;
  } else if (/screenshots?|screen ?shots?/.test(p)) {
    pred = (name) => /screenshot|screen ?shot/i.test(name);
  } else if (/\b(images?|photos?|pictures?)\b/.test(p)) {
    pred = (name) => IMG_EXT_RE.test(name);
  } else {
    const exts = new Set();
    (p.match(/\.([a-z0-9]{1,5})\b/g) || []).forEach((e) => exts.add(e.slice(1)));
    const wm = p.match(/\ball\s+([a-z]{2,8})\b/);
    if (wm) { const w = wm[1]; const key = EXT_WORDS[w] ? w : (EXT_WORDS[w.replace(/s$/, '')] ? w.replace(/s$/, '') : null); if (key) EXT_WORDS[key].forEach((e) => exts.add(e)); }
    if (exts.size) pred = (name) => exts.has((name.split('.').pop() || '').toLowerCase());
  }
  if (!pred) return { handled: false };
  if (action === 'group' && !target) return { handled: false };
  let base = `~/Documents/${cleanDest(target)}`;
  const t = target.toLowerCase();
  const match = dests.find((d) => { const leaf = d.label.replace(/^~\//, '').toLowerCase(); return leaf === t || leaf.endsWith(`/${t}`); });
  if (match) base = match.label;
  for (const a of actions) {
    if (a.isDir || !pred(a.name)) continue;
    if (action === 'delete') { a.action = 'delete'; a.category = 'Junk'; a.destPath = null; }
    else if (action === 'keep') { a.action = 'keep'; a.category = 'Other'; a.destPath = null; }
    else { let cat = base; if (codeNest) { const code = (a.name.match(/(?<!\d)\d{3}(?!\d)/) || [])[0]; if (code) cat = `${base}/${code}`; } a.action = 'group'; a.category = cat; a.destPath = null; }
    a.source = 'prompt'; a.include = true; a.reason = 'From your request';
    a.proposed = { action: a.action, category: a.category, destPath: a.destPath };
    changedIds.add(String(a.id));
  }
  return { handled: true };
}

// Parse a fuzzy instruction into structured intent (one focused model call) — what
// the 3B IS good at: { selector, action, target }.
async function parseIntent(model, userPrompt, dests, signal) {
  const system = 'You convert a file-organization instruction into structured intent. Respond ONLY with JSON.';
  const prompt =
    `Instruction: "${userPrompt}"\n\n` +
    'Existing destination folders: ' + describeDestinations(dests) + '\n\n' +
    'Return JSON {"selector":"<short description of WHICH files/folders this targets>",' +
    '"action":"group|delete|keep","target":"<destination folder name, only if action is group>"}. ' +
    'Examples: "move my design assets into Assets" → {"selector":"design asset files (logos, mockups, icons)","action":"group","target":"Assets"}. ' +
    '"delete old installers" → {"selector":"app installer files","action":"delete","target":""}.';
  try {
    const d = await ollama.chatJSON({ model, system, prompt, signal });
    if (d && d.selector) {
      return {
        selector: String(d.selector),
        action: ['group', 'delete', 'keep'].includes(d.action) ? d.action : 'group',
        target: String(d.target || '').trim(),
      };
    }
  } catch { /* model error */ }
  return null;
}

// Per-item INDEPENDENT match against a selector (batched yes/no). The 3B handles
// this reliably where a bulk remap muddles context. Returns a Set of matching ids.
async function matchByModel(model, items, selector, signal, onProgress) {
  const matched = new Set();
  const BATCH = 25;
  const nB = Math.max(1, Math.ceil(items.length / BATCH));
  const system = 'You judge each item independently against a description. Respond ONLY with JSON.';
  for (let b = 0; b < nB; b += 1) {
    if (signal && signal.aborted) break;
    const chunk = items.slice(b * BATCH, b * BATCH + BATCH);
    const prompt =
      `For each item, does it match this description: "${selector}"? Judge each INDEPENDENTLY.\n` +
      'Items: ' + JSON.stringify(chunk.map((it) => ({ id: it.id, name: it.name }))) + '\n' +
      'Return JSON {"<id>": true|false} for EVERY item.';
    try {
      const d = await ollama.chatJSON({ model, system, prompt, signal });
      if (d) for (const it of chunk) { if (d[it.id] === true || d[String(it.id)] === true) matched.add(String(it.id)); }
    } catch { /* skip chunk */ }
    onProgress({ done: b + 1, total: nB });
  }
  return matched;
}

// Apply a plain-word request: deterministic rules first (clear patterns, instant,
// 100%), else the PER-ITEM pipeline (parse → independent per-item match → apply) —
// which avoids the bulk-remap context muddle the 3B can't handle.
async function applyPrompt(actions, userPrompt, model, dests = [], signal, onProgress = () => {}) {
  const byLabel = new Map(dests.map((d) => [d.label, d]));
  const byId = new Map(actions.map((a) => [String(a.id), a]));
  const files = actions.filter((a) => !a.isDir);
  const disp = (cat) => String(cat || '').replace(/^~\/Documents\//, '');
  const resolveDest = (raw) => {
    const s = String(raw || '').trim();
    if (byLabel.has(s)) { const e = byLabel.get(s); return { category: e.label, destPath: e.path }; }
    return { category: `~/Documents/${cleanDest(s.replace(/^~\/(?:documents\/)?/i, ''))}`, destPath: null };
  };
  const stamp = (a) => { a.source = 'prompt'; a.reason = 'From your request'; a.include = true; a.proposed = { action: a.action, category: a.category, destPath: a.destPath }; };
  const changedIds = new Set();
  const summarize = () => [...changedIds].map((id) => {
    const a = byId.get(id);
    const to = a.action === 'group' ? disp(a.category) : a.action === 'delete' ? 'Quarantine' : 'kept in place';
    return `${a.rename || a.name}  →  ${to}`;
  });
  const allowDelete = /\b(delete|deletes?|remove|removes?|trash|discard|get rid of|quarantine|purge|clean out)\b/i.test(userPrompt);

  // 1) Deterministic fast path — recognized patterns, no model needed.
  const rule = applyRuleRequest(actions, userPrompt, dests, changedIds);
  if (rule.handled) return { actions, changed: changedIds.size, summary: summarize() };

  // 2) Per-item pipeline for fuzzy requests.
  const intent = await parseIntent(model, userPrompt, dests, signal);
  if (!intent) return { actions, changed: 0, summary: [] };
  const action = intent.action;
  if (action === 'delete' && !allowDelete) return { actions, changed: 0, summary: [] }; // safety rail
  if (action === 'group' && !intent.target) return { actions, changed: 0, summary: [] };

  // Match folders (if the request is about folders and some exist) else files.
  const wantsFolders = /\bfolders?\b/i.test(userPrompt);
  const folderNames = [...new Set(files.filter((a) => a.action === 'group').map((a) => disp(a.category)))];
  let matchedFiles;
  if (wantsFolders && folderNames.length) {
    const mf = await matchByModel(model, folderNames.map((name) => ({ id: name, name })), intent.selector, signal, onProgress);
    matchedFiles = files.filter((a) => a.action === 'group' && mf.has(disp(a.category)));
  } else {
    const mi = await matchByModel(model, files.map((a) => ({ id: a.id, name: a.rename || a.name })), intent.selector, signal, onProgress);
    matchedFiles = files.filter((a) => mi.has(String(a.id)));
  }

  // Apply: matched items → action. For group, nest a matched folder under target as
  // target/<folderName>, and matched loose files go directly into target.
  for (const a of matchedFiles) {
    if (action === 'delete') { a.action = 'delete'; a.category = 'Junk'; a.destPath = null; }
    else if (action === 'keep') { a.action = 'keep'; a.category = 'Other'; a.destPath = null; }
    else { const sub = wantsFolders && a.action === 'group' ? disp(a.category) : ''; const d = resolveDest(sub ? `${intent.target}/${sub}` : intent.target); a.action = 'group'; a.category = d.category; a.destPath = d.destPath; }
    stamp(a); changedIds.add(String(a.id));
  }
  return { actions, changed: changedIds.size, summary: summarize() };
}

// ---- Folder consolidation (a second pass over the PROPOSED folders) ----
// The per-file pass can leave many small, related sibling folders (e.g. one per
// homework topic). This pass asks the model to nest related folders under a
// shared parent ("CSE 421/Graph Algorithms"), producing deeper, tidier trees.
// It only touches NEW folders we proposed — never the user's existing folders.

// Generic tokens that shouldn't be used as a shared parent on their own.
const PREFIX_STOP = new Set(['the', 'a', 'an', 'my', 'of', 'and', 'for', 'to', 'in', 'on', 'with',
  'at', 'by', 'from', 'new', 'draft', 'final', 'copy', 'untitled', 'document', 'file', 'misc']);
const leafTokens = (leaf) => String(leaf).split(/[\s_\-]+/).filter(Boolean);

// Deterministic & GENERAL: nest sibling folders that share a common leading
// word-prefix under that prefix — "322 Close Reading" + "322 Writing in Practice"
// -> "322/…", "Taxes 2023" + "Taxes 2024" -> "Taxes/…", "Machine Learning Notes" +
// "Machine Learning Slides" -> "Machine Learning/…". Works in any domain, no model.
// Only touches NEW top-level folders we proposed. Returns the count moved.
function nestByCommonPrefix(actions) {
  const home = os.homedir();
  const PREFIX = '~/Documents/';
  const catActions = new Map();
  const folders = [];
  for (const a of actions) {
    if (a.action !== 'group' || a.isDir || !a.destPath) continue;
    let exists = false; try { exists = fs.existsSync(a.destPath); } catch { /* new */ }
    if (exists || !a.category.startsWith(PREFIX)) continue;
    const leaf = a.category.slice(PREFIX.length);
    if (leaf.includes('/')) continue; // already nested
    if (!catActions.has(a.category)) { catActions.set(a.category, []); folders.push({ cat: a.category, tokens: leafTokens(leaf) }); }
    catActions.get(a.category).push(a);
  }
  // Group by shared first token, then nest each group under its longest common prefix.
  const groups = new Map();
  for (const f of folders) {
    if (!f.tokens.length) continue;
    const k = normGroup(f.tokens[0]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  let changed = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    let lcp = group[0].tokens.slice();
    for (const f of group.slice(1)) {
      let i = 0;
      while (i < lcp.length && i < f.tokens.length && normGroup(lcp[i]) === normGroup(f.tokens[i])) i += 1;
      lcp = lcp.slice(0, i);
    }
    if (!lcp.length || !lcp.some((t) => !PREFIX_STOP.has(normGroup(t)))) continue; // need a real shared word
    const parent = lcp.join(' ');
    for (const f of group) {
      const child = f.tokens.slice(lcp.length).join(' ');
      const segs = child ? [parent, child] : [parent];
      const newCat = PREFIX + segs.join('/');
      if (newCat === f.cat) continue;
      const newPath = path.join(home, 'Documents', ...segs);
      for (const a of catActions.get(f.cat)) { a.category = newCat; a.destPath = newPath; }
      changed += catActions.get(f.cat).length;
    }
  }
  return changed;
}

function buildConsolidatePrompt(folders) {
  const system =
    'You tidy a list of proposed folders into a cleaner hierarchy by nesting RELATED ' +
    'folders under a shared parent (a course, client, project, or theme). Leave unrelated ' +
    'folders alone. Respond ONLY with JSON.';
  const prompt =
    'For each folder return a path:\n' +
    '  - "Parent/Folder" to nest it under a shared parent.\n' +
    '  - just "Folder" (unchanged) to keep it standalone.\n' +
    'Choose a PARENT that describes the whole group — either a broader category you name ' +
    '(e.g. several deep-learning topics under "Machine Learning", several companies\' bills ' +
    'under "Invoices"), OR, if one folder is genuinely a broader category containing the ' +
    'others, that folder. You may nest one or two levels when it helps ("Parent/Folder" or ' +
    '"Area/Course/Folder"). Derive names from the folders\' OWN subjects — do NOT copy these ' +
    'examples or invent a course number the contents do not support.\n' +
    'ONLY group folders that are genuinely related; leave unrelated folders standalone. ' +
    'The parent must NAME the actual shared topic — NEVER a vague word like "Documents", ' +
    '"Files", "Personal", "Misc", "Area", "Client", or "Stuff". If you can\'t name a real ' +
    'shared topic, leave the folder standalone.\n' +
    'Return JSON: {"map":{"<folder>":"<path>", ...}} with an entry for EVERY folder.\n\n' +
    'Folders:\n' + JSON.stringify(folders);
  return { system, prompt };
}

// Two path segments are "the same idea" if one's tokens contain the other's, they
// overlap heavily, or one is an acronym of the other ("ML" ≈ "Machine Learning",
// "Neural Networks" ≈ "Networks"). Used to collapse redundant nesting levels.
function segSimilar(a, b) {
  const an = normGroup(a), bn = normGroup(b);
  if (an === bn) return true;
  const A = tokenSet(a), B = tokenSet(b);
  if (!A.size || !B.size) return false;
  const subset = (X, Y) => { for (const x of X) if (!Y.has(x)) return false; return true; };
  if (subset(A, B) || subset(B, A)) return true;
  if (jaccard(a, b) >= 0.55) return true;
  const acro = (short, long) => {
    const s = normGroup(short).replace(/[^a-z0-9]/g, '');
    if (s.length < 2 || s.length > 6) return false;
    const initials = (normGroup(long).match(/[a-z0-9]+/g) || []).map((w) => w[0]).join('');
    return initials === s;
  };
  return acro(an, bn) || acro(bn, an);
}
const descriptiveness = (s) => tokenSet(s).size * 100 + s.length;

// Vague umbrella names the model invents that carry no real meaning — never use
// one as a parent ("Area/Personal Documents/Client/…" is noise, not structure).
const GENERIC_PARENT = new Set(['area', 'areas', 'personal', 'personal documents', 'documents', 'document',
  'files', 'file', 'misc', 'miscellaneous', 'stuff', 'general', 'other', 'others', 'category', 'categories',
  'folder', 'folders', 'items', 'item', 'client', 'clients', 'various', 'assorted', 'content', 'contents',
  'data', 'new folder', 'my documents', 'downloads', 'untitled']);

// Clean a model-proposed nesting path: keep the original folder as the final
// segment, collapse redundant/near-duplicate parent levels, and drop any parent
// that just restates the folder. No fixed depth cap — redundancy is what bloats
// chains, so removing it is what keeps them sane.
function tidySegments(rawSegs, leaf) {
  // The model's LAST segment is its own (often renamed) version of this folder —
  // drop it; we always re-append the real folder name as the leaf.
  const prefix = rawSegs.filter(Boolean).slice(0, -1);
  const parents = [];
  for (const s of prefix) {
    const j = parents.findIndex((p) => segSimilar(p, s));
    if (j >= 0) { if (descriptiveness(s) > descriptiveness(parents[j])) parents[j] = s; }
    else parents.push(s);
  }
  // Drop parents that restate the folder, and vague/meaningless umbrella names.
  const kept = parents.filter((p) => !segSimilar(p, leaf) && !GENERIC_PARENT.has(normGroup(p)));
  const out = [...kept, leaf];
  return out.length > 6 ? [kept[0], leaf] : out; // backstop against a pathological chain
}

function firstJsonObject(text) {
  const s = text.indexOf('{');
  if (s < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) { try { return JSON.parse(text.slice(s, i + 1)); } catch { return null; } } }
  }
  return null;
}

// Deterministic harmonization (ai-file-sorter's consistency pass, adapted): fold NEW
// sibling folders whose names are near-duplicates ("Receipts"/"Receipt", "Invoices"/
// "Invoice", "Machine Learning"/"MachineLearning") into one, picking the most
// descriptive name. Only touches NEW top-level ~/Documents folders we proposed —
// never the user's existing folders, and never collapses distinct concepts (the
// 0.8 gate keeps "Taxes" and "Travel" apart). A safety net for anything the
// within-run convergence in routeNewGroup didn't already unify. Returns count moved.
function mergeSimilarNewFolders(actions) {
  const PREFIX = '~/Documents/';
  const byCat = new Map();
  const cats = [];
  for (const a of actions) {
    if (a.action !== 'group' || a.isDir || !a.destPath) continue;
    if (!a.category.startsWith(PREFIX)) continue;
    const leaf = a.category.slice(PREFIX.length);
    if (leaf.includes('/')) continue; // already nested
    let exists = false;
    try { exists = fs.existsSync(a.destPath); } catch { /* new */ }
    if (exists) continue; // existing folders are the user's; never merge them away
    if (!byCat.has(a.category)) { byCat.set(a.category, []); cats.push(a.category); }
    byCat.get(a.category).push(a);
  }
  if (cats.length < 2) return 0;
  const leafOf = (c) => c.slice(PREFIX.length);
  // Union–find clustering by pairwise leaf-name similarity.
  const rep = new Map(cats.map((c) => [c, c]));
  const find = (c) => { while (rep.get(c) !== c) { rep.set(c, rep.get(rep.get(c))); c = rep.get(c); } return c; };
  for (let i = 0; i < cats.length; i += 1) {
    for (let j = i + 1; j < cats.length; j += 1) {
      if (folderMatchScore(leafOf(cats[i]), leafOf(cats[j])) >= NEW_FOLDER_MERGE_MIN) {
        const ri = find(cats[i]); const rj = find(cats[j]);
        if (ri !== rj) rep.set(rj, ri);
      }
    }
  }
  const clusters = new Map();
  for (const c of cats) { const r = find(c); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(c); }
  let changed = 0;
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    let winner = members[0]; // most descriptive leaf wins; alpha tie-break for determinism
    for (const m of members) {
      const dw = descriptiveness(leafOf(winner)); const dm = descriptiveness(leafOf(m));
      if (dm > dw || (dm === dw && leafOf(m) < leafOf(winner))) winner = m;
    }
    const winPath = byCat.get(winner)[0].destPath;
    for (const m of members) {
      if (m === winner) continue;
      for (const a of byCat.get(m)) { a.category = winner; a.destPath = winPath; changed += 1; }
    }
  }
  return changed;
}

// Modifies `actions` in place. Returns { changed, folders }.
async function consolidateFolders(actions, model, signal, onStatus = () => {}) {
  const home = os.homedir();
  // 0) Fold near-duplicate proposed folders together first, so prefix-nesting and the
  //    model pass below see one canonical name per subject.
  const mergedChanged = mergeSimilarNewFolders(actions);
  // Nest folders sharing a common leading word-prefix ("322 Close Reading"/"322
  // Writing…" -> "322/…", "Taxes 2023"/"Taxes 2024" -> "Taxes/…").
  const courseChanged = mergedChanged + nestByCommonPrefix(actions);

  // 2) Model pass over the remaining TOP-LEVEL new folders (skip already-nested).
  const byCat = new Map();
  for (const a of actions) {
    if (a.action !== 'group' || a.isDir || !a.destPath) continue;
    let exists = false;
    try { exists = fs.existsSync(a.destPath); } catch { /* treat as new */ }
    if (exists) continue;
    if (a.category.startsWith('~/Documents/') && a.category.slice('~/Documents/'.length).includes('/')) continue; // already nested
    if (!byCat.has(a.category)) byCat.set(a.category, []);
    byCat.get(a.category).push(a);
  }
  const cats = [...byCat.keys()];
  // Too few to bother, or too many — a huge folder list makes the model call slow
  // (and low-quality). The deterministic passes above already ran.
  if (cats.length < 4 || cats.length > 40) return { changed: courseChanged, folders: cats.length };

  onStatus('Condensing related folders…');
  const folderList = cats.map((c) => ({
    folder: c.split('/').pop(),
    examples: byCat.get(c).slice(0, 3).map((a) => a.rename || a.name),
    subjects: [...new Set(byCat.get(c).map((a) => a.tags && a.tags.subject).filter(Boolean))].slice(0, 2),
  }));

  const { system, prompt } = buildConsolidatePrompt(folderList);
  let resp = '';
  try {
    await ollama.chatStream({ model, system, prompt, signal, onText: (f) => { resp = f; } });
  } catch { return { changed: courseChanged, folders: cats.length }; }
  const obj = firstJsonObject(resp);
  const map = obj && (obj.map || obj);
  if (!map || typeof map !== 'object') return { changed: courseChanged, folders: cats.length };

  let changed = courseChanged;
  for (const c of cats) {
    const leaf = c.split('/').pop();
    const raw = map[leaf];
    if (!raw || typeof raw !== 'string') continue;
    const segs = tidySegments(cleanDest(raw).split('/').filter(Boolean), leaf);
    if (segs.length < 2) continue; // model left it standalone (or all parents were redundant)
    const newCat = `~/Documents/${segs.join('/')}`;
    if (newCat === c) continue;
    const newPath = path.join(home, 'Documents', ...segs);
    for (const a of byCat.get(c)) { a.category = newCat; a.destPath = newPath; }
    changed += byCat.get(c).length;
  }
  return { changed, folders: cats.length };
}

module.exports = {
  planByRules,
  refineWithModel,
  applyPrompt,
  applyRuleRequest,
  destForGroup,
  resolveDeepDest,
  makeItemStreamer,
  consolidateFolders,
  avoidSingletonNewFolders,
  choosePlacementForTag,
};
