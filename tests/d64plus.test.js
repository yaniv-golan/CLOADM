// Run: node tests/d64plus.test.js
// The Dragon 64 Plus: its profile, the two RAM banks and the video-RAM overlay of
// MAME's d64plus_state, its CRTC ports, and the 80-column picture.
//
// The expected values are worked out here from MAME's driver (src/mame/trs/dragon.cpp, 0.264:
// d64plus_bank_w, d64plus_6845_disp_r, crtc_update_row and machine_start's two memory_bank_creators),
// from the HD6845S data sheet (the register set, the 8x12 cell and the start-address walk) and from
// MAME's own monitor geometry (d64plus: set_raw(14.218_MHz_XTAL, 912, 0, 640, 316, 0, 264) - 114
// characters a line and 316 lines a frame), never by running the code under test. The pixel comparison
// with MAME is tools/mame-diff/d64plus/run-video.js.
const Emu = require('./load')();
const { D64PlusMachine, PLUS_WIDTH, PLUS_HEIGHT } = require('../js/machines/d64plus.js');

let fail = 0;
const check = (n, c, d = '') => { if (!c) { fail++; console.log('FAIL', n, d); } else console.log('ok  ', n, d); };

// a machine with our own images in every socket (never a real ROM)
const fake = (size, seed) => { const b = new Uint8Array(size); for (let i = 0; i < size; i++) b[i] = (i * 31 + seed) & 0xFF; return b; };
const charger = () => { const b = new Uint8Array(0x2000); for (let i = 0; i < b.length; i++) b[i] = i & 0xFF; return b; };
const machine = (roms = true) => {
  const m = Emu.createMachine('d64plus');
  if (roms) m.setRoms({ basic: fake(0x4000, 1), basic64: fake(0x4000, 2), chargen: charger(), prom: fake(0x200, 3) });
  m.reset(true);
  return m;
};

// ---- the profile ----
{
  const p = Emu.profiles.d64plus;
  check('d64plus is a profile of its own family', !!p && p.family === 'd64plus', p && p.family);
  check('it names MAME\'s driver d64plus', p.mame === 'd64plus');
  check('it is a Dragon: PAL, the Dragon keyboard, 64K, the ACIA and the ROM-bank select',
    p.video === 'pal' && p.keyboard === 'dragon' && p.options.ram.values.join() === '64' && p.acia === true && p.bankSelect === true);
  const bus = p.roms.filter((s) => !s.chip);
  check('two 16K BASIC sockets, as the Dragon 64', bus.length === 2 && bus.every((s) => s.size === 0x4000) && bus[1].bank === 1);
  const chips = p.roms.filter((s) => s.chip);
  check('two chips it reads directly: the 8K character generator and the 512-byte timing PROM',
    chips.length === 2 && chips.some((s) => s.id === 'chargen' && s.size === 0x2000 && s.files.includes('chargen.ic22'))
    && chips.some((s) => s.id === 'prom' && s.size === 0x200 && s.files.includes('n82s147an.ic12')));
  check('the character generator is required, the PROM is not (MAME loads it and never reads it)',
    p.roms.find((s) => s.id === 'chargen').required === true && p.roms.find((s) => s.id === 'prom').required === false);
  check('the known-good CRCs are MAME\'s ROM_START(d64plus)',
    p.roms.find((s) => s.id === 'basic').crcs[0] === '60A4634C' && p.roms.find((s) => s.id === 'basic64').crcs[0] === '17893A42'
    && p.roms.find((s) => s.id === 'chargen').crcs[0] === '514F1450' && p.roms.find((s) => s.id === 'prom').crcs[0] === '92B6728D');
  check('it offers no options the Dragon 64 does not', JSON.stringify(Object.keys(p.options)) === JSON.stringify(['cpu', 'ram']));
}

// ---- the two screens ----
{
  const m = machine();
  check('the default view is the Dragon\'s own VDG picture', m.view === 'vdg' && m.render().width === Emu.MC6847.WIDTH);
  m.view = 'plus';
  check('the plus screen is MAME\'s 640 x 264', m.render().width === 640 && m.render().height === 264 && PLUS_WIDTH === 640 && PLUS_HEIGHT === 264);
  // MAME's plus_screen: SCREEN(config, "plus_screen") with the CRTC's set_raw inside; the register set the
  // firmware programs (114 characters, 26 rows of 12 + 4 adjust) is 316 lines of 114 characters
  for (const [r, v] of [[0, 113], [4, 25], [5, 4], [9, 11]]) { m.write(0xFFE0, r); m.write(0xFFE1, v); }
  check('the CRTC\'s frame is 316 lines of 114 characters at 14.218 MHz / 8 (MAME\'s plus_screen geometry)',
    m.crtc.frameLines === 316 && m.crtc.horizTotal === 114, `${m.crtc.frameLines} x ${m.crtc.horizTotal}`);
}

