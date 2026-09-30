import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Searches common locations for the WebView2 runtime DLLs.
 *
 * Looks for:
 * - Microsoft.Web.WebView2.Core.dll
 * - Microsoft.Web.WebView2.Wpf.dll
 *
 * Expects the versioned subdirectory layout (runtimes/webview2/<version>/).
 *
 * Primary search is relative to this file's location (import.meta.url),
 * which is reliable regardless of the working directory of the host app.
 * This is what allows the DLLs to be bundled inside the npm package and
 * discovered through node_modules automatically.
 */
export function findWebView2Runtime(): string {
  // __dirname of this compiled file is dist/backend/netfx-wpf/
  // Runtimes are at <package-root>/runtimes/webview2/
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRootRuntimes = path.resolve(thisDir, '..', '..', '..', 'runtimes', 'webview2');

  const possibleBasePaths = [
    packageRootRuntimes,
    path.resolve(
      process.cwd(),
      'node_modules',
      '@devscholar',
      'node-with-window',
      'runtimes',
      'webview2'
    ),
    path.resolve(process.cwd(), 'runtimes', 'webview2'),
    path.resolve(process.cwd(), '..', 'node-with-window', 'runtimes', 'webview2'),
    path.resolve(
      process.cwd(),
      '..',
      '..',
      'node_modules',
      '@devscholar',
      'node-with-window',
      'runtimes',
      'webview2'
    ),
  ];

  for (const basePath of possibleBasePaths) {
    if (!fs.existsSync(basePath)) {
      continue;
    }

    // Check for versioned subdirectory layout
    const entries = fs.readdirSync(basePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const runtimePath = path.join(basePath, entry.name);
        const coreDllPath = path.join(runtimePath, 'Microsoft.Web.WebView2.Core.dll');
        const wpfDllPath = path.join(runtimePath, 'Microsoft.Web.WebView2.Wpf.dll');
        if (fs.existsSync(coreDllPath) && fs.existsSync(wpfDllPath)) {
          return runtimePath;
        }
      }
    }
  }

  throw new Error(`WebView2 DLLs not found. Searched in: ${possibleBasePaths.join(', ')}`);
}
