// src/utils.ts
import * as path from 'node:path';

declare const Deno: any;

export function getPowerShellPath(): string {
    const isDeno = typeof Deno !== 'undefined';
    if (isDeno) {
        const windir = Deno.env.get('windir') || 'C:\\Windows';
        return path.join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    }
    return 'powershell.exe';
}
