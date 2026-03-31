import * as path from 'node:path';
import * as fs from 'node:fs';
import { imports as gjsImports, startEventDrain, drainCallbacks } from '@devscholar/node-with-gjs';
import {
  IWindowProvider,
  BrowserWindowOptions,
  WebPreferences,
  MenuItemOptions,
  OpenDialogOptions,
  SaveDialogOptions,
} from '../../interfaces.js';
import { NativeImage } from '../../native-image.js';
import { ipcMain } from '../../ipc-main.js';
import { generateBridgeScript } from './bridge.js';
import { getSyncServerPort } from '../../node-integration.js';
import { buildGioMenu } from './menu.js';

// ── Module-level shared state ────────────────────────────────────────────────
// There can only be one Gtk.Application per process.  All BrowserWindows share
// the same application instance and the same GJS IPC connection.

let _gi: any = null;
let _Gtk: any = null;
let _Gdk: any = null;
let _WebKit: any = null;  // either WebKit 6.0 or WebKit2 4.1
let _Gio: any = null;
let _gtkApp: any = null;
let _appRunning = false;  // true once activate has fired
/** Callbacks queued before activate fires; drained in the activate handler. */
const _pendingWindowCreations: Array<() => void> = [];

function ensureGiLoaded(): void {
  if (_gi) return;
  _gi = gjsImports.gi;
  _gi.versions.Gtk = '4.0';
  _gi.versions.Gdk = '4.0';
  _Gtk = _gi.Gtk;
  _Gdk = _gi.Gdk;
  _Gio = _gi.Gio;

  // Prefer WebKit 6.0 (newer), fall back to WebKit2 4.1 (GTK4 API)
  try {
    _gi.versions.WebKit = '6.0';
    _WebKit = _gi.WebKit;
  } catch {
    try {
      _gi.versions.WebKit2 = '4.1';
      _WebKit = _gi.WebKit2;
    } catch (e) {
      console.error('[gjs-gtk4] Could not load WebKit namespace:', e);
      _WebKit = null;
    }
  }
}

function ensureGtkApp(): void {
  if (_gtkApp) return;
  ensureGiLoaded();
  _gtkApp = new _Gtk.Application({ application_id: 'org.nodejs.nww' });
  // MUST be a sync (non-async) callback: GJS blocks in processNestedCommands()
  // while Node.js creates windows inline.  If async, app.run() sees zero
  // windows after activate returns and quits immediately, killing the host.
  _gtkApp.connect('activate', () => {
    _appRunning = true;
    const callbacks = _pendingWindowCreations.splice(0);
    for (const fn of callbacks) fn();
  });
}

// ── GjsGtk4Window ────────────────────────────────────────────────────────────

export class GjsGtk4Window implements IWindowProvider {
  public options: BrowserWindowOptions;
  public webPreferences: WebPreferences;

  private win: any = null;
  private webView: any = null;
  private ucm: any = null;
  private _contentBox: any = null;
  private _menuBar: any = null;
  private _menuActionNames: string[] = [];
  /** Strong refs to Gio.SimpleAction proxies — prevents V8 GC from releasing
   *  the GJS-side objects and their signal callbacks. */
  private _menuActions: any[] = [];

  private _pendingMenu: MenuItemOptions[] | null = null;
  private _pendingFilePath: string | null = null;
  private navigationQueue: Array<() => void> = [];
  private isWebViewReady = false;
  private isClosed = false;
  private _isFullScreen = false;
  private _isKiosk = false;
  private _isResizable = true;
  private _zoomLevel = 1.0;
  private _navCompletedCallback: (() => void) | null = null;
  private _pendingExecs = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  public onClosed?: () => void;

