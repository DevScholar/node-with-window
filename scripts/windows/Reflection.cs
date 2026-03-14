// scripts/PsBridge/Reflection.cs
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

public static class Reflection
{
    public static Dictionary<string, object> InvokeReflectionLogic(Dictionary<string, object> cmd)
    {
        var action = cmd["action"].ToString();

        if (action == "GetRuntimeInfo")
        {
            var frameworkDescription = RuntimeInformation.FrameworkDescription;
            var environmentVersion = Environment.Version.ToString();
            string frameworkMoniker = InferFrameworkMoniker();
            
            return new Dictionary<string, object>
            {
                { "type", "runtimeInfo" },
                { "frameworkMoniker", frameworkMoniker },
                { "runtimeVersion", environmentVersion },
                { "frameworkDescription", frameworkDescription }
            };
        }

        if (action == "GetType")
        {
            var name = cmd["typeName"].ToString();
            var type = Type.GetType(name);
            if (type == null)
            {
                var assemblies = AppDomain.CurrentDomain.GetAssemblies();
                foreach (var asm in assemblies)
                {
                    type = asm.GetType(name);
                    if (type != null) break;
                }
            }
            if (type == null)
            {
                return new Dictionary<string, object> { { "type", "namespace" }, { "value", name } };
            }
            return Protocol.ConvertToProtocol(type);
        }

        if (action == "Inspect")
        {
            var target = BridgeState.ObjectStore[cmd["targetId"].ToString()];
            var memberName = cmd["memberName"].ToString();
            
            if (target is Type)
            {
                var prop = ((Type)target).GetProperty(memberName, BindingFlags.Public | BindingFlags.Static);
                if (prop != null)
                {
                    return new Dictionary<string, object> { { "type", "meta" }, { "memberType", "property" } };
                }
            }
            
            var members = target.GetType().GetMember(memberName);
            if (members != null && members.Length > 0)
            {
                var member = members[0];
                if (member is PropertyInfo)
                {
                    return new Dictionary<string, object> { { "type", "meta" }, { "memberType", "property" } };
                }
            }
            
            return new Dictionary<string, object> { { "type", "meta" }, { "memberType", "method" } };
        }

        if (action == "GetTypeName")
        {
            var target = BridgeState.ObjectStore[cmd["targetId"].ToString()];
            var typeName = target.GetType().FullName;
            return new Dictionary<string, object> { { "typeName", typeName } };
        }

        if (action == "InspectType")
        {
            var typeName = cmd["typeName"].ToString();
            var rawList = cmd["memberNames"] as System.Collections.Generic.List<object>;
            var emptyResult = new Dictionary<string, object>
            {
                { "typeName", typeName },
                { "members", new Dictionary<string, string>() }
            };
            if (rawList == null) return emptyResult;

            var type = Type.GetType(typeName);
            if (type == null)
            {
                var assemblies = AppDomain.CurrentDomain.GetAssemblies();
                foreach (var asm in assemblies)
                {
                    type = asm.GetType(typeName);
                    if (type != null) break;
                }
            }
            if (type == null) return emptyResult;

            var result = new Dictionary<string, object>();
            result["typeName"] = typeName;
            var members = new Dictionary<string, string>();

            foreach (object item in rawList)
            {
                var memberName = item.ToString();
                var prop = type.GetProperty(memberName, BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static);
                if (prop != null)
                {
                    members[memberName] = "property";
                    continue;
                }
                var methods = type.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static);
                var found = false;
                foreach (var m in methods)
                {
                    if (m.Name == memberName) { found = true; break; }
                }
                members[memberName] = found ? "method" : "unknown";
            }

            result["members"] = members;
            return result;
        }

