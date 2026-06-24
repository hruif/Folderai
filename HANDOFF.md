# Folderai — Handoff

Privacy-first desktop app (Electron) that cleans up a Downloads folder using a
**local Ollama model**. Everything runs on-device. Staging-first: nothing
touches disk until the user clicks Execute.

## Run

```bash
npm install
npm start            # dev run
npm run package      # build dist/Folderai-darwin-<arch>/Folderai.app (instant launch)
```

`@electron/packager` builds an unsigned `.app` (host arch). `bin/folderai` prefers
that packaged app and falls back to `npx electron .`. Single-instance lock in
main.js forwards a folder to an already-open window (`second-instance`).

Requires [Ollama](https://ollama.com) installed with a model pulled
(`ollama pull llama3.2:3b`). The app **auto-starts the Ollama server** itself, so
it doesn't need to be running beforehand. Falls back to rules-only if Ollama is
absent. Dev machine already has `llama3.2:3b`, `llama3.2:1b`, `deepseek-r1:7b`.

## How it works (pipeline)

1. **Scan** (`src/scanner.js`) — reads top level of the chosen folder (non-recursive).
   Also `gatherDestinations()` collects candidate destination folders across
   roots (Downloads, Documents, Desktop + user-added), one level deep, with a
   shallow layout summary per folder (`subfolders-only` / `files-only` / `mixed`).
2. **Rule-based plan** (`src/classifier.js` + `planByRules` in `src/planner.js`) —
   instant. Only flags obvious junk/temp/empty/installers for **delete**;
   everything else defaults to **keep**. Rules deliberately do NOT impose
   type-buckets (that broke the user's existing organization).
3. **AI refinement** (`refineWithModel`) — optional, gated behind a modal with a
   compute-time estimate + optional guidance text. Classifies **only loose files**
   (skips folders). Runs in batches of 12 but **streams** the model response
   (`ollama.chatStream` + `makeItemStreamer` incremental JSON parser), so each
   file is revealed one-by-one as the model emits it (~0.5s apart) at full batch
   speed — NOT 12 at once. For each file the model picks a destination *label*
   among the real folders, or keep/delete/new. If routed into a folder that has
   subfolders, `resolveDeepDest()` does an on-demand **deep drill** (one more
   model call) to sharpen the destination. Live progress bar with an **adaptive
   ETA** (sliding-window throughput in the renderer) + working **Stop** (aborts
   in-flight request via AbortController). 1-by-1 (non-batched) was measured ~5×
   slower, hence batch+stream.
4. **Plain-word prompts** (`applyPrompt`) — edits the staged plan via the model,
   respecting existing destinations.
5. **Execute** (`src/executor.js`) — moves files into destinations (absolute
   `destPath` for cross-location, else relative new folder inside scanned folder).
   **Deletes go to `_CleanupQuarantine/`** with a `restore-manifest.json` (never
   permanent). Cross-device safe, collision-safe naming, traversal guards.

## Key design decisions (don't regress these)

- **Staging-first** — every change is a reviewable action; Execute is the only
  thing that touches disk.
- **Rules never impose structure**; the model organizes using the user's REAL
  folders across locations. Files are NEVER dropped naked into a `subfolders-only`
  folder (drill picks/creates a subfolder).
- **Deletion guardrail** — the AI may move/keep freely but may NOT invent
  deletions; an AI "delete" is only honored if the deterministic rules already
  flagged it. Explicit "delete X" prompts still work.
- **AI result cache** (`src/cache.js`) — keyed by file path+size+mtime+guidance,
  persisted in userData. Unchanged files reused instantly; only misses hit the
  model. Auto-pruned on load; "Clear AI cache" button + "Re-run fresh" toggle.
- **Auto-managed Ollama** (`src/ollama.js` `ensureServer`/`stopServer`) — app
  starts the server if down; stops it on quit ONLY if the app started it AND the
  "Stop Ollama on exit" setting is on (`src/settings.js`, persisted).

## File map

| File | Role |
|------|------|
| `main.js` | Electron main + all IPC handlers; cache/settings lifecycle; Ollama auto-start/stop |
| `preload.js` | contextBridge `window.api` surface |
| `src/scanner.js` | top-level scan + `gatherDestinations` + `listSubfolders` |
| `src/classifier.js` | rule-based classification (junk/keep) |
| `src/planner.js` | `planByRules`, `classifyWithModel`, `resolveDeepDest`, `refineWithModel`, `applyPrompt` |
| `src/executor.js` | apply staged actions (move/quarantine) |
| `src/ollama.js` | local Ollama client (`chatJSON` + streaming `chatStream`) + server lifecycle |
| `src/cache.js` | classification result cache |
| `src/settings.js` | persisted settings |
| `src/finderSort.js` | detect a folder's current Finder sort (per-folder `.DS_Store` → global default → null), mapped to name/date/size |
| `bin/folderai` | CLI launcher — opens the app on a given folder (used by the Finder Quick Action) |
| `finder/` | Finder integration prototype: a "Clean up with Folderai" Quick Action (`.workflow`) + setup README. App is folder-aware via argv + macOS `open-file` (see `launchFolder` in main.js) |
| `renderer/` | UI (`index.html`, `styles.css`, `renderer.js`) — staging table, AI gate modal, prompt box, progress bar, sort control, destination dropdowns. Default view order is set from the folder's actual Finder sort on each scan (`finderSort` in the scan result), falling back to name |

## Important context / decisions made with the user

- **Model**: staying on **llama3.2:3b** (leaves headroom). 1B was tested and is
  too weak (mis-classifies, mis-deletes). The 3B is the practical floor and is
  still imperfect on routing/compound prompts — the staging UI is the safety net.
- **Eventual plan (NOT built)**: convert to a **truly embedded model** with
  `node-llama-cpp` (no Ollama at all), model **bundled at install** (user prefers
  honest upfront install over first-run downloads; use delta updates to keep app
  updates small). Auto-managed Ollama (current) is the agreed stopgap.
- **Roadmap (NOT built)**: classify by **file contents**, not just filenames —
  text extraction for PDFs/docx, macOS Vision OCR for images, a small VLM only
  where needed; powers content-aware rename / foldering. Keep the model layer
  pluggable. Read contents selectively (only when ambiguous) and cache by
  path+mtime.

## Open TODOs

- [ ] Persist user-added destination locations (`extraRoots`) across restarts
      (currently in-memory for the session). Mirror the settings.json pattern.
- [ ] Esc-to-dismiss on the AI gate modal (= Skip).
- [ ] `classified` count is overstated on Stop (reports `total - hits`, not files
      actually processed) — only shown in the non-cancelled status line, minor.
- [ ] Larger follow-ups: embedded model (node-llama-cpp), content-based
      classification/rename (see above).

## Testing notes

No formal test suite. Core modules were validated headlessly with throwaway
Node scripts (scan→plan→execute, AI routing, deep-drill, cache cold/warm/prune,
Stop abort, settings round-trip) and Electron boot smoke tests
(`timeout 8 npx electron .` grepping stderr for errors). The AI/model behavior is
non-deterministic on a 3B — verify the *mechanism*, not exact model choices.
Remember to `pkill -f "ollama serve"` after tests if you don't want it left running.
