import * as path from 'node:path';
import { MenuItemOptions } from '../../interfaces.js';
import { callbackRegistry } from '@devscholar/node-ps1-dotnet';
import type { DotnetProxy, DotNetObject } from './dotnet/types.js';

let dotnet: DotnetProxy;

export function setDotNetInstance(instance: DotnetProxy): void {
  dotnet = instance;
}

export function setMenu(
  window: { browserWindow: unknown; pendingMenu?: MenuItemOptions[] },
  menu: MenuItemOptions[]
): void {
  window.pendingMenu = menu;
}

interface WindowRef {
  browserWindow: DotNetObject;
  webView: DotNetObject;
  pendingMenu?: unknown[] | null;
  onClosed?: () => void;
  close(): void;
  minimize(): void;
  reload(): void;
  openDevTools(): void;
  executeJavaScript?(code: string): Promise<unknown>;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
}

// ---------------------------------------------------------------------------
// Accelerator parsing helpers
// ---------------------------------------------------------------------------

/** Parse an Electron accelerator string → Win32 virtual key code + WPF ModifierKeys int. */
function parseAccelerator(accel: string): { vk: number; modifiers: number } | null {
  const parts = accel.split('+');
  let mods = 0;
  let keyPart = '';
  for (const p of parts) {
    switch (p.toLowerCase()) {
      case 'ctrl': case 'control': case 'cmdorctrl': case 'cmd': case 'command':
        mods |= 2; break; // ModifierKeys.Control
      case 'shift':  mods |= 4; break;
      case 'alt':    mods |= 1; break;
      case 'meta': case 'super': case 'windows': mods |= 8; break;
      default: keyPart = p;
    }
  }
  if (!keyPart) return null;
  const vk = _electronKeyToVK(keyPart);
  if (vk === null) return null;
  return { vk, modifiers: mods };
}

function _electronKeyToVK(key: string): number | null {
  const k = key.toLowerCase();
  if (k.length === 1 && k >= 'a' && k <= 'z') return k.charCodeAt(0) - 32; // A=65..Z=90
  if (k.length === 1 && k >= '0' && k <= '9') return k.charCodeAt(0);       // 0=48..9=57
  const map: Record<string, number> = {
    'f1': 112, 'f2': 113, 'f3': 114, 'f4': 115,  'f5': 116,  'f6': 117,
    'f7': 118, 'f8': 119, 'f9': 120, 'f10': 121, 'f11': 122, 'f12': 123,
    'tab': 9, 'enter': 13, 'return': 13,
    'escape': 27, 'esc': 27,
    'space': 32, 'backspace': 8,
    'delete': 46, 'del': 46,
    'insert': 45, 'ins': 45,
    'home': 36, 'end': 35,
    'pageup': 33, 'pagedown': 34,
    'left': 37, 'up': 38, 'right': 39, 'down': 40,
    'plus': 187, 'minus': 189, '-': 189,
    'numadd': 107, 'numsub': 109, 'numdec': 110, 'nummult': 106, 'numdiv': 111,
  };
  return map[k] ?? null;
}

/** Format for display in InputGestureText (e.g. "Ctrl+Z"). */
function formatAcceleratorDisplay(accel: string): string {
  return accel.replace(/CmdOrCtrl/gi, 'Ctrl').replace(/Command/gi, 'Ctrl').replace(/Cmd/gi, 'Ctrl');
}

// ---------------------------------------------------------------------------
// Menu builder
// ---------------------------------------------------------------------------

