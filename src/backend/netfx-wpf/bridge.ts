import { WebPreferences } from '../../interfaces.js';
import { generateImportMapTag, buildImports } from '../../esm-importmap.js';
import { generateNodeBridgeIife } from '../bridge-shared.js';

/**
 * Windows Bridge - WebView2 JavaScript Injection
 *
 * 1. Node.js compatibility layer (when nodeIntegration is enabled)
 *    - window.require() via sync XHR to the nww:// custom scheme
 *    - window.process object with platform, arch, version, cwd, exit
 *
 * 2. IPC bridge (when contextIsolation is NOT enabled)
 *    - window.ipcRenderer.send()    - fire-and-forget messages
 *    - window.ipcRenderer.invoke()  - request-response with Promises
 *    - window.ipcRenderer.sendSync() - synchronous via nww:// scheme
 *    - window.ipcRenderer.on()      - receive messages from main process
 */

export function generateBridgeScript(webPreferences: WebPreferences): string {
  const nodeIntegration = webPreferences.nodeIntegration;

  let nodeBridge = '';
  if (nodeIntegration) {
    const injectedCwd     = JSON.stringify(process.cwd());
    const injectedVersion = JSON.stringify(process.version);
    const injectedEnv     = JSON.stringify(JSON.stringify(process.env));
    const injectedArch    = JSON.stringify(process.arch);

    const imports = buildImports();
    const importMapJson = JSON.stringify(JSON.stringify({ imports }));

    nodeBridge = generateNodeBridgeIife({
      platform: 'win32',
      injectedArch,
      injectedVersion,
      injectedEnv,
      injectedCwd,
      importMapJson,
    });
  }

  let ipcBridge = '';
  const needsIpcBridge = webPreferences.contextIsolation !== true || !!webPreferences.preload;
  if (needsIpcBridge) {
    ipcBridge = `
(function() {
    if (window.ipcRenderer) return;

    var __ipcPending   = {};
    var __ipcListeners = {};

    function ipcDispatch(msg) {
        if (msg.type === 'reply') {
            var p = __ipcPending[msg.id];
            if (p) {
                delete __ipcPending[msg.id];
                if (msg.error) p.reject(new Error(msg.error));
                else           p.resolve(msg.result);
            }
        } else if (msg.type === 'message') {
            var listeners = __ipcListeners[msg.channel] || [];
            for (var i = 0; i < listeners.length; i++) listeners[i].cb({}, msg.args);
        } else if (msg.type === 'nwwCallback') {
            var args = msg.args || [];
            var wrap = window.__nwwWrapResult || function(x) { return x; };
            if (args[0] === '__nww_resolve') {
                var ap = window.__nwwAsyncPending && window.__nwwAsyncPending[msg.id];
                if (ap) { delete window.__nwwAsyncPending[msg.id]; ap.resolve(wrap(args[1])); }
            } else if (args[0] === '__nww_reject') {
                var ap = window.__nwwAsyncPending && window.__nwwAsyncPending[msg.id];
                if (ap) { delete window.__nwwAsyncPending[msg.id]; ap.reject(new Error(args[1])); }
            } else {
                var cb = window.__nwwCallbacks && window.__nwwCallbacks[msg.id];
                if (cb) cb.apply(null, args.map(wrap));
            }
        }
    }

    window.chrome.webview.addEventListener('message', function(e) {
        var m;
        try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m.type === 'exec') {
            var eid = m.id;
            try {
                // eslint-disable-next-line no-eval -- executeJavaScript bridge: renderer eval is the
                // only mechanism to run arbitrary code in the WebView2 context.
                var r = eval(m.code);
                if (r && typeof r.then === 'function') {
                    r.then(function(v) {
                        window.chrome.webview.postMessage(
                            JSON.stringify({ type: 'execResult', id: eid, result: v == null ? null : v }));
                    }).catch(function(ex) {
                        window.chrome.webview.postMessage(
                            JSON.stringify({ type: 'execResult', id: eid, error: String(ex) }));
                    });
                } else {
                    window.chrome.webview.postMessage(
                        JSON.stringify({ type: 'execResult', id: eid, result: r == null ? null : r }));
                }
            } catch (ex) {
                window.chrome.webview.postMessage(
                    JSON.stringify({ type: 'execResult', id: eid, error: String(ex) }));
            }
            return;
        }
        ipcDispatch(m);
    });

    window.ipcRenderer = {
        send: function(channel) {
            var args = Array.prototype.slice.call(arguments, 1);
            window.chrome.webview.postMessage(
                JSON.stringify({ type: 'send', channel: channel, args: args }));
        },

        invoke: function(channel) {
            var args = Array.prototype.slice.call(arguments, 1);
            var id   = Math.random().toString(36).substring(2, 11);
            return new Promise(function(resolve, reject) {
                __ipcPending[id] = { resolve: resolve, reject: reject };
                window.chrome.webview.postMessage(
                    JSON.stringify({ type: 'invoke', channel: channel, id: id, args: args }));
            });
        },

        sendSync: function(channel) {
            var args = Array.prototype.slice.call(arguments, 1);
            var xhr = new XMLHttpRequest();
            xhr.open('POST', 'nww://host/__nww_ipc_sync__', false);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.send(JSON.stringify({ channel: channel, args: args }));
            if (xhr.status !== 200) return undefined;
            try { return JSON.parse(xhr.responseText).result; } catch (e) { return undefined; }
        },

        on: function(channel, callback) {
            if (!__ipcListeners[channel])
                __ipcListeners[channel] = [];
            __ipcListeners[channel].push({ cb: callback });
        },

        once: function(channel, callback) {
            var self = window.ipcRenderer;
            var wrapped = function(e, args) { self.off(channel, wrapped); callback(e, args); };
            self.on(channel, wrapped);
        },

        off: function(channel, callback) {
            var listeners = __ipcListeners[channel];
            if (!listeners) return;
            for (var i = 0; i < listeners.length; i++) {
                if (listeners[i].cb === callback) { listeners.splice(i, 1); return; }
            }
        },

        removeAllListeners: function(channel) {
            if (channel === undefined) { __ipcListeners = {}; }
            else { delete __ipcListeners[channel]; }
            return window.ipcRenderer;
        },

        postMessage: function(channel, message) {
            window.chrome.webview.postMessage(
                JSON.stringify({ type: 'send', channel: channel, args: [message] }));
        }
    };
    window.ipcRenderer.removeListener = window.ipcRenderer.off;

    window.contextBridge = {
        exposeInMainWorld: function(key, api) { window[key] = api; }
    };
})();`;

    if (webPreferences.contextIsolation === true && !webPreferences.nodeIntegration) {
      ipcBridge += `
(function() {
    if (!window.require) {
        window.require = function(m) {
            if (m === '@devscholar/node-with-window')
                return { ipcRenderer: window.ipcRenderer, contextBridge: window.contextBridge };
            return null;
        };
    }
})();`;
    }
  }

  return nodeBridge + ipcBridge;
}

