/* MC6847 / MC6847T1 Video Display Generator renderer (frame based) */
import { Frame } from '../video/frame.js';
import { artifactLine, mixColours } from './artifacter.js';

// 5x7 glyphs of the MC6847's internal character set (codes 0x00-0x3F), matching the real chip
const FONT_SRC = [
  '0E11010D15150E', '040A11111F1111', '1E09090E09091E', '0E11101010110E', // @ A B C
  '1E09090909091E', '1F10101E10101F', '1F10101E101010', '0F10101311110F', // D E F G
  '1111111F111111', '0E04040404040E', '0101010111110E', '11121418141211', // H I J K
  '1010101010101F', '111B1515111111', '11191513111111', '1F11111111111F', // L M N O
  '1E11111E101010', '0E11111115120D', '1E11111E141211', '0E11080402110E', // P Q R S
  '1F040404040404', '1111111111110E', '1111110A0A0404', '11111115151B11', // T U V W
  '11110A040A1111', '11110A04040404', '1F01020408101F', '1C10101010101C', // X Y Z [
  '10100804020101', '07010101010107', '040E1504040404', '0004081F080400', // \ ] up left
  '00000000000000', '04040404040004', '0A0A0A00000000', '0A0A1B001B0A0A', // sp ! " #
  '040F100E011E04', '19190204081313', '0814140815120D', '0C0C0C00000000', // $ % & '
  '04081010100804', '04020101010204', '00040E1F0E0400', '0004041F040400', // ( ) * +
  '00000018180810', '0000001F000000', '00000000001818', '01010204081010', // , - . /
  '0C12121212120C', '040C040404040E', '0E11010E10101F', '0E11010601110E', // 0 1 2 3
  '02060A1F020202', '1F101E0101110E', '0E10101E11110E', '1F010204081010', // 4 5 6 7
  '0E11110E11110E', '0E11110F01010E', '000C0C000C0C00', '0C0C000C0C0408', // 8 9 : ;
  '02040810080402', '00001F001F0000', '08040201020408', '0C120204040004', // < = > ?
];

// Build 64 glyphs of 12 rows x 8 pixels (bit 7 = leftmost)
const FONT = new Uint8Array(64 * 12);
FONT_SRC.forEach((hex, ch) => {
  for (let r = 0; r < 7; r++) {
    const bits = parseInt(hex.substr(r * 2, 2), 16);
    FONT[ch * 12 + 3 + r] = bits << 1; // 5 pixels in columns 2..6 of the 8-pixel cell
  }
});

// MC6847T1 (CoCo 2B) character set, codes $00-$3F: full 8x12 cells (12 rows of 8 pixels), matching the real chip
const T1_UPPER_SRC = [
  '001C22021A26221C00000000', '00081422223E222200000000', '003C12121C12123C00000000', '001C22202020221C00000000',
  '003C12121212123C00000000', '003E20203820203E00000000', '003E20203820202000000000', '001E20202622221E00000000',
  '002222223E22222200000000', '001C08080808081C00000000', '000202020222221C00000000', '002224283028242200000000',
  '002020202020203E00000000', '0022362A2A22222200000000', '002222322A26222200000000', '001C22222222221C00000000',
  '003C22223C20202000000000', '001C2222222A241A00000000', '003C22223C28242200000000', '001C22201C02221C00000000',
  '003E08080808080800000000', '002222222222221C00000000', '002222221414080800000000', '00222222222A362200000000',
  '002222140814222200000000', '002222140808080800000000', '003E02040810203E00000000', '001C10101010101C00000000',
  '000020100804020000000000', '001C04040404041C00000000', '00081C2A0808080800000000', '000008103E10080000000000',
  '000000000000000000000000', '000808080808000800000000', '001414140000000000000000', '0014143E003E141400000000',
  '00081E201C023C0800000000', '003032040810260600000000', '00102828102A241A00000000', '001818102000000000000000',
  '000408101010080400000000', '001008040404081000000000', '0000082A1C1C2A0800000000', '000008083E08080000000000',
  '000000000000181810200000', '000000003E00000000000000', '000000000000181800000000', '000002040810200000000000',
  '001C22262A32221C00000000', '000818080808081C00000000', '001C22021C20203E00000000', '001C22020C02221C00000000',
  '00040C14243E040400000000', '003E203C0202221C00000000', '000C10203C22221C00000000', '003E02040810202000000000',
  '001C22221C22221C00000000', '001C22221E02041800000000', '000000181800181800000000', '000000181800181810200000',
  '000408102010080400000000', '0000003E003E000000000000', '001008040204081000000000', '001C22020408000800000000',
];

