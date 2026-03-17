// window-commands.js
// GJS commands that operate on Gtk.Window and its decorations:
// create, show, menu, title, size, state, appearance.
import Gtk from 'gi://Gtk?version=4.0';
import WebKit from 'gi://WebKit?version=6.0';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';

// ---------------------------------------------------------------------------
// Accelerator helpers
// ---------------------------------------------------------------------------

/** Convert an Electron accelerator string to a GTK accelerator string. */
function electronAccelToGtk(accel) {
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
    if (!key) return null;
    return mods + key;
}

function _electronKeyToGtk(key) {
    const k = key.toLowerCase();
    if (k.length === 1) return k; // letters and digits pass through as-is
    const map = {
        'f1': 'F1',  'f2': 'F2',  'f3': 'F3',  'f4': 'F4',
        'f5': 'F5',  'f6': 'F6',  'f7': 'F7',  'f8': 'F8',
        'f9': 'F9',  'f10': 'F10', 'f11': 'F11', 'f12': 'F12',
        'tab': 'Tab',
        'enter': 'Return', 'return': 'Return',
        'escape': 'Escape', 'esc': 'Escape',
        'space': 'space', 'backspace': 'BackSpace',
        'delete': 'Delete', 'del': 'Delete',
        'insert': 'Insert',
        'home': 'Home', 'end': 'End',
        'pageup': 'Page_Up', 'pagedown': 'Page_Down',
        'left': 'Left', 'up': 'Up', 'right': 'Right', 'down': 'Down',
        'plus': 'plus', 'minus': 'minus', '-': 'minus',
    };
    return map[k] || null;
}

// ---------------------------------------------------------------------------
// Menu builder
// ---------------------------------------------------------------------------

