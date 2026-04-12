import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  IWindowProvider,
  BrowserWindowOptions,
  WebPreferences,
  OpenDialogOptions,
  SaveDialogOptions,
  MenuItemOptions,
} from '../../interfaces.js';
import { NativeImage } from '../../native-image.js';
import { findWebView2Runtime } from './webview2-runtime.js';
import { parseBackgroundColor } from './color.js';
import { WpfIpcBridge } from './ipc-bridge.js';
import { Win32Chrome } from './win32-chrome.js';
import { showOpenDialog, showSaveDialog, showMessageBox } from './dialogs.js';
import { buildWpfMenu } from './menu.js';
import { initWebView2WithProtocols } from './webview-setup.js';
import { popupContextMenu } from './popup-menu.js';
import { app } from '../../app.js';
import type { DotnetProxy, DotNetObject } from './dotnet/types.js';

/**
 * This library bridges Node.js with platform-specific GUI frameworks.
 *
 * On Windows, we use WebView2 (Microsoft's Chromium-based webview) combined with
 * WPF (Windows Presentation Foundation) for the window frame. The .NET interop is
 * handled by a self-contained PowerShell/C# bridge in scripts/backend/netfx-wpf/.
 *
 * Why this architecture?
 * - Node.js runs in a single-threaded event loop
 * - .NET/WPF also runs on its own thread and message loop
 * - We need to communicate between these two runtimes in a way that doesn't block either
 *
 * The Windows backend spawns a hidden PowerShell process (scripts/backend/netfx-wpf/WinHost.ps1)
 * that compiles and hosts the C# bridge. Communication happens through a named pipe
 * using synchronous JSON-line messages.
 */

let dotnet: DotnetProxy;

/**
 * Sets the .NET runtime instance that's used for all WPF/WebView2 operations.
 */
export function setDotNetInstance(instance: DotnetProxy): void {
  dotnet = instance;
}

/**
 * True once the first window's Application.Run() has been called.
 * Subsequent windows skip Application creation and just call Show().
 */
let _wpfStarted = false;

/**
 * NetFxWpfWindow implements the IWindowProvider interface for Windows using WPF + WebView2.
 *
 * Key architectural points:
 *
 * 1. SPLIT between createWindow() and show():
 *    - createWindow() sets up the WPF window and WebView2 control
 *    - show() actually displays the window and starts the WPF message loop
 *
 * 2. NAVIGATION QUEUE:
 *    WebView2 initialization is asynchronous. loadURL()/loadFile() calls
 *    before CoreWebView2 is ready are queued and replayed on init.
 *
 * 3. POLLING-BASED IPC:
 *    show() calls StartApplication which pre-sends an ok response and then
 *    calls Application.Run() on the .NET side, keeping Node's event loop free.
 *    Node.js polls for queued events every POLL_INTERVAL_MS, exactly like the
 *    Linux backend. This means async ipcMain.handle() callbacks work on Windows.
 *
 * 4. DELEGATE CLASSES:
 *    - WpfIpcBridge  — bridge script injection, WebMessageReceived, executeJavaScript
 *    - Win32Chrome   — P/Invoke window chrome (buttons, size constraints, HWND helpers)
 */
