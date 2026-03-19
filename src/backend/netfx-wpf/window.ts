import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  IWindowProvider,
  BrowserWindowOptions,
  WebPreferences,
  OpenDialogOptions,
  SaveDialogOptions,
  MenuItemOptions,
} from '../../interfaces.js';
import { NativeImage } from '../../native-image.js';
import { ipcMain } from '../../ipc-main.js';
import { generateBridgeScript } from './bridge.js';
import { showOpenDialog, showSaveDialog, showMessageBox } from './dialogs.js';
import { buildWpfMenu } from './menu.js';
import { getSyncServerPort } from '../../node-integration.js';
import { callbackRegistry, createProxy, createProxyWithInlineProps } from './dotnet/proxy.js';

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

let dotnet: unknown;

/**
 * Sets the .NET runtime instance that's used for all WPF/WebView2 operations.
 */
export function setDotNetInstance(instance: unknown): void {
  dotnet = instance;
}

/**
 * Searches common locations for the WebView2 runtime DLLs.
 *
 * Looks for:
 * - Microsoft.Web.WebView2.Core.dll
 * - Microsoft.Web.WebView2.Wpf.dll
 *
 * Supports both subdirectory layouts (versioned) and flat layouts.
 *
 * Primary search is relative to this file's location (import.meta.url),
 * which is reliable regardless of the working directory of the host app.
 * This is what allows the DLLs to be bundled inside the npm package and
 * discovered through node_modules automatically.
 */
function findWebView2Runtime(): string {
  // __dirname of this compiled file is dist/backend/netfx-wpf/
  // Runtimes are at <package-root>/runtimes/webview2/
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRootRuntimes = path.resolve(thisDir, '..', '..', '..', 'runtimes', 'webview2');

  const possibleBasePaths = [
    packageRootRuntimes,
    path.resolve(
      process.cwd(),
      'node_modules',
      '@devscholar',
      'node-with-window',
      'runtimes',
      'webview2'
    ),
    path.resolve(process.cwd(), 'runtimes', 'webview2'),
    path.resolve(process.cwd(), '..', 'node-with-window', 'runtimes', 'webview2'),
    path.resolve(
      process.cwd(),
      '..',
      '..',
      'node_modules',
      '@devscholar',
      'node-with-window',
      'runtimes',
      'webview2'
    ),
  ];

  for (const basePath of possibleBasePaths) {
    if (!fs.existsSync(basePath)) {
      continue;
    }

    // Check for versioned subdirectory layout
    const entries = fs.readdirSync(basePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const runtimePath = path.join(basePath, entry.name);
        const coreDllPath = path.join(runtimePath, 'Microsoft.Web.WebView2.Core.dll');
        const wpfDllPath = path.join(runtimePath, 'Microsoft.Web.WebView2.Wpf.dll');
        if (fs.existsSync(coreDllPath) && fs.existsSync(wpfDllPath)) {
          return runtimePath;
        }
      }
    }

    // Check for flat layout (DLLs directly in basePath)
    const coreDllPath = path.join(basePath, 'Microsoft.Web.WebView2.Core.dll');
    const wpfDllPath = path.join(basePath, 'Microsoft.Web.WebView2.Wpf.dll');
    if (fs.existsSync(coreDllPath) && fs.existsSync(wpfDllPath)) {
      return basePath;
    }
  }

  throw new Error(`WebView2 DLLs not found. Searched in: ${possibleBasePaths.join(', ')}`);
}

/** How often (ms) Node.js polls the .NET host for queued events. */
const POLL_INTERVAL_MS = 16;

/**
 * True once the first window's Application.Run() has been called.
 * Subsequent windows skip Application creation and just call Show().
 */
let _wpfStarted = false;

/**
 * Parses a CSS hex color string into ARGB components (each 0–255).
 * Accepts: #RGB, #RRGGBB, #AARRGGBB (Electron uses AA-prefixed alpha).
 * Returns null if the string is not a recognised hex color.
 */
function parseBackgroundColor(color: string): { a: number; r: number; g: number; b: number } | null {
  const hex3 = color.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (hex3) return {
    a: 255,
    r: parseInt(hex3[1] + hex3[1], 16),
    g: parseInt(hex3[2] + hex3[2], 16),
    b: parseInt(hex3[3] + hex3[3], 16),
  };
  const hex6 = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex6) return {
    a: 255,
    r: parseInt(hex6[1], 16),
    g: parseInt(hex6[2], 16),
    b: parseInt(hex6[3], 16),
  };
  // #AARRGGBB — Electron convention for transparent background colors
  const hex8 = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex8) return {
    a: parseInt(hex8[1], 16),
    r: parseInt(hex8[2], 16),
    g: parseInt(hex8[3], 16),
    b: parseInt(hex8[4], 16),
  };
  return null;
}

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
 */
