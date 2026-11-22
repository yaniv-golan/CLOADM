// Run: node tests/models.test.js
// The extra models that are not new chips: the Prológica CP-400 (a CoCo clone) and the
// Dragon 200-E (a Dragon 200 with a character generator ROM and a different VDG wiring).
// Their hardware against MAME 0.264 (src/mame/trs/coco12.cpp and dragon.cpp). cp400(config) is coco(config)
// with a different default cartridge, and it loads a single 16K cp400bas.rom at $8000-$BFFF through the same
// SAM maps; dragon200e(config) is dragon64(config) with set_get_char_rom() and a rewired sam_read().
const Emu = require('./load')();
let fail = 0;
const check = (n, c, d = '') => { if (!c) { fail++; console.log('FAIL', n, d); } else console.log('ok  ', n, d); };

const p = Emu.profiles.cp400;
check('cp400 is a profile', !!p);
check('cp400 is a SAM-family machine with a 6809', p.family === 'sam' && p.options.cpu.values.includes('6809'), p.family);
check('cp400 uses the CoCo keyboard (MAME cp400 does; only cp400c2 differs)', p.keyboard === 'coco');
check('cp400 is NTSC, like MAME\'s coco-derived config', p.video === 'ntsc');
check('cp400 has no ACIA (the base coco config has none)', !p.acia);
check('cp400 offers the CoCo RAM sizes, 64K by default', JSON.stringify(p.options.ram.values) === JSON.stringify([4, 16, 32, 64]) && p.options.ram.default === 64,
  JSON.stringify(p.options.ram));
check('cp400 names the MAME driver cp400', p.mame === 'cp400');
// one 16K ROM covering $8000-$BFFF: a single required slot, 16K at $8000
check('cp400 has one 16K BASIC ROM at $8000', p.roms.length === 1 && p.roms[0].size === 0x4000 && p.roms[0].at === 0x8000 && p.roms[0].required,
  JSON.stringify(p.roms));
check('the CP-400 ROM is the archive name cp400bas.rom', p.roms[0].files.includes('cp400bas.rom'), JSON.stringify(p.roms[0].files));

// it builds, boots the stub, and runs: a SAM machine with 64K
{
  const m = Emu.createMachine('cp400');
  check('cp400 builds and boots the stub', !!m && m.profile.id === 'cp400' && m.config.ram === 64);
  m.reset(true);
  for (let i = 0; i < 3; i++) m.runFrame();
  const screen = m.profile.textScreen ? null : [...Array(512)].map((_, i) => m.ram[0x400 + i] & 0x3F).map((c) => String.fromCharCode(c < 32 ? c + 64 : c)).join('');
  // the name is accented; the stub console folds it to ASCII for the 32x16 screen
  check('cp400 shows the no-ROM stub banner with the name folded to ASCII', /^PROLOGICA CP-400 /.test(screen || '') && /BUILT-IN STUB/.test(screen || ''),
    (screen || '').slice(0, 40));
  check('the profile keeps the accented name for menus and docs', Emu.profiles.cp400.name === 'Prol\u00f3gica CP-400', Emu.profiles.cp400.name);
  check('cp400 runs the NTSC field (262 lines, as MAME\'s coco-derived config)', m.lines === 262, String(m.lines));
}

// the 16K ROM maps over $8000-$BFFF: writes to it are lost, reads come from the ROM
{
  const r = Emu.assemble(' ORG $3000\n LDX #$0000\n BRA *\n END', '6809');
  const m = Emu.createMachine('cp400');
  const rom = new Uint8Array(0x4000);
  for (let i = 0; i < rom.length; i++) rom[i] = (i * 7 + 3) & 0xFF;
  m.setRoms({ basic: rom });
  m.reset(true);
  const a = m.read(0x8000), b = m.read(0xBFFF);
  m.write(0x8000, a ^ 0xFF);
  check('cp400 reads its 16K ROM across $8000-$BFFF', a === rom[0] && b === rom[0x3FFF] && m.read(0x8000) === a,
    `$8000=${a.toString(16)} $BFFF=${b.toString(16)}`);
}

