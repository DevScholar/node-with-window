import { MenuItemOptions } from '../../interfaces';

let dotnet: unknown;

export function setDotNetInstance(instance: unknown): void {
  dotnet = instance;
}

export function setMenu(
  window: { browserWindow: unknown; pendingMenu?: MenuItemOptions[] },
  menu: unknown[]
): void {
  (window as any).pendingMenu = menu;
}

export function buildWpfMenu(window: {
  browserWindow: unknown;
  webView: unknown;
  pendingMenu?: unknown[] | null;
}): void {
  const dotnetAny = dotnet as any;
  const DockPanelType = dotnetAny['System.Windows.Controls.DockPanel'];
  const MenuType = dotnetAny['System.Windows.Controls.Menu'];
  const MenuItemType = dotnetAny['System.Windows.Controls.MenuItem'];
  const SeparatorType = dotnetAny['System.Windows.Controls.Separator'];

  if (!window.pendingMenu) return;

  const menuBar = new MenuType();

  const buildItems = (parent: unknown, items: MenuItemOptions[]) => {
    for (const item of items) {
      if (item.type === 'separator') {
        (parent as any).Items.Add(new SeparatorType());
      } else {
        const mi = new MenuItemType();
        (mi as any).Header = item.label || '';
        if (item.enabled === false) (mi as any).IsEnabled = false;
        if (item.click) {
          const clickFn = item.click;
          (mi as any).add_Click(() => {
            clickFn();
          });
        }
        if (item.submenu) buildItems(mi, item.submenu);
        (parent as any).Items.Add(mi);
      }
    }
  };

  buildItems(menuBar, window.pendingMenu as MenuItemOptions[]);

  const panel = new DockPanelType();
  (panel as any).LastChildFill = true;
  DockPanelType.SetDock(menuBar, 1);
  const currentGrid = (window.browserWindow as any).Content;
  if (currentGrid) (currentGrid as any).Children.Remove(window.webView);
  (panel as any).Children.Add(menuBar);
  (panel as any).Children.Add(window.webView);
  (window.browserWindow as any).Content = panel;
}
