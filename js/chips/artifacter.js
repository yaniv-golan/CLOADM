/*
 * NTSC artifact colours as MAME 0.264 models them (src/devices/video/mc6847.cpp, class artifacter), shared by
 * the MC6847 and the GIME (whose compatibility modes MAME runs through the same artifacter, gime.cpp
 * render_scanline). In the 256-pixel two-colour mode a composite TV sees each pair of pixels as a colour: MAME
 * looks at a six-pixel window (two pixels either side of the pair, lit = the foreground colour) and picks each of
 * the pair's two colours from 16 - the background (0), the foreground (15) and 14 mixes of the two
 * (update_colors: artifact_colors, artifact_correction, mix_color). The phase setting (MAME's "Artifacting"
 * option: 1 Standard, 2 Reverse) swaps each mix with its partner.
 */
const ART_FACTORS = [
  0.157, 0.000, 0.157,  0.000, 0.157, 0.000,  1.000, 0.824, 1.000,  0.824, 1.000, 0.824,
  0.706, 0.236, 0.118,  0.000, 0.197, 0.471,  1.000, 0.550, 0.393,  0.275, 0.785, 1.000,
  0.000, 0.500, 1.000,  1.000, 0.500, 0.000,  1.000, 0.942, 0.785,  0.393, 0.942, 1.000,
  0.236, 0.000, 0.000,  0.000, 0.000, 0.236,
];
// window (6 bits, leftmost pixel first) * 2 + pixel of the pair -> colour 0-15
const ART_CORRECTION = [
  0, 0, 0, 0, 0, 6, 0, 2, 5, 7, 5, 7, 1, 3, 1, 11, 8, 6, 8, 14, 8, 9, 8, 9, 4, 4, 4, 15, 12, 12, 12, 15,
  5, 13, 5, 13, 13, 0, 13, 2, 10, 10, 10, 10, 10, 15, 10, 11, 3, 1, 3, 1, 15, 9, 15, 9, 11, 11, 11, 11, 15, 15, 15, 15,
  14, 0, 14, 0, 14, 6, 14, 2, 0, 7, 0, 7, 1, 3, 1, 11, 9, 6, 9, 14, 9, 9, 9, 9, 15, 4, 15, 15, 12, 12, 12, 15,
  2, 13, 2, 13, 2, 0, 2, 2, 10, 10, 10, 10, 10, 15, 10, 11, 12, 1, 12, 1, 12, 9, 12, 9, 15, 11, 15, 11, 15, 15, 15, 15,
];
const rgb = (r, g, b) => (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;   // little-endian RGBA, as Frame tables
const channels = (c) => [c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF];
// MAME's mix_color, per channel: (uint8_t)(c0 * (1 - f) + c1 * f + 0.5)
const mix = (f, c0, c1) => Math.trunc(c0 * (1 - f) + c1 * f + 0.5) & 0xFF;

// The 14 mixes (colours 1-14) of background c0 and foreground c1 (Frame table values) for phase setting v.
export function mixColours(v, c0, c1) {
  const a = channels(c0), b = channels(c1), out = [];
  for (let i = 1; i <= 14; i++) {
    const f = ART_FACTORS.slice(((i - 1) ^ (v & 1)) * 3, ((i - 1) ^ (v & 1)) * 3 + 3);
    out.push(rgb(mix(f[0], a[0], b[0]), mix(f[1], a[1], b[1]), mix(f[2], a[2], b[2])));
  }
  return out;
}

// Artifact one line of 256 pixels in place. lit(x): whether pixel x (-2..257, so into the borders) is the
// foreground; out[x] receives the colour number 0-15 of pixel x.
export function artifactLine(lit, out) {
  for (let x = 0; x < 256; x += 2) {
    let v = 0;
    for (let k = -2; k <= 3; k++) v = (v << 1) | (lit(x + k) ? 1 : 0);
    out[x] = ART_CORRECTION[v * 2];
    out[x + 1] = ART_CORRECTION[v * 2 + 1];
  }
}
