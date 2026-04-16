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
  /**
   * Ref'd timer that keeps the Node.js event loop alive while at least one
   * BrowserWindow exists.  Without this, the process would exit immediately
   * because node-ps1-dotnet's polling timer is unref'd by design.
   */
  private static _keepAlive: ReturnType<typeof setTimeout> | null = null;

  private static _startKeepAlive(): void {
    if (BrowserWindow._keepAlive) return;
    // Recursive setTimeout avoids any fixed-interval concerns.
    // The callback simply reschedules itself — zero side effects.
    const tick = () => {
      BrowserWindow._keepAlive = setTimeout(tick, 60_000);
    };
    tick();
  }

  private static _stopKeepAlive(): void {
    if (BrowserWindow._keepAlive) {
      clearTimeout(BrowserWindow._keepAlive);
      BrowserWindow._keepAlive = null;
    }
  }
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

    // Start the keepalive when the first window is created.
    if (BrowserWindow._allWindows.size === 1) {
      BrowserWindow._startKeepAlive();
    }

    const backend = resolveBackend(options?.backend);
    this._backendName = backend.name;
    this.provider = backend.createProvider(options);

    // Register the external-close callback BEFORE createWindow() so that any
    // close triggered during initialization (unlikely but possible) is handled.
    this.provider.onClosed = () => this._handleClosed();
    this.provider.onCloseRequest = () => this._handleCloseRequest();
    this.provider.onFocus = () => {
      BrowserWindow._focusedId = this._id;
      this.emit('focus');
    };
    this.provider.onBlur = () => this.emit('blur');
    this.provider.onResize = (width, height) => this.emit('resize', width, height);
    this.provider.onTitleUpdated = (title) => this.emit('page-title-updated', {}, title, false);
    this.provider.onMinimize = () => this.emit('minimize');
    this.provider.onMaximize = () => this.emit('maximize');
    this.provider.onUnmaximize = () => this.emit('unmaximize');
    this.provider.onRestore = () => this.emit('restore');
    this.provider.onEnterFullScreen = () => this.emit('enter-full-screen');
    this.provider.onLeaveFullScreen = () => this.emit('leave-full-screen');
    this.provider.onShow = () => this.emit('show');
    this.provider.onHide = () => this.emit('hide');
    this.provider.onMove = (x, y) => this.emit('move', x, y);

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
      onNavigate: cb => this.provider.onNavigate(cb),
      onDomReady: cb => this.provider.onDomReady(cb),
      onNavigateFailed: cb => this.provider.onNavigateFailed(cb),
      onWillNavigate: cb => this.provider.onWillNavigate?.(cb),
      getURL: () => this.provider.getURL?.() ?? '',
      getWebTitle: () => (this.provider as unknown as { getWebTitle?: () => string }).getWebTitle?.() ?? '',
      isLoading: () => this.provider.isLoading?.() ?? false,
      goBack: () => this.provider.goBack?.(),
      goForward: () => this.provider.goForward?.(),
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

  private async _init(_options?: BrowserWindowOptions): Promise<void> {
    try {
      await ensureBackendInitialized(this._backendName);
      await this.provider.createWindow();
      this._isCreated = true;
      this.emit('created');
      app.emit('browser-window-created', this);
    } catch (error) {
      this._isCreated = false;
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Called when the window is about to close (X button or close() call).
   * Emits the cancelable 'close' event. Returns true if the close was prevented.
   */
  private async _handleCloseRequest(): Promise<boolean> {
    if (this.listenerCount('close') === 0) return false;
    let prevented = false;
    const event = { preventDefault: () => { prevented = true; } };
    const listeners = this.rawListeners('close');
    for (const listener of listeners) {
      const result = (listener as (event: { preventDefault: () => void }) => unknown)(event);
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        await (result as Promise<unknown>);
      }
    }
    return prevented;
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
      // Clear the keepalive so the event loop can drain.
      BrowserWindow._stopKeepAlive();
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

  public hide(): void {
    this.provider.hide();
  }

  public isVisible(): boolean {
    return this.provider.isVisible();
  }

  public isDestroyed(): boolean {
    return this.provider.isDestroyed();
  }

  public isMinimized(): boolean {
    return this.provider.isMinimized();
  }

  public isMaximized(): boolean {
    return this.provider.isMaximized();
  }

  public isFocused(): boolean {
    return this.provider.isFocused();
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
    void this._closeAsync();
  }

  private async _closeAsync(): Promise<void> {
    if (await this._handleCloseRequest()) return; // cancelled by 'close' listener
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

  /**
   * Pops up a context menu at the given screen coordinates (or cursor position if omitted).
   * items — flat or nested MenuItemOptions array (same format as setMenu).
   */
  public popupMenu(items: MenuItemOptions[], x?: number, y?: number): void {
    this.provider.popupMenu?.(items, x, y);
  }

  public showOpenDialog(options: OpenDialogOptions): Promise<string[] | undefined> {
    return this.provider.showOpenDialog(options);
  }

  public showSaveDialog(options: SaveDialogOptions): Promise<string | undefined> {
    return this.provider.showSaveDialog(options);
  }

  public showMessageBox(options: {
    type?: string;
    title?: string;
    message: string;
    buttons?: string[];
    checkboxLabel?: string;
    checkboxChecked?: boolean;
  }): Promise<{ response: number; checkboxChecked: boolean }> {
    return this.provider.showMessageBox(options);
  }

  public showOpenDialogSync(options: OpenDialogOptions): string[] | undefined {
    return this.provider.showOpenDialogSync?.(options);
  }

  public showSaveDialogSync(options: SaveDialogOptions): string | undefined {
    return this.provider.showSaveDialogSync?.(options);
  }

  public showMessageBoxSync(options: {
    type?: string;
    title?: string;
    message: string;
    buttons?: string[];
  }): number {
    return this.provider.showMessageBoxSync?.(options) ?? 0;
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

  /** Forcibly destroys the window without emitting 'close'. Use close() for a graceful shutdown. */
  public destroy(): void {
    this.provider.close();
    this._handleClosed();
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

  public setMinimumSize(width: number, height: number): void {
    this.provider.setMinimumSize?.(width, height);
  }
  public setMaximumSize(width: number, height: number): void {
    this.provider.setMaximumSize?.(width, height);
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
