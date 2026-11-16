// Run: node tests/cpu.test.js
const Emu = require('./load')();
const { CPU6809 } = Emu;

let failures = 0, count = 0;
function check(name, got, want) {
  count++;
  if (got !== want) { failures++; console.log(`FAIL ${name}: got ${hex(got)} want ${hex(want)}`); }
}
const hex = (v) => (typeof v === 'number' ? '$' + v.toString(16).toUpperCase() : String(v));

// Assemble at $1000, reset vector -> $1000, run until PC hits $FFFF sentinel or step limit
function run(bytes, setup, maxSteps = 100000) {
  const mem = new Uint8Array(0x10000);
  mem.set(bytes, 0x1000);
  mem[0xFFFE] = 0x10; mem[0xFFFF] = 0x00;
  const cpu = new CPU6809({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } });
  cpu.reset();
  cpu.s = 0x8000;
  if (setup) setup(cpu, mem);
  let steps = 0, cycles = 0;
  // program ends with BRA * ($20 $FE)
  while (steps++ < maxSteps) {
    const pc = cpu.pc;
    if (mem[pc] === 0x20 && mem[pc + 1] === 0xFE) break;
    cycles += cpu.step();
  }
  return { cpu, mem, cycles };
}
const END = [0x20, 0xFE];
const F = CPU6809.FLAGS;

// 1. LDA #5; ADDA #3; STA $10 (direct)
{
  const { cpu, mem } = run([0x86, 0x05, 0x8B, 0x03, 0x97, 0x10, ...END]);
  check('add', mem[0x10], 8); check('add A', cpu.a, 8);
}
// 2. fill loop: LDX #$0400; LDA #$60; L: STA ,X+; CMPX #$0600; BNE L
{
  const { mem } = run([0x8E, 0x04, 0x00, 0x86, 0x60, 0xA7, 0x80, 0x8C, 0x06, 0x00, 0x26, 0xF9, ...END]);
  check('fill first', mem[0x400], 0x60); check('fill last', mem[0x5FF], 0x60); check('fill after', mem[0x600], 0);
}
// 3. MUL: LDA #12; LDB #13; MUL -> D=156
{
  const { cpu } = run([0x86, 12, 0xC6, 13, 0x3D, ...END]);
  check('mul', cpu.d, 156);
}
// 4. DAA: LDA #$19; ADDA #$28; DAA -> $47
{
  const { cpu } = run([0x86, 0x19, 0x8B, 0x28, 0x19, ...END]);
  check('daa', cpu.a, 0x47);
}
// 5. subroutine + stack: LDA #1; BSR sub; STA $20; BRA *; sub: PSHS A; LDA #$55; STA $21; PULS A,PC
{
  const { cpu, mem } = run([0x86, 0x01, 0x8D, 0x04, 0x97, 0x20, ...END,
    0x34, 0x02, 0x86, 0x55, 0x97, 0x21, 0x35, 0x82]);
  check('bsr ret A', mem[0x20], 1); check('sub wrote', mem[0x21], 0x55); check('stack bal', cpu.s, 0x8000);
}
// 6. 16-bit: LDD #$1234; ADDD #$0FFF; STD $30; SUBD #$2234 -> $FFFF (borrow)
{
  const { cpu, mem } = run([0xCC, 0x12, 0x34, 0xC3, 0x0F, 0xFF, 0xDD, 0x30, 0x83, 0x22, 0x34, ...END]);
  check('addd', (mem[0x30] << 8) | mem[0x31], 0x2233); check('subd', cpu.d, 0xFFFF);
  check('subd C', cpu.cc & F.C, F.C); check('subd N', cpu.cc & F.N, F.N);
}
// 7. TFR/EXG: LDX #$ABCD; TFR X,Y; EXG A,B (A=0 B=0 initially) ; LDD #$1122; EXG A,B -> $2211
{
  const { cpu } = run([0x8E, 0xAB, 0xCD, 0x1F, 0x12, 0xCC, 0x11, 0x22, 0x1E, 0x89, ...END]);
  check('tfr', cpu.y, 0xABCD); check('exg', cpu.d, 0x2211);
}
// 8. indexed modes: LDX #$2000; LDA #7; STA 5,X; LDB 5,X; LDY #$2005; LDA ,Y; LEAX 16,X ; STX $40
{
  const { cpu, mem } = run([0x8E, 0x20, 0x00, 0x86, 0x07, 0xA7, 0x05, 0xE6, 0x05,
    0x10, 0x8E, 0x20, 0x05, 0xA6, 0xA4, 0x30, 0x88, 0x10, 0x9F, 0x40, ...END]);
  check('idx sta', mem[0x2005], 7); check('idx ldb', cpu.b, 7); check('idx Y', cpu.a, 7);
  check('leax', (mem[0x40] << 8) | mem[0x41], 0x2010);
}
// 9. indirect: [$3000] -> $2100 ; LDA [$3000] ; and pc relative LEAX 4,PCR
{
  const { cpu } = run([0xA6, 0x9F, 0x30, 0x00, 0x30, 0x8C, 0x04, ...END], (c, m) => { m[0x3000] = 0x21; m[0x3001] = 0x00; m[0x2100] = 0x99; });
  check('ext indirect', cpu.a, 0x99); check('pcr', cpu.x, 0x1007 + 4);
}
// 10. long branch + LBSR: LBSR sub (+3) ; BRA * ; sub: LDA #$42 ; RTS
{
  const { cpu } = run([0x17, 0x00, 0x02, ...END, 0x86, 0x42, 0x39]);
  check('lbsr', cpu.a, 0x42); check('lbsr stack', cpu.s, 0x8000);
}
// 11. shifts/rotates: LDA #$81; ASLA (C=1,A=02) ; ROLA (A=05) ; LSRA (A=02,C=1) ; RORA (A=$81)
{
  const { cpu } = run([0x86, 0x81, 0x48, 0x49, 0x44, 0x46, ...END]);
  check('rot', cpu.a, 0x81);
}
// 12. compare/branch signed: LDA #$80 ; CMPA #$01 ; BLT +2 ; LDB #1 ; (skip) ; BGE +2? -> B stays 0
{
  const { cpu } = run([0x86, 0x80, 0x81, 0x01, 0x2D, 0x02, 0xC6, 0x01, ...END]);
  check('blt', cpu.b, 0);
}
// 13. NEG/COM/SEX: LDB #$80 ; SEX -> A=$FF ; NEGB -> $80 V set ; COMA -> 0
{
  const { cpu } = run([0xC6, 0x80, 0x1D, 0x50, 0x43, ...END]);
  check('sex/neg', cpu.b, 0x80); check('com', cpu.a, 0); check('neg V', cpu.cc & F.V, 0); // COMA cleared V
}
// 14. IRQ: setup vector at $FFF8 -> $1100 handler: INC $50; RTI. main: ANDCC #$EF; loop
{
  const mem = new Uint8Array(0x10000);
  mem.set([0x1C, 0xEF, 0x20, 0xFE], 0x1000);
  mem.set([0x0C, 0x50, 0x3B], 0x1100);
  mem[0xFFFE] = 0x10; mem[0xFFFF] = 0; mem[0xFFF8] = 0x11; mem[0xFFF9] = 0;
  const cpu = new CPU6809({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } });
  cpu.reset(); cpu.s = 0x8000;
  for (let i = 0; i < 5; i++) cpu.step();
  cpu.irqLine = true; cpu.step(); cpu.irqLine = false;
  for (let i = 0; i < 5; i++) cpu.step();
  check('irq handled', mem[0x50], 1); check('irq stack', cpu.s, 0x8000); check('irq pc loop', cpu.pc, 0x1002);
}
// 15. PSHU/PULU, ABX, 8-bit SBC
{
  const { cpu } = run([0xCE, 0x30, 0x00, 0x8E, 0x12, 0x34, 0x36, 0x10, 0x8E, 0, 0, 0x37, 0x10,
    0xC6, 0x10, 0x3A, 0x1A, 0x01, 0x86, 0x10, 0x82, 0x05, ...END]);
  check('pulu', cpu.x, 0x1244); check('u restored', cpu.u, 0x3000); check('sbc', cpu.a, 0x0A);
}
// 16. cycle counts: NOP(2) LDA #(2) LDA $10(4) LDX ,Y++(5+3) JSR ext(8) ... simple check
{
  const { cycles } = run([0x12, 0x86, 0x01, 0x96, 0x10, 0xAE, 0xA1, ...END]);
  check('cycles', cycles, 2 + 2 + 4 + 5 + 3);
}

