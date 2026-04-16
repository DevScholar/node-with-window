import { BrowserWindow } from './browser-window.js';
import { OpenDialogOptions, SaveDialogOptions } from './interfaces.js';

type MessageBoxOptions = {
  type?: string;
  title?: string;
  message: string;
  buttons?: string[];
  defaultId?: number;
  checkboxLabel?: string;
  checkboxChecked?: boolean;
};
type MessageBoxResult = { response: number; checkboxChecked: boolean };
type OpenDialogResult = { canceled: boolean; filePaths: string[] };
type SaveDialogResult = { canceled: boolean; filePath: string | undefined };

function resolveWindow(winOrOpts: BrowserWindow | unknown): BrowserWindow | undefined {
  return winOrOpts instanceof BrowserWindow ? winOrOpts : BrowserWindow.getFocusedWindow();
}

function resolveOpts<T>(winOrOpts: BrowserWindow | T, opts?: T): T {
  return (winOrOpts instanceof BrowserWindow ? opts : winOrOpts) as T;
}

export const dialog = {
  async showOpenDialog(
    winOrOpts: BrowserWindow | OpenDialogOptions,
    options?: OpenDialogOptions
  ): Promise<OpenDialogResult> {
    const win = resolveWindow(winOrOpts);
    const opts = resolveOpts(winOrOpts, options) ?? ({} as OpenDialogOptions);
    const result = await win?.showOpenDialog(opts);
    if (!result || result.length === 0) return { canceled: true, filePaths: [] };
    return { canceled: false, filePaths: result };
  },

  async showSaveDialog(
    winOrOpts: BrowserWindow | SaveDialogOptions,
    options?: SaveDialogOptions
  ): Promise<SaveDialogResult> {
    const win = resolveWindow(winOrOpts);
    const opts = resolveOpts(winOrOpts, options) ?? ({} as SaveDialogOptions);
    const result = await win?.showSaveDialog(opts);
    if (!result) return { canceled: true, filePath: undefined };
    return { canceled: false, filePath: result };
  },

  async showMessageBox(
    winOrOpts: BrowserWindow | MessageBoxOptions,
    options?: MessageBoxOptions
  ): Promise<MessageBoxResult> {
    const win = resolveWindow(winOrOpts);
    const opts = resolveOpts(winOrOpts, options) ?? ({ message: '' } as MessageBoxOptions);
    const result = await win?.showMessageBox(opts);
    return result ?? { response: 0, checkboxChecked: false };
  },

  showOpenDialogSync(
    _winOrOpts: BrowserWindow | OpenDialogOptions,
    _options?: OpenDialogOptions
  ): string[] | undefined {
    console.warn('[node-with-window] showOpenDialogSync: not supported with async dialogs, use showOpenDialog');
    return undefined;
  },

  showSaveDialogSync(
    _winOrOpts: BrowserWindow | SaveDialogOptions,
    _options?: SaveDialogOptions
  ): string | undefined {
    console.warn('[node-with-window] showSaveDialogSync: not supported with async dialogs, use showSaveDialog');
    return undefined;
  },

  showMessageBoxSync(
    _winOrOpts: BrowserWindow | MessageBoxOptions,
    _options?: MessageBoxOptions
  ): number {
    console.warn('[node-with-window] showMessageBoxSync: not supported with async dialogs, use showMessageBox');
    return 0;
  },

  showErrorBox(title: string, content: string): void {
    const win = BrowserWindow.getFocusedWindow();
    void win?.showMessageBox({ type: 'error', title, message: content, buttons: ['OK'] });
  },
};