// ---- the bank register ($FFE2), MAME's d64plus_bank_w ----
// bits 1-2: 0 standard, 2 bank A, 6 bank B; any other value leaves the banks alone (MAME logs an error).
// bit 0: the video RAM overlay appears; the switch above has already re-selected, so a write that clears
// bit 0 puts the window back on the selected bank.
{
  const m = machine();
  const sel = () => [m.pramBank, m.vramBank];
  m.write(0xFFE2, 0x00); check('0: the standard RAM, no overlay', sel().join() === '0,0', sel().join());
  m.write(0xFFE2, 0x02); check('2: bank A', sel().join() === '1,1', sel().join());
  m.write(0xFFE2, 0x06); check('6: bank B', sel().join() === '2,2', sel().join());
  m.write(0xFFE2, 0x01); check('1: bit 0 also overlays the video RAM on the standard bank', sel().join() === '0,3', sel().join());
  m.write(0xFFE2, 0x07); check('7: bank B and the overlay', sel().join() === '2,3', sel().join());
  m.write(0xFFE2, 0x03); check('3: bank A and the overlay', sel().join() === '1,3', sel().join());
  m.write(0xFFE2, 0x04); check('4 (R2 R1 = 10): the motherboard RAM, as $00 (Harvey-Smith schematic: bit 2 only XORs Z7)', sel().join() === '0,0', sel().join());
  m.write(0xFFE2, 0x07); m.write(0xFFE2, 0x05); check('5: the motherboard RAM and the overlay, even after bank B', sel().join() === '0,3', sel().join());
  m.write(0xFFE2, 0x00); check('0 again: the overlay goes back', sel().join() === '0,0', sel().join());
}
// config.mameCompat keeps MAME's d64plus_bank_w(): bits 2-1 = 10 logs an error and leaves both banks alone
{
  const m = Emu.createMachine('d64plus', { mameCompat: true });
  m.reset(true);
  const sel = () => [m.pramBank, m.vramBank];
  m.write(0xFFE2, 0x03); m.write(0xFFE2, 0x04);
  check('mameCompat: 4 after 3 leaves both banks as they were (MAME)', sel().join() === '1,3', sel().join());
  m.write(0xFFE2, 0x06); m.write(0xFFE2, 0x05);
  check('mameCompat: 5 after 6 keeps bank B and adds the overlay (MAME)', sel().join() === '2,3', sel().join());
}

// ---- what the CPU reads under each $FFE2 value, from the source RAM it should come from ----
// P. Harvey-Smith's traced Eagle schematic of his DragonPlus board (World of Dragon forum, 7 June 2017; known drawing errors; not verified on hardware):
// bit 1 selects the extra DRAM, bit 2 picks A or B; bit 0 the video RAM over $0000-$07FF. Compusense p. 2 gives $00, $02, $06 and R0.
// Each source holds its own byte, so a read says which RAM it came from. The table is written out here, not derived.
{
  const SRC = { mb: 0x11, A: 0x22, B: 0x33, V: 0x44 };
  //            $FFE2: [$0100, $1000]
  const TABLE = { 0: ['mb', 'mb'], 1: ['V', 'mb'], 2: ['A', 'A'], 3: ['V', 'A'], 4: ['mb', 'mb'], 5: ['V', 'mb'], 6: ['B', 'B'], 7: ['V', 'B'] };
  for (const before of [0x00, 0x02, 0x06, 0x07]) {
    for (let v = 0; v < 8; v++) {
      const m = machine();
      for (const a of [0x0100, 0x1000]) { m.ram[a] = SRC.mb; m.plusRam[a] = SRC.A; m.plusRam[0x8000 + a] = SRC.B; }
      m.videoRam[0x100] = SRC.V;
      m.write(0xFFE2, before); m.write(0xFFE2, v);
      const got = [m.read(0x0100), m.read(0x1000)], want = TABLE[v].map((k) => SRC[k]);
      check(`$FFE2 = $0${v} after $0${before}: $0100 from ${TABLE[v][0]}, $1000 from ${TABLE[v][1]}`, got.join() === want.join(), got.map((x) => x.toString(16)).join());
    }
  }
  // a write under $04 lands in the motherboard RAM, not in the bank selected before
  const m = machine();
  m.write(0xFFE2, 0x02); m.write(0xFFE2, 0x04); m.write(0x2000, 0x99);
  check('a write under $04 (after bank A) lands in the motherboard RAM', m.ram[0x2000] === 0x99 && m.plusRam[0x2000] !== 0x99);
}

