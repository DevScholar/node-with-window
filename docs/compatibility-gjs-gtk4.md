# Electron API Compatibility — `gjs-gtk4` Backend

**Platform:** Linux
**Stack:** GTK 4 + WebKitGTK 6.0 (falls back to WebKit2 4.1)
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
| `app.quit()` | ✅ | Emits `before-quit`, then `process.exit(0)` |
| `app.exit(exitCode?)` | ✅ | `process.exit(exitCode)`; relaunches first if `relaunch()` was called |
| `app.relaunch([options])` | ✅ | Spawns new process on next `quit()`/`exit()`; accepts `execPath` and `args` |
| `app.focus()` | ✅ | Calls `present()` on the first open BrowserWindow |
| `app.setName(name)` | ✅ | Overrides the value returned by `getName()` |
| `app.getLocale()` | ✅ | Returns `Intl.DateTimeFormat().resolvedOptions().locale` |
| `app.requestSingleInstanceLock()` | ✅ | PID-file based; returns `true` for first instance, `false` if another is alive |
| Event: `ready` | ✅ | Also fires immediately (via `setImmediate`) when `on('ready')` is called after the app is already ready |
| Event: `before-quit` | ✅ | |
| Event: `window-all-closed` | ✅ | Process exits with code 0 if no listener is registered |
| Event: `second-instance` | ❌ | `requestSingleInstanceLock()` detects existing instances but does not notify them |
| Event: `will-quit` | ❌ | Not emitted |
| Event: `activate` | ❌ | macOS only |
| Event: `browser-window-focus/blur/created` | ❌ | Not emitted |
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
| `autoHideMenuBar` | ❌ | Not implemented |

### `webPreferences`

| Option | Status | Notes |
|---|---|---|
| `nodeIntegration` | ✅ | Enables `window.require` (sync XHR) and `window.process` |
| `contextIsolation` | ⚠️ | When `true` + `preload`: globals `ipcRenderer` and `contextBridge` are deleted from `window` after the preload runs. Not true V8 context isolation. |
| `preload` | ✅ | Registered via `WebKit.UserContentManager.add_script()` at `DOCUMENT_START` |
| `partition` | ❌ | Accepted but not applied — WebKitGTK uses a single default profile |
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
| `win.hide()` | ❌ | Not implemented |
| `win.close()` | ✅ | `Window.close()`; process exit managed by close-event chain |
| `win.destroy()` | ✅ | Alias for `close()` |
| `win.focus()` | ✅ | `Window.present()` |
| `win.blur()` | ⚠️ | No-op — compositor controls focus |
| `win.isFocused()` | ❌ | Not implemented |
| `win.isVisible()` | ❌ | Not implemented |
| `win.isDestroyed()` | ❌ | Not implemented |
| `win.minimize()` | ✅ | `Window.minimize()` |
| `win.maximize()` | ✅ | `Window.maximize()` |
| `win.unmaximize()` / `win.restore()` | ✅ | `Window.unmaximize()` |
| `win.isMinimized()` | ❌ | Not implemented |
| `win.isMaximized()` | ❌ | Not implemented |
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
| `win.popupMenu(items, x?, y?)` | ❌ | Not implemented; logs `console.warn` |
| `win.showOpenDialog(options)` | ✅ | `Gtk.FileDialog` async + `drainCallbacks()` spin-wait; returns `string[] \| undefined` |
| `win.showSaveDialog(options)` | ✅ | Same mechanism |
| `win.showMessageBox(options)` | ⚠️ | Falls back to `alert()` via `evaluate_javascript`; always returns `0`; `buttons` array ignored |
| `win.capturePage()` | ❌ | Returns an empty `NativeImage`; WebKit snapshot API not yet wired |

### Window Events

| Event | Status | Notes |
|---|---|---|
| `'closed'` | ✅ | Emitted after the window has been destroyed |
| `'close'` | ❌ | Pre-close cancelable event not implemented |
| `'focus'` | ❌ | Not emitted |
| `'blur'` | ❌ | Not emitted |
| `'show'` | ❌ | Not emitted |
| `'hide'` | ❌ | Not emitted |
| `'resize'` | ❌ | Not emitted |
| `'move'` | ❌ | Not emitted |
| `'maximize'` | ❌ | Not emitted |
| `'unmaximize'` | ❌ | Not emitted |
| `'minimize'` | ❌ | Not emitted |
| `'restore'` | ❌ | Not emitted |
| `'enter-full-screen'` | ❌ | Not emitted |
| `'leave-full-screen'` | ❌ | Not emitted |
| `'page-title-updated'` | ❌ | Not emitted |
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
| Event: `'did-navigate'` | ❌ | Not emitted |
| Event: `'dom-ready'` | ❌ | Not emitted |
| Event: `'did-fail-load'` | ❌ | Not emitted |
| Event: `'will-navigate'` | ❌ | Not emitted |
| `webContents.getURL()` | ❌ | Not implemented |
| `webContents.getTitle()` | ❌ | Not implemented |
| `webContents.isLoading()` | ❌ | Not implemented |
| `webContents.goBack/goForward()` | ❌ | Not implemented |
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
| `ipcRenderer.sendSync(channel, ...args)` | ✅ | Sync XHR to loopback server |
| `ipcRenderer.on(channel, listener)` | ✅ | |
| `ipcRenderer.once(channel, listener)` | ✅ | |
| `ipcRenderer.off(channel, listener)` | ✅ | |
| `ipcRenderer.removeListener(channel, listener)` | ✅ | Alias for `off()` |
| `ipcRenderer.removeAllListeners(channel?)` | ❌ | Not implemented |
| `ipcRenderer.postMessage()` | ❌ | Not implemented |

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
| `dialog.showMessageBox([win,] options)` | ⚠️ | Falls back to `alert()` via `evaluate_javascript`; always returns `{ response: 0 }`; `buttons` array and `type` are ignored |
| `dialog.showErrorBox(title, content)` | ⚠️ | Calls `showMessageBox` — same `alert()` fallback |
| `dialog.showCertificateTrustDialog()` | ❌ | Not implemented |