// SYNC (opcode $13) with IRQ masked (ORCC #$10 first), so a pending IRQ only releases the wait.
// Hardware: the MC6809 data sheet's instruction table gives SYNC ">= 4" cycles (this core: opcode, dummy read at PC,
// two $FFFF cycles before the interrupt line is sampled), then one $FFFF cycle to release: 5 when the line is
// already asserted. MAME's m6809 (src/devices/cpu/m6809/base6x09.lst, SYNC: one dummy read, then it waits) gives
// 2 + 1 = 3; config.mameCompat selects that.
for (const mameCompat of [false, true]) {
  const tag = mameCompat ? 'SYNC mameCompat' : 'SYNC hardware';
  const syncCpu = () => {
    const mem = new Uint8Array(0x10000);
    mem.set([0x13, 0x12], 0x1000);           // SYNC; NOP
    mem[0xFFFE] = 0x10; mem[0xFFFF] = 0x00;
    const cpu = new CPU6809({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } });
    cpu.reset(); cpu.mameCompat = mameCompat; cpu.cc |= F.I;
    return cpu;
  };
  // the cycles from the start of SYNC until the CPU is about to execute the NOP after it
  const until = (cpu, onStep) => { let n = 0, steps = 0; while (cpu.pc !== 0x1001 || cpu.syncing) { n += cpu.step(); onStep && onStep(++steps); if (steps > 100) break; } return n; };
  {
    const cpu = syncCpu(); cpu.irqLine = true;          // interrupt already pending
    check(`${tag}: pending IRQ, total cycles`, until(cpu), mameCompat ? 3 : 5);
    check(`${tag}: pending IRQ, no interrupt taken (masked)`, cpu.pc, 0x1001);
  }
  {
    const cpu = syncCpu();                              // waits; the line rises after 10 waiting steps
    const n = until(cpu, (k) => { if (k === 11) cpu.irqLine = true; });
    check(`${tag}: waits, then resumes one cycle after the line rises`, n, (mameCompat ? 2 : 4) + 10 + 1);
    check(`${tag}: resumed at the next instruction`, cpu.pc, 0x1001);
  }
  {
    // An UNMASKED interrupt ends the SYNC wait and is then taken, vectoring to $FFF8. The lockstep is the
    // authority on the cycle total (tools/mame-diff/6309's SYNC case, on all four HD6309 machines, matches
    // MAME cycle for cycle); this pins the two facts a mistake would break: the interrupt IS taken, and the
    // SYNC step ends at the vector rather than falling through to the next instruction.
    // syncCpu() builds its memory inside a closure, so the vector is set through the CPU's own bus writes,
    // which land in that same memory.
    const cpu = syncCpu();
    cpu.s = 0x8000;                                     // a stack the frame fits in (syncCpu leaves it at 0)
    cpu.cc &= ~(F.I | F.F);                             // IRQ unmasked: the interrupt will be taken
    cpu.bus.write(0xFFF8, 0x30); cpu.bus.write(0xFFF9, 0x00);
    cpu.bus.write(0x3000, 0x39);                        // RTS at the vector's target: a clean landing
    cpu.irqLine = true;
    const before = cpu.s;
    const n = cpu.step();                               // the SYNC step: wait, entry and vector
    check(`${tag}: an unmasked interrupt out of a SYNC is taken (PC at the vector's target)`, cpu.pc, 0x3000);
    check(`${tag}: the whole state was stacked (12 bytes in emulation mode)`, before - cpu.s, 12);
    // 19 is the taken-entry figure with no wait left over, and it is what the lockstep measures from a SYNC
    // whose interrupt is already asserted (tools/mame-diff/6309 on all four HD6309 machines).
    check(`${tag}: the SYNC step costs the entry and no more (the wait was empty)`, n, 19);
  }
}

