# Quick Start

This guide walks you through creating a node-with-window app from scratch using [nww-forge](https://www.npmjs.com/package/@devscholar/nww-forge).

## Prerequisites

### Windows
- Node.js 18+
- PowerShell 5.1 and .NET Framework 4.8 (pre-installed on Windows 10/11)
- WebView2 runtime (pre-installed on Windows 11; [download](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) for Windows 10)

### Linux
- Node.js 18+
- GJS, GTK 4, WebKitGTK 6.0

```bash
sudo apt install gjs gir1.2-gtk-4.0 gir1.2-webkit-6.0
```

## 1. Scaffold a new app

```bash
npx @devscholar/nww-forge init my-app
cd my-app
```

This creates the project directory, installs dependencies, and downloads WebView2 DLLs on Windows.

To use TypeScript instead:

```bash
npx @devscholar/nww-forge init my-app --template=vanilla-ts
```

## 2. Project structure

```
my-app/
├── forge.config.js   # nww-forge configuration
├── main.js           # main process entry point
├── preload.js        # preload script (contextBridge)
├── renderer.js       # renderer-side JavaScript
├── index.html        # app UI
├── style.css
└── package.json
```

## 3. Run in development

```bash
npm start
```

This runs `nww-forge start`, which executes `main.js` directly with Node.js.

## 4. Understanding the generated code

**`main.js`** — the main process, runs in Node.js:

```js
import { app, BrowserWindow, ipcMain } from '@devscholar/node-with-window';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.on('ready', () => {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));
});
```

**`preload.js`** — runs before the renderer, has access to `ipcRenderer`:

```js
const { contextBridge, ipcRenderer } = require('@devscholar/node-with-window');

contextBridge.exposeInMainWorld('api', {
  send:   (channel, ...args) => ipcRenderer.send(channel, ...args),
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on:     (channel, listener) => ipcRenderer.on(channel, listener),
});
```

**`renderer.js`** — runs in the browser context, uses only what `preload.js` exposed:

```js
window.api.send('ping', 'hello');
```

## 5. Package for distribution

```bash
npm run make
```

Output: `out/make/my-app-<version>-<platform>-<arch>.zip`

The zip contains a folder bundle with a `launch.bat` (Windows) or `launch.sh` (Linux) that runs the app with Node.js. The target machine must have Node.js installed.

## Next steps

- Edit `index.html` and `renderer.js` to build your UI
- Add `ipcMain.on` / `ipcMain.handle` handlers in `main.js`
- See the [Electron IPC docs](https://www.electronjs.org/docs/latest/tutorial/ipc) — the API is the same
- See [node-with-window-examples](https://github.com/devscholar/node-with-window-examples) for more complete examples
