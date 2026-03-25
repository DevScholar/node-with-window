/**
 * ESM importmap support for nodeIntegration.
 *
 * When a page is loaded via loadFile() with nodeIntegration enabled, a
 * `<script type="importmap">` is injected into the HTML so that standard ES
 * module import statements resolve to the local ESM shim server:
 *
 *   import { readFileSync } from 'fs';   // works
 *   import path from 'node:path';        // works
 *   import axios from 'axios';           // works (CJS packages in project)
 *
 * Each shim URL (`/__nww_esm__/<name>`) is served by the sync server and
 * returns an ES module that re-exports everything through window.require().
 *
 * Note: ESM-native packages (no CJS export) will fail at require() time.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Complete list of Node.js 18+ built-in module names.
 * Both bare names ('fs') and 'node:' prefixed forms ('node:fs') are mapped in
 * the importmap so either import style resolves to the same shim.
 */
export const NODE_BUILTINS: readonly string[] = [
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster',
  'console', 'crypto', 'dgram', 'diagnostics_channel', 'dns',
  'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'querystring', 'readline', 'repl', 'stream', 'string_decoder',
  'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm',
  'worker_threads', 'zlib',
  // Sub-path variants
  'assert/strict',
  'dns/promises',
  'fs/promises',
  'path/posix', 'path/win32',
  'readline/promises',
  'stream/consumers', 'stream/promises', 'stream/web',
  'timers/promises',
  'util/types',
];

/**
 * Reads the user project's package.json and returns all declared dependency
 * names (dependencies + devDependencies + peerDependencies).
 * Returns an empty array if package.json is absent or unreadable.
 */
export function getUserPackageNames(): string[] {
  try {
    const pkgPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    const allDeps = {
      ...pkg['dependencies'] as Record<string, string> | undefined,
      ...pkg['devDependencies'] as Record<string, string> | undefined,
      ...pkg['peerDependencies'] as Record<string, string> | undefined,
    };
    return Object.keys(allDeps);
  } catch {
    return [];
  }
}

/**
 * Builds the full `imports` map for nodeIntegration importmap injection.
 * Includes Node.js builtins, @devscholar/node-with-window, and all packages
 * declared in the user project's package.json.
 */
export function buildImports(syncServerPort: number): Record<string, string> {
  const base = `http://127.0.0.1:${syncServerPort}/__nww_esm__/`;
  const imports: Record<string, string> = {};

  // @devscholar/node-with-window → renderer-side shim (ipcRenderer, etc.)
  imports['@devscholar/node-with-window'] = base + '@devscholar/node-with-window';

  // Node.js built-ins (bare and node: prefixed)
  for (const name of NODE_BUILTINS) {
    imports[name] = base + name;
    imports[`node:${name}`] = base + name;
  }

  // User project npm packages
  for (const pkg of getUserPackageNames()) {
    if (!(pkg in imports)) imports[pkg] = base + pkg;
  }

  return imports;
}

/**
 * Returns a `<script type="importmap">` HTML tag mapping every Node.js
 * built-in and user project package to the ESM shim endpoint.
 *
 * Must be the **first** element inside `<head>` so it takes effect before
 * any `<script type="module">` in the page.
 */
export function generateImportMapTag(syncServerPort: number): string {
  return `<script type="importmap">${JSON.stringify({ imports: buildImports(syncServerPort) })}</script>`;
}
