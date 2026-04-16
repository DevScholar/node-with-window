import * as path from 'node:path';
import { MenuItemOptions } from '../../interfaces.js';
import type Gio from '@girs/gio-2.0';

export function buildGioMenu(
  items: MenuItemOptions[],
  GioNs: typeof Gio,
  actions: Array<{ name: string; action: Gio.SimpleAction }>,
  resolveRole?: (role: string) => (() => void) | undefined,
  prefix = 'nww_a'
): Gio.Menu {
  const menu = new GioNs.Menu();
  let section = new GioNs.Menu();
  let sectionItemCount = 0;

  const flushSection = () => {
    if (sectionItemCount > 0) {
      menu.append_section(null, section);
    }
    section = new GioNs.Menu();
    sectionItemCount = 0;
  };

  for (const item of items) {
    if (item.type === 'separator') {
      flushSection();
      continue;
    }

    // visible: false — skip this item entirely
    if (item.visible === false) continue;

    if (item.submenu && item.submenu.length > 0) {
      const submenu = buildGioMenu(
        item.submenu,
        GioNs,
        actions,
        resolveRole,
        `${prefix}_s${actions.length}`
      );
      section.append_submenu(item.label || '', submenu);
      sectionItemCount++;
      continue;
    }

    const clickFn = item.click ?? (item.role && resolveRole ? resolveRole(item.role) : undefined);

    const actionId = `${prefix}_${actions.length}`;
    const action = new GioNs.SimpleAction({ name: actionId });

    if (clickFn) {
      action.connect('activate', async () => { clickFn(); });
    }
    if (item.enabled === false) {
      action.set_enabled(false);
    }

    actions.push({ name: actionId, action });

    // Use MenuItem when we need to attach an icon; otherwise use the simple append() path.
    if (item.icon) {
      try {
        const iconAbs = path.isAbsolute(item.icon)
          ? item.icon : path.resolve(process.cwd(), item.icon);
        const gioFile = (GioNs.File as unknown as { new_for_path: (p: string) => Gio.File }).new_for_path(iconAbs);
        const fileIcon = new (GioNs.FileIcon as unknown as new (opts: { file: Gio.File }) => Gio.FileIcon)({ file: gioFile });
        const mi = new GioNs.MenuItem(item.label || '', `win.${actionId}`);
        mi.set_icon(fileIcon);
        section.append_item(mi);
      } catch {
        // Icon loading failed — fall back to plain item
        section.append(item.label || '', `win.${actionId}`);
      }
    } else {
      section.append(item.label || '', `win.${actionId}`);
    }
    sectionItemCount++;
  }

  flushSection();
  return menu;
}
