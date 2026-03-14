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
    const winBridge = await import('./dotnet/index.js');
    setDotNetInstance(winBridge.default);
  },
  createProvider(options?: BrowserWindowOptions) {
    return new NetFxWpfWindow(options);
  },
});
