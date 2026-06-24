# Folderai — Feature Benchmark

A privacy-first desktop app that cleans up messy folders with a **local** AI model.
This is the definition-of-done used to judge release readiness.

Status: **✅ built & verified · ◑ partial · ⬜ not done**

---

## Classification (the core)
- ✅ **Dynamic AI sorting** of loose files into folders — reads *contents* (text, PDF, DOCX, and text-in-images via OCR) and adapts to any folder via a local model.
- ✅ Classifies by what a file **is** (type) and what it's **about** (subject), then applies general organizing conventions — no hard-coded, per-user rules.
- ✅ **Works within your existing structure** — routes into your real folders, proposes new ones only when needed; never imposes a fixed scheme.
- ✅ **Consolidates related folders** into a tidy nested structure (shared parents).
- ✅ **Plain-language adjustments** — type a request ("put invoices in Finance") to refine the plan before executing.

## Privacy
- ✅ **100% local** — the model runs on-device; filenames and contents never leave the machine. No cloud, account, or telemetry.

## Control & safety
- ✅ **Review staged changes — and edit them — before anything runs.**
  - Change any file's action or destination, **drag to reorganize** (multi-select), rename, create folders, or type a plain-language request; toggle items in/out.
- ✅ **Flags disposable files for (recoverable) deletion** — exact **duplicates** (a fast first pass), leftover **installers**, incomplete downloads, and empty/system junk → always to a quarantine folder, never permanent.
- ✅ **One-click Undo** of a whole run.
- ✅ **Stop / cancel** mid-run.

## Organization extras
- ✅ **De-duplicate** exact copies (deterministic, runs first).
- ✅ **Rename** — optional AI-suggested clean filenames.
- ✅ **Images** — reads text in screenshots/scans (OCR) and recognizes photo content (scene/object), all on-device.
- ✅ Add any folders as cleanup **sources and destinations** (Documents, Desktop, external drives).

## Search
- ✅ Search by file **name and content**, plus tags (type, subject, date, size).

## Personalization
- ✅ **Learns from your corrections** — remembers where you move things and applies it next run.

## UI / UX
- ✅ **Simple** enough for non-technical users — scan, review, done.
- ✅ Intuitive post-classification **tree** — collapsible, less cluttered; **drag-to-organize with multi-select** (⌘-click files *and* folders, drag many into one at once, cycle-safe); **create new folders**; **compact/comfortable density** toggle.
- ✅ Honest progress — composition-weighted **time estimate**, streaming results, **provisional until final** (no jarring end-reshuffle); edits lock during the run.

## Integration
- ◑ **Finder** right-click → "Clean up" (built as a Quick Action; needs packaging to install cleanly).

---

## Release gates — these decide "ready or not"
- ⬜ **One-download install** — bundle the model so there's no separate Ollama setup.
- ⬜ **Runs on any Mac** — ship a prebuilt, signed OCR binary (no Xcode tools needed by the user).
- ⬜ **Signed & notarized** app (passes Gatekeeper) + chosen distribution.
- ◑ **Stability** — thousands of files, odd/locked files, permissions, without crashing.

## Quality bars (acceptance — formerly bugs, now resolved)
- ✅ No silent no-op runs (cold model-load race fixed).
- ✅ Progress never looks frozen (the N/N "organizing folders…" phase is shown).
- ✅ "Loading model…" clears once classifying starts.

---

## Readiness verdict
**Feature-complete; not yet release-ready.** Every capability above is built and verified.
The gap is the **release layer**: it still needs a bundled model (no separate Ollama
install), a prebuilt/signed OCR binary (runtime `swiftc` breaks on machines without Xcode
tools), code signing + notarization, and a stability pass.

**Two caveats to keep visible:**
- Classification quality is **good, not perfect** — a local 3B lands ~mid-80s–90s% "reasonable"
  on diverse folders, with a real tail of misses. A stronger/bundled model raises this.
- Interactive **drag-and-drop** needs a hands-on test pass (logic verified; gestures can't be
  automated headlessly).
