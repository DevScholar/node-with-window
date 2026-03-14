// WinChromeActions.cs
// Actions that apply Win32 P/Invoke window-chrome operations.
// Delegates to WindowHelper for all platform calls.
using System;
using System.Collections.Generic;

public static class WinChromeActions
{
    public static bool Handles(string action)
    {
        return action == "WinHelper" || action == "TrashItem";
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
                // Unknown op: silently ignored — new ops added in future versions
                // will not crash older builds.
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

        throw new Exception("WinChromeActions: unhandled action: " + action);
    }
}
