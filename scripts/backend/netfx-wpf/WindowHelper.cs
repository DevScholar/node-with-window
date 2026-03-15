// scripts/PsBridge/WindowHelper.cs
//
// Win32 P/Invoke helpers for window-chrome manipulation (WPF + WebView2 backend).
// Used by the WinHelper action in Reflection.cs.
//
// C# 5.0 constraint: no auto-property initializers, no ?. operator, no $"" strings.
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;

// ---------------------------------------------------------------------------
// Raw Win32 P/Invoke declarations
// ---------------------------------------------------------------------------

internal static class WindowNativeMethods
{
    // GWL_STYLE / GWL_EXSTYLE index for GetWindowLong / SetWindowLong.
    internal const int GWL_STYLE   = -16;
    internal const int GWL_EXSTYLE = -20;

    // Window style bits for the minimize / maximize buttons.
    internal const int WS_MINIMIZEBOX = 0x00020000;
    internal const int WS_MAXIMIZEBOX = 0x00010000;

    // Extended window style: transparent to mouse input (passes messages to windows below).
    internal const int WS_EX_TRANSPARENT = 0x00000020;

    // Extended window style: tool window is not shown in the taskbar.
    internal const int WS_EX_TOOLWINDOW = 0x00000080;
    internal const int WS_EX_APPWINDOW  = 0x00040000;

    // System-menu constants used to gray out the Close item.
    internal const uint SC_CLOSE      = 0xF060;
    internal const uint MF_BYCOMMAND  = 0x00000000;
    internal const uint MF_ENABLED    = 0x00000000;
    internal const uint MF_GRAYED     = 0x00000001;

    // WM_SYSCOMMAND is posted when the user moves via title-bar drag / system menu.
    internal const int  WM_SYSCOMMAND = 0x0112;
    internal const int  SC_MOVE_MASK  = 0xFFF0;
    internal const int  SC_MOVE       = 0xF010;

    // FlashWindowEx flags.
    internal const uint FLASHW_STOP      = 0;
    internal const uint FLASHW_CAPTION   = 0x00000001;
    internal const uint FLASHW_TRAY      = 0x00000002;
    internal const uint FLASHW_ALL       = 0x00000003;
    internal const uint FLASHW_TIMERNOFG = 0x0000000C;

    // SHFileOperation constants for sending items to the recycle bin.
    internal const uint FO_DELETE    = 0x0003;
    internal const ushort FOF_ALLOWUNDO         = 0x0040;
    internal const ushort FOF_NOCONFIRMATION    = 0x0010;
    internal const ushort FOF_NOERRORUI         = 0x0400;
    internal const ushort FOF_SILENT            = 0x0004;

    [StructLayout(LayoutKind.Sequential)]
    internal struct FLASHWINFO
    {
        public uint   cbSize;
        public IntPtr hwnd;
        public uint   dwFlags;
        public uint   uCount;
        public uint   dwTimeout;
    }

    // pFrom / pTo must be double-null-terminated; CharSet.Auto selects Unicode on NT.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    internal struct SHFILEOPSTRUCT
    {
        public IntPtr  hwnd;
        public uint    wFunc;
        public string  pFrom;
        public string  pTo;
        public ushort  fFlags;
        public bool    fAnyOperationsAborted;
        public IntPtr  hNameMappings;
        public string  lpszProgressTitle;
    }

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetSystemMenu(IntPtr hWnd, bool bRevert);

    [DllImport("user32.dll")]
    internal static extern bool EnableMenuItem(IntPtr hMenu, uint uIDEnableItem, uint uEnable);

    [DllImport("user32.dll")]
    internal static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

    [DllImport("shell32.dll", CharSet = CharSet.Auto)]
    internal static extern int SHFileOperation(ref SHFILEOPSTRUCT FileOp);

    // GetWindow relationship constants.
    internal const uint GW_CHILD    = 5;
    internal const uint GW_HWNDNEXT = 2;

