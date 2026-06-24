# Folderai — App Store submission playbook

Build/sign mechanics live in **MAS.md**. This is the end-to-end path to TestFlight and
review, plus draft metadata so you can fill App Store Connect quickly.

> **Status (2026-06-24):** build `2026.0624.1559` (v1.0.0) is **uploaded and in TestFlight**.
> Signing + upload pipeline works. Remaining for *store review*: the `mas` app icon, screenshots,
> and publishing the privacy URL (GitHub Pages). TestFlight needs none of those.

---

## 0. Readiness checklist

**Code / build — DONE:**
- [x] Sandbox-compatible (in-process model, no external Ollama, no runtime `swiftc`)
- [x] Entitlements + sign script (`scripts/sign-mas.sh`, `build/entitlements.mas*.plist`)
- [x] Bundled model + Llama license/notice + "Built with Llama" in-app (Settings → About)
- [x] No-deletion guarantee (quarantine + undo); protected folders; folder grants
- [x] Version 1.0.0; bundle id `com.xintechllc.folderai`

**You must provide (assets / account):**
- [ ] **App icon** — a 1024×1024 PNG, converted to `build/icon.icns` (the build picks it
      up automatically). *Required — Apple rejects the default Electron icon.*
- [ ] **Screenshots** — Mac, one of: 1280×800, 1440×900, 2560×1600, or 2880×1800. 1–10 images.
- [ ] **Privacy policy URL** — host `PRIVACY.md` (e.g. a GitHub Pages page) and fill the date/email.
- [ ] **Support URL** (required) and optional Marketing URL.
- [ ] App Store Connect app record for `com.xintechllc.folderai` (you registered the ID + App Group).
- [ ] Certs + Mac App Store provisioning profile (you have these — see MAS.md).

---

## 1. Draft metadata (paste into App Store Connect)

- **Name:** Folderai
- **Subtitle (≤30):** `Tidy your Downloads, privately`
- **Primary category:** Utilities  ·  **Secondary:** Productivity
- **Age rating:** 4+
- **Keywords (≤100):** `downloads,organize,declutter,cleanup,files,folders,sort,tidy,local,private,offline,documents`
- **Promotional text (≤170):** `Tidy your messy Downloads with on-device AI. Review every move before it happens, nothing is ever deleted, and nothing leaves your Mac.`
- **Description:**

```
Folderai tidies your messy Downloads — and any folder — using AI that runs entirely on
your Mac. Nothing is uploaded; nothing leaves your device.

Scan a folder and Folderai groups files into the folders you already use, flags
duplicates and old installers, and leaves the rest alone. You review the full plan
before anything moves — and nothing is ever deleted: removals go to a Quarantine folder
you can undo.

• Private & on-device — a local AI model. No internet, no account, no tracking.
• Works with your existing folders — files land where you already keep them.
• Review first — see exactly what moves, where, and why before you click Clean up.
• Reversible — removals go to Quarantine; one-click Undo.
• Plain-language requests — e.g. "move PDFs into a Documents folder."
• Protected folders — mark folders Folderai must never touch.

Built with Llama.
```

- **Privacy nutrition label:** **Data Not Collected** (everything is local).
- **App Review notes:** "Folderai organizes files entirely on-device with a bundled local
  model — no network needed. On launch, grant a folder (e.g. Downloads) when prompted;
  Scan, then review the plan. It moves/renames within granted folders and never deletes
  (removals go to a Quarantine folder, with Undo). No account required."

---

## 2. Build, sign, upload  ✅ working

Per MAS.md, with your credentials set:
```bash
scripts/sign-mas.sh        # → /tmp/folderai-mas/Folderai-1.0.0.pkg (model + entitlements, quarantine stripped)
xcrun altool --upload-app --type osx --file /tmp/folderai-mas/Folderai-1.0.0.pkg \
  --username "<appleid>" --password "<app-specific-password>"
```
Or drag the `.pkg` into **Transporter**. Use an **app-specific password** (2FA rejects the
regular one). Each re-upload gets a fresh date-based build number automatically. See MAS.md for
the four validation rejections we already fixed in the script.

---

## 3. TestFlight (do this BEFORE submitting for review)

1. After upload, the build appears under your app → **TestFlight** in App Store Connect
   (a few minutes to "process"; you may get a one-time export-compliance question — answer
   "no" for non-standard encryption, since the app uses none beyond Apple's).
2. **Internal testers** (you + up to 100 team members): add them → they install via the
   **TestFlight** app on macOS. No beta review needed — available immediately.
3. (Optional) **External testers** (up to 10,000): requires a quick **Beta App Review**.
4. Install, run a real cleanup on your Mac, confirm it behaves.

## 4. Submit for review

1. App Store Connect → your app → **App Store** tab → create the **1.0** version.
2. Fill the metadata above, attach screenshots, set the privacy policy URL + the privacy
   label, choose pricing.
3. Select the uploaded build → **Add for Review** → **Submit**.
4. Typical review: ~24–48 h. If rejected, the most likely asks for this category are about
   folder-access justification (the App Review note above covers it) and the icon.

---

## Notes
- The bundled model makes the app ~2.5 GB — fine for the Mac App Store (Apple hosts it).
- Keep the **direct-distribution** path (Developer ID + notarize; `scripts/build.sh
  inprocess` then notarize) as a fallback if review stalls.
