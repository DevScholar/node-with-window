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
}

/**
 * WebContents — Electron-compatible object exposed as `win.webContents`.
 *
 * Wraps the renderer-facing operations that Electron surfaces through the
 * `webContents` property of a `BrowserWindow`.
 */
export class WebContents extends EventEmitter {
    private readonly _delegate: WebContentsDelegate;

    constructor(delegate: WebContentsDelegate) {
        super();
        this._delegate = delegate;
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
}
