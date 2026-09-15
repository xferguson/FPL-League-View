#!/usr/bin/env node
// Regenerates site/icons/icon.svg — the master app icon (a soccer ball on a
// pitch-green background) that every PNG icon in site/icons/ was rasterised
// from. Pure math, zero dependencies, matching the rest of this project.
//
//   node scripts/gen-icon-svg.mjs           # write site/icons/icon.svg
//   node scripts/gen-icon-svg.mjs --print   # print to stdout instead
//
// The PNGs (icon-192, icon-512, apple-touch-icon, favicon-16/32) are this SVG
// rasterised at each size — any SVG-to-PNG tool works. Re-run that step after
// editing this file and changing the design. Playwright is how they were
// originally produced here (open the SVG in a sized viewport and screenshot
// it), but that's a one-off export step, not a project dependency.

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = resolve(ROOT, 'site/icons/icon.svg');

const SIZE = 512;
const CX = SIZE / 2;
const CY = SIZE / 2;

const toRad = (deg) => (deg * Math.PI) / 180;

/** Points for a regular pentagon, one vertex pointing at `rotationDeg`. */
const pentagon = (cx, cy, r, rotationDeg) =>
  Array.from({ length: 5 }, (_, i) => {
    const a = toRad(rotationDeg - 90 + i * 72);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  })
    .map((p) => p.map((n) => Math.round(n * 100) / 100).join(','))
    .join(' ');

// Ball diameter is 67% of the icon — comfortably inside the 80%-diameter
// "safe zone" that Android's maskable-icon masks (circle, squircle, rounded
// square...) are guaranteed not to crop, so this one file is safe to declare
// as both "any" and "maskable" in the manifest.
const ballR = SIZE * 0.335;

const centerPent = pentagon(CX, CY, ballR * 0.36, 0);
const outerPents = Array.from({ length: 5 }, (_, i) => {
  const points = pentagon(
    CX + ballR * 0.62 * Math.cos(toRad(-90 + i * 72)),
    CY + ballR * 0.62 * Math.sin(toRad(-90 + i * 72)),
    ballR * 0.34,
    36 + i * 72
  );
  return `<polygon points="${points}"/>`;
}).join('\n      ');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <defs>
    <linearGradient id="pitch" x1="0" y1="0" x2="${SIZE}" y2="${SIZE}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#1f8a44"/>
      <stop offset="1" stop-color="#0b5c26"/>
    </linearGradient>
    <clipPath id="ballClip"><circle cx="${CX}" cy="${CY}" r="${ballR}"/></clipPath>
  </defs>
  <rect x="0" y="0" width="${SIZE}" height="${SIZE}" fill="url(#pitch)"/>
  <circle cx="${CX}" cy="${CY}" r="${ballR}" fill="#fbfbf9" stroke="rgba(11,11,11,0.14)" stroke-width="${SIZE * 0.006}"/>
  <g clip-path="url(#ballClip)" fill="#111214">
    <polygon points="${centerPent}"/>
    ${outerPents}
  </g>
</svg>
`;

if (process.argv.includes('--print')) {
  console.log(svg);
} else {
  await writeFile(OUT_FILE, svg);
  console.log(`Wrote ${OUT_FILE}`);
}