export function buildWpfMenu(window: WindowRef): void {
  const dotnetNs = dotnet as DotnetProxy & Record<string, DotNetObject>;
  const DockPanelType = dotnetNs['System.Windows.Controls.DockPanel'];
  const MenuType      = dotnetNs['System.Windows.Controls.Menu'];
  const MenuItemType  = dotnetNs['System.Windows.Controls.MenuItem'];
  const SeparatorType = dotnetNs['System.Windows.Controls.Separator'];

  if (!window.pendingMenu) return;

  const menuBar = new MenuType();
  const _callbackRefs: (() => void)[] = []; // Keep callbacks alive
  const _accelCallbackIds: string[] = []; // Track accelerator callback IDs for cleanup

  const roleClick = (role: string): (() => void) | undefined => {
    switch (role) {
      case 'close':            return () => window.close();
      case 'minimize':         return () => window.minimize();
      case 'reload':
      case 'forceReload':      return () => window.reload();
      case 'toggleDevTools':   return () => window.openDevTools();
      case 'togglefullscreen': return () => window.setFullScreen(!window.isFullScreen());
      case 'resetZoom':        return () => { (window.webView as DotNetObject).ZoomFactor = 1.0; };
      case 'zoomIn':           return () => {
        const z = (window.webView as DotNetObject).ZoomFactor as number;
        (window.webView as DotNetObject).ZoomFactor = Math.min(z + 0.1, 5.0);
      };
      case 'zoomOut':          return () => {
        const z = (window.webView as DotNetObject).ZoomFactor as number;
        (window.webView as DotNetObject).ZoomFactor = Math.max(z - 0.1, 0.25);
      };
      case 'undo':      return () => window.executeJavaScript?.("document.execCommand('undo')");
      case 'redo':      return () => window.executeJavaScript?.("document.execCommand('redo')");
      case 'cut':       return () => window.executeJavaScript?.("document.execCommand('cut')");
      case 'copy':      return () => window.executeJavaScript?.("document.execCommand('copy')");
      case 'paste':     return () => window.executeJavaScript?.("document.execCommand('paste')");
      case 'selectAll': return () => window.executeJavaScript?.("document.execCommand('selectAll')");
      default:          return undefined;
    }
  };

  // Collect accelerator entries to register with the window after building.
  const accelEntries: Array<{ vk: number; modifiers: number; callbackId: string }> = [];

  const buildItems = (parent: DotNetObject, items: MenuItemOptions[]) => {
    for (const item of items) {
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
              const uri  = new UriType('file:///' + iconAbs.replace(/\\/g, '/'));
              const bmp  = new BitmapImageType(uri);
              const img: DotNetObject = new ImageType();
              img.Source = bmp;
              img.Width  = 16;
              img.Height = 16;
              mi.Icon = img;
            }
          } catch { /* icon loading is best-effort */ }
        }

        if (item.accelerator) {
          mi.InputGestureText = formatAcceleratorDisplay(item.accelerator);
        }

        const clickFn = item.click ?? (item.role ? roleClick(item.role) : undefined);
        if (clickFn) {
          const callback = () => { clickFn(); };
          _callbackRefs.push(callback);
          mi.add_Click(callback);

          if (item.accelerator) {
            const parsed = parseAccelerator(item.accelerator);
            if (parsed) {
              const callbackId = Math.random().toString(36).slice(2) + Date.now().toString(36);
              callbackRegistry.set(callbackId, () => clickFn());
              accelEntries.push({ ...parsed, callbackId });
              _accelCallbackIds.push(callbackId);
            }
          }
        }

        if (item.submenu) buildItems(mi, item.submenu);
        parent.Items.Add(mi);
      }
    }
  };

  buildItems(menuBar, window.pendingMenu as MenuItemOptions[]);

  if (accelEntries.length > 0) {
    try {
      dotnet.registerWindowAccelerators(window.browserWindow, accelEntries);
    } catch { /* accelerators are best-effort */ }
  }

  const panel: DotNetObject = new DockPanelType();
  panel.LastChildFill = true;
  DockPanelType.SetDock(menuBar, 1);
  const currentGrid = window.browserWindow.Content as DotNetObject | null;
  if (currentGrid) currentGrid.Children.Remove(window.webView);
  panel.Children.Add(menuBar);
  panel.Children.Add(window.webView);
  window.browserWindow.Content = panel;

  // Cleanup menu callbacks when window closes
  const originalOnClosed = window.onClosed;
  window.onClosed = () => {
    _accelCallbackIds.forEach(id => callbackRegistry.delete(id));
    originalOnClosed?.();
  };
}
