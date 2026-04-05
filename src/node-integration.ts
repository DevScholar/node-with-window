import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ipcMain } from './ipc-main.js';

/**
 * Node integration via the nww:// custom protocol (no HTTP server).
 *
 * handleNwwRequest() is the single synchronous entry point called by both
 * platform backends' custom scheme handlers.
 *
 * Callbacks (fs.watch, EventEmitter.on, etc.) and async function results are
 * pushed to all open renderer windows via the addNwwCallbackPusher() registry
 * instead of the old SSE channel.
 *
 * Async Promise results:
 *   When a Node.js method returns a Promise, handleNwwRequest() returns
 *   { result: { __nww_async: asyncId } } immediately.  When the Promise
 *   settles, it pushes a synthetic callback with args
 *     ['__nww_resolve', serializedResult]  or  ['__nww_reject', errorMessage]
 *   The bridge script intercepts these and resolves/rejects a matching Promise
 *   stored in window.__nwwAsyncPending[asyncId].
 */

// ── Module resolver ───────────────────────────────────────────────────────────

// Resolve modules relative to the user's project so that npm packages
// installed there are found, in addition to Node.js built-ins.
const _require = createRequire(pathToFileURL(process.cwd() + '/'));

// ── Ref registry ──────────────────────────────────────────────────────────────

/**
 * Server-side registry for non-serializable Node.js objects.
 * The renderer receives only the id ({ __nww_ref: id }) and calls methods
 * on it via the /__nww_sync__ endpoint.
 */
const refRegistry = new Map<string, unknown>();

// ── Callback pusher registry ──────────────────────────────────────────────────

/** One push function per open window, registered on window init. */
const _callbackPushers = new Set<(id: string, args: unknown[]) => void>();

/** Register a window's IPC push function. Call on window open. */
export function addNwwCallbackPusher(fn: (id: string, args: unknown[]) => void): void {
  _callbackPushers.add(fn);
}

/** Unregister a window's IPC push function. Call on window close. */
export function removeNwwCallbackPusher(fn: (id: string, args: unknown[]) => void): void {
  _callbackPushers.delete(fn);
  // When the last window closes, clear all server-side refs.
  if (_callbackPushers.size === 0) refRegistry.clear();
}

function pushCallback(id: string, args: unknown[]): void {
  for (const push of _callbackPushers) {
    try { push(id, args); } catch { /* window closed */ }
  }
}

// ── Serialization helpers ─────────────────────────────────────────────────────

function isNeedsRef(val: unknown): boolean {
  if (val === null || typeof val !== 'object') return false;
  if (Array.isArray(val)) return false;
  if (Object.getPrototypeOf(val) === Object.prototype) return false;
  return true;
}

function storeRef(obj: unknown): string {
  const id = Math.random().toString(36).substring(2, 11);
  refRegistry.set(id, obj);
  return id;
}

function serializeValue(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(serializeValue);
  if (isNeedsRef(val)) return { __nww_ref: storeRef(val) };
  return val;
}

function resolveArg(a: unknown): unknown {
  if (a === null || typeof a !== 'object') return a;
  const obj = a as Record<string, unknown>;
  if (typeof obj.__nww_cb === 'string') {
    const id = obj.__nww_cb;
    return (...cbArgs: unknown[]) =>
      pushCallback(id, (cbArgs as unknown[]).map(serializeValue));
  }
  if (typeof obj.__nww_ref === 'string') {
    return refRegistry.get(obj.__nww_ref);
  }
  return a;
}

// ── Response type ─────────────────────────────────────────────────────────────

export interface NwwResponse {
  status: number;
  mimeType: string;
  body: string;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

// ── Request handler ───────────────────────────────────────────────────────────

const ok  = (data: unknown): NwwResponse => ({
  status: 200, mimeType: 'application/json',
  body: JSON.stringify({ result: serializeValue(data) }),
});
const err = (msg: string, status = 500): NwwResponse => ({
  status, mimeType: 'application/json',
  body: JSON.stringify({ error: msg }),
});

/**
 * Synchronously handle a nww:// scheme request.
 * Called from both platform backends' custom scheme handlers.
 *
 * @param uri    Full nww:// URI, e.g. "nww://host/__nww_sync__"
 * @param method HTTP method ("GET" or "POST")
 * @param body   Request body for POST requests, null for GET
 */
export function handleNwwRequest(
  uri: string,
  method: string,
  body: string | null,
): NwwResponse {
  let url: URL;
  try {
    url = new URL(uri.replace(/^nww:/, 'http:'));
  } catch {
    return err('Invalid URI', 400);
  }
  const pathname = url.pathname;

  // ── GET /__nww_module_keys__?m=<name> ──────────────────────────────────────
  if (pathname === '/__nww_module_keys__') {
    const m = url.searchParams.get('m') ?? '';
    try {
      const mod = _require(m) as Record<string, unknown>;
      const keys = Object.getOwnPropertyNames(mod).filter(
        k => k !== '__esModule' && k !== 'default' && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k),
      );
      return { status: 200, mimeType: 'application/json', body: JSON.stringify({ keys }) };
    } catch (e: unknown) {
      return err((e as Error).message ?? String(e));
    }
  }

