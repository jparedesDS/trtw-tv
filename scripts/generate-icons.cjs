/**
 * generate-icons.cjs
 *
 * Generates PNG icon files for the trtw.tv Chrome extension.
 * No dependencies required - creates valid PNG files from raw pixel data.
 *
 * Usage:  node scripts/generate-icons.cjs
 * Output: extension/icons/icon16.png, icon48.png, icon128.png
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── PNG encoder (minimal, no dependencies) ──────────────────────────────

function createPNG(width, height, rgba) {
  // rgba is a Uint8Array of width * height * 4 bytes

  // Build IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Build raw image data with filter bytes
  const rawLen = height * (1 + width * 4);
  const raw = Buffer.alloc(rawLen);
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = y * (1 + width * 4) + 1 + x * 4;
      raw[dstIdx]     = rgba[srcIdx];
      raw[dstIdx + 1] = rgba[srcIdx + 1];
      raw[dstIdx + 2] = rgba[srcIdx + 2];
      raw[dstIdx + 3] = rgba[srcIdx + 3];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  // Assemble PNG
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ];

  return Buffer.concat([signature, ...chunks]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeB, data]));
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([len, typeB, data, crcB]);
}

// CRC32 table
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── Drawing helpers ─────────────────────────────────────────────────────

function lerp(a, b, t) { return a + (b - a) * t; }

function hexToRGB(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF];
}

const COLOR_A = hexToRGB('#7c3aed'); // purple start
const COLOR_B = hexToRGB('#4f46e5'); // purple end

function setPixel(rgba, w, x, y, r, g, b, a) {
  const i = (y * w + x) * 4;
  // Alpha compositing (premultiplied over existing)
  const srcA = a / 255;
  const dstA = rgba[i + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA > 0) {
    rgba[i]     = Math.round((r * srcA + rgba[i]     * dstA * (1 - srcA)) / outA);
    rgba[i + 1] = Math.round((g * srcA + rgba[i + 1] * dstA * (1 - srcA)) / outA);
    rgba[i + 2] = Math.round((b * srcA + rgba[i + 2] * dstA * (1 - srcA)) / outA);
    rgba[i + 3] = Math.round(outA * 255);
  }
}

function fillRoundedRect(rgba, w, h, rx, ry, rw, rh, cornerR, r, g, b, a) {
  for (let py = Math.max(0, Math.floor(ry)); py < Math.min(h, Math.ceil(ry + rh)); py++) {
    for (let px = Math.max(0, Math.floor(rx)); px < Math.min(w, Math.ceil(rx + rw)); px++) {
      // Check if inside rounded rect
      const dx = px - rx;
      const dy = py - ry;
      let inside = true;

      // Top-left corner
      if (dx < cornerR && dy < cornerR) {
        const cx = rx + cornerR, cy = ry + cornerR;
        if ((px - cx) * (px - cx) + (py - cy) * (py - cy) > cornerR * cornerR) inside = false;
      }
      // Top-right corner
      if (dx > rw - cornerR && dy < cornerR) {
        const cx = rx + rw - cornerR, cy = ry + cornerR;
        if ((px - cx) * (px - cx) + (py - cy) * (py - cy) > cornerR * cornerR) inside = false;
      }
      // Bottom-left corner
      if (dx < cornerR && dy > rh - cornerR) {
        const cx = rx + cornerR, cy = ry + rh - cornerR;
        if ((px - cx) * (px - cx) + (py - cy) * (py - cy) > cornerR * cornerR) inside = false;
      }
      // Bottom-right corner
      if (dx > rw - cornerR && dy > rh - cornerR) {
        const cx = rx + rw - cornerR, cy = ry + rh - cornerR;
        if ((px - cx) * (px - cx) + (py - cy) * (py - cy) > cornerR * cornerR) inside = false;
      }

      if (inside) {
        setPixel(rgba, w, px, py, r, g, b, a);
      }
    }
  }
}

function fillTriangle(rgba, w, h, x1, y1, x2, y2, x3, y3, r, g, b, a) {
  const minX = Math.max(0, Math.floor(Math.min(x1, x2, x3)));
  const maxX = Math.min(w - 1, Math.ceil(Math.max(x1, x2, x3)));
  const minY = Math.max(0, Math.floor(Math.min(y1, y2, y3)));
  const maxY = Math.min(h - 1, Math.ceil(Math.max(y1, y2, y3)));

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      // Barycentric coordinates
      const d = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
      if (Math.abs(d) < 0.001) continue;
      const la = ((y2 - y3) * (px - x3) + (x3 - x2) * (py - y3)) / d;
      const lb = ((y3 - y1) * (px - x3) + (x1 - x3) * (py - y3)) / d;
      const lc = 1 - la - lb;
      if (la >= -0.01 && lb >= -0.01 && lc >= -0.01) {
        setPixel(rgba, w, px, py, r, g, b, a);
      }
    }
  }
}

function fillRect(rgba, w, h, rx, ry, rw, rh, r, g, b, a) {
  for (let py = Math.max(0, Math.floor(ry)); py < Math.min(h, Math.ceil(ry + rh)); py++) {
    for (let px = Math.max(0, Math.floor(rx)); px < Math.min(w, Math.ceil(rx + rw)); px++) {
      setPixel(rgba, w, px, py, r, g, b, a);
    }
  }
}

// ── Icon drawing ────────────────────────────────────────────────────────

function drawIcon(size) {
  const s = size;
  const rgba = new Uint8Array(s * s * 4); // starts transparent

  // 1) Background gradient rounded rect
  const bgR = s * 0.22;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      // Check rounded rect
      let inside = true;
      // Top-left
      if (x < bgR && y < bgR) {
        if ((x - bgR) * (x - bgR) + (y - bgR) * (y - bgR) > bgR * bgR) inside = false;
      }
      // Top-right
      if (x > s - bgR && y < bgR) {
        if ((x - (s - bgR)) * (x - (s - bgR)) + (y - bgR) * (y - bgR) > bgR * bgR) inside = false;
      }
      // Bottom-left
      if (x < bgR && y > s - bgR) {
        if ((x - bgR) * (x - bgR) + (y - (s - bgR)) * (y - (s - bgR)) > bgR * bgR) inside = false;
      }
      // Bottom-right
      if (x > s - bgR && y > s - bgR) {
        if ((x - (s - bgR)) * (x - (s - bgR)) + (y - (s - bgR)) * (y - (s - bgR)) > bgR * bgR) inside = false;
      }

      if (inside) {
        // Gradient: top-left to bottom-right
        const t = (x + y) / (2 * s);
        const r = Math.round(lerp(COLOR_A[0], COLOR_B[0], t));
        const g = Math.round(lerp(COLOR_A[1], COLOR_B[1], t));
        const b = Math.round(lerp(COLOR_A[2], COLOR_B[2], t));
        setPixel(rgba, s, x, y, r, g, b, 255);
      }
    }
  }

  // 2) White speech bubble
  const bx = s * 0.20;
  const by = s * 0.18;
  const bw = s * 0.60;
  const bh = s * 0.42;
  const br = s * 0.08;
  fillRoundedRect(rgba, s, s, bx, by, bw, bh, br, 255, 255, 255, 242); // 0.95 opacity

  // 3) Speech bubble tail
  const tailCx = s * 0.45;
  const tailTop = by + bh - 1;
  const tailH = s * 0.12;
  const tailW = s * 0.10;
  fillTriangle(
    rgba, s, s,
    tailCx - tailW * 0.5, tailTop,
    tailCx, tailTop + tailH,
    tailCx + tailW * 0.8, tailTop,
    255, 255, 255, 242
  );

  // 4) Text lines (purple bars)
  const l1x = bx + bw * 0.15;
  const l1y = by + bh * 0.30;
  const l1w = bw * 0.70;
  const l1h = Math.max(1, Math.round(s * 0.055));
  const l1r = Math.max(0.5, l1h / 2);

  // Line 1 (darker purple, 80% opacity)
  fillRoundedRect(rgba, s, s, l1x, l1y, l1w, l1h, l1r, 124, 58, 237, 204);

  // Line 2 (lighter purple, 50% opacity)
  const l2x = l1x;
  const l2y = by + bh * 0.58;
  const l2w = bw * 0.48;
  const l2h = l1h;
  const l2r = l1r;
  fillRoundedRect(rgba, s, s, l2x, l2y, l2w, l2h, l2r, 124, 58, 237, 128);

  return rgba;
}

// ── Main ────────────────────────────────────────────────────────────────

const outDir = path.join(__dirname, '..', 'extension', 'icons');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const iconSizes = [16, 48, 128];

for (const size of iconSizes) {
  const rgba = drawIcon(size);
  const png = createPNG(size, size, rgba);
  const outPath = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Created ${outPath} (${png.length} bytes)`);
}

console.log('\nDone! All icons generated.');
