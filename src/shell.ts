import { spawn } from 'node:child_process';
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
    }
};
