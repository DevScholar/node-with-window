import { OpenDialogOptions, SaveDialogOptions } from '../../interfaces.js';
import type { DotnetProxy, DotNetObject } from './dotnet/types.js';

let dotnet: DotnetProxy;

export function setDotNetInstance(instance: DotnetProxy): void {
  dotnet = instance;
}

// ---------------------------------------------------------------------------
// C# custom dialog (checkbox support)
// Compiled once via addType() on first use.
// ---------------------------------------------------------------------------

const CHECKBOX_DIALOG_SOURCE = `
using System;
using System.Windows;
using System.Windows.Controls;
public static class NwwCheckboxDialog {
    public static int[] Show(string title, string message, string[] buttons, string checkboxLabel, bool checkboxChecked) {
        int[] result = new int[] { 0, 0 };
        Application.Current.Dispatcher.Invoke(new System.Action(() => {
            Window window = new Window();
            window.Title = title;
            window.SizeToContent = SizeToContent.WidthAndHeight;
            window.WindowStartupLocation = WindowStartupLocation.CenterScreen;
            window.ResizeMode = ResizeMode.NoResize;
            window.MinWidth = 320;

            StackPanel root = new StackPanel();
            root.Margin = new Thickness(20);

            TextBlock msgBlock = new TextBlock();
            msgBlock.Text = message;
            msgBlock.TextWrapping = TextWrapping.Wrap;
            msgBlock.MaxWidth = 400;
            msgBlock.Margin = new Thickness(0, 0, 0, 12);
            root.Children.Add(msgBlock);

            CheckBox cb = new CheckBox();
            cb.Content = checkboxLabel;
            cb.IsChecked = checkboxChecked;
            cb.Margin = new Thickness(0, 0, 0, 12);
            root.Children.Add(cb);

            StackPanel btnPanel = new StackPanel();
            btnPanel.Orientation = Orientation.Horizontal;
            btnPanel.HorizontalAlignment = HorizontalAlignment.Right;

            for (int i = 0; i < buttons.Length; i++) {
                Button btn = new Button();
                btn.Content = buttons[i];
                btn.MinWidth = 75;
                btn.Padding = new Thickness(10, 5, 10, 5);
                btn.Margin = new Thickness(5, 0, 0, 0);
                int idx = i;
                btn.Click += (s, e) => {
                    result[0] = idx;
                    result[1] = (cb.IsChecked == true) ? 1 : 0;
                    window.DialogResult = true;
                };
                btnPanel.Children.Add(btn);
            }

            root.Children.Add(btnPanel);
            window.Content = root;
            window.ShowDialog();
        }));
        return result;
    }
}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _checkboxDialogType: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getCheckboxDialogType(): any {
  if (_checkboxDialogType) return _checkboxDialogType;
  _checkboxDialogType = (dotnet as unknown as {
    addType: (source: string, refs: string[]) => { NwwCheckboxDialog: unknown };
  }).addType(CHECKBOX_DIALOG_SOURCE, [
    'PresentationFramework',
    'PresentationCore',
    'WindowsBase',
  ]).NwwCheckboxDialog;
  return _checkboxDialogType;
}

// ---------------------------------------------------------------------------

export function showOpenDialog(options: OpenDialogOptions): Promise<string[] | undefined> {
  try {
    const dotnetNs = dotnet as DotnetProxy & Record<string, DotNetObject>;
    const OpenFileDlgType = dotnetNs['Microsoft.Win32.OpenFileDialog'];
    const dlg: DotNetObject = new OpenFileDlgType();

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
    const dotnetNs = dotnet as DotnetProxy & Record<string, DotNetObject>;
    const SaveFileDlgType = dotnetNs['Microsoft.Win32.SaveFileDialog'];
    const dlg: DotNetObject = new SaveFileDlgType();

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
  checkboxLabel?: string;
  checkboxChecked?: boolean;
}): Promise<{ response: number; checkboxChecked: boolean }> {
  try {
    const buttons = options.buttons && options.buttons.length > 0 ? options.buttons : ['OK'];

    // Use custom WPF Window when a checkbox label is requested.
    if (options.checkboxLabel) {
      const dlgType = getCheckboxDialogType();
      const raw: unknown = (dlgType as { Show: (...args: unknown[]) => unknown }).Show(
        options.title || 'Message',
        options.message,
        buttons,
        options.checkboxLabel,
        options.checkboxChecked ?? false,
      );
      // raw is int[] from C#: [buttonIndex, checkboxState]
      const arr = raw as number[];
      return Promise.resolve({ response: arr[0] ?? 0, checkboxChecked: arr[1] === 1 });
    }

    // No checkbox — use the lightweight Win32 MessageBox.
    const System = dotnet.System;
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

    const result = (Windows as unknown as DotNetObject).MessageBox.Show(
      options.message,
      options.title || 'Message',
      buttonType,
      iconType
    );
    let response = 0;
    if (result === 6) response = 0;
    else if (result === 7) response = 1;
    else if (result === 2) response = options.buttons && options.buttons.length > 2 ? 2 : 1;
    return Promise.resolve({ response, checkboxChecked: false });
  } catch (e) {
    console.error('[node-with-window] MessageBox error:', e);
    return Promise.resolve({ response: 0, checkboxChecked: false });
  }
}
