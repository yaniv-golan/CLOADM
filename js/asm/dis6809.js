/*
 * One entry per documented 6809 opcode, keyed by opcode byte: [mnemonic, mode], for the shared
 * disassembler engine (./disassembler.js). Page 2 and page 3 are reached through the $10 and $11 prefixes.
 *
 * The table is Motorola's instruction set summary (MC6809E data sheet, "Instruction Set Summary"),
 * entry for entry: mnemonic, addressing mode and the number of bytes. It is a different artefact from
 * the assembler's encoder (./isa6809.js): that one answers "what bytes does this mnemonic make", this
 * one answers "what is this byte", and tests/disasm.test.js checks both against each other in both
 * directions, for every entry.
 *
 * Modes the engine understands:
 *   inh    no operand                          imm8  #$nn            imm16 #$nnnn
 *   dir    <$nn (direct page)                  idx   indexed postbyte (+ its operand bytes)
 *   ext    >$nnnn                              rel8  short branch     rel16 long branch
 *   post   TFR/EXG register pair               stack PSHS/PULS/... register list
 *   cc     ORCC/ANDCC/CWAI condition-code mask
 * Bytes the table leaves out are not instructions: the 6809 core runs them as a no-op and reads no
 * operand. They are shown as data (FCB), and the engine gives each the byte count this project's CPU
 * core actually consumes for it, so the disassembly list and the CPU stay in step.
 */

const PAGE1 = {
  0x12: ['NOP', 'inh'], 0x13: ['SYNC', 'inh'], 0x16: ['LBRA', 'rel16'], 0x17: ['LBSR', 'rel16'],
  0x19: ['DAA', 'inh'], 0x1A: ['ORCC', 'cc'], 0x1C: ['ANDCC', 'cc'], 0x1D: ['SEX', 'inh'],
  0x1E: ['EXG', 'post'], 0x1F: ['TFR', 'post'],
  0x20: ['BRA', 'rel8'], 0x21: ['BRN', 'rel8'], 0x22: ['BHI', 'rel8'], 0x23: ['BLS', 'rel8'],
  0x24: ['BCC', 'rel8'], 0x25: ['BCS', 'rel8'], 0x26: ['BNE', 'rel8'], 0x27: ['BEQ', 'rel8'],
  0x28: ['BVC', 'rel8'], 0x29: ['BVS', 'rel8'], 0x2A: ['BPL', 'rel8'], 0x2B: ['BMI', 'rel8'],
  0x2C: ['BGE', 'rel8'], 0x2D: ['BLT', 'rel8'], 0x2E: ['BGT', 'rel8'], 0x2F: ['BLE', 'rel8'],
  0x30: ['LEAX', 'idx'], 0x31: ['LEAY', 'idx'], 0x32: ['LEAS', 'idx'], 0x33: ['LEAU', 'idx'],
  0x34: ['PSHS', 'stack'], 0x35: ['PULS', 'stack'], 0x36: ['PSHU', 'stack'], 0x37: ['PULU', 'stack'],
  0x39: ['RTS', 'inh'], 0x3A: ['ABX', 'inh'], 0x3B: ['RTI', 'inh'], 0x3C: ['CWAI', 'cc'],
  0x3D: ['MUL', 'inh'], 0x3F: ['SWI', 'inh'],
  0x80: ['SUBA', 'imm8'], 0x81: ['CMPA', 'imm8'], 0x82: ['SBCA', 'imm8'], 0x83: ['SUBD', 'imm16'],
  0x84: ['ANDA', 'imm8'], 0x85: ['BITA', 'imm8'], 0x86: ['LDA', 'imm8'], 0x88: ['EORA', 'imm8'],
  0x89: ['ADCA', 'imm8'], 0x8A: ['ORA', 'imm8'], 0x8B: ['ADDA', 'imm8'], 0x8C: ['CMPX', 'imm16'],
  0x8D: ['BSR', 'rel8'], 0x8E: ['LDX', 'imm16'],
  0xC0: ['SUBB', 'imm8'], 0xC1: ['CMPB', 'imm8'], 0xC2: ['SBCB', 'imm8'], 0xC3: ['ADDD', 'imm16'],
  0xC4: ['ANDB', 'imm8'], 0xC5: ['BITB', 'imm8'], 0xC6: ['LDB', 'imm8'], 0xC8: ['EORB', 'imm8'],
  0xC9: ['ADCB', 'imm8'], 0xCA: ['ORB', 'imm8'], 0xCB: ['ADDB', 'imm8'], 0xCC: ['LDD', 'imm16'],
  0xCE: ['LDU', 'imm16'],
};
// read-modify-write ops: direct, indexed and extended forms share the low nibble
const RMW = { 0x0: 'NEG', 0x3: 'COM', 0x4: 'LSR', 0x6: 'ROR', 0x7: 'ASR', 0x8: 'ASL', 0x9: 'ROL', 0xA: 'DEC', 0xC: 'INC', 0xD: 'TST', 0xE: 'JMP', 0xF: 'CLR' };
for (const [lo, mn] of Object.entries(RMW)) {
  PAGE1[0x00 + Number(lo)] = [mn, 'dir'];
  PAGE1[0x60 + Number(lo)] = [mn, 'idx'];
  PAGE1[0x70 + Number(lo)] = [mn, 'ext'];
}
// accumulator forms 0x40-0x5F (ASL/LSL and their siblings); JMP has none
for (const [lo, mn] of Object.entries(RMW)) {
  if (Number(lo) === 0xE) continue;
  PAGE1[0x40 + Number(lo)] = [mn + 'A', 'inh'];
  PAGE1[0x50 + Number(lo)] = [mn + 'B', 'inh'];
}
// 0x80-0xFF rows: A row (0x80) and B row (0xC0) each have the same 16 low nibbles; the modes follow the
// four 16-byte blocks: immediate, direct, indexed, extended
const GEN_A = ['SUBA', 'CMPA', 'SBCA', 'SUBD', 'ANDA', 'BITA', 'LDA', 'STA', 'EORA', 'ADCA', 'ORA', 'ADDA', 'CMPX', 'JSR', 'LDX', 'STX'];
const GEN_B = ['SUBB', 'CMPB', 'SBCB', 'ADDD', 'ANDB', 'BITB', 'LDB', 'STB', 'EORB', 'ADCB', 'ORB', 'ADDB', 'LDD', 'STD', 'LDU', 'STU'];
const SIXTEEN = new Set(['SUBD', 'ADDD', 'CMPX', 'CMPD', 'CMPY', 'CMPU', 'CMPS', 'LDD', 'STD', 'LDU', 'STU', 'LDX', 'STX', 'LDY', 'STY', 'LDS', 'STS']);
const MODES = ['imm', 'dir', 'idx', 'ext'];
for (const [base, names] of [[0x80, GEN_A], [0xC0, GEN_B]]) {
  for (let i = 0; i < 16; i++) {
    const mn = names[i];
    // stores have no immediate form: $87, $C7, $8F and $CF are not instructions
    const immediate = i !== 7 && i !== 15;
    for (let blk = 0; blk < 4; blk++) {
      if (blk === 0 && !immediate) continue;
      if (blk === 0 && i === 13) {
        // $8D is BSR (a relative branch) and $CD has no documented mnemonic ($8F is not used: it is the STX
        // immediate gap above, which the real part also leaves as data)
        if (base === 0x80) PAGE1[0x8D] = ['BSR', 'rel8'];
        continue;
      }
      const width = SIXTEEN.has(mn) ? 16 : 8;
      PAGE1[base + blk * 0x10 + i] = [mn, MODES[blk] === 'imm' ? `imm${width}` : MODES[blk]];
    }
  }
}

