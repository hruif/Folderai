# FolderAI — Prioritized Release Checklist

Core is built: content-based classification (objective type + subject → universal
grouping rules), works within existing folders, staging review, undo, quarantine,
collapsible tree preview, folder picker, cross-location + custom source/dest dirs,
auto-managed Ollama, settings, adaptive ETA.

Below is what remains, prioritized. Effort: **S** ≤1 day · **M** a few days · **L** ~a week+.
Each item notes the competitive gap it closes (from the landscape research).

---

## P0 — Release blockers (do *near* ship, not now)

- [ ] **Embed the model** (`node-llama-cpp` + bundled GGUF). *Deferred until release by decision.*
  Makes "private **and** simple" both true — no separate Ollama install. ai-file-sorter
  already does one-click local; this is table stakes for the "no setup" promise. **L**
- [ ] **Sign + notarize the `.app`** and pick distribution (direct DMG vs App Store).
  Unsigned builds hit Gatekeeper. App Store also implies sandbox review. **M**
- [ ] **Stability pass** — graceful errors, permissions (TCC for Documents/Desktop),
      thousands-of-files performance, never crash on a malformed file. **M**
- [ ] **Classification quality bar** — a final tuning/eval pass; decide the default
      model (`qwen2.5:3b` tied `llama3.2:3b` and is slightly smaller). **M**

---

## P1 — Launch features (each closes a competitor gap)

1. [x] **De-duplicate (deterministic, fast — no AI).** ✅ *done*
   - `src/dedup.js`: hash within same-size groups (full hash ≤8 MB, head+tail sample
     beyond), keep the likely original (no "copy"/"(n)" marker → oldest → shortest name).
   - Wired into the scan handler (`main.js`): exact copies → `delete` (quarantine) with
     reason `Duplicate of "<original>"`; preserved through the AI pass; surfaced as a
     "N duplicates" pill in the summary. Empties stay handled by rules.

2. [x] **Renaming.** ✅ *done* — *gap closed vs NameQuick, LlamaFS, Local-File-Organizer.*
   - Gated by a **"Suggest cleaner filenames"** toggle on the AI gate (off by default,
     so the extra `name` field is only requested when wanted — no quality/perf cost otherwise).
   - The tag pass returns a `name`; `buildRename` sanitizes it + keeps the original
     extension (`Acme Invoice March 2024.pdf`, `CSE 446 Homework 3.txt`).
   - `rename` field on the action; **editable** in the list row (clear it to keep the
     original), shown read-only in the tree. Executor renames on move *and* in place
     for kept files; undo restores the original name.
   - Note: name quality tracks the 3B — solid on real batches, occasionally degenerate
     on tiny ones (same variance as classification).

3. [~] **Process images — Phase 1 (OCR) done.** — *gap closed vs ai-file-sorter, LlamaFS, Local-File-Organizer.*
   - `native/ocr.swift` (Apple **Vision**, on-device) + `src/ocr.js` (lazy compile to a
     cached binary, graceful '' if unavailable). Wired into `content.js` for image
     exts → same content pipeline. Prompt now tells the model to type a screenshot by
     the document it SHOWS ("invoice"), not "image".
   - Verified: invoice screenshot → Invoices; homework screenshot read; text-less photo → kept.
   - ⚠️ **RELEASE BLOCKER:** OCR compiles via `swiftc` at runtime — end users without
     Xcode CLT have no `swiftc`, so OCR silently degrades. **Must ship a prebuilt,
     signed `ocr` binary** (compile at build, bundle in Resources, load from there).
   - [x] Phase 2 (lightweight): **Vision scene/object classification** (`VNClassifyImageRequest`)
     added alongside OCR — text-less images get broad labels (`outdoor, sky, sunset` /
     `document, printed_page`). Fed to the model as `[image contents: …]`: documents get
     filed, real photos stay kept (coarse, not per-object folders). Same framework, ~no
     extra cost, no bundled model. Verified on real photos + an invoice image.
   - Decided AGAINST a local **VLM** (moondream ~2GB, slow, fine-grained understanding
     wasted on coarse cleanup) — Vision classify covers the wide-category need.
   - [ ] Image-based PDF OCR (rasterize pages → Vision) — currently only image files.
   - ⚠️ RELEASE BLOCKER (carries over): ship a prebuilt signed `ocr` binary — runtime
     `swiftc` compile won't exist on end-user machines without Xcode CLT.

