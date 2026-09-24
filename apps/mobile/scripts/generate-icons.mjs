/**
 * Generates the NikahMate app icons from the brand mark.
 *
 * The mark is the khatim / Rub el Hizb eight-pointed star: two squares, one
 * rotated 45°, overlapping to make one figure. Two squares becoming one form —
 * the product in a single shape, and a motif with a thousand years of use in
 * Islamic geometric art. Deliberately not a heart.
 *
 * Drawn from primitives here rather than shipped as opaque binaries, so the
 * artwork stays reproducible, reviewable in a diff, and free of any
 * third-party asset. Rasterised with a hand-rolled PNG encoder (zlib is in the
 * standard library) so generating icons needs no image dependency.
 *
 *   node apps/mobile/scripts/generate-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

// Brand colours. Kept in sync with src/theme/palette.ts by hand — there are
// four numbers and they change roughly never.
const EMERALD_700 = [0x0a, 0x54, 0x49];
const EMERALD_500 = [0x1c, 0x8a, 0x72];
const GOLD_400 = [0xcf, 0xa2, 0x3f];
const CREAM = [0xff, 0xff, 0xff];

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** @param {Uint8Array} rgba length = w*h*4 */
function encodePng(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Signed distance to a rounded square centred at the origin.
 * Negative inside. Rotating the sample point instead of the shape keeps this
 * to one function for both squares.
 */
function roundedSquareSdf(px, py, half, corner, angleRad) {
  const cos = Math.cos(-angleRad);
  const sin = Math.sin(-angleRad);
  const x = Math.abs(px * cos - py * sin);
  const y = Math.abs(px * sin + py * cos);
  const dx = Math.max(x - (half - corner), 0);
  const dy = Math.max(y - (half - corner), 0);
  return Math.hypot(dx, dy) - corner;
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/**
 * Renders one icon.
 *
 * The mark is the motif nested inside itself: outer star, then the same figure
 * again at smaller scale in the inverse colours. Layering is what turns two
 * flat squares into a seal — and it is how the geometry actually works in the
 * tilework this borrows from, where a pattern repeats at diminishing scale.
 *
 * The nesting is also what keeps it legible small. At 24dp the inner layers
 * merge into a single dark centre, so the silhouette stays a star with a solid
 * core rather than becoming an empty box.
 *
 * Anti-aliased by supersampling 3x3 per pixel — simple, and at these sizes the
 * cost is irrelevant.
 */
function render({ size, background, markScale }) {
  const out = new Uint8Array(size * size * 4);
  const SS = 3;
  const centre = size / 2;
  const outer = (size * markScale) / 2;

  // Outer star, then the figure again inside it, inverted.
  const layers = [
    { half: outer, angle: Math.PI / 4, colour: GOLD_400 },
    { half: outer, angle: 0, colour: CREAM },
    { half: outer * 0.58, angle: Math.PI / 4, colour: EMERALD_700 },
    { half: outer * 0.26, angle: 0, colour: GOLD_400 },
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS - centre;
          const py = y + (sy + 0.5) / SS - centre;

          let colour;
          let alpha;

          if (background) {
            // Diagonal brand gradient.
            const t = (px + py) / (size * 1.4) + 0.5;
            colour = mix(EMERALD_700, EMERALD_500, Math.min(Math.max(t, 0), 1));
            alpha = 255;
          } else {
            colour = [0, 0, 0];
            alpha = 0;
          }

          for (const layer of layers) {
            if (roundedSquareSdf(px, py, layer.half, layer.half * 0.2, layer.angle) < 0) {
              colour = layer.colour;
              alpha = 255;
            }
          }

          r += colour[0] * (alpha / 255);
          g += colour[1] * (alpha / 255);
          b += colour[2] * (alpha / 255);
          a += alpha;
        }
      }

      const n = SS * SS;
      const i = (y * size + x) * 4;
      const aa = a / n;
      // Un-premultiply so edges stay crisp against any backdrop.
      const k = aa > 0 ? 255 / aa : 0;
      out[i] = Math.round(Math.min((r / n) * k, 255));
      out[i + 1] = Math.round(Math.min((g / n) * k, 255));
      out[i + 2] = Math.round(Math.min((b / n) * k, 255));
      out[i + 3] = Math.round(aa);
    }
  }

  return encodePng(out, size, size);
}

// ---------------------------------------------------------------------------

mkdirSync(ASSETS, { recursive: true });

const targets = [
  // Store and launcher icon: full bleed, no transparency.
  { file: 'icon.png', size: 1024, background: true, markScale: 0.56 },
  // Android adaptive foreground: transparent, and small enough that the
  // launcher's mask cannot crop the star's points.
  { file: 'adaptive-icon.png', size: 1024, background: false, markScale: 0.42 },
  // Splash: transparent, sits on the brand background set in app.json.
  { file: 'splash-icon.png', size: 512, background: false, markScale: 0.6 },
  { file: 'favicon.png', size: 64, background: true, markScale: 0.58 },
];

for (const t of targets) {
  const png = render(t);
  writeFileSync(join(ASSETS, t.file), png);
  console.log(`${t.file.padEnd(20)} ${t.size}x${t.size}  ${(png.length / 1024).toFixed(1)}KB`);
}