    [DllImport("user32.dll")]
    internal static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    // DWM glass transparency — makes the window's client area show the DWM compositor
    // layer (desktop/blur) through areas where the WPF render surface is transparent.
    [StructLayout(LayoutKind.Sequential)]
    internal struct MARGINS
    {
        public int cxLeftWidth;
        public int cxRightWidth;
        public int cyTopHeight;
        public int cyBottomHeight;
    }

    [DllImport("dwmapi.dll")]
    internal static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref MARGINS pMarInset);
}

// ---------------------------------------------------------------------------
// High-level helpers
// ---------------------------------------------------------------------------

public static class WindowHelper
{
    // HWNDs for which WM_SYSCOMMAND SC_MOVE should be suppressed.
    private static HashSet<IntPtr> _immovableHwnds = new HashSet<IntPtr>();

    // Hook delegates kept alive to prevent GC collection.
    private static Dictionary<IntPtr, Delegate> _movingHooks = new Dictionary<IntPtr, Delegate>();

    // HWNDs for which WM_NCHITTEST should always return HTCLIENT.
    // Used to make transparent WPF windows (AllowsTransparency=true) pass mouse
    // events to the WebView2 child HWND instead of letting WPF return HTTRANSPARENT.
    private static HashSet<IntPtr> _hitTestFixHwnds = new HashSet<IntPtr>();

    // ---------------------------------------------------------------------------
    // HWND resolution
    // ---------------------------------------------------------------------------

    /// <summary>
    /// Returns the Win32 HWND for a WPF Window via WindowInteropHelper (reflection).
    /// Returns IntPtr.Zero when the window handle has not been created yet.
    /// </summary>
    public static IntPtr GetHwnd(object wpfWindow)
    {
        if (wpfWindow == null) return IntPtr.Zero;

        Type helperType = null;
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (asm.GetName().Name != "PresentationFramework") continue;
            helperType = asm.GetType("System.Windows.Interop.WindowInteropHelper");
            if (helperType != null) break;
        }
        if (helperType == null) return IntPtr.Zero;

        object helper = Activator.CreateInstance(helperType, new object[] { wpfWindow });
        PropertyInfo handleProp = helperType.GetProperty("Handle");
        if (handleProp == null) return IntPtr.Zero;

