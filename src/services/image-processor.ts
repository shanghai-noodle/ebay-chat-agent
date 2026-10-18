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
   * Photo processing:
   * Preserves 100% original photo pixels, background, and camera fidelity without lossy re-encoding.
   * EXIF metadata (including orientation) remains intact in the JPEG header for eBay Picture Services
   * and Gemini Vision, which handle orientation natively.
   */
  static processPhoto(base64Input: string): { base64: string; mimeType: string; orientation: number } {
    try {
      // Inspect first 64KB for EXIF orientation header
      const binaryString = atob(base64Input.slice(0, 87382));
      const len = Math.min(binaryString.length, 65536);
      const headerBytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        headerBytes[i] = binaryString.charCodeAt(i);
      }

      const orientation = this.getExifOrientation(headerBytes);
      return {
        base64: base64Input,
        mimeType: 'image/jpeg',
        orientation,
      };
    } catch (err) {
      return {
        base64: base64Input,
        mimeType: 'image/jpeg',
        orientation: 1,
      };
    }
  }
}
