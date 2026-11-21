// Run: node tests/machine.test.js  -- headless machine test using the no-ROM stub and the demo binary
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
let fail = 0;
const check = (n, c) => { if (!c) { fail++; console.log('FAIL', n); } else console.log('ok  ', n); };

const m = Emu.createMachine('dragon64');
m.reset(true);
for (let i = 0; i < 5; i++) m.runFrame();
const screenText = () => { let s = ''; for (let i = 0x400; i < 0x600; i++) { const c = m.ram[i] & 0x3F; s += String.fromCharCode(c < 0x20 ? c + 0x40 : c); } return s; };
check('stub banner on screen', screenText().includes('DRAGON 64') && screenText().includes('BUILT-IN STUB'));
check('text mode VDG', (m.pia1.b.outValue() & 0x80) === 0);

const bin = new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/demo.bin')));
const d = Emu.formats.identify('demo.bin', bin);
check('identified DragonDOS', d.kind === 'binary' && d.exec === 0x4000);
m.injectAndRun(d.segments, d.exec);
for (let i = 0; i < 10; i++) m.runFrame();
check('demo printed message', screenText().includes('PRESS ANY KEY'));
m.stubKeys.push(32);
for (let i = 0; i < 30; i++) m.runFrame();
check('graphics mode set', (m.pia1.b.outValue() & 0xF0) === 0xE0);
check('display base $0E00', m.sam.displayBase === 0x0E00);
const px = Emu.frameToRGBA(m.render());
const colours = new Set(px); check('rendered several colours (' + colours.size + ')', colours.size >= 4);
check('PC in demo', m.cpu.pc >= 0x4000 && m.cpu.pc < 0x4200);

// CAS round trip: build a tape image with one ML file
const data = [0x86, 0x42, 0xB7, 0x30, 0x00, 0x20, 0xFE];
const block = (type, bytes) => { let sum = (type + bytes.length) & 0xFF; bytes.forEach(b => sum = (sum + b) & 0xFF); return [...Array(128).fill(0x55), 0x3C, type, bytes.length, ...bytes, sum, 0x55]; };
const nameBlk = [...'TEST    '].map(c => c.charCodeAt(0)).concat([2, 0, 0, 0x40, 0x00, 0x40, 0x00]);
const cas = new Uint8Array([...block(0, nameBlk), ...block(1, data), ...block(0xFF, [])]);
const files = Emu.formats.parseCas(cas);
check('cas parsed', files.length === 1 && files[0].name === 'TEST' && files[0].exec === 0x4000 && files[0].data.length === 7);
m.injectAndRun([{ addr: files[0].load, data: files[0].data }], files[0].exec);
m.runFrame();
check('cas program ran', m.ram[0x3000] === 0x42);

// tape waveform timing sanity: one 0x55 byte = 4 zero bits + 4 one bits
// (a lone byte, no blocks: the silence at the start of a tape, a 128-byte leader, then the byte's 16 half cycles)
const t = new Emu.Tape(new Uint8Array([0x00]), m.tickHz);
check('tape signal: silence, leader, byte', t.halves.length === 1 + (128 + 1) * 16 && t.levels[0] === 0 && t.halves[0] === Math.round(2 * m.tickHz)
  && t.levels[1] === 1 && t.levels[2] === 0);

