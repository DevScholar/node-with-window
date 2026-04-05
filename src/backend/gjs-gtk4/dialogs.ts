import * as path from 'node:path';
import * as fs from 'node:fs';
import { drainCallbacks } from '@devscholar/node-with-gjs';
import { OpenDialogOptions, SaveDialogOptions } from '../../interfaces.js';
import { _Gtk, _Gio } from './gtk-app.js';

export function showOpenDialog(win: any, options: OpenDialogOptions): string[] | undefined {
  if (!win) return undefined;

  let result: string[] | undefined;
  let done = false;

  try {
    const dialog = new _Gtk.FileDialog();
    if (options.title) dialog.title = options.title;
    if (options.defaultPath) {
      try { dialog.initial_folder = _Gio.File.new_for_path(options.defaultPath); } catch { /* ignore */ }
    }

    const isMulti = options.properties?.includes('multiSelections');
    const isDir   = options.properties?.includes('openDirectory');

    const callback = (source: any, asyncResult: any) => {
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
      done = true;
    };

    if (isDir) dialog.select_folder(win, null, callback);
    else if (isMulti) dialog.open_multiple(win, null, callback);
    else dialog.open(win, null, callback);

    while (!done) drainCallbacks();
  } catch (e) {
    console.warn('[gjs-gtk4] showOpenDialog failed:', e);
  }

  return result;
}

export function showSaveDialog(win: any, options: SaveDialogOptions): string | undefined {
  if (!win) return undefined;

  let result: string | undefined;
  let done = false;

  try {
    const dialog = new _Gtk.FileDialog();
    if (options.title) dialog.title = options.title;
    if (options.defaultPath) {
      const dp = options.defaultPath;
      try {
        const stat = fs.statSync(dp);
        if (stat.isDirectory()) {
          dialog.initial_folder = _Gio.File.new_for_path(dp);
        } else {
          dialog.initial_folder = _Gio.File.new_for_path(path.dirname(dp));
          dialog.initial_name = path.basename(dp);
        }
      } catch {
        dialog.initial_name = path.basename(dp);
      }
    }

    dialog.save(win, null, (source: any, asyncResult: any) => {
      try {
        const file = source.save_finish(asyncResult);
        result = file ? file.get_path() : undefined;
      } catch { /* user cancelled */ }
      done = true;
    });

    while (!done) drainCallbacks();
  } catch (e) {
    console.warn('[gjs-gtk4] showSaveDialog failed:', e);
  }

  return result;
}

export function showMessageBox(
  win: any,
  options: { type?: string; title?: string; message: string; buttons?: string[] },
): number {
  if (!win) return 0;

  let result = 0;
  let done = false;

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

    const buttons = options.buttons || ['OK'];
    for (let i = 0; i < buttons.length; i++) {
      dialog.add_button(buttons[i], i);
    }

    dialog.connect('response', (_d: any, response: number) => {
      result = response >= 0 ? response : 0;
      _d.close();
      done = true;
    });

    dialog.present();
    while (!done) drainCallbacks();
  } catch (e) {
    console.warn('[gjs-gtk4] showMessageBox failed:', e);
  }

  return result;
}
