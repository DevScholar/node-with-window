// src/ipc.ts
import * as fs from 'node:fs';
import type { ProtocolResponse, CommandRequest } from './types.js';

declare const Deno: any;

const MAX_LINE_LENGTH = 1024 * 1024 * 2; // 2MB buffer per line
const CHUNK_SIZE = 16 * 1024; // 16KB chunk size for buffering
const isDeno = typeof Deno !== 'undefined';

export class IpcSync {
    public fd: number = 0;
    private exited: boolean = false;

    private readBuffer = isDeno ? new Uint8Array(CHUNK_SIZE) : Buffer.alloc(CHUNK_SIZE);
    private resultBuffer = isDeno ? new Uint8Array(MAX_LINE_LENGTH) : Buffer.alloc(MAX_LINE_LENGTH);
    private bufferOffset = 0;
    private bufferLength = 0;

    constructor(
        private pipeName: string,
        private onEvent: (msg: ProtocolResponse) => any 
    ) {}

    private readLineSync(): string | null {
        let resultOffset = 0;
        
        while (true) {
            if (this.bufferOffset >= this.bufferLength) {
                try {
                    if (isDeno) {
                        this.readBuffer.fill(0);
                    } else {
                        (this.readBuffer as Buffer).fill(0);
                    }
                    const bytesRead = fs.readSync(this.fd, this.readBuffer, 0, CHUNK_SIZE, null);
                    if (bytesRead === 0) {
                        if (resultOffset === 0) return null;
                        break;
                    }
                    this.bufferOffset = 0;
                    this.bufferLength = bytesRead;
                } catch (e) {
                    return null;
                }
            }
            
            let lineEnd = -1;
            for (let i = this.bufferOffset; i < this.bufferLength; i++) {
                if (this.readBuffer[i] === 10) {
                    lineEnd = i;
                    break;
                }
            }
            
            if (lineEnd !== -1) {
                const lineLength = lineEnd - this.bufferOffset;
                if (resultOffset + lineLength > MAX_LINE_LENGTH) {
                    throw new Error("IPC Pipe line length exceeded max limit.");
                }
                if (isDeno) {
                    this.resultBuffer.set(this.readBuffer.subarray(this.bufferOffset, lineEnd), resultOffset);
                } else {
                    (this.readBuffer as Buffer).copy(this.resultBuffer as Buffer, resultOffset, this.bufferOffset, lineEnd);
                }
                resultOffset += lineLength;
                this.bufferOffset = lineEnd + 1;
                break;
            }
            
            const availableLength = this.bufferLength - this.bufferOffset;
            if (resultOffset + availableLength > MAX_LINE_LENGTH) {
                throw new Error("IPC Pipe line length exceeded max limit.");
            }
            if (isDeno) {
                this.resultBuffer.set(this.readBuffer.subarray(this.bufferOffset, this.bufferLength), resultOffset);
            } else {
                (this.readBuffer as Buffer).copy(this.resultBuffer as Buffer, resultOffset, this.bufferOffset, this.bufferLength);
            }
            resultOffset += availableLength;
            this.bufferOffset = this.bufferLength;
        }

        if (resultOffset === 0) return '';
        
        if (isDeno) {
            return new TextDecoder().decode(this.resultBuffer.subarray(0, resultOffset));
        } else {
            return (this.resultBuffer as Buffer).toString('utf8', 0, resultOffset);
        }
    }

    private tryConnect(pipePath: string): boolean {
        try {
            this.fd = fs.openSync(pipePath, 'r+');
            return true;
        } catch {
            return false;
        }
    }

    connect() {
        const pipePath = `\\\\.\\pipe\\${this.pipeName}`;
        const start = Date.now();
        let delay = 1;
        const maxDelay = 100;

        while (true) {
            if (this.tryConnect(pipePath)) break;

            if (Date.now() - start > 5000) {
                throw new Error(`Timeout connecting pipe: ${pipePath}`);
            }

            const target = Date.now() + delay;
            while (Date.now() < target) {
                if (this.tryConnect(pipePath)) return;
            }

            delay = Math.min(delay * 1.5, maxDelay);
        }
    }

    send(cmd: CommandRequest): ProtocolResponse {
        if (this.exited) {
            return { type: 'exit', message: '' };
        }

        try {
            fs.writeSync(this.fd, JSON.stringify(cmd) + '\n');
        } catch (e) {
            throw new Error("Pipe closed (Write failed)");
        }

        while (true) {
            const line = this.readLineSync();
            if (line === null) throw new Error("Pipe closed (Read EOF)");
            if (!line.trim()) continue;

            let res: ProtocolResponse;
            try {
                res = JSON.parse(line);
            } catch (e) {
                throw new Error(`Pipe closed (Invalid JSON): ${line}`);
            }

            if (res.type === 'event') {
                let result = null;
                try {
                    result = this.onEvent(res);
                } catch (e) {
                    console.error("Callback Error:", e);
                }
                
                const reply = { type: 'reply', result: result };
                try {
                    fs.writeSync(this.fd, JSON.stringify(reply) + '\n');
                } catch {}
                continue;
            }

            if (res.type === 'error') throw new Error(`Host Error: ${res.message}`);
            
            if (res.type === 'exit') {
                this.exited = true;
                return res;
            }
            
            return res;
        }
    }

    close() {
        this.exited = true;
        if (this.fd) {
            try {
                fs.closeSync(this.fd);
            } catch {}
            this.fd = 0;
        }
    }
}
