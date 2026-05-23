// Dynamic imports with computed paths so tsc doesn't statically resolve them.
// Top-level await ensures all present backends register before the app resolves.
const _be = [
  './backend/netfx-wpf/index.js',
  './backend/gjs-gtk4/index.js',
  './backend/jxa-cocoa/index.js',
];
await Promise.allSettled(_be.map(p => import(p)));

export * from './app.js';
export * from './browser-window.js';
export * from './web-contents.js';
export * from './interfaces.js';
export * from './ipc-main.js';
export * from './backends.js';
export * from './menu.js';
export * from './shell.js';
export * from './dialog.js';
export * from './native-image.js';
export * from './protocol.js';
