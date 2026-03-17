# Electron API Compatibility — `gjs-gtk4` Backend

**Platform:** Linux
**Stack:** GTK 4 + WebKitGTK 6 (WebKit2GTK)
**Bridge:** GJS host process (`scripts/backend/gjs-gtk4/host.js`) spawned as a child; Node.js communicates over two Unix FIFOs at 16 ms poll intervals.

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
| `app.focus()` | ✅ | Calls `present()` on the first open BrowserWindow |
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

`new BrowserWindow(options)` is synchronous, matching Electron. A GJS host child process is spawned in the background; `show()` fires via `setImmediate` once the window is ready (unless `show: false`).

### Constructor Options

| Option | Status | Notes |
|---|---|---|
| `width`, `height` | ✅ | GTK `default_width` / `default_height` |
| `title` | ✅ | GTK `Window.title`; also auto-synced from `document.title` |
| `icon` | ✅ | Applied via `Gdk.Texture` on `Show`; best-effort |
| `resizable` | ✅ | `Window.set_resizable(false)` when `false` |
| `alwaysOnTop` | ✅ | `Window.set_keep_above(true)` |
| `show` | ✅ | Pass `false` to prevent auto-show |
| `webPreferences` | ✅ | See WebPreferences section |
| `x`, `y` | ❌ | Not forwarded to GTK; placement is WM-controlled |
| `minWidth`, `minHeight` | ✅ | `Window.set_size_request()` |
| `maxWidth`, `maxHeight` | ❌ | GTK4 has no API for maximum window size |
| `movable` | ✅ | `Window.set_decorated(false)` when `false` — removes title bar so window cannot be dragged |
| `minimizable` | ⚠️ | Logged as warning; GTK4 provides no compositor-independent API to hide the minimize button |
| `maximizable` | ✅ | `Window.set_resizable()` controls whether the window can be maximized |
| `closable` | ✅ | `Window.set_deletable(false)` hides the close button |
| `transparent` | ✅ | `set_decorated(false)` + `WebKit.WebView.set_background_color(alpha=0)` — compositor-dependent |
| `frame` | ✅ | `Window.set_decorated(false)` — removes title bar and border |
| `backgroundColor` | ✅ | `WebKit.WebView.set_background_color(Gdk.RGBA)`; accepts `#RGB`, `#RRGGBB`, `#AARRGGBB` |
| `kiosk` | ✅ | `Window.fullscreen()` + `Window.set_resizable(false)` |
| `skipTaskbar` | ⚠️ | Logged as warning; GTK4 removed `set_skip_taskbar_hint()`, most compositors ignore workarounds |
| `fullscreen` | ✅ | `Window.fullscreen()` called at creation |
| `parent`, `modal` | ⚠️ | `modal` disables the parent window via `set_sensitive(false)`; no GTK `set_transient_for` (cross-process limitation) |
| `titleBarStyle` | ✅ | `'hidden'`/`'hiddenInset'`: empty `Gtk.Box` with `height_request = 0` replaces the default CSD headerbar via `set_titlebar()`; WM resize border is preserved. `'default'`: standard headerbar (no-op). Only effective when `frame !== false` and `transparent !== true`. |

### `webPreferences`

