import { MenuItemOptions } from '../../interfaces.js';

/**
 * Build a Gio.Menu model from a flat/nested MenuItemOptions array.
 *
 * @param resolveRole  Optional callback that maps a role string to a click
 *                     function.  Callers (e.g. GjsGtk4Window) supply this so
 *                     built-in roles (undo, reload, close, …) work without a
 *                     click handler on the item itself.
 */
export function buildGioMenu(
  items: MenuItemOptions[],
  Gio: any,
  actions: Array<{ name: string; action: any }>,
  resolveRole?: (role: string) => (() => void) | undefined,
  prefix = 'nww_a'
): any {
  const menu = new Gio.Menu();
  let section = new Gio.Menu();
  let sectionItemCount = 0;

  const flushSection = () => {
    if (sectionItemCount > 0) {
      menu.append_section(null, section);
    }
    section = new Gio.Menu();
    sectionItemCount = 0;
  };

  for (const item of items) {
    if (item.type === 'separator') {
      flushSection();
      continue;
    }

    if (item.submenu && item.submenu.length > 0) {
      const submenu = buildGioMenu(
        item.submenu,
        Gio,
        actions,
        resolveRole,
        `${prefix}_s${actions.length}`
      );
      section.append_submenu(item.label || '', submenu);
      sectionItemCount++;
      continue;
    }

    // Resolve click function: explicit click > role > nothing
    const clickFn = item.click ?? (item.role && resolveRole ? resolveRole(item.role) : undefined);

    const actionId = `${prefix}_${actions.length}`;
    const action = new Gio.SimpleAction({ name: actionId });

    if (clickFn) {
      action.connect('activate', async () => { clickFn(); });
    }
    if (item.enabled === false) {
      action.set_enabled(false);
    }

    actions.push({ name: actionId, action });
    section.append(item.label || '', `win.${actionId}`);
    sectionItemCount++;
  }

  flushSection();
  return menu;
}
