# Electron API Compatibility — `netfx-wpf` Backend

**Platform:** Windows
**Stack:** WPF (Windows Presentation Foundation) + WebView2 (Chromium-based)
**Bridge:** `@devscholar/node-ps1-dotnet` — PowerShell/C# bridge compiled via `Add-Type`; Node.js polls for queued .NET events at 16 ms intervals.

---

## `app`

| API | Status | Notes |
|---|---|---|
| `app.whenReady()` | ✅ | |
| `app.isReady()` | ✅ | |
| `app.getName()` | ✅ | Reads `name` from `package.json` |
| `app.getVersion()` | ✅ | Reads `version` from `package.json` |
| `app.getPath(name)` | ✅ | `home`, `temp`, `desktop`, `downloads`, `documents`, `music`, `pictures`, `videos`, `appData`, `userData`, `logs`, `exe`, `module` |
| `app.setPath(name, path)` | ✅ | Overrides a named path returned by `getPath()` |
| `app.quit()` | ✅ | Emits `before-quit`, then `will-quit`, then `process.exit(0)` |
| `app.exit(exitCode?)` | ✅ | `process.exit(exitCode)`; relaunches first if `relaunch()` was called |
| `app.relaunch([options])` | ✅ | Spawns new process on next `quit()`/`exit()`; accepts `execPath` and `args` |
| `app.focus()` | ✅ | Calls `focus()` on the first open BrowserWindow |
| `app.setName(name)` | ✅ | Overrides the value returned by `getName()` |
| `app.getLocale()` | ✅ | Returns `Intl.DateTimeFormat().resolvedOptions().locale` |
| `app.requestSingleInstanceLock()` | ✅ | PID-file based; returns `true` for first instance, `false` if another is alive |
| `app.isReady()` | ✅ | |
| Event: `ready` | ✅ | Also fires immediately (via `setImmediate`) when `on('ready')` is called after the app is already ready |
| Event: `before-quit` | ✅ | |
| Event: `will-quit` | ✅ | Emitted just before `process.exit(0)`, after `before-quit` |
| Event: `window-all-closed` | ✅ | Process exits with code 0 if no listener is registered |
| Event: `second-instance` | ❌ | `requestSingleInstanceLock()` detects existing instances but does not notify them |
| Event: `activate` | ❌ | macOS only |
| Event: `browser-window-created` | ✅ | Emitted with the new `BrowserWindow` instance after backend initialization |
| Event: `browser-window-focus` / `browser-window-blur` | ❌ | Not emitted |
| Event: `web-contents-created` | ❌ | Not emitted |
| `app.dock` | ❌ | macOS only |
| `app.setAppUserModelId()` | ❌ | Not implemented |
| `app.isPackaged` | ❌ | Not implemented |
| `app.commandLine.*` | ❌ | Not implemented |

---

## `BrowserWindow`

### Constructor

`new BrowserWindow(options)` is synchronous, matching Electron. Backend initialization (WPF + WebView2) runs asynchronously; `show()` fires via `setImmediate` once ready (unless `show: false`).

### Constructor Options

