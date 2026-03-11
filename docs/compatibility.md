# Electron API Compatibility

This document tracks which Electron APIs are implemented in `node-with-window`, which are partially supported, and which are absent. The goal is to serve as a migration guide for apps moving from Electron, and as a feature roadmap.

---

## Platform Support

| Platform | Backend | Status |
|---|---|---|
| Windows | WPF + WebView2 | ✅ Supported |
| Linux | GJS + GTK4 + WebKit2GTK | ✅ Supported |
| macOS | — | ❌ Not implemented |

---

## `app`

### Supported

| API | Notes |
|---|---|
| `app.whenReady()` | ✅ |
| `app.isReady()` | ✅ |
| `app.getName()` | ✅ Reads from `package.json` |
| `app.getVersion()` | ✅ Reads from `package.json` |
| `app.getPath(name)` | ✅ Supports: `home`, `temp`, `desktop`, `downloads`, `documents`, `music`, `pictures`, `videos`, `appData`, `userData`, `logs`, `exe`, `module` |
| `app.quit()` | ✅ Emits `before-quit`, then exits |
| Event: `ready` | ✅ |
| Event: `before-quit` | ✅ |
| Event: `window-all-closed` | ✅ |

### Not Implemented

| API | Notes |
|---|---|
| `app.exit([exitCode])` | Use `process.exit()` directly |
| `app.relaunch()` | — |
| `app.focus()` | — |
| `app.setName(name)` | — |
| `app.setPath(name, path)` | — |
| `app.getLocale()` | — |
| `app.getLocaleCountryCode()` | — |
| `app.requestSingleInstanceLock()` | — |
| `app.addRecentDocument()` | — |
| `app.clearRecentDocuments()` | — |
| `app.setAppUserModelId()` | Windows-specific, not implemented |
| `app.setBadgeCount()` | — |
| `app.dock` | macOS only |
| `app.commandLine` | — |
| Event: `activate` | macOS only |
| Event: `second-instance` | — |
| Event: `open-file` | macOS only |
| Event: `open-url` | macOS only |

---

## `BrowserWindow`

### Constructor Options

| Option | Status | Notes |
|---|---|---|
| `width`, `height` | ✅ | |
| `minWidth`, `minHeight` | ✅ | |
| `maxWidth`, `maxHeight` | ✅ | |
| `title` | ✅ | |
| `icon` | ✅ | Path to image file |
| `resizable` | ✅ | Passed to backend |
| `show` | ✅ | |
| `webPreferences` | ✅ | See WebPreferences section |
| `x`, `y` | ⚠️ Accepted but not applied | Backend support varies |
| `movable`, `minimizable`, `maximizable`, `closable` | ⚠️ Accepted but not applied | — |
| `transparent`, `frame`, `kiosk` | ⚠️ Accepted but not applied | — |
| `alwaysOnTop`, `skipTaskbar` | ⚠️ Accepted but not applied | — |
| `fullscreen` | ⚠️ Accepted but not applied | — |
| `backgroundColor` | ❌ | — |
| `parent` | ❌ | No child window support |
| `modal` | ❌ | — |
| `titleBarStyle` | ❌ | — |
| `trafficLightPosition` | ❌ | macOS only |
| `vibrancy` | ❌ | macOS only |

### `WebPreferences`

| Option | Status | Notes |
|---|---|---|
| `nodeIntegration` | ✅ | Enables `window.requireAsync`, `window.process` |
| `contextIsolation` | ✅ | When `false`, `window.ipcRenderer` is injected |
| `partition` | ✅ | `persist:<name>` or `temp:` |
| `preload` | ❌ | Use `nodeIntegration` + `ipcMain`/`ipcRenderer` instead |
| `sandbox` | ⚠️ Accepted, no effect | Always sandboxed |
| `webSecurity` | ⚠️ Accepted, no effect | — |

### Static Methods

| API | Status | Notes |
|---|---|---|
| `BrowserWindow.create(options)` | ✅ | **node-with-window specific** — async factory, preferred over `new` |
| `BrowserWindow.getAllWindows()` | ✅ | |
| `BrowserWindow.getFocusedWindow()` | ✅ | Returns first open window |
| `BrowserWindow.fromId(id)` | ❌ | — |
| `BrowserWindow.fromWebContents(wc)` | ❌ | No `webContents` object |

