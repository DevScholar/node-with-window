import { EventEmitter } from 'node:events';
import { IWindowProvider, BrowserWindowOptions, MenuItemOptions, OpenDialogOptions, SaveDialogOptions } from './interfaces';
import { resolveBackend, ensureBackendInitialized } from './backends.js';
import { ipcMain } from './ipc-main.js';
import { app } from './app.js';
import { startSyncServer } from './node-integration.js';
import type { Menu } from './menu.js';

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
            // Start the sync-require HTTP server before the backend so its port
            // is available when setupIpcBridge() injects the bridge script.
            if (options?.webPreferences?.nodeIntegration) {
                await startSyncServer();
            }
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

    public static getFocusedWindow(): BrowserWindow | undefined {
        return BrowserWindow.getAllWindows()[0];
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
            this._createdPromise.then(() => this.provider.show()).catch(() => {});
            return;
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

    public reload(): void {
        if (this.provider.reload) {
            this.provider.reload();
        }
    }

    public openDevTools(): void {
        if (this.provider.openDevTools) {
            this.provider.openDevTools();
        }
    }
}