---

## Classification quality

- [x] **Papers by format** ✅ KEPT — `looksLikePaper` detects arXiv ids (`2210.01241v1`),
  legacy arXiv, and DOIs → "Research Papers". This is a strict, unambiguous machine FORMAT
  (~zero false positives), like recognizing a file extension — not keyword classification.
- **REVERTED deterministic keyword shortcuts** (filename resume/cv/cover-letter detection;
  course-code unification). Principle: don't paper over the model with name-keyword hacks —
  they MASK whether the model can actually classify, hiding problems we should fix generally.
  - Finding: removing the resume/cover-letter shortcut did NOT regress — the **model
    classifies resumes & cover letters correctly on its own** (the shortcut was redundant,
    masking real capability). Validated the principle.
  - Rule going forward: generalize the model first; add deterministic help only for strict
    universal FORMATS (extensions, arXiv/DOI), never for fuzzy keyword classification.
- [x] **Generalized financial-doc handling (prompt + routing, no keyword hack)** ✅
  - Prompt: "use the EXACT type the name/contents name (a Bank Statement is 'statement', not
    'receipt')" + "genuinely ambiguous names (document/untitled/scan) stay put — don't force
    a type." Routing: added `bill`/`utility bill` → `Bills` (model already typed it "bill").
  - Result: bank statements → `Statements`, bills → `Bills`, ambiguous → kept (8–9/9 financial).
  - Caught & fixed a regression my first wording caused (over-classifying `document.pdf`).
- **Still-open 3B weaknesses (honestly surfaced, NOT hacked):**
  - **Cover letters** classify inconsistently from FILENAME alone (sometimes kept). NB: tests
    use empty dummy files (filename-only = worst case); real cover letters have content
    ("Dear Hiring Manager…") the model reads, so real-world is likely better. Confirm with
    content before considering any assist.
  - Lone numbered files (`scan0007`) form singleton folders via the series heuristic — minor.
- [x] **"Stuck at N/N" + "Loading model" status** ✅ — after all files classify, the bar
  now animates "Finishing — organizing folders…" (post-passes run there) instead of a
  frozen `N/N`; the stale "Loading the local model…" line clears once classifying starts.
  Also capped the model consolidation to ≤40 folders (a huge list made it slow).

- [x] **Folder consolidation (2nd pass).** ✅ *done* — condenses related sibling folders
  into deeper, shared-parent trees (`Poetry/Robert Frost`, `Invoices/Acme Corp`).
  - `consolidateFolders` in `planner.js`: one model call over the PROPOSED NEW folders
    (existing user folders untouched), runs when ≥4 new folders. Toggle **"Condense
    related folders"** on the AI gate (default on).
  - Deterministic safety guards: max 2 levels (no chaining), parent can't be a sibling
    folder or itself — so it only nests under a genuine new umbrella, never makes it worse.
  - Verified: poets → `Poetry/…`, vendors → `Invoices/…`. Residual: the 3B sometimes
    can't name an umbrella (offered a sibling → guard left those standalone). Better model lifts this.

## Findings from the 318-file benchmark (~14 min run)

- [ ] **PERF: classification is slow** — 318 files ≈ 14 min; ~500 ≈ 20+ min on first run.
  The local 3B (one JSON gen per 12-file batch) is the floor; per-file extraction +
  per-image OCR add to it. Options: skip content extraction when the filename is
  already confident, raise concurrency, faster model. Cache already covers re-runs.
- [x] **BUG: `ensureServer` 404 race** ✅ *fixed* — added `ollama.warmupModel(model)`
  (tiny `/api/chat`, retries through the cold-start 404 until the model serves), called
  before classify + apply-prompt. If it never comes up, the run now reports an error
  instead of a silent "kept everything." Verified: cold start → warmed in 5.7s → all
  files classified.
- [x] **Consolidation incoherence** ✅ *fixed* — the problem was meaning, not depth.
  `Area/Personal Documents/Client/Resume` came from (a) the 3B mis-typing cover letters
  as "resume" and (b) invented vague parents. Fixes: filename wins over model type for
  high-confidence doc types (resume/cv/cover letter/transcript); `GENERIC_PARENT`
  stoplist rejects vague umbrellas ("Area", "Personal", "Misc", "Client"…); prompt nudge.
  Verified: cover letters → `Cover Letters` (was the nonsense path).
