/**
 * WebPreferences - Configuration options for the WebView
 */
export interface WebPreferences {
  nodeIntegration?: boolean;
  contextIsolation?: boolean;
  preload?: string;
  sandbox?: boolean;
  webSecurity?: boolean;
  allowRunningInsecureContent?: boolean;
  experimentalFeatures?: boolean;
  defaultFontFamily?: string;
  defaultFontSize?: number;
  defaultMonospaceFontSize?: number;
  minimumFontSize?: number;
  backgroundThrottling?: boolean;
  /**
   * Sets the session partition to use for the window.
   * Prefix with 'persist:' for a persistent session, or 'temp:' for temporary.
   */
  partition?: string;
  cache?: boolean;
}

/**
 * BrowserWindowOptions - Configuration options for creating a window
 */
export interface BrowserWindowOptions {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  resizable?: boolean;
  movable?: boolean;
  minimizable?: boolean;
  maximizable?: boolean;
  closable?: boolean;
  title?: string;
  show?: boolean;
  frame?: boolean;
  /**
   * Controls the style of the window title bar.
   * - 'default':      the standard OS-themed title bar (same as frame: true)
   * - 'hidden':       the title bar is removed; resize borders are kept
   * - 'hiddenInset':  same as 'hidden' on Windows/Linux (macOS-specific inset
   *                   traffic-light buttons are not emulated on other platforms)
   */
  titleBarStyle?: 'default' | 'hidden' | 'hiddenInset';
  transparent?: boolean;
  /** CSS hex color for the window/webview background (#RGB, #RRGGBB, or #AARRGGBB). */
  backgroundColor?: string;
  fullscreen?: boolean;
  alwaysOnTop?: boolean;
  skipTaskbar?: boolean;
  kiosk?: boolean;
  /** Absolute or relative path to the window icon image (PNG or JPG). */
  icon?: string;
  /** Backend to use for this window. Defaults to the app-level backend or platform default. */
  backend?: string;
  /**
   * Parent BrowserWindow. The child window stays above the parent and closes with it.
   * Typed as `unknown` to avoid a circular import; pass a BrowserWindow instance.
   */
  parent?: unknown;
  /** When true (and parent is set), the parent window is blocked until this window is closed. */
  modal?: boolean;
  webPreferences?: WebPreferences;
}

/**
 * MenuItemOptions - Configuration for a menu item
 */
export interface MenuItemOptions {
  label?: string;
  type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio';
  enabled?: boolean;
  visible?: boolean;
  checked?: boolean;
  accelerator?: string;
  /** Absolute or relative path to an image file for the item icon. WPF: best-effort; GTK: best-effort. */
  icon?: string;
  /** Tooltip text shown when hovering the item. WPF only; ignored on GTK. */
  toolTip?: string;
  click?: () => void;
  submenu?: MenuItemOptions[];
  role?:
    | 'undo'
    | 'redo'
    | 'cut'
    | 'copy'
    | 'paste'
    | 'delete'
    | 'selectAll'
    | 'reload'
    | 'forceReload'
    | 'toggleDevTools'
    | 'resetZoom'
    | 'zoomIn'
    | 'zoomOut'
    | 'togglefullscreen'
    | 'window'
    | 'minimize'
    | 'close'
    | 'help'
    | 'about'
    | 'services'
    | 'hide'
    | 'hideOthers'
    | 'unhide'
    | 'quit';
}

/**
 * DialogOptions - Common options for file dialogs
 */
export interface DialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  properties?: Array<
    | 'openFile'
    | 'openDirectory'
    | 'multiSelections'
    | 'showHiddenFiles'
    | 'createDirectory'
    | 'promptToCreate'
  >;
  buttonLabel?: string;
  message?: string;
  type?: 'none' | 'info' | 'error' | 'question' | 'warning';
}

/**
 * OpenDialogOptions - Options for the open file dialog
 */
export interface OpenDialogOptions extends DialogOptions {
  properties?: Array<
    | 'openFile'
    | 'openDirectory'
    | 'multiSelections'
    | 'showHiddenFiles'
    | 'createDirectory'
    | 'promptToCreate'
  >;
}

