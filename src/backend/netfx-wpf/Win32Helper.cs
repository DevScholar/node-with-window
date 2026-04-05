
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

// ---------------------------------------------------------------------------
// Raw Win32 P/Invoke declarations
// ---------------------------------------------------------------------------

internal static class WindowNativeMethods
{
    internal const int GWL_STYLE   = -16;
    internal const int GWL_EXSTYLE = -20;
    internal const int WS_MINIMIZEBOX = 0x00020000;
    internal const int WS_MAXIMIZEBOX = 0x00010000;
    internal const int WS_EX_TRANSPARENT = 0x00000020;
    internal const int WS_EX_TOOLWINDOW = 0x00000080;
    internal const int WS_EX_APPWINDOW  = 0x00040000;
    internal const uint SC_CLOSE      = 0xF060;
    internal const uint MF_BYCOMMAND  = 0x00000000;
    internal const uint MF_ENABLED    = 0x00000000;
    internal const uint MF_GRAYED     = 0x00000001;
    internal const int  WM_SYSCOMMAND = 0x0112;
    internal const int  SC_MOVE_MASK  = 0xFFF0;
    internal const int  SC_MOVE       = 0xF010;
    internal const uint FLASHW_STOP      = 0;
    internal const uint FLASHW_CAPTION   = 0x00000001;
    internal const uint FLASHW_TRAY      = 0x00000002;
    internal const uint FLASHW_ALL       = 0x00000003;
    internal const uint FLASHW_TIMERNOFG = 0x0000000C;
    internal const uint FO_DELETE    = 0x0003;
    internal const ushort FOF_ALLOWUNDO         = 0x0040;
    internal const ushort FOF_NOCONFIRMATION    = 0x0010;
    internal const ushort FOF_NOERRORUI         = 0x0400;
    internal const ushort FOF_SILENT            = 0x0004;
    internal const uint GW_CHILD    = 5;
    internal const uint GW_HWNDNEXT = 2;
    internal const uint WM_SETICON = 0x0080;
    internal const int  ICON_SMALL = 0;
    internal const int  ICON_BIG   = 1;

    [StructLayout(LayoutKind.Sequential)]
    internal struct FLASHWINFO
    {
        public uint   cbSize;
        public IntPtr hwnd;
        public uint   dwFlags;
        public uint   uCount;
        public uint   dwTimeout;
    }

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

    [StructLayout(LayoutKind.Sequential)]
    internal struct MARGINS
    {
        public int cxLeftWidth;
        public int cxRightWidth;
        public int cyTopHeight;
        public int cyBottomHeight;
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

    [DllImport("user32.dll")]
    internal static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("dwmapi.dll")]
    internal static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref MARGINS pMarInset);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern IntPtr GetConsoleWindow();

    [DllImport("user32.dll")]
    internal static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("shell32.dll", PreserveSig = false)]
    internal static extern void SetCurrentProcessExplicitAppUserModelID(
        [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)]
        string AppID);
}

// ---------------------------------------------------------------------------
// Reflection helpers to access host-assembly globals (BridgeState, PsHost)
// ---------------------------------------------------------------------------

internal static class HostBridge
{
    internal static TextWriter GetWriter()
    {
        foreach (Assembly a in AppDomain.CurrentDomain.GetAssemblies())
        {
            Type t = a.GetType("BridgeState");
            if (t == null) continue;
            PropertyInfo p = t.GetProperty("Writer", BindingFlags.Public | BindingFlags.Static);
            if (p != null) return p.GetValue(null, null) as TextWriter;
        }
        return null;
    }

