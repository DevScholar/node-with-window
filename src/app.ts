import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
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
  private _customName: string | null = null;
  private _customPaths = new Map<string, string>();
  private _shouldRelaunch = false;
  private _relaunchOptions: { execPath?: string; args?: string[] } | null = null;
  private _lockFile: string | null = null;
  private _exitHandlerRegistered = false;

  constructor() {
    super();
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  // Override on() so that registering a 'ready' listener immediately starts
  // initialization (if not already started). This matches Electron's behaviour
  // where app.on('ready', cb) fires without an explicit whenReady() call.
  public on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    super.on(event, listener);
    if (event === 'ready') {
      if (this._isReady) {
        // App already ready — fire the callback on the next tick to keep behaviour
        // consistent with the not-yet-ready case (always async).
        setImmediate(() => listener());
      } else if (!this.initializationStarted) {
        this.whenReady().catch(e => this.emit('error', e));
      }
    }
    return this;
  }

  public once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    super.once(event, listener);
    if (event === 'ready') {
      if (this._isReady) {
        setImmediate(() => listener());
      } else if (!this.initializationStarted) {
        this.whenReady().catch(e => this.emit('error', e));
      }
    }
    return this;
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
    this.initializePlatform().catch(e => this.readyReject(e));
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
    return this._customName ?? readUserPackageJson().name ?? 'node-with-window-app';
  }

  /** Override the app name returned by `getName()`. */
  public setName(name: string): void {
    this._customName = name;
  }

  public getVersion(): string {
    return readUserPackageJson().version ?? '1.0.0';
  }

  public getPath(name: string): string {
    if (this._customPaths.has(name)) return this._customPaths.get(name)!;
    switch (name) {
      case 'home':
        return os.homedir();
      case 'temp':
        return os.tmpdir();
      case 'desktop':
        return path.join(os.homedir(), 'Desktop');
      case 'downloads':
        return path.join(os.homedir(), 'Downloads');
      case 'documents':
        return path.join(os.homedir(), 'Documents');
      case 'music':
        return path.join(os.homedir(), 'Music');
      case 'pictures':
        return path.join(os.homedir(), 'Pictures');
      case 'videos':
        return path.join(os.homedir(), 'Videos');
      case 'appData':
        if (process.platform === 'win32')
          return process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
        if (process.platform === 'darwin')
          return path.join(os.homedir(), 'Library', 'Application Support');
        return process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
      case 'userData':
        return path.join(this.getPath('appData'), this.getName());
      case 'logs':
        return path.join(this.getPath('userData'), 'logs');
      case 'exe':
      case 'module':
        return process.execPath;
      default:
        throw new Error(`app.getPath: unknown path name "${name}"`);
    }
  }

  /** Override a named path returned by `getPath()`. */
  public setPath(name: string, value: string): void {
    this._customPaths.set(name, value);
  }

  /** Returns the system locale, e.g. `'en-US'`. */
  public getLocale(): string {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  }

  /**
   * Exits immediately with the given exit code. Unlike `quit()`, does not
   * emit `before-quit`. If `relaunch()` was called previously, the app is
   * relaunched first.
   */
  public exit(exitCode = 0): void {
    if (this._shouldRelaunch) this._doRelaunch();
    process.exit(exitCode);
  }

  /**
   * Marks the app for relaunch when it exits. Call `app.exit()` or
   * `app.quit()` immediately after to trigger the relaunch.
   *
   * @param options.execPath  Path to re-execute (defaults to `process.execPath`).
   * @param options.args      Arguments (defaults to `process.argv.slice(1)`).
   */
  public relaunch(options?: { execPath?: string; args?: string[] }): void {
    this._shouldRelaunch = true;
    this._relaunchOptions = options ?? null;
  }

  private _doRelaunch(): void {
    const execPath = this._relaunchOptions?.execPath ?? process.execPath;
    const args = this._relaunchOptions?.args ?? process.argv.slice(1);
    cp.spawn(execPath, args, { detached: true, stdio: 'ignore' }).unref();
  }

  /**
   * Focuses the first open BrowserWindow, bringing it to the foreground.
   * Uses a dynamic import to avoid a circular module dependency.
   */
  public focus(): void {
    // Dynamic import used to avoid circular dep: browser-window → backends → (app never imported by backends)
    import('./browser-window.js')
      .then(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) windows[0].focus();
      })
      .catch(() => {});
  }

  /**
   * Tries to acquire a single-instance lock using a PID file in the OS temp
   * directory. Returns `true` if this is the first instance (lock acquired),
   * `false` if another instance is already running.
   *
   * Typical usage:
   * ```ts
   * if (!app.requestSingleInstanceLock()) {
   *     app.quit();
   * }
   * app.on('second-instance', () => { /* bring existing window to front *\/ });
   * ```
   *
   * Note: The `second-instance` event is emitted when this method is called
   * while another instance already holds the lock but that instance has called
   * `requestSingleInstanceLock()` on the same app name.
   */
  public requestSingleInstanceLock(): boolean {
    const lockDir = path.join(os.tmpdir(), 'nww-locks');
    try {
      fs.mkdirSync(lockDir, { recursive: true });
    } catch { /* directory may already exist */ }

    const safeName = this.getName().replace(/[^a-z0-9_-]/gi, '_');
    const lockPath = path.join(lockDir, `${safeName}.lock`);

    if (fs.existsSync(lockPath)) {
      try {
        const pid = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
        if (!isNaN(pid)) {
          process.kill(pid, 0); // throws ESRCH if process does not exist
          return false; // Another live instance holds the lock
        }
      } catch (e: unknown) {
        // ESRCH → stale lock; EPERM → process alive but we can't signal it (treat as alive)
        if ((e as NodeJS.ErrnoException).code === 'EPERM') return false;
        // ESRCH → fall through and take the lock
      }
    }

    fs.writeFileSync(lockPath, String(process.pid));
    this._lockFile = lockPath;
    if (!this._exitHandlerRegistered) {
      this._exitHandlerRegistered = true;
      process.on('exit', () => {
        try {
          if (this._lockFile) fs.unlinkSync(this._lockFile);
        } catch { /* lock file cleanup is best-effort */ }
      });
    }
    return true;
  }

  public get quitting(): boolean {
    return this.isQuitting;
  }

  public quit(): void {
    this.isQuitting = true;
    this.emit('before-quit');
    this.emit('will-quit');
    if (this._shouldRelaunch) this._doRelaunch();
    process.exit(0);
  }
}

export const app = new App();
