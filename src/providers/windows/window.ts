import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { IWindowProvider, BrowserWindowOptions, WebPreferences, OpenDialogOptions, SaveDialogOptions, MenuItemOptions } from '../../interfaces';
import { ipcMain } from '../../ipc-main';
import { injectBridgeScript } from './bridge.js';
import { showOpenDialog, showSaveDialog, showMessageBox } from './dialogs.js';
import { buildWpfMenu } from './menu.js';

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
    // __dirname of this compiled file is dist/providers/windows/
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
 * 3. SYNCHRONOUS IPC ONLY:
 *    node-ps1-dotnet blocks Node's event loop with fs.readSync(). Async
 *    IPC handlers cannot resolve while the window is open — use sync handlers.
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
    public tempHtmlFile: string | null = null;
    public userDataPath: string;
    public pendingMenu: MenuItemOptions[] | null = null;
    private isCleanedUp = false;

    constructor(options?: BrowserWindowOptions) {
        this.options = options || {};
        this.webPreferences = this.options.webPreferences || {};

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
     *
     * IMPORTANT: Async IPC handlers are NOT supported on Windows.
     * node-ps1-dotnet blocks Node's event loop with fs.readSync() while the
     * window is open, so Promise microtasks can never run. Always use
     * synchronous handlers with ipcMain.handle().
     */
    private setupIpcBridge(): void {
        const handlers = (ipcMain as unknown as { handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> }).handlers;

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

                if (type === 'send') {
                    ipcMain.emit(channel, event, ...args);
                } else if (type === 'invoke') {
                    const handler = handlers.get(channel);
                    if (handler) {
                        try {
                            const result = handler(event, ...args);

                            if (result && typeof (result as unknown as { then: unknown }).then === 'function') {
                                console.warn(`[node-with-window] Handler for "${channel}" returned a Promise. Async handlers are not supported — use synchronous handlers only.`);
                                this.sendIpcReply(id, null, `Channel "${channel}": async handlers are not supported.`);
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
        if (!this.app) {
            this.pendingFilePath = absolutePath;
            return;
        }
        const html = fs.readFileSync(absolutePath, 'utf-8');
        const injectedHtml = injectBridgeScript(html, this.webPreferences);
        (this.coreWebView2 as unknown as { NavigateToString: (s: string) => void }).NavigateToString(injectedHtml);
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

        let initialUri: string;

        if (this.pendingFilePath) {
            const rawHtml = fs.readFileSync(this.pendingFilePath, 'utf-8');
            const injectedHtml = injectBridgeScript(rawHtml, this.webPreferences);

            this.tempHtmlFile = path.join(os.tmpdir(), `node-with-window-${Date.now()}.html`);
            fs.writeFileSync(this.tempHtmlFile, injectedHtml, 'utf-8');
            initialUri = this.tempHtmlFile;
            this.pendingFilePath = null;
        } else {
            initialUri = 'about:blank';
        }

        (this.webView as unknown as { Source: unknown }).Source = new System.Uri(initialUri);
        this.app = new Windows.Application();

        const keepAlive = setInterval(() => {}, 1000);

        (this.browserWindow as unknown as { add_Closed: (cb: () => void) => void }).add_Closed(() => {
            clearInterval(keepAlive);
            if (this.tempHtmlFile) {
                try { fs.unlinkSync(this.tempHtmlFile); } catch {}
            }
            this.cleanupUserData();
            process.exit(0);
        });

        setImmediate(() => (this.app as unknown as { Run: (w: unknown) => void }).Run(this.browserWindow));
    }

    public close(): void {
        if (this.isCleanedUp) return;
        this.isCleanedUp = true;

        if (this.browserWindow) {
            (this.browserWindow as unknown as { Close: () => void }).Close();
        }

        if (this.tempHtmlFile) {
            try { fs.unlinkSync(this.tempHtmlFile); } catch {}
            this.tempHtmlFile = null;
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
        this.pendingMenu = menu;
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
