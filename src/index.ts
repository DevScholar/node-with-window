// Side-effect imports to register built-in backends at module load time
import './backend/netfx-wpf/index.js';
import './backend/gjs-gtk4/index.js';

export * from './app.js';
export * from './browser-window.js';
export * from './interfaces.js';
export * from './ipc-main.js';
export * from './backends.js';
export * from './menu.js';
export * from './shell.js';
export * from './dialog.js';
