import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';

export const shell = {
  openExternal(url: string): void {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  },

  openPath(filePath: string): void {
    if (process.platform === 'win32') {
      spawn('explorer', [filePath], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' }).unref();
    }
  },

  showItemInFolder(filePath: string): void {
    if (process.platform === 'win32') {
      spawn('explorer', ['/select,', filePath], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', ['-R', filePath], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [dirname(filePath)], { detached: true, stdio: 'ignore' }).unref();
    }
  },

  beep(): void {
    process.stdout.write('\x07');
  },

  /**
   * Moves a file or directory to the system trash (Recycle Bin on Windows).
   * Returns a Promise that rejects if the path does not exist or the operation fails.
   */
  trashItem(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        // Determine if path is a file or directory to call the correct VB method.
        let isDir = false;
        try {
          isDir = statSync(filePath).isDirectory();
        } catch (e) {
          reject(new Error(`shell.trashItem: path not found: ${filePath}`));
          return;
        }

        const escapedPath = filePath.replace(/'/g, "''");
        const method = isDir
          ? `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${escapedPath}', 'OnlyErrorDialogs', 'SendToRecycleBin')`
          : `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${escapedPath}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;

        const ps = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command',
           `Add-Type -AssemblyName Microsoft.VisualBasic; ${method}`],
          { stdio: ['ignore', 'ignore', 'pipe'] }
        );
        let stderr = '';
        ps.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        ps.on('close', (code: number) => {
          if (code === 0) resolve();
          else reject(new Error(`shell.trashItem failed (exit ${code}): ${stderr.trim()}`));
        });
      } else {
        // Linux / macOS: use gio trash (available on GNOME-based systems) or
        // fall back to the macOS `trash` CLI if present.
        const [cmd, args] =
          process.platform === 'darwin'
            ? ['osascript', ['-e', `tell application "Finder" to delete POSIX file "${filePath}"`]]
            : ['gio', ['trash', filePath]];

        const proc = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', (code: number) => {
          if (code === 0) resolve();
          else reject(new Error(`shell.trashItem failed (exit ${code}): ${stderr.trim()}`));
        });
        proc.on('error', (err: Error) => reject(err));
      }
    });
  },
};
