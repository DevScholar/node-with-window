// Side-effect imports to register built-in backends at module load time
import './backend/netfx-wpf/index.js';
import './backend/gjs-gtk4/index.js';

export * from './app';
export * from './browser-window';
export * from './interfaces';
export * from './ipc-main';
export * from './backends';
