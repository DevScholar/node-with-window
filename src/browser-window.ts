import { EventEmitter } from 'node:events';
import {
  IWindowProvider,
  BrowserWindowOptions,
  MenuItemOptions,
  OpenDialogOptions,
  SaveDialogOptions,
} from './interfaces';
import { resolveBackend, ensureBackendInitialized } from './backends.js';
import { app } from './app.js';
import { startSyncServer } from './node-integration.js';
import { Menu, MENU_REMOVED } from './menu.js';
import { WebContents } from './web-contents.js';
import { NativeImage } from './native-image.js';

/**
 * BrowserWindow - Cross-platform window with WebView support
 *
 * - Windows (default): netfx-wpf  (WebView2 + WPF via .NET)
 * - Linux (default):   gjs-gtk4   (WebKitGTK + GTK4 via GJS)
 *
 * Usage (Electron-compatible):
 *
 * ```javascript
 * const win = new BrowserWindow({ width: 800, height: 600 });
 * win.loadFile('index.html');
 * win.setMenu([...]);
 * // window auto-shows on the next event-loop tick
 * ```
 *
 * The constructor is synchronous and returns immediately.  Backend
 * initialization runs in the background; all method calls before it
 * completes are queued and drained automatically.
 */
export class BrowserWindow extends EventEmitter {
  private provider: IWindowProvider;
  private _backendName: string;
  private _id: number;
  private static _allWindows: Map<number, BrowserWindow> = new Map();
  private static _lastId = 0;
  /** The window that most recently received focus (via focus() API call). */
  private static _focusedId: number | null = null;
  private _isCreated = false;
  /** True once setMenu() has been called explicitly on this window. */
  private _menuSet = false;
  private _createdPromise: Promise<void>;

  /** Electron-compatible webContents object. */
  public readonly webContents: WebContents;

  constructor(options?: BrowserWindowOptions) {
    super();

    BrowserWindow._lastId++;
    this._id = BrowserWindow._lastId;
    BrowserWindow._allWindows.set(this._id, this);

    const backend = resolveBackend(options?.backend);
    this._backendName = backend.name;
    this.provider = backend.createProvider(options);

    // Register the external-close callback BEFORE createWindow() so that any
    // close triggered during initialization (unlikely but possible) is handled.
    this.provider.onClosed = () => this._handleClosed();

    this.webContents = new WebContents({
      sendToRenderer: (channel, ...args) => {
        this.provider.sendToRenderer(channel, ...args);
      },
      openDevTools: () => {
        this.provider.openDevTools();
      },
      reload: () => {
        this.provider.reload();
      },
      loadURL: url => this.loadURL(url),
      loadFile: filePath => this.loadFile(filePath),
      executeJavaScript: code => this.provider.executeJavaScript(code),
      onNavigationCompleted: cb => {
        this.provider.onNavigationCompleted(cb);
      },
    });

    this._createdPromise = this._init(options);

    // Auto-show on the next event-loop tick so the caller's synchronous
    // setup code (loadFile, setMenu, ipcMain.handle, …) runs first —
    // matching Electron's behaviour where new BrowserWindow() shows after
    // the current synchronous block finishes.
    if (options?.show !== false) {
      setImmediate(() => this.show());
    }
  }

