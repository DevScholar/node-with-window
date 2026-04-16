import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';

function spawnToPromise(cmd: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    proc.on('error', reject);
    proc.on('close', (code: number | null) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    proc.unref();
  });
}

export const shell = {
  openExternal(url: string): Promise<void> {
    if (process.platform === 'win32') {
      return spawnToPromise('cmd', ['/c', 'start', '', url]);
    } else if (process.platform === 'darwin') {
      return spawnToPromise('open', [url]);
    } else {
      return spawnToPromise('xdg-open', [url]);
    }
  },

  openPath(filePath: string): Promise<string> {
    const run = (cmd: string, args: string[]): Promise<string> =>
      new Promise<string>((resolve) => {
        let stderr = '';
        const proc = spawn(cmd, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
        proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('error', (err: Error) => resolve(err.message));
        proc.on('close', (code: number | null) => {
          resolve(code === 0 || code === null ? '' : stderr.trim() || `exit code ${code}`);
        });
        proc.unref();
      });

    if (process.platform === 'win32') {
      return run('explorer', [filePath]);
    } else if (process.platform === 'darwin') {
      return run('open', [filePath]);
    } else {
      return run('xdg-open', [filePath]);
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
            (mod.default as unknown as { trashItem: (p: string) => void }).trashItem(filePath);
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
