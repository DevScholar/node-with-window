import * as path from 'node:path';
import * as fs from 'node:fs';
import { WebPreferences } from '../../interfaces.js';
import { ipcMain } from '../../ipc-main.js';
import { generateBridgeScript } from './bridge.js';
import { addNwwCallbackPusher, removeNwwCallbackPusher } from '../../node-integration.js';

/**
 * Owns the WebView2 IPC channel for one window: bridge script injection,
 * WebMessageReceived dispatch, executeJavaScript, and send/reply helpers.
 *
 * Uses lazy getters so it can be constructed before coreWebView2 exists.
 * Call setup() once inside add_CoreWebView2InitializationCompleted.
 * Call cleanup() when the window closes.
 */
export class WpfIpcBridge {
  private _pendingExecs = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private _navCompletedCallback: (() => void) | null = null;
  private _nwwPushFn: ((id: string, args: unknown[]) => void) | null = null;

  constructor(
    private readonly getCoreWebView2: () => unknown,
    private readonly getBrowserWindow: () => unknown,
    private readonly getDotnet: () => any,
    private readonly webPreferences: WebPreferences,
    /** The IWindowProvider instance — passed as event.sender to ipcMain handlers. */
    private readonly getWindowSender: () => unknown,
  ) {}

  /**
   * Injects the bridge script, wires document-title sync, WebMessageReceived
   * dispatch, and (if registered) NavigationCompleted.
   * @param pendingAbsFilePath Absolute file:// path to navigate to after script
   *   registration, or null to skip navigation (loadURL handles it separately).
   */
  public setup(pendingAbsFilePath: string | null): void {
    const coreWebView2 = this.getCoreWebView2();
    const dotnetAny = this.getDotnet();
    const handlers = (ipcMain as any).handlers as Map<
      string,
      (event: unknown, ...args: unknown[]) => unknown
    >;

    // ── Bridge + preload script ────────────────────────────────────────────────
    let bridgeScript = generateBridgeScript(this.webPreferences);
    const preloadPath = this.webPreferences.preload;
    if (preloadPath) {
      const absPreload = path.isAbsolute(preloadPath)
        ? preloadPath
        : path.resolve(process.cwd(), preloadPath);
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
        console.error('[node-with-window] Failed to load preload script:', e);
      }
    }

    if (pendingAbsFilePath) {
      const fileUri = 'file:///' + pendingAbsFilePath.replace(/\\/g, '/');
      dotnetAny.addScriptAndNavigate(coreWebView2, bridgeScript, fileUri);
    } else {
      (
        coreWebView2 as unknown as {
          AddScriptToExecuteOnDocumentCreatedAsync: (s: string) => unknown;
        }
      ).AddScriptToExecuteOnDocumentCreatedAsync(bridgeScript);
    }

    // ── Register nww callback pusher ───────────────────────────────────────────
    this._nwwPushFn = (id: string, args: unknown[]) => this.pushNwwCallback(id, args);
    addNwwCallbackPusher(this._nwwPushFn);

    // ── Document title → WPF window title sync ─────────────────────────────────
    (
      coreWebView2 as unknown as {
        add_DocumentTitleChanged: (cb: (_sender: unknown, _e: unknown) => void) => void;
      }
    ).add_DocumentTitleChanged((_sender, _e) => {
      const title = (coreWebView2 as unknown as { DocumentTitle: string }).DocumentTitle;
      if (title) {
        (this.getBrowserWindow() as unknown as { Title: string }).Title = title;
      }
    });

    // ── WebMessageReceived → IPC dispatch ──────────────────────────────────────
    (
      coreWebView2 as unknown as {
        add_WebMessageReceived: (cb: (_sender: unknown, e: unknown) => void) => void;
      }
    ).add_WebMessageReceived((_sender, e) => {
      try {
        const evt = e as unknown as { WebMessageAsJson: string };
        const outer = JSON.parse(evt.WebMessageAsJson);
        const message = typeof outer === 'string' ? JSON.parse(outer) : outer;
        const { channel, type, id, args = [] } = message;

        const event = {
          sender: this.getWindowSender(),
          reply: (ch: string, ...a: unknown[]) => this.send(ch, ...a),
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
          const handler = handlers.get(channel);
          if (handler) {
            try {
              const result = handler(event, ...args);
              if (result && typeof (result as unknown as { then: unknown }).then === 'function') {
                (result as Promise<unknown>)
                  .then(r => this.sendIpcReply(id, r, null))
                  .catch(err => this.sendIpcReply(id, null, (err as Error).message || String(err)));
              } else {
                this.sendIpcReply(id, result, null);
              }
            } catch (err: unknown) {
              const error = err as { message?: string };
              this.sendIpcReply(id, null, error.message || String(err));
            }
          } else {
            this.sendIpcReply(id, null, `No handler for channel: ${channel}`);
          }
        }
      } catch (err: unknown) {
        const error = err as { message?: string };
        console.error('[WebView2] WebMessageReceived error:', error.message);
      }
    });

    // ── NavigationCompleted → did-finish-load callback ─────────────────────────
    if (this._navCompletedCallback) {
      (
        coreWebView2 as unknown as {
          add_NavigationCompleted: (cb: (_s: unknown, _e: unknown) => void) => void;
        }
      ).add_NavigationCompleted((_s, _e) => {
        this._navCompletedCallback?.();
      });
    }
  }

  /** Push a node-integration callback to the renderer via the IPC channel. */
  public pushNwwCallback(id: string, args: unknown[]): void {
    const coreWebView2 = this.getCoreWebView2();
    if (!coreWebView2) return;
    const payload = JSON.stringify({ type: 'nwwCallback', id, args });
    (coreWebView2 as unknown as { PostWebMessageAsString: (s: string) => void })
      .PostWebMessageAsString(payload);
  }

  /** Remove the callback pusher registration. Call when the window closes. */
  public cleanup(): void {
    if (this._nwwPushFn) {
      removeNwwCallbackPusher(this._nwwPushFn);
      this._nwwPushFn = null;
    }
    this.rejectAll('Window closed');
  }

  public onNavigationCompleted(callback: () => void): void {
    this._navCompletedCallback = callback;
  }

  public send(channel: string, ...args: unknown[]): void {
    const coreWebView2 = this.getCoreWebView2();
    if (!coreWebView2) return;
    const payload = JSON.stringify({ type: 'message', channel, args });
    (coreWebView2 as unknown as { PostWebMessageAsString: (s: string) => void }).PostWebMessageAsString(payload);
  }

  public sendIpcReply(id: string, result: unknown, error: string | null): void {
    const payload = JSON.stringify({ type: 'reply', id, result, error });
    (
      this.getCoreWebView2() as unknown as { PostWebMessageAsString: (msg: string) => void }
    ).PostWebMessageAsString(payload);
  }

  public executeJavaScript(code: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const coreWebView2 = this.getCoreWebView2();
      if (!coreWebView2) {
        reject(new Error('WebView2 not ready'));
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
      const payload = JSON.stringify({ type: 'exec', id, code });
      (
        coreWebView2 as unknown as { PostWebMessageAsString: (s: string) => void }
      ).PostWebMessageAsString(payload);
    });
  }

  /** Reject all in-flight executeJavaScript promises. */
  public rejectAll(reason: string): void {
    for (const pending of this._pendingExecs.values()) {
      pending.reject(new Error(reason));
    }
    this._pendingExecs.clear();
  }
}
