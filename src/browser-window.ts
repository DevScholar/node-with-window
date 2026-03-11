import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { IWindowProvider, BrowserWindowOptions, MenuItemOptions, OpenDialogOptions, SaveDialogOptions } from './interfaces';
import { resolveBackend, ensureBackendInitialized } from './backends.js';
import { ipcMain } from './ipc-main.js';
import { app } from './app.js';
import { startSyncServer } from './node-integration.js';
import type { Menu } from './menu.js';

/** Registered once per process when the first nodeIntegration window is created. */
let _nodeIntegrationHandlerRegistered = false;

function registerNodeIntegrationHandler() {
    if (_nodeIntegrationHandlerRegistered) return;
    _nodeIntegrationHandlerRegistered = true;
    const _require = createRequire(import.meta.url);
    ipcMain.handle('__nww:require__', (_event, moduleName, methodName, args) => {
        console.log(`[requireAsync] ${moduleName}.${methodName}()`);
        const mod = _require(moduleName as string);
        const fn = (mod as Record<string, unknown>)[methodName as string];
        if (typeof fn !== 'function') {
            throw new Error(`${moduleName}.${methodName} is not a function`);
        }
        return (fn as (...a: unknown[]) => unknown).apply(mod, args as unknown[]);
    });
}

/**
 * BrowserWindow - Cross-platform window with WebView support
 *
 * - Windows (default): netfx-wpf  (WebView2 + WPF via .NET)
 * - Linux (default):   gjs-gtk4   (WebKitGTK + GTK4 via GJS)
 *
 * Use the static create() method instead of the constructor:
 *
 * ```javascript
 * const win = await BrowserWindow.create(options);
 * ```
 */
export class BrowserWindow extends EventEmitter {
    private provider: IWindowProvider;
    private _backendName: string;
    private _id: number;
    private static _allWindows: Map<number, BrowserWindow> = new Map();
    private static _lastId = 0;
    private _isCreated = false;
    private _createdPromise: Promise<void>;

    constructor(options?: BrowserWindowOptions) {
        super();

        BrowserWindow._lastId++;
        this._id = BrowserWindow._lastId;
        BrowserWindow._allWindows.set(this._id, this);

        const backend = resolveBackend(options?.backend);
        this._backendName = backend.name;
        this.provider = backend.createProvider(options);

        this._createdPromise = this._init();
    }

    private async _init(): Promise<void> {
        try {
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
     * Creates a new BrowserWindow instance asynchronously.
     *
     * ```javascript
     * await app.whenReady();
     * const win = await BrowserWindow.create({ width: 800, height: 600 });
     * win.loadFile('index.html');
     * win.show();
     * ```
     */
    public static async create(options?: BrowserWindowOptions): Promise<BrowserWindow> {
        if (options?.webPreferences?.nodeIntegration) {
            registerNodeIntegrationHandler();
            await startSyncServer();
        }
        const win = new BrowserWindow(options);
        await win._createdPromise;
        if (options?.show !== false) {
            // Defer show() to the next event-loop tick so the caller's synchronous
            // code (loadFile, setMenu, ipcMain.handle, …) runs first — just like
            // Electron's new BrowserWindow() which shows after construction but lets
            // you configure the window before the message loop processes events.
            setImmediate(() => win.show());
        }
        return win;
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

    public static getFocusedWindow(): BrowserWindow | undefined {
        return BrowserWindow.getAllWindows()[0];
    }

    public async loadURL(url: string): Promise<void> {
        if (!this._isCreated) {
            await this._createdPromise;
        }
        return this.provider.loadURL(url);
    }

    public async loadFile(filePath: string): Promise<void> {
        if (!this._isCreated) {
            await this._createdPromise;
        }
        return this.provider.loadFile(filePath);
    }

    public show(): void {
        if (!this._isCreated) {
            throw new Error('Cannot show window before it is created. Call await window.whenCreated() first.');
        }
        this.provider.show();
    }

    public close(): void {
        BrowserWindow._allWindows.delete(this._id);
        this.provider.close();
        this.emit('closed');
        if (BrowserWindow._allWindows.size === 0) {
            app.emit('window-all-closed');
        }
    }

    public setMenu(menu: MenuItemOptions[] | Menu): void {
        const items: MenuItemOptions[] = Array.isArray(menu)
            ? menu
            : (menu as Menu).items();
        this.provider.setMenu(items);
    }

    public removeMenu(): void {
        this.provider.setMenu([]);
    }

    public showOpenDialog(options: OpenDialogOptions): string[] | undefined {
        return this.provider.showOpenDialog(options);
    }

    public showSaveDialog(options: SaveDialogOptions): string | undefined {
        return this.provider.showSaveDialog(options);
    }

    public showMessageBox(options: { type?: string; title?: string; message: string; buttons?: string[] }): number {
        return this.provider.showMessageBox(options);
    }

    public send(channel: string, ...args: unknown[]): void {
        if (this.provider.sendToRenderer) {
            this.provider.sendToRenderer(channel, ...args);
        }
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

    /**
     * Reloads the current page in the WebView.
     */
    public reload(): void {
        if (this.provider.reload) {
            this.provider.reload();
        }
    }

    /**
     * Opens the developer tools window.
     */
    public openDevTools(): void {
        if (this.provider.openDevTools) {
            this.provider.openDevTools();
        }
    }
}
