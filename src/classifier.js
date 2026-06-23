'use strict';

// Deterministic, rule-based classification. Fast and reliable; used as the
// baseline and as a fallback whenever the local model is unavailable or
// returns something unusable.

const path = require('path');

const CATEGORY_BY_EXT = {
  // Images
  jpg: 'Images', jpeg: 'Images', png: 'Images', gif: 'Images', heic: 'Images',
  webp: 'Images', bmp: 'Images', tiff: 'Images', svg: 'Images', ico: 'Images',
  // Documents
  pdf: 'Documents', doc: 'Documents', docx: 'Documents', txt: 'Documents',
  rtf: 'Documents', odt: 'Documents', pages: 'Documents', md: 'Documents',
  epub: 'Documents', mobi: 'Documents',
  // Spreadsheets
  xls: 'Spreadsheets', xlsx: 'Spreadsheets', csv: 'Spreadsheets', numbers: 'Spreadsheets',
  // Presentations
  ppt: 'Presentations', pptx: 'Presentations', key: 'Presentations',
  // Archives
  zip: 'Archives', tar: 'Archives', gz: 'Archives', tgz: 'Archives', rar: 'Archives',
  '7z': 'Archives', bz2: 'Archives', xz: 'Archives',
  // Installers
  dmg: 'Installers', pkg: 'Installers', exe: 'Installers', msi: 'Installers', deb: 'Installers',
  // Audio
  mp3: 'Audio', wav: 'Audio', flac: 'Audio', aac: 'Audio', m4a: 'Audio', ogg: 'Audio',
  // Video
  mp4: 'Video', mov: 'Video', avi: 'Video', mkv: 'Video', webm: 'Video', wmv: 'Video',
  // Code & data
  js: 'Code', ts: 'Code', jsx: 'Code', tsx: 'Code', py: 'Code', java: 'Code',
  c: 'Code', cpp: 'Code', h: 'Code', go: 'Code', rs: 'Code', rb: 'Code', php: 'Code',
  sh: 'Code', html: 'Code', css: 'Code', json: 'Code', xml: 'Code', yml: 'Code',
  yaml: 'Code', ipynb: 'Code', sql: 'Code',
};

// Names that are almost always disposable.
const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);
// Extensions for incomplete / temporary downloads.
const TEMP_EXTS = new Set(['crdownload', 'part', 'partial', 'download', 'tmp', 'temp']);

function extOf(name) {
  const e = path.extname(name).toLowerCase().replace('.', '');
  return e;
}

// Returns { category, deleteSuggested|keep, reason } from rules alone.
function classifyByRules(item) {
  const { name, isDir, size } = item;

  if (JUNK_NAMES.has(name)) {
    return { category: 'Junk', deleteSuggested: true, reason: 'System/metadata junk file' };
  }

  if (isDir) {
    return { category: 'Folders', deleteSuggested: false, keep: true, reason: 'Folder — left in place by default' };
  }

  const ext = extOf(name);

  if (TEMP_EXTS.has(ext)) {
    return { category: 'Junk', deleteSuggested: true, reason: 'Incomplete or temporary download' };
  }

  if (size === 0) {
    return { category: 'Junk', deleteSuggested: true, reason: 'Empty (0-byte) file' };
  }

  const detectedType = CATEGORY_BY_EXT[ext] || 'Other';

  // Rules only confidently flag disposable installers for deletion. For
  // everything else we DEFAULT TO KEEP and let the model (which can see the
  // user's existing folder structure) propose where things should go. The
  // rule-based pass must not impose a rigid type-based scheme on top of the
  // user's own organization.
  if (detectedType === 'Installers') {
    return { category: 'Installers', deleteSuggested: true,
      reason: 'Installer — usually safe to remove after installing' };
  }

  return {
    category: detectedType, // a hint only; action is keep until the model/user decides
    keep: true,
    reason: `Looks like ${detectedType} (.${ext || 'none'}) — kept in place pending AI/your review`,
  };
}

module.exports = { classifyByRules, CATEGORY_BY_EXT, extOf };
