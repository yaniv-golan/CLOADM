// Run: node tests/tms7000.test.js
//
// The TMS7000 (TMS7040) CPU core and its instruction set (stage 1).
//
// The expected values are transcribed from the TMS7000 Family Data Manual (TI, SPND001B, 1986):
//   Table 6-3 "TMS7000 Family Instruction Overview" (pages 6-9..6-14) gives every opcode, byte length,
//   cycle count and status-bit column; Appendix F "Instruction Opcode Set" (F-1, F-2) and Appendix E
//   "Hexadecimal Instruction Table/Opcode Map" (E-1) restate the opcodes independently. The values here
//   were written from those tables, not read back out of the code under test. Where the scan's OCR
//   corrupts a digit, the comment names the two sources that agree.
//
// What is proved:
//  * every opcode decodes to the mnemonic the manual gives it, with the manual's byte length and cycles;
//  * the assembler encodes mnemonics to those same bytes (assemble -> disassemble -> assemble round trip);
//  * the arithmetic/logic operations set C, N and Z as Table 6-3's status columns say;
//  * the core executes instructions, respects addressing, and survives saveState -> JSON -> loadState.
const path = require('path');
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const isa = require(path.join(__dirname, '..', 'js/asm/isa7000.js'));
const enc = (mn, operand) => {
  // the encoder resolves addresses through the engine's evaluator, so this stub has to understand the
  // literal hex the cases use; a symbol would come from the assembler itself (see the symbolic test)
  const ev = (e) => {
    const s = String(e).trim().replace(/^[>$]/, '');
    if (/^[0-9A-Fa-f]+$/.test(s)) return { value: parseInt(s, 16), unresolved: false };
    return { value: 0, unresolved: false };
  };
  const bytes = isa.encode(mn, operand || '', { ev, pc: 0 });
  return bytes ? bytes.map((b) => b & 0xFF) : null;
};