export function buildGtkMenu(gtkWindow, webView, windowBoxRef, menuActions, menuActionIndexRef, ipcQueue, items, state) {
    if (!gtkWindow || !webView) return;

    menuActionIndexRef.value = 0;
    const menuModel = new Gio.Menu();

    // Collect (gtkAccel, win-group action name) pairs for ShortcutController.
    const accelEntries = [];

    function buildItems(parent, list) {
        for (const item of list) {
            if (item.type === 'separator') {
                parent.append_section(null, new Gio.Menu());
            } else if (item.submenu && item.submenu.length > 0) {
                const sub = new Gio.Menu();
                buildItems(sub, item.submenu);
                parent.append_submenu(item.label || '', sub);
            } else {
                const name = `a${menuActionIndexRef.value}`;
                const idx  = menuActionIndexRef.value++;
                const action = new Gio.SimpleAction({ name });
                if (item.enabled === false) action.set_enabled(false);
                action.connect('activate', () => {
                    ipcQueue.push(JSON.stringify({ type: 'menuClick', id: idx }));
                });
                menuActions.add_action(action);
                parent.append(item.label || '', `win.${name}`);

                // Register keyboard shortcut for items that have an accelerator.
                if (item.accelerator) {
                    const gtkAccel = electronAccelToGtk(item.accelerator);
                    if (gtkAccel) accelEntries.push({ gtkAccel, name });
                }
            }
        }
    }

    buildItems(menuModel, items);

    const menuBar = new Gtk.PopoverMenuBar({ menu_model: menuModel });
    gtkWindow.insert_action_group('win', menuActions);

    if (windowBoxRef.value) windowBoxRef.value.remove(webView);
    const newBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
    newBox.append(menuBar);
    newBox.append(webView);
    windowBoxRef.value = newBox;
    gtkWindow.set_child(newBox);

    // Install (or replace) a ShortcutController for keyboard accelerators.
    if (state) {
        if (state.shortcutController) {
            try { gtkWindow.remove_controller(state.shortcutController); } catch (_e) {}
            state.shortcutController = null;
        }
        if (accelEntries.length > 0) {
            try {
                const sc = new Gtk.ShortcutController();
                sc.set_scope(Gtk.ShortcutScope.GLOBAL);
                for (const entry of accelEntries) {
                    const trigger = Gtk.ShortcutTrigger.parse_string(entry.gtkAccel);
                    const shortcutAction = Gtk.ShortcutAction.parse_string(`action(win.${entry.name})`);
                    if (trigger && shortcutAction) {
                        sc.add_shortcut(new Gtk.Shortcut({ trigger, action: shortcutAction }));
                    }
                }
                gtkWindow.add_controller(sc);
                state.shortcutController = sc;
            } catch (_e) { /* accelerators are best-effort */ }
        }
    }
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

export function handleWindowCommand(cmd, state) {
    // state = { gtkWindow, webView, windowBoxRef, menuActions, menuActionIndexRef,
    //           ipcQueue, iconPathRef, isClosedRef, mainLoop, cm }

    switch (cmd.action) {

        case 'CreateWindow': {
            const opts = cmd.options || {};
            Gtk.init();

            state.cm = new WebKit.UserContentManager();
            state.cm.register_script_message_handler('ipc', null);
            state.cm.connect('script-message-received', (_mgr, value) => {
                const msg = value.to_string();
                if (msg) state.ipcQueue.push(msg);
            });

            state.webView = new WebKit.WebView({
                vexpand: true,
                hexpand: true,
                user_content_manager: state.cm,
            });

            const settings = state.webView.get_settings();
            settings.enable_developer_extras = true;

            if (opts.webPreferences && opts.webPreferences.webSecurity === false) {
                settings.allow_file_access_from_file_urls = true;
                settings.allow_universal_access_from_file_urls = true;
            }

            state.gtkWindow = new Gtk.Window({
                title: opts.title || 'node-with-window',
                default_width:  opts.width  || 800,
                default_height: opts.height || 600,
            });

            if (opts.resizable === false) state.gtkWindow.set_resizable(false);
            // Kiosk mode: fullscreen + prevent resizing out of fullscreen.
            if (opts.kiosk) {
                state.gtkWindow.fullscreen();
                state.gtkWindow.set_resizable(false);
            } else if (opts.fullscreen) {
                state.gtkWindow.fullscreen();
            }
            // set_keep_above was removed in GTK4; try it and fall back silently.
            if (opts.alwaysOnTop) {
                try { state.gtkWindow.set_keep_above(true); }
                catch (_e) { state.alwaysOnTopPending = true; }
            }
            if (opts.icon)    state.iconPathRef.value = opts.icon;
            if (opts.minWidth > 0 || opts.minHeight > 0) {
                state.gtkWindow.set_size_request(
                    opts.minWidth  > 0 ? opts.minWidth  : -1,
                    opts.minHeight > 0 ? opts.minHeight : -1
                );
            }

            // frame: false — remove window chrome (title bar + border).
            // transparent also implies frameless (compositor requires undecorated window).
            if (opts.frame === false || opts.transparent === true) {
                state.gtkWindow.set_decorated(false);
            }

            // titleBarStyle: 'hidden'/'hiddenInset' — replace the default GTK headerbar
            // with an empty zero-height box so the window retains its resize border while
            // the native title bar is hidden.  Only applied when frame is not already false
            // (which calls set_decorated(false) above, removing all chrome including borders).
            if (opts.frame !== false && !opts.transparent &&
                    (opts.titleBarStyle === 'hidden' || opts.titleBarStyle === 'hiddenInset')) {
                const emptyBar = new Gtk.Box({ height_request: 0 });
                state.gtkWindow.set_titlebar(emptyBar);
            }

            // transparent: true — transparent window + WebView background.
            // GTK4 removes gtk_widget_set_app_paintable; use CSS instead.
            if (opts.transparent === true) {
                const cssProvider = new Gtk.CssProvider();
                cssProvider.load_from_string('.nww-transparent { background-color: transparent; box-shadow: none; }');
                Gtk.StyleContext.add_provider_for_display(
                    Gdk.Display.get_default(),
                    cssProvider,
                    Gtk.STYLE_PROVIDER_PRIORITY_USER
                );
                state.gtkWindow.add_css_class('nww-transparent');
                try {
                    const c = new Gdk.RGBA();
                    c.red = c.green = c.blue = c.alpha = 0;
                    state.webView.set_background_color(c);
                } catch (_e) { /* not all WebKitGTK versions support this */ }
            } else if (opts.backgroundColor) {
                const parsed = parseHexColor(opts.backgroundColor);
                if (parsed) {
                    try {
                        const c = new Gdk.RGBA();
                        c.red   = parsed.r / 255;
                        c.green = parsed.g / 255;
                        c.blue  = parsed.b / 255;
                        c.alpha = parsed.a / 255;
                        state.webView.set_background_color(c);
                    } catch (_e) { /* ignore */ }
                }
            }

            state.gtkWindow.connect('close-request', () => {
                state.isClosedRef.value = true;
                if (state.mainLoop) state.mainLoop.quit();
                return false;
            });

            state.webView.connect('notify::title', () => {
                const t = state.webView.title;
                if (t && state.gtkWindow) state.gtkWindow.set_title(t);
            });

            state.webView.connect('load-changed', (_wv, loadEvent) => {
                if (loadEvent === WebKit.LoadEvent.FINISHED)
                    state.ipcQueue.push(JSON.stringify({ type: 'navigationCompleted' }));
            });

            state.windowBoxRef.value = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
            if (opts.transparent) state.windowBoxRef.value.add_css_class('nww-transparent');
            state.windowBoxRef.value.append(state.webView);
            state.gtkWindow.set_child(state.windowBoxRef.value);

            return { type: 'void' };
        }

        case 'Show': {
            if (state.gtkWindow) state.gtkWindow.present();
            // GTK4 fallback for alwaysOnTop: try GdkToplevel after the surface exists.
            if (state.alwaysOnTopPending) {
                try {
                    const surface = state.gtkWindow.get_surface();
                    if (surface && typeof surface.set_keep_above === 'function')
                        surface.set_keep_above(true);
                } catch (_e) { /* compositor may not support keep-above */ }
                state.alwaysOnTopPending = false;
            }
            if (state.iconPathRef.value) {
                try {
                    const texture = Gdk.Texture.new_from_filename(state.iconPathRef.value);
                    const surface = state.gtkWindow.get_surface();
                    if (surface) surface.set_icon_list([texture]);
                } catch (_e) { /* icon loading is best-effort */ }
            }
            return { type: 'void' };
        }

        case 'SetMenu': {
            buildGtkMenu(
                state.gtkWindow, state.webView, state.windowBoxRef,
                state.menuActions, state.menuActionIndexRef, state.ipcQueue,
                cmd.menu || [], state
            );
            return { type: 'void' };
        }

        case 'Focus': {
            if (state.gtkWindow) state.gtkWindow.present();
            return { type: 'void' };
        }

        case 'SetTitle': {
            if (state.gtkWindow) state.gtkWindow.set_title(cmd.title || '');
            return { type: 'void' };
        }

        case 'GetTitle': {
            return { type: 'result', value: state.gtkWindow ? (state.gtkWindow.get_title() || '') : '' };
        }

        case 'Minimize': {
            if (state.gtkWindow) state.gtkWindow.minimize();
            return { type: 'void' };
        }

        case 'Maximize': {
            if (state.gtkWindow) state.gtkWindow.maximize();
            return { type: 'void' };
        }

        case 'Unmaximize': {
            if (state.gtkWindow) state.gtkWindow.unmaximize();
            return { type: 'void' };
        }

        case 'SetFullScreen': {
            if (state.gtkWindow) {
                if (cmd.flag) state.gtkWindow.fullscreen();
                else          state.gtkWindow.unfullscreen();
            }
            return { type: 'void' };
        }

        case 'SetSize': {
            if (state.gtkWindow) state.gtkWindow.set_default_size(cmd.width, cmd.height);
            return { type: 'void' };
        }

        case 'GetSize': {
            const w = state.gtkWindow ? state.gtkWindow.get_width()  : 0;
            const h = state.gtkWindow ? state.gtkWindow.get_height() : 0;
            return { type: 'result', value: [w, h] };
        }

        case 'SetResizable': {
            if (state.gtkWindow) state.gtkWindow.set_resizable(cmd.flag);
            return { type: 'void' };
        }

        case 'SetAlwaysOnTop': {
            if (state.gtkWindow) {
                try { state.gtkWindow.set_keep_above(cmd.flag); }
                catch (_e) { /* compositor may not support set_keep_above; ignore */ }
            }
            return { type: 'void' };
        }

        case 'SetMinimizable': {
            if (!cmd.flag)
                console.warn('[node-with-window] win.setMinimizable(false): GTK4 cannot reliably hide the minimize button on all compositors.');
            return { type: 'void' };
        }

        case 'SetMaximizable': {
            if (state.gtkWindow) state.gtkWindow.set_resizable(!!cmd.flag);
            return { type: 'void' };
        }

        case 'SetClosable': {
            if (state.gtkWindow) state.gtkWindow.set_deletable(cmd.flag);
            return { type: 'void' };
        }

        case 'SetMovable': {
            if (state.gtkWindow) state.gtkWindow.set_decorated(cmd.flag);
            return { type: 'void' };
        }

        case 'SetSkipTaskbar': {
            console.warn('[node-with-window] win.setSkipTaskbar(): not reliably supported in GTK4/GNOME.');
            return { type: 'void' };
        }

        case 'FlashFrame': {
            try {
                if (state.gtkWindow && cmd.flag) {
                    const surface = state.gtkWindow.get_surface();
                    if (surface && surface.set_urgency_hint)
                        surface.set_urgency_hint(true);
                }
            } catch (_e) { /* compositor may not support urgency hints */ }
            return { type: 'void' };
        }

        case 'SetFrame': {
            if (state.gtkWindow) state.gtkWindow.set_decorated(cmd.flag);
            return { type: 'void' };
        }

        case 'SetTransparent': {
            if (state.webView) {
                try {
                    const c = new Gdk.RGBA();
                    c.red = c.green = c.blue = 0;
                    c.alpha = cmd.flag ? 0 : 1;
                    state.webView.set_background_color(c);
                } catch (_e) { /* ignore */ }
            }
            if (state.gtkWindow && cmd.flag) state.gtkWindow.set_decorated(false);
            return { type: 'void' };
        }

        case 'SetBackgroundColor': {
            if (state.webView && cmd.color) {
                const parsed = parseHexColor(cmd.color);
                if (parsed) {
                    try {
                        const c = new Gdk.RGBA();
                        c.red   = parsed.r / 255;
                        c.green = parsed.g / 255;
                        c.blue  = parsed.b / 255;
                        c.alpha = parsed.a / 255;
                        state.webView.set_background_color(c);
                    } catch (_e) { /* ignore */ }
                }
            }
            return { type: 'void' };
        }

        case 'SetSensitive': {
            if (state.gtkWindow) {
                try { state.gtkWindow.set_sensitive(cmd.sensitive !== false); } catch (_e) { /* ignore */ }
            }
            return { type: 'void' };
        }

        case 'Close': {
            state.isClosedRef.value = true;
            if (state.gtkWindow) state.gtkWindow.close();
            if (state.mainLoop)  state.mainLoop.quit();
            return { type: 'void' };
        }

        case 'CaptureSnapshot': {
            if (!state.webView) return { type: 'result', value: '' };

            let done = false;
            let base64Result = '';
            const tmpPath = GLib.build_filenamev([GLib.get_tmp_dir(), `nww-snap-${Date.now()}.png`]);

            state.webView.get_snapshot(
                WebKit.SnapshotRegion.VISIBLE,
                WebKit.SnapshotOptions.NONE,
                null,
                (_wv, asyncResult) => {
                    try {
                        const surface = state.webView.get_snapshot_finish(asyncResult);
                        if (surface) {
                            surface.writeToPNG(tmpPath);
                            const [ok, bytes] = GLib.file_get_contents(tmpPath);
                            if (ok && bytes) base64Result = GLib.base64_encode(bytes);
                            try { GLib.unlink(tmpPath); } catch (_e) { /* ignore */ }
                        }
                    } catch (e) {
                        console.error('[node-with-window] capturePage error:', e.message || e);
                    }
                    done = true;
                }
            );

            const ctx = GLib.MainContext.default();
            const deadline = Date.now() + 10_000;
            while (!done && Date.now() < deadline) ctx.iteration(true);

            return { type: 'result', value: base64Result };
        }

        case 'SetMinSize': {
            if (state.gtkWindow) {
                state.gtkWindow.set_size_request(
                    cmd.minWidth  > 0 ? cmd.minWidth  : -1,
                    cmd.minHeight > 0 ? cmd.minHeight : -1
                );
            }
            return { type: 'void' };
        }

        case 'PopupMenu': {
            if (!state.gtkWindow || !state.webView) return { type: 'void' };
            const popupActions = new Gio.SimpleActionGroup();
            const popupModel = new Gio.Menu();
            let pidx = 0;

            function buildPopupItems(parent, list) {
                for (const item of list) {
                    if (item.type === 'separator') {
                        parent.append_section(null, new Gio.Menu());
                    } else if (item.submenu && item.submenu.length > 0) {
                        const sub = new Gio.Menu();
                        buildPopupItems(sub, item.submenu);
                        parent.append_submenu(item.label || '', sub);
                    } else {
                        const pname = `p${pidx}`;
                        const pidxCaptured = pidx++;
                        const paction = new Gio.SimpleAction({ name: pname });
                        if (item.enabled === false) paction.set_enabled(false);
                        paction.connect('activate', () => {
                            state.ipcQueue.push(JSON.stringify({ type: 'popupMenuClick', id: pidxCaptured }));
                        });
                        popupActions.add_action(paction);
                        parent.append(item.label || '', `popup.${pname}`);
                    }
                }
            }

            buildPopupItems(popupModel, cmd.items || []);
            state.gtkWindow.insert_action_group('popup', popupActions);

            const popover = new Gtk.PopoverMenu({ menu_model: popupModel });
            popover.set_parent(state.webView);

            if (cmd.x !== undefined && cmd.y !== undefined) {
                try {
                    const rect = new Gdk.Rectangle();
                    rect.x = Math.round(cmd.x);
                    rect.y = Math.round(cmd.y);
                    rect.width  = 1;
                    rect.height = 1;
                    popover.set_pointing_to(rect);
                } catch (_e) { /* positioning is best-effort */ }
            }

            popover.popup();
            return { type: 'void' };
        }

        default:
            return null; // not handled here
    }
}

// ---------------------------------------------------------------------------
// Color parser — accepts #RGB, #RRGGBB, #AARRGGBB (Electron convention)
// Kept here because window-commands is the primary consumer.
// ---------------------------------------------------------------------------

export function parseHexColor(str) {
    if (!str || str[0] !== '#') return null;
    const s = str.slice(1);
    if (s.length === 3) {
        return {
            a: 255,
            r: parseInt(s[0] + s[0], 16),
            g: parseInt(s[1] + s[1], 16),
            b: parseInt(s[2] + s[2], 16),
        };
    }
    if (s.length === 6) {
        return {
            a: 255,
            r: parseInt(s.slice(0, 2), 16),
            g: parseInt(s.slice(2, 4), 16),
            b: parseInt(s.slice(4, 6), 16),
        };
    }
    if (s.length === 8) {
        return {
            a: parseInt(s.slice(0, 2), 16),
            r: parseInt(s.slice(2, 4), 16),
            g: parseInt(s.slice(4, 6), 16),
            b: parseInt(s.slice(6, 8), 16),
        };
    }
    return null;
}
