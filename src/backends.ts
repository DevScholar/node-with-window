import type { BrowserWindowOptions, IWindowProvider } from './interfaces.js';

/**
 * BackendDescriptor — describes a named window backend.
 *
 * Backends are registered at module-load time (side-effect imports in index.ts).
 * Users can register their own backends with registerBackend().
 */
export interface BackendDescriptor {
    /** Unique identifier, e.g. 'netfx-wpf', 'gjs-gtk4' */
    name: string;
    /** OS platforms where this backend is the default (e.g. ['win32'], ['linux']) */
    defaultPlatforms: NodeJS.Platform[];
    /** One-time initialization (e.g. loading .NET runtime). Idempotent. */
    initialize(): Promise<void>;
    /** Instantiate a window provider for the given options */
    createProvider(options?: BrowserWindowOptions): IWindowProvider;
}

const _registry    = new Map<string, BackendDescriptor>();
const _initialized = new Set<string>();
let _appBackendName: string | null = null;

/** Register a backend so it can be used by name or as a platform default. */
export function registerBackend(descriptor: BackendDescriptor): void {
    _registry.set(descriptor.name, descriptor);
}

/**
 * Override the app-level backend selection.
 * Must be called before app.whenReady().
 */
export function setAppBackendName(name: string): void {
    _appBackendName = name;
}

/**
 * Resolve a backend by explicit name, app-level override, or platform default.
 * Throws a descriptive error if no backend is found.
 */
export function resolveBackend(name?: string): BackendDescriptor {
    const target = name ?? _appBackendName ?? _platformDefault();
    if (!target) {
        throw new Error(
            `No backend available for platform '${process.platform}'. ` +
            `Registered backends: ${[..._registry.keys()].join(', ') || 'none'}.`
        );
    }
    const b = _registry.get(target);
    if (!b) {
        throw new Error(
            `Backend '${target}' is not registered. ` +
            `Registered backends: ${[..._registry.keys()].join(', ')}.`
        );
    }
    return b;
}

/**
 * Initialize a backend exactly once; subsequent calls are no-ops.
 * Called automatically by app.whenReady() and BrowserWindow._init().
 */
export async function ensureBackendInitialized(name: string): Promise<void> {
    if (_initialized.has(name)) return;
    const b = _registry.get(name);
    if (!b) throw new Error(`Backend '${name}' is not registered.`);
    await b.initialize();
    _initialized.add(name);
}

function _platformDefault(): string | undefined {
    for (const [name, desc] of _registry)
        if ((desc.defaultPlatforms as string[]).includes(process.platform))
            return name;
    return undefined;
}