    // Invoke action on the WPF Dispatcher of the given object (or any Application dispatcher).
    // Falls back to direct call if no dispatcher is available.
    internal static void DispatcherInvoke(object wpfObject, Action action)
    {
        object dispatcher = null;
        // Try to get dispatcher from the WPF object itself
        if (wpfObject != null)
        {
            var dispProp = wpfObject.GetType().GetProperty("Dispatcher");
            if (dispProp != null) dispatcher = dispProp.GetValue(wpfObject, null);
        }
        // Fall back to Application.Current.Dispatcher
        if (dispatcher == null)
        {
            foreach (Assembly a in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (a.GetName().Name != "PresentationFramework") continue;
                var appType = a.GetType("System.Windows.Application");
                if (appType == null) break;
                var currentProp = appType.GetProperty("Current", BindingFlags.Public | BindingFlags.Static);
                if (currentProp == null) break;
                var app = currentProp.GetValue(null, null);
                if (app == null) break;
                var dispProp = app.GetType().GetProperty("Dispatcher");
                if (dispProp != null) dispatcher = dispProp.GetValue(app, null);
                break;
            }
        }
        if (dispatcher == null) { action(); return; }
        // Check if already on dispatcher thread
        var checkAccessMethod = dispatcher.GetType().GetMethod("CheckAccess");
        if (checkAccessMethod != null)
        {
            bool onThread = (bool)checkAccessMethod.Invoke(dispatcher, null);
            if (onThread) { action(); return; }
        }
        // Invoke on dispatcher thread
        var invokeMethod = dispatcher.GetType().GetMethod("Invoke",
            new Type[] { typeof(Action) });
        if (invokeMethod != null)
            invokeMethod.Invoke(dispatcher, new object[] { action });
        else
            action();
    }
}

// ---------------------------------------------------------------------------
// High-level Win32/WPF helpers
// ---------------------------------------------------------------------------

public static class WindowHelper
{
    private static HashSet<IntPtr> _immovableHwnds = new HashSet<IntPtr>();
    private static Dictionary<IntPtr, Delegate> _movingHooks = new Dictionary<IntPtr, Delegate>();
    private static HashSet<IntPtr> _hitTestFixHwnds = new HashSet<IntPtr>();
    private static System.Drawing.Icon _consoleIconRef = null;
    private static Dictionary<string, System.Windows.Input.KeyEventHandler> _accelHandlers =
        new Dictionary<string, System.Windows.Input.KeyEventHandler>();
    private static Dictionary<string, List<Tuple<int, int, string>>> _accelMaps =
        new Dictionary<string, List<Tuple<int, int, string>>>();
    // Keep menu click handlers alive to prevent GC
    private static List<Delegate> _menuClickHandlers = new List<Delegate>();

    // --- Icon ---

    public static void SetWindowIcon(object wpfWindow, string iconPath)
    {
        if (string.IsNullOrEmpty(iconPath) || !File.Exists(iconPath)) return;
        string ext = Path.GetExtension(iconPath).ToLowerInvariant();
        string fileUri = "file:///" + iconPath.Replace((char)92, (char)47);
        Uri uri = new Uri(fileUri);
        object bitmapSource = null;
        if (ext == ".ico") bitmapSource = _LoadBitmapFrame(uri);
        if (bitmapSource == null) bitmapSource = _LoadBitmapImage(uri);
        if (bitmapSource != null)
        {
            Type t = wpfWindow.GetType();
            PropertyInfo iconProp = null;
            while (t != null && iconProp == null) { iconProp = t.GetProperty("Icon"); t = t.BaseType; }
            if (iconProp != null) { try { iconProp.SetValue(wpfWindow, bitmapSource, null); } catch { } }
        }
        try
        {
            string appId = "NodeWithWindow." + Path.GetFileNameWithoutExtension(iconPath);
            WindowNativeMethods.SetCurrentProcessExplicitAppUserModelID(appId);
        }
        catch { }
        if (ext == ".ico") _SetConsoleIcon(iconPath);
    }

    private static object _LoadBitmapFrame(Uri uri)
    {
        try
        {
            Type bitmapFrameType = null;
            foreach (Assembly asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (asm.GetName().Name == "PresentationCore")
                { bitmapFrameType = asm.GetType("System.Windows.Media.Imaging.BitmapFrame"); break; }
            }
            if (bitmapFrameType == null) return null;
            foreach (MethodInfo m in bitmapFrameType.GetMethods(BindingFlags.Public | BindingFlags.Static))
            {
                if (m.Name != "Create") continue;
                ParameterInfo[] prms = m.GetParameters();
                if (prms.Length == 1 && prms[0].ParameterType == typeof(Uri))
                    return m.Invoke(null, new object[] { uri });
            }
            return null;
        }
        catch { return null; }
    }

