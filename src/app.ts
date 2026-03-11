import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { resolveBackend, ensureBackendInitialized, setAppBackendName } from './backends.js';

function readUserPackageJson(): { name?: string; version?: string } {
    try {
        return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
    } catch {
        return {};
    }
}

class App extends EventEmitter {
    private readyPromise: Promise<void>;
    private readyResolve!: () => void;
    private readyReject!: (reason: unknown) => void;
    private initializationStarted = false;
    private _isReady = false;
    private isQuitting = false;

    constructor() {
        super();
        this.readyPromise = new Promise((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
    }

    private async initializePlatform(): Promise<void> {
        const backend = resolveBackend();
        await ensureBackendInitialized(backend.name);
        this._isReady = true;
        this.readyResolve();
        this.emit('ready');
    }

    public async whenReady(): Promise<void> {
        if (this.initializationStarted) return this.readyPromise;
        this.initializationStarted = true;
        this.initializePlatform().catch((e) => this.readyReject(e));
        return this.readyPromise;
    }

    public isReady(): boolean {
        return this._isReady;
    }

    public setBackend(name: string): void {
        if (this.initializationStarted)
            throw new Error('Cannot change backend after app.whenReady() has been called.');
        setAppBackendName(name);
    }

    public getName(): string {
        return readUserPackageJson().name ?? 'node-with-window-app';
    }

    public getVersion(): string {
        return readUserPackageJson().version ?? '1.0.0';
    }

    public getPath(name: string): string {
        switch (name) {
            case 'home':      return os.homedir();
            case 'temp':      return os.tmpdir();
            case 'desktop':   return path.join(os.homedir(), 'Desktop');
            case 'downloads': return path.join(os.homedir(), 'Downloads');
            case 'documents': return path.join(os.homedir(), 'Documents');
            case 'music':     return path.join(os.homedir(), 'Music');
            case 'pictures':  return path.join(os.homedir(), 'Pictures');
            case 'videos':    return path.join(os.homedir(), 'Videos');
            case 'appData':
                if (process.platform === 'win32')
                    return process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
                if (process.platform === 'darwin')
                    return path.join(os.homedir(), 'Library', 'Application Support');
                return process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
            case 'userData':  return path.join(this.getPath('appData'), this.getName());
            case 'logs':      return path.join(this.getPath('userData'), 'logs');
            case 'exe':
            case 'module':    return process.execPath;
            default: throw new Error(`app.getPath: unknown path name "${name}"`);
        }
    }

    public get quitting(): boolean {
        return this.isQuitting;
    }

    public quit(): void {
        this.isQuitting = true;
        this.emit('before-quit');
        process.exit(0);
    }
}

export const app = new App();