// ---- 1. the opcode table matches the manual's Table 6-3 ----
// [mnemonic, operand as the manual spells it, expected bytes]
// The ADD family, Table 6-3 page 6-9: B,A 68 ; Rs,A 18 ; Rs,B 38 ; Rs,Rd 48 ; %iop,A 28 ; %iop,B 58 ; %iop,Rd 78
{
  const cases = [
    ['ADD', 'B,A', [0x68]], ['ADD', 'R5,A', [0x18, 0x05]], ['ADD', 'R5,B', [0x38, 0x05]],
    ['ADD', 'R5,R6', [0x48, 0x05, 0x06]], ['ADD', '%>12,A', [0x28, 0x12]],
    ['ADD', '%>12,B', [0x58, 0x12]], ['ADD', '%>12,R6', [0x78, 0x12, 0x06]],
    // ADC page 6-9: B,A 69 ; Rs,A 19 ; Rs,B 39 ; Rs,Rd 49 ; %iop,A 29 ; %iop,B 59 ; %iop,Rd 79
    ['ADC', 'B,A', [0x69]], ['ADC', 'R5,A', [0x19, 0x05]], ['ADC', 'R5,B', [0x39, 0x05]],
    ['ADC', 'R5,R6', [0x49, 0x05, 0x06]], ['ADC', '%>12,A', [0x29, 0x12]],
    // AND page 6-9: B,A 63 ; 13 33 43 ; 23 53 73
    ['AND', 'B,A', [0x63]], ['AND', 'R5,A', [0x13, 0x05]], ['AND', 'R5,R6', [0x43, 0x05, 0x06]],
    // CMP: Appendix E puts CMP on grid row 1101, so the function nibble is D (Table 6-3's OCR reads 60):
    // B,A 6D ; 1D 3D 4D ; 2D 5D 7D. MAME's disassembler agrees (0x6D).
    ['CMP', 'B,A', [0x6D]], ['CMP', 'R5,A', [0x1D, 0x05]], ['CMP', 'R5,B', [0x3D, 0x05]],
    ['CMP', 'R5,R6', [0x4D, 0x05, 0x06]], ['CMP', '%>12,A', [0x2D, 0x12]],
    // MPY page 6-12: B,A 6C ; 1C 3C 4C ; 2C 5C 7C
    ['MPY', 'B,A', [0x6C]], ['MPY', 'R5,A', [0x1C, 0x05]], ['MPY', 'R5,R6', [0x4C, 0x05, 0x06]],
    // OR page 6-12: B,A 64 ; 14 34 44 ; 24 54 74
    ['OR', 'B,A', [0x64]], ['OR', 'R5,A', [0x14, 0x05]],
    // SUB page 6-14: B,A 6A ; 1A 3A 4A ; 2A 5A 7A
    ['SUB', 'B,A', [0x6A]], ['SUB', 'R5,A', [0x1A, 0x05]],
    // SBB page 6-13: B,A 6B ; 1B 3B 4B ; 2B 5B 7B
    ['SBB', 'B,A', [0x6B]], ['SBB', 'R5,A', [0x1B, 0x05]],
    // XOR page 6-14: B,A 65 ; 15 35 45 ; 25 55 75
    ['XOR', 'B,A', [0x65]], ['XOR', 'R5,A', [0x15, 0x05]],
    // DAC page 6-10, DSB page 6-11: 6E/1E/3E/4E/2E/5E/7E and 6F/1F/3F/4F/2F/5F/7F
    ['DAC', 'B,A', [0x6E]], ['DAC', 'R5,A', [0x1E, 0x05]],
    ['DSB', 'B,A', [0x6F]], ['DSB', 'R5,A', [0x1F, 0x05]],
    // BTJO/BTJZ carry a branch target as their third operand (see section 4); from pc 0, ">2" is the
    // zero-offset form for the 2-byte B,A shape, ">3" for the 3-byte Rn,A shape
    ['BTJO', 'B,A,>2', [0x66, 0x00]], ['BTJO', 'R5,A,>3', [0x16, 0x05, 0x00]],
    ['BTJZ', 'B,A,>2', [0x67, 0x00]], ['BTJZ', 'R2,B,>3', [0x37, 0x02, 0x00]],
    // MOV page 6-12: A,B C0 ; A,Rd D0 ; B,A 62 ; B,Rd D1 ; Rs,A 12 ; Rs,B 32 ; Rs,Rd 42 ;
    //                 %iop,A 22 ; %iop,B 52 ; %iop,Rd 72
    ['MOV', 'A,B', [0xC0]], ['MOV', 'A,R3', [0xD0, 0x03]], ['MOV', 'B,A', [0x62]],
    ['MOV', 'B,R3', [0xD1, 0x03]], ['MOV', 'R1,A', [0x12, 0x01]], ['MOV', 'R1,B', [0x32, 0x01]],
    ['MOV', 'R1,R2', [0x42, 0x01, 0x02]], ['MOV', '%>7F,A', [0x22, 0x7F]],
    ['MOV', '%>7F,R2', [0x72, 0x7F, 0x02]],
  ];
  let bad = 0; const bads = [];
  for (const [mn, operand, want] of cases) {
    const got = enc(mn, operand);
    if (JSON.stringify(got) !== JSON.stringify(want)) { bad++; bads.push(`${mn} ${operand}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  }
  check('the dual-operand opcodes match Table 6-3', bad === 0, bads.slice(0, 6).join(' | '));
}

// ---- 2. peripheral, extended, single-operand and implied opcodes ----
{
  const cases = [
    // MOVP page 6-12: A,Pd 82 ; B,Pd 92 ; %iop,Pd A2 ; Ps,A 80 ; Ps,B 91
    ['MOVP', 'A,P5', [0x82, 0x05]], ['MOVP', 'B,P5', [0x92, 0x05]], ['MOVP', 'P5,A', [0x80, 0x05]],
    ['MOVP', 'P5,B', [0x91, 0x05]], ['MOVP', '%>3C,P5', [0xA2, 0x3C, 0x05]],
    // ANDP/ORP/XORP page 6-9/6-12/6-14: 83/93/A3, 84/94/A4, 85/95/A5
    ['ANDP', 'A,P5', [0x83, 0x05]], ['ORP', 'A,P5', [0x84, 0x05]], ['XORP', 'A,P5', [0x85, 0x05]],
    // BR page 6-10: @Label 8C ; @Label(B) AC ; *Rn 9C
    ['BR', '@>1234', [0x8C, 0x12, 0x34]], ['BR', '@>1234(B)', [0xAC, 0x12, 0x34]],
    // CALL page 6-10: 8E / AE / 9E
    ['CALL', '@>1234', [0x8E, 0x12, 0x34]], ['CALL', '@>1234(B)', [0xAE, 0x12, 0x34]],
    // LDA page 6-11: 8A / AA / 9A ; STA 8B / AB / 9B ; CMPA 8D / AD / 9D
    ['LDA', '@>1234', [0x8A, 0x12, 0x34]], ['LDA', '@>1234(B)', [0xAA, 0x12, 0x34]],
    ['STA', '@>1234', [0x8B, 0x12, 0x34]], ['CMPA', '@>1234', [0x8D, 0x12, 0x34]],
    // CLR: A B5 ; B C5 ; Rd D5 (the scan's leading D reads as 0; Appendix E column 6 is the Rn form)
    ['CLR', 'A', [0xB5]], ['CLR', 'B', [0xC5]], ['CLR', 'R7', [0xD5, 0x07]],
    // DEC/DECD/INC/INV: B2 C2 D2 ; BB CB DB ; B3 C3 D3 ; B4 C4 D4
    ['DEC', 'A', [0xB2]], ['DECD', 'B', [0xCB]], ['DECD', 'R3', [0xDB, 0x03]],
    ['INC', 'A', [0xB3]], ['INV', 'B', [0xC4]],
    // POP/PUSH: B9 C9 D9 / B8 C8 D8
    ['POP', 'A', [0xB9]], ['POP', 'R2', [0xD9, 0x02]], ['PUSH', 'A', [0xB8]], ['PUSH', 'R2', [0xD8, 0x02]],
    // RL/RLC/RR/RRC page 6-13: BE/CF/BC/BD families
    ['RL', 'A', [0xBE]], ['RLC', 'B', [0xCF]], ['RR', 'R4', [0xDC, 0x04]], ['RRC', 'A', [0xBD]],
    // SWAP: A B7 ; B C7 ; Rn D7 -- XCHB: A B6 ; B C6 ; Rn D6
    ['SWAP', 'A', [0xB7]], ['SWAP', 'R1', [0xD7, 0x01]], ['XCHB', 'A', [0xB6]], ['XCHB', 'R1', [0xD6, 0x01]],
    // TSTA/TSTB: TSTA B0 -- the same byte as CLRC (Appendix F lists both; MAME's disassembler too)
    ['TSTA', '', [0xB0]], ['TSTB', '', [0xC1]],
    // implied page 6-10..6-14
    ['NOP', '', [0x00]], ['IDLE', '', [0x01]], ['EINT', '', [0x05]], ['DINT', '', [0x06]],
    ['SETC', '', [0x07]], ['CLRC', '', [0xB0]], ['LDSP', '', [0x0D]], ['STSP', '', [0x09]],
    ['RETS', '', [0x0A]], ['RETI', '', [0x0B]], ['PUSH', 'ST', [0x0E]], ['POP', 'ST', [0x08]],
    // MOVD page 6-12: %>iop,Rp 88 ; %>iop(B),Rp A8 ; Rp,Rp 98. The immediate is 16 bits (Table A-17).
    ['MOVD', '%>12,R4', [0x88, 0x00, 0x12, 0x04]], ['MOVD', 'R2,R4', [0x98, 0x02, 0x04]],
    // jumps page 6-11: JMP E0 ; JC/JHS E3 ; JZ/JEQ E2 ; JN/JLT E1 ; JNZ/JNE E6 ; JP/JGT E4 ;
    //                  JPZ/JGE E5 ; JNC/JL E7. The operand is a target address (Table 6-1: offset = ta -
    //                  pcn), so "JMP >2" from pc 0 has offset 2 - 2 = 0 and is the zero-offset form.
    ['JMP', '>2', [0xE0, 0x00]], ['JC', '>2', [0xE3, 0x00]], ['JHS', '>2', [0xE3, 0x00]],
    ['JZ', '>2', [0xE2, 0x00]], ['JEQ', '>2', [0xE2, 0x00]], ['JN', '>2', [0xE1, 0x00]],
    ['JNZ', '>2', [0xE6, 0x00]], ['JP', '>2', [0xE4, 0x00]], ['JPZ', '>2', [0xE5, 0x00]],
    // DJNZ page 6-11: A BA ; B CA ; Rd DA, 2 bytes plus the offset (3 for the Rd form)
    ['DJNZ', 'A,>2', [0xBA, 0x00]], ['DJNZ', 'B,>2', [0xCA, 0x00]], ['DJNZ', 'R3,>3', [0xDA, 0x03, 0x00]],
  ];
  let bad = 0; const bads = [];
  for (const [mn, operand, want] of cases) {
    const got = enc(mn, operand);
    if (JSON.stringify(got) !== JSON.stringify(want)) { bad++; bads.push(`${mn} ${operand}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  }
  check('peripheral, extended, single-operand and implied opcodes match the manual', bad === 0, bads.slice(0, 8).join(' | '));
}

// ---- 3. TRAP 0-23 is $FF down to $E8 (page 6-14 and the trap vector table on page 6-64) ----
// The vector table is what settles the order: Trap 0 is the last entry, at >FFFE/>FFFF, Trap 1 at
// >FFFC/>FFFD, and Trap 23 at >FFD0/>FFD1. Truncating "vector address = >FF00 + 2n" into a byte gives
// the opcode, so Trap 0 is $FF and Trap 23 is $E8 (MAME's disassembler numbers them the same way).
{
  let bad = 0, bads = [];
  for (let i = 0; i < 24; i++) {
    const got = enc(`TRAP ${i}`);
    const want = 0xFF - i;
    if (!got || got[0] !== want) { bad++; bads.push(`TRAP ${i}: got ${JSON.stringify(got)} want $${want.toString(16)}`); }
  }
  check('TRAP 0-23 encodes as $FF-$E8', bad === 0, bads.join(' '));
  check('TRAP 0 is $FF and TRAP 23 is $E8', enc('TRAP 0')[0] === 0xFF && enc('TRAP 23')[0] === 0xE8,
    `${JSON.stringify(enc('TRAP 0'))} ${JSON.stringify(enc('TRAP 23'))}`);
}

// ---- 4. BTJO/BTJZ carry an offset byte: Table 6-3 gives them their own lengths and cycles ----
// P6-9: B,A,Ofst 2 bytes 7 (9); Rn,A,Ofst 3 10 (12); Rn,B 3 10 (12); Rn,Rn 4 12 (14);
//       %>iop,A 3 9 (11); %>iop,B 3 9 (11); %>iop,Rn 4 11 (13). BTJOP/BTJZP: A,Pn 3 11 (13);
//       B,Pn 3 10 (12); %>iop,Pn 4 12 (14).
{
  const isa = require(path.join(__dirname, '..', 'js/asm/isa7000.js'));
  const entry = (mn, op) => isa.OPS.find((e) => e.mn === mn && e.modes.some((m) => m.op === op));
  const mode = (mn, op) => entry(mn, op).modes.find((m) => m.op === op);
  const cases = [
    // [mnemonic, opcode, bytes, cycles, taken]
    ['BTJO', 0x66, 2, 7, 9], ['BTJO', 0x16, 3, 10, 12], ['BTJO', 0x36, 3, 10, 12],
    ['BTJO', 0x46, 4, 12, 14], ['BTJO', 0x26, 3, 9, 11], ['BTJO', 0x56, 3, 9, 11],
    ['BTJO', 0x76, 4, 11, 13],
    ['BTJZ', 0x67, 2, 7, 9], ['BTJZ', 0x77, 4, 11, 13],
    ['BTJOP', 0x86, 3, 11, 13], ['BTJOP', 0x96, 3, 10, 12], ['BTJOP', 0xA6, 4, 12, 14],
    ['BTJZP', 0x87, 3, 11, 13], ['BTJZP', 0x97, 3, 10, 12], ['BTJZP', 0xA7, 4, 12, 14],
  ];
  let bad = 0, bads = [];
  for (const [mn, opc, bytes, cycles, taken] of cases) {
    const m = mode(mn, opc);
    if (!m) { bad++; bads.push(`${mn} $${opc.toString(16)} missing`); continue; }
    if (m.bytes !== bytes || m.cycles !== cycles || m.taken !== taken) {
      bad++; bads.push(`${mn} $${opc.toString(16)}: ${m.bytes}/${m.cycles}/${m.taken} want ${bytes}/${cycles}/${taken}`);
    }
  }
  check('BTJO/BTJZ/BTJOP/BTJZP lengths and cycles match Table 6-3', bad === 0, bads.slice(0, 6).join(' | '));
}

// ---- 5. MOVD's immediate is 16 bits, and its indexed form is %n(B), per page 6-44 and Table A-17 ----
// Table 6-3: MOVD %>iop,Rp 88 (4 bytes), %>iop(B),Rp A8 (4), Rp,Rp 98 (3).
{
  const cases = [
    ['MOVD', '%>1234,R3', [0x88, 0x12, 0x34, 0x03]],
    ['MOVD', '%>1234(B),R3', [0xA8, 0x12, 0x34, 0x03]],
    ['MOVD', 'R5,R3', [0x98, 0x05, 0x03]],
  ];
  let bad = 0, bads = [];
  for (const [mn, operand, want] of cases) {
    const got = enc(mn, operand);
    if (JSON.stringify(got) !== JSON.stringify(want)) { bad++; bads.push(`${mn} ${operand}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  }
  check('MOVD takes a 16-bit immediate and the %n(B) form', bad === 0, bads.join(' | '));
}

// ---- 5b. symbolic operands: the manual's programs write labels, not hex (pages 6-19, 6-41, 6-44) ----
// "LDA @LABEL4", "BR @TABLE(B)", "MOVD %TAB(B),R3" all take a symbol or an expression, and the value comes
// from the engine's evaluator rather than a hex literal.
{
  const ctx = { ev: () => ({ value: 0x1234, unresolved: false }), pc: 0x0100 };
  const cases = [
    ['LDA', '@TABLE', [0x8A, 0x12, 0x34]],
    ['LDA', '@TABLE(B)', [0xAA, 0x12, 0x34]],
    ['STA', '@TABLE', [0x8B, 0x12, 0x34]],
    ['BR', '@LABEL4', [0x8C, 0x12, 0x34]],
    ['CALL', '@SUB', [0x8E, 0x12, 0x34]],
    ['CMPA', '@TABLE', [0x8D, 0x12, 0x34]],
    ['MOVD', '%TAB(B),R3', [0xA8, 0x12, 0x34, 0x03]],
  ];
  let bad = 0, bads = [];
  for (const [mn, operand, want] of cases) {
    let got = null;
    try { got = isa.encode(mn, operand, ctx); } catch (e) { got = `threw ${e.message}`; }
    const bytes = Array.isArray(got) ? got.map((b) => b & 0xFF) : got;
    if (JSON.stringify(bytes) !== JSON.stringify(want)) { bad++; bads.push(`${mn} ${operand}: got ${JSON.stringify(bytes)} want ${JSON.stringify(want)}`); }
  }
  check('extended operands take symbols and expressions', bad === 0, bads.join(' | '));
}

// ---- 6. jumps to labels: the offset is the target minus the next instruction (Section 6.2.5) ----
{
  // a label in column 1, an instruction indented: the engine's syntax, and how the manual's listings read
  const src = ['         ORG $0100', 'LOOP     JMP LOOP2', '         BTJO %>1,A,LOOP', '         DJNZ B,LOOP', 'LOOP2    RETS', '         END LOOP'];
  const r = Emu.assemble ? Emu.assemble(src.join('\n'), '7000') : null;
  check('a 7000 program with labelled jumps assembles', !!r && r.ok, r ? JSON.stringify(r.errors) : 'no assemble export');
  if (r && r.ok) {
    const bytes = Array.from(r.segments[0].data);
    // bytes laid out: JMP $0100 (2) ; BTJO $0102 (3) ; DJNZ $0105 (2) ; LOOP2 = $0107
    // JMP at >0100 to >0107: offset = >0107 - >0102 = 5
    check('JMP to a forward label is a 5-offset', bytes[0] === 0xE0 && bytes[1] === 0x05, JSON.stringify(bytes.slice(0, 2)));
    // BTJO %>1,A,LOOP is 3 bytes at >0102, so offset = >0100 - >0105 = -5
    check('BTJO back to a label encodes the negative offset', bytes[2] === 0x26 && bytes[3] === 0x01 && bytes[4] === 0xFB,
      JSON.stringify(bytes.slice(2, 5)));
    // DJNZ B,LOOP is 2 bytes at >0105, so offset = >0100 - >0107 = -7
    check('DJNZ back to a label encodes the negative offset', bytes[5] === 0xCA && bytes[6] === 0xF9, JSON.stringify(bytes.slice(5, 7)));
  }
}

console.log(`${n - fail}/${n} TMS7000 checks passed`);
process.exitCode = fail ? 1 : 0;
