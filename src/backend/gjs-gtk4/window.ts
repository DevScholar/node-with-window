import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { init, imports, startEventDrain } from '@devscholar/node-with-gjs';
import {
  IWindowProvider,
  BrowserWindowOptions,
  WebPreferences,
  OpenDialogOptions,
  SaveDialogOptions,
  MenuItemOptions,
} from '../../interfaces.js';
import { ipcMain } from '../../ipc-main.js';
import { NativeImage } from '../../native-image.js';
import { injectBridgeScript, generateBridgeScript } from './bridge.js';
import { getSyncServerPort } from '../../node-integration.js';
import { GjsMenuManager } from './menu.js';
import { showOpenDialog, showSaveDialog, showMessageBox } from './dialogs.js';

/**
 * GjsGtk4Window — IWindowProvider implementation for Linux using GTK4 + WebKitGTK.
 *
 * Architecture
 * ────────────
 * Uses @devscholar/node-with-gjs as the bridge to GJS.  All GTK/WebKit objects
 * are proxy objects; method calls become synchronous JSON-line IPC to a single
 * shared GJS host process.  This mirrors how the Windows backend uses
 * @devscholar/node-ps1-dotnet to drive WPF.
 *
 * There is NO separate GJS process per window.  All BrowserWindow instances
 * share one GJS host (managed by node-with-gjs), each creating its own
 * Gtk.Window + WebKit.WebView inside that process.
 *
 * Event loop
 * ──────────
 * node-with-gjs's host.js runs a GLib.MainLoop, so GTK events are always
 * being processed.  startEventDrain() is called once (on first show()) so that
 * GJS signal callbacks (WebKit IPC, window-close, load-changed, …) are
 * delivered to Node.js every ~16 ms via the IpcWorker.
 */

// ---------------------------------------------------------------------------
// Module-level shared state
// ---------------------------------------------------------------------------

let _gjsReady = false;
// GI namespace proxies — initialised once, reused by all windows and sub-modules.
let Gtk: any, WebKit: any, Gio: any, Gdk: any, GLib: any;
// Cached enum / constant values to avoid repeated IPC calls.
let _GTK_VERTICAL: any;
let _WEBKIT_LOAD_FINISHED: any;
let _INJECT_FRAMES_ALL: any;
let _INJECT_TIME_START: any;

function ensureGjs(): void {
    if (_gjsReady) return;
    _gjsReady = true;

    init();
    imports.gi.versions.Gtk     = '4.0';
    imports.gi.versions.WebKit  = '6.0';
    imports.gi.versions.Gdk     = '4.0';
    Gtk    = imports.gi.Gtk;
    WebKit = imports.gi.WebKit;
    Gio    = imports.gi.Gio;
    Gdk    = imports.gi.Gdk;
    GLib   = imports.gi.GLib;

    Gtk.init();

    // Cache enum values (each access is an IPC round-trip; read once).
    _GTK_VERTICAL         = Gtk.Orientation.VERTICAL;
    _WEBKIT_LOAD_FINISHED = WebKit.LoadEvent.FINISHED;
    _INJECT_FRAMES_ALL    = WebKit.UserContentInjectedFrames.ALL_FRAMES;
    _INJECT_TIME_START    = WebKit.UserScriptInjectionTime.START;
}

/** startEventDrain() called at most once across all window instances. */
let _drainStarted = false;
function ensureDrain(): void {
    if (_drainStarted) return;
    _drainStarted = true;
    startEventDrain();
}

// Returns true when running inside a VMware virtual machine.
function isVMware(): boolean {
    try {
        return fs.readFileSync('/sys/class/dmi/id/sys_vendor', 'utf-8')
                  .trim().toLowerCase().includes('vmware');
    } catch { return false; }
}

// ---------------------------------------------------------------------------
// parseHexColor — #RGB / #RRGGBB / #AARRGGBB → { r, g, b, a }
// ---------------------------------------------------------------------------