    private static object _LoadBitmapImage(Uri uri)
    {
        try
        {
            Type bitmapImageType = null;
            foreach (Assembly asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (asm.GetName().Name == "PresentationCore")
                { bitmapImageType = asm.GetType("System.Windows.Media.Imaging.BitmapImage"); break; }
            }
            if (bitmapImageType == null) return null;
            return Activator.CreateInstance(bitmapImageType, new object[] { uri });
        }
        catch { return null; }
    }

    private static void _SetConsoleIcon(string iconPath)
    {
        try
        {
            IntPtr consoleHwnd = WindowNativeMethods.GetConsoleWindow();
            if (consoleHwnd == IntPtr.Zero) return;
            System.Drawing.Icon icon = new System.Drawing.Icon(iconPath);
            _consoleIconRef = icon;
            WindowNativeMethods.SendMessage(consoleHwnd, WindowNativeMethods.WM_SETICON,
                new IntPtr(WindowNativeMethods.ICON_SMALL), icon.Handle);
            WindowNativeMethods.SendMessage(consoleHwnd, WindowNativeMethods.WM_SETICON,
                new IntPtr(WindowNativeMethods.ICON_BIG), icon.Handle);
        }
        catch { }
    }

    // --- HWND ---

    public static IntPtr GetHwnd(object wpfWindow)
    {
        if (wpfWindow == null) return IntPtr.Zero;
        Type helperType = Type.GetType("System.Windows.Interop.WindowInteropHelper, PresentationFramework");
        if (helperType == null) return IntPtr.Zero;
        object helper = Activator.CreateInstance(helperType, new object[] { wpfWindow });
        PropertyInfo handleProp = helperType.GetProperty("Handle");
        if (handleProp == null) return IntPtr.Zero;
        return (IntPtr)handleProp.GetValue(helper, null);
    }

    public static string GetHwndString(object wpfWindow)
    {
        return GetHwnd(wpfWindow).ToInt64().ToString();
    }

    // --- Flash ---

    public static void FlashWindow(object wpfWindow, bool flag)
    {
        IntPtr hwnd = GetHwnd(wpfWindow);
        if (hwnd == IntPtr.Zero) return;
        WindowNativeMethods.FLASHWINFO fi = new WindowNativeMethods.FLASHWINFO();
        fi.cbSize    = (uint)Marshal.SizeOf(fi);
        fi.hwnd      = hwnd;
        fi.uCount    = 0;
        fi.dwTimeout = 0;
        fi.dwFlags   = flag
            ? (WindowNativeMethods.FLASHW_ALL | WindowNativeMethods.FLASHW_TIMERNOFG)
            : WindowNativeMethods.FLASHW_STOP;
        WindowNativeMethods.FlashWindowEx(ref fi);
    }

    // --- Min/Max buttons ---

    public static void SetMinimizable(object wpfWindow, bool flag)
    {
        IntPtr hwnd = GetHwnd(wpfWindow);
        if (hwnd == IntPtr.Zero) return;
        int style = WindowNativeMethods.GetWindowLong(hwnd, WindowNativeMethods.GWL_STYLE);
        if (flag) style |= WindowNativeMethods.WS_MINIMIZEBOX;
        else      style &= ~WindowNativeMethods.WS_MINIMIZEBOX;
        WindowNativeMethods.SetWindowLong(hwnd, WindowNativeMethods.GWL_STYLE, style);
    }

    public static void SetMaximizable(object wpfWindow, bool flag)
    {
        IntPtr hwnd = GetHwnd(wpfWindow);
        if (hwnd == IntPtr.Zero) return;
        int style = WindowNativeMethods.GetWindowLong(hwnd, WindowNativeMethods.GWL_STYLE);
        if (flag) style |= WindowNativeMethods.WS_MAXIMIZEBOX;
        else      style &= ~WindowNativeMethods.WS_MAXIMIZEBOX;
        WindowNativeMethods.SetWindowLong(hwnd, WindowNativeMethods.GWL_STYLE, style);
    }

    // --- Close button ---

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

    // --- Movable ---

    public static void SetMovable(object wpfWindow, bool flag)
    {
        IntPtr hwnd = GetHwnd(wpfWindow);
        if (hwnd == IntPtr.Zero) return;
        if (!flag)
        {
            _immovableHwnds.Add(hwnd);
            if (!_movingHooks.ContainsKey(hwnd)) InstallMovingHook(hwnd);
        }
        else
        {
            _immovableHwnds.Remove(hwnd);
        }
    }