// ---- Dragon 200-E: a Dragon 200 with a character generator ROM and the VDG rewired to reach it ----
{
  const p = Emu.profiles.dragon200e;
  check('dragon200e is a profile', !!p);
  check('dragon200e is a SAM-family Dragon with a 6809 and 64K, ROM-banked like the 64',
    p.family === 'sam' && p.options.cpu.values.includes('6809') && p.options.ram.values.includes(64) && p.bankSelect === true);
  check('dragon200e is PAL, like every Dragon, with the ACIA at $FF04', p.video === 'pal' && p.acia === true);
  check('dragon200e names the MAME driver dragon200e', p.mame === 'dragon200e');
  check('dragon200e has the Dragon matrix under its own name (Spanish legends)',
    p.keyboard === 'dragon200e' && Emu.keyboards && !!Emu.keyboards.dragon200e, p.keyboard);
  // three ROMs: the two 16K BASIC banks on the bus and the 4K generator off it
  const bus = p.roms.filter((s) => !s.chip), chips = p.roms.filter((s) => s.chip);
  check('dragon200e has two 16K BASIC banks and one 4K character generator',
    bus.length === 2 && bus.every((s) => s.size === 0x4000 && s.at === 0x8000) && bus[0].bank === 0 && bus[1].bank === 1
    && chips.length === 1 && chips[0].id === 'chargen' && chips[0].size === 0x1000 && chips[0].required,
    JSON.stringify(p.roms.map((s) => [s.id, s.size, s.at, s.bank, s.chip])));
  check('the generator is the 200-E chip rom26.ic1 with its known-good CRC',
    chips[0].files.includes('rom26.ic1') && chips[0].crcs.includes('565724BC'), JSON.stringify(chips[0]));
  check('the BASIC banks are the 200-E chips, not the Dragon 64 ones',
    bus[0].files.includes('ic18_v1.4e.ic34') && bus[1].files.includes('ic17_v1.4e.ic37')
    && bus[0].crcs.includes('95AF0A0A') && bus[1].crcs.includes('48B985DF'));
  check('dragon200e has the LK1 "Inverse Video" setting, Normal by default (MAME\'s default)',
    JSON.stringify(p.options.inverseVideo) === JSON.stringify({ values: [false, true], default: false }), JSON.stringify(p.options.inverseVideo));
  // the machine builds, needs all three ROMs to boot, and wires the generator into the VDG
  const m = Emu.createMachine('dragon200e');
  check('dragon200e does not boot without its ROMs (the generator is required too)', !m.hasRom);
  const fake = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * seed + 7) & 0xFF; return b; };
  m.setRoms({ basic: fake(0x4000, 3), basic64: fake(0x4000, 5) });
  check('dragon200e still does not boot without the character generator', !m.hasRom);
  m.setRoms({ chargen: fake(0x1000, 11) });
  check('dragon200e boots with all three ROMs', m.hasRom);
  check('the generator image is kept off the bus (it is not part of the 32K ROM area)', m.charRom && m.charRom.length === 0x1000);
  // char_rom_r(): the row comes from (line << 8) | (PB4 << 7) | byte, masked to 4K. A text byte with bit 7
  // clear is drawn by the generator on the 200-E (INTEXT = /AS), unlike on a CoCo where PB4 alone selects it.
  const gen = new Uint8Array(0x1000); for (let i = 0; i < gen.length; i++) gen[i] = (i ^ (i >> 8)) & 0xFF;
  m.setRoms({ chargen: gen });
  const lit = (byte, line, pb4, inverse) => {
    const v = new Emu.MC6847();
    v.getCharRom = (b, l, bank) => m.charRom[((l << 8) | (bank << 7) | b) & 0xFFF];
    v.extIntFromData = true;
    // MAME's driver asserts INV while its LK1 port reads 1, which is the "Normal" setting (0x01, the
    // default): the same rule as js/machines/sam.js, so the option name and this test agree.
    v.invInput = !inverse; v.charBank = pb4;
    v.drawSamples(0, 0, line, Uint8Array.from([byte, ...new Array(31).fill(0x20)]), 32, 0);
    return Array.from({ length: 8 }, (_, i) => v.frame.data[32 + i] === 0 ? 1 : 0).join('');
  };
  const bits = (x) => Array.from({ length: 8 }, (_, i) => (x & (0x80 >> i)) ? '1' : '0').join('');
  // the generator's row for an address, as the chip applies it (four-tone: the VDG's INV input)
  const row = (addr, inv) => { const b = bits(gen[addr & 0xFFF]); return inv ? [...b].map((c) => c === '1' ? '0' : '1').join('') : b; };
  check('200-E: a text byte is drawn by the generator from (line << 8) | (PB4 << 7) | byte',
    lit(0x21, 3, 0, false) === row((3 << 8) | 0x21, true) && lit(0x21, 3, 1, false) === row((3 << 8) | 0x80 | 0x21, true)
    && lit(0x21, 3, 0, false) !== lit(0x21, 3, 1, false));
  check('200-E: LK1 "Inverse" changes the picture (INV is the link, not the byte)',
    lit(0x21, 3, 0, true) === row((3 << 8) | 0x21, false) && lit(0x21, 3, 0, true) !== lit(0x21, 3, 0, false));
  // a byte with bit 7 set is a semigraphic on this wiring too: the generator must not be consulted
  {
    const v = new Emu.MC6847();
    const calls = [];
    v.getCharRom = (b, l, bank) => { calls.push(b); return 0; };
    v.extIntFromData = true;
    v.drawSamples(0, 0, 3, Uint8Array.from([0xA1, ...new Array(31).fill(0x20)]), 32, 0);
    check('200-E: a semigraphic byte (bit 7 set) does not reach the generator', !calls.includes(0xA1), JSON.stringify(calls));
  }
}

