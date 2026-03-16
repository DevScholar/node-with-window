# Electron API Compatibility — `netfx-wpf` Backend

**Platform:** Windows
**Stack:** WPF (Windows Presentation Foundation) + WebView2 (Chromium-based)
**Bridge:** Self-contained — `scripts/backend/netfx-wpf/WinHost.ps1` compiles the C# bridge via PowerShell `Add-Type` and communicates over a Named Pipe; Node.js polls for events at 16 ms intervals.

---

## `app`

| API | Status | Notes |
|---|---|---|
| `app.whenReady()` | ✅ | |
| `app.isReady()` | ✅ | |
| `app.getName()` | ✅ | Reads `name` from `package.json` |
| `app.getVersion()` | ✅ | Reads `version` from `package.json` |
| `app.getPath(name)` | ✅ | `home`, `temp`, `desktop`, `downloads`, `documents`, `music`, `pictures`, `videos`, `appData`, `userData`, `logs`, `exe`, `module` |
| `app.quit()` | ✅ | Emits `before-quit`, then `process.exit(0)` |
| Event: `ready` | ✅ | |
| Event: `before-quit` | ✅ | |
| Event: `window-all-closed` | ✅ | |
| `app.exit()` | ✅ | `process.exit(exitCode)`; relaunches first if `relaunch()` was called |
| `app.relaunch([options])` | ✅ | Spawns a new process on next `quit()`/`exit()`; accepts `execPath` and `args` |
| `app.focus()` | ✅ | Focuses the first open BrowserWindow |
| `app.setName(name)` | ✅ | Overrides the value returned by `getName()` |
| `app.setPath(name, path)` | ✅ | Overrides a named path returned by `getPath()` |
| `app.getLocale()` | ✅ | Returns `Intl.DateTimeFormat().resolvedOptions().locale` |
| `app.requestSingleInstanceLock()` | ✅ | PID-file based; returns `true` for first instance, `false` if another is alive |
| Event: `second-instance` | ⚠️ | Lock detection works, but cross-process notification requires manual IPC |
| `app.dock` | ❌ | macOS only |
| Event: `activate` | ❌ | macOS only |

---

## `BrowserWindow`

### Constructor

`new BrowserWindow(options)` is synchronous, matching Electron. Window creation (WPF + WebView2 init) runs asynchronously in the background; `show()` fires via `setImmediate` once the window is ready (unless `show: false`).

### Constructor Options

| Option | Status | Notes |
|---|---|---|
| `width`, `height` | ✅ | Default: 800×600 |
| `minWidth`, `minHeight` | ✅ | WPF `MinWidth`/`MinHeight` |
| `maxWidth`, `maxHeight` | ✅ | WPF `MaxWidth`/`MaxHeight` |
| `title` | ✅ | Also auto-synced from `document.title` |
| `icon` | ✅ | Absolute or relative path; PNG/JPG; best-effort |
| `resizable` | ✅ | WPF `ResizeMode.NoResize` when `false` |
| `show` | ✅ | Pass `false` to prevent auto-show |
| `x`, `y` | ✅ | Sets `WindowStartupLocation.Manual` + `Left`/`Top` |
| `alwaysOnTop` | ✅ | WPF `Topmost` |
| `webPreferences` | ✅ | See WebPreferences section |
| `movable` | ✅ | `HwndSource` `WM_NCHITTEST` hook blocks title-bar drag when `false` |
| `minimizable`, `maximizable` | ✅ | `GetWindowLong`/`SetWindowLong` WS_MINIMIZEBOX / WS_MAXIMIZEBOX |
| `closable` | ✅ | `EnableMenuItem` on the system menu's `SC_CLOSE` item |
| `transparent` | ✅ | `WindowStyle.None` + `AllowsTransparency = false` + `Background = Transparent` + `WindowChrome(GlassFrameThickness = -1)` + `ResizeMode = NoResize`; WebView2 background alpha set to 0. Uses the hardware DX renderer path (not WS_EX_LAYERED) so WebView2 receives mouse clicks correctly. |
| `frame` | ✅ | `WindowStyle.None` — removes title bar and border |
| `backgroundColor` | ✅ | WebView2 `DefaultBackgroundColor` via `System.Drawing.Color.FromArgb`; accepts `#RGB`, `#RRGGBB`, `#AARRGGBB` |
| `kiosk` | ✅ | `setFullScreen(true)` + `setSkipTaskbar(true)`; exit restores previous state |
| `skipTaskbar` | ✅ | `SetWindowLong` WS_EX_TOOLWINDOW / WS_EX_APPWINDOW on extended style |
| `fullscreen` | ✅ | Applied at window creation via `setFullScreen(true)` |
| `parent`, `modal` | ✅ | `parent` sets WPF `WindowInteropHelper.Owner`; `modal` disables the parent window until the child closes |
| `titleBarStyle` | ✅ | `'hidden'`/`'hiddenInset'`: `WindowStyle.None` + `WindowChrome(GlassFrameThickness = 0, ResizeBorderThickness = 4, CaptionHeight = 0)`; title bar removed, 4 px resize border kept. `'default'`: standard title bar (no-op). |