// ---- the MC6847 always fetches the motherboard RAM ----
// P. Harvey-Smith's traced Eagle schematic of his DragonPlus board (World of Dragon forum, 7 June 2017; known drawing errors; not verified on hardware):
// the VDG reads in E = 0 straight from the motherboard RAM. Our own firmware (an idle loop) keeps the VDG in text mode on $0000
// (SAM F = 0); the motherboard holds pattern P there and banks A, B and the video RAM hold Q. Under every $FFE2 value
// the picture must be the one a machine with P alone draws, and never the one Q draws.
{
  const fw = Emu.assemble(`        ORG     $8000
RESET   ORCC    #$50
        STA     $FFDD
        CLR     $FF23
        LDA     #$F8
        STA     $FF22
        LDA     #$34
        STA     $FF23
        CLR     $FF22
IDLE    BRA     IDLE
        ORG     $BFFE
        FDB     RESET`);
  const img = new Uint8Array(0x4000).fill(0x12);
  for (const sg of fw.segments) img.set(sg.data, sg.addr - 0x8000);
  const P = (a) => (a * 7 + 1) & 0xFF, Q = (a) => (a * 13 + 0x40) & 0xFF;
  const picture = (fill, v, compat = false) => {
    const m = Emu.createMachine('d64plus', { mameCompat: compat });
    m.setRoms({ basic: img, basic64: img, chargen: charger(), prom: fake(0x200, 3) });
    m.reset(true);
    fill(m);
    m.write(0xFFE2, v);
    for (let f = 0; f < 3; f++) m.runFrame();
    return Array.from(m.render().data).join();
  };
  const mbOnly = (src) => (m) => { for (let a = 0; a < 0x800; a++) m.ram[a] = src(a); };
  const both = (m) => {
    for (let a = 0; a < 0x800; a++) { m.ram[a] = P(a); m.plusRam[a] = Q(a); m.plusRam[0x8000 + a] = Q(a); m.videoRam[a] = Q(a); }
  };
  const want = picture(mbOnly(P), 0), notWant = picture(mbOnly(Q), 0);
  check('the two patterns draw different pictures (the test can tell them apart)', want !== notWant);
  for (let v = 0; v < 8; v++) {
    const got = picture(both, v);
    check(`$FFE2 = $0${v}: the VDG draws the motherboard RAM's bytes`, got === want && got !== notWant);
  }
  check('mameCompat: the VDG draws the motherboard RAM too (MAME 0.264 never applies $FFE2)', picture(both, 0x03, true) === want);
}

// ---- paging.asm, the lockstep firmware, on our machine without mameCompat ----
// RESULTS: the CPU's reads after $02 -> $04, $06 -> $04, $07 -> $05 and $03 -> $04 (the bytes paging.asm put in the
// motherboard RAM: $0100 = $03, $0101 = $04, $01FF = $02, $1000 = $5A, $1001 = $77)
{
  const t = require('../tools/mame-diff/d64plus/spec').paging('d64plus');
  const m = t.machine(), halt2 = t.asm.symbols.get('HALT2');
  for (let f = 0; f < 600 && m.cpu.pc !== halt2; f++) m.runFrame();
  const got = Array.from(m.ram.subarray(0x3F10, 0x3F18));
  check('paging.asm reaches its HALT loop', m.cpu.pc === halt2 && m.ram[0] === 0x01);
  check('paging.asm: every read under $04 / $05 came from the motherboard RAM', got.join() === [0x03, 0x5A, 0x77, 0x04, 0x5A, 0x77, 0x03, 0x02].join(),
    got.map((x) => x.toString(16)).join(' '));
  check('paging.asm: no byte reached bank A, bank B or the video RAM', m.plusRam.every((x) => x === 0) && m.videoRam.every((x) => x === 0));
}

