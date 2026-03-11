import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { IWindowProvider, BrowserWindowOptions, WebPreferences, OpenDialogOptions, SaveDialogOptions, MenuItemOptions } from '../../interfaces';
import { ipcMain } from '../../ipc-main';
import { injectBridgeScript, generateBridgeScript } from './bridge.js';
import { showOpenDialog, showSaveDialog, showMessageBox } from './dialogs.js';
import { buildWpfMenu } from './menu.js';
import { getSyncServerPort } from '../../node-integration.js';

/**
 * This library bridges Node.js with platform-specific GUI frameworks.
 *
 * On Windows, we use WebView2 (Microsoft's Chromium-based webview) combined with
 * WPF (Windows Presentation Foundation) for the window frame. The actual .NET
 * interop is handled by the separate 'node-ps1-dotnet' package.
 *
 * Why this architecture?
 * - Node.js runs in a single-threaded event loop
 * - .NET/WPF also runs on its own thread and message loop
 * - We need to communicate between these two runtimes in a way that doesn't block either
 *
 * The node-ps1-dotnet package spawns a hidden PowerShell process that hosts .NET.
 * Communication happens through stdin/stdout JSON messages - this is why we can't use
 * async handlers in IPC (they would block the single-threaded bridge process).
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
        path.resolve(process.cwd(), 'node_modules', '@devscholar', 'node-with-window', 'runtimes', 'webview2'),
        path.resolve(process.cwd(), 'runtimes', 'webview2'),
        path.resolve(process.cwd(), '..', 'node-with-window', 'runtimes', 'webview2'),
        path.resolve(process.cwd(), '..', '..', 'node_modules', '@devscholar', 'node-with-window', 'runtimes', 'webview2'),
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
 * WindowsWindow implements the IWindowProvider interface for Windows using WPF + WebView2.
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
export class WindowsWindow implements IWindowProvider {
    public options: BrowserWindowOptions;
    public webPreferences: WebPreferences;
    public browserWindow: unknown;
    public webView: unknown;
    public coreWebView2: unknown;
    public app: unknown;
    public isWebViewReady = false;
    public navigationQueue: Array<() => void> = [];
    public pendingFilePath: string | null = null;
    private _pendingFileUri: string | null = null;
    public userDataPath: string;
    public pendingMenu: MenuItemOptions[] | null = null;
    private isClosed = false;
    private _pollTimer: ReturnType<typeof setInterval> | null = null;
    private _isFullScreen = false;
    private _isResizable = true;
    private _navCompletedCallback: (() => void) | null = null;
    private _pendingExecs = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

    constructor(options?: BrowserWindowOptions) {
        this.options = options || {};
        this.webPreferences = this.options.webPreferences || {};
        this._isResizable = this.options.resizable ?? true;

        const partition = this.webPreferences.partition;

        if (partition) {
            if (partition.startsWith('persist:')) {
                const partitionName = partition.substring(8);
                this.userDataPath = path.join(os.tmpdir(), 'node-with-window-webview2', 'persist', partitionName);
            } else if (partition.startsWith('temp:')) {
                this.userDataPath = path.join(os.tmpdir(), 'node-with-window-webview2', `temp-${Date.now()}-${Math.random()}`);
            } else {
                this.userDataPath = path.join(os.tmpdir(), 'node-with-window-webview2', 'persist', partition);
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

        const WebView2Type = (WebView2WpfAssembly as unknown as { GetType: (name: string) => { new (): unknown } }).GetType('Microsoft.Web.WebView2.Wpf.WebView2');
        this.webView = new WebView2Type();

        const CreationPropertiesType = (WebView2WpfAssembly as unknown as { GetType: (name: string) => { new (): unknown } }).GetType('Microsoft.Web.WebView2.Wpf.CoreWebView2CreationProperties');
        const props = new CreationPropertiesType() as unknown as { UserDataFolder: string };
        props.UserDataFolder = this.userDataPath;
        (this.webView as unknown as { CreationProperties: unknown }).CreationProperties = props;

        this.browserWindow = new Windows.Window();
        (this.browserWindow as unknown as { Title: string }).Title = this.options.title || 'node-with-window';
        (this.browserWindow as unknown as { Width: number }).Width = this.options.width || 800;
        (this.browserWindow as unknown as { Height: number }).Height = this.options.height || 600;
        (this.browserWindow as unknown as { WindowStartupLocation: unknown }).WindowStartupLocation = Windows.WindowStartupLocation.CenterScreen;

        if (this.options.icon) {
            try {
                const absIcon = path.isAbsolute(this.options.icon)
                    ? this.options.icon
                    : path.resolve(process.cwd(), this.options.icon);
                if (fs.existsSync(absIcon)) {
                    const fileUri = 'file:///' + absIcon.replace(/\\/g, '/');
                    const Imaging = Windows.Media.Imaging;
                    const bitmap = new Imaging.BitmapImage(new System.Uri(fileUri));
                    (this.browserWindow as unknown as { Icon: unknown }).Icon = bitmap;
                }
            } catch (_e) {
                // Icon loading is best-effort; ignore failures
            }
        }

        const grid = new Controls.Grid();
        (this.browserWindow as unknown as { Content: unknown }).Content = grid;
        (grid as unknown as { Children: { Add: (w: unknown) => void } }).Children.Add(this.webView);

        // Apply constructor options that map directly to WPF window properties.
        if (this.options.resizable === false) {
            (this.browserWindow as unknown as { ResizeMode: unknown }).ResizeMode = Windows.ResizeMode.NoResize;
        }
        if (this.options.minWidth)  (this.browserWindow as unknown as { MinWidth:  number }).MinWidth  = this.options.minWidth;
        if (this.options.minHeight) (this.browserWindow as unknown as { MinHeight: number }).MinHeight = this.options.minHeight;
        if (this.options.maxWidth)  (this.browserWindow as unknown as { MaxWidth:  number }).MaxWidth  = this.options.maxWidth;
        if (this.options.maxHeight) (this.browserWindow as unknown as { MaxHeight: number }).MaxHeight = this.options.maxHeight;
        if (this.options.alwaysOnTop) {
            (this.browserWindow as unknown as { Topmost: boolean }).Topmost = true;
        }
        if (this.options.x !== undefined && this.options.y !== undefined) {
            (this.browserWindow as unknown as { WindowStartupLocation: unknown }).WindowStartupLocation = Windows.WindowStartupLocation.Manual;
            (this.browserWindow as unknown as { Left: number }).Left = this.options.x;
            (this.browserWindow as unknown as { Top: number  }).Top  = this.options.y;
        }

        (this.webView as unknown as { add_CoreWebView2InitializationCompleted: (cb: (s: unknown, e: unknown) => void) => void }).add_CoreWebView2InitializationCompleted((sender, e) => {
            const evt = e as unknown as { IsSuccess: boolean; InitializationException?: { Message?: string } };
            if (evt.IsSuccess) {
                this.coreWebView2 = (this.webView as unknown as { CoreWebView2: unknown }).CoreWebView2;
                this.setupIpcBridge();
                this.isWebViewReady = true;

                while (this.navigationQueue.length > 0) {
                    const action = this.navigationQueue.shift();
                    if (action) action();
                }
            }
        });
    }

    /**
     * Sets up the IPC bridge and document title sync.
     * Both sync and async ipcMain.handle() callbacks are supported.
     */
    private setupIpcBridge(): void {
        const handlers = (ipcMain as unknown as { handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> }).handlers;

        // Register the bridge script and navigate in one atomic C# operation.
        // AddScriptToExecuteOnDocumentCreatedAsync returns a Task<string> that completes
        // only after the WebView2 browser process confirms the script registration.
        // In polling mode we cannot Task.Wait() on the UI thread (deadlock), so the
        // dedicated AddScriptAndNavigate action uses Task.ContinueWith to call Navigate()
        // only after the ack arrives — guaranteeing the script runs on the first document.
        const bridgeScript = generateBridgeScript(this.webPreferences, getSyncServerPort());
        // _pendingFileUri is set when loadFile() was called before show().
        // pendingFilePath is set when loadFile() was called after show() but before
        // CoreWebView2 was ready (e.g. async user code between create() and loadFile()).
        if (!this._pendingFileUri && this.pendingFilePath) {
            this._pendingFileUri = 'file:///' + this.pendingFilePath.replace(/\\/g, '/');
            this.pendingFilePath = null;
        }
        if (this._pendingFileUri) {
            (dotnet as any).addScriptAndNavigate(this.coreWebView2, bridgeScript, this._pendingFileUri);
            this._pendingFileUri = null;
        } else {
            (this.coreWebView2 as unknown as { AddScriptToExecuteOnDocumentCreatedAsync: (s: string) => unknown })
                .AddScriptToExecuteOnDocumentCreatedAsync(bridgeScript);
        }

        // Automatically sync document.title changes to the WPF window title bar
        (this.coreWebView2 as unknown as { add_DocumentTitleChanged: (cb: (_sender: unknown, _e: unknown) => void) => void }).add_DocumentTitleChanged((_sender, _e) => {
            const title = (this.coreWebView2 as unknown as { DocumentTitle: string }).DocumentTitle;
            if (title) {
                (this.browserWindow as unknown as { Title: string }).Title = title;
            }
        });

        (this.coreWebView2 as unknown as { add_WebMessageReceived: (cb: (_sender: unknown, e: unknown) => void) => void }).add_WebMessageReceived((_sender, e) => {
            try {
                const evt = e as unknown as { WebMessageAsJson: string };
                const message = JSON.parse(evt.WebMessageAsJson);
                const { channel, type, id, args = [] } = message;

                const event = {
                    sender: this,
                    reply: (ch: string, ...a: unknown[]) => this.send(ch, ...a)
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
                                    .then(r  => this.sendIpcReply(id, r, null))
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
            (this.coreWebView2 as unknown as { add_NavigationCompleted: (cb: (_s: unknown, _e: unknown) => void) => void })
                .add_NavigationCompleted((_s, _e) => { this._navCompletedCallback?.(); });
        }
    }

    public onNavigationCompleted(callback: () => void): void {
        this._navCompletedCallback = callback;
    }

    public executeJavaScript(code: string): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (!this.coreWebView2) { reject(new Error('WebView2 not ready')); return; }
            const id = Math.random().toString(36).substring(2, 11);
            this._pendingExecs.set(id, { resolve, reject });
            const payload = JSON.stringify({ type: 'exec', id, code });
            (this.coreWebView2 as unknown as { PostWebMessageAsString: (s: string) => void }).PostWebMessageAsString(payload);
        });
    }

    public sendIpcReply(id: string, result: unknown, error: string | null): void {
        const payload = JSON.stringify({ type: 'reply', id, result, error });
        (this.coreWebView2 as unknown as { PostWebMessageAsString: (msg: string) => void }).PostWebMessageAsString(payload);
    }

    public send(channel: string, ...args: unknown[]): void {
        if (!this.coreWebView2) return;
        const payload = JSON.stringify({ type: 'message', channel, args });
        (this.coreWebView2 as unknown as { PostWebMessageAsString: (msg: string) => void }).PostWebMessageAsString(payload);
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
        const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
        if (!this.isWebViewReady) {
            // Queue whether show() hasn't been called yet OR has been called but
            // CoreWebView2 isn't ready yet; setupIpcBridge() will pick this up.
            this.pendingFilePath = absolutePath;
            return;
        }
        const fileUri = 'file:///' + absolutePath.replace(/\\/g, '/');
        (this.coreWebView2 as unknown as { Navigate: (url: string) => void }).Navigate(fileUri);
    }

    public show(): void {
        if (this.app) {
            (this.browserWindow as unknown as { Show: () => void }).Show();
            return;
        }

        const dotnetAny = dotnet as any;
        const System = dotnetAny.System;
        const Windows = System.Windows;

        if (this.pendingMenu) {
            buildWpfMenu({ browserWindow: this.browserWindow, webView: this.webView, pendingMenu: this.pendingMenu });
        }

        if (this.pendingFilePath) {
            // Store for setupIpcBridge to navigate AFTER script registration
            this._pendingFileUri = 'file:///' + this.pendingFilePath.replace(/\\/g, '/');
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

        // Poll for queued .NET events (WebMessageReceived, CoreWebView2InitializationCompleted, …)
        // exactly like the Linux backend polls its GJS host.
        this._pollTimer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
    }

    public close(): void {
        if (this.isClosed) return;
        this.isClosed = true;
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
        if (this.browserWindow) {
            try { (this.browserWindow as unknown as { Close: () => void }).Close(); } catch { /* ignore */ }
        }
        this.cleanupUserData();
        process.exit(0);
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /** Called when the WPF window has been closed (via poll or direct close()). */
    private _onWindowClosed(): void {
        if (this.isClosed) return;
        this.isClosed = true;
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
        this.cleanupUserData();
        process.exit(0);
    }

    /** Poll the .NET host for one queued event and dispatch it. */
    private _poll(): void {
        if (this.isClosed) return;
        let resp: { type: string; message?: string };
        try {
            resp = (dotnet as any).pollEvent() as typeof resp;
        } catch {
            // Pipe closed — .NET process exited unexpectedly
            this._onWindowClosed();
            return;
        }
        if (resp.type === 'ipc' && resp.message) {
            try {
                const result = (dotnet as any).dispatchEvent(resp.message);
                // If the callback is async, silently swallow the promise (errors logged inside)
                if (result && typeof (result as Promise<unknown>).then === 'function') {
                    (result as Promise<unknown>).catch((e: unknown) =>
                        console.error('[node-with-window] async event handler error:', e));
                }
            } catch (e) {
                console.error('[node-with-window] event dispatch error:', e);
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
            buildWpfMenu({ browserWindow: this.browserWindow, webView: this.webView, pendingMenu: menu });
        } else {
            this.pendingMenu = menu;
        }
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
    public destroy(): void { this.close(); }

    /** Bring window to the foreground and give it input focus. */
    public focus(): void {
        if (!this.browserWindow) return;
        (this.browserWindow as unknown as { Activate: () => void }).Activate();
    }

    /** Remove input focus (no direct WPF equivalent — no-op). */
    public blur(): void { /* WPF has no direct blur API */ }

    public minimize(): void {
        if (!this.browserWindow) return;
        (this.browserWindow as unknown as { WindowState: unknown }).WindowState =
            (dotnet as any).System.Windows.WindowState.Minimized;
    }

    public maximize(): void {
        if (!this.browserWindow) return;
        (this.browserWindow as unknown as { WindowState: unknown }).WindowState =
            (dotnet as any).System.Windows.WindowState.Maximized;
    }

    public unmaximize(): void {
        if (!this.browserWindow) return;
        (this.browserWindow as unknown as { WindowState: unknown }).WindowState =
            (dotnet as any).System.Windows.WindowState.Normal;
    }

    public setFullScreen(flag: boolean): void {
        if (!this.browserWindow) return;
        this._isFullScreen = flag;
        const Windows = (dotnet as any).System.Windows;
        const win = this.browserWindow as unknown as { WindowStyle: unknown; WindowState: unknown; Topmost: boolean };
        if (flag) {
            win.WindowStyle = Windows.WindowStyle.None;
            win.WindowState = Windows.WindowState.Maximized;
            win.Topmost = true;
        } else {
            win.WindowStyle = Windows.WindowStyle.SingleBorderWindow;
            win.WindowState = Windows.WindowState.Normal;
            win.Topmost = false;
        }
    }

    public isFullScreen(): boolean { return this._isFullScreen; }

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
        (this.browserWindow as unknown as { ResizeMode: unknown }).ResizeMode =
            resizable ? Windows.ResizeMode.CanResize : Windows.ResizeMode.NoResize;
    }

    public isResizable(): boolean { return this._isResizable; }

    public setAlwaysOnTop(flag: boolean): void {
        if (!this.browserWindow) return;
        (this.browserWindow as unknown as { Topmost: boolean }).Topmost = flag;
    }

    /** Center the window on the primary screen. */
    public center(): void {
        if (!this.browserWindow) return;
        const sp = (dotnet as any).System.Windows.SystemParameters;
        const win = this.browserWindow as unknown as { Left: number; Top: number; Width: number; Height: number };
        win.Left = (sp.PrimaryScreenWidth  - win.Width)  / 2;
        win.Top  = (sp.PrimaryScreenHeight - win.Height) / 2;
    }

    /** Flash the taskbar button to attract user attention (no-op — requires P/Invoke). */
    public flashFrame(_flag: boolean): void { /* P/Invoke not implemented */ }

    public showOpenDialog(options: OpenDialogOptions): string[] | undefined {
        return showOpenDialog(options);
    }

    public showSaveDialog(options: SaveDialogOptions): string | undefined {
        return showSaveDialog(options);
    }

    public showMessageBox(options: { type?: string; title?: string; message: string; buttons?: string[] }): number {
        return showMessageBox(options);
    }
}