| Option | Status | Notes |
|---|---|---|
| `width`, `height` | ✅ | Default: 800×600 |
| `x`, `y` | ✅ | Sets `WindowStartupLocation.Manual` + `Left`/`Top` |
| `minWidth`, `minHeight` | ✅ | WPF `MinWidth`/`MinHeight` |
| `maxWidth`, `maxHeight` | ✅ | WPF `MaxWidth`/`MaxHeight` |
| `title` | ✅ | Also auto-synced from `document.title` |
| `icon` | ✅ | Absolute or relative path; ICO/PNG/JPG; best-effort |
| `resizable` | ✅ | WPF `ResizeMode.NoResize` when `false` |
| `movable` | ✅ | `WM_NCHITTEST` hook blocks title-bar drag when `false` |
| `minimizable` | ✅ | `GetWindowLong`/`SetWindowLong` `WS_MINIMIZEBOX` |
| `maximizable` | ✅ | `GetWindowLong`/`SetWindowLong` `WS_MAXIMIZEBOX` |
| `closable` | ✅ | `EnableMenuItem` `SC_CLOSE` on system menu |
| `show` | ✅ | Pass `false` to prevent auto-show |
| `alwaysOnTop` | ✅ | WPF `Topmost` |
| `frame` | ✅ | `WindowStyle.None` — removes title bar and border |
| `titleBarStyle` | ✅ | `'hidden'`/`'hiddenInset'`: `WindowStyle.None` + `WindowChrome(ResizeBorderThickness=4, CaptionHeight=0)`; 4 px resize border kept. `'default'`: standard title bar (no-op). |
| `transparent` | ✅ | `WindowStyle.None` + `AllowsTransparency=false` + `Background=Transparent` + `WindowChrome(GlassFrameThickness=-1)` + WebView2 alpha=0. Hardware DX renderer path — mouse clicks reach WebView2 on fully transparent pixels. |
| `backgroundColor` | ✅ | WebView2 `DefaultBackgroundColor`; accepts `#RGB`, `#RRGGBB`, `#AARRGGBB` |
| `fullscreen` | ✅ | Applied at creation via `setFullScreen(true)` |
| `kiosk` | ✅ | `setFullScreen(true)` + `setSkipTaskbar(true)` |
| `skipTaskbar` | ✅ | `SetWindowLong` `WS_EX_TOOLWINDOW`/`WS_EX_APPWINDOW` |
| `parent`, `modal` | ✅ | `parent` sets WPF `WindowInteropHelper.Owner`; `modal` disables the parent until the child closes |
| `webPreferences` | ✅ | See WebPreferences section |
| `autoHideMenuBar` | ✅ | Menu bar hidden initially (`Visibility.Collapsed`); bare Alt key (`Key.System` + `SystemKey LeftAlt/RightAlt`) toggles visibility via `add_PreviewKeyDown` |
| `hasShadow` | ❌ | Not implemented |
| `center` (as option) | ❌ | Use `win.center()` after creation |

### `webPreferences`

| Option | Status | Notes |
|---|---|---|
| `nodeIntegration` | ✅ | Enables `window.require` (sync XHR) and `window.process` |
| `contextIsolation` | ⚠️ | When `true` + `preload`: globals `ipcRenderer` and `contextBridge` are deleted from `window` after the preload runs. Not true V8 context isolation — there is no separate JavaScript context. |
| `preload` | ✅ | Script appended to bridge code and registered via `AddScriptToExecuteOnDocumentCreatedAsync` |
| `partition` | ✅ | `persist:<name>` for persistent profile, `temp:` for ephemeral (deleted on window close) |
| `webSecurity` | ✅ | `false` passes `--disable-web-security` to WebView2 |
| `sandbox` | ⚠️ | Accepted, no effect |

### Static Methods

| API | Status | Notes |
|---|---|---|
| `BrowserWindow.getAllWindows()` | ✅ | |
| `BrowserWindow.getFocusedWindow()` | ⚠️ | Returns the window that last received focus via the `focus()` API call. Does **not** track focus gained through user mouse clicks. Falls back to the first open window. |
| `BrowserWindow.fromId(id)` | ✅ | |
| `BrowserWindow.fromWebContents(wc)` | ✅ | |

### Instance Methods

