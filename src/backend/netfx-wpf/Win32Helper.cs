
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

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
        if (wpfObject != null)
        {
            var dispProp = wpfObject.GetType().GetProperty("Dispatcher");
            if (dispProp != null) dispatcher = dispProp.GetValue(wpfObject, null);
        }
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
        var checkAccessMethod = dispatcher.GetType().GetMethod("CheckAccess");
        if (checkAccessMethod != null)
        {
            bool onThread = (bool)checkAccessMethod.Invoke(dispatcher, null);
            if (onThread) { action(); return; }
        }
        var invokeMethod = dispatcher.GetType().GetMethod("Invoke",
            new Type[] { typeof(Action) });
        if (invokeMethod != null)
            invokeMethod.Invoke(dispatcher, new object[] { action });
        else
            action();
    }
}

// ---------------------------------------------------------------------------
// Win32 window helpers that require persistent C# state or WM hooks
// ---------------------------------------------------------------------------

public static class WindowHelper
{
    private static HashSet<IntPtr> _immovableHwnds = new HashSet<IntPtr>();
    private static Dictionary<IntPtr, Delegate> _movingHooks = new Dictionary<IntPtr, Delegate>();
    private static Dictionary<string, System.Windows.Input.KeyEventHandler> _accelHandlers =
        new Dictionary<string, System.Windows.Input.KeyEventHandler>();
    private static Dictionary<string, List<Tuple<int, int, string>>> _accelMaps =
        new Dictionary<string, List<Tuple<int, int, string>>>();
    // Keep menu click handlers alive to prevent GC
    private static List<Delegate> _menuClickHandlers = new List<Delegate>();

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

    private static IntPtr GetHwnd(object wpfWindow)
    {
        if (wpfWindow == null) return IntPtr.Zero;
        Type helperType = Type.GetType("System.Windows.Interop.WindowInteropHelper, PresentationFramework");
        if (helperType == null) return IntPtr.Zero;
        object helper = Activator.CreateInstance(helperType, new object[] { wpfWindow });
        PropertyInfo handleProp = helperType.GetProperty("Handle");
        if (handleProp == null) return IntPtr.Zero;
        return (IntPtr)handleProp.GetValue(helper, null);
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
        const int WM_SYSCOMMAND = 0x0112;
        const int SC_MOVE_MASK  = 0xFFF0;
        const int SC_MOVE       = 0xF010;
        if (msg == WM_SYSCOMMAND)
        {
            int command = (int)wParam & SC_MOVE_MASK;
            if (command == SC_MOVE && _immovableHwnds.Contains(hwnd))
                handled = true;
        }
        return IntPtr.Zero;
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
                            "{{\"type\":\"event\",\"callbackId\":\"{0}\",\"args\":[]}}", acc.Item3);
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
// WebView2 async helpers (require Task.ContinueWith + DispatcherInvoke)
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

        if (prop.CanWrite)
        {
            var list = new List<string>();
            if (origins != null)
                foreach (var o in origins)
                    if (o != null) list.Add(o.ToString());
            prop.SetValue(schemeReg, list, null);
            return;
        }

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
}