// ---- the banks at the bus ----
// Each 32K bank holds the whole $0000-$7FFF, because the SAM drives A14; the video bank maps only
// $0000-$07FF and the 32K bank serves the rest (MAME installs both as handlers over the same map).
{
  const m = machine();
  m.write(0xFFE2, 0x00); m.ram[0x0100] = 0x11; m.write(0xFFE2, 0x02); m.write(0x0100, 0x22); m.write(0xFFE2, 0x06); m.write(0x0100, 0x33);
  m.write(0xFFE2, 0x00);
  check('the standard bank keeps its own $0100', m.read(0x0100) === 0x11, m.read(0x0100).toString(16));
  m.write(0xFFE2, 0x02); check('bank A keeps its own', m.read(0x0100) === 0x22, m.read(0x0100).toString(16));
  m.write(0xFFE2, 0x06); check('bank B keeps its own', m.read(0x0100) === 0x33, m.read(0x0100).toString(16));
  m.write(0xFFE2, 0x00);
  // the video overlay covers $0000-$07FF and only that
  m.write(0xFFE2, 0x01);
  m.write(0x0000, 0xAA); m.write(0x07FF, 0xBB);
  check('the overlay holds what was written to $0000-$07FF', m.videoRam[0] === 0xAA && m.videoRam[0x7FF] === 0xBB);
  check('... and the standard RAM underneath was not touched', m.ram[0] !== 0xAA);
  check('$0800 is not in the overlay, so the 32K bank serves it', m.read(0x0800) === m.ram[0x0800]);
  m.write(0xFFE2, 0x00);
  check('switching the overlay off reveals the standard bank\'s own $0000 again', m.read(0x0000) === m.ram[0]);
  // the video RAM is 2K and the overlay maps only $0000-$07FF (MAME's m_vram_bank covers 0x0000-0x07ff;
  // above it the 32K bank serves), so a 2K mirror is not visible at the bus - $0800 is the standard RAM
  m.write(0xFFE2, 0x01); m.write(0x0000, 0x5A);
  check('the overlay covers $0000-$07FF only: $0800 is the 32K bank\'s', m.read(0x0800) === m.ram[0x0800] && m.videoRam.length === 0x800,
    m.read(0x0800).toString(16));
}

// ---- the CRTC ports ----
{
  const m = machine();
  // $FFE0 is the address latch; $FFE1 the data. R0 = 113 is 114 characters.
  m.write(0xFFE0, 0); m.write(0xFFE1, 113);
  check('$FFE0/$FFE1 program the CRTC registers', m.crtc.reg[0] === 113 && m.crtc.horizTotal === 114);
  m.write(0xFFE0, 12); m.write(0xFFE1, 0x01); m.write(0xFFE0, 13); m.write(0xFFE1, 0x00);
  m.write(0xFFE0, 12);
  check('the HD6845S reads R12/R13 back (the MC6845 cannot)', m.read(0xFFE1) === 0x01);
  check('$FFE0 reads the status register, which the HD6845S does not have (0)', m.read(0xFFE0) === 0);
  check('$FFE2 reads $FF while display enable is on and $FE while blanking',
    (m.crtc.de = true, m.read(0xFFE2) === 0xFF) && (m.crtc.de = false, m.read(0xFFE2) === 0xFE));
}

