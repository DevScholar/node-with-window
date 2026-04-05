import * as path from 'node:path';
import * as fs from 'node:fs';
import { startEventDrain } from '@devscholar/node-with-gjs';
import {
  _Gtk, _Gdk, _WebKit, _Gio, _GLib, _gtkApp, _appRunning, _pendingWindowCreations, ensureGtkApp,
} from './gtk-app.js';
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
import {
  handleNwwRequest,
  addNwwCallbackPusher,
  removeNwwCallbackPusher,
} from '../../node-integration.js';
import { buildGioMenu } from './menu.js';
import { showOpenDialog, showSaveDialog, showMessageBox } from './dialogs.js';
import { protocol } from '../../protocol.js';

export class GjsGtk4Window implements IWindowProvider {
  public options: BrowserWindowOptions;
  public webPreferences: WebPreferences;

  private win: any = null;
  private webView: any = null;
  private ucm: any = null;
  private _webContext: any = null;
  private _nwwPushFn: ((id: string, args: unknown[]) => void) | null = null;
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
  /** Registered by BrowserWindow; called when the user requests close (X button). Return true to cancel. */
  public onCloseRequest?: () => boolean;

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
    // Always create a WebContext so we can register the nww:// scheme for
    // node integration (require, sendSync) and any user custom schemes.
    try {
      this._webContext = new _WebKit.WebContext();
    } catch {
      this._webContext = _WebKit.WebContext.get_default();
    }

    // nww:// — internal scheme for node integration (always registered).
    this._webContext.register_uri_scheme('nww', (req: any) => {
      void this._handleNwwSchemeRequest(req);
    });

    // User custom schemes.
    const registeredSchemes = protocol.getRegisteredSchemes();
    for (const [scheme] of registeredSchemes) {
      this._webContext.register_uri_scheme(scheme, (req: any) => {
        void this._handleUriSchemeRequest(scheme, req);
      });
    }

    this.webView = new _WebKit.WebView({
      user_content_manager: this.ucm,
      ...(this._webContext ? { web_context: this._webContext } : {}),
    });

    try {
      const settings = this.webView.get_settings();
      settings.enable_developer_extras = true;
    } catch { /* best-effort */ }

    // ── Bridge script (injected at DOCUMENT_START on every page load) ──────
    let bridgeScript = generateBridgeScript(this.webPreferences);
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

    // ── Register nww callback pusher ───────────────────────────────────────
    this._nwwPushFn = (id: string, args: unknown[]) => this._pushNwwCallback(id, args);
    addNwwCallbackPusher(this._nwwPushFn);

