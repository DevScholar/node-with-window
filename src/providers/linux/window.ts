import * as path from 'node:path';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
    IWindowProvider, BrowserWindowOptions, WebPreferences,
    OpenDialogOptions, SaveDialogOptions, MenuItemOptions,
} from '../../interfaces';
import { ipcMain } from '../../ipc-main';
import { injectBridgeScript } from './bridge.js';

/**
 * LinuxWindow — IWindowProvider implementation for Linux using GTK4 + WebKitGTK.
 *
 * Architecture overview
 * ─────────────────────
 * A dedicated GJS script (scripts/linux/host.js) is spawned as a child process.
 * It runs the GLib main loop and owns the GTK window + WebKit WebView.
 * Node.js communicates with it over two Unix FIFOs:
 *
 *   Node.js ──(fd3/reqFIFO)──► GJS host  (commands)
 *   GJS host ──(fd4/resFIFO)──► Node.js  (responses)
 *
 * Commands are synchronous JSON-line request/response pairs (like node-ps1-dotnet).
 *
 * WebKit IPC (ipcRenderer ↔ ipcMain)
 * ────────────────────────────────────
 * The HTML page posts messages via window.webkit.messageHandlers.ipc.postMessage().
 * The GJS host queues them. Node.js drains the queue with periodic 'Poll' commands
 * (POLL_INTERVAL_MS). On each poll result:
 *  - type 'ipc'  → parse the message, dispatch to ipcMain handlers, send reply back
 *                   to the WebView via a 'SendToRenderer' command.
 *  - type 'exit' → the window was closed; call process.exit(0).
 *  - type 'none' → nothing pending; keep polling.
 */

// ---------------------------------------------------------------------------
// IpcSync — minimal synchronous pipe IPC (same protocol as node-with-gjs)
// ---------------------------------------------------------------------------

class LinuxIpc {
    /** Leftover bytes from a previous chunked read. */
    private readBuf = Buffer.alloc(0);

    constructor(private fdRead: number, private fdWrite: number) {}

    /** Read one newline-terminated JSON line from the pipe (blocking). */
    private readLine(): string | null {
        const chunk = Buffer.alloc(4096);
        while (true) {
            const nl = this.readBuf.indexOf(10 /* \n */);
            if (nl !== -1) {
                const line = this.readBuf.slice(0, nl).toString('utf8');
                this.readBuf = this.readBuf.slice(nl + 1);
                return line;
            }
            let n: number;
            try { n = fs.readSync(this.fdRead, chunk, 0, chunk.length, null); }
            catch { return null; }
            if (n === 0) {
                if (this.readBuf.length > 0) {
                    const line = this.readBuf.toString('utf8');
                    this.readBuf = Buffer.alloc(0);
                    return line;
                }
                return null;
            }
            this.readBuf = Buffer.concat([this.readBuf, chunk.slice(0, n)]);
        }
    }

    send(cmd: unknown): unknown {
        try {
            fs.writeSync(this.fdWrite, JSON.stringify(cmd) + '\n');
        } catch {
            throw new Error('Linux IPC: pipe closed (write failed)');
        }
        // Skip blank lines (shouldn't occur) and wait for a real response
        while (true) {
            const line = this.readLine();
            if (line === null) throw new Error('Linux IPC: pipe closed (read EOF)');
            if (!line.trim()) continue;
            return JSON.parse(line);
        }
    }

    close() {
        try { fs.closeSync(this.fdRead); }  catch { /* ignore */ }
        try { fs.closeSync(this.fdWrite); } catch { /* ignore */ }
    }
}

// ---------------------------------------------------------------------------
// LinuxWindow
// ---------------------------------------------------------------------------

/** How often (ms) Node.js polls the GJS host for queued WebKit IPC messages. */
const POLL_INTERVAL_MS = 16;

function findGjsPath(): string {
    try {
        return cp.execSync('which gjs', { encoding: 'utf-8' }).trim() || 'gjs';
    } catch {
        return 'gjs';
    }
}