| Option | Status | Notes |
|---|---|---|
| `nodeIntegration` | ✅ | Enables `window.require` (sync XHR) and `window.process`; same mechanism as the `netfx-wpf` backend |
| `contextIsolation` | ✅ | `false` (default) injects `window.ipcRenderer` |
| `partition` | ⚠️ | Accepted, not applied — WebKitGTK uses a default profile |
| `preload` | ✅ | Supported via `webPreferences.preload` |
| `sandbox` | ⚠️ | Accepted, no effect |
| `webSecurity` | ✅ | `false` sets `allow_file_access_from_file_urls` + `allow_universal_access_from_file_urls` on `WebKit.Settings` |

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
| `win.loadURL(url)` | ✅ | Queued until GJS host is ready |
| `win.loadFile(path)` | ✅ | Read as HTML, bridge script injected, sent as `LoadHTML` |
| `win.show()` | ✅ | `Window.present()` |
| `win.close()` | ✅ | Sends `Close` command to GJS host; cleans up FIFOs and kills GJS process; process exit is managed by the BrowserWindow close-event chain |
| `win.destroy()` | ✅ | Alias for `close()` |
| `win.focus()` | ✅ | `Window.present()` |
| `win.blur()` | ⚠️ | No-op + console warning; GNOME compositor controls focus |
| `win.minimize()` | ✅ | `Window.minimize()` |
| `win.maximize()` | ✅ | `Window.maximize()` |
| `win.unmaximize()` / `win.restore()` | ✅ | `Window.unmaximize()` |
| `win.setFullScreen(flag)` | ✅ | `Window.fullscreen()` / `Window.unfullscreen()` |
| `win.isFullScreen()` | ✅ | Tracks local state set by `setFullScreen()` |
| `win.setTitle(title)` | ✅ | `Window.set_title()` |
| `win.getTitle()` | ✅ | Round-trip query to GJS host |
| `win.setSize(w, h)` | ✅ | `Window.set_default_size()`; takes effect on next layout pass |
| `win.getSize()` | ✅ | `Window.get_width()` / `get_height()` — returns `[0,0]` before first show |
| `win.setPosition(x, y)` | ⚠️ | No-op + console warning; GTK4 removed `window.move()`, placement is WM-controlled |
| `win.getPosition()` | ⚠️ | Returns `[0, 0]` + console warning |
| `win.setOpacity(opacity)` | ⚠️ | No-op + console warning; `gtk_widget_set_opacity()` removed in GTK4 |
| `win.getOpacity()` | ⚠️ | Returns `1.0` + console warning |
| `win.setResizable(flag)` | ✅ | `Window.set_resizable()`; works at runtime |
| `win.isResizable()` | ✅ | Tracks local state (constructor default + `setResizable()` calls) |
| `win.setMinimizable(flag)` | ⚠️ | Logs warning; no reliable GTK4 API to hide minimize button |
| `win.isMinimizable()` | ✅ | Tracked in JS |
| `win.setMaximizable(flag)` | ✅ | `Window.set_resizable()` |
| `win.isMaximizable()` | ✅ | Tracked in JS |
| `win.setClosable(flag)` | ✅ | `Window.set_deletable()` |
| `win.isClosable()` | ✅ | Tracked in JS |
| `win.setMovable(flag)` | ✅ | `Window.set_decorated(false)` removes title bar, preventing drag |
| `win.isMovable()` | ✅ | Tracked in JS |
| `win.setSkipTaskbar(flag)` | ⚠️ | Logs warning; GTK4 removed urgency/taskbar hint APIs |
| `win.setAlwaysOnTop(flag)` | ✅ | `Window.set_keep_above()` |
| `win.center()` | ⚠️ | No-op + console warning; GTK4 removed `gtk_window_set_position()` |
| `win.flashFrame(flag)` | ⚠️ | Best-effort via `Gdk.Surface.set_urgency_hint()`; compositor support varies |
| `win.setBackgroundColor(color)` | ✅ | `WebKit.WebView.set_background_color(Gdk.RGBA)`; same format as `backgroundColor` constructor option |
| `win.setMenu(menu)` | ✅ | GTK4 `PopoverMenuBar`; menu items flattened and mapped to `Gio.SimpleAction` |
| `win.removeMenu()` | ✅ | Calls `setMenu([])` |
| `win.popupMenu(items, x?, y?)` | ✅ | `Gtk.PopoverMenu` with separate `popup` action group; positioned at explicit screen coordinates or cursor |
| `win.setMinimumSize(w, h)` | ✅ | `Window.set_size_request()` |
| `win.setMaximumSize(w, h)` | ⚠️ | No-op + console warning; GTK4 has no max-size API |
| `win.showOpenDialog(options)` | ✅ | `Gtk.FileChooserDialog`; synchronous via nested GLib main loop |
| `win.showSaveDialog(options)` | ✅ | Same |
| `win.showMessageBox(options)` | ✅ | `Gtk.AlertDialog`; synchronous via nested GLib main loop |
| `win.capturePage()` | ✅ | `webkit_web_view_get_snapshot` (VISIBLE region, PNG); nested GLib main loop; returns `NativeImage` |

### `win.webContents`

