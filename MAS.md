# Mac App Store submission

**Status (2026-06-24): the build + sign + upload pipeline works end-to-end.** The first build
(`2026.0624.1559`, v1.0.0, App Apple ID 6783997657) is uploaded and in TestFlight. This is the
checklist for the account-side parts plus how to build + sign + upload. See `APPSTORE.md` for the
listing/metadata + TestFlight/review flow, and `HANDOFF.md` for the architecture.

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
export APPLE_TEAM_ID="Y97FTNGTB8"
export MAS_APP_CERT="Apple Distribution: Xintech LLC (Y97FTNGTB8)"          # the modern unified cert; "3rd Party Mac Developer Application" also works
export MAS_INSTALLER_CERT="3rd Party Mac Developer Installer: Xintech LLC (Y97FTNGTB8)"
export PROVISION_PROFILE="$HOME/Downloads/Folderai_Mac_App_Store.provisionprofile"

scripts/sign-mas.sh
```

This precompiles the OCR helper, bundles the gguf, builds the **mas** Electron target with
`--no-asar`, sets `LSMinimumSystemVersion 12.0`, embeds the profile, bakes your Team ID into
`build/entitlements.mas.plist`, **strips `com.apple.quarantine`**, signs via
`scripts/sign-app.mjs` (@electron/osx-sign's programmatic `sign()`), and produces a signed
`Folderai-<version>.pkg`. Set `FA_BUILD` to override the auto date-based `CFBundleVersion`.

Signing uses the **programmatic API**, not the CLI: @electron/osx-sign 2.x dropped the
`--entitlements` CLI flag (and `npx @electron/osx-sign` can't resolve its `electron-osx-sign`
bin). `sign-app.mjs` passes our parent entitlements to the main app and our inherit
entitlements to nested code; `preAutoEntitlements` auto-adds the team-identifier +
application-groups from the profile to the top-level app. The script verifies
`com.apple.security.cs.allow-jit` on the main app and Electron helper apps after signing.

## Upload

- **Transporter.app** (App Store, easiest): drag in the `.pkg`.
- or CLI: `xcrun altool --upload-app --type osx --file Folderai-*.pkg --username <appleid> --password <app-specific-pw>`
  (or `--apiKey <KEY_ID> --apiIssuer <ISSUER_ID>` with an App Store Connect API key)

**2FA gotcha:** your *regular* Apple ID password is rejected as "account or password incorrect."
Use an **app-specific password** (appleid.apple.com → Sign-In and Security → App-Specific
Passwords) or an ASC API key. `altool` reporting "UPLOAD SUCCEEDED" only means it transferred —
Apple's post-processing emails any rejections minutes later.

## Validation rejections we hit (and how they're fixed in `sign-mas.sh`)

Apple validates **after** upload and rejects one issue at a time — expect to iterate:
1. **No bundle id in a nested bundle** — the legacy `finder/*.workflow` → now `finder/` (and
   `docs/`) are excluded from the package.
2. **arm64 without x86_64** — arm64-only is only allowed if the deployment target is 12.0+ →
   `LSMinimumSystemVersion` is set to `12.0` (we ship Apple-Silicon-only; no Intel slice).
3. **ITMS-91109 `com.apple.quarantine`** — files downloaded via a browser (the provisioning
   profile from ~/Downloads) carry it → `xattr -cr "$APP"` runs **before** signing.
4. **Reused build number** — a rejected `CFBundleVersion` can't be re-uploaded → it's now
   date-based and increments every run.

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
  apps. Only `allow-jit` is allowed, and it must be present on the main app and Electron
  helpers. If it is missing, Electron/V8 can crash before app code runs with
  `Fatal process out of memory: Failed to reserve virtual memory for CodeRange`; launching
  with `--js-flags=--jitless` is a useful confirmation, not a shippable fix.
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
