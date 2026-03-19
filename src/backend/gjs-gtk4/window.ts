import * as path from 'node:path';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  IWindowProvider,
  BrowserWindowOptions,
  WebPreferences,
  OpenDialogOptions,
  SaveDialogOptions,
  MenuItemOptions,
} from '../../interfaces.js';
import { ipcMain } from '../../ipc-main.js';
import { NativeImage } from '../../native-image.js';
import { injectBridgeScript, generateBridgeScript } from './bridge.js';
import { getSyncServerPort } from '../../node-integration.js';

/**
 * GjsGtk4Window — IWindowProvider implementation for Linux using GTK4 + WebKitGTK.
 *
 * Architecture overview
 * ─────────────────────
 * A dedicated GJS script (scripts/backend/gjs-gtk4/host.js) is spawned as a child process.
 * It runs the GLib main loop and owns the GTK window + WebKit WebView.
 * Node.js communicates with it over two Unix FIFOs:
 *
 *   Node.js ──(fd3/reqFIFO)──► GJS host  (commands)
 *   GJS host ──(fd4/resFIFO)──► Node.js  (responses)
 *
 * Commands are synchronous JSON-line request/response pairs (like node-ps1-dotnet).
 *
 * WebKit IPC (ipcRenderer ↔ ipcMain)
 * ────────────────────────────────────
 * The HTML page posts messages via window.webkit.messageHandlers.ipc.postMessage().
 * The GJS host queues them. Node.js drains the queue with periodic 'Poll' commands
 * (POLL_INTERVAL_MS). On each poll result:
 *  - type 'ipc'  → parse the message, dispatch to ipcMain handlers, send reply back
 *                   to the WebView via a 'SendToRenderer' command.
 *  - type 'exit' → the window was closed; call process.exit(0).
 *  - type 'none' → nothing pending; keep polling.
 */

// ---------------------------------------------------------------------------
// IpcSync — minimal synchronous pipe IPC (same protocol as node-with-gjs)
// ---------------------------------------------------------------------------

class LinuxIpc {
  /** Leftover bytes from a previous chunked read. */
  private readBuf = Buffer.alloc(0);

  constructor(
    private fdRead: number,
    private fdWrite: number
  ) {}

  /** Read one newline-terminated JSON line from the pipe (blocking). */
  private readLine(): string | null {
    const chunk = Buffer.alloc(4096);
    while (true) {
      const nl = this.readBuf.indexOf(10 /* \n */);
      if (nl !== -1) {
        const line = this.readBuf.subarray(0, nl).toString('utf8');
        this.readBuf = this.readBuf.subarray(nl + 1);
        return line;
      }
      let n: number;
      try {
        n = fs.readSync(this.fdRead, chunk, 0, chunk.length, null);
      } catch {
        return null;
      }
      if (n === 0) {
        if (this.readBuf.length > 0) {
          const line = this.readBuf.toString('utf8');
          this.readBuf = Buffer.alloc(0);
          return line;
        }
        return null;
      }
      this.readBuf = Buffer.concat([this.readBuf, chunk.subarray(0, n)]);
    }
  }

  send(cmd: unknown): unknown {
    try {
      fs.writeSync(this.fdWrite, JSON.stringify(cmd) + '\n');
    } catch {
      throw new Error('Linux IPC: pipe closed (write failed)');
    }
    // Skip blank lines (shouldn't occur) and wait for a real response
    while (true) {
      const line = this.readLine();
      if (line === null) throw new Error('Linux IPC: pipe closed (read EOF)');
      if (!line.trim()) continue;
      return JSON.parse(line);
    }
  }