export class NetFxWpfWindow implements IWindowProvider {
  public options: BrowserWindowOptions;
  public webPreferences: WebPreferences;
  public browserWindow!: DotNetObject;
  public webView!: DotNetObject;
  public coreWebView2!: DotNetObject;
  public app!: DotNetObject | boolean;
  public isWebViewReady = false;
  public navigationQueue: Array<() => void> = [];
  public pendingFilePath: string | null = null;
  private _pendingAbsFilePath: string | null = null;
  public userDataPath: string;
  private _isTempSession = false;
  public pendingMenu: MenuItemOptions[] | null = null;
  /** Registered by BrowserWindow; called when the WPF window is closed externally. */
  public onClosed?: () => void;
  /** Registered by BrowserWindow; called when the user requests close (X button). Return true to cancel. */
  public onCloseRequest?: () => Promise<boolean> | boolean;
  /** Registered by BrowserWindow; called when the window gains focus. */
  public onFocus?: () => void;
  /** Registered by BrowserWindow; called when the window loses focus. */
  public onBlur?: () => void;
  /** Registered by BrowserWindow; called when the window is resized. */
  public onResize?: (width: number, height: number) => void;
  /** Registered by BrowserWindow; called when the page title changes. */
  public onTitleUpdated?: (title: string) => void;
  public onMinimize?: () => void;
  public onMaximize?: () => void;
  public onUnmaximize?: () => void;
  public onRestore?: () => void;
  public onEnterFullScreen?: () => void;
  public onLeaveFullScreen?: () => void;
  public onShow?: () => void;
  public onHide?: () => void;
  private isClosed = false;
  private _isVisible = false;
  private _isFullScreen = false;
  private _isKiosk = false;
  private _isResizable = true;
  private _webViewInitTimer: ReturnType<typeof setTimeout> | null = null;
  private _coreAssembly: unknown = null;

  private readonly _ipcBridge: WpfIpcBridge;
  private readonly _windowChrome: Win32Chrome;

  constructor(options?: BrowserWindowOptions) {
    this.options = options || {};
    this.webPreferences = this.options.webPreferences || {};
    this._isResizable = this.options.resizable ?? true;

    const partition = this.webPreferences.partition;
    const userDataBase = app.getPath('userData');

    if (partition) {
      if (partition.startsWith('persist:')) {
        const partitionName = partition.substring(8);
        this.userDataPath = path.join(userDataBase, 'Partitions', partitionName);
      } else if (partition.startsWith('temp:')) {
        this._isTempSession = true;
        this.userDataPath = path.join(
          os.tmpdir(),
          'node-with-window-webview2',
          `temp-${Date.now()}-${Math.random()}`
        );
      } else {
        // Non-prefixed partition treated as persist (Electron-compatible)
        this.userDataPath = path.join(userDataBase, 'Partitions', partition);
      }
    } else {
      this.userDataPath = userDataBase;
    }

    this._ipcBridge = new WpfIpcBridge(
      () => this.coreWebView2,
      () => this.browserWindow,
      () => dotnet,
      this.webPreferences,
      () => this,
      () => this.webView,
    );
    this._windowChrome = new Win32Chrome(
      () => this.browserWindow,
      () => dotnet,
      this.options,
    );
  }

