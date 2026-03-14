import * as http from 'node:http';
import { createRequire } from 'node:module';
import { ipcMain } from './ipc-main.js';

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
 *
 * Callback delivery via SSE:
 *   - The renderer also opens a persistent EventSource to /__nww_events__.
 *   - When a callback arg ({__nww_cb: id}) is detected, the real Node.js
 *     callback pushes a JSON event to all SSE clients instead of resolving
 *     the HTTP response.  This allows callbacks to fire multiple times
 *     (fs.watch, EventEmitter.on, etc.) — not just once.
 *   - The sync XHR responds immediately with the function's return value;
 *     callbacks arrive later via SSE regardless of how many times they fire.
 *
 * Non-serializable object refs:
 *   - Node.js objects that cannot survive JSON serialization (Buffer, FSWatcher,
 *     Stream, ChildProcess, etc.) are stored in a refRegistry keyed by a random
 *     id, and only the id is sent to the renderer as { __nww_ref: id }.
 *   - The renderer wraps it in a Proxy; every method call on that Proxy sends
 *     { ref, methodName, args } back here, where the real object is retrieved
 *     and the method is invoked.  Return values and arguments are recursively
 *     checked so ref objects can be threaded through multiple calls.
 */

let _port = 0;
let _ready: Promise<number> | null = null;

/** All currently connected SSE clients (one per renderer page). */
const sseClients = new Set<http.ServerResponse>();

/**
 * Server-side registry for non-serializable Node.js objects.
 * The renderer receives only the id ({ __nww_ref: id }) and calls methods
 * on it via the /__nww_sync__ endpoint with { ref, methodName, args }.
 */
const refRegistry = new Map<string, unknown>();

/** Returns the port once startSyncServer() has resolved, 0 otherwise. */
export function getSyncServerPort(): number {
  return _port;
}

