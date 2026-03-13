import { WebPreferences } from '../../interfaces';
import { generateImportMapTag, NODE_BUILTINS } from '../../esm-importmap.js';

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
    const injectedEnv     = JSON.stringify(process.env);
    const injectedPort    = syncServerPort;

    // Build the MutationObserver importmap-injection block only when a sync
    // server is running.  When port === 0 the block is omitted entirely so
    // the generated script string contains no importmap/MutationObserver text.
    let importMapBlock = '';
    if (injectedPort > 0) {
      const base = `http://127.0.0.1:${injectedPort}/__nww_esm__/`;
      const imports: Record<string, string> = {};
      for (const name of NODE_BUILTINS) {
        imports[name] = base + name;
        imports[`node:${name}`] = base + name;
      }
      const injectedImportMapJson = JSON.stringify(JSON.stringify({ imports }));
      importMapBlock = `
    // Importmap injection for loadURL() — makes 'import { x } from "fs"' work
    // even when the page HTML was not served by us (no pre-injected importmap).
    // For loadFile() the HTML already contains the importmap; the guard below
    // prevents a second injection.
    var __nwwImportMapJson = ${injectedImportMapJson};
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
    }`;
    }

    if (injectedPort > 0) {
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
        platform: 'win32',
        arch: 'x64',
        version: ${injectedVersion},
        env: ${injectedEnv},
        cwd: function() { return ${injectedCwd}; },
        exit: function(code) {
            window.chrome.webview.postMessage(
                JSON.stringify({ type: 'send', channel: 'process:exit', args: [code] }));
        }
    };
${importMapBlock}
})();`;
    } else {
      // Fallback stubs when no sync server is running.
      nodeBridge = `
(function() {
    if (window.__nodeBridge) return;
    window.__nodeBridge = true;
    window.require = function(m) {
        console.warn('[node-with-window] window.require() stub: sync server not available.');
        return null;
    };
    window.process = {
        platform: 'win32', arch: 'x64',
        version: ${injectedVersion},
        env: ${injectedEnv},
        cwd: function() { return ${injectedCwd}; },
        exit: function(code) {
            window.chrome.webview.postMessage(
                JSON.stringify({ type: 'send', channel: 'process:exit', args: [code] }));
        }
    };
})();`;
    }
  }

  let ipcBridge = '';
  if (webPreferences.contextIsolation !== true) {
    ipcBridge = `
(function(){
if(window.ipcRenderer)return;

window.__ipcPending={};
window.__ipcListeners={};

window.__ipcDispatch=function(msg){
  if(msg.type==='reply'){
    var p=window.__ipcPending[msg.id];
    if(p){delete window.__ipcPending[msg.id];if(msg.error)p.reject(new Error(msg.error));else p.resolve(msg.result);}
  }else if(msg.type==='message'){
    var listeners=window.__ipcListeners[msg.channel]||[];
    for(var i=0;i<listeners.length;i++)listeners[i].cb({},msg.args);
  }
};

window.chrome.webview.addEventListener('message',function(e){
  var m;try{m=JSON.parse(e.data);}catch(err){return;}
  if(m.type==='exec'){
    var eid=m.id;
    try{
      var r=eval(m.code);
      if(r&&typeof r.then==='function'){
        r.then(function(v){window.chrome.webview.postMessage(JSON.stringify({type:'execResult',id:eid,result:v==null?null:v}));})
         .catch(function(ex){window.chrome.webview.postMessage(JSON.stringify({type:'execResult',id:eid,error:String(ex)}));});
      }else{
        window.chrome.webview.postMessage(JSON.stringify({type:'execResult',id:eid,result:r==null?null:r}));
      }
    }catch(ex){window.chrome.webview.postMessage(JSON.stringify({type:'execResult',id:eid,error:String(ex)}));}
    return;
  }
  window.__ipcDispatch(m);
});

window.ipcRenderer={
  send:function(channel){
    var args=Array.prototype.slice.call(arguments,1);
    window.chrome.webview.postMessage(JSON.stringify({type:'send',channel:channel,args:args}));
  },
  invoke:function(channel){
    var args=Array.prototype.slice.call(arguments,1);
    var id=Math.random().toString(36).substring(2,11);
    return new Promise(function(resolve,reject){
      window.__ipcPending[id]={resolve:resolve,reject:reject};
      window.chrome.webview.postMessage(JSON.stringify({type:'invoke',channel:channel,id:id,args:args}));
    });
  },
  sendSync:function(channel){
    var args=Array.prototype.slice.call(arguments,1);
    var xhr=new XMLHttpRequest();
    xhr.open('POST','http://127.0.0.1:${syncServerPort}/__nww_ipc_sync__',false);
    xhr.setRequestHeader('Content-Type','application/json');
    xhr.send(JSON.stringify({channel:channel,args:args}));
    if(xhr.status!==200)return undefined;
    try{return JSON.parse(xhr.responseText).result;}catch(e){return undefined;}
  },
  on:function(channel,callback){
    if(!window.__ipcListeners[channel])window.__ipcListeners[channel]=[];
    window.__ipcListeners[channel].push({cb:callback});
  },
  once:function(channel,callback){
    var self=window.ipcRenderer;
    var wrapped=function(e,args){self.off(channel,wrapped);callback(e,args);};
    self.on(channel,wrapped);
  },
  off:function(channel,callback){
    var listeners=window.__ipcListeners[channel];
    if(!listeners)return;
    for(var i=0;i<listeners.length;i++){if(listeners[i].cb===callback){listeners.splice(i,1);return;}}
  }
};
window.ipcRenderer.removeListener=window.ipcRenderer.off;
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