    private static void InstallMovingHook(IntPtr hwnd)
    {
        Type hwndSourceType   = Type.GetType("System.Windows.Interop.HwndSource, PresentationCore");
        Type hookDelegateType = Type.GetType("System.Windows.Interop.HwndSourceHook, PresentationCore");
        if (hwndSourceType == null || hookDelegateType == null) return;
        MethodInfo fromHwndMethod = hwndSourceType.GetMethod("FromHwnd", BindingFlags.Public | BindingFlags.Static);
        if (fromHwndMethod == null) return;
        object hwndSource = fromHwndMethod.Invoke(null, new object[] { hwnd });
        if (hwndSource == null) return;
        MethodInfo addHookMethod = hwndSourceType.GetMethod("AddHook");
        if (addHookMethod == null) return;
        MethodInfo hookMethod = typeof(WindowHelper).GetMethod("_MovingHookProc", BindingFlags.Public | BindingFlags.Static);
        if (hookMethod == null) return;
        Delegate hook = Delegate.CreateDelegate(hookDelegateType, hookMethod);
        _movingHooks[hwnd] = hook;
        addHookMethod.Invoke(hwndSource, new object[] { hook });
    }

    public static IntPtr _MovingHookProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == WindowNativeMethods.WM_SYSCOMMAND)
        {
            int command = (int)wParam & WindowNativeMethods.SC_MOVE_MASK;
            if (command == WindowNativeMethods.SC_MOVE && _immovableHwnds.Contains(hwnd))
                handled = true;
        }
        return IntPtr.Zero;
    }

    // --- Skip taskbar ---

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

    // --- Transparent hit-test fix ---

    public static void FixTransparentInput(object wpfWindow)
    {
        IntPtr hwnd = GetHwnd(wpfWindow);
        if (hwnd == IntPtr.Zero) return;
        if (_hitTestFixHwnds.Contains(hwnd)) return;
        _hitTestFixHwnds.Add(hwnd);
        InstallHitTestHook(hwnd);
        FixChildHwnds(hwnd);
    }

    public static void FixTransparentInputChildren(object wpfWindow)
    {
        IntPtr hwnd = GetHwnd(wpfWindow);
        if (hwnd != IntPtr.Zero) FixChildHwnds(hwnd);
    }

    private static void InstallHitTestHook(IntPtr hwnd)
    {
        Type hwndSourceType   = Type.GetType("System.Windows.Interop.HwndSource, PresentationCore");
        Type hookDelegateType = Type.GetType("System.Windows.Interop.HwndSourceHook, PresentationCore");
        if (hwndSourceType == null || hookDelegateType == null) return;
        MethodInfo fromHwndMethod = hwndSourceType.GetMethod("FromHwnd", BindingFlags.Public | BindingFlags.Static);
        if (fromHwndMethod == null) return;
        object hwndSource = fromHwndMethod.Invoke(null, new object[] { hwnd });
        if (hwndSource == null) return;
        MethodInfo addHookMethod = hwndSourceType.GetMethod("AddHook");
        if (addHookMethod == null) return;
        MethodInfo hookMethod = typeof(WindowHelper).GetMethod("_HitTestHookProc", BindingFlags.Public | BindingFlags.Static);
        if (hookMethod == null) return;
        Delegate hook = Delegate.CreateDelegate(hookDelegateType, hookMethod);
        var key = new IntPtr(hwnd.ToInt64() ^ 0x48544658L);
        _movingHooks[key] = hook;
        addHookMethod.Invoke(hwndSource, new object[] { hook });
    }

    public static void FixChildHwnds(IntPtr parentHwnd)
    {
        IntPtr child = WindowNativeMethods.GetWindow(parentHwnd, WindowNativeMethods.GW_CHILD);
        while (child != IntPtr.Zero)
        {
            int exStyle = WindowNativeMethods.GetWindowLong(child, WindowNativeMethods.GWL_EXSTYLE);
            if ((exStyle & WindowNativeMethods.WS_EX_TRANSPARENT) != 0)
                WindowNativeMethods.SetWindowLong(child, WindowNativeMethods.GWL_EXSTYLE,
                    exStyle & ~WindowNativeMethods.WS_EX_TRANSPARENT);
            child = WindowNativeMethods.GetWindow(child, WindowNativeMethods.GW_HWNDNEXT);
        }
    }

    public static IntPtr _HitTestHookProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        const int WM_NCHITTEST = 0x0084;
        const int HTCLIENT     = 1;
        if (msg == WM_NCHITTEST && _hitTestFixHwnds.Contains(hwnd))
        {
            handled = true;
            return new IntPtr(HTCLIENT);
        }
        return IntPtr.Zero;
    }

    // --- Full screen ---

    public static void SetFullScreen(object wpfWindow, bool flag, bool needFrameless, bool alwaysOnTop)
    {
        HostBridge.DispatcherInvoke(wpfWindow, delegate
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
            var propTopmost     = windowType.GetProperty("Topmost");
            if (propWindowStyle == null || propWindowState == null || propTopmost == null) return;
            var stateNormal    = Enum.Parse(windowStateType, "Normal");
            var stateMaximized = Enum.Parse(windowStateType, "Maximized");
            var styleNone      = Enum.Parse(windowStyleType, "None");
            var styleSingle    = Enum.Parse(windowStyleType, "SingleBorderWindow");
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
        });
    }

    // --- Minimize ---

    public static void Minimize(object wpfWindow)
    {
        HostBridge.DispatcherInvoke(wpfWindow, delegate
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
        });
    }

    // --- Trash item ---

    public static void TrashItem(string filePath)
    {
        if (string.IsNullOrEmpty(filePath)) throw new ArgumentException("filePath must not be empty");
        string pFrom = filePath + (char)0;
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

    // --- Owner / modal ---

    public static void SetOwnerByHwnd(object childWindow, long ownerHwnd)
    {
        Type wihType = Type.GetType("System.Windows.Interop.WindowInteropHelper, PresentationFramework");
        if (wihType == null) return;
        object wih = Activator.CreateInstance(wihType, new object[] { childWindow });
        PropertyInfo ownerProp = wihType.GetProperty("Owner");
        if (ownerProp != null) ownerProp.SetValue(wih, new IntPtr(ownerHwnd), null);
    }

    public static void SetWindowEnabled(object wpfWindow, bool enabled)
    {
        PropertyInfo prop = null;
        Type t = wpfWindow.GetType();
        while (t != null && prop == null) { prop = t.GetProperty("IsEnabled"); t = t.BaseType; }
        if (prop != null) prop.SetValue(wpfWindow, enabled, null);
    }

    // --- WindowChrome ---

    public static void ApplyWindowChrome(object wpfWindow)
    {
        Type windowChromeType = null;
        Type thicknessType    = null;
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (asm.GetName().Name != "PresentationFramework") continue;
            windowChromeType = asm.GetType("System.Windows.Shell.WindowChrome");
            thicknessType    = asm.GetType("System.Windows.Thickness");
            break;
        }
        if (windowChromeType == null || thicknessType == null) return;
        object chrome = Activator.CreateInstance(windowChromeType);
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
        MethodInfo setMethod = windowChromeType.GetMethod("SetWindowChrome", BindingFlags.Public | BindingFlags.Static);
        if (setMethod != null) setMethod.Invoke(null, new object[] { wpfWindow, chrome });
    }

    public static void ApplyHiddenTitleBar(object wpfWindow)
    {
        Type windowChromeType = null;
        Type thicknessType    = null;
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            if (asm.GetName().Name != "PresentationFramework") continue;
            windowChromeType = asm.GetType("System.Windows.Shell.WindowChrome");
            thicknessType    = asm.GetType("System.Windows.Thickness");
            break;
        }
        if (windowChromeType == null || thicknessType == null) return;
        object chrome = Activator.CreateInstance(windowChromeType);
        object zeroThickness   = Activator.CreateInstance(thicknessType, new object[] { 0.0, 0.0, 0.0, 0.0 });
        object resizeThickness = Activator.CreateInstance(thicknessType, new object[] { 4.0, 4.0, 4.0, 4.0 });
        PropertyInfo glassProp   = windowChromeType.GetProperty("GlassFrameThickness");
        PropertyInfo resizeProp  = windowChromeType.GetProperty("ResizeBorderThickness");
        PropertyInfo captionProp = windowChromeType.GetProperty("CaptionHeight");
        PropertyInfo aeroProp    = windowChromeType.GetProperty("UseAeroCaptionButtons");
        if (glassProp   != null) glassProp.SetValue(chrome, zeroThickness, null);
        if (resizeProp  != null) resizeProp.SetValue(chrome, resizeThickness, null);
        if (captionProp != null) captionProp.SetValue(chrome, 0.0, null);
        if (aeroProp    != null) aeroProp.SetValue(chrome, false, null);
        MethodInfo setMethod = windowChromeType.GetMethod("SetWindowChrome", BindingFlags.Public | BindingFlags.Static);
        if (setMethod != null) setMethod.Invoke(null, new object[] { wpfWindow, chrome });
    }

    // --- DWM transparency ---

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

    // --- Keyboard accelerators ---

    public static void RegisterAccelerators(string windowId, object wpfWindow, List<object> shortcuts)
    {
        var list = new List<Tuple<int, int, string>>();
        if (shortcuts != null)
        {
            foreach (var item in shortcuts)
            {
                var s = item as Dictionary<string, object>;
                if (s == null) continue;
                int vk      = int.Parse(s["vk"].ToString());
                int mods    = int.Parse(s["modifiers"].ToString());
                string cbId = s["callbackId"].ToString();
                list.Add(Tuple.Create(vk, mods, cbId));
            }
        }
        _accelMaps[windowId] = list;

        EventInfo evInfo = null;
        Type t = wpfWindow.GetType();
        while (t != null && evInfo == null) { evInfo = t.GetEvent("PreviewKeyDown"); t = t.BaseType; }
        if (evInfo == null) return;

        System.Windows.Input.KeyEventHandler oldHandler;
        if (_accelHandlers.TryGetValue(windowId, out oldHandler))
        {
            try { evInfo.RemoveEventHandler(wpfWindow, oldHandler); } catch { }
        }

        string capturedId = windowId;
        System.Windows.Input.KeyEventHandler newHandler = (sender, e) =>
        {
            List<Tuple<int, int, string>> currentList;
            if (!_accelMaps.TryGetValue(capturedId, out currentList)) return;
            var modKeys = System.Windows.Input.Keyboard.Modifiers;
            foreach (var acc in currentList)
            {
                var expectedKey  = System.Windows.Input.KeyInterop.KeyFromVirtualKey(acc.Item1);
                var expectedMods = (System.Windows.Input.ModifierKeys)acc.Item2;
                if (e.Key == expectedKey && modKeys == expectedMods)
                {
                    var writer = HostBridge.GetWriter();
                    if (writer != null)
                    {
                        var json = string.Format(
                            "{{\\\"type\\\":\\\"event\\\",\\\"callbackId\\\":\\\"{0}\\\",\\\"args\\\":[]}}", acc.Item3);
                        lock (writer) { writer.WriteLine(json); }
                    }
                    e.Handled = true;
                    return;
                }
            }
        };

        _accelHandlers[windowId] = newHandler;
        evInfo.AddEventHandler(wpfWindow, newHandler);
    }
}

