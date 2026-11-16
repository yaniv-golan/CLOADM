// Run: node tests/mc10.test.js  -- 6803 CPU, 6803 assembler and MC-10 machine (no-ROM stub) tests
const Emu = require('./load')();
let fail = 0;
const check = (n, c) => { if (!c) { fail++; console.log('FAIL', n); } else console.log('ok  ', n); };
const hex = (v) => v.toString(16).toUpperCase();

// ---------------- CPU: a bare 64K bus ----------------
function cpuWith(code, at = 0x1000) {
  const mem = new Uint8Array(0x10000);
  mem.set(code, at);
  mem[0xFFFE] = at >> 8; mem[0xFFFF] = at & 0xFF;
  const cpu = new Emu.CPU6803({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } });
  cpu.reset();
  cpu.s = 0x01FF;
  return { cpu, mem, run(n = 1) { let c = 0; for (let i = 0; i < n; i++) c += cpu.step(); return c; } };
}
const asm = (src) => {
  const r = Emu.assemble(src, '6803');
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
};
const prog = (src) => { const r = asm(' ORG $1000\n' + src); return Object.assign(cpuWith(r.segments[0].data), { sym: r.symbols }); };
const { H, I, N, Z, V, C } = Emu.CPU6803.FLAGS;
const flags = (cpu) => cpu.cc & 0x3F;