  public async createWindow(): Promise<void> {
    const System = dotnet.System;
    const Windows = System.Windows;
    const Controls = Windows.Controls;

    const runtimePath = findWebView2Runtime();
    const coreDllPath = path.join(runtimePath, 'Microsoft.Web.WebView2.Core.dll');
    const wpfDllPath = path.join(runtimePath, 'Microsoft.Web.WebView2.Wpf.dll');

    this._coreAssembly = System.Reflection.Assembly.LoadFrom(coreDllPath);
    const WebView2WpfAssembly = System.Reflection.Assembly.LoadFrom(wpfDllPath);

    const WebView2Type = (
      WebView2WpfAssembly as unknown as { GetType: (name: string) => { new (): DotNetObject } }
    ).GetType('Microsoft.Web.WebView2.Wpf.WebView2');
    this.webView = new WebView2Type();

    // nww:// is always registered, so we always use CoreWebView2Environment.CreateAsync()
    // (which accepts CoreWebView2EnvironmentOptions with scheme registrations) and never set
    // CoreWebView2CreationProperties.  EnsureCoreWebView2Async() is called from show() via
    // _initWebView2WithProtocols() after the WPF application has started.

    this.browserWindow = new Windows.Window();
    (this.browserWindow as unknown as { Title: string }).Title =
      this.options.title || 'node-with-window';
    (this.browserWindow as unknown as { Width: number }).Width = this.options.width || 800;
    (this.browserWindow as unknown as { Height: number }).Height = this.options.height || 600;
    (this.browserWindow as unknown as { WindowStartupLocation: unknown }).WindowStartupLocation =
      Windows.WindowStartupLocation.CenterScreen;

    if (this.options.icon) {
      const absIcon = path.isAbsolute(this.options.icon)
        ? this.options.icon
        : path.resolve(process.cwd(), this.options.icon);
      if (fs.existsSync(absIcon)) {
        dotnet.setWindowIcon(this.browserWindow, absIcon);
      }
    }

    const grid = new Controls.Grid();
    (this.browserWindow as unknown as { Content: unknown }).Content = grid;
    (grid as unknown as { Children: { Add: (w: unknown) => void } }).Children.Add(this.webView);

    // Apply constructor options that map directly to WPF window properties.
    if (this.options.resizable === false) {
      (this.browserWindow as unknown as { ResizeMode: unknown }).ResizeMode =
        Windows.ResizeMode.NoResize;
    }
    if (this.options.minWidth)
      (this.browserWindow as unknown as { MinWidth: number }).MinWidth = this.options.minWidth;
    if (this.options.minHeight)
      (this.browserWindow as unknown as { MinHeight: number }).MinHeight = this.options.minHeight;
    if (this.options.maxWidth)
      (this.browserWindow as unknown as { MaxWidth: number }).MaxWidth = this.options.maxWidth;
    if (this.options.maxHeight)
      (this.browserWindow as unknown as { MaxHeight: number }).MaxHeight = this.options.maxHeight;
    if (this.options.alwaysOnTop) {
      (this.browserWindow as unknown as { Topmost: boolean }).Topmost = true;
    }
    if (this.options.x !== undefined && this.options.y !== undefined) {
      (this.browserWindow as unknown as { WindowStartupLocation: unknown }).WindowStartupLocation =
        Windows.WindowStartupLocation.Manual;
      (this.browserWindow as unknown as { Left: number }).Left = this.options.x;
      (this.browserWindow as unknown as { Top: number }).Top = this.options.y;
    }

    // frame: false — remove title bar and window border.
    // transparent and titleBarStyle:'hidden'/'hiddenInset' also imply WindowStyle.None.
    const needFrameless = this.options.frame === false || this.options.transparent === true
      || this.options.titleBarStyle === 'hidden' || this.options.titleBarStyle === 'hiddenInset';
    if (needFrameless) {
      (this.browserWindow as unknown as { WindowStyle: unknown }).WindowStyle =
        Windows.WindowStyle.None;
    }

    if (this.options.transparent) {
      // WindowChrome approach (article: wpf-transparent-window-without-allows-transparency):
      //   - AllowsTransparency=false  → hardware DX renderer, no WS_EX_LAYERED, no OS-level
      //                                  per-pixel alpha hit-testing → WebView2 receives clicks
      //   - ResizeMode=NoResize       → required by WPF for correct glass-frame compositing
      //   - Background=Transparent    → WPF DX surface cleared to alpha=0 so DWM glass shows through
      //   - WindowChrome(-1,-1,-1,-1) → WPF manages DWM glass over entire client area
      (this.browserWindow as unknown as { ResizeMode: unknown }).ResizeMode =
        Windows.ResizeMode.NoResize;
      (this.browserWindow as unknown as { Background: unknown }).Background =
        Windows.Media.Brushes.Transparent;
      dotnet.applyWindowChrome(this.browserWindow);
      dotnet.setWebViewBackground(this.webView, 0, 0, 0, 0);
    } else if (this.options.frame !== false &&
        (this.options.titleBarStyle === 'hidden' || this.options.titleBarStyle === 'hiddenInset')) {
      // titleBarStyle:'hidden'/'hiddenInset' — remove the native title bar while keeping
      // the resize border (4 px on all sides).
      dotnet.applyHiddenTitleBar(this.browserWindow);
      if (this.options.backgroundColor) {
        const parsed = parseBackgroundColor(this.options.backgroundColor);
        if (parsed) {
          dotnet.setWebViewBackground(this.webView, parsed.a, parsed.r, parsed.g, parsed.b);
        }
      }
    } else if (this.options.backgroundColor) {
      const parsed = parseBackgroundColor(this.options.backgroundColor);
      if (parsed) {
        dotnet.setWebViewBackground(this.webView, parsed.a, parsed.r, parsed.g, parsed.b);
      }
    }

    (
      this.webView as unknown as {
        add_CoreWebView2InitializationCompleted: (cb: (s: unknown, e: unknown) => void) => void;
      }
    ).add_CoreWebView2InitializationCompleted((sender, e) => {
      const evt = e as unknown as {
        IsSuccess: boolean;
        InitializationException?: { Message?: string };
      };
      if (evt.IsSuccess) {
        this.coreWebView2 = (this.webView as unknown as { CoreWebView2: DotNetObject }).CoreWebView2;
        if (this._webViewInitTimer !== null) {
          clearTimeout(this._webViewInitTimer);
          this._webViewInitTimer = null;
        }
        try {
          // Resolve any pending file path before handing off to the bridge.
          if (!this._pendingAbsFilePath && this.pendingFilePath) {
            this._pendingAbsFilePath = this.pendingFilePath;
            this.pendingFilePath = null;
          }
          this._ipcBridge.setup(this._pendingAbsFilePath);
          this._pendingAbsFilePath = null;
        } catch (e) {
          console.error('[node-with-window] IPC bridge setup failed:', e);
        }
        this.isWebViewReady = true;

        while (this.navigationQueue.length > 0) {
          const action = this.navigationQueue.shift();
          if (action) action();
        }
      } else {
        const msg = evt.InitializationException?.Message ?? 'unknown error';
        console.error('[node-with-window] WebView2 initialization failed:', msg);
        if (this._webViewInitTimer !== null) {
          clearTimeout(this._webViewInitTimer);
          this._webViewInitTimer = null;
        }
        this.navigationQueue = [];
        this.isWebViewReady = true;
      }
    });

    // Timeout fallback: if WebView2 doesn't initialize within 10s, mark as ready anyway.
    this._webViewInitTimer = setTimeout(() => {
      this._webViewInitTimer = null;
      if (!this.isWebViewReady) {
        console.warn('[node-with-window] WebView2 initialization timeout, proceeding anyway');
        this.isWebViewReady = true;
        while (this.navigationQueue.length > 0) {
          const action = this.navigationQueue.shift();
          if (action) action();
        }
      }
    }, 10000);
  }