// NMI after reset: ignored until the program loads S (LDS, or TFR/EXG/LEAS into S). MAME 0.264 m6809.cpp
// execute_set_input: the NMI edge is latched only once m_lds_encountered; the MC6809 data sheet (NMI): "not
// recognized until after the first program load of the hardware stack pointer". An NMI edge before that is lost,
// not taken later.
{
  const mem = new Uint8Array(0x10000);
  // $1000: NOP; LDS #$7F00; NOP; NOP; BRA *     NMI vector -> $2000: BRA *
  mem.set([0x12, 0x10, 0xCE, 0x7F, 0x00, 0x12, 0x12, 0x20, 0xFE], 0x1000);
  mem.set([0x20, 0xFE], 0x2000);
  mem[0xFFFE] = 0x10; mem[0xFFFF] = 0x00; mem[0xFFFC] = 0x20; mem[0xFFFD] = 0x00;
  const cpu = new CPU6809({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } });
  cpu.reset();
  cpu.step();                       // NOP
  cpu.nmi();                        // an edge before S is loaded
  cpu.step();                       // LDS #$7F00
  cpu.step();                       // NOP
  check('NMI before LDS: ignored, not taken after it', cpu.pc, 0x1006);
  cpu.nmi();                        // after LDS: taken
  cpu.step();
  check('NMI after LDS: taken', cpu.pc, 0x2000);
}

// CLR on memory reads its operand before writing 0 (MC6809 data sheet cycle-by-cycle table: read, VMA, write; MAME
// CLR8 @read_operand): an I/O register sees one read, then the write, in 6 cycles (CLR extended: 7)
for (const [name, bytes, cyc] of [['CLR $40 (direct)', [0x0F, 0x40], 6], ['CLR $0040 (extended)', [0x7F, 0x00, 0x40], 7], ['CLR ,X (indexed)', [0x6F, 0x84], 6]]) {
  const log = [];
  const mem = new Uint8Array(0x10000);
  mem.set(bytes, 0x1000); mem[0xFFFE] = 0x10; mem[0xFFFF] = 0x00; mem[0x40] = 0x55;
  const cpu = new CPU6809({ read: (a) => { if (a === 0x40) log.push('r'); return mem[a]; }, write: (a, v) => { if (a === 0x40) log.push('w' + v); mem[a] = v; } });
  cpu.reset(); cpu.x = 0x40; cpu.dp = 0;
  const c = cpu.step();
  check(`${name}: reads, then writes 0`, log.join(','), 'r,w0');
  check(`${name}: cycles`, c, cyc);
}

console.log(`${count - failures}/${count} checks passed`);
process.exitCode = failures ? 1 : 0;