/**
 * Locate scripts/linux/host.js by walking up the directory tree from
 * `import.meta.url`.
 *
 * Why not a fixed relative path?
 * When esbuild bundles node-with-window into the user's app, import.meta.url
 * points to the *bundle* file (e.g. dist/notepad/notepad.js), not to
 * dist/providers/linux/window.js.  A fixed "../../.." would resolve to the
 * wrong directory.  Walking up and checking both the package-root pattern
 * ("scripts/linux/host.js") and the node_modules installation pattern
 * ("node_modules/@devscholar/node-with-window/scripts/linux/host.js")
 * handles both the bundled case and the unbundled/development case.
 */
function findHostScript(): string {
    const startDir = path.dirname(fileURLToPath(import.meta.url));
    let dir = startDir;

    for (let i = 0; i < 12; i++) {
        const candidates = [
            // Package root (unbundled: dist/providers/linux/ → ../../.. → root)
            path.join(dir, 'scripts', 'linux', 'host.js'),
            // npm install / file: link (bundled: walk up to node_modules)
            path.join(dir, 'node_modules', '@devscholar', 'node-with-window', 'scripts', 'linux', 'host.js'),
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) return p;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break; // filesystem root
        dir = parent;
    }

    throw new Error(
        `[node-with-window] Cannot locate scripts/linux/host.js.\n` +
        `Searched upward from: ${startDir}\n` +
        `Run \`npm run build\` inside node-with-window and ensure the package is properly installed.`
    );
}

export class LinuxWindow implements IWindowProvider {
    public options: BrowserWindowOptions;
    public webPreferences: WebPreferences;

    private ipc: LinuxIpc | null = null;
    private proc: cp.ChildProcess | null = null;
    private reqPath = '';
    private resPath = '';

    /** Pending menu set before show() is called. */
    private pendingMenu: MenuItemOptions[] | null = null;

    /** Map from menu-action index (assigned at SetMenu time) to click handler. */
    private menuClickHandlers: Map<number, () => void> = new Map();

    /** Pending loadURL/loadFile call before show() is called. */
    private pendingLoad: { kind: 'url'; url: string } | { kind: 'html'; html: string; baseUri: string } | null = null;

    private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    private isClosed = false;

    constructor(options?: BrowserWindowOptions) {
        this.options        = options || {};
        this.webPreferences = this.options.webPreferences || {};
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    public async createWindow(): Promise<void> {
        const token = `${process.pid}-${Date.now()}`;
        this.reqPath = path.join(os.tmpdir(), `nww-req-${token}.pipe`);
        this.resPath = path.join(os.tmpdir(), `nww-res-${token}.pipe`);

        cp.execSync(`mkfifo "${this.reqPath}"`);
        cp.execSync(`mkfifo "${this.resPath}"`);

        const hostScript = findHostScript();

        const gjsPath = findGjsPath();
        // Open the FIFOs BEFORE spawning GJS so that the open() calls don't block forever.
        // We open the write end first (Node→GJS) and then the read end (GJS→Node).
        // GJS opens them in the opposite order on its side, so both sides unblock together.
        const spawnEnv = { ...process.env, WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: '1' };
        this.proc = cp.spawn(
            'bash',
            ['-c', `exec "${gjsPath}" -m "${hostScript}" 3<"${this.reqPath}" 4>"${this.resPath}"`],
            { stdio: 'inherit', env: spawnEnv },
        );
        this.proc.unref();

        const fdWrite = fs.openSync(this.reqPath, 'w');
        const fdRead  = fs.openSync(this.resPath, 'r');
        this.ipc      = new LinuxIpc(fdRead, fdWrite);

        // Register cleanup handlers
        process.once('beforeExit', () => this._cleanup());
        process.once('exit',       () => this._cleanup());
        process.once('SIGINT',     () => { this._cleanup(); process.exit(0); });

        // Tell GJS to create the window (but not show it yet)
        this._send('CreateWindow', { options: this.options });
    }

    public show(): void {
        if (!this.ipc) return;

        // Apply pending menu before showing
        if (this.pendingMenu) {
            this._applyMenu(this.pendingMenu);
            this.pendingMenu = null;
        }

        // Apply pending navigation
        if (this.pendingLoad) {
            if (this.pendingLoad.kind === 'url') {
                this._send('LoadURL', { url: this.pendingLoad.url });
            } else {
                this._send('LoadHTML', { html: this.pendingLoad.html, baseUri: this.pendingLoad.baseUri });
            }
            this.pendingLoad = null;
        }

        this._send('Show', {});

        // Start polling for WebKit IPC messages and window-closed events
        this.keepAliveTimer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
    }

    public close(): void {
        if (this.isClosed) return;
        this.isClosed = true;
        if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; }
        try { this._send('Close', {}); } catch { /* pipe may already be closed */ }
        this._cleanup();
    }

