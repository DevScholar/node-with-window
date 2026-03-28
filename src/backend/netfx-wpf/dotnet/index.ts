// src/backend/netfx-wpf/dotnet/index.ts
// WPF backend bridge — delegates to @devscholar/node-ps1-dotnet for all .NET IPC.
// Win32/WPF helpers are compiled at first use via AddType (Win32Helper.ts).
import dotnetBase from '@devscholar/node-ps1-dotnet';
import { getWin32HelperSource } from '../Win32Helper.js';
export { callbackRegistry, createProxy, createProxyWithInlineProps } from '@devscholar/node-ps1-dotnet';

// Compile Win32Helper on first use.
let _win32HelperCompiled = false;
function ensureWin32Helper(): void {
    if (_win32HelperCompiled) return;
    _win32HelperCompiled = true;
    const result = (dotnetBase as any).addType(getWin32HelperSource());
    if (result && result.__type === 'error') {
        throw new Error('[node-with-window] Win32Helper AddType failed: ' + (result.__message || JSON.stringify(result)));
    }
}

function windowHelper(): any {
    ensureWin32Helper();
    return (dotnetBase as any).WindowHelper;
}

function webView2Helper(): any {
    ensureWin32Helper();
    return (dotnetBase as any).WebView2Helper;
}

// The dotnet proxy exposed to window.ts / dialogs.ts / menu.ts via setDotNetInstance.
// Retains the same surface as the old self-contained proxy.
const dotnetProxy = new Proxy(function() {} as any, {
    get: (_target: any, prop: string) => {
        if (prop === 'default') return dotnetProxy;
        if (prop === 'then') return undefined;
        if (prop === '__inspect') return (dotnetBase as any).__inspect;

        // ── Delegate core .NET resolution to node-ps1-dotnet ─────────────────
        if (prop === 'load') return (dotnetBase as any).load;
        if (prop === 'frameworkMoniker') return (dotnetBase as any).frameworkMoniker;
        if (prop === 'runtimeVersion') return (dotnetBase as any).runtimeVersion;
        if (prop === 'addListener') return (dotnetBase as any).addListener;
        if (prop === 'System') return (dotnetBase as any).System;
        if (prop === 'startApplication') return (dotnetBase as any).startApplication;
        if (prop === 'pollEvent') return () => ({ type: 'none' });
        if (prop === 'addType') return (dotnetBase as any).addType;
        if (prop === 'awaitTask') return (dotnetBase as any).awaitTask;

        // ── WebView2 async helpers ─────────────────────────────────────────
        if (prop === 'addScriptAndNavigate') {
            return (coreWebView2: any, script: string, url: string) => {
                webView2Helper().AddScriptAndNavigate(coreWebView2, script, url);
            };
        }
        if (prop === 'addScriptAndNavigateToString') {
            return (coreWebView2: any, script: string, html: string) => {
                webView2Helper().AddScriptAndNavigateToString(coreWebView2, script, html);
            };
        }
        if (prop === 'setWebViewBackground') {
            return (webView: any, a: number, r: number, g: number, b: number) => {
                webView2Helper().SetWebViewBackground(webView, a, r, g, b);
            };
        }
        if (prop === 'capturePreview') {
            return (webView: any): string => {
                const result = webView2Helper().ExecuteScriptOrCapture
                    ? null
                    : (webView2Helper() as any).CapturePreview(webView);
                // CapturePreview returns a primitive string proxy — unwrap it
                return result && result.__ref
                    ? String((dotnetBase as any).__inspect?.(result.__ref, '') ?? '')
                    : (result as string) ?? '';
            };
        }

        // ── Win32/WPF window management ────────────────────────────────────
        if (prop === 'winHelper') {
            return (win: any, op: string, flag?: boolean) => {
                const wh = windowHelper();
                switch (op) {
                    case 'FlashWindow':    wh.FlashWindow(win, flag ?? false); break;
                    case 'SetMinimizable': wh.SetMinimizable(win, flag ?? true); break;
                    case 'SetMaximizable': wh.SetMaximizable(win, flag ?? true); break;
                    case 'SetClosable':    wh.SetClosable(win, flag ?? true); break;
                    case 'SetMovable':     wh.SetMovable(win, flag ?? true); break;
                    case 'SetSkipTaskbar': wh.SetSkipTaskbar(win, flag ?? false); break;
                    default: break;
                }
            };
        }
        if (prop === 'minimize') {
            return (win: any) => windowHelper().Minimize(win);
        }
        if (prop === 'setFullScreen') {
            return (win: any, flag: boolean, needFrameless: boolean, alwaysOnTop: boolean) => {
                windowHelper().SetFullScreen(win, flag, needFrameless, alwaysOnTop);
            };
        }
        if (prop === 'fixTransparentInput') {
            return (win: any) => windowHelper().FixTransparentInput(win);
        }
        if (prop === 'fixTransparentInputChildren') {
            return (win: any) => windowHelper().FixTransparentInputChildren(win);
        }
        if (prop === 'applyWindowChrome') {
            return (win: any) => windowHelper().ApplyWindowChrome(win);
        }
        if (prop === 'applyHiddenTitleBar') {
            return (win: any) => windowHelper().ApplyHiddenTitleBar(win);
        }
        if (prop === 'fixDwmTransparent') {
            return (win: any) => windowHelper().DwmTransparent(win);
        }
        if (prop === 'setWindowIcon') {
            return (win: any, iconPath: string) => windowHelper().SetWindowIcon(win, iconPath);
        }
        if (prop === 'getHwnd') {
            return (win: any): string => {
                const r = windowHelper().GetHwndString(win) as any;
                // result may be a proxy wrapping a string primitive — toString() it
                return r && r.__ref ? '0' : String(r ?? '0');
            };
        }
        if (prop === 'setOwnerByHwnd') {
            return (win: any, ownerHwnd: string) => {
                windowHelper().SetOwnerByHwnd(win, parseInt(ownerHwnd, 10));
            };
        }
        if (prop === 'setWindowEnabled') {
            return (win: any, enabled: boolean) => windowHelper().SetWindowEnabled(win, enabled);
        }
        if (prop === 'trashItem') {
            return (filePath: string) => {
                const res = windowHelper().TrashItem(filePath) as any;
                if (res && res.type === 'error') throw new Error(res.message || 'TrashItem failed');
            };
        }
        if (prop === 'registerWindowAccelerators') {
            return (win: any, shortcuts: Array<{ vk: number; modifiers: number; callbackId: string }>) => {
                const winId = win && win.__ref ? win.__ref : String(win);
                windowHelper().RegisterAccelerators(winId, win, shortcuts);
            };
        }

        // ── Fall through: .NET type resolution ────────────────────────────
        return (dotnetBase as any)[prop];
    },

    apply: (_target: any, _thisArg: any, argArray: any[]) => {
        return (dotnetBase as any)(...argArray);
    }
});

export default dotnetProxy;
