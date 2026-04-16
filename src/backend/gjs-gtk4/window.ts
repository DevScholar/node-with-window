import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';
import { startEventDrain } from '@devscholar/node-with-gjs';
import {
  _Gtk, _Gdk, _WebKit, _Gio, _gtkApp, _appRunning, _pendingWindowCreations, ensureGtkApp,
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
  addNwwCallbackPusher,
  removeNwwCallbackPusher,
} from '../../node-integration.js';
import { buildGioMenu } from './menu.js';
import { showOpenDialog, showSaveDialog, showMessageBox } from './dialogs.js';
import { protocol } from '../../protocol.js';
import { handleNwwScheme, handleUriScheme } from './scheme-handler.js';
import { app } from '../../app.js';
import type Gtk from '@girs/gtk-4.0';
import type Gdk from '@girs/gdk-4.0';
import type Gio from '@girs/gio-2.0';
import type WebKit from '@girs/webkit-6.0';

export class GjsGtk4Window implements IWindowProvider {
  public options: BrowserWindowOptions;
  public webPreferences: WebPreferences;

  private win: Gtk.ApplicationWindow | null = null;
  private webView: WebKit.WebView | null = null;
  private ucm: WebKit.UserContentManager | null = null;
  private _webContext: WebKit.WebContext | null = null;
  private _nwwPushFn: ((id: string, args: unknown[]) => void) | null = null;
  private _contentBox: Gtk.Box | null = null;
  private _menuBar: Gtk.PopoverMenuBar | null = null;
  private _menuActionNames: string[] = [];
  private _menuActions: Gio.SimpleAction[] = [];

  private _pendingMenu: MenuItemOptions[] | null = null;
  private _pendingFilePath: string | null = null;
  private navigationQueue: Array<() => void> = [];
  private isWebViewReady = false;
  private isClosed = false;
  private _isVisible = false;
  private _isMinimized = false;
  private _isMaximized = false;
  private _isFullScreen = false;
  private _isKiosk = false;
  private _isResizable = true;
  private _zoomLevel = 1.0;
  private _userDataPath: string | null = null;
  private _isTempSession = false;
  private _navCompletedCallback: (() => void) | null = null;
  private _navigateCallback: ((url: string) => void) | null = null;
  private _domReadyCallback: (() => void) | null = null;
  private _navigateFailedCallback: ((errorCode: number, errorDescription: string, url: string) => void) | null = null;
  private _willNavigateCallback: ((url: string) => void) | null = null;
  private _pendingExecs = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  public onClosed?: () => void;
  public onCloseRequest?: () => Promise<boolean> | boolean;
  public onFocus?: () => void;
  public onBlur?: () => void;
  public onResize?: (width: number, height: number) => void;
  public onTitleUpdated?: (title: string) => void;
  public onMinimize?: () => void;
  public onMaximize?: () => void;
  public onUnmaximize?: () => void;
  public onRestore?: () => void;
  public onEnterFullScreen?: () => void;
  public onLeaveFullScreen?: () => void;
  public onShow?: () => void;
  public onHide?: () => void;
  public onMove?: (x: number, y: number) => void;