    // -------------------------------------------------------------------------
    // Navigation
    // -------------------------------------------------------------------------

    public async loadURL(url: string): Promise<void> {
        if (!this.ipc) {
            this.pendingLoad = { kind: 'url', url };
            return;
        }
        this._send('LoadURL', { url });
    }

    public async loadFile(filePath: string): Promise<void> {
        const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
        const rawHtml = fs.readFileSync(absPath, 'utf-8');
        const html    = injectBridgeScript(rawHtml, this.webPreferences);
        const baseUri = `file://${absPath}`;

        if (!this.ipc) {
            this.pendingLoad = { kind: 'html', html, baseUri };
            return;
        }
        this._send('LoadHTML', { html, baseUri });
    }

    // -------------------------------------------------------------------------
    // Menu
    // -------------------------------------------------------------------------

    public setMenu(menu: MenuItemOptions[]): void {
        if (!this.ipc) {
            this.pendingMenu = menu;
            return;
        }
        this._applyMenu(menu);
    }

    /** Flatten the menu tree, assign numeric IDs to clickable items, store handlers. */
    private _applyMenu(menu: MenuItemOptions[]): void {
        this.menuClickHandlers.clear();
        let idx = 0;

        const flatten = (items: MenuItemOptions[]): unknown[] => {
            return items.map(item => {
                if (item.type === 'separator') return { type: 'separator' };
                if (item.submenu) {
                    return {
                        label:   item.label,
                        enabled: item.enabled,
                        submenu: flatten(item.submenu),
                    };
                }
                const id = idx++;
                if (item.click) this.menuClickHandlers.set(id, item.click);
                return { label: item.label, enabled: item.enabled, id };
            });
        };

        this._send('SetMenu', { menu: flatten(menu) });
    }

    // -------------------------------------------------------------------------
    // IPC: Node.js → Renderer
    // -------------------------------------------------------------------------

    public sendToRenderer(channel: string, ...args: unknown[]): void {
        this.send(channel, ...args);
    }

    public send(channel: string, ...args: unknown[]): void {
        const payload = JSON.stringify({ type: 'message', channel, args });
        const script  = `window.__ipcDispatch(${JSON.stringify(payload)})`;
        try { this._send('SendToRenderer', { script }); } catch { /* ignore if closed */ }
    }

    // -------------------------------------------------------------------------
    // Dialogs
    // -------------------------------------------------------------------------

    public showOpenDialog(options: OpenDialogOptions): string[] | undefined {
        try {
            const res = this._send('ShowOpenDialog', { options }) as { value: string[] | null };
            return res.value ?? undefined;
        } catch {
            return undefined;
        }
    }

    public showSaveDialog(options: SaveDialogOptions): string | undefined {
        try {
            const res = this._send('ShowSaveDialog', { options }) as { value: string | null };
            return res.value ?? undefined;
        } catch {
            return undefined;
        }
    }

    public showMessageBox(options: { type?: string; title?: string; message: string; buttons?: string[] }): number {
        try {
            const res = this._send('ShowMessageBox', { options }) as { value: number };
            return res.value ?? 0;
        } catch {
            return 0;
        }
    }

    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------

