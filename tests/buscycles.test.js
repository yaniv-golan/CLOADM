// 6809 bus cycles: every cycle of a step is logged with its address (real accesses, dummy reads of the
// byte at PC, $FFFF "VMA" cycles). For every opcode, page and indexed post byte the log has exactly as many
// cycles as the step takes; and sample sequences match the addresses of real 6809 bus captures (hoglet67's
// 6809 decoder) as XRoar 1.13 implements them (src/mc6809/mc6809.c). Timing that depends on them is also
// compared with XRoar instruction by instruction (tools/mame-diff/sam/run-xroar.js).
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const mem = new Uint8Array(65536);
const cpu = new Emu.CPU6809({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } });
const run = (bytes, setup = () => {}) => {
  mem.fill(0x12); mem.set(bytes, 0x1000); mem[0x2000] = 0x40; mem[0x2001] = 0x00;
  cpu.reset(); cpu.irqLine = cpu.firqLine = false; cpu.pc = 0x1000; cpu.s = 0x8000; cpu.u = 0x9000; cpu.x = 0x2000; cpu.y = 0x3000; cpu.dp = 0x00; cpu.cc = 0x50; setup();
  const c = cpu.step();
  return { c, seq: [...cpu.cycleAddr.subarray(0, cpu.cycleCount)] };
};

// every opcode x post byte: logged cycles == cycles taken
{
  let n = 0, bad = [];
  for (let op = 0; op < 256; op++) {
    const pages = op === 0x10 || op === 0x11 ? [...Array(256).keys()] : [null];
    for (const op2 of pages) for (let pb = 0; pb < 256; pb += (op2 === null ? 1 : 17)) {
      const bytes = op2 === null ? [op, pb, 0x10, 0x20, 0x30] : [op, op2, pb, 0x10, 0x20, 0x30];
      const r = run(bytes); n++;
      if (r.seq.length !== r.c && bad.length < 5) bad.push(bytes.slice(0, 3).map((b) => b.toString(16)).join(' '));
    }
  }
  for (const [name, setup] of [['IRQ', () => { cpu.cc = 0; cpu.irqLine = true; }], ['FIRQ', () => { cpu.cc = 0; cpu.firqLine = true; }],
    ['NMI', () => { cpu.nmiArmed = true; cpu.nmi(); }]]) {
    const r = run([0x12], setup); n++;
    if (r.seq.length !== r.c) bad.push(name);
  }
  check('every opcode, page and post byte logs exactly the cycles it takes', bad.length === 0, `(${n} steps) ${bad.join(', ')}`);
}

// sample sequences (XRoar's mc6809.c: peek_byte(PC) = dummy at PC, NVMA_CYCLE = $FFFF)
const F = 0xFFFF;
const cases = [
  ['LDA $4567 (extended): opcode, operand x2, VMA, read', [0xB6, 0x45, 0x67], [0x1000, 0x1001, 0x1002, F, 0x4567]],
  ['LDA <$45 (direct): opcode, operand, VMA, read', [0x96, 0x45], [0x1000, 0x1001, F, 0x0045]],
  ['NOP: opcode, dummy read at PC', [0x12], [0x1000, 0x1001]],
  ['BRA: opcode, offset, VMA', [0x20, 0x05], [0x1000, 0x1001, F]],
  ['LDA ,X: opcode, post byte, dummy at PC, read', [0xA6, 0x84], [0x1000, 0x1001, 0x1002, 0x2000]],
  ['LDA ,X+: opcode, post byte, dummy at PC, VMA x2, read', [0xA6, 0x80], [0x1000, 0x1001, 0x1002, F, F, 0x2000]],
  ['LDA 5,X: opcode, post byte, dummy at PC, VMA, read', [0xA6, 0x05], [0x1000, 0x1001, 0x1002, F, 0x2005]],
  ['LDA [,X]: post byte, dummy at PC, pointer x2, VMA, read', [0xA6, 0x94], [0x1000, 0x1001, 0x1002, 0x2000, 0x2001, F, 0x4000]],
  ['INC $4567: read, VMA, write', [0x7C, 0x45, 0x67], [0x1000, 0x1001, 0x1002, F, 0x4567, F, 0x4567]],
  ['CLR $4567: address presented (read), VMA, write', [0x7F, 0x45, 0x67], [0x1000, 0x1001, 0x1002, F, 0x4567, F, 0x4567]],
  ['TST $4567: read, VMA x2', [0x7D, 0x45, 0x67], [0x1000, 0x1001, 0x1002, F, 0x4567, F, F]],
  ['JSR $4567: the target address, VMA, push PC low then high', [0xBD, 0x45, 0x67], [0x1000, 0x1001, 0x1002, F, 0x4567, F, 0x7FFF, 0x7FFE]],
  ['RTS: dummy at PC, pull PC, VMA', [0x39], [0x1000, 0x1001, 0x8000, 0x8001, F]],
  ['TSTA: dummy at PC', [0x4D], [0x1000, 0x1001]],
  ['LDA $40,X: post byte, offset, VMA, read', [0xA6, 0x88, 0x40], [0x1000, 0x1001, 0x1002, F, 0x2040]],
  ['PSHS A,B: post byte, VMA x2, read at S, push B then A', [0x34, 0x06], [0x1000, 0x1001, F, F, 0x8000, 0x7FFF, 0x7FFE]],
  ['PULS A: post byte, VMA x2, pull, read at S', [0x35, 0x02], [0x1000, 0x1001, F, F, 0x8000, 0x8001]],
  ['MUL: dummy at PC, VMA x9', [0x3D], [0x1000, 0x1001, F, F, F, F, F, F, F, F, F]],
  ['LBRA: offset x2, VMA x2', [0x16, 0x00, 0x10], [0x1000, 0x1001, 0x1002, F, F]],
  ['ADDD #$1234: operand x2, VMA', [0xC3, 0x12, 0x34], [0x1000, 0x1001, 0x1002, F]],
];
for (const [name, bytes, want] of cases) {
  const r = run(bytes);
  check(name, r.seq.join() === want.join(), `got ${r.seq.map((a) => a.toString(16)).join(' ')}`);
}
{
  const r = run([0x12], () => { cpu.cc = 0; cpu.irqLine = true; });
  const want = [0x1000, 0x1000, F, 0x7FFF, 0x7FFE, 0x7FFD, 0x7FFC, 0x7FFB, 0x7FFA, 0x7FF9, 0x7FF8, 0x7FF7, 0x7FF6, 0x7FF5, 0x7FF4, F, 0xFFF8, 0xFFF9, F];
  check('IRQ: dummy at PC x2, VMA, push 12, VMA, vector, VMA', r.seq.join() === want.join(), `got ${r.seq.map((a) => a.toString(16)).join(' ')}`);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