        return (IntPtr)handleProp.GetValue(helper, null);
    }

    // ---------------------------------------------------------------------------
    // Flash
    // ---------------------------------------------------------------------------

    /// <summary>Flash or stop flashing the taskbar button.</summary>
    public static void FlashWindow(object wpfWindow, bool flag)
    {
        IntPtr hwnd = GetHwnd(wpfWindow);
        if (hwnd == IntPtr.Zero) return;

        WindowNativeMethods.FLASHWINFO fi = new WindowNativeMethods.FLASHWINFO();
        fi.cbSize   = (uint)Marshal.SizeOf(fi);
        fi.hwnd     = hwnd;
        fi.uCount   = 0;
        fi.dwTimeout = 0;
        fi.dwFlags  = flag
            ? (WindowNativeMethods.FLASHW_ALL | WindowNativeMethods.FLASHW_TIMERNOFG)
            : WindowNativeMethods.FLASHW_STOP;
        WindowNativeMethods.FlashWindowEx(ref fi);
    }

    // ---------------------------------------------------------------------------
    // Minimize / Maximize buttons
    // ---------------------------------------------------------------------------

    /// <summary>Show or hide the minimize button in the title bar.</summary>
    public static void SetMinimizable(object wpfWindow, bool flag)
    {
        IntPtr hwnd = GetHwnd(wpfWindow);
        if (hwnd == IntPtr.Zero) return;

        int style = WindowNativeMethods.GetWindowLong(hwnd, WindowNativeMethods.GWL_STYLE);
        if (flag)
            style |= WindowNativeMethods.WS_MINIMIZEBOX;
        else
            style &= ~WindowNativeMethods.WS_MINIMIZEBOX;
        WindowNativeMethods.SetWindowLong(hwnd, WindowNativeMethods.GWL_STYLE, style);
    }

    /// <summary>Show or hide the maximize button in the title bar.</summary>
    public static void SetMaximizable(object wpfWindow, bool flag)
    {
        IntPtr hwnd = GetHwnd(wpfWindow);
        if (hwnd == IntPtr.Zero) return;

        int style = WindowNativeMethods.GetWindowLong(hwnd, WindowNativeMethods.GWL_STYLE);
        if (flag)
            style |= WindowNativeMethods.WS_MAXIMIZEBOX;
        else
            style &= ~WindowNativeMethods.WS_MAXIMIZEBOX;
        WindowNativeMethods.SetWindowLong(hwnd, WindowNativeMethods.GWL_STYLE, style);
    }

    // ---------------------------------------------------------------------------
    // Close button
    // ---------------------------------------------------------------------------

    /// <summary>Enable or gray out the system-menu Close item (and the × button).</summary>
    public static void SetClosable(object wpfWindow, bool flag)
    {
        IntPtr hwnd = GetHwnd(wpfWindow);
        if (hwnd == IntPtr.Zero) return;

        IntPtr menu  = WindowNativeMethods.GetSystemMenu(hwnd, false);
        uint   state = flag
            ? (WindowNativeMethods.MF_BYCOMMAND | WindowNativeMethods.MF_ENABLED)
            : (WindowNativeMethods.MF_BYCOMMAND | WindowNativeMethods.MF_GRAYED);
        WindowNativeMethods.EnableMenuItem(menu, WindowNativeMethods.SC_CLOSE, state);
    }

    // ---------------------------------------------------------------------------
    // Movable — blocks WM_SYSCOMMAND SC_MOVE via HwndSource hook
    // ---------------------------------------------------------------------------

    /// <summary>
    /// Prevent (or re-allow) the window from being dragged by the user.
    /// Installs a WndProc hook on first call when flag is false.
    /// The hook is kept alive for the lifetime of the window.
    /// </summary>
    public static void SetMovable(object wpfWindow, bool flag)
    {
        IntPtr hwnd = GetHwnd(wpfWindow);
        if (hwnd == IntPtr.Zero) return;

        if (!flag)
        {
            _immovableHwnds.Add(hwnd);
            if (!_movingHooks.ContainsKey(hwnd))
                InstallMovingHook(hwnd);
        }
        else
        {
            _immovableHwnds.Remove(hwnd);
            // The hook remains installed but becomes a no-op once hwnd is removed.
        }
    }

    private static void InstallMovingHook(IntPtr hwnd)
    {
        // Locate HwndSource (PresentationCore) and HwndSourceHook delegate type.
        Type hwndSourceType = null;
        Type hookDelegateType = null;
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (asm.GetName().Name != "PresentationCore") continue;
            hwndSourceType    = asm.GetType("System.Windows.Interop.HwndSource");
            hookDelegateType  = asm.GetType("System.Windows.Interop.HwndSourceHook");
            break;
        }
        if (hwndSourceType == null || hookDelegateType == null) return;

        MethodInfo fromHwndMethod = hwndSourceType.GetMethod(
            "FromHwnd", BindingFlags.Public | BindingFlags.Static);
        if (fromHwndMethod == null) return;

        object hwndSource = fromHwndMethod.Invoke(null, new object[] { hwnd });
        if (hwndSource == null) return;

        MethodInfo addHookMethod = hwndSourceType.GetMethod("AddHook");
        if (addHookMethod == null) return;

        // Bind the static _MovingHookProc to the HwndSourceHook delegate type.
        MethodInfo hookMethod = typeof(WindowHelper).GetMethod(
            "_MovingHookProc", BindingFlags.Public | BindingFlags.Static);
        if (hookMethod == null) return;

        Delegate hook = Delegate.CreateDelegate(hookDelegateType, hookMethod);
        _movingHooks[hwnd] = hook;
        addHookMethod.Invoke(hwndSource, new object[] { hook });
    }

    /// <summary>
    /// WndProc hook: intercepts WM_SYSCOMMAND SC_MOVE for immovable windows.
    /// Signature must match HwndSourceHook exactly.
    /// </summary>
    public static IntPtr _MovingHookProc(
        IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == WindowNativeMethods.WM_SYSCOMMAND)
        {
            int command = (int)wParam & WindowNativeMethods.SC_MOVE_MASK;
            if (command == WindowNativeMethods.SC_MOVE && _immovableHwnds.Contains(hwnd))
            {
                handled = true;
            }
        }
        return IntPtr.Zero;
    }

    // ---------------------------------------------------------------------------
    // Skip taskbar
    // ---------------------------------------------------------------------------

    /// <summary>
    /// Show or hide the window in the taskbar by toggling WS_EX_TOOLWINDOW /
    /// WS_EX_APPWINDOW on the extended window style.
    /// </summary>
    public static void SetSkipTaskbar(object wpfWindow, bool skip)
    {
        IntPtr hwnd = GetHwnd(wpfWindow);
        if (hwnd == IntPtr.Zero) return;

        int exStyle = WindowNativeMethods.GetWindowLong(hwnd, WindowNativeMethods.GWL_EXSTYLE);
        if (skip)
        {
            exStyle |=  WindowNativeMethods.WS_EX_TOOLWINDOW;
            exStyle &= ~WindowNativeMethods.WS_EX_APPWINDOW;
        }
        else
        {
            exStyle &= ~WindowNativeMethods.WS_EX_TOOLWINDOW;
            exStyle |=  WindowNativeMethods.WS_EX_APPWINDOW;
        }
        WindowNativeMethods.SetWindowLong(hwnd, WindowNativeMethods.GWL_EXSTYLE, exStyle);
    }

    // ---------------------------------------------------------------------------
    // Transparent hit-test fix
    // ---------------------------------------------------------------------------

    /// <summary>
    /// Installs a WndProc hook that intercepts WM_NCHITTEST on the given WPF window
    /// and returns HTCLIENT for the entire client area.
    ///
    /// Background: when WPF uses AllowsTransparency=true it switches to a layered-window
    /// software renderer.  The WPF hit-tester sees only its own pixel bitmap; because the
    /// WPF Background is Brushes.Transparent the entire bitmap is alpha=0, so WPF returns
    /// HTTRANSPARENT for every WM_NCHITTEST message.  Windows then routes mouse input to
    /// the window behind, bypassing the WebView2 child HWND entirely.
    ///
    /// The fix: intercept WM_NCHITTEST before WPF handles it and return HTCLIENT, which
    /// tells Windows "this HWND owns this point" and lets normal child-HWND dispatch carry
    /// the message down to WebView2.
    /// </summary>
    public static void FixTransparentInput(object wpfWindow)
    {
        IntPtr hwnd = GetHwnd(wpfWindow);
        if (hwnd == IntPtr.Zero) return;
        if (_hitTestFixHwnds.Contains(hwnd)) return; // already installed
        _hitTestFixHwnds.Add(hwnd);
        InstallHitTestHook(hwnd);
        // Also clear WS_EX_TRANSPARENT from any child HWNDs that already exist.
        // WebView2's HwndHost-side HWND is created when the WPF window is shown,
        // so it should be present by the time _applyWindowChrome() calls this.
        FixChildHwnds(hwnd);
    }

    private static void InstallHitTestHook(IntPtr hwnd)
    {
        Type hwndSourceType = null;
        Type hookDelegateType = null;
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (asm.GetName().Name != "PresentationCore") continue;
            hwndSourceType   = asm.GetType("System.Windows.Interop.HwndSource");
            hookDelegateType = asm.GetType("System.Windows.Interop.HwndSourceHook");
            break;
        }
        if (hwndSourceType == null || hookDelegateType == null) return;

        MethodInfo fromHwndMethod = hwndSourceType.GetMethod(
            "FromHwnd", BindingFlags.Public | BindingFlags.Static);
        if (fromHwndMethod == null) return;

        object hwndSource = fromHwndMethod.Invoke(null, new object[] { hwnd });
        if (hwndSource == null) return;

        MethodInfo addHookMethod = hwndSourceType.GetMethod("AddHook");
        if (addHookMethod == null) return;

        MethodInfo hookMethod = typeof(WindowHelper).GetMethod(
            "_HitTestHookProc", BindingFlags.Public | BindingFlags.Static);
        if (hookMethod == null) return;

        Delegate hook = Delegate.CreateDelegate(hookDelegateType, hookMethod);
        // Reuse _movingHooks dictionary slot — any key suffix keeps the delegate alive.
        var key = new IntPtr(hwnd.ToInt64() ^ 0x48544658L); // XOR with 'HTFX'
        _movingHooks[key] = hook;
        addHookMethod.Invoke(hwndSource, new object[] { hook });
    }

    /// <summary>
    /// Removes WS_EX_TRANSPARENT from the direct first-level child HWNDs of parentHwnd.
    ///
    /// When WPF uses AllowsTransparency=true, Windows routes mouse input by walking the
    /// HWND tree with RealChildWindowFromPoint/ChildWindowFromPointEx.  Any child that
    /// carries WS_EX_TRANSPARENT is skipped during this traversal, so clicks appear to
    /// pass straight through it.  WebView2's HwndHost HWND can acquire this flag because
    /// it is a child of a layered window.  Stripping the flag ensures the WebView2 HWND
    /// is treated as an opaque hit target.
    ///
    /// NOTE: Only first-level children are processed.  Recursing into WebView2's internal
    /// Chromium HWNDs is intentionally avoided: those HWNDs rely on WS_EX_TRANSPARENT for
    /// their DirectComposition rendering pipeline, and stripping it breaks WebView2 rendering.
    /// </summary>
    public static void FixChildHwnds(IntPtr parentHwnd)
    {
        IntPtr child = WindowNativeMethods.GetWindow(parentHwnd, WindowNativeMethods.GW_CHILD);
        while (child != IntPtr.Zero)
        {
            int exStyle = WindowNativeMethods.GetWindowLong(child, WindowNativeMethods.GWL_EXSTYLE);
            if ((exStyle & WindowNativeMethods.WS_EX_TRANSPARENT) != 0)
            {
                WindowNativeMethods.SetWindowLong(child, WindowNativeMethods.GWL_EXSTYLE,
                    exStyle & ~WindowNativeMethods.WS_EX_TRANSPARENT);
            }
            // Do NOT recurse — leave WebView2's internal Chromium HWND tree untouched.
            child = WindowNativeMethods.GetWindow(child, WindowNativeMethods.GW_HWNDNEXT);
        }
    }

    /// <summary>
    /// WndProc hook: intercepts WM_NCHITTEST for transparent-fix windows and returns
    /// HTCLIENT so mouse events reach the WebView2 child HWND.
    /// Signature must match HwndSourceHook exactly.
    /// </summary>
    public static IntPtr _HitTestHookProc(
        IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        const int WM_NCHITTEST  = 0x0084;
        const int HTCLIENT      = 1;

        if (msg == WM_NCHITTEST && _hitTestFixHwnds.Contains(hwnd))
        {
            handled = true;
            return new IntPtr(HTCLIENT);
        }
        return IntPtr.Zero;
    }

    // ---------------------------------------------------------------------------
    // Full screen
    // ---------------------------------------------------------------------------

    /// <summary>
    /// Enters or exits full-screen mode atomically on the WPF UI thread.
    ///
    /// All three property sets (WindowState, WindowStyle, Topmost) happen in a single
    /// C# call so no WPF layout/dispatch pass can interleave between them.
    ///
    /// WPF quirk: WindowState must be reset to Normal before setting WindowStyle.None
    /// followed by Maximized; otherwise Maximized is silently ignored.
    /// </summary>
    public static void SetFullScreen(object wpfWindow, bool flag, bool needFrameless, bool alwaysOnTop)
    {
        Type windowType = wpfWindow.GetType();

        Type windowStyleType = null;
        Type windowStateType = null;
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (asm.GetName().Name != "PresentationFramework") continue;
            windowStyleType = asm.GetType("System.Windows.WindowStyle");
            windowStateType = asm.GetType("System.Windows.WindowState");
            break;
        }
        if (windowStyleType == null || windowStateType == null) return;

        var propWindowStyle = windowType.GetProperty("WindowStyle");
        var propWindowState = windowType.GetProperty("WindowState");
        var propTopmost    = windowType.GetProperty("Topmost");
        if (propWindowStyle == null || propWindowState == null || propTopmost == null) return;

        var stateNormal   = Enum.Parse(windowStateType, "Normal");
        var stateMaximized = Enum.Parse(windowStateType, "Maximized");
        var styleNone     = Enum.Parse(windowStyleType, "None");
        var styleSingle   = Enum.Parse(windowStyleType, "SingleBorderWindow");

        if (flag)
        {
            propWindowState.SetValue(wpfWindow, stateNormal,    null);
            propWindowStyle.SetValue(wpfWindow, styleNone,      null);
            propWindowState.SetValue(wpfWindow, stateMaximized, null);
            propTopmost.SetValue(wpfWindow, true, null);
        }
        else
        {
            propWindowState.SetValue(wpfWindow, stateNormal, null);
            object restoreStyle = needFrameless ? styleNone : (object)styleSingle;
            propWindowStyle.SetValue(wpfWindow, restoreStyle, null);
            propTopmost.SetValue(wpfWindow, alwaysOnTop, null);
        }
    }

    // ---------------------------------------------------------------------------
    // Minimize
    // ---------------------------------------------------------------------------

    /// <summary>
    /// Minimizes the WPF window via a single reflection call on the WPF UI thread.
    /// Using a dedicated C# action avoids the multi-IPC-call path that can fail
    /// when the WPF Dispatcher is busy processing menu-close animations.
    /// </summary>
    public static void Minimize(object wpfWindow)
    {
        Type windowType = wpfWindow.GetType();
        Type windowStateType = null;
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (asm.GetName().Name != "PresentationFramework") continue;
            windowStateType = asm.GetType("System.Windows.WindowState");
            break;
        }
        if (windowStateType == null) return;

        var propWindowState = windowType.GetProperty("WindowState");
        if (propWindowState == null) return;

        var stateMinimized = Enum.Parse(windowStateType, "Minimized");
        propWindowState.SetValue(wpfWindow, stateMinimized, null);
    }

    // ---------------------------------------------------------------------------
    // Trash item (Recycle Bin)
    // ---------------------------------------------------------------------------

    /// <summary>
    /// Sends a file or directory to the Recycle Bin using SHFileOperation.
    /// Throws on failure.
    /// </summary>
    public static void TrashItem(string filePath)
    {
        if (string.IsNullOrEmpty(filePath))
            throw new ArgumentException("filePath must not be empty");

        // pFrom must be double-null-terminated.
        string pFrom = filePath + '\0';

        WindowNativeMethods.SHFILEOPSTRUCT op = new WindowNativeMethods.SHFILEOPSTRUCT();
        op.hwnd   = IntPtr.Zero;
        op.wFunc  = WindowNativeMethods.FO_DELETE;
        op.pFrom  = pFrom;
        op.pTo    = null;
        op.fFlags = (ushort)(
            WindowNativeMethods.FOF_ALLOWUNDO      |
            WindowNativeMethods.FOF_NOCONFIRMATION |
            WindowNativeMethods.FOF_NOERRORUI      |
            WindowNativeMethods.FOF_SILENT
        );

        int result = WindowNativeMethods.SHFileOperation(ref op);
        if (result != 0)
            throw new Exception(string.Format("SHFileOperation failed with error code 0x{0:X}", result));
    }

    // ---------------------------------------------------------------------------
    // WindowChrome transparency (recommended approach for WebView2)
    // ---------------------------------------------------------------------------

    /// <summary>
    /// Applies WPF WindowChrome with GlassFrameThickness=-1 to extend the DWM
    /// compositor glass over the entire client area.
    ///
    /// This is the correct approach for transparent windows hosting WebView2:
    ///   AllowsTransparency=false  →  hardware DX renderer, no WS_EX_LAYERED
    ///   WindowChrome(-1,-1,-1,-1) →  WPF manages DWM lifecycle; transparent WPF
    ///                                 areas show desktop behind via DWM composition
    ///
    /// Unlike the raw DwmExtendFrameIntoClientArea P/Invoke approach, using WPF's
    /// WindowChrome class integrates with WPF's rendering pipeline so the window
    /// does not appear black in hardware rendering mode.
    ///
    /// Must be called while on the WPF UI thread (any time after the Window object
    /// is created, including before Show()).
    /// </summary>
    public static void ApplyWindowChrome(object wpfWindow)
    {
        Type windowChromeType = null;
        Type thicknessType = null;
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (windowChromeType == null)
                windowChromeType = asm.GetType("System.Windows.Shell.WindowChrome");
            if (thicknessType == null)
                thicknessType = asm.GetType("System.Windows.Thickness");
            if (windowChromeType != null && thicknessType != null) break;
        }
        if (windowChromeType == null || thicknessType == null) return;

        object chrome = Activator.CreateInstance(windowChromeType);

        // Thickness(-1,-1,-1,-1) extends the DWM glass frame over the entire client area.
        object negThickness  = Activator.CreateInstance(thicknessType, new object[] { -1.0, -1.0, -1.0, -1.0 });
        object zeroThickness = Activator.CreateInstance(thicknessType, new object[] {  0.0,  0.0,  0.0,  0.0 });

        PropertyInfo glassProp   = windowChromeType.GetProperty("GlassFrameThickness");
        PropertyInfo resizeProp  = windowChromeType.GetProperty("ResizeBorderThickness");
        PropertyInfo captionProp = windowChromeType.GetProperty("CaptionHeight");
        PropertyInfo aeroProp    = windowChromeType.GetProperty("UseAeroCaptionButtons");

        if (glassProp   != null) glassProp.SetValue(chrome, negThickness, null);
        if (resizeProp  != null) resizeProp.SetValue(chrome, zeroThickness, null);
        if (captionProp != null) captionProp.SetValue(chrome, 0.0, null);
        if (aeroProp    != null) aeroProp.SetValue(chrome, false, null);

        MethodInfo setMethod = windowChromeType.GetMethod(
            "SetWindowChrome", BindingFlags.Public | BindingFlags.Static);
        if (setMethod != null) setMethod.Invoke(null, new object[] { wpfWindow, chrome });
    }

    // ---------------------------------------------------------------------------
    // DWM transparency (raw P/Invoke — kept for reference, use ApplyWindowChrome instead)
    // ---------------------------------------------------------------------------

    /// <summary>
    /// Enables DWM glass transparency for the entire client area.
    ///
    /// Use this instead of AllowsTransparency=true when the window hosts WebView2.
    /// AllowsTransparency=true uses WS_EX_LAYERED + UpdateLayeredWindow (SWRT mode),
    /// which causes per-pixel alpha hit-testing at the OS level: clicks on alpha=0
    /// pixels are routed to the window behind BEFORE WM_NCHITTEST is sent, so no
    /// WM_NCHITTEST hook can intercept them.  WebView2's rendering area is alpha=0
    /// in the WPF bitmap (WPF cannot render into child HWNDs), so the entire
    /// WebView2 area passes through clicks.
    ///
    /// With AllowsTransparency=false (hardware/DX renderer) + DwmExtendFrameIntoClientArea:
    /// - The window is NOT WS_EX_LAYERED — no per-pixel alpha hit-testing.
    /// - All clicks within the window bounds are routed normally to the window and
    ///   its child HWNDs (including WebView2).
    /// - Visual transparency is provided by DWM composition (desktop/blur behind
    ///   the window wherever the WPF render surface has alpha=0).
    /// </summary>
    public static void DwmTransparent(object wpfWindow)
    {
        IntPtr hwnd = GetHwnd(wpfWindow);
        if (hwnd == IntPtr.Zero) return;

        var margins = new WindowNativeMethods.MARGINS
        {
            cxLeftWidth    = -1,
            cxRightWidth   = -1,
            cyTopHeight    = -1,
            cyBottomHeight = -1
        };
        WindowNativeMethods.DwmExtendFrameIntoClientArea(hwnd, ref margins);
    }
}
