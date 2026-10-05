import * as jpeg from 'jpeg-js';

export class ImageProcessor {
  /**
   * Reads the EXIF orientation tag from raw JPEG bytes without decoding the full image.
   * Returns 1 (normal), 3 (180°), 6 (90° CW), or 8 (270° CW / 90° CCW).
   */
  static getExifOrientation(buffer: Uint8Array): number {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
      return 1;
    }

    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) return 1;
      const marker = buffer[offset + 1];
      const length = (buffer[offset + 2] << 8) | buffer[offset + 3];

      if (marker === 0xe1) {
        // APP1 Marker (EXIF)
        const exifOffset = offset + 4;
        if (
          buffer[exifOffset] === 0x45 && // E
          buffer[exifOffset + 1] === 0x78 && // x
          buffer[exifOffset + 2] === 0x69 && // i
          buffer[exifOffset + 3] === 0x66 && // f
          buffer[exifOffset + 4] === 0x00 &&
          buffer[exifOffset + 5] === 0x00
        ) {
          const tiffOffset = exifOffset + 6;
          const isLittle = buffer[tiffOffset] === 0x49 && buffer[tiffOffset + 1] === 0x49;
          const read16 = (o: number) =>
            isLittle ? buffer[o] | (buffer[o + 1] << 8) : (buffer[o] << 8) | buffer[o + 1];
          const read32 = (o: number) =>
            isLittle
              ? buffer[o] | (buffer[o + 1] << 8) | (buffer[o + 2] << 16) | (buffer[o + 3] << 24)
              : (buffer[o] << 24) | (buffer[o + 1] << 16) | (buffer[o + 2] << 8) | buffer[o + 3];

          const ifd0Offset = tiffOffset + read32(tiffOffset + 4);
          if (ifd0Offset + 2 <= buffer.length) {
            const entries = read16(ifd0Offset);
            for (let i = 0; i < entries; i++) {
              const entryOffset = ifd0Offset + 2 + i * 12;
              if (entryOffset + 10 <= buffer.length) {
                const tag = read16(entryOffset);
                if (tag === 0x0112) {
                  // Orientation tag
                  return read16(entryOffset + 8);
                }
              }
            }
          }
        }
        return 1;
      } else if (
        (marker >= 0xe0 && marker <= 0xef) ||
        marker === 0xfe ||
        marker === 0xdb ||
        marker === 0xc4 ||
        marker === 0xc0
      ) {
        offset += 2 + length;
      } else {
        break;
      }
    }
    return 1;
  }

  /**
   * Rotates pixel matrix according to EXIF orientation so image displays upright.
   */
  static rotatePixels(
    srcData: Uint8Array,
    width: number,
    height: number,
    orientation: number
  ): { data: Uint8Array; width: number; height: number } {
    if (orientation === 6) {
      // 90° Clockwise
      const newWidth = height;
      const newHeight = width;
      const dest = new Uint8Array(newWidth * newHeight * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const srcIdx = (y * width + x) * 4;
          const destX = height - 1 - y;
          const destY = x;
          const destIdx = (destY * newWidth + destX) * 4;
          dest[destIdx] = srcData[srcIdx];
          dest[destIdx + 1] = srcData[srcIdx + 1];
          dest[destIdx + 2] = srcData[srcIdx + 2];
          dest[destIdx + 3] = srcData[srcIdx + 3];
        }
      }
      return { data: dest, width: newWidth, height: newHeight };
    }

    if (orientation === 8) {
      // 270° Clockwise (90° CCW)
      const newWidth = height;
      const newHeight = width;
      const dest = new Uint8Array(newWidth * newHeight * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const srcIdx = (y * width + x) * 4;
          const destX = y;
          const destY = width - 1 - x;
          const destIdx = (destY * newWidth + destX) * 4;
          dest[destIdx] = srcData[srcIdx];
          dest[destIdx + 1] = srcData[srcIdx + 1];
          dest[destIdx + 2] = srcData[srcIdx + 2];
          dest[destIdx + 3] = srcData[srcIdx + 3];
        }
      }
      return { data: dest, width: newWidth, height: newHeight };
    }

    if (orientation === 3) {
      // 180° Rotation
      const dest = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const srcIdx = (y * width + x) * 4;
          const destX = width - 1 - x;
          const destY = height - 1 - y;
          const destIdx = (destY * width + destX) * 4;
          dest[destIdx] = srcData[srcIdx];
          dest[destIdx + 1] = srcData[srcIdx + 1];
          dest[destIdx + 2] = srcData[srcIdx + 2];
          dest[destIdx + 3] = srcData[srcIdx + 3];
        }
      }
      return { data: dest, width, height };
    }

    return { data: srcData, width, height };
  }

  /**
   * Photo processing:
   * 1. Detects EXIF orientation.
   * 2. If orientation is 1 (normal/upright), returns the original photo untouched (zero loss / original background).
   * 3. If orientation is rotated (3, 6, 8), rotates pixels to upright orientation.
   */
  static processPhoto(base64Input: string): { base64: string; mimeType: string } {
    try {
      const binaryString = atob(base64Input);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // 1. Detect orientation
      const orientation = this.getExifOrientation(bytes);

      // If already upright (orientation <= 1), keep original image untouched
      if (orientation <= 1) {
        return { base64: base64Input, mimeType: 'image/jpeg' };
      }

      console.log(`[ImageProcessor] Correcting EXIF orientation ${orientation} to upright...`);

      // 2. Decode JPEG
      const decoded = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 256 });
      if (!decoded || !decoded.data) {
        return { base64: base64Input, mimeType: 'image/jpeg' };
      }

      // 3. Rotate to upright
      const rotated = this.rotatePixels(decoded.data, decoded.width, decoded.height, orientation);

      // 4. Re-encode to high quality JPEG
      const reencoded = jpeg.encode(
        {
          data: rotated.data,
          width: rotated.width,
          height: rotated.height,
        },
        95
      );

      // 5. Convert back to base64
      let outBinary = '';
      const outBytes = reencoded.data;
      const chunkSize = 8192;
      for (let i = 0; i < outBytes.length; i += chunkSize) {
        outBinary += String.fromCharCode(...outBytes.subarray(i, i + chunkSize));
      }

      return {
        base64: btoa(outBinary),
        mimeType: 'image/jpeg',
      };
    } catch (err) {
      console.warn('[ImageProcessor] Processing error, using original photo:', err);
      return { base64: base64Input, mimeType: 'image/jpeg' };
    }
  }
}
