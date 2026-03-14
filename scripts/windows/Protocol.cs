
// scripts/PsBridge/Protocol.cs
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public static class Protocol
{
    public static Dictionary<string, object> ConvertToProtocol(object inputObject)
    {
        if (inputObject == null)
        {
            return new Dictionary<string, object> { { "type", "null" } };
        }
        
        if (inputObject is bool || inputObject is string)
        {
            return new Dictionary<string, object> { { "type", "primitive" }, { "value", inputObject } };
        }

        if (inputObject.GetType().IsPrimitive)
        {
            var val = inputObject;
            if (val is double || val is float)
            {
                double dVal = Convert.ToDouble(val);
                if (double.IsNaN(dVal) || double.IsInfinity(dVal))
                {
                    val = null;
                }
            }
            return new Dictionary<string, object> { { "type", "primitive" }, { "value", val } };
        }

        if (inputObject is Task)
        {
            var refId = Guid.NewGuid().ToString();
            BridgeState.ObjectStore[refId] = inputObject;
            return new Dictionary<string, object>
            {
                { "type", "task" },
                { "id", refId },
                { "netType", inputObject.GetType().FullName }
            };
        }

        if (inputObject is Array)
        {
            var arr = (Array)inputObject;
            var arrResult = new List<Dictionary<string, object>>();
            foreach (var item in arr)
            {
                arrResult.Add(ConvertToProtocol(item));
            }
            return new Dictionary<string, object> { { "type", "array" }, { "value", arrResult } };
        }

        var objRefId = Guid.NewGuid().ToString();
        BridgeState.ObjectStore[objRefId] = inputObject;
        
        return new Dictionary<string, object>
        {
            { "type", "ref" },
            { "id", objRefId },
            { "netType", inputObject.GetType().FullName }
        };
    }

    public static object[] ResolveArgs(object argsObj)
    {
        var realArgs = new List<object>();
        
        IEnumerable<object> cmdArgs = null;
        if (argsObj is object[])
        {
            cmdArgs = ((object[])argsObj);
        }
        else if (argsObj is List<object>)
        {
            cmdArgs = (List<object>)argsObj;
        }
        
        if (cmdArgs != null)
        {
            foreach (var arg in cmdArgs)
            {
                var dict = arg as Dictionary<string, object>;
                if (dict != null && dict.ContainsKey("__ref"))
                {
                    realArgs.Add(BridgeState.ObjectStore[dict["__ref"].ToString()]);
                }
                else if (dict != null && dict.ContainsKey("type") && dict["type"].ToString() == "callback")
                {
                    var cbId = dict["callbackId"].ToString();
                    
                    Func<object, object, object, object, object> callback = (p1, p2, p3, p4) =>
                    {
                        var netCallbackArgs = new object[] { p1, p2, p3, p4 };
                        
                        var validProtoArgs = new List<Dictionary<string, object>>();
                        foreach (var a in netCallbackArgs)
                        {
                            if (a != null)
                            {
                                validProtoArgs.Add(ConvertToProtocol(a));
                            }
                        }

                        var msg = new Dictionary<string, object>
                        {
                            { "type", "event" },
                            { "callbackId", cbId },
                            { "args", validProtoArgs }
                        };
                        
                        var json = SimpleJson.Serialize(msg);
                        
                        BridgeState.Writer.WriteLine(json);
                        
                        object result = null;
                        try
                        {
                            if (PsHost.ProcessNestedCommands != null)
                            {
                                result = PsHost.ProcessNestedCommands();
                            }
                        }
                        catch { }
                        
                        return result;
                    };
                    
                    realArgs.Add(callback);
                }
                else
                {
                    realArgs.Add(arg);
                }
            }
        }
        return realArgs.ToArray();
    }

    public static void RemoveBridgeObject(string id)
    {
        object ignored;
        BridgeState.ObjectStore.TryRemove(id, out ignored);
    }
}

public static class SimpleJson
{
    public static string Serialize(object obj)
    {
        if (obj == null) return "null";
        
        if (obj is Dictionary<string, object>)
        {
            var dict = (Dictionary<string, object>)obj;
            var parts = new List<string>();
            foreach (var kvp in dict)
            {
                parts.Add(string.Format("\"{0}\":{1}", EscapeString(kvp.Key), Serialize(kvp.Value)));
            }
            return "{" + string.Join(",", parts.ToArray()) + "}";
        }
        
        if (obj is List<Dictionary<string, object>>)
        {
            var list = (List<Dictionary<string, object>>)obj;
            var parts = new List<string>();
            foreach (var item in list)
            {
                parts.Add(Serialize(item));
            }
            return "[" + string.Join(",", parts.ToArray()) + "]";
        }

        if (obj is List<object>)
        {
            var list = (List<object>)obj;
            var parts = new List<string>();
            foreach (var item in list)
            {
                parts.Add(Serialize(item));
            }
            return "[" + string.Join(",", parts.ToArray()) + "]";
        }
        
        if (obj is string)
        {
            return "\"" + EscapeString((string)obj) + "\"";
        }
        
        if (obj is bool)
        {
            return (bool)obj ? "true" : "false";
        }
        
        if (obj == null)
        {
            return "null";
        }
        
        if (obj.GetType().IsPrimitive || obj is decimal)
        {
            return obj.ToString();
        }
        
        return "\"" + EscapeString(obj.ToString()) + "\"";
    }
    
    private static string EscapeString(string s)
    {
        if (s == null) return "";
        var sb = new StringBuilder();
        foreach (var c in s)
        {
            switch (c)
            {
                case '\\': sb.Append("\\\\"); break;
                case '"': sb.Append("\\\""); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default: sb.Append(c); break;
            }
        }
        return sb.ToString();
    }
}
