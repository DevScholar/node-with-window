import { EventEmitter } from 'node:events';
import type { IpcMainEvent } from './interfaces.js';

export type { IpcMainEvent };

type IpcHandler = (event: IpcMainEvent, ...args: unknown[]) => unknown;

/**
 * IPC main — manages channels between the renderer and the main process.
 *
 * Two handler types:
 *  - handle(channel, fn)  invokable channels; fn may return a Promise.
 *    The platform backend awaits the result and sends a reply message.
 *  - on(channel, fn)      fire-and-forget listeners (ipcRenderer.send /
 *    ipcRenderer.sendSync). For sendSync, set event.returnValue.
 */
class AsyncIpcMain extends EventEmitter {
  public handlers = new Map<string, IpcHandler>();

  public handle(channel: string, listener: IpcHandler): void {
    this.handlers.set(channel, listener);
  }

  public handleOnce(channel: string, listener: IpcHandler): void {
    const wrapper: IpcHandler = (event, ...args) => {
      this.handlers.delete(channel);
      return listener(event, ...args);
    };
    this.handlers.set(channel, wrapper);
  }

  public removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  public removeAllListeners(channel?: string): this {
    if (channel === undefined) {
      this.handlers.clear();
    } else {
      this.handlers.delete(channel);
    }
    return super.removeAllListeners(channel);
  }

  public on(channel: string, listener: IpcHandler): this {
    return super.on(channel, listener);
  }

  public once(channel: string, listener: IpcHandler): this {
    return super.once(channel, listener);
  }

  public off(channel: string, listener: IpcHandler): this {
    return super.off(channel, listener);
  }

  public send(channel: string, ...args: unknown[]): void {
    this.emit(channel, ...args);
  }
}

export const ipcMain = new AsyncIpcMain();
