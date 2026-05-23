import { $, ObjC } from '@devscholar/node-with-jxa';
import type { ImageOps } from '../../native-image.js';

function nsDataFromBuffer(data: Buffer): any {
  return $.NSData.dataWithBytesLength(data, data.length);
}

function bufferFromNsData(nsData: any): Buffer {
  const len = Number(nsData.length);
  const buf = Buffer.alloc(len);
  const bytes = nsData.bytes;
  for (let i = 0; i < len; i++) {
    buf[i] = Number(bytes[i]);
  }
  return buf;
}

export const jxaImageOps: ImageOps = {
  toJPEG(data: Buffer, quality: number): Buffer {
    try {
      ObjC.import('AppKit');
      const nsData = nsDataFromBuffer(data);
      const imageRep = $.NSBitmapImageRep.imageRepWithData(nsData);
      if (!imageRep) return data;

      const props = $.NSDictionary.dictionaryWithObjectForKey(
        $.NSNumber.numberWithFloat(quality / 100),
        $.NSImageCompressionFactor,
      );
      const jpegData = imageRep.representationUsingTypeProperties(
        $.NSBitmapImageFileTypeJPEG,
        props,
      );
      if (!jpegData) return data;
      return bufferFromNsData(jpegData);
    } catch {
      return data;
    }
  },

  resize(data: Buffer, width: number, height: number): Buffer {
    try {
      ObjC.import('AppKit');
      const nsData = nsDataFromBuffer(data);
      const image = $.NSImage.alloc.initWithData(nsData);
      if (!image) return data;

      const newSize = $.NSMakeSize(width, height);
      const newImage = $.NSImage.alloc.initWithSize(newSize);
      newImage.lockFocus();
      image.drawInRectFromRectOperationFraction(
        $.NSMakeRect(0, 0, width, height),
        $.NSMakeRect(0, 0, image.size.width, image.size.height),
        $.NSCompositingOperationSourceOver,
        1.0,
      );
      const bitmap = $.NSBitmapImageRep.alloc.initWithFocusedViewRect(
        $.NSMakeRect(0, 0, width, height),
      );
      newImage.unlockFocus();

      const pngData = bitmap.representationUsingTypeProperties(
        $.NSBitmapImageFileTypePNG,
        null,
      );
      if (!pngData) return data;
      return bufferFromNsData(pngData);
    } catch {
      return data;
    }
  },

  crop(data: Buffer, x: number, y: number, width: number, height: number): Buffer {
    try {
      ObjC.import('AppKit');
      const nsData = nsDataFromBuffer(data);
      const image = $.NSImage.alloc.initWithData(nsData);
      if (!image) return data;

      const newSize = $.NSMakeSize(width, height);
      const newImage = $.NSImage.alloc.initWithSize(newSize);
      newImage.lockFocus();
      image.drawInRectFromRectOperationFraction(
        $.NSMakeRect(0, 0, width, height),
        $.NSMakeRect(x, y, width, height),
        $.NSCompositingOperationSourceOver,
        1.0,
      );
      const bitmap = $.NSBitmapImageRep.alloc.initWithFocusedViewRect(
        $.NSMakeRect(0, 0, width, height),
      );
      newImage.unlockFocus();

      const pngData = bitmap.representationUsingTypeProperties(
        $.NSBitmapImageFileTypePNG,
        null,
      );
      if (!pngData) return data;
      return bufferFromNsData(pngData);
    } catch {
      return data;
    }
  },
};
