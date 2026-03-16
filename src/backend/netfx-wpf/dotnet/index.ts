// src/backend/netfx-wpf/dotnet/index.ts
// Self-contained WinBridge client for node-with-window.
// Spawns scripts/backend/netfx-wpf/WinHost.ps1 and communicates via named pipe.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getPowerShellPath } from './utils.js';
import { IpcSync } from './ipc.js';
import { getIpc, setIpc, getProc, setProc, getInitialized, setInitialized, getCachedRuntimeInfo, setCachedRuntimeInfo } from './state.js';
import { callbackRegistry, createProxyWithInlineProps, createProxy, setNodePs1Dotnet, setPollingMode } from './proxy.js';
import { createNamespaceProxy } from './namespace.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Searches common locations for scripts/backend/netfx-wpf/WinHost.ps1.
 * Handles both direct installs and esbuild-bundled scenarios where __dirname
 * points to the bundle output rather than the original package tree.
 */
function findWinHostScript(): string {
    const candidates = [
        // tsc output: dist/backend/netfx-wpf/dotnet/ → ../../../../scripts/backend/netfx-wpf/
        path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'backend', 'netfx-wpf', 'WinHost.ps1'),
        // esbuild bundle output one level deep: dist/<app>/ → ../../scripts/backend/netfx-wpf/
        path.resolve(__dirname, '..', '..', 'scripts', 'backend', 'netfx-wpf', 'WinHost.ps1'),
        // installed as npm package
        path.resolve(process.cwd(), 'node_modules', '@devscholar', 'node-with-window', 'scripts', 'backend', 'netfx-wpf', 'WinHost.ps1'),
        path.resolve(process.cwd(), '..', 'node_modules', '@devscholar', 'node-with-window', 'scripts', 'backend', 'netfx-wpf', 'WinHost.ps1'),
        path.resolve(process.cwd(), '..', '..', 'node_modules', '@devscholar', 'node-with-window', 'scripts', 'backend', 'netfx-wpf', 'WinHost.ps1'),
        path.resolve(process.cwd(), '..', '..', '..', 'node_modules', '@devscholar', 'node-with-window', 'scripts', 'backend', 'netfx-wpf', 'WinHost.ps1'),
        // monorepo sibling
        path.resolve(process.cwd(), '..', 'node-with-window', 'scripts', 'backend', 'netfx-wpf', 'WinHost.ps1'),
        // cwd fallback
        path.resolve(process.cwd(), 'scripts', 'backend', 'netfx-wpf', 'WinHost.ps1'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    throw new Error(
        `node-with-window: cannot find WinHost.ps1. Searched:\n${candidates.map(p => '  ' + p).join('\n')}`
    );
}

function cleanup() {
    if (!getInitialized()) return;
    setInitialized(false);

    const ipc = getIpc();
    if (ipc) {
        try { ipc.close(); } catch {}
    }

    const proc = getProc();
    if (proc && !proc.killed) {
        try { proc.kill('SIGKILL'); } catch {}
    }

    setProc(null);
    setIpc(null);
}

function doInitialize() {
    if (getInitialized()) return;

    const pipeName = `WinWindow_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
    const scriptPath = findWinHostScript();

    const powerShellPath = getPowerShellPath();
    const proc = cp.spawn(powerShellPath, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text',
        '-Command',
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; $PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'; chcp.com 65001 > $null; & '${scriptPath}' -PipeName '${pipeName}'`
    ], {
        stdio: 'inherit',
        windowsHide: false,
        env: {
            ...process.env,
            DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '0',
            DOTNET_SYSTEM_GLOBALIZATION_CULTURE: 'en-US',
            DOTNET_UTF8_GLOBALIZATION: '1'
        },
        shell: false
    });

    setProc(proc);
    proc.unref();

    proc.on('exit', () => {
        cleanup();
        process.exit(0);
    });

    process.on('beforeExit', () => {
        cleanup();
        process.exit(0);
    });

    process.on('exit', () => { cleanup(); });

    process.on('SIGINT', () => {
        cleanup();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        cleanup();
        process.exit(0);
    });

    process.on('uncaughtException', (err) => {
        console.error('Uncaught Exception:', err);
        cleanup();
        process.exit(1);
    });

    const ipc = new IpcSync(pipeName, (res: any) => {
        const cb = callbackRegistry.get(res.callbackId!);
        if (cb) {
            const wrappedArgs = (res.args || []).map((arg: any) => {
                if (arg && arg.type === 'ref' && arg.props) return createProxyWithInlineProps(arg);
                return createProxy(arg);
            });
            return cb(...wrappedArgs);
        }
        return null;
    });

    ipc.connect();
    setIpc(ipc);
    setInitialized(true);
}

