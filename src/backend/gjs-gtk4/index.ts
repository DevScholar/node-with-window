import { GjsGtk4Window } from './window.js';
import { registerBackend } from '../../backends.js';
import type { BrowserWindowOptions } from '../../interfaces.js';

export { GjsGtk4Window };

registerBackend({
  name: 'gjs-gtk4',
  defaultPlatforms: ['linux'],
  async initialize() {
    // node-with-gjs initialises lazily on first GI namespace access;
    // no explicit setup needed here.
  },
  createProvider(options?: BrowserWindowOptions) {
    return new GjsGtk4Window(options);
  },
});
