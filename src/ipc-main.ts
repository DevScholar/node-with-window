import { EventEmitter } from 'events';
import * as nodeWorker from 'node:worker_threads';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

type IpcHandler = (event: IpcMainEvent, ...args: unknown[]) => unknown;

/**
 * Event object passed to IPC handlers.
 * 
 * This is similar to Electron's IpcMainEvent and provides:
 * - sender: Reference to the window that sent the message
 * - frameId: The frame ID that sent the message
 * - reply: Function to send a response back to the renderer
 */
interface IpcMainEvent {
    sender: unknown;
    frameId: number;
    reply: (channel: string, ...args: unknown[]) => void;
}

/**
 * Registry for callback functions used in IPC communication.
 * 
 * Callbacks are needed when you want to pass a function from
 * renderer to main process (e.g., for progress callbacks).
 */
const callbackRegistry = new Map<string, Function>();

/**
 * IPC Main - handles inter-process communication between renderer and main process.
 * 
 * This class manages:
 * - Handler registration for IPC channels
 * - Synchronous and asynchronous invocation
 * - Worker thread pool for async operations
 * 
 * Why use a worker thread pool?
 * - The .NET bridge (node-ps1-dotnet) uses synchronous stdin/stdout
 * - If we do async work in the main thread, we might block the bridge
 * - Workers let us run async handlers without blocking
 * 
 * IMPORTANT: Workers must be properly cleaned up to avoid memory leaks.
 * Call dispose() when shutting down the application.
 */
class AsyncIpcMain extends EventEmitter {
    /**
     * Map of channel names to their handler functions.
     */
    public handlers = new Map<string, IpcHandler>();
    
    /**
     * Pool of worker threads for running async handlers.
     */
    private workerPool: nodeWorker.Worker[] = [];
    
    /**
     * Maximum number of workers in the pool.
     */
    private maxWorkers = 4;
    
    /**
     * Current worker index for round-robin distribution.
     */
    private currentWorkerIndex = 0;
    
    /**
     * Flag indicating if this instance has been disposed.
     */
    private isDisposed = false;

    constructor() {
        super();
        // Workers are now lazily initialized to avoid creating them unnecessarily
    }

    /**
     * Lazily initializes the worker pool.
     * 
     * We don't create workers immediately because:
     * 1. Most IPC might be synchronous (no workers needed)
     * 2. Worker creation has overhead
     * 3. Users might not use async IPC at all
     */
    private initializeWorkerPool(): void {
        if (this.workerPool.length > 0 || this.isDisposed) {
            return;
        }
        
        /**
         * Worker code that handles async IPC calls.
         * 
         * This runs in a separate thread, allowing us to run async
         * handlers without blocking the main event loop.
         * 
         * The worker:
         * 1. Listens for messages from the main thread
         * 2. Executes the handler function
         * 3. Returns the result or error
         */
        const workerCode = `
const { parentPort, workerData } = require('worker_threads');

parentPort.on('message', async (msg) => {
    try {
        const { id, channel, args, handler } = msg;
        let result;
        
        if (handler && typeof handler === 'function') {
            try {
                result = await handler(...args);
            } catch (err) {
                result = { __error: err.message || String(err) };
            }
        } else {
            result = { __error: 'No handler provided' };
        }
        
        parentPort.postMessage({ id, result });
    } catch (err) {
        parentPort.postMessage({ id, error: String(err) });
    }
});
`;
        for (let i = 0; i < this.maxWorkers; i++) {
            try {
                const worker = new nodeWorker.Worker(workerCode, { eval: true });
                this.workerPool.push(worker);
            } catch (e) {
                console.warn('[node-with-window] Failed to create worker:', e);
            }
        }
    }

    /**
     * Registers a handler for an IPC channel.
     * 
     * This is the main way to handle messages from the renderer:
     * 
     * ```javascript
     * ipcMain.handle('fs:readFile', async (event, filePath) => {
     *     return fs.readFileSync(filePath, 'utf-8');
     * });
     * ```
     * 
     * @param channel - The channel name to handle
     * @param listener - The handler function
     */
    public handle(channel: string, listener: IpcHandler): void {
        this.handlers.set(channel, listener);
    }

    /**
     * Alias for handle() - registers a one-way handler.
     * 
     * Unlike handle(), this is for fire-and-forget messages
     * that don't expect a response.
     * 
     * @param channel - The channel name to handle
     * @param listener - The handler function
     */
    public onChannel(channel: string, listener: IpcHandler): void {
        this.handlers.set(channel, listener);
    }

    /**
     * Synchronously invokes a handler.
     * 
     * This is used for synchronous IPC calls where we can't await.
     * Note: If the handler returns a Promise, it will be ignored!
     * 
     * @param channel - The channel to invoke
     * @param event - The IPC event object
     * @param args - Arguments to pass to the handler
     * @returns The handler's return value
     * @throws Error if no handler is registered
     */
    public _invoke(channel: string, event: IpcMainEvent, ...args: unknown[]): unknown {
        const handler = this.handlers.get(channel);
        if (handler) {
            return handler(event, ...args);
        }
        throw new Error(`No handler registered for channel "${channel}"`);
    }

