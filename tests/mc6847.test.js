// Run: node tests/mc6847.test.js
// The MC6847's external character generator (the Dragon 200-E). A machine may fit a
// character ROM and have the VDG fetch glyph rows from it instead of its internal set; MAME's
// mc6847.cpp does this through set_get_char_rom(), and dragon.cpp's dragon200e composes the address as
//   (raster line << 8) | (PIA1 port B bit 4 << 7) | character code,  masked to the ROM's 4K.
// The test's character set is built here from that formula, never a real ROM.
//
// The 200-E also wires the VDG's alphanumeric control inputs differently from the CoCo, and that wiring
// is what makes the generator reachable: dragon.cpp dragon200e_state::sam_read() drives AS from the
// fetched byte's bit 7, INTEXT from its inverse (not PIA1 PB4), and INV from the LK1 "Inverse Video"
// link (not the byte's bit 6). Both wirings are checked below.
const Emu = require('./load')();
let fail = 0;
const check = (n, c, d = '') => { if (!c) { fail++; console.log('FAIL', n, d); } else console.log('ok  ', n, d); };

// text mode byte: A/G 0, INTEXT 0, GM 0 => an alphanumeric line; CSS 0
const TEXT = 0;
// a 4K character ROM where every byte mixes its own address's two halves, so a fetched row is recognisable
// and two addresses that share a low byte (the same code on two raster lines) still differ
const addrFont = new Uint8Array(0x1000);
for (let i = 0; i < addrFont.length; i++) addrFont[i] = (i ^ (i >> 8)) & 0xFF;
// the 200-E's formula, exactly as its driver composes it
const rom = (byte, line, pb4) => addrFont[((line << 8) | (pb4 << 7) | byte) & 0xFFF];

const vdg = new Emu.MC6847();
const rowBytes = (bytes) => { const b = new Uint8Array(32).fill(0x20); bytes.forEach((v, i) => { b[i] = v; }); return b; };

// the 8 pixels a cell draws on one raster line, as booleans (foreground = 1). Text mode draws foreground
// colour 0 on background colour 9 (dark green), so lit = colour 0.
function cell(vdg, byte, textLine, pb4 = 0) {
  vdg.charBank = pb4;              // the machine's PIA1 PB4, as the 200-E presents it to the VDG
  vdg.drawSamples(0, TEXT, textLine, rowBytes([byte]), 32, 0);   // 32 cells, the first the test byte
  const px = vdg.frame.data;
  const out = [];
  for (let i = 0; i < 8; i++) out.push(px[32 + i] === 0 ? 1 : 0);   // cell 0, its first 8 pixels
  return out;
}
const bitsOf = (byte) => { const out = []; for (let i = 0; i < 8; i++) out.push((byte & (0x80 >> i)) ? 1 : 0); return out; };
const invert = (bits) => bits.map((b) => 1 - b);

// without a character generator the internal set is used: "A" (code $21) has its familiar shape on the
// middle raster line - a bar of lit pixels - and nothing reads the ROM
const FONT_A_ROW3 = cell(vdg, 0x21, 3);
{
  check('no character generator: the internal font draws a row of "A"', FONT_A_ROW3.some((b) => b), FONT_A_ROW3.join(''));
  check('no character generator: getCharRom is null', vdg.getCharRom === null);
  check('CoCo/Dragon wiring by default: INTEXT comes from PIA1 PB4, not the byte', vdg.charIntExt(0x21, 0x10) === true && vdg.charIntExt(0x21, 0) === false);
  check('CoCo/Dragon wiring by default: INV is the byte\'s bit 6', vdg.charInv(0x21) === false && vdg.charInv(0x61) === true && vdg.invInput === null);
}

// The CoCo's wiring, which MAME drives too (coco12_m.cpp sam_read: as_w/inv_w from the byte): a byte with
// bit 7 set is a semigraphic here, whatever a generator would draw. This is why the 200-E must rewire.
{
  vdg.getCharRom = (byte, line, pb4) => rom(byte, line, pb4);
  const semi = cell(vdg, 0xA1, 3);         // AS high, INTEXT low (PB4 low) => SG4
  const gen = bitsOf(rom(0xA1, 3, 0));
  check('CoCo wiring: a byte with bit 7 set is semigraphics, not a generator glyph', JSON.stringify(semi) !== JSON.stringify(gen));
  vdg.getCharRom = null;
}