### Instance Methods

| API | Status | Notes |
|---|---|---|
| `win.loadURL(url)` | ✅ | |
| `win.loadFile(path)` | ✅ | |
| `win.show()` | ✅ | |
| `win.close()` | ✅ | |
| `win.reload()` | ✅ | |
| `win.openDevTools()` | ✅ | Opens DevTools panel |
| `win.setMenu(menu)` | ✅ | Accepts `Menu` instance or raw `MenuItemOptions[]` |
| `win.removeMenu()` | ✅ | |
| `win.send(channel, ...args)` | ✅ | Equivalent of `webContents.send()` in Electron |
| `win.showOpenDialog(options)` | ✅ | Synchronous internally; returns `string[] \| undefined` |
| `win.showSaveDialog(options)` | ✅ | Returns `string \| undefined` |
| `win.showMessageBox(options)` | ✅ | Returns button index |
| `win.destroy()` | ❌ | Use `win.close()` |
| `win.focus()` / `win.blur()` | ❌ | — |
| `win.minimize()` / `win.maximize()` | ❌ | — |
| `win.unmaximize()` / `win.restore()` | ❌ | — |
| `win.setFullScreen()` / `win.isFullScreen()` | ❌ | — |
| `win.setTitle(title)` / `win.getTitle()` | ❌ | Title updates automatically from `document.title` |
| `win.setSize()` / `win.getSize()` | ❌ | — |
| `win.setPosition()` / `win.getPosition()` | ❌ | — |
| `win.setOpacity()` / `win.getOpacity()` | ❌ | — |
| `win.setResizable()` / `win.isResizable()` | ❌ | — |
| `win.setAlwaysOnTop()` | ❌ | — |
| `win.center()` | ❌ | Window is centered on startup by default |
| `win.flashFrame()` | ❌ | — |
| `win.capturePage()` | ❌ | — |

### `webContents`

In Electron, `win.webContents` is a separate object with its own API. In node-with-window, there is no `webContents` property. Use the `BrowserWindow` instance directly:

| Electron | node-with-window equivalent |
|---|---|
| `win.webContents.send(channel, ...args)` | `win.send(channel, ...args)` |
| `win.webContents.openDevTools()` | `win.openDevTools()` |
| `win.webContents.reload()` | `win.reload()` |
| `win.webContents.loadURL(url)` | `win.loadURL(url)` |
| `win.webContents.loadFile(path)` | `win.loadFile(path)` |
| `win.webContents.executeJavaScript()` | ❌ Not implemented |
| `win.webContents.session` | ❌ Not implemented |
| `win.webContents.on('did-finish-load')` | ❌ Not implemented |

---

## `ipcMain`

### Supported

| API | Status | Notes |
|---|---|---|
| `ipcMain.handle(channel, listener)` | ✅ | Async request-response handler |
| `ipcMain.handleOnce(channel, listener)` | ✅ | One-time handler |
| `ipcMain.removeHandler(channel)` | ✅ | |

### Not Implemented / Different Behavior

| Electron API | Status | Notes |
|---|---|---|
| `ipcMain.on(channel, listener)` | ❌ | For fire-and-forget from renderer, use `handle()` and ignore the return value |
| `ipcMain.once(channel, listener)` | ❌ | Use `handleOnce()` |
| `ipcMain.removeListener(channel, listener)` | ❌ | Use `removeHandler()` |
| `ipcMain.removeAllListeners(channel)` | ❌ | — |
| `event.returnValue` (sync IPC) | ❌ | Synchronous IPC is not supported; all IPC is async |
| `event.reply(channel, ...args)` | ✅ | Available on the event object passed to `handle()` |
| `event.senderFrame` | ❌ | — |

---

## `ipcRenderer` (renderer-side, injected when `contextIsolation: false`)

### Supported

