import { imports, drainCallbacks } from '@devscholar/node-with-gjs';
import { OpenDialogOptions, SaveDialogOptions } from '../../interfaces.js';

// Helpers to access GTK lazily (namespaces already initialised by window.ts).
function getGtk() { return imports.gi.Gtk; }
function getGLib() { return imports.gi.GLib; }

// SharedArrayBuffer used as a timer for Atomics.wait() sleeps.
// Allocated once and reused across all dialog calls.
const _sleepSab = new SharedArrayBuffer(4);
const _sleepArr = new Int32Array(_sleepSab);

/** Block the calling thread for ~ms milliseconds using Atomics.wait(). */
function sleep(ms: number) { Atomics.wait(_sleepArr, 0, 0, ms); }

/**
 * Spin until done() returns true, draining GJS callback events every 2 ms.
 * This allows GTK signal callbacks (dialog 'response') to be delivered while
 * the Node.js main thread is synchronously waiting for the dialog result.
 */
function waitForDialog(done: () => boolean) {
    const deadline = Date.now() + 30_000;
    while (!done() && Date.now() < deadline) {
        drainCallbacks();
        if (!done()) sleep(2);
    }
}

export function showOpenDialog(
    gtkWindow: any,
    options: OpenDialogOptions
): string[] | undefined {
    if (!gtkWindow) return undefined;
    const Gtk = getGtk();
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

    let result: string[] | undefined;
    let done = false;
    dialog.connect('response', (d: any, response: any) => {
        if (response === Gtk.ResponseType.ACCEPT) {
            if (props.includes('multiSelections')) {
                const list = d.get_files();
                const n: number = list.get_n_items();
                result = [];
                for (let i = 0; i < n; i++) {
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
    waitForDialog(() => done);
    return result;
}

export function showSaveDialog(
    gtkWindow: any,
    options: SaveDialogOptions
): string | undefined {
    if (!gtkWindow) return undefined;
    const Gtk = getGtk();
    const GLib = getGLib();
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
        const basename: string = GLib.path_get_basename(options.defaultPath);
        if (basename) dialog.set_current_name(basename);
    }

    let result: string | undefined;
    let done = false;
    dialog.connect('response', (d: any, response: any) => {
        if (response === Gtk.ResponseType.ACCEPT) {
            const f = d.get_file();
            if (f) result = f.get_path();
        }
        d.close();
        done = true;
    });
    dialog.present();
    waitForDialog(() => done);
    return result;
}

export function showMessageBox(
    gtkWindow: any,
    options: { type?: string; title?: string; message: string; buttons?: string[] }
): number {
    if (!gtkWindow) return 0;
    const Gtk = getGtk();
    const typeMap: Record<string, any> = {
        none:     Gtk.MessageType.OTHER,
        info:     Gtk.MessageType.INFO,
        error:    Gtk.MessageType.ERROR,
        question: Gtk.MessageType.QUESTION,
        warning:  Gtk.MessageType.WARNING,
    };
    const dialog = new Gtk.MessageDialog({
        transient_for: gtkWindow,
        modal: true,
        message_type: typeMap[options.type || 'none'] ?? Gtk.MessageType.OTHER,
        text: options.title || 'Message',
        secondary_text: options.message || '',
    });

    const buttons = options.buttons || ['OK'];
    for (let i = 0; i < buttons.length; i++)
        dialog.add_button(buttons[i], i);

    let result = 0;
    let done = false;
    dialog.connect('response', (d: any, response: any) => {
        result = response >= 0 ? response : 0;
        d.close();
        done = true;
    });
    dialog.present();
    waitForDialog(() => done);
    return result;
}
