// src/backend/netfx-wpf/dotnet/index.ts
// WPF backend bridge — delegates to @devscholar/node-ps1-dotnet for all .NET IPC.
// Win32Helper (C#) is compiled at first use via AddType for the irreducible parts
// (SetMovable, RegisterAccelerators, WebView2Helper async).
// All other helpers are implemented directly in TypeScript (win32-helpers.ts).
import dotnetBase from '@devscholar/node-ps1-dotnet';
import { startApplication, addType } from '@devscholar/node-ps1-dotnet/internal';
import { getWin32HelperSource } from '../Win32Helper.js';
import * as win32 from '../win32-helpers.js';
import type { DotnetProxy } from './types.js';
export { callbackRegistry, createProxy, createProxyWithInlineProps } from '@devscholar/node-ps1-dotnet';

// Compile the residual Win32Helper.cs (SetMovable, RegisterAccelerators, WebView2Helper).
let _win32HelperCompiled = false;
function ensureWin32Helper(): void {
    if (_win32HelperCompiled) return;
    _win32HelperCompiled = true;
    const result = addType(getWin32HelperSource());
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
const dotnetProxy = new Proxy(function() {} as unknown as DotnetProxy, {
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
        if (prop === 'startApplication') return startApplication;
        if (prop === 'pollEvent') return () => ({ type: 'none' });
        if (prop === 'addType') return addType;
        if (prop === 'awaitTask') return (dotnetBase as any).awaitTask;

        // ── TS-implemented Win32/WPF helpers ──────────────────────────────────
        if (prop === 'getHwnd')
            return (win: any) => win32.getHwndString(win);
        if (prop === 'minimize')
            return (win: any) => win32.minimize(win);
        if (prop === 'setFullScreen')
            return (win: any, flag: boolean, needFrameless: boolean, alwaysOnTop: boolean) =>
                win32.setFullScreen(win, flag, needFrameless, alwaysOnTop);
        if (prop === 'applyWindowChrome')
            return (win: any) => win32.applyWindowChrome(win);
        if (prop === 'applyHiddenTitleBar')
            return (win: any) => win32.applyHiddenTitleBar(win);
        if (prop === 'setWindowIcon')
            return (win: any, iconPath: string) => win32.setWindowIcon(win, iconPath);
        if (prop === 'setOwnerByHwnd')
            return (win: any, ownerHwnd: string) => win32.setOwnerByHwnd(win, ownerHwnd);
        if (prop === 'setWindowEnabled')
            return (win: any, enabled: boolean) => win32.setWindowEnabled(win, enabled);
        if (prop === 'setWebViewBackground')
            return (wv: any, a: number, r: number, g: number, b: number) =>
                win32.setWebViewBackground(wv, a, r, g, b);
        if (prop === 'capturePreview')
            return (wv: any) => win32.capturePreview(wv);
        if (prop === 'trashItem')
            return (filePath: string) => win32.trashItem(filePath);

        // ── Mixed: most ops are TS; SetMovable stays in C# (HwndSourceHook) ──
        if (prop === 'winHelper') {
            return (win: any, op: string, flag?: boolean) => {
                switch (op) {
                    case 'FlashWindow':    win32.flashWindow(win, flag ?? false); break;
                    case 'SetMinimizable': win32.setMinimizable(win, flag ?? true); break;
                    case 'SetMaximizable': win32.setMaximizable(win, flag ?? true); break;
                    case 'SetClosable':    win32.setClosable(win, flag ?? true); break;
                    case 'SetMovable':     windowHelper().SetMovable(win, flag ?? true); break;
                    case 'SetSkipTaskbar': win32.setSkipTaskbar(win, flag ?? false); break;
                    default: break;
                }
            };
        }

        // ── RegisterAccelerators stays in C# (PreviewKeyDown + pipe write) ───
        if (prop === 'registerWindowAccelerators') {
            return (win: any, shortcuts: Array<{ vk: number; modifiers: number; callbackId: string }>) => {
                const winId = win && win.__ref ? win.__ref : String(win);
                windowHelper().RegisterAccelerators(winId, win, shortcuts);
            };
        }

        // ── WebView2 async helpers stay in C# (Task.ContinueWith + Dispatcher) ─
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
        if (prop === 'setSchemeAllowedOrigins') {
            return (reg: any, origins: string[]) => {
                webView2Helper().SetSchemeAllowedOrigins(reg, origins);
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
