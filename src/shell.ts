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
   *
   * Windows: uses SHFileOperation via the self-contained C# bridge (no PowerShell spawn).
   * Linux:   delegates to `gio trash`.
   * macOS:   delegates to AppleScript / Finder.
   */
  trashItem(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (process.platform === 'win32') {
        // Validate path exists before sending to C# layer.
        try {
          statSync(filePath);
        } catch {
          reject(new Error(`shell.trashItem: path not found: ${filePath}`));
          return;
        }

        // Use the already-running WPF bridge process (SHFileOperation P/Invoke).
        // Dynamic import avoids pulling in the .NET bridge on non-Windows platforms.
        import('./backend/netfx-wpf/dotnet/index.js').then(mod => {
          try {
            (mod.default as any).trashItem(filePath);
            resolve();
          } catch (e) {
            reject(e);
          }
        }).catch(reject);
      } else {
        // Linux / macOS: use gio trash or AppleScript.
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