        if (action == "AddEvent")
        {
            var target = BridgeState.ObjectStore[cmd["targetId"].ToString()];
            var eventName = cmd["eventName"].ToString();
            var cbId = cmd["callbackId"].ToString();

            var eventInfo = target.GetType().GetEvent(eventName);
            if (eventInfo != null)
            {
                var delegateType = eventInfo.EventHandlerType;
                var invokeMethod = delegateType.GetMethod("Invoke");
                var parameters = invokeMethod.GetParameters();
                
                Delegate handler = null;

                if (parameters.Length == 0)
                {
                    Action handler0 = () =>
                    {
                        var writer = BridgeState.Writer;
                        if (writer == null) return;
                        var msg = new Dictionary<string, object>
                        {
                            { "type", "event" },
                            { "callbackId", cbId },
                            { "args", new List<Dictionary<string, object>>() }
                        };
                        var json = SimpleJson.Serialize(msg);
                        if (BridgeState.UseQueueMode) { BridgeState.EventQueue.Enqueue(json); }
                        else { writer.WriteLine(json); try { if (PsHost.ProcessNestedCommands != null) PsHost.ProcessNestedCommands(); } catch { } }
                    };
                    handler = Delegate.CreateDelegate(delegateType, handler0.Target, handler0.Method);
                }
                else if (parameters.Length == 1)
                {
                    Action<object> handler1 = (arg) =>
                    {
                        var writer = BridgeState.Writer;
                        if (writer == null) return;
                        var protoArgs = new List<Dictionary<string, object>>();
                        protoArgs.Add(arg == null
                            ? new Dictionary<string, object> { { "type", "null" } }
                            : Protocol.ConvertToProtocol(arg));
                        var msg = new Dictionary<string, object>
                        {
                            { "type", "event" },
                            { "callbackId", cbId },
                            { "args", protoArgs }
                        };
                        var json = SimpleJson.Serialize(msg);
                        if (BridgeState.UseQueueMode) { BridgeState.EventQueue.Enqueue(json); }
                        else { writer.WriteLine(json); try { if (PsHost.ProcessNestedCommands != null) PsHost.ProcessNestedCommands(); } catch { } }
                    };
                    handler = Delegate.CreateDelegate(delegateType, handler1.Target, handler1.Method);
                }
                else if (parameters.Length == 2)
                {
                    var senderType = parameters[0].ParameterType;
                    var eType = parameters[1].ParameterType;
                    
                    Action<object, object> handlerAction = (sender, e) =>
                    {
                        var writer = BridgeState.Writer;
                        if (writer == null) return;
                        
                        var protoArgs = new List<Dictionary<string, object>>();
                        
                        foreach (var arg in new object[] { sender, e })
                        {
                            if (arg == null)
                            {
                                protoArgs.Add(new Dictionary<string, object> { { "type", "null" } });
                            }
                            else
                            {
                                protoArgs.Add(Protocol.ConvertToProtocol(arg));
                            }
                        }
                        
                        var msg = new Dictionary<string, object>
                        {
                            { "type", "event" },
                            { "callbackId", cbId },
                            { "args", protoArgs }
                        };
                        
                        var json = SimpleJson.Serialize(msg);

                        if (BridgeState.UseQueueMode)
                        {
                            BridgeState.EventQueue.Enqueue(json);
                        }
                        else
                        {
                            writer.WriteLine(json);
                            try
                            {
                                if (PsHost.ProcessNestedCommands != null)
                                    PsHost.ProcessNestedCommands();
                            }
                            catch { }
                        }
                    };

                    handler = Delegate.CreateDelegate(delegateType, handlerAction.Target, handlerAction.Method);
                }
                else
                {
                    // Delegates with 3+ parameters: not supported, event will be silently ignored.
                    // Most real-world events use 0, 1, or 2 parameters.
                    handler = null;
                }

                eventInfo.AddEventHandler(target, handler);
            }
            
            return new Dictionary<string, object> { { "type", "void" } };
        }

        if (action == "New")
        {
            var type = (Type)BridgeState.ObjectStore[cmd["typeId"].ToString()];
            var argsObj = cmd.ContainsKey("args") ? cmd["args"] : null;
            var args = Protocol.ResolveArgs(argsObj);
            
            object obj;
            try
            {
                if (args.Length == 0)
                {
                    obj = Activator.CreateInstance(type);
                }
                else
                {
                    var constructors = type.GetConstructors();
                    Exception lastException = null;
                    
                    foreach (var ctor in constructors)
                    {
                        var parameters = ctor.GetParameters();
                        if (parameters.Length != args.Length) continue;
                        
                        var convertedArgs = new object[args.Length];
                        var match = true;
                        
                        for (var i = 0; i < parameters.Length; i++)
                        {
                            var pType = parameters[i].ParameterType;
                            var arg = args[i];
                            
                            if (arg == null)
                            {
                                convertedArgs[i] = null;
                            }
                            else if (pType.IsAssignableFrom(arg.GetType()))
                            {
                                convertedArgs[i] = arg;
                            }
                            else if (arg is IConvertible && !pType.IsAssignableFrom(typeof(string)))
                            {
                                try
                                {
                                    convertedArgs[i] = Convert.ChangeType(arg, pType);
                                }
                                catch
                                {
                                    match = false;
                                    break;
                                }
                            }
                            else if (pType.IsEnum && arg is int)
                            {
                                convertedArgs[i] = Enum.ToObject(pType, arg);
                            }
                            else
                            {
                                match = false;
                                break;
                            }
                        }
                        
                        if (match)
                        {
                            try
                            {
                                obj = ctor.Invoke(convertedArgs);
                                return Protocol.ConvertToProtocol(obj);
                            }
                            catch (Exception ex)
                            {
                                lastException = ex;
                            }
                        }
                    }
                    
                    if (lastException != null)
                    {
                        throw lastException;
                    }
                    
                    obj = Activator.CreateInstance(type);
                }
            }
            catch (Exception ex)
            {
                throw new Exception("New Error: " + ex.Message);
            }
            
            return Protocol.ConvertToProtocol(obj);
        }

