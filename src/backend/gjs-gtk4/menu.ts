import { imports } from '@devscholar/node-with-gjs';
import { MenuItemOptions } from '../../interfaces.js';

function getGtk() { return imports.gi.Gtk; }
function getGio()  { return imports.gi.Gio; }

// ---------------------------------------------------------------------------
// Accelerator helpers
// ---------------------------------------------------------------------------

function electronAccelToGtk(accel: string): string | null {
    const parts = accel.split('+');
    let mods = '';
    let keyPart = '';
    for (const p of parts) {
        switch (p.toLowerCase()) {
            case 'ctrl': case 'control': case 'cmdorctrl': case 'cmd': case 'command':
                mods += '<Ctrl>'; break;
            case 'shift': mods += '<Shift>'; break;
            case 'alt':   mods += '<Alt>';   break;
            case 'meta': case 'super': case 'windows': mods += '<Super>'; break;
            default: keyPart = p;
        }
    }
    if (!keyPart) return null;
    const key = _electronKeyToGtk(keyPart);
    return key ? mods + key : null;
}

function _electronKeyToGtk(key: string): string | null {
    const k = key.toLowerCase();
    if (k.length === 1) return k;
    const map: Record<string, string> = {
        'f1':'F1','f2':'F2','f3':'F3','f4':'F4','f5':'F5','f6':'F6',
        'f7':'F7','f8':'F8','f9':'F9','f10':'F10','f11':'F11','f12':'F12',
        'tab':'Tab','enter':'Return','return':'Return',
        'escape':'Escape','esc':'Escape',
        'space':'space','backspace':'BackSpace',
        'delete':'Delete','del':'Delete',
        'insert':'Insert','home':'Home','end':'End',
        'pageup':'Page_Up','pagedown':'Page_Down',
        'left':'Left','up':'Up','right':'Right','down':'Down',
        'plus':'plus','minus':'minus','-':'minus',
    };
    return map[k] ?? null;
}

// ---------------------------------------------------------------------------
// GjsMenuWindowRef — window methods needed by roleClick
// ---------------------------------------------------------------------------

export interface GjsMenuWindowRef {
    close(): void;
    minimize(): void;
    reload(): void;
    openDevTools(): void;
    isFullScreen(): boolean;
    setFullScreen(flag: boolean): void;
    executeJavaScript(code: string): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// GjsMenuManager
// ---------------------------------------------------------------------------

/**
 * Manages GTK menu state for one GjsGtk4Window instance.
 * Creates real GTK objects (Gio.Menu, Gio.SimpleAction, Gtk.PopoverMenuBar,
 * Gtk.ShortcutController) through the node-with-gjs proxy layer.
 */
export class GjsMenuManager {
    /** Keep all proxy objects alive to prevent GC-triggered release. */
    private _refs: any[] = [];
    private _shortcutController: any = null;

    constructor(
        private windowRef: GjsMenuWindowRef,
        private gtkWindow: any,
        private webView: any,
        private getWindowBox: () => any,
        private setWindowBox: (box: any) => void,
    ) {}

    roleClick(role: string): (() => void) | undefined {
        const w = this.windowRef;
        switch (role) {
            case 'close':            return () => w.close();
            case 'minimize':         return () => w.minimize();
            case 'reload':
            case 'forceReload':      return () => w.reload();
            case 'toggleDevTools':   return () => w.openDevTools();
            case 'togglefullscreen': return () => w.setFullScreen(!w.isFullScreen());
            case 'resetZoom':        return () => w.executeJavaScript('document.body.style.zoom="100%"');
            case 'zoomIn':           return () => w.executeJavaScript('document.body.style.zoom=(parseFloat(document.body.style.zoom||1)+0.1)+""');
            case 'zoomOut':          return () => w.executeJavaScript('document.body.style.zoom=Math.max(parseFloat(document.body.style.zoom||1)-0.1,0.25)+""');
            case 'undo':             return () => w.executeJavaScript("document.execCommand('undo')");
            case 'redo':             return () => w.executeJavaScript("document.execCommand('redo')");
            case 'cut':              return () => w.executeJavaScript("document.execCommand('cut')");
            case 'copy':             return () => w.executeJavaScript("document.execCommand('copy')");
            case 'paste':            return () => w.executeJavaScript("document.execCommand('paste')");
            case 'selectAll':        return () => w.executeJavaScript("document.execCommand('selectAll')");
            default:                 return undefined;
        }
    }

