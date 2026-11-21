// The built-in firmware (no ROMs) sets the SAM's memory size to the fitted RAM, as BASIC does.
// Run: node tests/stub-sam.test.js
//
// The SAM's M1/M0 bits size the video counter (MC6883 data sheet p. 4-645, "Memory Size"; MAME 6883sam.cpp
// m_counter_mask: 4K -> $0FFF, 16K -> $3FFF, 64K -> $FFFF). Color BASIC and Dragon BASIC set them at power-on from
// the RAM they find: M=01 for 16K, M=10 for 32K and 64K. The stub used to leave them at M=00 (4K), so a program
// run on it that displayed anything above $0FFF saw the first 4K again unless it set M itself.
// The oracle is the rendered picture, not the register: a screen placed above 4K must show its own bytes.
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const boot = (id, config) => {
  const m = Emu.createMachine(id, config);
  m.reset(true);
  for (let f = 0; f < 3; f++) m.runFrame();
  return m;
};
// the expected M for the fitted RAM, as BASIC sets it
const wantM = (k) => (k >= 32 ? 2 : k >= 16 ? 1 : 0);

// ---- 1. every SAM model and RAM option ----
for (const [pid, p] of Object.entries(Emu.profiles)) {
  if (p.family !== 'sam' && p.family !== 'alpha' && p.family !== 'd64plus') continue;
  for (const ram of p.options.ram.values) {
    const m = boot(pid, { ram });
    check(`${pid} ${ram}K: the built-in firmware leaves M=${wantM(ram).toString(2).padStart(2, '0')}`, !m.hasRom && m.sam.memSize === wantM(ram),
      `memSize ${m.sam.memSize}`);
  }
}

// ---- 2. the picture: a text screen at $2000 shows $2000's bytes, not $0000's ----
// Two machines show the same characters, one from the usual $0400, one from $2000 with something else at $0000
// (where a 4K counter would wrap to). The frames must be identical.
const frame = (m) => Array.from(Emu.frameToRGBA(m.render()));
for (const [id, ram] of [['dragon32', 32], ['coco', 16], ['coco', 64], ['dragon64', 64]]) {
  const a = boot(id, { ram }), b = boot(id, { ram });
  const text = (m, base) => { for (let i = 0; i < 0x200; i++) m.ram[base + i] = 0x41 + (i % 26); };
  a.cpu.cc |= 0x50; b.cpu.cc |= 0x50;                       // nothing of the stub's writes to the screen
  text(a, 0x0400);
  text(b, 0x2000);
  for (let i = 0; i < 0x0600; i++) b.ram[i] = 0x60;         // spaces where a wrapped counter would read
  for (let bit = 0; bit < 7; bit++) b.write(0xFFC6 + 2 * bit + ((0x2000 >> 9) >> bit & 1), 0);   // F = $2000/512
  // freeze both CPUs on an endless branch so neither runs the stub again
  for (const m of [a, b]) { m.ram[0x3F00] = 0x20; m.ram[0x3F01] = 0xFE; m.jump(0x3F00); m.runFrame(); m.runFrame(); }
  const fa = frame(a), fb = frame(b);
  check(`${id} ${ram}K: a text screen at $2000 shows its own bytes (no 4K wrap)`, fa.length === fb.length && fa.every((v, i) => v === fb[i]));
}

console.log(fail ? `${fail} failed` : 'all stub SAM checks passed');
process.exitCode = fail ? 1 : 0;