// ---- the 80-column picture, from the data sheet and MAME's crtc_update_row ----
// A cell is character code c at raster line ra: generator[(c << 4) | (ra & 0x0F)] & 0xFFF (MAME masks the
// address to 4K), drawn 8 pixels wide from bit 7, 12 lines tall (R9 = 11). The cursor column is forced to
// $FF. MA starts at R12/R13 and advances by R1 per character row.
{
  const m = machine();
  // A generator in which every byte identifies its own address: byte a holds a. So the lit pixels of a
  // cell say exactly which generator address was fetched.
  const gen = new Uint8Array(0x2000);
  for (let a = 0; a < gen.length; a++) gen[a] = a & 0xFF;
  m.setRoms({ basic: fake(0x4000, 1), basic64: fake(0x4000, 2), chargen: gen, prom: fake(0x200, 3) });
  m.reset(true);
  // MAME's plus_screen geometry: 114 characters (R0), 80 displayed (R1), HS at 96 (R2), $0F (R3), 26 rows
  // (R4), 4 adjust lines (R5), 22 displayed rows (R6), VS at row 24 (R7), 12 raster lines (R9), start 0
  for (const [r, v] of [[0, 113], [1, 80], [2, 96], [3, 0x0F], [4, 25], [5, 4], [6, 22], [7, 24], [8, 0], [9, 11], [10, 0], [11, 11], [12, 0], [13, 0], [14, 0], [15, 0]]) {
    m.write(0xFFE0, r); m.write(0xFFE1, v);
  }
  m.write(0xFFE2, 0x01);           // the video RAM overlay
  m.videoRam[0] = 0x21;            // row 0, column 0
  m.drawPlus();
  const px = m.plusFrame.data;
  const lit = (x, y) => px[y * 640 + x];
  const bits = (y, col = 0) => [...Array(8)].map((_, i) => lit(col * 8 + i, y) ? 1 : 0).join('');
  // row 0, raster 0: address ($21 << 4) | 0 = $210, byte $10 = 0001 0000
  check('a cell is generator[(code << 4) | ra], drawn from bit 7', bits(0) === '00010000', bits(0));
  // raster 1: address $211, byte $11 = 0001 0001
  check('the next raster line fetches the next byte', bits(1) === '00010001', bits(1));
  // raster 11 is the last of the row (R9 = 11): $21B = 0001 1011; row 1 raster 0 is MA $50, code $00
  check('a row is 12 raster lines, and the next row begins R1 characters on',
    bits(11) === '00011011' && bits(12) === '00000000', `${bits(11)} then ${bits(12)}`);
  check('the picture is 640 x 264: 22 rows of 12 lines', px.length === 640 * 264);
  // MAME reads an 8K region but masks the address to 4K (crtc_update_row: base()[addr & 0xfff]), so only
  // the first 4K - 256 characters x 16 bytes - is ever fetched. Put a different byte in the second 4K at
  // the address a cell would use and check it never shows: byte $210 is the one read, $1210 is not.
  m.videoRam[0] = 0x21;
  gen[0x1210] = 0xFF;              // all lit, in the second 4K
  gen[0x210] = 0x00;               // dark, in the first
  m.drawPlus();
  check('only the generator\'s first 4K is read (address & 0xFFF): the second 4K never shows',
    bits(0) === '00000000', bits(0));
  gen[0x210] = 0x10;
  m.drawPlus();
  check('... and the first 4K is read as it stands', bits(0) === '00010000', bits(0));
  // the cursor column is forced to $FF (crtc_update_row: if (column == cursor_x) data = 0xff)
  m.videoRam[0] = 0x21;
  m.write(0xFFE0, 14); m.write(0xFFE1, 0); m.write(0xFFE0, 15); m.write(0xFFE1, 3);   // cursor at MA 3
  m.write(0xFFE0, 10); m.write(0xFFE1, 0); m.write(0xFFE0, 11); m.write(0xFFE1, 11);  // rasters 0..11, on
  m.crtc.cursorState = true;
  m.drawPlus();
  check('the cursor column is all lit on every raster line of its row',
    bits(0, 3) === '11111111' && bits(5, 3) === '11111111', `${bits(0, 3)} ${bits(5, 3)}`);
  // (columns 2 and 4 hold code $00 - video RAM is 0 there - so generator[$000] = $00: dark)
  check('the cells beside it keep their own glyphs',
    bits(0, 2) === '00000000' && bits(0, 4) === '00000000', `${bits(0, 2)} ${bits(0, 4)}`);
  // MA starts at R12/R13: with $50 at R13, row 0 column 0 is the code at MA $50
  m.write(0xFFE0, 12); m.write(0xFFE1, 0); m.write(0xFFE0, 13); m.write(0xFFE1, 0x50);
  m.videoRam[0x50] = 0xA5;         // generator[$A50] = $50 = 0101 0000
  m.crtc.cursorState = false;
  m.drawPlus();
  check('MA starts at R12/R13: row 0 reads from MA $50, not from $00', bits(0) === '01010000', bits(0));
}

