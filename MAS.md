# Mac App Store submission

Everything code-side is done. This is the checklist for the parts only you can do
(they need your Apple Developer account), plus how to build + sign + upload.

## What you provide (one-time setup in the Apple Developer portal)

1. **Apple Developer Program** membership ($99/yr).
2. **App Store Connect → a new macOS app** with bundle ID `com.xintechllc.folderai`
   (change it in `package.json` / `scripts/*.sh` if you want a different one — keep it
   consistent everywhere).
3. **An App Group**: register `com.xintechllc.folderai` so the identifier becomes
   `<TEAMID>.com.xintechllc.folderai`. Electron's main process needs this or it crashes at
   launch (the `application-groups` entitlement — verified in our sandbox spike).
4. **Two certificates** (Certificates, Identifiers & Profiles):
   - `3rd Party Mac Developer Application: <you> (<TEAMID>)`
   - `3rd Party Mac Developer Installer: <you> (<TEAMID>)`
5. **A Mac App Store provisioning profile** for `com.xintechllc.folderai` that **includes the
   App Group**. Download it as `embedded.provisionprofile`.

## Build + sign + package

```bash
export APPLE_TEAM_ID="AB12CD34EF"
export MAS_APP_CERT="3rd Party Mac Developer Application: Your Name (AB12CD34EF)"
export MAS_INSTALLER_CERT="3rd Party Mac Developer Installer: Your Name (AB12CD34EF)"
export PROVISION_PROFILE="$HOME/path/to/embedded.provisionprofile"

scripts/sign-mas.sh
```

This precompiles the OCR helper, builds the **mas** Electron target with `--no-asar`,
embeds the profile, bakes your Team ID into `build/entitlements.mas.plist`, signs the
app + every nested binary (Electron helpers, `ocr-helper`, node-llama-cpp `.node`) with
the inherit entitlements, and produces a signed `FolderAI-<version>.pkg`.

## Upload

- **Transporter.app** (App Store, easiest): drag in the `.pkg`.
- or CLI: `xcrun altool --upload-app --type osx --file FolderAI-*.pkg --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>`

Then finish the listing in App Store Connect and submit for review.

## Things to know (from the research + the sandbox spike)

- **The model is BUNDLED** (no first-run download). `scripts/sign-mas.sh` copies the
  gguf into `Resources/models/llama3.2-3b.gguf`; `src/model.js` uses that bundled copy
  directly (the sandbox can't reach an external Ollama blob). Apple hosts the ~2 GB app
  for free, so it works offline immediately. (Alternative — a small app + first-run
  download via `FA_MODEL_URL` — remains supported in `src/model.js` if ever preferred.)
  Bundling redistributes the Llama 3.2 weights, so comply with the Llama 3.2 license
  (attribution + bundled license/notice; see the in-app About/credits).
- **Entitlements are deliberately minimal.** Do NOT add
  `com.apple.security.cs.allow-unsigned-executable-memory` — it's banned for App Store
  apps. Only `allow-jit` is allowed (and present).
- **No auto-update / crash reporter** in MAS Electron builds (Apple handles updates).
- **Known Electron risk:** an open macOS-26 V8/MAP_JIT MAS startup bug
  (electron/electron#51351) — test launch on your target OS early.
- **Product scope** (already enforced in code): user-granted folders only
  (Documents/Desktop/Downloads), a do-not-touch protected list, and **no deletion** —
  removals go to Quarantine. Keep it that way; it's what makes the app sandbox- and
  review-compatible.

## Direct-distribution fallback (no App Store)

Same codebase, far fewer hoops: `scripts/build.sh inprocess`, then sign with a
**Developer ID Application** cert + `xcrun notarytool`. No sandbox, full file access,
your own updater. Keep this as the safety net.