  close() {
    try {
      fs.closeSync(this.fdRead);
    } catch {
      /* ignore */
    }
    try {
      fs.closeSync(this.fdWrite);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// GjsGtk4Window
// ---------------------------------------------------------------------------

/** How often (ms) Node.js polls the GJS host for queued WebKit IPC messages. */
const POLL_INTERVAL_MS = 16;

// Single global SIGINT handler registered once for all GjsGtk4Window instances.
// Prevents SIGKILL'd windows from leaving orphan GJS processes.
let _sigintRegistered = false;
const _allInstances = new Set<GjsGtk4Window>();

function _ensureGlobalSigint(): void {
  if (_sigintRegistered) return;
  _sigintRegistered = true;
  process.on('SIGINT', () => {
    for (const win of _allInstances) {
      try { win['_cleanup'](); } catch { /* ignore */ }
    }
    process.exit(0);
  });
}

function findGjsPath(): string {
  try {
    return cp.execSync('which gjs', { encoding: 'utf-8' }).trim() || 'gjs';
  } catch {
    return 'gjs';
  }
}

/**
 * Locate scripts/backend/gjs-gtk4/host.js by walking up the directory tree from
 * `import.meta.url`.
 *
 * Why not a fixed relative path?
 * When esbuild bundles node-with-window into the user's app, import.meta.url
 * points to the *bundle* file (e.g. dist/notepad/notepad.js), not to
 * dist/backend/gjs-gtk4/window.js.  A fixed "../../.." would resolve to the
 * wrong directory.  Walking up and checking both the package-root pattern
 * ("scripts/backend/gjs-gtk4/host.js") and the node_modules installation pattern
 * ("node_modules/@devscholar/node-with-window/scripts/backend/gjs-gtk4/host.js")
 * handles both the bundled case and the unbundled/development case.
 */
function findHostScript(): string {
  const startDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = startDir;

  for (let i = 0; i < 12; i++) {
    const candidates = [
      // Package root (unbundled: dist/backend/gjs-gtk4/ → ../../.. → root)
      path.join(dir, 'scripts', 'backend', 'gjs-gtk4', 'host.js'),
      // npm install / file: link (bundled: walk up to node_modules)
      path.join(
        dir,
        'node_modules',
        '@devscholar',
        'node-with-window',
        'scripts',
        'backend',
        'gjs-gtk4',
        'host.js'
      ),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  throw new Error(
    `[node-with-window] Cannot locate scripts/backend/gjs-gtk4/host.js.\n` +
      `Searched upward from: ${startDir}\n` +
      `Run \`npm run build\` inside node-with-window and ensure the package is properly installed.`
  );
}

/** Returns true when running inside a VMware virtual machine. */
function isVMware(): boolean {
  try {
    const vendor = fs.readFileSync('/sys/class/dmi/id/sys_vendor', 'utf-8').trim();
    return vendor.toLowerCase().includes('vmware');
  } catch {
    return false;
  }
}

export class GjsGtk4Window implements IWindowProvider {
  public options: BrowserWindowOptions;
  public webPreferences: WebPreferences;
  /** Registered by BrowserWindow; called when the GTK window is closed externally. */
  public onClosed?: () => void;

  private ipc: LinuxIpc | null = null;
  private proc: cp.ChildProcess | null = null;
  private reqPath = '';
  private resPath = '';

  /** Pending menu set before show() is called. */
  private pendingMenu: MenuItemOptions[] | null = null;

  /** Map from menu-action index (assigned at SetMenu time) to click handler. */
  private menuClickHandlers: Map<number, () => void> = new Map();

  /** Map from popup-action index (assigned at popupMenu time) to click handler. */
  private _popupClickHandlers: Map<number, () => void> = new Map();

  /** Pending loadURL/loadFile call before show() is called. */
  private pendingLoad:
    | { kind: 'url'; url: string }
    | { kind: 'html'; html: string; baseUri: string }
    | null = null;

  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private isClosed = false;
  private _navCompletedCallback: (() => void) | null = null;
  private _pendingExecs = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private _isFullScreen = false;
  private _isKiosk = false;
  private _isResizable = true;
  private _isMinimizable = true;
  private _isMaximizable = true;
  private _isClosable = true;
  private _isMovable = true;

  constructor(options?: BrowserWindowOptions) {
    this.options = options || {};
    this.webPreferences = this.options.webPreferences || {};
    this._isResizable   = this.options.resizable    ?? true;
    this._isMinimizable = this.options.minimizable  ?? true;
    this._isMaximizable = this.options.maximizable  ?? true;
    this._isClosable    = this.options.closable     ?? true;
    this._isMovable     = this.options.movable      ?? true;
    _allInstances.add(this);
    _ensureGlobalSigint();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  public async createWindow(): Promise<void> {
    const token = `${process.pid}-${Date.now()}`;
    this.reqPath = path.join(os.tmpdir(), `nww-req-${token}.pipe`);
    this.resPath = path.join(os.tmpdir(), `nww-res-${token}.pipe`);

    cp.execSync(`mkfifo "${this.reqPath}"`);
    cp.execSync(`mkfifo "${this.resPath}"`);

    const hostScript = findHostScript();

    const gjsPath = findGjsPath();
    // Open the FIFOs BEFORE spawning GJS so that the open() calls don't block forever.
    // We open the write end first (Node→GJS) and then the read end (GJS→Node).
    // GJS opens them in the opposite order on its side, so both sides unblock together.
    const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
    if (isVMware()) {
      spawnEnv.WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS = '1';
    }
    this.proc = cp.spawn(
      'bash',
      ['-c', `exec "${gjsPath}" -m "${hostScript}" 3<"${this.reqPath}" 4>"${this.resPath}"`],
      { stdio: 'inherit', env: spawnEnv }
    );
    this.proc.unref();

    const fdWrite = fs.openSync(this.reqPath, 'w');
    const fdRead = fs.openSync(this.resPath, 'r');
    // Unlink immediately after both ends are open: the kernel keeps the FIFOs
    // alive via the open file descriptors but removes the directory entries,
    // so no orphan files survive a crash (SIGKILL or otherwise).
    try { fs.unlinkSync(this.reqPath); } catch { /* ignore */ }
    try { fs.unlinkSync(this.resPath); } catch { /* ignore */ }
    this.ipc = new LinuxIpc(fdRead, fdWrite);

    // Resolve icon path to absolute before sending to GJS
    const options = { ...this.options };
    if (options.icon) {
      options.icon = path.isAbsolute(options.icon)
        ? options.icon
        : path.resolve(process.cwd(), options.icon);
    }

    // Tell GJS to create the window (but not show it yet)
    this._send('CreateWindow', { options });

    // Register the bridge (and optional preload) as a UserContentManager script so
    // that it fires on every page navigation, including loadURL().
    // For loadFile() the bridge is also injected into the HTML directly; the
    // window.__nodeBridge / window.ipcRenderer guards prevent double-execution.
    let userScript = generateBridgeScript(this.webPreferences, getSyncServerPort());
    const preloadPath = this.webPreferences.preload;
    if (preloadPath) {
      const absPreload = path.isAbsolute(preloadPath)
        ? preloadPath
        : path.resolve(process.cwd(), preloadPath);
      try {
        userScript += '\n' + fs.readFileSync(absPreload, 'utf-8');
        if (this.webPreferences.contextIsolation === true) {
          userScript +=
            '\n(function(){' +
            'window.ipcRenderer=undefined;' +
            'window.contextBridge=undefined;' +
            '})();';
        }
      } catch (e) {
        console.error('[node-with-window] Failed to load preload script:', e);
      }
    }
    this._send('SetUserScript', { code: userScript });
  }

  public show(): void {
    if (!this.ipc) return;

    // Apply pending menu before showing
    if (this.pendingMenu) {
      this._applyMenu(this.pendingMenu);
      this.pendingMenu = null;
    }

    // Apply pending navigation
    if (this.pendingLoad) {
      if (this.pendingLoad.kind === 'url') {
        this._send('LoadURL', { url: this.pendingLoad.url });
      } else {
        this._send('LoadHTML', { html: this.pendingLoad.html, baseUri: this.pendingLoad.baseUri });
      }
      this.pendingLoad = null;
    }

    this._send('Show', {});

    // Start polling for WebKit IPC messages and window-closed events
    this.keepAliveTimer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  public close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    try {
      this._send('Close', {});
    } catch {
      /* pipe may already be closed */
    }
    this._cleanup();
    // Do NOT call process.exit() here — BrowserWindow._handleClosed() owns exit logic.
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  public async loadURL(url: string): Promise<void> {
    if (!this.ipc) {
      this.pendingLoad = { kind: 'url', url };
      return;
    }
    this._send('LoadURL', { url });
  }

  public async loadFile(filePath: string): Promise<void> {
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    const rawHtml = fs.readFileSync(absPath, 'utf-8');
    const html = injectBridgeScript(rawHtml, this.webPreferences, getSyncServerPort());
    const baseUri = `file://${absPath}`;

    if (!this.ipc) {
      this.pendingLoad = { kind: 'html', html, baseUri };
      return;
    }
    this._send('LoadHTML', { html, baseUri });
  }

  // -------------------------------------------------------------------------
  // Menu
  // -------------------------------------------------------------------------

  public setMenu(menu: MenuItemOptions[]): void {
    if (!this.ipc) {
      this.pendingMenu = menu;
      return;
    }
    this._applyMenu(menu);
  }

  public popupMenu(items: MenuItemOptions[], x?: number, y?: number): void {
    if (!this.ipc) return;
    this._popupClickHandlers.clear();
    let pidx = 0;

    const flattenPopup = (list: MenuItemOptions[]): unknown[] => {
      return list.map(item => {
        if (item.type === 'separator') return { type: 'separator' };
        if (item.submenu) {
          return {
            label: item.label,
            enabled: item.enabled,
            submenu: flattenPopup(item.submenu),
          };
        }
        const id = pidx++;
        const clickFn = item.click ?? (item.role ? this._roleClick(item.role) : undefined);
        if (clickFn) this._popupClickHandlers.set(id, clickFn);
        return { label: item.label, enabled: item.enabled, id };
      });
    };

    try {
      this._send('PopupMenu', { items: flattenPopup(items), x, y });
    } catch {
      /* ignore */
    }
  }

  public setMinimumSize(width: number, height: number): void {
    try {
      this._send('SetMinSize', { minWidth: width, minHeight: height });
    } catch {
      /* ignore */
    }
  }

  public setMaximumSize(_width: number, _height: number): void {
    console.warn('[node-with-window] win.setMaximumSize() is not supported on GTK4: GTK4 has no API for maximum window size.');
  }

  /** Translate a menu item role to a click handler. Mirrors netfx-wpf/menu.ts. */
  private _roleClick(role: string): (() => void) | undefined {
    switch (role) {
      case 'close':            return () => this.close();
      case 'minimize':         return () => this.minimize();
      case 'reload':
      case 'forceReload':      return () => this.reload();
      case 'toggleDevTools':   return () => this.openDevTools();
      case 'togglefullscreen': return () => this.setFullScreen(!this.isFullScreen());
      case 'resetZoom':        return () => this.executeJavaScript('document.body.style.zoom="100%"');
      case 'zoomIn':           return () => this.executeJavaScript('document.body.style.zoom=(parseFloat(document.body.style.zoom||1)+0.1)+"" ');
      case 'zoomOut':          return () => this.executeJavaScript('document.body.style.zoom=Math.max(parseFloat(document.body.style.zoom||1)-0.1,0.25)+""');
      case 'undo':             return () => this.executeJavaScript("document.execCommand('undo')");
      case 'redo':             return () => this.executeJavaScript("document.execCommand('redo')");
      case 'cut':              return () => this.executeJavaScript("document.execCommand('cut')");
      case 'copy':             return () => this.executeJavaScript("document.execCommand('copy')");
      case 'paste':            return () => this.executeJavaScript("document.execCommand('paste')");
      case 'selectAll':        return () => this.executeJavaScript("document.execCommand('selectAll')");
      default:                 return undefined;
    }
  }

  /** Flatten the menu tree, assign numeric IDs to clickable items, store handlers. */
  private _applyMenu(menu: MenuItemOptions[]): void {
    this.menuClickHandlers.clear();
    let idx = 0;

    const flatten = (items: MenuItemOptions[]): unknown[] => {
      return items.map(item => {
        if (item.type === 'separator') return { type: 'separator' };
        if (item.submenu) {
          return {
            label: item.label,
            enabled: item.enabled,
            submenu: flatten(item.submenu),
          };
        }
        const id = idx++;
        const clickFn = item.click ?? (item.role ? this._roleClick(item.role) : undefined);
        if (clickFn) this.menuClickHandlers.set(id, clickFn);
        return { label: item.label, enabled: item.enabled, id, accelerator: item.accelerator };
      });
    };

    this._send('SetMenu', { menu: flatten(menu) });
  }

  // -------------------------------------------------------------------------
  // IPC: Node.js → Renderer
  // -------------------------------------------------------------------------

  public sendToRenderer(channel: string, ...args: unknown[]): void {
    this.send(channel, ...args);
  }

  public send(channel: string, ...args: unknown[]): void {
    const payload = JSON.stringify({ type: 'message', channel, args });
    const script = `window.__ipcDispatch(${JSON.stringify(payload)})`;
    try {
      this._send('SendToRenderer', { script });
    } catch {
      /* ignore if closed */
    }
  }

  // -------------------------------------------------------------------------
  // Dialogs
  // -------------------------------------------------------------------------

  public showOpenDialog(options: OpenDialogOptions): string[] | undefined {
    try {
      const res = this._send('ShowOpenDialog', { options }) as { value: string[] | null };
      return res.value ?? undefined;
    } catch {
      return undefined;
    }
  }

  public showSaveDialog(options: SaveDialogOptions): string | undefined {
    try {
      const res = this._send('ShowSaveDialog', { options }) as { value: string | null };
      return res.value ?? undefined;
    } catch {
      return undefined;
    }
  }

  public showMessageBox(options: {
    type?: string;
    title?: string;
    message: string;
    buttons?: string[];
  }): number {
    try {
      const res = this._send('ShowMessageBox', { options }) as { value: number };
      return res.value ?? 0;
    } catch {
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  public reload(): void {
    try {
      this._send('Reload', {});
    } catch {
      /* ignore */
    }
  }

  public openDevTools(): void {
    try {
      this._send('OpenDevTools', {});
    } catch {
      /* ignore */
    }
  }

  public focus(): void {
    try {
      this._send('Focus', {});
    } catch {
      /* ignore */
    }
  }

  public minimize(): void {
    try {
      this._send('Minimize', {});
    } catch {
      /* ignore */
    }
  }

  public maximize(): void {
    try {
      this._send('Maximize', {});
    } catch {
      /* ignore */
    }
  }

  public unmaximize(): void {
    try {
      this._send('Unmaximize', {});
    } catch {
      /* ignore */
    }
  }

  public setFullScreen(flag: boolean): void {
    this._isFullScreen = flag;
    try {
      this._send('SetFullScreen', { flag });
    } catch {
      /* ignore */
    }
  }

  public isFullScreen(): boolean {
    return this._isFullScreen;
  }

  public setKiosk(flag: boolean): void {
    this._isKiosk = flag;
    this.setFullScreen(flag);
    this.setSkipTaskbar(flag || (this.options.skipTaskbar ?? false));
  }

  public isKiosk(): boolean {
    return this._isKiosk;
  }

  public setTitle(title: string): void {
    try {
      this._send('SetTitle', { title });
    } catch {
      /* ignore */
    }
  }

  public getTitle(): string {
    try {
      const res = this._send('GetTitle', {}) as { value?: string };
      return res.value ?? '';
    } catch {
      return '';
    }
  }

  public setSize(width: number, height: number): void {
    try {
      this._send('SetSize', { width, height });
    } catch {
      /* ignore */
    }
  }

  public getSize(): [number, number] {
    try {
      const res = this._send('GetSize', {}) as { value?: [number, number] };
      return res.value ?? [0, 0];
    } catch {
      return [0, 0];
    }
  }

  public setResizable(resizable: boolean): void {
    this._isResizable = resizable;
    try {
      this._send('SetResizable', { flag: resizable });
    } catch {
      /* ignore */
    }
  }

  public isResizable(): boolean {
    return this._isResizable;
  }

  public setAlwaysOnTop(flag: boolean): void {
    try {
      this._send('SetAlwaysOnTop', { flag });
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Unsupported on GTK4/GNOME — warn and return safe defaults
  // -------------------------------------------------------------------------

  public blur(): void {
    console.warn('[node-with-window] win.blur() is not supported on GTK4/GNOME: the compositor controls focus.');
  }

  public setPosition(_x: number, _y: number): void {
    console.warn('[node-with-window] win.setPosition() is not supported on GTK4/GNOME: GTK4 removed window.move() and placement is managed by the window manager.');
  }

  public getPosition(): [number, number] {
    console.warn('[node-with-window] win.getPosition() is not supported on GTK4/GNOME: window position is managed by the window manager.');
    return [0, 0];
  }

  public setOpacity(_opacity: number): void {
    console.warn('[node-with-window] win.setOpacity() is not supported on GTK4/GNOME: gtk_widget_set_opacity() was removed in GTK4.');
  }

  public getOpacity(): number {
    console.warn('[node-with-window] win.getOpacity() is not supported on GTK4/GNOME.');
    return 1.0;
  }

  public center(): void {
    console.warn('[node-with-window] win.center() is not supported on GTK4/GNOME: GTK4 removed gtk_window_set_position().');
  }

  public flashFrame(flag: boolean): void {
    try {
      this._send('FlashFrame', { flag });
    } catch {
      /* ignore */
    }
  }

  public setMinimizable(flag: boolean): void {
    this._isMinimizable = flag;
    try {
      this._send('SetMinimizable', { flag });
    } catch {
      /* ignore */
    }
  }

  public isMinimizable(): boolean {
    return this._isMinimizable;
  }

  public setMaximizable(flag: boolean): void {
    this._isMaximizable = flag;
    try {
      this._send('SetMaximizable', { flag });
    } catch {
      /* ignore */
    }
  }

  public isMaximizable(): boolean {
    return this._isMaximizable;
  }

  public setClosable(flag: boolean): void {
    this._isClosable = flag;
    try {
      this._send('SetClosable', { flag });
    } catch {
      /* ignore */
    }
  }

  public isClosable(): boolean {
    return this._isClosable;
  }

  public setMovable(flag: boolean): void {
    this._isMovable = flag;
    try {
      this._send('SetMovable', { flag });
    } catch {
      /* ignore */
    }
  }

  public isMovable(): boolean {
    return this._isMovable;
  }

  public setSkipTaskbar(flag: boolean): void {
    try {
      this._send('SetSkipTaskbar', { flag });
    } catch {
      /* ignore */
    }
  }

  public setFrame(flag: boolean): void {
    try {
      this._send('SetFrame', { flag });
    } catch {
      /* ignore */
    }
  }

  public setBackgroundColor(color: string): void {
    try {
      this._send('SetBackgroundColor', { color });
    } catch {
      /* ignore */
    }
  }

  public getHwnd(): string {
    return '0'; // X11 XIDs are not exposed via this API
  }

  public setEnabled(flag: boolean): void {
    try {
      this._send('SetSensitive', { sensitive: flag });
    } catch {
      /* ignore */
    }
  }

  public async capturePage(): Promise<NativeImage> {
    try {
      const res = this._send('CaptureSnapshot', {}) as { value?: string };
      const b64 = res.value ?? '';
      if (!b64) return new NativeImage(Buffer.alloc(0));
      return new NativeImage(Buffer.from(b64, 'base64'));
    } catch {
      return new NativeImage(Buffer.alloc(0));
    }
  }

  public onNavigationCompleted(callback: () => void): void {
    this._navCompletedCallback = callback;
  }

  public executeJavaScript(code: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ipc) {
        reject(new Error('GJS host not ready'));
        return;
      }
      const id = Math.random().toString(36).substring(2, 11);
      const timer = setTimeout(() => {
        if (this._pendingExecs.delete(id)) {
          reject(new Error('executeJavaScript timed out after 10000ms'));
        }
      }, 10_000);
      this._pendingExecs.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });
      // Send the eval code as a self-contained IIFE so renderer scripts cannot
      // call the same entry point to forge execResult messages.
      const eid = JSON.stringify(id);
      const src = JSON.stringify(code);
      const script =
        `(function(){var eid=${eid};` +
        `try{var r=eval(${src});` +
        `if(r&&typeof r.then==='function'){` +
        `r.then(function(v){window.webkit.messageHandlers.ipc.postMessage(` +
        `JSON.stringify({type:'execResult',id:eid,result:v==null?null:v}));})` +
        `.catch(function(ex){window.webkit.messageHandlers.ipc.postMessage(` +
        `JSON.stringify({type:'execResult',id:eid,error:String(ex)}));});` +
        `}else{window.webkit.messageHandlers.ipc.postMessage(` +
        `JSON.stringify({type:'execResult',id:eid,result:r==null?null:r}));}` +
        `}catch(ex){window.webkit.messageHandlers.ipc.postMessage(` +
        `JSON.stringify({type:'execResult',id:eid,error:String(ex)}));}` +
        `})()`;
      try {
        this._send('SendToRenderer', { script });
      } catch (e) {
        clearTimeout(timer);
        this._pendingExecs.delete(id);
        reject(e);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Send a command and return the response object. Throws on pipe error. */
  private _send(action: string, params: Record<string, unknown>): unknown {
    const resp = this.ipc!.send({ action, ...params }) as {
      type: string;
      value?: unknown;
      message?: unknown;
    };

    if (resp.type === 'error') {
      console.error(`[GjsGtk4Window] GJS error for "${action}":`, resp.message);
    }
    return resp;
  }

  /**
   * Poll the GJS host for queued WebKit IPC messages.
   * Called on a POLL_INTERVAL_MS timer after show().
   */
  private _poll(): void {
    if (this.isClosed) return;
    let resp: { type: string; message?: string };
    try {
      resp = this._send('Poll', {}) as typeof resp;
    } catch (e: unknown) {
      // EINTR (signal) and EAGAIN (non-blocking) are transient — skip this tick.
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EINTR' || code === 'EAGAIN') return;
      // Any other error (EBADF, EIO, EOF) means the GJS process has gone away.
      this._onWindowClosed();
      return;
    }

    if (resp.type === 'exit') {
      this._onWindowClosed();
    } else if (resp.type === 'ipc' && resp.message) {
      this._handleIpcMessage(resp.message);
    }
  }

  /** Dispatch a WebKit IPC message to the registered ipcMain handler. */
  private _handleIpcMessage(rawJson: string): void {
    let data: { type: string; channel: string; id?: string; args?: unknown[] };
    try {
      data = JSON.parse(rawJson);
    } catch {
      console.error('[GjsGtk4Window] Invalid IPC JSON:', rawJson);
      return;
    }

    const { type, channel, id, args = [] } = data;

    // Menu click — handled locally without involving ipcMain
    if (type === 'menuClick') {
      const handler = this.menuClickHandlers.get((data as unknown as { id: number }).id);
      if (handler) handler();
      return;
    }

    // Popup menu click
    if (type === 'popupMenuClick') {
      const handler = this._popupClickHandlers.get((data as unknown as { id: number }).id);
      if (handler) handler();
      return;
    }

    // executeJavaScript result
    if (type === 'execResult') {
      const pending = this._pendingExecs.get(id!);
      if (pending) {
        this._pendingExecs.delete(id!);
        if ((data as unknown as { error?: string }).error)
          pending.reject(new Error((data as unknown as { error: string }).error));
        else pending.resolve((data as unknown as { result: unknown }).result);
      }
      return;
    }

    // did-finish-load
    if (type === 'navigationCompleted') {
      this._navCompletedCallback?.();
      return;
    }

    const event = {
      sender: this,
      frameId: 0,
      reply: (ch: string, ...a: unknown[]) => this.send(ch, ...a),
    };

    if (type === 'send') {
      ipcMain.emit(channel, event, ...args);
    } else if (type === 'invoke') {
      const handlers = (
        ipcMain as unknown as { handlers: Map<string, (e: unknown, ...a: unknown[]) => unknown> }
      ).handlers;
      const handler = handlers.get(channel);

      if (!handler) {
        this._sendIpcReply(id!, null, `No handler for channel: ${channel}`);
        return;
      }

      try {
        const result = handler(event, ...args);
        // Support both sync and async handlers
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          (result as Promise<unknown>)
            .then(r => this._sendIpcReply(id!, r, null))
            .catch(e => this._sendIpcReply(id!, null, (e as Error).message || String(e)));
        } else {
          this._sendIpcReply(id!, result, null);
        }
      } catch (e: unknown) {
        this._sendIpcReply(id!, null, (e as Error).message || String(e));
      }
    }
  }

  /** Send an invoke() reply back to the HTML renderer. */
  private _sendIpcReply(id: string, result: unknown, error: string | null): void {
    const payload = JSON.stringify({ type: 'reply', id, result, error });
    const script = `window.__ipcDispatch(${JSON.stringify(payload)})`;
    try {
      this._send('SendToRenderer', { script });
    } catch {
      /* window may be closing */
    }
  }

  /** Called when the GTK window has been closed. */
  private _onWindowClosed(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    for (const pending of this._pendingExecs.values()) {
      pending.reject(new Error('Window closed'));
    }
    this._pendingExecs.clear();
    this._cleanup();
    // Notify BrowserWindow, which will emit 'closed', 'window-all-closed', and
    // call process.exit(0) if no listener handles window-all-closed.
    this.onClosed?.();
  }

  private _cleanup(): void {
    _allInstances.delete(this);
    if (this.ipc) {
      this.ipc.close();
      this.ipc = null;
    }
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
}
