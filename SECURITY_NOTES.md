# Dependency security notes — October 22, 2026

Electron is updated to 44.9.3, a supported release containing the published
Electron CA-store fix and Chromium security updates. Its embedded Node reports
24.22.0. The standalone Node runtime used for builds is separately pinned to
24.22.1. Updating the build runtime does not update Electron's embedded Node.

Do not treat a clean npm audit as evidence that every October 21 Node fix is
included in Electron. Verify the Electron release notes and move to a release
that incorporates those Node fixes as soon as it is available. Rebuild and
redistribute the desktop app after any Electron security update.

- https://releases.electronjs.org/release/v44.9.3
- https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
- https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9
