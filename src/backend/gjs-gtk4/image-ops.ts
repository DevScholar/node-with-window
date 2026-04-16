// src/backend/gjs-gtk4/image-ops.ts
// Image operations for the GTK backend.
// Uses GdkPixbuf (via node-with-gjs) for JPEG encoding, bicubic resize,
// and sub-pixbuf crop.  All operations are synchronous.

import { ensureGiLoaded, _gi } from './gtk-app.js';
import type { ImageOps } from '../../native-image.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPixbufNs(): any {
  ensureGiLoaded();
  // GdkPixbuf is a separate GI namespace — load on first use.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gi = _gi as any;
  if (!gi.GdkPixbuf) {
    gi.versions = gi.versions ?? {};
    gi.versions.GdkPixbuf = '2.0';
    // Accessing gi.GdkPixbuf triggers lazy loading of the typelib.
    void gi.GdkPixbuf;
  }
  return gi.GdkPixbuf;
}

/**
 * Decode arbitrary image bytes (PNG / JPEG / …) into a GdkPixbuf using
 * PixbufLoader, which handles format detection automatically.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bufferToPixbuf(GdkPixbuf: any, data: Buffer): any {
  const loader = new GdkPixbuf.PixbufLoader();
  loader.write(data);
  loader.close();
  return loader.get_pixbuf();
}

/**
 * Save a GdkPixbuf to a Node Buffer in the given format.
 * `save_to_bufferv` returns either a Uint8Array directly (modern GJS) or
 * a [ok, Uint8Array] tuple (older bindings) — handle both.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pixbufToBuffer(pixbuf: any, type: string, keys: string[], values: string[]): Buffer {
  const result = pixbuf.save_to_bufferv(type, keys, values);
  const bytes: Uint8Array = Array.isArray(result) ? result[1] : result;
  return Buffer.from(bytes);
}

export const gtkImageOps: ImageOps = {
  toJPEG(data: Buffer, quality: number): Buffer {
    const GdkPixbuf = getPixbufNs();
    const pixbuf = bufferToPixbuf(GdkPixbuf, data);
    return pixbufToBuffer(pixbuf, 'jpeg', ['quality'], [String(quality)]);
  },

  resize(data: Buffer, width: number, height: number): Buffer {
    const GdkPixbuf = getPixbufNs();
    const pixbuf = bufferToPixbuf(GdkPixbuf, data);
    // InterpType: NEAREST=0, TILES=1, BILINEAR=2, HYPER=3
    const scaled = pixbuf.scale_simple(width, height, 2 /* BILINEAR */);
    return pixbufToBuffer(scaled, 'png', [], []);
  },

  crop(data: Buffer, x: number, y: number, width: number, height: number): Buffer {
    const GdkPixbuf = getPixbufNs();
    const pixbuf = bufferToPixbuf(GdkPixbuf, data);
    const sub = pixbuf.new_subpixbuf(x, y, width, height);
    return pixbufToBuffer(sub, 'png', [], []);
  },
};