function parseHexColor(str: string): { r: number; g: number; b: number; a: number } | null {
    if (!str || str[0] !== '#') return null;
    const s = str.slice(1);
    if (s.length === 3)
        return { a: 255, r: parseInt(s[0]+s[0],16), g: parseInt(s[1]+s[1],16), b: parseInt(s[2]+s[2],16) };
    if (s.length === 6)
        return { a: 255, r: parseInt(s.slice(0,2),16), g: parseInt(s.slice(2,4),16), b: parseInt(s.slice(4,6),16) };
    if (s.length === 8)
        return { a: parseInt(s.slice(0,2),16), r: parseInt(s.slice(2,4),16), g: parseInt(s.slice(4,6),16), b: parseInt(s.slice(6,8),16) };
    return null;
}

// ---------------------------------------------------------------------------
// GjsGtk4Window
// ---------------------------------------------------------------------------

export class GjsGtk4Window implements IWindowProvider {
    public options: BrowserWindowOptions;
    public webPreferences: WebPreferences;
    public onClosed?: () => void;

    // GTK proxy objects
    private gtkWindow: any  = null;
    private webView: any    = null;
    private cm: any         = null;  // WebKit.UserContentManager
    private windowBox: any  = null;  // current Gtk.Box child of gtkWindow

    private menu: GjsMenuManager | null = null;
    private pendingMenu: MenuItemOptions[] | null = null;
    private pendingLoad:
        | { kind: 'url'; url: string }
        | { kind: 'html'; html: string; baseUri: string }
        | null = null;

    private isClosed         = false;
    private _isFullScreen    = false;
    private _isKiosk         = false;
    private _isResizable     = true;
    private _isMinimizable   = true;
    private _isMaximizable   = true;
    private _isClosable      = true;
    private _isMovable       = true;
    private _alwaysOnTopPending = false;
    private _iconPath: string | null = null;

    private _navCompletedCallback: (() => void) | null = null;
    private _pendingExecs = new Map<string, {
        resolve: (v: unknown) => void;
        reject:  (e: Error)   => void;
    }>();

