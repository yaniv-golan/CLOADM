/*
 * Disassembler engine for the 6809 and the 6803, one instruction at a time.
 *   disassemble(cpu, addr, { peek, dp, labelOf }) -> { addr, size, bytes, mnemonic, mode, text, target, illegal }
 *   disassembleBlock(cpu, addr, count, opts)      -> the same, `count` instructions one after another
 *
 * peek(addr) -> byte must be side-effect free (the debugger passes a memory read that does not touch I/O
 * registers); every address wraps at 16 bits, as the CPU's program counter does. dp is the 6809's direct
 * page, used to give a direct operand its absolute address (`target`); the text is always the operand as
 * the assembler wants it, so disassemble -> assemble gives back the same bytes.
 * labelOf(addr) -> symbol name or null: a symbol replaces an absolute address in the text.
 *
 * Instruction sets are data (./dis6809.js, ./dis6803.js, ./dis7000.js) plus the rules here. Undocumented opcodes are
 * data (FCB), and they must occupy the bytes this project's CPU core reads for them, so a disassembly list
 * and the CPU stay in step through any byte sequence; tests/disasm.test.js measures the core independently
 * and compares. The 6309 is a new entry in `disassemblers` with its own table.
 */
import { dis6809 } from './dis6809.js';
import { dis6803 } from './dis6803.js';
import { decode7000 } from './dis7000.js';
import { dis6309 } from './dis6309.js';

const hexByte = (v) => '$' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const hexWord = (v) => '$' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');

// an absolute address, as a symbol when one is known there
const addressText = (a, labelOf) => (labelOf && labelOf(a & 0xFFFF)) || hexWord(a & 0xFFFF);
// an operand number: a symbol only where a full address is meant, never inside an index offset
const num = (v) => (v < 0 ? '-' + hexWord(-v) : hexWord(v));

// ---- 6809 indexed addressing: the postbyte and its operand bytes ----
// Returns { size (bytes after the opcode), text, target } or null for a postbyte the part has no mode for.
const IDXREG = ['X', 'Y', 'U', 'S'];
// The offset size the assembler picks for a constant offset (js/asm/isa6809.js indexed): none for 0, 5 bits for
// -16..15 (not indirect), else 8 or 16. An offset stored in another size is shown with the prefix that forces it
// (<< 5 bits, < 8 bits, > 16 bits), so the text reassembles to the same bytes.
const minimalOffset = (v, ind) => (v === 0 ? 0 : !ind && v >= -16 && v <= 15 ? 5 : v >= -128 && v <= 127 ? 8 : 16);
const sizePrefix = (bits, v, ind) => (minimalOffset(v, ind) === bits ? '' : { 5: '<<', 8: '<', 16: '>' }[bits]);
function indexed6809(at, peek, labelOf) {
  const pb = peek(at) & 0xFF;
  const reg = IDXREG[(pb >> 5) & 3];
  const ind = !!(pb & 0x10);
  const wrap = (s) => (ind ? `[${s}]` : s);
  if (!(pb & 0x80)) {                                   // 5-bit signed offset, the commonest form
    let off = pb & 0x1F;
    if (off & 0x10) off -= 32;
    return { size: 1, text: `${sizePrefix(5, off, false)}${off},${reg}`, target: null };
  }
  const b1 = peek(at + 1) & 0xFF;
  const signed8 = (b1 << 24) >> 24;
  const b2 = peek(at + 2) & 0xFF;
  const signed16 = ((b1 << 8) | b2) << 16 >> 16;
  switch (pb & 0x0F) {
    case 0x0: return ind ? null : { size: 1, text: `,${reg}+`, target: null };
    case 0x1: return { size: 1, text: wrap(`,${reg}++`), target: null };
    case 0x2: return ind ? null : { size: 1, text: `,-${reg}`, target: null };
    case 0x3: return { size: 1, text: wrap(`,--${reg}`), target: null };
    case 0x4: return { size: 1, text: wrap(`,${reg}`), target: null };
    case 0x5: return { size: 1, text: wrap(`B,${reg}`), target: null };
    case 0x6: return { size: 1, text: wrap(`A,${reg}`), target: null };
    case 0x8: return { size: 2, text: wrap(`${sizePrefix(8, signed8, ind)}${signed8},${reg}`), target: null };
    case 0x9: return { size: 3, text: wrap(`${sizePrefix(16, signed16, ind)}${signed16},${reg}`), target: null };
    case 0xB: return { size: 1, text: wrap(`D,${reg}`), target: null };
    // PCR: the offset is from the byte after the instruction, so show where it lands
    case 0xC: { const t = (at + 2 + signed8) & 0xFFFF; return { size: 2, text: wrap(`${addressText(t, labelOf)},PCR`), target: t }; }
    case 0xD: {
      const t = (at + 3 + signed16) & 0xFFFF, near = signed16 + 1 >= -128 && signed16 + 1 <= 127;
      return { size: 3, text: wrap(`${near ? '>' : ''}${addressText(t, labelOf)},PCR`), target: t };
    }
    case 0xF: if (!ind) return null; { const a = (b1 << 8) | b2; return { size: 3, text: `[${addressText(a, labelOf)}]`, target: a }; }
  }
  return null;                                          // 7, A and E have no mode
}
// bytes after the opcode that an indexed instruction occupies (the CPU reads one postbyte at least)
function indexed6809Size(at, peek) {
  const ix = indexed6809(at, peek, null);
  return ix ? ix.size : 1;
}

