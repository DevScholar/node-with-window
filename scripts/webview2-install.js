#!/usr/bin/env node

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNTIMES_DIR = path.join(__dirname, '..', 'runtimes', 'webview2');

const DEFAULT_VERSION = 'latest';
const PACKAGE_NAME = 'Microsoft.Web.WebView2';

const COLORS = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    red: '\x1b[31m'
};

function log(message, color = 'reset') {
    console.log(`${COLORS[color]}${message}${COLORS.reset}`);
}

function error(message) {
    console.error(`${COLORS.red}Error:${COLORS.reset} ${message}`);
}

async function fetchJson(url, redirectCount = 0) {
    if (redirectCount > 5) {
        throw new Error('Too many redirects');
    }

    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                const redirectUrl = res.headers.location;
                if (redirectUrl) {
                    fetchJson(redirectUrl, redirectCount + 1).then(resolve).catch(reject);
                    return;
                }
            }

            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Failed to parse JSON: ${data}`));
                }
            });
        }).on('error', reject);
    });
}

async function downloadFile(url, dest, redirectCount = 0) {
    if (redirectCount > 5) {
        throw new Error('Too many redirects');
    }

    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                const redirectUrl = res.headers.location;
                file.close();
                if (redirectUrl) {
                    downloadFile(redirectUrl, dest, redirectCount + 1).then(resolve).catch(reject);
                    return;
                }
            }

            res.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

let serviceIndex = null;

async function getServiceIndex() {
    if (!serviceIndex) {
        const data = await fetchJson('https://api.nuget.org/v3/index.json');
        serviceIndex = data;
    }
    return serviceIndex;
}

async function getLatestVersion() {
    log('Fetching latest version from NuGet...', 'blue');

    const index = await getServiceIndex();
    const searchResource = index.resources.find(r => r['@type'] === 'SearchQueryService');
    const searchUrl = searchResource['@id'];

    const data = await fetchJson(`${searchUrl}?take=1&q=${PACKAGE_NAME}&prerelease=false`);

    if (data.data && data.data.length > 0) {
        const item = data.data[0];
        const versionObj = item.versions[item.versions.length - 1];
        return versionObj.version;
    }

    throw new Error('Could not find latest version');
}

async function downloadNupkg(version, destDir) {
    const nupkgPath = path.join(destDir, `${PACKAGE_NAME}.${version}.nupkg`);

    if (fs.existsSync(nupkgPath)) {
        log(`Package already exists: ${nupkgPath}`, 'yellow');
        return nupkgPath;
    }

    log(`Downloading ${PACKAGE_NAME} ${version}...`, 'blue');
    const url = `https://www.nuget.org/api/v2/package/${PACKAGE_NAME}/${version}`;
    await downloadFile(url, nupkgPath);
    log(`Downloaded to: ${nupkgPath}`, 'green');
    return nupkgPath;
}

