import { WebPreferences } from '../../interfaces';
import { generateImportMapTag, NODE_BUILTINS } from '../../esm-importmap.js';
import { generateNodeBridgeIife, generateNodeBridgeStub } from '../bridge-shared.js';

/**
 * Windows Bridge - WebView2 JavaScript Injection
 *
 * This file generates the JavaScript code that's injected into the renderer's
 * HTML page. It provides:
 *
 * 1. Node.js compatibility layer (optional, when nodeIntegration is enabled)
 *    - window.require() — full sync-XHR bridge to a local Node.js HTTP server
 *    - window.process object with platform, arch, version, cwd, exit
 *
 * 2. IPC bridge (when contextIsolation is NOT enabled)
 *    - window.ipcRenderer.send() - fire-and-forget messages
 *    - window.ipcRenderer.invoke() - request-response with Promises
 *    - window.ipcRenderer.on() - receive messages from main process
 */

export function generateBridgeScript(webPreferences: WebPreferences, syncServerPort = 0): string {
  const nodeIntegration = webPreferences.nodeIntegration;

  let nodeBridge = '';
  if (nodeIntegration) {
    const injectedCwd     = JSON.stringify(process.cwd());
    const injectedVersion = JSON.stringify(process.version);
    // Double-encode env so </script> sequences inside env values cannot break the
    // enclosing <script> tag (the outer JSON.stringify produces a safe string literal).
    const injectedEnv     = JSON.stringify(JSON.stringify(process.env));
    const injectedArch    = JSON.stringify(process.arch);
    const injectedPort    = syncServerPort;

    if (injectedPort > 0) {
      const base = `http://127.0.0.1:${injectedPort}/__nww_esm__/`;
      const imports: Record<string, string> = {};
      imports['@devscholar/node-with-window'] = base + '@devscholar/node-with-window';
      for (const name of NODE_BUILTINS) {
        imports[name] = base + name;
        imports[`node:${name}`] = base + name;
      }
      // Build the importmap JSON for the dynamic injection guard.
      // The MutationObserver importmap-injection block makes 'import { x } from "fs"'
      // work even when the page HTML was not served by us (no pre-injected importmap).
      // For loadFile() the HTML already contains the importmap; the guard prevents
      // a second injection.
      const importMapJson = JSON.stringify(JSON.stringify({ imports }));

      nodeBridge = generateNodeBridgeIife({
        port: injectedPort,
        platform: 'win32',
        injectedArch,
        injectedVersion,
        injectedEnv,
        injectedCwd,
        importMapJson,
      });
    } else {
      // Fallback stubs when no sync server is running.
      nodeBridge = generateNodeBridgeStub({
        platform: 'win32',
        injectedArch,
        injectedVersion,
        injectedEnv,
        injectedCwd,
      });
    }
  }

  let ipcBridge = '';
  if (webPreferences.contextIsolation !== true) {
    // Fix #3: ipcDispatch is a closure-local function, not window.__ipcDispatch,
    // so renderer scripts cannot call it to spoof replies.
    // Fix #13: formatted for readability, matching the Linux bridge style.
    ipcBridge = `
(function() {
    if (window.ipcRenderer) return;

    // Pending invoke callbacks keyed by request id
    window.__ipcPending   = {};
    // Registered on() listeners keyed by channel
    window.__ipcListeners = {};

    // Dispatch replies and push messages — closure-local so renderer code cannot call it.
    function ipcDispatch(msg) {
        if (msg.type === 'reply') {
            var p = window.__ipcPending[msg.id];
            if (p) {
                delete window.__ipcPending[msg.id];
                if (msg.error) p.reject(new Error(msg.error));
                else           p.resolve(msg.result);
            }
        } else if (msg.type === 'message') {
            var listeners = window.__ipcListeners[msg.channel] || [];
            for (var i = 0; i < listeners.length; i++) listeners[i].cb({}, msg.args);
        }
    }

    // Messages from the main process arrive via chrome.webview (WebView2 trusted channel).
    window.chrome.webview.addEventListener('message', function(e) {
        var m;
        try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m.type === 'exec') {
            // executeJavaScript() path — eval runs in renderer context.
            var eid = m.id;
            try {
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
                window.__ipcPending[id] = { resolve: resolve, reject: reject };
                window.chrome.webview.postMessage(
                    JSON.stringify({ type: 'invoke', channel: channel, id: id, args: args }));
            });
        },

        sendSync: function(channel) {
            var args = Array.prototype.slice.call(arguments, 1);
            var xhr = new XMLHttpRequest();
            xhr.open('POST', 'http://127.0.0.1:${syncServerPort}/__nww_ipc_sync__', false);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.send(JSON.stringify({ channel: channel, args: args }));
            if (xhr.status !== 200) return undefined;
            try { return JSON.parse(xhr.responseText).result; } catch (e) { return undefined; }
        },

        on: function(channel, callback) {
            if (!window.__ipcListeners[channel])
                window.__ipcListeners[channel] = [];
            window.__ipcListeners[channel].push({ cb: callback });
        },

        once: function(channel, callback) {
            var self = window.ipcRenderer;
            var wrapped = function(e, args) { self.off(channel, wrapped); callback(e, args); };
            self.on(channel, wrapped);
        },

        off: function(channel, callback) {
            var listeners = window.__ipcListeners[channel];
            if (!listeners) return;
            for (var i = 0; i < listeners.length; i++) {
                if (listeners[i].cb === callback) { listeners.splice(i, 1); return; }
            }
        }
    };
    window.ipcRenderer.removeListener = window.ipcRenderer.off;
})();`;
  }

  return nodeBridge + ipcBridge;
}

/**
 * Injects the bridge script into HTML.
 *
 * @param html - Original HTML content
 * @param webPreferences - Configuration for what to inject
 * @param syncServerPort - Port for the sync server
 * @returns Modified HTML with bridge script inserted
 */
export function injectBridgeScript(html: string, webPreferences: WebPreferences, syncServerPort = 0): string {
  const script = `<script>${generateBridgeScript(webPreferences, syncServerPort)}</script>`;

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
 * @param syncServerPort  Port the sync server is listening on
 * @param baseHref        Optional base URL, e.g. 'file:///C:/myapp/src/'
 */
export function injectImportMap(
  html: string,
  webPreferences: WebPreferences,
  syncServerPort: number,
  baseHref?: string,
): string {
  if (!webPreferences.nodeIntegration || syncServerPort <= 0) {
    if (!baseHref) return html;
    const baseTag = `<base href="${baseHref}">`;
    if (/<head[^>]*>/i.test(html)) return html.replace(/(<head[^>]*>)/i, `$1${baseTag}`);
    return `<head>${baseTag}</head>${html}`;
  }

  const importMapTag = generateImportMapTag(syncServerPort);
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