| API | Status | Notes |
|---|---|---|
| `ipcRenderer.send(channel, ...args)` | ✅ | Fire-and-forget to main process |
| `ipcRenderer.invoke(channel, ...args)` | ✅ | Returns `Promise` for request-response |
| `ipcRenderer.on(channel, listener)` | ✅ | Listen for messages from main |
| `ipcRenderer.once(channel, listener)` | ✅ | One-time listener |
| `ipcRenderer.off(channel, listener)` | ✅ | Remove listener |
| `ipcRenderer.removeListener(channel, listener)` | ✅ | Alias for `off()` |

### Not Implemented

| API | Status | Notes |
|---|---|---|
| `ipcRenderer.sendSync(channel, ...args)` | ❌ | Synchronous IPC is not feasible in WebView2/WebKit; use `invoke()` |
| `ipcRenderer.sendToHost(channel, ...args)` | ❌ | — |
| `ipcRenderer.postMessage(channel, message, transfer)` | ❌ | — |

### Availability

`ipcRenderer` is injected into the page's global scope when `contextIsolation: false` (the default). There is no preload script mechanism. If `contextIsolation: true`, no bridge is injected.

---

## `dialog`

All dialog methods accept an optional `BrowserWindow` as the first argument (Electron-compatible), or just the options object.

| API | Status | Notes |
|---|---|---|
| `dialog.showOpenDialog([win,] options)` | ✅ | Returns `{ canceled, filePaths }` |
| `dialog.showSaveDialog([win,] options)` | ✅ | Returns `{ canceled, filePath }` |
| `dialog.showMessageBox([win,] options)` | ✅ | Returns `{ response }` (button index) |
| `dialog.showErrorBox(title, content)` | ✅ | |
| `dialog.showCertificateTrustDialog()` | ❌ | macOS only |

### `showOpenDialog` Options

| Option | Status |
|---|---|
| `title` | ✅ |
| `defaultPath` | ✅ |
| `filters` | ✅ |
| `properties` (`openFile`, `openDirectory`, `multiSelections`) | ✅ |
| `properties` (`showHiddenFiles`, `createDirectory`, `promptToCreate`) | ⚠️ Passed to backend, support varies |
| `message` | ✅ (macOS sheet text) |
| `buttonLabel` | ⚠️ Passed to backend |

### `showMessageBox` Options

| Option | Status |
|---|---|
| `type` (`none`, `info`, `error`, `question`, `warning`) | ✅ |
| `title` | ✅ |
| `message` | ✅ |
| `buttons` | ✅ |
| `defaultId` | ❌ |
| `cancelId` | ❌ |
| `checkboxLabel` / `checkboxChecked` | ❌ |
| `noLink` | ❌ |

---

## `shell`

| API | Status | Notes |
|---|---|---|
| `shell.openExternal(url)` | ✅ | |
| `shell.openPath(filePath)` | ✅ | |
| `shell.showItemInFolder(filePath)` | ✅ | |
| `shell.beep()` | ✅ | Writes `\x07` to stdout |
| `shell.trashItem(path)` | ❌ | — |
| `shell.readShortcutLink(path)` | ❌ | Windows only |
| `shell.writeShortcutLink(path, ...)` | ❌ | Windows only |

---

## `Menu` and `MenuItem`

### `Menu`

| API | Status | Notes |
|---|---|---|
| `Menu.buildFromTemplate(template)` | ✅ | |
| `new Menu()` | ✅ | |
| `menu.append(item)` | ✅ | |
| `menu.insert(pos, item)` | ✅ | |
| `menu.items()` | ✅ | Returns `MenuItemOptions[]` |
| `Menu.setApplicationMenu(menu)` | ❌ | Use `win.setMenu(menu)` instead |
| `Menu.getApplicationMenu()` | ❌ | — |
| `menu.popup([options])` | ❌ | Context menus not implemented |
| `menu.closePopup([win])` | ❌ | — |
| `menu.getMenuItemById(id)` | ❌ | — |

### `MenuItem` Options

| Option | Status |
|---|---|
| `label` | ✅ |
| `type` (`normal`, `separator`, `submenu`, `checkbox`, `radio`) | ✅ |
| `click` | ✅ |
| `submenu` | ✅ |
| `enabled` | ✅ |
| `visible` | ✅ |
| `checked` | ✅ |
| `accelerator` | ✅ (displayed; keyboard shortcuts not enforced natively) |
| `role` | ✅ (stored; not automatically wired to platform commands) |
| `id` | ❌ |
| `icon` | ❌ |
| `sublabel` | ❌ |
| `toolTip` | ❌ |
| `before` / `after` / `beforeGroupContaining` / `afterGroupContaining` | ❌ |