| API | Status | Notes |
|---|---|---|
| `win.loadURL(url)` | ✅ | Queued until WebView2 is ready |
| `win.loadFile(path)` | ✅ | Navigates to `file:///` URI; bridge script registered via `AddScriptToExecuteOnDocumentCreatedAsync` |
| `win.show()` | ✅ | Starts WPF `Application.Run()` (first window); subsequent windows call `Window.Show()` |
| `win.hide()` | ✅ | `Window.Hide()` |
| `win.close()` | ✅ | Calls `Window.Close()`; temp user-data is cleaned up; process exit managed by close-event chain |
| `win.destroy()` | ✅ | Alias for `close()` |
| `win.focus()` | ✅ | `Window.Activate()` |
| `win.blur()` | ⚠️ | No-op — WPF has no programmatic blur API |
| `win.isFocused()` | ✅ | `Window.IsActive` |
| `win.isVisible()` | ✅ | Tracked in JS (`_isVisible` flag) |
| `win.isDestroyed()` | ✅ | Tracked in JS (`isClosed` flag) |
| `win.minimize()` | ✅ | `WindowState.Minimized` |
| `win.maximize()` | ✅ | `WindowState.Maximized` |
| `win.unmaximize()` / `win.restore()` | ✅ | `WindowState.Normal` |
| `win.isMinimized()` | ✅ | Reads `Window.WindowState === Minimized` |
| `win.isMaximized()` | ✅ | Reads `Window.WindowState === Maximized` |
| `win.isNormal()` | ❌ | Not implemented |
| `win.setFullScreen(flag)` | ✅ | `WindowStyle.None` + `Maximized` + `Topmost`; not exclusive fullscreen |
| `win.isFullScreen()` | ✅ | Tracked in JS (`_isFullScreen` flag) |
| `win.setKiosk(flag)` | ✅ | `setFullScreen` + `setSkipTaskbar` |
| `win.isKiosk()` | ✅ | Tracked in JS |
| `win.setTitle(title)` | ✅ | `Window.Title` |
| `win.getTitle()` | ✅ | Reads `Window.Title` |
| `win.setSize(w, h)` | ✅ | `Window.Width`/`Height` |
| `win.getSize()` | ✅ | Reads `Window.ActualWidth`/`ActualHeight`, rounded |
| `win.setPosition(x, y)` | ✅ | `Window.Left`/`Top` |
| `win.getPosition()` | ✅ | Reads `Window.Left`/`Top`, rounded |
| `win.setMinimumSize(w, h)` | ✅ | `Window.MinWidth`/`MinHeight`; queued if called before window creation |
| `win.setMaximumSize(w, h)` | ✅ | `Window.MaxWidth`/`MaxHeight`; queued if called before window creation |
| `win.getMinimumSize()` | ❌ | Not implemented |
| `win.getMaximumSize()` | ❌ | Not implemented |
| `win.setResizable(flag)` | ✅ | `ResizeMode.CanResize`/`NoResize` |
| `win.isResizable()` | ✅ | Tracked in JS |
| `win.setMovable(flag)` | ✅ | `WM_SYSCOMMAND SC_MOVE` intercept |
| `win.isMovable()` | ✅ | Tracked in JS |
| `win.setMinimizable(flag)` | ✅ | `SetWindowLong WS_MINIMIZEBOX` |
| `win.isMinimizable()` | ✅ | Tracked in JS |
| `win.setMaximizable(flag)` | ✅ | `SetWindowLong WS_MAXIMIZEBOX` |
| `win.isMaximizable()` | ✅ | Tracked in JS |
| `win.setClosable(flag)` | ✅ | `EnableMenuItem SC_CLOSE` |
| `win.isClosable()` | ✅ | Tracked in JS |
| `win.setAlwaysOnTop(flag)` | ✅ | `Window.Topmost` |
| `win.setOpacity(opacity)` | ✅ | `Window.Opacity` (0.0–1.0) |
| `win.getOpacity()` | ✅ | Reads `Window.Opacity` |
| `win.center()` | ✅ | Computed from `SystemParameters.PrimaryScreenWidth/Height` |
| `win.flashFrame(flag)` | ✅ | `FlashWindowEx` (user32) — flashes taskbar button until window is focused |
| `win.setSkipTaskbar(flag)` | ✅ | `SetWindowLong WS_EX_TOOLWINDOW`/`WS_EX_APPWINDOW` |
| `win.setBackgroundColor(color)` | ✅ | WebView2 `DefaultBackgroundColor`; same format as constructor option |
| `win.setMenu(menu)` | ✅ | Accepts `Menu` instance or `MenuItemOptions[]` |
| `win.removeMenu()` | ✅ | Clears the menu bar |
| `win.popupMenu(items, x?, y?)` | ✅ | WPF `ContextMenu`; positioned at cursor or explicit screen coordinates |
| `win.showOpenDialog(options)` | ✅ | Synchronous native dialog; returns `string[] \| undefined` |
| `win.showSaveDialog(options)` | ✅ | Synchronous native dialog; returns `string \| undefined` |
| `win.showMessageBox(options)` | ✅ | Synchronous native dialog; returns button index |
| `win.capturePage()` | ✅ | `CoreWebView2.CapturePreviewAsync(Png)`; returns `Promise<NativeImage>` |