export class NetFxWpfWindow implements IWindowProvider {
  public options: BrowserWindowOptions;
  public webPreferences: WebPreferences;
  public browserWindow: unknown;
  public webView: unknown;
  public coreWebView2: unknown;
  public app: unknown;
  public isWebViewReady = false;
  public navigationQueue: Array<() => void> = [];
  public pendingFilePath: string | null = null;
  private _pendingAbsFilePath: string | null = null;
  public userDataPath: string;
  public pendingMenu: MenuItemOptions[] | null = null;
  /** Registered by BrowserWindow; called when the WPF window is closed externally. */
  public onClosed?: () => void;
  private isClosed = false;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _isFullScreen = false;
  private _isKiosk = false;
  private _isResizable = true;
  private _isMinimizable = true;
  private _isMaximizable = true;
  private _isClosable = true;
  private _isMovable = true;
  private _skipTaskbar = false;
  private _navCompletedCallback: (() => void) | null = null;
  private _pendingExecs = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(options?: BrowserWindowOptions) {
    this.options = options || {};
    this.webPreferences = this.options.webPreferences || {};
    this._isResizable   = this.options.resizable    ?? true;
    this._isMinimizable = this.options.minimizable  ?? true;
    this._isMaximizable = this.options.maximizable  ?? true;
    this._isClosable    = this.options.closable     ?? true;
    this._isMovable     = this.options.movable      ?? true;
    this._skipTaskbar   = this.options.skipTaskbar  ?? false;

    const partition = this.webPreferences.partition;

    if (partition) {
      if (partition.startsWith('persist:')) {
        const partitionName = partition.substring(8);
        this.userDataPath = path.join(
          os.tmpdir(),
          'node-with-window-webview2',
          'persist',
          partitionName
        );
      } else if (partition.startsWith('temp:')) {
        this.userDataPath = path.join(
          os.tmpdir(),
          'node-with-window-webview2',
          `temp-${Date.now()}-${Math.random()}`
        );
      } else {
        this.userDataPath = path.join(
          os.tmpdir(),
          'node-with-window-webview2',
          'persist',
          partition
        );
      }
    } else {
      this.userDataPath = path.join(os.tmpdir(), 'node-with-window-webview2', 'default');
    }
  }

