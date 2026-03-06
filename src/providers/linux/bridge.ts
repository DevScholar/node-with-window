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

export function generateBridgeScript(webPreferences: WebPreferences): string {
    const nodeIntegration = webPreferences.nodeIntegration;

    let nodeBridge = '';
    if (nodeIntegration) {
        const injectedCwd     = JSON.stringify(process.cwd());
        const injectedVersion = JSON.stringify(process.version);

        nodeBridge = `
(function() {
    if (window.__nodeBridge) return;
    window.__nodeBridge = true;

    const nodeRequire = function(module) {
        const stub = function(name) {
            return function() {
                console.warn('[node-with-window] ' + module + '.' + name + '() is not available in renderer. Use ipcRenderer.invoke() instead.');
                return null;
            };
        };
        if (module === 'fs') {
            return { readFileSync: stub('readFileSync'), writeFileSync: stub('writeFileSync'),
                existsSync: stub('existsSync'), readdirSync: stub('readdirSync'),
                mkdirSync: stub('mkdirSync'), statSync: stub('statSync'),
                unlinkSync: stub('unlinkSync'), rmdirSync: stub('rmdirSync') };
        }
        if (module === 'path') {
            return { join: stub('join'), resolve: stub('resolve'), dirname: stub('dirname'),
                basename: stub('basename'), extname: stub('extname'),
                isAbsolute: stub('isAbsolute'), normalize: stub('normalize') };
        }
        if (module === 'os') {
            return { homedir: stub('homedir'), tmpdir: stub('tmpdir'),
                platform: function() { return 'linux'; },
                arch: function() { return 'x64'; },
                cpus: stub('cpus'), totalmem: stub('totalmem'),
                freemem: stub('freemem'), uptime: stub('uptime') };
        }
        return null;
    };

    window.require = function(module) { return nodeRequire(module); };

    window.process = {
        platform: 'linux',
        arch: 'x64',
        version: ${injectedVersion},
        env: {},
        cwd: function() { return ${injectedCwd}; },
        exit: function(code) {
            window.webkit.messageHandlers.ipc.postMessage(
                JSON.stringify({ type: 'send', channel: 'process:exit', args: [code] }));
        }
    };
})();`;
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

    // Called by the main process (via evaluate_javascript) to deliver replies
    // and push messages to on() listeners.
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
                listeners[i]({}, msg.args);
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
            window.__ipcListeners[channel].push(callback);
        }
    };
})();`;
    }

    return nodeBridge + ipcBridge;
}

/**
 * Injects the bridge script into HTML, mirroring the Windows implementation.
 */
export function injectBridgeScript(html: string, webPreferences: WebPreferences): string {
    const script = `<script>${generateBridgeScript(webPreferences)}</script>`;

    if (/<head[^>]*>/i.test(html))
        return html.replace(/(<head[^>]*>)/i, `$1${script}`);

    if (/<body[^>]*>/i.test(html))
        return html.replace(/(<body[^>]*>)/i, `$1${script}`);

    return script + html;
}
