// Sign a packaged .app for the Mac App Store via @electron/osx-sign's programmatic API
// (the 2.x CLI dropped --entitlements). The MAIN app gets our parent entitlements
// (sandbox + allow-jit + application-groups + file access + bookmarks + network); the
// Electron helpers + ocr-helper + node-llama-cpp .node get osx-sign's default child
// (app-sandbox + inherit). preAutoEntitlements (default) adds the team-identifier and
// the application-groups from the provisioning profile.
//
// Usage: node scripts/sign-app.mjs <app.app> <parent-entitlements.plist>
import { signAsync } from '@electron/osx-sign';

const [app, entitlements] = process.argv.slice(2);
if (!app || !entitlements) {
  console.error('usage: sign-app.mjs <app> <parent-entitlements.plist>');
  process.exit(1);
}
if (!process.env.MAS_APP_CERT || !process.env.PROVISION_PROFILE) {
  console.error('MAS_APP_CERT and PROVISION_PROFILE must be set');
  process.exit(1);
}

try {
  await signAsync({
    app,
    identity: process.env.MAS_APP_CERT,
    platform: 'mas',
    type: 'distribution',
    provisioningProfile: process.env.PROVISION_PROFILE,
    entitlements, // parent (main app); helpers fall back to osx-sign's default child
  });
  console.log('› signed ok');
} catch (e) {
  console.error('SIGN FAILED:', (e && e.message) || e);
  process.exit(1);
}