{
  const t = prog(' LDAA #$80'); const c = t.run();
  check('LDAA # sets N, 2 cycles', t.cpu.a === 0x80 && flags(t.cpu) === (I | N) && c === 2);
}
{
  const t = prog(' CLC\n LDAA #$7F\n ADDA #$01'); t.run(3);
  check('ADDA $7F+1: H N V', t.cpu.a === 0x80 && flags(t.cpu) === (I | H | N | V));
}
{
  const t = prog(' LDAA #$10\n SUBA #$20'); t.run(2);
  check('SUBA borrow: N C', t.cpu.a === 0xF0 && (flags(t.cpu) & (N | C | V | Z)) === (N | C));
}
{
  const t = prog(' SEC\n LDAA #$05\n SBCA #$05'); t.run(3);
  check('SBCA with carry in', t.cpu.a === 0xFF && (t.cpu.cc & C));
}
{
  const t = prog(' LDAA #$09\n ADDA #$01\n DAA'); t.run(3);
  check('DAA 09+01 = 10', t.cpu.a === 0x10 && !(t.cpu.cc & C));
  const u = prog(' LDAA #$99\n ADDA #$01\n DAA'); u.run(3);
  check('DAA 99+01 = 00 carry', u.cpu.a === 0x00 && (u.cpu.cc & C) && (u.cpu.cc & Z));
}
{
  const t = prog(' LDAA #$0F\n LDAB #$09\n MUL'); const c = t.run(3);
  check('MUL $0F*$09 = $0087, C = bit 7, 10 cycles', t.cpu.d === 0x87 && (t.cpu.cc & C) && c === 2 + 2 + 10);
}
{
  const t = prog(' LDD #$8001\n LSRD'); t.run(2);
  check('LSRD: C and V from bit 0', t.cpu.d === 0x4000 && (flags(t.cpu) & (C | V | N)) === (C | V));
  const u = prog(' LDD #$4000\n ASLD'); u.run(2);
  check('ASLD: N V', u.cpu.d === 0x8000 && (flags(u.cpu) & (N | V | C)) === (N | V));
}
{
  const t = prog(' LDX #$1000\n CPX #$2000'); t.run(2);
  check('CPX sets C on the 6801', (t.cpu.cc & C) && (t.cpu.cc & N) && !(t.cpu.cc & Z));
}
{
  const t = prog(' LDX #$1234\n PSHX\n PULA\n PULB'); const c = t.run(4);
  check('PSHX stores high byte at the lower address', t.cpu.a === 0x12 && t.cpu.b === 0x34 && t.mem[0x1FE] === 0x12 && c === 3 + 4 + 4 + 4);
}
{
  const t = prog(' LDAB #$FF\n LDX #$0101\n ABX'); t.run(3);
  check('ABX unsigned', t.cpu.x === 0x0200);
}
{
  const t = prog(' JSR SUB\n NOP\nSUB RTS');
  const c1 = t.run(); const sp = t.cpu.s; const c2 = t.run();
  check('JSR extended 6 cycles, RTS 5', c1 === 6 && sp === 0x01FD && c2 === 5 && t.cpu.pc === 0x1003);
}
{
  const t = prog(' LDAA #$11\n LDAB #$22\n LDX #$3344\n SWI');
  t.mem[0xFFFA] = 0x20; t.mem[0xFFFB] = 0x00;
  t.run(3); const c = t.run();
  const st = Array.from(t.mem.slice(0x1F9, 0x200)).map(hex).join(' ');
  check('SWI: 12 cycles, stacks CC B A X PC, vector $FFFA (' + st + ')', c === 12 && t.cpu.pc === 0x2000 &&
    t.mem[0x1FA] === 0x22 && t.mem[0x1FB] === 0x11 && t.mem[0x1FC] === 0x33 && t.mem[0x1FD] === 0x44 &&
    t.mem[0x1FE] === 0x10 && t.mem[0x1FF] === 0x08 && (t.cpu.cc & I));
}
{
  const t = cpuWith([0x02, 0x01]); const c = t.run();
  check('undefined opcode: 4-cycle no-op on the MC6803', c === 4 && t.cpu.pc === 0x1001);
  const u = cpuWith([0x02]); u.cpu.trapIllegal = true; u.mem[0xFFEE] = 0x30; u.mem[0xFFEF] = 0x00;
  u.run();
  check('trapIllegal: HD6301-style TRAP to $FFEE', u.cpu.pc === 0x3000 && u.mem[0x1FE] === 0x10 && u.mem[0x1FF] === 0x00);
}
{
  const t = prog(' CLR $0080\n INC $0080\n LDAA $0080');
  t.run(3);
  check('on-chip RAM at $80', t.cpu.a === 1 && t.mem[0x80] === 0);
}
// cycle table spot checks (MC6801 data sheet)
{
  const CY = Emu.CPU6803.CYCLES;
  const want = { 0x01: 2, 0x04: 3, 0x08: 3, 0x30: 3, 0x32: 4, 0x38: 5, 0x39: 5, 0x3A: 3, 0x3B: 10, 0x3C: 4, 0x3D: 10, 0x3E: 9, 0x3F: 12,
    0x20: 3, 0x6E: 3, 0x7E: 3, 0x60: 6, 0x7F: 6, 0x86: 2, 0x96: 3, 0xA6: 4, 0xB6: 4, 0x97: 3, 0x83: 4, 0x93: 5, 0xA3: 6, 0xB3: 6,
    0x8C: 4, 0x9C: 5, 0x8D: 6, 0x9D: 5, 0xAD: 6, 0xBD: 6, 0x8E: 3, 0x9E: 4, 0xAE: 5, 0xBE: 5, 0x9F: 4, 0xCC: 3, 0xDC: 4, 0xDD: 4,
    0xED: 5, 0xFD: 5, 0xCE: 3, 0xDF: 4, 0xC3: 4, 0xF3: 6 };
  const bad = Object.entries(want).filter(([o, n]) => CY[o] !== n).map(([o]) => hex(+o));
  check('cycle table (' + (bad.join(' ') || 'all match') + ')', bad.length === 0);
}
// free-running timer, output compare interrupt and WAI
{
  const t = prog(` LDD $09
 ADDD #40
 STD $0B
 LDAA #$08
 STAA $08
 CLI
 WAI
 NOP
ISR LDAA $08
 LDD $0B
 STD $0B
 RTI`);
  const isr = t.sym.get('ISR');
  t.mem[0xFFF4] = isr >> 8; t.mem[0xFFF5] = isr & 0xFF;
  let steps = 0;
  while (t.cpu.pc !== isr && steps++ < 1000) t.run();
  const ctr = t.cpu.counterAt(t.cpu.totalCycles), ocr = t.cpu.ocr;
  check('OCF interrupt from WAI to $FFF4', t.cpu.pc === isr && (t.cpu.read8(0x08) & 0x40));
  check('WAI wake-up takes 4 cycles after the compare (counter ' + hex(ctr) + ', OCR ' + hex(ocr) + ')', ((ctr - ocr) & 0xFFFF) === 4);
  t.run(4);
  check('TCSR read + OCR write clears OCF, RTI returns', !(t.cpu.tcsr & 0x40) && t.cpu.pc === isr - 1);
}
{
  const t = prog(' LDAA $08\n STAA $09\nW LDAA $08\n BITA #$20\n BEQ W');
  let steps = 0;
  t.run(2);
  const start = t.cpu.totalCycles;
  while (!(t.cpu.a & 0x20) && steps++ < 100) t.run(3);
  check('counter write presets $FFF8; TOF when it holds $FFFF', (t.cpu.a & 0x20) && t.cpu.totalCycles - start < 20);
}

