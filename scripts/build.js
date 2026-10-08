// Build script — compiles every backend in a single tsc pass.
//
// Cross-platform compilation works because the platform-specific
// optionalDependencies are typed by ambient declarations in src/types/ (see
// node-ps1-dotnet.d.ts, node-with-gjs.d.ts, node-with-jxa.d.ts), so tsc never
// needs the real packages installed to resolve the backend imports. The
// runtime loading in src/index.ts is already tolerant of missing backends
// (Promise.allSettled), so a full three-backend dist can be produced from any
// single platform.

import { cpSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// 1. Compile all backends.
console.log('[build] Running tsc...');
execSync('npx tsc', { cwd: root, stdio: 'inherit' });

// 2. Copy the C# asset the WPF backend reads at runtime (tsc does not copy
//    non-TS files, and this is loaded via __dirname/Win32Helper.cs).
const csSrc = join(root, 'src/backend/netfx-wpf/Win32Helper.cs');
const csDst = join(root, 'dist/backend/netfx-wpf/Win32Helper.cs');
mkdirSync(join(root, 'dist/backend/netfx-wpf'), { recursive: true });
cpSync(csSrc, csDst);
console.log('[build] Copied Win32Helper.cs');

console.log('[build] Done.');