        if (action == "Invoke")
        {
            var target = BridgeState.ObjectStore[cmd["targetId"].ToString()];
            var name = cmd["methodName"].ToString();
            var argsObj = cmd.ContainsKey("args") ? cmd["args"] : null;
            var realArgs = Protocol.ResolveArgs(argsObj);

            var isStatic = target is Type;
            var targetType = isStatic ? (Type)target : target.GetType();

            if (isStatic && realArgs.Length == 0)
            {
                try
                {
                    var prop = targetType.GetProperty(name, BindingFlags.Public | BindingFlags.Static);
                    if (prop != null)
                    {
                        var result = prop.GetValue(null);
                        return Protocol.ConvertToProtocol(result);
                    }
                    
                    var field = targetType.GetField(name, BindingFlags.Public | BindingFlags.Static);
                    if (field != null)
                    {
                        var result = field.GetValue(null);
                        return Protocol.ConvertToProtocol(result);
                    }
                }
                catch { }
            }

            if (!isStatic && realArgs.Length > 0)
            {
                var prop = targetType.GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
                if (prop != null && prop.CanWrite)
                {
                    try
                    {
                        var value = realArgs[0];
                        if (value != null && !prop.PropertyType.IsAssignableFrom(value.GetType()))
                        {
                            if (prop.PropertyType.IsEnum)
                            {
                                var intValue = value is long ? (int)(long)value : (int)value;
                                value = Enum.ToObject(prop.PropertyType, intValue);
                            }
                            else if (prop.PropertyType.IsValueType && !prop.PropertyType.IsPrimitive)
                            {
                                // Handle structs like FontWeight - try to create from integer
                                var intValue = value is long ? (int)(long)value : (int)value;
                                var ctor = prop.PropertyType.GetConstructor(new[] { typeof(int) });
                                if (ctor != null)
                                {
                                    value = ctor.Invoke(new object[] { intValue });
                                }
                                else if (value is IConvertible)
                                {
                                    value = Convert.ChangeType(value, prop.PropertyType);
                                }
                            }
                            else if (value is IConvertible)
                            {
                                value = Convert.ChangeType(value, prop.PropertyType);
                            }
                        }
                        prop.SetValue(target, value);
                        return new Dictionary<string, object> { { "type", "void" } };
                    }
                    catch (Exception ex)
                    {
                        throw new Exception("Set Property Error '" + name + "': " + ex.Message);
                    }
                }
            }

            if (!isStatic && realArgs.Length == 0)
            {
                var prop = targetType.GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
                if (prop != null)
                {
                    return Protocol.ConvertToProtocol(prop.GetValue(target));
                }
            }

            try
            {
                object result = null;
                var bindingFlags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy | BindingFlags.IgnoreCase;

                var hasDelegateArg = false;
                foreach (var arg in realArgs)
                {
                    if (arg is Delegate || arg is Func<object, object, object, object, object>)
                    {
                        hasDelegateArg = true;
                        break;
                    }
                }

                var manualSuccess = false;

                if (hasDelegateArg)
                {
                    var methods = targetType.GetMethods(bindingFlags).Where(m => m.Name == name).ToArray();
                    
                    foreach (var method in methods)
                    {
                        var parameters = method.GetParameters();
                        if (parameters.Length != realArgs.Length) continue;
                        
                        var tempArgs = new object[realArgs.Length];
                        Array.Copy(realArgs, tempArgs, realArgs.Length);
                        var match = true;
                        
                        for (var i = 0; i < parameters.Length; i++)
                        {
                            var pType = parameters[i].ParameterType;
                            var arg = tempArgs[i];
                            
                            if (arg is Func<object, object, object, object, object>)
                            {
                                var func = (Func<object, object, object, object, object>)arg;
                                if (pType == typeof(Delegate))
                                {
                                    try
                                    {
                                        tempArgs[i] = (Action)(() => func(null, null, null, null));
                                    }
                                    catch
                                    {
                                        match = false;
                                        break;
                                    }
                                }
                                else if (typeof(Delegate).IsAssignableFrom(pType))
                                {
                                    try
                                    {
                                        tempArgs[i] = Delegate.CreateDelegate(pType, func.Target, func.Method);
                                    }
                                    catch
                                    {
                                        match = false;
                                        break;
                                    }
                                }
                                else
                                {
                                    match = false;
                                    break;
                                }

                                if (tempArgs[i] == null)
                                {
                                    match = false;
                                    break;
                                }
                            }
                            else if (arg != null && !pType.IsAssignableFrom(arg.GetType()))
                            {
                                if (pType.IsEnum && (arg is int || arg is long))
                                {
                                    var intVal = arg is long ? (int)(long)arg : (int)arg;
                                    tempArgs[i] = Enum.ToObject(pType, intVal);
                                }
                                else if (IsNumericType(arg.GetType()) && IsNumericType(pType))
                                {
                                    try
                                    {
                                        tempArgs[i] = Convert.ChangeType(arg, pType);
                                    }
                                    catch
                                    {
                                        match = false;
                                        break;
                                    }
                                }
                                else
                                {
                                    match = false;
                                    break;
                                }
                            }
                        }
                        
                        if (match)
                        {
                            try
                            {
                                var instanceToCall = isStatic ? null : target;
                                result = method.Invoke(instanceToCall, tempArgs);
                                manualSuccess = true;
                                break;
                            }
                            catch { }
                        }
                    }
                }

                if (!manualSuccess)
                {
                    var methods = targetType.GetMethods(bindingFlags).Where(m => m.Name == name).ToArray();
                    
                    if (methods.Length == 1)
                    {
                        var method = methods[0];
                        var convertedArgs = ConvertArgsForMethod(method, realArgs);
                        result = method.Invoke(isStatic ? null : target, convertedArgs);
                    }
                    else if (methods.Length > 1 && realArgs.Length > 0)
                    {
                        MethodInfo bestMethod = FindBestMatchingMethod(methods, realArgs);
                        if (bestMethod != null)
                        {
                            var convertedArgs = ConvertArgsForMethod(bestMethod, realArgs);
                            result = bestMethod.Invoke(isStatic ? null : target, convertedArgs);
                        }
                        else
                        {
                            result = methods[0].Invoke(isStatic ? null : target, realArgs);
                        }
                    }
                    else if (methods.Length > 0)
                    {
                        result = methods[0].Invoke(isStatic ? null : target, realArgs);
                    }
                }

                return Protocol.ConvertToProtocol(result);

            }
            catch (Exception ex)
            {
                if (realArgs.Length == 0)
                {
                    try
                    {
                        object val = null;
                        if (isStatic)
                        {
                            var prop = targetType.GetProperty(name, BindingFlags.Public | BindingFlags.Static);
                            if (prop != null) val = prop.GetValue(null);
                            else
                            {
                                var field = targetType.GetField(name, BindingFlags.Public | BindingFlags.Static);
                                if (field != null) val = field.GetValue(null);
                            }
                        }
                        else
                        {
                            var prop = targetType.GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
                            if (prop != null) val = prop.GetValue(target);
                            else
                            {
                                var field = targetType.GetField(name, BindingFlags.Public | BindingFlags.Instance);
                                if (field != null) val = field.GetValue(target);
                            }
                        }
                        if (val != null)
                        {
                            return Protocol.ConvertToProtocol(val);
                        }
                    }
                    catch { }
                }
                var innerMsg = ex.InnerException != null ? ex.InnerException.Message : ex.Message;
                throw new Exception("Invoke Error (" + name + "): " + innerMsg);
            }
        }
        
