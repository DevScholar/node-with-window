// scripts/PsBridge/PsHostEntry.cs
using System;
using System.Globalization;
using System.Text;

public static class PsHostEntry
{
    public static void Run(string pipeName)
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.InputEncoding = Encoding.UTF8;
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
        CultureInfo.DefaultThreadCurrentUICulture = CultureInfo.InvariantCulture;

        BridgeState.PipeName = pipeName;
        PsHost.ProcessNestedCommands = PsHost.RunProcessNestedCommands;
        
        try
        {
            PsHost.StartServer();
        }
        finally
        {
            if (BridgeState.PipeServer != null)
            {
                BridgeState.PipeServer.Dispose();
            }
        }
    }
}
