/**
 * post-publish.js
 *
 * NOTE: This script is for INTERNAL DEVELOPER USE ONLY.
 * End users of this package do not need to run or care about this script.
 *
 * After publishing to npm, restore local file: dependencies so local
 * development continues to use the symlinked packages.
 *
 * Counterpart: scripts/pre-publish.js (swaps to npm versions before publish)
 * Triggered by: "postpublish" in package.json (runs automatically after `npm publish`)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, '..', 'package.json');
const localDepsPath = join(__dirname, '..', 'local-dependencies.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const { packages: localDeps } = JSON.parse(readFileSync(localDepsPath, 'utf-8'));

let changed = false;
for (const [name, localRef] of Object.entries(localDeps)) {
    if (pkg.dependencies?.[name] !== undefined) {
        const current = pkg.dependencies[name];
        pkg.dependencies[name] = localRef;
        changed = true;
        console.log(`[post-publish] ${name}: "${current}" → "${localRef}"`);
    }
}

if (changed) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
    console.log('[post-publish] package.json restored to local file: references.');
} else {
    console.log('[post-publish] No "latest" references found, nothing to restore.');
}
