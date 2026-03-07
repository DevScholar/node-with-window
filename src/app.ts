import { EventEmitter } from 'node:events';
import { resolveBackend, ensureBackendInitialized, setAppBackendName } from './backends.js';

/**
 * App - Main Application Controller
 * 
 * This is the entry point for the node-with-window library. It:
 * 1. Initializes platform-specific runtime (e.g., .NET on Windows)
 * 2. Provides lifecycle events (ready, before-quit)
 * 3. Exits the process when quit() is called
 * 
 * IMPORTANT: The order of initialization matters!
 * 
 * This class is instantiated lazily (see the export at the bottom).
 * Initialization starts when whenReady() is first called.
 * 
 * This means:
 * - When you import { app } from 'node-with-window', no processes start
 * - Only when you call await app.whenReady() does initialization begin
 * - This gives users full control over when and if the platform initializes
 */

/**
 * App class - singleton that manages the application lifecycle
 * 
 * Extends EventEmitter to provide lifecycle events:
 * - 'ready': Fired when the app has finished initializing
 * - 'before-quit': Fired before the app exits
 * - 'error': Fired when initialization fails
 * 
 * On Windows, this also initializes the .NET runtime via node-ps1-dotnet.
 */
class App extends EventEmitter {
    /**
     * Promise that resolves when the app is ready.
     * 
     * Use this to wait for platform initialization before creating windows:
     * 
     * ```javascript
     * const { app, BrowserWindow } = require('node-with-window');
     * 
     * await app.whenReady();
     * const win = new BrowserWindow();
     * ```
     */
    private readyPromise: Promise<void>;
    
    /**
     * Resolution function for readyPromise.
     * Set when whenReady() is first called.
     */
    private readyResolve!: () => void;
    
    /**
     * Rejection function for readyPromise.
     * Set when whenReady() is first called.
     */
    private readyReject!: (reason: unknown) => void;
    
    /**
     * Flag to track if initialization has started.
     */
    private initializationStarted = false;
    
    /**
     * Flag to track if the app has been quit.
     */
    private isQuitting = false;

    constructor() {
        super();
        
        // Create a promise that we resolve when initialization is complete
        // Note: We don't start initialization here - it's lazy
        this.readyPromise = new Promise((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
    }

    /**
     * Initializes the platform-specific runtime (lazy initialization).
     *
     * Resolves the active backend (app-level override or platform default) and
     * calls its initialize() method exactly once. On Windows this starts the
     * .NET/PowerShell bridge; on Linux no global setup is needed.
     *
     * Why lazy initialization?
     * - No module-level side effects (good for testing)
     * - Proper error handling via promise rejection
     * - Users control when initialization starts
     */
    private async initializePlatform(): Promise<void> {
        const backend = resolveBackend();
        await ensureBackendInitialized(backend.name);

        // Mark the app as ready and emit the event
        this.readyResolve();
        this.emit('ready');
    }

    /**
     * Returns a promise that resolves when the app is ready.
     * 
     * ```javascript
     * await app.whenReady();
     * // Now it's safe to create windows
     * ```
     * 
     * @returns Promise that resolves when initialization is complete
     * @throws Error if platform initialization fails
     */
    public async whenReady(): Promise<void> {
        // If already initialized, return immediately
        if (this.initializationStarted) {
            return this.readyPromise;
        }
        
        // Mark initialization as started
        this.initializationStarted = true;
        
        // Start initialization
        this.initializePlatform().catch((e) => {
            this.readyReject(e);
        });
        
        return this.readyPromise;
    }

    /**
     * Override the default backend for this platform.
     * Must be called before app.whenReady().
     *
     * Example: app.setBackend('netfx-wpf');
     */
    public setBackend(name: string): void {
        if (this.initializationStarted)
            throw new Error('Cannot change backend after app.whenReady() has been called.');
        setAppBackendName(name);
    }

    /**
     * Checks if the app is currently initializing.
     * 
     * @returns true if initialization has started but not completed
     */
    public isInitializing(): boolean {
        return this.initializationStarted && this.readyPromise !== Promise.resolve();
    }

    /**
     * Checks if the app has been quit.
     * 
     * @returns true if quit() has been called
     */
    public get quitting(): boolean {
        return this.isQuitting;
    }

    /**
     * Quits the application.
     * 
     * This:
     * 1. Emits the 'before-quit' event
     * 2. Exits the Node.js process with code 0
     * 
     * Note: On Windows, the WPF application will also close because
     * we set up a handler in show() that calls process.exit() when
     * the window closes.
     */
    public quit(): void {
        this.isQuitting = true;
        this.emit('before-quit');
        process.exit(0);
    }
}

/**
 * The singleton app instance (lazy initialization).
 * 
 * When you import { app } from 'node-with-window', you get this instance.
 * No initialization happens until whenReady() is called.
 * 
 * This is different from the previous implementation where app was created
 * immediately at module load time, which caused side effects.
 */
export const app = new App();
