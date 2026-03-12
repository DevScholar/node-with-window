import { describe, it, expect, afterEach, vi } from 'vitest';
import { ipcMain } from '../../src/ipc-main.js';

// Clean up both EventEmitter listeners and handle() handlers after each test.
afterEach(() => {
  ipcMain.removeAllListeners();
  (ipcMain as unknown as { handlers: Map<string, unknown> }).handlers.clear();
});

// Build a minimal IpcMainEvent-like object for testing.
function makeEvent() {
  return {
    sender: null,
    frameId: 0,
    returnValue: undefined as unknown,
    reply: vi.fn(),
  };
}

describe('ipcMain.handle / removeHandler', () => {
  it('registers and invokes a handler', () => {
    ipcMain.handle('ch:ping', (_event, val) => `pong:${val}`);
    const handlers = (ipcMain as unknown as { handlers: Map<string, Function> }).handlers;
    const result = handlers.get('ch:ping')!(makeEvent(), 'hello');
    expect(result).toBe('pong:hello');
  });

  it('removeHandler stops the handler from being invoked', () => {
    const fn = vi.fn();
    ipcMain.handle('ch:remove', fn);
    ipcMain.removeHandler('ch:remove');
    const handlers = (ipcMain as unknown as { handlers: Map<string, Function> }).handlers;
    expect(handlers.has('ch:remove')).toBe(false);
  });

  it('overwriting a handler replaces the previous one', () => {
    ipcMain.handle('ch:overwrite', () => 'first');
    ipcMain.handle('ch:overwrite', () => 'second');
    const handlers = (ipcMain as unknown as { handlers: Map<string, Function> }).handlers;
    expect(handlers.get('ch:overwrite')!(makeEvent())).toBe('second');
  });
});

describe('ipcMain.handleOnce', () => {
  it('fires once then removes itself', () => {
    const fn = vi.fn(() => 'once-result');
    ipcMain.handleOnce('ch:once', fn);
    const handlers = (ipcMain as unknown as { handlers: Map<string, Function> }).handlers;
    // First call fires the handler and removes it.
    const result = handlers.get('ch:once')!(makeEvent());
    expect(result).toBe('once-result');
    expect(fn).toHaveBeenCalledOnce();
    // Handler should now be gone.
    expect(handlers.has('ch:once')).toBe(false);
  });
});

describe('ipcMain.on / once / off (EventEmitter)', () => {
  it('on() receives events emitted on that channel', () => {
    const received: unknown[] = [];
    ipcMain.on('ch:send', (_event, a, b) => received.push([a, b]));
    const event = makeEvent();
    ipcMain.emit('ch:send', event, 'x', 42);
    expect(received).toEqual([['x', 42]]);
  });

  it('on() fires on every emit', () => {
    const fn = vi.fn();
    ipcMain.on('ch:multi', fn);
    ipcMain.emit('ch:multi', makeEvent());
    ipcMain.emit('ch:multi', makeEvent());
    ipcMain.emit('ch:multi', makeEvent());
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('once() fires exactly once', () => {
    const fn = vi.fn();
    ipcMain.once('ch:once-ee', fn);
    ipcMain.emit('ch:once-ee', makeEvent());
    ipcMain.emit('ch:once-ee', makeEvent());
    expect(fn).toHaveBeenCalledOnce();
  });

  it('off() removes a registered listener', () => {
    const fn = vi.fn();
    ipcMain.on('ch:off', fn);
    ipcMain.off('ch:off', fn);
    ipcMain.emit('ch:off', makeEvent());
    expect(fn).not.toHaveBeenCalled();
  });

  it('multiple listeners on the same channel all fire', () => {
    const a = vi.fn(), b = vi.fn();
    ipcMain.on('ch:multi-listener', a);
    ipcMain.on('ch:multi-listener', b);
    ipcMain.emit('ch:multi-listener', makeEvent());
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('on() and handle() are independent registries', () => {
    const onFn  = vi.fn(() => 'from-on');
    const hndFn = vi.fn(() => 'from-handle');
    ipcMain.on('ch:dual', onFn);
    ipcMain.handle('ch:dual', hndFn);

    // Emitting fires only the EventEmitter listener.
    ipcMain.emit('ch:dual', makeEvent());
    expect(onFn).toHaveBeenCalledOnce();
    expect(hndFn).not.toHaveBeenCalled();

    // The handlers map still has the handle() entry.
    const handlers = (ipcMain as unknown as { handlers: Map<string, Function> }).handlers;
    handlers.get('ch:dual')!(makeEvent());
    expect(hndFn).toHaveBeenCalledOnce();
  });
});

describe('event.returnValue (sendSync support)', () => {
  it('on() handler can mutate event.returnValue', () => {
    ipcMain.on('ch:sync', (event) => {
      event.returnValue = 'sync-response';
    });
    const event = makeEvent();
    ipcMain.emit('ch:sync', event);
    expect(event.returnValue).toBe('sync-response');
  });

  it('returnValue is undefined if no handler sets it', () => {
    ipcMain.on('ch:no-return', (_event) => { /* nothing */ });
    const event = makeEvent();
    ipcMain.emit('ch:no-return', event);
    expect(event.returnValue).toBeUndefined();
  });
});

describe('event.reply', () => {
  it('reply function is callable and passed correctly', () => {
    let replyCalled = false;
    let repliedChannel = '';
    ipcMain.on('ch:reply', (event) => {
      event.reply('reply-channel', 'data');
    });
    const event = {
      sender: null,
      frameId: 0,
      returnValue: undefined as unknown,
      reply: (ch: string) => { replyCalled = true; repliedChannel = ch; },
    };
    ipcMain.emit('ch:reply', event);
    expect(replyCalled).toBe(true);
    expect(repliedChannel).toBe('reply-channel');
  });
});
