import { WebPreferences } from '../../interfaces.js';
import { buildImports } from '../../esm-importmap.js';
import { generateNodeBridgeIife } from '../bridge-shared.js';

/**
 * Linux Bridge - WebKitGTK JavaScript Injection
 *
 * 1. Node.js compatibility layer (when nodeIntegration is enabled)
 *    - window.require() via sync XHR to the nww:// custom scheme
 *    - window.process with platform, arch, version, cwd, exit
 *
 * 2. IPC bridge (when contextIsolation is NOT enabled)
 *    - window.ipcRenderer.send()    - fire-and-forget to main
 *    - window.ipcRenderer.invoke()  - request/response (Promise)
 *    - window.ipcRenderer.sendSync() - synchronous via nww:// scheme
 *    - window.ipcRenderer.on()      - receive messages from main
 *
 * Renderer → Main: window.webkit.messageHandlers.ipc.postMessage(json)
 * Main → Renderer: evaluate_javascript calls window.__ipcDispatch(json)
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
      platform: 'linux',
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

    window.__ipcDispatch = function(jsonStr) {
        var msg;
        try { msg = JSON.parse(jsonStr); } catch (e) { return; }
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
                var apResolve = window.__nwwAsyncPending && window.__nwwAsyncPending[msg.id];
                if (apResolve) { delete window.__nwwAsyncPending[msg.id]; apResolve.resolve(wrap(args[1])); }
            } else if (args[0] === '__nww_reject') {
                var apReject = window.__nwwAsyncPending && window.__nwwAsyncPending[msg.id];
                if (apReject) { delete window.__nwwAsyncPending[msg.id]; apReject.reject(new Error(args[1])); }
            } else {
                var cb = window.__nwwCallbacks && window.__nwwCallbacks[msg.id];
                if (cb) cb.apply(null, args.map(wrap));
            }
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
            var id   = Math.random().toString(36).substring(2, 11);
            return new Promise(function(resolve, reject) {
                __ipcPending[id] = { resolve: resolve, reject: reject };
                window.webkit.messageHandlers.ipc.postMessage(
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