// MC6847T1 lowercase set, codes $00-$1F in lowercase mode: full 8x12 cells
const T1_LOWER_SRC = [
  '000814220000000000000000', '0000001C021E221E00000000', '0020202C3222322C00000000', '0000001C2220221C00000000',
  '0002021A2622261A00000000', '0000001C223E201C00000000', '00040A081C08080800000000', '0000001A26261A02221C0000',
  '0020202C3222222200000000', '000800180808081C00000000', '0000020002020202221C0000', '002020242830282400000000',
  '001808080808081C00000000', '000000342A2A2A2A00000000', '0000002C3222222200000000', '0000001C2222221C00000000',
  '0000002C3222322C20200000', '0000001A2622261A02020000', '0000002C3220202000000000', '0000001E201C023C00000000',
  '0008083E08080A0400000000', '000000222222261A00000000', '000000222222140800000000', '00000022222A2A1400000000',
  '000000221408142200000000', '0000002222221E02221C0000', '0000003E0408103E00000000', '000408081008080400000000',
  '000808080008080800000000', '001008080408081000000000', '00102A040000000000000000', '000000000000003E00000000',
];

const cells = (src) => {
  const out = new Uint8Array(src.length * 12);
  src.forEach((hex, ch) => { for (let r = 0; r < 12; r++) out[ch * 12 + r] = parseInt(hex.substr(r * 2, 2), 16); });
  return out;
};
const T1_UPPER = cells(T1_UPPER_SRC), T1_LOWER = cells(T1_LOWER_SRC);