// ---------------------------------------------------------------------------
// WebView2 async helpers
// ---------------------------------------------------------------------------

public static class WebView2Helper
{
    private static MethodInfo FindMethod(Type type, string name, int paramCount)
    {
        foreach (var m in type.GetMethods(BindingFlags.Public | BindingFlags.Instance))
        {
            if (m.Name != name) continue;
            if (paramCount >= 0 && m.GetParameters().Length != paramCount) continue;
            return m;
        }
        return null;
    }

    /// <summary>
    /// Mutates the AllowedOrigins list on a CoreWebView2CustomSchemeRegistration object
    /// directly in C# to avoid Protocol.cs converting IList&lt;string&gt; to a JS array and
    /// losing the reference.  The origins array is passed as object[] from JS.
    /// </summary>
    public static void SetSchemeAllowedOrigins(object schemeReg, object[] origins)
    {
        var prop = schemeReg.GetType().GetProperty("AllowedOrigins");
        if (prop == null) return;

        // Try property setter first (some SDK versions have it).
        if (prop.CanWrite)
        {
            var list = new List<string>();
            if (origins != null)
                foreach (var o in origins)
                    if (o != null) list.Add(o.ToString());
            prop.SetValue(schemeReg, list, null);
            return;
        }

        // Getter-only: mutate the existing IList<string> in-place.
        var existing = prop.GetValue(schemeReg, null) as System.Collections.IList;
        if (existing == null) return;
        existing.Clear();
        if (origins != null)
            foreach (var o in origins)
                if (o != null) existing.Add(o.ToString());
    }

