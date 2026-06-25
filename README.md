# Folderai — Local Downloads Cleaner

A privacy-first desktop prototype that tidies up your Downloads folder. All
processing happens on your machine — classification runs on a **local Ollama
model**, and nothing is ever sent to the cloud.

## What it does

1. **Reads & classifies** every top-level file and folder (deterministic rules,
   refined by your local model).
2. **Groups** files into category folders (`Images/`, `Documents/`, …) and flags
   disposable clutter (installers, temp downloads, empties, junk).
3. **Stages everything for review** — no change touches disk until you click
   *Execute*. Toggle, re-categorize, or change any action inline.
4. **Plain-word requests** — type things like *"keep all PDFs in place"* or
   *"delete old screenshots"* and the local model rewrites the staged plan.
5. **Safe deletes** — items marked *delete* are moved to a `_CleanupQuarantine/`
   folder with a `restore-manifest.json`, so nothing is ever permanently lost.

## Requirements

- [Node.js](https://nodejs.org) 18+
- [Ollama](https://ollama.com) running locally with a model pulled, e.g.:
  ```bash
  ollama pull llama3.2:3b
  ```
  (The app still works rules-only if Ollama is offline — the *Use AI* toggle
  just turns off.)

## Run

```bash
npm install
npm start
```

## Website

The GitHub Pages project site lives in `docs/`. If Pages is enabled for
`main` / `docs`, it publishes as `https://hruif.github.io/Folderai/`.

To refresh the site screenshots from the actual Electron renderer:

```bash
PATH=/opt/homebrew/bin:$PATH ./node_modules/.bin/electron scripts/capture-folderai-website-shots.js
```

## How it works

| Layer | File |
|-------|------|
| Electron entry / IPC | `main.js`, `preload.js` |
| Folder scan (metadata) | `src/scanner.js` |
| Rule-based classifier | `src/classifier.js` |
| Local-model client | `src/ollama.js` |
| Plan + prompt editing | `src/planner.js` |
| Staged execution + quarantine | `src/executor.js` |
| Review UI | `renderer/` |

## Prototype notes

- Scanning is **top-level only** by design — it organizes your Downloads root and
  leaves nested folder contents untouched.
- The model is used as a *refinement* over rules; if it returns unusable output,
  the reliable rule-based classification is kept.
- To restore quarantined files, see `_CleanupQuarantine/restore-manifest.json`
  (each entry records the original path).
- **Small-model caveat:** plain-word requests are most reliable when *single-intent*
  ("keep all PDFs in place", "delete installers", "move music into a Tunes folder").
  Compound instructions ("keep PDFs **and** delete installers") can be partially
  applied by a 3B model. This is why review is staging-first — just verify and
  fix any row inline before executing. A larger local model improves this.
