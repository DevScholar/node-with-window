# Electron API Compatibility — `gjs-gtk4` Backend

**Platform:** Linux
**Stack:** GTK 4 + WebKitGTK 6.0
**Bridge:** `@devscholar/node-with-gjs` — in-process GJS bindings; GTK event loop drained by Node.js at 16 ms intervals via `startEventDrain()`.

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
| `app.focus()` | ✅ | Calls `present()` on the first open BrowserWindow |
| `app.setName(name)` | ✅ | Overrides the value returned by `getName()` |
| `app.getLocale()` | ✅ | Returns `Intl.DateTimeFormat().resolvedOptions().locale` |
| `app.requestSingleInstanceLock()` | ✅ | PID-file based; returns `true` for first instance, `false` if another is alive |
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

---

## `BrowserWindow`

### Constructor

`new BrowserWindow(options)` is synchronous, matching Electron. GTK initialization runs asynchronously in the background; `show()` fires via `setImmediate` once ready (unless `show: false`).

### Constructor Options

| Option | Status | Notes |
|---|---|---|
| `width`, `height` | ✅ | `Gtk.Window.set_default_size()` |
| `x`, `y` | ❌ | GTK4 removed `window.move()`; placement is compositor-controlled |
| `minWidth`, `minHeight` | ✅ | `Window.set_size_request()` |
| `maxWidth`, `maxHeight` | ❌ | GTK4 has no maximum window size API |
| `title` | ✅ | `Window.set_title()`; also auto-synced from `document.title` |
| `icon` | ✅ | `Gtk.Window.set_icon_name()` / `Gdk.Texture`; best-effort |
| `resizable` | ✅ | `Window.set_resizable(false)` |
| `movable` | ⚠️ | `Window.set_decorated(false)` removes the title bar, preventing drag; the window can still be moved via compositor shortcuts |
| `minimizable` | ⚠️ | No compositor-independent GTK4 API to hide the minimize button; no effect |
| `maximizable` | ⚠️ | `Window.set_resizable(false)` also disables maximize; there is no separate maximize-button API |
| `closable` | ✅ | `Window.set_deletable(false)` hides the close button |
| `alwaysOnTop` | ❌ | No portable GTK4 API via GObject Introspection; no effect |
| `show` | ✅ | Pass `false` to prevent auto-show |
| `frame` | ✅ | `Window.set_decorated(false)` — removes title bar and border |
| `titleBarStyle` | ✅ | `'hidden'`/`'hiddenInset'`: empty `Gtk.Box` replaces the default CSD headerbar; WM resize border is preserved |
| `transparent` | ✅ | `set_decorated(false)` + `WebKit.WebView.set_background_color(alpha=0)`; compositor-dependent |
| `backgroundColor` | ✅ | `WebKit.WebView.set_background_color(Gdk.RGBA)`; accepts `#RGB`, `#RRGGBB`, `#AARRGGBB` |
| `fullscreen` | ✅ | `Window.fullscreen()` at creation |
| `kiosk` | ✅ | `fullscreen()` + `set_resizable(false)` |
| `skipTaskbar` | ❌ | GTK4 removed taskbar hint APIs; no effect |
| `parent`, `modal` | ⚠️ | `modal` disables the parent via `set_sensitive(false)`; no `set_transient_for()` (in-process limitation) |
| `webPreferences` | ✅ | See WebPreferences section |
| `autoHideMenuBar` | ✅ | Menu bar hidden initially; bare Alt key (keyval 65513/65514) toggles visibility via `EventControllerKey` |

### `webPreferences`

