import { NetFxWpfWindow, setDotNetInstance as setWindowDotNetInstance } from './window.js';
import { generateBridgeScript, injectBridgeScript } from './bridge.js';
import {
  showOpenDialog,
  showSaveDialog,
  showMessageBox,
  setDotNetInstance as setDialogDotNetInstance,
} from './dialogs.js';
import { setMenu, buildWpfMenu, setDotNetInstance as setMenuDotNetInstance } from './menu.js';
import { registerBackend } from '../../backends.js';
import type { BrowserWindowOptions } from '../../interfaces.js';

let dotnetInstance: unknown = null;

export {
  NetFxWpfWindow,
  generateBridgeScript,
  injectBridgeScript,
  showOpenDialog,
  showSaveDialog,
  showMessageBox,
  setMenu,
  buildWpfMenu,
};

export function setDotNetInstance(instance: unknown): void {
  dotnetInstance = instance;
  setWindowDotNetInstance(instance);
  setDialogDotNetInstance(instance);
  setMenuDotNetInstance(instance);
}

export function getDotNetInstance(): unknown {
  return dotnetInstance;
}

registerBackend({
  name: 'netfx-wpf',
  defaultPlatforms: ['win32'],
  async initialize() {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — no type declarations for this package
    const nodePs1Dotnet = await import('@devscholar/node-ps1-dotnet');
    const dotnet = nodePs1Dotnet.default || nodePs1Dotnet;
    setDotNetInstance(dotnet);
  },
  createProvider(options?: BrowserWindowOptions) {
    return new NetFxWpfWindow(options);
  },
});
