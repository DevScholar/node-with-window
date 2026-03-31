import { MenuItemOptions } from '../../interfaces.js';

/**
 * Build a Gio.Menu model from a flat/nested MenuItemOptions array.
 *
 * Items within the same "run" (between separators) are grouped into a
 * Gio.Menu section.  Separators become section boundaries so the host
 * toolkit renders them as visual dividers.
 *
 * @param items   Menu items to convert
 * @param Gio     The Gio GI namespace proxy (passed in to avoid re-loading)
 * @param actions Accumulator for {name, action} pairs; caller adds them to the
 *                window so they are reachable as "win.<name>" in menu models.
 * @param prefix  Internal prefix for unique action names (used in recursion)
 */
export function buildGioMenu(
  items: MenuItemOptions[],
  Gio: any,
  actions: Array<{ name: string; action: any }>,
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
        `${prefix}_s${actions.length}`
      );
      section.append_submenu(item.label || '', submenu);
      sectionItemCount++;
      continue;
    }

    // Leaf item with optional click handler
    const actionId = `${prefix}_${actions.length}`;
    const action = new Gio.SimpleAction({ name: actionId });

    const clickFn = item.click ?? undefined;
    if (clickFn) {
      // Async callback — GJS enqueues it to eventQueue, delivered via poll
      action.connect('activate', async () => { clickFn(); });
    }
    if (item.enabled === false) {
      action.set_enabled(false);
    }

    actions.push({ name: actionId, action });
    section.append(item.label || '', `win.${actionId}`);
    sectionItemCount++;
  }

  flushSection();  // flush any remaining items
  return menu;
}