### Window Events

| Event | Status | Notes |
|---|---|---|
| `'closed'` | ✅ | Emitted after the window has been destroyed |
| `'close'` | ✅ | Pre-close cancelable event; fires on X-button click; `event.preventDefault()` sets `e.Cancel = true` via `add_Closing` sync event |
| `'focus'` | ✅ | `Window.Activated` |
| `'blur'` | ✅ | `Window.Deactivated` |
| `'show'` | ✅ | Emitted from `show()` |
| `'hide'` | ✅ | Emitted from `hide()` |
| `'resize'` | ✅ | `Window.SizeChanged`; args: `(width, height)` in logical pixels |
| `'move'` | ✅ | `Window.LocationChanged`; args: `(x, y)` in logical pixels |
| `'maximize'` | ✅ | `Window.StateChanged` → `WindowState.Maximized` (when not in fullscreen) |
| `'unmaximize'` | ✅ | `Window.StateChanged` → `WindowState.Normal` from Maximized |
| `'minimize'` | ✅ | `Window.StateChanged` → `WindowState.Minimized` |
| `'restore'` | ✅ | `Window.StateChanged` → `WindowState.Normal` from Minimized |
| `'enter-full-screen'` | ✅ | Emitted from `setFullScreen(true)` |
| `'leave-full-screen'` | ✅ | Emitted from `setFullScreen(false)` |
| `'page-title-updated'` | ✅ | Emitted on `CoreWebView2.DocumentTitleChanged`; args: `(event, title, explicitSet)` |
| `'ready-to-show'` | ❌ | Not emitted |

### `win.webContents`

| API | Status | Notes |
|---|---|---|
| `webContents.send(channel, ...args)` | ✅ | `CoreWebView2.PostWebMessageAsString` |
| `webContents.openDevTools()` | ✅ | `CoreWebView2.OpenDevToolsWindow()` |
| `webContents.reload()` | ✅ | `CoreWebView2.Reload()` |
| `webContents.loadURL(url)` | ✅ | |
| `webContents.loadFile(path)` | ✅ | |
| `webContents.executeJavaScript(code)` | ✅ | Returns `Promise`; supports async expressions; 10 s timeout |
| `webContents.session.clearCache()` | ✅ | Clears Cache API entries via `caches.keys()` |
| `webContents.session.clearStorageData()` | ✅ | Clears `localStorage`, `sessionStorage`, `indexedDB`; cookies not supported |
| Event: `'did-finish-load'` | ✅ | Emitted on `CoreWebView2.NavigationCompleted` (success) |
| Event: `'did-navigate'` | ✅ | Emitted on `NavigationCompleted` (success); arg: `url` |
| Event: `'dom-ready'` | ✅ | Emitted on `CoreWebView2.DOMContentLoaded` |
| Event: `'did-fail-load'` | ✅ | Emitted on `NavigationCompleted` (failure); args: `(event, errorCode, url, errorDescription, isMainFrame)` |
| Event: `'will-navigate'` | ✅ | `CoreWebView2.NavigationStarting`; arg: `url` |
| `webContents.getURL()` | ✅ | `CoreWebView2.Source` |
| `webContents.getTitle()` | ✅ | `CoreWebView2.DocumentTitle` |
| `webContents.isLoading()` | ✅ | Tracked via `NavigationStarting` / `NavigationCompleted` |
| `webContents.goBack/goForward()` | ✅ | `CoreWebView2.GoBack()` / `CoreWebView2.GoForward()` |
| `webContents.print()` / `printToPDF()` | ❌ | Not implemented |

