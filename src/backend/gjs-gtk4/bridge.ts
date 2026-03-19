import { WebPreferences } from '../../interfaces.js';
import { generateImportMapTag, NODE_BUILTINS } from '../../esm-importmap.js';
import { generateNodeBridgeIife, generateNodeBridgeStub } from '../bridge-shared.js';

/**
 * Linux Bridge — WebKit JavaScript Injection
 *
 * Mirrors the Windows bridge (bridge.ts) but uses the WebKit messaging API:
 *   - Renderer -> Main:  window.webkit.messageHandlers.ipc.postMessage(json)
 *   - Main -> Renderer (IPC):  window.__ipcDispatch(json)   (called via evaluate_javascript)
 *   - Main -> Renderer (eval): self-contained IIFE injected via SendToRenderer
 *
 * executeJavaScript() sends eval code as a standalone IIFE rather than routing
 * it through __ipcDispatch, so renderer scripts cannot forge exec requests.
 *
 * ipcRenderer API exposed in the renderer is intentionally identical to the
 * Windows version so that application code is fully cross-platform.
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
      const importMapJson = JSON.stringify(JSON.stringify({ imports }));

      nodeBridge = generateNodeBridgeIife({
        port: injectedPort,
        platform: 'linux',
        injectedArch,
        injectedVersion,
        injectedEnv,
        injectedCwd,
        importMapJson,
      });
    } else {
      // Fallback stubs when no sync server is running (nodeIntegration without
      // a running server should not happen in normal use, but degrade gracefully).
      nodeBridge = generateNodeBridgeStub({
        platform: 'linux',
        injectedArch,
        injectedVersion,
        injectedEnv,
        injectedCwd,
      });
    }
  }

  let ipcBridge = '';
  const needsIpcBridge = webPreferences.contextIsolation !== true || !!webPreferences.preload;
  if (needsIpcBridge) {
    /**
     * WebKit IPC bridge.
     *
     * Outgoing (renderer -> main):
     *   window.webkit.messageHandlers.ipc.postMessage(jsonString)
     *
     * Incoming (main -> renderer, IPC replies/push):
     *   window.__ipcDispatch(jsonString)  — called by evaluate_javascript() in the host
     *
     * Message format (same as Windows):
     *   { type: 'send',    channel, args }
     *   { type: 'invoke',  channel, id, args }
     *   { type: 'reply',   id, result, error }
     *   { type: 'message', channel, args }
     */
    ipcBridge = `
(function() {
    if (window.ipcRenderer) return;

    // Pending invoke callbacks keyed by request id
    window.__ipcPending   = {};
    // Registered on() listeners keyed by channel
    window.__ipcListeners = {};

    // Called by the main process (via evaluate_javascript) to deliver replies
    // and push messages to on() listeners.
    // NOTE: executeJavaScript() eval is NOT routed through here — it is sent
    // as a self-contained IIFE so renderer scripts cannot forge exec requests.
    window.__ipcDispatch = function(json) {
        var msg;
        try { msg = JSON.parse(json); } catch(e) { return; }
        if (msg.type === 'reply') {
            var p = window.__ipcPending[msg.id];
            if (p) {
                delete window.__ipcPending[msg.id];
                if (msg.error) p.reject(new Error(msg.error));
                else           p.resolve(msg.result);
            }
        } else if (msg.type === 'message') {
            var listeners = window.__ipcListeners[msg.channel] || [];
            for (var i = 0; i < listeners.length; i++)
                listeners[i].cb({}, msg.args);
        }
    };

    window.ipcRenderer = {
        send: function(channel) {
            var args = Array.prototype.slice.call(arguments, 1);
            window.webkit.messageHandlers.ipc.postMessage(
                JSON.stringify({ type: 'send', channel: channel, args: args }));
        },

        invoke: function(channel) {
            var args = Array.prototype.slice.call(arguments, 1);
            var id   = Math.random().toString(36).substr(2, 9);
            return new Promise(function(resolve, reject) {
                window.__ipcPending[id] = { resolve: resolve, reject: reject };
                window.webkit.messageHandlers.ipc.postMessage(
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
            try { return JSON.parse(xhr.responseText).result; } catch(e) { return undefined; }
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
 * Injects the bridge script (and importmap when nodeIntegration is active)
 * into HTML, mirroring the Windows implementation.
 *
 * The importmap must precede the bridge script so that `import 'fs'` in any
 * subsequent `<script type="module">` resolves via the shim server.
 */
export function injectBridgeScript(html: string, webPreferences: WebPreferences, syncServerPort = 0): string {
  const bridgeTag = `<script>${generateBridgeScript(webPreferences, syncServerPort)}</script>`;
  const importMapTag = (webPreferences.nodeIntegration && syncServerPort > 0)
    ? generateImportMapTag(syncServerPort)
    : '';
  // importmap must come BEFORE the bridge script so it is registered before
  // any module scripts the bridge might trigger.
  const injection = importMapTag + bridgeTag;

  if (/<head[^>]*>/i.test(html)) return html.replace(/(<head[^>]*>)/i, `$1${injection}`);

  if (/<body[^>]*>/i.test(html)) return html.replace(/(<body[^>]*>)/i, `$1${injection}`);

  return injection + html;
}
