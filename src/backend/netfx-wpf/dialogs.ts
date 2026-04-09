import { OpenDialogOptions, SaveDialogOptions } from '../../interfaces.js';

let dotnet: unknown;

export function setDotNetInstance(instance: unknown): void {
  dotnet = instance;
}

export function showOpenDialog(options: OpenDialogOptions): Promise<string[] | undefined> {
  try {
    const dotnetAny = dotnet as any;
    const OpenFileDlgType = dotnetAny['Microsoft.Win32.OpenFileDialog'];
    const dlg = new OpenFileDlgType();

    if (options.title) dlg.Title = options.title;
    if (options.filters && options.filters.length > 0) {
      dlg.Filter = options.filters
        .map((f: { name: string; extensions: string[] }) => {
          const exts = f.extensions.map((e: string) => (e === '*' ? '*.*' : `*.${e}`)).join(';');
          return `${f.name}|${exts}`;
        })
        .join('|');
    }
    const props = options.properties || ['openFile'];
    dlg.Multiselect = props.includes('multiSelections');

    const ok = dlg.ShowDialog();
    if (ok) {
      const fileName: string = dlg.FileName;
      return Promise.resolve(fileName ? [fileName] : undefined);
    }
    return Promise.resolve(undefined);
  } catch (e) {
    console.error('[node-with-window] Open dialog error:', e);
    return Promise.resolve(undefined);
  }
}

export function showSaveDialog(options: SaveDialogOptions): Promise<string | undefined> {
  try {
    const dotnetAny = dotnet as any;
    const SaveFileDlgType = dotnetAny['Microsoft.Win32.SaveFileDialog'];
    const dlg = new SaveFileDlgType();

    if (options.title) dlg.Title = options.title;
    if (options.defaultPath) dlg.FileName = options.defaultPath;
    if (options.filters && options.filters.length > 0) {
      dlg.Filter = options.filters
        .map((f: { name: string; extensions: string[] }) => {
          const exts = f.extensions.map((e: string) => (e === '*' ? '*.*' : `*.${e}`)).join(';');
          return `${f.name}|${exts}`;
        })
        .join('|');
    }

    const ok = dlg.ShowDialog();
    if (ok) {
      const fileName: string = dlg.FileName;
      return Promise.resolve(fileName || undefined);
    }
    return Promise.resolve(undefined);
  } catch (e) {
    console.error('[node-with-window] Save dialog error:', e);
    return Promise.resolve(undefined);
  }
}

export function showMessageBox(options: {
  type?: string;
  title?: string;
  message: string;
  buttons?: string[];
}): Promise<number> {
  try {
    const System = (
      dotnet as unknown as {
        System: {
          Windows: {
            MessageBox: {
              Show: (msg: string, title: string, button: number, icon: number) => number;
            };
          };
        };
      }
    ).System;
    const Windows = System.Windows;

    const iconMap: Record<string, number> = {
      none: 0,
      info: 64,
      error: 16,
      question: 32,
      warning: 48,
    };
    const buttonMap: Record<string, number> = {
      OK: 0,
      OKCancel: 1,
      YesNo: 4,
      YesNoCancel: 3,
    };

    const iconType = iconMap[options.type || 'none'] || 0;
    const buttonType = options.buttons
      ? options.buttons.length <= 1
        ? buttonMap['OK']
        : options.buttons.length === 2
          ? buttonMap['YesNo']
          : options.buttons.length === 3
            ? buttonMap['YesNoCancel']
            : buttonMap['OKCancel']
      : buttonMap['OK'];

    const result = Windows.MessageBox.Show(
      options.message,
      options.title || 'Message',
      buttonType,
      iconType
    );
    let response = 0;
    if (result === 6) response = 0;
    else if (result === 7) response = 1;
    else if (result === 2) response = options.buttons && options.buttons.length > 2 ? 2 : 1;
    return Promise.resolve(response);
  } catch (e) {
    console.error('[node-with-window] MessageBox error:', e);
    return Promise.resolve(0);
  }
}