// Low-level .NET interop API used by the WPF proxy.
const winBridge = {
    _load(typeName: string): any {
        doInitialize();
        return createProxy(getIpc()!.send({ action: 'GetType', typeName }));
    },

    _release(id: string) {
        const ipc = getIpc();
        if (ipc) { try { ipc.send({ action: 'Release', targetId: id }); } catch {} }
    },

    _close() {
        const proc = getProc();
        if (proc) proc.kill();
        cleanup();
    },

    _loadAssembly(assemblyName: string): any {
        doInitialize();
        return createProxy(getIpc()!.send({ action: 'LoadAssembly', assemblyName }));
    },

    _loadFrom(filePath: string): any {
        doInitialize();
        return createProxy(getIpc()!.send({ action: 'LoadFrom', filePath }));
    },

    _getRuntimeInfo(): { frameworkMoniker: string; runtimeVersion: string } {
        if (getCachedRuntimeInfo()) return getCachedRuntimeInfo()!;
        doInitialize();
        const res = getIpc()!.send({ action: 'GetRuntimeInfo' });
        const info = {
            frameworkMoniker: res.frameworkMoniker || 'netstandard2.0',
            runtimeVersion: res.runtimeVersion || '0.0.0'
        };
        setCachedRuntimeInfo(info);
        return info;
    },
};

setNodePs1Dotnet(() => winBridge);