// ---- 6803 indexed addressing: one unsigned offset byte, register X ----
function indexed6803(at, peek) {
  const off = peek(at) & 0xFF;
  return { size: 1, text: off ? `${hexByte(off)},X` : ',X', target: null };
}

// The bytes an undocumented opcode of each part occupies, after its opcode (and page prefix).
// The 6809 core decodes by 16-byte block, so an undocumented opcode reads what its block's operand is;
// page 2's long-branch block reads a 16-bit offset even where the condition is undefined. The 6803 core
// runs its documented illegal opcodes as no-ops, except the immediate forms of the stores, which still
// advance past their operand. These rules are what tests/disasm.test.js checks against the core.
function undoc6809(page, code, at, peek) {
  if (page === 2) return code >= 0x20 && code < 0x30 ? 2 : 0;
  if (page === 3) return 0;
  if (code < 0x10) return 1;                                   // direct block: one address byte
  if (code >= 0x60 && code < 0x70) return indexed6809Size(at, peek);
  if (code >= 0x70 && code < 0x80) return 2;                   // extended block: two address bytes
  if (code >= 0x80) {
    switch ((code >> 4) & 3) {
      case 2: return indexed6809Size(at, peek);
      case 3: return 2;
      default: return 1;                                       // immediate and direct blocks: one byte
    }
  }
  return 0;
}
// The 6309 does not run undefined opcodes: it takes the Illegal Instruction exception, having read no
// operand at all [Atkinson printed pp. 152-153, the opcode map's footnote and note 4; HD63B09EP
// Technical Reference Guide printed p. 7]. That makes an undefined byte a one-byte instruction on page 1
// and a two-byte one behind $10/$11, whatever the 6809 would have made of the same encoding. (The core
// currently runs some of those instead of trapping - see js/asm/dis6309.js for the list.)
function undoc6309() { return 0; }
const UNDOC_6803_2 = new Set([0x87, 0xC7]);
const UNDOC_6803_3 = new Set([0x8F, 0xCD, 0xCF]);
function undoc6803(code) {
  return UNDOC_6803_3.has(code) ? 2 : UNDOC_6803_2.has(code) ? 1 : 0;
}

