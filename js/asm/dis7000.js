/*
 * The TMS7000's decoder for the shared disassembler engine (js/asm/disassembler.js), in the same shape as
 * decode6809/decode6803: (addr, peek, dp, labelOf) -> the instruction record.
 *
 * The instruction set is the table in ./isa7000.js, the one the assembler encodes from and the CPU
 * executes, so the three cannot disagree about what a byte means or how long it is. The operand text is
 * written so that assembling it gives back the same bytes (Section 6.2's spellings): %>nn immediates,
 * @>nnnn direct, *Rn indirect, @>nnnn(B) indexed, Rn,Rn dual, and a jump operand written as the target
 * address because that is what the assembler takes (§6.2.5: offset = ta - pcn).
 */
import { OPS_BY_OPCODE } from './isa7000.js';

// form -> the addressing mode the text has to describe; `rel` forms carry an offset byte as well
const MODE_OF = {
  'implied': 'inh', 'A': 'accA', 'B': 'accB', 'Rn': 'reg', 'Rd': 'reg', 'Rp': 'Rp', 'Rs': 'reg',
  'B,A': 'dual', 'Rn,A': 'dual', 'Rn,B': 'dual', 'Rn,Rn': 'dual', 'imm,A': 'dual', 'imm,B': 'dual', 'imm,Rn': 'dual',
  'A,B': 'dual', 'A,Rd': 'dual', 'B,Rd': 'dual',
  'A,Pd': 'periph', 'B,Pd': 'periph', 'imm,Pd': 'periph', 'Ps,A': 'periph', 'Ps,B': 'periph',
  'A,Pn': 'periph', 'B,Pn': 'periph', 'imm,Pn': 'periph',
  'imm,Rp': 'imm16', 'imm(B),Rp': 'imm16b', 'Rp,Rp': 'movdr',
  'direct': 'ext', 'indirect': 'extind', 'indexed': 'extidx',
  'rel': 'rel', 'A,rel': 'relreg', 'B,rel': 'relreg', 'Rn,rel': 'relreg',
};
const modeOf = (mode) => MODE_OF[mode.form] || null;
const isRel = (mode) => !!(mode && mode.rel);

const hexB = (v) => '>' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const hexW = (v) => '>' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');

export function decode7000(addr, peek, dp, labelOf) {
  const bytes = [];
  const take = () => { const v = peek((addr + bytes.length) & 0xFFFF) & 0xFF; bytes.push(v); return v; };
  const op = take();
  const entry = OPS_BY_OPCODE.get(op);
  // an undocumented byte the core executes is still shown as data: the assembler has no spelling for it,
  // so naming it would make a disassembly fail to reassemble to its own bytes
  if (!entry || entry.modes[0].undocumented) {
    return { addr, size: 1, bytes: bytes.slice(), mnemonic: 'FCB', mode: 'data', text: 'FCB ' + hexB(op), target: null, illegal: true };
  }
  const m = entry.modes[0];
  const form = m.form;
  const mode = modeOf(m);
  const mn = entry.mn;
  // the operand bytes, in the order the CPU reads them
  const relBytes = isRel(m) ? 1 : 0;
  const targetAt = (at) => {
    const off = (peek(at) << 24) >> 24;
    return { off, target: (addr + (at - addr) + 1 + off) & 0xFFFF };
  };
  let text = mn, target = null;

  switch (mode) {
    case 'inh':
      break;
    case 'accA': text = `${mn} A`; break;
    case 'accB': text = `${mn} B`; break;
    case 'reg': case 'Rp': text = `${mn} R${take() & 0xFF}`; break;
    case 'rel': {
      const v = take();
      const off = (v << 24) >> 24;
      target = (addr + bytes.length + off) & 0xFFFF;
      text = `${mn} ${(labelOf && labelOf(target)) || hexW(target)}`;
      break;
    }
    case 'relreg': {
      const reg = form[0] === 'R' ? `R${take() & 0xFF}` : form[0];
      const v = take();
      const off = (v << 24) >> 24;
      target = (addr + bytes.length + off) & 0xFFFF;
      text = `${mn} ${reg},${(labelOf && labelOf(target)) || hexW(target)}`;
      break;
    }
    case 'dual': case 'dualrel': {
      text = `${mn} ${dualOperand(form, take, peek, addr, bytes)}`;
      if (isRel(m)) {
        const v = take();
        const off = (v << 24) >> 24;
        target = (addr + bytes.length + off) & 0xFFFF;
        text += `,${(labelOf && labelOf(target)) || hexW(target)}`;
      }
      break;
    }
    case 'periph': case 'periphrel': {
      text = `${mn} ${periphOperand(form, take)}`;
      if (isRel(m)) {
        const v = take();
        const off = (v << 24) >> 24;
        target = (addr + bytes.length + off) & 0xFFFF;
        text += `,${(labelOf && labelOf(target)) || hexW(target)}`;
      }
      break;
    }
    case 'imm16': { const hi = take(); const lo = take(); text = `${mn} %>${(((hi << 8) | lo)).toString(16).toUpperCase().padStart(4, '0')},R${take()}`; break; }
    case 'imm16b': { const hi = take(); const lo = take(); text = `${mn} %>${(((hi << 8) | lo)).toString(16).toUpperCase().padStart(4, '0')}(B),R${take()}`; break; }
    case 'movdr': { const s = take(); text = `${mn} R${s},R${take()}`; break; }
    case 'ext': { const hi = take(); const lo = take(); target = (hi << 8) | lo; text = `${mn} @${(labelOf && labelOf(target)) || hexW(target)}`; break; }
    case 'extind': text = `${mn} *R${take()}`; break;
    case 'extidx': { const hi = take(); const lo = take(); text = `${mn} @${hexW((hi << 8) | lo)}(B)`; break; }
    default: break;
  }
  return { addr, size: bytes.length, bytes, mnemonic: mn, mode, text, target, illegal: false };
}

// the operand text for a dual-operand instruction, read in the order the CPU reads it
function dualOperand(form, take, peek, addr, bytes) {
  switch (form) {
    case 'B,A': case 'A,B': return form;
    case 'Rn,A': return `R${take()},A`;
    case 'Rn,B': return `R${take()},B`;
    case 'Rn,Rn': { const s = take(); return `R${s},R${take()}`; }
    case 'imm,A': return `%${hexB(take())},A`;
    case 'imm,B': return `%${hexB(take())},B`;
    case 'imm,Rn': { const v = take(); return `%${hexB(v)},R${take()}`; }
    case 'A,Rd': return `A,R${take()}`;
    case 'B,Rd': return `B,R${take()}`;
    default: return form;
  }
}
function periphOperand(form, take) {
  switch (form) {
    case 'A,Pd': return `A,P${take()}`;
    case 'B,Pd': return `B,P${take()}`;
    case 'Ps,A': return `P${take()},A`;
    case 'Ps,B': return `P${take()},B`;
    case 'imm,Pd': case 'imm,Pn': { const v = take(); return `%${hexB(v)},P${take()}`; }
    case 'A,Pn': return `A,P${take()}`;
    case 'B,Pn': return `B,P${take()}`;
    default: return form;
  }
}