| API | Status | Notes |
|---|---|---|
| `win.webContents.send(channel, ...args)` | ✅ | Via `evaluate_javascript` / `window.__ipcDispatch` |
| `win.webContents.openDevTools()` | ✅ | WebKit inspector (requires `enable_developer_extras = true`) |
| `win.webContents.reload()` | ✅ | Sends `Reload` command to GJS host |
| `win.webContents.loadURL(url)` | ✅ | |
| `win.webContents.loadFile(path)` | ✅ | |
| `win.webContents.executeJavaScript(code)` | ✅ | Evaluates in renderer via `__ipcDispatch`; returns `Promise`; supports async expressions |
| `win.webContents.session` | ✅ | `clearCache()` clears Cache API entries; `clearStorageData()` clears localStorage/sessionStorage/indexedDB |
| `win.webContents.on('did-finish-load')` | ✅ | Emitted on WebKit `load-changed` (`FINISHED`) signal |

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
| `ipcRenderer.send(channel, ...args)` | ✅ | `window.webkit.messageHandlers.ipc.postMessage` |
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
| `shell.trashItem(path)` | ✅ | Delegates to `gio trash` |

---

## `Menu` / `MenuItem`

| API | Status | Notes |
|---|---|---|
| `Menu.buildFromTemplate(template)` | ✅ | |
| `new Menu()` / `menu.append()` / `menu.insert()` | ✅ | |
| `Menu.setApplicationMenu(menu)` | ✅ | Sets the default menu for all windows; `null` removes the menu bar |
| `menu.popup()` | ✅ | `Gtk.PopoverMenu`; call as `menu.popup({ window, x?, y? })` |
| `label`, `type`, `click`, `submenu`, `enabled`, `visible`, `checked`, `role` | ✅ | |
| `accelerator` | ✅ | Keyboard shortcuts enforced via `Gtk.ShortcutController` with `GLOBAL` scope |
| `toolTip`, `icon`, `id`, `sublabel` | ❌ | |

---

## Node.js Integration in Renderer (`nodeIntegration: true`)

| Feature | Status | Notes |
|---|---|---|
| `window.require(moduleName)` | ✅ | Sync XHR to local HTTP server; all Node.js built-ins work; npm packages in user's project not accessible |
| Callback arguments (e.g. `fs.readFile(path, cb)`) | ✅ | Serialized as `{__nww_cb: id}`; fired via SSE |
| Multi-fire callbacks (e.g. `fs.watch`, `EventEmitter.on`) | ✅ | Same SSE mechanism |
| Non-serializable return values (Buffer, FSWatcher, Stream, …) | ✅ | Stored in ref registry; renderer gets a Proxy |
| `window.process.platform` | ✅ | `'linux'` |
| `window.process.arch` | ✅ | Reflects actual `process.arch` from the main process |
| `window.process.version` | ✅ | Injected from main process |
| `window.process.env` | ✅ | Snapshot of `process.env` from the main process at window creation time |
| `window.process.cwd()` | ✅ | Injected from main process |
| `window.process.exit(code)` | ✅ | Sends IPC to main process |
| `import { x } from 'fs'` | ✅ | Importmap injected into `<head>`; works with `loadFile()` and `loadURL()` |

---

## Key Differences from Electron

1. **`window.require` uses synchronous XHR** to a loopback HTTP server (same mechanism as the `netfx-wpf` backend). All Node.js builtins work. SSE delivers callbacks, so `fs.watch`, `EventEmitter.on`, etc. fire correctly. npm packages in the user's project are not accessible (only Node.js builtins via `node:` scheme).

2. **`x`, `y`, `maxWidth`, `maxHeight` constructor options are ignored.** GTK window placement is managed by the window manager; GTK4 removed `window.move()`. GTK4 has no API for maximum window size. `minWidth`/`minHeight` are applied via `set_size_request()`.

3. **Preload scripts** are supported. Set `webPreferences.preload` to an absolute or relative path. The script is registered via `WebKit.UserContentManager.add_script()` so it fires on every page navigation before the page's own scripts.

4. **`webPreferences.partition` is ignored.** WebKitGTK uses a single default profile; per-window session isolation is not supported.

5. **WebKit sandbox is only disabled inside VMware.** The library reads `/sys/class/dmi/id/sys_vendor` at startup; if it contains `"vmware"`, `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1` is set for the GJS child process. On bare-metal and other hypervisors the sandbox runs normally.