// ---------------- assembler encodings (MC6801 data sheet opcodes) ----------------
const ENC = [
  ['LDAA #$12', '86 12'], ['LDAA $12', '96 12'], ['LDAA $1234', 'B6 12 34'], ['LDAA 5,X', 'A6 05'], ['LDAA ,X', 'A6 00'],
  ['LDA >$12', 'B6 00 12'], ['STAA $80', '97 80'], ['STAB 255,X', 'E7 FF'], ['LDD #$1234', 'CC 12 34'], ['STD $80', 'DD 80'],
  ['LDX #$1234', 'CE 12 34'], ['STX $4000', 'FF 40 00'], ['LDS #$01FF', '8E 01 FF'], ['STS 2,X', 'AF 02'], ['CPX ,X', 'AC 00'],
  ['CMPX #1', '8C 00 01'], ['ADDD #1', 'C3 00 01'], ['SUBD $10', '93 10'], ['JSR $20', '9D 20'], ['JSR 0,X', 'AD 00'],
  ['JSR $E000', 'BD E0 00'], ['JMP 3,X', '6E 03'], ['JMP $E000', '7E E0 00'], ['NEG $1234', '70 12 34'], ['NEG 3,X', '60 03'],
  ['NEG $12', '70 00 12'], ['TST $12', '7D 00 12'], ['CLR 0,X', '6F 00'], ['ORAA #1', '8A 01'], ['ORAB #1', 'CA 01'],
  ['EORA #1', '88 01'], ['BITB #1', 'C5 01'], ['ADCA $40', '99 40'], ['SBCB $40', 'D2 40'], ['ABX', '3A'], ['MUL', '3D'],
  ['PSHX', '3C'], ['PULX', '38'], ['LSRD', '04'], ['ASLD', '05'], ['LSLD', '05'], ['TAP', '06'], ['TPA', '07'], ['INX', '08'],
  ['DEX', '09'], ['CLV', '0A'], ['SEV', '0B'], ['CLC', '0C'], ['SEC', '0D'], ['CLI', '0E'], ['SEI', '0F'], ['SBA', '10'],
  ['CBA', '11'], ['TAB', '16'], ['TBA', '17'], ['DAA', '19'], ['ABA', '1B'], ['TSX', '30'], ['INS', '31'], ['PULA', '32'],
  ['PULB', '33'], ['DES', '34'], ['TXS', '35'], ['PSHA', '36'], ['PSHB', '37'], ['RTS', '39'], ['RTI', '3B'], ['WAI', '3E'],
  ['SWI', '3F'], ['NEGA', '40'], ['COMB', '53'], ['ASLA', '48'], ['LSLB', '58'], ['ROLA', '49'], ['DECB', '5A'], ['INCA', '4C'],
  ['TSTB', '5D'], ['CLRA', '4F'], ['NOP', '01'], ['BRA *', '20 FE'], ['BHS *+2', '24 00'], ['BLO *', '25 FE'], ['BSR *', '8D FE'],
  ['BLE *-10', '2F F4'],
];
{
  const bad = [];
  for (const [src, want] of ENC) {
    const r = Emu.assemble(` ORG $1000\n ${src}`, '6803');
    const got = r.ok && r.segments.length ? Array.from(r.segments[0].data).map((b) => hex(b).padStart(2, '0')).join(' ') : 'error';
    if (got !== want) bad.push(`${src}: ${got} (want ${want})`);
  }
  check(`assembler encodes ${ENC.length} instructions` + (bad.length ? ': ' + bad.join('; ') : ''), bad.length === 0);
  for (const src of ['LDAA 300,X', 'STAA #1', 'JSR #1', 'NEG #1', 'NEG <$12', 'LDAA ,Y', 'ABX 1']) {
    const r = Emu.assemble(` ORG $1000\n ${src}`, '6803');
    check(`assembler rejects "${src}"`, !r.ok);
  }
  const r = asm(` ORG $1000\nL1 LDAA FWD\n FCB 'A,"BC"\n FDB L1\nFWD EQU $40\n END L1`);
  check('forward reference keeps extended size; FCB/FCC/FDB; END sets exec',
    Array.from(r.segments[0].data).join(',') === [0xB6, 0, 0x40, 65, 66, 67, 0x10, 0x00].join(',') && r.exec === 0x1000);
}