    public static void AddScriptAndNavigate(object coreWebView2, string script, string url)
    {
        var addScriptMethod = FindMethod(coreWebView2.GetType(), "AddScriptToExecuteOnDocumentCreatedAsync", 1);
        var navigateMethod  = FindMethod(coreWebView2.GetType(), "Navigate", 1);
        if (addScriptMethod == null || navigateMethod == null)
            throw new Exception("AddScriptAndNavigate: required CoreWebView2 methods not found");
        var task = (Task)addScriptMethod.Invoke(coreWebView2, new object[] { script });
        var capturedNavigate = navigateMethod;
        var capturedWebView  = coreWebView2;
        var capturedUrl      = url;
        task.ContinueWith(delegate(Task t)
        {
            HostBridge.DispatcherInvoke(null, delegate
            {
                try { capturedNavigate.Invoke(capturedWebView, new object[] { capturedUrl }); } catch { }
            });
        });
    }

    public static void AddScriptAndNavigateToString(object coreWebView2, string script, string html)
    {
        var addScriptMethod  = FindMethod(coreWebView2.GetType(), "AddScriptToExecuteOnDocumentCreatedAsync", 1);
        var navStringMethod  = FindMethod(coreWebView2.GetType(), "NavigateToString", 1);
        if (addScriptMethod == null || navStringMethod == null)
            throw new Exception("AddScriptAndNavigateToString: required CoreWebView2 methods not found");
        var task = (Task)addScriptMethod.Invoke(coreWebView2, new object[] { script });
        var capturedMethod  = navStringMethod;
        var capturedWebView = coreWebView2;
        var capturedHtml    = html;
        task.ContinueWith(delegate(Task t)
        {
            HostBridge.DispatcherInvoke(null, delegate
            {
                try { capturedMethod.Invoke(capturedWebView, new object[] { capturedHtml }); } catch { }
            });
        });
    }

