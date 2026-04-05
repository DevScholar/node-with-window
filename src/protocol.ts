// ── Types ──────────────────────────────────────────────────────────────────────

export interface SchemePrivileges {
  /** WebView2: TreatAsSecure. WebKit: treated as a secure context (like https). */
  secure?: boolean;
  /**
   * WebView2: HasAuthorityComponent — enables scheme://host/path style URLs.
   * Set true for http-like schemes.
   */
  standard?: boolean;
}

export interface RegisteredScheme {
  scheme: string;
  privileges?: SchemePrivileges;
}

export interface ProtocolRequest {
  url: string;
  method: string;
}

export interface ProtocolResponse {
  statusCode?: number;
  /** MIME type, e.g. "text/html", "application/javascript", "image/png". */
  mimeType?: string;
  /**
   * Response body. String is encoded as UTF-8. Buffer is transmitted as-is
   * (binary-safe on both Windows and Linux).
   */
  data: string | Buffer | null;
}

export type ProtocolHandler = (
  request: ProtocolRequest,
) => ProtocolResponse | Promise<ProtocolResponse>;

// ── Protocol singleton ────────────────────────────────────────────────────────

class Protocol {
  private _schemes = new Map<string, SchemePrivileges>();
  private _handlers = new Map<string, ProtocolHandler>();

  /**
   * Pre-register schemes with privileges. Must be called before any BrowserWindow
   * is created (before app is ready) so that the WebView environment is configured
   * to accept requests for the scheme.
   */
  registerSchemesAsPrivileged(schemes: RegisteredScheme[]): void {
    for (const { scheme, privileges } of schemes) {
      this._schemes.set(scheme, privileges ?? {});
    }
  }

  /**
   * Register a handler for requests to the given scheme.
   *
   * The scheme should first be registered with `registerSchemesAsPrivileged`.
   * The handler is called for every request to `scheme://*`.
   *
   * **Windows note**: the handler runs in a worker thread (worker_threads) so
   * that async handlers work. Because the function source is eval'd in the
   * worker, closures over variables from the outer scope are NOT supported.
   * Use inline `require()`/`await import()` inside the handler body instead.
   *
   * **Linux note**: the handler runs on the main thread; async and closures
   * both work normally.
   */
  handle(scheme: string, handler: ProtocolHandler): void {
    this._handlers.set(scheme, handler);
  }

  /** Remove the handler for the given scheme. */
  unhandle(scheme: string): void {
    this._handlers.delete(scheme);
  }

  /** Returns true if a handler is currently registered for the scheme. */
  isProtocolHandled(scheme: string): boolean {
    return this._handlers.has(scheme);
  }

  /** @internal — used by backends */
  getRegisteredSchemes(): Map<string, SchemePrivileges> {
    return this._schemes;
  }

  /** @internal — used by backends */
  getHandler(scheme: string): ProtocolHandler | undefined {
    return this._handlers.get(scheme);
  }

  /** @internal — used by backends */
  getAllHandlers(): Map<string, ProtocolHandler> {
    return this._handlers;
  }
}

export const protocol = new Protocol();

// ── Windows worker-thread bridge ──────────────────────────────────────────────
//
// On Windows, `add_WebResourceRequested` is a synchronous C# event.
// We bridge async handlers by:
//   1. Running each handler in a dedicated worker thread (worker_threads).
//   2. Blocking the main thread with Atomics.wait() until the worker responds.
//   3. Returning the result synchronously to C# — fully transparent to node-ps1-dotnet.
//
// SharedArrayBuffer layout (all at byte offset 0):
//   [0..3]   Int32  state  :  0=idle, 1=request_pending, 2=response_ready, 255=shutdown
//   [4..7]   Int32  reqLen :  length of request JSON in dataBuf
//   [8..11]  Int32  resLen :  length of response JSON in dataBuf
//   [12..15] Int32  (padding)
//   [16...]  Uint8  dataBuf: request JSON followed (reused) by response JSON
//
// State machine:
//   main: store(state,1) → notify → wait(state,1)
//   worker: wait(state,0) → process → store(state,2) → notify → wait(state,2)
//   main: read result → store(state,0) → notify        (acknowledges to worker)

