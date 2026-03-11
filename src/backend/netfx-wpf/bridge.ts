import { WebPreferences } from '../../interfaces';

/**
 * Windows Bridge - WebView2 JavaScript Injection
 *
 * This file generates the JavaScript code that's injected into the renderer's
 * HTML page. It provides:
 *
 * 1. Node.js compatibility layer (optional, when nodeIntegration is enabled)
 *    - window.require() stub that warns about unavailable modules
 *    - window.process object with platform, arch, version, cwd, exit
 *
 * 2. IPC bridge (when contextIsolation is NOT enabled)
 *    - window.ipcRenderer.send() - fire-and-forget messages
 *    - window.ipcRenderer.invoke() - request-response with Promises
 *    - window.ipcRenderer.on() - receive messages from main process
 *
 * WHY THIS APPROACH?
 *
 * WebView2 doesn't have Electron's "preload script" concept. Instead, we:
 * 1. Read the user's HTML file
 * 2. Inject our bridge script as a <script> tag
 * 3. Load the modified HTML into WebView2
 *
 * This is simpler than Electron's approach but has security implications:
 * - If nodeIntegration is enabled, the renderer has access to Node.js APIs
 * - The bridge runs in the same context as user code (no isolation)
 *
 * For better security, leave nodeIntegration: false and use contextIsolation.
 * The IPC bridge will still work - it's just exposed as ipcRenderer.
 */

/**
 * Generates the complete bridge script as a JavaScript string.
 *
 * @param webPreferences - Configuration that determines what features to enable
 * @returns JavaScript code that will be injected into the HTML
 */
