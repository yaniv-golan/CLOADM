/*
 * GIME (TCC1014) for the Tandy Color Computer 3: MMU, registers, interrupts, timer and video.
 * Self-contained chip (registers GIME): it knows nothing about the CPU or the PIAs. The machine
 * owns the time line, calls hsRise()/hsFall() at the right moments and timerExpired() when the
 * time reported through onTimer(timerDue) is reached.
 *
 * Time base: one GIME clock = master crystal / 8 (3.58 MHz NTSC). A scanline is 228 clocks,
 * a slow (0.89 MHz) CPU cycle is 4 clocks and a fast (1.79 MHz) cycle is 2.
 *
 * Frame structure follows MAME's gime/mc6847 model (top border, body, bottom border, retrace,
 * vblank; 262 lines NTSC). Video is recorded one scanline at a time when the line ends (at the
 * next HS rise), so register changes during a frame (palette, mode, border) show on later lines.
 *
 * Output: 640 x 240 pixels (scanlines 1-240 of the field, as MAME shows them). The active area
 * is 512 pixels wide with 64-pixel side borders, or 640 pixels with no side border in the
 * "wide" modes (40/80 columns, 160/320/640 pixels). Each output pixel is half as wide as it is
 * tall: display the buffer at a 4:3 aspect (e.g. 640 x 480).
 */
import { state } from '../util.js';
import { Frame } from '../video/frame.js';
import { artifactLine, mixColours } from './artifacter.js';

const WIDTH = 640, HEIGHT = 240;
const LINE = 228;          // GIME clocks per scanline
const HS_FALL = 212;       // HS falls (and FS changes) this many clocks after HS rises

// interrupt sources ($FF92/$FF93 bits)
const INT_TMR = 0x20, INT_HBORD = 0x10, INT_VBORD = 0x08, INT_EI2 = 0x04, INT_EI1 = 0x02, INT_EI0 = 0x01;
// scanline zones
const Z_TOP = 0, Z_BODY = 1, Z_BOTTOM = 2, Z_RETRACE = 3, Z_VBLANK = 4;