  constructor(options?: BrowserWindowOptions) {
    this.options = options || {};
    this.webPreferences = this.options.webPreferences || {};
    this._isResizable = this.options.resizable ?? true;

    const partition = this.webPreferences.partition;
    if (partition) {
      const userDataBase = app.getPath('userData');
      if (partition.startsWith('persist:')) {
        this._userDataPath = path.join(userDataBase, 'Partitions', partition.substring(8));
      } else if (partition.startsWith('temp:')) {
        this._isTempSession = true;
        this._userDataPath = path.join(
          os.tmpdir(), 'node-with-window-webkit',
          `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`
        );
      } else {
        this._userDataPath = path.join(userDataBase, 'Partitions', partition);
      }
    }
  }

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
          startEventDrain();
          _gtkApp.run([]);
        }
      }
    });
  }

  // ── Window creation ────────────────────────────────────────────────────────

  private _createWindowInGtk(): void {
    this._setupWebContext();
    this._setupWebView();
    this._setupGtkWindow();
    this._connectWindowSignals();
    this._connectWebViewSignals();
  }

  /** Create UCM, WebContext, and register URI scheme handlers. */
  private _setupWebContext(): void {
    if (!_WebKit) throw new Error('[gjs-gtk4] WebKit namespace not available');

    this.ucm = new _WebKit.UserContentManager() as WebKit.UserContentManager;
    try {
      this.ucm.register_script_message_handler('ipc', null);
    } catch {
      this.ucm.register_script_message_handler('ipc');
    }

    this.ucm.connect('script-message-received::ipc', async (_ucm: WebKit.UserContentManager, jsResult: any) => {
      try {
        let json: string;
        try {
          json = jsResult.get_js_value().to_string();
        } catch {
          json = jsResult.to_string();
        }
        this._handleIpcMessage(json);
      } catch (e) {
        console.error('[gjs-gtk4] IPC message error:', e);
      }
    });

    try {
      if (this._userDataPath && !this._isTempSession) {
        // persist: partition — dedicated data directory
        const dataManager = new (_WebKit.WebsiteDataManager as any)({
          base_data_directory: this._userDataPath,
          base_cache_directory: path.join(this._userDataPath, 'cache'),
        });
        this._webContext = new (_WebKit.WebContext as any)({ website_data_manager: dataManager });
      } else if (this._isTempSession) {
        // temp: partition — ephemeral (in-memory) session
        try {
          const dataManager = new (_WebKit.WebsiteDataManager as any)({ is_ephemeral: true });
          this._webContext = new (_WebKit.WebContext as any)({ website_data_manager: dataManager });
        } catch {
          this._webContext = new _WebKit.WebContext();
        }
      } else {
        this._webContext = new _WebKit.WebContext();
      }
    } catch {
      this._webContext = _WebKit.WebContext.get_default() as WebKit.WebContext;
    }

    this._webContext!.register_uri_scheme('nww', (req: WebKit.URISchemeRequest) => {
      handleNwwScheme(req);
    });

    for (const [scheme] of protocol.getRegisteredSchemes()) {
      this._webContext!.register_uri_scheme(scheme, (req: WebKit.URISchemeRequest) => {
        void handleUriScheme(scheme, req);
      });
    }
  }

  /** Create the WebView, configure settings, and inject the bridge + preload script. */
  private _setupWebView(): void {
    this.webView = new _WebKit.WebView({
      user_content_manager: this.ucm ?? undefined,
      web_context: this._webContext ?? undefined,
    }) as WebKit.WebView;

    try {
      const settings = this.webView.get_settings();
      settings.enable_developer_extras = true;
    } catch { /* best-effort */ }

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
      InjectionTime.START,
      null,
      null
    ) as WebKit.UserScript;
    this.ucm!.add_script(userScript);
  }

  /** Create the GTK ApplicationWindow, set layout, apply background/transparency options. */
  private _setupGtkWindow(): void {
    this.win = new _Gtk.ApplicationWindow({ application: _gtkApp }) as Gtk.ApplicationWindow;
    this.win.set_title(this.options.title || 'node-with-window');
    this.win.set_default_size(this.options.width || 800, this.options.height || 600);

    if (!this._isResizable) this.win.set_resizable(false);
    if (this.options.minWidth || this.options.minHeight) {
      this.win.set_size_request(this.options.minWidth || -1, this.options.minHeight || -1);
    }

    const needFrameless = this.options.frame === false
      || this.options.transparent
      || this.options.titleBarStyle === 'hidden'
      || this.options.titleBarStyle === 'hiddenInset';
    if (needFrameless) {
      this.win.set_decorated(false);
    }

    if (this.options.transparent) {
      try {
        const rgba = new _Gdk.RGBA() as Gdk.RGBA;
        rgba.red = 0; rgba.green = 0; rgba.blue = 0; rgba.alpha = 0;
        this.webView!.set_background_color(rgba);
      } catch (e) { console.warn('[gjs-gtk4] set_background_color failed:', e); }

      try {
        const provider = new _Gtk.CssProvider() as Gtk.CssProvider;
        const css = '.nww-transparent { background-color: transparent; background: transparent; }';
        try { provider.load_from_string(css); }
        catch { provider.load_from_data(css, -1); }
        this.win.add_css_class('nww-transparent');
        _Gtk.StyleContext.add_provider_for_display(
          _Gdk.Display.get_default()!, provider, 600);
      } catch (e) { console.warn('[gjs-gtk4] Transparent CSS failed:', e); }
    } else if (this.options.backgroundColor) {
      try {
        const rgba = new _Gdk.RGBA() as Gdk.RGBA;
        rgba.parse(this.options.backgroundColor);
        this.webView!.set_background_color(rgba);
      } catch { /* best-effort */ }
    }

    this._contentBox = new _Gtk.Box({ orientation: _Gtk.Orientation.VERTICAL, spacing: 0 }) as Gtk.Box;
    this.win.set_child(this._contentBox);

    this.webView!.set_hexpand(true);
    this.webView!.set_vexpand(true);
    this._contentBox.append(this.webView!);

    if (this._pendingMenu !== null) {
      this._applyMenu(this._pendingMenu);
      this._pendingMenu = null;
    }

    this._nwwPushFn = (id: string, args: unknown[]) => this._pushNwwCallback(id, args);
    addNwwCallbackPusher(this._nwwPushFn);
  }

  /** Connect GTK window signals: close-request, focus, maximize, fullscreen, minimize, resize. */
  private _connectWindowSignals(): void {
    let closeInProgress = false;
    const closeRequestHandler = async () => {
      if (closeInProgress) return;
      closeInProgress = true;
      try {
        const prevented = await (this.onCloseRequest?.() ?? false);
        if (!prevented) {
          this._onWindowClosed();
          if (this.win) try { this.win.destroy(); } catch { /* ignore */ }
        }
      } finally {
        closeInProgress = false;
      }
    };
    (closeRequestHandler as unknown as { __syncReturn?: boolean }).__syncReturn = true;
    this.win!.connect('close-request', closeRequestHandler);

    this.win!.connect('notify::is-active', () => {
      try {
        if (this.win!.is_active) this.onFocus?.();
        else                     this.onBlur?.();
      } catch { /* best-effort */ }
    });

    this.win!.connect('notify::maximized', () => {
      try {
        const isMax: boolean = Boolean(this.win!.is_maximized);
        if (isMax !== this._isMaximized) {
          this._isMaximized = isMax;
          if (isMax) this.onMaximize?.();
          else       this.onUnmaximize?.();
        }
      } catch { /* best-effort */ }
    });

    this.win!.connect('notify::fullscreened', () => {
      try {
        const isFull: boolean = this.win!.fullscreened ?? false;
        if (isFull !== this._isFullScreen) {
          this._isFullScreen = isFull;
          if (isFull) this.onEnterFullScreen?.();
          else        this.onLeaveFullScreen?.();
        }
      } catch { /* best-effort */ }
    });

    try {
      this.win!.connect('notify::suspended', () => {
        try {
          const isSuspended: boolean = (this.win as unknown as { suspended?: boolean }).suspended ?? false;
          if (isSuspended !== this._isMinimized) {
            this._isMinimized = isSuspended;
            if (isSuspended) this.onMinimize?.();
            else             this.onRestore?.();
          }
        } catch { /* best-effort */ }
      });
    } catch { /* notify::suspended not available on this GTK version */ }

    try {
      this.win!.connect('notify::default-width', () => {
        try {
          const w = this.win!.get_width() as number;
          const h = this.win!.get_height() as number;
          this.onResize?.(Math.round(w), Math.round(h));
        } catch { /* best-effort */ }
      });
    } catch { /* best-effort */ }

    if (this.options.autoHideMenuBar) {
      try {
        const keyCtrl = new _Gtk.EventControllerKey() as Gtk.EventControllerKey;
        keyCtrl.connect('key-pressed', (_ctrl: any, keyval: number, _keycode: number, state: number) => {
          // Gdk.ModifierType.MOD1_MASK = Alt, keyval 65513=LeftAlt, 65514=RightAlt
          const isAltAlone = (keyval === 65513 || keyval === 65514) && (state & 0x8) === 0;
          if (isAltAlone && this._menuBar) {
            const visible = this._menuBar.get_visible();
            this._menuBar.set_visible(!visible);
          }
          return false;
        });
        this.win!.add_controller(keyCtrl);
      } catch { /* best-effort */ }
    }
  }

  /** Connect WebView signals: navigation events and title updates. Perform initial navigation. */
  private _connectWebViewSignals(): void {
    this.webView!.connect('load-changed', (_wv: WebKit.WebView, loadEvent: any) => {
      if (loadEvent === 2) {
        try {
          const url: string = this.webView!.get_uri?.() ?? '';
          this._domReadyCallback?.();
          this._navigateCallback?.(url);
        } catch { /* best-effort */ }
      }
      if (loadEvent === 3) {
        this.isWebViewReady = true;
        this._navCompletedCallback?.();
        while (this.navigationQueue.length > 0) {
          const action = this.navigationQueue.shift();
          if (action) action();
        }
      }
    });

    this.webView!.connect('load-failed', (_wv: WebKit.WebView, _loadEvent: any, uri: string, error: any) => {
      try {
        const code: number = error?.code ?? -1;
        const msg: string  = error?.message ?? 'Navigation failed';
        this._navigateFailedCallback?.(code, msg, uri ?? '');
      } catch { /* best-effort */ }
      return false;
    });

    this.webView!.connect('decide-policy', (_wv: WebKit.WebView, decision: any, decisionType: any) => {
      try {
        if (decisionType === 0 && this._willNavigateCallback) {
          const navAction = decision.get_navigation_action?.();
          const request = navAction?.get_request?.();
          const url: string = request?.get_uri?.() ?? '';
          if (url && url !== 'about:blank') {
            this._willNavigateCallback(url);
          }
        }
        decision.use();
      } catch { /* best-effort */ }
      return false;
    });

    this.webView!.connect('notify::title', () => {
      try {
        const pageTitle: string = this.webView!.get_title?.() ?? '';
        if (pageTitle) {
          this.win!.set_title(pageTitle);
          this.onTitleUpdated?.(pageTitle);
        }
      } catch { /* best-effort */ }
    });

    if (this._pendingFilePath) {
      this.webView!.load_uri(pathToFileURL(this._pendingFilePath).href);
      this._pendingFilePath = null;
    } else {
      this.webView!.load_uri('about:blank');
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  public show(): void {
    if (this.win) {
      this._isVisible = true;
      this.win.present();
      this.onShow?.();
    }
  }

  public hide(): void {
    if (this.win) {
      this._isVisible = false;
      this.win.hide();
      this.onHide?.();
    }
  }

  public isVisible(): boolean {
    return this._isVisible && !this.isClosed;
  }

  public isDestroyed(): boolean {
    return this.isClosed;
  }

  public isMinimized(): boolean {
    return this._isMinimized;
  }

  public isMaximized(): boolean {
    if (this.win) {
      try { return Boolean(this.win.is_maximized); } catch { /* ignore */ }
    }
    return this._isMaximized;
  }

  public isFocused(): boolean {
    if (this.win) {
      try { return this.win.is_active as boolean; } catch { /* ignore */ }
    }
    return false;
  }

  private _cleanup(): void {
    if (this._nwwPushFn) {
      removeNwwCallbackPusher(this._nwwPushFn);
      this._nwwPushFn = null;
    }
    for (const p of this._pendingExecs.values()) p.reject(new Error('Window closed'));
    this._pendingExecs.clear();
  }

  private _onWindowClosed(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this._cleanup();
    this.onClosed?.();
  }

  public close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this._isVisible = false;
    this._cleanup();
    if (this.win) {
      try { this.win.destroy(); } catch { /* ignore */ }
    }
    if (this._isTempSession && this._userDataPath) {
      try { fs.rmSync(this._userDataPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
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
    const fileUri = pathToFileURL(absolutePath).href;
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

  public onNavigate(callback: (url: string) => void): void {
    this._navigateCallback = callback;
  }

  public onDomReady(callback: () => void): void {
    this._domReadyCallback = callback;
  }

  public onNavigateFailed(callback: (errorCode: number, errorDescription: string, url: string) => void): void {
    this._navigateFailedCallback = callback;
  }

  public onWillNavigate(callback: (url: string) => void): void {
    this._willNavigateCallback = callback;
  }

  public goBack(): void {
    if (this.webView) try { this.webView.go_back(); } catch { /* ignore */ }
  }

  public goForward(): void {
    if (this.webView) try { this.webView.go_forward(); } catch { /* ignore */ }
  }

  public getURL(): string {
    if (!this.webView) return '';
    try { return (this.webView.get_uri?.() as string) ?? ''; } catch { return ''; }
  }

  public getWebTitle(): string {
    if (!this.webView) return '';
    try { return (this.webView.get_title?.() as string) ?? ''; } catch { return ''; }
  }

  public isLoading(): boolean {
    if (!this.webView) return false;
    try { return this.webView.is_loading as boolean; } catch { return false; }
  }

  // ── IPC & JavaScript execution ─────────────────────────────────────────────

  private _evaluateJs(code: string): void {
    if (!this.webView) return;
    this.webView.evaluate_javascript(code, -1, null, null, null, null);
  }

  private _pushNwwCallback(id: string, args: unknown[]): void {
    const payload = JSON.stringify({ type: 'nwwCallback', id, args });
    this._evaluateJs(
      `window.__ipcDispatch && window.__ipcDispatch(${JSON.stringify(payload)})`,
    );
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
      const handler = (ipcMain as unknown as { handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> }).handlers.get(channel) as
        | ((event: unknown, ...args: unknown[]) => unknown)
        | undefined;
      if (handler) {
        try {
          const result = handler(event, ...args);
          if (result && typeof (result as unknown as { then?: unknown }).then === 'function') {
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

    if (this._menuBar) {
      try { this._contentBox.remove(this._menuBar); } catch { /* ignore */ }
      this._menuBar = null;
    }

    for (const name of this._menuActionNames) {
      try { this.win.remove_action(name); } catch { /* ignore */ }
    }
    this._menuActionNames = [];
    this._menuActions = [];

    if (!items || items.length === 0) return;

    const actions: Array<{ name: string; action: Gio.SimpleAction }> = [];
    const gioMenu = buildGioMenu(items, _Gio, actions, (role) => this._roleAction(role));

    for (const { name, action } of actions) {
      this.win.add_action(action);
      this._menuActionNames.push(name);
      this._menuActions.push(action);
    }

    try {
      this._menuBar = new _Gtk.PopoverMenuBar({ menu_model: gioMenu }) as Gtk.PopoverMenuBar;
      this._contentBox.prepend(this._menuBar);
      // autoHideMenuBar: initially hide; Alt key toggles visibility
      if (this.options.autoHideMenuBar) {
        this._menuBar.set_visible(false);
      }
    } catch (e) {
      console.error('[gjs-gtk4] Failed to create PopoverMenuBar:', e);
    }
  }

  public popupMenu(items: MenuItemOptions[], x?: number, y?: number): void {
    if (!this.win || !items || items.length === 0) return;
    try {
      const actions: Array<{ name: string; action: Gio.SimpleAction }> = [];
      const gioMenu = buildGioMenu(items, _Gio, actions, (role) => this._roleAction(role), 'popup');

      // Register actions temporarily on the window
      const tempNames: string[] = [];
      for (const { name, action } of actions) {
        this.win.add_action(action);
        tempNames.push(name);
      }

      const popover = new _Gtk.PopoverMenu({ menu_model: gioMenu }) as Gtk.PopoverMenu;
      popover.set_parent(this.win);
      popover.set_has_arrow(false);

      if (x !== undefined && y !== undefined) {
        // x/y are screen coordinates; translate to window-relative best-effort
        try {
          const surface = this.win.get_surface?.();
          // On X11 we can compute window origin; on Wayland we just use as-is
          let wx = x, wy = y;
          if (surface && (surface as any).get_origin) {
            let ox = 0, oy = 0;
            try { (surface as any).get_origin(ox, oy); wx = x - ox; wy = y - oy; } catch { /* ignore */ }
          }
          const rect = new _Gdk.Rectangle() as Gdk.Rectangle;
          rect.x = Math.round(wx); rect.y = Math.round(wy);
          rect.width = 1; rect.height = 1;
          popover.set_pointing_to(rect);
        } catch { /* positioning is best-effort */ }
      }

      // Clean up actions and popover when dismissed
      popover.connect('closed', () => {
        try {
          for (const name of tempNames) this.win!.remove_action(name);
        } catch { /* ignore */ }
        try { popover.unparent(); } catch { /* ignore */ }
      });

      popover.popup();
    } catch (e) {
      console.warn('[gjs-gtk4] popupMenu failed:', e);
    }
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

  // ── Window state ───────────────────────────────────────────────────────────

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
    if (flag) this.win.fullscreen();
    else      this.win.unfullscreen();
    this._isFullScreen = flag;
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
  }

  public center(): void {
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
  }

  public setBackgroundColor(color: string): void {
    if (!this.webView) return;
    try {
      const rgba = new _Gdk.RGBA() as Gdk.RGBA;
      rgba.parse(color);
      this.webView.set_background_color(rgba);
    } catch { /* best-effort */ }
  }

  public flashFrame(_flag: boolean): void { /* no-op on GTK */ }

  public getHwnd(): string {
    return '0';
  }

  public setEnabled(flag: boolean): void {
    if (this.win) this.win.set_sensitive(flag);
  }

  // ── Dialogs & capture ──────────────────────────────────────────────────────

  public async capturePage(): Promise<NativeImage> {
    if (!this.webView) return new NativeImage(Buffer.alloc(0));
    return new Promise<NativeImage>((resolve) => {
      try {
        const tmpPath = path.join(os.tmpdir(), `nww-snap-${Date.now()}.png`);
        // WebKitGTK snapshot: region=FULL_DOCUMENT(1), options=NONE(0)
        (this.webView as any).get_snapshot(1, 0, null, (source: any, result: any) => {
          try {
            const surface = source.get_snapshot_finish(result);
            surface.writeToPNG(tmpPath);
            const buf = fs.readFileSync(tmpPath);
            try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
            resolve(new NativeImage(buf));
          } catch {
            resolve(new NativeImage(Buffer.alloc(0)));
          }
        });
      } catch {
        resolve(new NativeImage(Buffer.alloc(0)));
      }
    });
  }

  public showOpenDialog(options: OpenDialogOptions): Promise<string[] | undefined> {
    return showOpenDialog(this.win, options);
  }

  public showSaveDialog(options: SaveDialogOptions): Promise<string | undefined> {
    return showSaveDialog(this.win, options);
  }

  public showMessageBox(options: {
    type?: string;
    title?: string;
    message: string;
    buttons?: string[];
    checkboxLabel?: string;
    checkboxChecked?: boolean;
  }): Promise<{ response: number; checkboxChecked: boolean }> {
    return showMessageBox(this.win, options);
  }
}