// The dotnet proxy: property access resolves .NET types; special props are WPF/WebView2 commands.
const dotnetProxy = new Proxy(function() {} as any, {
    get: (_target: any, prop: string) => {
        if (prop === 'default') return dotnetProxy;
        if (prop === 'then') return undefined;

        if (prop === 'load') return (nameOrPath: string) => {
            if (nameOrPath.includes('/') || nameOrPath.includes('\\') ||
                nameOrPath.endsWith('.dll') || nameOrPath.endsWith('.exe')) {
                return winBridge._loadFrom(nameOrPath);
            }
            return winBridge._loadAssembly(nameOrPath);
        };

        if (prop === 'frameworkMoniker') return winBridge._getRuntimeInfo().frameworkMoniker;
        if (prop === 'runtimeVersion') return winBridge._getRuntimeInfo().runtimeVersion;

        // ─── WPF / WebView2 commands ──────────────────────────────────────────────

        // Registers a bridge script and navigates atomically: C# awaits
        // AddScriptToExecuteOnDocumentCreatedAsync before calling Navigate.
        if (prop === 'addScriptAndNavigate') {
            return (coreWebView2: any, script: string, url: string) => {
                doInitialize();
                getIpc()!.send({ action: 'AddScriptAndNavigate', targetId: coreWebView2.__ref, script, url });
            };
        }
        if (prop === 'addScriptAndNavigateToString') {
            return (coreWebView2: any, script: string, html: string) => {
                doInitialize();
                getIpc()!.send({ action: 'AddScriptAndNavigateToString', targetId: coreWebView2.__ref, script, html });
            };
        }

        // Starts the WPF Application.Run() loop. After this call, the WPF dispatcher
        // owns the UI thread; use pollEvent() to process events from Node.js's side.
        if (prop === 'startApplication') {
            return (app: any, window: any, webView?: any) => {
                doInitialize();
                const cmd: any = { action: 'StartApplication', appId: app.__ref, windowId: window.__ref };
                if (webView) cmd.webViewId = webView.__ref;
                getIpc()!.send(cmd);
                setPollingMode(true);
            };
        }

        // Polls for one queued event from the WPF side.
        // Returns { type: 'ipc', message: string } or { type: 'none' } (or other).
        // Callers (NetFxWpfWindow._poll) are responsible for routing the message.
        if (prop === 'pollEvent') {
            return (): { type: string; message?: string } => {
                const ipc = getIpc();
                if (!ipc) return { type: 'none' };
                return ipc.send({ action: 'Poll' }) as any;
            };
        }

        // Sends a window-management P/Invoke command to the WPF backend.
        // windowId: the __ref of the WPF Window object.
        // op: one of FlashWindow | SetMinimizable | SetMaximizable | SetClosable |
        //          SetMovable | SetSkipTaskbar | Minimize | SetFullScreen
        if (prop === 'winHelper') {
            return (window: any, op: string, flag: boolean) => {
                doInitialize();
                getIpc()!.send({ action: 'WinHelper', windowId: window.__ref, op, flag });
            };
        }

        // Minimizes the WPF window via a single atomic C# call.
        if (prop === 'minimize') {
            return (window: any): void => {
                doInitialize();
                getIpc()!.send({ action: 'WinHelper', windowId: window.__ref, op: 'Minimize' });
            };
        }

        // Enters or exits full-screen mode via a single atomic C# call.
        // needFrameless: true when the window was created with frame:false or transparent:true.
        // alwaysOnTop:   true when the window was created with alwaysOnTop:true.
        if (prop === 'setFullScreen') {
            return (window: any, flag: boolean, needFrameless: boolean, alwaysOnTop: boolean): void => {
                doInitialize();
                getIpc()!.send({ action: 'WinHelper', windowId: window.__ref, op: 'SetFullScreen', flag, needFrameless, alwaysOnTop });
            };
        }

        // Sends a file or directory to the Recycle Bin via SHFileOperation.
        // Returns a promise-like: callers should await or catch on the TypeScript side.
        if (prop === 'trashItem') {
            return (filePath: string): void => {
                doInitialize();
                const res = getIpc()!.send({ action: 'TrashItem', filePath }) as any;
                if (res && res.type === 'error') {
                    throw new Error(res.message || 'TrashItem failed');
                }
            };
        }

        // Sets WebView2 DefaultBackgroundColor. a/r/g/b are 0-255 integers.
        // Call this right after creating the WebView2 object, before show().
        if (prop === 'setWebViewBackground') {
            return (webView: any, a: number, r: number, g: number, b: number): void => {
                doInitialize();
                getIpc()!.send({ action: 'SetWebViewBackground', webViewId: webView.__ref, a, r, g, b });
            };
        }

        // Installs a WM_NCHITTEST hook on the WPF window that forces HTCLIENT for all
        // hits. Required when transparent:true is used: WPF's layered-window renderer
        // returns HTTRANSPARENT (clicks pass through) because the WPF bitmap is fully
        // transparent — WebView2 is a child HWND not visible to WPF's hit-tester.
        if (prop === 'fixTransparentInput') {
            return (window: any): void => {
                doInitialize();
                getIpc()!.send({ action: 'FixTransparentInput', windowId: window.__ref });
            };
        }

        // Re-runs the child-HWND WS_EX_TRANSPARENT cleanup after CoreWebView2 initialises.
        // WebView2 creates additional host-side HWNDs asynchronously; calling this in
        // CoreWebView2InitializationCompleted ensures those HWNDs are fixed too.
        if (prop === 'fixTransparentInputChildren') {
            return (window: any): void => {
                doInitialize();
                getIpc()!.send({ action: 'FixTransparentInputChildren', windowId: window.__ref });
            };
        }

        // Applies WPF WindowChrome with GlassFrameThickness=-1 for transparent windows.
        // This is the recommended approach over raw DwmExtendFrameIntoClientArea:
        // WPF manages the DWM lifecycle, so the hardware DX render target composites
        // correctly with the DWM glass and the window does not appear black.
        // Call from createWindow() (before show()) — no HWND required.
        if (prop === 'applyWindowChrome') {
            return (window: any): void => {
                doInitialize();
                getIpc()!.send({ action: 'ApplyWindowChrome', windowId: window.__ref });
            };
        }
        if (prop === 'applyHiddenTitleBar') {
            return (window: any): void => {
                doInitialize();
                getIpc()!.send({ action: 'ApplyHiddenTitleBar', windowId: window.__ref });
            };
        }

        // Enables DWM glass transparency for the entire client area.
        // Use this instead of AllowsTransparency=true when hosting WebView2.
        // AllowsTransparency=true (WS_EX_LAYERED + UpdateLayeredWindow) filters
        // clicks by per-pixel alpha at the OS level before WM_NCHITTEST is sent,
        // so the WebView2 area (alpha=0 in the WPF bitmap) always passes through.
        // With AllowsTransparency=false + DwmExtendFrameIntoClientArea, the window
        // is not layered — all clicks route normally to the window and child HWNDs.
        if (prop === 'fixDwmTransparent') {
            return (window: any): void => {
                doInitialize();
                getIpc()!.send({ action: 'DwmTransparent', windowId: window.__ref });
            };
        }

        // Returns the Win32 HWND of a WPF window as a decimal string.
        // Only valid after the window has been shown (Application.Run called).
        if (prop === 'getHwnd') {
            return (window: any): string => {
                doInitialize();
                const result = getIpc()!.send({ action: 'GetHwnd', windowId: window.__ref }) as any;
                return (result?.value ?? '0').toString();
            };
        }

        // Sets the owner HWND of a child WPF window (parent/modal support).
        if (prop === 'setOwnerByHwnd') {
            return (childWindow: any, ownerHwnd: string): void => {
                doInitialize();
                getIpc()!.send({ action: 'SetOwnerByHwnd', windowId: childWindow.__ref, ownerHwnd });
            };
        }

        // Enables or disables user interaction on a WPF window (modal blocking).
        if (prop === 'setWindowEnabled') {
            return (window: any, enabled: boolean): void => {
                doInitialize();
                getIpc()!.send({ action: 'SetWindowEnabled', windowId: window.__ref, enabled });
            };
        }

        // Captures the WebView2 rendering as a PNG and returns it as a base64 string.
        if (prop === 'capturePreview') {
            return (webView: any): string => {
                doInitialize();
                const result = getIpc()!.send({ action: 'CapturePreview', webViewId: webView.__ref }) as any;
                return (result?.value ?? '') as string;
            };
        }

        // Fall through: resolve as a .NET type name.
        return winBridge._load(prop);
    },

    apply: (_target: any, _thisArg: any, argArray: any[]) => {
        return createNamespaceProxy(argArray[0], winBridge);
    }
});

export default dotnetProxy;

// Exported for use by window.ts to dispatch .NET event callbacks received via Poll.
export { callbackRegistry, createProxy, createProxyWithInlineProps } from './proxy.js';
