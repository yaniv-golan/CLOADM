/*
 * The documented MC6801/MC6803 instruction set, keyed by opcode byte: [mnemonic, mode], for the shared
 * disassembler engine (./disassembler.js). Source: Motorola's MC6801/MC6803 data sheet, "Instruction Set"
 * summary. The assembler's encoder (./isa6803.js) accepts both the 6800-style names and the 6809-style
 * ones; the disassembler uses the 6800-style ones (LDAA, STAA, ORAA), the names the part's own literature
 * and MAME's disassembler use.
 *
 * Modes as for the 6809 table (./dis6809.js), except that this part has only n,X indexed (mode idx with a
 * one-byte offset) and no indirect addressing. The 6803 has no valid-mode gaps: every opcode from $00 is
 * either an instruction or one of the documented "illegal" opcodes (page 1 of the data sheet lists them),
 * which the CPU core executes as a 4-cycle no-op with no operand bytes read, so the engine shows each as
 * one byte of data.
 */

const PAGE1 = {
  0x01: ['NOP', 'inh'],
  0x04: ['LSRD', 'inh'], 0x05: ['ASLD', 'inh'], 0x06: ['TAP', 'inh'], 0x07: ['TPA', 'inh'],
  0x08: ['INX', 'inh'], 0x09: ['DEX', 'inh'], 0x0A: ['CLV', 'inh'], 0x0B: ['SEV', 'inh'],
  0x0C: ['CLC', 'inh'], 0x0D: ['SEC', 'inh'], 0x0E: ['CLI', 'inh'], 0x0F: ['SEI', 'inh'],
  0x10: ['SBA', 'inh'], 0x11: ['CBA', 'inh'], 0x16: ['TAB', 'inh'], 0x17: ['TBA', 'inh'],
  0x19: ['DAA', 'inh'], 0x1B: ['ABA', 'inh'],
  0x30: ['TSX', 'inh'], 0x31: ['INS', 'inh'], 0x32: ['PULA', 'inh'], 0x33: ['PULB', 'inh'],
  0x34: ['DES', 'inh'], 0x35: ['TXS', 'inh'], 0x36: ['PSHA', 'inh'], 0x37: ['PSHB', 'inh'],
  0x38: ['PULX', 'inh'], 0x39: ['RTS', 'inh'], 0x3A: ['ABX', 'inh'], 0x3B: ['RTI', 'inh'],
  0x3C: ['PSHX', 'inh'], 0x3D: ['MUL', 'inh'], 0x3E: ['WAI', 'inh'], 0x3F: ['SWI', 'inh'],
};
// branches 0x20-0x2F
['BRA', 'BRN', 'BHI', 'BLS', 'BCC', 'BCS', 'BNE', 'BEQ', 'BVC', 'BVS', 'BPL', 'BMI', 'BGE', 'BLT', 'BGT', 'BLE']
  .forEach((n, i) => { PAGE1[0x20 + i] = [n, 'rel8']; });
// read-modify-write ops: accumulator forms 0x40/0x50, memory forms 0x60 (indexed) / 0x70 (extended)
const RMW = { 0x0: 'NEG', 0x3: 'COM', 0x4: 'LSR', 0x6: 'ROR', 0x7: 'ASR', 0x8: 'ASL', 0x9: 'ROL', 0xA: 'DEC', 0xC: 'INC', 0xD: 'TST', 0xE: 'JMP', 0xF: 'CLR' };
for (const [lo, mn] of Object.entries(RMW)) {
  if (Number(lo) !== 0xE) { PAGE1[0x40 + Number(lo)] = [mn + 'A', 'inh']; PAGE1[0x50 + Number(lo)] = [mn + 'B', 'inh']; }
  PAGE1[0x60 + Number(lo)] = [mn, 'idx'];
  PAGE1[0x70 + Number(lo)] = [mn, 'ext'];
}
// 0x80-0xFF rows: A (0x80) and B (0xC0), four blocks immediate / direct / indexed / extended
const GEN_A = ['SUBA', 'CMPA', 'SBCA', 'SUBD', 'ANDA', 'BITA', 'LDAA', 'STAA', 'EORA', 'ADCA', 'ORAA', 'ADDA', 'CPX', 'JSR', 'LDS', 'STS'];
const GEN_B = ['SUBB', 'CMPB', 'SBCB', 'ADDD', 'ANDB', 'BITB', 'LDAB', 'STAB', 'EORB', 'ADCB', 'ORAB', 'ADDB', 'LDD', 'STD', 'LDX', 'STX'];
const SIXTEEN = new Set(['SUBD', 'ADDD', 'CPX', 'LDD', 'STD', 'LDS', 'STS', 'LDX', 'STX']);
const MODES = ['imm', 'dir', 'idx', 'ext'];
for (const [base, names] of [[0x80, GEN_A], [0xC0, GEN_B]]) {
  for (let i = 0; i < 16; i++) {
    const mn = names[i];
    // stores have no immediate form: $87, $C7, $8F and $CF are four of this part's illegal opcodes
    const immediate = i !== 7 && i !== 15;
    for (let blk = 0; blk < 4; blk++) {
      if (blk === 0 && !immediate) continue;
      if (base === 0x80 && blk === 0 && i === 13) { PAGE1[0x8D] = ['BSR', 'rel8']; continue; }   // $CD is illegal here
      if (base === 0xC0 && blk === 0 && i === 13) continue;
      const width = SIXTEEN.has(mn) ? 16 : 8;
      PAGE1[base + blk * 0x10 + i] = [mn, MODES[blk] === 'imm' ? `imm${width}` : MODES[blk]];
    }
  }
}

export const dis6803 = { name: '6803', pages: [PAGE1] };
