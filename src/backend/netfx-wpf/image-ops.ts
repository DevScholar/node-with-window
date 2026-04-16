// src/backend/netfx-wpf/image-ops.ts
// Image operations for the WPF backend.
// Uses a lazily-compiled System.Drawing C# helper class for JPEG encoding,
// bicubic resize, and crop. All operations accept / return base64 strings
// across the dotnet bridge to avoid large byte-array serialisation overhead.

import type { DotnetProxy } from './dotnet/types.js';
import type { ImageOps } from '../../native-image.js';

// C# source for the helper — compiled once on first use via dotnet.addType().
// Constraints: PowerShell 5.1 Add-Type = C# 5 only (no ?. / $"" / auto-prop initializers).
const HELPER_SOURCE = `
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

public static class NwwImageHelper {

    private static ImageCodecInfo _jpegCodec;

    static NwwImageHelper() {
        var codecs = ImageCodecInfo.GetImageEncoders();
        _jpegCodec = null;
        for (int i = 0; i < codecs.Length; i++) {
            if (codecs[i].FormatID == ImageFormat.Jpeg.Guid) {
                _jpegCodec = codecs[i];
                break;
            }
        }
    }

    public static string ToJpeg(string base64, int quality) {
        byte[] data = Convert.FromBase64String(base64);
        using (var ms = new MemoryStream(data))
        using (var bmp = new Bitmap(ms)) {
            var ep = new EncoderParameters(1);
            ep.Param[0] = new EncoderParameter(Encoder.Quality, (long)quality);
            using (var outMs = new MemoryStream()) {
                bmp.Save(outMs, _jpegCodec, ep);
                return Convert.ToBase64String(outMs.ToArray());
            }
        }
    }

    public static string Resize(string base64, int width, int height) {
        byte[] data = Convert.FromBase64String(base64);
        using (var ms = new MemoryStream(data))
        using (var src = new Bitmap(ms))
        using (var dst = new Bitmap(width, height))
        using (var g = Graphics.FromImage(dst)) {
            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
            g.DrawImage(src, 0, 0, width, height);
            using (var outMs = new MemoryStream()) {
                dst.Save(outMs, ImageFormat.Png);
                return Convert.ToBase64String(outMs.ToArray());
            }
        }
    }

    public static string Crop(string base64, int x, int y, int width, int height) {
        byte[] data = Convert.FromBase64String(base64);
        using (var ms = new MemoryStream(data))
        using (var src = new Bitmap(ms)) {
            var rect = new Rectangle(x, y, width, height);
            using (var dst = (Bitmap)src.Clone(rect, src.PixelFormat))
            using (var outMs = new MemoryStream()) {
                dst.Save(outMs, ImageFormat.Png);
                return Convert.ToBase64String(outMs.ToArray());
            }
        }
    }
}
`;

let _dotnet: DotnetProxy | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _helper: any = null;

export function setDotNetInstance(instance: DotnetProxy): void {
  _dotnet = instance;
  _helper = null; // reset on re-init
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getHelper(): any {
  if (_helper) return _helper;
  if (!_dotnet) throw new Error('netfx-wpf image-ops: dotnet not initialized');
  _helper = _dotnet.addType(HELPER_SOURCE, ['System.Drawing']);
  return _helper;
}

export const wpfImageOps: ImageOps = {
  toJPEG(data: Buffer, quality: number): Buffer {
    const result = getHelper().ToJpeg(data.toString('base64'), quality) as string;
    return Buffer.from(result, 'base64');
  },

  resize(data: Buffer, width: number, height: number): Buffer {
    const result = getHelper().Resize(data.toString('base64'), width, height) as string;
    return Buffer.from(result, 'base64');
  },

  crop(data: Buffer, x: number, y: number, width: number, height: number): Buffer {
    const result = getHelper().Crop(data.toString('base64'), x, y, width, height) as string;
    return Buffer.from(result, 'base64');
  },
};