| Option | Status | Notes |
|---|---|---|
| `nodeIntegration` | ✅ | Enables `window.require` (sync XHR) and `window.process` |
| `contextIsolation` | ⚠️ | When `true` + `preload`: globals `ipcRenderer` and `contextBridge` are deleted from `window` after the preload runs. Not true V8 context isolation. |
| `preload` | ✅ | Registered via `WebKit.UserContentManager.add_script()` at `DOCUMENT_START` |
| `partition` | ✅ | `persist:<name>` → dedicated `WebsiteDataManager` with named directory; `temp:<name>` → ephemeral session (directory cleaned up on window close) |
| `webSecurity` | ✅ | `false` sets `allow_file_access_from_file_urls` + `allow_universal_access_from_file_urls` on `WebKit.Settings` |
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
| `win.loadURL(url)` | ✅ | `WebView.load_uri(url)`; queued until GTK is ready |
| `win.loadFile(path)` | ✅ | `WebView.load_uri('file://' + absolutePath)`; bridge script injected via `UserContentManager` |
| `win.show()` | ✅ | `Window.present()` |
| `win.hide()` | ✅ | `Window.hide()` |
| `win.close()` | ✅ | `Window.close()`; process exit managed by close-event chain |
| `win.destroy()` | ✅ | Alias for `close()` |
| `win.focus()` | ✅ | `Window.present()` |
| `win.blur()` | ⚠️ | No-op — compositor controls focus |
| `win.isFocused()` | ✅ | `Window.is_active` |
| `win.isVisible()` | ✅ | Tracked in JS (`_isVisible` flag) |
| `win.isDestroyed()` | ✅ | Tracked in JS (`isClosed` flag) |
| `win.minimize()` | ✅ | `Window.minimize()` |
| `win.maximize()` | ✅ | `Window.maximize()` |
| `win.unmaximize()` / `win.restore()` | ✅ | `Window.unmaximize()` |
| `win.isMinimized()` | ✅ | Tracked via `notify::suspended` signal |
| `win.isMaximized()` | ✅ | `Window.is_maximized` |
| `win.isNormal()` | ❌ | Not implemented |
| `win.setFullScreen(flag)` | ✅ | `Window.fullscreen()` / `Window.unfullscreen()` |
| `win.isFullScreen()` | ✅ | Tracked in JS |
| `win.setKiosk(flag)` | ✅ | `setFullScreen` + `set_resizable(false)` |
| `win.isKiosk()` | ✅ | Tracked in JS |
| `win.setTitle(title)` | ✅ | `Window.set_title()` |
| `win.getTitle()` | ✅ | `Window.get_title()` |
| `win.setSize(w, h)` | ✅ | `Window.set_default_size()`; takes effect on next layout pass |
| `win.getSize()` | ✅ | `Window.get_width()`/`get_height()`; returns `[0,0]` before first show |
| `win.setPosition(x, y)` | ⚠️ | No-op + `console.warn`; GTK4 removed `window.move()` |
| `win.getPosition()` | ⚠️ | Returns `[0, 0]` + `console.warn` |
| `win.setMinimumSize(w, h)` | ✅ | `Window.set_size_request()` |
| `win.setMaximumSize(w, h)` | ⚠️ | No-op; GTK4 has no maximum window size API |
| `win.getMinimumSize()` | ❌ | Not implemented |
| `win.getMaximumSize()` | ❌ | Not implemented |
| `win.setResizable(flag)` | ✅ | `Window.set_resizable()` |
| `win.isResizable()` | ✅ | Tracked in JS |
| `win.setMovable(flag)` | ⚠️ | `Window.set_decorated(false)` when `false`; removes title bar as a side effect |
| `win.isMovable()` | ✅ | Tracked in JS |
| `win.setMinimizable(flag)` | ⚠️ | No-op + `console.warn` |
| `win.isMinimizable()` | ✅ | Tracked in JS |
| `win.setMaximizable(flag)` | ⚠️ | `Window.set_resizable()` (affects resize too); no separate maximize-button API |
| `win.isMaximizable()` | ✅ | Tracked in JS |
| `win.setClosable(flag)` | ✅ | `Window.set_deletable()` |
| `win.isClosable()` | ✅ | Tracked in JS |
| `win.setAlwaysOnTop(flag)` | ❌ | No-op; no portable GTK4 API via GI |
| `win.setOpacity(opacity)` | ⚠️ | No-op + `console.warn`; `gtk_widget_set_opacity()` removed in GTK4 |
| `win.getOpacity()` | ⚠️ | Returns `1.0` + `console.warn` |
| `win.center()` | ⚠️ | No-op + `console.warn`; placement is compositor-controlled |
| `win.flashFrame(flag)` | ❌ | No-op; GTK4 removed urgency hint APIs |
| `win.setSkipTaskbar(flag)` | ❌ | No-op; GTK4 removed taskbar hint APIs |
| `win.setBackgroundColor(color)` | ✅ | `WebView.set_background_color(Gdk.RGBA)` |
| `win.setMenu(menu)` | ✅ | GTK4 `PopoverMenuBar`; items mapped to `Gio.SimpleAction` |
| `win.removeMenu()` | ✅ | Removes the `PopoverMenuBar` widget |
| `win.popupMenu(items, x?, y?)` | ✅ | `Gtk.PopoverMenu` with `Gio.Menu` model; positioned at cursor or explicit window-relative coordinates |
| `win.showOpenDialog(options)` | ✅ | `Gtk.FileDialog` async + `drainCallbacks()` spin-wait; returns `string[] \| undefined` |
| `win.showSaveDialog(options)` | ✅ | Same mechanism |
| `win.showMessageBox(options)` | ✅ | `Gtk.AlertDialog` (GTK ≥ 4.10) or `Gtk.MessageDialog` fallback; `drainCallbacks()` spin-wait; returns button index |
| `win.capturePage()` | ✅ | WebKit `get_snapshot(FULL_DOCUMENT)` → cairo surface → PNG tmpfile → `NativeImage`; best-effort |

