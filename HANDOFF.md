# Folderai — Handoff

Privacy-first macOS app (Electron) that tidies messy folders (Downloads, and any folder)
with a **local, on-device AI model**. Everything runs on-device — nothing is uploaded.
**Staging-first**: nothing touches disk until the user clicks "Clean up", and **nothing is
ever deleted** — removals go to a Quarantine folder with one-click Undo.

---

## Current status (2026-06-24)

**The first Mac App Store build is uploaded and in TestFlight processing** — build
`2026.0624.1559`, version 1.0.0, App Apple ID 6783997657, bundle `com.xintechllc.folderai`
(Team `Y97FTNGTB8`, Xintech LLC). The full signing + upload pipeline works end-to-end.

- ✅ In-process inference (no external Ollama) — sandbox-proven
- ✅ App sandbox + entitlements + signing pipeline (`scripts/sign-mas.sh`)
- ✅ Model bundled in the app (offline, no first-run download)
- ✅ No-deletion guarantee (quarantine + Undo), protected folders, folder grants
- ✅ Uploaded to App Store Connect; cleared all four validation rejections (see below)

**Pending before *store review*** (TestFlight doesn't need these):
1. **App icon doesn't apply on the `mas` packager target** — `build/icon.icns` (a placeholder
   broom mark) embeds fine on the regular `darwin` build but `electron-packager` skips it on
   `mas` (warns `…with extension ".icon"`). Unsolved; required for store review.
2. **Store metadata + screenshots** — drafts in `APPSTORE.md`; Mac screenshots must be exactly
   1280×800 / 1440×900 / 2560×1600 / 2880×1800.
3. **Website / privacy-policy URL** — `docs/` is the project-site source; enable GitHub Pages
   (Settings → Pages → main `/docs`) to publish `https://hruif.github.io/Folderai/` and
   `https://hruif.github.io/Folderai/privacy.html`.

---

## Two backends, one switchboard

`src/inference.js` selects the inference backend:
- **In-process (App Store):** `src/llama.js` — `node-llama-cpp` (linked llama.cpp, no server/
  subprocess/binary → sandbox-compatible). Active when `FA_BACKEND=llama`. `main.js` sets this
  when it detects a bundled `inprocess.flag` (added by `scripts/build.sh inprocess` and
  `scripts/sign-mas.sh`). Metal GPU offload; sequence pool for concurrency; clean `dispose()`
  on quit (fixes a quit crash — the Metal context must be torn down before exit).
- **Ollama (dev default):** `src/ollama.js` — auto-starts/stops a local Ollama server. Used in
  `npm start` dev runs. Requires `ollama pull llama3.2:3b`.

The model is **llama3.2:3b** (1B was too weak — mis-routes/mis-deletes). The 3B is still
imperfect on routing/compound prompts; the staging UI is the safety net. For MAS the gguf is
bundled at `Resources/models/llama3.2-3b.gguf` (`src/model.js` prefers the bundled copy;
falls back to copying a local Ollama blob, or `FA_MODEL_URL` download).

## Pipeline

1. **Scan** (`src/scanner.js`) — top level of the chosen folder + `gatherDestinations()` across
   roots (Downloads/Documents/Desktop + user-added), one level deep with a layout summary.
2. **Rule plan** (`src/classifier.js` + `planByRules`) — instant; flags only obvious junk/
   installers for removal, everything else **keep**. Rules never impose type-buckets.
3. **AI refinement** (`refineWithModel`) — gated behind a modal with a time estimate + optional
   guidance. Classifies loose files only, batched + streamed (revealed one-by-one). Routes files
   into the user's **existing** folders. `destForGroup` (`src/planner.js`) is **code-aware**:
   `444_HW.pdf` → existing `cse444` or `CSE/444` (matches 3-digit + `cseNNN` codes against dest
   leaf names AND subfolders, ignoring bare years).
4. **Plain-word prompts** (`applyPrompt`) — deterministic rule pass → fuzzy model pass; a
   delete-safety rail means an AI "delete" is only honored if the rules already flagged it.
5. **Execute** (`src/executor.js`) — moves within granted folders; **removals → Quarantine**
   (`restore-manifest.json`, cross-device safe, traversal-guarded); hard-guards protected paths.

## App-sandbox specifics (App Store build)

- Entitlements: `build/entitlements.mas.plist` (parent — app-sandbox, allow-jit, application-
  groups, files.user-selected.read-write, files.bookmarks.app-scope, network.client). `__TEAMID__`
  is substituted at sign time. Helpers use osx-sign's default child (app-sandbox + inherit).
- **`application-groups` is mandatory** — Electron's Mach-port rendezvous crashes at launch
  without it (found in the sandbox spike).
- **Security-scoped bookmarks** (`src/scope.js`) persist folder access across launches; `main.js`
  `withAccess()` wraps file ops in start/stopAccessingSecurityScopedResource.
- `--no-asar` so native `.node`/`ocr-helper` are real signable files.
- OCR: precompiled Vision `ocr-helper` bundled (no runtime `swiftc`, which the sandbox forbids).

## Signing + upload (this is the part that took iteration)

`scripts/sign-mas.sh` → `scripts/sign-app.mjs`:
- Signs via **@electron/osx-sign's programmatic `sign()`** (NOT `signAsync`; the 2.x **CLI
  dropped `--entitlements`** and `npx @electron/osx-sign` can't resolve its bin). Our parent
  entitlements go to the main app; `preAutoEntitlements` (default) auto-adds team-identifier +
  application-groups from the provisioning profile.