    public static void SetWebViewBackground(object webView, int a, int r, int g, int b)
    {
        var bgProp = webView.GetType().GetProperty("DefaultBackgroundColor");
        if (bgProp != null)
        {
            var color = System.Drawing.Color.FromArgb(a, r, g, b);
            bgProp.SetValue(webView, color, null);
        }
    }

    public static string ExecuteScript(object webView, string script)
    {
        var coreWebView2Prop = webView.GetType().GetProperty("CoreWebView2");
        if (coreWebView2Prop == null) throw new Exception("CoreWebView2 not available");
        var coreWebView2 = coreWebView2Prop.GetValue(webView, null);
        if (coreWebView2 == null) throw new Exception("WebView2 not initialized");
        var method = coreWebView2.GetType().GetMethod("ExecuteScript", new Type[] { typeof(string) });
        if (method == null) throw new Exception("ExecuteScript method not found");
        var task = method.Invoke(coreWebView2, new object[] { script }) as Task<string>;
        if (task == null) return null;
        task.Wait();
        return task.Result;
    }

    public static string CapturePreview(object webView)
    {
        var coreWebView2Prop = webView.GetType().GetProperty("CoreWebView2");
        if (coreWebView2Prop == null) throw new Exception("CoreWebView2 not available");
        var coreWebView2 = coreWebView2Prop.GetValue(webView, null);
        if (coreWebView2 == null) throw new Exception("WebView2 not initialized");
        var captureMethod = coreWebView2.GetType().GetMethod("CapturePreviewAsync");
        if (captureMethod == null) throw new Exception("CapturePreviewAsync not found");
        var formatType = captureMethod.GetParameters()[0].ParameterType;
        var pngFormat  = Enum.Parse(formatType, "Png");
        var stream = new System.IO.MemoryStream();
        var task   = captureMethod.Invoke(coreWebView2, new object[] { pngFormat, stream }) as Task;
        if (task != null) task.Wait();
        return System.Convert.ToBase64String(stream.ToArray());
    }
}
