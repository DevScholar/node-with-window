import { BrowserWindow } from './browser-window.js';
import { OpenDialogOptions, SaveDialogOptions } from './interfaces.js';

type MessageBoxOptions = {
  type?: string;
  title?: string;
  message: string;
  buttons?: string[];
  defaultId?: number;
};
type MessageBoxResult = { response: number };
type OpenDialogResult = { canceled: boolean; filePaths: string[] };
type SaveDialogResult = { canceled: boolean; filePath: string | undefined };

function resolveWindow(winOrOpts: BrowserWindow | unknown): BrowserWindow | undefined {
  return winOrOpts instanceof BrowserWindow ? winOrOpts : BrowserWindow.getFocusedWindow();
}

function resolveOpts<T>(winOrOpts: BrowserWindow | T, opts?: T): T {
  return (winOrOpts instanceof BrowserWindow ? opts : winOrOpts) as T;
}

export const dialog = {
  showOpenDialog(
    winOrOpts: BrowserWindow | OpenDialogOptions,
    options?: OpenDialogOptions
  ): Promise<OpenDialogResult> {
    const win = resolveWindow(winOrOpts);
    const opts = resolveOpts(winOrOpts, options) ?? ({} as OpenDialogOptions);
    const result = win?.showOpenDialog(opts);
    if (!result || result.length === 0) return Promise.resolve({ canceled: true, filePaths: [] });
    return Promise.resolve({ canceled: false, filePaths: result });
  },

  showSaveDialog(
    winOrOpts: BrowserWindow | SaveDialogOptions,
    options?: SaveDialogOptions
  ): Promise<SaveDialogResult> {
    const win = resolveWindow(winOrOpts);
    const opts = resolveOpts(winOrOpts, options) ?? ({} as SaveDialogOptions);
    const result = win?.showSaveDialog(opts);
    if (!result) return Promise.resolve({ canceled: true, filePath: undefined });
    return Promise.resolve({ canceled: false, filePath: result });
  },

  showMessageBox(
    winOrOpts: BrowserWindow | MessageBoxOptions,
    options?: MessageBoxOptions
  ): Promise<MessageBoxResult> {
    const win = resolveWindow(winOrOpts);
    const opts = resolveOpts(winOrOpts, options) ?? ({ message: '' } as MessageBoxOptions);
    const response = win?.showMessageBox(opts) ?? 0;
    return Promise.resolve({ response });
  },

  showOpenDialogSync(
    winOrOpts: BrowserWindow | OpenDialogOptions,
    options?: OpenDialogOptions
  ): string[] | undefined {
    const win = resolveWindow(winOrOpts);
    const opts = resolveOpts(winOrOpts, options) ?? ({} as OpenDialogOptions);
    const result = win?.showOpenDialog(opts);
    return result && result.length > 0 ? result : undefined;
  },

  showSaveDialogSync(
    winOrOpts: BrowserWindow | SaveDialogOptions,
    options?: SaveDialogOptions
  ): string | undefined {
    const win = resolveWindow(winOrOpts);
    const opts = resolveOpts(winOrOpts, options) ?? ({} as SaveDialogOptions);
    return win?.showSaveDialog(opts);
  },

  showMessageBoxSync(
    winOrOpts: BrowserWindow | MessageBoxOptions,
    options?: MessageBoxOptions
  ): number {
    const win = resolveWindow(winOrOpts);
    const opts = resolveOpts(winOrOpts, options) ?? ({ message: '' } as MessageBoxOptions);
    return win?.showMessageBox(opts) ?? 0;
  },

  showErrorBox(title: string, content: string): void {
    const win = BrowserWindow.getFocusedWindow();
    win?.showMessageBox({ type: 'error', title, message: content, buttons: ['OK'] });
  },
};
