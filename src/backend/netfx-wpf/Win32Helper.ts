// src/backend/netfx-wpf/Win32Helper.ts
// Loads Win32Helper.cs at runtime — avoids all JSON escape issues with the C# source.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getWin32HelperSource(): string {
    return fs.readFileSync(path.join(__dirname, 'Win32Helper.cs'), 'utf8');
}