const rgb = (r, g, b) => (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0; // ABGR for little-endian ImageData

// ---- palettes: the 64 GIME colours ----
// RGB monitor: colour bits are R1 G1 B1 R0 G0 B0 (bit 5 .. bit 0); four levels per gun.
const RGB_PALETTE = new Uint32Array(64);
for (let c = 0; c < 64; c++) {
  const lvl = (hi, lo) => (((c >> hi) & 1) * 2 + ((c >> lo) & 1)) * 0x55;
  RGB_PALETTE[c] = rgb(lvl(5, 2), lvl(4, 1), lvl(3, 0));
}
// Composite monitor: MAME's measured composite colours, the table gime.cpp's get_composite_color() holds
// (MAME 0.264, src/mame/trs/gime.cpp; Copyright (c) Nathan Woods, BSD-3-Clause: the notice and conditions are in
// licenses/MAME-gime-BSD-3-Clause.txt, which must stay with these tables), as 0xRRGGBB; and the table it
// switches to while $FF98 bit 5 (BPI, burst phase invert) is set. $FF98 bit 4 (MOCH) shows the composite colours in
// grey: MAME's mc6847.h black_and_white(), (r + g + b) / 3 on each gun.
const COMPOSITE_RGB = [
  0x000000, 0x004c00, 0x004300, 0x0a3100, 0x2f1b00, 0x550100, 0x6c0000, 0x770006,
  0x71004b, 0x5c008b, 0x3b00b8, 0x1100ca, 0x001499, 0x002c62, 0x004011, 0x004b00,
  0x2d2d2d, 0x069800, 0x288f00, 0x537d00, 0x786700, 0xa04c00, 0xb63402, 0xc3224c,
  0xbd1693, 0xa814d5, 0x881cfe, 0x5e2cff, 0x105ee9, 0x0076b2, 0x008b60, 0x009618,
  0x747474, 0x41d714, 0x62cf00, 0x8ebd00, 0xb4a700, 0xdd8c01, 0xf5733a, 0xfe6085,
  0xfd53ce, 0xe950ff, 0xc958ff, 0x9e67ff, 0x4e9aff, 0x36b3f7, 0x26c9a3, 0x2bd558,
  0xfdfdfe, 0x88e85a, 0xa1e03f, 0xbed238, 0xd8c342, 0xf1b161, 0xfea08d, 0xfe95bf,
  0xfd8ef1, 0xef8eff, 0xd895ff, 0xb9a1ff, 0x86c4ff, 0x78d4f2, 0x71e2b6, 0xffffff,
];
const COMPOSITE_RGB_180 = [
  0x000000, 0x5a0e5a, 0x4f0c4f, 0x360f40, 0x0d213c, 0x003334, 0x004141, 0x004943,
  0x005409, 0x005600, 0x114c00, 0x263700, 0x392500, 0x491d00, 0x4f0f3e, 0x590e59,
  0x2d2d2d, 0xb11fb7, 0x9932c1, 0x7248c5, 0x4a5bc2, 0x1a6eba, 0x0077a9, 0x008c62,
  0x009619, 0x039700, 0x238f00, 0x467800, 0x9c4e00, 0xb23c00, 0xb92e59, 0xb6209e,
  0x747474, 0xe852ff, 0xcd60ff, 0xa677ff, 0x7d8aff, 0x4d9eff, 0x32b4ed, 0x29c7a2,
  0x2ad459, 0x39d223, 0x50c11a, 0x72a911, 0xcf831e, 0xf47733, 0xff5f85, 0xfe54d1,
  0xfdfdfc, 0xef8fff, 0xd697ff, 0xb8a4ff, 0x9eb3ff, 0x86c6ff, 0x76d4e7, 0x74ddb3,
  0x77e683, 0x80e170, 0x92d56b, 0xacc466, 0xeaac71, 0xffa385, 0xff95c1, 0xffffff,
];
const fromRgb = (v) => rgb((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF);
const grey = (v) => { const a = Math.floor((((v >> 16) & 0xFF) + ((v >> 8) & 0xFF) + (v & 0xFF)) / 3); return rgb(a, a, a); };
const COMPOSITE_PALETTE = Uint32Array.from(COMPOSITE_RGB, fromRgb);
const COMPOSITE_PALETTE_180 = Uint32Array.from(COMPOSITE_RGB_180, fromRgb);
const COMPOSITE_GREY = Uint32Array.from(COMPOSITE_RGB, grey);
const COMPOSITE_GREY_180 = Uint32Array.from(COMPOSITE_RGB_180, grey);

// ---- fonts (our own glyph designs) ----
// 5x7 capitals, digits and punctuation in MC6847 code order ($00 '@' .. $3F '?'), one hex byte per row.
const CAPS = [
  '0E11010D15150E', '040A11111F1111', '1E09090E09091E', '0E11101010110E',
  '1E09090909091E', '1F10101E10101F', '1F10101E101010', '0F10101311110F',
  '1111111F111111', '0E04040404040E', '0101010111110E', '11121418141211',
  '1010101010101F', '111B1515111111', '11191513111111', '1F11111111111F',
  '1E11111E101010', '0E11111115120D', '1E11111E141211', '0E11100E01110E',
  '1F040404040404', '1111111111110E', '1111110A0A0404', '11111115151B11',
  '11110A040A1111', '11110A04040404', '1F01020408101F', '0E08080808080E',
  '00100804020100', '0E02020202020E', '040E1504040404', '0004081F080400',
  '00000000000000', '04040404040004', '0A0A0A00000000', '0A0A1F0A1F0A0A',
  '040F140E051E04', '18190204081303', '0814140815120D', '04040800000000',
  '02040808080402', '08040202020408', '0004150E150400', '0004041F040400',
  '000000000C0408', '0000001F000000', '00000000000C0C', '00010204081000',
  '0E11131519110E', '040C040404040E', '0E11010E10101F', '0E11010601110E',
  '02060A121F0202', '1F101E0101110E', '0E10101E11110E', '1F010204081010',
  '0E11110E11110E', '0E11110F01010E', '000C0C000C0C00', '000C0C000C0408',
  '02040810080402', '00001F001F0000', '08040201020408', '0E110102040004',
];
// lower case and symbols for ASCII $60-$7F, 8 rows (row 7 = descender)
const LOWER = [
  '0804020000000000', '00000E010F110F00', '10101E1111111E00', '00000E1110110E00',
  '01010F1111110F00', '00000E111F100E00', '0609081C08080800', '00000F11110F010E',
  '1010161911111100', '04000C0404040E00', '020006020202120C', '1010121418141200',
  '0C04040404040E00', '00001A1515151500', '0000161911111100', '00000E1111110E00',
  '00001E11111E1010', '00000F11110F0101', '0000161910101000', '00000F100E011E00',
  '08081C0808090600', '0000111111130D00', '00001111110A0400', '0000111115150A00',
  '0000110A040A1100', '00001111110F010E', '00001F0204081F00', '0204040804040200',
  '0404040004040400', '0804040204040800', '0815020000000000', '0A150A150A150A00',
];
// GIME international characters $00-$1F (hi-res text), same format as LOWER
const INTL = [
  '0E111010110E0408', '0A00111111130D00', '02040E111F100E00', '040A0E010F110F00',
  '0A000E010F110F00', '08040E010F110F00', '04000E010F110F00', '00000E1110110E04',
  '040A0E111F100E00', '0A000E111F100E00', '08040E111F100E00', '0A000C0404040E00',
  '040A000C04040E00', '0C12121C12121C10', '11040A111F111100', '04040A111F111100',
  '02040E1111110E00', '00001A050F140F00', '0F14141E14141700', '040A0E1111110E00',
  '0A000E1111110E00', '00000E1315190E00', '040A001111130D00', '0804111111130D00',
  '0E13151515190E00', '110E111111110E00', '0A11111111110E00', '0E100E110E010E00',
  '0609081C08091E00', '04041F0404001F00', '040A040000000000', '0205040E04041408',
];
const rows = (hex) => { const r = []; for (let i = 0; i < hex.length; i += 2) r.push(parseInt(hex.substr(i, 2), 16)); return r; };
// Hi-res text font: 128 characters x 12 rows, glyph in rows 0-7, pixels in bits 6..2.
const HIRES_FONT = new Uint8Array(128 * 12);
// Compatibility (32-column) font: 96 x 12, glyph from row 1. Codes 0-63 are the MC6847 set,
// 64-95 the lower-case page (ASCII $60-$7F).
const LOWRES_FONT = new Uint8Array(96 * 12);
{
  const put = (font, ch, top, bytes) => bytes.forEach((b, r) => { if (top + r < 12) font[ch * 12 + top + r] = (b << 2) & 0xFF; });
  for (let c = 0; c < 64; c++) put(LOWRES_FONT, c, 1, rows(CAPS[c]));
  for (let c = 0; c < 32; c++) put(LOWRES_FONT, 64 + c, 1, rows(LOWER[c]));
  for (let c = 0; c < 32; c++) put(HIRES_FONT, c, 0, rows(INTL[c]));
  for (let c = 0x20; c < 0x60; c++) put(HIRES_FONT, c, 0, rows(CAPS[c < 0x40 ? c : c - 0x40]));
  put(HIRES_FONT, 0x5E, 0, rows('040A110000000000'));        // ^
  put(HIRES_FONT, 0x5F, 0, rows('0000000000001F00'));        // _
  for (let c = 0; c < 32; c++) put(HIRES_FONT, 0x60 + c, 0, rows(LOWER[c]));
}
// What each hi-res text character code ($00-$7F; the GIME ignores bit 7) is, as readable text, for screen readers.
// $20-$7E are ASCII. $00-$1F are the GIME's international set, given as the Unicode letters the glyphs above draw
// (INTL); $7F, a checkerboard block, is U+2592.
const TEXT_CHARS = Object.freeze([...'ÇüéâäàåçêëèïîßÄÅóæÆôöøûùØÖÜ§£±°ƒ',
  ...Array.from({ length: 0x5F }, (_, i) => String.fromCharCode(0x20 + i)), '\u2592']);
// Semigraphics 4: bit 3 top-left, 2 top-right, 1 bottom-left, 0 bottom-right (rows 0-5 / 6-11)
const SG4_FONT = new Uint8Array(16 * 12);
for (let c = 0; c < 16; c++) for (let r = 0; r < 12; r++) {
  const top = r < 6;
  SG4_FONT[c * 12 + r] = ((c & (top ? 8 : 2)) ? 0xF0 : 0) | ((c & (top ? 4 : 1)) ? 0x0F : 0);
}

// $FF9C -> lines per row in compatibility text mode (as MAME models it; real GIME behaviour unverified)
const COMPAT_TEXT_LPR = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 4, 3, 2, 1, 12];
// $FF98 bits 0-2 -> lines per row in GIME modes (7: the row never ends)
const GIME_LPR = [1, 1, 2, 8, 9, 10, 11, 0x10000];
const HRES_BYTES = [16, 20, 32, 40, 64, 80, 128, 160];
// $FF99 -> characters per row in GIME text modes: bit 4 (H50) and bit 2 select 32, 40, 64 or 80
const textCols = (ff99) => ((ff99 & 0x10) ? ((ff99 & 0x04) ? 80 : 64) : ((ff99 & 0x04) ? 40 : 32));

class GIME {
  // opts: { ram: Uint8Array (128K or 512K), pal: bool, rom: () => 32K Uint8Array, cart: () => Uint8Array|null }
  constructor(opts) {
    this.ram = opts.ram;
    this.ramMask = this.ram.length - 1;
    this.pal = !!opts.pal;
    this.romBytes = opts.rom;
    this.cartBytes = opts.cart || (() => null);
    this.onIrq = null;              // called when the IRQ/FIRQ outputs may have changed
    this.onTimer = null;            // called with the new timerDue whenever the timer restarts
    this.regs = new Uint8Array(16);
    this.mmu = new Uint8Array(16);
    this.palette = new Uint8Array(16);
    // the picture as 6-bit hardware colour codes; the frame's table is the monitor's palette
    this.frame = new Frame(WIDTH, HEIGHT, 4 / 3);
    this.mixKeys = [];              // (see the artifact colours below)
    this.monitor = 'rgb';
    // per-slot read/write views: slots 0-7 = 8K pages of $0000-$FDFF, slot 8 = $FE00-$FEFF
    this.rd = new Array(9); this.wr = new Array(9);
    this.cartPages = [null, null, null, null];   // the cartridge's four 8K pages, built when first mapped
    this.empty = new Uint8Array(0x2000);       // empty cartridge space
    this.sink = new Uint8Array(0x2000);        // writes to ROM land here and are ignored
    // NTSC: 262 lines. PAL: 312, with 25 padding lines at the top and 25 inside the bottom
    // border (our own model of the PAL GIME; MAME's coco3p differs and is not verified).
    this.pad = this.pal ? 25 : 0;
    this.untilRetrace = 25 + 192 + 26 + this.pad * 2;
    this.untilVblank = this.untilRetrace + 6;
    this.fsFall = 25 + 192 + 26 + 1 + this.pad;
    this.lines = this.untilVblank + 13;
    this.linePal = new Uint8Array(16);   // palette registers latched for the line being drawn
    // NTSC artifact colours in the compatibility modes' 256-pixel two-colour mode (as MAME's gime.cpp
    // render_scanline, through the MC6847's artifacter): 0 off, 1 or 2 the phase. The mixes of each background /
    // foreground pair in use get colour codes from 64 up, 14 per pair ([c0, c1, phase] in mixKeys: the pair's
    // colour codes, so the mixes are made again from whichever palette the monitor and $FF98 select, and a
    // snapshot can rebuild them)
    this.artifact = 0;
    this.artBuf = new Uint8Array(256);
    this.powerOn();
  }

  powerOn() {
    this.physical = 0; this.logical = 0; this.zone = Z_TOP;
    this.fs = false; this.fsNext = null;
    this.topBorder = 25 + this.pad; this.body = 192;
    this.legacy = false;
    this.videoPos = 0; this.lineInRow = 0;
    this.reset();
  }

  reset() {
    this.regs.fill(0);
    for (let i = 0; i < 8; i++) this.mmu[i] = this.mmu[i + 8] = 56 + i;
    this.palette.fill(0);
    this.sam = 0;
    this.intValue = 0; this.irq = 0; this.firq = 0;
    this.blink = false;
    this.ff22 = 0; this.ff23 = 0;
    this.timerValue = 0; this.timerDue = Infinity;
    if (this.onTimer) this.onTimer(Infinity);
    this.updateMemory();
    this.notifyIrq();
  }

  // ---------------- MMU ----------------
  get fast() { return (this.sam & 0x1800) !== 0; }   // SAM R1 or R0: 1.79 MHz
  get ty() { return (this.sam & 0x8000) !== 0; }

  updateMemory() { for (let s = 0; s <= 8; s++) this.mapSlot(s); }
  // the cartridge (or its bank) or the ROMs changed: its pages are built again, then the memory map
  cartridgeChanged() { this.cartPages.fill(null); this.updateMemory(); }

  // Registers and video/timer state. Memory-map caches are rebuilt; the frame buffer is redrawn
  // from the next scanline on.
  saveState() { return state.save(this, GIME.STATE); }
  loadState(s) {
    state.load(this, s, GIME.STATE);
    this.updateMemory();
    this.updateTable();
  }
  blockFor(slot) {
    if (!(this.regs[0] & 0x40)) return slot + 56;
    return this.mmu[slot + ((this.regs[1] & 1) ? 8 : 0)];
  }
  mapSlot(s) {
    let slot = s, forceRam = false, block;
    if (s === 8) {           // $FE00-$FEFF: fixed to RAM block $3F when MC3 is set
      slot = 7;
      forceRam = !!(this.regs[0] & 0x08);
      block = forceRam ? 63 : this.blockFor(7);
    } else block = this.blockFor(s);
    let rd, wr;
    if ((block & 0x3F) >= 0x3C && !this.ty && !forceRam) {
      const mode = this.regs[0] & 3;
      if (mode === 3 || (mode < 2 && (block & 0x3F) >= 0x3E)) {
        // cartridge; the 8K page is chosen by the CPU slot, not by the block number (as in MAME)
        const n = (slot & 3) ^ 2;
        if (!this.cartPages[n]) {
          const cart = this.cartBytes();
          if (cart && cart.length) {
            const page = new Uint8Array(0x2000), base = n * 0x2000;
            for (let i = 0; i < 0x2000; i++) page[i] = cart[(base + i) % cart.length];
            this.cartPages[n] = page;
          } else this.cartPages[n] = this.empty;
        }
        rd = this.cartPages[n];
      } else {
        // internal ROM; also chosen by CPU slot
        const p = (slot & 3) * 0x2000;
        rd = this.romBytes().subarray(p, p + 0x2000);
      }
      wr = this.sink;
    } else {
      const base = (block * 0x2000) & this.ramMask;
      rd = wr = this.ram.subarray(base, base + 0x2000);
    }
    this.rd[s] = rd; this.wr[s] = wr;
  }
  // CPU address -> view index and offset helpers for the machine's fast path
  read(a) { const s = a >= 0xFE00 ? 8 : a >> 13; return this.rd[s][(a & 0x1FFF)]; }
  write(a, v) { const s = a >= 0xFE00 ? 8 : a >> 13; this.wr[s][a & 0x1FFF] = v; }
  // CPU address ($0000-$FEFF) -> physical RAM address under the current mapping, or -1 for ROM
  physAddr(a) {
    const s = a >= 0xFE00 ? 8 : a >> 13;
    if (this.wr[s] === this.sink) return -1;
    const block = s === 8 && (this.regs[0] & 0x08) ? 63 : this.blockFor(s === 8 ? 7 : s);
    return ((block * 0x2000) + (a & 0x1FFF)) & this.ramMask;
  }

  // ---------------- interrupts ----------------
  notifyIrq() { if (this.onIrq) this.onIrq(); }
  // $FF90 bit 2 (MC2): the spare chip select, $FF40-$FF5F, is on (MAME gime_device::spare_chip_select_enabled)
  get scsEnabled() { return (this.regs[0] & 0x04) !== 0; }
  get irqOut() { return (this.regs[0] & 0x20) !== 0 && this.irq !== 0; }
  get firqOut() { return (this.regs[0] & 0x10) !== 0 && this.firq !== 0; }
  setIrq(v) { if (v !== this.irq) { this.irq = v; this.notifyIrq(); } }
  setFirq(v) { if (v !== this.firq) { this.firq = v; this.notifyIrq(); } }
  // interrupt inputs latch on a rising edge into the enabled IRQ/FIRQ status
  setInterrupt(bit, level) {
    const old = this.intValue;
    if (level) this.intValue |= bit; else this.intValue &= ~bit;
    if (level && !(old & bit)) {
      if (this.regs[2] & bit) this.setIrq(this.irq | bit);
      if (this.regs[3] & bit) this.setFirq(this.firq | bit);
    }
  }
  pulse(bit) { this.setInterrupt(bit, true); this.setInterrupt(bit, false); }

  // ---------------- timer ----------------
  // now: current time in GIME clocks on the machine's time line
  resetTimer(now) {
    let v = ((this.regs[4] & 0x0F) << 8) | this.regs[5];
    if (v > 0) {
      v += 2;  // the 1986 GIME reloads with the value plus two (MAME's model)
      this.timerDue = now + v * ((this.regs[1] & 0x20) ? 1 : LINE);
    } else this.timerDue = Infinity;
    this.timerValue = v;
    if (this.onTimer) this.onTimer(this.timerDue);
  }
  // the machine calls this when its time line reaches timerDue
  timerExpired() {
    this.resetTimer(this.timerDue);
    this.blink = !this.blink;
    this.pulse(INT_TMR);
  }

  // ---------------- registers ----------------
  // $FF90-$FFBF reads; floating() supplies the undriven data bus bits
  readReg(a, floating) {
    if (a < 0xFFA0) {
      if (a === 0xFF92) { const v = this.irq; this.setIrq(0); return v; }
      if (a === 0xFF93) { const v = this.firq; this.setFirq(0); return v; }
      return floating();   // the other registers are write-only
    }
    if (a < 0xFFB0) return (this.mmu[a & 15] & 0x3F) | (floating() & 0xC0);
    return this.palette[a & 15] | (floating() & 0xC0);
  }
  // $FF90-$FFDF writes. Returns true if the CPU clock rate changed.
  writeReg(a, v, now) {
    if (a < 0xFFA0) {
      const r = a & 15, x = this.regs[r] ^ v;
      this.regs[r] = v;
      switch (r) {
        case 0:
          if (x & 0x4B) this.updateMemory();
          if (x & 0x30) this.notifyIrq();
          break;
        case 8:
          if (x & 0x30) this.updateTable();   // BPI and MOCH choose the composite palette
          break;
        case 1:
          if (x & 0x01) this.updateMemory();
          if (x & 0x20) this.resetTimer(now);
          break;
        case 2: // disabling a source acknowledges it, as reading does
          this.setIrq(this.irq & v);
          if (this.timerValue === 0 && (x & INT_TMR)) this.pulse(INT_TMR);
          break;
        case 3:
          this.setFirq(this.firq & v);
          if (this.timerValue === 0 && (x & INT_TMR)) this.pulse(INT_TMR);
          break;
        case 4: this.resetTimer(now); break;   // writing $FF94 restarts the timer; $FF95 alone does not
        case 9: if (x & 0x60) this.updateGeometry(); break;
        default: break;
      }
      return false;
    }
    if (a < 0xFFB0) {
      this.mmu[a & 15] = v;
      this.mapSlot(a & 7); if ((a & 7) === 7) this.mapSlot(8);
      return false;
    }
    if (a < 0xFFC0) { this.palette[a & 15] = v & 0x3F; return false; }
    // SAM compatibility registers $FFC0-$FFDF: even address clears, odd sets a bit
    const off = a - 0xFFC0, mask = 1 << (off >> 1), old = this.sam;
    if (off & 1) this.sam |= mask; else this.sam &= ~mask;
    const x = old ^ this.sam;
    if (x & 0x8000) this.updateMemory();
    return (x & 0x1800) !== 0;
  }
  // the GIME snoops writes to PIA1 to follow the VDG mode bits ($FF22 data written while $FF23 selects it)
  piaWrite(reg, v) {
    if (reg === 3) this.ff23 = v;
    if (reg === 2 && (this.ff23 & 0x04)) this.ff22 = v;
  }
  // EI0 (cartridge), EI1 (keyboard), EI2 (serial) inputs
  setInput(bit, level) { this.setInterrupt(bit, level); }

  // ---------------- video timing ----------------
  updateGeometry() {
    switch (this.regs[9] & 0x60) {
      case 0x00: this.topBorder = 25; this.body = 192; break;
      case 0x20: this.topBorder = 23; this.body = 200; break;
      case 0x40: this.topBorder = 0xFFFF; this.body = 0xFFFF; break; // "zero/infinite" lines
      default: this.topBorder = 8; this.body = 225; break;
    }
    this.topBorder += this.pad;
  }
  isPadLine(l) { return this.pal && (l < 25 || (l >= 266 && l < 291)); }
  newFrame() {
    const legacy = !!(this.regs[0] & 0x80);
    const changed = legacy !== this.legacy;
    this.legacy = legacy;
    this.videoPos = this.videoBase();
    this.lineInRow = this.regs[12] & 0x0F;
    if (changed) this.updateGeometry();
  }
  videoBase() {
    const r = this.regs;
    if (this.legacy) return ((((this.sam >> 3) & 0x7F) << 9) + (r[14] & 0x3F) * 8 + (r[13] & 0xE0) * 0x800) & this.ramMask;
    return this.nativeVideoBase();
  }
  // the GIME-mode video start: $FF9B bits 0-3, $FF9D, $FF9E (x 8 bytes)
  nativeVideoBase() {
    const r = this.regs;
    return ((r[14] * 8) | (r[13] * 0x800) | ((r[11] & 0x0F) * 0x80000)) & this.ramMask;
  }

  // ---------------- the text screen, for readers ----------------
  // The GIME-mode text screen as the next frame will draw it, from the registers: null when the GIME is not in a
  // GIME text mode (compatibility mode, or HRES set: a bitmap). Reads only: no register, counter or memory changes.
  // It follows recordBody() and drawText() line for line:
  //  * the rows start at the video start ($FF9B/$FF9D/$FF9E) and are `pitch` bytes apart: the characters (and
  //    attribute bytes) of a row, or 256 with $FF9F bit 7 (HVEN);
  //  * a row's cells start ($FF9F & $7F) x 2 bytes in, wrapping within the row's 256 bytes;
  //  * every row is `lpr` scanlines ($FF98 bits 0-2); the body shows topBorder..min(body end, retrace, the picture's
  //    last line) scanlines ($FF99 bits 5-6), so the screen has ceil(lines / lpr) rows, the last perhaps cut short;
  //  * the vertical scroll ($FF9C) is loaded into the line counter at the frame start, but every top-border line
  //    sets the counter to 0 again (hsRise, as MAME 0.264's record_border_scanline), so in this model (and MAME's)
  //    it never moves a GIME-mode text row: the body always starts on line 0 of its first row.
  // Returns { cols, attr, lpr, rows, base, pitch, hoff, hven, chars: [Uint8Array(cols)], attrs: [Uint8Array(cols)]
  // | null }, the character codes as stored (bit 7 included; the font ignores it).
  textScreen() {
    const r = this.regs;
    if ((r[0] & 0x80) || (r[8] & 0x80)) return null;
    const cols = textCols(r[9]), attr = !!(r[9] & 0x01);
    const pitch = (r[15] & 0x80) ? 256 : cols * (attr ? 2 : 1);
    const hoff = (r[15] & 0x7F) * 2, lpr = GIME_LPR[r[8] & 7], base = this.nativeVideoBase();
    const lines = Math.max(0, Math.min(this.topBorder + this.body, this.untilRetrace, HEIGHT + 1 + this.pad) - this.topBorder);
    const rows = Math.ceil(lines / lpr);
    const chars = [], attrs = attr ? [] : null;
    for (let row = 0; row < rows; row++) {
      const at = base + row * pitch, c = new Uint8Array(cols), a = attr ? new Uint8Array(cols) : null;
      for (let i = 0, off = 0; i < cols; i++, off += attr ? 2 : 1) {
        const p = at + ((hoff + off) & 0xFF);
        c[i] = this.mem(p);
        if (a) a[i] = this.mem(p + 1);
      }
      chars.push(c); if (a) attrs.push(a);
    }
    return { cols, attr, lpr, rows, base, pitch, hoff, hven: !!(r[15] & 0x80), chars, attrs };
  }
  // HS rising edge: record the line that just ended and advance the scanline counter.
  // Returns true if HS is seen by the PIA (not on PAL padding lines).
  // Sets this.fsNext to the field sync level due at the HS fall, or null for no change.
  hsRise() {
    switch (this.zone) {
      case Z_TOP: case Z_BOTTOM: this.lineInRow = 0; this.recordBorder(this.physical); break;
      case Z_BODY: this.recordBody(this.physical); break;
      default: break;
    }
    this.physical++; this.logical++;
    if (this.zone === Z_VBLANK && this.logical >= 13) {
      this.physical = 0; this.logical = 0; this.zone = Z_TOP;
      this.newFrame();
    } else if (this.zone < Z_VBLANK && this.physical >= this.untilVblank) {
      this.logical = 0; this.zone = Z_VBLANK;
    } else if (this.zone < Z_RETRACE && this.physical >= this.untilRetrace) {
      this.logical = 0; this.zone = Z_RETRACE;
    } else if (this.zone === Z_TOP && this.logical >= this.topBorder) {
      this.logical = 0; this.zone = Z_BODY;
    } else if (this.zone === Z_BODY && this.logical >= this.body) {
      this.logical = 0; this.zone = Z_BOTTOM;
      this.pulse(INT_VBORD);
    }
    // field sync is high until the end of the bottom border and again from the last retrace line
    const fsWanted = this.physical < this.fsFall || this.physical >= this.untilVblank - 1;
    this.fsNext = fsWanted !== this.fs ? fsWanted : null;
    this.setInterrupt(INT_HBORD, true);
    return !this.isPadLine(this.physical);
  }
  // HS falling edge. Returns true if HS is seen by the PIA. Field sync changes here too (see fsNext).
  hsFall() {
    this.setInterrupt(INT_HBORD, false);
    if (this.fsNext !== null) { this.fs = this.fsNext; }
    return !this.isPadLine(this.physical);
  }

  // ---------------- video recording ----------------
  // monitor: 'rgb' or 'composite' - only the frame's colour table changes
  get monitor() { return this._monitor; }
  set monitor(v) {
    this._monitor = v === 'composite' ? 'composite' : 'rgb';
    this.updateTable();
  }
  // The frame's colour table: the 64 colours of the monitor in use - on composite, the phase-inverted set while
  // $FF98 BPI is set and grey while MOCH is (MAME: update_composite() picks the grey palette, the BPI write
  // reloads the colours) - then the artifact mixes made from them. MAME draws a whole field with the palette in
  // force when it updates the screen; a change here applies to the whole picture too.
  updateTable() {
    const t = this.frame.table, f98 = this.regs[8];
    t.set(this._monitor !== 'composite' ? RGB_PALETTE
      : f98 & 0x20 ? (f98 & 0x10 ? COMPOSITE_GREY_180 : COMPOSITE_PALETTE_180)
        : (f98 & 0x10 ? COMPOSITE_GREY : COMPOSITE_PALETTE));
    this.mixKeys.forEach(([c0, c1, v], i) => t.set(mixColours(v, t[c0], t[c1]), 64 + 14 * i));
  }
  colour(c) { return c & 0x3F; }
  resolvePalette() {
    for (let i = 0; i < 16; i++) this.linePal[i] = this.palette[i] & 0x3F;
    return this.linePal;
  }
  borderColour() {
    if (!this.legacy) return this.regs[10] & 0x3F;
    const m = this.ff22;
    if (m & 0x80) return (m & 0x08) ? 0x3F : 0x12;     // graphics: white or green
    if (m & 0x40) return (m & 0x08) ? 0x26 : 0x12;     // text with GM2: orange or green
    return 0;
  }
  outRow(physical) { return physical - 1 - this.pad; }
  recordBorder(physical) {
    const y = this.outRow(physical);
    if (y < 0 || y >= HEIGHT) return;
    this.frame.data.fill(this.colour(this.borderColour()), y * WIDTH, (y + 1) * WIDTH);
  }
  mem(a) { return this.ram[a & this.ramMask]; }

  recordBody(physical) {
    const y = this.outRow(physical);
    const draw = y >= 0 && y < HEIGHT;
    const px = this.frame.data, o = y * WIDTH;
    const pal = this.resolvePalette();
    const border = this.colour(this.borderColour());
    const r = this.regs;
    let pitch, lpr;
    if (this.legacy) {
      const m = this.ff22, ag = !!(m & 0x80), gm = (m >> 4) & 7;
      pitch = ag && (gm === 0 || gm === 1 || gm === 3 || gm === 5) ? 16 : 32;
      if (draw) {
        px.fill(border, o, o + 64); px.fill(border, o + 576, o + WIDTH);
        this.drawLegacy(px, o + 64, pal, pitch);
        if (this.artifact && ag && gm === 7) this.artifactLegacy(px, o + 64, pal, !!(m & 0x08));
      }
      if (!ag) lpr = COMPAT_TEXT_LPR[r[12] & 0x0F];
      else { const v = this.sam & 7; lpr = v === 0 ? 12 : v === 2 ? 3 : (v === 4 || v === 3) ? 2 : 1; }
    } else {
      const ff98 = r[8], ff99 = r[9];
      const wide = !!(ff99 & 0x04);
      const x0 = wide ? 0 : 64, width = wide ? 640 : 512;
      if (draw && !wide) { px.fill(border, o, o + 64); px.fill(border, o + 576, o + WIDTH); }
      if (ff98 & 0x80) {
        const bytes = HRES_BYTES[(ff99 >> 2) & 7];
        pitch = bytes;
        if (draw) this.drawGraphics(px, o + x0, pal, bytes, width, ff99 & 3);
      } else {
        const cols = textCols(ff99);
        const attr = !!(ff99 & 0x01);
        pitch = cols * (attr ? 2 : 1);
        if (draw) this.drawText(px, o + x0, pal, cols, attr, width / (cols * 8), ff98 & 7);
      }
      if (r[15] & 0x80) pitch = 256;        // horizontal virtual screen
      lpr = GIME_LPR[ff98 & 7];
    }
    if (++this.lineInRow >= lpr) {
      this.lineInRow = 0;
      this.videoPos = (this.videoPos + pitch) & this.ramMask;
    }
  }

  // NTSC artifact colours over a drawn compatibility-mode line in the 256-pixel two-colour mode (two output
  // pixels per pixel; the window reaches into the borders), between the line's background and foreground,
  // palette entries 8 and 9 (CSS 0) or 10 and 11 (CSS 1), compared by colour as MAME compares them.
  artifactLegacy(px, o, pal, css) {
    const t = this.frame.table, c0 = pal[css ? 10 : 8], c1 = pal[css ? 11 : 9], lit = t[c1];
    const base = this.mixCodes(c0, c1) - 1, line = this.artBuf;
    artifactLine((x) => t[px[o + x * 2]] === lit, line);
    for (let x = 0; x < 256; x++) {
      const n = line[x], c = n === 0 ? c0 : n === 15 ? c1 : base + n;
      px[o + x * 2] = c; px[o + x * 2 + 1] = c;
    }
  }
  // the first of the 14 colour codes holding the mixes of colour codes c0 and c1
  mixCodes(c0, c1) {
    let i = this.mixKeys.findIndex(([a, b, v]) => a === c0 && b === c1 && v === this.artifact);
    if (i < 0) {
      if (this.mixKeys.length === 13) this.mixKeys.length = 0;   // codes 64-245 in use: start again
      i = this.mixKeys.push([c0, c1, this.artifact]) - 1;
      const t = this.frame.table;
      t.set(mixColours(this.artifact, t[c0], t[c1]), 64 + 14 * i);
    }
    return 64 + 14 * i;
  }

  drawLegacy(px, o, pal, bytes) {
    const m = this.ff22, base = this.videoPos, row = this.lineInRow % 12;
    if (m & 0x80) {
      const gm = (m >> 4) & 7, css = !!(m & 0x08);
      // [bits per pixel, output pixels per data pixel]
      const [bpp, scale] = gm === 0 ? [2, 8] : (gm === 1 || gm === 3 || gm === 5) ? [1, 4] : gm === 7 ? [1, 2] : [2, 4];
      const cbase = bpp === 2 ? (css ? 4 : 0) : (css ? 10 : 8), mask = (1 << bpp) - 1;
      for (let i = 0; i < bytes; i++) {
        const v = this.mem(base + i);
        for (let p = 8 - bpp; p >= 0; p -= bpp) {
          const c = pal[cbase + ((v >> p) & mask)];
          for (let k = 0; k < scale; k++) px[o++] = c;
        }
      }
      return;
    }
    // text: the GIME behaves like an MC6847T1 (no SG6; GM0 selects lower case, GM1 inverts)
    const css = !!(m & 0x08), gm0 = !!(m & 0x10), gm1 = !!(m & 0x20);
    const bg = pal[css ? 14 : 12], fg = pal[css ? 15 : 13];
    for (let i = 0; i < 32; i++) {
      const ch = this.mem(base + i);
      let bits, c0, c1;
      if (ch & 0x80) {
        bits = SG4_FONT[(ch & 0x0F) * 12 + row];
        c0 = pal[8]; c1 = pal[(ch >> 4) & 7];
      } else {
        const inv = (ch & 0x40) !== 0, code = ch & 0x3F;
        if (gm0 && !inv && code < 32) bits = LOWRES_FONT[(64 + code) * 12 + row] ^ 0xFF;
        else bits = LOWRES_FONT[code * 12 + row];
        if (inv !== gm1) bits ^= 0xFF;
        c0 = bg; c1 = fg;
      }
      for (let j = 0; j < 8; j++) { const c = (bits & (0x80 >> j)) ? c1 : c0; px[o++] = c; px[o++] = c; }
    }
  }

  drawGraphics(px, o, pal, bytes, width, cres) {
    let bpp = cres === 0 ? 1 : cres === 1 ? 2 : 4;
    while (bytes * (8 / bpp) > width) bpp *= 2;   // 128/160-byte rows fetch more bits per pixel
    const ppb = 8 / bpp, scale = width / (bytes * ppb), mask = (1 << bpp) - 1;
    const base = this.videoPos, hoff = (this.regs[15] & 0x7F) * 2;
    for (let i = 0; i < bytes; i++) {
      const v = this.mem(base + ((hoff + i) & 0xFF));   // a row wraps within 256 bytes
      for (let p = 8 - bpp; p >= 0; p -= bpp) {
        const c = pal[(v >> p) & mask];
        for (let k = 0; k < scale; k++) px[o++] = c;
      }
    }
  }

  drawText(px, o, pal, cols, attr, scale, lprBits) {
    const base = this.videoPos, hoff = (this.regs[15] & 0x7F) * 2, row = this.lineInRow;
    // the underline row depends on the lines-per-row setting
    const ul = lprBits === 3 ? 7 : (lprBits === 4 || lprBits === 5) ? 8 : lprBits === 6 ? 9 : -1;
    let off = 0;
    for (let i = 0; i < cols; i++) {
      const a = base + ((hoff + off) & 0xFF);
      let ch = this.mem(a), fg = pal[1], bg = pal[0], under = false;
      if (attr) {
        let at = this.mem(a + 1);
        if ((at & 0x80) && this.blink) { ch = 0x20; at &= ~0x40; }   // blink: blank on alternate timer periods
        fg = pal[8 + ((at >> 3) & 7)]; bg = pal[at & 7];
        under = (at & 0x40) !== 0 && row === ul;
        off += 2;
      } else off += 1;
      const bits = under ? 0xFF : (row < 12 ? HIRES_FONT[(ch & 0x7F) * 12 + row] : 0);
      for (let j = 0; j < 8; j++) {
        const c = (bits & (0x80 >> j)) ? fg : bg;
        for (let k = 0; k < scale; k++) px[o++] = c;
      }
    }
  }
}

GIME.WIDTH = WIDTH; GIME.HEIGHT = HEIGHT; GIME.LINE = LINE; GIME.HS_FALL = HS_FALL;
GIME.RGB_PALETTE = RGB_PALETTE; GIME.COMPOSITE_PALETTE = COMPOSITE_PALETTE; GIME.COMPOSITE_PALETTE_180 = COMPOSITE_PALETTE_180;
GIME.HIRES_FONT = HIRES_FONT; GIME.LOWRES_FONT = LOWRES_FONT; GIME.TEXT_CHARS = TEXT_CHARS;
GIME.INT = { TMR: INT_TMR, HBORD: INT_HBORD, VBORD: INT_VBORD, EI2: INT_EI2, EI1: INT_EI1, EI0: INT_EI0 };
GIME.STATE = ['regs', 'mmu', 'palette', 'linePal', 'sam', 'zone', 'logical', 'physical', 'topBorder', 'body', 'lineInRow', 'mixKeys',
  'videoPos', 'timerDue', 'timerValue', 'legacy', 'irq', 'firq', 'intValue', 'fs', 'fsNext', 'fsFall', 'ff22', 'ff23', 'blink',
  'untilVblank', 'untilRetrace'];

export { GIME };
