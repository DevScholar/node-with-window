import * as path from 'node:path';
import { $, ObjC } from '@devscholar/node-with-jxa';
import type { OpenDialogOptions, SaveDialogOptions } from '../../interfaces.js';

function unwrapURLArray(nsArray: any): string[] {
  const result: string[] = [];
  try {
    const count = Number(nsArray.count);
    for (let i = 0; i < count; i++) {
      const url = nsArray.objectAtIndex(i);
      const pathStr = ObjC.unwrap(url.path) as string | null;
      if (pathStr) result.push(pathStr);
    }
  } catch { /* ignore */ }
  return result;
}

export function showOpenDialogSync(
  _win: unknown,
  options: OpenDialogOptions,
): string[] | undefined {
  try {
    const panel = $.NSOpenPanel.openPanel;
    panel.setCanChooseFiles(true);
    panel.setCanChooseDirectories(
      !!options.properties?.includes('openDirectory'),
    );
    panel.setAllowsMultipleSelection(
      !!options.properties?.includes('multiSelections'),
    );
    panel.setShowsHiddenFiles(
      !!options.properties?.includes('showHiddenFiles'),
    );
    if (options.title) panel.setMessage(options.title);
    if (options.defaultPath)
      panel.setDirectoryURL($.NSURL.fileURLWithPath(options.defaultPath));
    if (options.filters) {
      const types = $.NSMutableArray.alloc.init;
      for (const filter of options.filters) {
        for (const ext of filter.extensions) {
          types.addObject(ext);
        }
      }
      panel.setAllowedFileTypes(types);
    }
    // macOS 12 (Monterey) moved the open/save panel UI into a separate XPC
    // "open and save panel service".  Calling `[NSOpenPanel runModal]` under
    // that architecture fails with "The open file operation failed to connect
    // to the open and save panel service" (-1001).  `[NSApp runModalForWindow:]`
    // is the API Apple expects on macOS 12+ for app-modal panels.  (Tk hit the
    // exact same regression — see Tk bug 108ada5dc8.)
    const response = Number(
      $.NSApplication.sharedApplication.runModalForWindow(panel),
    );
    if (response === 1) {
      // NSModalResponseOK
      return unwrapURLArray(panel.URLs);
    }
  } catch (e) {
    console.warn('[jxa-cocoa] showOpenDialogSync failed:', e);
  }
  return undefined;
}

export function showSaveDialogSync(
  _win: unknown,
  options: SaveDialogOptions,
): string | undefined {
  try {
    const panel = $.NSSavePanel.savePanel;
    if (options.title) panel.setTitle(options.title);
    if (options.defaultPath) {
      const dp = options.defaultPath;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const stat = require('node:fs').statSync(dp);
        if (stat.isDirectory()) {
          panel.setDirectoryURL($.NSURL.fileURLWithPath(dp));
        } else {
          panel.setDirectoryURL(
            $.NSURL.fileURLWithPath(path.dirname(dp)),
          );
          panel.setNameFieldStringValue(path.basename(dp));
        }
      } catch {
        panel.setDirectoryURL(
          $.NSURL.fileURLWithPath(
            path.isAbsolute(dp) ? path.dirname(dp) : process.cwd(),
          ),
        );
        panel.setNameFieldStringValue(path.basename(dp));
      }
    }
    // Same macOS 12+ panel-service requirement as showOpenDialogSync.
    const response = Number(
      $.NSApplication.sharedApplication.runModalForWindow(panel),
    );
    if (response === 1) {
      return (ObjC.unwrap(panel.URL.path) as string) || undefined;
    }
  } catch (e) {
    console.warn('[jxa-cocoa] showSaveDialogSync failed:', e);
  }
  return undefined;
}

export function showMessageBoxSync(
  _win: unknown,
  options: {
    type?: string;
    title?: string;
    message: string;
    buttons?: string[];
  },
): number {
  try {
    const alert = $.NSAlert.alloc.init;
    if (options.title) alert.setMessageText(options.title);
    alert.setInformativeText(options.message);
    const buttons = options.buttons || ['OK'];
    for (const btn of buttons) {
      alert.addButtonWithTitle(btn);
    }
    const response = Number(alert.runModal);
    // NSAlertFirstButtonReturn = 1000, second = 1001, etc.
    return Math.max(0, response - 1000);
  } catch (e) {
    console.warn('[jxa-cocoa] showMessageBoxSync failed:', e);
  }
  return 0;
}

export async function showOpenDialog(
  _win: unknown,
  options: OpenDialogOptions,
): Promise<string[] | undefined> {
  return showOpenDialogSync(_win, options);
}

export async function showSaveDialog(
  _win: unknown,
  options: SaveDialogOptions,
): Promise<string | undefined> {
  return showSaveDialogSync(_win, options);
}

export async function showMessageBox(
  _win: unknown,
  options: {
    type?: string;
    title?: string;
    message: string;
    buttons?: string[];
    checkboxLabel?: string;
    checkboxChecked?: boolean;
  },
): Promise<{ response: number; checkboxChecked: boolean }> {
  const response = showMessageBoxSync(_win, options);
  return { response, checkboxChecked: false };
}
