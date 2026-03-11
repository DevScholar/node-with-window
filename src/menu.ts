import { MenuItemOptions } from './interfaces.js';

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
