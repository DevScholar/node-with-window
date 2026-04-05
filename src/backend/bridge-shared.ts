/**
 * Shared node-bridge code generator.
 *
 * Both the Windows (netfx-wpf) and Linux (gjs-gtk4) bridges include an
 * identical JavaScript IIFE that wires up window.require(), window.process,
 * and the ref/callback serialization layer.  This module generates that IIFE
 * so the two bridge files don't diverge.
 *
 * Transport: all requests go to the nww:// custom scheme (no HTTP server).
 *
 * Callbacks (fs.watch, EventEmitter.on, etc.) and async Promise results arrive
 * via the existing IPC channel as { type:'nwwCallback', id, args } messages
 * instead of the old SSE EventSource connection.
 *
 * Async result protocol:
 *   - Sync XHR response: { result: { __nww_async: asyncId } }
 *   - Later, IPC push:   { type:'nwwCallback', id: asyncId, args: ['__nww_resolve', value] }
 *                    or  { type:'nwwCallback', id: asyncId, args: ['__nww_reject',  msg]   }
 *   - Bridge script stores the pending Promise in window.__nwwAsyncPending[asyncId].
 *
 * Platform-specific differences:
 *   - process.platform value
 *   - process.exit() uses the platform's postMessage API
 */

export interface NodeBridgeOptions {
  platform: 'win32' | 'linux';
  /** JSON.stringify'd arch string ready for direct embedding. */
  injectedArch: string;
  /** JSON.stringify'd version string ready for direct embedding. */
  injectedVersion: string;
  /**
   * Double-encoded env string: JSON.stringify(JSON.stringify(process.env)).
   * Rendered in the script as: env: JSON.parse(${injectedEnv})
   * The double-encoding keeps </script> sequences in env values from breaking
   * the surrounding <script> tag.
   */
  injectedEnv: string;
  /** JSON.stringify'd cwd string ready for direct embedding. */
  injectedCwd: string;
  /**
   * Double-encoded import map JSON string, or the string 'null'.
   * Rendered in the script as: if (importMapJson !== null) { ... }
   */
  importMapJson: string;
}

/**
 * Generate the full node-bridge IIFE for the given platform and options.
 * Returns a JavaScript string starting with `(function() {` and ending with `})();`
 */
export function generateNodeBridgeIife(opts: NodeBridgeOptions): string {
  const { platform, injectedArch, injectedVersion, injectedEnv, injectedCwd, importMapJson } = opts;

  const postMessage =
    platform === 'win32'
      ? `window.chrome.webview.postMessage`
      : `window.webkit.messageHandlers.ipc.postMessage`;

  return `(function() {
    if (window.__nodeBridge) return;
    window.__nodeBridge = true;

    window.__nwwCallbacks = {};
    window.__nwwAsyncPending = {};
    // WeakMap from function → id: prevents the same function object from being
    // registered multiple times (e.g. a named handler passed on every call).
    var __nwwFnToId = new WeakMap();

    function __nwwSerializeArg(a) {
        if (typeof a === 'function') {
            var existing = __nwwFnToId.get(a);
            if (existing !== undefined) return { __nww_cb: existing };
            var id = Math.random().toString(36).substring(2, 11);
            __nwwFnToId.set(a, id);
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

    // Expose __nwwWrapResult on window so the IPC bridge (separate IIFE) can
    // call it when dispatching nwwCallback messages.
    window.__nwwWrapResult = __nwwWrapResult;

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
                fetch('nww://host/__nww_release__', {
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
                    xhr.open('POST', 'nww://host/__nww_sync__', false);
                    xhr.setRequestHeader('Content-Type', 'application/json');
                    xhr.send(JSON.stringify({ ref: refId, methodName: prop, args: args.map(__nwwSerializeArg) }));
                    var resp = JSON.parse(xhr.responseText);
                    if (xhr.status !== 200) throw new Error(resp.error || 'ref call failed');
                    return __nwwHandleResult(resp.result);
                };
            }
        });
        window.__nwwLiveRefs.add(refId);
        __nwwRefFinalizer.register(proxy, refId);
        return proxy;
    }

    function __nwwHandleResult(result) {
        if (result !== null && typeof result === 'object' && typeof result.__nww_async === 'string') {
            var asyncId = result.__nww_async;
            return new Promise(function(resolve, reject) {
                window.__nwwAsyncPending[asyncId] = { resolve: resolve, reject: reject };
            });
        }
        return __nwwWrapResult(result);
    }

    window.require = function(moduleName) {
        if (moduleName === '@devscholar/node-with-window') {
            return { ipcRenderer: window.ipcRenderer, contextBridge: window.contextBridge };
        }
        return new Proxy({}, {
            get: function(target, methodName) {
                if (typeof methodName !== 'string') return undefined;
                if (methodName === 'then') return undefined;
                return function() {
                    var args = Array.prototype.slice.call(arguments);
                    var xhr = new XMLHttpRequest();
                    xhr.open('POST', 'nww://host/__nww_sync__', false);
                    xhr.setRequestHeader('Content-Type', 'application/json');
                    xhr.send(JSON.stringify({ moduleName: moduleName, methodName: methodName, args: args.map(__nwwSerializeArg) }));
                    var resp = JSON.parse(xhr.responseText);
                    if (xhr.status !== 200) throw new Error(resp.error || 'require failed');
                    return __nwwHandleResult(resp.result);
                };
            }
        });
    };

    window.addEventListener('unload', function() {
        if (window.__nwwLiveRefs.size === 0) return;
        var ids = Array.from(window.__nwwLiveRefs);
        window.__nwwLiveRefs.clear();
        var xhr = new XMLHttpRequest();
        xhr.open('POST', 'nww://host/__nww_release__', false);
        xhr.setRequestHeader('Content-Type', 'application/json');
        try { xhr.send(JSON.stringify({ refs: ids })); } catch (_e) {}
    });

    window.process = {
        platform: '${platform}',
        arch: ${injectedArch},
        version: ${injectedVersion},
        env: JSON.parse(${injectedEnv}),
        cwd: function() { return ${injectedCwd}; },
        exit: function(code) {
            ${postMessage}(
                JSON.stringify({ type: 'send', channel: 'process:exit', args: [code] }));
        }
    };

    if (${importMapJson} !== null) {
        var __nwwImportMapJson = ${importMapJson};
        function __nwwDoInjectImportMap() {
            if (!document.head) return false;
            if (document.querySelector('script[type="importmap"]')) return true;
            var s = document.createElement('script');
            s.type = 'importmap';
            s.textContent = __nwwImportMapJson;
            document.head.insertBefore(s, document.head.firstChild);
            return true;
        }
        if (!__nwwDoInjectImportMap()) {
            var __nwwImportMapObs = new MutationObserver(function(m, o) {
                if (__nwwDoInjectImportMap()) o.disconnect();
            });
            __nwwImportMapObs.observe(document, { childList: true, subtree: true });
        }
    }
})();`;
}