    applyMenu(menu: MenuItemOptions[]): void {
        const Gtk = getGtk();
        const Gio = getGio();

        // Clear old refs so old GTK objects can be GC'd
        this._refs = [];
        if (this._shortcutController) {
            try { this.gtkWindow.remove_controller(this._shortcutController); } catch { /* ignore */ }
            this._shortcutController = null;
        }

        const actionGroup = new Gio.SimpleActionGroup();
        const menuModel   = new Gio.Menu();
        const accelEntries: Array<{ gtkAccel: string; name: string }> = [];
        let idx = 0;

        const buildItems = (parent: any, items: MenuItemOptions[]) => {
            for (const item of items) {
                if (item.type === 'separator') {
                    parent.append_section(null, new Gio.Menu());
                } else if (item.submenu && item.submenu.length > 0) {
                    const sub = new Gio.Menu();
                    buildItems(sub, item.submenu);
                    parent.append_submenu(item.label || '', sub);
                    this._refs.push(sub);
                } else {
                    const name = `a${idx}`;
                    const capturedIdx = idx++;
                    const action = new Gio.SimpleAction({ name });
                    if (item.enabled === false) action.set_enabled(false);
                    const clickFn = item.click ?? (item.role ? this.roleClick(item.role) : undefined);
                    if (clickFn) {
                        action.connect('activate', () => clickFn());
                    }
                    actionGroup.add_action(action);
                    this._refs.push(action);
                    parent.append(item.label || '', `win.${name}`);
                    if (item.accelerator) {
                        const gtkAccel = electronAccelToGtk(item.accelerator);
                        if (gtkAccel) accelEntries.push({ gtkAccel, name });
                    }
                    void capturedIdx; // suppress unused warning
                }
            }
        };
        buildItems(menuModel, menu);
        this._refs.push(actionGroup, menuModel);

        const menuBar = new Gtk.PopoverMenuBar({ menu_model: menuModel });
        this._refs.push(menuBar);
        this.gtkWindow.insert_action_group('win', actionGroup);

        // Rebuild window box: [menuBar, webView]
        const oldBox = this.getWindowBox();
        if (oldBox) {
            try { oldBox.remove(this.webView); } catch { /* ignore */ }
        }
        const newBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
        newBox.append(menuBar);
        newBox.append(this.webView);
        this.setWindowBox(newBox);
        this._refs.push(newBox);
        this.gtkWindow.set_child(newBox);

        // Keyboard accelerators
        if (accelEntries.length > 0) {
            try {
                const sc = new Gtk.ShortcutController();
                sc.set_scope(Gtk.ShortcutScope.GLOBAL);
                for (const entry of accelEntries) {
                    const trigger = Gtk.ShortcutTrigger.parse_string(entry.gtkAccel);
                    const shortcutAction = Gtk.ShortcutAction.parse_string(`action(win.${entry.name})`);
                    if (trigger && shortcutAction) {
                        sc.add_shortcut(new Gtk.Shortcut({ trigger, action: shortcutAction }));
                        this._refs.push(trigger, shortcutAction);
                    }
                }
                this.gtkWindow.add_controller(sc);
                this._shortcutController = sc;
                this._refs.push(sc);
            } catch { /* accelerators are best-effort */ }
        }
    }

    popupMenu(items: MenuItemOptions[], x?: number, y?: number): void {
        const Gtk = getGtk();
        const Gio = getGio();
        const popupRefs: any[] = [];

        const actionGroup = new Gio.SimpleActionGroup();
        const popupModel  = new Gio.Menu();
        let pidx = 0;

        const buildPopupItems = (parent: any, list: MenuItemOptions[]) => {
            for (const item of list) {
                if (item.type === 'separator') {
                    parent.append_section(null, new Gio.Menu());
                } else if (item.submenu && item.submenu.length > 0) {
                    const sub = new Gio.Menu();
                    buildPopupItems(sub, item.submenu);
                    parent.append_submenu(item.label || '', sub);
                    popupRefs.push(sub);
                } else {
                    const pname = `p${pidx++}`;
                    const action = new Gio.SimpleAction({ name: pname });
                    if (item.enabled === false) action.set_enabled(false);
                    const clickFn = item.click ?? (item.role ? this.roleClick(item.role) : undefined);
                    if (clickFn) action.connect('activate', () => clickFn());
                    actionGroup.add_action(action);
                    popupRefs.push(action);
                    parent.append(item.label || '', `popup.${pname}`);
                }
            }
        };
        buildPopupItems(popupModel, items);
        popupRefs.push(actionGroup, popupModel);

        this.gtkWindow.insert_action_group('popup', actionGroup);

        const popover = new Gtk.PopoverMenu({ menu_model: popupModel });
        popover.set_parent(this.webView);
        popupRefs.push(popover);

        if (x !== undefined && y !== undefined) {
            try {
                const Gdk = imports.gi.Gdk;
                const rect = new Gdk.Rectangle();
                rect.x = Math.round(x);
                rect.y = Math.round(y);
                rect.width  = 1;
                rect.height = 1;
                popover.set_pointing_to(rect);
                popupRefs.push(rect);
            } catch { /* positioning is best-effort */ }
        }

        popover.popup();
        // popupRefs keeps the GTK objects alive until GC; that's fine for a popup.
        void popupRefs;
    }
}
