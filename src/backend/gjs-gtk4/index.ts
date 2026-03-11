export { LinuxWindow } from './window.js';
export { generateBridgeScript, injectBridgeScript } from './bridge.js';

import { registerBackend } from '../../backends.js';
import { LinuxWindow } from './window.js';
import type { BrowserWindowOptions } from '../../interfaces.js';

registerBackend({
  name: 'gjs-gtk4',
  defaultPlatforms: ['linux'],
  async initialize() {
    /* GJS is spawned per-window; no global init needed */
  },
  createProvider(options?: BrowserWindowOptions) {
    return new LinuxWindow(options);
  },
});
