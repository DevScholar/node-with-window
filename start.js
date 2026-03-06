import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);

if (args.length === 0) {
    console.error('Usage: node start.js <script.ts>');
    process.exit(1);
}

let targetScript = args[0];

targetScript = path.resolve(targetScript);

if (!fs.existsSync(targetScript)) {
    console.error(`Error: File not found: ${targetScript}`);
    process.exit(1);
}

async function buildAndRun() {
    console.log('Building TypeScript...');
    
    const ext = path.extname(targetScript);
    const projectDir = __dirname;
    const srcDir = path.join(projectDir, 'src');
    const relativePath = path.relative(srcDir, targetScript);
    const outfile = path.join(projectDir, 'dist-examples', relativePath.replace(/\.ts$/, '.js'));
    
    const outDir = path.dirname(outfile);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }
    
    await esbuild.build({
        entryPoints: [targetScript],
        bundle: true,
        outfile: outfile,
        format: 'esm',
        platform: 'node',
        target: 'node18',
        sourcemap: true,
        logLevel: 'info',
        external: ['@devscholar/node-ps1-dotnet', '@devscholar/node-with-gjs']
    });
    
    console.log('Build complete.');
    console.log('Running:', path.relative(projectDir, outfile));
    
    const proc = spawn(process.execPath, [
        '--no-warnings', 
        outfile
    ], {
        stdio: 'inherit',
        env: process.env
    });
    
    proc.on('exit', (code) => {
        process.exit(code || 0);
    });
    
    proc.on('error', (err) => {
        console.error('Failed to start:', err.message);
        process.exit(1);
    });
}

buildAndRun().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
});