  public async createWindow(): Promise<void> {
    const dotnetAny = dotnet as any;
    const System = dotnetAny.System;
    const Windows = System.Windows;
    const Controls = Windows.Controls;

    const runtimePath = findWebView2Runtime();
    const coreDllPath = path.join(runtimePath, 'Microsoft.Web.WebView2.Core.dll');
    const wpfDllPath = path.join(runtimePath, 'Microsoft.Web.WebView2.Wpf.dll');

    System.Reflection.Assembly.LoadFrom(coreDllPath);
    const WebView2WpfAssembly = System.Reflection.Assembly.LoadFrom(wpfDllPath);

    const WebView2Type = (
      WebView2WpfAssembly as unknown as { GetType: (name: string) => { new (): unknown } }
    ).GetType('Microsoft.Web.WebView2.Wpf.WebView2');
    this.webView = new WebView2Type();

    const CreationPropertiesType = (
      WebView2WpfAssembly as unknown as { GetType: (name: string) => { new (): unknown } }
    ).GetType('Microsoft.Web.WebView2.Wpf.CoreWebView2CreationProperties');
    const props = new CreationPropertiesType() as unknown as {
      UserDataFolder: string;
      AdditionalBrowserArguments: string;
    };
    props.UserDataFolder = this.userDataPath;
    if (this.webPreferences.webSecurity === false) {
      props.AdditionalBrowserArguments = '--disable-web-security';
    }
    (this.webView as unknown as { CreationProperties: unknown }).CreationProperties = props;

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
        (dotnet as any).setWindowIcon(this.browserWindow, absIcon);
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
      //
      // WindowChrome is a WPF dependency property — no HWND needed, safe to call
      // before show(). Applying it here (before Application.Run/Show) means the window
      // is already transparent when it first becomes visible, eliminating the black flash.
      (this.browserWindow as unknown as { ResizeMode: unknown }).ResizeMode =
        Windows.ResizeMode.NoResize;
      (this.browserWindow as unknown as { Background: unknown }).Background =
        Windows.Media.Brushes.Transparent;
      (dotnet as any).applyWindowChrome(this.browserWindow);
      (dotnet as any).setWebViewBackground(this.webView, 0, 0, 0, 0);
    } else if (this.options.frame !== false &&
        (this.options.titleBarStyle === 'hidden' || this.options.titleBarStyle === 'hiddenInset')) {
      // titleBarStyle:'hidden'/'hiddenInset' — remove the native title bar while keeping
      // the resize border (4 px on all sides).  The app is expected to implement its own
      // drag region in HTML (e.g. -webkit-app-region: drag via a custom CSS class).
      (dotnet as any).applyHiddenTitleBar(this.browserWindow);
      if (this.options.backgroundColor) {
        const parsed = parseBackgroundColor(this.options.backgroundColor);
        if (parsed) {
          (dotnet as any).setWebViewBackground(this.webView, parsed.a, parsed.r, parsed.g, parsed.b);
        }
      }
    } else if (this.options.backgroundColor) {
      const parsed = parseBackgroundColor(this.options.backgroundColor);
      if (parsed) {
        (dotnet as any).setWebViewBackground(this.webView, parsed.a, parsed.r, parsed.g, parsed.b);
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
        this.coreWebView2 = (this.webView as unknown as { CoreWebView2: unknown }).CoreWebView2;
        try {
          this.setupIpcBridge();
        } catch (e) {
          console.error('[node-with-window] setupIpcBridge failed:', e);
        }
        this.isWebViewReady = true;

        while (this.navigationQueue.length > 0) {
          const action = this.navigationQueue.shift();
          if (action) action();
        }
      } else {
        const msg = evt.InitializationException?.Message ?? 'unknown error';
        console.error('[node-with-window] WebView2 initialization failed:', msg);
        this.navigationQueue = [];
      }
    });
  }

  /**
   * Sets up the IPC bridge and document title sync.
   * Both sync and async ipcMain.handle() callbacks are supported.
   */
  private setupIpcBridge(): void {
    const handlers = (
      ipcMain as unknown as {
        handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
      }
    ).handlers;

    // Register the bridge script and navigate in one atomic C# operation.
    // AddScriptToExecuteOnDocumentCreatedAsync returns a Task<string> that completes
    // only after the WebView2 browser process confirms the script registration.
    // In polling mode we cannot Task.Wait() on the UI thread (deadlock), so the
    // dedicated AddScriptAndNavigate action uses Task.ContinueWith to call Navigate()
    // only after the ack arrives — guaranteeing the script runs on the first document.
    let bridgeScript = generateBridgeScript(this.webPreferences, getSyncServerPort());
    const preloadPath = this.webPreferences.preload;
    if (preloadPath) {
      const absPreload = path.isAbsolute(preloadPath)
        ? preloadPath
        : path.resolve(process.cwd(), preloadPath);
      try {
        bridgeScript += '\n' + fs.readFileSync(absPreload, 'utf-8');
      } catch (e) {
        console.error('[node-with-window] Failed to load preload script:', e);
      }
    }
    // _pendingAbsFilePath is set when loadFile() was called before show().
    // pendingFilePath is set when loadFile() was called after show() but before
    // CoreWebView2 was ready (e.g. async user code between create() and loadFile()).
    if (!this._pendingAbsFilePath && this.pendingFilePath) {
      this._pendingAbsFilePath = this.pendingFilePath;
      this.pendingFilePath = null;
    }
    if (this._pendingAbsFilePath) {
      const fileUri = 'file:///' + this._pendingAbsFilePath.replace(/\\/g, '/');
      (dotnet as any).addScriptAndNavigate(this.coreWebView2, bridgeScript, fileUri);
      this._pendingAbsFilePath = null;
    } else {
      (
        this.coreWebView2 as unknown as {
          AddScriptToExecuteOnDocumentCreatedAsync: (s: string) => unknown;
        }
      ).AddScriptToExecuteOnDocumentCreatedAsync(bridgeScript);
    }

    // Automatically sync document.title changes to the WPF window title bar
    (
      this.coreWebView2 as unknown as {
        add_DocumentTitleChanged: (cb: (_sender: unknown, _e: unknown) => void) => void;
      }
    ).add_DocumentTitleChanged((_sender, _e) => {
      const title = (this.coreWebView2 as unknown as { DocumentTitle: string }).DocumentTitle;
      if (title) {
        (this.browserWindow as unknown as { Title: string }).Title = title;
      }
    });

    (
      this.coreWebView2 as unknown as {
        add_WebMessageReceived: (cb: (_sender: unknown, e: unknown) => void) => void;
      }
    ).add_WebMessageReceived((_sender, e) => {
      try {
        const evt = e as unknown as { WebMessageAsJson: string };
        // WebMessageAsJson double-encodes string messages: JSON.parse once gives the inner
        // JSON string, JSON.parse again gives the actual message object.
        const outer = JSON.parse(evt.WebMessageAsJson);
        const message = typeof outer === 'string' ? JSON.parse(outer) : outer;
        const { channel, type, id, args = [] } = message;

        const event = {
          sender: this,
          reply: (ch: string, ...a: unknown[]) => this.send(ch, ...a),
        };

        if (type === 'execResult') {
          const pending = this._pendingExecs.get(id);
          if (pending) {
            this._pendingExecs.delete(id);
            if (message.error) pending.reject(new Error(message.error));
            else pending.resolve(message.result);
          }
        } else if (type === 'send') {
          ipcMain.emit(channel, event, ...args);
        } else if (type === 'invoke') {
          const handler = handlers.get(channel);
          if (handler) {
            try {
              const result = handler(event, ...args);
              if (result && typeof (result as unknown as { then: unknown }).then === 'function') {
                (result as Promise<unknown>)
                  .then(r => this.sendIpcReply(id, r, null))
                  .catch(err => this.sendIpcReply(id, null, (err as Error).message || String(err)));
              } else {
                this.sendIpcReply(id, result, null);
              }
            } catch (err: unknown) {
              const error = err as { message?: string };
              this.sendIpcReply(id, null, error.message || String(err));
            }
          } else {
            this.sendIpcReply(id, null, `No handler for channel: ${channel}`);
          }
        }
      } catch (err: unknown) {
        const error = err as { message?: string };
        console.error('[WebView2] WebMessageReceived error:', error.message);
      }
    });

    // Fire 'did-finish-load' through the registered callback when navigation completes.
    if (this._navCompletedCallback) {
      (
        this.coreWebView2 as unknown as {
          add_NavigationCompleted: (cb: (_s: unknown, _e: unknown) => void) => void;
        }
      ).add_NavigationCompleted((_s, _e) => {
        this._navCompletedCallback?.();
      });
    }
  }

  public onNavigationCompleted(callback: () => void): void {
    this._navCompletedCallback = callback;
  }

  public executeJavaScript(code: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.coreWebView2) {
        reject(new Error('WebView2 not ready'));
        return;
      }
      const id = Math.random().toString(36).substring(2, 11);
      const timer = setTimeout(() => {
        if (this._pendingExecs.delete(id)) {
          reject(new Error('executeJavaScript timed out after 10000ms'));
        }
      }, 10_000);
      this._pendingExecs.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });
      const payload = JSON.stringify({ type: 'exec', id, code });
      (
        this.coreWebView2 as unknown as { PostWebMessageAsString: (s: string) => void }
      ).PostWebMessageAsString(payload);
    });
  }

  public sendIpcReply(id: string, result: unknown, error: string | null): void {
    const payload = JSON.stringify({ type: 'reply', id, result, error });
    (
      this.coreWebView2 as unknown as { PostWebMessageAsString: (msg: string) => void }
    ).PostWebMessageAsString(payload);
  }

  public send(channel: string, ...args: unknown[]): void {
    if (!this.coreWebView2) return;
    const payload = JSON.stringify({ type: 'message', channel, args });
    (
      this.coreWebView2 as unknown as { PostWebMessageAsString: (msg: string) => void }
    ).PostWebMessageAsString(payload);
  }

  public sendToRenderer(channel: string, ...args: unknown[]): void {
    this.send(channel, ...args);
  }

  public async loadURL(urlStr: string): Promise<void> {
    if (!this.app) {
      this.navigationQueue.push(() => this.loadURL(urlStr));
      return;
    }
    const System = (dotnet as any).System;
    (this.webView as unknown as { Source: unknown }).Source = new System.Uri(urlStr);
  }

  public async loadFile(filePath: string): Promise<void> {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);
    if (!this.isWebViewReady) {
      // Queue whether show() hasn't been called yet OR has been called but
      // CoreWebView2 isn't ready yet; setupIpcBridge() will pick this up.
      this.pendingFilePath = absolutePath;
      return;
    }
    const fileUri = 'file:///' + absolutePath.replace(/\\/g, '/');
    const System = (dotnet as any).System;
    (this.webView as unknown as { Source: unknown }).Source = new System.Uri(fileUri);
  }

  public show(): void {
    if (this.app) {
      (this.browserWindow as unknown as { Show: () => void }).Show();
      return;
    }

    const dotnetAny = dotnet as any;

    // ── Secondary-window path ────────────────────────────────────────────────
    // WPF message loop is already running (another window called Application.Run).
    // Just wire the close handler and call Show() — no new Application or timer.
    if (_wpfStarted) {
      this.app = true; // mark as started so re-calls above take the fast path

      if (this.pendingMenu) {
        buildWpfMenu(Object.assign(this, { pendingMenu: this.pendingMenu }));
      }

      (this.browserWindow as unknown as { add_Closed: (cb: () => void) => void }).add_Closed(() => {
        this._onWindowClosed();
      });

      // Set WPF Owner before Show() if a parent window is provided.
      if (this.options.parent) {
        const parentHwnd = (this.options.parent as any).getHwnd?.() as string | undefined;
        if (parentHwnd && parentHwnd !== '0') {
          dotnetAny.setOwnerByHwnd(this.browserWindow, parentHwnd);
        }
      }

      (this.browserWindow as unknown as { Show: () => void }).Show();

      if (this.options.kiosk) {
        this.setKiosk(true);
      } else if (this.options.fullscreen) {
        this.setFullScreen(true);
      }
      this._applyWindowChrome();

      // Disable parent for modal windows.
      if (this.options.modal && this.options.parent) {
        (this.options.parent as any).setEnabled?.(false);
      }
      return;
    }

    // ── Primary-window path ──────────────────────────────────────────────────
    _wpfStarted = true;

    const System = dotnetAny.System;
    const Windows = System.Windows;

    if (this.pendingMenu) {
      buildWpfMenu(Object.assign(this, { pendingMenu: this.pendingMenu }));
    }

    if (this.pendingFilePath) {
      // Store absolute path; setupIpcBridge navigates to the file:// URI after registering the bridge script.
      this._pendingAbsFilePath = this.pendingFilePath;
      this.pendingFilePath = null;
    }

    // Always start with about:blank so WebView2 doesn't auto-navigate before we can
    // register AddScriptToExecuteOnDocumentCreated in setupIpcBridge().
    (this.webView as unknown as { Source: unknown }).Source = new System.Uri('about:blank');
    this.app = new Windows.Application();

    (this.browserWindow as unknown as { add_Closed: (cb: () => void) => void }).add_Closed(() => {
      this._onWindowClosed();
    });

    // StartApplication pre-sends {type:'ok'} immediately, then calls Application.Run()
    // on the .NET side — the Node.js event loop is never blocked.
    dotnetAny.startApplication(this.app, this.browserWindow);

    // Apply fullscreen / kiosk option after the window is shown.
    if (this.options.kiosk) {
      this.setKiosk(true);
    } else if (this.options.fullscreen) {
      this.setFullScreen(true);
    }

    // Apply P/Invoke chrome options. HWND is valid once Application.Run() has been
    // called and the window handle has been created (synchronous after startApplication).
    this._applyWindowChrome();

    // Poll for queued .NET events (WebMessageReceived, CoreWebView2InitializationCompleted, …)
    // exactly like the Linux backend polls its GJS host.
    this._pollTimer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  public close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
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

  /** Called when the WPF window has been closed (via poll or direct close()). */
  private _onWindowClosed(): void {
    if (this.isClosed) return;
    this.isClosed = true;

    // Re-enable the parent if this was a modal window.
    if (this.options.modal && this.options.parent) {
      (this.options.parent as any).setEnabled?.(true);
    }

    for (const pending of this._pendingExecs.values()) {
      pending.reject(new Error('Window closed'));
    }
    this._pendingExecs.clear();

    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this.cleanupUserData();
    // Notify BrowserWindow, which will emit 'closed', 'window-all-closed', and
    // call process.exit(0) if no listener handles window-all-closed.
    // Secondary windows: BrowserWindow._handleClosed() does NOT exit when other
    // windows remain open, so this is safe for both primary and secondary windows.
    this.onClosed?.();
  }

  /** Poll the .NET host for one queued event and dispatch it. */
  private _poll(): void {
    if (this.isClosed) return;
    let resp: { type: string; message?: string };
    try {
      resp = (dotnet as any).pollEvent() as typeof resp;
    } catch (e: unknown) {
      // EINTR / EAGAIN are transient — skip this tick.
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EINTR' || code === 'EAGAIN') return;
      // Pipe closed — .NET process exited unexpectedly.
      this._onWindowClosed();
      return;
    }
    if (resp.type === 'ipc' && resp.message) {
      try {
        this._dispatchRendererMessage(resp.message);
      } catch (e) {
        console.error('[node-with-window] event dispatch error:', e);
      }
    }
  }

  /**
   * Dispatches a JSON message from the WebView2 renderer to the appropriate handler.
   *
   * Message shapes:
   *   { type: 'event', callbackId, args }  — .NET event callbacks (menu, WebView2 events, etc.)
   *
   * IPC messages (send/invoke/execResult) are handled directly in the
   * add_WebMessageReceived callback registered during createWindow(), not here.
   */
  private _dispatchRendererMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'event') {
      // .NET event callback (e.g. menu item click, WebView2 CoreWebView2InitializationCompleted)
      const cb = callbackRegistry.get(msg.callbackId);
      if (cb) {
        const wrappedArgs = (msg.args ?? []).map((arg: any) => {
          if (arg && arg.type === 'ref' && arg.props) return createProxyWithInlineProps(arg);
          return createProxy(arg);
        });
        try { cb(...wrappedArgs); } catch (e) { console.error('[node-with-window] .NET event callback error:', e); }
      }
    }
  }

  public cleanupUserData(): void {
    if (this.userDataPath && fs.existsSync(this.userDataPath)) {
      try {
        fs.rmSync(this.userDataPath, { recursive: true, force: true });
      } catch {}
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
    if (!this.browserWindow) return;
    const dotnetAny = dotnet as any;
    const ContextMenuType = dotnetAny['System.Windows.Controls.ContextMenu'];
    const MenuItemType    = dotnetAny['System.Windows.Controls.MenuItem'];
    const SeparatorType   = dotnetAny['System.Windows.Controls.Separator'];
    if (!ContextMenuType) return;

    const cm = new ContextMenuType();

    const buildItems = (parent: unknown, list: MenuItemOptions[]) => {
      for (const item of list) {
        if (item.type === 'separator') {
          (parent as any).Items.Add(new SeparatorType());
        } else {
          const mi = new MenuItemType();
          (mi as any).Header = item.label || '';
          if (item.enabled === false) (mi as any).IsEnabled = false;
          if (item.toolTip) (mi as any).ToolTip = item.toolTip;

          // Icon (best-effort)
          if (item.icon) {
            try {
              const iconAbs = path.isAbsolute(item.icon)
                ? item.icon : path.resolve(process.cwd(), item.icon);
              const BitmapImageType = dotnetAny['System.Windows.Media.Imaging.BitmapImage'];
              const ImageType       = dotnetAny['System.Windows.Controls.Image'];
              const UriType         = dotnetAny['System.Uri'];
              if (BitmapImageType && ImageType && UriType) {
                const uri = new UriType('file:///' + iconAbs.replace(/\\/g, '/'));
                const bmp = new BitmapImageType(uri);
                const img = new ImageType();
                (img as any).Source = bmp;
                (img as any).Width  = 16;
                (img as any).Height = 16;
                (mi as any).Icon = img;
              }
            } catch { /* best-effort */ }
          }

          const clickFn = item.click ?? (item.role ? this._wpfRoleClick(item.role) : undefined);
          if (clickFn) (mi as any).add_Click(() => { clickFn(); });
          if (item.submenu) buildItems(mi, item.submenu);
          (parent as any).Items.Add(mi);
        }
      }
    };

    buildItems(cm, items);

    // Explicit screen position
    if (x !== undefined && y !== undefined) {
      try {
        const PlacementModeType = dotnetAny['System.Windows.Controls.Primitives.PlacementMode'];
        const absolutePoint = (PlacementModeType as any).AbsolutePoint;
        (cm as any).Placement       = absolutePoint;
        (cm as any).HorizontalOffset = x;
        (cm as any).VerticalOffset   = y;
      } catch { /* placement is best-effort */ }
    }

    (cm as any).IsOpen = true;
  }

  /** Role→action mapping used by popupMenu (mirrors buildWpfMenu's roleClick). */
  private _wpfRoleClick(role: string): (() => void) | undefined {
    switch (role) {
      case 'close':            return () => this.close();
      case 'minimize':         return () => { (dotnet as any).minimize(this.browserWindow); };
      case 'reload':
      case 'forceReload':      return () => this.reload();
      case 'toggleDevTools':   return () => this.openDevTools();
      case 'togglefullscreen': return () => this.setFullScreen(!this.isFullScreen());
      case 'resetZoom':        return () => { if (this.webView) (this.webView as any).ZoomFactor = 1.0; };
      case 'zoomIn':           return () => { if (this.webView) (this.webView as any).ZoomFactor = Math.min(((this.webView as any).ZoomFactor as number) + 0.1, 5.0); };
      case 'zoomOut':          return () => { if (this.webView) (this.webView as any).ZoomFactor = Math.max(((this.webView as any).ZoomFactor as number) - 0.1, 0.25); };
      case 'undo':      return () => this.executeJavaScript("document.execCommand('undo')");
      case 'redo':      return () => this.executeJavaScript("document.execCommand('redo')");
      case 'cut':       return () => this.executeJavaScript("document.execCommand('cut')");
      case 'copy':      return () => this.executeJavaScript("document.execCommand('copy')");
      case 'paste':     return () => this.executeJavaScript("document.execCommand('paste')");
      case 'selectAll': return () => this.executeJavaScript("document.execCommand('selectAll')");
      default:          return undefined;
    }
  }

  /** Set the minimum window size (applied immediately if window exists). */
  public setMinimumSize(width: number, height: number): void {
    if (!this.browserWindow) {
      // Store for later — window.ts constructor options are already read; we'll apply in show()
      (this as any)._pendingMinSize = [width, height];
      return;
    }
    (this.browserWindow as any).MinWidth  = width;
    (this.browserWindow as any).MinHeight = height;
  }

  /** Set the maximum window size (applied immediately if window exists). */
  public setMaximumSize(width: number, height: number): void {
    if (!this.browserWindow) {
      (this as any)._pendingMaxSize = [width, height];
      return;
    }
    (this.browserWindow as any).MaxWidth  = width > 0 ? width  : Infinity;
    (this.browserWindow as any).MaxHeight = height > 0 ? height : Infinity;
  }

  /**
   * Reloads the current page in WebView2.
   */
  public reload(): void {
    if (!this.coreWebView2) return;
    (this.coreWebView2 as unknown as { Reload: () => void }).Reload();
  }

  /**
   * Opens the WebView2 developer tools window.
   */
  public openDevTools(): void {
    if (!this.coreWebView2) return;
    (this.coreWebView2 as unknown as { OpenDevToolsWindow: () => void }).OpenDevToolsWindow();
  }

  /** Alias for close() — Electron compat. */
  public destroy(): void {
    this.close();
  }

  /** Bring window to the foreground and give it input focus. */
  public focus(): void {
    if (!this.browserWindow) return;
    (this.browserWindow as unknown as { Activate: () => void }).Activate();
  }

  /** Remove input focus (no direct WPF equivalent — no-op). */
  public blur(): void {
    /* WPF has no direct blur API */
  }

  public minimize(): void {
    if (!this.browserWindow) return;
    (dotnet as any).minimize(this.browserWindow);
  }

  public maximize(): void {
    if (!this.browserWindow) return;
    (this.browserWindow as unknown as { WindowState: unknown }).WindowState = (
      dotnet as any
    ).System.Windows.WindowState.Maximized;
  }

  public unmaximize(): void {
    if (!this.browserWindow) return;
    (this.browserWindow as unknown as { WindowState: unknown }).WindowState = (
      dotnet as any
    ).System.Windows.WindowState.Normal;
  }

  public setFullScreen(flag: boolean): void {
    if (!this.browserWindow) return;
    this._isFullScreen = flag;
    const needFrameless = this.options.frame === false || this.options.transparent === true
      || this.options.titleBarStyle === 'hidden' || this.options.titleBarStyle === 'hiddenInset';
    (dotnet as any).setFullScreen(
      this.browserWindow, flag, needFrameless, this.options.alwaysOnTop ?? false
    );
  }

  public isFullScreen(): boolean {
    return this._isFullScreen;
  }

  public setKiosk(flag: boolean): void {
    this._isKiosk = flag;
    this.setFullScreen(flag);
    this.setSkipTaskbar(flag || (this.options.skipTaskbar ?? false));
  }

  public isKiosk(): boolean {
    return this._isKiosk;
  }

  public setBackgroundColor(color: string): void {
    if (!this.webView) return;
    const parsed = parseBackgroundColor(color);
    if (parsed) {
      (dotnet as any).setWebViewBackground(this.webView, parsed.a, parsed.r, parsed.g, parsed.b);
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
    const Windows = (dotnet as any).System.Windows;
    (this.browserWindow as unknown as { ResizeMode: unknown }).ResizeMode = resizable
      ? Windows.ResizeMode.CanResize
      : Windows.ResizeMode.NoResize;
  }

  public isResizable(): boolean {
    return this._isResizable;
  }

  public setAlwaysOnTop(flag: boolean): void {
    if (!this.browserWindow) return;
    (this.browserWindow as unknown as { Topmost: boolean }).Topmost = flag;
  }

  /** Center the window on the primary screen. */
  public center(): void {
    if (!this.browserWindow) return;
    const sp = (dotnet as any).System.Windows.SystemParameters;
    const win = this.browserWindow as unknown as {
      Left: number;
      Top: number;
      Width: number;
      Height: number;
    };
    win.Left = (sp.PrimaryScreenWidth - win.Width) / 2;
    win.Top = (sp.PrimaryScreenHeight - win.Height) / 2;
  }

  /** Flash (or stop flashing) the taskbar button to attract user attention. */
  public flashFrame(flag: boolean): void {
    if (!this.browserWindow) return;
    (dotnet as any).winHelper(this.browserWindow, 'FlashWindow', flag);
  }

  public setMinimizable(flag: boolean): void {
    this._isMinimizable = flag;
    if (!this.browserWindow) return;
    (dotnet as any).winHelper(this.browserWindow, 'SetMinimizable', flag);
  }

  public isMinimizable(): boolean {
    return this._isMinimizable;
  }

  public setMaximizable(flag: boolean): void {
    this._isMaximizable = flag;
    if (!this.browserWindow) return;
    (dotnet as any).winHelper(this.browserWindow, 'SetMaximizable', flag);
  }

  public isMaximizable(): boolean {
    return this._isMaximizable;
  }

  public setClosable(flag: boolean): void {
    this._isClosable = flag;
    if (!this.browserWindow) return;
    (dotnet as any).winHelper(this.browserWindow, 'SetClosable', flag);
  }

  public isClosable(): boolean {
    return this._isClosable;
  }

  public setMovable(flag: boolean): void {
    this._isMovable = flag;
    if (!this.browserWindow) return;
    (dotnet as any).winHelper(this.browserWindow, 'SetMovable', flag);
  }

  public isMovable(): boolean {
    return this._isMovable;
  }

  public setSkipTaskbar(flag: boolean): void {
    this._skipTaskbar = flag;
    if (!this.browserWindow) return;
    (dotnet as any).winHelper(this.browserWindow, 'SetSkipTaskbar', flag);
  }

  /** Returns the Win32 HWND as a decimal string (valid after show()). */
  public getHwnd(): string {
    if (!this.browserWindow) return '0';
    return (dotnet as any).getHwnd(this.browserWindow) as string;
  }

  /** Enable or disable user interaction (used to block a parent for modal children). */
  public setEnabled(flag: boolean): void {
    if (!this.browserWindow) return;
    (dotnet as any).setWindowEnabled(this.browserWindow, flag);
  }

  /** Captures the WebView2 rendering as a PNG and returns a NativeImage. */
  public async capturePage(): Promise<NativeImage> {
    if (!this.webView) return new NativeImage(Buffer.alloc(0));
    const base64 = (dotnet as any).capturePreview(this.webView) as string;
    if (!base64) return new NativeImage(Buffer.alloc(0));
    return new NativeImage(Buffer.from(base64, 'base64'));
  }

  /**
   * Applies P/Invoke window chrome options that require an HWND.
   * Called once from show() after Application.Run() has been called.
   */
  private _applyWindowChrome(): void {
    if (!this.browserWindow) return;
    if (!this._isMinimizable) (dotnet as any).winHelper(this.browserWindow, 'SetMinimizable', false);
    if (!this._isMaximizable) (dotnet as any).winHelper(this.browserWindow, 'SetMaximizable', false);
    if (!this._isClosable)   (dotnet as any).winHelper(this.browserWindow, 'SetClosable',    false);
    if (!this._isMovable)    (dotnet as any).winHelper(this.browserWindow, 'SetMovable',     false);
    if (this._skipTaskbar)   (dotnet as any).winHelper(this.browserWindow, 'SetSkipTaskbar', true);
  }

  public showOpenDialog(options: OpenDialogOptions): string[] | undefined {
    return showOpenDialog(options);
  }

  public showSaveDialog(options: SaveDialogOptions): string | undefined {
    return showSaveDialog(options);
  }

  public showMessageBox(options: {
    type?: string;
    title?: string;
    message: string;
    buttons?: string[];
  }): number {
    return showMessageBox(options);
  }
}
