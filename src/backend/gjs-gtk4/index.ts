import { GjsGtk4Window } from './window.js';
import { gtkImageOps } from './image-ops.js';
import { registerBackend } from '../../backends.js';
import { registerImageOps } from '../../native-image.js';
import type { BrowserWindowOptions } from '../../interfaces.js';

export { GjsGtk4Window };

registerBackend({
  name: 'gjs-gtk4',
  defaultPlatforms: ['linux'],
  async initialize() {
    registerImageOps(gtkImageOps);
  },
  createProvider(options?: BrowserWindowOptions) {
    return new GjsGtk4Window(options);
  },
});