function decode6809(addr, peek, dp, labelOf, table = dis6809) {
  const bytes = [];
  const take = () => { const v = peek((addr + bytes.length) & 0xFFFF) & 0xFF; bytes.push(v); return v; };
  const first = take();
  const page = first === 0x10 ? 2 : first === 0x11 ? 3 : 1;
  const code = page === 1 ? first : take();
  const entry = table.pages[page - 1][code];
  if (!entry) {
    const undoc = table === dis6309 ? undoc6309 : undoc6809;
    for (let i = 0; i < undoc(page, code, addr + bytes.length, peek); i++) take();
    return data(addr, bytes);
  }
  const [mnemonic, mode] = entry;
  const at = addr + bytes.length;                       // the first operand byte
  let text = mnemonic, target = null;
  switch (mode) {
    case 'inh': break;
    case 'imm8': text = `${mnemonic} #${hexByte(take())}`; break;
    case 'imm16': { const h = take(); text = `${mnemonic} #${hexWord((h << 8) | take())}`; break; }
    // LDQ immediate ($CD) is the 6309's one 32-bit operand: four bytes, big-endian, in a single page-1
    // opcode [HD63B09EP Technical Reference Guide, printed p. 12: "CD LDQ Immediate 5 5"; Atkinson
    // printed p. 93]. The assembler takes the same $nnnnnnnn form.
    case 'imm32': {
      let v = 0; for (let i = 0; i < 4; i++) v = (v * 256) + take();
      text = `${mnemonic} #$${v.toString(16).toUpperCase().padStart(8, '0')}`;
      break;
    }
    case 'dir': {
      const off = take();
      target = ((dp << 8) | off) & 0xFFFF;
      // with a symbol, the text is the absolute address (which reassembles the same way); otherwise the
      // operand stays the byte itself, exactly what the assembler's direct mode wants
      const sym = labelOf && labelOf(target);
      text = `${mnemonic} <${sym || hexByte(off)}`;
      break;
    }
    case 'ext': { const h = take(); const a = (h << 8) | take(); target = a; text = `${mnemonic} >${addressText(a, labelOf)}`; break; }
    case 'rel8': { const o = (take() << 24) >> 24; target = (addr + bytes.length + o) & 0xFFFF; text = `${mnemonic} ${addressText(target, labelOf)}`; break; }
    case 'rel16': { const h = take(); const o = (((h << 8) | take()) << 16) >> 16; target = (addr + bytes.length + o) & 0xFFFF; text = `${mnemonic} ${addressText(target, labelOf)}`; break; }
    case 'idx': {
      const ix = indexed6809(at, peek, labelOf);
      if (!ix) { /* an indexed form with no mode: the whole instruction is data */ return data(addr, [...bytes, ...readBytes(at, indexed6809Size(at, peek), peek)]); }
      for (let i = 0; i < ix.size; i++) take();
      text = `${mnemonic} ${ix.text}`; target = ix.target;
      break;
    }
    // The 6309's AIM/OIM/EIM/TIM ($01/$02/$05/$0B and their $6x/$7x forms): one immediate mask byte, then an
    // ordinary direct, indexed or extended operand. These modes are 'imm8' followed by the operand's own
    // mode, so the mask byte is taken here and the rest reuses the dir/idx/ext handling above rather than
    // repeating the indexed postbyte logic [HD63B09EP Technical Reference Guide, AIM/OIM/EIM/TIM descriptions
    // pp. 5-6 and the opcode table pp. 10-12: "#I8, EA"]. Lengths: 3 direct, 3+ indexed, 4 extended.
    case 'imm8dir': {
      const mask = take(), off = take();
      target = ((dp << 8) | off) & 0xFFFF;
      const sym = labelOf && labelOf(target);
      text = `${mnemonic} #${hexByte(mask)},<${sym || hexByte(off)}`;
      break;
    }
    case 'imm8ext': { const mask = take(); const h = take(); const a = (h << 8) | take(); target = a; text = `${mnemonic} #${hexByte(mask)},>${addressText(a, labelOf)}`; break; }
    case 'imm8idx': {
      const mask = take(), iat = addr + bytes.length;
      const ix = indexed6809(iat, peek, labelOf);
      if (!ix) return data(addr, [...bytes, ...readBytes(iat, indexed6809Size(iat, peek), peek)]);
      for (let i = 0; i < ix.size; i++) take();
      text = `${mnemonic} #${hexByte(mask)},${ix.text}`; target = ix.target;
      break;
    }
    case 'cc': text = `${mnemonic} #${hexByte(take())}`; break;
    case 'post': {
      const pb = take(), r1 = pb >> 4, r2 = pb & 0x0F;
      // the 6309's register file adds W, V, E, F and the zero register, so TFR/EXG and the
      // inter-register instructions (ADDR..CMPR) can name pairs the 6809 has no code for
      // [HD63B09EP Technical Reference Guide, printed p. 4; Atkinson printed p. 135]
      const names = table === dis6309 ? REGNAMES6309 : REGNAMES;
      if (!names[r1] || !names[r2]) return data(addr, bytes);   // an undefined register pair
      text = `${mnemonic} ${names[r1]},${names[r2]}`;
      break;
    }
    case 'stack': {
      const pb = take();
      const list = STACKBITS.filter(([bit]) => pb & bit).map(([bit, name]) => (bit === 0x40 ? (mnemonic.endsWith('U') ? 'S' : 'U') : name));
      text = list.length ? `${mnemonic} ${list.join(',')}` : mnemonic;   // an empty list stacks nothing
      break;
    }
    // The 6309's bit-manipulation instructions (BAND..STBT, $1130-$1137): a postbyte holding the register
    // and the two bit numbers, then one direct address byte [HD63B09EP Technical Reference Guide, "Error
    // Trapping"/instruction descriptions pp. 6-7 and the opcode table pp. 16-17: "x, post-byte, memory
    // location", register in the top two bits, source bit in bits 3-5, destination bit in bits 0-2, and
    // only DIRECT mode allowed]. The text is what the assembler takes: register, source, destination, <addr.
    case 'bitmem': {
      const pb = take(), reg = BITREGS[(pb >> 6) & 3];
      if (!reg) return data(addr, bytes);                  // register code 3 is undefined
      const off = take();
      target = ((dp << 8) | off) & 0xFFFF;
      const sym = labelOf && labelOf(target);
      text = `${mnemonic} ${reg},${(pb >> 3) & 7},${pb & 7},<${sym || hexByte(off)}`;
      break;
    }
    // The 6309's block moves, TFM ($1138-$113B): a postbyte whose halves name the source and destination
    // pointer, and whose opcode picks which of them moves and in which direction. The four opcodes are
    // the four combinations: $1138 both post-increment, $1139 both pre-decrement, $113A source only,
    // $113B destination only [HD63B09EP Technical Reference Guide, printed p. 6 ("TFM r0+,r1",
    // "TFM r0,r1+") and the opcode table printed p. 17; Atkinson printed p. 152 draws the same four
    // variants]. The text is the canonical form for the opcode - what the assembler encodes it back to -
    // because the instruction set has one opcode for each direction pair.
    case 'tfm': {
      const pb = take(), src = TFMREGS[pb >> 4], dst = TFMREGS[pb & 0x0F];
      if (!src || !dst) return data(addr, bytes);          // TFM pointers are X, Y, U, S, D only
      const dir = { 0x38: ['+', '+'], 0x39: ['-', '-'], 0x3A: ['+', ''], 0x3B: ['', '+'] }[code];
      if (!dir) return data(addr, bytes);
      text = `${mnemonic} ${src}${dir[0]},${dst}${dir[1]}`;
      break;
    }
  }
  return { addr, size: bytes.length, bytes, mnemonic, mode, text, target, illegal: false };
}

