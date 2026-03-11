import * as http from 'node:http';
import { createRequire } from 'node:module';

/**
 * Synchronous require server for nodeIntegration windows.
 *
 * When nodeIntegration is enabled we start a local HTTP server bound to
 * 127.0.0.1 on a random port.  The renderer calls it with a synchronous
 * XMLHttpRequest so that window.require(moduleName).methodName(...args)
 * appears synchronous to renderer JavaScript, even though Node.js and the
 * renderer are in separate processes.
 *
 * Why sync XHR works here while a spin-wait does not:
 *   - sync XHR blocks only the renderer's JS thread.
 *   - Chromium's C++ network stack keeps running on a background thread,
 *     handles the TCP connection, and delivers the response.
 *   - Node.js (separate OS process) processes the HTTP request normally.
 *   - The renderer JS thread unblocks when the TCP response arrives.
 *   - A spin-wait instead would block the same JS thread that needs to
 *     fire IPC callbacks → deadlock.
 */

let _port = 0;
let _ready: Promise<number> | null = null;

/** Returns the port once startSyncServer() has resolved, 0 otherwise. */
export function getSyncServerPort(): number {
    return _port;
}

/**
 * Starts the HTTP server (idempotent — safe to call multiple times).
 * Resolves with the chosen port once the server is listening.
 */
export function startSyncServer(): Promise<number> {
    if (_ready) return _ready;

    // Resolve modules relative to this file so Node.js builtins always work.
    // npm packages installed in the user's project are NOT on this path;
    // that is a known limitation (builtins cover the common Electron use cases).
    const _require = createRequire(import.meta.url);

    _ready = new Promise<number>((resolve, reject) => {
        const server = http.createServer((req, res) => {
            // Add CORS headers so file:// pages in WebView2 can reach us.
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            if (req.method !== 'POST') {
                res.writeHead(405);
                res.end();
                return;
            }

            let body = '';
            req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            req.on('end', () => {
                const sendOk  = (result: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ result })); };
                const sendErr = (e: unknown)      => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: (e as Error).message ?? String(e) })); };
                try {
                    const { moduleName, methodName, args } = JSON.parse(body) as {
                        moduleName: string;
                        methodName: string;
                        args: unknown[];
                    };

                    console.log(`[require] ${moduleName}.${methodName}()`);

                    const mod = _require(moduleName) as Record<string, unknown>;
                    const fn = mod[methodName];
                    if (typeof fn !== 'function') {
                        throw new Error(`${moduleName}.${methodName} is not a function`);
                    }

                    const result = (fn as (...a: unknown[]) => unknown).apply(mod, args);

                    // If the function returns a Promise (e.g. fs/promises.readFile),
                    // wait for it to settle before responding.  The renderer's sync XHR
                    // keeps blocking until the HTTP response arrives, so this is safe.
                    if (result !== null && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
                        (result as Promise<unknown>).then(sendOk).catch(sendErr);
                    } else {
                        sendOk(result);
                    }
                } catch (e: unknown) {
                    sendErr(e);
                }
            });
        });

        server.on('error', reject);

        // Port 0 → OS picks a free port automatically.
        server.listen(0, '127.0.0.1', () => {
            _port = (server.address() as { port: number }).port;
            console.log(`[node-integration] sync require server on 127.0.0.1:${_port}`);
            resolve(_port);
        });
    });

    return _ready;
}