  private async _init(options?: BrowserWindowOptions): Promise<void> {
    try {
      // Start the sync HTTP server before the backend so its port is available
      // when setupIpcBridge() injects the bridge script.  The server is needed
      // for both window.require (nodeIntegration) and ipcRenderer.sendSync().
      await startSyncServer();
      await ensureBackendInitialized(this._backendName);
      await this.provider.createWindow();
      this._isCreated = true;
      this.emit('created');
    } catch (error) {
      this._isCreated = false;
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Called when the provider signals its window was closed externally
   * (e.g. the user clicked the X button). Also called from close() after
   * provider.close() completes.
   *
   * Emits 'closed' on this window, removes it from the all-windows registry,
   * and — when the last window is gone — emits 'window-all-closed' on app.
   * If no listener handles 'window-all-closed', the process exits with code 0,
   * matching Electron's default behaviour.
   */
  private _handleClosed(): void {
    if (!BrowserWindow._allWindows.has(this._id)) return; // already handled
    BrowserWindow._allWindows.delete(this._id);
    if (BrowserWindow._focusedId === this._id) BrowserWindow._focusedId = null;

    this.emit('closed');

    if (BrowserWindow._allWindows.size === 0) {
      // Emit window-all-closed. If no listener is registered, default to exit
      // (same as Electron on non-macOS platforms).
      if (app.listenerCount('window-all-closed') === 0) {
        process.exit(0);
      } else {
        app.emit('window-all-closed');
      }
    }
  }

  /**
   * Synchronous factory — equivalent to `new BrowserWindow(options)`.
   * Kept for backward compatibility; `await BrowserWindow.create(opts)`
   * continues to work because awaiting a non-Promise value returns it as-is.
   */
  public static create(options?: BrowserWindowOptions): BrowserWindow {
    return new BrowserWindow(options);
  }

  public whenCreated(): Promise<void> {
    return this._createdPromise;
  }

  public get isCreated(): boolean {
    return this._isCreated;
  }

  public get id(): number {
    return this._id;
  }

  public static getAllWindows(): BrowserWindow[] {
    return Array.from(BrowserWindow._allWindows.values());
  }

  /**
   * Returns the window that most recently received focus via the focus() API.
   * Falls back to the first open window when no focus has been recorded.
   * Note: focus gained via mouse click is not tracked without platform events.
   */
  public static getFocusedWindow(): BrowserWindow | undefined {
    if (BrowserWindow._focusedId !== null) {
      const focused = BrowserWindow._allWindows.get(BrowserWindow._focusedId);
      if (focused) return focused;
    }
    return BrowserWindow.getAllWindows()[0];
  }

  public static fromId(id: number): BrowserWindow | null {
    return BrowserWindow._allWindows.get(id) ?? null;
  }

  /** Find the BrowserWindow that owns a given WebContents instance. */
  public static fromWebContents(wc: WebContents): BrowserWindow | null {
    for (const win of BrowserWindow._allWindows.values()) {
      if (win.webContents === wc) return win;
    }
    return null;
  }

  public async loadURL(url: string): Promise<void> {
    if (!this._isCreated) await this._createdPromise;
    return this.provider.loadURL(url);
  }

  public async loadFile(filePath: string): Promise<void> {
    if (!this._isCreated) await this._createdPromise;
    return this.provider.loadFile(filePath);
  }

  public show(): void {
    if (!this._isCreated) {
      // Backend not ready yet — queue show() to run once _init resolves.
      this._createdPromise.then(() => this._showNow()).catch(() => {});
      return;
    }
    this._showNow();
  }

  private _showNow(): void {
    // Apply the application menu when the caller never called setMenu().
    if (!this._menuSet) {
      const resolved = Menu._resolveDefaultItems();
      if (resolved === MENU_REMOVED) {
        this.provider.setMenu([]);
      } else {
        this.provider.setMenu(resolved);
      }
    }
    this.provider.show();
  }

  public close(): void {
    this.provider.close();
    this._handleClosed();
  }

  public setMenu(menu: MenuItemOptions[] | Menu): void {
    this._menuSet = true;
    const items: MenuItemOptions[] = Array.isArray(menu) ? menu : (menu as Menu).items();
    this.provider.setMenu(items);
  }

  public removeMenu(): void {
    this._menuSet = true;
    this.provider.setMenu([]);
  }

  public showOpenDialog(options: OpenDialogOptions): string[] | undefined {
    return this.provider.showOpenDialog(options);
  }

  public showSaveDialog(options: SaveDialogOptions): string | undefined {
    return this.provider.showSaveDialog(options);
  }

  public showMessageBox(options: {
    type?: string;
    title?: string;
    message: string;
    buttons?: string[];
  }): number {
    return this.provider.showMessageBox(options);
  }

  public getUserDataPath(): string | undefined {
    if ('userDataPath' in this.provider) {
      return (this.provider as { userDataPath: string }).userDataPath;
    }
    return undefined;
  }

  public cleanupUserData(): void {
    if (this.provider.cleanupUserData) {
      this.provider.cleanupUserData();
    }
  }

  /** Alias for close(). */
  public destroy(): void {
    this.close();
  }

  public focus(): void {
    BrowserWindow._focusedId = this._id;
    this.provider.focus();
  }
  public blur(): void {
    this.provider.blur();
  }

  public minimize(): void {
    this.provider.minimize();
  }
  public maximize(): void {
    this.provider.maximize();
  }
  public unmaximize(): void {
    this.provider.unmaximize();
  }
  /** Alias for unmaximize(). */
  public restore(): void {
    this.provider.unmaximize();
  }

  public setFullScreen(flag: boolean): void {
    this.provider.setFullScreen(flag);
  }
  public isFullScreen(): boolean {
    return this.provider.isFullScreen();
  }

  public setKiosk(flag: boolean): void {
    this.provider.setKiosk(flag);
  }
  public isKiosk(): boolean {
    return this.provider.isKiosk();
  }

  public setTitle(title: string): void {
    this.provider.setTitle(title);
  }
  public getTitle(): string {
    return this.provider.getTitle();
  }

  public setSize(width: number, height: number): void {
    this.provider.setSize(width, height);
  }
  public getSize(): [number, number] {
    return this.provider.getSize();
  }

  public setPosition(x: number, y: number): void {
    this.provider.setPosition?.(x, y);
  }
  public getPosition(): [number, number] {
    return this.provider.getPosition?.() ?? [0, 0];
  }

  public setOpacity(opacity: number): void {
    this.provider.setOpacity?.(opacity);
  }
  public getOpacity(): number {
    return this.provider.getOpacity?.() ?? 1;
  }

  public setResizable(resizable: boolean): void {
    this.provider.setResizable(resizable);
  }
  public isResizable(): boolean {
    return this.provider.isResizable();
  }

  public setAlwaysOnTop(flag: boolean): void {
    this.provider.setAlwaysOnTop(flag);
  }

  public center(): void {
    this.provider.center();
  }

  public flashFrame(flag: boolean): void {
    this.provider.flashFrame(flag);
  }

  public setBackgroundColor(color: string): void {
    this.provider.setBackgroundColor(color);
  }

  /** Returns the native window HWND as a decimal string (Windows only; '0' on Linux). */
  public getHwnd(): string {
    return this.provider.getHwnd();
  }

  /** Enable or disable user interaction on this window (used for modal parent blocking). */
  public setEnabled(flag: boolean): void {
    this.provider.setEnabled(flag);
  }

  /** Captures the WebView contents and returns a NativeImage (PNG). */
  public capturePage(): Promise<NativeImage> {
    return this.provider.capturePage();
  }
}
