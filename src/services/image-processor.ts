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
   * Rotates pixel matrix according to EXIF orientation.
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
   * Enhances lighting, vibrancy, and contrast for crisp commercial product presentation.
   */
  static enhanceLightingAndContrast(data: Uint8Array): void {
    const contrastFactor = 1.08;
    const brightnessBoost = 6;

    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const val = data[i + c];
        // Apply contrast stretch around midpoint 128 + slight brightness boost
        const enhanced = Math.min(
          255,
          Math.max(0, Math.round((val - 128) * contrastFactor + 128 + brightnessBoost))
        );
        data[i + c] = enhanced;
      }
    }
  }

  /**
   * Edge-aware flood fill background replacement to clean, solid white (#FFFFFF).
   * Seeds from all borders/corners, determines background colors, and replaces
   * connected background pixels with solid pure white while preserving the product subject.
   */
  static replaceBackgroundWithWhite(data: Uint8Array, width: number, height: number): void {
    const totalPixels = width * height;
    const visited = new Uint8Array(totalPixels);
    const queue: number[] = [];

    // 1. Sample border pixels to establish background reference color
    let sumR = 0,
      sumG = 0,
      sumB = 0,
      borderCount = 0;

    const samplePixel = (x: number, y: number) => {
      const idx = (y * width + x) * 4;
      sumR += data[idx];
      sumG += data[idx + 1];
      sumB += data[idx + 2];
      borderCount++;
    };

    // Step every 4 pixels along the border for speed and coverage
    for (let x = 0; x < width; x += 4) {
      samplePixel(x, 0);
      samplePixel(x, height - 1);
    }
    for (let y = 0; y < height; y += 4) {
      samplePixel(0, y);
      samplePixel(width - 1, y);
    }

    if (borderCount === 0) return;
    const bgAvgR = sumR / borderCount;
    const bgAvgG = sumG / borderCount;
    const bgAvgB = sumB / borderCount;

    // 2. Initialize flood-fill queue with all outer boundary pixels
    for (let x = 0; x < width; x++) {
      queue.push(x, 0);
      queue.push(x, height - 1);
      visited[x] = 1;
      visited[(height - 1) * width + x] = 1;
    }
    for (let y = 0; y < height; y++) {
      queue.push(0, y);
      queue.push(width - 1, y);
      visited[y * width] = 1;
      visited[y * width + width - 1] = 1;
    }

    // Color tolerance distance from sampled background
    const tolerance = 48;
    const maxSteps = totalPixels * 2;
    let steps = 0;
    let head = 0;

    while (head < queue.length && steps++ < maxSteps) {
      const x = queue[head++];
      const y = queue[head++];
      const idx = (y * width + x) * 4;

      // Replace pixel with solid white
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;

      // Check 4-connected neighbors
      const neighbors = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ];

      for (const [nx, ny] of neighbors) {
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const nPos = ny * width + nx;
          if (!visited[nPos]) {
            visited[nPos] = 1;
            const nIdx = nPos * 4;
            const dr = data[nIdx] - bgAvgR;
            const dg = data[nIdx + 1] - bgAvgG;
            const db = data[nIdx + 2] - bgAvgB;
            const dist = Math.sqrt(dr * dr + dg * dg + db * db);

            if (dist < tolerance) {
              queue.push(nx, ny);
            }
          }
        }
      }
    }
  }

  /**
   * Full pipeline:
   * 1. Decodes JPEG.
   * 2. Detects and corrects EXIF orientation (upright).
   * 3. Enhances lighting & contrast.
   * 4. Replaces background with solid white (#FFFFFF).
   * 5. Re-encodes to high-quality JPEG ready for eBay Picture Services (EPS).
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

      // 2. Decode JPEG
      const decoded = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 256 });
      if (!decoded || !decoded.data) {
        return { base64: base64Input, mimeType: 'image/jpeg' };
      }

      // 3. Rotate if needed
      let working = {
        data: decoded.data,
        width: decoded.width,
        height: decoded.height,
      };

      if (orientation > 1) {
        working = this.rotatePixels(decoded.data, decoded.width, decoded.height, orientation);
      }

      // 4. Enhance lighting & contrast
      this.enhanceLightingAndContrast(working.data);

      // 5. Replace background with solid white
      this.replaceBackgroundWithWhite(working.data, working.width, working.height);

      // 6. Re-encode to high quality JPEG
      const reencoded = jpeg.encode(
        {
          data: working.data,
          width: working.width,
          height: working.height,
        },
        92
      );

      // 7. Convert back to base64
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