    /**
     * Asynchronously invokes a handler using a worker thread.
     * 
     * This is for handlers that need to do async work without
     * blocking the main thread. The handler runs in a worker.
     * 
     * @param channel - The channel to invoke
     * @param event - The IPC event object
     * @param args - Arguments to pass to the handler
     * @returns Promise that resolves with the handler's result
     * @throws Error if no handler is registered or on timeout
     */
    public async invokeAsync(channel: string, event: IpcMainEvent, ...args: unknown[]): Promise<unknown> {
        const handler = this.handlers.get(channel);
        if (!handler) {
            throw new Error(`No handler registered for channel "${channel}"`);
        }

        // Lazily initialize worker pool if needed
        if (this.workerPool.length === 0) {
            this.initializeWorkerPool();
        }

        if (this.workerPool.length > 0) {
            return new Promise((resolve, reject) => {
                const id = `async_${Date.now()}_${Math.random()}`;
                const worker = this.workerPool[this.currentWorkerIndex % this.workerPool.length];
                this.currentWorkerIndex++;

                /**
                 * Wrapper that runs the handler in the worker.
                 * 
                 * We pass the handler as a string (toString()) and eval it
                 * in the worker. This is necessary because workers can't
                 * directly access functions from the main thread.
                 */
                const handlerWrapper = async (...a: unknown[]) => {
                    try {
                        return await handler(event, ...a);
                    } catch (err) {
                        return { __error: String(err) };
                    }
                };

                // Timeout after 30 seconds to prevent hanging
                const timeout = setTimeout(() => {
                    reject(new Error(`IPC timeout for channel "${channel}"`));
                }, 30000);

                const handlerFn = (msg: { id: string; result?: unknown; error?: string }) => {
                    if (msg.id === id) {
                        clearTimeout(timeout);
                        worker.off('message', handlerFn);
                        if (msg.error) {
                            reject(new Error(msg.error));
                        } else if (msg.result && typeof msg.result === 'object' && '__error' in msg.result) {
                            reject(new Error((msg.result as { __error: string }).__error));
                        } else {
                            resolve(msg.result);
                        }
                    }
                };

                worker.on('message', handlerFn);
                worker.postMessage({ id, channel, args, handler: handlerWrapper.toString() });
            });
        }

        // Fallback: try to run handler directly (works for sync handlers)
        return new Promise((resolve) => {
            const result = handler(event, ...args);
            if (result && typeof result === 'object' && 'then' in result) {
                (result as Promise<unknown>).then(resolve).catch((err) => resolve({ __error: String(err) }));
            } else {
                resolve(result);
            }
        });
    }

    /**
     * Sends a message to handlers (fire-and-forget).
     * 
     * This doesn't wait for a response - it just emits the event
     * to all registered handlers.
     * 
     * @param channel - The channel to send to
     * @param args - Arguments to send
     */
    public send(channel: string, ...args: unknown[]): void {
        this.emit(channel, ...args);
    }

    /**
     * Disposes of the IPC main instance.
     * 
     * This:
     * 1. Terminates all worker threads
     * 2. Clears the handler map
     * 3. Clears the callback registry
     * 
     * Call this when shutting down the application to prevent
     * resource leaks.
     */
    public dispose(): void {
        if (this.isDisposed) {
            return;
        }
        
        this.isDisposed = true;
        
        // Terminate all workers
        for (const worker of this.workerPool) {
            try {
                worker.terminate();
            } catch (e) {
                // Ignore errors during termination
            }
        }
        this.workerPool = [];
        
        // Clear handlers
        this.handlers.clear();
        
        // Clear callback registry
        callbackRegistry.clear();
    }
}

/**
 * The singleton IPC main instance.
 * 
 * Use this to register handlers and send messages:
 * 
 * ```javascript
 * import { ipcMain } from 'node-with-window';
 * 
 * ipcMain.handle('my-channel', (event, ...args) => {
 *     // Handle the message
 * });
 * ```
 */
export const ipcMain = new AsyncIpcMain();

/**
 * Wraps a callback function for IPC communication.
 * 
 * This is used when you need to pass a function from the
 * main process to the renderer (e.g., for progress callbacks).
 * 
 * @param fn - The function to wrap
 * @returns A unique ID that can be passed to the renderer
 */
export function wrapCallback(fn: Function): string {
    const id = `cb_${Date.now()}_${Math.random()}`;
    callbackRegistry.set(id, fn);
    return id;
}

/**
 * Unwraps a callback function by ID.
 * 
 * @param id - The callback ID
 * @returns The wrapped function, or undefined if not found
 */
export function unwrapCallback(id: string): Function | undefined {
    return callbackRegistry.get(id);
}