---

## `ipcMain`

| API | Status | Notes |
|---|---|---|
| `ipcMain.handle(channel, listener)` | ✅ | Sync and async handlers both supported |
| `ipcMain.handleOnce(channel, listener)` | ✅ | |
| `ipcMain.removeHandler(channel)` | ✅ | |
| `ipcMain.on(channel, listener)` | ✅ | |
| `ipcMain.once(channel, listener)` | ✅ | |
| `ipcMain.off(channel, listener)` | ✅ | |
| `ipcMain.removeAllListeners()` | ✅ | Clears both `handle` handlers and `on` listeners |
| `event.returnValue` (sendSync) | ✅ | Set in `ipcMain.on()` handler; returned to `sendSync()` caller |
| `event.reply(channel, ...args)` | ✅ | |
| `event.frameId` | ⚠️ | Always `0`; multi-frame detection not supported |

---

## `ipcRenderer` (injected when `contextIsolation: false`)

| API | Status | Notes |
|---|---|---|
| `ipcRenderer.send(channel, ...args)` | ✅ | `chrome.webview.postMessage` |
| `ipcRenderer.invoke(channel, ...args)` | ✅ | Returns `Promise` |
| `ipcRenderer.sendSync(channel, ...args)` | ✅ | Sync XHR to custom protocol |
| `ipcRenderer.on(channel, listener)` | ✅ | |
| `ipcRenderer.once(channel, listener)` | ✅ | |
| `ipcRenderer.off(channel, listener)` | ✅ | |
| `ipcRenderer.removeListener(channel, listener)` | ✅ | Alias for `off()` |
| `ipcRenderer.removeAllListeners(channel?)` | ✅ | Removes all listeners for the given channel, or all channels if omitted |
| `ipcRenderer.postMessage()` | ✅ | Sends the message as the first argument via the `send` IPC path |
| `ipcRenderer.sendToHost()` | ❌ | Not implemented |

---

## `contextBridge`

| API | Status | Notes |
|---|---|---|
| `contextBridge.exposeInMainWorld(key, api)` | ⚠️ | Implemented as `window[key] = api`. When `contextIsolation: true`, the globals `ipcRenderer` and `contextBridge` are deleted from `window` after the preload runs — there is no actual V8 context separation. The exposed API remains accessible via any references captured in preload closures. |

---

## `dialog`

All methods are exposed as Promises but execute synchronously underneath (blocking the Node.js event loop until the dialog is dismissed). This matches Electron's `show*Sync` variants in behaviour, unlike Electron's default async dialogs.

| API | Status | Notes |
|---|---|---|
| `dialog.showOpenDialog([win,] options)` | ✅ | Returns `Promise<{ canceled, filePaths }>` |
| `dialog.showSaveDialog([win,] options)` | ✅ | Returns `Promise<{ canceled, filePath }>` |
| `dialog.showMessageBox([win,] options)` | ✅ | Returns `Promise<{ response, checkboxChecked }>`; `buttons` array supported; `checkboxLabel` option supported — renders a custom WPF `Window` with a `CheckBox` (compiled once via `addType()`); `checkboxChecked` reflects user selection |
| `dialog.showErrorBox(title, content)` | ✅ | |
| `dialog.showOpenDialogSync([win,] options)` | ✅ | Returns `string[] \| undefined` |
| `dialog.showSaveDialogSync([win,] options)` | ✅ | Returns `string \| undefined` |
| `dialog.showMessageBoxSync([win,] options)` | ✅ | Returns `number` |
| `dialog.showCertificateTrustDialog()` | ❌ | Not implemented | macOS only |

---

## `shell`

