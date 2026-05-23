import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { $, ObjC } from '@devscholar/node-with-jxa';
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
import { handleNwwRequest } from '../../node-integration.js';
import { buildCocoaMenu } from './menu.js';
import {
  showOpenDialog,
  showSaveDialog,
  showMessageBox,
  showOpenDialogSync,
  showSaveDialogSync,
  showMessageBoxSync,
} from './dialogs.js';

let _nextWindowId = 0;

function toNSString(str: string): any {
  return $.NSString.stringWithUTF8String(str);
}

/**
 * JxaCocoaWindow — macOS window provider using AppKit + WKWebView via JXA.
 *
 * Architecture:
 *   Node.js main thread  →  $ proxy IPC  →  JXA host (osascript)
 *   JXA host creates NSWindow + WKWebView, runs NSApplication event loop.
 *   Renderer ↔ Main IPC via WKScriptMessageHandler + evaluateJavaScript.
 */
export class JxaCocoaWindow implements IWindowProvider {
  public options: BrowserWindowOptions;
  public webPreferences: WebPreferences;

  private _id: number;
  private nsWindow: any = null;
  private webView: any = null;
  private nsApp: any = null;
  private _appRunning = false;

  private _isVisible = false;
  private _isClosed = false;
  private _isMinimized = false;
  private _isMaximized = false;
  private _isFullScreen = false;
  private _isKiosk = false;
  private _isResizable = true;
  private _zoomLevel = 1.0;

  private _nwwPushFn: ((id: string, args: unknown[]) => void) | null = null;
  private _pendingMenu: MenuItemOptions[] | null = null;
  private _pendingFilePath: string | null = null;
  private navigationQueue: Array<() => void> = [];
  private _isWebViewReady = false;

  private _navCompletedCallback: (() => void) | null = null;
  private _navigateCallback: ((url: string) => void) | null = null;
  private _domReadyCallback: (() => void) | null = null;
  private _navigateFailedCallback:
    | ((errorCode: number, errorDescription: string, url: string) => void)
    | null = null;
  private _willNavigateCallback: ((url: string) => void) | null = null;

  private _pendingExecs = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  // Strong refs to delegate proxies so JXA doesn't GC them
  private _delegates: any[] = [];

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
    this._id = ++_nextWindowId;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  public async createWindow(): Promise<void> {
    ObjC.import('AppKit');
    ObjC.import('WebKit');

    this.nsApp = $.NSApplication.sharedApplication;
    this.nsApp.setActivationPolicy($.NSApplicationActivationPolicyRegular);

    // App delegate: quit when last window closes
    this._setupAppDelegate();

    // Style mask
    let styleMask =
      Number($.NSWindowStyleMaskTitled) |
      Number($.NSWindowStyleMaskClosable) |
      Number($.NSWindowStyleMaskResizable) |
      Number($.NSWindowStyleMaskMiniaturizable);

    const needFrameless =
      this.options.frame === false ||
      this.options.transparent ||
      this.options.titleBarStyle === 'hidden' ||
      this.options.titleBarStyle === 'hiddenInset';
    if (needFrameless) {
      styleMask |= Number($.NSWindowStyleMaskFullSizeContentView);
    }

    const rect = $.NSMakeRect(
      this.options.x ?? 200,
      this.options.y ?? 200,
      this.options.width ?? 800,
      this.options.height ?? 600,
    );
    this.nsWindow =
      $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
        rect,
        styleMask,
        Number($.NSBackingStoreBuffered),
        false,
      );

    this.nsWindow.setTitle(
      toNSString(this.options.title || 'node-with-window'),
    );

    if (!this._isResizable)
      this.nsWindow.setStyleMask(
        styleMask & ~Number($.NSWindowStyleMaskResizable),
      );

    if (this.options.minWidth || this.options.minHeight) {
      const minSize = $.NSSize;
      minSize.width = this.options.minWidth ?? 0;
      minSize.height = this.options.minHeight ?? 0;
      this.nsWindow.setMinSize(minSize);
    }

    if (this.options.maxWidth || this.options.maxHeight) {
      const maxSize = $.NSSize;
      maxSize.width = this.options.maxWidth ?? 99999;
      maxSize.height = this.options.maxHeight ?? 99999;
      this.nsWindow.setMaxSize(maxSize);
    }

    // Transparency / background color
    if (this.options.transparent) {
      this.nsWindow.setOpaque(false);
      this.nsWindow.setBackgroundColor($.NSColor.clearColor);
    } else if (this.options.backgroundColor) {
      const color = this._parseColor(this.options.backgroundColor);
      if (color) this.nsWindow.setBackgroundColor(color);
    }

