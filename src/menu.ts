import { MenuItemOptions } from './interfaces.js';

// Sentinel used by BrowserWindow to detect "menu explicitly removed".
export const MENU_REMOVED = Symbol('MENU_REMOVED');

// Global application menu — null means "use built-in default", MENU_REMOVED
// means the caller explicitly cleared it with setApplicationMenu(null).
let _applicationMenu: Menu | null | typeof MENU_REMOVED = null;

export class Menu {
  private _items: MenuItemOptions[];

  constructor() {
    this._items = [];
  }

  static buildFromTemplate(template: MenuItemOptions[]): Menu {
    const menu = new Menu();
    menu._items = template;
    return menu;
  }

  items(): MenuItemOptions[] {
    return this._items;
  }

  append(item: MenuItemOptions): void {
    this._items.push(item);
  }

  insert(pos: number, item: MenuItemOptions): void {
    this._items.splice(pos, 0, item);
  }

  /**
   * Pops up this menu as a context menu.
   * options.window — the BrowserWindow to associate the popup with.
   * options.x, options.y — screen coordinates (defaults to cursor position if omitted).
   */
  popup(options?: { window?: unknown; x?: number; y?: number }): void {
    const win = options?.window;
    if (!win) return;
    const provider = (win as any).provider as { popupMenu?: (...a: unknown[]) => void } | undefined;
    if (typeof provider?.popupMenu === 'function') {
      provider.popupMenu(this._items, options?.x, options?.y);
    }
  }

  /**
   * Sets the application menu for all windows.
   * Pass null to remove the menu bar entirely (matching Electron behaviour).
   */
  static setApplicationMenu(menu: Menu | null): void {
    _applicationMenu = menu ?? MENU_REMOVED;
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