/**
 * SaveDialogOptions - Options for the save file dialog
 */
export interface SaveDialogOptions extends DialogOptions {
  filters?: Array<{ name: string; extensions: string[] }>;
}

/**
 * IpcMainEvent - Event object passed to IPC handlers in the main process
 */
export interface IpcMainEvent {
  sender: unknown;
  frameId: number;
  reply: (channel: string, ...args: unknown[]) => void;
  /** Set this to return a value from ipcRenderer.sendSync(). */
  returnValue?: unknown;
}

/**
 * IpcRendererEvent - Event object for renderer-side IPC
 */
export interface IpcRendererEvent {
  senderId: number;
  sender: unknown;
}

/**
 * IWindowProvider - Interface for platform-specific window implementations
 *
 * Abstracts the differences between Windows (WPF+WebView2) and Linux (GTK+WebKit).
 *
 * Lifecycle contract for process exit:
 *   When the window is closed (either via close() or by the user clicking X),
 *   the provider must call this.onClosed?.() — NEVER call process.exit() directly.
 *   BrowserWindow registers onClosed and owns the decision to emit events and exit.
 */
export interface IWindowProvider {
  createWindow(): Promise<void>;
  loadURL(url: string): Promise<void>;
  loadFile(filePath: string): Promise<void>;
  show(): void;
  close(): void;
  setMenu(menu: MenuItemOptions[]): void;
  showOpenDialog(options: OpenDialogOptions): string[] | undefined;
  showSaveDialog(options: SaveDialogOptions): string | undefined;
  showMessageBox(options: {
    type?: string;
    title?: string;
    message: string;
    buttons?: string[];
  }): number;

  /**
   * Called by BrowserWindow immediately after createWindow() succeeds.
   * The provider must call this when the underlying window is closed by
   * any means other than a direct close() call (e.g. the user clicks X).
   * Must NOT be called from close() — BrowserWindow handles that path itself.
   */
  onClosed?: () => void;

  // ── Methods required by all backends ──────────────────────────────────────
  sendToRenderer(channel: string, ...args: unknown[]): void;
  reload(): void;
  openDevTools(): void;
  focus(): void;
  blur(): void;
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  setFullScreen(flag: boolean): void;
  isFullScreen(): boolean;
  setKiosk(flag: boolean): void;
  isKiosk(): boolean;
  setBackgroundColor(color: string): void;
  setTitle(title: string): void;
  getTitle(): string;
  setSize(width: number, height: number): void;
  getSize(): [number, number];
  setResizable(resizable: boolean): void;
  isResizable(): boolean;
  setAlwaysOnTop(flag: boolean): void;
  center(): void;
  flashFrame(flag: boolean): void;
  executeJavaScript(code: string): Promise<unknown>;
  onNavigationCompleted(callback: () => void): void;
  getHwnd(): string;
  setEnabled(flag: boolean): void;
  capturePage(): Promise<import('./native-image.js').NativeImage>;

  // ── Platform-limited methods (optional — may warn or return defaults) ─────
  /** GTK4: window placement is managed by compositor; warns and is a no-op. */
  setPosition?(x: number, y: number): void;
  /** GTK4: not supported; warns and returns [0, 0]. */
  getPosition?(): [number, number];
  /** GTK4: gtk_widget_set_opacity was removed; warns and is a no-op. */
  setOpacity?(opacity: number): void;
  /** GTK4: not supported; warns and returns 1.0. */
  getOpacity?(): number;
  /** Windows-only. */
  cleanupUserData?(): void;

  // ── Optional methods (not all backends support these) ────────────────────
  /** Show a context menu at the given screen position, or at cursor if omitted. */
  popupMenu?(items: MenuItemOptions[], x?: number, y?: number): void;
  /** Set the minimum window size. GTK4: only minWidth/minHeight; maxWidth/maxHeight are no-ops. */
  setMinimumSize?(width: number, height: number): void;
  /** Set the maximum window size. WPF only; no-op on GTK4. */
  setMaximumSize?(width: number, height: number): void;
}
