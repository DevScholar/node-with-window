import * as path from 'node:path';
import type { MenuItemOptions } from '../../interfaces.js';
import type { DotnetProxy, DotNetObject } from './dotnet/types.js';

/** Minimum window surface needed by popup menu and role-click actions. */
export interface PopupMenuWindowContext {
  browserWindow: DotNetObject;
  webView?: DotNetObject;
  close(): void;
  reload(): void;
  openDevTools(): void;
  setFullScreen(flag: boolean): void;
  isFullScreen(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
}

/** Map a menu role string to a click handler, mirroring buildWpfMenu's role logic. */
export function wpfRoleClick(
  role: string,
  ctx: PopupMenuWindowContext,
  dotnet: DotnetProxy,
): (() => void) | undefined {
  switch (role) {
    case 'close':            return () => ctx.close();
    case 'minimize':         return () => { dotnet.minimize(ctx.browserWindow); };
    case 'reload':
    case 'forceReload':      return () => ctx.reload();
    case 'toggleDevTools':   return () => ctx.openDevTools();
    case 'togglefullscreen': return () => ctx.setFullScreen(!ctx.isFullScreen());
    case 'resetZoom':        return () => { if (ctx.webView) ctx.webView.ZoomFactor = 1.0; };
    case 'zoomIn':           return () => { if (ctx.webView) ctx.webView.ZoomFactor = Math.min((ctx.webView.ZoomFactor as number) + 0.1, 5.0); };
    case 'zoomOut':          return () => { if (ctx.webView) ctx.webView.ZoomFactor = Math.max((ctx.webView.ZoomFactor as number) - 0.1, 0.25); };
    case 'undo':      return () => ctx.executeJavaScript("document.execCommand('undo')");
    case 'redo':      return () => ctx.executeJavaScript("document.execCommand('redo')");
    case 'cut':       return () => ctx.executeJavaScript("document.execCommand('cut')");
    case 'copy':      return () => ctx.executeJavaScript("document.execCommand('copy')");
    case 'paste':     return () => ctx.executeJavaScript("document.execCommand('paste')");
    case 'selectAll': return () => ctx.executeJavaScript("document.execCommand('selectAll')");
    default:          return undefined;
  }
}

/** Show a WPF ContextMenu at screen position (x, y) or at cursor if not specified. */
export function popupContextMenu(
  ctx: PopupMenuWindowContext,
  dotnet: DotnetProxy,
  items: MenuItemOptions[],
  x?: number,
  y?: number,
): void {
  if (!ctx.browserWindow) return;
  const dotnetNs = dotnet as DotnetProxy & Record<string, DotNetObject>;
  const ContextMenuType = dotnetNs['System.Windows.Controls.ContextMenu'];
  const MenuItemType    = dotnetNs['System.Windows.Controls.MenuItem'];
  const SeparatorType   = dotnetNs['System.Windows.Controls.Separator'];
  if (!ContextMenuType) return;

  const cm: DotNetObject = new ContextMenuType();

  const buildItems = (parent: DotNetObject, list: MenuItemOptions[]) => {
    for (const item of list) {
      if (item.type === 'separator') {
        parent.Items.Add(new SeparatorType());
      } else {
        const mi: DotNetObject = new MenuItemType();
        mi.Header = item.label || '';
        if (item.enabled === false) mi.IsEnabled = false;
        if (item.toolTip) mi.ToolTip = item.toolTip;

        if (item.icon) {
          try {
            const iconAbs = path.isAbsolute(item.icon)
              ? item.icon : path.resolve(process.cwd(), item.icon);
            const BitmapImageType = dotnetNs['System.Windows.Media.Imaging.BitmapImage'];
            const ImageType       = dotnetNs['System.Windows.Controls.Image'];
            const UriType         = dotnetNs['System.Uri'];
            if (BitmapImageType && ImageType && UriType) {
              const uri = new UriType('file:///' + iconAbs.replace(/\\/g, '/'));
              const bmp = new BitmapImageType(uri);
              const img: DotNetObject = new ImageType();
              img.Source = bmp;
              img.Width  = 16;
              img.Height = 16;
              mi.Icon = img;
            }
          } catch { /* best-effort */ }
        }

        const clickFn = item.click ?? (item.role ? wpfRoleClick(item.role, ctx, dotnet) : undefined);
        if (clickFn) mi.add_Click(() => { clickFn(); });
        if (item.submenu) buildItems(mi, item.submenu);
        parent.Items.Add(mi);
      }
    }
  };

  buildItems(cm, items);

  if (x !== undefined && y !== undefined) {
    try {
      const PlacementModeType = dotnetNs['System.Windows.Controls.Primitives.PlacementMode'];
      const absolutePoint = (PlacementModeType as DotNetObject).AbsolutePoint;
      cm.Placement        = absolutePoint;
      cm.HorizontalOffset = x;
      cm.VerticalOffset   = y;
    } catch { /* placement is best-effort */ }
  }

  cm.IsOpen = true;
}