// colour codes in the frame (Frame), and their RGB values
const GREEN = 0, YELLOW = 1, BLUE = 2, RED = 3, BUFF = 4, CYAN = 5, MAGENTA = 6, ORANGE = 7;
const BLACK = 8, DARK_GREEN = 9, DARK_ORANGE = 10, BRIGHT_ORANGE = 11;
const rgb = (r, g, b) => (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0; // little-endian RGBA
const TABLE = [
  rgb(0x30, 0xD2, 0x00), rgb(0xC1, 0xE5, 0x00), rgb(0x4C, 0x3A, 0xB4), rgb(0x9A, 0x32, 0x36), // green yellow blue red
  rgb(0xBF, 0xC8, 0xAD), rgb(0x41, 0xAF, 0x71), rgb(0xC8, 0x4E, 0xF0), rgb(0xD4, 0x7F, 0x00), // buff cyan magenta orange
  rgb(0x0A, 0x0A, 0x0A),                         // black
  rgb(0x00, 0x3A, 0x00), rgb(0x6B, 0x27, 0x00),  // alphanumeric backgrounds (CSS 0 / 1)
  rgb(0xFF, 0xB7, 0x00),                         // alphanumeric foreground with CSS=1
];

// ---- Composite colour, as MAME 0.264 models it (src/devices/video/mc6847.cpp, class artifacter) ----
// NTSC artifact colours in the 256x192 mode: js/chips/artifacter.js (shared with the GIME).
// colour codes of the 14 mixes: 12-25 with CSS 0 (black and green), 26-39 with CSS 1 (black and buff)
const MIX = [12, 26];
// PAL: MAME blends each pair of active lines (process_artifacts_pal) in the semigraphics and four-colour
// modes, replacing two different colours one above the other by one colour (create_color_blend_table),
// a model of a PAL TV's averaging of adjacent lines' colour. [upper, lower, colour]; codes 40-55.
const PAL_BLEND = [
  [RED, BLUE, rgb(0x7C, 0x2E, 0x81)], [BLUE, RED, rgb(0x6B, 0x3E, 0x6B)],
  [ORANGE, MAGENTA, rgb(0xBE, 0x73, 0x65)], [MAGENTA, ORANGE, rgb(0xDE, 0x5F, 0x6A)],
  [ORANGE, CYAN, rgb(0x7E, 0xA2, 0x00)], [CYAN, ORANGE, rgb(0x99, 0x8D, 0x3C)],
  [CYAN, MAGENTA, rgb(0x82, 0x80, 0xC5)], [MAGENTA, CYAN, rgb(0x89, 0x80, 0x9F)],
  [GREEN, CYAN, rgb(0x44, 0xB7, 0x1B)], [CYAN, GREEN, rgb(0x4A, 0xF2, 0x70)],
  [YELLOW, BUFF, rgb(0xDC, 0xD2, 0x57)], [BUFF, YELLOW, rgb(0xD1, 0xF6, 0x95)],
  [GREEN, MAGENTA, rgb(0xA6, 0x86, 0x10)], [MAGENTA, GREEN, rgb(0x6B, 0xBE, 0xB3)],
  [GREEN, ORANGE, rgb(0x91, 0xC5, 0x3B)], [ORANGE, GREEN, rgb(0xAD, 0xBC, 0x22)],
];
const PAL_CODE = new Uint8Array(256 * 16).fill(0xFF);   // upper * 16 + lower -> blended code
PAL_BLEND.forEach(([a, b], i) => { PAL_CODE[a * 16 + b] = 40 + i; });

const BORDER_X = 32, BORDER_Y = 24;
const WIDTH = 256 + BORDER_X * 2, HEIGHT = 192 + BORDER_Y * 2;

// Graphics modes: [bytes fetched per scanline, scanlines per fetched row, bits per pixel].
// Taken from MAME's mc6847.cpp: record_body_scanline() calls record_scanline_res<sample_count,
// yres>, and the row is repeated 192/yres times. A mode that fetches 16 bytes draws them 16
// pixels wide and one that fetches 32 draws them 8 wide, so both fill the 256-pixel active area.
const GMODES = [
  [16, 3, 2], // GM0 CG1  64x64   4c
  [16, 3, 1], // GM1 RG1 128x64   2c
  [32, 3, 2], // GM2 CG2 128x64   4c
  [16, 2, 1], // GM3 RG2 128x96   2c
  [32, 2, 2], // GM4 CG3 128x96   4c
  [16, 1, 1], // GM5 RG3 128x192  2c
  [32, 1, 2], // GM6 CG6 128x192  4c
  [32, 1, 1], // GM7 RG6 256x192  2c
];
const GMODE_NAMES = ['CG1', 'RG1', 'CG2', 'RG2', 'CG3', 'RG3', 'CG6', 'RG6'];   // GMODES' rows, as the data sheet names them

// External character mode (INT/EXT high, AS low) with no external character ROM fitted, as on the
// Dragon and CoCo: every row of the cell is the complement of the byte's low seven bits, so the
// leftmost pixel is always lit. This is MAME's "stripe" font (mc6847.cpp: m_stripes[i] = ~(i / 12),
// indexed by data & 0x7F, foreground for set bits). As MAME (m_stripes); no hardware reference for what a
// Dragon or CoCo shows here has been found.
const stripe = (ch) => ~(ch & 0x7F) & 0xFF;

// Scanline renderer. The machine draws each active line as the beam passes it (drawSamples(), endLine()),
// with the data bytes its address counter fetched, and border rows with borderLine().
//
// A mode change part-way through a scanline splits that scanline: the part before the change is
// drawn with the old mode and the part after with the new one. The VDG has no line buffer - it
// converts each byte as it is fetched - which is what MAME models by recording, at the moment of
// the change, only the rest of the line (mc6847.cpp video_flush/record_partial_body_scanline).
// Positions are 0-32 across the 256-pixel active area; clocks since HS map to a position by
// (clocks - 25) / 4 (MAME's experimentally determined offset to the first visible pixel).
class MC6847 {
  constructor() {
    this.width = WIDTH; this.height = HEIGHT;
    this.frame = new Frame(WIDTH, HEIGHT, 4 / 3, Object.freeze({ x: BORDER_X, y: BORDER_Y, width: 256, height: 192 }));
    this.frame.table.set(TABLE);
    this.t1 = false;      // MC6847T1 (CoCo 2B): lowercase mode instead of SG6/external characters
    this.pal = false;     // PAL composite colour (line-pair blending) instead of NTSC artifact colours
    PAL_BLEND.forEach(([, , c], i) => { this.frame.table[40 + i] = c; });
    this.lineBuf = new Uint8Array(256);
    // per active line, the mode and data byte the line began with (MAME: m_mode[0]); composite colour
    // follows them
    this.firstMode = new Uint8Array(192);
    this.firstByte = new Uint8Array(192);
    // An external character generator fitted in place of the internal set (the Dragon 200-E): the machine
    // supplies the glyph byte for (fetched byte, raster line, bank), or null for the internal set.
    this.getCharRom = null;
    this.charBank = 0;    // the machine's bank input to the character generator (the 200-E: PIA1 PB4)
    // The Dragon 200-E wires the VDG differently from the CoCo (dragon.cpp dragon200e_state::sam_read):
    // INTEXT comes from the fetched byte's bit 7 inverted, not from PIA1 PB4, and INV from its LK1 link,
    // not from the byte's bit 6. Both default to the CoCo/Dragon wiring.
    this.extIntFromData = false;
    this.invInput = null;  // null: INV is the fetched byte's bit 6; true/false: tied high or low
    this.artifact = 0;
  }
  // composite colour: 0 off, 1 or 2 the NTSC artifact phase (MAME's "Artifacting": Standard, Reverse); on a
  // PAL machine any non-zero value turns line-pair blending on
  get artifact() { return this._artifact; }
  set artifact(v) {
    this._artifact = v;
    [GREEN, BUFF].forEach((fg, css) => this.frame.table.set(mixColours(v, TABLE[BLACK], TABLE[fg]), MIX[css]));
  }
  saveState() { return { firstMode: Array.from(this.firstMode), firstByte: Array.from(this.firstByte) }; }
  loadState(s) { this.firstMode.set(s.firstMode); this.firstByte.set(s.firstByte); }

  // Composite colour for active line y once it is complete (MAME applies it to each line in screen_update,
  // after the line's right border is drawn).
  finishLine(y) {
    const a = y - BORDER_Y;
    if (!this._artifact || a < 0 || a > 191) return;
    const px = this.frame.data, mode = this.firstMode[a], ag = mode & 0x80;
    if (this.pal) {
      // the semigraphics modes (AS: the first byte's bit 7 in text) and the four-colour graphics modes
      // (GM0 = 0, PB4 on these machines), for each odd line with the line above it
      if (!(a & 1) || !(ag ? !(mode & 0x10) : this.firstByte[a] & 0x80)) return;
      const lo = y * WIDTH + BORDER_X, hi = lo - WIDTH;
      for (let x = 0; x < 256; x++) {
        const u = px[hi + x], d = px[lo + x];
        if (u === d || u > 15 || d > 15) continue;
        const c = PAL_CODE[u * 16 + d];
        if (c !== 0xFF) { px[hi + x] = c; px[lo + x] = c; }
      }
      return;
    }
    if ((mode & 0xF0) !== 0xF0) return;              // NTSC artifact colours: the 256x192 mode only
    const css = (mode >> 3) & 1, c1 = css ? BUFF : GREEN, base = MIX[css] - 1;
    const row = y * WIDTH + BORDER_X, line = this.lineBuf;
    artifactLine((x) => px[row + x] === c1, line);
    for (let x = 0; x < 256; x++) { const n = line[x]; line[x] = n === 0 ? BLACK : n === 15 ? c1 : base + n; }
    px.set(line, row);
  }
  // bytes per scanline and line repeat when the VDG generates its own addresses (machines without a SAM)
  static addressing(modeByte) {
    return modeByte & 0x80 ? GMODES[(modeByte >> 4) & 7].slice(0, 2) : [32, 12];
  }

  // bytes the VDG fetches along one scanline in this mode: 32 in text and the 32-byte graphics
  // modes, 16 in the 16-byte graphics modes (GMODES gives those as 16)
  static bytesPerLine(modeByte) {
    return modeByte & 0x80 ? GMODES[(modeByte >> 4) & 7][0] : 32;
  }
  // graphics mode GM (0-7) as the data sheet names it, with its picture: { name: 'CG1'..'RG6', width, height, colours }
  // (from GMODES: bytes per line x 8 / bits per pixel across, 192 lines / lines per row down)
  static graphicsMode(gm) {
    const [bytes, rows, bits] = GMODES[gm & 7];
    return { name: GMODE_NAMES[gm & 7], width: bytes * 8 / bits, height: 192 / rows, colours: 1 << bits };
  }
  // clocks since the line began (HS on) -> active byte position, MAME's rule (mc6847.cpp
  // scanline_position_from_clock): the first visible pixel 25 clocks in, four clocks per position.
  // MAME divides with C's truncation toward zero; below the visible area every value is "before it".
  static positionFromClock(clocks) { return Math.trunc((clocks - 25) / 4); }
  static borderOf(modeByte) { return modeByte & 0x80 ? (modeByte & 0x08 ? BUFF : GREEN) : BLACK; }

  // The VDG's alphanumeric control inputs, per fetched byte. On the Dragon and CoCo the character code's
  // bit 7 is AS and its bit 6 is INV (MAME's coco12_m.cpp sam_read drives as_w/inv_w from the byte), and
  // INTEXT comes from PIA1 PB4. The Dragon 200-E instead ties INTEXT to /AS and INV to its LK1 link
  // (dragon.cpp dragon200e_state::sam_read), which is how its character ROM gets to draw every text byte.
  charAs(ch) { return !!(ch & 0x80); }
  charIntExt(ch, modeByte) { return this.extIntFromData ? !(ch & 0x80) : !!(modeByte & 0x10); }
  charInv(ch) { return this.invInput === null ? !!(ch & 0x40) : !!this.invInput; }
  // one glyph row from the internal set (the T1's in its modes), with the INV input applied
  glyph(ch, line) {
    const bits = (this.t1 ? T1_UPPER : FONT)[(ch & 0x3F) * 12 + line];
    return this.charInv(ch) ? ~bits & 0xFF : bits;
  }
  // one glyph row from the external generator; MAME passes the fetched byte unmasked
  extGlyph(ch, line) {
    const bits = this.getCharRom(ch, line, this.charBank);
    return this.charInv(ch) ? ~bits & 0xFF : bits;
  }

  // A scanline drawn as the beam passes it, as MAME's mc6847.cpp records it: each run of bytes the VDG
  // fetched with one mode is emitted from the pixel the previous run reached (emit_samples() advances
  // its pixel pointer by what each sample drew), so a 16-byte mode draws each byte 16 pixels wide
  // wherever its run starts. drawSamples() returns the pixel reached; the left border takes the mode
  // of the line's first byte (MAME: m_mode[0]).
  drawSamples(y, modeByte, textLine, bytes, n, startPixel) {
    const px = this.frame.data, row = y * WIDTH;
    if (startPixel === 0 && n) {
      px.fill(MC6847.borderOf(modeByte), row, row + BORDER_X);
      const a = y - BORDER_Y;
      if (a >= 0 && a < 192) { this.firstMode[a] = modeByte; this.firstByte[a] = bytes[0]; }
    }
    let o = row + BORDER_X + startPixel;
    for (let i = 0; i < n; i++) o = this.emitSample(px, o, modeByte, textLine, bytes[i]);
    return o - (row + BORDER_X);
  }
  // End such a scanline. The right border takes the mode of the line's last byte (MAME: m_mode[width-1]),
  // and covers anything the bytes drew past the active area. A line whose bytes cover less than the
  // 256 active pixels (a 16-byte run starting at an odd position has one byte fewer than its share)
  // leaves the rest undrawn: MAME's screen bitmap keeps what an earlier frame drew there, which keepTail
  // reproduces (comparisons); otherwise those pixels take the border colour.
  endLine(y, lastMode, pixel, keepTail) {
    const px = this.frame.data, row = y * WIDTH, border = MC6847.borderOf(lastMode);
    if (pixel < 256 && !keepTail) px.fill(border, row + BORDER_X + pixel, row + BORDER_X + 256);
    px.fill(border, row + BORDER_X + 256, row + WIDTH);
    this.finishLine(y);
  }

  // Emit one fetched byte at output offset `o`; returns the new offset.
  emitSample(px, o, modeByte, textLine, ch) {
    const ag = !!(modeByte & 0x80), gm = (modeByte >> 4) & 7, css = !!(modeByte & 0x08);
    if (!ag) {
      // AS and INTEXT are per fetched byte (see charAs/charIntExt): the same test the CoCo makes from the
      // mode byte and the byte's bit 7, and the 200-E's INTEXT = /AS
      const as = this.charAs(ch), intExt = this.charIntExt(ch, modeByte);
      const fg = css ? BRIGHT_ORANGE : GREEN, bg = css ? DARK_ORANGE : DARK_GREEN;
      if (this.t1 && intExt && !as && ch < 0x20) {
        const bits = ~T1_LOWER[ch * 12 + textLine];
        for (let i = 0; i < 8; i++) px[o++] = (bits & (0x80 >> i)) ? fg : bg;
      } else if (as) {
        if (intExt && !this.t1) {
          const c = ((ch >> 6) & 3) | (css ? 4 : 0);
          const b = ch & 0x3F, seg = (textLine / 4) | 0;
          const l = b & (0x20 >> (seg * 2)), r = b & (0x10 >> (seg * 2));
          for (let i = 0; i < 4; i++) px[o++] = l ? c : BLACK;
          for (let i = 0; i < 4; i++) px[o++] = r ? c : BLACK;
        } else {
          const c = (ch >> 4) & 7, seg = textLine < 6 ? 0 : 1;
          const l = ch & (0x08 >> (seg * 2)), r = ch & (0x04 >> (seg * 2));
          for (let i = 0; i < 4; i++) px[o++] = l ? c : BLACK;
          for (let i = 0; i < 4; i++) px[o++] = r ? c : BLACK;
        }
      } else if (intExt && !this.t1) {
        // INTEXT high, AS low: the external generator if one is fitted, else the stripe pattern
        const bits = this.getCharRom ? this.extGlyph(ch, textLine) : stripe(ch);
        for (let i = 0; i < 8; i++) px[o++] = (bits & (0x80 >> i)) ? fg : bg;
      } else {
        const bits = this.glyph(ch, textLine);
        for (let i = 0; i < 8; i++) px[o++] = (bits & (0x80 >> i)) ? fg : bg;
      }
      return o;
    }
    const [, , bpp] = GMODES[gm];
    const perByte = 256 / MC6847.bytesPerLine(modeByte);
    const step = perByte / (8 / bpp);
    const cbase = css ? 4 : 0, on = css ? BUFF : GREEN;
    if (bpp === 2) for (let p = 3; p >= 0; p--) { const c = cbase + ((ch >> (p * 2)) & 3); for (let k = 0; k < step; k++) px[o++] = c; }
    else for (let p = 7; p >= 0; p--) { const c = (ch >> p) & 1 ? on : BLACK; for (let k = 0; k < step; k++) px[o++] = c; }
    return o;
  }

  // A border row (above or below the active area): the whole row in the mode's border colour.
  borderLine(y, modeByte) {
    const row = y * WIDTH;
    this.frame.data.fill(MC6847.borderOf(modeByte), row, row + WIDTH);
  }
}

MC6847.WIDTH = WIDTH; MC6847.HEIGHT = HEIGHT;
MC6847.BORDER_X = BORDER_X; MC6847.BORDER_Y = BORDER_Y;
MC6847.TABLE = TABLE;
MC6847.MIX = MIX;
MC6847.PAL_BLEND = PAL_BLEND;
MC6847.PAL_CODE0 = 40;

export { MC6847 };
