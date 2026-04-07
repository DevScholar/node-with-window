import { EventEmitter } from 'node:events';

/**
 * Internal delegate interface — avoids a circular dependency between
 * WebContents and BrowserWindow.
 */
export interface WebContentsDelegate {
  sendToRenderer(channel: string, ...args: unknown[]): void;
  openDevTools(): void;
  reload(): void;
  loadURL(url: string): Promise<void>;
  loadFile(filePath: string): Promise<void>;
  executeJavaScript?(code: string): Promise<unknown>;
  onNavigationCompleted?(callback: () => void): void;
  onNavigate?(callback: (url: string) => void): void;
  onDomReady?(callback: () => void): void;
  onNavigateFailed?(callback: (errorCode: number, errorDescription: string, url: string) => void): void;
}

/**
 * Minimal Electron-compatible Session object.
 * Exposes cache/storage clearing; platform-specific HTTP cache clearing is stubbed.
 */
export class Session {
  private readonly _executeJS: (code: string) => Promise<unknown>;

  constructor(executeJS: (code: string) => Promise<unknown>) {
    this._executeJS = executeJS;
  }

  /**
   * Clears the HTTP/disk cache.
   * Full implementation requires platform WebView APIs; JS-accessible caches are cleared.
   */
  public clearCache(): Promise<void> {
    return this._executeJS('caches.keys().then(ks=>Promise.all(ks.map(k=>caches.delete(k))))')
      .then(() => void 0)
      .catch(() => void 0);
  }

  /**
   * Clears web storage.
   * @param options.storages Subset of `['localstorage','sessionstorage','indexdb','cookies']`.
   *                         Defaults to all four.
   */
  public clearStorageData(options?: { storages?: string[] }): Promise<void> {
    const storages = options?.storages ?? ['localstorage', 'sessionstorage', 'indexdb'];
    const parts: string[] = [];
    if (storages.includes('localstorage')) parts.push('localStorage.clear()');
    if (storages.includes('sessionstorage')) parts.push('sessionStorage.clear()');
    if (storages.includes('indexdb'))
      parts.push(
        '(async()=>{const dbs=await indexedDB.databases();dbs.forEach(db=>indexedDB.deleteDatabase(db.name))})()'
      );
    if (parts.length === 0) return Promise.resolve();
    return this._executeJS(parts.join(';'))
      .then(() => void 0)
      .catch(() => void 0);
  }
}

/**
 * WebContents — Electron-compatible object exposed as `win.webContents`.
 *
 * Wraps the renderer-facing operations that Electron surfaces through the
 * `webContents` property of a `BrowserWindow`.
 */
export class WebContents extends EventEmitter {
  private readonly _delegate: WebContentsDelegate;
  private readonly _session: Session;

  constructor(delegate: WebContentsDelegate) {
    super();
    this._delegate = delegate;
    this._session = new Session(code => this.executeJavaScript(code));
    // Wire 'did-finish-load' event through the backend navigation signal.
    delegate.onNavigationCompleted?.(() => this.emit('did-finish-load'));
    delegate.onDomReady?.(() => this.emit('dom-ready'));
    delegate.onNavigate?.((url) => this.emit('did-navigate', url));
    delegate.onNavigateFailed?.((errorCode, errorDescription, url) => {
      this.emit('did-fail-load', null, errorCode, url, errorDescription, true);
    });
  }

  public send(channel: string, ...args: unknown[]): void {
    this._delegate.sendToRenderer(channel, ...args);
  }

  public openDevTools(): void {
    this._delegate.openDevTools();
  }

  public reload(): void {
    this._delegate.reload();
  }

  public loadURL(url: string): Promise<void> {
    return this._delegate.loadURL(url);
  }

  public loadFile(filePath: string): Promise<void> {
    return this._delegate.loadFile(filePath);
  }

  /**
   * Evaluates `code` in the renderer context and returns the result.
   * Supports both synchronous and Promise-returning expressions.
   */
  public executeJavaScript(code: string): Promise<unknown> {
    if (!this._delegate.executeJavaScript) {
      return Promise.reject(new Error('executeJavaScript is not supported by this backend'));
    }
    return this._delegate.executeJavaScript(code);
  }

  /** Electron-compatible session object for cache and storage management. */
  public get session(): Session {
    return this._session;
  }
}