const WORKER_CODE = /* language=js */ `
'use strict';
const { workerData } = require('worker_threads');

const ctrl    = new Int32Array(workerData.sharedBuf, 0, 4);
const dataBuf = new Uint8Array(workerData.sharedBuf, 16);
const dec     = new TextDecoder();
const enc     = new TextEncoder();

// Reconstruct handler functions from their source strings.
// Each entry in workerData.handlers is [scheme, functionSourceString].
const handlers = Object.create(null);
for (const scheme of Object.keys(workerData.handlers)) {
  try {
    handlers[scheme] = eval('(' + workerData.handlers[scheme] + ')');
  } catch (e) {
    handlers[scheme] = null;
    process.stderr.write('[protocol-worker] Failed to eval handler for ' + scheme + ': ' + e + '\\n');
  }
}

async function loop() {
  while (true) {
    // Wait for main thread to post a request (state 0 → 1).
    Atomics.wait(ctrl, 0, 0);
    if (ctrl[0] === 255) break; // shutdown

    // Read request.
    const reqLen = ctrl[1];
    const req = JSON.parse(dec.decode(dataBuf.slice(0, reqLen)));
    const scheme = req._scheme;
    const handler = handlers[scheme];

    let resObj;
    try {
      const result = handler
        ? await handler({ url: req.url, method: req.method })
        : { statusCode: 404, data: 'No handler for scheme: ' + scheme };

      let body = result.data;
      let isBase64 = false;

      if (body instanceof Uint8Array || (body && typeof body === 'object' && body.buffer)) {
        // Buffer / Uint8Array → base64
        const uint8 = body instanceof Uint8Array ? body : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        // btoa equivalent via Buffer
        body = Buffer.from(uint8).toString('base64');
        isBase64 = true;
      } else if (body === null || body === undefined) {
        body = '';
      }

      resObj = {
        ok: true,
        statusCode: result.statusCode ?? 200,
        mimeType: result.mimeType ?? null,
        body: body,
        isBase64,
      };
    } catch (e) {
      resObj = { ok: false, statusCode: 500, body: String(e), isBase64: false, mimeType: null };
    }

    // Write response.
    const resBytes = enc.encode(JSON.stringify(resObj));
    dataBuf.set(resBytes);
    ctrl[2] = resBytes.length;
    Atomics.store(ctrl, 0, 2);
    Atomics.notify(ctrl, 0, 1); // wake main thread

    // Wait for main thread to acknowledge (state 2 → 0).
    Atomics.wait(ctrl, 0, 2);
  }
}

loop().catch(e => process.stderr.write('[protocol-worker] Fatal: ' + e + '\\n'));
`;

const SHARED_BUF_SIZE = 32 * 1024 * 1024; // 32 MB

let _sharedBuf: SharedArrayBuffer | null = null;
let _ctrl: Int32Array | null = null;
let _dataBuf: Uint8Array | null = null;
let _worker: unknown = null;

/**
 * Spawn (or respawn) the worker thread with the current set of handlers.
 * Must be called on Windows after all `protocol.handle()` calls and before
 * `add_WebResourceRequested` is registered.
 * @internal
 */
export function ensureProtocolWorker(handlers: Map<string, ProtocolHandler>): void {
  if (_worker) {
    (_worker as { terminate: () => void }).terminate();
    _worker = null;
  }
  if (handlers.size === 0) return;

  _sharedBuf = new SharedArrayBuffer(SHARED_BUF_SIZE);
  _ctrl      = new Int32Array(_sharedBuf, 0, 4);
  _dataBuf   = new Uint8Array(_sharedBuf, 16);

  // Serialize handler sources.
  const handlerSources: Record<string, string> = {};
  for (const [scheme, fn] of handlers) {
    handlerSources[scheme] = fn.toString();
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Worker } = require('worker_threads') as typeof import('worker_threads');
  _worker = new Worker(WORKER_CODE, {
    eval: true,
    workerData: { sharedBuf: _sharedBuf, handlers: handlerSources },
  });
}

/**
 * Call a protocol handler synchronously by proxying through the worker thread.
 * Blocks the main thread with Atomics.wait() until the worker responds.
 * Safe to call from inside an `add_WebResourceRequested` callback.
 * @internal
 */
export function callHandlerSync(
  scheme: string,
  url: string,
  method: string,
): { statusCode: number; mimeType: string | null; body: string; isBase64: boolean } {
  if (!_ctrl || !_dataBuf) {
    return { statusCode: 500, mimeType: null, body: 'Protocol worker not initialized', isBase64: false };
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // Write request.
  const reqBytes = enc.encode(JSON.stringify({ _scheme: scheme, url, method }));
  _dataBuf.set(reqBytes);
  _ctrl[1] = reqBytes.length;

  // Signal worker: state 0 → 1.
  Atomics.store(_ctrl, 0, 1);
  Atomics.notify(_ctrl, 0, 1);

  // Block until worker sets state to 2 (response_ready).
  Atomics.wait(_ctrl, 0, 1);

  // Read response.
  const resLen = _ctrl[2];
  const res = JSON.parse(dec.decode(_dataBuf.slice(0, resLen))) as {
    ok: boolean;
    statusCode: number;
    mimeType: string | null;
    body: string;
    isBase64: boolean;
  };

  // Acknowledge: state 2 → 0, wake worker.
  Atomics.store(_ctrl, 0, 0);
  Atomics.notify(_ctrl, 0, 1);

  if (!res.ok) {
    return { statusCode: res.statusCode, mimeType: null, body: res.body, isBase64: false };
  }
  return { statusCode: res.statusCode, mimeType: res.mimeType, body: res.body, isBase64: res.isBase64 };
}
