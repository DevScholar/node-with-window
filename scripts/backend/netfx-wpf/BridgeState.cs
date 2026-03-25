// scripts/PsBridge/BridgeState.cs
using System;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;

public class EventEntry
{
    public string TargetId;
    public string EventName;
    public Delegate Handler;
}

public static class BridgeState
{
    public static ConcurrentDictionary<string, object> ObjectStore { get; private set; }

    // Stores event handler delegates keyed by callbackId for later removal.
    public static ConcurrentDictionary<string, EventEntry> EventHandlerStore { get; private set; }

    public static StreamReader Reader { get; set; }
    public static StreamWriter Writer { get; set; }
    public static NamedPipeServerStream PipeServer { get; set; }
    public static string PipeName { get; set; }

    // Queue for events dispatched in polling mode (set by StartApplication)
    public static ConcurrentQueue<string> EventQueue { get; set; }

    // When true, AddEvent handlers enqueue instead of blocking on ProcessNestedCommands
    public static bool UseQueueMode { get; set; }

    static BridgeState()
    {
        ObjectStore = new ConcurrentDictionary<string, object>();
        EventHandlerStore = new ConcurrentDictionary<string, EventEntry>();
        EventQueue = new ConcurrentQueue<string>();
        UseQueueMode = false;
    }
}
