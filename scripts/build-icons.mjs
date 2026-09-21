#!/usr/bin/env node
/**
 * Renders every shipped icon from the single vector source at `public/logo.svg`.
 *
 *   npm run build:icons
 *
 * The five PNG/ICO files below are committed artifacts, not build output — Next
 * resolves `src/app/icon.png`, `src/app/apple-icon.png` and `src/app/favicon.ico`
 * as file-based metadata at build time, and `public/` ships them for anything
 * that wants the raw asset. They are committed so a clone does not need a
 * rasteriser to build.
 *
 * That is exactly why this script exists: five hand-maintained binaries drift.
 * Change the mark in `public/logo.svg`, run this, commit all seven files together.
 *
 * Three of the outputs are deliberately NOT a plain resize of the source:
 *
 *   - `apple-icon.png` is rendered full-bleed (the source's rounded corners are
 *     filled back in), because iOS applies its own squircle mask. A rounded
 *     icon inside a rounded mask reads as inset.
 *   - `favicon.ico` is cropped in before scaling. At 16px the safe-area padding
 *     is roughly a fifth of the glyph's legibility budget, and nothing is
 *     masking a browser tab, so the padding is pure loss there.
 *   - `src/components/BrandMark.tsx` is not a raster at all. The app chrome
 *     needs the mark in `currentColor` so it inherits whatever the surface
 *     around it is painted in, and an `<img src="…svg">` cannot inherit a
 *     colour — the SVG has to be inline in the DOM. So the ribbons are lifted
 *     out of the source and emitted as a React component, tile and gradients
 *     and long shadows dropped. Same producer as the other five, which is what
 *     keeps `public/logo.svg` the single source of the mark.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'public', 'logo.svg');

/**
 * Fills the corners for apple-icon. The tile in the source is a diagonal
 * gradient, so this is its midpoint rather than a token: the corner slivers it
 * paints are a few units off at the extreme tips, and iOS's squircle mask cuts
 * exactly those tips off. It is NOT a brand token from globals.css - see the
 * palette note in public/logo.svg.
 */
const BACKGROUND = '#163F48';

/**
 * Fraction of the source square the favicon keeps. Smaller = tighter crop.
 *
 * 0.62 was picked by rendering 0.80 / 0.70 / 0.62 / 0.55 at 16px and looking.
 * Above it the four ribbons collapse into a green smear; at 0.55 the slanted
 * ends clip against the frame, since the mark is 566 wide on a 1024 source.
 */
const FAVICON_CROP = 0.62;

/**
 * Sizes packed into favicon.ico: 16 is the legacy tab, 32 the retina tab, and
 * 48/64 are what Windows and pinned-tab surfaces reach for. This list matches
 * the frames the previous hand-made icon shipped — dropping one is a silent
 * downgrade that only shows up on somebody else's desktop.
 */
const FAVICON_SIZES = [16, 32, 48, 64];

/** Plain resizes of the source, corners and padding intact. */
const DIRECT = [
  ['public/icon-1024.png', 1024],
  ['public/icon.png', 512],
  ['src/app/icon.png', 512],
];

/** Where the inline `currentColor` variant lands. Generated — never hand-edited. */
const BRAND_MARK = 'src/components/BrandMark.tsx';

/**
 * The ribbons, and only the ribbons.
 *
 * Picking them by *what paints them* rather than by position: a ribbon is a
 * path filled with a ribbon gradient. The tile is a `<rect>`, and the four long
 * shadows carry no `fill` of their own (they inherit it from the `<g>` they sit
 * in), so neither can match this. If the source is redrawn with a different
 * number of ribbons, the count assertion below catches it instead of the
 * generator silently emitting a partial mark.
 */
const RIBBON = /<path\s+fill="url\(#r\d+\)"\s+d="([^"]+)"/g;

/**
 * Tightest box containing the ribbons, read off the path data.
 *
 * Every command in those paths (`M`, `L`, `C`) takes absolute coordinate pairs
 * and `Z` takes none, so every number in a `d` is one half of a point and the
 * numbers can simply be walked two at a time. Curve control points are included,
 * which makes this an upper bound on the true bounding box rather than the exact
 * one — for these four paths the controls sit inside the segment extents, so the
 * two agree, and if a redraw ever changes that the mark gains a hair of padding
 * rather than getting clipped.
 */
function markGeometry(paths) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const d of paths) {
    const numbers = (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
    if (numbers.length === 0 || numbers.length % 2 !== 0) {
      throw new Error(`ribbon path has an odd coordinate count — not pairs: ${d}`);
    }
    for (let i = 0; i < numbers.length; i += 2) {
      minX = Math.min(minX, numbers[i]);
      maxX = Math.max(maxX, numbers[i]);
      minY = Math.min(minY, numbers[i + 1]);
      maxY = Math.max(maxY, numbers[i + 1]);
    }
  }

  const x = Math.floor(minX);
  const y = Math.floor(minY);
  return { viewBox: `${x} ${y} ${Math.ceil(maxX) - x} ${Math.ceil(maxY) - y}` };
}

/**
 * The generated component's source text.
 *
 * `size` is the mark's *width*, not a square side, because the mark is not
 * square — 566 x 401, so it is wider than it is tall. Callers ask for the
 * dimension they are budgeting for in a row of chrome, and the other one
 * follows from the aspect ratio. `Icon`'s `size` means the same thing there; it
 * only happens to be both dimensions because its viewBox is square.
 */