        if (action == "AwaitTask")
        {
            var taskId = cmd["taskId"].ToString();
            var task = (Task)BridgeState.ObjectStore[taskId];
            try
            {
                task.Wait();
                var taskType = task.GetType();
                if (taskType.IsGenericType && taskType.GetGenericTypeDefinition() == typeof(Task<>))
                {
                    var result = taskType.GetProperty("Result").GetValue(task);
                    return Protocol.ConvertToProtocol(result);
                }
                return new Dictionary<string, object> { { "type", "void" } };
            }
            catch (AggregateException ae)
            {
                var innerMsg = ae.InnerException != null ? ae.InnerException.Message : ae.ToString();
                throw new Exception("Task Error: " + innerMsg);
            }
        }
        
        if (action == "LoadAssembly")
        {
            var assemblyName = cmd["assemblyName"].ToString();
            Assembly asm = null;
            try
            {
                asm = Assembly.Load(assemblyName);
            }
            catch
            {
#pragma warning disable 618
                try { asm = Assembly.LoadWithPartialName(assemblyName); } catch { }
#pragma warning restore 618
            }
            if (asm == null)
            {
                throw new Exception("Failed to load assembly: " + assemblyName);
            }
            return Protocol.ConvertToProtocol(asm);
        }
        
        if (action == "LoadFrom")
        {
            var filePath = cmd["filePath"].ToString();
            if (!File.Exists(filePath))
            {
                throw new Exception("File not found: " + filePath);
            }
            // Add the DLL's directory to PATH so native side-by-side dependencies
            // (e.g. WebView2Loader.dll) are discoverable by the Windows DLL loader.
            string dllDir = Path.GetDirectoryName(filePath);
            if (dllDir != null && dllDir.Length > 0)
            {
                string currentPath = Environment.GetEnvironmentVariable("PATH");
                if (currentPath == null) currentPath = "";
                if (currentPath.IndexOf(dllDir, StringComparison.OrdinalIgnoreCase) < 0)
                {
                    Environment.SetEnvironmentVariable("PATH", dllDir + ";" + currentPath);
                }
            }
            Assembly asm = null;
            try
            {
                asm = Assembly.LoadFrom(filePath);
            }
            catch (Exception ex)
            {
                throw new Exception("Failed to load assembly from file: " + ex.Message);
            }
            return Protocol.ConvertToProtocol(asm);
        }