/**
 * Injects the bridge script into HTML.
 */
export function injectBridgeScript(html: string, webPreferences: WebPreferences): string {
  const script = `<script>${generateBridgeScript(webPreferences)}</script>`;

  if (/<head[^>]*>/i.test(html)) return html.replace(/(<head[^>]*>)/i, `$1${script}`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/(<body[^>]*>)/i, `$1${script}`);
  return script + html;
}

// ─────────────────────────────────────────────────────────────────────────────
// Static ESM import support via HTML importmap
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Injects an importmap (and optionally a `<base>` tag) into an HTML string.
 *
 * Used for `loadFile()` so that `import { x } from 'fs'` resolves correctly
 * when the page is loaded via NavigateToString (no server-side intercept).
 *
 * @param html            Source HTML to modify
 * @param webPreferences  Only reads .nodeIntegration
 * @param baseHref        Optional base URL, e.g. 'file:///C:/myapp/src/'
 */
export function injectImportMap(
  html: string,
  webPreferences: WebPreferences,
  baseHref?: string,
): string {
  if (!webPreferences.nodeIntegration) {
    if (!baseHref) return html;
    const baseTag = `<base href="${baseHref}">`;
    if (/<head[^>]*>/i.test(html)) return html.replace(/(<head[^>]*>)/i, `$1${baseTag}`);
    return `<head>${baseTag}</head>${html}`;
  }

  const importMapTag = generateImportMapTag();
  const baseTag = baseHref ? `<base href="${baseHref}">` : '';
  const injection = baseTag + importMapTag;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/(<head[^>]*>)/i, `$1${injection}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/(<html[^>]*>)/i, `$1<head>${injection}</head>`);
  }
  return `<head>${injection}</head>${html}`;
}
