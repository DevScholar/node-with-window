# Node with Window

> ⚠️ Alpha — expect breaking changes.

A cross-platform windowing library for Node.js with an Electron-compatible API.
Uses WPF + WebView2 on Windows and GTK 4 + WebKitGTK on Linux.

![WPF Notepad Screenshot](./screenshots/wpf-notepad.png)

![GTK Notepad Screenshot](./screenshots/gtk-notepad.png)

## Install

```bash
npm install @devscholar/node-with-window
```

On Windows, also download the WebView2 SDK DLLs:

```bash
node node_modules/@devscholar/node-with-window/scripts/webview2-install.js install
```

## Quick start

Use [nww-forge](https://www.npmjs.com/package/@devscholar/nww-forge) to scaffold a new app:

```bash
npx @devscholar/nww-forge init my-app
cd my-app
npm start
```

See [docs/quick-start.md](./docs/quick-start.md) for a step-by-step guide.

## Prerequisites

### Windows

- Node.js 18+
- PowerShell 5.1
- .NET Framework 4.8
- **WebView2 runtime** (pre-installed on Windows 11; install from [Microsoft](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) on Windows 10)

### Linux

- Node.js 18+
- GJS (GNOME JavaScript runtime)
- GTK 4
- WebKitGTK 6.0

These are typically pre-installed on Ubuntu 24.04 LTS / GNOME desktops. If missing:

```bash
sudo apt install gjs gir1.2-gtk-4.0 gir1.2-webkit-6.0
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

## API

The API mirrors [Electron](https://www.electronjs.org/docs/latest/) — replace
`import ... from 'electron'` with `import ... from '@devscholar/node-with-window'`.


## Examples

See [node-with-window-examples](https://github.com/devscholar/node-with-window-examples).

## Developing

After making changes to `node-with-window` itself, rebuild:

```bash
cd node-with-window && npm run build
```
