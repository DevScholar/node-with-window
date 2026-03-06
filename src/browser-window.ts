import { EventEmitter } from 'node:events';
import { IWindowProvider, BrowserWindowOptions, MenuItemOptions, OpenDialogOptions, SaveDialogOptions } from './interfaces';
import { WindowsWindow } from './providers/windows/index';
import { LinuxWindow } from './providers/linux/index';

/**
 * BrowserWindow - Cross-platform window with WebView support
 *
 * - Windows: WebView2 + WPF
 * - Linux: WebKitGTK + GTK4
 *
 * Use the static create() method instead of the constructor:
 *
 * ```javascript
 * const win = await BrowserWindow.create(options);
 * ```
 */
export class BrowserWindow extends EventEmitter {
    private provider: IWindowProvider;
    private _id: number;
    private static _allWindows: Map<number, BrowserWindow> = new Map();
    private static _lastId = 0;
    private _isCreated = false;
    private _createdPromise: Promise<void>;

    constructor(options?: BrowserWindowOptions) {
        super();
        const platform = process.platform;

        BrowserWindow._lastId++;
        this._id = BrowserWindow._lastId;
        BrowserWindow._allWindows.set(this._id, this);

        if (platform === 'win32') {
            this.provider = new WindowsWindow(options);
        } else if (platform === 'linux') {
            this.provider = new LinuxWindow(options);
        } else {
            BrowserWindow._allWindows.delete(this._id);
            throw new Error(`Platform ${platform} is not currently supported by node-with-window.`);
        }

        this._createdPromise = this._init();
    }

    private async _init(): Promise<void> {
        try {
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
        const win = new BrowserWindow(options);
        await win._createdPromise;
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
    }

    public setMenu(menu: MenuItemOptions[]): void {
        this.provider.setMenu(menu);
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
