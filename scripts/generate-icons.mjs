// Render icons/icon.svg (and icon-small.svg for tiny sizes) to PNG at every
// size Chrome and the website need. Run with `npm run icons`.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Map each output PNG to (source svg, output px). The "small" variant drops
// the mountain silhouette and uses a thicker trail stroke so the icon stays
// readable at 16/32 px.
const TARGETS = [
  { src: 'icons/icon-small.svg', out: 'icons/icon-16.png', size: 16 },
  { src: 'icons/icon-small.svg', out: 'icons/icon-32.png', size: 32 },
  { src: 'icons/icon.svg', out: 'icons/icon-48.png', size: 48 },
  { src: 'icons/icon.svg', out: 'icons/icon-128.png', size: 128 },
  // Chrome Web Store listing tile is rendered at 440×280; the 512 PNG is the
  // standard upload size for the store icon and gives us a high-res master.
  { src: 'icons/icon.svg', out: 'icons/icon-512.png', size: 512 },
  // Website assets. docs/icons/ is served at /icons/ via GitHub Pages.
  { src: 'icons/icon.svg', out: 'docs/icons/icon-256.png', size: 256 },
  { src: 'icons/icon.svg', out: 'docs/icons/icon-512.png', size: 512 }
];

await mkdir(resolve(ROOT, 'docs/icons'), { recursive: true });

for (const t of TARGETS) {
  const svg = await readFile(resolve(ROOT, t.src));
  // density bumps the SVG render resolution so anti-aliasing stays clean.
  await sharp(svg, { density: 384 })
    .resize(t.size, t.size)
    .png({ compressionLevel: 9 })
    .toFile(resolve(ROOT, t.out));
  console.log(`✓ ${t.out} (${t.size}×${t.size}) ← ${t.src}`);
}

console.log('Done.');
