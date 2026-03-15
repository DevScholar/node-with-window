// window-commands.js
// GJS commands that operate on Gtk.Window and its decorations:
// create, show, menu, title, size, state, appearance.
import Gtk from 'gi://Gtk?version=4.0';
import WebKit from 'gi://WebKit?version=6.0';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk?version=4.0';

// ---------------------------------------------------------------------------
// Menu builder
// ---------------------------------------------------------------------------

export function buildGtkMenu(gtkWindow, webView, windowBoxRef, menuActions, menuActionIndexRef, ipcQueue, items) {
    if (!gtkWindow || !webView) return;

    menuActionIndexRef.value = 0;
    const menuModel = new Gio.Menu();

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
            // set_keep_above was removed in GTK4; try it and fall back silently.
            if (opts.alwaysOnTop) {
                try { state.gtkWindow.set_keep_above(true); }
                catch (_e) { state.alwaysOnTopPending = true; }
            }
            if (opts.icon)    state.iconPathRef.value = opts.icon;
            if (opts.kiosk || opts.fullscreen) state.gtkWindow.fullscreen();

            // frame: false — remove window chrome (title bar + border).
            // transparent also implies frameless (compositor requires undecorated window).
            if (opts.frame === false || opts.transparent === true) {
                state.gtkWindow.set_decorated(false);
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
                cmd.menu || []
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
            if (state.gtkWindow) state.gtkWindow.set_keep_above(cmd.flag);
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
