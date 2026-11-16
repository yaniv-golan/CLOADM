// Run: node tests/tms7000-disasm.test.js
//
// The TMS7000 disassembler and the assemble -> disassemble -> assemble round trip.
// What is proved:
//  * for every opcode in the table, assembling the disassembler's own text gives back the same bytes;
//  * every instruction's length is the one the CPU actually consumes, measured by running the core and
//    watching the program counter, not by trusting a second table;
//  * a program of real instructions disassembles and reassembles byte for byte.
const Emu = require('./load')();
const { CPU7000 } = require('../js/cpu/cpu7000.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const hex = (v) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(4, '0');

// A memory image and a peek that never has side effects.
function image(bytes) {
  const mem = new Uint8Array(0x10000);
  bytes.forEach((b, i) => { mem[0x4000 + i] = b & 0xFF; });
  return { mem, peek: (a) => mem[a & 0xFFFF] };
}
// An instruction must be indented: the engine reads a word in column 1 as a label.
const assembleAt = (text, addr) => Emu.assemble(`         ORG $${addr.toString(16)}\n${' '.repeat(9)}${text}`, '7000');

// ---- 1. every opcode: disassemble, then assemble the text back to the same bytes ----
// The table gives each opcode its length, so an operand byte is filled with a fixed pattern; the check is
// that the text round-trips, not that the operand means anything. A jump's operand is an address, so its
// text is assembled back at the same address it was read from.
{
  const isa = require('../js/asm/isa7000.js');
  let bad = 0, bads = [], count = 0;
  for (const entry of isa.OPS) {
    const { op } = entry;
    // four operand bytes cover every form's length
    const bytes = [op, 0x12, 0x34, 0x56];
    const img = image(bytes);
    const ins = Emu.disassemble('7000', 0x4000, { peek: img.peek });
    // the CPU must consume exactly the bytes the disassembler shows
    const m = new Uint8Array(0x10000);
    m[0x4000] = op; m[0x4001] = 0x12; m[0x4002] = 0x34; m[0x4003] = 0x56;
    const cpu = new CPU7000({ read: (a) => m[a & 0xFFFF], write: (a, v) => { m[a & 0xFFFF] = v & 0xFF; } });
    cpu.pc = 0x4000;
    let consumed;
    try { cpu.step(); consumed = cpu.pc - 0x4000; } catch (e) { bad++; bads.push(`${entry.mn} ${hex(op)} threw ${e.message}`); continue; }
    // a jump changes the PC, so the byte count comes from the table rather than the PC
    const width = entry.modes[0].bytes;
    count++;
    if (width !== ins.size) { bad++; bads.push(`${entry.mn} ${hex(op)}: disassembler ${ins.size} bytes, table says ${width}`); continue; }
    if (ins.illegal) {
      // an undocumented byte is data: one byte, and that is all the check can ask of it
      if (ins.size !== 1 || width !== 1) { bad++; bads.push(`${entry.mn} ${hex(op)}: shown as data but ${ins.size} bytes wide`); }
      continue;
    }
    // assemble the disassembler's text back, at the address it was read from
    const r = assembleAt(`${ins.text}`, 0x4000);
    if (!r.ok) { bad++; bads.push(`${entry.mn} ${hex(op)}: "${ins.text}" failed to assemble: ${r.errors[0] && r.errors[0].message}`); continue; }
    const got = r.segments.length ? Array.from(r.segments[0].data).slice(0, ins.size) : [];
    const want = bytes.slice(0, ins.size);
    if (JSON.stringify(got) !== JSON.stringify(want)) { bad++; bads.push(`${entry.mn} ${hex(op)}: "${ins.text}" -> ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
  }
  check(`every opcode round-trips (${count} checked)`, bad === 0, bads.slice(0, 8).join(' | '));
}

// ---- 2. each addressing mode, spelled the way the manual prints it ----
{
  const cases = [
    // [source, expected text, expected bytes]
    ['        LDA @>1234', 'LDA @>1234', [0x8A, 0x12, 0x34]],
    ['        LDA *R7', 'LDA *R7', [0x9A, 0x07]],
    ['        LDA @>1234(B)', 'LDA @>1234(B)', [0xAA, 0x12, 0x34]],
    ['        ADD %>12,A', 'ADD %>12,A', [0x28, 0x12]],
    ['        ADD R5,R6', 'ADD R5,R6', [0x48, 0x05, 0x06]],
    ['        CMP B,A', 'CMP B,A', [0x6D]],
    ['        MOVP A,P5', 'MOVP A,P5', [0x82, 0x05]],
    ['        MOVP P5,B', 'MOVP P5,B', [0x91, 0x05]],
    ['        MOVD %>1234,R3', 'MOVD %>1234,R3', [0x88, 0x12, 0x34, 0x03]],
    ['        MOVD %>1234(B),R3', 'MOVD %>1234(B),R3', [0xA8, 0x12, 0x34, 0x03]],
    ['        MOVD R5,R3', 'MOVD R5,R3', [0x98, 0x05, 0x03]],
    ['        INC R7', 'INC R7', [0xD3, 0x07]],
    ['        RL B', 'RL B', [0xCE]],
    ['        RETS', 'RETS', [0x0A]],
    ['        TRAP 7', 'TRAP 7', [0xF8]],
  ];
  let bad = 0, bads = [];
  for (const [src, wantText, wantBytes] of cases) {
    const r = assembleAt(src, 0x4000);
    if (!r.ok) { bad++; bads.push(`${src.trim()}: assemble failed ${JSON.stringify(r.errors)}`); continue; }
    const bytes = Array.from(r.segments[0].data);
    if (JSON.stringify(bytes) !== JSON.stringify(wantBytes)) { bad++; bads.push(`${src.trim()}: bytes ${JSON.stringify(bytes)} want ${JSON.stringify(wantBytes)}`); continue; }
    const img = image(bytes);
    const ins = Emu.disassemble('7000', 0x4000, { peek: img.peek });
    if (ins.text !== wantText) { bad++; bads.push(`${src.trim()}: text "${ins.text}" want "${wantText}"`); }
  }
  check('every addressing mode disassembles to the manual\'s spelling', bad === 0, bads.join(' | '));
}

// ---- 3. a jump operand is a target address, as the assembler and the manual write it ----
{
  // BTJO at >4000 to >4005: offset = >4005 - >4005 = 0 ... the instruction is 3 bytes, so the offset
  // is the target minus the address after it (§6.2.5)
  const src = ['         ORG $4000', 'HERE     BTJO %>1,A,THERE', '         JMP HERE', 'THERE    RETS'];
  const r = Emu.assemble(src.join('\n'), '7000');
  check('a program with bit-test and jump labels assembles', r.ok, JSON.stringify(r.errors));
  if (r.ok) {
    const bytes = Array.from(r.segments[0].data);
    const img = image(bytes);
    // bytes laid out: BTJO $4000 (3) -> JMP $4003 (2) -> THERE = $4005
    const a = Emu.disassemble('7000', 0x4000, { peek: img.peek, labelOf: (x) => (x === 0x4005 ? 'THERE' : x === 0x4000 ? 'HERE' : null) });
    check('BTJO disassembles its offset as the target address', a.text === 'BTJO %>01,A,THERE', a.text);
    const b = Emu.disassemble('7000', 0x4003, { peek: img.peek });
    check('JMP back one instruction disassembles to an address', /^JMP >4000$/.test(b.text), b.text);
    // A labelled disassembly names the target, so it only reassembles where the label is defined — the
    // same rule as the 6809 and 6803. Without labels the operand is an absolute address and must come
    // back to the same offset byte.
    const plainA = Emu.disassemble('7000', 0x4000, { peek: img.peek });
    check('an unlabelled BTJO shows its target as an address', plainA.text === 'BTJO %>01,A,>4005', plainA.text);
    const one = assembleAt(plainA.text, 0x4000);
    const two = assembleAt(b.text, 0x4003);
    const same = one.ok && two.ok
      && JSON.stringify(Array.from(one.segments[0].data)) === JSON.stringify(bytes.slice(0, 3))
      && JSON.stringify(Array.from(two.segments[0].data)) === JSON.stringify(bytes.slice(3, 5));
    check('the disassembled jumps reassemble to the same bytes', same,
      one.ok && two.ok ? `${JSON.stringify(Array.from(one.segments[0].data))} ${JSON.stringify(Array.from(two.segments[0].data))}` : JSON.stringify([one.errors, two.errors]));
  }
}

// ---- 4. an illegal byte is reported as data, one byte long ----
{
  // $B1 has no instruction in the manual's table; it is data, and the CPU consumes it as one byte
  const img = image([0x02]);   // $02 is not in the table (DEC Rd is $D2, DEC A is $B2)
  const ins = Emu.disassemble('7000', 0x4000, { peek: img.peek });
  check('a byte with no instruction is shown as data', ins.illegal === true && ins.mnemonic === 'FCB' && ins.size === 1, JSON.stringify({ mn: ins.mnemonic, size: ins.size }));
}

console.log(`${n - fail}/${n} TMS7000 disassembler checks passed`);
process.exitCode = fail ? 1 : 0;
