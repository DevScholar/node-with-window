// WebView2Actions.cs
// Actions that require the WPF message loop (StartApplication/Poll) and WebView2 APIs.
// These are invoked exclusively by node-with-window; general dotnet proxy users
// never call them directly.
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Threading.Tasks;

public static class WebView2Actions
{
    public static bool Handles(string action)
    {
        switch (action)
        {
            case "Poll":
            case "AddScriptAndNavigate":
            case "AddScriptAndNavigateToString":
            case "StartApplication":
            case "ExecuteScript":
            case "SetResolvingCallback":
            case "SetWebViewBackground":
                return true;
            default:
                return false;
        }
    }

    public static Dictionary<string, object> Execute(Dictionary<string, object> cmd)
    {
        var action = cmd["action"].ToString();

        if (action == "Poll")
        {
            string eventJson;
            if (BridgeState.EventQueue.TryDequeue(out eventJson))
            {
                return new Dictionary<string, object>
                {
                    { "type", "ipc" },
                    { "message", eventJson }
                };
            }
            return new Dictionary<string, object> { { "type", "none" } };
        }

        // Registers a preload script on CoreWebView2, waits for the async registration
        // to complete, then navigates to a URL — all without blocking the WPF UI thread.
        if (action == "AddScriptAndNavigate")
        {
            var targetId = cmd["targetId"].ToString();
            var script   = cmd["script"].ToString();
            var url      = cmd["url"].ToString();

            var coreWebView2     = BridgeState.ObjectStore[targetId];
            var coreWebView2Type = coreWebView2.GetType();

            var addScriptMethod = FindMethod(coreWebView2Type, "AddScriptToExecuteOnDocumentCreatedAsync", 1);
            var navigateMethod  = FindMethod(coreWebView2Type, "Navigate", 1);

            if (addScriptMethod == null || navigateMethod == null)
                throw new Exception("AddScriptAndNavigate: could not find required CoreWebView2 methods");

            var task                   = (Task)addScriptMethod.Invoke(coreWebView2, new object[] { script });
            var capturedNavigateMethod = navigateMethod;
            var capturedCoreWebView2   = coreWebView2;
            var capturedUrl            = url;
            var capturedContext        = PsHost.MainSyncContext;

            task.ContinueWith(delegate(Task t)
            {
                if (capturedContext != null)
                {
                    capturedContext.Post(delegate(object state)
                    {
                        try { capturedNavigateMethod.Invoke(capturedCoreWebView2, new object[] { capturedUrl }); }
                        catch { }
                    }, null);
                }
            });

            return new Dictionary<string, object> { { "type", "void" } };
        }

        // Same as AddScriptAndNavigate but uses NavigateToString for inline HTML.
        if (action == "AddScriptAndNavigateToString")
        {
            var targetId = cmd["targetId"].ToString();
            var script   = cmd["script"].ToString();
            var html     = cmd["html"].ToString();

            var coreWebView2     = BridgeState.ObjectStore[targetId];
            var coreWebView2Type = coreWebView2.GetType();

            var addScriptMethod        = FindMethod(coreWebView2Type, "AddScriptToExecuteOnDocumentCreatedAsync", 1);
            var navigateToStringMethod = FindMethod(coreWebView2Type, "NavigateToString", 1);

            if (addScriptMethod == null || navigateToStringMethod == null)
                throw new Exception("AddScriptAndNavigateToString: could not find required CoreWebView2 methods");

            var task = (Task)addScriptMethod.Invoke(coreWebView2, new object[] { script });
            var capturedMethod  = navigateToStringMethod;
            var capturedWebView = coreWebView2;
            var capturedHtml    = html;
            var capturedContext = PsHost.MainSyncContext;

            task.ContinueWith(delegate(Task t)
            {
                if (capturedContext != null)
                {
                    capturedContext.Post(delegate(object state)
                    {
                        try { capturedMethod.Invoke(capturedWebView, new object[] { capturedHtml }); }
                        catch { }
                    }, null);
                }
            });

            return new Dictionary<string, object> { { "type", "void" } };
        }

        if (action == "StartApplication")
        {
            var appId    = cmd["appId"].ToString();
            var windowId = cmd["windowId"].ToString();
            var wpfApp    = BridgeState.ObjectStore[appId];
            var wpfWindow = BridgeState.ObjectStore[windowId];

            BridgeState.UseQueueMode = true;

            // Hook Window.Loaded to call EnsureCoreWebView2Async on the UI thread.
            // Calling it from the Node.js poll callback would deadlock: task.Wait()
            // on the UI thread prevents the dispatcher from pumping the completion.
            if (cmd.ContainsKey("webViewId"))
            {
                var webViewObj  = BridgeState.ObjectStore[cmd["webViewId"].ToString()];
                var loadedEvent = wpfWindow.GetType().GetEvent("Loaded");
                if (loadedEvent != null)
                {
                    Action<object, object> loadedAction = (sender, e) =>
                    {
                        var ensureMethod = FindMethod(webViewObj.GetType(), "EnsureCoreWebView2Async", 1)
                                       ?? FindMethod(webViewObj.GetType(), "EnsureCoreWebView2Async", -1);
                        if (ensureMethod != null)
                        {
                            try { ensureMethod.Invoke(webViewObj, new object[] { null }); }
                            catch { }
                        }
                    };
                    try
                    {
                        var handler = Delegate.CreateDelegate(loadedEvent.EventHandlerType,
                                                              loadedAction.Target, loadedAction.Method);
                        loadedEvent.AddEventHandler(wpfWindow, handler);
                    }
                    catch { }
                }
            }

            // Capture the WPF DispatcherSynchronizationContext so Poll commands can
            // be marshalled onto the UI thread via MainSyncContext.Post().
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                if (asm.GetName().Name != "WindowsBase") continue;
                var dispatcherType  = asm.GetType("System.Windows.Threading.Dispatcher");
                var syncContextType = asm.GetType("System.Windows.Threading.DispatcherSynchronizationContext");
                if (dispatcherType == null || syncContextType == null) break;
                var dispatcher  = dispatcherType.GetProperty("CurrentDispatcher").GetValue(null);
                var syncContext = Activator.CreateInstance(syncContextType, dispatcher)
                                  as System.Threading.SynchronizationContext;
                if (syncContext != null)
                    PsHost.MainSyncContext = syncContext;
                break;
            }

            // Pre-send the ok response BEFORE Application.Run() blocks this thread.
            var okJson = SimpleJson.Serialize(new Dictionary<string, object>
            {
                { "type", "primitive" }, { "value", true }
            });
            lock (BridgeState.Writer) { BridgeState.Writer.WriteLine(okJson); }

            var runMethod = FindMethod(wpfApp.GetType(), "Run", 1);
            if (runMethod != null) runMethod.Invoke(wpfApp, new object[] { wpfWindow });

            // Window closed — terminate the host process.
            Environment.Exit(0);

            // Unreachable; satisfies compiler (ExecuteCommand won't write a second response).
            return new Dictionary<string, object> { { "__skipResponse", true } };
        }

