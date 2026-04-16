import * as path from 'node:path';
import * as fs from 'node:fs';
import { OpenDialogOptions, SaveDialogOptions } from '../../interfaces.js';
import { _Gtk, _Gio } from './gtk-app.js';
import type Gtk from '@girs/gtk-4.0';
import type Gio from '@girs/gio-2.0';

export async function showOpenDialog(win: Gtk.ApplicationWindow | null, options: OpenDialogOptions): Promise<string[] | undefined> {
  if (!win) return undefined;

  return new Promise<string[] | undefined>((resolve) => {
    try {
      const dialog = new _Gtk.FileDialog() as Gtk.FileDialog;
      if (options.title) dialog.title = options.title;
      const openFolder = options.defaultPath
        ? _Gio.File.new_for_path(options.defaultPath)
        : _Gio.File.new_for_path(process.cwd());
      try { dialog.initial_folder = openFolder; } catch { /* ignore */ }

      const isMulti = options.properties?.includes('multiSelections');
      const isDir   = options.properties?.includes('openDirectory');

      const callback = (source: Gtk.FileDialog, asyncResult: Gio.AsyncResult) => {
        let result: string[] | undefined;
        try {
          if (isDir) {
            const folder = source.select_folder_finish(asyncResult);
            result = folder ? [folder.get_path()!] : undefined;
          } else if (isMulti) {
            const list = source.open_multiple_finish(asyncResult);
            const count = list.get_n_items();
            result = [];
            for (let i = 0; i < count; i++) result.push((list.get_item(i) as Gio.File).get_path()!);
          } else {
            const file = source.open_finish(asyncResult);
            result = file ? [file.get_path()!] : undefined;
          }
        } catch { /* user cancelled */ }
        resolve(result);
      };

      if (isDir) dialog.select_folder(win, null, callback as unknown as (...args: unknown[]) => void);
      else if (isMulti) dialog.open_multiple(win, null, callback as unknown as (...args: unknown[]) => void);
      else dialog.open(win, null, callback as unknown as (...args: unknown[]) => void);
    } catch (e) {
      console.warn('[gjs-gtk4] showOpenDialog failed:', e);
      resolve(undefined);
    }
  });
}

export async function showSaveDialog(win: Gtk.ApplicationWindow | null, options: SaveDialogOptions): Promise<string | undefined> {
  if (!win) return undefined;

  return new Promise<string | undefined>((resolve) => {
    try {
      const dialog = new _Gtk.FileDialog() as Gtk.FileDialog;
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

      dialog.save(win, null, ((source: Gtk.FileDialog, asyncResult: Gio.AsyncResult) => {
        let result: string | undefined;
        try {
          const file = source.save_finish(asyncResult);
          result = file ? file.get_path()! : undefined;
        } catch { /* user cancelled */ }
        resolve(result);
      }) as unknown as (...args: unknown[]) => void);
    } catch (e) {
      console.warn('[gjs-gtk4] showSaveDialog failed:', e);
      resolve(undefined);
    }
  });
}

