import { WindowsWindow, setDotNetInstance as setWindowDotNetInstance } from './window.js';
import { generateBridgeScript, injectBridgeScript } from './bridge.js';
import { showOpenDialog, showSaveDialog, showMessageBox, setDotNetInstance as setDialogDotNetInstance } from './dialogs.js';
import { setMenu, buildWpfMenu, setDotNetInstance as setMenuDotNetInstance } from './menu.js';

let dotnetInstance: unknown = null;

export { WindowsWindow, generateBridgeScript, injectBridgeScript, showOpenDialog, showSaveDialog, showMessageBox, setMenu, buildWpfMenu };

export function setDotNetInstance(instance: unknown): void {
    dotnetInstance = instance;
    setWindowDotNetInstance(instance);
    setDialogDotNetInstance(instance);
    setMenuDotNetInstance(instance);
}

export function getDotNetInstance(): unknown {
    return dotnetInstance;
}