---

## Node.js Integration in Renderer

Electron's `nodeIntegration: true` gives the renderer process full access to Node.js modules. This is not possible in node-with-window because the renderer runs inside WebView2 or WebKit, which are separate processes with no Node.js runtime.

| Feature | Status | Notes |
|---|---|---|
| `window.require('fs')` | ⚠️ Stub only | Returns stub object that warns on use; does not call Node.js |
| `window.require('path')` | ⚠️ Stub only | Same as above |
| `window.require('os')` | ⚠️ Stub only | Same as above |
| `window.requireAsync('fs')` | ✅ | **node-with-window specific** — proxy that routes calls to main process via IPC |
| `window.process.platform` | ✅ | `'win32'` or `'linux'` |
| `window.process.arch` | ✅ | `'x64'` |
| `window.process.version` | ✅ | Injected from main process |
| `window.process.env` | ⚠️ | Always empty `{}`; env vars are not forwarded to renderer |
| `window.process.cwd()` | ✅ | Injected from main process |
| `window.process.exit(code)` | ✅ | Sends IPC to main process |
| Full Node.js module access | ❌ | Architectural limitation; use `ipcMain.handle()` + `ipcRenderer.invoke()` |

### Migration Pattern

Replace direct `fs` calls in the renderer:

```js
// Electron (nodeIntegration: true)
const fs = require('fs');
const content = fs.readFileSync(path, 'utf-8');

// node-with-window
const content = await window.requireAsync('fs').readFileSync(path, 'utf-8');
```

Or route through explicit IPC:

```js
// main process
ipcMain.handle('read-file', (event, path) => fs.readFileSync(path, 'utf-8'));

// renderer
const content = await ipcRenderer.invoke('read-file', path);
```

---

## Major Electron APIs Not Implemented

| Module | Notes |
|---|---|
| `Tray` | System tray icons |
| `Notification` | Native desktop notifications |
| `clipboard` | Read/write clipboard |
| `globalShortcut` | Register global keyboard shortcuts |
| `nativeTheme` | Dark/light mode detection |
| `screen` | Display metrics, multi-monitor |
| `powerMonitor` | System power events |
| `powerSaveBlocker` | Prevent sleep |
| `protocol` | Custom URL schemes |
| `session` | Cookie storage, cache, proxy |
| `net` / `net.request` | Electron's HTTP client |
| `BrowserView` | Embedded views within a window |
| `webContents` | Separate object; use `BrowserWindow` directly |
| `contentTracing` | Performance tracing |
| `desktopCapturer` | Screen/window capture |
| `autoUpdater` | — |
| `crashReporter` | — |
| `nativeImage` | — |
| `safeStorage` | — |
| `systemPreferences` | macOS only |
| `TouchBar` | macOS only |

---

## Key Differences from Electron

1. **`BrowserWindow.create()` is async.** In Electron, `new BrowserWindow()` is synchronous. In node-with-window, always `await BrowserWindow.create(options)`.

2. **No `webContents` object.** Methods like `send()`, `reload()`, `openDevTools()` are directly on the `BrowserWindow` instance.

3. **No preload scripts.** The IPC bridge is injected automatically via `AddScriptToExecuteOnDocumentCreatedAsync` (Windows) or the WebKit equivalent. There is no custom preload path.

4. **`ipcMain.on()` is absent.** Use `ipcMain.handle()` for all IPC from the renderer. For fire-and-forget semantics, handle the message and return `undefined`.

5. **`window.requireAsync()` instead of `window.require()`.** Real Node.js module access from the renderer requires async IPC; `window.require()` only returns stubs.

6. **Dialogs are synchronous internally.** The `dialog.*` API returns Promises for Electron compatibility, but the underlying platform dialog blocks until the user responds.

7. **`Menu.setApplicationMenu()` is absent.** Call `win.setMenu(menu)` on the specific `BrowserWindow` instead.
