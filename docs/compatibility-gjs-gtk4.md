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
| `app.exit()` | ❌ | Use `process.exit()` |
| `app.relaunch()` | ❌ | |
| `app.focus()` | ❌ | |
| `app.setName()` / `app.setPath()` | ❌ | |
| `app.getLocale()` | ❌ | |
| `app.requestSingleInstanceLock()` | ❌ | |
| `app.dock` | ❌ | macOS only |
| Event: `activate` | ❌ | macOS only |
| Event: `second-instance` | ❌ | |

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
| `x`, `y` | ❌ | Not forwarded to GTK |
| `minWidth`, `minHeight` | ❌ | Not forwarded to GTK |
| `maxWidth`, `maxHeight` | ❌ | Not forwarded to GTK |
| `movable`, `minimizable`, `maximizable`, `closable` | ⚠️ | Accepted, not applied |
| `transparent`, `frame`, `kiosk` | ⚠️ | Accepted, not applied |
| `skipTaskbar`, `fullscreen` | ⚠️ | Accepted, not applied |
| `backgroundColor` | ❌ | |
| `parent`, `modal` | ❌ | No child window support |
| `titleBarStyle` | ❌ | |

### `webPreferences`

| Option | Status | Notes |
|---|---|---|
| `nodeIntegration` | ⚠️ | Injects stub `window.require` — calls log a warning and return `null`. Use `ipcMain`/`ipcRenderer` for all Node.js access on Linux. |
| `contextIsolation` | ✅ | `false` (default) injects `window.ipcRenderer` |
| `partition` | ⚠️ | Accepted, not applied — WebKitGTK uses a default profile |
| `preload` | ❌ | No preload script support |
| `sandbox` | ⚠️ | Accepted, no effect |
| `webSecurity` | ⚠️ | Accepted, no effect |

### Static Methods

| API | Status | Notes |
|---|---|---|
| `new BrowserWindow(options)` | ✅ | Electron-compatible synchronous constructor |
| `BrowserWindow.getAllWindows()` | ✅ | |
| `BrowserWindow.getFocusedWindow()` | ✅ | Returns first open window |
| `BrowserWindow.fromId(id)` | ❌ | |
| `BrowserWindow.fromWebContents(wc)` | ❌ | |

### Instance Methods

| API | Status | Notes |
|---|---|---|
| `win.loadURL(url)` | ✅ | Queued until GJS host is ready |
| `win.loadFile(path)` | ✅ | Read as HTML, bridge script injected, sent as `LoadHTML` |
| `win.show()` | ✅ | `Window.present()` |
| `win.close()` | ✅ | Sends `Close` command to GJS host; cleans up FIFOs; exits process |
| `win.destroy()` | ✅ | Alias for `close()` |
| `win.focus()` | ❌ | Not implemented |
| `win.blur()` | ❌ | Not implemented |
| `win.minimize()` | ❌ | Not implemented |
| `win.maximize()` | ❌ | Not implemented |
| `win.unmaximize()` / `win.restore()` | ❌ | Not implemented |
| `win.setFullScreen(flag)` | ❌ | Not implemented |
| `win.isFullScreen()` | ❌ | Not implemented |
| `win.setTitle(title)` | ❌ | Not implemented |
| `win.getTitle()` | ❌ | Not implemented |
| `win.setSize(w, h)` | ❌ | Not implemented |
| `win.getSize()` | ❌ | Not implemented |
| `win.setPosition(x, y)` | ❌ | Not implemented |
| `win.getPosition()` | ❌ | Not implemented |
| `win.setOpacity(opacity)` | ❌ | Not implemented |
| `win.getOpacity()` | ❌ | Not implemented |
| `win.setResizable(flag)` | ❌ | Not implemented at runtime (only constructor option) |
| `win.isResizable()` | ❌ | Not implemented |
| `win.setAlwaysOnTop(flag)` | ❌ | Not implemented at runtime (only constructor option) |
| `win.center()` | ❌ | Not implemented |
| `win.flashFrame(flag)` | ❌ | Not implemented |
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
| `win.webContents.executeJavaScript()` | ❌ | |
| `win.webContents.session` | ❌ | |
| `win.webContents.on('did-finish-load')` | ❌ | |

---

## `ipcMain`

| API | Status | Notes |
|---|---|---|
| `ipcMain.handle(channel, listener)` | ✅ | Sync and async handlers both supported |
| `ipcMain.handleOnce(channel, listener)` | ✅ | |
| `ipcMain.removeHandler(channel)` | ✅ | |
| `ipcMain.on(channel, listener)` | ❌ | Use `handle()` and return `undefined` for fire-and-forget |
| `ipcMain.once(channel, listener)` | ❌ | Use `handleOnce()` |
| `event.returnValue` (sync IPC) | ❌ | |
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
| `ipcRenderer.sendSync()` | ❌ | |

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
| `Menu.setApplicationMenu(menu)` | ❌ | Use `win.setMenu(menu)` |
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
| `window.require('fs')` | ⚠️ | Stub — logs warning, returns `null` |
| `window.require('path')` | ⚠️ | Stub — logs warning, returns `null` |
| `window.require('os')` | ⚠️ | Partial — `platform()` and `arch()` work; all other methods are stubs |
| `window.process.platform` | ✅ | `'linux'` |
| `window.process.arch` | ✅ | `'x64'` |
| `window.process.version` | ✅ | Injected from main process |
| `window.process.env` | ⚠️ | Always `{}` |
| `window.process.cwd()` | ✅ | Injected from main process |
| `window.process.exit(code)` | ✅ | Sends IPC to main process |

---

## Key Differences from Electron

1. **`window.require` is not functional.** Only stubs are injected. All Node.js access from the renderer must go through `ipcMain.handle` + `ipcRenderer.invoke`.

2. **Many `BrowserWindow` window-state methods are not implemented.** `minimize`, `maximize`, `setFullScreen`, `setTitle`, `setSize`, `setPosition`, `setOpacity`, `setResizable`, `setAlwaysOnTop`, `center`, `flashFrame`, `focus`, `blur` all have no effect. Implement them via GJS host commands if needed.

3. **`x`, `y`, `minWidth`, `minHeight`, `maxWidth`, `maxHeight` constructor options are ignored.** GTK window placement is managed by the window manager.

4. **No preload scripts.** The IPC bridge is injected by prepending a `<script>` tag to the HTML source. There is no `webPreferences.preload` path.

5. **`ipcMain.on()` is absent.** Use `ipcMain.handle()` for all renderer→main communication.

6. **`Menu.setApplicationMenu()` is absent.** Use `win.setMenu(menu)` on the `BrowserWindow` instance.

7. **`webPreferences.partition` is ignored.** WebKitGTK uses a single default profile; per-window session isolation is not supported.

8. **WebKit sandbox must be disabled.** The GJS host sets `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1` at spawn time. This is a known limitation of embedding WebKitGTK outside its default sandbox environment.
