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
export function generateBridgeScript(webPreferences: WebPreferences): string {
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

    // Expose require globally
    window.require = function(module) {
        return nodeRequire(module);
    };

    // Expose process object with some working properties
    window.process = {
        platform: 'win32',
        arch: 'x64',
        version: ${injectedVersion},
        env: {},
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
window.ipcRenderer={
  /**
   * Send a message to main process (fire-and-forget)
   * Similar to ipcRenderer.send() in Electron
   */
  send:function(channel){
    var args=Array.prototype.slice.call(arguments,1);
    window.chrome.webview.postMessage({type:'send',channel:channel,args:args});
  },
  
  /**
   * Invoke a handler and get a Promise result
   * Similar to ipcRenderer.invoke() in Electron
   * 
   * How it works:
   * 1. Generate a random ID to track this request
   * 2. Create a Promise with handlers for resolve/reject
   * 3. Set up a one-time message listener to handle the reply
   * 4. Send the message with the ID
   * 5. When reply arrives, resolve or reject the Promise
   */
  invoke:function(channel){
    var args=Array.prototype.slice.call(arguments,1);
    var id=Math.random().toString(36).substr(2,9);
    return new Promise(function(resolve,reject){
      var handler=function(e){
        var m=JSON.parse(e.data);
        if(m.type==='reply'&&m.id===id){
          window.chrome.webview.removeEventListener('message',handler);
          if(m.error)reject(new Error(m.error));else resolve(m.result);
        }
      };
      window.chrome.webview.addEventListener('message',handler);
      window.chrome.webview.postMessage({type:'invoke',channel:channel,id:id,args:args});
    });
  },
  
  /**
   * Listen for messages from main process
   * Similar to ipcRenderer.on() in Electron
   * 
   * Main process sends messages using webView.PostWebMessageAsString()
   * We receive them via the 'message' event and filter by channel
   */
  on:function(channel,callback){
    window.chrome.webview.addEventListener('message',function(e){
      var m=JSON.parse(e.data);
      if(m.type==='message'&&m.channel===channel)callback(e,m.args);
    });
  }
};`;
        ipcBridge += '})();';
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
