// Build script — hides platform-foreign backend source dirs before tsc so that
// TypeScript never resolves optional dependencies that exist only on other OSes.
// Restores everything afterwards (try/finally).

import { renameSync, existsSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const FOREIGN = {
  darwin: ['src/backend/gjs-gtk4', 'src/backend/netfx-wpf'],
  linux:  ['src/backend/jxa-cocoa', 'src/backend/netfx-wpf'],
  win32:  ['src/backend/gjs-gtk4', 'src/backend/jxa-cocoa'],
}[process.platform] ?? [];

// Non-Linux platforms don't have @girs/gjs installed, so patch tsconfig
// to remove it from the "types" array during compilation.
const TSCONFIG = join(root, 'tsconfig.json');
let tsconfigOriginal = null;
if (process.platform !== 'linux') {
  tsconfigOriginal = readFileSync(TSCONFIG, 'utf8');
  const patched = tsconfigOriginal.replace(/"@girs\/gjs"\s*,\s*|\s*"@girs\/gjs"/, '');
  writeFileSync(TSCONFIG, patched, 'utf8');
  console.log('[build] Patched tsconfig.json: removed @girs/gjs from types');
}

// 1. Hide foreign backend dirs (dot-prefix so tsc's ** glob skips them)
const hidden = [];
for (const rel of FOREIGN) {
  const abs = join(root, rel);
  if (existsSync(abs)) {
    const tmp = join(root, 'src/backend', '.' + rel.split('/').pop());
    renameSync(abs, tmp);
    hidden.push({ abs, tmp });
    console.log(`[build] Hidden: ${rel} → src/backend/.${rel.split('/').pop()}`);
  }
}

try {
  // 2. Run tsc
  console.log('[build] Running tsc...');
  execSync('npx tsc', { cwd: root, stdio: 'inherit' });
} finally {
  // 3. Restore tsconfig if patched
  if (tsconfigOriginal) {
    writeFileSync(TSCONFIG, tsconfigOriginal, 'utf8');
    console.log('[build] Restored tsconfig.json');
  }
  // 4. Restore hidden dirs
  for (const { abs, tmp } of hidden) {
    if (existsSync(tmp)) {
      renameSync(tmp, abs);
      console.log(`[build] Restored: ${abs}`);
    }
  }
}

// 4. Copy Win32Helper.cs (Windows only)
if (process.platform === 'win32') {
  const csSrc = join(root, 'src/backend/netfx-wpf/Win32Helper.cs');
  if (existsSync(csSrc)) {
    const csDst = join(root, 'dist/backend/netfx-wpf/Win32Helper.cs');
    mkdirSync(join(root, 'dist/backend/netfx-wpf'), { recursive: true });
    cpSync(csSrc, csDst);
    console.log('[build] Copied Win32Helper.cs');
  }
}

console.log('[build] Done.');