// ---- the primary source: Compusense, "Dragonplus Interface Technical Information" ----
// The board's own technical notes ((c) Compusense Ltd; archived at archive.worldofdragon.org,
// downloads/Software/Dragon/Compusense Ltd/Dragon Plus/DragonPlusTech.pdf). Expected values are read off its
// tables here, not from MAME:
//   p. 1: two 32K dynamic banks (A, B) and the 2K static video RAM (C) over the low addresses; C "can overlay
//         any other bank ... without losing the remainder of the dynamic bank";
//   p. 2: $FFE2 write: R2 R1 = 00 standard, 01 bank A, 11 bank B; R0 = 1 the video RAM (bank C);
//   p. 3: $FFE2 read bit 0: 1 "Video display busy i.e. not blanking", 0 "available, ie blanking";
//   p. 4: the example 6845 table, R9 = 10, and "only the first character set is used".
{
  const m = machine();
  // p. 2: each documented value, a different byte at $1000 in each 32K bank, then read back
  for (const [v, b] of [[0x00, 0x11], [0x02, 0x22], [0x06, 0x33]]) { m.write(0xFFE2, v); m.write(0x1000, b); }
  const at = (v) => { m.write(0xFFE2, v); return m.read(0x1000); };
  check('Compusense p. 2: $00, $02 and $06 select three separate 32K banks at $0000-$7FFF',
    at(0x00) === 0x11 && at(0x02) === 0x22 && at(0x06) === 0x33, [0, 2, 6].map((v) => at(v).toString(16)).join());
  // p. 1-2: R0 = 1 adds the video RAM at $0000-$07FF and keeps the rest of the selected bank
  m.write(0xFFE2, 0x00); m.write(0x0010, 0x77);   // the standard bank's own $0010
  m.write(0xFFE2, 0x01); m.write(0x0010, 0x5A);
  check('Compusense p. 1-2: $01 overlays the video RAM ($0010 written there) and keeps the standard bank above it',
    m.read(0x0010) === 0x5A && m.read(0x1000) === 0x11);
  m.write(0xFFE2, 0x03);
  check('$03: the same video RAM, over bank A', m.read(0x0010) === 0x5A && m.read(0x1000) === 0x22);
  m.write(0xFFE2, 0x07);
  check('$07: the same video RAM, over bank B', m.read(0x0010) === 0x5A && m.read(0x1000) === 0x33);
  m.write(0xFFE2, 0x00);
  check('$00 again: the video RAM goes and the standard bank\'s own $0010 is back', m.read(0x0010) === 0x77 && m.videoRam[0x10] === 0x5A);
  // p. 3: bit 0 is 1 while the display is on (not blanking) and 0 while it blanks; sample a whole frame with
  // p. 4's register table programmed
  for (const [r, v] of [[0, 112], [1, 80], [2, 93], [3, 55], [4, 25], [5, 30], [6, 24], [7, 25], [8, 0xA2], [9, 10], [10, 96], [11, 10], [12, 0], [13, 0], [14, 0], [15, 0]]) {
    m.write(0xFFE0, r); m.write(0xFFE1, v);
  }
  let busy = 0, blank = 0, agree = true;
  for (let i = 0; i < 4000; i++) {
    m.runCycles(m.cycle + 7);
    const v = m.read(0xFFE2);
    if (v & 1) busy++; else blank++;
    if (((v & 1) === 1) !== !!m.crtc.de_r()) agree = false;
  }
  check('Compusense p. 3: $FFE2 bit 0 reads 1 while the display is on and 0 while it blanks, and both occur',
    agree && busy > 0 && blank > 0, `${busy} busy, ${blank} blanking`);
  // p. 4: R9 = 10 makes a character row 11 raster lines (the HD6845S counts R9 + 1 lines in non-interlace,
  // R8 = $A2's mode bits 0-1 = 2: non-interlace per the HD6845S data sheet's R8 table)
  check('Compusense p. 4: its table (R9 = 10) gives rows of 11 raster lines', m.crtc.reg[9] + 1 === 11 && (m.crtc.reg[8] & 3) !== 3);
}

