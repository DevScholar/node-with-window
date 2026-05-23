import { $, ObjC } from '@devscholar/node-with-jxa';
import type { MenuItemOptions } from '../../interfaces.js';

// ---------------------------------------------------------------------------
// Accelerator mapping: Electron → Cocoa keyEquivalent + modifier flags
// ---------------------------------------------------------------------------
const MODIFIER_MAP: Record<string, number> = {
  cmd: 1 << 20, // NSEventModifierFlagCommand
  command: 1 << 20,
  ctrl: 1 << 18, // NSEventModifierFlagControl
  control: 1 << 18,
  alt: 1 << 19, // NSEventModifierFlagOption
  option: 1 << 19,
  shift: 1 << 17, // NSEventModifierFlagShift
};

function parseAccelerator(accel: string): { key: string; modifiers: number } {
  const parts = accel.split(/\+/g).map(p => p.trim().toLowerCase());
  let key = parts.pop() || '';
  let modifiers = 0;
  for (const part of parts) {
    if (part === 'cmdorctrl') {
      modifiers |= MODIFIER_MAP[process.platform === 'darwin' ? 'cmd' : 'ctrl'];
    } else if (MODIFIER_MAP[part] !== undefined) {
      modifiers |= MODIFIER_MAP[part];
    }
  }
  // Electron → Cocoa key names
  const keyMap: Record<string, string> = {
    plus: '+',
    up: '↑',    // ↑
    down: '↓',  // ↓
    left: '←',  // ←
    right: '→', // →
    escape: '',
    enter: '\r',
    return: '\r',
    tab: '\t',
    space: ' ',
    backspace: '\b',
    delete: '',
    home: '↖',  // ↖
    end: '↘',   // ↘
    pageup: '⇞',   // ⇞
    pagedown: '⇟', // ⇟
  };
  if (keyMap[key]) key = keyMap[key];
  // F-keys
  if (key.startsWith('f') && /^f\d+$/.test(key)) {
    const n = parseInt(key.slice(1), 10);
    if (n >= 1 && n <= 12) {
      key = String.fromCharCode(0xf703 + n); // NSF1FunctionKey = 0xF704, etc.
    }
  }
  return { key, modifiers };
}

// ---------------------------------------------------------------------------
// Role → Cocoa standard selector (sent to first responder)
// ---------------------------------------------------------------------------
const ROLE_SELECTOR: Record<string, string> = {
  undo: 'undo:',
  redo: 'redo:',
  cut: 'cut:',
  copy: 'copy:',
  paste: 'paste:',
  delete: 'delete:',
  selectAll: 'selectAll:',
  minimize: 'performMiniaturize:',
  close: 'performClose:',
  togglefullscreen: 'toggleFullScreen:',
  hide: 'hide:',
  hideOthers: 'hideOtherApplications:',
  unhide: 'unhideAllApplications:',
  quit: 'terminate:',
};

// ---------------------------------------------------------------------------
// Menu builder
// ---------------------------------------------------------------------------
let menuHandlerInstance: any = null;
let nextTag = 1;
const tagCallbacks = new Map<number, () => void>();

function getMenuHandler(): any {
  if (menuHandlerInstance) return menuHandlerInstance;

  const impl = (sender: any) => {
    try {
      const tag = Number(sender.tag);
      const cb = tagCallbacks.get(tag);
      if (cb) cb();
    } catch { /* ignore */ }
  };
  (impl as any).__nww_syncReturn = null;

  ObjC.registerSubclass({
    name: 'NwjxaMenuHandler',
    superclass: 'NSObject',
    methods: {
      'menuItemClicked:': {
        types: ['void', ['id']],
        implementation: impl,
      },
    },
  });
  menuHandlerInstance = $.NwjxaMenuHandler.alloc.init;
  return menuHandlerInstance;
}

function toNSString(str: string): any {
  return $.NSString.stringWithUTF8String(str);
}

export function buildCocoaMenu(
  items: MenuItemOptions[],
  resolveRole?: (role: string) => (() => void) | undefined,
): any {
  const menu = $.NSMenu.alloc.initWithTitle(toNSString(''));
  for (const item of items) {
    if (item.visible === false) continue;

    if (item.type === 'separator') {
      menu.addItem($.NSMenuItem.separatorItem);
      continue;
    }

    if (item.submenu && item.submenu.length > 0) {
      const sub = buildCocoaMenu(item.submenu, resolveRole);
      const subItem = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(
        toNSString(item.label || ''),
        toNSString(''),
        toNSString(''),
      );
      subItem.setSubmenu(sub);
      if (item.enabled === false) subItem.setEnabled(false);
      menu.addItem(subItem);
      continue;
    }

    const clickFn =
      item.click ??
      (item.role && resolveRole ? resolveRole(item.role) : undefined);
    const roleSel = item.role ? ROLE_SELECTOR[item.role] : undefined;

    let keyEquiv = '';
    let modifiers = 0;
    if (item.accelerator) {
      const parsed = parseAccelerator(item.accelerator);
      keyEquiv = parsed.key;
      modifiers = parsed.modifiers;
    }

    const nsItem = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(
      toNSString(item.label || ''),
      toNSString(roleSel || 'menuItemClicked:'),
      toNSString(keyEquiv),
    );

    if (roleSel) {
      // Standard Cocoa action → first responder
      nsItem.setTarget(null);
    } else if (clickFn) {
      const tag = nextTag++;
      tagCallbacks.set(tag, clickFn);
      nsItem.setTag(tag);
      nsItem.setTarget(getMenuHandler());
    }

    if (item.enabled === false) nsItem.setEnabled(false);
    if (modifiers) nsItem.setKeyEquivalentModifierMask(modifiers);
    menu.addItem(nsItem);
  }
  return menu;
}
