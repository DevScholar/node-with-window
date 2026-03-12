import { WebPreferences } from '../../interfaces';

/**
 * Linux Bridge — WebKit JavaScript Injection
 *
 * Mirrors the Windows bridge (bridge.ts) but uses the WebKit messaging API:
 *   - Renderer -> Main:  window.webkit.messageHandlers.ipc.postMessage(json)
 *   - Main -> Renderer:  window.__ipcDispatch(json)   (called via evaluate_javascript)
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
    const injectedEnv     = JSON.stringify(process.env);
    const injectedPort    = syncServerPort;

    if (injectedPort > 0) {
      // Full implementation: synchronous XHR to the local require server.
      // SSE connection delivers callbacks (fs.watch, EventEmitter.on, etc.).
      // FinalizationRegistry + unload handler keep server-side ref memory tidy.
      nodeBridge = `
(function() {
    if (window.__nodeBridge) return;
    window.__nodeBridge = true;

    window.__nwwCallbacks = {};

    var __nwwEvtSrc = new EventSource('http://127.0.0.1:${injectedPort}/__nww_events__');
    __nwwEvtSrc.onmessage = function(e) {
        var msg = JSON.parse(e.data);
        var cb = window.__nwwCallbacks[msg.id];
        if (cb) cb.apply(null, msg.args.map(__nwwWrapResult));
    };

    function __nwwSerializeArg(a) {
        if (typeof a === 'function') {
            var id = Math.random().toString(36).substring(2, 11);
            window.__nwwCallbacks[id] = a;
            return { __nww_cb: id };
        }
        if (a !== null && typeof a === 'object' && typeof a.__nww_ref === 'string') {
            return { __nww_ref: a.__nww_ref };
        }
        return a;
    }

    function __nwwWrapResult(result) {
        if (result !== null && typeof result === 'object' && typeof result.__nww_ref === 'string') {
            return __nwwMakeRef(result.__nww_ref);
        }
        return result;
    }

    window.__nwwLiveRefs = new Set();
    var __nwwPendingRelease = [];
    var __nwwReleaseTimer = null;

    var __nwwRefFinalizer = new FinalizationRegistry(function(id) {
        window.__nwwLiveRefs.delete(id);
        __nwwPendingRelease.push(id);
        if (!__nwwReleaseTimer) {
            __nwwReleaseTimer = setTimeout(function() {
                __nwwReleaseTimer = null;
                var batch = __nwwPendingRelease.splice(0);
                if (batch.length === 0) return;
                fetch('http://127.0.0.1:${injectedPort}/__nww_release__', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ refs: batch })
                }).catch(function() {});
            }, 0);
        }
    });

    function __nwwMakeRef(refId) {
        var proxy = new Proxy({ __nww_ref: refId }, {
            get: function(target, prop) {
                if (prop === '__nww_ref') return refId;
                if (typeof prop !== 'string') return undefined;
                if (prop === 'then') return undefined;
                return function() {
                    var args = Array.prototype.slice.call(arguments);
                    var xhr = new XMLHttpRequest();
                    xhr.open('POST', 'http://127.0.0.1:${injectedPort}/__nww_sync__', false);
                    xhr.setRequestHeader('Content-Type', 'application/json');
                    xhr.send(JSON.stringify({ ref: refId, methodName: prop, args: args.map(__nwwSerializeArg) }));
                    var resp = JSON.parse(xhr.responseText);
                    if (xhr.status !== 200) throw new Error(resp.error || 'ref call failed');
                    return __nwwWrapResult(resp.result);
                };
            }
        });
        window.__nwwLiveRefs.add(refId);
        __nwwRefFinalizer.register(proxy, refId);
        return proxy;
    }

    window.require = function(moduleName) {
        return new Proxy({}, {
            get: function(target, methodName) {
                if (typeof methodName !== 'string') return undefined;
                if (methodName === 'then') return undefined;
                return function() {
                    var args = Array.prototype.slice.call(arguments);
                    var xhr = new XMLHttpRequest();
                    xhr.open('POST', 'http://127.0.0.1:${injectedPort}/__nww_sync__', false);
                    xhr.setRequestHeader('Content-Type', 'application/json');
                    xhr.send(JSON.stringify({ moduleName: moduleName, methodName: methodName, args: args.map(__nwwSerializeArg) }));
                    var resp = JSON.parse(xhr.responseText);
                    if (xhr.status !== 200) throw new Error(resp.error || 'require failed');
                    return __nwwWrapResult(resp.result);
                };
            }
        });
    };

    window.addEventListener('unload', function() {
        if (window.__nwwLiveRefs.size === 0) return;
        var ids = Array.from(window.__nwwLiveRefs);
        window.__nwwLiveRefs.clear();
        var xhr = new XMLHttpRequest();
        xhr.open('POST', 'http://127.0.0.1:${injectedPort}/__nww_release__', false);
        xhr.setRequestHeader('Content-Type', 'application/json');
        try { xhr.send(JSON.stringify({ refs: ids })); } catch (_e) {}
    });

    window.process = {
        platform: 'linux',
        arch: 'x64',
        version: ${injectedVersion},
        env: ${injectedEnv},
        cwd: function() { return ${injectedCwd}; },
        exit: function(code) {
            window.webkit.messageHandlers.ipc.postMessage(
                JSON.stringify({ type: 'send', channel: 'process:exit', args: [code] }));
        }
    };
})();`;
    } else {
      // Fallback stubs when no sync server is running (nodeIntegration without
      // a running server should not happen in normal use, but degrade gracefully).
      nodeBridge = `
(function() {
    if (window.__nodeBridge) return;
    window.__nodeBridge = true;
    var stub = function(m, n) {
        return function() {
            console.warn('[node-with-window] ' + m + '.' + n + '() is not available. Use ipcRenderer.invoke() instead.');
            return null;
        };
    };
    window.require = function(m) {
        console.warn('[node-with-window] window.require() stub: sync server not available.');
        return null;
    };
    window.process = {
        platform: 'linux', arch: 'x64',
        version: ${injectedVersion},
        env: ${injectedEnv},
        cwd: function() { return ${injectedCwd}; },
        exit: function(code) {
            window.webkit.messageHandlers.ipc.postMessage(
                JSON.stringify({ type: 'send', channel: 'process:exit', args: [code] }));
        }
    };
})();`;
    }
  }

  let ipcBridge = '';
  if (webPreferences.contextIsolation !== true) {
    /**
     * WebKit IPC bridge.
     *
     * Outgoing (renderer -> main):
     *   window.webkit.messageHandlers.ipc.postMessage(jsonString)
     *
     * Incoming (main -> renderer):
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

    // Called by the main process (via evaluate_javascript) to deliver replies,
    // push messages to on() listeners, or execute arbitrary JS (executeJavaScript).
    window.__ipcDispatch = function(json) {
        var msg;
        try { msg = JSON.parse(json); } catch(e) { return; }
        if (msg.type === 'exec') {
            var eid = msg.id;
            try {
                var r = eval(msg.code);
                if (r && typeof r.then === 'function') {
                    r.then(function(v) {
                        window.webkit.messageHandlers.ipc.postMessage(
                            JSON.stringify({type:'execResult',id:eid,result:v==null?null:v}));
                    }).catch(function(ex) {
                        window.webkit.messageHandlers.ipc.postMessage(
                            JSON.stringify({type:'execResult',id:eid,error:String(ex)}));
                    });
                } else {
                    window.webkit.messageHandlers.ipc.postMessage(
                        JSON.stringify({type:'execResult',id:eid,result:r==null?null:r}));
                }
            } catch(ex) {
                window.webkit.messageHandlers.ipc.postMessage(
                    JSON.stringify({type:'execResult',id:eid,error:String(ex)}));
            }
            return;
        }
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
 * Injects the bridge script into HTML, mirroring the Windows implementation.
 */
export function injectBridgeScript(html: string, webPreferences: WebPreferences, syncServerPort = 0): string {
  const script = `<script>${generateBridgeScript(webPreferences, syncServerPort)}</script>`;

  if (/<head[^>]*>/i.test(html)) return html.replace(/(<head[^>]*>)/i, `$1${script}`);

  if (/<body[^>]*>/i.test(html)) return html.replace(/(<body[^>]*>)/i, `$1${script}`);

  return script + html;
}
