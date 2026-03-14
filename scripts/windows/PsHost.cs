// scripts/PsBridge/PsHost.cs
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;

public static class PsHost
{
    public static Func<object> ProcessNestedCommands { get; set; }

    public static BlockingCollection<Dictionary<string, object>> CommandQueue = new BlockingCollection<Dictionary<string, object>>();
    public static BlockingCollection<Dictionary<string, object>> ReplyQueue = new BlockingCollection<Dictionary<string, object>>();
    public static SynchronizationContext MainSyncContext { get; set; }

    public static object RunProcessNestedCommands()
    {
        var queues = new BlockingCollection<Dictionary<string, object>>[] { ReplyQueue, CommandQueue };
        
        while (BridgeState.PipeServer != null && BridgeState.PipeServer.IsConnected)
        {
            Dictionary<string, object> item;
            int index = BlockingCollection<Dictionary<string, object>>.TakeFromAny(queues, out item);

            if (index == 0)
            {
                if (item != null && item.ContainsKey("result"))
                {
                    return item["result"];
                }
                return null;
            }
            else if (index == 1)
            {
                if (item != null)
                {
                    ExecuteCommand(item);
                }
            }
        }
        return null;
    }

    private static void UpdateSyncContext()
    {
        if (SynchronizationContext.Current != null && MainSyncContext != SynchronizationContext.Current)
        {
            MainSyncContext = SynchronizationContext.Current;
        }
    }

    public static void ExecuteCommand(Dictionary<string, object> cmd)
    {
        if (cmd == null) return;
        
        try
        {
            var result = Reflection.InvokeReflectionLogic(cmd);
            UpdateSyncContext();

            // StartApplication pre-sends its own response and then blocks; skip the normal write.
            if (result != null && result.ContainsKey("__skipResponse"))
                return;

            var json = SimpleJson.Serialize(result);
            lock (BridgeState.Writer)
            {
                BridgeState.Writer.WriteLine(json);
            }
        }
        catch (Exception ex)
        {
            UpdateSyncContext();
            var errMsg = ex.InnerException != null ? ex.InnerException.Message : ex.Message;
            var errJson = SimpleJson.Serialize(new Dictionary<string, object>
            {
                { "type", "error" },
                { "message", errMsg.Replace("\"", "'") }
            });
            lock (BridgeState.Writer)
            {
                BridgeState.Writer.WriteLine(errJson);
            }
        }
    }

    public static void DrainCommandQueue(object state)
    {
        Dictionary<string, object> cmd;
        while (CommandQueue.TryTake(out cmd))
        {
            UpdateSyncContext();
            ExecuteCommand(cmd);
        }
    }

    public static void StartServer()
    {
        // Key change: Changed PipeOptions.None to PipeOptions.Asynchronous
        // This allows Windows to perform concurrent overlapped I/O on the handle, so reader thread suspension will never block main thread writes!
        BridgeState.PipeServer = new NamedPipeServerStream(
            BridgeState.PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        
        BridgeState.PipeServer.WaitForConnection();
        var utf8Encoding = new System.Text.UTF8Encoding(false);
        BridgeState.Reader = new StreamReader(BridgeState.PipeServer, utf8Encoding);
        BridgeState.Writer = new StreamWriter(BridgeState.PipeServer, utf8Encoding);
        BridgeState.Writer.AutoFlush = true;

        var readerThread = new Thread(() =>
        {
            try
            {
                while (BridgeState.PipeServer.IsConnected)
                {
                    var line = BridgeState.Reader.ReadLine();
                    if (line == null) break;

                    var msg = SimpleJsonDeserializer.Deserialize(line) as Dictionary<string, object>;
                    if (msg == null) continue;

                    if (msg.ContainsKey("type") && msg["type"].ToString() == "reply")
                    {
                        ReplyQueue.Add(msg);
                    }
                    else
                    {
                        CommandQueue.Add(msg);
                        if (MainSyncContext != null)
                        {
                            MainSyncContext.Post(DrainCommandQueue, null);
                        }
                    }
                }
            }
            catch { }
            finally
            {
                CommandQueue.CompleteAdding();
                ReplyQueue.CompleteAdding();
            }
        });
        readerThread.IsBackground = true;
        readerThread.Start();

        try
        {
            foreach (var cmd in CommandQueue.GetConsumingEnumerable())
            {
                UpdateSyncContext();
                ExecuteCommand(cmd);
            }
        }
        catch { }

        Environment.Exit(0);
    }
}

// SimpleJsonDeserializer: static entry point, instance-based parsing (thread-safe).
public static class SimpleJsonDeserializer
{
    public static object Deserialize(string json)
    {
        return new JsonParser(json).Parse();
    }
}

internal class JsonParser
{
    private int _index;
    private readonly string _json;

