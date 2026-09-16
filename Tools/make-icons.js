/**
 * Draw the Home Screen icons: `ui/icons/icon-{180,192,512}.png`.
 *
 * Generated rather than drawn in an editor so the icon is a few lines anyone can change, and with no
 * image library — a PNG is a zlib stream of scanlines with a CRC per chunk, and Node has zlib. Run it
 * when the design changes and commit the output; nothing runs it at build time.
 *
 * The design is the app's own picture: a lane of waveform lines on the Wine header colour, the tallest
 * line in the record colour. iOS rounds the corners itself, so the square is filled edge to edge.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'icons');

/** Wine's `--lr-grad-start`, hsl(330 20% 17%) — see `ui/src/theme.ts`. Also the manifest's theme colour. */
export const BACKGROUND = [52, 35, 43];
const LINE = [243, 231, 222];
const RECORD = [222, 66, 76];

/** Relative heights of the lines, left to right. One is the record colour. */
const HEIGHTS = [0.28, 0.52, 0.74, 0.46, 0.9, 0.62, 0.36, 0.56, 0.3];
const ACCENT = 4;

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const px = Buffer.alloc(size * size * 3);
  const set = (x, y, [r, g, b], a = 1) => {
    const i = (y * size + x) * 3;
    px[i] = Math.round(px[i] * (1 - a) + r * a);
    px[i + 1] = Math.round(px[i + 1] * (1 - a) + g * a);
    px[i + 2] = Math.round(px[i + 2] * (1 - a) + b * a);
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, BACKGROUND);

  // Lines across the middle 70%, round-capped, coverage-sampled 4×4 so the edges are smooth.
  const span = size * 0.7;
  const pitch = span / HEIGHTS.length;
  const width = pitch * 0.56;
  const left = (size - span) / 2 + (pitch - width) / 2;
  HEIGHTS.forEach((h, i) => {
    const cx = left + i * pitch + width / 2;
    const half = (size * 0.62 * h) / 2;
    const r = width / 2;
    const colour = i === ACCENT ? RECORD : LINE;
    for (let y = Math.floor(size / 2 - half - r); y <= Math.ceil(size / 2 + half + r); y++) {
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        let hits = 0;
        for (let sy = 0; sy < 4; sy++) {
          for (let sx = 0; sx < 4; sx++) {
            const qx = x + (sx + 0.5) / 4 - cx;
            const qy = Math.max(0, Math.abs(y + (sy + 0.5) / 4 - size / 2) - half);
            if (qx * qx + qy * qy <= r * r) hits++;
          }
        }
        if (hits && x >= 0 && y >= 0 && x < size && y < size) set(x, y, colour, hits / 16);
      }
    }
  });

  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    rows[y * (size * 3 + 1)] = 0; // filter: none
    px.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${size}.png`), png(size));
}
console.log('ui/icons: 180, 192, 512');