// ---------------- MC-10 machine in stub mode ----------------
const m = Emu.createMachine('mc10');
m.reset(true);
for (let i = 0; i < 3; i++) m.runFrame();
const screenText = () => { let s = ''; for (let i = 0x4000; i < 0x4200; i++) { const c = m.ram[i] & 0x3F; s += String.fromCharCode(c < 0x20 ? c + 0x40 : c); } return s; };
check('stub banner on screen', screenText().includes('MC-10') && screenText().includes('BUILT-IN STUB'));
check('frame timing: 14934 cycles, 59.92 fps', m.frameCycles === 14934 && Math.abs(m.fps - 59.92) < 0.01);
{
  const r = asm(`
        ORG     $5000
START   LDX     #MSG
LOOP    LDAA    0,X
        BEQ     KEY
        JSR     $F9C6           ; CHROUT
        INX
        BRA     LOOP
KEY     LDAA    #$FD            ; strobe column 1 (A, I, Q, Y, 1, 9)
        STAA    $02
        LDAB    $BFFF
        STAB    $80
        LDAA    #$7F            ; column 7: SHIFT on port 2 bit 1
        STAA    $02
        LDAA    $03
        STAA    $81
        LDAA    #$FE            ; column 0: CTRL
        STAA    $02
        LDAA    $03
        STAA    $82
        LDAA    #$BC            ; RG6 (A/G, GM2-0), CSS 0, sound bit high
        STAA    $BFFF
        BRA     KEY
MSG     FCC     "HELLO FROM THE 6803"
        FCB     13,0
        END     START`);
  m.injectAndRun(r.segments, r.exec);
  m.setKey('A', true); m.setKey('SHIFT', true);
  for (let i = 0; i < 3; i++) m.runFrame();
  check('program printed through CHROUT', screenText().includes('HELLO FROM THE 6803'));
  check('keyboard: A pressed reads row 0 low at $BFFF', m.ram[0x80] === 0xFE);
  check('keyboard: SHIFT on port 2 bit 1', (m.ram[0x81] & 0x02) === 0);
  check('keyboard: no CTRL', (m.ram[0x82] & 0x02) !== 0);
  m.setKey('A', false); m.setKey('LEFT', true);  // CONTROL + A position
  m.runFrame();
  check('LEFT arrow = CTRL + A', m.ram[0x80] === 0xFE && (m.ram[0x82] & 0x02) === 0);
  m.clearKeys();
  check('latch selects RG6', (m.vdgMode() & 0xF8) === 0xF0 && m.latch === 0xBC);
  check('render size', m.render().data.length === m.screenWidth * m.screenHeight);
  check('sound bit 7 on $BFFF', m.soundLevel === 1);
}
// Alice: AZERTY legend on the same matrix
{
  const a = Emu.createMachine('alice');
  check('Alice: A is at the MC-10 Q position, M at ;', a.keyPos.A[0] === 2 && a.keyPos.A[1] === 1 && a.keyPos.M[0] === 5 && a.keyPos.M[1] === 3);
  check('Alice: NTSC timing', a.frameCycles === 14934);
}
// cassette: the tape starts when the cassette bit is polled in a tight loop
{
  const r = asm(`
        ORG     $5000
        LDX     #0
POLL    LDAA    $03
        ANDA    #$10
        CMPA    $80
        BEQ     SAME
        STAA    $80
        INX
SAME    BRA     POLL
        END`);
  const t = Emu.createMachine('mc10');
  t.reset(true); t.runFrame(); t.runFrame();
  t.deck.insert(new Emu.Tape(new Uint8Array(64).fill(0x55), t.tickHz, 'test', t.profile.tape));
  t.injectAndRun(r.segments, r.exec);
  for (let i = 0; i < 10; i++) t.runFrame();
  // 10 frames of 1200/2400 Hz signal: roughly 2 * 1800 * 10/60 = 600 edges
  check('tape plays while polled (motor ' + t.deck.motor + ', ' + t.cpu.x + ' edges)', t.deck.motor && t.cpu.x > 300 && t.cpu.x < 900);
}