- **Four Apple validation rejections, each fixed (iterate one at a time):**
  1. bundled `finder/*.workflow` had no bundle id → exclude `finder/` (and `docs/`) from the build.
  2. arm64-only rejected at min 10.15 → set `LSMinimumSystemVersion 12.0` (Apple-Silicon-only).
  3. **ITMS-91109**: `embedded.provisionprofile` (copied from ~/Downloads) carried
     `com.apple.quarantine` → `xattr -cr "$APP"` **before** signing.
  4. a rejected build number can't be reused → `--build-version` is a date-based `CFBundleVersion`
     (`FA_BUILD` env or `date +%Y.%m%d.%H%M`), independent of the 1.0.0 marketing version.
- **Upload:** `xcrun altool --upload-app --type osx --file <pkg> --username <appleid> --password
  <app-specific-pw>`. The regular Apple ID password fails ("account or password incorrect") under
  2FA — use an **app-specific password** (appleid.apple.com) or an ASC API key. Transporter.app is
  the GUI alternative. `altool` success = uploaded; Apple's post-processing emails rejections minutes later.

## File map

| File | Role |
|------|------|
| `main.js` | Electron main + IPC; backend detection; `withAccess` bookmarks; quit-time `dispose()` |
| `src/inference.js` | backend switchboard (`FA_BACKEND=llama` → in-process, else Ollama) |
| `src/llama.js` | in-process node-llama-cpp backend (chat/stream/warmup/dispose) |
| `src/ollama.js` | dev Ollama client + server lifecycle |
| `src/model.js` | model delivery — bundled gguf preferred, else copy Ollama blob / `FA_MODEL_URL` |
| `src/scope.js` | granted + protected folders, security-scoped bookmarks (userData/scope.json) |
| `src/scanner.js` | top-level scan + `gatherDestinations` |
| `src/planner.js` | rules, `classifyWithModel`, `destForGroup` (code-aware), `applyPrompt` |
| `src/executor.js` | apply actions; quarantine-only; protected-path guards |
| `src/ocr.js` | bundled Vision `ocr-helper` (no runtime swiftc) |
| `renderer/` | UI — staging table, AI gate, settings, progress + work-weighted ETA |
| `scripts/build.sh` | `[inprocess]` build → `dist-inprocess/Folderai.app` (dev/test; auto-uses `build/icon.icns`) |
| `scripts/sign-mas.sh` + `scripts/sign-app.mjs` | MAS build + sign + signed `.pkg` |
| `finder/` | legacy Finder Quick Action (`.workflow`) — **excluded from the MAS build** |
| `docs/` | GitHub Pages project site: landing, support, privacy, real app screenshots |
| `scripts/capture-folderai-website-shots.js` | Regenerates `docs/assets/*screenshot.png` from the Electron renderer and rebuilds the hero image |
| `APPSTORE.md` / `MAS.md` / `PRIVACY.md` | submission playbook / build guide / policy |

## Recent UI/features (this session)

- **Renamed** FolderAI → Folderai (lowercase wordmark).
- **Start fresh** (Settings → Maintenance) — clears the saved plan + cache + learned changes and
  empties the view (the prior "Clear AI cache" left the restored `staged-plan.json` on screen).
- **Work-weighted ETA** — projects by size/type-weighted work, not raw file count, so a burst of
  tiny files doesn't skew it (`computeEta`/`buildEtaUnits` in `renderer.js`).
- **AI-gate note** reflects "Re-run from scratch" (no "reused instantly" when ignoring cache).
- **Existing-folder routing** fix (code-aware `destForGroup`).
- De-jargoned/decluttered UI; Destinations merged (one "Add destination"); min window size;
  settings overflow fixed; centered settings gear.

## Run / build

```bash
npm install
npm start                 # dev run (Ollama backend) — needs `ollama pull llama3.2:3b`
npm run build             # scripts/build.sh inprocess → dist-inprocess/Folderai.app (in-process, unsigned)
npm run build:mas         # scripts/sign-mas.sh → signed .pkg (needs the env vars below)
```

MAS signing env (Xintech LLC):
```bash
export APPLE_TEAM_ID="Y97FTNGTB8"
export MAS_APP_CERT="Apple Distribution: Xintech LLC (Y97FTNGTB8)"
export MAS_INSTALLER_CERT="3rd Party Mac Developer Installer: Xintech LLC (Y97FTNGTB8)"
export PROVISION_PROFILE="$HOME/Downloads/Folderai_Mac_App_Store.provisionprofile"
```

## Open TODOs

- [ ] **`mas` app icon** — make `electron-packager` apply `build/icon.icns` on the mas target
      (required for store review).
- [ ] Replace the **placeholder icon** with a designed 1024×1024.
- [ ] Store metadata + correctly-sized screenshots; enable GitHub Pages for the privacy URL.
- [ ] Re-add the deferred deterministic rules — bulk-pattern apply-prompt handler and
      series/course filename-rescue (the 3B omits ~30% of files); both were built then removed.
- [ ] Esc-to-dismiss on the AI gate; minor `classified`-count overstatement on Stop.
- [ ] Content-based classification/rename roadmap (text/OCR/VLM where ambiguous).

## Testing notes

No formal suite. Validate the *mechanism* (scan→plan→execute, routing, cache, Stop, settings)
headlessly + Electron boot smoke (`timeout 8 npx electron .`, grep stderr). The 3B is
non-deterministic — don't assert exact model choices. **Set `HOME` to a temp dir before
execute()/classify tests**, or they mutate the real `~/Documents`. After Ollama tests,
`pkill -f "ollama serve"` (but never while the user is running the app).
```
