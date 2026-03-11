# Coupling Analysis: node-with-window ↔ node-ps1-dotnet

This document analyses the structural coupling between `node-with-window` (the cross-platform windowing library) and `node-ps1-dotnet` (the Windows .NET bridge). It identifies where the layering breaks down, what principles are violated, and what the architectural consequences are.

---

## Background

`node-ps1-dotnet` is meant to be a **general-purpose Node.js ↔ .NET interop layer**: spawn a PowerShell/C# host, call .NET methods reflectively over a pipe. `node-with-window`'s Windows backend (`src/backend/netfx-wpf/`) is supposed to be a consumer that builds WPF+WebView2 windows on top of it.

In practice the boundary between the two is severely eroded. Platform-specific concerns (WPF message loops, WebView2 race conditions, polling mechanics) have leaked into the bridge layer, and the bridge layer has grown fingers that reach back into the consumer.

---

## Coupling Inventory

### 1. `startApplication` — WPF lifecycle embedded in the bridge

**Where:** `window.ts:349`, `index.ts:218–226`, `Reflection.cs:766–866`

`window.ts` calls `(dotnet as any).startApplication(this.app, this.browserWindow)`. The word "any" signals the problem. This is not a .NET method call; it is a special hard-coded action in the bridge that:

- Sets `BridgeState.UseQueueMode = true` globally, changing the behaviour of every subsequent event handler
- Pre-sends an `{type:'ok'}` response *before* blocking, because `Application.Run()` never returns
- Calls the WPF `Application.Run()` message pump, blocking the .NET thread indefinitely
- Installs the WPF `DispatcherSynchronizationContext` into `PsHost.MainSyncContext`
- Calls `Environment.Exit(0)` when the window closes

None of this belongs in a general-purpose .NET bridge. It is the WPF application lifecycle. The `__skipResponse` sentinel (see §7) exists only because of this action.

**Violated principle:** Single Responsibility Principle. `Reflection.cs` handles both generic .NET reflection *and* WPF application lifecycle management.

---

### 2. `Poll` / `pollEvent` — polling queue exposed as bridge primitive

**Where:** `window.ts:352–402`, `index.ts:229–256`, `Reflection.cs:693–705`, `BridgeState.cs:17`

Node-with-window sets a 16 ms `setInterval` that calls `(dotnet as any).pollEvent()`. This drains `BridgeState.EventQueue`, a C# `ConcurrentQueue<string>` that event handlers enqueue to when `UseQueueMode` is true.

The entire polling mechanism — queue, drain loop, 16 ms cadence, `{type:'ipc', message}` wire format — is specific to the Windows polling architecture. The Linux GJS backend uses GObject signals and never polls. Yet the queue and the `Poll` action live inside the generic bridge.

`pollEvent()` also has an unusual return type (boolean "any events processed?") that has no meaning in the normal .NET reflection API, making it a **conceptually foreign member** of the proxy.

**Violated principle:** Open/Closed Principle. Adding a new event-driven backend requires understanding and working around the Windows-specific queueing infrastructure already baked into the bridge.

---

### 3. `AddScriptAndNavigate` — a race-condition fix masquerading as an API

**Where:** `window.ts:227–234`, `index.ts:211–215`, `Reflection.cs:711–764`

`setupIpcBridge()` in `window.ts` calls `(dotnet as any).addScriptAndNavigate(coreWebView2, script, url)`. This is not a .NET method; it is a bespoke bridge action that:

1. Calls `CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(script)` (returns a `Task<string>`)
2. Attaches a `Task.ContinueWith` continuation that posts `Navigate(url)` to the WPF UI thread once the ack arrives

The action exists because in polling mode `Task.Wait()` on the WPF UI thread deadlocks, so the Task cannot be awaited inline. This is a correct and necessary fix — but it conflates a **WebView2-specific synchronisation concern** with the bridge's general reflection logic.

`Reflection.cs` now knows about `AddScriptToExecuteOnDocumentCreatedAsync`, `Navigate`, and `PsHost.MainSyncContext`. None of those are generic .NET concepts.

**Violated principle:** Separation of Concerns. A workaround for a race condition in one UI framework lives in the generic .NET reflector.

---

### 4. `__ref` access — consuming a proxy internal

**Where:** `index.ts:214, 221`, `proxy.ts:154`

`addScriptAndNavigate` and `startApplication` both extract `coreWebView2.__ref`, `app.__ref`, `window.__ref` to obtain the object IDs used inside the bridge. `__ref` is a hidden getter added by `proxy.ts` on every proxy object, prefixed with underscores to signal it is private.

Consuming code in `index.ts` (within the same package) reads `__ref` directly rather than going through a typed accessor. Outside callers such as a future backend could not rely on this being stable.

**Violated principle:** Encapsulation / Law of Demeter. Implementation details of the proxy layer leak to consumers as an undocumented contract.

---

### 5. `pollingMode` global flag — invisible temporal coupling

**Where:** `proxy.ts:28–29`, `index.ts:226`, `Reflection.cs:769`

Calling `startApplication` has a side effect that is invisible at the call site: it sets `pollingMode = true` in `proxy.ts`. After this point, `createProxy()` **silently returns `null`** for any `Task` object instead of awaiting it (to avoid UI-thread deadlock).

There is a parallel flag `BridgeState.UseQueueMode` on the C# side, set by the same `startApplication` action.

The two packages must stay synchronised on this global state. If either sets it independently or at the wrong time, Task handling fails silently. No type signature expresses this contract.

