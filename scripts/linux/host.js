// scripts/linux/host.js
// GJS host script for the node-with-window Linux backend.
// Spawned by GjsGtk4Window via: gjs -m host.js
// IPC: fd 3 = read commands from Node.js, fd 4 = write responses to Node.js
//
// Protocol (JSON lines):
//   Node.js -> GJS: { action, ...params }
//   GJS -> Node.js: { type: 'void' | 'result' | 'error' | 'ipc' | 'none' | 'exit', ... }
//
// The 'Poll' action is called periodically by Node.js to drain the ipcQueue
// (messages posted by the HTML page via window.webkit.messageHandlers.ipc).

import Gtk from 'gi://Gtk?version=4.0';
import WebKit from 'gi://WebKit?version=6.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
import System from 'system';

// ---------------------------------------------------------------------------
// Stream setup — fd 3 (Node.js -> GJS), fd 4 (GJS -> Node.js)
// ---------------------------------------------------------------------------

let UnixInputStream, UnixOutputStream;
try {
    const GioUnix = imports.gi.GioUnix;
    UnixInputStream = GioUnix.InputStream;
    UnixOutputStream = GioUnix.OutputStream;
} catch (_e) {
    UnixInputStream = Gio.UnixInputStream;
    UnixOutputStream = Gio.UnixOutputStream;
}

if (!UnixInputStream || !UnixOutputStream) {
    printerr('node-with-window linux host: cannot find Unix stream classes');
    System.exit(1);
}

const inStream  = new UnixInputStream({ fd: 3, close_fd: false });
const outStream = new UnixOutputStream({ fd: 4, close_fd: false });
const dataIn    = new Gio.DataInputStream({ base_stream: inStream });
const dataOut   = new Gio.DataOutputStream({ base_stream: outStream });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let gtkWindow   = null;  // Gtk.Window
let webView     = null;  // WebKit.WebView
let mainLoop    = null;  // GLib.MainLoop
let windowBox   = null;  // Gtk.Box (root child of window)
let iconPath    = null;  // icon file path (set during CreateWindow)
let isClosed    = false;

// Queue of JSON strings posted by the HTML renderer (webkit.messageHandlers.ipc)
const ipcQueue  = [];

let cm = null;  // WebKit.UserContentManager (set during CreateWindow)

// Gio.SimpleActionGroup for menu item actions
const menuActions     = new Gio.SimpleActionGroup();
let   menuActionIndex = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeLine(obj) {
    try {
        dataOut.put_string(JSON.stringify(obj) + '\n', null);
    } catch (_e) {
        System.exit(0);
    }
}

// ---------------------------------------------------------------------------
// Color parser — accepts #RGB, #RRGGBB, #AARRGGBB (Electron convention)
// ---------------------------------------------------------------------------

