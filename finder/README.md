# FolderAI — Finder integration (prototype)

Right-click any folder in Finder → **Quick Actions → Clean up with FolderAI**, and
the app opens straight onto that folder and scans it. No hunting for an app.

This is a thin hand-off: Finder runs `bin/folderai <folder>`, which launches the
app pointed at that folder. The app does the rest (scan → AI → stage → execute).

## Install

```bash
# 0. build the app once so launch is instant (creates dist/FolderAI-darwin-*/FolderAI.app)
npm install && npm run package

# 1. make the launcher executable
chmod +x bin/folderai

# 2. install the Quick Action for your user
mkdir -p ~/Library/Services
cp -R "finder/FolderAI Cleanup.workflow" ~/Library/Services/

# 3. (first time) allow it in System Settings → Keyboard → Keyboard Shortcuts →
#    Services → Files and Folders → ensure "Clean up with FolderAI" is checked.
```

Then in Finder: right-click a folder → **Quick Actions / Services → Clean up with FolderAI**.

> The bundled workflow calls `$HOME/Documents/GitHub/Folderai/bin/folderai`. If you
> moved the project, edit the path in the Quick Action (Automator) or recreate it
> (below).

## If the Quick Action doesn't appear (recreate in ~30s)

macOS is picky about hand-authored `.workflow` bundles. The reliable path:

1. Open **Automator** → New → **Quick Action**.
2. "Workflow receives current" = **folders**, in **Finder**.
3. Add a **Run Shell Script** action; Shell `/bin/zsh`, **Pass input: as arguments**.
4. Paste:
   ```bash
   for f in "$@"; do
     "$HOME/Documents/GitHub/Folderai/bin/folderai" "$f"
   done
   ```
5. Save as **Clean up with FolderAI**.

## Notes

- `bin/folderai` prefers the packaged `dist/FolderAI-darwin-*/FolderAI.app` (instant
  launch) and falls back to `npx electron .` if you haven't run `npm run package`.
- It runs the app binary directly with the folder as an argument. A single-instance
  lock (in `main.js`) means if the app is already open, the folder is forwarded to
  the running window (`second-instance`) instead of opening a second copy.
- A **menu-bar (tray) presence** is the natural companion — always available,
  click to open — and removes the launch step entirely.
