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
}