---

## `shell`

| API | Status | Notes |
|---|---|---|
| `shell.openExternal(url)` | ✅ | `xdg-open` |
| `shell.openPath(filePath)` | ✅ | `xdg-open` |
| `shell.showItemInFolder(filePath)` | ✅ | `xdg-open` on parent directory |
| `shell.beep()` | ✅ | Writes `\x07` to stdout |
| `shell.trashItem(path)` | ✅ | `gio trash` |

---

## `Menu` / `MenuItem`

| API | Status | Notes |
|---|---|---|
| `Menu.buildFromTemplate(template)` | ✅ | |
| `new Menu()` / `menu.append()` / `menu.insert()` | ✅ | |
| `Menu.setApplicationMenu(menu \| null)` | ✅ | `null` removes the menu bar from all windows |
| `Menu.getApplicationMenu()` | ✅ | |
| `menu.popup({ window, x?, y? })` | ❌ | Not implemented (`popupMenu` is a stub) |
| `label`, `type`, `click`, `submenu`, `enabled`, `visible`, `checked`, `role` | ✅ | |
| `accelerator` | ✅ | Keyboard shortcuts enforced via `Gtk.ShortcutController` with `GLOBAL` scope |
| `toolTip`, `icon`, `id`, `sublabel` | ❌ | |

---

## `nativeImage`

| API | Status | Notes |
|---|---|---|
| `nativeImage.createEmpty()` | ✅ | |
| `nativeImage.createFromBuffer(buffer)` | ✅ | Expects PNG bytes |
| `nativeImage.createFromPath(path)` | ❌ | Not implemented |
| `nativeImage.createFromDataURL(url)` | ❌ | Not implemented |
| `image.toPNG()` | ✅ | Returns `Buffer` |
| `image.toDataURL()` | ✅ | Returns `data:image/png;base64,...` |
| `image.toJPEG(quality)` | ❌ | Not implemented |
| `image.isEmpty()` | ✅ | |
| `image.getSize()` | ✅ | Reads PNG IHDR chunk |
| `image.resize()` / `image.crop()` | ❌ | Not implemented |

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
| `protocol` | Custom URL scheme registration |
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

1. **Single-process model.** GTK and Node.js share the same OS process via `@devscholar/node-with-gjs`. There is no separate renderer process. `nodeIntegration` works via a local HTTP server and sync XHR.

2. **`contextIsolation` is simulated, not enforced.** When `contextIsolation: true` and a preload is present, `ipcRenderer` and `contextBridge` are deleted from `window` after the preload runs. This is not V8 context isolation.

3. **No cancelable `'close'` event.** Only `'closed'` (post-destruction) is emitted.

4. **Window events are not emitted.** `'focus'`, `'blur'`, `'resize'`, `'move'`, etc. are not wired to GTK signals.

5. **`dialog.showMessageBox` uses `alert()`.** GTK4 removed synchronous dialog APIs. `showMessageBox` evaluates `alert(message)` in the WebView as a fallback — it always returns `0` and ignores the `buttons` array.

6. **`win.capturePage()` returns an empty image.** The WebKit snapshot API is not yet wired; `NativeImage.isEmpty()` will return `true`.

7. **`webPreferences.partition` is ignored.** WebKitGTK uses a single default data manager; per-window session isolation is not supported.

8. **`x`, `y`, `maxWidth`, `maxHeight`, `alwaysOnTop`, `skipTaskbar`, `flashFrame` have no effect.** GTK4 removed the relevant APIs (`window.move()`, maximum size, urgency hints); window placement and stacking are managed entirely by the compositor.

9. **`win.popupMenu()` is not implemented.** It logs a warning. The `menu.popup()` method is equally unimplemented for GTK4.

10. **Preload scripts** are registered via `WebKit.UserContentManager.add_script()` at `DOCUMENT_START` — they run on every navigation before the page's own scripts, matching Electron's behaviour.
