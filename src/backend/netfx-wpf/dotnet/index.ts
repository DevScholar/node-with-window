// src/backend/netfx-wpf/dotnet/index.ts
// WPF backend bridge — delegates to @devscholar/node-ps1-dotnet for all .NET IPC.
// Win32Helper (C#) is compiled at first use via AddType for the irreducible parts
// (SetMovable, RegisterAccelerators, WebView2Helper async).
// All other helpers are implemented directly in TypeScript (win32-helpers.ts).
import dotnetBase from '@devscholar/node-ps1-dotnet';
import { startApplication, addType } from '@devscholar/node-ps1-dotnet/internal';
import { getWin32HelperSource } from '../Win32Helper.js';
import * as win32 from '../win32-helpers.js';
import type { DotnetProxy, DotNetObject } from './types.js';
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

function windowHelper(): DotNetObject {
    ensureWin32Helper();
    return (dotnetBase as DotNetObject).WindowHelper as DotNetObject;
}

function webView2Helper(): DotNetObject {
    ensureWin32Helper();
    return (dotnetBase as DotNetObject).WebView2Helper as DotNetObject;
}

// The dotnet proxy exposed to window.ts / dialogs.ts / menu.ts via setDotNetInstance.
const dotnetProxy: DotnetProxy = new Proxy(function() {} as unknown as DotnetProxy, {
    get: (_target: DotnetProxy, prop: string) => {
        if (prop === 'default') return dotnetProxy;
        if (prop === 'then') return undefined;
        if (prop === '__inspect') return (dotnetBase as DotNetObject).__inspect;

        if (prop === 'load') return (dotnetBase as DotNetObject).load;
        if (prop === 'frameworkMoniker') return (dotnetBase as DotNetObject).frameworkMoniker;
        if (prop === 'runtimeVersion') return (dotnetBase as DotNetObject).runtimeVersion;
        if (prop === 'addListener') return (dotnetBase as DotNetObject).addListener;
        if (prop === 'System') return (dotnetBase as DotNetObject).System;
        if (prop === 'startApplication') return startApplication;
        if (prop === 'pollEvent') return () => ({ type: 'none' });
        if (prop === 'addType') return addType;
        if (prop === 'awaitTask') return (dotnetBase as DotNetObject).awaitTask;

        if (prop === 'getHwnd')
            return (win: DotNetObject) => win32.getHwndString(win);
        if (prop === 'minimize')
            return (win: DotNetObject) => win32.minimize(win);
        if (prop === 'setFullScreen')
            return (win: DotNetObject, flag: boolean, needFrameless: boolean, alwaysOnTop: boolean) =>
                win32.setFullScreen(win, flag, needFrameless, alwaysOnTop);
        if (prop === 'applyWindowChrome')
            return (win: DotNetObject) => win32.applyWindowChrome(win);
        if (prop === 'applyHiddenTitleBar')
            return (win: DotNetObject) => win32.applyHiddenTitleBar(win);
        if (prop === 'setWindowIcon')
            return (win: DotNetObject, iconPath: string) => win32.setWindowIcon(win, iconPath);
        if (prop === 'setOwnerByHwnd')
            return (win: DotNetObject, ownerHwnd: string) => win32.setOwnerByHwnd(win, ownerHwnd);
        if (prop === 'setWindowEnabled')
            return (win: DotNetObject, enabled: boolean) => win32.setWindowEnabled(win, enabled);
        if (prop === 'setWebViewBackground')
            return (wv: DotNetObject, a: number, r: number, g: number, b: number) =>
                win32.setWebViewBackground(wv, a, r, g, b);
        if (prop === 'capturePreview')
            return (wv: DotNetObject) => win32.capturePreview(wv);
        if (prop === 'trashItem')
            return (filePath: string) => win32.trashItem(filePath);

        if (prop === 'winHelper') {
            return (win: DotNetObject, op: string, flag?: boolean) => {
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
            return (win: DotNetObject, shortcuts: Array<{ vk: number; modifiers: number; callbackId: string }>) => {
                const winId = win && (win as DotNetObject & { __ref?: string }).__ref ? (win as DotNetObject & { __ref?: string }).__ref : String(win);
                windowHelper().RegisterAccelerators(winId, win, shortcuts);
            };
        }

        if (prop === 'addScriptAndNavigate') {
            return (coreWebView2: DotNetObject, script: string, url: string) => {
                webView2Helper().AddScriptAndNavigate(coreWebView2, script, url);
            };
        }
        if (prop === 'addScriptAndNavigateToString') {
            return (coreWebView2: DotNetObject, script: string, html: string) => {
                webView2Helper().AddScriptAndNavigateToString(coreWebView2, script, html);
            };
        }
        if (prop === 'setSchemeAllowedOrigins') {
            return (reg: DotNetObject, origins: string[]) => {
                webView2Helper().SetSchemeAllowedOrigins(reg, origins);
            };
        }

        return (dotnetBase as DotNetObject)[prop];
    },

    apply: (_target: DotnetProxy, _thisArg: unknown, argArray: unknown[]) => {
        return (dotnetBase as unknown as (...args: unknown[]) => DotNetObject)(...argArray as [unknown]);
    }
});

export default dotnetProxy;