const REGNAMES = { 0x0: 'D', 0x1: 'X', 0x2: 'Y', 0x3: 'U', 0x4: 'S', 0x5: 'PC', 0x8: 'A', 0x9: 'B', 0xA: 'CC', 0xB: 'DP' };
// the 6309 register file: the 6809 set plus W (6), V (7) and E/F (E/F), and the zero register on both
// its codes (C and D) [HD63B09EP Technical Reference Guide, printed p. 4; Atkinson printed p. 135]. The
// assembler spells the zero register "0", which is what the text must say to reassemble.
const REGNAMES6309 = {
  0x0: 'D', 0x1: 'X', 0x2: 'Y', 0x3: 'U', 0x4: 'S', 0x5: 'PC', 0x6: 'W', 0x7: 'V',
  0x8: 'A', 0x9: 'B', 0xA: 'CC', 0xB: 'DP', 0xC: '0', 0xD: '0', 0xE: 'E', 0xF: 'F',
};
// the register field of a bit-manipulation postbyte: CC, A, B (code 3 is not a register)
const BITREGS = { 0x0: 'CC', 0x1: 'A', 0x2: 'B' };
// the pointer registers TFM accepts, by postbyte code: X, Y, U, S, D (Atkinson printed p. 149, note 10)
const TFMREGS = { 0x0: 'D', 0x1: 'X', 0x2: 'Y', 0x3: 'U', 0x4: 'S' };
const STACKBITS = [[0x01, 'CC'], [0x02, 'A'], [0x04, 'B'], [0x08, 'DP'], [0x10, 'X'], [0x20, 'Y'], [0x40, 'U'], [0x80, 'PC']];
const readBytes = (at, n, peek) => Array.from({ length: n }, (_, i) => peek((at + i) & 0xFFFF) & 0xFF);
const data = (addr, bytes) => ({
  addr, size: bytes.length, bytes: bytes.slice(), mnemonic: 'FCB', mode: 'data',
  text: 'FCB ' + bytes.map(hexByte).join(','), target: null, illegal: true,
});