    public JsonParser(string json)
    {
        _json = json;
        _index = 0;
    }

    public object Parse() { return ParseValue(); }

    private void SkipWhitespace()
    {
        while (_index < _json.Length && char.IsWhiteSpace(_json[_index]))
        {
            _index++;
        }
    }

    private object ParseValue()
    {
        SkipWhitespace();
        
        if (_index >= _json.Length) return null;
        
        var c = _json[_index];
        
        if (c == 'n')
        {
            _index += 4;
            return null;
        }
        
        if (c == 't')
        {
            _index += 4;
            return true;
        }
        
        if (c == 'f')
        {
            _index += 5;
            return false;
        }
        
        if (c == '"')
        {
            return ParseString();
        }
        
        if (c == '{')
        {
            return ParseObject();
        }
        
        if (c == '[')
        {
            return ParseArray();
        }
        
        if (c == '-' || char.IsDigit(c))
        {
            return ParseNumber();
        }
        
        return null;
    }

    private string ParseString()
    {
        _index++;
        var start = _index;
        var result = new StringBuilder();
        
        while (_index < _json.Length && _json[_index] != '"')
        {
            if (_json[_index] == '\\')
            {
                result.Append(_json.Substring(start, _index - start));
                _index++;
                if (_index < _json.Length)
                {
                    var escaped = _json[_index];
                    switch (escaped)
                    {
                        case '"': result.Append('"'); break;
                        case '\\': result.Append('\\'); break;
                        case 'n': result.Append('\n'); break;
                        case 'r': result.Append('\r'); break;
                        case 't': result.Append('\t'); break;
                        default: result.Append(escaped); break;
                    }
                    _index++;
                    start = _index;
                }
            }
            else
            {
                _index++;
            }
        }
        
        result.Append(_json.Substring(start, _index - start));
        _index++;
        
        return result.ToString();
    }

    private object ParseNumber()
    {
        var start = _index;
        
        if (_json[_index] == '-') _index++;
        
        while (_index < _json.Length && char.IsDigit(_json[_index]))
        {
            _index++;
        }
        
        var isDouble = false;
        if (_index < _json.Length && _json[_index] == '.')
        {
            isDouble = true;
            _index++;
            while (_index < _json.Length && char.IsDigit(_json[_index]))
            {
                _index++;
            }
        }
        
        if (_index < _json.Length && (_json[_index] == 'e' || _json[_index] == 'E'))
        {
            isDouble = true;
            _index++;
            if (_index < _json.Length && (_json[_index] == '+' || _json[_index] == '-'))
            {
                _index++;
            }
            while (_index < _json.Length && char.IsDigit(_json[_index]))
            {
                _index++;
            }
        }
        
        var numStr = _json.Substring(start, _index - start);
        
        if (isDouble)
        {
            return double.Parse(numStr, CultureInfo.InvariantCulture);
        }
        else
        {
            return long.Parse(numStr);
        }
    }

    private Dictionary<string, object> ParseObject()
    {
        var result = new Dictionary<string, object>();
        _index++;
        
        SkipWhitespace();
        
        if (_index < _json.Length && _json[_index] == '}')
        {
            _index++;
            return result;
        }
        
        while (_index < _json.Length)
        {
            SkipWhitespace();
            
            var key = ParseString();
            
            SkipWhitespace();
            _index++;
            
            var value = ParseValue();
            
            result[key] = value;
            
            SkipWhitespace();
            
            if (_index < _json.Length && _json[_index] == '}')
            {
                _index++;
                break;
            }
            
            if (_index < _json.Length && _json[_index] == ',')
            {
                _index++;
            }
        }
        
        return result;
    }

    private List<object> ParseArray()
    {
        var result = new List<object>();
        _index++;
        
        SkipWhitespace();
        
        if (_index < _json.Length && _json[_index] == ']')
        {
            _index++;
            return result;
        }
        
        while (_index < _json.Length)
        {
            var value = ParseValue();
            result.Add(value);
            
            SkipWhitespace();
            
            if (_index < _json.Length && _json[_index] == ']')
            {
                _index++;
                break;
            }
            
            if (_index < _json.Length && _json[_index] == ',')
            {
                _index++;
            }
        }
        
        return result;
    }
}