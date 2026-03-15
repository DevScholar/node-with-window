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
  mininumFontSize?: number;
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
  sendToRenderer?(channel: string, ...args: unknown[]): void;
  cleanupUserData?(): void;
  reload?(): void;
  openDevTools?(): void;
  focus?(): void;
  blur?(): void;
  minimize?(): void;
  maximize?(): void;
  unmaximize?(): void;
  setFullScreen?(flag: boolean): void;
  isFullScreen?(): boolean;
  setKiosk?(flag: boolean): void;
  isKiosk?(): boolean;
  setBackgroundColor?(color: string): void;
  setTitle?(title: string): void;
  getTitle?(): string;
  setSize?(width: number, height: number): void;
  getSize?(): [number, number];
  setPosition?(x: number, y: number): void;
  getPosition?(): [number, number];
  setOpacity?(opacity: number): void;
  getOpacity?(): number;
  setResizable?(resizable: boolean): void;
  isResizable?(): boolean;
  setAlwaysOnTop?(flag: boolean): void;
  center?(): void;
  flashFrame?(flag: boolean): void;
  executeJavaScript?(code: string): Promise<unknown>;
  onNavigationCompleted?(callback: () => void): void;
  /** Returns the native window HWND (Windows) as a decimal string, or '0' if unavailable. */
  getHwnd?(): string;
  /** Enable or disable user interaction on the window (used for modal parent blocking). */
  setEnabled?(flag: boolean): void;
  /** Captures the WebView contents and returns a NativeImage (PNG). */
  capturePage?(): Promise<import('./native-image.js').NativeImage>;
}
