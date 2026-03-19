#!/usr/bin/env node
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

let runtime = 'node', target = null;
const extraArgs = [];
for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--runtime=')) runtime = arg.slice(10);
    else if (arg.startsWith('-r='))    runtime = arg.slice(3);
    else if (!target)                  target = arg;
    else                               extraArgs.push(arg);
}

const cwd = process.cwd();

// Resolve target: "." or omitted → read package.json "main", then try main.js, main.ts
if (!target || target === '.') {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg.main) target = pkg.main;
        } catch { /* ignore */ }
    }
    if (!target) target = fs.existsSync(path.join(cwd, 'main.js')) ? 'main.js' : 'main.ts';
}

const targetFile = path.resolve(cwd, target);
if (!fs.existsSync(targetFile)) {
    console.error(`[node-with-window] Error: ${targetFile} not found`);
    process.exit(1);
}

const isTs = targetFile.endsWith('.ts');
const isWin = process.platform === 'win32';

// JS entry: run directly without building
if (!isTs) {
    console.log(`[node-with-window] Running ${target} with ${runtime}...`);
    const runArgs = runtime === 'deno'
        ? ['run', '--allow-all', targetFile, ...extraArgs]
        : [targetFile, ...extraArgs];
    const proc = spawn(runtime, runArgs, { stdio: 'inherit', cwd });
    proc.on('exit', code => process.exit(code ?? 0));
    process.exit; // keep process alive for the spawn
} else {
    // TS entry: build with esbuild first
    const outfile = path.join(cwd, 'dist', 'main.js');
    fs.mkdirSync(path.dirname(outfile), { recursive: true });

    const esbuildLocal = path.join(cwd, 'node_modules/.bin', isWin ? 'esbuild.cmd' : 'esbuild');
    const usingLocal   = fs.existsSync(esbuildLocal);
    const esbuildCmd   = usingLocal ? esbuildLocal : (isWin ? 'npx.cmd' : 'npx');
    const esbuildPre   = usingLocal ? [] : ['esbuild'];
    const external     = isWin ? '@devscholar/node-ps1-dotnet' : '@devscholar/node-with-gjs';

    console.log(`[node-with-window] Building ${target}...`);
    const build = spawnSync(
        esbuildCmd,
        [...esbuildPre, targetFile,
         '--bundle', `--outfile=${outfile}`, '--format=esm',
         '--platform=node', '--target=node18', '--sourcemap',
         `--external:${external}`],
        { stdio: 'inherit', cwd, shell: isWin }
    );
    if (build.status !== 0) process.exit(build.status ?? 1);

    console.log(`[node-with-window] Running with ${runtime}...`);
    const runArgs = runtime === 'deno'
        ? ['run', '--allow-all', outfile, ...extraArgs]
        : [outfile, ...extraArgs];
    const proc = spawn(runtime, runArgs, { stdio: 'inherit', cwd });
    proc.on('exit', code => process.exit(code ?? 0));
}