### `webPreferences`

| Option | Status | Notes |
|---|---|---|
| `nodeIntegration` | ✅ | Enables `window.require` (sync XHR) and `window.process` |
| `contextIsolation` | ✅ | `false` (default) injects `window.ipcRenderer` |
| `partition` | ✅ | `persist:<name>` for persistent profile, `temp:` for ephemeral |
| `preload` | ✅ | Supported via `webPreferences.preload` |
| `sandbox` | ⚠️ | Accepted, no effect |
| `webSecurity` | ✅ | `false` passes `--disable-web-security` to WebView2 (disables CORS/same-origin) |

### Static Methods

| API | Status | Notes |
|---|---|---|
| `new BrowserWindow(options)` | ✅ | Electron-compatible synchronous constructor |
| `BrowserWindow.getAllWindows()` | ✅ | |
| `BrowserWindow.getFocusedWindow()` | ✅ | Returns first open window |
| `BrowserWindow.fromId(id)` | ✅ | Looks up by internal window ID |
| `BrowserWindow.fromWebContents(wc)` | ✅ | Finds the owning BrowserWindow |

### Instance Methods

| API | Status | Notes |
|---|---|---|
| `win.loadURL(url)` | ✅ | Queued until WebView2 is ready |
| `win.loadFile(path)` | ✅ | HTML read from disk; importmap injected into `<head>` (when `nodeIntegration` is on); passed to WebView2 via `NavigateToString` |
| `win.show()` | ✅ | Starts WPF `Application.Run()`; subsequent calls call `Window.Show()` |
| `win.close()` | ✅ | Calls `Window.Close()`, stops poll timer, cleans up user-data dir; process exit is managed by the BrowserWindow close-event chain |
| `win.destroy()` | ✅ | Alias for `close()` |
| `win.focus()` | ✅ | `Window.Activate()` |
| `win.blur()` | ✅ | No-op — WPF has no programmatic blur API |
| `win.minimize()` | ✅ | `WindowState.Minimized` |
| `win.maximize()` | ✅ | `WindowState.Maximized` |
| `win.unmaximize()` / `win.restore()` | ✅ | `WindowState.Normal` |
| `win.setFullScreen(flag)` | ✅ | `WindowStyle.None` + `Maximized` + `Topmost` |
| `win.isFullScreen()` | ✅ | Tracked in JS (`_isFullScreen` flag) |
| `win.setTitle(title)` | ✅ | `Window.Title` |
| `win.getTitle()` | ✅ | Reads `Window.Title` |
| `win.setSize(w, h)` | ✅ | `Window.Width` / `Window.Height` |
| `win.getSize()` | ✅ | Reads `Window.ActualWidth` / `ActualHeight`, rounded |
| `win.setPosition(x, y)` | ✅ | `Window.Left` / `Window.Top` |
| `win.getPosition()` | ✅ | Reads `Window.Left` / `Window.Top`, rounded |
| `win.setOpacity(opacity)` | ✅ | `Window.Opacity` (0.0–1.0) |
| `win.getOpacity()` | ✅ | Reads `Window.Opacity` |
| `win.setResizable(flag)` | ✅ | `ResizeMode.CanResize` / `NoResize` |
| `win.isResizable()` | ✅ | Tracked in JS (`_isResizable` flag) |
| `win.setMinimizable(flag)` | ✅ | `SetWindowLong` WS_MINIMIZEBOX |
| `win.isMinimizable()` | ✅ | Tracked in JS |
| `win.setMaximizable(flag)` | ✅ | `SetWindowLong` WS_MAXIMIZEBOX |
| `win.isMaximizable()` | ✅ | Tracked in JS |
| `win.setClosable(flag)` | ✅ | `EnableMenuItem` SC_CLOSE on system menu |
| `win.isClosable()` | ✅ | Tracked in JS |
| `win.setMovable(flag)` | ✅ | `HwndSource` hook intercepts `WM_SYSCOMMAND SC_MOVE` |
| `win.isMovable()` | ✅ | Tracked in JS |
| `win.setSkipTaskbar(flag)` | ✅ | `SetWindowLong` WS_EX_TOOLWINDOW / WS_EX_APPWINDOW |
| `win.setAlwaysOnTop(flag)` | ✅ | `Window.Topmost` |
| `win.center()` | ✅ | Computes from `SystemParameters.PrimaryScreenWidth/Height` |
| `win.flashFrame(flag)` | ✅ | `FlashWindowEx` (user32) — flashes taskbar button until window is focused |
| `win.setBackgroundColor(color)` | ✅ | WebView2 `DefaultBackgroundColor`; same format as `backgroundColor` constructor option |
| `win.setMenu(menu)` | ✅ | Accepts `Menu` instance or `MenuItemOptions[]` |
| `win.removeMenu()` | ✅ | Clears the menu bar |
| `win.showOpenDialog(options)` | ✅ | Synchronous; returns `string[] \| undefined` |
| `win.showSaveDialog(options)` | ✅ | Synchronous; returns `string \| undefined` |
| `win.showMessageBox(options)` | ✅ | Synchronous; returns button index |
| `win.capturePage()` | ✅ | Returns `Promise<NativeImage>`; uses `CoreWebView2.CapturePreviewAsync(Png)` |