        if (action == "ExecuteScript")
        {
            var webViewId  = cmd["webViewId"].ToString();
            var script     = cmd["script"].ToString();
            var webViewObj = BridgeState.ObjectStore[webViewId];

            var coreWebView2Prop = webViewObj.GetType().GetProperty("CoreWebView2");
            if (coreWebView2Prop == null)
                return new Dictionary<string, object> { { "type", "error" }, { "message", "CoreWebView2 not available" } };

            var coreWebView2 = coreWebView2Prop.GetValue(webViewObj);
            if (coreWebView2 == null)
                return new Dictionary<string, object> { { "type", "error" }, { "message", "WebView2 not initialized" } };

            var executeScriptMethod = coreWebView2.GetType().GetMethod("ExecuteScript", new[] { typeof(string) });
            if (executeScriptMethod == null)
                return new Dictionary<string, object> { { "type", "error" }, { "message", "ExecuteScript method not found" } };

            try
            {
                var task = executeScriptMethod.Invoke(coreWebView2, new object[] { script })
                           as System.Threading.Tasks.Task<string>;
                if (task != null)
                {
                    task.Wait();
                    return new Dictionary<string, object> { { "type", "primitive" }, { "value", task.Result } };
                }
                return new Dictionary<string, object> { { "type", "primitive" }, { "value", null } };
            }
            catch (Exception ex)
            {
                return new Dictionary<string, object> { { "type", "error" }, { "message", ex.Message } };
            }
        }

        if (action == "SetResolvingCallback")
        {
            var cbId = cmd["callbackId"].ToString();
            AppDomain.CurrentDomain.AssemblyResolve += (resolveSender, resolveArgs) =>
            {
                var writer = BridgeState.Writer;
                if (writer == null) return null;
                var eventArgs = new List<Dictionary<string, object>>();
                eventArgs.Add(new Dictionary<string, object> { { "type", "primitive" }, { "value", resolveArgs.Name } });
                var msg = new Dictionary<string, object>
                {
                    { "type", "event" },
                    { "callbackId", cbId },
                    { "args", eventArgs }
                };
                lock (writer) { writer.WriteLine(SimpleJson.Serialize(msg)); }

                object result = null;
                try
                {
                    if (PsHost.ProcessNestedCommands != null)
                        result = PsHost.ProcessNestedCommands();
                }
                catch { }

                var path = result as string;
                if (path != null && path.Length > 0)
                {
                    try { return System.Reflection.Assembly.LoadFrom(path); } catch { }
                }
                return null;
            };
            return new Dictionary<string, object> { { "type", "void" } };
        }

        // Sets WebView2 DefaultBackgroundColor. Must be called before show().
        // WPF WebView2 defers the value until CoreWebView2Controller is initialised.
        if (action == "SetWebViewBackground")
        {
            var webViewId  = cmd["webViewId"].ToString();
            var a          = Convert.ToInt32(cmd["a"]);
            var r          = Convert.ToInt32(cmd["r"]);
            var g          = Convert.ToInt32(cmd["g"]);
            var b          = Convert.ToInt32(cmd["b"]);

            var webViewObj = BridgeState.ObjectStore[webViewId];
            var bgProp     = webViewObj.GetType().GetProperty("DefaultBackgroundColor");
            if (bgProp != null)
            {
                var color = System.Drawing.Color.FromArgb(a, r, g, b);
                bgProp.SetValue(webViewObj, color, null);
            }
            return new Dictionary<string, object> { { "type", "void" } };
        }

        throw new Exception("WebView2Actions: unhandled action: " + action);
    }

    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------

    // Finds a public instance method by name and optional parameter count
    // (pass -1 to match any overload).
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
}