export async function showMessageBox(
  win: Gtk.ApplicationWindow | null,
  options: { type?: string; title?: string; message: string; buttons?: string[]; checkboxLabel?: string; checkboxChecked?: boolean },
): Promise<{ response: number; checkboxChecked: boolean }> {
  if (!win) return { response: 0, checkboxChecked: false };

  const buttons = options.buttons || ['OK'];

  // When a checkbox is needed, always use Gtk.Dialog with custom content.
  if (options.checkboxLabel) {
    return new Promise<{ response: number; checkboxChecked: boolean }>((resolve) => {
      try {
        const dialog = new _Gtk.Dialog({
          title: options.title || options.message,
          transient_for: win,
          modal: true,
        } as unknown as Gtk.Dialog.ConstructorProps) as Gtk.Dialog;

        const contentArea = (dialog as unknown as { get_content_area: () => Gtk.Box }).get_content_area();

        const label = new _Gtk.Label({ label: options.message }) as Gtk.Label;
        (label as unknown as { margin_start: number }).margin_start = 12;
        (label as unknown as { margin_end: number }).margin_end = 12;
        (label as unknown as { margin_top: number }).margin_top = 12;
        (label as unknown as { margin_bottom: number }).margin_bottom = 8;
        (label as unknown as { xalign: number }).xalign = 0;
        (contentArea as unknown as { append: (w: unknown) => void }).append(label);

        const checkbox = new _Gtk.CheckButton({
          label: options.checkboxLabel,
          active: options.checkboxChecked ?? false,
        } as unknown as Gtk.CheckButton.ConstructorProps) as Gtk.CheckButton;
        (checkbox as unknown as { margin_start: number }).margin_start = 12;
        (checkbox as unknown as { margin_end: number }).margin_end = 12;
        (checkbox as unknown as { margin_bottom: number }).margin_bottom = 12;
        (contentArea as unknown as { append: (w: unknown) => void }).append(checkbox);

        for (let i = 0; i < buttons.length; i++) {
          (dialog as unknown as { add_button: (label: string, id: number) => void }).add_button(buttons[i], i);
        }

        (dialog as unknown as { connect: (sig: string, cb: (d: Gtk.Dialog, r: number) => void) => void })
          .connect('response', (d: Gtk.Dialog, response: number) => {
            const result = response >= 0 ? response : 0;
            const checked = (checkbox as unknown as { active: boolean }).active;
            (d as unknown as { close: () => void }).close();
            resolve({ response: result, checkboxChecked: checked });
          });

        (dialog as unknown as { present: () => void }).present();
      } catch (e) {
        console.warn('[gjs-gtk4] showMessageBox (checkbox) failed:', e);
        resolve({ response: 0, checkboxChecked: false });
      }
    });
  }

  // No checkbox — use AlertDialog (GTK ≥ 4.10) or MessageDialog fallback.
  if (_Gtk.AlertDialog) {
    try {
      const response = await new Promise<number>((resolve) => {
        const dialog = new _Gtk.AlertDialog({
          message: options.title || options.message,
          detail: options.title ? options.message : '',
          buttons,
          modal: true,
        } as Gtk.AlertDialog.ConstructorProps) as Gtk.AlertDialog;
        try { dialog.cancel_button = buttons.length - 1; } catch { /* ignore */ }

        dialog.choose(win, null, ((source: Gtk.AlertDialog, asyncResult: Gio.AsyncResult) => {
          let result = 0;
          try {
            result = source.choose_finish(asyncResult);
          } catch {
            result = buttons.length - 1;
          }
          resolve(result);
        }) as unknown as (...args: unknown[]) => void);
      });
      return { response, checkboxChecked: false };
    } catch (e) {
      console.warn('[gjs-gtk4] AlertDialog failed, falling back to MessageDialog:', e);
    }
  }

  const response = await new Promise<number>((resolve) => {
    try {
      const typeMap: Record<string, number> = {
        none:     0,
        info:     1,
        warning:  2,
        question: 3,
        error:    4,
      };

      const dialog = new _Gtk.MessageDialog({
        transient_for: win,
        modal: true,
        message_type: typeMap[options.type || 'none'] ?? 0,
        text: options.title || 'Message',
        secondary_text: options.message || '',
      } as unknown as Gtk.MessageDialog.ConstructorProps) as Gtk.MessageDialog;

      for (let i = 0; i < buttons.length; i++) {
        dialog.add_button(buttons[i], i);
      }

      dialog.connect('response', (_d: Gtk.MessageDialog, r: number) => {
        const result = r >= 0 ? r : 0;
        _d.close();
        resolve(result);
      });

      dialog.present();
    } catch (e) {
      console.warn('[gjs-gtk4] showMessageBox failed:', e);
      resolve(0);
    }
  });
  return { response, checkboxChecked: false };
}
