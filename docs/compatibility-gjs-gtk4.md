# Electron API Compatibility — `gjs-gtk4` Backend

**Platform:** Linux
**Stack:** GTK 4 + WebKitGTK 6 (WebKit2GTK)
**Bridge:** GJS host process (`scripts/linux/host.js`) spawned as a child; Node.js communicates over two Unix FIFOs at 16 ms poll intervals.

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
| `minWidth`, `minHeight` | ❌ | Not forwarded to GTK |
| `maxWidth`, `maxHeight` | ❌ | Not forwarded to GTK |
| `movable`, `minimizable`, `maximizable`, `closable` | ⚠️ | Accepted, not applied |
| `transparent`, `frame`, `kiosk` | ⚠️ | Accepted, not applied |
| `skipTaskbar` | ⚠️ | Accepted, not applied |
| `fullscreen` | ✅ | `Window.fullscreen()` called at creation |
| `backgroundColor` | ❌ | |
| `parent`, `modal` | ❌ | No child window support |
| `titleBarStyle` | ❌ | |

### `webPreferences`

| Option | Status | Notes |
|---|---|---|
| `nodeIntegration` | ⚠️ | Injects stub `window.require` — calls log a warning and return `null`. Use `ipcMain`/`ipcRenderer` for all Node.js access on Linux. |
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
| `win.close()` | ✅ | Sends `Close` command to GJS host; cleans up FIFOs; exits process |
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
| `win.setAlwaysOnTop(flag)` | ✅ | `Window.set_keep_above()` |
| `win.center()` | ⚠️ | No-op + console warning; GTK4 removed `gtk_window_set_position()` |
| `win.flashFrame(flag)` | ⚠️ | No-op + console warning |
| `win.setMenu(menu)` | ✅ | GTK4 `PopoverMenuBar`; menu items flattened and mapped to `Gio.SimpleAction` |
| `win.removeMenu()` | ✅ | Calls `setMenu([])` |
| `win.showOpenDialog(options)` | ✅ | `Gtk.FileChooserDialog`; synchronous via nested GLib main loop |
| `win.showSaveDialog(options)` | ✅ | Same |
| `win.showMessageBox(options)` | ✅ | `Gtk.AlertDialog`; synchronous via nested GLib main loop |
| `win.capturePage()` | ❌ | |

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
| `shell.trashItem()` | ❌ | |

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

> **Linux limitation:** `window.require` on GTK4/WebKit is stub-only. All calls log a console warning and return `null`. The underlying sync XHR mechanism used on Windows does not work with WebKitGTK (no synchronous XHR to loopback, no SSE buffering during XHR block).

Use `ipcMain.handle` + `ipcRenderer.invoke` for all Node.js access from the renderer on Linux:

```js
// main process
import * as fs from 'node:fs';
ipcMain.handle('read-file', (_event, path) => fs.readFileSync(path, 'utf-8'));

// renderer (works on both Windows and Linux)
const content = await ipcRenderer.invoke('read-file', '/path/to/file');
```

| Feature | Status | Notes |
|---|---|---|
| `window.require('fs')` | ✅ | Full sync-XHR bridge; all Node.js builtins accessible |
| `window.require('path')` | ✅ | Full sync-XHR bridge |
| `window.require('os')` | ✅ | Full sync-XHR bridge |
| `window.process.platform` | ✅ | `'linux'` |
| `window.process.arch` | ✅ | `'x64'` |
| `window.process.version` | ✅ | Injected from main process |
| `window.process.env` | ✅ | Snapshot of `process.env` from the main process at window creation time |
| `window.process.cwd()` | ✅ | Injected from main process |
| `window.process.exit(code)` | ✅ | Sends IPC to main process |
| `import { x } from 'fs'` | ✅ | Standard static ESM import; works with both `loadFile()` and `loadURL()` |

---

## Key Differences from Electron

1. **`window.require` uses synchronous XHR** to a loopback HTTP server (same mechanism as the `netfx-wpf` backend). All Node.js builtins work. SSE delivers callbacks, so `fs.watch`, `EventEmitter.on`, etc. fire correctly. npm packages in the user's project are not accessible (only Node.js builtins via `node:` scheme).

2. **`x`, `y`, `minWidth`, `minHeight`, `maxWidth`, `maxHeight` constructor options are ignored.** GTK window placement is managed by the window manager; GTK4 removed `window.move()`.

3. **Preload scripts** are supported. Set `webPreferences.preload` to an absolute or relative path. The script is registered via `WebKit.UserContentManager.add_script()` so it fires on every page navigation before the page's own scripts.

4. **`ipcMain.on()` is absent.** Use `ipcMain.handle()` for all renderer→main communication.

5. **`Menu.setApplicationMenu()` is absent.** Use `win.setMenu(menu)` on the `BrowserWindow` instance.

6. **`webPreferences.partition` is ignored.** WebKitGTK uses a single default profile; per-window session isolation is not supported.

7. **WebKit sandbox is only disabled inside VMware.** The library reads `/sys/class/dmi/id/sys_vendor` at startup; if it contains `"vmware"`, `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1` is set for the GJS child process. On bare-metal and other hypervisors the sandbox runs normally.