// keyboard matrix: press 'A' (row2 col1), strobe column 1 low
m.reset(true); m.runFrame();
m.setKey('A', true);
m.write(0xFF02, 0xFD);
check('keyboard row 2 low', (m.read(0xFF00) & 0x04) === 0);
m.write(0xFF02, 0xFB);
check('other column unaffected', (m.read(0xFF00) & 0x04) !== 0);
// cassette: motor on via PIA1 CA2, measure PA0 periods for byte $F0 (4 zero bits then 4 one bits)
{
  const mm = Emu.createMachine('dragon64'); mm.reset(true); mm.runFrame();
  const tp = new Emu.Tape(new Uint8Array([0xF0]), m.tickHz);
  tp.idx = tp.halves.length - 16; tp.left = tp.halves[tp.idx];   // the byte itself
  mm.deck.insert(tp);
  mm.write(0xFF21, 0x3C);           // CA2 high = motor on, data register selected
  const periods = []; let last = mm.read(0xFF20) & 1, lastRise = null;
  for (let i = 0; i < 6000; i++) {
    mm.cycle += 1;
    const v = mm.read(0xFF20) & 1;
    if (v && !last) { if (lastRise !== null) periods.push(i - lastRise); lastRise = i; }
    last = v;
  }
  const hz = periods.slice(0, 7).map(p => Math.round(m.tickHz / p));
  check('tape bit periods ' + hz.join(','), hz.slice(0, 3).every(h => Math.abs(h - 1200) < 20) && hz.slice(4, 7).every(h => Math.abs(h - 2400) < 40));
  mm.write(0xFF21, 0x34);
  const pos = tp.idx; mm.cycle += 5000; mm.read(0xFF20);
  check('tape stops with motor', tp.idx === pos);
}
// synthetic ROMs: bank 0 resets to $8000, sets PB2 low (select bank 1), jumps to $A000 which bank 1 holds
{
  const r0 = new Uint8Array(0x4000), r1 = new Uint8Array(0x4000);
  r0.set([0x86, 0x11, 0xB7, 0x30, 0x00,                 // LDA #$11; STA $3000
          0x7F, 0xFF, 0x23, 0x86, 0xFF, 0xB7, 0xFF, 0x22, // CLR $FF23 (DDR); LDA #$FF; STA $FF22
          0x86, 0x04, 0xB7, 0xFF, 0x23,                 // LDA #$04; STA $FF23 (data reg)
          0x7F, 0xFF, 0x22,                             // CLR $FF22  -> PB2 low: 64K ROM
          0x7E, 0xA0, 0x00]);                           // JMP $A000
  r0[0x3FFE] = 0x80; r0[0x3FFF] = 0x00;
  r1.set(r0.subarray(0, 0x20));                         // same code in both banks (real D64 ROMs do this too)
  r1.set([0x86, 0x22, 0xB7, 0x30, 0x01, 0xB7, 0xFF, 0xDD, 0xB7, 0xFF, 0xDF, 0x20, 0xFE], 0x2000); // LDA #$22; STA $3001; STA $FFDD (M1=1); STA $FFDF (TY=1); BRA *
  const mm = Emu.createMachine('dragon64'); mm.setRoms({ basic: r0, basic64: r1 }); mm.reset(true); mm.runFrame();
  check('bank 0 ran', mm.ram[0x3000] === 0x11);
  check('bank 1 selected via PB2', mm.ram[0x3001] === 0x22);
  check('64K map type', mm.sam.mapType === 1);
  mm.ram[0x9000] = 0x5A; check('all-RAM read in map type 1', mm.read(0x9000) === 0x5A);
}