### Window Events

| Event | Status | Notes |
|---|---|---|
| `'closed'` | ✅ | Emitted after the window has been destroyed |
| `'close'` | ✅ | Pre-close cancelable event; `event.preventDefault()` prevents the window from closing |
| `'focus'` | ✅ | `notify::is-active` (GTK `is_active` becomes `true`) |
| `'blur'` | ✅ | `notify::is-active` (GTK `is_active` becomes `false`) |
| `'show'` | ✅ | Emitted from `show()` |
| `'hide'` | ✅ | Emitted from `hide()` |
| `'resize'` | ✅ | `notify::default-width`; args: `(width, height)` in logical pixels |
| `'move'` | ❌ | Not emitted (compositor-managed; GTK4 has no move event) |
| `'maximize'` | ✅ | `notify::maximized` → `is_maximized` transitions to `true` |
| `'unmaximize'` | ✅ | `notify::maximized` → `is_maximized` transitions to `false` |
| `'minimize'` | ✅ | `notify::suspended` → `suspended` transitions to `true` (GTK ≥ 4.12) |
| `'restore'` | ✅ | `notify::suspended` → `suspended` transitions to `false` (GTK ≥ 4.12) |
| `'enter-full-screen'` | ✅ | `notify::fullscreened` → `fullscreened` transitions to `true` |
| `'leave-full-screen'` | ✅ | `notify::fullscreened` → `fullscreened` transitions to `false` |
| `'page-title-updated'` | ✅ | Emitted on WebKit `notify::title`; args: `(event, title, explicitSet)` |
| `'ready-to-show'` | ❌ | Not emitted |

### `win.webContents`

| API | Status | Notes |
|---|---|---|
| `webContents.send(channel, ...args)` | ✅ | Via `evaluate_javascript` → `window.__ipcDispatch` |
| `webContents.openDevTools()` | ✅ | WebKit inspector (`enable_developer_extras = true`) |
| `webContents.reload()` | ✅ | `WebView.reload()` |
| `webContents.loadURL(url)` | ✅ | |
| `webContents.loadFile(path)` | ✅ | |
| `webContents.executeJavaScript(code)` | ✅ | Returns `Promise`; result sent back via IPC message handler; 10 s timeout |
| `webContents.session.clearCache()` | ✅ | Clears Cache API entries via `caches.keys()` |
| `webContents.session.clearStorageData()` | ✅ | Clears `localStorage`, `sessionStorage`, `indexedDB`; cookies not supported |
| Event: `'did-finish-load'` | ✅ | Emitted on WebKit `load-changed` (`FINISHED`) |
| Event: `'did-navigate'` | ✅ | Emitted on `load-changed` (`COMMITTED`); arg: `url` |
| Event: `'dom-ready'` | ✅ | Emitted on `load-changed` (`COMMITTED`); fires together with `did-navigate` |
| Event: `'did-fail-load'` | ✅ | Emitted on WebKit `load-failed`; args: `(event, errorCode, url, errorDescription, isMainFrame)` |
| Event: `'will-navigate'` | ✅ | `decide-policy` (NAVIGATION_ACTION decision type); arg: `url` |
| `webContents.getURL()` | ✅ | `WebView.get_uri()` |
| `webContents.getTitle()` | ✅ | `WebView.get_title()` |
| `webContents.isLoading()` | ✅ | `WebView.is_loading` |
| `webContents.goBack/goForward()` | ✅ | `WebView.go_back()` / `WebView.go_forward()` |
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
| `event.frameId` | ⚠️ | Always `0` |

---

## `ipcRenderer` (injected when `contextIsolation: false`)