| API | Status | Notes |
|---|---|---|
| `shell.openExternal(url)` | ✅ | `cmd /c start`; returns `Promise<void>` |
| `shell.openPath(filePath)` | ✅ | `explorer`; returns `Promise<string>` (empty string on success, error message on failure) |
| `shell.showItemInFolder(filePath)` | ✅ | `explorer /select,`; returns `void` |
| `shell.beep()` | ✅ | Writes `\x07` to stdout |
| `shell.trashItem(path)` | ✅ | `SHFileOperation` (shell32) with `FOF_ALLOWUNDO` — sends to Recycle Bin; returns `Promise<void>` |
| `shell.readShortcutLink()` | ❌ | Not implemented |
| `shell.writeShortcutLink()` | ❌ | Not implemented |

---

## `Menu` / `MenuItem`

| API | Status | Notes |
|---|---|---|
| `Menu.buildFromTemplate(template)` | ✅ | |
| `new Menu()` / `menu.append()` / `menu.insert()` | ✅ | |
| `Menu.setApplicationMenu(menu \| null)` | ✅ | `null` removes the menu bar from all windows |
| `Menu.getApplicationMenu()` | ✅ | |
| `menu.popup({ window, x?, y? })` | ✅ | WPF `ContextMenu` |
| `label`, `type`, `click`, `submenu`, `enabled`, `visible`, `checked`, `role` | ✅ | |
| `accelerator` | ✅ | Displayed as `InputGestureText`; keyboard shortcuts enforced via C# `PreviewKeyDown` hook |
| `toolTip` | ✅ | WPF `MenuItem.ToolTip` |
| `icon` | ✅ | WPF `MenuItem.Icon` (`BitmapImage` 16×16); best-effort |
| `id`, `sublabel` | ❌ | |

---

## `nativeImage`

| API | Status | Notes |
|---|---|---|
| `nativeImage.createEmpty()` | ✅ | |
| `nativeImage.createFromBuffer(buffer)` | ✅ | Accepts PNG, JPEG, GIF, WebP or any raw image bytes |
| `nativeImage.createFromPath(path)` | ✅ | `fs.readFileSync`; returns empty image on error |
| `nativeImage.createFromDataURL(url)` | ✅ | Parses any `data:<mime>;base64,...` URL |
| `image.toPNG()` | ✅ | Returns the raw stored bytes (PNG if loaded as PNG) |
| `image.toDataURL()` | ✅ | MIME type auto-detected from magic bytes (PNG/JPEG/GIF/WebP) |
| `image.toJPEG(quality)` | ✅ | `System.Drawing.Bitmap` + `JpegBitmapEncoder`; compiled once via `addType()` |
| `image.isEmpty()` | ✅ | |
| `image.getSize()` | ✅ | PNG IHDR chunk or JPEG SOF marker scan |
| `image.resize(options)` | ✅ | `System.Drawing.Graphics.DrawImage` with `HighQualityBicubic`; returns PNG |
| `image.crop(rect)` | ✅ | `Bitmap.Clone(Rectangle, PixelFormat)`; returns PNG |

---

## Node.js Integration in Renderer (`nodeIntegration: true`)

`window.require` is synchronous, matching Electron's `nodeIntegration: true` behaviour.

| Feature | Status | Notes |
|---|---|---|
| `window.require('fs')` and all Node.js built-ins | ✅ | Sync XHR to local HTTP server (`127.0.0.1:<port>`) |
| npm packages declared in user's `package.json` | ✅ | Resolved via `createRequire(process.cwd())` |
| Callback arguments (e.g. `fs.readFile(path, cb)`) | ✅ | Serialized as `{__nww_cb: id}`; fired via SSE |
| Multi-fire callbacks (e.g. `fs.watch`, `EventEmitter.on`) | ✅ | Same SSE mechanism |
| Non-serializable values (Buffer, FSWatcher, Stream, …) | ✅ | Stored in ref registry; renderer gets a Proxy |
| `window.process.platform` | ✅ | `'win32'` |
| `window.process.arch` | ✅ | Reflects actual `process.arch` |
| `window.process.version` | ✅ | Injected from main process |
| `window.process.env` | ✅ | Snapshot of `process.env` at window creation time |
| `window.process.cwd()` | ✅ | Injected from main process |
| `window.process.exit(code)` | ✅ | Sends IPC to main process |
| `import { x } from 'fs'` (static ESM) | ✅ | importmap injected; works with both `loadFile()` and `loadURL()` |