function decode6803(addr, peek, dp, labelOf) {
  const bytes = [];
  const take = () => { const v = peek((addr + bytes.length) & 0xFFFF) & 0xFF; bytes.push(v); return v; };
  const code = take();
  const entry = dis6803.pages[0][code];
  if (!entry) {
    for (let i = 0; i < undoc6803(code); i++) take();
    return data(addr, bytes);
  }
  const [mnemonic, mode] = entry;
  const at = addr + bytes.length;
  let text = mnemonic, target = null;
  switch (mode) {
    case 'inh': break;
    case 'imm8': text = `${mnemonic} #${hexByte(take())}`; break;
    case 'imm16': { const h = take(); text = `${mnemonic} #${hexWord((h << 8) | take())}`; break; }
    case 'dir': { const off = take(); target = off; text = labelOf && labelOf(off) ? `${mnemonic} <${labelOf(off)}` : `${mnemonic} <${hexByte(off)}`; break; }
    case 'ext': { const h = take(); const a = (h << 8) | take(); target = a; text = `${mnemonic} >${addressText(a, labelOf)}`; break; }
    case 'rel8': { const o = (take() << 24) >> 24; target = (addr + bytes.length + o) & 0xFFFF; text = `${mnemonic} ${addressText(target, labelOf)}`; break; }
    case 'idx': { const ix = indexed6803(at, peek); take(); text = `${mnemonic} ${ix.text}`; break; }
  }
  return { addr, size: bytes.length, bytes, mnemonic, mode, text, target, illegal: false };
}

// The 6309 shares the 6809 engine and rules; only its instruction table differs (./dis6309.js), so it
// goes through the same decoder with that table. The 6809 and 6309 tables have the same three-page
// shape, which is what lets one function serve both.
const DECODERS = { '6809': decode6809, '6803': decode6803, '6309': (addr, peek, dp, labelOf) => decode6809(addr, peek, dp, labelOf, dis6309), '7000': decode7000 };

export function disassemble(cpu, addr, { peek, dp = 0, labelOf = null } = {}) {
  const decode = DECODERS[cpu];
  if (!decode) throw new Error(`no disassembler for CPU ${cpu}`);
  if (typeof peek !== 'function') throw new Error('disassemble: a peek(addr) function is required');
  return decode(addr & 0xFFFF, peek, dp & 0xFF, labelOf);
}

export function disassembleBlock(cpu, addr, count, opts = {}) {
  const out = [];
  let a = addr & 0xFFFF;
  for (let i = 0; i < count; i++) {
    const ins = disassemble(cpu, a, opts);
    out.push(ins);
    a = (a + ins.size) & 0xFFFF;
  }
  return out;
}