        // ─── WebView2 / WPF Framework Actions ────────────────────────────────────
        // The following actions are intended for authors building WebView2-based
        // window frameworks (e.g. @devscholar/node-with-window). They rely on the
        // WPF polling model (StartApplication + Poll) and WebView2-specific APIs.
        // General node-ps1-dotnet users do not need to invoke these directly.

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

        // Registers a script on CoreWebView2, waits for the registration Task to
        // complete (cross-process ack), then navigates — all without blocking the
        // WPF UI thread.  Task.ContinueWith runs on a thread-pool thread; it marshals
        // the Navigate call back to the UI thread via MainSyncContext.Post.
        if (action == "AddScriptAndNavigate")
        {
            var targetId = cmd["targetId"].ToString();
            var script   = cmd["script"].ToString();
            var url      = cmd["url"].ToString();

            var coreWebView2 = BridgeState.ObjectStore[targetId];
            var coreWebView2Type = coreWebView2.GetType();

            MethodInfo addScriptMethod = null;
            foreach (var m in coreWebView2Type.GetMethods(BindingFlags.Public | BindingFlags.Instance))
            {
                if (m.Name == "AddScriptToExecuteOnDocumentCreatedAsync" && m.GetParameters().Length == 1)
                {
                    addScriptMethod = m;
                    break;
                }
            }

            MethodInfo navigateMethod = null;
            foreach (var m in coreWebView2Type.GetMethods(BindingFlags.Public | BindingFlags.Instance))
            {
                if (m.Name == "Navigate" && m.GetParameters().Length == 1)
                {
                    navigateMethod = m;
                    break;
                }
            }

            if (addScriptMethod == null || navigateMethod == null)
            {
                throw new Exception("AddScriptAndNavigate: could not find required CoreWebView2 methods");
            }

            var task = (Task)addScriptMethod.Invoke(coreWebView2, new object[] { script });
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

        if (action == "AddScriptAndNavigateToString")
        {
            var targetId = cmd["targetId"].ToString();
            var script   = cmd["script"].ToString();
            var html     = cmd["html"].ToString();

            var coreWebView2     = BridgeState.ObjectStore[targetId];
            var coreWebView2Type = coreWebView2.GetType();

            MethodInfo addScriptMethod = null;
            foreach (var m in coreWebView2Type.GetMethods(BindingFlags.Public | BindingFlags.Instance))
            {
                if (m.Name == "AddScriptToExecuteOnDocumentCreatedAsync" && m.GetParameters().Length == 1)
                {
                    addScriptMethod = m;
                    break;
                }
            }

            MethodInfo navigateToStringMethod = null;
            foreach (var m in coreWebView2Type.GetMethods(BindingFlags.Public | BindingFlags.Instance))
            {
                if (m.Name == "NavigateToString" && m.GetParameters().Length == 1)
                {
                    navigateToStringMethod = m;
                    break;
                }
            }

            if (addScriptMethod == null || navigateToStringMethod == null)
            {
                throw new Exception("AddScriptAndNavigateToString: could not find required CoreWebView2 methods");
            }

            var task = (Task)addScriptMethod.Invoke(coreWebView2, new object[] { script });
            var capturedNavigateToStringMethod = navigateToStringMethod;
            var capturedCoreWebView2           = coreWebView2;
            var capturedHtml                   = html;
            var capturedContext                = PsHost.MainSyncContext;

            task.ContinueWith(delegate(Task t)
            {
                if (capturedContext != null)
                {
                    capturedContext.Post(delegate(object state)
                    {
                        try { capturedNavigateToStringMethod.Invoke(capturedCoreWebView2, new object[] { capturedHtml }); }
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

            // If a webView ref is provided, hook Window.Loaded in C# to call
            // EnsureCoreWebView2Async directly (fire-and-forget).
            // Calling it via the Node.js poll callback would deadlock: AwaitTask sends
            // task.Wait() on the WPF UI thread, but the task needs the dispatcher to
            // pump messages to complete.
            if (cmd.ContainsKey("webViewId"))
            {
                var webViewRef = cmd["webViewId"].ToString();
                var webViewObj = BridgeState.ObjectStore[webViewRef];
                var loadedEvent = wpfWindow.GetType().GetEvent("Loaded");
                if (loadedEvent != null)
                {
                    Action<object, object> loadedAction = (sender, e) =>
                    {
                        MethodInfo ensureMethod = null;
                        foreach (var m in webViewObj.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance))
                        {
                            if (m.Name == "EnsureCoreWebView2Async" && m.GetParameters().Length == 1)
                            {
                                ensureMethod = m;
                                break;
                            }
                        }
                        if (ensureMethod == null)
                        {
                            foreach (var m in webViewObj.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance))
                            {
                                if (m.Name == "EnsureCoreWebView2Async")
                                {
                                    ensureMethod = m;
                                    break;
                                }
                            }
                        }
                        if (ensureMethod != null)
                        {
                            try { ensureMethod.Invoke(webViewObj, new object[] { null }); }
                            catch { }
                        }
                    };
                    try
                    {
                        var delegateType = loadedEvent.EventHandlerType;
                        var handler = Delegate.CreateDelegate(delegateType, loadedAction.Target, loadedAction.Method);
                        loadedEvent.AddEventHandler(wpfWindow, handler);
                    }
                    catch { }
                }
            }

            // Install the WPF DispatcherSynchronizationContext so the reader thread can
            // dispatch Poll commands onto the UI thread via MainSyncContext.Post().
            // By this point WindowsBase.dll is already loaded (WPF objects have been created).
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

            // Pre-send the response BEFORE Application.Run() blocks this thread.
            var okJson = SimpleJson.Serialize(new Dictionary<string, object>
            {
                { "type", "primitive" }, { "value", true }
            });
            lock (BridgeState.Writer) { BridgeState.Writer.WriteLine(okJson); }

            // Start the WPF message loop — blocks until the window is closed.
            MethodInfo runMethod = null;
            foreach (var m in wpfApp.GetType().GetMethods(BindingFlags.Public | BindingFlags.Instance))
            {
                if (m.Name == "Run" && m.GetParameters().Length == 1)
                {
                    runMethod = m;
                    break;
                }
            }
            if (runMethod != null) runMethod.Invoke(wpfApp, new object[] { wpfWindow });

            // Window closed — terminate the host process.
            Environment.Exit(0);

            // Unreachable; satisfies compiler (ExecuteCommand won't write a second response).
            return new Dictionary<string, object> { { "__skipResponse", true } };
        }

        if (action == "ExecuteScript")
        {
            var webViewId = cmd["webViewId"].ToString();
            var script = cmd["script"].ToString();
            var webViewObj = BridgeState.ObjectStore[webViewId];
            
            var coreWebView2Prop = webViewObj.GetType().GetProperty("CoreWebView2");
            if (coreWebView2Prop == null)
            {
                return new Dictionary<string, object> { { "type", "error" }, { "message", "CoreWebView2 not available" } };
            }
            
            var coreWebView2 = coreWebView2Prop.GetValue(webViewObj);
            if (coreWebView2 == null)
            {
                return new Dictionary<string, object> { { "type", "error" }, { "message", "WebView2 not initialized" } };
            }
            
            var executeScriptMethod = coreWebView2.GetType().GetMethod("ExecuteScript", new[] { typeof(string) });
            if (executeScriptMethod == null)
            {
                return new Dictionary<string, object> { { "type", "error" }, { "message", "ExecuteScript method not found" } };
            }
            
            try
            {
                var task = executeScriptMethod.Invoke(coreWebView2, new object[] { script }) as System.Threading.Tasks.Task<string>;
                if (task != null)
                {
                    task.Wait();
                    var result = task.Result;
                    return new Dictionary<string, object> { { "type", "primitive" }, { "value", result } };
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
                var json = SimpleJson.Serialize(msg);
                lock (writer) { writer.WriteLine(json); }

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
                    try { return Assembly.LoadFrom(path); } catch { }
                }
                return null;
            };
            return new Dictionary<string, object> { { "type", "void" } };
        }

        if (action == "Release")
        {
            Protocol.RemoveBridgeObject(cmd["targetId"].ToString());
            return new Dictionary<string, object> { { "type", "void" } };
        }

        // ─── WinHelper — P/Invoke window chrome operations ───────────────────────
        // Used exclusively by node-with-window to apply window properties that
        // require direct Win32 calls (FlashWindow, taskbar visibility, etc.).

        if (action == "WinHelper")
        {
            var windowId = cmd["windowId"].ToString();
            var op       = cmd["op"].ToString();
            var wpfWindow = BridgeState.ObjectStore[windowId];

            if (op == "FlashWindow")
            {
                bool flag = cmd.ContainsKey("flag") && (bool)cmd["flag"];
                WindowHelper.FlashWindow(wpfWindow, flag);
            }
            else if (op == "SetMinimizable")
            {
                bool flag = !cmd.ContainsKey("flag") || (bool)cmd["flag"];
                WindowHelper.SetMinimizable(wpfWindow, flag);
            }
            else if (op == "SetMaximizable")
            {
                bool flag = !cmd.ContainsKey("flag") || (bool)cmd["flag"];
                WindowHelper.SetMaximizable(wpfWindow, flag);
            }
            else if (op == "SetClosable")
            {
                bool flag = !cmd.ContainsKey("flag") || (bool)cmd["flag"];
                WindowHelper.SetClosable(wpfWindow, flag);
            }
            else if (op == "SetMovable")
            {
                bool flag = !cmd.ContainsKey("flag") || (bool)cmd["flag"];
                WindowHelper.SetMovable(wpfWindow, flag);
            }
            else if (op == "SetSkipTaskbar")
            {
                bool flag = cmd.ContainsKey("flag") && (bool)cmd["flag"];
                WindowHelper.SetSkipTaskbar(wpfWindow, flag);
            }

            return new Dictionary<string, object> { { "type", "void" } };
        }

        if (action == "TrashItem")
        {
            var filePath = cmd["filePath"].ToString();
            try
            {
                WindowHelper.TrashItem(filePath);
                return new Dictionary<string, object> { { "type", "void" } };
            }
            catch (Exception ex)
            {
                return new Dictionary<string, object>
                {
                    { "type", "error" },
                    { "message", ex.Message }
                };
            }
        }

        return new Dictionary<string, object> { { "type", "void" } };
    }
    
    private static object[] ConvertArgsForMethod(MethodInfo method, object[] args)
    {
        if (args == null || args.Length == 0) return args;
        
        var parameters = method.GetParameters();
        if (parameters.Length != args.Length) return args;
        
        var convertedArgs = new object[args.Length];
        Array.Copy(args, convertedArgs, args.Length);
        
        for (var i = 0; i < parameters.Length; i++)
        {
            var pType = parameters[i].ParameterType;
            var arg = args[i];
            
            if (arg == null || pType.IsAssignableFrom(arg.GetType()))
            {
                continue;
            }
            
            var argType = arg.GetType();
            
            if (pType.IsEnum)
            {
                if (arg is int || arg is long)
                {
                    var intVal = arg is long ? (int)(long)arg : (int)arg;
                    convertedArgs[i] = Enum.ToObject(pType, intVal);
                }
            }
            else if (pType == typeof(TimeSpan))
            {
                if (arg is long)
                {
                    convertedArgs[i] = TimeSpan.FromMilliseconds((long)arg);
                }
                else if (arg is int)
                {
                    convertedArgs[i] = TimeSpan.FromMilliseconds((int)arg);
                }
                else if (arg is double)
                {
                    convertedArgs[i] = TimeSpan.FromMilliseconds((double)arg);
                }
            }
            else if (argType == typeof(string) && (pType == typeof(string) || pType == typeof(object)))
            {
                convertedArgs[i] = arg;
            }
            else if (IsNumericType(argType) && IsNumericType(pType))
            {
                try
                {
                    convertedArgs[i] = Convert.ChangeType(arg, pType);
                }
                catch { }
            }
            else if (arg is IConvertible && pType != typeof(string))
            {
                try
                {
                    convertedArgs[i] = Convert.ChangeType(arg, pType);
                }
                catch { }
            }
        }
        
        return convertedArgs;
    }
    
    private static MethodInfo FindBestMatchingMethod(MethodInfo[] methods, object[] args)
    {
        if (methods == null || methods.Length == 0 || args == null || args.Length == 0)
            return null;
        
        foreach (var method in methods)
        {
            var parameters = method.GetParameters();
            if (parameters.Length != args.Length) continue;
            
            var match = true;
            for (var i = 0; i < parameters.Length; i++)
            {
                var pType = parameters[i].ParameterType;
                var arg = args[i];
                var argType = arg != null ? arg.GetType() : null;
                
                if (argType == null) continue;
                
                if (!pType.IsAssignableFrom(argType))
                {
                    if (argType == typeof(string))
                    {
                        if (pType != typeof(string) && pType != typeof(object))
                        {
                            match = false;
                            break;
                        }
                        continue;
                    }
                    
                    if (pType.IsEnum)
                    {
                        if (!(arg is int || arg is long))
                        {
                            match = false;
                            break;
                        }
                    }
                    else if (pType == typeof(TimeSpan) && IsNumericType(argType))
                    {
                        continue;
                    }
                    else if (IsNumericType(argType) && IsNumericType(pType))
                    {
                        continue;
                    }
                    else if (args[i] is IConvertible && pType != typeof(string))
                    {
                        continue;
                    }
                    else
                    {
                        match = false;
                        break;
                    }
                }
            }
            
            if (match) return method;
        }
        
        return null;
    }
    
    private static string InferFrameworkMoniker()
    {
        var frameworkDescription = RuntimeInformation.FrameworkDescription;
        var environmentVersion = Environment.Version;
        
        if (frameworkDescription.StartsWith(".NET Framework"))
        {
            var versionParts = environmentVersion.ToString().Split('.');
            if (versionParts.Length >= 2)
            {
                int major = int.Parse(versionParts[0]);
                int minor = int.Parse(versionParts[1]);
                return "net" + major + minor;
            }
            return "net472";
        }
        
        if (frameworkDescription.StartsWith(".NET") && !frameworkDescription.StartsWith(".NET Framework"))
        {
            var versionParts = environmentVersion.ToString().Split('.');
            if (versionParts.Length >= 1)
            {
                int major = int.Parse(versionParts[0]);
                return "net" + major + ".0";
            }
            return "net8.0";
        }
        
        if (frameworkDescription.StartsWith(".NET Core"))
        {
            var versionParts = environmentVersion.ToString().Split('.');
            if (versionParts.Length >= 2)
            {
                int major = int.Parse(versionParts[0]);
                int minor = int.Parse(versionParts[1]);
                return "netcoreapp" + major + "." + minor;
            }
            return "netcoreapp3.1";
        }
        
        return "netstandard2.0";
    }
    
    private static bool IsNumericType(Type type)
    {
        return type == typeof(int) || type == typeof(long) || type == typeof(short) ||
               type == typeof(byte) || type == typeof(double) || type == typeof(float) ||
               type == typeof(decimal) || type == typeof(uint) || type == typeof(ulong) ||
               type == typeof(ushort) || type == typeof(sbyte);
    }
}
