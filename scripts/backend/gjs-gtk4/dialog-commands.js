// dialog-commands.js
// GJS helper: synchronous file/message dialogs via nested GLib.MainContext iteration.
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';

// Runs a nested GLib event loop until getDone() returns true or the timeout elapses.
// This lets modal dialogs process events without returning control to the
// outer io_add_watch handler. Without a timeout, a dialog that never responds
// (e.g. compositor crash) would freeze the GJS host indefinitely.
const NESTED_LOOP_TIMEOUT_MS = 30_000;

function runNestedLoop(getDone) {
    const ctx = GLib.MainContext.default();
    const deadline = Date.now() + NESTED_LOOP_TIMEOUT_MS;
    while (!getDone() && Date.now() < deadline) ctx.iteration(true);
}

export function showOpenDialog(gtkWindow, options) {
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

export function showSaveDialog(gtkWindow, options) {
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

export function showMessageBox(gtkWindow, options) {
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