  public onNavigationCompleted(callback: () => void): void {
    this._ipcBridge.onNavigationCompleted(callback);
  }

  public onNavigate(callback: (url: string) => void): void {
    this._ipcBridge.onNavigate(callback);
  }

  public onDomReady(callback: () => void): void {
    this._ipcBridge.onDomReady(callback);
  }

  public onNavigateFailed(callback: (errorCode: number, errorDescription: string, url: string) => void): void {
    this._ipcBridge.onNavigateFailed(callback);
  }

  public executeJavaScript(code: string): Promise<unknown> {
    return this._ipcBridge.executeJavaScript(code);
  }

  public sendIpcReply(id: string, result: unknown, error: string | null): void {
    this._ipcBridge.sendIpcReply(id, result, error);
  }

  public send(channel: string, ...args: unknown[]): void {
    this._ipcBridge.send(channel, ...args);
  }

  public sendToRenderer(channel: string, ...args: unknown[]): void {
    this._ipcBridge.send(channel, ...args);
  }

  /**
   * Registers cancelable Closing and final Closed handlers on the WPF window.
   * Call once per window after the window object is created.
   *
   * - add_Closing: fires before the window closes (X button only, not programmatic).
   *   `FireSyncEventAndWait` blocks C# until Node.js replies, so `e.Cancel = true`
   *   is applied synchronously — this is the same mechanism as the node-ps1-dotnet
   *   prevent-close example.  When `isClosed` is already set (programmatic path),
   *   the handler returns without cancelling.
   * - add_Closed: fires after the window has been destroyed.
   */
  private _registerWindowCloseHandlers(): void {
    (this.browserWindow as DotNetObject).add_Closing((_s: unknown, e: DotNetObject) => {
      if (this.isClosed) return;
      e.Cancel = true;
      void this._handleCloseRequestAsync();
    });
    (this.browserWindow as unknown as { add_Closed: (cb: () => void) => void }).add_Closed(() => {
      this._onWindowClosed();
    });
    (this.browserWindow as DotNetObject).add_Activated((_s: unknown, _e: unknown) => {
      this.onFocus?.();
    });
    (this.browserWindow as DotNetObject).add_Deactivated((_s: unknown, _e: unknown) => {
      this.onBlur?.();
    });
    (this.browserWindow as DotNetObject).add_SizeChanged((_s: unknown, e: DotNetObject) => {
      try {
        const w = Math.round(e.NewSize.Width as number);
        const h = Math.round(e.NewSize.Height as number);
        this.onResize?.(w, h);
      } catch { /* best-effort */ }
    });
  }