async function extractNupkg(nupkgPath, destDir) {
    log('Extracting package...', 'blue');

    const tempDir = path.join(destDir, 'temp_extract');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    const { spawn } = await import('child_process');

    const zipPath = nupkgPath.replace('.nupkg', '.zip');
    fs.copyFileSync(nupkgPath, zipPath);

    await new Promise((resolve, reject) => {
        const proc = spawn('powershell', [
            '-Command',
            `Expand-Archive -Path '${zipPath}' -DestinationPath '${tempDir}' -Force; Remove-Item '${zipPath}'`
        ], {
            stdio: 'ignore',
            detached: false
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Extraction failed with code ${code}`));
            }
        });

        proc.on('error', reject);

        setTimeout(() => {
            proc.kill();
            reject(new Error('Extraction timeout'));
        }, 30000);
    });

    log('Extracted successfully', 'green');

    const libDir = path.join(tempDir, 'lib');
    const dlls = [];

    if (fs.existsSync(libDir)) {
        const subdirs = fs.readdirSync(libDir);
        for (const subdir of subdirs) {
            const subdirPath = path.join(libDir, subdir);
            if (fs.statSync(subdirPath).isDirectory()) {
                const files = fs.readdirSync(subdirPath);
                for (const file of files) {
                    if (file.endsWith('.dll')) {
                        const srcPath = path.join(subdirPath, file);
                        const destPath = path.join(destDir, file);
                        fs.copyFileSync(srcPath, destPath);
                        dlls.push(destPath);
                        log(`  Extracted: ${file}`, 'green');
                    }
                }
            }
        }
    }

    // Extract the architecture-specific WebView2Loader.dll from runtimes/
    // Without this native DLL, WebView2 fails to initialize and shows a blank window.
    const arch = process.arch; // 'x64', 'ia32', 'arm64'
    const runtimeArch = arch === 'ia32' ? 'win-x86' : arch === 'arm64' ? 'win-arm64' : 'win-x64';
    const nativeDir = path.join(tempDir, 'runtimes', runtimeArch, 'native');
    if (fs.existsSync(nativeDir)) {
        const nativeFiles = fs.readdirSync(nativeDir);
        for (const file of nativeFiles) {
            if (file.endsWith('.dll')) {
                const srcPath = path.join(nativeDir, file);
                const destPath = path.join(destDir, file);
                fs.copyFileSync(srcPath, destPath);
                dlls.push(destPath);
                log(`  Extracted (${runtimeArch}): ${file}`, 'green');
            }
        }
    } else {
        log(`  Warning: native dir not found for ${runtimeArch}: ${nativeDir}`, 'yellow');
    }

    const licenseFiles = ['LICENSE.txt', 'NOTICE.txt'];
    for (const licenseFile of licenseFiles) {
        const srcPath = path.join(tempDir, licenseFile);
        if (fs.existsSync(srcPath)) {
            const destPath = path.join(destDir, licenseFile);
            fs.copyFileSync(srcPath, destPath);
            log(`  Extracted: ${licenseFile}`, 'green');
        }
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
    return dlls;
}

async function install(version = DEFAULT_VERSION) {
    if (version === 'latest') {
        version = await getLatestVersion();
    }

    const versionDir = path.join(RUNTIMES_DIR, version);
    if (!fs.existsSync(versionDir)) {
        fs.mkdirSync(versionDir, { recursive: true });
    }

    const currentVersionFile = path.join(RUNTIMES_DIR, 'current.txt');

    if (fs.existsSync(currentVersionFile)) {
        const currentVersion = fs.readFileSync(currentVersionFile, 'utf-8').trim();
        if (currentVersion === version) {
            log(`Version ${version} is already installed`, 'yellow');
            await listInstalled();
            return;
        }
    }

    const nupkgPath = await downloadNupkg(version, versionDir);
    const dlls = await extractNupkg(nupkgPath, versionDir);

    fs.unlinkSync(nupkgPath);
    log('Removed nupkg file', 'blue');

    fs.writeFileSync(currentVersionFile, version);

    log(`\nSuccessfully installed ${PACKAGE_NAME} ${version}`, 'green');
    log(`DLLs location: ${versionDir}`, 'green');

    if (dlls.length > 0) {
        log('\nExtracted DLLs:', 'green');
        dlls.forEach(d => log(`  - ${path.basename(d)}`, 'reset'));
    }
}

async function listInstalled() {
    if (!fs.existsSync(RUNTIMES_DIR)) {
        log('No versions installed', 'yellow');
        return;
    }

    const currentVersionFile = path.join(RUNTIMES_DIR, 'current.txt');
    let currentVersion = '';
    if (fs.existsSync(currentVersionFile)) {
        currentVersion = fs.readFileSync(currentVersionFile, 'utf-8').trim();
    }

    const versions = fs.readdirSync(RUNTIMES_DIR).filter(v => v !== 'current');

    if (versions.length === 0) {
        log('No versions installed', 'yellow');
        return;
    }

    log('\nInstalled WebView2 versions:', 'blue');
    for (const v of versions) {
        const marker = v === currentVersion ? ' * ' : '   ';
        log(`${marker}${v}`, v === currentVersion ? 'green' : 'reset');
    }
}

async function use(version) {
    const versionDir = path.join(RUNTIMES_DIR, version);
    if (!fs.existsSync(versionDir)) {
        error(`Version ${version} is not installed`);
        error(`Run: node scripts/webview2-install.js install ${version}`);
        process.exit(1);
    }

    const currentVersionFile = path.join(RUNTIMES_DIR, 'current.txt');
    fs.writeFileSync(currentVersionFile, version);
    log(`Now using WebView2 ${version}`, 'green');
}

async function remove(version) {
    const versionDir = path.join(RUNTIMES_DIR, version);
    if (!fs.existsSync(versionDir)) {
        error(`Version ${version} is not installed`);
        process.exit(1);
    }

    const currentVersionFile = path.join(RUNTIMES_DIR, 'current.txt');
    if (fs.existsSync(currentVersionFile)) {
        const currentVersion = fs.readFileSync(currentVersionFile, 'utf-8').trim();
        if (currentVersion === version) {
            fs.unlinkSync(currentVersionFile);
        }
    }

    fs.rmSync(versionDir, { recursive: true, force: true });
    log(`Removed WebView2 ${version}`, 'green');
}

async function info(version = 'latest') {
    if (version === 'latest') {
        version = await getLatestVersion();
    }

    log(`\n${PACKAGE_NAME}`, 'blue');
    log(`Version: ${version}`, 'reset');
}

function showHelp() {
    log(`
WebView2 Version Manager (like nvm for WebView2)

Usage: node scripts/webview2-install.js <command> [options]

Commands:
    install [version]    Install WebView2 version (default: latest)
                        Use 'latest' to install the latest version
    use <version>       Switch to a specific installed version
    remove <version>    Remove a specific version
    list                List installed versions
    info [version]      Show package info (default: latest)
    latest              Show the latest available version

Examples:
    node scripts/webview2-install.js install
    node scripts/webview2-install.js install latest
    node scripts/webview2-install.js install 1.0.3800.47
    node scripts/webview2-install.js use 1.0.3800.47
    node scripts/webview2-install.js list
    node scripts/webview2-install.js info
`, 'blue');
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0] || 'help';

    switch (command) {
        case 'install':
        case 'i':
            await install(args[1] || DEFAULT_VERSION);
            break;
        case 'use':
            if (!args[1]) {
                error('Version required');
                process.exit(1);
            }
            await use(args[1]);
            break;
        case 'remove':
        case 'rm':
            if (!args[1]) {
                error('Version required');
                process.exit(1);
            }
            await remove(args[1]);
            break;
        case 'list':
        case 'ls':
            await listInstalled();
            break;
        case 'info':
            await info(args[1] || 'latest');
            break;
        case 'latest':
            const latest = await getLatestVersion();
            log(`Latest version: ${latest}`, 'green');
            break;
        case 'help':
        case '-h':
        case '--help':
            showHelp();
            break;
        default:
            error(`Unknown command: ${command}`);
            showHelp();
            process.exit(1);
    }
}

main().then(() => {
    process.exit(0);
}).catch(err => {
    error(err.message);
    process.exit(1);
});
