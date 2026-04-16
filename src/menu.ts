import { MenuItemOptions } from './interfaces.js';

// Sentinel used by BrowserWindow to detect "menu explicitly removed".
export const MENU_REMOVED = Symbol('MENU_REMOVED');

// Global application menu — null means "use built-in default", MENU_REMOVED
// means the caller explicitly cleared it with setApplicationMenu(null).
let _applicationMenu: Menu | null | typeof MENU_REMOVED = null;
// Unsubscribe handle for the current application menu's change listener.
let _appMenuUnsub: (() => void) | null = null;

// Depth-first search for a menu item by id.
function findById(items: MenuItemOptions[], id: string): MenuItemOptions | null {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.submenu) {
      const found = findById(item.submenu, id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Wraps a MenuItemOptions in a Proxy that calls onChange() whenever any
 * property (including submenu) is written. Submenu children are wrapped
 * recursively so nested item writes are also captured.
 */
function wrapItem(item: MenuItemOptions, onChange: () => void): MenuItemOptions {
  const wrapped: MenuItemOptions = { ...item };
  if (item.submenu) {
    wrapped.submenu = item.submenu.map(child => wrapItem(child, onChange));
  }
  return new Proxy(wrapped, {
    set(target, prop, value) {
      if (prop === 'submenu' && Array.isArray(value)) {
        // Wrap newly assigned submenu children so they are also live.
        value = (value as MenuItemOptions[]).map(child => wrapItem(child, onChange));
      }
      (target as Record<string, unknown>)[prop as string] = value;
      onChange();
      return true;
    },
  });
}

export class Menu {
  private _items: MenuItemOptions[];
  private _subscribers: Set<() => void> = new Set();
  private _notifyPending = false;

  /**
   * Injected by browser-window.ts at module load time to break the circular
   * import (menu.ts cannot import browser-window.ts).
   * Called whenever the application menu is replaced or one of its items
   * changes, so that BrowserWindow instances can push the update to their
   * native providers.
   * @internal
   */
  static _appMenuUpdater: ((menu: Menu) => void) | null = null;

  constructor() {
    this._items = [];
  }

  static buildFromTemplate(template: MenuItemOptions[]): Menu {
    const menu = new Menu();
    menu._items = template.map(item => wrapItem(item, () => menu._scheduleNotify()));
    return menu;
  }

  items(): MenuItemOptions[] {
    return this._items;
  }

  append(item: MenuItemOptions): void {
    this._items.push(wrapItem(item, () => this._scheduleNotify()));
    this._scheduleNotify();
  }

  insert(pos: number, item: MenuItemOptions): void {
    this._items.splice(pos, 0, wrapItem(item, () => this._scheduleNotify()));
    this._scheduleNotify();
  }

  /**
   * Searches the menu tree (depth-first) for an item with the given id.
   * Returns the live (Proxy-wrapped) item if found, or null.
   * Modifying the returned object's properties immediately triggers a menu
   * rebuild on all windows that have this menu applied.
   */
  getMenuItemById(id: string): MenuItemOptions | null {
    return findById(this._items, id);
  }

  /**
   * Subscribe to item changes in this menu. The callback is fired
   * (via microtask, batched) whenever any item property is written or the
   * menu structure changes (append/insert). Returns an unsubscribe function.
   * @internal
   */
  _subscribe(fn: () => void): () => void {
    this._subscribers.add(fn);
    return () => this._subscribers.delete(fn);
  }

  private _scheduleNotify(): void {
    if (this._notifyPending) return;
    this._notifyPending = true;
    queueMicrotask(() => {
      this._notifyPending = false;
      for (const fn of this._subscribers) fn();
    });
  }

  /**
   * Pops up this menu as a context menu.
   * options.window — the BrowserWindow to associate the popup with.
   * options.x, options.y — screen coordinates (defaults to cursor position if omitted).
   */
  popup(options?: { window?: unknown; x?: number; y?: number }): void {
    const win = options?.window;
    if (!win) return;
    const provider = (win as unknown as { provider?: { popupMenu?: (...a: unknown[]) => void } }).provider;
    if (typeof provider?.popupMenu === 'function') {
      provider.popupMenu(this._items, options?.x, options?.y);
    }
  }

  /**
   * Sets the application menu for all windows.
   * Pass null to remove the menu bar entirely (matching Electron behaviour).
   */
  static setApplicationMenu(menu: Menu | null): void {
    _appMenuUnsub?.();
    _appMenuUnsub = null;
    _applicationMenu = menu ?? MENU_REMOVED;
    if (menu instanceof Menu) {
      // Immediately push to all existing windows that use the app menu.
      Menu._appMenuUpdater?.(menu);
      // Re-push on any future item change.
      _appMenuUnsub = menu._subscribe(() => Menu._appMenuUpdater?.(menu));
    }
  }

  /**
   * Returns the application menu, or null if none is set / it has been removed.
   */
  static getApplicationMenu(): Menu | null {
    if (_applicationMenu === MENU_REMOVED) return null;
    return _applicationMenu;
  }

  /**
   * Returns the effective menu items to apply to a new BrowserWindow.
   * Internal — used by BrowserWindow.show().
   *
   * - setApplicationMenu(null) was called → MENU_REMOVED (no menu bar)
   * - setApplicationMenu(menu) was called → that menu's items
   * - never called                        → built-in default menu items
   */
  static _resolveDefaultItems(): MenuItemOptions[] | typeof MENU_REMOVED {
    if (_applicationMenu === MENU_REMOVED) return MENU_REMOVED;
    if (_applicationMenu !== null)         return _applicationMenu.items();
    return buildDefaultMenuTemplate();
  }
}

// ---------------------------------------------------------------------------
// Built-in default menu — mirrors Electron's default on Windows / Linux
// ---------------------------------------------------------------------------

function buildDefaultMenuTemplate(): MenuItemOptions[] {
  return [
    {
      label: 'Edit',
      submenu: [
        { role: 'undo',      label: 'Undo'       },
        { role: 'redo',      label: 'Redo'       },
        { type: 'separator' },
        { role: 'cut',       label: 'Cut'        },
        { role: 'copy',      label: 'Copy'       },
        { role: 'paste',     label: 'Paste'      },
        { type: 'separator' },
        { role: 'selectAll', label: 'Select All' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload',           label: 'Reload'                 },
        { role: 'forceReload',      label: 'Force Reload'           },
        { role: 'toggleDevTools',   label: 'Toggle Developer Tools' },
        { type: 'separator' },
        { role: 'resetZoom',        label: 'Actual Size'            },
        { role: 'zoomIn',           label: 'Zoom In'                },
        { role: 'zoomOut',          label: 'Zoom Out'               },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Toggle Full Screen'     },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize', label: 'Minimize' },
        { role: 'close',    label: 'Close'    },
      ],
    },
  ];
}

export class MenuItem {
  id?: string;
  label?: string;
  type?: MenuItemOptions['type'];
  enabled?: boolean;
  visible?: boolean;
  checked?: boolean;
  accelerator?: string;
  click?: () => void;
  submenu?: MenuItemOptions[];
  role?: MenuItemOptions['role'];

  constructor(options: MenuItemOptions) {
    Object.assign(this, options);
  }
}
