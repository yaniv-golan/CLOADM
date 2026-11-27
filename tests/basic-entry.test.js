// Run: node tests/basic-entry.test.js
//
// The clean-room BASIC's published entry points (docs/clean-room-basic.md, section 3): the jumps at $8006-$8029 and
// the table of calls at $A000-$A00D that Dragon Data Ltd's "Dragon 32 Information for Machine Code Users!" (March
// 1983, printed pages 4-5) gives. The layout is checked against a table written here by hand from those pages (a
// jump to our routine where it does the page's job, $FF where none of ours does), and the stubs are called from
// machine code on a Dragon 64 running the image assembled from basic/ at test time (no other ROM): the screen
// output, the cassette relay on and off (interrupts left as they were, unlike CASON), and the keyboard poll through
// $8006 and through [$A000]. The ROM as built has the table at $A000 with no byte lost before it; a mutant's build
// moves it or goes without (tools/build-basic.js).
const { buildBasic } = require('../tools/build-basic.js');
const { Basic } = require('./basic/harness.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const hex = (v) => '$' + v.toString(16).toUpperCase();

const { rom, symbols } = buildBasic();
const at = (a) => rom[a - 0x8000];
const word = (a) => at(a) * 256 + at(a + 1);

// ---- the layout ----
// [address, our routine or null] from the manual's pages 4-5
const JUMPS = [[0x8006, 'KEYIN'], [0x8009, null], [0x800C, 'CHROUT'], [0x800F, null], [0x8012, null], [0x8015, 'RLYON'],
  [0x8018, 'RLYOFF'], [0x801B, null], [0x801E, 'CWBYTE'], [0x8021, null], [0x8024, 'CRBYTE'], [0x8027, 'CRBIT']];
for (const [a, r] of JUMPS) {
  if (r) check(`${hex(a)}: JMP ${r}`, at(a) === 0x7E && word(a + 1) === symbols.get(r), `${at(a).toString(16)} ${hex(word(a + 1))}`);
  else check(`${hex(a)}: $FF (no routine of ours does its job)`, at(a) === 0xFF && at(a + 1) === 0xFF && at(a + 2) === 0xFF);
}
check('$8000-$8005: nothing published, nothing placed', [0, 1, 2, 3, 4, 5].every((i) => rom[i] === 0xFF));
const first = buildBasic().listing.find((l) => l.file === 'boot.inc' && l.bytes && l.bytes.length);
check('the code starts at $802A, just after the last published jump', first && first.addr === 0x802A, first && hex(first.addr));
check('$A000: the keyboard poll, KEYIN', word(0xA000) === symbols.get('KEYIN'), hex(word(0xA000)));
check('$A002-$A00D: $FF (no routine of ours does those jobs, or nothing is published)', [...rom.subarray(0x2002, 0x200E)].every((x) => x === 0xFF));

check('the ROM as built: the table costs no byte (a routine starts at $A000)', buildBasic().gap === 0, String(buildBasic().gap));
// A mutant's build (tests only) moves the table when the code before it grows or shrinks: still at $A000, after an
// instruction that nothing runs on from, with the bytes between left $FF; or, where no such place fits, has none
for (const [name, edit] of [
  ['3 bytes more before it', (f, t) => (f === 'screen.inc' ? t.replace('CHROUT  PSHS    D,X\n', 'CHROUT  PSHS    D,X\n        NOP\n        NOP\n        NOP\n') : t)],
  ['2 bytes fewer before it', (f, t) => (f === 'screen.inc' ? t.replace('        JSR     TXTSCR\n        LDA     ,S\n', '        JSR     TXTSCR\n') : t)],
  ['4 bytes fewer before it', (f, t) => (f === 'screen.inc' ? t.replace('        CMPA    #8\n        BEQ     CHRBS\n', '') : t)],
]) {
  const m = buildBasic({ edit });
  const before = m.listing.filter((l) => l.bytes && l.bytes.length && l.addr < 0xA000 && l.addr >= 0x9F00).pop();
  const hole = m.rom.subarray(before.addr + before.bytes.length - 0x8000, 0x2000);
  check(`${name}: the table still at $A000, KEYIN's address in it`, m.symbols.get('VECTBL') === 0xA000 && m.rom[0x2000] * 256 + m.rom[0x2001] === m.symbols.get('KEYIN'),
    `gap ${m.gap}`);
  check(`${name}: after ${before.src.trim().split(/\s+/).slice(-2).join(' ')}, the ${m.gap} bytes up to it $FF`,
    /^\S*\s+(RTS|RTI|BRA|LBRA|JMP|PULS\s+\S*PC)\b/.test(before.src) && hole.length === m.gap && hole.every((x) => x === 0xFF));
}

{
  // all but 5 of the free bytes taken before it: no place below $A000 leaves room for the table and the code after it
  const grow = 0xBFF0 - symbols.get('ROMEND') - 5;
  const m = buildBasic({ edit: (f, t) => (f === 'd64basic.asm' ? t.replace('        INCLUDE "screen.inc"', `        RMB     ${grow}\n        INCLUDE "screen.inc"`) : t) });
  check('a mutant\'s build with no room for it has no table', m.gap === null && !m.symbols.has('VECTBL'), `gap ${m.gap}`);
}

// ---- the stubs called from machine code ----
// stubs(rom) -> [name, pass, detail] for each call; run on the ROM as built, and on mutants that must fail one
const poke = (b, a, bytes) => bytes.forEach((v, i) => { b.m.ram[a + i] = v; });
function stubs(image) {
  const out = [];
  const boot = () => {
    const b = new Basic(image);
    if (!b.waitOk({ limit: 600, stable: 3 })) throw new Error('no OK at boot');
    return b;
  };
  const exec = (b, a) => { b.type(`EXEC ${a}\n`); };
  // $800C: "HI" on the screen
  {
    const b = boot();
    poke(b, 0x7000, [0x86, 0x48, 0xBD, 0x80, 0x0C, 0x86, 0x49, 0xBD, 0x80, 0x0C, 0x39]);
    exec(b, 0x7000);
    const ok = b.waitOk({ limit: 300 }), s = b.screen();
    out.push(['$800C writes A to the screen', ok && s.includes('HI'), JSON.stringify(s.slice(-3))]);
  }
  // $8015 with interrupts on, then $8018 with them masked: the relay on and off, CC's I bit as each found it
  // (CASON masks interrupts and CASOFF unmasks them: the stubs must do neither); then TIMER still counting
  {
    const b = boot();
    poke(b, 0x7000, [0xBD, 0x80, 0x15, 0xB6, 0xFF, 0x21, 0xB7, 0x70, 0x30, 0x1F, 0xA8, 0xB7, 0x70, 0x33,
      0x1A, 0x50, 0xBD, 0x80, 0x18, 0xB6, 0xFF, 0x21, 0xB7, 0x70, 0x31, 0x1F, 0xA8, 0xB7, 0x70, 0x32,
      0x1C, 0xEF, 0x39]);
    exec(b, 0x7000);
    b.waitOk({ limit: 300 });
    const r = b.m.ram;
    out.push(['$8015 turns the relay on (PIA 1 CA2 high)', (r[0x7030] & 0x38) === 0x38, hex(r[0x7030])]);
    out.push(['$8015 leaves interrupts on', (r[0x7033] & 0x10) === 0, hex(r[0x7033])]);
    out.push(['$8018 turns it off', (r[0x7031] & 0x38) === 0x30, hex(r[0x7031])]);
    out.push(['$8018 leaves interrupts masked', (r[0x7032] & 0x10) !== 0, hex(r[0x7032])]);
    const t0 = r[0x112] * 256 + r[0x113];
    b.run(10);
    const t1 = r[0x112] * 256 + r[0x113];
    out.push(['TIMER counts after them', ((t1 - t0) & 0xFFFF) >= 9, `${t0} -> ${t1}`]);
  }
  // $801E: the byte in A written to the tape, a cycle of the DAC (high then low) a bit: 16 writes to PIA 1 port A
  {
    const b = boot();
    const pa = b.m.pia1.a, was = pa.onOutput;
    let writes = 0;
    poke(b, 0x7000, [0x86, 0x55, 0xBD, 0x80, 0x1E, 0x39]);
    pa.onOutput = (...a) => { writes++; return was && was.apply(pa, a); };
    exec(b, 0x7000);
    b.waitOk({ limit: 300 });
    pa.onOutput = was;
    out.push(['$801E writes a byte: 16 DAC writes, high and low a bit', writes === 16, String(writes)]);
  }
  // $8006 and [$A000]: no key gives 0; a key pressed while the program polls gives its code
  for (const [name, call] of [['$8006', [0xBD, 0x80, 0x06]], ['[$A000]', [0xAD, 0x9F, 0xA0, 0x00]]]) {
    const b = boot();
    // LDA #$55, the call, STA $7050; then the call until A is not 0 (BEQ back), STA $7051, RTS
    const once = [0x86, 0x55, ...call, 0xB7, 0x70, 0x50];
    const loop = [...call, 0x27, 0xFE - call.length, 0xB7, 0x70, 0x51, 0x39];
    poke(b, 0x7000, [...once, ...loop]);
    exec(b, 0x7000);
    b.run(5);
    const r = b.m.ram;
    out.push([`${name} with no new key: A = 0`, r[0x7050] === 0, hex(r[0x7050])]);
    b.keys(['X']);
    b.waitOk({ limit: 300 });
    out.push([`${name} with X pressed: A = 'X'`, r[0x7051] === 0x58, hex(r[0x7051])]);
  }
  return out;
}
for (const [name, pass, detail] of stubs(rom)) check(name, pass, detail);

// mutants: each stub pointed at a routine that does the job differently must fail a call above
for (const [what, file, from, to] of [
  ['$8015 to CASON (interrupts masked)', 'd64basic.asm', 'JMP     RLYON', 'JMP     CASON'],
  ['$8018 to CASOFF (interrupts unmasked)', 'd64basic.asm', 'JMP     RLYOFF', 'JMP     CASOFF'],
  ['$800C to SCROLL', 'd64basic.asm', 'JMP     CHROUT ', 'JMP     SCROLL '],
  ['$801E to CWDLY', 'd64basic.asm', 'JMP     CWBYTE', 'JMP     CWDLY '],
  ['$8006 to CHROUT', 'd64basic.asm', 'JMP     KEYIN ', 'JMP     CHROUT'],
  ['$A000 to CHROUT', 'vectbl.inc', 'FDB     KEYIN', 'FDB     CHROUT'],
]) {
  const m = buildBasic({ edit: (f, t) => {
    if (f !== file) return t;
    if (!t.includes(from)) throw new Error(`mutant source not found: ${from}`);
    return t.replace(from, to);
  } });
  let failed;
  try { failed = stubs(m.rom).filter(([, pass]) => !pass).map(([name]) => name); } catch (e) { failed = [e.message]; }
  check(`mutant "${what}" fails a call`, failed.length > 0, failed.join('; '));
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
