/**
 * TypeScript implementations of Win32/WPF helpers for the netfx-wpf backend.
 * Replaces the eliminable portions of Win32Helper.cs.
 *
 * Relies on:
 *   - win32-pinvoke.ts  for compiled @DllImport bindings (User32, Shell32, Kernel32)
 *   - @devscholar/node-ps1-dotnet for WPF proxy access
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import dotnetBase from '@devscholar/node-ps1-dotnet';
import { addType } from '@devscholar/node-ps1-dotnet/internal';
import type { DotNetObject } from './dotnet/types.js';

type CallableDotNet = DotNetObject & ((...args: unknown[]) => DotNetObject);

const dotnet = dotnetBase as unknown as CallableDotNet;
import {
    User32, Shell32, Kernel32,
    GWL_STYLE, GWL_EXSTYLE,
    WS_MINIMIZEBOX, WS_MAXIMIZEBOX,
    WS_EX_TOOLWINDOW, WS_EX_APPWINDOW,
    SC_CLOSE, MF_BYCOMMAND, MF_ENABLED, MF_GRAYED,
    FLASHW_STOP, FLASHW_ALL, FLASHW_TIMERNOFG,
    FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
    WM_SETICON, ICON_SMALL, ICON_BIG,
} from './win32-pinvoke.js';

// Intentional GC anchor — keeps the icon handle alive for the lifetime of the process.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let _consoleIconRef: DotNetObject | null = null;

// ── HWND ───────────────────────────────────────────────────────────────────────

export function getHwnd(win: DotNetObject): bigint {
    const WIH = dotnet('System.Windows.Interop').WindowInteropHelper;
    const helper = new WIH(win);
    return helper.Handle as bigint;
}

export function getHwndString(win: DotNetObject): string {
    return String(Number(getHwnd(win)));
}

// ── Button visibility ──────────────────────────────────────────────────────────

export function setMinimizable(win: DotNetObject, flag: boolean): void {
    const hwnd = getHwnd(win);
    let style = User32.GetWindowLong(hwnd, GWL_STYLE);
    if (flag) style |= WS_MINIMIZEBOX;
    else      style &= ~WS_MINIMIZEBOX;
    User32.SetWindowLong(hwnd, GWL_STYLE, style);
}

export function setMaximizable(win: DotNetObject, flag: boolean): void {
    const hwnd = getHwnd(win);
    let style = User32.GetWindowLong(hwnd, GWL_STYLE);
    if (flag) style |= WS_MAXIMIZEBOX;
    else      style &= ~WS_MAXIMIZEBOX;
    User32.SetWindowLong(hwnd, GWL_STYLE, style);
}

export function setClosable(win: DotNetObject, flag: boolean): void {
    const hwnd = getHwnd(win);
    const menu  = User32.GetSystemMenu(hwnd, false);
    const state = flag
        ? (MF_BYCOMMAND | MF_ENABLED)
        : (MF_BYCOMMAND | MF_GRAYED);
    User32.EnableMenuItem(menu, SC_CLOSE, state);
}

// ── Taskbar ────────────────────────────────────────────────────────────────────

export function setSkipTaskbar(win: DotNetObject, skip: boolean): void {
    const hwnd = getHwnd(win);
    let exStyle = User32.GetWindowLong(hwnd, GWL_EXSTYLE);
    if (skip) {
        exStyle |=  WS_EX_TOOLWINDOW;
        exStyle &= ~WS_EX_APPWINDOW;
    } else {
        exStyle &= ~WS_EX_TOOLWINDOW;
        exStyle |=  WS_EX_APPWINDOW;
    }
    User32.SetWindowLong(hwnd, GWL_EXSTYLE, exStyle);
}

// ── Flash ──────────────────────────────────────────────────────────────────────

export function flashWindow(win: DotNetObject, flag: boolean): void {
    const hwnd = getHwnd(win);
    if (hwnd === 0n) return;
    User32.FlashWindowEx({
        cbSize:    20, // sizeof(FLASHWINFO) on 64-bit is 24, on 32-bit is 20; Marshal.SizeOf handles it at Add-Type time
        hwnd,
        dwFlags:   flag ? (FLASHW_ALL | FLASHW_TIMERNOFG) : FLASHW_STOP,
        uCount:    0,
        dwTimeout: 0,
    });
}

// ── Trash ──────────────────────────────────────────────────────────────────────

export function trashItem(filePath: string): void {
    if (!filePath) throw new Error('filePath must not be empty');
    const result = Shell32.SHFileOperation({
        hwnd:                  0n,
        wFunc:                 FO_DELETE,
        pFrom:                 filePath + '\0',
        pTo:                   '',
        fFlags:                FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT,
        fAnyOperationsAborted: false,
        hNameMappings:         0n,
        lpszProgressTitle:     '',
    });
    if (result !== 0)
        throw new Error(`SHFileOperation failed with error code 0x${result.toString(16).toUpperCase()}`);
}

// ── Owner / enabled ────────────────────────────────────────────────────────────

export function setOwnerByHwnd(win: DotNetObject, ownerHwnd: string): void {
    const WIH = dotnet('System.Windows.Interop').WindowInteropHelper;
    const wih = new WIH(win);
    const IntPtr = dotnet('System').IntPtr;
    wih.Owner = new IntPtr(parseInt(ownerHwnd, 10));
}

export function setWindowEnabled(win: DotNetObject, enabled: boolean): void {
    win.IsEnabled = enabled;
}

// ── WindowChrome ───────────────────────────────────────────────────────────────

export function applyWindowChrome(win: DotNetObject): void {
    const WindowChrome = dotnet('System.Windows.Shell').WindowChrome;
    const Thickness    = dotnet('System.Windows').Thickness;
    const chrome = new WindowChrome();
    chrome.GlassFrameThickness  = new Thickness(-1, -1, -1, -1);
    chrome.ResizeBorderThickness = new Thickness(0, 0, 0, 0);
    chrome.CaptionHeight         = 0;
    chrome.UseAeroCaptionButtons = false;
    WindowChrome.SetWindowChrome(win, chrome);
}

export function applyHiddenTitleBar(win: DotNetObject): void {
    const WindowChrome = dotnet('System.Windows.Shell').WindowChrome;
    const Thickness    = dotnet('System.Windows').Thickness;
    const chrome = new WindowChrome();
    chrome.GlassFrameThickness   = new Thickness(0, 0, 0, 0);
    chrome.ResizeBorderThickness  = new Thickness(4, 4, 4, 4);
    chrome.CaptionHeight          = 0;
    chrome.UseAeroCaptionButtons  = false;
    WindowChrome.SetWindowChrome(win, chrome);
}

// ── Window state ───────────────────────────────────────────────────────────────

export function minimize(win: DotNetObject): void {
    const WindowState = dotnet('System.Windows').WindowState;
    win.WindowState = WindowState.Minimized;
}

export function setFullScreen(win: DotNetObject, flag: boolean, needFrameless: boolean, alwaysOnTop: boolean): void {
    const WS = dotnet('System.Windows');
    if (flag) {
        win.WindowState = WS.WindowState.Normal;
        win.WindowStyle = WS.WindowStyle.None;
        win.WindowState = WS.WindowState.Maximized;
        win.Topmost     = true;
    } else {
        win.WindowState = WS.WindowState.Normal;
        win.WindowStyle = needFrameless ? WS.WindowStyle.None : WS.WindowStyle.SingleBorderWindow;
        win.Topmost     = alwaysOnTop;
    }
}

// ── Icon ───────────────────────────────────────────────────────────────────────

export function setWindowIcon(win: DotNetObject, iconPath: string): void {
    if (!iconPath || !fs.existsSync(iconPath)) return;

    const ext = path.extname(iconPath).toLowerCase();
    const fileUri = 'file:///' + iconPath.replace(/\\/g, '/');
    const Uri = dotnet('System').Uri;
    const uri = new Uri(fileUri);

    let img: DotNetObject | null = null;
    if (ext === '.ico') {
        try {
            const BitmapFrame = dotnet('System.Windows.Media.Imaging').BitmapFrame;
            img = BitmapFrame.Create(uri);
        } catch {
            img = null;
        }
    }
    if (!img) {
        try {
            const BitmapImage = dotnet('System.Windows.Media.Imaging').BitmapImage;
            img = new BitmapImage(uri);
        } catch {
            img = null;
        }
    }
    if (img) {
        try { win.Icon = img; } catch { /* icon assignment is best-effort */ }
    }

    // Set AppUserModelID so the taskbar groups the app with its icon
    try {
        Shell32.SetCurrentProcessExplicitAppUserModelID(
            'NodeWithWindow.' + path.basename(iconPath, ext)
        );
    } catch { /* AppUserModelID is best-effort */ }

    // Mirror icon to console window
    if (ext === '.ico') {
        try {
            const consoleHwnd = Kernel32.GetConsoleWindow();
            if (consoleHwnd !== 0n) {
                const Icon = dotnet('System.Drawing').Icon;
                const icon = new Icon(iconPath);
                _consoleIconRef = icon; // prevent GC
                const handle: bigint = icon.Handle as bigint;
                User32.SendMessage(consoleHwnd, WM_SETICON, BigInt(ICON_SMALL), handle);
                User32.SendMessage(consoleHwnd, WM_SETICON, BigInt(ICON_BIG),   handle);
            }
        } catch { /* console icon mirroring is best-effort */ }
    }
}

