import { EventEmitter } from 'events';
import { setDotNetInstance } from './providers/windows/index';

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
     * On Windows:
     * - Imports @devscholar/node-ps1-dotnet
     * - Sets the .NET instance globally via setDotNetInstance()
     * - This makes .NET available to the Windows window provider
     * 
     * Why is this needed?
     * - node-ps1-dotnet spawns a hidden PowerShell process
     * - This process hosts .NET and handles our calls
     * - The communication is synchronous (stdin/stdout JSON)
     * 
     * Why lazy initialization?
     * - Previously we initialized in the constructor, which caused issues:
     *   1. Module-level side effects (bad for testing)
     *   2. 50ms magic delay to avoid race conditions
     *   3. No way to handle initialization errors gracefully
     * - Now initialization starts when whenReady() is called
     * - This gives users control and proper error handling
     */
    private async initializePlatform(): Promise<void> {
        if (process.platform === 'win32') {
            try {
                // Import the .NET bridge package
                // This spawns a PowerShell process with .NET hosting
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-ignore — no type declarations for this package
                const nodePs1Dotnet = await import('@devscholar/node-ps1-dotnet');
                const dotnet = nodePs1Dotnet.default || nodePs1Dotnet;
                
                // Set the .NET instance globally
                // This makes it available to WindowsWindow.createWindow()
                // which uses it to access WPF classes
                setDotNetInstance(dotnet);
            } catch (e) {
                // Emit error event so users can handle it
                this.emit('error', e);
                throw e; // Re-throw to reject the promise
            }
        }
        
        // Mark the app as ready and emit the event
        this.readyResolve();
        this.emit('ready');
    }

    /**
     * Returns a promise that resolves when the app is ready.
     * 
     * This is the recommended way to wait for the app to initialize:
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