function brandMarkSource(paths, viewBox) {
  const [, , width, height] = viewBox.split(' ').map(Number);
  const ribbons = paths.map((d) => `      <path d="${d}" />`).join('\n');

  return `/**
 * GENERATED by \`npm run build:icons\` from public/logo.svg. Do not edit — edit
 * the source and re-run, or the mark drifts from the shipped icons.
 *
 * The four ribbons of the helparr mark, monochrome. The tile, the lime-to-green
 * ramp and the long shadows are all dropped: this variant exists to sit in app
 * chrome, where it inherits \`currentColor\` from whatever is around it, and a
 * four-step gradient would put a second palette next to the single-accent
 * chrome the rest of the UI is painted in.
 */
import type { SVGProps } from 'react';

/** The mark's own bounding box in source units — see \`markGeometry\` in the generator. */
const VIEW_BOX = '${viewBox}';

/** ${width} / ${height}, the mark's aspect ratio. Height follows from the requested width. */
const ASPECT = ${width} / ${height};

interface BrandMarkProps extends SVGProps<SVGSVGElement> {
  /** Rendered width in px. Height is derived — the mark is wider than it is tall. */
  size?: number;
}

export default function BrandMark({ size = 16, className = '', ...rest }: BrandMarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={Number((size / ASPECT).toFixed(2))}
      viewBox={VIEW_BOX}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...rest}
    >
${ribbons}
    </svg>
  );
}
`;
}

/**
 * Rasterise the source at `size`. The density is pinned high rather than left
 * to librsvg's 72dpi default, otherwise the vector is rendered small and then
 * scaled up — which quietly reintroduces the soft edges this whole file exists
 * to avoid.
 */
function render(svg, size) {
  return sharp(svg, { density: 600 }).resize(size, size, { fit: 'fill' });
}

/**
 * ICO is a thin container: a 6-byte header, one 16-byte directory entry per
 * image, then the payloads. PNG payloads are legal in ICO since Vista, so the
 * images go in verbatim and there is no BMP/DIB encoding to get wrong. Written
 * by hand because neither sharp nor any other dependency here emits ICO, and a
 * whole package for 20 bytes of header is not a trade worth making.
 */
function buildIco(images) {
  const HEADER = 6;
  const ENTRY = 16;
  const header = Buffer.alloc(HEADER);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(ENTRY * images.length);
  let offset = HEADER + ENTRY * images.length;

  images.forEach(({ size, data }, i) => {
    const at = i * ENTRY;
    // 0 means 256 in this field; none of our sizes hit that, but be correct.
    directory.writeUInt8(size >= 256 ? 0 : size, at + 0);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2); // palette size (0 = no palette)
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.data)]);
}

async function main() {
  const svg = await readFile(SOURCE);
  const written = [];

  for (const [target, size] of DIRECT) {
    const data = await render(svg, size).png().toBuffer();
    await writeFile(path.join(ROOT, target), data);
    written.push([target, `${size}x${size}`, data.length]);
  }

  // Full-bleed for iOS: composite the rounded source onto an opaque square so
  // the transparent corners become background instead of holes.
  const apple = await sharp({
    create: { width: 180, height: 180, channels: 4, background: BACKGROUND },
  })
    .composite([{ input: await render(svg, 180).png().toBuffer() }])
    .png()
    .toBuffer();
  await writeFile(path.join(ROOT, 'src/app/apple-icon.png'), apple);
  written.push(['src/app/apple-icon.png', '180x180 (full bleed)', apple.length]);

  // Crop in before scaling down, so the glyph owns more of a 16px tab.
  const base = await render(svg, 1024).png().toBuffer();
  const side = Math.round(1024 * FAVICON_CROP);
  const inset = Math.round((1024 - side) / 2);
  // `flatten` composites the rounded corners onto the background and drops the
  // alpha channel with them, so sharp writes a 24-bit RGB PNG. Next decodes
  // `src/app/favicon.ico` at build time with a decoder that accepts RGBA only,
  // and fails the whole build with "The PNG is not in RGBA format!" — a break
  // that no test lane except `test:bundle`/`test:e2e`/`test:a11y` reaches,
  // because only those run `next build`. `ensureAlpha` puts an opaque alpha
  // channel back: same pixels, and it makes the 32bpp the ICO directory
  // declares below true rather than aspirational.
  const cropped = await sharp(base)
    .extract({ left: inset, top: inset, width: side, height: side })
    .flatten({ background: BACKGROUND })
    .ensureAlpha()
    .png()
    .toBuffer();

  const frames = [];
  for (const size of FAVICON_SIZES) {
    frames.push({
      size,
      data: await sharp(cropped).resize(size, size, { fit: 'fill' }).png().toBuffer(),
    });
  }
  const ico = buildIco(frames);
  await writeFile(path.join(ROOT, 'src/app/favicon.ico'), ico);
  written.push(['src/app/favicon.ico', FAVICON_SIZES.join('/'), ico.length]);

  // The inline chrome variant. Same source, no rasteriser involved.
  const ribbons = Array.from(svg.toString('utf8').matchAll(RIBBON), (m) => m[1]);
  if (ribbons.length !== 4) {
    throw new Error(
      `expected 4 ribbon paths in ${path.relative(ROOT, SOURCE)}, found ${ribbons.length} — ` +
        'the mark was redrawn; check RIBBON still matches what paints a ribbon',
    );
  }
  const { viewBox } = markGeometry(ribbons);
  const component = brandMarkSource(ribbons, viewBox);
  await writeFile(path.join(ROOT, BRAND_MARK), component);
  written.push([BRAND_MARK, `viewBox ${viewBox}`, Buffer.byteLength(component)]);

  const width = Math.max(...written.map(([f]) => f.length));
  console.log(`icons rendered from ${path.relative(ROOT, SOURCE)}\n`);
  for (const [file, dims, bytes] of written) {
    console.log(`  ${file.padEnd(width)}  ${dims.padEnd(22)} ${bytes} B`);
  }
}

main().catch((error) => {
  console.error(`build:icons failed — ${error.message}`);
  process.exit(1);
});