  public show(): void {
    if (this.app) {
      this._isVisible = true;
      (this.browserWindow as unknown as { Show: () => void }).Show();
      this.onShow?.();
      return;
    }

    // ── Secondary-window path ────────────────────────────────────────────────
    // WPF message loop is already running (another window called Application.Run).
    // Just wire the close handler and call Show() — no new Application or timer.
    if (_wpfStarted) {
      this.app = true; // mark as started so re-calls above take the fast path

      if (this.pendingMenu) {
        buildWpfMenu(Object.assign(this, { pendingMenu: this.pendingMenu }));
      }

      this._registerWindowCloseHandlers();

      // Set WPF Owner before Show() if a parent window is provided.
      if (this.options.parent) {
        const parentHwnd = (this.options.parent as unknown as { getHwnd?: () => string }).getHwnd?.() as string | undefined;
        if (parentHwnd && parentHwnd !== '0') {
          dotnet.setOwnerByHwnd(this.browserWindow, parentHwnd);
        }
      }

      (this.browserWindow as unknown as { Show: () => void }).Show();
      this._isVisible = true;
      this.onShow?.();

      setImmediate(() => {
        initWebView2WithProtocols(this._coreAssembly as DotNetObject, this.webView, this.webPreferences, this.userDataPath, dotnet).catch(e => {
          console.error('[node-with-window] Protocol WebView2 init error (secondary window):', e);
        });
      });

      if (this.options.kiosk) {
        this.setKiosk(true);
      } else if (this.options.fullscreen) {
        this.setFullScreen(true);
      }
      this._windowChrome.apply();

      // Disable parent for modal windows.
      if (this.options.modal && this.options.parent) {
        (this.options.parent as unknown as { setEnabled?: (f: boolean) => void }).setEnabled?.(false);
      }
      return;
    }

    // ── Primary-window path ──────────────────────────────────────────────────
    _wpfStarted = true;

    const System = dotnet.System;
    const Windows = System.Windows;

    if (this.pendingMenu) {
      buildWpfMenu(Object.assign(this, { pendingMenu: this.pendingMenu }));
    }

    if (this.pendingFilePath) {
      // Store absolute path; _ipcBridge.setup() navigates to the file:// URI after
      // registering the bridge script.
      this._pendingAbsFilePath = this.pendingFilePath;
      this.pendingFilePath = null;
    }

    // Always use the protocol-based initialization path so that nww:// (node
    // integration) and any user custom schemes are registered before WebView2
    // creates its environment.  We never set Source = about:blank here; the
    // IPC bridge setup and initial navigation happen inside
    // _initWebView2WithProtocols() after EnsureCoreWebView2Async resolves.
    this.app = new Windows.Application();

    this._registerWindowCloseHandlers();

    // StartApplication pre-sends {type:'ok'} immediately, then calls Application.Run()
    // on the .NET side — the Node.js event loop is never blocked.
    dotnet.startApplication(this.app, this.browserWindow);

    // Always initialize WebView2 via the protocol path so nww:// is registered.
    setTimeout(() => {
      initWebView2WithProtocols(this._coreAssembly as DotNetObject, this.webView, this.webPreferences, this.userDataPath, dotnet).catch(e => {
        console.error('[node-with-window] Protocol WebView2 init error:', e);
      });
    }, 100);

    if (this.options.kiosk) {
      this.setKiosk(true);
    } else if (this.options.fullscreen) {
      this.setFullScreen(true);
    }

    // Apply P/Invoke chrome options. HWND is valid once Application.Run() has been
    // called and the window handle has been created (synchronous after startApplication).
    this._windowChrome.apply();
  }

