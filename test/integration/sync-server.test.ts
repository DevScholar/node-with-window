/**
 * Integration tests for the node-integration HTTP server.
 *
 * These tests start the real sync server (once, shared across the suite) and
 * exercise each endpoint with actual HTTP requests.  No WebView or window is
 * needed — we talk to the server directly from Node.js.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { startSyncServer, getSyncServerPort } from '../../src/node-integration.js';
import { ipcMain } from '../../src/ipc-main.js';

// Start the server once before any tests run.
// startSyncServer() is idempotent — safe to call multiple times.
beforeAll(async () => {
  await startSyncServer();
});

// Clean ipcMain listeners after each test.
afterEach(() => {
  ipcMain.removeAllListeners();
  (ipcMain as unknown as { handlers: Map<string, unknown> }).handlers.clear();
});

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function base() {
  return `http://127.0.0.1:${getSyncServerPort()}`;
}

async function postJson(path: string, body: unknown) {
  const res = await fetch(`${base()}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

// ──────────────────────────────────────────────────────────────────────────────
// Server startup
// ──────────────────────────────────────────────────────────────────────────────

describe('startSyncServer', () => {
  it('binds to a non-zero port', () => {
    expect(getSyncServerPort()).toBeGreaterThan(0);
  });

  it('is idempotent — returns same port on repeated calls', async () => {
    const port1 = getSyncServerPort();
    await startSyncServer();
    expect(getSyncServerPort()).toBe(port1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// /__nww_sync__ — window.require() calls
// ──────────────────────────────────────────────────────────────────────────────

describe('/__nww_sync__ — module method calls', () => {
  it('calls os.platform() and returns a string', async () => {
    const { status, body } = await postJson('/__nww_sync__', {
      moduleName: 'os',
      methodName: 'platform',
      args: [],
    });
    expect(status).toBe(200);
    expect(typeof body.result).toBe('string');
    expect(['win32', 'linux', 'darwin']).toContain(body.result);
  });

  it('calls os.arch() and returns a string', async () => {
    const { status, body } = await postJson('/__nww_sync__', {
      moduleName: 'os',
      methodName: 'arch',
      args: [],
    });
    expect(status).toBe(200);
    expect(typeof body.result).toBe('string');
  });

  it('calls path.join() with arguments', async () => {
    const { status, body } = await postJson('/__nww_sync__', {
      moduleName: 'path',
      methodName: 'join',
      args: ['a', 'b', 'c'],
    });
    expect(status).toBe(200);
    // Result should contain all path segments
    expect(String(body.result)).toContain('a');
    expect(String(body.result)).toContain('b');
    expect(String(body.result)).toContain('c');
  });

  it('returns 500 for an unknown module', async () => {
    const { status } = await postJson('/__nww_sync__', {
      moduleName: '__nonexistent_module__',
      methodName: 'foo',
      args: [],
    });
    expect(status).toBe(500);
  });

  it('returns 500 for a non-function method', async () => {
    const { status, body } = await postJson('/__nww_sync__', {
      moduleName: 'os',
      methodName: 'notAFunction',
      args: [],
    });
    expect(status).toBe(500);
    expect(typeof body.error).toBe('string');
  });

  it('returns 405 for non-POST requests', async () => {
    const res = await fetch(`${base()}/__nww_sync__`);
    expect(res.status).toBe(405);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// /__nww_ipc_sync__ — ipcRenderer.sendSync()
// ──────────────────────────────────────────────────────────────────────────────

describe('/__nww_ipc_sync__ — ipcRenderer.sendSync()', () => {
  it('calls ipcMain.on() listener and returns event.returnValue', async () => {
    ipcMain.on('test:sync-ping', (event) => {
      event.returnValue = 'pong';
    });
    const { status, body } = await postJson('/__nww_ipc_sync__', {
      channel: 'test:sync-ping',
      args:    [],
    });
    expect(status).toBe(200);
    expect(body.result).toBe('pong');
  });

  it('passes args to the listener', async () => {
    ipcMain.on('test:sync-echo', (event, a, b) => {
      event.returnValue = { a, b };
    });
    const { status, body } = await postJson('/__nww_ipc_sync__', {
      channel: 'test:sync-echo',
      args:    [42, 'hello'],
    });
    expect(status).toBe(200);
    expect((body.result as { a: unknown; b: unknown }).a).toBe(42);
    expect((body.result as { a: unknown; b: unknown }).b).toBe('hello');
  });

  it('returns undefined (null in JSON) when no listener sets returnValue', async () => {
    ipcMain.on('test:sync-no-return', (_event) => { /* nothing */ });
    const { status, body } = await postJson('/__nww_ipc_sync__', {
      channel: 'test:sync-no-return',
      args:    [],
    });
    expect(status).toBe(200);
    // undefined serialises as null in JSON
    expect(body.result).toBeNull();
  });

  it('returns null when no listener is registered', async () => {
    const { status, body } = await postJson('/__nww_ipc_sync__', {
      channel: 'test:sync-unregistered',
      args:    [],
    });
    // No listener → returnValue stays undefined → null
    expect(status).toBe(200);
    expect(body.result).toBeNull();
  });

  it('works with complex return values', async () => {
    ipcMain.on('test:sync-complex', (event) => {
      event.returnValue = { nested: { x: 1 }, arr: [1, 2, 3] };
    });
    const { status, body } = await postJson('/__nww_ipc_sync__', {
      channel: 'test:sync-complex',
      args:    [],
    });
    expect(status).toBe(200);
    const result = body.result as { nested: { x: number }; arr: number[] };
    expect(result.nested.x).toBe(1);
    expect(result.arr).toEqual([1, 2, 3]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// /__nww_release__ — ref cleanup
// ──────────────────────────────────────────────────────────────────────────────

describe('/__nww_release__ — ref cleanup', () => {
  it('accepts a POST with a refs array and returns 204', async () => {
    const res = await fetch(`${base()}/__nww_release__`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ refs: ['fake-ref-1', 'fake-ref-2'] }),
    });
    expect(res.status).toBe(204);
  });

  it('accepts an empty refs array', async () => {
    const res = await fetch(`${base()}/__nww_release__`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ refs: [] }),
    });
    expect(res.status).toBe(204);
  });

  it('handles malformed JSON gracefully', async () => {
    const res = await fetch(`${base()}/__nww_release__`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:   'not-json',
    });
    expect(res.status).toBe(204);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// /__nww_events__ — SSE endpoint
// ──────────────────────────────────────────────────────────────────────────────

describe('/__nww_events__ — SSE endpoint', () => {
  it('responds with text/event-stream content-type', async () => {
    // We only check the headers; we don't hold the connection open.
    const ac = new AbortController();
    const res = await fetch(`${base()}/__nww_events__`, { signal: ac.signal }).catch(() => null);
    if (res) {
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      ac.abort();
    }
  });
});