// Compusense p. 4's register table on the plus screen: R1 = 80 characters, R6 = 24 displayed rows of R9 + 1 = 11
// raster lines, so 24 x 11 = 264 lines, the whole 640 x 264 picture: the last row (23) is drawn on lines 253-263.
{
  const m = machine();
  const gen = new Uint8Array(0x2000);
  for (let a = 0; a < gen.length; a++) gen[a] = a & 0xFF;      // byte a holds a: a cell shows its own address
  m.setRoms({ basic: fake(0x4000, 1), basic64: fake(0x4000, 2), chargen: gen, prom: fake(0x200, 3) });
  m.reset(true);
  for (const [r, v] of [[0, 112], [1, 80], [2, 93], [3, 55], [4, 25], [5, 30], [6, 24], [7, 25], [8, 0xA2], [9, 10], [10, 96], [11, 10], [12, 0], [13, 0], [14, 0], [15, 0]]) {
    m.write(0xFFE0, r); m.write(0xFFE1, v);
  }
  m.videoRam[23 * 80] = 0x21;                                   // row 23, column 0 (MA = 23 x R1)
  m.drawPlus();
  const px = m.plusFrame.data;
  const bits = (y) => [...Array(8)].map((_, i) => px[y * 640 + i] ? 1 : 0).join('');
  // row 23 begins at line 23 x 11 = 253: raster 0 is generator $210 = 0001 0000, raster 10 (line 263) $21A = 0001 1010
  check('Compusense p. 4: 24 rows of 11 lines fill all 264 lines; row 23 is drawn on lines 253-263',
    bits(253) === '00010000' && bits(263) === '00011010' && bits(252) !== bits(253), `${bits(252)} ${bits(253)} ${bits(263)}`);
}

// ---- config.mameCompat: MAME 0.264's bank register never reaches memory ----
// A Lua probe of MAME 0.264 (docs/verification.md) writes each documented $FFE2 value and then
// $0100: the CPU reads back what it wrote every time and the plus_ram / video_ram shares stay untouched.
{
  const m = Emu.createMachine('d64plus', { mameCompat: true });
  m.setRoms({ basic: fake(0x4000, 1), basic64: fake(0x4000, 2), chargen: charger(), prom: fake(0x200, 3) });
  m.reset(true);
  for (const v of [0x00, 0x01, 0x02, 0x03, 0x06, 0x07]) { m.write(0xFFE2, v); m.write(0x0100, 0x40 + v); m.write(0x1000, 0x60 + v); }
  check('mameCompat: every write reached the standard RAM, the last one standing',
    m.ram[0x0100] === 0x47 && m.ram[0x1000] === 0x67 && m.read(0x0100) === 0x47);
  check('mameCompat: the plus RAM and the video RAM are never written', m.plusRam.every((x) => x === 0) && m.videoRam.every((x) => x === 0));
  check('mameCompat: the register itself is still kept (for the snapshot)', m.pramBank === 2 && m.vramBank === 3);
}

// ---- the SAM's page bit P1 comes first ----
// In 64K map type 0, P1 ($FFD5) moves $0000-$7FFF onto the upper 32K of the standard RAM (the SAM forms the
// address: MAME's sam6883_device::read/write; MC6883 data sheet), and the banks cover only the SAM's
// $0000-$7FFF (dragon.cpp machine_start installs them over 0x0000-0x7fff), so a paged access never reaches them.
{
  const m = machine();
  m.write(0xFFDD, 0);                          // M1: 64K
  m.write(0xFFE2, 0x07);                       // bank B and the video RAM
  m.write(0xFFD5, 0);                          // P1
  m.write(0x0010, 0xA5); m.write(0x1000, 0x5A);
  check('P1: $0010 and $1000 land in the standard RAM\'s upper half, not in bank B or the video RAM',
    m.ram[0x8010] === 0xA5 && m.ram[0x9000] === 0x5A && m.videoRam[0x10] !== 0xA5 && m.plusRam[0x9000] !== 0x5A);
  m.write(0xFFD4, 0);                          // P1 off: the banks again
  check('P1 off: the bank B / video RAM map is back', m.read(0x0010) === m.videoRam[0x10] && m.read(0x1000) === m.plusRam[0x9000]);
}

// ---- without a character generator the plus screen is blank, and the machine still runs ----
{
  const m = Emu.createMachine('d64plus');   // no ROMs at all: the stub machine
  m.reset(true);
  for (let i = 0; i < 3; i++) m.runFrame();
  check('it boots and runs with no ROMs (the stub), as any Dragon', m.useStub && m.cpu.pc >= 0x8000);
  m.view = 'plus';
  check('with no character generator the plus screen is blank', m.render().data.every((v) => v === 0));
  check('the VDG screen still has the stub banner', (() => { m.view = 'vdg'; return new Set(Emu.frameToRGBA(m.render())).size >= 2; })());
}

// ---- the reset state ----
{
  const m = machine();
  m.write(0xFFE2, 0x07);
  m.reset(true);
  check('a power cycle returns both banks to the standard RAM', m.pramBank === 0 && m.vramBank === 0);
  check('and the CRTC to its power-on registers', m.crtc.reg[0] === 0x3F && m.crtc.de_r() === 0);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