function parseHexColor(str) {
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

// ---------------------------------------------------------------------------
// Menu builder
// ---------------------------------------------------------------------------

function buildGtkMenu(items) {
    if (!gtkWindow || !webView) return;

    // Reset action group by creating a fresh one
    menuActionIndex = 0;

    const menuModel = new Gio.Menu();

    function buildItems(parent, list) {
        for (const item of list) {
            if (item.type === 'separator') {
                // Append an empty section which renders as a separator
                parent.append_section(null, new Gio.Menu());
            } else if (item.submenu && item.submenu.length > 0) {
                const sub = new Gio.Menu();
                buildItems(sub, item.submenu);
                parent.append_submenu(item.label || '', sub);
            } else {
                const name = `a${menuActionIndex}`;
                const idx  = menuActionIndex++;
                const action = new Gio.SimpleAction({ name });
                if (item.enabled === false) action.set_enabled(false);
                // When activated, push a menuClick event so Node.js can call the handler
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

    // Rebuild the window's child box with the menu bar on top.
    // webView must be removed from its current parent before reparenting.
    if (windowBox) windowBox.remove(webView);
    const newBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
    newBox.append(menuBar);
    newBox.append(webView);
    windowBox = newBox;
    gtkWindow.set_child(newBox);
}

// ---------------------------------------------------------------------------
// Synchronous dialogs — use a nested GLib.MainContext iteration loop so that
// the GTK event loop processes dialog events without returning control to the
// io_add_watch handler.
// ---------------------------------------------------------------------------

function runNestedLoop(getDone) {
    const ctx = GLib.MainContext.default();
    while (!getDone()) ctx.iteration(true);
}

function showOpenDialog(options) {
    if (!gtkWindow) return { type: 'result', value: null };

    const dialog = new Gtk.FileChooserDialog({
        title: options.title || 'Open File',
        action: Gtk.FileChooserAction.OPEN,
        transient_for: gtkWindow,
        modal: true,
    });
    dialog.add_button('_Cancel', Gtk.ResponseType.CANCEL);
    dialog.add_button('_Open',   Gtk.ResponseType.ACCEPT);

    const props = options.properties || ['openFile'];
    if (props.includes('multiSelections')) dialog.set_select_multiple(true);

    if (options.filters) {
        for (const f of options.filters) {
            const gf = new Gtk.FileFilter();
            gf.set_name(f.name);
            for (const ext of f.extensions)
                gf.add_pattern(ext === '*' ? '*' : `*.${ext}`);
            dialog.add_filter(gf);
        }
    }

    let result = null;
    let done   = false;
    dialog.connect('response', (d, response) => {
        if (response === Gtk.ResponseType.ACCEPT) {
            if (props.includes('multiSelections')) {
                const list = d.get_files();
                result = [];
                for (let i = 0; i < list.get_n_items(); i++) {
                    const f = list.get_item(i);
                    if (f) result.push(f.get_path());
                }
            } else {
                const f = d.get_file();
                if (f) result = [f.get_path()];
            }
        }
        d.close();
        done = true;
    });
    dialog.present();
    runNestedLoop(() => done);
    return { type: 'result', value: result };
}

function showSaveDialog(options) {
    if (!gtkWindow) return { type: 'result', value: null };

    const dialog = new Gtk.FileChooserDialog({
        title: options.title || 'Save File',
        action: Gtk.FileChooserAction.SAVE,
        transient_for: gtkWindow,
        modal: true,
    });
    dialog.add_button('_Cancel', Gtk.ResponseType.CANCEL);
    dialog.add_button('_Save',   Gtk.ResponseType.ACCEPT);

    if (options.filters) {
        for (const f of options.filters) {
            const gf = new Gtk.FileFilter();
            gf.set_name(f.name);
            for (const ext of f.extensions)
                gf.add_pattern(ext === '*' ? '*' : `*.${ext}`);
            dialog.add_filter(gf);
        }
    }

    if (options.defaultPath) {
        const basename = GLib.path_get_basename(options.defaultPath);
        if (basename) dialog.set_current_name(basename);
    }

    let result = null;
    let done   = false;
    dialog.connect('response', (d, response) => {
        if (response === Gtk.ResponseType.ACCEPT) {
            const f = d.get_file();
            if (f) result = f.get_path();
        }
        d.close();
        done = true;
    });
    dialog.present();
    runNestedLoop(() => done);
    return { type: 'result', value: result };
}

function showMessageBox(options) {
    if (!gtkWindow) return { type: 'result', value: 0 };

    const typeMap = {
        none:     Gtk.MessageType.OTHER,
        info:     Gtk.MessageType.INFO,
        error:    Gtk.MessageType.ERROR,
        question: Gtk.MessageType.QUESTION,
        warning:  Gtk.MessageType.WARNING,
    };

    const dialog = new Gtk.MessageDialog({
        transient_for: gtkWindow,
        modal: true,
        message_type: typeMap[options.type || 'none'] || Gtk.MessageType.OTHER,
        text: options.title || 'Message',
        secondary_text: options.message || '',
    });

    const buttons = options.buttons || ['OK'];
    for (let i = 0; i < buttons.length; i++)
        dialog.add_button(buttons[i], i);

    let result = 0;
    let done   = false;
    dialog.connect('response', (d, response) => {
        result = response >= 0 ? response : 0;
        d.close();
        done = true;
    });
    dialog.present();
    runNestedLoop(() => done);
    return { type: 'result', value: result };
}

// ---------------------------------------------------------------------------
// Command dispatcher
// ---------------------------------------------------------------------------

function executeCommand(cmd) {
    switch (cmd.action) {

        case 'CreateWindow': {
            const opts = cmd.options || {};

            Gtk.init();

            // WebKit UserContentManager — receives messages from ipcRenderer.send/invoke
            cm = new WebKit.UserContentManager();
            cm.register_script_message_handler('ipc', null);
            cm.connect('script-message-received', (_mgr, value) => {
                const msg = value.to_string();
                if (msg) ipcQueue.push(msg);
            });

            webView = new WebKit.WebView({
                vexpand: true,
                hexpand: true,
                user_content_manager: cm,
            });

            // Enable DevTools
            const settings = webView.get_settings();
            settings.enable_developer_extras = true;

            // webSecurity: false disables CORS and same-origin policy
            if (opts.webPreferences && opts.webPreferences.webSecurity === false) {
                settings.allow_file_access_from_file_urls = true;
                settings.allow_universal_access_from_file_urls = true;
            }

            gtkWindow = new Gtk.Window({
                title: opts.title || 'node-with-window',
                default_width:  opts.width  || 800,
                default_height: opts.height || 600,
            });

            if (opts.resizable === false) gtkWindow.set_resizable(false);
            if (opts.alwaysOnTop)         gtkWindow.set_keep_above(true);
            if (opts.icon)               iconPath = opts.icon;
            if (opts.fullscreen)         gtkWindow.fullscreen();

            // frame: false — remove window chrome (title bar + border).
            // transparent also implies frameless (compositor requires undecorated window).
            if (opts.frame === false || opts.transparent === true) {
                gtkWindow.set_decorated(false);
            }

            // transparent: true — transparent WebView background (compositor-dependent).
            if (opts.transparent === true) {
                try {
                    const transparentColor = new Gdk.RGBA();
                    transparentColor.red   = 0;
                    transparentColor.green = 0;
                    transparentColor.blue  = 0;
                    transparentColor.alpha = 0;
                    webView.set_background_color(transparentColor);
                } catch (_e) {
                    // Not all WebKitGTK versions support set_background_color; ignore.
                }
            } else if (opts.backgroundColor) {
                const parsed = parseHexColor(opts.backgroundColor);
                if (parsed) {
                    try {
                        const c = new Gdk.RGBA();
                        c.red   = parsed.r / 255;
                        c.green = parsed.g / 255;
                        c.blue  = parsed.b / 255;
                        c.alpha = parsed.a / 255;
                        webView.set_background_color(c);
                    } catch (_e) { /* ignore */ }
                }
            }

            // Exit cleanly when the user closes the window
            gtkWindow.connect('close-request', () => {
                isClosed = true;
                if (mainLoop) mainLoop.quit();
                return false; // allow default close behaviour
            });

            // Sync WebView document title -> window title bar
            webView.connect('notify::title', () => {
                const t = webView.title;
                if (t && gtkWindow) gtkWindow.set_title(t);
            });

            // Push a navigationCompleted event when the page finishes loading
            webView.connect('load-changed', (_wv, loadEvent) => {
                if (loadEvent === WebKit.LoadEvent.FINISHED) {
                    ipcQueue.push(JSON.stringify({ type: 'navigationCompleted' }));
                }
            });

            windowBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
            windowBox.append(webView);
            gtkWindow.set_child(windowBox);

            return { type: 'void' };
        }

        case 'Show': {
            if (gtkWindow) gtkWindow.present();
            if (iconPath) {
                try {
                    const texture = Gdk.Texture.new_from_filename(iconPath);
                    const surface = gtkWindow.get_surface();
                    if (surface) surface.set_icon_list([texture]);
                } catch (_e) {
                    // Icon loading is best-effort; ignore failures
                }
            }
            return { type: 'void' };
        }

        case 'SetMenu': {
            buildGtkMenu(cmd.menu || []);
            return { type: 'void' };
        }

        case 'LoadURL': {
            if (webView) webView.load_uri(cmd.url);
            return { type: 'void' };
        }

        case 'LoadHTML': {
            if (webView) webView.load_html(cmd.html, cmd.baseUri || null);
            return { type: 'void' };
        }

        case 'SetUserScript': {
            if (cm && cmd.code) {
                const script = new WebKit.UserScript(
                    cmd.code,
                    WebKit.UserContentInjectedFrames.ALL_FRAMES,
                    WebKit.UserScriptInjectionTime.START,
                    null,
                    null
                );
                cm.add_script(script);
            }
            return { type: 'void' };
        }

        case 'SendToRenderer': {
            if (webView) {
                // Fire-and-forget: we don't need the JS return value.
                // The empty callback satisfies GJS binding requirements.
                webView.evaluate_javascript(cmd.script, -1, null, null, null, () => {});
            }
            return { type: 'void' };
        }

        // Node.js calls Poll periodically to drain the WebKit IPC message queue.
        case 'Poll': {
            if (isClosed)           return { type: 'exit' };
            if (ipcQueue.length > 0) return { type: 'ipc', message: ipcQueue.shift() };
            return { type: 'none' };
        }

        case 'Reload': {
            if (webView) webView.reload();
            return { type: 'void' };
        }

        case 'OpenDevTools': {
            if (webView) {
                const inspector = webView.get_inspector();
                if (inspector) inspector.show();
            }
            return { type: 'void' };
        }

        case 'Focus': {
            if (gtkWindow) gtkWindow.present();
            return { type: 'void' };
        }

        case 'SetTitle': {
            if (gtkWindow) gtkWindow.set_title(cmd.title || '');
            return { type: 'void' };
        }

        case 'GetTitle': {
            return { type: 'result', value: gtkWindow ? (gtkWindow.get_title() || '') : '' };
        }

        case 'Minimize': {
            if (gtkWindow) gtkWindow.minimize();
            return { type: 'void' };
        }

        case 'Maximize': {
            if (gtkWindow) gtkWindow.maximize();
            return { type: 'void' };
        }

        case 'Unmaximize': {
            if (gtkWindow) gtkWindow.unmaximize();
            return { type: 'void' };
        }

        case 'SetFullScreen': {
            if (gtkWindow) {
                if (cmd.flag) gtkWindow.fullscreen();
                else          gtkWindow.unfullscreen();
            }
            return { type: 'void' };
        }

        case 'SetSize': {
            if (gtkWindow) gtkWindow.set_default_size(cmd.width, cmd.height);
            return { type: 'void' };
        }

        case 'GetSize': {
            const w = gtkWindow ? gtkWindow.get_width()  : 0;
            const h = gtkWindow ? gtkWindow.get_height() : 0;
            return { type: 'result', value: [w, h] };
        }

        case 'SetResizable': {
            if (gtkWindow) gtkWindow.set_resizable(cmd.flag);
            return { type: 'void' };
        }

        case 'SetAlwaysOnTop': {
            if (gtkWindow) gtkWindow.set_keep_above(cmd.flag);
            return { type: 'void' };
        }

        case 'SetMinimizable': {
            // GTK4 does not expose a direct API to hide the minimize button on most
            // compositors. We use set_deletable(false) for closable=false only.
            // For minimizable we set the window type hint as a best-effort approach.
            // No-op with a warning when the compositor does not honour the hint.
            if (!cmd.flag) {
                console.warn('[node-with-window] win.setMinimizable(false): GTK4 cannot reliably hide the minimize button on all compositors.');
            }
            return { type: 'void' };
        }

        case 'SetMaximizable': {
            if (gtkWindow) gtkWindow.set_resizable(cmd.flag ? true : false);
            return { type: 'void' };
        }

        case 'SetClosable': {
            // set_deletable controls the close button in the title bar.
            if (gtkWindow) gtkWindow.set_deletable(cmd.flag);
            return { type: 'void' };
        }

        case 'SetMovable': {
            // GTK4 removed gtk_window_set_decorated which was used to block moves.
            // Best effort: remove the title bar decoration entirely when movable=false.
            if (gtkWindow) gtkWindow.set_decorated(cmd.flag);
            return { type: 'void' };
        }

        case 'SetSkipTaskbar': {
            // set_skip_taskbar_hint is not available in GTK4 (removed).
            // Best effort via window type hint; most GNOME compositors ignore it.
            console.warn('[node-with-window] win.setSkipTaskbar(): not reliably supported in GTK4/GNOME.');
            return { type: 'void' };
        }

        case 'FlashFrame': {
            // GTK4 removed gtk_window_set_urgency_hint. Best effort via Gdk.Surface.
            try {
                if (gtkWindow && cmd.flag) {
                    const surface = gtkWindow.get_surface();
                    if (surface && surface.set_urgency_hint) {
                        surface.set_urgency_hint(true);
                    }
                }
            } catch (_e) {
                // Silently ignore — not all compositors / GDK backends support this.
            }
            return { type: 'void' };
        }

        case 'ShowOpenDialog':    return showOpenDialog(cmd.options || {});
        case 'ShowSaveDialog':    return showSaveDialog(cmd.options || {});
        case 'ShowMessageBox':    return showMessageBox(cmd.options || {});

        case 'Close': {
            isClosed = true;
            if (gtkWindow) gtkWindow.close();
            if (mainLoop)  mainLoop.quit();
            return { type: 'void' };
        }

        case 'SetFrame': {
            // Remove (false) or restore (true) window decorations (title bar + border).
            if (gtkWindow) gtkWindow.set_decorated(cmd.flag);
            return { type: 'void' };
        }

        case 'SetTransparent': {
            // Make the WebKit content background transparent (compositor-dependent).
            if (webView) {
                try {
                    const c = new Gdk.RGBA();
                    c.red   = 0;
                    c.green = 0;
                    c.blue  = 0;
                    c.alpha = cmd.flag ? 0 : 1;
                    webView.set_background_color(c);
                } catch (_e) { /* ignore */ }
            }
            if (gtkWindow && cmd.flag) gtkWindow.set_decorated(false);
            return { type: 'void' };
        }

        case 'SetBackgroundColor': {
            if (webView && cmd.color) {
                const parsed = parseHexColor(cmd.color);
                if (parsed) {
                    try {
                        const c = new Gdk.RGBA();
                        c.red   = parsed.r / 255;
                        c.green = parsed.g / 255;
                        c.blue  = parsed.b / 255;
                        c.alpha = parsed.a / 255;
                        webView.set_background_color(c);
                    } catch (_e) { /* ignore */ }
                }
            }
            return { type: 'void' };
        }

        default:
            return { type: 'error', message: `Unknown action: ${cmd.action}` };
    }
}

// ---------------------------------------------------------------------------
// IO watch — receive commands from Node.js while the GLib main loop runs
// ---------------------------------------------------------------------------

function bindIPCEvent() {
    const channel = GLib.IOChannel.unix_new(3);
    GLib.io_add_watch(channel, GLib.PRIORITY_DEFAULT, GLib.IOCondition.IN, () => {
        try {
            const [line] = dataIn.read_line_utf8(null);
            if (!line) {
                if (mainLoop) mainLoop.quit();
                return GLib.SOURCE_REMOVE;
            }

            let cmd;
            try { cmd = JSON.parse(line); }
            catch (_e) {
                writeLine({ type: 'error', message: `Invalid JSON: ${line}` });
                return GLib.SOURCE_CONTINUE;
            }

            let response;
            try { response = executeCommand(cmd); }
            catch (e) { response = { type: 'error', message: String(e) }; }

            writeLine(response);
        } catch (_e) {
            if (mainLoop) mainLoop.quit();
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

bindIPCEvent();

mainLoop = GLib.MainLoop.new(null, false);
mainLoop.run();