const PAGE2 = {
  0x3F: ['SWI2', 'inh'],
  0x83: ['CMPD', 'imm16'], 0x8C: ['CMPY', 'imm16'], 0x8E: ['LDY', 'imm16'],
  0x93: ['CMPD', 'dir'], 0x9C: ['CMPY', 'dir'], 0x9E: ['LDY', 'dir'], 0x9F: ['STY', 'dir'],
  0xA3: ['CMPD', 'idx'], 0xAC: ['CMPY', 'idx'], 0xAE: ['LDY', 'idx'], 0xAF: ['STY', 'idx'],
  0xB3: ['CMPD', 'ext'], 0xBC: ['CMPY', 'ext'], 0xBE: ['LDY', 'ext'], 0xBF: ['STY', 'ext'],
  0xCE: ['LDS', 'imm16'],
  0xDE: ['LDS', 'dir'], 0xDF: ['STS', 'dir'],
  0xEE: ['LDS', 'idx'], 0xEF: ['STS', 'idx'],
  0xFE: ['LDS', 'ext'], 0xFF: ['STS', 'ext'],
};
// long branches: 0x20-0x2F, the same conditions as the short ones. $10 $20 is LBRA: the data sheet's
// long-branch block has it as the always-true condition, and the CPU core executes it as a 16-bit branch.
PAGE2[0x20] = ['LBRA', 'rel16'];
['LBRN', 'LBHI', 'LBLS', 'LBCC', 'LBCS', 'LBNE', 'LBEQ', 'LBVC', 'LBVS', 'LBPL', 'LBMI', 'LBGE', 'LBLT', 'LBGT', 'LBLE']
  .forEach((n, i) => { PAGE2[0x21 + i] = [n, 'rel16']; });

const PAGE3 = {
  0x3F: ['SWI3', 'inh'],
  0x83: ['CMPU', 'imm16'], 0x8C: ['CMPS', 'imm16'],
  0x93: ['CMPU', 'dir'], 0x9C: ['CMPS', 'dir'],
  0xA3: ['CMPU', 'idx'], 0xAC: ['CMPS', 'idx'],
  0xB3: ['CMPU', 'ext'], 0xBC: ['CMPS', 'ext'],
};

export const dis6809 = { name: '6809', pages: [PAGE1, PAGE2, PAGE3] };