// The MAME comparison holds two keys from power-on. Its Lua presses them on MAME's keyboard ports, and the
// two machines' matrices differ (the Alice's A is row 2 col 1; the MC-10's is row 0 col 1), so the spec must
// derive the port and bit from each machine's own layout. When it did not, the lockstep diverged at the first
// keyboard read while this suite and the regression hash - both of which only run our machine - stayed green.
// This checks the derived port and bit against the matrix, which is the half a MAME run cannot do without MAME.
{
  const spec = require('../tools/mame-diff/mc10/spec.js');
  for (const id of ['mc10', 'alice']) {
    const t = spec.trace(id, { regenerate: false });
    check(`${id}: the comparison holds the keys the profile's matrix gives`, JSON.stringify(t.keys) === JSON.stringify(['A', 'SHIFT']), JSON.stringify(t.keys));
    // read the port and mask back out of the generated script and compare with the matrix
    const pos = Emu.keyboards[Emu.profiles[id].keyboard];
    for (const k of t.keys) {
      const [row, col] = pos[k];
      const want = `ports[":pb${col}"].fields) do\n  if (f.mask == 0x${(1 << row).toString(16).toUpperCase()})`;
      check(`${id}: MAME is told to press ${k} on port pb${col} bit ${row}`, t.luaPrelude.includes(want), want.replace(/\n/g, ' '));
    }
    // and the machine really has that key down
    const m = t.machine();
    for (const k of t.keys) {
      const [row, col] = pos[k];
      check(`${id}: the machine starts with ${k} down`, !!(m.keyCols[col] & (1 << row)), `col ${col} row ${row}`);
    }
  }
}

// MAME-compat video latch write: events less than a whole cycle after the instruction's start are brought in first,
// those a whole cycle or more later are not. Past 2^24 ticks a cycle minus 1e-9 rounds to the whole cycle (the
// double's step there is 2^-28, about 3.7e-9), so the event a whole cycle later was fired too early.
for (const base of [1000, 2 ** 24 + 5, 2 ** 30 + 7]) {
  const m = Emu.createMachine('mc10', { mameCompat: true });
  m.reset(true);
  m.queue.length = 0;
  m.cycle = base;
  const fired = [];
  m.on('probe', (arg) => fired.push(arg));
  m.schedule(base + 0.5, 'probe', 'half', 0);
  m.schedule(base + 1, 'probe', 'whole', 0);
  m.write(0xBFFF, m.latch ^ 0x20);                  // a video bit changes
  check(`latch write at tick ${base}: the event half a cycle later fired, the one a whole cycle later did not (${fired})`, fired.join() === 'half');
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