  // ── GET /__nww_esm__/<moduleName> ──────────────────────────────────────────
  if (pathname.startsWith('/__nww_esm__/')) {
    const moduleName = decodeURIComponent(pathname.slice('/__nww_esm__/'.length));
    if (!moduleName) return { status: 400, mimeType: 'text/plain', body: 'Missing module name' };

    if (moduleName === '@devscholar/node-with-window') {
      return {
        status: 200, mimeType: 'text/javascript',
        body: [
          '/* nww ESM shim: @devscholar/node-with-window */',
          'export var ipcRenderer = window.ipcRenderer;',
          'export default { ipcRenderer: window.ipcRenderer };',
        ].join('\n'),
      };
    }

    try {
      const mod = _require(moduleName) as Record<string, unknown>;
      const keys = Object.getOwnPropertyNames(mod).filter(
        k => k !== '__esModule' && k !== 'default' && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k),
      );
      const namedExports = keys
        .map(k => `export var ${k} = _m[${JSON.stringify(k)}];`)
        .join('\n');
      return {
        status: 200, mimeType: 'text/javascript',
        body: [
          `/* nww ESM shim: ${moduleName} */`,
          `var _m = window.require(${JSON.stringify(moduleName)});`,
          namedExports,
          `export default _m;`,
        ].join('\n'),
      };
    } catch (e: unknown) {
      return { status: 500, mimeType: 'text/plain', body: (e as Error).message ?? String(e) };
    }
  }

  // All remaining endpoints are POST and require a parsed body.
  if (body !== null && body.length > MAX_BODY_BYTES) return err('Request too large', 413);
  let parsed: Record<string, unknown> = {};
  if (body) {
    try { parsed = JSON.parse(body) as Record<string, unknown>; }
    catch { return err('Invalid JSON body', 400); }
  }

  // ── POST /__nww_release__ ───────────────────────────────────────────────────
  if (pathname === '/__nww_release__') {
    const refs = parsed.refs;
    if (Array.isArray(refs)) {
      for (const id of refs) {
        if (typeof id === 'string') refRegistry.delete(id);
      }
    }
    return { status: 204, mimeType: 'application/json', body: '' };
  }

  // ── POST /__nww_ipc_sync__ ──────────────────────────────────────────────────
  if (pathname === '/__nww_ipc_sync__') {
    const { channel, args = [] } = parsed as { channel: string; args: unknown[] };
    const event = {
      returnValue: undefined as unknown,
      sender: null,
      frameId: 0,
      reply: () => {},
    };
    try {
      ipcMain.emit(channel, event, ...(args as unknown[]).map(resolveArg));
      const returnVal = event.returnValue !== undefined ? serializeValue(event.returnValue) : null;
      return ok(returnVal);
    } catch (e: unknown) {
      return err((e as Error).message ?? String(e));
    }
  }

  // ── POST /__nww_sync__ ──────────────────────────────────────────────────────
  if (pathname === '/__nww_sync__') {
    try {
      let target: unknown;
      let methodName: string;
      let rawArgs: unknown[];

      if (typeof parsed.ref === 'string') {
        target = refRegistry.get(parsed.ref);
        if (target === undefined) return err(`Unknown ref: ${parsed.ref}`);
        methodName = parsed.methodName as string;
        rawArgs = (parsed.args as unknown[]) ?? [];
      } else {
        target = _require(parsed.moduleName as string);
        methodName = parsed.methodName as string;
        rawArgs = (parsed.args as unknown[]) ?? [];
      }

      const fn = (target as Record<string, unknown>)[methodName];
      if (typeof fn !== 'function') return err(`${methodName} is not a function`);

      let hasCallbacks = false;
      const resolvedArgs = rawArgs.map(a => {
        if (
          a !== null &&
          typeof a === 'object' &&
          typeof (a as Record<string, unknown>).__nww_cb === 'string'
        ) hasCallbacks = true;
        return resolveArg(a);
      });

      const rawResult = (fn as (...a: unknown[]) => unknown).apply(target, resolvedArgs);

      // Promise-returning function: respond immediately with an async handle,
      // then push the settled result via the callback channel.
      if (
        !hasCallbacks &&
        rawResult !== null &&
        typeof rawResult === 'object' &&
        typeof (rawResult as Promise<unknown>).then === 'function'
      ) {
        const asyncId = Math.random().toString(36).substring(2, 11);
        (rawResult as Promise<unknown>)
          .then(r  => pushCallback(asyncId, ['__nww_resolve', serializeValue(r)]))
          .catch(e => pushCallback(asyncId, ['__nww_reject',  (e as Error).message ?? String(e)]));
        return ok({ __nww_async: asyncId });
      }

      return ok(rawResult);
    } catch (e: unknown) {
      return err((e as Error).message ?? String(e));
    }
  }

  return err('Not found', 404);
}
