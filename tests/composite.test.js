// Composite colour: NTSC artifact colours and PAL line-pair blending, as MAME 0.264's
// mc6847.cpp models them (class artifacter). The authority is the MAME comparison
// (node tools/mame-diff/run.js <profile> --video --artifact N: every pixel, and every artifact pixel checked
// against MAME's own mix colour); these tests pin known patterns with values worked out by hand from MAME's
// tables, so that a change is noticed without MAME.
const Emu = require('./load')();
const V = Emu.MC6847;

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const hex = (c) => '$' + (((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF)).toString(16).toUpperCase().padStart(6, '0');
const RGB = (r, g, b) => (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;

// one active line (line 10) of the 256x192 two-colour mode, drawn through the VDG as the machines draw it
function rg6Line(css, artifact, byte) {
  const v = new V();
  v.artifact = artifact;
  const y = V.BORDER_Y + 10, mode = 0xF0 | (css ? 0x08 : 0);
  const px = v.drawSamples(y, mode, 0, new Uint8Array(32).fill(byte), 32, 0);
  v.endLine(y, mode, px, false);
  const rgba = Emu.frameToRGBA(v.frame);
  return (x) => rgba[y * V.WIDTH + V.BORDER_X + x];
}

// ---------------- NTSC ----------------
// Our colours: black $0A0A0A, buff $BFC8AD. A pair's six-pixel window (two pixels either side, lit = buff)
// indexes artifact_correction; its entries pick colours[0..15] (0 = black, 15 = buff, 1-14 the mixes), and
// mix i uses artifact_colors row (i - 1) xor (setting & 1). Per channel: trunc(c0 (1 - f) + c1 f + 0.5).
// $AA (lit, unlit, ...): window 101010 = 42 -> entries 84, 85 = 9, 9. Setting 1: row 8 xor 1 = 9, factors
// (1, 0.5, 0): R = $BF, G = trunc(10 * 0.5 + 200 * 0.5 + 0.5) = 105 = $69, B = $0A: orange. Setting 2: row 8,
// factors (0, 0.5, 1): $0A, $69, $AD: blue. $55: window 010101 = 21 -> entries 42, 43 = 10, 10: the other one.
{
  const ORANGE = RGB(0xBF, 0x69, 0x0A), BLUE = RGB(0x0A, 0x69, 0xAD);
  for (const [setting, byte, want, name] of [[1, 0xAA, ORANGE, 'orange'], [2, 0xAA, BLUE, 'blue'], [1, 0x55, BLUE, 'blue'], [2, 0x55, ORANGE, 'orange']]) {
    const p = rg6Line(true, setting, byte);
    let ok = true;
    for (let x = 2; x < 254; x++) if (p(x) !== want) { ok = false; break; }
    check(`artifact setting ${setting}: $${byte.toString(16).toUpperCase()} in 256x192 CSS 1 is ${name}`, ok, `(${hex(p(100))})`);
  }
  // solid: buff; empty: black, except where the window reaches the buff border at each end. Left pair:
  // window 110000 = 48 -> entries 96, 97 = 2, 13. Setting 1: mix 2 = row 1 xor 1 = 0 (0.157, 0, 0.157):
  // R = trunc(10 * 0.843 + 191 * 0.157 + 0.5) = 38 = $26, G = $0A, B = trunc(10 * 0.843 + 173 * 0.157 + 0.5) = 36 = $24;
  // mix 13 = row 12 xor 1 = 13 (0, 0, 0.236): B = trunc(10 * 0.764 + 173 * 0.236 + 0.5) = 48 = $30.
  // Right pair: window 000011 = 3 -> entries 6, 7 = 0 (black), 2.
  const full = rg6Line(true, 1, 0xFF), empty = rg6Line(true, 1, 0x00);
  check('artifact setting 1: $FF is buff', full(0) === RGB(0xBF, 0xC8, 0xAD) && full(128) === RGB(0xBF, 0xC8, 0xAD), `(${hex(full(128))})`);
  check('artifact setting 1: $00 is black in the middle', empty(2) === RGB(0x0A, 0x0A, 0x0A) && empty(128) === RGB(0x0A, 0x0A, 0x0A), `(${hex(empty(128))})`);
  check('artifact setting 1: $00 next to the left border', empty(0) === RGB(0x26, 0x0A, 0x24) && empty(1) === RGB(0x0A, 0x0A, 0x30), `(${hex(empty(0))} ${hex(empty(1))})`);
  check('artifact setting 1: $00 next to the right border', empty(254) === RGB(0x0A, 0x0A, 0x0A) && empty(255) === RGB(0x26, 0x0A, 0x24), `(${hex(empty(254))} ${hex(empty(255))})`);
  // CSS 0 (black and green, $30D200): $AA, setting 1, factors (1, 0.5, 0): $30, trunc(5 + 105 + 0.5) = 110 = $6E, $0A
  const g = rg6Line(false, 1, 0xAA);
  check('artifact setting 1: $AA in 256x192 CSS 0', g(100) === RGB(0x30, 0x6E, 0x0A), `(${hex(g(100))})`);
  // off: two colours
  const off = rg6Line(true, 0, 0xAA);
  check('artifacting off: $AA is buff and black', off(100) === RGB(0xBF, 0xC8, 0xAD) && off(101) === RGB(0x0A, 0x0A, 0x0A));
  // other modes are left alone: RG3 (128x192, mode $D8) with $AA
  const v = new V(); v.artifact = 1;
  const y = V.BORDER_Y + 10, px = v.drawSamples(y, 0xD8, 0, new Uint8Array(16).fill(0xAA), 16, 0);
  v.endLine(y, 0xD8, px, false);
  // (RG3 pixels are two wide: $AA is buff at 0-1, black at 2-3)
  const r3 = Emu.frameToRGBA(v.frame), at = (x) => r3[y * V.WIDTH + V.BORDER_X + x];
  check('artifact colours only in the 256x192 mode', at(0) === RGB(0xBF, 0xC8, 0xAD) && at(1) === at(0) && at(2) === RGB(0x0A, 0x0A, 0x0A) && at(3) === at(2) && at(100) === at(0));
}

// ---------------- PAL ----------------
// mc6847.cpp create_color_blend_table: red above blue becomes $7C2E81; blending happens on each odd active
// line with the line above, in the semigraphics modes and the four-colour graphics modes (GM0 = 0).
{
  const RED = 3, BLUE = 2, GREEN = 0;
  // a = odd active line; codes above and below; the line's first mode and byte
  const pal = (a, up, down, mode, first = 0) => {
    const v = new V(); v.pal = true; v.artifact = 1;
    const lo = (V.BORDER_Y + a) * V.WIDTH + V.BORDER_X, hi = lo - V.WIDTH;
    v.frame.data.fill(up, hi, hi + 256); v.frame.data.fill(down, lo, lo + 256);
    v.firstMode[a] = mode; v.firstByte[a] = first;
    v.finishLine(V.BORDER_Y + a);
    const rgba = Emu.frameToRGBA(v.frame);
    return [rgba[hi + 7], rgba[lo + 7]];
  };
  const [u, d] = pal(11, RED, BLUE, 0x80);
  check('PAL: red above blue in CG1 blends to $7C2E81, both lines', u === RGB(0x7C, 0x2E, 0x81) && d === u, `(${hex(u)} ${hex(d)})`);
  const [u2] = pal(11, BLUE, RED, 0xE8);
  check('PAL: blue above red in CG6 CSS 1 blends to $6B3E6B', u2 === RGB(0x6B, 0x3E, 0x6B), `(${hex(u2)})`);
  const [u3] = pal(11, RED, BLUE, 0x90);
  check('PAL: no blending in a two-colour mode (GM0 = 1)', u3 === Emu.MC6847.TABLE[RED]);
  const [u4] = pal(10, RED, BLUE, 0x80);
  check('PAL: no blending from an even line', u4 === Emu.MC6847.TABLE[RED]);
  const [u5] = pal(11, RED, BLUE, 0x00, 0x80);
  check('PAL: semigraphics text line (first byte bit 7) blends', u5 === RGB(0x7C, 0x2E, 0x81));
  const [u6] = pal(11, RED, BLUE, 0x00, 0x41);
  check('PAL: alphanumeric text line does not blend', u6 === Emu.MC6847.TABLE[RED]);
  const [u7] = pal(11, RED, GREEN, 0x80);
  check('PAL: a pair without a blend colour is left alone', u7 === Emu.MC6847.TABLE[RED]);
  const v = new V(); v.pal = true; v.artifact = 1;
  const y = V.BORDER_Y + 10, px = v.drawSamples(y, 0xF8, 0, new Uint8Array(32).fill(0xAA), 32, 0);
  v.endLine(y, 0xF8, px, false);
  check('PAL: no NTSC artifact colours', Emu.frameToRGBA(v.frame)[y * V.WIDTH + V.BORDER_X + 100] === RGB(0xBF, 0xC8, 0xAD));
}

// ---------------- the CoCo 3's compatibility modes ----------------
// MAME runs the GIME's compatibility-mode 256-pixel two-colour lines through the same artifacter (gime.cpp
// render_scanline), with palette entries 10 and 11 (CSS 1) as background and foreground, each pixel two wide.
// Palette 10 = 0 (black), 11 = 63 (white, $FFFFFF on the RGB monitor). $AA, setting 1: mix 9 with factors
// (1, 0.5, 0): R = 255, G = trunc(255 * 0.5 + 0.5) = 128, B = 0: $FF8000. Setting 2: (0, 0.5, 1): $0080FF.
{
  const line = (setting, byte, ff22 = 0xF8) => {
    const m = Emu.createMachine('coco3'), g = m.gime;
    g.legacy = true; g.ff22 = ff22; g.sam = 6; g.palette[10] = 0; g.palette[11] = 63; g.palette[6] = 63; g.videoPos = 0; g.lineInRow = 0;
    g.ram.fill(byte, 0, 64);
    g.artifact = setting;
    g.recordBody(11);                        // physical line 11 = output row 10
    const t = g.frame.table;
    return (x) => t[g.frame.data[10 * 640 + 64 + x]];   // pixel x of the 512-pixel active area
  };
  const p1 = line(1, 0xAA), p2 = line(2, 0xAA), p0 = line(0, 0xAA);
  check('CoCo 3: $AA, setting 1, is $FF8000, two output pixels per pixel', p1(100) === RGB(0xFF, 0x80, 0x00) && p1(101) === p1(100) && p1(102) === p1(100), `(${hex(p1(100))})`);
  check('CoCo 3: $AA, setting 2, is $0080FF', p2(100) === RGB(0x00, 0x80, 0xFF), `(${hex(p2(100))})`);
  check('CoCo 3: artifacting off: white and black', p0(100) === RGB(0xFF, 0xFF, 0xFF) && p0(102) === RGB(0x00, 0x00, 0x00));
  // CG6 CSS 1 ($E8): $AA is four pixels of colour 2 = palette 6 (set to 63, white), each four wide: all white
  const cg6 = line(1, 0xAA, 0xE8);
  let allWhite = true;
  for (let x = 0; x < 512; x++) if (cg6(x) !== RGB(0xFF, 0xFF, 0xFF)) allWhite = false;
  check('CoCo 3: no artifact colours in a four-colour mode', allWhite, `(${hex(cg6(100))})`);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