  constructor(options?: BrowserWindowOptions) {
    this.options = options || {};
    this.webPreferences = this.options.webPreferences || {};
    this._isResizable = this.options.resizable ?? true;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  public async createWindow(): Promise<void> {
    ensureGtkApp();

    return new Promise<void>((resolve, reject) => {
      const doCreate = () => {
        try {
          this._createWindowInGtk();
          resolve();
        } catch (e) {
          reject(e);
        }
      };

      if (_appRunning) {
        doCreate();
      } else {
        _pendingWindowCreations.push(doCreate);
        if (_pendingWindowCreations.length === 1) {
          // First window: start the GTK application (non-blocking via node-with-gjs)
          startEventDrain();
          _gtkApp.run([]);
        }
      }
    });
  }

  private _createWindowInGtk(): void {
    if (!_WebKit) throw new Error('[gjs-gtk4] WebKit namespace not available');

    // ── UserContentManager for IPC ─────────────────────────────────────────
    this.ucm = new _WebKit.UserContentManager();
    try {
      // WebKit 6.0: 2 args; WebKit2 4.1: 1 arg
      this.ucm.register_script_message_handler('ipc', null);
    } catch {
      this.ucm.register_script_message_handler('ipc');
    }

    // Async callback: messages arrive via poll every 16 ms
    this.ucm.connect('script-message-received::ipc', async (_ucm: any, jsResult: any) => {
      try {
        let json: string;
        try {
          json = jsResult.get_js_value().to_string();  // WebKit2 4.1
        } catch {
          json = jsResult.to_string();                  // WebKit 6.0
        }
        this._handleIpcMessage(json);
      } catch (e) {
        console.error('[gjs-gtk4] IPC message error:', e);
      }
    });

    // ── WebView ────────────────────────────────────────────────────────────
    this.webView = new _WebKit.WebView({ user_content_manager: this.ucm });

    try {
      const settings = this.webView.get_settings();
      settings.enable_developer_extras = true;
    } catch { /* best-effort */ }

    // ── Bridge script (injected at DOCUMENT_START on every page load) ──────
    let bridgeScript = generateBridgeScript(this.webPreferences, getSyncServerPort());
    if (this.webPreferences.preload) {
      const absPreload = path.isAbsolute(this.webPreferences.preload)
        ? this.webPreferences.preload
        : path.resolve(process.cwd(), this.webPreferences.preload);
      try {
        bridgeScript += '\n' + fs.readFileSync(absPreload, 'utf-8');
        if (this.webPreferences.contextIsolation === true) {
          bridgeScript +=
            '\n(function(){' +
            'window.ipcRenderer=undefined;' +
            'window.contextBridge=undefined;' +
            '})();';
        }
      } catch (e) {
        console.error('[gjs-gtk4] Failed to load preload script:', e);
      }
    }

    const InjectedFrames = _WebKit.UserContentInjectedFrames;
    const InjectionTime  = _WebKit.UserScriptInjectionTime;
    const userScript = new _WebKit.UserScript(
      bridgeScript,
      InjectedFrames.ALL_FRAMES,
      InjectionTime.DOCUMENT_START,
      null,
      null
    );
    this.ucm.add_script(userScript);

    // ── Window ─────────────────────────────────────────────────────────────
    this.win = new _Gtk.ApplicationWindow({ application: _gtkApp });
    this.win.set_title(this.options.title || 'node-with-window');
    this.win.set_default_size(this.options.width || 800, this.options.height || 600);

    if (!this._isResizable) this.win.set_resizable(false);
    if (this.options.minWidth || this.options.minHeight) {
      this.win.set_size_request(this.options.minWidth || -1, this.options.minHeight || -1);
    }

    // ── Frame / decorations ────────────────────────────────────────────────
    const needFrameless = this.options.frame === false
      || this.options.transparent
      || this.options.titleBarStyle === 'hidden'
      || this.options.titleBarStyle === 'hiddenInset';
    if (needFrameless) {
      this.win.set_decorated(false);
    }

    // ── Transparent window ─────────────────────────────────────────────────
    if (this.options.transparent) {
      // 1. Transparent WebKit background so compositor sees through the page
      try {
        const rgba = new _Gdk.RGBA();
        rgba.red = 0; rgba.green = 0; rgba.blue = 0; rgba.alpha = 0;
        this.webView.set_background_color(rgba);
      } catch (e) { console.warn('[gjs-gtk4] set_background_color failed:', e); }

      // 2. Transparent GTK window background via CSS (so the window chrome
      //    itself doesn't paint an opaque rectangle behind the webview)
      try {
        const provider = new _Gtk.CssProvider();
        const css = '.nww-transparent { background-color: transparent; background: transparent; }';
        try { provider.load_from_string(css); }
        catch { provider.load_from_data(css, -1); }
        this.win.add_css_class('nww-transparent');
        _Gtk.StyleContext.add_provider_for_display(
          _Gdk.Display.get_default(), provider, 600);
      } catch (e) { console.warn('[gjs-gtk4] Transparent CSS failed:', e); }
    } else if (this.options.backgroundColor) {
      try {
        const rgba = new _Gdk.RGBA();
        rgba.parse(this.options.backgroundColor);
        this.webView.set_background_color(rgba);
      } catch { /* best-effort */ }
    }

    // ── Layout: vertical box (menu bar on top, webview below) ──────────────
    this._contentBox = new _Gtk.Box({ orientation: _Gtk.Orientation.VERTICAL, spacing: 0 });
    this.win.set_child(this._contentBox);

    this.webView.set_hexpand(true);
    this.webView.set_vexpand(true);
    this._contentBox.append(this.webView);

    // ── Apply pending menu ─────────────────────────────────────────────────
    if (this._pendingMenu !== null) {
      this._applyMenu(this._pendingMenu);
      this._pendingMenu = null;
    }

    // ── Signal: window closed by user ──────────────────────────────────────
    this.win.connect('close-request', async () => {
      this._onWindowClosed();
    });

    // ── Signal: page load progress ────────────────────────────────────────
    // LoadEvent enum: STARTED=0, REDIRECTED=1, COMMITTED=2, FINISHED=3
    this.webView.connect('load-changed', async (_wv: any, loadEvent: any) => {
      if (loadEvent === 3) {  // FINISHED
        this.isWebViewReady = true;
        this._navCompletedCallback?.();
        while (this.navigationQueue.length > 0) {
          const action = this.navigationQueue.shift();
          if (action) action();
        }
      }
    });

    // ── Initial navigation ─────────────────────────────────────────────────
    if (this._pendingFilePath) {
      this.webView.load_uri('file://' + this._pendingFilePath);
      this._pendingFilePath = null;
    } else {
      this.webView.load_uri('about:blank');
    }
  }

  public show(): void {
    if (this.win) this.win.present();
  }

  public close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const p of this._pendingExecs.values()) p.reject(new Error('Window closed'));
    this._pendingExecs.clear();
    if (this.win) {
      try { this.win.close(); } catch { /* ignore */ }
    }
    // Notify BrowserWindow regardless of how close() was called (menu role,
    // BrowserWindow.close(), etc.). BrowserWindow._handleClosed() is idempotent.
    this.onClosed?.();
  }

  private _onWindowClosed(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const pending of this._pendingExecs.values()) {
      pending.reject(new Error('Window closed'));
    }
    this._pendingExecs.clear();
    this.onClosed?.();
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  public async loadURL(url: string): Promise<void> {
    if (!this.webView) {
      this.navigationQueue.push(() => this.loadURL(url));
      return;
    }
    this.webView.load_uri(url);
  }

  public async loadFile(filePath: string): Promise<void> {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);
    const fileUri = 'file://' + absolutePath;
    if (!this.webView) {
      this._pendingFilePath = absolutePath;
      return;
    }
    this.webView.load_uri(fileUri);
  }

  public reload(): void {
    if (this.webView) this.webView.reload();
  }

  public onNavigationCompleted(callback: () => void): void {
    this._navCompletedCallback = callback;
  }

  // ── IPC ────────────────────────────────────────────────────────────────────

  private _evaluateJs(code: string): void {
    if (!this.webView) return;
    // 6 args: script, length, world_name, source_uri, cancellable, callback
    this.webView.evaluate_javascript(code, -1, null, null, null, null);
  }

  public sendToRenderer(channel: string, ...args: unknown[]): void {
    const payload = JSON.stringify({ type: 'message', channel, args });
    this._evaluateJs(
      `window.__ipcDispatch && window.__ipcDispatch(${JSON.stringify(payload)})`
    );
  }

  public sendIpcReply(id: string, result: unknown, error: string | null): void {
    const payload = JSON.stringify({ type: 'reply', id, result, error });
    this._evaluateJs(
      `window.__ipcDispatch && window.__ipcDispatch(${JSON.stringify(payload)})`
    );
  }

  public executeJavaScript(code: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.webView) {
        reject(new Error('WebView not ready'));
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

      // Wrap code in an IIFE that sends the result back via the IPC channel.
      // The handler in _handleIpcMessage resolves / rejects the promise above.
      const eid = JSON.stringify(id);
      const wrapped =
        `(function(){` +
        `var eid=${eid};` +
        `try{` +
        `  var r=(function(){${code}})();` +
        `  if(r&&typeof r.then==='function'){` +
        `    r.then(function(v){window.webkit.messageHandlers.ipc.postMessage(JSON.stringify({type:'execResult',id:eid,result:v==null?null:v}));})` +
        `    .catch(function(e){window.webkit.messageHandlers.ipc.postMessage(JSON.stringify({type:'execResult',id:eid,error:String(e)}));});` +
        `  }else{window.webkit.messageHandlers.ipc.postMessage(JSON.stringify({type:'execResult',id:eid,result:r==null?null:r}));}` +
        `}catch(e){window.webkit.messageHandlers.ipc.postMessage(JSON.stringify({type:'execResult',id:eid,error:String(e)}));}` +
        `})()`;
      this._evaluateJs(wrapped);
    });
  }

  private _handleIpcMessage(json: string): void {
    let message: any;
    try { message = JSON.parse(json); } catch { return; }

    const { channel, type, id, args = [] } = message;
    const event = {
      sender: this,
      reply: (ch: string, ...a: unknown[]) => this.sendToRenderer(ch, ...a),
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
      const handler = (ipcMain as any).handlers.get(channel) as
        | ((event: unknown, ...args: unknown[]) => unknown)
        | undefined;
      if (handler) {
        try {
          const result = handler(event, ...args);
          if (result && typeof (result as any).then === 'function') {
            (result as Promise<unknown>)
              .then(r => this.sendIpcReply(id, r, null))
              .catch(err => this.sendIpcReply(id, null, (err as Error).message || String(err)));
          } else {
            this.sendIpcReply(id, result, null);
          }
        } catch (err: unknown) {
          const e = err as { message?: string };
          this.sendIpcReply(id, null, e.message || String(err));
        }
      } else {
        this.sendIpcReply(id, null, `No handler for channel: ${channel}`);
      }
    }
  }

  // ── DevTools ───────────────────────────────────────────────────────────────

  public openDevTools(): void {
    if (!this.webView) return;
    try {
      const inspector = this.webView.get_inspector();
      if (inspector) inspector.show();
    } catch { /* best-effort */ }
  }

  // ── Menu ───────────────────────────────────────────────────────────────────

  public setMenu(menu: MenuItemOptions[]): void {
    if (!this.win) {
      this._pendingMenu = menu;
      return;
    }
    this._applyMenu(menu);
  }

  private _applyMenu(items: MenuItemOptions[]): void {
    if (!this.win || !this._contentBox) return;

    // Remove existing menu bar
    if (this._menuBar) {
      try { this._contentBox.remove(this._menuBar); } catch { /* ignore */ }
      this._menuBar = null;
    }

    // Remove old window actions and release references
    for (const name of this._menuActionNames) {
      try { this.win.remove_action(name); } catch { /* ignore */ }
    }
    this._menuActionNames = [];
    this._menuActions = [];

    if (!items || items.length === 0) return;

    const actions: Array<{ name: string; action: any }> = [];
    const gioMenu = buildGioMenu(items, _Gio, actions, (role) => this._roleAction(role));

    for (const { name, action } of actions) {
      this.win.add_action(action);
      this._menuActionNames.push(name);
      this._menuActions.push(action);  // prevent V8 GC → keeps callbacks alive
    }

    try {
      this._menuBar = new _Gtk.PopoverMenuBar({ menu_model: gioMenu });
      this._contentBox.prepend(this._menuBar);
    } catch (e) {
      console.error('[gjs-gtk4] Failed to create PopoverMenuBar:', e);
    }
  }

  public popupMenu(_items: MenuItemOptions[], _x?: number, _y?: number): void {
    // TODO: implement context menu via Gtk.PopoverMenu
  }

  private _roleAction(role: string): (() => void) | undefined {
    switch (role) {
      case 'close':            return () => this.close();
      case 'minimize':         return () => this.minimize();
      case 'reload':
      case 'forceReload':      return () => this.reload();
      case 'toggleDevTools':   return () => this.openDevTools();
      case 'togglefullscreen': return () => this.setFullScreen(!this.isFullScreen());
      case 'resetZoom':        return () => { this._zoomLevel = 1.0;   if (this.webView) this.webView.set_zoom_level(1.0); };
      case 'zoomIn':           return () => { this._zoomLevel = Math.min(this._zoomLevel + 0.1, 5.0);  if (this.webView) this.webView.set_zoom_level(this._zoomLevel); };
      case 'zoomOut':          return () => { this._zoomLevel = Math.max(this._zoomLevel - 0.1, 0.25); if (this.webView) this.webView.set_zoom_level(this._zoomLevel); };
      case 'undo':      return () => this._evaluateJs("document.execCommand('undo')");
      case 'redo':      return () => this._evaluateJs("document.execCommand('redo')");
      case 'cut':       return () => this._evaluateJs("document.execCommand('cut')");
      case 'copy':      return () => this._evaluateJs("document.execCommand('copy')");
      case 'paste':     return () => this._evaluateJs("document.execCommand('paste')");
      case 'selectAll': return () => this._evaluateJs("document.execCommand('selectAll')");
      default:          return undefined;
    }
  }

  // ── Window management ──────────────────────────────────────────────────────

  public focus(): void {
    if (this.win) this.win.present();
  }

  public blur(): void { /* GTK4 has no direct blur API */ }

  public minimize(): void {
    if (this.win) try { this.win.minimize(); } catch { /* ignore */ }
  }

  public maximize(): void {
    if (this.win) this.win.maximize();
  }

  public unmaximize(): void {
    if (this.win) this.win.unmaximize();
  }

  public setFullScreen(flag: boolean): void {
    if (!this.win) return;
    this._isFullScreen = flag;
    if (flag) this.win.fullscreen();
    else      this.win.unfullscreen();
  }

  public isFullScreen(): boolean {
    return this._isFullScreen;
  }

  public setKiosk(flag: boolean): void {
    this._isKiosk = flag;
    this.setFullScreen(flag);
  }

  public isKiosk(): boolean {
    return this._isKiosk;
  }

  public setTitle(title: string): void {
    if (this.win) this.win.set_title(title);
  }

  public getTitle(): string {
    if (this.win) {
      try { return this.win.get_title() as string; } catch { /* ignore */ }
    }
    return this.options.title ?? '';
  }

  public setSize(width: number, height: number): void {
    if (this.win) this.win.set_default_size(width, height);
  }

  public getSize(): [number, number] {
    if (!this.win) return [this.options.width ?? 0, this.options.height ?? 0];
    try {
      const w = this.win.get_width() as number;
      const h = this.win.get_height() as number;
      return [Math.round(w), Math.round(h)];
    } catch {
      return [this.options.width ?? 0, this.options.height ?? 0];
    }
  }

  public setResizable(resizable: boolean): void {
    this._isResizable = resizable;
    if (this.win) this.win.set_resizable(resizable);
  }

  public isResizable(): boolean {
    return this._isResizable;
  }

  public setAlwaysOnTop(_flag: boolean): void {
    // GTK4: compositor-controlled; no portable always-on-top API via GI
  }

  public center(): void {
    // GTK4: window placement is managed by the compositor
    console.warn('[gjs-gtk4] setPosition/center: not supported on GTK4 (compositor-managed)');
  }

  public setPosition(_x: number, _y: number): void {
    console.warn('[gjs-gtk4] setPosition: not supported on GTK4 (compositor-managed)');
  }

  public getPosition(): [number, number] {
    return [0, 0];
  }

  public setOpacity(_opacity: number): void {
    console.warn('[gjs-gtk4] setOpacity: not supported on GTK4');
  }

  public getOpacity(): number {
    return 1;
  }

  public setMinimumSize(width: number, height: number): void {
    if (this.win) this.win.set_size_request(width, height);
  }

  public setMaximumSize(_width: number, _height: number): void {
    // GTK4 removed maximum window size constraint
  }

  public setBackgroundColor(color: string): void {
    if (!this.webView) return;
    try {
      const rgba = new _Gdk.RGBA();
      rgba.parse(color);
      this.webView.set_background_color(rgba);
    } catch { /* best-effort */ }
  }

  public flashFrame(_flag: boolean): void { /* no-op on GTK */ }

  public getHwnd(): string {
    return '0';  // Windows-only
  }

  public setEnabled(flag: boolean): void {
    if (this.win) this.win.set_sensitive(flag);
  }

  public async capturePage(): Promise<NativeImage> {
    return new NativeImage(Buffer.alloc(0));
  }

  // ── Dialogs ────────────────────────────────────────────────────────────────

  public showOpenDialog(options: OpenDialogOptions): string[] | undefined {
    if (!this.win) return undefined;

    let result: string[] | undefined;
    let done = false;

    try {
      const dialog = new _Gtk.FileDialog();
      if (options.title) dialog.title = options.title;
      if (options.defaultPath) {
        try { dialog.initial_folder = _Gio.File.new_for_path(options.defaultPath); } catch { /* ignore */ }
      }

      const isMulti = options.properties?.includes('multiSelections');
      const isDir   = options.properties?.includes('openDirectory');

      const callback = (source: any, asyncResult: any) => {
        try {
          if (isDir) {
            const folder = source.select_folder_finish(asyncResult);
            result = folder ? [folder.get_path()] : undefined;
          } else if (isMulti) {
            const list = source.open_multiple_finish(asyncResult);
            const count = list.get_n_items();
            result = [];
            for (let i = 0; i < count; i++) result.push(list.get_item(i).get_path());
          } else {
            const file = source.open_finish(asyncResult);
            result = file ? [file.get_path()] : undefined;
          }
        } catch { /* user cancelled */ }
        done = true;
      };

      if (isDir) dialog.select_folder(this.win, null, callback);
      else if (isMulti) dialog.open_multiple(this.win, null, callback);
      else dialog.open(this.win, null, callback);

      while (!done) drainCallbacks();
    } catch (e) {
      console.warn('[gjs-gtk4] showOpenDialog failed:', e);
    }

    return result;
  }

  public showSaveDialog(options: SaveDialogOptions): string | undefined {
    if (!this.win) return undefined;

    let result: string | undefined;
    let done = false;

    try {
      const dialog = new _Gtk.FileDialog();
      if (options.title) dialog.title = options.title;
      if (options.defaultPath) {
        const dp = options.defaultPath;
        try {
          const stat = fs.statSync(dp);
          if (stat.isDirectory()) {
            dialog.initial_folder = _Gio.File.new_for_path(dp);
          } else {
            dialog.initial_folder = _Gio.File.new_for_path(path.dirname(dp));
            dialog.initial_name = path.basename(dp);
          }
        } catch {
          dialog.initial_name = path.basename(dp);
        }
      }

      dialog.save(this.win, null, (source: any, asyncResult: any) => {
        try {
          const file = source.save_finish(asyncResult);
          result = file ? file.get_path() : undefined;
        } catch { /* user cancelled */ }
        done = true;
      });

      while (!done) drainCallbacks();
    } catch (e) {
      console.warn('[gjs-gtk4] showSaveDialog failed:', e);
    }

    return result;
  }

  public showMessageBox(options: {
    type?: string;
    title?: string;
    message: string;
    buttons?: string[];
  }): number {
    // GTK4 has no synchronous dialog API. Use JavaScript alert() in the WebView
    // as a simple fallback — it blocks the renderer until dismissed.
    if (this.webView) {
      const msg = (options.message || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
      this._evaluateJs(`alert('${msg}')`);
    }
    return 0;
  }
}