| API | Status | Notes |
|---|---|---|
| `ipcRenderer.send(channel, ...args)` | ✅ | `window.webkit.messageHandlers.ipc.postMessage` |
| `ipcRenderer.invoke(channel, ...args)` | ✅ | Returns `Promise` |
| `ipcRenderer.sendSync(channel, ...args)` | ✅ | Sync XHR to custom protocol |
| `ipcRenderer.on(channel, listener)` | ✅ | |
| `ipcRenderer.once(channel, listener)` | ✅ | |
| `ipcRenderer.off(channel, listener)` | ✅ | |
| `ipcRenderer.removeListener(channel, listener)` | ✅ | Alias for `off()` |
| `ipcRenderer.removeAllListeners(channel?)` | ✅ | Removes all listeners for the given channel, or all channels if omitted |
| `ipcRenderer.postMessage()` | ✅ | Sends the message as the first argument via the `send` IPC path |

---

## `contextBridge`

| API | Status | Notes |
|---|---|---|
| `contextBridge.exposeInMainWorld(key, api)` | ⚠️ | Implemented as `window[key] = api`. When `contextIsolation: true`, `ipcRenderer` and `contextBridge` are deleted from `window` after the preload runs. Not true V8 context isolation. |

---

## `dialog`

All methods execute synchronously underneath (`Gtk.FileDialog` async callbacks drained via `drainCallbacks()` spin-wait), blocking the Node.js event loop until dismissed.

| API | Status | Notes |
|---|---|---|
| `dialog.showOpenDialog([win,] options)` | ✅ | `Gtk.FileDialog`; returns `Promise<{ canceled, filePaths }>` |
| `dialog.showSaveDialog([win,] options)` | ✅ | `Gtk.FileDialog`; returns `Promise<{ canceled, filePath }>` |
| `dialog.showMessageBox([win,] options)` | ✅ | `checkboxLabel` option supported — uses `Gtk.Dialog` + `Gtk.CheckButton`; without checkbox uses `Gtk.AlertDialog` (GTK ≥ 4.10) or `Gtk.MessageDialog` fallback; returns `Promise<{ response, checkboxChecked }>` |
| `dialog.showOpenDialogSync([win,] options)` | ✅ | Blocks via `GLib.MainLoop.run()`; uses `Gtk.FileDialog`; returns `string[] \| undefined` |
| `dialog.showSaveDialogSync([win,] options)` | ✅ | Blocks via `GLib.MainLoop.run()`; uses `Gtk.FileDialog`; returns `string \| undefined` |
| `dialog.showMessageBoxSync([win,] options)` | ✅ | Blocks via `GLib.MainLoop.run()`; uses `Gtk.AlertDialog` (GTK ≥ 4.10) or `Gtk.MessageDialog` fallback; returns `number` |
| `dialog.showErrorBox(title, content)` | ✅ | Delegates to `showMessageBox` |
| `dialog.showCertificateTrustDialog()` | ❌ | Not implemented | macOS only |

---

## `shell`

| API | Status | Notes |
|---|---|---|
| `shell.openExternal(url)` | ✅ | `xdg-open`; returns `Promise<void>` |
| `shell.openPath(filePath)` | ✅ | `xdg-open`; returns `Promise<string>` (empty string on success, error message on failure) |
| `shell.showItemInFolder(filePath)` | ✅ | `xdg-open` on parent directory; returns `void` |
| `shell.beep()` | ✅ | Writes `\x07` to stdout |
| `shell.trashItem(path)` | ✅ | `gio trash`; returns `Promise<void>` |

---

## `Menu` / `MenuItem`

| API | Status | Notes |
|---|---|---|
| `Menu.buildFromTemplate(template)` | ✅ | |
| `new Menu()` / `menu.append()` / `menu.insert()` | ✅ | |
| `Menu.setApplicationMenu(menu \| null)` | ✅ | `null` removes the menu bar from all windows |
| `Menu.getApplicationMenu()` | ✅ | |
| `menu.popup({ window, x?, y? })` | ✅ | `Gtk.PopoverMenu`; coordinates are best-effort (window-relative on X11, approximate on Wayland) |
| `label`, `type`, `click`, `submenu`, `enabled`, `visible`, `checked`, `role` | ✅ | `visible: false` skips the item |
| `accelerator` | ✅ | Keyboard shortcuts enforced via `Gtk.ShortcutController` with `GLOBAL` scope |
| `icon` | ✅ | `Gio.FileIcon` via `Gio.MenuItem.set_icon()`; accepts absolute or relative path; best-effort |
| `toolTip`, `sublabel` | ❌ | Not supported by `Gio.Menu` / `PopoverMenuBar` |
| `id` | ❌ | Ignored at render time (no GTK concept of item ID) |

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
| `image.toJPEG(quality)` | ✅ | `GdkPixbuf.PixbufLoader` + `save_to_bufferv('jpeg', ...)` |
| `image.isEmpty()` | ✅ | |
| `image.getSize()` | ✅ | PNG IHDR chunk or JPEG SOF marker scan |
| `image.resize(options)` | ✅ | `Pixbuf.scale_simple(w, h, BILINEAR)`; returns PNG |
| `image.crop(rect)` | ✅ | `Pixbuf.new_subpixbuf(x, y, w, h)`; returns PNG |