// SAM 64K-mode memory map: page bit P1 ($FFD4/$FFD5) moves $0000-$7FFF onto RAM $8000-$FFFF, only with
// M1 set and map type 0; map type 1 (TY) is all RAM only with M1 set. Expected values from the MC6883 data sheet
// (Table 1 and the P1 note) and MAME 0.264 sam6883_device::read/write; the SAM diagnostic checks the same in lockstep.
{
  const m = Emu.createMachine('dragon64');
  m.reset(true);
  for (let i = 0; i < 0x10000; i++) m.ram[i] = (i * 7 + (i >> 8)) & 0xFF;
  const sam = (a) => m.write(a, 0);
  const lo = (a) => (a * 7 + (a >> 8)) & 0xFF;
  check('P1 without M1: $1234 is RAM $1234', (sam(0xFFD5), m.read(0x1234) === lo(0x1234)));
  sam(0xFFDD);                                                      // M1: 64K
  check('P1 with M1: $1234 reads RAM $9234', m.read(0x1234) === lo(0x9234));
  check('...$7FFF reads RAM $FFFF', m.read(0x7FFF) === lo(0xFFFF));
  m.write(0x0100, 0xA5);
  check('...a write to $0100 lands in RAM $8100', m.ram[0x8100] === 0xA5 && m.ram[0x0100] === lo(0x0100));
  const rom = m.read(0x9000);
  check('...$8000-$FEFF is still ROM', rom === m.currentRom()[0x1000]);
  sam(0xFFDF);                                                      // TY: all RAM, P1 ignored
  check('TY with M1 and P1: $1234 is RAM $1234 again', m.read(0x1234) === lo(0x1234));
  check('...$9000 is RAM', m.read(0x9000) === lo(0x9000));
  sam(0xFFD4); sam(0xFFDC);                                         // P1 and M1 clear, TY still set
  check('TY without M1: $9000 is ROM', m.read(0x9000) === rom);
  m.write(0x9000, 0x3C);
  check('...and a write there is lost', m.ram[0x9000] === lo(0x9000));
  sam(0xFFDE);
  // a 32K Dragon: P1 points the low half at absent RAM, which reads 0 and drops writes (MAME: nop_readwrite above the RAM)
  const d = Emu.createMachine('dragon32');
  d.reset(true);
  d.ram[0x1234] = 0x77;
  d.write(0xFFDD, 0); d.write(0xFFD5, 0);
  check('32K with P1: the low half reads 0', d.read(0x1234) === 0x00);
  d.write(0x1234, 0x55);
  d.write(0xFFD4, 0);
  check('...and the write went nowhere', d.read(0x1234) === 0x77);
}
// machine configuration: defaults, validation, effect
{
  const d = Emu.resolveConfig('coco3');
  check('config defaults (CoCo 3: 512K, 6809, mameCompat off)', d.ram === 512 && d.cpu === '6809' && d.mameCompat === false);
  const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };
  check('unknown option rejected', throws(() => Emu.createMachine('dragon64', { turbo: true })));
  // the CoCo 1/2 now offers 4K/16K/32K/64K; a size it does not have is still refused
  check('RAM sizes the CoCo 1/2 offers are accepted', Emu.createMachine('coco', { ram: 4 }).ramSize === 0x1000
    && Emu.createMachine('coco', { ram: 16 }).ramSize === 0x4000);
  check('unsupported RAM size rejected', throws(() => Emu.createMachine('coco', { ram: 8 })));
  check('config is frozen', Object.isFrozen(Emu.createMachine('mc10').config));
  check('CoCo 3 128K config gives 128K of RAM', Emu.createMachine('coco3', { ram: 128 }).mem.length === 128 * 1024);
  check('MC-10 4K config ends RAM at $5000', Emu.createMachine('mc10', { ram: 4 }).ramEnd === 0x5000);
}
// PC hooks run only when the instruction at the hooked address executes: an interrupt taken exactly at
// CHROUT must not print the character twice (once before the interrupt, once after its RTI)
for (const id of ['dragon64', 'coco3', 'mc10']) {
  const mm = Emu.createMachine(id);
  mm.reset(true); mm.runFrame(); mm.runFrame();
  const cpu = mm.cpu, chrout = id === 'mc10' ? 0xF9C6 : 0xB110;
  const prints = [];
  const orig = mm.stubConsole.putChar.bind(mm.stubConsole);
  mm.stubConsole.putChar = (c) => { prints.push(c); orig(c); };
  // a JSR CHROUT frame returning to an endless loop, with the interrupt raised as the CPU reaches CHROUT
  const loop = id === 'mc10' ? 0x4800 : 0x3000;
  mm.poke(loop, 0x20); mm.poke(loop + 1, 0xFE);                 // BRA *
  cpu.s -= 2; mm.poke(cpu.s, loop >> 8); mm.poke(cpu.s + 1, loop & 0xFF);
  if (id === 'mc10') cpu.s = (cpu.s - 1) & 0xFFFF, mm.poke(cpu.s + 1, loop >> 8), mm.poke(cpu.s + 2, loop & 0xFF);
  cpu.pc = chrout; cpu.a = 0x41;
  if (id === 'mc10') { cpu.nmiPending = true; } else { cpu.nmiArmed = true; cpu.nmi(); }
  mm.runCycles(mm.cycle + 2000);
  check(`${id}: an interrupt at a hooked address runs the hook once (${prints.length} print${prints.length === 1 ? '' : 's'})`, prints.length === 1 && prints[0] === 0x41);
}
// The summary every suite ends with: tests/all.js reads it to tell a suite that finished from one that stopped
// part-way and exited 0 anyway.
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
