// src/native-image.ts
// Electron-compatible NativeImage.
//
// Simple operations (toPNG, toDataURL, isEmpty, getSize, createFromPath,
// createFromDataURL) are pure Node.js and always available.
//
// Pixel-level operations (toJPEG, resize, crop) delegate to the platform
// image backend registered by the active window backend:
//   - Windows (netfx-wpf): System.Drawing via dotnet bridge
//   - Linux (gjs-gtk4): GdkPixbuf via GJS bridge
//
// Call registerImageOps() once during backend initialization to activate them.

import * as fs from 'node:fs';

// ─── ImageOps provider ───────────────────────────────────────────────────────

export interface ImageOps {
  toJPEG(data: Buffer, quality: number): Buffer;
  resize(data: Buffer, width: number, height: number): Buffer;
  crop(data: Buffer, x: number, y: number, width: number, height: number): Buffer;
}

let _imageOps: ImageOps | null = null;

/** Called by each window backend during initialization to supply image ops. */
export function registerImageOps(ops: ImageOps): void {
  _imageOps = ops;
}

// ─── NativeImage ─────────────────────────────────────────────────────────────

/**
 * Electron-compatible image object.
 * toJPEG(), resize(), and crop() are synchronous and require the window
 * backend to be initialized (which happens automatically via app.whenReady()).
 */
export class NativeImage {
  private readonly _data: Buffer;

  /** @internal */
  constructor(data: Buffer) {
    this._data = data;
  }

  // ── format detection ───────────────────────────────────────────────────────

  private _getMimeType(): string {
    const d = this._data;
    if (d.length >= 3 && d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return 'image/jpeg';
    if (d.length >= 4 && d[0] === 0x47 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x38) return 'image/gif';
    if (
      d.length >= 12 &&
      d[0] === 0x52 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x46 &&
      d[8] === 0x57 && d[9] === 0x45 && d[10] === 0x42 && d[11] === 0x50
    ) return 'image/webp';
    return 'image/png';
  }

  // ── sync pure-JS APIs ──────────────────────────────────────────────────────

  /** Returns the raw stored image bytes. */
  toPNG(): Buffer {
    return Buffer.from(this._data);
  }

  /**
   * Returns a data-URL string.
   * MIME type is auto-detected from the raw bytes (PNG / JPEG / GIF / WebP).
   */
  toDataURL(_options?: { mimeType?: string; scaleFactor?: number }): string {
    return `data:${this._getMimeType()};base64,` + this._data.toString('base64');
  }

  isEmpty(): boolean {
    return this._data.length === 0;
  }

  /**
   * Returns the image dimensions.
   * Supports PNG (IHDR chunk) and JPEG (SOF marker scan).
   * Returns { width: 0, height: 0 } for unsupported or malformed data.
   */
  getSize(): { width: number; height: number } {
    const d = this._data;
    // ── PNG ──────────────────────────────────────────────────────────────────
    if (
      d.length >= 24 &&
      d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47 &&
      d[4] === 0x0d && d[5] === 0x0a && d[6] === 0x1a && d[7] === 0x0a
    ) {
      return { width: d.readUInt32BE(16), height: d.readUInt32BE(20) };
    }
    // ── JPEG: scan for SOF marker ─────────────────────────────────────────────
    if (d.length >= 3 && d[0] === 0xff && d[1] === 0xd8) {
      let i = 2;
      while (i < d.length - 8) {
        if (d[i] !== 0xff) break;
        const m = d[i + 1];
        if (m === 0xff) { i++; continue; } // padding
        if (
          m === 0xc0 || m === 0xc1 || m === 0xc2 || m === 0xc3 ||
          m === 0xc5 || m === 0xc6 || m === 0xc7 ||
          m === 0xc9 || m === 0xca || m === 0xcb
        ) {
          if (i + 8 < d.length) {
            return { height: d.readUInt16BE(i + 5), width: d.readUInt16BE(i + 7) };
          }
        }
        if (i + 3 >= d.length) break;
        i += 2 + d.readUInt16BE(i + 2);
      }
    }
    return { width: 0, height: 0 };
  }

  /** Alias for toPNG(), for API compatibility. */
  getBitmap(): Buffer {
    return this.toPNG();
  }

  // ── platform-native ops (sync) ─────────────────────────────────────────────

  /**
   * Encodes the image as JPEG.
   * quality: 0–100.
   * Requires the window backend to be initialized.
   */
  toJPEG(quality = 80): Buffer {
    if (!_imageOps) throw new Error('nativeImage.toJPEG: window backend not initialized');
    return _imageOps.toJPEG(this._data, Math.max(0, Math.min(100, quality)));
  }

  /**
   * Returns a resized copy as a new NativeImage (PNG).
   * Supply width, height, or both; if only one is given the other is scaled
   * proportionally.
   * Requires the window backend to be initialized.
   */
  resize(options: { width?: number; height?: number; quality?: 'good' | 'better' | 'best' }): NativeImage {
    if (!_imageOps) throw new Error('nativeImage.resize: window backend not initialized');
    const { width: reqW = 0, height: reqH = 0 } = options;
    const { width: srcW, height: srcH } = this.getSize();
    let nw = reqW || srcW;
    let nh = reqH || srcH;
    if (reqW && !reqH && srcH) nh = Math.round(srcH * reqW / srcW);
    if (reqH && !reqW && srcW) nw = Math.round(srcW * reqH / srcH);
    return new NativeImage(_imageOps.resize(this._data, nw, nh));
  }

  /**
   * Returns a cropped copy as a new NativeImage (PNG).
   * Requires the window backend to be initialized.
   */
  crop(rect: { x: number; y: number; width: number; height: number }): NativeImage {
    if (!_imageOps) throw new Error('nativeImage.crop: window backend not initialized');
    return new NativeImage(_imageOps.crop(this._data, rect.x, rect.y, rect.width, rect.height));
  }
}

// ─── factory ─────────────────────────────────────────────────────────────────

export const nativeImage = {
  createEmpty(): NativeImage {
    return new NativeImage(Buffer.alloc(0));
  },

  /** Creates a NativeImage from raw image bytes (PNG, JPEG, etc.). */
  createFromBuffer(buffer: Buffer): NativeImage {
    return new NativeImage(buffer);
  },

  /**
   * Loads an image from disk.
   * Returns an empty NativeImage if the file cannot be read.
   */
  createFromPath(filePath: string): NativeImage {
    try {
      return new NativeImage(fs.readFileSync(filePath));
    } catch {
      return new NativeImage(Buffer.alloc(0));
    }
  },

  /**
   * Creates a NativeImage from a data URL (e.g. `data:image/png;base64,...`).
   * Returns an empty NativeImage for malformed input.
   */
  createFromDataURL(dataURL: string): NativeImage {
    const m = dataURL.match(/^data:[^;]+;base64,(.+)$/s);
    if (!m) return new NativeImage(Buffer.alloc(0));
    try {
      return new NativeImage(Buffer.from(m[1], 'base64'));
    } catch {
      return new NativeImage(Buffer.alloc(0));
    }
  },
};