    // ── Signal: window closed by user ──────────────────────────────────────
    // close-request fires synchronously via FireSyncEventAndWait — the return
    // value (true = cancel, false = allow) reaches GTK before the signal returns.
    // Same mechanism as the node-with-gjs prevent-close example.
    this.win.connect('close-request', () => {
      if (this.isClosed) {
        // Programmatic close (provider.close() already set isClosed).
        // _onWindowClosed() will return early; just allow GTK to destroy the widget.
        this._onWindowClosed();
        return false;
      }
      if (this.onCloseRequest?.()) {
        return true; // prevented — keep window open
      }
      this._onWindowClosed();
      return false;
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
    if (this._nwwPushFn) {
      removeNwwCallbackPusher(this._nwwPushFn);
      this._nwwPushFn = null;
    }
    for (const p of this._pendingExecs.values()) p.reject(new Error('Window closed'));
    this._pendingExecs.clear();
    if (this.win) {
      try { this.win.close(); } catch { /* ignore */ }
    }
    this.onClosed?.();
  }

  private _onWindowClosed(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this._nwwPushFn) {
      removeNwwCallbackPusher(this._nwwPushFn);
      this._nwwPushFn = null;
    }
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

  // ── nww:// scheme handler ──────────────────────────────────────────────────

  /** Push a node-integration callback to the renderer via evaluate_javascript. */
  private _pushNwwCallback(id: string, args: unknown[]): void {
    const payload = JSON.stringify({ type: 'nwwCallback', id, args });
    this._evaluateJs(
      `window.__ipcDispatch && window.__ipcDispatch(${JSON.stringify(payload)})`,
    );
  }

  /**
   * Read the POST body from a WebKitURISchemeRequest.
   * get_http_body() is available in WebKit 2.40+; returns null on older builds.
   */
  private _readNwwBody(req: any): string | null {
    try {
      const stream = req.get_http_body?.();
      if (!stream) return null;
      const gBytes = stream.read_bytes(10 * 1024 * 1024, null);
      const data: Uint8Array = gBytes.get_data();
      return new TextDecoder().decode(data);
    } catch {
      return null;
    }
  }

  private _handleNwwSchemeRequest(req: any): void {
    try {
      const uri: string    = req.get_uri();
      const method: string = req.get_http_method?.() ?? 'GET';
      const body           = method === 'POST' ? this._readNwwBody(req) : null;

      const result = handleNwwRequest(uri, method, body);

      const bytes = result.status === 204
        ? new Uint8Array(0)
        : new TextEncoder().encode(result.body);
      const glibBytes = new (_GLib.Bytes as any)(bytes);
      const stream    = _Gio.MemoryInputStream.new_from_bytes(glibBytes);

      // Use req.finish() directly — the URISchemeResponse constructor in some
      // WebKit versions doesn't properly store the input stream, causing
      // g_input_stream_read_async assertion failures.  Status code is always
      // 200 but the nww bridge checks the JSON body, not HTTP status.
      req.finish(stream, bytes.length, result.mimeType);
    } catch (e) {
      console.error('[gjs-gtk4] nww scheme handler error:', e);
      try { req.finish_error(e instanceof Error ? e : new Error(String(e))); } catch { /* ignore */ }
    }
  }

  // ── Protocol scheme handler ────────────────────────────────────────────────

  private async _handleUriSchemeRequest(scheme: string, request: any): Promise<void> {
    const uri: string    = request.get_uri();
    const method: string = request.get_http_method();
    const handler = protocol.getHandler(scheme);

    if (!handler) {
      try { request.finish_error(new Error(`No handler for scheme: ${scheme}`)); } catch { /* ignore */ }
      return;
    }

    let result;
    try {
      result = await handler({ url: uri, method });
    } catch (e) {
      console.error(`[gjs-gtk4] Protocol handler error for ${scheme}:`, e);
      try { request.finish_error(e instanceof Error ? e : new Error(String(e))); } catch { /* ignore */ }
      return;
    }

    try {
      const body = result.data ?? '';
      let bytes: Uint8Array;
      if (typeof body === 'string') {
        bytes = new TextEncoder().encode(body);
      } else {
        bytes = new Uint8Array((body as Buffer).buffer, (body as Buffer).byteOffset, (body as Buffer).byteLength);
      }

      const glibBytes = new (_GLib.Bytes as any)(bytes);
      const stream    = _Gio.MemoryInputStream.new_from_bytes(glibBytes);
      const mimeType  = result.mimeType ?? 'text/html; charset=utf-8';
      const status    = result.statusCode ?? 200;

      if (status !== 200) {
        const resp = new _WebKit.URISchemeResponse(stream);
        resp.set_status(status, null);
        resp.set_content_type(mimeType);
        request.finish_with_response(resp);
      } else {
        request.finish(stream, bytes.length, mimeType);
      }
    } catch (e) {
      console.error(`[gjs-gtk4] Protocol finish error for ${scheme}:`, e);
      try { request.finish_error(e instanceof Error ? e : new Error(String(e))); } catch { /* ignore */ }
    }
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
    console.warn('[gjs-gtk4] popupMenu: not yet implemented on GTK4');
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
    return showOpenDialog(this.win, options);
  }

  public showSaveDialog(options: SaveDialogOptions): string | undefined {
    return showSaveDialog(this.win, options);
  }

  public showMessageBox(options: {
    type?: string;
    title?: string;
    message: string;
    buttons?: string[];
  }): number {
    return showMessageBox(this.win, options);
  }
}