    public reload(): void {
        try { this._send('Reload', {}); } catch { /* ignore */ }
    }

    public openDevTools(): void {
        try { this._send('OpenDevTools', {}); } catch { /* ignore */ }
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /** Send a command and return the response object. Throws on pipe error. */
    private _send(action: string, params: Record<string, unknown>): unknown {
        const resp = this.ipc!.send({ action, ...params }) as { type: string; value?: unknown; message?: unknown };

        if (resp.type === 'error') {
            console.error(`[LinuxWindow] GJS error for "${action}":`, resp.message);
        }
        return resp;
    }

    /**
     * Poll the GJS host for queued WebKit IPC messages.
     * Called on a POLL_INTERVAL_MS timer after show().
     */
    private _poll(): void {
        if (this.isClosed) return;
        let resp: { type: string; message?: string };
        try {
            resp = this._send('Poll', {}) as typeof resp;
        } catch {
            // Pipe closed — the GJS process exited (window was closed externally)
            this._onWindowClosed();
            return;
        }

        if (resp.type === 'exit') {
            this._onWindowClosed();
        } else if (resp.type === 'ipc' && resp.message) {
            this._handleIpcMessage(resp.message);
        }
    }

    /** Dispatch a WebKit IPC message to the registered ipcMain handler. */
    private _handleIpcMessage(rawJson: string): void {
        let data: { type: string; channel: string; id?: string; args?: unknown[] };
        try { data = JSON.parse(rawJson); }
        catch { console.error('[LinuxWindow] Invalid IPC JSON:', rawJson); return; }

        const { type, channel, id, args = [] } = data;

        // Menu click — handled locally without involving ipcMain
        if (type === 'menuClick') {
            const handler = this.menuClickHandlers.get((data as unknown as { id: number }).id);
            if (handler) handler();
            return;
        }

        const event = {
            sender:  this,
            frameId: 0,
            reply:   (ch: string, ...a: unknown[]) => this.send(ch, ...a),
        };

        if (type === 'send') {
            ipcMain.emit(channel, event, ...args);

        } else if (type === 'invoke') {
            const handlers = (ipcMain as unknown as { handlers: Map<string, (e: unknown, ...a: unknown[]) => unknown> }).handlers;
            const handler  = handlers.get(channel);

            if (!handler) {
                this._sendIpcReply(id!, null, `No handler for channel: ${channel}`);
                return;
            }

            try {
                const result = handler(event, ...args);
                // Support both sync and async handlers
                if (result && typeof (result as Promise<unknown>).then === 'function') {
                    (result as Promise<unknown>)
                        .then(r  => this._sendIpcReply(id!, r, null))
                        .catch(e => this._sendIpcReply(id!, null, (e as Error).message || String(e)));
                } else {
                    this._sendIpcReply(id!, result, null);
                }
            } catch (e: unknown) {
                this._sendIpcReply(id!, null, (e as Error).message || String(e));
            }
        }
    }

    /** Send an invoke() reply back to the HTML renderer. */
    private _sendIpcReply(id: string, result: unknown, error: string | null): void {
        const payload = JSON.stringify({ type: 'reply', id, result, error });
        const script  = `window.__ipcDispatch(${JSON.stringify(payload)})`;
        try { this._send('SendToRenderer', { script }); } catch { /* window may be closing */ }
    }

    /** Called when the GTK window has been closed. */
    private _onWindowClosed(): void {
        if (this.isClosed) return;
        this.isClosed = true;
        if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; }
        this._cleanup();
        process.exit(0);
    }

    private _cleanup(): void {
        if (this.ipc) { this.ipc.close(); this.ipc = null; }
        if (this.proc && !this.proc.killed) { try { this.proc.kill('SIGKILL'); } catch { /* ignore */ } }
        for (const p of [this.reqPath, this.resPath]) {
            if (p && fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
        }
    }
}
