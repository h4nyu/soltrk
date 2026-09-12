/**
 * Draws the home-screen icons into client/public.
 *
 * Kept as a script rather than committing only the PNGs so the icons stay
 * reproducible and reviewable - they are computed, not drawn in a tool. Run
 * with `npx tsx packages/web/scripts/make-icons.ts`; they change rarely enough
 * that this is not wired into the build.
 *
 * PNG is written by hand because nothing else here needs an image library:
 * IHDR, one zlib-deflated IDAT of filter-0 scanlines, IEND.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(__dirname, "..", "client", "public");

// The dashboard's own dark palette, so the icon and the page agree.
const BG: RGB = [0x16, 0x17, 0x1a];
const SUN: RGB = [0xf0, 0xb7, 0x57];
const GROUND: RGB = [0x62, 0xab, 0x86];

type RGB = [number, number, number];

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf: Buffer): number => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const png = (size: number, rgba: Uint8Array): Buffer => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

/**
 * Coverage of one pixel by the glyph, sampled 3x3 so edges are not jagged.
 * Everything is in units of the icon's side, so the same code draws any size.
 */
const coverage = (x: number, y: number, size: number, shape: (u: number, v: number) => boolean): number => {
  let hits = 0;
  for (let sy = 0; sy < 3; sy += 1) {
    for (let sx = 0; sx < 3; sx += 1) {
      const u = (x + (sx + 0.5) / 3) / size;
      const v = (y + (sy + 0.5) / 3) / size;
      if (shape(u, v)) hits += 1;
    }
  }
  return hits / 9;
};

// A sun over a horizon. Kept inside the middle 60% so that Android's maskable
// crop cannot cut it, and bold enough to read at 48px.
const CX = 0.5;
const CY = 0.44;
const DISC = 0.15;
const RAY_IN = 0.21;
const RAY_OUT = 0.3;
const RAY_HALF_WIDTH = 0.033;

const inSun = (u: number, v: number): boolean => {
  const dx = u - CX;
  const dy = v - CY;
  const r = Math.hypot(dx, dy);
  if (r <= DISC) return true;
  if (r < RAY_IN || r > RAY_OUT) return false;
  // Eight rays: the angle to the nearest multiple of 45 degrees, as a distance
  // across the ray rather than an angle, so rays keep a constant width.
  const a = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const off = Math.abs(a - Math.round(a / step) * step);
  return r * Math.sin(off) <= RAY_HALF_WIDTH;
};

// Below where the lowest ray ends (CY + RAY_OUT = 0.74) so the two do not
// collide, and short enough that its ends stay inside the central 80% circle
// Android crops a maskable icon to.
const inGround = (u: number, v: number): boolean =>
  v >= 0.765 && v <= 0.795 && u >= 0.26 && u <= 0.74;

const draw = (size: number): Buffer => {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const sun = coverage(x, y, size, inSun);
      const ground = coverage(x, y, size, inGround);
      // Painted back to front: background, horizon, then the sun over it.
      let [r, g, b] = BG;
      for (const [layer, colour] of [
        [ground, GROUND],
        [sun, SUN],
      ] as [number, RGB][]) {
        r = Math.round(r * (1 - layer) + colour[0] * layer);
        g = Math.round(g * (1 - layer) + colour[1] * layer);
        b = Math.round(b * (1 - layer) + colour[2] * layer);
      }
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255; // opaque: iOS composites its own mask anyway
    }
  }
  return png(size, rgba);
};

for (const size of [180, 192, 512]) {
  const file = join(OUT, `icon-${size}.png`);
  writeFileSync(file, draw(size));
  console.log(`${file}`);
}
