import { JxaCocoaWindow } from './window.js';
import { jxaImageOps } from './image-ops.js';
import { registerBackend } from '../../backends.js';
import { registerImageOps } from '../../native-image.js';
import type { BrowserWindowOptions } from '../../interfaces.js';

export { JxaCocoaWindow };

registerBackend({
  name: 'jxa-cocoa',
  defaultPlatforms: ['darwin'],
  async initialize() {
    registerImageOps(jxaImageOps);
  },
  createProvider(options?: BrowserWindowOptions) {
    return new JxaCocoaWindow(options);
  },
});