// ---- Dragon 200-E: a Dragon in everything but the keyboard legends and the character generator ----
// MAME 0.264 src/mame/trs/dragon.cpp: dragon200e_state::dragon200e() is dragon64(config) plus the generator, so it has
// the Dragon 64's cartridge slot (COCOCART_SLOT ... dragon_cart, default "dragon_fdc"), the Dragon parallel printer
// (dragon_state::pia1_pa_changed: PIA1 PA1 high prints PIA0 port B) and the 6551 with an RS-232 port
// (RS232_PORT "rs232", whose RXD coco_state::pia1_pb_r reads on PB0 through m_rs232->rxd_r(), coco.cpp).
{
  const p = Emu.profiles.dragon200e;
  check('every profile names its lineage: dragon, coco or mc10',
    Object.entries(Emu.profiles).every(([, q]) => ['dragon', 'coco', 'mc10'].includes(q.lineage)),
    JSON.stringify(Object.entries(Emu.profiles).filter(([, q]) => !['dragon', 'coco', 'mc10'].includes(q.lineage)).map(([id, q]) => [id, q.lineage])));
  check('dragon200e is a Dragon by lineage, whatever its keyboard is called', p.lineage === 'dragon' && p.lineage === Emu.profiles.dragon64.lineage);
  // the disk cartridges the page offers: the Dragon 64's, never RS-DOS
  const dos = (id) => { const s = new Emu.Session({ welcomeMenu: false }); s.switchMachine(id, {}, { menu: false }); return s.diskDosChoices().map((c) => c.id); };
  const d200e = dos('dragon200e'), d64 = dos('dragon64');
  check('dragon200e offers the Dragon 64\'s disk cartridges (DragonDOS, Delta DOS), not RS-DOS',
    JSON.stringify(d200e) === JSON.stringify(d64) && d200e.includes('dragondos') && !d200e.includes('rsdos'), `${d200e} vs ${d64}`);
  // the printer: MAME's parallel port, and no bit-banger
  const m = Emu.createMachine('dragon200e');
  m.reset(true);
  check('dragon200e has no bit-banger (its printer is the Dragon parallel port)', !m.bitBanger);
  check('dragon200e: reset prints PIA0 port B ($FF), as on the Dragon 64', m.printed.join() === '255', m.printed.join());
  m.printed.length = 0;
  m.write(0xFF03, 0x00); m.write(0xFF02, 0xFF); m.write(0xFF03, 0x04);   // PIA0 PB outputs
  m.write(0xFF21, 0x00); m.write(0xFF20, 0xFE); m.write(0xFF21, 0x04);   // PIA1 PA1-7 outputs
  m.write(0xFF02, 0x41); m.write(0xFF20, 0x00); m.write(0xFF20, 0x02);   // strobe low, then high: 'A'
  m.write(0xFF02, 0x42); m.write(0xFF20, 0xFC); m.write(0xFF20, 0xFE);   // 'B'
  check('dragon200e: PIA1 PA1 high prints PIA0 port B (MAME dragon_state::pia1_pa_changed)', m.printed.join() === '65,66', m.printed.join());
  // the 6551's port: PB0 is its RXD, idle at mark, and a terminal's start bit reads 0
  check('dragon200e: the 6551 has its RS-232 port, as the Dragon 64\'s', p.acia === true && p.rs232 === true && !!m.acia);
  m.write(0xFF23, 0x00); m.write(0xFF22, 0x00); m.write(0xFF23, 0x04);
  m.acia.attachSerial('terminal', { baud: 1200 });
  const idle = m.read(0xFF22) & 1;
  m.acia.port.send([0x00], m.ioTime());
  check('dragon200e: PIA1 PB0 follows the 6551\'s port (idle 1, a start bit 0)', idle === 1 && (m.read(0xFF22) & 1) === 0);
}