    // Fullscreen / always on top
    if (this.options.fullscreen) {
      this.nsWindow.toggleFullScreen(null);
    }
    if (this.options.alwaysOnTop) {
      this.nsWindow.setLevel(Number($.NSFloatingWindowLevel));
    }

    // WKWebView setup
    this._setupWebView();

    // Delegates
    this._setupWindowDelegate();
    this._setupNavDelegate();

    // Assemble
    this.nsWindow.contentView.addSubview(this.webView);

    // Initial navigation
    if (this._pendingFilePath) {
      this.loadFile(this._pendingFilePath);
      this._pendingFilePath = null;
    }

    // Menu
    if (this._pendingMenu !== null) {
      this._applyMenu(this._pendingMenu);
      this._pendingMenu = null;
    }

    // NWW callback pusher
    this._nwwPushFn = (id: string, args: unknown[]) =>
      this._pushNwwCallback(id, args);
    addNwwCallbackPusher(this._nwwPushFn);

    return Promise.resolve();
  }

  // ── App delegate ───────────────────────────────────────────────────────────

  private _setupAppDelegate(): void {
    const impl = () => {
      // Quit when last window closes
      return true;
    };
    (impl as any).__nww_syncReturn = true;

    ObjC.registerSubclass({
      name: 'NwjxaAppDelegate',
      superclass: 'NSObject',
      methods: {
        'applicationShouldTerminateAfterLastWindowClosed:': {
          types: ['bool', ['id']],
          implementation: impl,
        },
      },
    });
    const delegate = $.NwjxaAppDelegate.alloc.init;
    this.nsApp.setDelegate(delegate);
    this._delegates.push(delegate);
  }

  // ── WebView setup ──────────────────────────────────────────────────────────

  private _setupWebView(): void {
    const config = $.WKWebViewConfiguration.alloc.init;
    const userContent = $.WKUserContentController.alloc.init;

    // Register nww:// custom scheme handler for nodeIntegration
    this._registerNwwSchemeHandler(config);

    // IPC handler
    const handlerName = `NwjxaIpcHandler_${this._id}`;

    const handlerImpl = (_controller: any, message: any) => {
      try {
        const body = ObjC.unwrap(message.body) as string;
        this._handleIpcMessage(body);
      } catch (e) {
        console.error('[jxa-cocoa] IPC handler error:', e);
      }
    };
    (handlerImpl as any).__nww_syncReturn = null;

    ObjC.registerSubclass({
      name: handlerName,
      superclass: 'NSObject',
      methods: {
        'userContentController:didReceiveScriptMessage:': {
          types: ['void', ['id', 'id']],
          implementation: handlerImpl,
        },
      },
    });
    const ipcHandler = $[handlerName].alloc.init;
    userContent.addScriptMessageHandlerName(ipcHandler, toNSString('ipc'));
    this._delegates.push(ipcHandler);

    config.setUserContentController(userContent);

    this.webView = $.WKWebView.alloc.initWithFrameConfiguration(
      this.nsWindow.contentView.bounds,
      config,
    );
    this.webView.setAutoresizingMask(
      Number($.NSViewWidthSizable) | Number($.NSViewHeightSizable),
    );

    // Bridge script injection
    let bridgeScript = generateBridgeScript(this.webPreferences);

    // Preload script
    if (this.webPreferences.preload) {
      const absPreload = path.isAbsolute(this.webPreferences.preload)
        ? this.webPreferences.preload
        : path.resolve(process.cwd(), this.webPreferences.preload);
      try {
        const fs = require('node:fs');
        bridgeScript += '\n' + fs.readFileSync(absPreload, 'utf-8');
        if (this.webPreferences.contextIsolation === true) {
          bridgeScript +=
            '\n(function(){' +
            'window.ipcRenderer=undefined;' +
            'window.contextBridge=undefined;' +
            '})();';
        }
      } catch (e) {
        console.error(
          `[jxa-cocoa] Failed to load preload script "${absPreload}":`,
          e,
        );
      }
    }

    const userScript = $.WKUserScript.alloc.initWithSourceInjectionTimeForMainFrameOnly(
      toNSString(bridgeScript),
      0, // WKUserScriptInjectionTimeAtDocumentStart
      false,
    );
    userContent.addUserScript(userScript);
  }

  /** Register a WKURLSchemeHandler for the nww:// custom scheme.
   *  This is the JXA equivalent of WebKitGTK's register_uri_scheme.
   *  Without it, require(), ipcRenderer.sendSync(), and ref-based callbacks
   *  in the renderer do not work. */
  private _registerNwwSchemeHandler(config: any): void {
    const schemeHandlerName = `NwjxaSchemeHandler_${this._id}`;

    const startTaskImpl = (_webView: any, task: any) => {
      try {
        const request = task.request;
        const url: string = ObjC.unwrap(request.URL.absoluteString) || '';
        const method: string = ObjC.unwrap(request.HTTPMethod) || 'GET';

        let body: string | null = null;
        if (method === 'POST') {
          const bodyData = request.HTTPBody;
          if (bodyData) {
            body =
              (ObjC.unwrap(
                $.NSString.alloc.initWithDataEncoding(bodyData, 4 /* NSUTF8StringEncoding */),
              ) as string) || null;
          }
        }

        const result = handleNwwRequest(url, method, body);

        if (result.status === 204) {
          const response =
            $.NSURLResponse.alloc.initWithURLMIMETypeExpectedContentLengthTextEncodingName(
              request.URL,
              toNSString('application/json'),
              0,
              null,
            );
          task.didReceiveResponse(response);
          task.didFinish();
        } else {
          const nsBody = toNSString(result.body);
          const data = nsBody.dataUsingEncoding(4 /* NSUTF8StringEncoding */);
          const response =
            $.NSURLResponse.alloc.initWithURLMIMETypeExpectedContentLengthTextEncodingName(
              request.URL,
              toNSString(result.mimeType),
              Number(data.length),
              null,
            );
          task.didReceiveResponse(response);
          task.didReceiveData(data);
          task.didFinish();
        }
      } catch (e) {
        console.error('[jxa-cocoa] nww scheme handler error:', e);
        try {
          const errMsg = toNSString(
            (e as Error).message || 'Scheme handler error',
          );
          const err = $.NSError.alloc.initWithDomainCodeUserInfo(
            toNSString('NwjxaSchemeHandler'),
            -1,
            $.NSDictionary.dictionaryWithObjectForKey(
              errMsg,
              $.NSLocalizedDescriptionKey,
            ),
          );
          task.didFailWithError(err);
        } catch {
          /* best-effort */ }
      }
    };
    (startTaskImpl as any).__nww_syncReturn = null;

    const stopTaskImpl = (_webView: any, _task: any) => {
      // No-op: nww:// requests are handled synchronously
    };
    (stopTaskImpl as any).__nww_syncReturn = null;

    ObjC.registerSubclass({
      name: schemeHandlerName,
      superclass: 'NSObject',
      protocols: ['WKURLSchemeHandler'],
      methods: {
        'webView:startURLSchemeTask:': {
          types: ['void', ['id', 'id']],
          implementation: startTaskImpl,
        },
        'webView:stopURLSchemeTask:': {
          types: ['void', ['id', 'id']],
          implementation: stopTaskImpl,
        },
      },
    });

    const schemeHandler = $[schemeHandlerName].alloc.init;
    config.setURLSchemeHandlerForURLScheme(
      schemeHandler,
      toNSString('nww'),
    );
    this._delegates.push(schemeHandler);
  }

  // ── Window delegate ────────────────────────────────────────────────────────

  private _setupWindowDelegate(): void {
    const winRef = this;
    const delegateName = `NwjxaWindowDelegate_${this._id}`;

    const willClose = () => {
      winRef._onWindowClosed();
    };
    (willClose as any).__nww_syncReturn = null;

    const didBecomeKey = () => {
      winRef.onFocus?.();
    };
    (didBecomeKey as any).__nww_syncReturn = null;

    const didResignKey = () => {
      winRef.onBlur?.();
    };
    (didResignKey as any).__nww_syncReturn = null;

    const didResize = () => {
      try {
        const frame = winRef.nsWindow.frame;
        const w = Number(frame.size.width);
        const h = Number(frame.size.height);
        winRef.onResize?.(Math.round(w), Math.round(h));
      } catch {
        /* ignore */ }
    };
    (didResize as any).__nww_syncReturn = null;

    const didMiniaturize = () => {
      winRef._isMinimized = true;
      winRef.onMinimize?.();
    };
    (didMiniaturize as any).__nww_syncReturn = null;

    const didDeminiaturize = () => {
      winRef._isMinimized = false;
      winRef.onRestore?.();
    };
    (didDeminiaturize as any).__nww_syncReturn = null;

    const didEnterFullScreen = () => {
      winRef._isFullScreen = true;
      winRef.onEnterFullScreen?.();
    };
    (didEnterFullScreen as any).__nww_syncReturn = null;

    const didExitFullScreen = () => {
      winRef._isFullScreen = false;
      winRef.onLeaveFullScreen?.();
    };
    (didExitFullScreen as any).__nww_syncReturn = null;

    const didMove = () => {
      try {
        const pos = winRef.getPosition();
        winRef.onMove?.(pos[0], pos[1]);
      } catch {
        /* ignore */ }
    };
    (didMove as any).__nww_syncReturn = null;

    ObjC.registerSubclass({
      name: delegateName,
      superclass: 'NSObject',
      methods: {
        'windowWillClose:': { types: ['void', ['id']], implementation: willClose },
        'windowDidBecomeKey:': {
          types: ['void', ['id']],
          implementation: didBecomeKey,
        },
        'windowDidResignKey:': {
          types: ['void', ['id']],
          implementation: didResignKey,
        },
        'windowDidResize:': { types: ['void', ['id']], implementation: didResize },
        'windowDidMiniaturize:': {
          types: ['void', ['id']],
          implementation: didMiniaturize,
        },
        'windowDidDeminiaturize:': {
          types: ['void', ['id']],
          implementation: didDeminiaturize,
        },
        'windowDidEnterFullScreen:': {
          types: ['void', ['id']],
          implementation: didEnterFullScreen,
        },
        'windowDidExitFullScreen:': {
          types: ['void', ['id']],
          implementation: didExitFullScreen,
        },
        'windowDidMove:': { types: ['void', ['id']], implementation: didMove },
      },
    });
    const delegate = $[delegateName].alloc.init;
    this.nsWindow.setDelegate(delegate);
    this._delegates.push(delegate);
  }

  // ── Navigation delegate ────────────────────────────────────────────────────

  private _setupNavDelegate(): void {
    const winRef = this;
    const delegateName = `NwjxaNavDelegate_${this._id}`;

    const didFinish = () => {
      winRef._isWebViewReady = true;
      winRef._navCompletedCallback?.();
      while (winRef.navigationQueue.length > 0) {
        const action = winRef.navigationQueue.shift();
        if (action) action();
      }
    };
    (didFinish as any).__nww_syncReturn = null;

    const didFail = (_webView: any, _navigation: any, error: any) => {
      try {
        const code = Number(error.code) || -1;
        const msg =
          (ObjC.unwrap(error.localizedDescription) as string) ||
          'Navigation failed';
        const url = '';
        winRef._navigateFailedCallback?.(code, msg, url);
      } catch {
        /* ignore */ }
    };
    (didFail as any).__nww_syncReturn = null;

    const didCommit = () => {
      try {
        const url =
          (ObjC.unwrap(winRef.webView.URL?.absoluteString) as string) || '';
        winRef._domReadyCallback?.();
        winRef._navigateCallback?.(url);
      } catch {
        /* ignore */ }
    };
    (didCommit as any).__nww_syncReturn = null;

    const decidePolicy = (
      _webView: any,
      navAction: any,
      decisionHandler: any,
    ) => {
      try {
        if (winRef._willNavigateCallback) {
          const url =
            (ObjC.unwrap(navAction.request.URL.absoluteString) as string) || '';
          if (url && url !== 'about:blank') {
            winRef._willNavigateCallback(url);
          }
        }
        decisionHandler(0); // WKNavigationActionPolicyAllow = 0
      } catch {
        decisionHandler(0);
      }
    };
    (decidePolicy as any).__nww_syncReturn = null;

    ObjC.registerSubclass({
      name: delegateName,
      superclass: 'NSObject',
      methods: {
        'webView:didFinishNavigation:': {
          types: ['void', ['id', 'id']],
          implementation: didFinish,
        },
        'webView:didFailNavigation:withError:': {
          types: ['void', ['id', 'id', 'id']],
          implementation: didFail,
        },
        'webView:didCommitNavigation:': {
          types: ['void', ['id', 'id']],
          implementation: didCommit,
        },
        'webView:decidePolicyForNavigationAction:decisionHandler:': {
          types: ['void', ['id', 'id', 'id']],
          implementation: decidePolicy,
        },
      },
    });
    const delegate = $[delegateName].alloc.init;
    this.webView.setNavigationDelegate(delegate);
    this._delegates.push(delegate);
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private _onWindowClosed(): void {
    if (this._isClosed) return;
    this._isClosed = true;
    this._isVisible = false;
    this._cleanup();
    this.onClosed?.();
  }

  private _cleanup(): void {
    if (this._nwwPushFn) {
      removeNwwCallbackPusher(this._nwwPushFn);
      this._nwwPushFn = null;
    }
    for (const p of this._pendingExecs.values())
      p.reject(new Error('Window closed'));
    this._pendingExecs.clear();
  }

  // ── Show / Hide / Close ────────────────────────────────────────────────────

  public show(): void {
    if (this.nsWindow) {
      this.nsWindow.makeKeyAndOrderFront(null);
      this.nsApp.activateIgnoringOtherApps(true);
      this._isVisible = true;
      this.onShow?.();
    }
    if (!this._appRunning) {
      this._appRunning = true;
      // Triggers node-with-jxa's StartApp → refForApp() + startPolling()
      this.nsApp.run();
    }
  }

  public hide(): void {
    if (this.nsWindow) {
      this.nsWindow.orderOut(null);
      this._isVisible = false;
      this.onHide?.();
    }
  }

  public isVisible(): boolean {
    return this._isVisible && !this._isClosed;
  }

  public isDestroyed(): boolean {
    return this._isClosed;
  }

  public isMinimized(): boolean {
    return this._isMinimized;
  }

  public isMaximized(): boolean {
    if (this.nsWindow) {
      try {
        return Boolean(this.nsWindow.isZoomed);
      } catch {
        /* ignore */ }
    }
    return this._isMaximized;
  }

  public isFocused(): boolean {
    if (this.nsWindow) {
      try {
        return this.nsWindow.isKeyWindow;
      } catch {
        /* ignore */ }
    }
    return false;
  }

  public close(): void {
    if (this._isClosed) return;
    this._isClosed = true;
    this._isVisible = false;
    this._cleanup();
    if (this.nsWindow) {
      try {
        this.nsWindow.close();
      } catch {
        /* ignore */ }
    }
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  public async loadURL(url: string): Promise<void> {
    if (!this.webView) {
      this.navigationQueue.push(() => this.loadURL(url));
      return;
    }
    const nsUrl = $.NSURL.URLWithString(toNSString(url));
    const req = $.NSURLRequest.requestWithURL(nsUrl);
    this.webView.loadRequest(req);
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
    const nsUrl = $.NSURL.URLWithString(toNSString(fileUri));
    const req = $.NSURLRequest.requestWithURL(nsUrl);
    this.webView.loadRequest(req);
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

  public onNavigateFailed(
    callback: (errorCode: number, errorDescription: string, url: string) => void,
  ): void {
    this._navigateFailedCallback = callback;
  }

  public onWillNavigate(callback: (url: string) => void): void {
    this._willNavigateCallback = callback;
  }

  public goBack(): void {
    if (this.webView)
      try {
        this.webView.goBack();
      } catch {
        /* ignore */ }
  }

  public goForward(): void {
    if (this.webView)
      try {
        this.webView.goForward();
      } catch {
        /* ignore */ }
  }

  public getURL(): string {
    if (!this.webView) return '';
    try {
      return (ObjC.unwrap(this.webView.URL?.absoluteString) as string) || '';
    } catch {
      return '';
    }
  }

  public getWebTitle(): string {
    if (!this.webView) return '';
    try {
      return (ObjC.unwrap(this.webView.title) as string) || '';
    } catch {
      return '';
    }
  }

  public isLoading(): boolean {
    if (!this.webView) return false;
    try {
      return this.webView.isLoading as boolean;
    } catch {
      return false;
    }
  }

  // ── IPC & JavaScript execution ─────────────────────────────────────────────

  private _evaluateJs(code: string): void {
    if (!this.webView) return;
    this.webView.evaluateJavaScript_completionHandler(
      toNSString(code),
      null,
    );
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
      `window.__ipcDispatch && window.__ipcDispatch(${JSON.stringify(payload)})`,
    );
  }

  public sendIpcReply(
    id: string,
    result: unknown,
    error: string | null,
  ): void {
    const payload = JSON.stringify({ type: 'reply', id, result, error });
    this._evaluateJs(
      `window.__ipcDispatch && window.__ipcDispatch(${JSON.stringify(payload)})`,
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
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
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
    try {
      message = JSON.parse(json);
    } catch {
      return;
    }

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
      const handler = (
        ipcMain as unknown as {
          handlers: Map<
            string,
            (event: unknown, ...a: unknown[]) => unknown
          >;
        }
      ).handlers.get(channel) as
        | ((event: unknown, ...a: unknown[]) => unknown)
        | undefined;
      if (handler) {
        try {
          const result = handler(event, ...args);
          if (
            result &&
            typeof (result as Promise<unknown>).then === 'function'
          ) {
            (result as Promise<unknown>)
              .then(r => this.sendIpcReply(id, r, null))
              .catch(err =>
                this.sendIpcReply(
                  id,
                  null,
                  (err as Error).message || String(err),
                ),
              );
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
      const inspector = this.webView._inspector;
      if (inspector) inspector.show();
    } catch {
      /* best-effort */ }
  }

  // ── Menu ───────────────────────────────────────────────────────────────────

  public setMenu(menu: MenuItemOptions[]): void {
    if (!this.nsWindow) {
      this._pendingMenu = menu;
      return;
    }
    this._applyMenu(menu);
  }

  private _applyMenu(items: MenuItemOptions[]): void {
    if (!this.nsApp) return;
    if (!items || items.length === 0) {
      this.nsApp.setMainMenu(null);
      return;
    }
    const menu = buildCocoaMenu(items, (role) => this._roleAction(role));
    this.nsApp.setMainMenu(menu);
  }

  /** Pop up a context menu.  x/y are screen coordinates (Electron convention:
   *  top-left origin).  When omitted the menu appears at the current mouse
   *  location.  Mirrors the GJS backend's popupMenu via Gtk.PopoverMenu. */
  public popupMenu(items: MenuItemOptions[], x?: number, y?: number): void {
    if (!this.webView || !items || items.length === 0) return;
    try {
      const menu = buildCocoaMenu(items, (role) => this._roleAction(role));

      let point: any;
      if (x !== undefined && y !== undefined) {
        // Convert Electron (top-left) coordinates → Cocoa (bottom-left)
        const screen = this.nsWindow.screen;
        const screenFrame = screen.frame;
        const screenHeight = Number(screenFrame.size.height);
        const cocoaY = screenHeight - y;
        point = $.NSMakePoint(x, cocoaY);
      } else {
        point = $.NSEvent.mouseLocation;
      }

      menu.popUpMenuPositioningItemAtLocationInView(
        null,
        point,
        this.webView,
      );
    } catch (e) {
      console.warn('[jxa-cocoa] popupMenu failed:', e);
    }
  }

  private _roleAction(
    role: string,
  ): (() => void) | undefined {
    switch (role) {
      case 'close':
        return () => this.close();
      case 'minimize':
        return () => this.minimize();
      case 'reload':
      case 'forceReload':
        return () => this.reload();
      case 'toggleDevTools':
        return () => this.openDevTools();
      case 'togglefullscreen':
        return () => this.setFullScreen(!this.isFullScreen());
      case 'resetZoom':
        return () => {
          this._zoomLevel = 1.0;
          this.webView?.setMagnification(1.0);
        };
      case 'zoomIn':
        return () => {
          this._zoomLevel = Math.min(this._zoomLevel + 0.1, 5.0);
          this.webView?.setMagnification(this._zoomLevel);
        };
      case 'zoomOut':
        return () => {
          this._zoomLevel = Math.max(this._zoomLevel - 0.1, 0.25);
          this.webView?.setMagnification(this._zoomLevel);
        };
      case 'undo':
        return () => this._evaluateJs("document.execCommand('undo')");
      case 'redo':
        return () => this._evaluateJs("document.execCommand('redo')");
      case 'cut':
        return () => this._evaluateJs("document.execCommand('cut')");
      case 'copy':
        return () => this._evaluateJs("document.execCommand('copy')");
      case 'paste':
        return () => this._evaluateJs("document.execCommand('paste')");
      case 'selectAll':
        return () => this._evaluateJs("document.execCommand('selectAll')");
      default:
        return undefined;
    }
  }

  // ── Window state ───────────────────────────────────────────────────────────

  public focus(): void {
    if (this.nsWindow) {
      this.nsWindow.makeKeyAndOrderFront(null);
      this.nsApp?.activateIgnoringOtherApps(true);
    }
  }

  public blur(): void {
    if (this.nsWindow) {
      try {
        this.nsWindow.resignKeyWindow();
      } catch {
        /* ignore */ }
    }
  }

  public minimize(): void {
    if (this.nsWindow) {
      this.nsWindow.miniaturize(null);
      this._isMinimized = true;
    }
  }

  public maximize(): void {
    if (this.nsWindow) {
      this.nsWindow.zoom(null);
      this._isMaximized = true;
    }
  }

  public unmaximize(): void {
    if (this.nsWindow) {
      this.nsWindow.zoom(null);
      this._isMaximized = false;
    }
  }

  public setFullScreen(flag: boolean): void {
    if (!this.nsWindow) return;
    const current = this._isFullScreen;
    if (flag !== current) {
      this.nsWindow.toggleFullScreen(null);
    }
  }

  public isFullScreen(): boolean {
    return this._isFullScreen;
  }

  public setKiosk(flag: boolean): void {
    this._isKiosk = flag;
    this.setFullScreen(flag);
    if (this.nsWindow) {
      if (flag) {
        this.nsWindow.setLevel(Number($.NSMainMenuWindowLevel) + 1);
      } else {
        this.nsWindow.setLevel(Number($.NSNormalWindowLevel));
      }
    }
  }

  public isKiosk(): boolean {
    return this._isKiosk;
  }

  public setTitle(title: string): void {
    if (this.nsWindow) this.nsWindow.setTitle(toNSString(title));
  }

  public getTitle(): string {
    if (this.nsWindow) {
      try {
        return (ObjC.unwrap(this.nsWindow.title) as string) || '';
      } catch {
        /* ignore */ }
    }
    return this.options.title ?? '';
  }

  public setSize(width: number, height: number): void {
    if (this.nsWindow) {
      const frame = this.nsWindow.frame;
      const newFrame = $.NSMakeRect(
        Number(frame.origin.x),
        Number(frame.origin.y),
        width,
        height,
      );
      this.nsWindow.setFrameDisplay(newFrame, true);
    }
  }

  public getSize(): [number, number] {
    if (!this.nsWindow)
      return [this.options.width ?? 0, this.options.height ?? 0];
    try {
      const frame = this.nsWindow.frame;
      return [
        Math.round(Number(frame.size.width)),
        Math.round(Number(frame.size.height)),
      ];
    } catch {
      return [this.options.width ?? 0, this.options.height ?? 0];
    }
  }

  public setPosition(x: number, y: number): void {
    if (!this.nsWindow) return;
    try {
      const frame = this.nsWindow.frame;
      const w = Number(frame.size.width);
      const h = Number(frame.size.height);
      const screen = this.nsWindow.screen;
      const screenFrame = screen.frame;
      const screenHeight = Number(screenFrame.size.height);
      const cocoaY = screenHeight - y - h;
      const rect = $.NSMakeRect(x, cocoaY, w, h);
      this.nsWindow.setFrameDisplay(rect, true);
    } catch {
      /* ignore */ }
  }

  public getPosition(): [number, number] {
    if (!this.nsWindow) return [0, 0];
    try {
      const frame = this.nsWindow.frame;
      const x = Number(frame.origin.x);
      const y = Number(frame.origin.y);
      const h = Number(frame.size.height);
      const screen = this.nsWindow.screen;
      const screenFrame = screen.frame;
      const screenHeight = Number(screenFrame.size.height);
      return [Math.round(x), Math.round(screenHeight - y - h)];
    } catch {
      return [0, 0];
    }
  }

  public setResizable(resizable: boolean): void {
    this._isResizable = resizable;
    if (this.nsWindow) {
      const currentMask = Number(this.nsWindow.styleMask);
      if (resizable) {
        this.nsWindow.setStyleMask(
          currentMask | Number($.NSWindowStyleMaskResizable),
        );
      } else {
        this.nsWindow.setStyleMask(
          currentMask & ~Number($.NSWindowStyleMaskResizable),
        );
      }
    }
  }

  public isResizable(): boolean {
    return this._isResizable;
  }

  public setAlwaysOnTop(flag: boolean): void {
    if (this.nsWindow) {
      this.nsWindow.setLevel(
        flag
          ? Number($.NSFloatingWindowLevel)
          : Number($.NSNormalWindowLevel),
      );
    }
  }

  public center(): void {
    if (this.nsWindow) this.nsWindow.center();
  }

  public flashFrame(flag: boolean): void {
    if (this.nsWindow) {
      try {
        this.nsWindow.dockTile.badgeLabel = flag ? ' ' : '';
      } catch {
        /* ignore */ }
    }
  }

  public setOpacity(opacity: number): void {
    if (this.nsWindow) this.nsWindow.setAlphaValue(opacity);
  }

  public getOpacity(): number {
    if (this.nsWindow) {
      try {
        return Number(this.nsWindow.alphaValue);
      } catch {
        /* ignore */ }
    }
    return 1;
  }

  public setMinimumSize(width: number, height: number): void {
    if (this.nsWindow) {
      this.nsWindow.setMinSize($.NSMakeSize(width, height));
    }
  }

  public setMaximumSize(width: number, height: number): void {
    if (this.nsWindow) {
      this.nsWindow.setMaxSize($.NSMakeSize(width, height));
    }
  }

  public setBackgroundColor(color: string): void {
    if (!this.webView) return;
    const nsColor = this._parseColor(color);
    if (nsColor) {
      try {
        this.webView.setValueForKey(nsColor, toNSString('backgroundColor'));
      } catch {
        /* best-effort */ }
    }
  }

  private _parseColor(color: string): any | null {
    try {
      let hex = color.replace('#', '');
      if (hex.length === 3) {
        hex = hex
          .split('')
          .map(c => c + c)
          .join('');
      }
      let r = 0,
        g = 0,
        b = 0,
        a = 1;
      if (hex.length === 6) {
        r = parseInt(hex.slice(0, 2), 16) / 255;
        g = parseInt(hex.slice(2, 4), 16) / 255;
        b = parseInt(hex.slice(4, 6), 16) / 255;
      } else if (hex.length === 8) {
        a = parseInt(hex.slice(0, 2), 16) / 255;
        r = parseInt(hex.slice(2, 4), 16) / 255;
        g = parseInt(hex.slice(4, 6), 16) / 255;
        b = parseInt(hex.slice(6, 8), 16) / 255;
      }
      return $.NSColor.colorWithSRGBRedGreenBlueAlpha(r, g, b, a);
    } catch {
      return null;
    }
  }

  public getHwnd(): string {
    return '0';
  }

  public setEnabled(_flag: boolean): void {
    // Cocoa has no direct window-level setEnabled; modal blocking is handled
    // via NSApplication's modal window stack. No-op for MVP.
  }

  // ── Capture page ──────────────────────────────────────────────────────────

  public async capturePage(): Promise<NativeImage> {
    if (!this.webView) return new NativeImage(Buffer.alloc(0));

    return new Promise<NativeImage>(resolve => {
      try {
        const config = $.WKSnapshotConfiguration.alloc.init;
        // snapshot the full viewport
        const handler = (image: any, error: any) => {
          try {
            if (error) {
              console.warn(
                '[jxa-cocoa] capturePage error:',
                ObjC.unwrap(error.localizedDescription),
              );
              resolve(new NativeImage(Buffer.alloc(0)));
              return;
            }
            if (!image) {
              resolve(new NativeImage(Buffer.alloc(0)));
              return;
            }
            image.lockFocus();
            const bitmap =
              $.NSBitmapImageRep.alloc.initWithFocusedViewRect(
                $.NSMakeRect(0, 0, image.size.width, image.size.height),
              );
            image.unlockFocus();

            const pngData = bitmap.representationUsingTypeProperties(
              $.NSBitmapImageFileTypePNG,
              null,
            );
            if (!pngData) {
              resolve(new NativeImage(Buffer.alloc(0)));
              return;
            }
            const len = Number(pngData.length);
            const buf = Buffer.alloc(len);
            const bytes = pngData.bytes;
            for (let i = 0; i < len; i++) {
              buf[i] = Number(bytes[i]);
            }
            resolve(new NativeImage(buf));
          } catch (e) {
            console.warn('[jxa-cocoa] capturePage handler error:', e);
            resolve(new NativeImage(Buffer.alloc(0)));
          }
        };

        this.webView.takeSnapshotWithConfigurationCompletionHandler(
          config,
          handler,
        );
      } catch (e) {
        console.warn('[jxa-cocoa] capturePage failed:', e);
        resolve(new NativeImage(Buffer.alloc(0)));
      }
    });
  }

  // ── Dialogs ────────────────────────────────────────────────────────────────

  public showOpenDialog(
    options: OpenDialogOptions,
  ): Promise<string[] | undefined> {
    return showOpenDialog(this.nsWindow, options);
  }

  public showSaveDialog(
    options: SaveDialogOptions,
  ): Promise<string | undefined> {
    return showSaveDialog(this.nsWindow, options);
  }

  public showMessageBox(options: {
    type?: string;
    title?: string;
    message: string;
    buttons?: string[];
    checkboxLabel?: string;
    checkboxChecked?: boolean;
  }): Promise<{ response: number; checkboxChecked: boolean }> {
    return showMessageBox(this.nsWindow, options);
  }

  public showOpenDialogSync(
    options: OpenDialogOptions,
  ): string[] | undefined {
    return showOpenDialogSync(this.nsWindow, options);
  }

  public showSaveDialogSync(
    options: SaveDialogOptions,
  ): string | undefined {
    return showSaveDialogSync(this.nsWindow, options);
  }

  public showMessageBoxSync(options: {
    type?: string;
    title?: string;
    message: string;
    buttons?: string[];
  }): number {
    return showMessageBoxSync(this.nsWindow, options);
  }
}