### `win.webContents`

| API | Status | Notes |
|---|---|---|
| `win.webContents.send(channel, ...args)` | ✅ | `CoreWebView2.PostWebMessageAsString` |
| `win.webContents.openDevTools()` | ✅ | `CoreWebView2.OpenDevToolsWindow()` |
| `win.webContents.reload()` | ✅ | `CoreWebView2.Reload()` |
| `win.webContents.loadURL(url)` | ✅ | |
| `win.webContents.loadFile(path)` | ✅ | |
| `win.webContents.executeJavaScript(code)` | ✅ | Evaluates in renderer; returns `Promise`; supports async expressions |
| `win.webContents.session` | ✅ | `clearCache()` clears Cache API entries; `clearStorageData()` clears localStorage/sessionStorage/indexedDB |
| `win.webContents.on('did-finish-load')` | ✅ | Emitted on `CoreWebView2.NavigationCompleted` |

---

## `ipcMain`

| API | Status | Notes |
|---|---|---|
| `ipcMain.handle(channel, listener)` | ✅ | Sync and async handlers both supported |
| `ipcMain.handleOnce(channel, listener)` | ✅ | |
| `ipcMain.removeHandler(channel)` | ✅ | |
| `ipcMain.on(channel, listener)` | ✅ | |
| `ipcMain.once(channel, listener)` | ✅ | |
| `event.returnValue` (sync IPC) | ✅ | Set in `ipcMain.on()` handler; returned to `sendSync()` caller |
| `event.reply(channel, ...args)` | ✅ | |

---

## `ipcRenderer` (injected when `contextIsolation: false`)

| API | Status | Notes |
|---|---|---|
| `ipcRenderer.send(channel, ...args)` | ✅ | `chrome.webview.postMessage` |
| `ipcRenderer.invoke(channel, ...args)` | ✅ | Returns `Promise` |
| `ipcRenderer.on(channel, listener)` | ✅ | |
| `ipcRenderer.once(channel, listener)` | ✅ | |
| `ipcRenderer.off(channel, listener)` | ✅ | |
| `ipcRenderer.removeListener(channel, listener)` | ✅ | Alias for `off()` |
| `ipcRenderer.sendSync()` | ✅ | Sync XHR to loopback; handler must be synchronous |

---

## `dialog`

| API | Status | Notes |
|---|---|---|
| `dialog.showOpenDialog([win,] options)` | ✅ | Returns `{ canceled, filePaths }` |
| `dialog.showSaveDialog([win,] options)` | ✅ | Returns `{ canceled, filePath }` |
| `dialog.showMessageBox([win,] options)` | ✅ | Returns `{ response }` |
| `dialog.showErrorBox(title, content)` | ✅ | |

---

## `shell`

| API | Status | Notes |
|---|---|---|
| `shell.openExternal(url)` | ✅ | |
| `shell.openPath(filePath)` | ✅ | |
| `shell.showItemInFolder(filePath)` | ✅ | |
| `shell.beep()` | ✅ | Writes `\x07` to stdout |
| `shell.trashItem(path)` | ✅ | `SHFileOperation` (shell32) with `FOF_ALLOWUNDO` — sends to Recycle Bin |

---

## `Menu` / `MenuItem`

| API | Status | Notes |
|---|---|---|
| `Menu.buildFromTemplate(template)` | ✅ | |
| `new Menu()` / `menu.append()` / `menu.insert()` | ✅ | |
| `Menu.setApplicationMenu(menu)` | ✅ | Sets the default menu for all windows; `null` removes the menu bar |
| `menu.popup()` | ❌ | Context menus not implemented |
| `label`, `type`, `click`, `submenu`, `enabled`, `visible`, `checked`, `accelerator`, `role` | ✅ | `accelerator` is displayed; keyboard shortcuts are not enforced natively |
| `id`, `icon`, `sublabel`, `toolTip` | ❌ | |

---

## Node.js Integration in Renderer (`nodeIntegration: true`)

`window.require` is fully synchronous, matching Electron's `nodeIntegration: true` behaviour.