**Violated principle:** Cohesion. Related state (what happens to Tasks after the WPF loop starts) is spread across two modules in two packages.

---

### 6. `ProcessNestedCommands` callback — hidden dependency

**Where:** `PsHost.cs:13`, `Reflection.cs:163, 185, 231`

`PsHost.ProcessNestedCommands` is a static `Func<object>` that event handlers call in *non-polling* mode after writing an event to the pipe. It is set by the PowerShell host. node-with-window never sets it directly, but it relies on the execution path that uses it when operating before `startApplication` is called.

This is an invisible dependency: window.ts assumes the callback was wired up by the hosting infrastructure, with no way to verify it at compile time or at the call site.

**Violated principle:** Dependency Inversion Principle. High-level consumer code depends on a low-level initialisation detail that happens somewhere else.

---

### 7. `__skipResponse` sentinel — implicit dispatcher protocol

**Where:** `Reflection.cs:861`, `PsHost.cs:64–66`

`StartApplication` returns `{ "__skipResponse": true }` to tell the command dispatcher in `PsHost.ExecuteCommand` to skip writing a second response. This exists because `startApplication` pre-sends `{type:'ok'}` before calling `Application.Run()` (which never returns).

The sentinel is a magic string that couples `StartApplication`'s unusual semantics to the generic dispatch loop. A developer reading `ExecuteCommand` for the first time has no way to know why this check exists without tracing back to `StartApplication`.

**Violated principle:** Explicit over implicit. The protocol for handling `StartApplication`'s dual-response behaviour is hidden in a string literal rather than expressed structurally.

---

### 8. `MainSyncContext` — WPF thread management in the reflector

**Where:** `Reflection.cs:821–840`, `PsHost.cs:17`

`StartApplication` loads `WindowsBase.dll` by name, extracts the WPF `Dispatcher`, and creates a `DispatcherSynchronizationContext` stored in `PsHost.MainSyncContext`. This context is later used by `AddScriptAndNavigate` (§3) to marshal calls to the UI thread.

This is deep WPF runtime introspection. It only works because WPF is present. It would silently produce `null` in any other .NET environment, causing `AddScriptAndNavigate` to drop the `Navigate` call.

**Violated principle:** Separation of Concerns. Platform-specific thread synchronisation setup lives inside the generic command executor.

---

## Summary Table

| Coupling point | Files | Severity | Violated principle |
|---|---|---|---|
| `startApplication` action | `window.ts`, `Reflection.cs` | Critical | SRP — WPF lifecycle in bridge |
| `Poll` / `pollEvent` | `window.ts`, `index.ts`, `Reflection.cs` | Critical | OCP — polling queue in bridge |
| `AddScriptAndNavigate` | `window.ts`, `index.ts`, `Reflection.cs` | High | SoC — WebView2 race fix in bridge |
| `__ref` access | `index.ts`, `proxy.ts` | Medium | Encapsulation — private detail used directly |
| `pollingMode` global flag | `proxy.ts`, `index.ts`, `Reflection.cs` | High | Cohesion — state split across packages |
| `ProcessNestedCommands` callback | `PsHost.cs`, `Reflection.cs` | Medium | DIP — hidden host dependency |
| `__skipResponse` sentinel | `Reflection.cs`, `PsHost.cs` | Medium | Explicit over implicit |
| `MainSyncContext` setup | `Reflection.cs`, `PsHost.cs` | High | SoC — WPF thread management in reflector |

---

## What belongs where

**Should stay in `node-ps1-dotnet`:**
- Generic reflection: `Invoke`, `New`, `GetType`, `AddEvent`, `LoadFrom`, `Release`, `AwaitTask`
- Pipe transport: `IpcSync`, `PsHost.StartServer`, `BridgeState` (reduced to transport-only state)
- Object store: `BridgeState.ObjectStore`

**Should move to `node-with-window`'s Windows backend:**
- WPF application lifecycle (`StartApplication`, `Application.Run`, `Environment.Exit`)
- WebView2 script-and-navigate atomicity (`AddScriptAndNavigate`, `Task.ContinueWith`)
- WPF `DispatcherSynchronizationContext` setup (`MainSyncContext`)
- Event polling queue (`EventQueue`, `UseQueueMode`, `Poll`)

**Should be formalised into a typed interface:**
- The implicit protocol between `window.ts` and `index.ts` (polling mode, event format, `__ref` access) should be expressed as TypeScript interfaces, not `as any` casts and underscore-prefixed internals.

---

## Architectural consequences

The current coupling has the following practical consequences:

1. **Cannot replace the bridge.** A drop-in replacement for `node-ps1-dotnet` would require reimplementing the WPF-specific actions and the exact event wire format, because `window.ts` calls them by name.

2. **Cannot add a second Windows backend.** If a future backend used a different .NET hosting model (e.g. Native AOT), all the WPF-specific code in `Reflection.cs` would still be compiled in.

3. **Cannot test `window.ts` in isolation.** Every `(dotnet as any).` call is a hidden call into `node-ps1-dotnet` with no interface to mock.

4. **Changes require cross-package coordination.** Adding a new event type requires changes to `Reflection.cs` (C#), `BridgeState` (C#), `index.ts` (TypeScript), and `window.ts` (TypeScript). None of these changes is type-checked against the others.

5. **Silent failures.** `pollingMode`, `UseQueueMode`, `MainSyncContext`, and `ProcessNestedCommands` are all global state that must be set in the right order. Errors manifest as silently dropped events or null returns, not exceptions.
