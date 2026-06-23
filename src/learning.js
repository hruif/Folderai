'use strict';

const fs = require('fs');

// Learns from the user's corrections. When the user overrides where a file goes,
// we record a GENERAL rule keyed on the file's objective tags (type or subject) —
// not the individual file — and apply it on the next run. Sits on top of the
// general engine; never hard-coded.

const norm = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');

function loadLearning(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* fresh */ }
  return { file, data };
}
function saveLearning(store) {
  try { fs.writeFileSync(store.file, JSON.stringify(store.data, null, 2)); } catch { /* ignore */ }
}
function clearLearning(store) { store.data = {}; saveLearning(store); }

// The rule key for an action — keyed on whichever tag drove its placement so a
// correction generalizes the same way the placement did.
function keyFor(tags) {
  if (!tags) return null;
  const type = norm(tags.type), subject = norm(tags.subject), basis = tags.basis;
  if ((basis === 'type' || basis === 'bucket') && type) return `type:${type}`;
  if ((basis === 'subject' || basis === 'series') && subject) return `subject:${subject}`;
  if (subject) return `subject:${subject}`;
  if (type) return `type:${type}`;
  return null;
}

// Record corrections from the executed plan: any included file whose final
// destination differs from what we proposed becomes/updates a rule.
function recordCorrections(store, actions) {
  let learned = 0;
  for (const a of actions) {
    if (!a.include) continue;
    const p = a.proposed;
    if (!p) continue;
    const changed = a.action !== p.action || (a.category || '') !== (p.category || '') ||
      (a.destPath || null) !== (p.destPath || null);
    if (!changed) continue;
    if (a.action === 'delete') continue; // don't learn deletions this way
    const key = keyFor(a.tags);
    if (!key) continue;
    store.data[key] = { action: a.action, category: a.category || null, destPath: a.destPath || null, ts: Date.now() };
    learned += 1;
  }
  if (learned) saveLearning(store);
  return learned;
}

// The learned override for a file's tags, or null. Subject rules (narrower) win
// over type rules.
function lookup(store, tags) {
  if (!store || !tags) return null;
  const type = norm(tags.type), subject = norm(tags.subject);
  if (subject && store.data[`subject:${subject}`]) return store.data[`subject:${subject}`];
  if (type && store.data[`type:${type}`]) return store.data[`type:${type}`];
  return null;
}

module.exports = { loadLearning, saveLearning, clearLearning, recordCorrections, lookup };