  public close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this._ipcBridge.cleanup();
    if (this.browserWindow) {
      try {
        (this.browserWindow as unknown as { Close: () => void }).Close();
      } catch {
        /* ignore */
      }
    }
    this.cleanupUserData();
    // Do NOT call process.exit() here — BrowserWindow._handleClosed() owns exit logic.
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Async close-request handler: calls onCloseRequest and destroys window if not prevented. */
  private async _handleCloseRequestAsync(): Promise<void> {
    const prevented = await (this.onCloseRequest?.() ?? false);
    if (!prevented) {
      this.isClosed = true;
      try { this.browserWindow.Close(); } catch { /* ignore */ }
    }
  }

  /** Called when the WPF window has been closed (via poll or direct close()). */
  private _onWindowClosed(): void {
    if (this.isClosed) return;
    this.isClosed = true;

    if (this._webViewInitTimer !== null) {
      clearTimeout(this._webViewInitTimer);
      this._webViewInitTimer = null;
    }

    // Re-enable the parent if this was a modal window.
    if (this.options.modal && this.options.parent) {
      (this.options.parent as unknown as { setEnabled?: (f: boolean) => void }).setEnabled?.(true);
    }

    this._ipcBridge.cleanup();
    this.cleanupUserData();
    // Notify BrowserWindow, which will emit 'closed', 'window-all-closed', and
    // call process.exit(0) if no listener handles window-all-closed.
    this.onClosed?.();
  }

  public cleanupUserData(): void {
    if (!this._isTempSession) return;
    if (this.userDataPath && fs.existsSync(this.userDataPath)) {
      try {
        fs.rmSync(this.userDataPath, { recursive: true, force: true });
      } catch { /* temp session cleanup is best-effort */ }
    }
  }

  public setMenu(menu: MenuItemOptions[]): void {
    if (this.app && this.browserWindow) {
      buildWpfMenu(Object.assign(this, { pendingMenu: menu }));
    } else {
      this.pendingMenu = menu;
    }
  }

  /** Show a context menu at screen position (x, y) or at cursor if not specified. */
  public popupMenu(items: MenuItemOptions[], x?: number, y?: number): void {
    popupContextMenu(this, dotnet, items, x, y);
  }

  public async loadURL(urlStr: string): Promise<void> {
    if (!this.webView) {
      this.navigationQueue.push(() => this.loadURL(urlStr));
      return;
    }
    const System = dotnet.System;
    (this.webView as unknown as { Source: unknown }).Source = new System.Uri(urlStr);
  }