export function generateBridgeScript(webPreferences: WebPreferences, syncServerPort = 0): string {
  const nodeIntegration = webPreferences.nodeIntegration;

  /**
   * NODE BRIDGE
   *
   * When nodeIntegration is enabled, we provide limited Node.js compatibility.
   *
   * Why stub out the modules?
   * - We can't actually give the renderer access to Node.js modules in WebView2
   * - Instead, we provide stub functions that warn the user and return null
   * - This helps users understand they should use IPC instead
   *
   * What we provide:
   * - window.require() - returns stubs for fs, path, os modules
   * - window.process - object with platform, arch, version, env, cwd, exit
   *
   * The exit() function is special - it sends a message to the main process
   * which can then handle it appropriately.
   */
  let nodeBridge = '';
  if (nodeIntegration) {
    const injectedCwd = JSON.stringify(process.cwd());
    const injectedVersion = JSON.stringify(process.version);
    const injectedEnv = JSON.stringify(process.env);
    const injectedPort = syncServerPort;

    /**
     * IIFE (Immediately Invoked Function Expression) pattern:
     * - Prevents our variables from polluting the global scope
     * - The leading semicolon handles cases where our script is concatenated
     *   with other scripts that don't end with a semicolon
     */
    nodeBridge = `
(function() {
    // Guard - only initialize once even if script is injected multiple times
    if (window.__nodeBridge) return;
    window.__nodeBridge = true;

    /**
     * Stub for require() - returns fake modules that warn about usage
     * 
     * In a real Node.js environment, require() loads actual modules.
     * Here, we return stub objects that warn users to use IPC instead.
     */
    const nodeRequire = function(module) {
        var stub = function(name) {
            return function() {
                console.warn('[node-with-window] ' + module + '.' + name + '() is not available in renderer. Use ipcRenderer.invoke() instead.');
                return null;
            };
        };
        
        // fs module stubs - most file operations aren't available
        if (module === 'fs') {
            return { readFileSync: stub('readFileSync'), writeFileSync: stub('writeFileSync'),
                existsSync: stub('existsSync'), readdirSync: stub('readdirSync'),
                mkdirSync: stub('mkdirSync'), statSync: stub('statSync'),
                unlinkSync: stub('unlinkSync'), rmdirSync: stub('rmdirSync') };
        }
        
        // path module stubs - some might work but we warn anyway
        if (module === 'path') {
            return { join: stub('join'), resolve: stub('resolve'), dirname: stub('dirname'),
                basename: stub('basename'), extname: stub('extname'),
                isAbsolute: stub('isAbsolute'), normalize: stub('normalize') };
        }
        
        // os module stubs
        if (module === 'os') {
            return { homedir: stub('homedir'), tmpdir: stub('tmpdir'),
                platform: function() { return 'win32'; },
                arch: function() { return 'x64'; },
                cpus: stub('cpus'), totalmem: stub('totalmem'),
                freemem: stub('freemem'), uptime: stub('uptime') };
        }
        return null;
    };

    // Global registry for callbacks passed to window.require().
    // Keyed by a random id that survives JSON serialization as {__nww_cb: id}.
    // Stored globally so the SSE listener (below) can fire them any number of
    // times — this is what enables fs.watch, EventEmitter.on, etc.
    window.__nwwCallbacks = {};

    // Persistent SSE connection for callback delivery.
    // The server pushes {id, args} events whenever a registered callback fires.
    // Using EventSource (rather than polling) means zero overhead when idle and
    // no missed events: Chromium buffers SSE messages while the JS thread is
    // blocked on a sync XHR, then dispatches them once the thread is free.
    var __nwwEvtSrc = new EventSource('http://127.0.0.1:${injectedPort}/__nww_events__');
    __nwwEvtSrc.onmessage = function(e) {
        var msg = JSON.parse(e.data);
        var cb = window.__nwwCallbacks[msg.id];
        if (cb) cb.apply(null, msg.args.map(__nwwWrapResult));
    };

    // Serialize one argument for the JSON body sent to the server.
    // Functions → {__nww_cb: id} stored in window.__nwwCallbacks
    // Ref proxies → {__nww_ref: id} so the server can retrieve the real object
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

    // Wrap a value returned by the server.
    // {__nww_ref: id} → ref Proxy so method calls on it round-trip to the server.
    // Everything else → returned as-is.
    function __nwwWrapResult(result) {
        if (result !== null && typeof result === 'object' && typeof result.__nww_ref === 'string') {
            return __nwwMakeRef(result.__nww_ref);
        }
        return result;
    }

    // Build a Proxy for a server-side ref object.
    // Any method call on the proxy is dispatched to { ref, methodName, args }
    // on the server, which retrieves the real object from refRegistry.
    function __nwwMakeRef(refId) {
        return new Proxy({ __nww_ref: refId }, {
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
    }

    // Synchronous require via local HTTP server.
    // window.require(moduleName).methodName(...args) blocks the renderer JS
    // thread with a synchronous XMLHttpRequest to the Node.js HTTP server
    // started on loopback at the injected port.  This works because:
    //   - sync XHR only freezes the renderer's JS thread
    //   - Chromium's C++ network stack keeps running on a background thread
    //   - Node.js (separate OS process) handles the TCP request normally
    //   - the JS thread unblocks once the TCP response arrives
    // This is fundamentally different from a spin-wait, which would block the
    // same thread that needs to fire the IPC reply callback (deadlock).
    //
    // Non-serializable return values (Buffer, FSWatcher, Stream, etc.) come
    // back as {__nww_ref: id} and are wrapped in a ref Proxy automatically.
    // Function arguments become {__nww_cb: id}; callbacks fire via SSE and
    // can be invoked any number of times (fs.watch, EventEmitter.on, etc.).
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


    // Expose process object with some working properties
    window.process = {
        platform: 'win32',
        arch: 'x64',
        version: ${injectedVersion},
        env: ${injectedEnv},
        cwd: function() { return ${injectedCwd}; },
        // Exit sends a message to main process rather than actually exiting
        exit: function(code) { window.chrome.webview.postMessage({ type: 'send', channel: 'process:exit', args: [code] }); }
    };
})();`;
  }

  /**
   * IPC BRIDGE
   *
   * Provides Electron-compatible ipcRenderer API for communicating with main process.
   *
   * Only included when contextIsolation is NOT enabled (for compatibility with
   * existing code that expects ipcRenderer to be available).
   *
   * Why no contextIsolation by default?
   * - Electron defaults to contextIsolation: true, but this library defaults to false
   * - This makes migration from Electron easier (less configuration needed)
   * - Users who want security can enable contextIsolation themselves
   */
  let ipcBridge = '';
  if (webPreferences.contextIsolation !== true) {
    /**
     * The IPC bridge uses WebView2's webview.postMessage API:
     *
     * window.chrome.webview.postMessage({...}) sends to the native side
     * window.chrome.webview.addEventListener('message', ...) receives from native
     *
     * Message format:
     * {
     *   type: 'send' | 'invoke' | 'message' | 'reply',
     *   channel: string,
     *   id?: string,        // for request-response correlation
     *   args?: any[]
     * }
     */
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
        r.then(function(v){window.chrome.webview.postMessage({type:'execResult',id:eid,result:v==null?null:v});})
         .catch(function(ex){window.chrome.webview.postMessage({type:'execResult',id:eid,error:String(ex)});});
      }else{
        window.chrome.webview.postMessage({type:'execResult',id:eid,result:r==null?null:r});
      }
    }catch(ex){window.chrome.webview.postMessage({type:'execResult',id:eid,error:String(ex)});}
    return;
  }
  window.__ipcDispatch(m);
});

window.ipcRenderer={
  send:function(channel){
    var args=Array.prototype.slice.call(arguments,1);
    window.chrome.webview.postMessage({type:'send',channel:channel,args:args});
  },
  invoke:function(channel){
    var args=Array.prototype.slice.call(arguments,1);
    var id=Math.random().toString(36).substring(2,11);
    return new Promise(function(resolve,reject){
      window.__ipcPending[id]={resolve:resolve,reject:reject};
      window.chrome.webview.postMessage({type:'invoke',channel:channel,id:id,args:args});
    });
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
 * We insert a <script> tag with our bridge code. The position matters:
 * 1. If <head> exists, insert at the start of head
 * 2. If <body> exists, insert at the start of body
 * 3. Otherwise, prepend to the document
 *
 * Why at the start?
 * - We want our APIs (ipcRenderer, require, process) available ASAP
 * - Scripts in <head> without async/defer block HTML parsing until loaded
 * - Inserting at the start of body ensures DOM is ready
 *
 * @param html - Original HTML content
 * @param webPreferences - Configuration for what to inject
 * @returns Modified HTML with bridge script inserted
 */
export function injectBridgeScript(html: string, webPreferences: WebPreferences): string {
  const script = `<script>${generateBridgeScript(webPreferences)}</script>`;

  // Try to insert after <head> tag
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/(<head[^>]*>)/i, `$1${script}`);
  }

  // Try to insert after <body> tag
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/(<body[^>]*>)/i, `$1${script}`);
  }

  // Fallback: prepend to document
  return script + html;
}
