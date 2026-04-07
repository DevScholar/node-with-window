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
let _consoleIconRef: any = null;

// ── HWND ───────────────────────────────────────────────────────────────────────

export function getHwnd(win: any): bigint {
    const WIH = (dotnetBase as any)('System.Windows.Interop').WindowInteropHelper;
    const helper = new WIH(win);
    return helper.Handle as bigint;
}

export function getHwndString(win: any): string {
    return String(Number(getHwnd(win)));
}

// ── Button visibility ──────────────────────────────────────────────────────────

export function setMinimizable(win: any, flag: boolean): void {
    const hwnd = getHwnd(win);
    let style = User32.GetWindowLong(hwnd, GWL_STYLE);
    if (flag) style |= WS_MINIMIZEBOX;
    else      style &= ~WS_MINIMIZEBOX;
    User32.SetWindowLong(hwnd, GWL_STYLE, style);
}

export function setMaximizable(win: any, flag: boolean): void {
    const hwnd = getHwnd(win);
    let style = User32.GetWindowLong(hwnd, GWL_STYLE);
    if (flag) style |= WS_MAXIMIZEBOX;
    else      style &= ~WS_MAXIMIZEBOX;
    User32.SetWindowLong(hwnd, GWL_STYLE, style);
}

export function setClosable(win: any, flag: boolean): void {
    const hwnd = getHwnd(win);
    const menu  = User32.GetSystemMenu(hwnd, false);
    const state = flag
        ? (MF_BYCOMMAND | MF_ENABLED)
        : (MF_BYCOMMAND | MF_GRAYED);
    User32.EnableMenuItem(menu, SC_CLOSE, state);
}

// ── Taskbar ────────────────────────────────────────────────────────────────────

export function setSkipTaskbar(win: any, skip: boolean): void {
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

export function flashWindow(win: any, flag: boolean): void {
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

export function setOwnerByHwnd(win: any, ownerHwnd: string): void {
    const WIH = (dotnetBase as any)('System.Windows.Interop').WindowInteropHelper;
    const wih = new WIH(win);
    const IntPtr = (dotnetBase as any)('System').IntPtr;
    wih.Owner = new IntPtr(parseInt(ownerHwnd, 10));
}

export function setWindowEnabled(win: any, enabled: boolean): void {
    win.IsEnabled = enabled;
}

// ── WindowChrome ───────────────────────────────────────────────────────────────

export function applyWindowChrome(win: any): void {
    const WindowChrome = (dotnetBase as any)('System.Windows.Shell').WindowChrome;
    const Thickness    = (dotnetBase as any)('System.Windows').Thickness;
    const chrome = new WindowChrome();
    chrome.GlassFrameThickness  = new Thickness(-1, -1, -1, -1);
    chrome.ResizeBorderThickness = new Thickness(0, 0, 0, 0);
    chrome.CaptionHeight         = 0;
    chrome.UseAeroCaptionButtons = false;
    WindowChrome.SetWindowChrome(win, chrome);
}

export function applyHiddenTitleBar(win: any): void {
    const WindowChrome = (dotnetBase as any)('System.Windows.Shell').WindowChrome;
    const Thickness    = (dotnetBase as any)('System.Windows').Thickness;
    const chrome = new WindowChrome();
    chrome.GlassFrameThickness   = new Thickness(0, 0, 0, 0);
    chrome.ResizeBorderThickness  = new Thickness(4, 4, 4, 4);
    chrome.CaptionHeight          = 0;
    chrome.UseAeroCaptionButtons  = false;
    WindowChrome.SetWindowChrome(win, chrome);
}

// ── Window state ───────────────────────────────────────────────────────────────

export function minimize(win: any): void {
    const WindowState = (dotnetBase as any)('System.Windows').WindowState;
    win.WindowState = WindowState.Minimized;
}

export function setFullScreen(win: any, flag: boolean, needFrameless: boolean, alwaysOnTop: boolean): void {
    const WS = (dotnetBase as any)('System.Windows');
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

export function setWindowIcon(win: any, iconPath: string): void {
    if (!iconPath || !fs.existsSync(iconPath)) return;

    const ext = path.extname(iconPath).toLowerCase();
    const fileUri = 'file:///' + iconPath.replace(/\\/g, '/');
    const Uri = (dotnetBase as any)('System').Uri;
    const uri = new Uri(fileUri);

    let img: any = null;
    if (ext === '.ico') {
        try {
            const BitmapFrame = (dotnetBase as any)('System.Windows.Media.Imaging').BitmapFrame;
            img = BitmapFrame.Create(uri);
        } catch {
            img = null;
        }
    }
    if (!img) {
        try {
            const BitmapImage = (dotnetBase as any)('System.Windows.Media.Imaging').BitmapImage;
            img = new BitmapImage(uri);
        } catch {
            img = null;
        }
    }
    if (img) {
        try { win.Icon = img; } catch {}
    }

    // Set AppUserModelID so the taskbar groups the app with its icon
    try {
        Shell32.SetCurrentProcessExplicitAppUserModelID(
            'NodeWithWindow.' + path.basename(iconPath, ext)
        );
    } catch {}

    // Mirror icon to console window
    if (ext === '.ico') {
        try {
            const consoleHwnd = Kernel32.GetConsoleWindow();
            if (consoleHwnd !== 0n) {
                const Icon = (dotnetBase as any)('System.Drawing').Icon;
                const icon = new Icon(iconPath);
                _consoleIconRef = icon; // prevent GC
                const handle: bigint = icon.Handle as bigint;
                User32.SendMessage(consoleHwnd, WM_SETICON, BigInt(ICON_SMALL), handle);
                User32.SendMessage(consoleHwnd, WM_SETICON, BigInt(ICON_BIG),   handle);
            }
        } catch {}
    }
}

// ── WebView2 ───────────────────────────────────────────────────────────────────

export function setWebViewBackground(webView: any, a: number, r: number, g: number, b: number): void {
    const Color = (dotnetBase as any)('System.Drawing').Color;
    webView.DefaultBackgroundColor = Color.FromArgb(a, r, g, b);
}

export async function capturePreview(webView: any): Promise<string> {
    const cw2            = webView.CoreWebView2;
    const captureMethod  = cw2.GetType().GetMethod('CapturePreviewAsync');
    const formatType     = captureMethod.GetParameters()[0].ParameterType;
    const pngFormat      = (dotnetBase as any)('System').Enum.Parse(formatType, 'Png');
    const MemoryStream   = (dotnetBase as any)('System.IO').MemoryStream;
    const stream         = new MemoryStream();
    const task           = cw2.CapturePreviewAsync(pngFormat, stream);
    await (dotnetBase as any).awaitTask(task);
    const bytes          = stream.ToArray();
    return (dotnetBase as any)('System').Convert.ToBase64String(bytes) as string;
}