// ---- RAM options: the CoCo's 4K/16K/32K/64K ----
// The fitted RAM (MAME's coco12.cpp: RAM over $0000..size-1, everything above it unreadable) and the SAM's
// M1/M0 mask that mirrors the video address to it (MC6883 data sheet p. 4-645, "Memory Size").
{
  for (const id of ['coco', 'coco2b', 'mx1600', 'lzcolor64', 'cd6809']) {
    const p = Emu.profiles[id];
    check(`${id} offers the CoCo RAM sizes, 64K by default`,
      JSON.stringify(p.options.ram.values) === JSON.stringify([4, 16, 32, 64]) && p.options.ram.default === 64, JSON.stringify(p.options.ram));
  }
  // an option a model does not have is refused
  {
    let threw = false;
    try { Emu.createMachine('dragon32', { ram: 16 }); } catch (e) { threw = /ram must be one of/.test(e.message); }
    check('the Dragon 32 refuses a RAM size it does not have', threw);
  }
  for (const id of ['coco', 'coco2b', 'mx1600', 'lzcolor64', 'cd6809']) {
    const m = Emu.createMachine(id, { ram: 4 });
    m.setRoms({});
    m.reset(true);
    m.write(0x0000, 0x5A); m.write(0x0FFF, 0xA5);
    check(`${id} 4K: RAM at $0000-$0FFF reads and writes`, m.read(0x0000) === 0x5A && m.read(0x0FFF) === 0xA5);
    m.write(0x1000, 0x11);
    check(`${id} 4K: absent RAM at $1000 reads 0`, m.read(0x1000) === 0x00 && m.ram[0x1000] === 0x00);
    // the SAM's display counter mask follows M1/M0 (MAME counter_mask): 4K $0FFF, 16K $3FFF, 64K $FFFF
    const mask = (mem) => { m.sam.reg = mem << 13; return m.sam.counterMask; };
    check(`${id}: the SAM mirrors video to the declared RAM size (4K, 16K, 64K)`,
      mask(0) === 0x0FFF && mask(1) === 0x3FFF && mask(2) === 0xFFFF && mask(3) === 0xFFFF,
      [mask(0), mask(1), mask(2), mask(3)].map((x) => x.toString(16)).join(' '));
  }
  // each size installs exactly that much RAM. In 64K mode the I/O page ($FF00-$FFFF) is decoded by the SAM
  // before RAM, so the highest RAM a 64K machine exposes through the CPU is $FEFF in map type 1 only
  // (MAME's read/write decode: RAM space is $0000-$7FFF, plus $8000-$FEFF with TY=1; in map type 0 the
  // $8000-$FEFF range is ROM).
  for (const [ram, top] of [[4, 0x1000], [16, 0x4000], [32, 0x8000], [64, 0x8000]]) {
    const m = Emu.createMachine('coco', { ram });
    m.setRoms({}); m.reset(true);
    m.write(top - 1, 0x42);
    check(`coco ${ram}K: RAM ends at $${(top - 1).toString(16)} (map type 0)`, m.read(top - 1) === 0x42, m.read(top - 1).toString(16));
  }
  // in map type 1 (64K mode) every size that fits has its RAM above $8000, up to the fitted size
  for (const [ram, top] of [[16, 0x4000], [32, 0x8000], [64, 0xFF00]]) {
    const m = Emu.createMachine('coco', { ram });
    m.setRoms({}); m.reset(true);
    m.sam.reg = 0xC000;                                        // TY=1 with M1 (64K size): TY alone keeps the ROM
    m.write(top - 1, 0x42);
    check(`coco ${ram}K in 64K mode: RAM reaches $${(top - 1).toString(16)}`, m.read(top - 1) === 0x42, m.read(top - 1).toString(16));
  }
  // in map type 1 (64K mode) the RAM above $8000 is present only when it is fitted
  {
    const small = Emu.createMachine('coco', { ram: 4 }); small.setRoms({}); small.reset(true);
    small.sam.reg = 0xC000;                                  // TY=1 with M1
    small.write(0x9000, 0x77);
    check('4K in 64K mode: absent RAM above $8000 reads 0', small.read(0x9000) === 0x00, small.read(0x9000).toString(16));
    const big = Emu.createMachine('coco', { ram: 64 }); big.setRoms({}); big.reset(true);
    big.sam.reg = 0xC000;
    big.write(0x9000, 0x77);
    check('64K in 64K mode: RAM above $8000 reads and writes', big.read(0x9000) === 0x77);
  }
}

