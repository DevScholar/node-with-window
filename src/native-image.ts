// src/native-image.ts
// Minimal Electron-compatible NativeImage implementation.
// Stores raw PNG bytes; JPEG output is not supported (no native encoder available).

/**
 * An image returned by win.capturePage() and similar APIs.
 * Matches the subset of Electron's NativeImage that is most commonly used.
 */
export class NativeImage {
  private readonly _data: Buffer;

  /** @internal */
  constructor(data: Buffer) {
    this._data = data;
  }

  /** Returns the image encoded as PNG bytes. */
  toPNG(): Buffer {
    return Buffer.from(this._data);
  }

  /** Returns a data-URL string (PNG). The mimeType option is accepted but ignored. */
  toDataURL(_options?: { mimeType?: string; scaleFactor?: number }): string {
    return 'data:image/png;base64,' + this._data.toString('base64');
  }

  /** Returns true if the image has no pixel data. */
  isEmpty(): boolean {
    return this._data.length === 0;
  }

  /**
   * Returns the image dimensions by reading the PNG IHDR chunk.
   * Returns { width: 0, height: 0 } for empty or malformed images.
   */
  getSize(): { width: number; height: number } {
    // PNG structure: 8-byte signature + 4-byte chunk length + 4-byte "IHDR" + 4-byte width + 4-byte height = 24 bytes minimum.
    if (this._data.length < 24) return { width: 0, height: 0 };
    // Validate the PNG magic signature: 89 50 4E 47 0D 0A 1A 0A
    if (this._data[0] !== 0x89 || this._data[1] !== 0x50 ||
        this._data[2] !== 0x4E || this._data[3] !== 0x47 ||
        this._data[4] !== 0x0D || this._data[5] !== 0x0A ||
        this._data[6] !== 0x1A || this._data[7] !== 0x0A) {
      return { width: 0, height: 0 };
    }
    return {
      width:  this._data.readUInt32BE(16),
      height: this._data.readUInt32BE(20),
    };
  }

  /** Returns the raw PNG bytes (same as toPNG). */
  getBitmap(): Buffer {
    return this.toPNG();
  }
}

/** Factory helpers matching Electron's `nativeImage` module. */
export const nativeImage = {
  /** Creates an empty NativeImage. */
  createEmpty(): NativeImage {
    return new NativeImage(Buffer.alloc(0));
  },

  /** Creates a NativeImage from raw PNG bytes. */
  createFromBuffer(buffer: Buffer): NativeImage {
    return new NativeImage(buffer);
  },
};
