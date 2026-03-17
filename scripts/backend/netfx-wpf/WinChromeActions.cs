// WinChromeActions.cs
// Actions that apply Win32 P/Invoke window-chrome operations.
// Delegates to WindowHelper for all platform calls.
using System;
using System.Collections.Generic;

public static class WinChromeActions
{
    public static bool Handles(string action)
    {
        return action == "WinHelper" || action == "TrashItem"
            || action == "FixTransparentInput" || action == "FixTransparentInputChildren"
            || action == "DwmTransparent" || action == "ApplyWindowChrome" || action == "ApplyHiddenTitleBar"
            || action == "GetHwnd" || action == "SetOwnerByHwnd" || action == "SetWindowEnabled"
            || action == "SetWindowIcon";
    }

    public static Dictionary<string, object> Execute(Dictionary<string, object> cmd)
    {
        var action = cmd["action"].ToString();

        if (action == "WinHelper")
        {
            var wpfWindow = BridgeState.ObjectStore[cmd["windowId"].ToString()];
            var op        = cmd["op"].ToString();

            switch (op)
            {
                case "FlashWindow":
                {
                    bool flag = cmd.ContainsKey("flag") && (bool)cmd["flag"];
                    WindowHelper.FlashWindow(wpfWindow, flag);
                    break;
                }
                case "SetMinimizable":
                {
                    bool flag = !cmd.ContainsKey("flag") || (bool)cmd["flag"];
                    WindowHelper.SetMinimizable(wpfWindow, flag);
                    break;
                }
                case "SetMaximizable":
                {
                    bool flag = !cmd.ContainsKey("flag") || (bool)cmd["flag"];
                    WindowHelper.SetMaximizable(wpfWindow, flag);
                    break;
                }
                case "SetClosable":
                {
                    bool flag = !cmd.ContainsKey("flag") || (bool)cmd["flag"];
                    WindowHelper.SetClosable(wpfWindow, flag);
                    break;
                }
                case "SetMovable":
                {
                    bool flag = !cmd.ContainsKey("flag") || (bool)cmd["flag"];
                    WindowHelper.SetMovable(wpfWindow, flag);
                    break;
                }
                case "SetSkipTaskbar":
                {
                    bool flag = cmd.ContainsKey("flag") && (bool)cmd["flag"];
                    WindowHelper.SetSkipTaskbar(wpfWindow, flag);
                    break;
                }
                case "Minimize":
                {
                    WindowHelper.Minimize(wpfWindow);
                    break;
                }
                case "SetFullScreen":
                {
                    bool fsFlag       = cmd.ContainsKey("flag")          && (bool)cmd["flag"];
                    bool needFrameless = cmd.ContainsKey("needFrameless") && (bool)cmd["needFrameless"];
                    bool alwaysOnTop  = cmd.ContainsKey("alwaysOnTop")   && (bool)cmd["alwaysOnTop"];
                    WindowHelper.SetFullScreen(wpfWindow, fsFlag, needFrameless, alwaysOnTop);
                    break;
                }
                // Unknown op: silently ignored — new ops added in future versions
                // will not crash older builds.
            }

            return new Dictionary<string, object> { { "type", "void" } };
        }

        if (action == "FixTransparentInput")
        {
            var wpfWindow = BridgeState.ObjectStore[cmd["windowId"].ToString()];
            WindowHelper.FixTransparentInput(wpfWindow);
            return new Dictionary<string, object> { { "type", "void" } };
        }

        // Called again after CoreWebView2 initialises (its HWNDs are created asynchronously).
        if (action == "FixTransparentInputChildren")
        {
            var wpfWindow = BridgeState.ObjectStore[cmd["windowId"].ToString()];
            var hwnd = WindowHelper.GetHwnd(wpfWindow);
            if (hwnd != System.IntPtr.Zero) WindowHelper.FixChildHwnds(hwnd);
            return new Dictionary<string, object> { { "type", "void" } };
        }

        if (action == "ApplyWindowChrome")
        {
            var wpfWindow = BridgeState.ObjectStore[cmd["windowId"].ToString()];
            WindowHelper.ApplyWindowChrome(wpfWindow);
            return new Dictionary<string, object> { { "type", "void" } };
        }

        if (action == "ApplyHiddenTitleBar")
        {
            var wpfWindow = BridgeState.ObjectStore[cmd["windowId"].ToString()];
            WindowHelper.ApplyHiddenTitleBar(wpfWindow);
            return new Dictionary<string, object> { { "type", "void" } };
        }

        if (action == "DwmTransparent")
        {
            var wpfWindow = BridgeState.ObjectStore[cmd["windowId"].ToString()];
            WindowHelper.DwmTransparent(wpfWindow);
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

        if (action == "GetHwnd")
        {
            var wpfWindow = BridgeState.ObjectStore[cmd["windowId"].ToString()];
            IntPtr hwnd = WindowHelper.GetHwnd(wpfWindow);
            return new Dictionary<string, object>
            {
                { "type", "primitive" }, { "value", hwnd.ToInt64().ToString() }
            };
        }

        if (action == "SetOwnerByHwnd")
        {
            var childWindow = BridgeState.ObjectStore[cmd["windowId"].ToString()];
            long ownerHwnd = long.Parse(cmd["ownerHwnd"].ToString());
            WindowHelper.SetOwnerByHwnd(childWindow, ownerHwnd);
            return new Dictionary<string, object> { { "type", "void" } };
        }

        if (action == "SetWindowEnabled")
        {
            var wpfWindow = BridgeState.ObjectStore[cmd["windowId"].ToString()];
            bool enabled = bool.Parse(cmd["enabled"].ToString());
            WindowHelper.SetWindowEnabled(wpfWindow, enabled);
            return new Dictionary<string, object> { { "type", "void" } };
        }

        if (action == "SetWindowIcon")
        {
            var wpfWindow = BridgeState.ObjectStore[cmd["windowId"].ToString()];
            var iconPath  = cmd["iconPath"].ToString();
            WindowHelper.SetWindowIcon(wpfWindow, iconPath);
            return new Dictionary<string, object> { { "type", "void" } };
        }

        throw new Exception("WinChromeActions: unhandled action: " + action);
    }
}