---

## `protocol`

Must be configured **before** any `BrowserWindow` is created (before `app` is ready).

| API | Status | Notes |
|---|---|---|
| `protocol.registerSchemesAsPrivileged(schemes)` | ✅ | Registers custom schemes with `{ secure?, standard? }` privileges; must be called before the first `BrowserWindow` |
| `protocol.handle(scheme, handler)` | ✅ | Registers an async request handler: `(req: { url, method }) => { statusCode?, mimeType?, data: string \| Buffer \| null }` |
| `protocol.unhandle(scheme)` | ✅ | Removes the handler for the scheme |
| `protocol.isProtocolHandled(scheme)` | ✅ | Returns `true` if a handler is registered |

**Windows note:** the handler runs in a dedicated `worker_threads` worker (so async handlers work inside the synchronous `add_WebResourceRequested` C# callback). Because the function source is serialized and `eval`'d in the worker, **closures over outer-scope variables are not supported**. Use inline `require()`/`await import()` instead.

---

## Not Implemented

The following Electron modules have no equivalent in this library:

| Module | Notes |
|---|---|
| `Tray` | System tray icon |
| `Notification` | Desktop notifications |
| `clipboard` | Clipboard read/write |
| `screen` | Display geometry, cursor position |
| `globalShortcut` | Global keyboard shortcuts (unrelated to menu `accelerator`) |
| `nativeTheme` | Dark/light mode detection and `prefers-color-scheme` |
| `powerMonitor` | Sleep/wake/lock/unlock events, battery status |
| `powerSaveBlocker` | Prevent display sleep |
| `protocol.interceptBufferProtocol()` | Not implemented (use `protocol.handle()` instead) |
| `net` | Chromium-routed HTTP requests |
| `autoUpdater` | App auto-update |
| `desktopCapturer` | Screen/window recording |
| `BrowserView` | Embedded webview inside a window |
| `safeStorage` | OS-level encrypted storage |
| `session.fromPartition()` | Static session factory |
| `webContents.setWindowOpenHandler()` | Intercept `window.open()` |
| `webContents.findInPage()` | In-page text search |

---

## Key Differences from Electron

- **Single-process model.** There is no separate renderer process. Node.js and the WebView run in the same OS process. `nodeIntegration` works via a local HTTP server and sync XHR — not by directly running Node in the renderer.

- **`contextIsolation` is simulated, not enforced.** When `contextIsolation: true` and a preload is present, `ipcRenderer` and `contextBridge` are deleted from `window` after the preload executes. This is not V8 context isolation — malicious page scripts can still access any closures created by the preload.

- **Most window state-change events are emitted.** `'focus'`, `'blur'`, `'resize'`, `'show'`, `'hide'`, `'move'`, `'maximize'`, `'unmaximize'`, `'minimize'`, `'restore'`, `'enter-full-screen'`, `'leave-full-screen'`, and `'page-title-updated'` are all emitted. `'ready-to-show'` is not emitted.

- **`dialog` methods block the event loop.** All dialog methods execute synchronously on the Node.js thread. Unlike Electron's async native dialogs, they block until dismissed.

- **`win.blur()` is a no-op.** WPF has no programmatic focus-removal API.

- **`setFullScreen()` is not exclusive fullscreen.** It sets `WindowStyle.None` + `WindowState.Maximized` + `Topmost`. The taskbar may remain visible depending on system settings.

- **`transparent: true` requires no host-page CSS.** Uses `AllowsTransparency=false` (hardware DX renderer) + `WindowChrome(GlassFrameThickness=-1)` + WPF `Background=Transparent` + WebView2 alpha=0. Mouse clicks reach WebView2 on fully transparent pixels.

- **Preload scripts** run via `AddScriptToExecuteOnDocumentCreatedAsync` — they execute on every navigation before the page's own scripts, matching Electron's behaviour.
