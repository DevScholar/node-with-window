import * as path from 'node:path';
import * as fs from 'node:fs';
import { OpenDialogOptions, SaveDialogOptions } from '../../interfaces.js';
import { _Gtk, _Gio } from './gtk-app.js';

export async function showOpenDialog(win: any, options: OpenDialogOptions): Promise<string[] | undefined> {
  if (!win) return undefined;

  return new Promise<string[] | undefined>((resolve) => {
    try {
      const dialog = new _Gtk.FileDialog();
      if (options.title) dialog.title = options.title;
      const openFolder = options.defaultPath
        ? _Gio.File.new_for_path(options.defaultPath)
        : _Gio.File.new_for_path(process.cwd());
      try { dialog.initial_folder = openFolder; } catch { /* ignore */ }

      const isMulti = options.properties?.includes('multiSelections');
      const isDir   = options.properties?.includes('openDirectory');

      // Async callback: GJS pushes result to eventQueue, Node.js resolves via Poll.
      // No while(!done) drainCallbacks() — Node.js event loop stays free.
      const callback = async (source: any, asyncResult: any) => {
        let result: string[] | undefined;
        try {
          if (isDir) {
            const folder = source.select_folder_finish(asyncResult);
            result = folder ? [folder.get_path()] : undefined;
          } else if (isMulti) {
            const list = source.open_multiple_finish(asyncResult);
            const count = list.get_n_items();
            result = [];
            for (let i = 0; i < count; i++) result.push(list.get_item(i).get_path());
          } else {
            const file = source.open_finish(asyncResult);
            result = file ? [file.get_path()] : undefined;
          }
        } catch { /* user cancelled */ }
        resolve(result);
      };

      if (isDir) dialog.select_folder(win, null, callback);
      else if (isMulti) dialog.open_multiple(win, null, callback);
      else dialog.open(win, null, callback);
    } catch (e) {
      console.warn('[gjs-gtk4] showOpenDialog failed:', e);
      resolve(undefined);
    }
  });
}

export async function showSaveDialog(win: any, options: SaveDialogOptions): Promise<string | undefined> {
  if (!win) return undefined;

  return new Promise<string | undefined>((resolve) => {
    try {
      const dialog = new _Gtk.FileDialog();
      if (options.title) dialog.title = options.title;
      const dp = options.defaultPath;
      if (dp) {
        try {
          const stat = fs.statSync(dp);
          if (stat.isDirectory()) {
            dialog.initial_folder = _Gio.File.new_for_path(dp);
          } else {
            dialog.initial_folder = _Gio.File.new_for_path(path.dirname(dp));
            dialog.initial_name = path.basename(dp);
          }
        } catch {
          dialog.initial_folder = _Gio.File.new_for_path(
            path.isAbsolute(dp) ? path.dirname(dp) : process.cwd()
          );
          dialog.initial_name = path.basename(dp);
        }
      } else {
        try { dialog.initial_folder = _Gio.File.new_for_path(process.cwd()); } catch { /* ignore */ }
      }

      dialog.save(win, null, async (source: any, asyncResult: any) => {
        let result: string | undefined;
        try {
          const file = source.save_finish(asyncResult);
          result = file ? file.get_path() : undefined;
        } catch { /* user cancelled */ }
        resolve(result);
      });
    } catch (e) {
      console.warn('[gjs-gtk4] showSaveDialog failed:', e);
      resolve(undefined);
    }
  });
}

export async function showMessageBox(
  win: any,
  options: { type?: string; title?: string; message: string; buttons?: string[] },
): Promise<number> {
  if (!win) return 0;

  const buttons = options.buttons || ['OK'];

  // Prefer AlertDialog (GTK 4.10+) — MessageDialog is deprecated since 4.10
  // and its response-id mapping is unreliable on newer GTK versions.
  if (_Gtk.AlertDialog) {
    try {
      return await new Promise<number>((resolve) => {
        const dialog = new _Gtk.AlertDialog({
          message: options.title || options.message,
          detail: options.title ? options.message : '',
          buttons,
          modal: true,
        });
        // Last button is conventionally Cancel; pressing Escape triggers it.
        try { dialog.cancel_button = buttons.length - 1; } catch { /* ignore */ }

        dialog.choose(win, null, async (source: any, asyncResult: any) => {
          let result = 0;
          try {
            result = source.choose_finish(asyncResult);
          } catch {
            // Dismissed via Escape or titlebar X → treat as last button (Cancel).
            result = buttons.length - 1;
          }
          resolve(result);
        });
      });
    } catch (e) {
      console.warn('[gjs-gtk4] AlertDialog failed, falling back to MessageDialog:', e);
    }
  }

  // Fallback for GTK < 4.10: Gtk.MessageDialog
  return new Promise<number>((resolve) => {
    try {
      const typeMap: Record<string, number> = {
        none:     0,  // Gtk.MessageType.OTHER
        info:     1,  // Gtk.MessageType.INFO
        warning:  2,  // Gtk.MessageType.WARNING
        question: 3,  // Gtk.MessageType.QUESTION
        error:    4,  // Gtk.MessageType.ERROR
      };

      const dialog = new _Gtk.MessageDialog({
        transient_for: win,
        modal: true,
        message_type: typeMap[options.type || 'none'] ?? 0,
        text: options.title || 'Message',
        secondary_text: options.message || '',
      });

      for (let i = 0; i < buttons.length; i++) {
        dialog.add_button(buttons[i], i);
      }

      dialog.connect('response', async (_d: any, response: number) => {
        const result = response >= 0 ? response : 0;
        _d.close();
        resolve(result);
      });

      dialog.present();
    } catch (e) {
      console.warn('[gjs-gtk4] showMessageBox failed:', e);
      resolve(0);
    }
  });
}
