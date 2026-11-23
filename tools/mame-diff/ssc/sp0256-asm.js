// sp0256-asm.js: our own assembler for SP0256 programs (its images are what the comparisons install as
// "sp0256-al2.bin", MAME's file name; never a real AL2), so the speech chip can be tested and compared with MAME on
// images this project builds (AGENTS.md hard rule 1: the SP0256-AL2's program is copyrighted and never used here).
//
// The image is the AL2's 2 KB, at $1000-$17FF of the chip's address space (MAME's coco_ssc region; the Pak's
// sp0256 socket). Entry n is the 16-bit word at $1000 + 2n, so an allophone number n (0-63, what the Pak loads)
// starts there; entries usually hold a JMP to the code, which starts after the 64 entries, at $1080.
//
// The encoding is js/chips/sp0256.js's: bits are emitted LSB first; an instruction is its 4-bit immediate, then its
// 4-bit opcode; parameter fields follow in the order and widths FIELDS gives for the opcode and the current mode;
// branch and page addresses are emitted most significant bit first.
//
// A program is a list of statements (plain objects, so a case reads as data):
//   { label: 'name' }                       a label at the current bit position (a branch target must be byte-
//                                           aligned: JMP and JSR land on bytes; `align` pads with zero bits)
//   { align: true }
//   { entry: n, to: 'label' }               entry n: JMP label (written at $1000 + 2n, wherever the program is)
//   { op: 'SETMODE', mode: 0-3, msb: 0-3 }  the M/P mode for the loads after it, and the repeat count's high bits
//                                           for the NEXT instruction only
//   { op: 'LOAD_4', repeat: 1-15, fields: [v, v, ...] }   any load: its fields' raw values, in FIELDS order for the
//                                           current mode (clear entries take no value); `repeat` 0 reads no fields
//   { op: 'PAUSE', repeat: n }
//   { op: 'JMP' | 'JSR', to: 'label' }, { op: 'RTS' }, { op: 'PAGE', page: 1-15 }
const { OP, FIELDS } = require('../../../js/chips/sp0256.js');

const ROM_BASE = 0x1000, ROM_SIZE = 0x800, CODE_START = 0x1080;
const rev4 = (v) => ((v & 1) << 3) | ((v & 2) << 1) | ((v & 4) >> 1) | ((v & 8) >> 3);
const rev8 = (v) => (rev4(v & 15) << 4) | rev4(v >> 4);

// program -> { image (2 KB), end (bit position after the code), labels }
function assemble(program) {
  const out = new Uint8Array(ROM_SIZE);
  let bitPos = (CODE_START - ROM_BASE) * 8;
  const labels = new Map(), fixups = [], entries = [];
  let mode = 0;
  const put = (value, n) => {
    for (let i = 0; i < n; i++, bitPos++) {
      if (bitPos >= ROM_SIZE * 8) throw new Error('sp0256-asm: the program does not fit in 2 KB');
      if ((value >> i) & 1) out[bitPos >> 3] |= 1 << (bitPos & 7);
    }
  };
  const byte = (immed, op) => { put(immed, 4); put(op, 4); };
  // a branch: the immediate and the next 8 bits hold the target's bits 11-0, most significant first
  const branch = (op, label) => {
    fixups.push({ at: bitPos, label, op });
    put(0, 16);
  };
  for (const st of program) {
    if ('label' in st) { labels.set(st.label, bitPos); continue; }
    if (st.align) { bitPos = (bitPos + 7) & ~7; continue; }
    if ('entry' in st) { entries.push(st); continue; }
    const op = st.op === 'RTS' || st.op === 'PAGE' ? OP.RTS_PAG : OP[st.op];
    if (op === undefined) throw new Error(`sp0256-asm: unknown instruction ${st.op}`);
    if (st.op === 'SETMODE') {
      if (!(st.mode >= 0 && st.mode <= 3) || !((st.msb || 0) >= 0 && (st.msb || 0) <= 3)) throw new Error('sp0256-asm: SETMODE mode and msb are 0-3');
      // the chip's mode register takes the immediate's bits 3 and 2 as its M/P bits and bits 1-0 as the repeat MSBs
      byte(((st.mode & 1) << 3) | ((st.mode & 2) << 1) | (st.msb || 0), op);
      mode = st.mode;
      continue;
    }
    if (st.op === 'JMP' || st.op === 'JSR') { branch(op, st.to); continue; }
    if (st.op === 'RTS') { byte(0, op); continue; }
    if (st.op === 'PAGE') {
      if (!(st.page >= 1 && st.page <= 15)) throw new Error('sp0256-asm: PAGE takes 1-15');
      byte(rev4(st.page), op);
      continue;
    }
    const repeat = st.repeat || 0;
    if (repeat < 0 || repeat > 15) throw new Error(`sp0256-asm: ${st.op} repeat is 0-15 (the high bits come from SETMODE)`);
    byte(repeat, op);
    if (!repeat) continue;
    const fields = FIELDS[op] ? FIELDS[op][mode].filter((x) => x.length === 4) : [];
    const values = st.fields || [];
    if (values.length !== fields.length) throw new Error(`sp0256-asm: ${st.op} in mode ${mode} takes ${fields.length} fields, given ${values.length}`);
    fields.forEach(([, bits], i) => {
      if (values[i] < 0 || values[i] >= (1 << bits)) throw new Error(`sp0256-asm: ${st.op} field ${i} is ${bits} bits; ${values[i]} does not fit`);
      put(values[i], bits);
    });
  }
  const end = bitPos;
  for (const fx of fixups) {
    if (!labels.has(fx.label)) throw new Error(`sp0256-asm: no label ${fx.label}`);
    const at = labels.get(fx.label);
    if (at & 7) throw new Error(`sp0256-asm: ${fx.label} is not on a byte boundary (a branch lands on one)`);
    const target = ROM_BASE + (at >> 3);
    bitPos = fx.at;
    byte(rev4((target >> 8) & 15), fx.op);
    put(rev8(target & 0xff), 8);
  }
  for (const e of entries) {
    if (!(e.entry >= 0 && e.entry < 64)) throw new Error('sp0256-asm: entries are 0-63');
    if (!labels.has(e.to)) throw new Error(`sp0256-asm: no label ${e.to}`);
    const at = labels.get(e.to);
    if (at & 7) throw new Error(`sp0256-asm: ${e.to} is not on a byte boundary`);
    const target = ROM_BASE + (at >> 3);
    bitPos = e.entry * 16;
    byte(rev4((target >> 8) & 15), OP.JMP);
    put(rev8(target & 0xff), 8);
  }
  return { image: out, end, labels };
}

module.exports = { assemble, ROM_BASE, ROM_SIZE, CODE_START };
