# Node with Window

⚠️ This project is still in pre-alpha stage, expect breaking changes.

A cross-platform windowing library for Node.js/Deno/Bun with an Electron-compatible API. Uses [node-ps1-dotnet](https://github.com/DevScholar/node-ps1-dotnet) (WPF + WebView2) on Windows and [node-with-gjs](https://github.com/DevScholar/node-with-gjs) (GTK + WebKitGTK) on Linux.

![WPF Notepad Screenshot](./screenshots/wpf-notepad.png)

![GTK Notepad Screenshot](./screenshots/gtk-notepad.png)



## Prerequisites

### Windows

- Node.js 18+
- PowerShell 5.1
- .NET Framework 4.8
- **WebView2 runtime** (pre-installed on Windows 11; install from [Microsoft](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) on Windows 10)
- WebView2 SDK DLLs in `runtimes/webview2/`:
  - `Microsoft.Web.WebView2.Core.dll`
  - `Microsoft.Web.WebView2.Wpf.dll`

  Install via the parent project's install script:
  ```
  node ../node-ps1-dotnet/scripts/webview2-install.js install
  ```
  Then copy or symlink the resulting DLLs into `runtimes/webview2/`.

### Linux

- Node.js 18+
- GJS (GNOME JavaScript runtime)
- GTK 4
- WebKitGTK 6.0

These are typically pre-installed on Ubuntu 24.04 LTS / GNOME desktops. If missing:

```bash
sudo apt install gjs gir1.2-gtk-4.0 gir1.2-webkit2-6.0
```

#### WebKit sandbox in virtual machines

When running inside a VMware (or similar) virtual machine, WebKitGTK's bubblewrap
sandbox may fail with `Permission denied` because the VM kernel restricts
unprivileged user namespaces:

```
bwrap: setting up uid map: Permission denied
Failed to fully launch dbus-proxy
```

`node-with-window` detects VMware at startup by reading `/sys/class/dmi/id/sys_vendor`.
When running inside VMware, `WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1` is set
automatically when spawning the GJS host, suppressing this error.
On bare-metal or other hypervisors the WebKit sandbox runs normally.
If you hit this error in another environment (e.g. a container or a different VM),
enable user namespaces instead:

```bash
sudo sysctl -w kernel.unprivileged_userns_clone=1
# To persist across reboots:
echo 'kernel.unprivileged_userns_clone=1' | sudo tee /etc/sysctl.d/99-userns.conf
```

## Install

```bash
npm install
```

## Examples

See [node-with-window-examples](https://github.com/devscholar/node-with-window-examples).

### Windows

```bash
cd ../node-with-window-examples
npm install
npm run notepad
```

### Linux

If you are copying files from another machine (e.g. a Windows shared folder into a VM),
do a clean install to avoid stale platform-specific binaries:

```bash
cd ../node-with-window-examples
rm -rf dist node_modules
npm install
```

`npm install` triggers a `postinstall` script that compiles
`@devscholar/node-with-gjs` (used internally) from its TypeScript source using
the bundled esbuild.

Then run:

```bash
npm run notepad
```

The WebKit sandbox is disabled automatically by the library (see
[WebKit sandbox in virtual machines](#webkit-sandbox-in-virtual-machines)).

## API

The API mirrors [Electron](https://www.electronjs.org/docs/latest/) — replace
`import ... from 'electron'` with `import ... from '@devscholar/node-with-window'`.

## Writing your own app

1. Create a new project and install `node-with-window`:

```bash
mkdir myapp
cd myapp
npm init -y
npm install /path/to/node-with-window
```

2. Create `main.ts`:

```typescript
import { app, BrowserWindow, ipcMain } from 'node-with-window';
import * as path from 'node:path';
import * as url from 'node:url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

app.whenReady().then(() => {
    ipcMain.handle('greet', (event, name: string) => `Hello, ${name}!`);

    const win = new BrowserWindow({ 
        title: 'My App', 
        width: 600, 
        height: 400,
        webPreferences: {
            nodeIntegration: true
        }
    });
    win.loadFile(path.join(__dirname, 'index.html'));
    win.show();
});
```

3. Create `index.html` (no need to add the bridge script manually):

```html
<!DOCTYPE html>
<html>
<body>
    <div id="output">Loading...</div>
    <script>
        // Use Node.js APIs directly when nodeIntegration is enabled
        const fs = require('fs');
        const path = require('path');
        
        window.ipcRenderer.invoke('greet', 'world').then(msg => {
            document.getElementById('output').textContent = msg;
        });
        
        console.log('Current directory:', process.cwd());
    </script>
</body>
</html>
```

4. Run using the start.js helper:

```bash
node /path/to/node-with-window/start.js main.ts
```

## Developing

This library depends on [node-ps1-dotnet](https://github.com/DevScholar/node-ps1-dotnet) (Windows) and
[node-with-gjs](https://github.com/DevScholar/node-with-gjs) (Linux), both installed as `file:` symlinks in
`node_modules` (non-NPM versions of Node with Window only). After changing either dependency, rebuild in order.
```

The script builds `node-ps1-dotnet` then `node-with-window`. Because
`node-with-window-examples` resolves both via `file:` symlinks, no copy step
is needed — the rebuilt `dist/` is picked up immediately.

If you only changed `node-with-window` itself:

```bash
cd node-with-window && npm run build
```

## How it works

### Windows (WPF + WebView2)

- The main process communicates with a PowerShell-hosted .NET runtime over a Windows Named Pipe via the [node-ps1-dotnet](../node-ps1-dotnet) bridge
- `show()` sends a `StartApplication` command to the .NET host, which immediately acknowledges and then calls `Application.Run(window)` — blocking the .NET thread in the WPF message loop without blocking the Node.js event loop
- Node.js polls for events every 16 ms with a `Poll` command that drains a thread-safe queue. WPF event handlers (like `WebMessageReceived`) enqueue their payload instead of blocking on synchronous IPC, so `async ipcMain.handle()` callbacks work normally
- When `loadFile` is called before `show()`, the HTML is read, the `ipcRenderer` bridge is injected into `<head>`, and the modified HTML is written to a temp file. `webView.Source` is set to this temp file URL before `Application.Run()` — identical to the one-navigation pattern in the reference [`webview2-browser.ts`](../node-ps1-dotnet-examples/src/wpf/webview2-browser/webview2-browser.ts) example
- The `WebMessageReceived` handler enqueues the raw JSON payload. The next `Poll` delivers it to Node.js, which dispatches it to the registered `ipcMain` handler and sends the reply via `PostWebMessageAsString`
- Node integration uses `NODE_WITH_WINDOW:` prefixed messages via `chrome.webview.postMessage()` to provide access to Node.js APIs in the renderer

### Linux (GJS + GTK 4 + WebKitGTK)

- `GjsGtk4Window` spawns a dedicated GJS script (`scripts/linux/host.js`) as a child process.
  The host script runs the GTK 4 main loop (`GLib.MainLoop`) and owns the `Gtk.Window` + `WebKit.WebView`.
- Node.js and the GJS host communicate over two Unix FIFOs (passed as fd 3 and fd 4) using
  a synchronous newline-delimited JSON request/response protocol — the same as the Windows pipe bridge.
- **WebKit → Node.js IPC:** the HTML renderer posts messages via
  `window.webkit.messageHandlers.ipc.postMessage(json)`. The GJS host queues them.
  Node.js drains the queue every 16 ms with a `Poll` command.
- **Node.js → WebKit IPC:** replies and push messages are delivered by sending a
  `SendToRenderer` command, which calls `webView.evaluate_javascript()` in GJS.
- Async `ipcMain.handle()` handlers are fully supported (the Node.js event loop stays alive
  between polls).
- File/message dialogs are implemented natively with `Gtk.FileChooserDialog` /
  `Gtk.MessageDialog` using a nested `GLib.MainContext.iteration()` loop for synchronous
  behaviour without blocking IPC.