/** Push a callback invocation to every connected SSE client. */
function pushSseCallback(id: string, args: unknown[]): void {
  const data = `data: ${JSON.stringify({ id, args: serializeValue(args) })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      /* client disconnected */
    }
  }
}

/**
 * Returns true when the value needs to be stored as a ref rather than
 * serialized directly.  Plain objects {}, arrays, and primitives are fine.
 * Class instances (Buffer, FSWatcher, Stream, etc.) are not.
 */
function isNeedsRef(val: unknown): boolean {
  if (val === null || typeof val !== 'object') return false;
  if (Array.isArray(val)) return false;
  if (Object.getPrototypeOf(val) === Object.prototype) return false;
  return true;
}

/** Store an object in the ref registry and return its id. */
function storeRef(obj: unknown): string {
  const id = Math.random().toString(36).substring(2, 11);
  refRegistry.set(id, obj);
  return id;
}

/**
 * Recursively serialize a value for the JSON response.
 * Non-serializable objects are replaced with { __nww_ref: id }.
 */
function serializeValue(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(serializeValue);
  if (isNeedsRef(val)) return { __nww_ref: storeRef(val) };
  return val;
}

/**
 * Resolve an argument arriving from the renderer.
 * { __nww_cb: id }  → real Node.js callback that pushes SSE events
 * { __nww_ref: id } → real object from the ref registry
 * Anything else     → unchanged
 */
function resolveArg(a: unknown): unknown {
  if (a === null || typeof a !== 'object') return a;
  const obj = a as Record<string, unknown>;
  if (typeof obj.__nww_cb === 'string') {
    const id = obj.__nww_cb;
    return (...cbArgs: unknown[]) => pushSseCallback(id, cbArgs);
  }
  if (typeof obj.__nww_ref === 'string') {
    return refRegistry.get(obj.__nww_ref);
  }
  return a;
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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // ── SSE endpoint ─────────────────────────────────────────────────
      // The renderer opens a persistent EventSource here so that callbacks
      // registered via window.require can fire multiple times (fs.watch,
      // EventEmitter.on, etc.).
      if (req.method === 'GET' && req.url === '/__nww_events__') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write('\n'); // initial flush so EventSource fires 'open'
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      // ── Module keys endpoint (nodeImport ESM support) ─────────────────
      // Returns the own enumerable property names of a module so the renderer
      // can generate a blob URL with named ES exports.
      if (req.method === 'GET' && req.url?.startsWith('/__nww_module_keys__?')) {
        try {
          const moduleName = new URL('http://x' + req.url).searchParams.get('m') ?? '';
          const mod = _require(moduleName) as Record<string, unknown>;
          const keys = Object.getOwnPropertyNames(mod).filter(
            k => k !== '__esModule' && k !== 'default' && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k)
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ keys }));
        } catch (e: unknown) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: (e as Error).message ?? String(e) }));
        }
        return;
      }

      // ── ESM shim endpoint (static import support via importmap) ──────────
      // Returns a JavaScript ES module that re-exports a Node.js built-in
      // through window.require(), enabling:
      //   import { readFileSync } from 'fs';
      //   import path from 'path';
      //
      // URL pattern: GET /__nww_esm__/<moduleName>
      //
      // The generated module source uses window.require() so all method calls
      // still go through the existing sync-XHR mechanism. The key list is
      // resolved server-side so the export names are accurate.
      if (req.method === 'GET' && req.url?.startsWith('/__nww_esm__/')) {
        const moduleName = req.url.slice('/__nww_esm__/'.length);
        if (!moduleName) {
          res.writeHead(400); res.end(); return;
        }

        // @devscholar/node-with-window exposes renderer-side APIs (ipcRenderer, etc.)
        // that live on window.* in the renderer — no _require() call needed.
        // Note: 'electron' is intentionally not aliased to this module.
        if (moduleName === '@devscholar/node-with-window') {
          const src = [
            '/* node-with-window ESM shim: @devscholar/node-with-window */',
            'export var ipcRenderer = window.ipcRenderer;',
            'export default { ipcRenderer: window.ipcRenderer };',
          ].join('\n');
          res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
          res.end(src);
          return;
        }

        try {
          const mod = _require(moduleName) as Record<string, unknown>;
          const keys = Object.getOwnPropertyNames(mod).filter(
            k => k !== '__esModule' && k !== 'default' && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k)
          );
          const namedExports = keys
            .map(k => `export var ${k} = _m[${JSON.stringify(k)}];`)
            .join('\n');
          const src = [
            `/* node-with-window ESM shim: ${moduleName} */`,
            `var _m = window.require(${JSON.stringify(moduleName)});`,
            namedExports,
            `export default _m;`,
          ].join('\n');
          res.writeHead(200, {
            'Content-Type': 'text/javascript',
            'Cache-Control': 'no-store',
          });
          res.end(src);
        } catch (e: unknown) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(String((e as Error).message ?? e));
        }
        return;
      }

      // ── Ref release endpoint ──────────────────────────────────────────
      // The renderer calls this to free server-side ref objects when their
      // Proxy wrappers are GC'd (FinalizationRegistry) or on page unload.
      if (req.method === 'POST' && req.url === '/__nww_release__') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const { refs } = JSON.parse(body) as { refs: string[] };
            if (Array.isArray(refs)) {
              for (const id of refs) refRegistry.delete(id);
            }
          } catch { /* ignore malformed body */ }
          res.writeHead(204);
          res.end();
        });
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }

      // ── Sync IPC endpoint (ipcRenderer.sendSync) ─────────────────────
      if (req.url === '/__nww_ipc_sync__') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const { channel, args = [] } = JSON.parse(body) as { channel: string; args: unknown[] };
            const event = {
              returnValue: undefined as unknown,
              sender: null,
              frameId: 0,
              reply: () => {},
            };
            ipcMain.emit(channel, event, ...(args as unknown[]).map(resolveArg));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            // Explicitly map undefined → null so the JSON key is always present.
            const returnVal = event.returnValue !== undefined
              ? serializeValue(event.returnValue)
              : null;
            res.end(JSON.stringify({ result: returnVal }));
          } catch (e: unknown) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (e as Error).message ?? String(e) }));
          }
        });
        return;
      }

      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        const respond = (result: unknown) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result: serializeValue(result) }));
        };
        const sendErr = (e: unknown) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: (e as Error).message ?? String(e) }));
        };

        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;

          // Resolve the target object and method from the request.
          // Two forms are supported:
          //   { moduleName, methodName, args } — fresh module call
          //   { ref, methodName, args }        — method on a stored ref
          let target: unknown;
          let methodName: string;
          let rawArgs: unknown[];

          if (typeof parsed.ref === 'string') {
            target = refRegistry.get(parsed.ref);
            if (target === undefined) throw new Error(`Unknown ref: ${parsed.ref}`);
            methodName = parsed.methodName as string;
            rawArgs = (parsed.args as unknown[]) ?? [];
          } else {
            const moduleName = parsed.moduleName as string;
            methodName = parsed.methodName as string;
            rawArgs = (parsed.args as unknown[]) ?? [];
            target = _require(moduleName);
          }

          const fn = (target as Record<string, unknown>)[methodName];
          if (typeof fn !== 'function') {
            throw new Error(`${methodName} is not a function`);
          }

          // Resolve {__nww_cb} and {__nww_ref} markers in args.
          let hasCallbacks = false;
          const resolvedArgs = rawArgs.map(a => {
            if (a !== null && typeof a === 'object') {
              const o = a as Record<string, unknown>;
              if (typeof o.__nww_cb === 'string') {
                hasCallbacks = true;
              }
            }
            return resolveArg(a);
          });

          const rawResult = (fn as (...a: unknown[]) => unknown).apply(target, resolvedArgs);

          if (
            !hasCallbacks &&
            rawResult !== null &&
            typeof rawResult === 'object' &&
            typeof (rawResult as Promise<unknown>).then === 'function'
          ) {
            // Promise-returning function (e.g. fs.promises.readFile):
            // wait for the Promise to resolve, then respond.
            (rawResult as Promise<unknown>).then(r => respond(r)).catch(sendErr);
          } else {
            // Sync return value, or callback-style function.
            // Callbacks will arrive via SSE — respond right away.
            respond(rawResult);
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
      resolve(_port);
    });
  });

  return _ready;
}