// The 200-E's wiring: AS = bit 7, INTEXT = /AS, INV = the link. Every text byte (bit 7 clear, so INTEXT
// high) now reaches the generator, under the address the driver composes. A byte with bit 7 set is a
// semigraphic exactly as on the CoCo (AS high leaves INTEXT low), so the generator must not be asked.
{
  vdg.getCharRom = (byte, line, pb4) => rom(byte, line, pb4);
  vdg.extIntFromData = true;
  vdg.invInput = false;                    // LK1 "Normal" (MAME's default: PORT_CONFSETTING 0x01)
  for (const byte of [0x21, 0x41, 0x61, 0x00, 0x3F, 0x7F]) {
    for (const line of [0, 3, 11]) {
      const want = bitsOf(rom(byte, line, 0));
      if (JSON.stringify(cell(vdg, byte, line)) !== JSON.stringify(want))
        check(`200-E: byte $${byte.toString(16)} line ${line} drawn from the generator`, false, JSON.stringify(cell(vdg, byte, line)));
    }
  }
  check('200-E: text bytes with bit 6 set are drawn by the generator (not inverted by data)',
    JSON.stringify(cell(vdg, 0x61, 3)) === JSON.stringify(bitsOf(rom(0x61, 3, 0))));
  check('200-E: the generator really replaced the internal font', JSON.stringify(cell(vdg, 0x21, 3)) !== JSON.stringify(FONT_A_ROW3));
  // a byte with bit 7 set is a semigraphic: INTEXT = /AS is low there, so the generator is never called
  {
    const semis = [0x80, 0x9F, 0xA1, 0xBF];
    const calls = [];
    vdg.getCharRom = (byte, line, pb4) => { calls.push(byte); return rom(byte, line, pb4); };
    for (const b of semis) cell(vdg, b, 1);
    check('200-E: a byte with bit 7 set draws semigraphics and never reaches the generator',
      !calls.some((b) => semis.includes(b)), JSON.stringify([...new Set(calls)]));
    vdg.getCharRom = (byte, line, pb4) => rom(byte, line, pb4);
  }
  // the raster line selects the row (the composed address is (line << 8) | ... )
  check('200-E: the raster line selects the row', JSON.stringify(cell(vdg, 0x21, 5)) === JSON.stringify(bitsOf(rom(0x21, 5, 0)))
    && JSON.stringify(cell(vdg, 0x21, 5)) !== JSON.stringify(cell(vdg, 0x21, 3)));
  // PIA1 port B bit 4 adds 0x80 to the address: the 200-E's second 2K half / Spanish set bank
  check('200-E: PIA1 PB4 selects the other half of the generator', JSON.stringify(cell(vdg, 0x21, 3, 1)) === JSON.stringify(bitsOf(rom(0x21, 3, 1)))
    && JSON.stringify(cell(vdg, 0x21, 3, 1)) !== JSON.stringify(cell(vdg, 0x21, 3, 0)));
  // LK1 "Inverse": the whole fetched row is inverted, whatever the byte says
  vdg.invInput = true;
  const invNorm = bitsOf(rom(0x21, 3, 0));
  check('200-E: LK1 "Inverse" inverts the fetched row', JSON.stringify(cell(vdg, 0x21, 3)) === JSON.stringify(invert(invNorm)),
    JSON.stringify(cell(vdg, 0x21, 3)));
  vdg.invInput = false;
  vdg.getCharRom = null;
  vdg.extIntFromData = false;
}

// The generator is passed the byte unmasked (MAME's delegate takes the fetched byte; the 200-E's driver
// masks the composed address to 4K, not the code), and only the address is masked. A byte with bit 6 set
// still reaches the generator: on the 200-E INV is the link, not bit 6.
{
  const seen = [];
  vdg.getCharRom = (byte, line, pb4) => { seen.push([byte, line, pb4]); return 0; };
  vdg.extIntFromData = true;
  cell(vdg, 0x65, 7, 1);
  check('the generator receives the raw fetched byte, the raster line and the bank', JSON.stringify(seen[0]) === JSON.stringify([0x65, 7, 1]), JSON.stringify(seen[0]));
  vdg.getCharRom = null; vdg.extIntFromData = false;
}

// The whole-line and the span path (drawSamples) must draw the same picture: the machine draws a line in
// spans when the mode changes part-way along it.
{
  vdg.getCharRom = (byte, line, pb4) => rom(byte, line, pb4);
  vdg.extIntFromData = true;
  const data = new Uint8Array(32);
  for (let i = 0; i < 32; i++) data[i] = (i * 37 + 0x21) & 0xFF;
  vdg.drawSamples(10, TEXT, 4, data, 32, 0);
  const whole = Array.from(vdg.frame.data.subarray(10 * Emu.MC6847.WIDTH, 10 * Emu.MC6847.WIDTH + Emu.MC6847.WIDTH));
  vdg.drawSamples(10, TEXT, 4, data.subarray(0, 16), 16, 0);
  vdg.drawSamples(10, TEXT, 4, data.subarray(16), 16, 128);
  const spans = Array.from(vdg.frame.data.subarray(10 * Emu.MC6847.WIDTH, 10 * Emu.MC6847.WIDTH + Emu.MC6847.WIDTH));
  check('a line drawn in two spans equals the same line drawn whole', JSON.stringify(spans) === JSON.stringify(whole));
  vdg.getCharRom = null; vdg.extIntFromData = false;
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