// ---- the 200-E's character-generator bank: per fetch, or per field under mameCompat ----
// PB4 is an address line into the generator (MAME's char_rom_r), so the hardware takes the bank at each
// fetch. MAME calls char_rom_r() from screen_update, after a whole field has run, so it uses one sample of
// PB4 for the whole field; config.mameCompat reproduces that (AGENTS 4.6).
// Driven through real video: the raster spec's machine boots our firmware into text mode, then flipping
// PB4 mid-field shows which banks the generator was asked for.
{
  const spec = require('../tools/mame-diff/sam/spec.js');
  const run = (compat, frames) => {
    const t = spec.raster('dragon200e', { regenerate: false, config: { mameCompat: compat } });
    const m = t.machine();
    let changes = 0, last = m.charBankLatch, bank = null;
    const orig = m.vdg.getCharRom;
    m.vdg.getCharRom = (b, l, bk) => { if (bank === null) bank = bk; return orig(b, l, bk); };
    for (let f = 0; f < frames; f++) { m.runFrame(); if (m.charBankLatch !== last) { changes++; last = m.charBankLatch; } }
    // now flip PB4 and see what the very next fetch uses
    m.write(0xFF22, 0x10);
    const before = bank;
    bank = null;
    for (let f = 0; f < 3; f++) m.runFrame();
    m.vdg.getCharRom = orig;
    return { changes, latch: m.charBankLatch, nextBank: bank, before };
  };
  const hw = run(false, 300);
  check('200-E hardware: no per-field bank latch is kept', hw.changes === 0, `${hw.changes} changes`);
  check('200-E hardware: the fetch takes the bank straight from PB4 (it flips at once)', hw.nextBank === 1, JSON.stringify(hw));

  const mm = run(true, 300);
  check('200-E mameCompat: the bank is latched once per field', mm.changes > 0, `${mm.changes} changes over 300 frames`);
  check('200-E mameCompat: a PB4 flip does not reach the picture until the field ends', mm.nextBank === 0, JSON.stringify(mm));
}

// ---- the 200-E's PB4 and MAME's INTEXT flush ----
// MAME's 200-E drives the VDG's INTEXT from each fetched byte (sam_read) and, through the CoCo/Dragon PIA1
// port B handler, from PB4 on every port B write; when the two disagree the write splits the line, and at
// SAM V 1 the split's extra reads move the display counter. config.mameCompat reproduces that
// (js/machines/sam.js mameIntextTrack); on the hardware PB4 reaches only the character generator, so a write
// of PB1 alone changes nothing. Raster case 11 (raster-chargen.asm) writes PB $00/$02 along every line at V 1.
{
  const spec = require('../tools/mame-diff/sam/spec.js');
  const fields = (compat) => {
    const t = spec.raster('dragon200e', { regenerate: false, config: { mameCompat: compat } });
    const m = t.machine(), got = {};
    for (let f = 0; f < 2000 && !(got.swept && got.plain); f++) {
      m.runFrame();
      if (m.read(t.phaseAddr) !== 11) continue;
      const n = m.read(t.fieldAddr), pic = m.render().data;
      if (n === 3 && !got.swept) got.swept = pic.slice();
      if (n === t.plain && !got.plain) got.plain = pic.slice();
    }
    let changed = 0;
    // the first text row holds the lead-in's toggled byte ($0400): left out, as lib/raster.js does
    const W = Emu.MC6847.WIDTH, from = (Emu.MC6847.BORDER_Y + 12) * W;
    for (let i = from; i < got.swept.length; i++) if (got.swept[i] !== got.plain[i]) changed++;
    return changed;
  };
  const hw = fields(false), mm = fields(true);
  check('200-E hardware: PB1 writes along every line change nothing', hw === 0, `${hw} px`);
  check('200-E mameCompat: the same writes split lines as MAME does and change the picture', mm > 10000, `${mm} px`);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;