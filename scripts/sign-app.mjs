// Sign a packaged .app for the Mac App Store via @electron/osx-sign's programmatic API
// (the 2.x CLI dropped --entitlements). The main app gets our parent entitlements
// (sandbox + allow-jit + application-groups + file access + bookmarks + network);
// nested code gets our inherit entitlements (sandbox + inherit + allow-jit).
// preAutoEntitlements (default) adds the team-identifier and the application-groups
// from the provisioning profile to the top-level app only.
//
// Usage: node scripts/sign-app.mjs <app.app> <parent-entitlements.plist> <child-entitlements.plist>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sign } from '@electron/osx-sign';

const [app, entitlements, entitlementsInherit] = process.argv.slice(2);
if (!app || !entitlements || !entitlementsInherit) {
  console.error('usage: sign-app.mjs <app> <parent-entitlements.plist> <child-entitlements.plist>');
  process.exit(1);
}
if (!process.env.MAS_APP_CERT || !process.env.PROVISION_PROFILE) {
  console.error('MAS_APP_CERT and PROVISION_PROFILE must be set');
  process.exit(1);
}

function helperApps(appPath) {
  const frameworks = path.join(appPath, 'Contents', 'Frameworks');
  if (!fs.existsSync(frameworks)) return [];
  return fs.readdirSync(frameworks, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app') && entry.name.includes('Helper'))
    .map((entry) => path.join(frameworks, entry.name));
}

function entitlementsFor(target) {
  return execFileSync('codesign', ['-d', '--entitlements', ':-', target], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function requireEntitlement(target, key) {
  const entitlementsXml = entitlementsFor(target);
  if (!entitlementsXml.includes(`<key>${key}</key>`)) {
    throw new Error(`${target} is missing required entitlement ${key}`);
  }
}

function verifyJitEntitlements(appPath) {
  const targets = [appPath, ...helperApps(appPath)];
  for (const target of targets) {
    requireEntitlement(target, 'com.apple.security.cs.allow-jit');
  }
  console.log(`› verified allow-jit entitlement on ${targets.length} app bundle(s)`);
}

try {
  await sign({
    app,
    identity: process.env.MAS_APP_CERT,
    platform: 'mas',
    type: 'distribution',
    provisioningProfile: process.env.PROVISION_PROFILE,
    entitlements,
    optionsForFile: (filePath) => (
      filePath.includes(`${path.sep}Contents${path.sep}`)
        ? { entitlements: entitlementsInherit }
        : { entitlements }
    ),
  });
  verifyJitEntitlements(app);
  console.log('› signed ok');
} catch (e) {
  console.error('SIGN FAILED:', (e && e.message) || e);
  process.exit(1);
}