  public async loadFile(filePath: string): Promise<void> {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);
    if (!this.isWebViewReady) {
      this.pendingFilePath = absolutePath;
      return;
    }
    const fileUri = 'file:///' + absolutePath.replace(/\\/g, '/');
    const System = dotnet.System;
    (this.webView as unknown as { Source: unknown }).Source = new System.Uri(fileUri);
  }

  public reload(): void {
    if (!this.coreWebView2) return;
    (this.coreWebView2 as unknown as { Reload: () => void }).Reload();
  }

  public openDevTools(): void {
    if (!this.coreWebView2) return;
    (this.coreWebView2 as unknown as { OpenDevToolsWindow: () => void }).OpenDevToolsWindow();
  }

  /** Alias for close() — Electron compat. */
  public destroy(): void {
    this.close();
  }

  public focus(): void {
    if (!this.browserWindow) return;
    (this.browserWindow as unknown as { Activate: () => void }).Activate();
  }

  public blur(): void {
    /* WPF has no direct blur API */
  }

  public minimize(): void {
    if (!this.browserWindow) return;
    dotnet.minimize(this.browserWindow);
  }

  public maximize(): void {
    if (!this.browserWindow) return;
    (this.browserWindow as unknown as { WindowState: unknown }).WindowState =
      dotnet.System.Windows.WindowState.Maximized;
  }

  public unmaximize(): void {
    if (!this.browserWindow) return;
    (this.browserWindow as unknown as { WindowState: unknown }).WindowState =
      dotnet.System.Windows.WindowState.Normal;
  }

  public setFullScreen(flag: boolean): void {
    if (!this.browserWindow) return;
    this._isFullScreen = flag;
    const needFrameless = this.options.frame === false || this.options.transparent === true
      || this.options.titleBarStyle === 'hidden' || this.options.titleBarStyle === 'hiddenInset';
    dotnet.setFullScreen(
      this.browserWindow, flag, needFrameless, this.options.alwaysOnTop ?? false
    );
  }

  public isFullScreen(): boolean {
    return this._isFullScreen;
  }

  public setKiosk(flag: boolean): void {
    this._isKiosk = flag;
    this.setFullScreen(flag);
    this._windowChrome.setSkipTaskbar(flag || (this.options.skipTaskbar ?? false));
  }

  public isKiosk(): boolean {
    return this._isKiosk;
  }

  public setBackgroundColor(color: string): void {
    if (!this.webView) return;
    const parsed = parseBackgroundColor(color);
    if (parsed) {
      dotnet.setWebViewBackground(this.webView, parsed.a, parsed.r, parsed.g, parsed.b);
    }
  }

  public setTitle(title: string): void {
    if (!this.browserWindow) return;
    (this.browserWindow as unknown as { Title: string }).Title = title;
  }

  public getTitle(): string {
    if (!this.browserWindow) return this.options.title ?? '';
    return (this.browserWindow as unknown as { Title: string }).Title;
  }

  public setSize(width: number, height: number): void {
    if (!this.browserWindow) return;
    const win = this.browserWindow as unknown as { Width: number; Height: number };
    win.Width = width;
    win.Height = height;
  }

  public getSize(): [number, number] {
    if (!this.browserWindow) return [this.options.width ?? 0, this.options.height ?? 0];
    const win = this.browserWindow as unknown as { ActualWidth: number; ActualHeight: number };
    return [Math.round(win.ActualWidth), Math.round(win.ActualHeight)];
  }

  public setPosition(x: number, y: number): void {
    if (!this.browserWindow) return;
    const win = this.browserWindow as unknown as { Left: number; Top: number };
    win.Left = x;
    win.Top = y;
  }

  public getPosition(): [number, number] {
    if (!this.browserWindow) return [0, 0];
    const win = this.browserWindow as unknown as { Left: number; Top: number };
    return [Math.round(win.Left), Math.round(win.Top)];
  }

  public setOpacity(opacity: number): void {
    if (!this.browserWindow) return;
    (this.browserWindow as unknown as { Opacity: number }).Opacity = opacity;
  }

  public getOpacity(): number {
    if (!this.browserWindow) return 1;
    return (this.browserWindow as unknown as { Opacity: number }).Opacity;
  }

  public setResizable(resizable: boolean): void {
    this._isResizable = resizable;
    if (!this.browserWindow) return;
    const Windows = dotnet.System.Windows;
    (this.browserWindow as unknown as { ResizeMode: unknown }).ResizeMode = resizable
      ? Windows.ResizeMode.CanResize
      : Windows.ResizeMode.NoResize;
  }

  public isResizable(): boolean {
    return this._isResizable;
  }

  public hide(): void {
    if (!this.browserWindow) return;
    this._isVisible = false;
    (this.browserWindow as unknown as { Hide: () => void }).Hide();
    this.onHide?.();
  }

  public isVisible(): boolean {
    return this._isVisible && !this.isClosed;
  }

  public isDestroyed(): boolean {
    return this.isClosed;
  }

  public isMinimized(): boolean {
    if (!this.browserWindow) return false;
    try {
      const state = this.browserWindow.WindowState;
      const Minimized = dotnet.System.Windows.WindowState.Minimized;
      return state === Minimized;
    } catch { return false; }
  }

  public isMaximized(): boolean {
    if (!this.browserWindow) return false;
    try {
      const state = this.browserWindow.WindowState;
      const Maximized = dotnet.System.Windows.WindowState.Maximized;
      return state === Maximized;
    } catch { return false; }
  }

  public isFocused(): boolean {
    if (!this.browserWindow) return false;
    try { return this.browserWindow.IsActive as boolean; } catch { return false; }
  }

  public setAlwaysOnTop(flag: boolean): void {
    if (!this.browserWindow) return;
    (this.browserWindow as unknown as { Topmost: boolean }).Topmost = flag;
  }

  /** Center the window on the primary screen. */
  public center(): void {
    if (!this.browserWindow) return;
    const sp = dotnet.System.Windows.SystemParameters;
    const win = this.browserWindow as unknown as {
      Left: number; Top: number; Width: number; Height: number;
    };
    win.Left = (sp.PrimaryScreenWidth  - win.Width)  / 2;
    win.Top  = (sp.PrimaryScreenHeight - win.Height) / 2;
  }

  // ── Win32Chrome delegation ─────────────────────────────────────────────────

  public setMinimumSize(width: number, height: number): void {
    this._windowChrome.setMinimumSize(width, height);
  }

  public setMaximumSize(width: number, height: number): void {
    this._windowChrome.setMaximumSize(width, height);
  }

  public setMinimizable(flag: boolean): void  { this._windowChrome.setMinimizable(flag); }
  public isMinimizable(): boolean             { return this._windowChrome.isMinimizable(); }
  public setMaximizable(flag: boolean): void  { this._windowChrome.setMaximizable(flag); }
  public isMaximizable(): boolean             { return this._windowChrome.isMaximizable(); }
  public setClosable(flag: boolean): void     { this._windowChrome.setClosable(flag); }
  public isClosable(): boolean                { return this._windowChrome.isClosable(); }
  public setMovable(flag: boolean): void      { this._windowChrome.setMovable(flag); }
  public isMovable(): boolean                 { return this._windowChrome.isMovable(); }
  public setSkipTaskbar(flag: boolean): void  { this._windowChrome.setSkipTaskbar(flag); }
  public getHwnd(): string                    { return this._windowChrome.getHwnd(); }
  public setEnabled(flag: boolean): void      { this._windowChrome.setEnabled(flag); }
  public flashFrame(flag: boolean): void      { this._windowChrome.flashFrame(flag); }

  // ── Dialogs ────────────────────────────────────────────────────────────────

  public showOpenDialog(options: OpenDialogOptions): Promise<string[] | undefined> {
    return showOpenDialog(options);
  }

  public showSaveDialog(options: SaveDialogOptions): Promise<string | undefined> {
    return showSaveDialog(options);
  }

  public showMessageBox(options: {
    type?: string;
    title?: string;
    message: string;
    buttons?: string[];
  }): Promise<number> {
    return showMessageBox(options);
  }

  /** Captures the WebView2 rendering as a PNG and returns a NativeImage. */
  public async capturePage(): Promise<NativeImage> {
    if (!this.webView) return new NativeImage(Buffer.alloc(0));
    const base64 = dotnet.capturePreview(this.webView) as string;
    if (!base64) return new NativeImage(Buffer.alloc(0));
    return new NativeImage(Buffer.from(base64, 'base64'));
  }
}
