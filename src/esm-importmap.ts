/**
 * ESM importmap support for nodeIntegration.
 *
 * When a page is loaded via loadFile() with nodeIntegration enabled, a
 * `<script type="importmap">` is injected into the HTML so that standard ES
 * module import statements resolve to the local ESM shim server:
 *
 *   import { readFileSync } from 'fs';   // works
 *   import path from 'node:path';        // works
 *
 * Each shim URL (`/__nww_esm__/<name>`) is served by the sync server and
 * returns an ES module that re-exports everything through window.require().
 */

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
 * Returns a `<script type="importmap">` HTML tag that maps every Node.js
 * built-in module name (and its 'node:' prefixed alias) to the ESM shim
 * endpoint served by the sync server.
 *
 * Must be the **first** element inside `<head>` so it takes effect before
 * any `<script type="module">` in the page.
 */
export function generateImportMapTag(syncServerPort: number): string {
  const base = `http://127.0.0.1:${syncServerPort}/__nww_esm__/`;
  const imports: Record<string, string> = {};
  // @devscholar/node-with-window → renderer-side shim (ipcRenderer, etc.)
  // Note: 'electron' is intentionally not aliased; use @devscholar/node-with-window directly.
  imports['@devscholar/node-with-window'] = base + '@devscholar/node-with-window';
  for (const name of NODE_BUILTINS) {
    imports[name] = base + name;
    imports[`node:${name}`] = base + name;
  }
  return `<script type="importmap">${JSON.stringify({ imports })}</script>`;
}