---

## Node.js Integration in Renderer (`nodeIntegration: true`)

| Feature | Status | Notes |
|---|---|---|
| `window.require('fs')` and all Node.js built-ins | ✅ | Sync XHR to local HTTP server (`127.0.0.1:<port>`) |
| npm packages declared in user's `package.json` | ✅ | Resolved via `createRequire(process.cwd())` |
| Callback arguments (e.g. `fs.readFile(path, cb)`) | ✅ | Serialized as `{__nww_cb: id}`; fired via SSE |
| Multi-fire callbacks (e.g. `fs.watch`, `EventEmitter.on`) | ✅ | Same SSE mechanism |
| Non-serializable values (Buffer, FSWatcher, Stream, …) | ✅ | Stored in ref registry; renderer gets a Proxy |
| `window.process.platform` | ✅ | `'linux'` |
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

**Linux note:** the handler runs on the main thread via `WebContext.register_uri_scheme()`; async handlers and closures both work normally.

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
| `nativeTheme` | Dark/light mode detection |
| `powerMonitor` | Sleep/wake/lock/unlock events |
| `powerSaveBlocker` | Prevent display sleep |
| `protocol.interceptBufferProtocol()` | Not implemented (use `protocol.handle()` instead) |
| `net` | Network requests routed via WebKit |
| `autoUpdater` | App auto-update |
| `desktopCapturer` | Screen/window recording |
| `BrowserView` | Embedded webview inside a window |
| `safeStorage` | OS-level encrypted storage |
| `session.fromPartition()` | Session isolation per partition |
| `webContents.setWindowOpenHandler()` | Intercept `window.open()` |
| `webContents.findInPage()` | In-page text search |

---

## Key Differences from Electron

- **Single-process model.** GTK and Node.js share the same OS process via `@devscholar/node-with-gjs`. There is no separate renderer process. `nodeIntegration` works via a local HTTP server and sync XHR.

- **`contextIsolation` is simulated, not enforced.** When `contextIsolation: true` and a preload is present, `ipcRenderer` and `contextBridge` are deleted from `window` after the preload runs. This is not V8 context isolation.

- **Most window state-change events are emitted.** `'focus'`, `'blur'`, `'resize'`, `'show'`, `'hide'`, `'maximize'`, `'unmaximize'`, `'enter-full-screen'`, `'leave-full-screen'`, and `'page-title-updated'` are all emitted. `'minimize'` and `'restore'` require GTK ≥ 4.12 (`notify::suspended`). `'move'` is not emitted — GTK4 provides no window-move event.

- **`win.capturePage()` uses a tmpfile round-trip.** `WebKitWebView.get_snapshot()` writes a cairo PNG surface to `os.tmpdir()`, reads it back, then deletes the file. The image is always RGBA/PNG.

- **`webPreferences.partition` is supported.** `persist:<name>` creates a named `WebsiteDataManager` under `userData/Partitions/`. `temp:` creates an ephemeral session deleted when the window closes.

- **`x`, `y`, `maxWidth`, `maxHeight`, `alwaysOnTop`, `skipTaskbar`, `flashFrame` have no effect.** GTK4 removed the relevant APIs (`window.move()`, maximum size, urgency hints); window placement and stacking are managed entirely by the compositor.

- **`win.popupMenu()` uses `Gtk.PopoverMenu`.** Screen coordinates are translated to window-relative on X11; on Wayland the popover may appear at an approximate position.

- **Preload scripts** are registered via `WebKit.UserContentManager.add_script()` at `DOCUMENT_START` — they run on every navigation before the page's own scripts, matching Electron's behaviour.