- **PERF DATA (48 files, model-only):** batch size barely matters — 6=104s, **12=90s**,
  24=92s, 48=97s (12 is the sweet spot; smaller is worse from per-call prompt re-eval).
  File reading is NOT the bottleneck — .bin 90s ≈ .pdf 89s ≈ .jpg(OCR) 92s. Concurrency
  is the only real knob and it's modest: 2→4 ≈ −17%, 4→6 nothing. **The floor is the 3B
  generating ~1 classification/file (~2s/file).** Real levers: deterministic fast-path for
  obvious-by-name files (skip the model), drop the `reason` field (fewer output tokens),
  faster model. Cache already covers re-runs.
- **DEBIASED accuracy: 82%** on a diverse non-academic set (office/finance/travel/
  household/photos/music/gaming) — vs the ~97% on the academic-biased set, confirming the
  earlier number was inflated. Diverse failures cluster on **financial sub-types**
  (invoice/receipt/bill/statement blurred) + occasional hallucinations.

## P2 — Differentiators & utility

4. [x] **Learning from corrections.** ✅ *done* — *gap closed vs ai-file-sorter.*
   - `src/learning.js`: at execute, any included file whose final destination differs
     from what we proposed becomes a rule keyed on the objective tag that drove the
     placement (`type:invoice`, `subject:cse 446`) — generalizes, not per-file.
   - Applied as a post-pass in `refineWithModel` (overrides fresh *and* cached
     placements; junk/dupes untouched); persisted to `learning.json`.
   - Setting **"Learn from my changes"** (on by default) + **"Forget learned"** button.
   - Verified: one correction (Acme invoice → Finance) routed BOTH that invoice and a
     different vendor's invoice to Finance next run.

5. [x] **Search by name + content (+ tags).** ✅ *done*
   - The content excerpt (text / OCR / image labels) is now carried on each action
     (`excerpt`, `ext`) and cached, alongside `tags.type`/`subject` + size + mtime.
   - Toolbar **search box** filters list AND tree live by name, type, subject, category,
     content excerpt, extension, size, and date (month/year) — multi-word = AND. Match count shown.
   - Verified: name/content/type/date/multi-word queries (8/8 logic cases).
   - Note: content search needs the excerpt, which exists after an AI run (or cache hit);
     before classifying, search covers name + metadata only.

5b. [x] **Provisional in-run UI** ✅ — don't lock/hide (a frozen multi-min run reads as
   broken). Instead: stream the stable List during the run (forced to List view); the
   nested **Tree shows "organizing… appears when done"** so the end-consolidation reshuffle
   isn't shown as if final; **edits/dest-picker locked mid-run** (they'd be overwritten by the
   next stream update) with a provisional banner. Tree settles on completion.

6. [x] **Drag-to-organize + create folders in the tree.** ✅ *done*
   - Drag a **file** onto a folder node → reparents it (`nodeDest` resolves the node's
     label to action/category/destPath; quarantine-drop = delete). Drag a **folder** node →
     reparents the whole subtree under the target (nesting preserved), with a cycle guard.
   - **＋ New folder** button → inline input (Electron has no `window.prompt`) creates an
     empty `~/Documents/<name>` node you can drag files into.
   - Moves set `source:'prompt'` so they feed the learning layer on execute.
   - Verified: reparent math (file + subtree), cycle guard, boot. (Interactive DnD itself
     is manual-test territory; the logic + wiring are confirmed.)

7. [ ] **Polish.** **S**
   - Persist user-added locations (`extraRoots`) across restarts.
   - Esc dismisses the AI gate / picker; small UI niceties.

---

## Recommended sequence

```
De-dup (S, quick win)
  → Renaming (M, reuses tags)
  → Images / OCR (M/L, biggest competitive gap)
  → Learning from corrections (M/L)
  → Search + tags (M)
  → Drag-to-organize + polish (S)
  ───────────────  then, at release:  ───────────────
  → Embed model (L) + sign/notarize + stability/eval pass
```

## Notes on positioning (keep the marketing honest as features land)
- Don't claim **image understanding**, **rename**, or **search by content** in the
  listing until shipped (currently behind several competitors on the first two).
- The durable wedge is: **fully local (no cloud mode at all) + files into YOUR
  existing folders + review/undo everything.** Lead with that.
