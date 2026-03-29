/**
 * pre-publish.js
 *
 * NOTE: This script is for INTERNAL DEVELOPER USE ONLY.
 * End users of this package do not need to run or care about this script.
 *
 * Before publishing to npm, replace local file: dependencies with their
 * published npm versions so the packed tarball has correct dependencies
 * for npm consumers.
 *
 * Counterpart: scripts/post-publish.js (restores local file: references)
 * Triggered by: "prepublishOnly" in package.json (runs automatically before `npm publish`)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, '..', 'package.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

const LOCAL_DEPS = {
    '@devscholar/node-ps1-dotnet': 'file:../node-ps1-dotnet',
};

let changed = false;
for (const [name, localRef] of Object.entries(LOCAL_DEPS)) {
    if (pkg.dependencies?.[name] === localRef) {
        pkg.dependencies[name] = 'latest';
        changed = true;
        console.log(`[pre-publish] ${name}: "${localRef}" → "latest"`);
    }
}

if (changed) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
    console.log('[pre-publish] package.json updated for npm publish.');
} else {
    console.log('[pre-publish] No local file: references found, nothing to change.');
}