    constructor(options?: BrowserWindowOptions) {
        this.options        = options || {};
        this.webPreferences = this.options.webPreferences || {};
        this._isResizable   = this.options.resizable   ?? true;
        this._isMinimizable = this.options.minimizable ?? true;
        this._isMaximizable = this.options.maximizable ?? true;
        this._isClosable    = this.options.closable    ?? true;
        this._isMovable     = this.options.movable     ?? true;
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    public async createWindow(): Promise<void> {
        ensureGjs();
        if (isVMware()) process.env.WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS = '1';

        const opts = this.options;

        // WebKit content manager + IPC message handler
        this.cm = new WebKit.UserContentManager();
        this.cm.register_script_message_handler('ipc', null);
        this.cm.connect('script-message-received', (_mgr: any, value: any) => {
            const msg: string = value.to_string();
            if (msg) this._handleIpcMessage(msg);
        });

        // WebView
        this.webView = new WebKit.WebView({
            vexpand: true,
            hexpand: true,
            user_content_manager: this.cm,
        });
        const settings = this.webView.get_settings();
        settings.enable_developer_extras = true;
        if (opts.webPreferences?.webSecurity === false) {
            settings.allow_file_access_from_file_urls             = true;
            settings.allow_universal_access_from_file_urls        = true;
        }

        // GTK window
        this.gtkWindow = new Gtk.Window({
            title:          opts.title          || 'node-with-window',
            default_width:  opts.width          || 800,
            default_height: opts.height         || 600,
        });

        // Signals
        this.gtkWindow.connect('close-request', () => {
            this._onWindowClosed();
            return false;
        });
        this.webView.connect('notify::title', () => {
            const t: string = this.webView.title;
            if (t && this.gtkWindow) this.gtkWindow.set_title(t);
        });
        this.webView.connect('load-changed', (_wv: any, loadEvent: any) => {
            if (loadEvent === _WEBKIT_LOAD_FINISHED)
                this._handleIpcMessage(JSON.stringify({ type: 'navigationCompleted' }));
        });

        // Apply window options
        if (opts.resizable === false)   this.gtkWindow.set_resizable(false);
        if (opts.kiosk) {
            this.gtkWindow.fullscreen();
            this.gtkWindow.set_resizable(false);
            this._isFullScreen = true;
        } else if (opts.fullscreen) {
            this.gtkWindow.fullscreen();
            this._isFullScreen = true;
        }
        if (opts.alwaysOnTop) {
            try { this.gtkWindow.set_keep_above(true); }
            catch { this._alwaysOnTopPending = true; }
        }
        if (opts.icon) {
            this._iconPath = path.isAbsolute(opts.icon)
                ? opts.icon
                : path.resolve(process.cwd(), opts.icon);
        }
        if ((opts.minWidth ?? 0) > 0 || (opts.minHeight ?? 0) > 0) {
            this.gtkWindow.set_size_request(
                (opts.minWidth  ?? 0) > 0 ? opts.minWidth!  : -1,
                (opts.minHeight ?? 0) > 0 ? opts.minHeight! : -1
            );
        }
        if (opts.frame === false || opts.transparent === true)
            this.gtkWindow.set_decorated(false);
        if (opts.frame !== false && !opts.transparent &&
                (opts.titleBarStyle === 'hidden' || opts.titleBarStyle === 'hiddenInset')) {
            const emptyBar = new Gtk.Box({ height_request: 0 });
            this.gtkWindow.set_titlebar(emptyBar);
        }
        if (opts.transparent === true) {
            const css = new Gtk.CssProvider();
            css.load_from_string('.nww-transparent { background-color: transparent; box-shadow: none; }');
            Gtk.StyleContext.add_provider_for_display(
                Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_USER);
            this.gtkWindow.add_css_class('nww-transparent');
            try {
                const c = new Gdk.RGBA();
                c.red = c.green = c.blue = c.alpha = 0;
                this.webView.set_background_color(c);
            } catch { /* not all WebKitGTK versions support this */ }
        } else if (opts.backgroundColor) {
            this._applyBackgroundColor(opts.backgroundColor);
        }

        // Window layout: single box containing the webView (menu added later)
        this.windowBox = new Gtk.Box({ orientation: _GTK_VERTICAL, spacing: 0 });
        this.windowBox.append(this.webView);
        this.gtkWindow.set_child(this.windowBox);

        // Menu manager
        this.menu = new GjsMenuManager(
            this,
            this.gtkWindow,
            this.webView,
            () => this.windowBox,
            (b: any) => { this.windowBox = b; },
        );

        // Bridge + optional preload script
        let userScript = generateBridgeScript(this.webPreferences, getSyncServerPort());
        const preloadPath = this.webPreferences.preload;
        if (preloadPath) {
            const abs = path.isAbsolute(preloadPath)
                ? preloadPath
                : path.resolve(process.cwd(), preloadPath);
            try {
                userScript += '\n' + fs.readFileSync(abs, 'utf-8');
                if (this.webPreferences.contextIsolation === true)
                    userScript += '\n(function(){window.ipcRenderer=undefined;window.contextBridge=undefined;})();';
            } catch (e) {
                console.error('[node-with-window] Failed to load preload script:', e);
            }
        }
        const gjsUserScript = new WebKit.UserScript(
            userScript,
            _INJECT_FRAMES_ALL,
            _INJECT_TIME_START,
            null, null
        );
        this.cm.add_script(gjsUserScript);
    }

    public show(): void {
        if (!this.gtkWindow) return;

        if (this.pendingMenu) {
            this.menu!.applyMenu(this.pendingMenu);
            this.pendingMenu = null;
        }
        if (this.pendingLoad) {
            if (this.pendingLoad.kind === 'url')
                this.webView.load_uri(this.pendingLoad.url);
            else
                this.webView.load_html(this.pendingLoad.html, this.pendingLoad.baseUri);
            this.pendingLoad = null;
        }

        this.gtkWindow.present();
        ensureDrain(); // start GJS callback delivery (once for all windows)

        // GTK4 alwaysOnTop: retry after surface is mapped
        if (this._alwaysOnTopPending) {
            try {
                const surface = this.gtkWindow.get_surface();
                if (surface?.set_keep_above) surface.set_keep_above(true);
            } catch { /* compositor may not support it */ }
            this._alwaysOnTopPending = false;
        }
        // Window icon
        if (this._iconPath) {
            try {
                const texture = Gdk.Texture.new_from_filename(this._iconPath);
                const surface = this.gtkWindow.get_surface();
                if (surface) surface.set_icon_list([texture]);
            } catch { /* icon loading is best-effort */ }
        }
    }

    public close(): void {
        if (this.isClosed) return;
        try { this.gtkWindow?.close(); } catch { /* ignore */ }
        this._onWindowClosed();
    }

    // -------------------------------------------------------------------------
    // Navigation
    // -------------------------------------------------------------------------

    public async loadURL(url: string): Promise<void> {
        if (!this.gtkWindow) { this.pendingLoad = { kind: 'url', url }; return; }
        this.webView.load_uri(url);
    }

    public async loadFile(filePath: string): Promise<void> {
        const abs  = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
        const html = injectBridgeScript(fs.readFileSync(abs, 'utf-8'), this.webPreferences, getSyncServerPort());
        const uri  = `file://${abs}`;
        if (!this.gtkWindow) { this.pendingLoad = { kind: 'html', html, baseUri: uri }; return; }
        this.webView.load_html(html, uri);
    }

    // -------------------------------------------------------------------------
    // Menu
    // -------------------------------------------------------------------------

    public setMenu(menu: MenuItemOptions[]): void {
        if (!this.gtkWindow) { this.pendingMenu = menu; return; }
        this.menu!.applyMenu(menu);
    }

    public popupMenu(items: MenuItemOptions[], x?: number, y?: number): void {
        if (!this.gtkWindow) return;
        try { this.menu!.popupMenu(items, x, y); } catch { /* ignore */ }
    }

    // -------------------------------------------------------------------------
    // IPC: Node.js → Renderer
    // -------------------------------------------------------------------------

    public sendToRenderer(channel: string, ...args: unknown[]): void { this.send(channel, ...args); }

    public send(channel: string, ...args: unknown[]): void {
        const payload = JSON.stringify({ type: 'message', channel, args });
        this._evalJs(`window.__ipcDispatch(${JSON.stringify(payload)})`);
    }

    // -------------------------------------------------------------------------
    // Dialogs
    // -------------------------------------------------------------------------

    public showOpenDialog(options: OpenDialogOptions): string[] | undefined {
        return showOpenDialog(this.gtkWindow, options);
    }
    public showSaveDialog(options: SaveDialogOptions): string | undefined {
        return showSaveDialog(this.gtkWindow, options);
    }
    public showMessageBox(options: { type?: string; title?: string; message: string; buttons?: string[] }): number {
        return showMessageBox(this.gtkWindow, options);
    }

    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------

    public reload():       void { try { this.webView?.reload();    } catch { /* ignore */ } }
    public openDevTools(): void { try { this.webView?.get_inspector()?.show(); } catch { /* ignore */ } }
    public focus():        void { try { this.gtkWindow?.present(); } catch { /* ignore */ } }
    public minimize():     void { try { this.gtkWindow?.minimize(); } catch { /* ignore */ } }
    public maximize():     void { try { this.gtkWindow?.maximize(); } catch { /* ignore */ } }
    public unmaximize():   void { try { this.gtkWindow?.unmaximize(); } catch { /* ignore */ } }

    public setFullScreen(flag: boolean): void {
        this._isFullScreen = flag;
        try { flag ? this.gtkWindow?.fullscreen() : this.gtkWindow?.unfullscreen(); } catch { /* ignore */ }
    }
    public isFullScreen(): boolean { return this._isFullScreen; }

    public setKiosk(flag: boolean): void {
        this._isKiosk = flag;
        this.setFullScreen(flag);
        this.setSkipTaskbar(flag || (this.options.skipTaskbar ?? false));
    }
    public isKiosk(): boolean { return this._isKiosk; }

    public setTitle(title: string): void { try { this.gtkWindow?.set_title(title); } catch { /* ignore */ } }
    public getTitle(): string {
        try { return this.gtkWindow?.get_title() ?? ''; } catch { return ''; }
    }

    public setSize(w: number, h: number): void {
        try { this.gtkWindow?.set_default_size(w, h); } catch { /* ignore */ }
    }
    public getSize(): [number, number] {
        try {
            return [this.gtkWindow?.get_width() ?? 0, this.gtkWindow?.get_height() ?? 0];
        } catch { return [0, 0]; }
    }

    public setMinimumSize(w: number, h: number): void {
        try { this.gtkWindow?.set_size_request(w > 0 ? w : -1, h > 0 ? h : -1); } catch { /* ignore */ }
    }
    public setMaximumSize(_w: number, _h: number): void {
        console.warn('[node-with-window] win.setMaximumSize() is not supported on GTK4.');
    }

    public setResizable(flag: boolean): void {
        this._isResizable = flag;
        try { this.gtkWindow?.set_resizable(flag); } catch { /* ignore */ }
    }
    public isResizable(): boolean { return this._isResizable; }

    public setAlwaysOnTop(flag: boolean): void {
        try { this.gtkWindow?.set_keep_above(flag); } catch { /* compositor may not support it */ }
    }

    public blur():                    void { console.warn('[node-with-window] win.blur() is not supported on GTK4/GNOME.'); }
    public setPosition(_x: number, _y: number): void { console.warn('[node-with-window] win.setPosition() is not supported on GTK4/GNOME.'); }
    public getPosition():             [number, number] { console.warn('[node-with-window] win.getPosition() is not supported on GTK4/GNOME.'); return [0, 0]; }
    public setOpacity(_o: number):    void { console.warn('[node-with-window] win.setOpacity() is not supported on GTK4/GNOME.'); }
    public getOpacity():              number { console.warn('[node-with-window] win.getOpacity() is not supported on GTK4/GNOME.'); return 1.0; }
    public center():                  void { console.warn('[node-with-window] win.center() is not supported on GTK4/GNOME.'); }

    public flashFrame(flag: boolean): void {
        if (!flag) return;
        try {
            const surface = this.gtkWindow?.get_surface();
            if (surface?.set_urgency_hint) surface.set_urgency_hint(true);
        } catch { /* compositor may not support urgency hints */ }
    }

    public setMinimizable(flag: boolean): void {
        this._isMinimizable = flag;
        if (!flag) console.warn('[node-with-window] win.setMinimizable(false): not reliably supported on all GTK4 compositors.');
    }
    public isMinimizable(): boolean { return this._isMinimizable; }

    public setMaximizable(flag: boolean): void {
        this._isMaximizable = flag;
        try { this.gtkWindow?.set_resizable(flag); } catch { /* ignore */ }
    }
    public isMaximizable(): boolean { return this._isMaximizable; }

    public setClosable(flag: boolean): void {
        this._isClosable = flag;
        try { this.gtkWindow?.set_deletable(flag); } catch { /* ignore */ }
    }
    public isClosable(): boolean { return this._isClosable; }

    public setMovable(flag: boolean): void {
        this._isMovable = flag;
        try { this.gtkWindow?.set_decorated(flag); } catch { /* ignore */ }
    }
    public isMovable(): boolean { return this._isMovable; }

    public setSkipTaskbar(_flag: boolean): void {
        console.warn('[node-with-window] win.setSkipTaskbar(): not reliably supported in GTK4/GNOME.');
    }
    public setFrame(flag: boolean): void {
        try { this.gtkWindow?.set_decorated(flag); } catch { /* ignore */ }
    }
    public setBackgroundColor(color: string): void { this._applyBackgroundColor(color); }

    public getHwnd(): string { return '0'; }

    public setEnabled(flag: boolean): void {
        try { this.gtkWindow?.set_sensitive(flag); } catch { /* ignore */ }
    }

    public async capturePage(): Promise<NativeImage> {
        if (!this.webView) return new NativeImage(Buffer.alloc(0));
        return new Promise<NativeImage>((resolve) => {
            const tmpPath = path.join(os.tmpdir(), `nww-snap-${Date.now()}.png`);
            this.webView.get_snapshot(
                WebKit.SnapshotRegion.VISIBLE,
                WebKit.SnapshotOptions.NONE,
                null,
                (_wv: any, asyncResult: any) => {
                    try {
                        const surface = this.webView.get_snapshot_finish(asyncResult);
                        if (surface) {
                            surface.writeToPNG(tmpPath);
                            const buf = fs.readFileSync(tmpPath);
                            try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
                            resolve(new NativeImage(buf));
                            return;
                        }
                    } catch (e) {
                        console.error('[node-with-window] capturePage error:', e);
                    }
                    resolve(new NativeImage(Buffer.alloc(0)));
                }
            );
        });
    }

    public onNavigationCompleted(callback: () => void): void {
        this._navCompletedCallback = callback;
    }

    public executeJavaScript(code: string): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (!this.webView) { reject(new Error('WebView not ready')); return; }
            const id    = Math.random().toString(36).substring(2, 11);
            const timer = setTimeout(() => {
                if (this._pendingExecs.delete(id))
                    reject(new Error('executeJavaScript timed out after 10000ms'));
            }, 10_000);
            this._pendingExecs.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject:  (e) => { clearTimeout(timer); reject(e); },
            });
            const eid = JSON.stringify(id);
            const src = JSON.stringify(code);
            const script =
                `(function(){var eid=${eid};` +
                `try{var r=eval(${src});` +
                `if(r&&typeof r.then==='function'){` +
                `r.then(function(v){window.webkit.messageHandlers.ipc.postMessage(` +
                `JSON.stringify({type:'execResult',id:eid,result:v==null?null:v}));})` +
                `.catch(function(ex){window.webkit.messageHandlers.ipc.postMessage(` +
                `JSON.stringify({type:'execResult',id:eid,error:String(ex)}));});` +
                `}else{window.webkit.messageHandlers.ipc.postMessage(` +
                `JSON.stringify({type:'execResult',id:eid,result:r==null?null:r}));}` +
                `}catch(ex){window.webkit.messageHandlers.ipc.postMessage(` +
                `JSON.stringify({type:'execResult',id:eid,error:String(ex)}));}` +
                `})()`;
            this._evalJs(script);
        });
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /** Fire-and-forget JavaScript evaluation in the WebView. */
    private _evalJs(script: string): void {
        if (!this.webView) return;
        try {
            this.webView.evaluate_javascript(script, -1, null, null, null, null);
        } catch { /* ignore — window may be closing */ }
    }

    private _applyBackgroundColor(color: string): void {
        const parsed = parseHexColor(color);
        if (!parsed || !this.webView) return;
        try {
            const c = new Gdk.RGBA();
            c.red   = parsed.r / 255;
            c.green = parsed.g / 255;
            c.blue  = parsed.b / 255;
            c.alpha = parsed.a / 255;
            this.webView.set_background_color(c);
        } catch { /* ignore */ }
    }

    private _handleIpcMessage(rawJson: string): void {
        let data: { type: string; channel: string; id?: string; args?: unknown[] };
        try { data = JSON.parse(rawJson); }
        catch { console.error('[GjsGtk4Window] Invalid IPC JSON:', rawJson); return; }

        const { type, channel, id, args = [] } = data;

        if (type === 'execResult') {
            const pending = this._pendingExecs.get(id!);
            if (pending) {
                this._pendingExecs.delete(id!);
                (data as any).error
                    ? pending.reject(new Error((data as any).error))
                    : pending.resolve((data as any).result);
            }
            return;
        }

        if (type === 'navigationCompleted') {
            this._navCompletedCallback?.();
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
            const handlers = (ipcMain as any).handlers as Map<string, (e: unknown, ...a: unknown[]) => unknown>;
            const handler  = handlers.get(channel);
            if (!handler) {
                this._sendIpcReply(id!, null, `No handler for channel: ${channel}`);
                return;
            }
            try {
                const result = handler(event, ...args);
                if (result && typeof (result as any).then === 'function') {
                    (result as Promise<unknown>)
                        .then(r  => this._sendIpcReply(id!, r, null))
                        .catch(e => this._sendIpcReply(id!, null, (e as Error).message || String(e)));
                } else {
                    this._sendIpcReply(id!, result, null);
                }
            } catch (e) {
                this._sendIpcReply(id!, null, (e as Error).message || String(e));
            }
        }
    }

    private _sendIpcReply(id: string, result: unknown, error: string | null): void {
        const payload = JSON.stringify({ type: 'reply', id, result, error });
        this._evalJs(`window.__ipcDispatch(${JSON.stringify(payload)})`);
    }

    private _onWindowClosed(): void {
        if (this.isClosed) return;
        this.isClosed = true;
        for (const p of this._pendingExecs.values()) p.reject(new Error('Window closed'));
        this._pendingExecs.clear();
        this._cleanup();
        this.onClosed?.();
    }

    private _cleanup(): void {
        // Release GTK proxy objects so node-with-gjs can free the GJS-side refs.
        this.cm         = null;
        this.webView    = null;
        this.windowBox  = null;
        this.gtkWindow  = null;
    }
}