// ── WebView2 ───────────────────────────────────────────────────────────────────

export function setWebViewBackground(webView: DotNetObject, a: number, r: number, g: number, b: number): void {
    const Color = dotnet('System.Drawing').Color;
    webView.DefaultBackgroundColor = Color.FromArgb(a, r, g, b);
}

let _captureHelper: DotNetObject | null = null;

export async function capturePreview(webView: DotNetObject): Promise<string> {
    if (!_captureHelper) {
        addType([
            'using Microsoft.Web.WebView2.Core;',
            'using System.IO;',
            'using System.Threading.Tasks;',
            'public static class __CaptureHelper__ {',
            '    public static Task CapturePng(CoreWebView2 cw2, Stream stream) {',
            '        return cw2.CapturePreviewAsync(CoreWebView2CaptureOutputFormat.Png, stream);',
            '    }',
            '}',
        ].join('\n'));
        _captureHelper = dotnet.__CaptureHelper__ as DotNetObject;
    }
    const MemoryStream = dotnet('System.IO').MemoryStream;
    const stream = new MemoryStream();
    const task   = _captureHelper.CapturePng(webView.CoreWebView2, stream);
    await dotnet.awaitTask(task);
    const bytes  = stream.ToArray();
    return dotnet('System').Convert.ToBase64String(bytes) as string;
}