| Feature | Status | Notes |
|---|---|---|
| `window.require('fs')` | ✅ | Sync XHR to local HTTP server (`127.0.0.1:<port>`) |
| `window.require('path')` | ✅ | Same |
| `window.require('os')` | ✅ | Same |
| `window.require('child_process')` | ✅ | Same |
| Any built-in or `npm` module | ✅ | `createRequire(import.meta.url)` on the Node.js side |
| Callback arguments (e.g. `fs.readFile(path, cb)`) | ✅ | Serialized as `{__nww_cb: id}`; fired via SSE |
| Multi-fire callbacks (e.g. `fs.watch`, `EventEmitter.on`) | ✅ | Same SSE mechanism |
| Non-serializable return values (Buffer, FSWatcher, Stream, …) | ✅ | Stored in ref registry; renderer gets a Proxy |
| `window.process.platform` | ✅ | `'win32'` |
| `window.process.arch` | ✅ | Reflects actual `process.arch` from the main process |
| `window.process.version` | ✅ | Injected from main process |
| `window.process.env` | ✅ | Snapshot of `process.env` from the main process at window creation time |
| `window.process.cwd()` | ✅ | Injected from main process |
| `window.process.exit(code)` | ✅ | Sends IPC to main process |
| `import { x } from 'fs'` | ✅ | Standard static ESM import; works with both `loadFile()` and `loadURL()` |

### How `window.require` works

```js
// Identical to Electron nodeIntegration: true
const fs = window.require('fs');
const data = fs.readFileSync('/path/to/file', 'utf-8');   // synchronous
fs.readFile('/path/to/file', 'utf-8', (err, data) => {}); // callbacks via SSE
const buf = fs.readFileSync('/path/to/file');               // Buffer → Proxy via ref registry
```

`window.require(module).method(...args)` issues a synchronous `XMLHttpRequest` to a loopback HTTP server started in the main process. Chromium's network stack runs on a background thread, so the renderer JS thread can block without deadlocking Node.js. Callbacks are delivered via a persistent `EventSource` (`/__nww_events__`); Chromium queues SSE events while XHR is in flight and dispatches them once the JS thread unblocks.

### Static `import` support (ESM)

With `nodeIntegration: true`, standard static ES module import syntax works for all Node.js built-in modules:

```js
// <script type="module"> — no special API, fully standard syntax
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { platform } from 'node:os';     // node: prefix also works
import { readFile } from 'fs/promises'; // sub-path variants too

const data = readFileSync('/path/to/file', 'utf-8');
```

**How it works:**

The bridge registers two complementary mechanisms so imports work regardless of how the page is loaded:

| Loaded via | Mechanism |
|---|---|
| `loadFile()` | `<script type="importmap">` injected into the HTML source before WebView2 receives it |
| `loadURL()` | `MutationObserver` in the bridge script detects when `<head>` is created and injects the importmap before any module script is parsed |

Both mechanisms map every Node.js built-in name (and its `node:` alias) to `http://127.0.0.1:<port>/__nww_esm__/<module>`. That endpoint returns an ES module whose named exports delegate to `window.require()`. The underlying sync-XHR mechanism is unchanged — `import` is purely a syntax layer on top.

---

## Key Differences from Electron

1. **Preload scripts** are supported. Set `webPreferences.preload` to an absolute or relative path. The script is appended to the bridge code registered with `CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync`, so it runs on every navigation before the page's own scripts.

2. **`ipcMain.on()`** registers fire-and-forget listeners for `ipcRenderer.send()` and `ipcRenderer.sendSync()` calls.

3. **`win.blur()` is a no-op.** WPF has no direct API to remove focus from a window programmatically.

4. **`win.flashFrame()` flashes the taskbar button** using `FlashWindowEx` (user32). Calling with `true` flashes until the window receives focus; `false` stops flashing immediately.

5. **`setFullScreen()` does not use an exclusive fullscreen mode.** It sets `WindowStyle.None` + `WindowState.Maximized` + `Topmost = true`. The WPF window frame is hidden but the taskbar may remain visible depending on system settings.

6. **`webSecurity: false`** passes `--disable-web-security` to the WebView2 browser process via `CoreWebView2CreationProperties.AdditionalBrowserArguments`. Requires WebView2 SDK ≥ 1.0.1661.

7. **`transparent: true` requires no host-page CSS.** The WPF window uses `AllowsTransparency = false` (hardware DX renderer) combined with `WindowChrome(GlassFrameThickness = -1)` to extend DWM glass over the entire client area, and WPF `Background` is set to `Transparent`. WebView2's background alpha is also set to 0. This approach avoids the WS_EX_LAYERED path so mouse clicks reach WebView2 on fully transparent pixels. `frame: false` is implied (`WindowStyle.None` is required for WindowChrome transparency).
