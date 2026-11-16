/*
 * One entry per opcode the HD6309 decodes: [mnemonic, mode], for the shared disassembler engine
 * (./disassembler.js). Page 2 and page 3 are reached through the $10 and $11 prefixes. It is a
 * different artefact from the assembler's encoder (./isa6309.js): that one answers "what bytes does
 * this mnemonic make", this one answers "what is this byte".
 *
 * The 6309 runs the whole 6809 instruction set with the same encodings, so a shared opcode keeps the
 * 6809 mode unchanged (./dis6809.js); the 6309-only instructions are the additions, plus a handful of
 * mnemonics the 6309 spells differently (ASL/LSL, BHS/BCC, ...). Sources, by printed page:
 *
 *   HD63B09EP Technical Reference Guide, "Opcode and Mnemonics Reference Table", printed pp. 11-18:
 *     the opcode -> mnemonic -> mode mapping for every entry, with the 6309-only ones starred.
 *   Motorola MC6809E data sheet, "Instruction Set Summary": the modes the 6809 shares, unchanged.
 *   Atkinson, "Motorola 6809 and Hitachi 6309 Programmer's Reference": the opcode map (printed p. 152)
 *     and the per-instruction pages, used where the guide's table needed a second reading.
 *
 * Rows that are not simply the guide's table:
 *   - The guide's length column is wrong in three places and the mode here follows its own structural
 *     reading, not the printed number: TIM direct (0B) prints no length at all; LDMD immediate (113D)
 *     prints 5 where Atkinson's LDMD page (printed p. 92) gives 3, because MD is 8 bits; DIVD immediate
 *     (118D) prints 4 where Atkinson's DIVD page (printed p. 58) gives 3, because the divisor is one
 *     byte. None of the three changes the mode recorded here.
 *   - The guide omits the 6309 conditional long branches' own rows on page 14 but lists them; they are
 *     0x21-0x2F on page 2, all rel16 (guide's mnemonic table, printed p. 21, "10 xx 4").
 *   - RORW ($1056) is real: Atkinson, printed p. 118, gives it an encoding and byte count. The guide
 *     marks that one row with a '?' in the margin; the third source settles it, so it is listed.
 *   - NEGW, ASRW and ASLW ($1050/$1057/$1058) are NOT listed, because the hardware does not have them:
 *     Atkinson printed p. 101 ("The 6309 does not provide instructions for negating the E, F, W and Q
 *     accumulators"), printed p. 18 (ASR has no W variant) and printed p. 16 (ASLD: "The D accumulator
 *     is the only 16-bit register for which an ASL instruction has been provided"), and the opcode map
 *     on printed p. 152 leaves those cells blank, with undefined opcodes trapping on a 6309 (printed
 *     p. 153, note 4). The disassembler prints them as data, which is the hardware view. Our core and
 *     MAME run them instead; that is a known deviation tracked for the core branch. It is a difference in
 *     behaviour, not in length - both read two bytes - so tests/disasm.test.js's length comparison holds
 *     for them unchanged and needs no exclusion.
 *   - The guide's table names several opcodes with both spellings in one cell (ASL/LSL, BHS/BCC,
 *     BLO/BCS, LBHS/LBCC, ...). The assembler accepts the two as separate mnemonics, so a table entry
 *     carries the one its own 6809 table uses (./dis6809.js), which is the form the text reassembles
 *     from; the cell in the guide lists both.
 *
 * Modes the engine understands: see ./disassembler.js. Three exist only for the 6309: `imm8dir`,
 * `imm8idx` and `imm8ext` (AIM/OIM/EIM/TIM: a mask byte, then an ordinary operand), `bitmem` (the bit
 * operations, $1130-$1137), and `tfm` (the block moves, $1138-$113B, whose operand is a postbyte).
 */
const PAGE1 = {
  0x00: ['NEG', 'dir'], 0x01: ['OIM', 'imm8dir'], 0x02: ['AIM', 'imm8dir'], 0x03: ['COM', 'dir'],
  0x04: ['LSR', 'dir'], 0x05: ['EIM', 'imm8dir'], 0x06: ['ROR', 'dir'], 0x07: ['ASR', 'dir'],
  0x08: ['ASL', 'dir'], 0x09: ['ROL', 'dir'], 0x0A: ['DEC', 'dir'], 0x0B: ['TIM', 'imm8dir'],
  0x0C: ['INC', 'dir'], 0x0D: ['TST', 'dir'], 0x0E: ['JMP', 'dir'], 0x0F: ['CLR', 'dir'], 0x12: ['NOP', 'inh'],
  0x13: ['SYNC', 'inh'], 0x14: ['SEXW', 'inh'], 0x16: ['LBRA', 'rel16'], 0x17: ['LBSR', 'rel16'],
  0x19: ['DAA', 'inh'], 0x1A: ['ORCC', 'cc'], 0x1C: ['ANDCC', 'cc'], 0x1D: ['SEX', 'inh'], 0x1E: ['EXG', 'post'],
  0x1F: ['TFR', 'post'], 0x20: ['BRA', 'rel8'], 0x21: ['BRN', 'rel8'], 0x22: ['BHI', 'rel8'], 0x23: ['BLS', 'rel8'],
  0x24: ['BCC', 'rel8'], 0x25: ['BCS', 'rel8'], 0x26: ['BNE', 'rel8'], 0x27: ['BEQ', 'rel8'],
  0x28: ['BVC', 'rel8'], 0x29: ['BVS', 'rel8'], 0x2A: ['BPL', 'rel8'], 0x2B: ['BMI', 'rel8'], 0x2C: ['BGE', 'rel8'],
  0x2D: ['BLT', 'rel8'], 0x2E: ['BGT', 'rel8'], 0x2F: ['BLE', 'rel8'], 0x30: ['LEAX', 'idx'], 0x31: ['LEAY', 'idx'],
  0x32: ['LEAS', 'idx'], 0x33: ['LEAU', 'idx'], 0x34: ['PSHS', 'stack'], 0x35: ['PULS', 'stack'],
  0x36: ['PSHU', 'stack'], 0x37: ['PULU', 'stack'], 0x39: ['RTS', 'inh'], 0x3A: ['ABX', 'inh'], 0x3B: ['RTI', 'inh'],
  0x3C: ['CWAI', 'cc'], 0x3D: ['MUL', 'inh'], 0x3F: ['SWI', 'inh'], 0x40: ['NEGA', 'inh'], 0x43: ['COMA', 'inh'],
  0x44: ['LSRA', 'inh'], 0x46: ['RORA', 'inh'], 0x47: ['ASRA', 'inh'], 0x48: ['ASLA', 'inh'],
  0x49: ['ROLA', 'inh'], 0x4A: ['DECA', 'inh'], 0x4C: ['INCA', 'inh'], 0x4D: ['TSTA', 'inh'], 0x4F: ['CLRA', 'inh'],
  0x50: ['NEGB', 'inh'], 0x53: ['COMB', 'inh'], 0x54: ['LSRB', 'inh'], 0x56: ['RORB', 'inh'], 0x57: ['ASRB', 'inh'],
  0x58: ['ASLB', 'inh'], 0x59: ['ROLB', 'inh'], 0x5A: ['DECB', 'inh'], 0x5C: ['INCB', 'inh'],
  0x5D: ['TSTB', 'inh'], 0x5F: ['CLRB', 'inh'], 0x60: ['NEG', 'idx'], 0x61: ['OIM', 'imm8idx'],
  0x62: ['AIM', 'imm8idx'], 0x63: ['COM', 'idx'], 0x64: ['LSR', 'idx'], 0x65: ['EIM', 'imm8idx'],
  0x66: ['ROR', 'idx'], 0x67: ['ASR', 'idx'], 0x68: ['ASL', 'idx'], 0x69: ['ROL', 'idx'], 0x6A: ['DEC', 'idx'],
  0x6B: ['TIM', 'imm8idx'], 0x6C: ['INC', 'idx'], 0x6D: ['TST', 'idx'], 0x6E: ['JMP', 'idx'], 0x6F: ['CLR', 'idx'],
  0x70: ['NEG', 'ext'], 0x71: ['OIM', 'imm8ext'], 0x72: ['AIM', 'imm8ext'], 0x73: ['COM', 'ext'],
  0x74: ['LSR', 'ext'], 0x75: ['EIM', 'imm8ext'], 0x76: ['ROR', 'ext'], 0x77: ['ASR', 'ext'],
  0x78: ['ASL', 'ext'], 0x79: ['ROL', 'ext'], 0x7A: ['DEC', 'ext'], 0x7B: ['TIM', 'imm8ext'],
  0x7C: ['INC', 'ext'], 0x7D: ['TST', 'ext'], 0x7E: ['JMP', 'ext'], 0x7F: ['CLR', 'ext'], 0x80: ['SUBA', 'imm8'],
  0x81: ['CMPA', 'imm8'], 0x82: ['SBCA', 'imm8'], 0x83: ['SUBD', 'imm16'], 0x84: ['ANDA', 'imm8'],
  0x85: ['BITA', 'imm8'], 0x86: ['LDA', 'imm8'], 0x88: ['EORA', 'imm8'], 0x89: ['ADCA', 'imm8'],
  0x8A: ['ORA', 'imm8'], 0x8B: ['ADDA', 'imm8'], 0x8C: ['CMPX', 'imm16'], 0x8D: ['BSR', 'rel8'],
  0x8E: ['LDX', 'imm16'], 0x90: ['SUBA', 'dir'], 0x91: ['CMPA', 'dir'], 0x92: ['SBCA', 'dir'], 0x93: ['SUBD', 'dir'],
  0x94: ['ANDA', 'dir'], 0x95: ['BITA', 'dir'], 0x96: ['LDA', 'dir'], 0x97: ['STA', 'dir'], 0x98: ['EORA', 'dir'],
  0x99: ['ADCA', 'dir'], 0x9A: ['ORA', 'dir'], 0x9B: ['ADDA', 'dir'], 0x9C: ['CMPX', 'dir'], 0x9D: ['JSR', 'dir'],
  0x9E: ['LDX', 'dir'], 0x9F: ['STX', 'dir'], 0xA0: ['SUBA', 'idx'], 0xA1: ['CMPA', 'idx'], 0xA2: ['SBCA', 'idx'],
  0xA3: ['SUBD', 'idx'], 0xA4: ['ANDA', 'idx'], 0xA5: ['BITA', 'idx'], 0xA6: ['LDA', 'idx'], 0xA7: ['STA', 'idx'],
  0xA8: ['EORA', 'idx'], 0xA9: ['ADCA', 'idx'], 0xAA: ['ORA', 'idx'], 0xAB: ['ADDA', 'idx'], 0xAC: ['CMPX', 'idx'],
  0xAD: ['JSR', 'idx'], 0xAE: ['LDX', 'idx'], 0xAF: ['STX', 'idx'], 0xB0: ['SUBA', 'ext'], 0xB1: ['CMPA', 'ext'],
  0xB2: ['SBCA', 'ext'], 0xB3: ['SUBD', 'ext'], 0xB4: ['ANDA', 'ext'], 0xB5: ['BITA', 'ext'], 0xB6: ['LDA', 'ext'],
  0xB7: ['STA', 'ext'], 0xB8: ['EORA', 'ext'], 0xB9: ['ADCA', 'ext'], 0xBA: ['ORA', 'ext'], 0xBB: ['ADDA', 'ext'],
  0xBC: ['CMPX', 'ext'], 0xBD: ['JSR', 'ext'], 0xBE: ['LDX', 'ext'], 0xBF: ['STX', 'ext'], 0xC0: ['SUBB', 'imm8'],
  0xC1: ['CMPB', 'imm8'], 0xC2: ['SBCB', 'imm8'], 0xC3: ['ADDD', 'imm16'], 0xC4: ['ANDB', 'imm8'],
  0xC5: ['BITB', 'imm8'], 0xC6: ['LDB', 'imm8'], 0xC8: ['EORB', 'imm8'], 0xC9: ['ADCB', 'imm8'],
  0xCA: ['ORB', 'imm8'], 0xCB: ['ADDB', 'imm8'], 0xCC: ['LDD', 'imm16'], 0xCD: ['LDQ', 'imm32'],
  0xCE: ['LDU', 'imm16'], 0xD0: ['SUBB', 'dir'], 0xD1: ['CMPB', 'dir'], 0xD2: ['SBCB', 'dir'], 0xD3: ['ADDD', 'dir'],
  0xD4: ['ANDB', 'dir'], 0xD5: ['BITB', 'dir'], 0xD6: ['LDB', 'dir'], 0xD7: ['STB', 'dir'], 0xD8: ['EORB', 'dir'],
  0xD9: ['ADCB', 'dir'], 0xDA: ['ORB', 'dir'], 0xDB: ['ADDB', 'dir'], 0xDC: ['LDD', 'dir'], 0xDD: ['STD', 'dir'],
  0xDE: ['LDU', 'dir'], 0xDF: ['STU', 'dir'], 0xE0: ['SUBB', 'idx'], 0xE1: ['CMPB', 'idx'], 0xE2: ['SBCB', 'idx'],
  0xE3: ['ADDD', 'idx'], 0xE4: ['ANDB', 'idx'], 0xE5: ['BITB', 'idx'], 0xE6: ['LDB', 'idx'], 0xE7: ['STB', 'idx'],
  0xE8: ['EORB', 'idx'], 0xE9: ['ADCB', 'idx'], 0xEA: ['ORB', 'idx'], 0xEB: ['ADDB', 'idx'], 0xEC: ['LDD', 'idx'],
  0xED: ['STD', 'idx'], 0xEE: ['LDU', 'idx'], 0xEF: ['STU', 'idx'], 0xF0: ['SUBB', 'ext'], 0xF1: ['CMPB', 'ext'],
  0xF2: ['SBCB', 'ext'], 0xF3: ['ADDD', 'ext'], 0xF4: ['ANDB', 'ext'], 0xF5: ['BITB', 'ext'], 0xF6: ['LDB', 'ext'],
  0xF7: ['STB', 'ext'], 0xF8: ['EORB', 'ext'], 0xF9: ['ADCB', 'ext'], 0xFA: ['ORB', 'ext'], 0xFB: ['ADDB', 'ext'],
  0xFC: ['LDD', 'ext'], 0xFD: ['STD', 'ext'], 0xFE: ['LDU', 'ext'], 0xFF: ['STU', 'ext'],
};

const PAGE2 = {
  0x21: ['LBRN', 'rel16'], 0x22: ['LBHI', 'rel16'], 0x23: ['LBLS', 'rel16'], 0x24: ['LBCC', 'rel16'],
  0x25: ['LBCS', 'rel16'], 0x26: ['LBNE', 'rel16'], 0x27: ['LBEQ', 'rel16'], 0x28: ['LBVC', 'rel16'],
  0x29: ['LBVS', 'rel16'], 0x2A: ['LBPL', 'rel16'], 0x2B: ['LBMI', 'rel16'], 0x2C: ['LBGE', 'rel16'],
  0x2D: ['LBLT', 'rel16'], 0x2E: ['LBGT', 'rel16'], 0x2F: ['LBLE', 'rel16'], 0x30: ['ADDR', 'post'],
  0x31: ['ADCR', 'post'], 0x32: ['SUBR', 'post'], 0x33: ['SBCR', 'post'], 0x34: ['ANDR', 'post'],
  0x35: ['ORR', 'post'], 0x36: ['EORR', 'post'], 0x37: ['CMPR', 'post'], 0x38: ['PSHSW', 'inh'],
  0x39: ['PULSW', 'inh'], 0x3A: ['PSHUW', 'inh'], 0x3B: ['PULUW', 'inh'], 0x3F: ['SWI2', 'inh'],
  0x40: ['NEGD', 'inh'], 0x43: ['COMD', 'inh'], 0x44: ['LSRD', 'inh'], 0x46: ['RORD', 'inh'], 0x47: ['ASRD', 'inh'],
  0x48: ['ASLD', 'inh'], 0x49: ['ROLD', 'inh'], 0x4A: ['DECD', 'inh'], 0x4C: ['INCD', 'inh'],
  0x4D: ['TSTD', 'inh'], 0x4F: ['CLRD', 'inh'], 0x53: ['COMW', 'inh'], 0x54: ['LSRW', 'inh'], 0x56: ['RORW', 'inh'],
  0x59: ['ROLW', 'inh'], 0x5A: ['DECW', 'inh'], 0x5C: ['INCW', 'inh'], 0x5D: ['TSTW', 'inh'], 0x5F: ['CLRW', 'inh'],
  0x80: ['SUBW', 'imm16'], 0x81: ['CMPW', 'imm16'], 0x82: ['SBCD', 'imm16'], 0x83: ['CMPD', 'imm16'],
  0x84: ['ANDD', 'imm16'], 0x85: ['BITD', 'imm16'], 0x86: ['LDW', 'imm16'], 0x88: ['EORD', 'imm16'],
  0x89: ['ADCD', 'imm16'], 0x8A: ['ORD', 'imm16'], 0x8B: ['ADDW', 'imm16'], 0x8C: ['CMPY', 'imm16'],
  0x8E: ['LDY', 'imm16'], 0x90: ['SUBW', 'dir'], 0x91: ['CMPW', 'dir'], 0x92: ['SBCD', 'dir'], 0x93: ['CMPD', 'dir'],
  0x94: ['ANDD', 'dir'], 0x95: ['BITD', 'dir'], 0x96: ['LDW', 'dir'], 0x97: ['STW', 'dir'], 0x98: ['EORD', 'dir'],
  0x99: ['ADCD', 'dir'], 0x9A: ['ORD', 'dir'], 0x9B: ['ADDW', 'dir'], 0x9C: ['CMPY', 'dir'], 0x9E: ['LDY', 'dir'],
  0x9F: ['STY', 'dir'], 0xA0: ['SUBW', 'idx'], 0xA1: ['CMPW', 'idx'], 0xA2: ['SBCD', 'idx'], 0xA3: ['CMPD', 'idx'],
  0xA4: ['ANDD', 'idx'], 0xA5: ['BITD', 'idx'], 0xA6: ['LDW', 'idx'], 0xA7: ['STW', 'idx'], 0xA8: ['EORD', 'idx'],
  0xA9: ['ADCD', 'idx'], 0xAA: ['ORD', 'idx'], 0xAB: ['ADDW', 'idx'], 0xAC: ['CMPY', 'idx'], 0xAE: ['LDY', 'idx'],
  0xAF: ['STY', 'idx'], 0xB0: ['SUBW', 'ext'], 0xB1: ['CMPW', 'ext'], 0xB2: ['SBCD', 'ext'], 0xB3: ['CMPD', 'ext'],
  0xB4: ['ANDD', 'ext'], 0xB5: ['BITD', 'ext'], 0xB6: ['LDW', 'ext'], 0xB7: ['STW', 'ext'], 0xB8: ['EORD', 'ext'],
  0xB9: ['ADCD', 'ext'], 0xBA: ['ORD', 'ext'], 0xBB: ['ADDW', 'ext'], 0xBC: ['CMPY', 'ext'], 0xBE: ['LDY', 'ext'],
  0xBF: ['STY', 'ext'], 0xCE: ['LDS', 'imm16'], 0xDC: ['LDQ', 'dir'], 0xDD: ['STQ', 'dir'], 0xDE: ['LDS', 'dir'],
  0xDF: ['STS', 'dir'], 0xEC: ['LDQ', 'idx'], 0xED: ['STQ', 'idx'], 0xEE: ['LDS', 'idx'], 0xEF: ['STS', 'idx'],
  0xFC: ['LDQ', 'ext'], 0xFD: ['STQ', 'ext'], 0xFE: ['LDS', 'ext'], 0xFF: ['STS', 'ext'],
};

const PAGE3 = {
  0x30: ['BAND', 'bitmem'], 0x31: ['BIAND', 'bitmem'], 0x32: ['BOR', 'bitmem'], 0x33: ['BIOR', 'bitmem'],
  0x34: ['BEOR', 'bitmem'], 0x35: ['BIEOR', 'bitmem'], 0x36: ['LDBT', 'bitmem'], 0x37: ['STBT', 'bitmem'],
  0x38: ['TFM', 'tfm'], 0x39: ['TFM', 'tfm'], 0x3A: ['TFM', 'tfm'], 0x3B: ['TFM', 'tfm'], 0x3C: ['BITMD', 'imm8'],
  0x3D: ['LDMD', 'imm8'], 0x3F: ['SWI3', 'inh'], 0x43: ['COME', 'inh'], 0x4A: ['DECE', 'inh'], 0x4C: ['INCE', 'inh'],
  0x4D: ['TSTE', 'inh'], 0x4F: ['CLRE', 'inh'], 0x53: ['COMF', 'inh'], 0x5A: ['DECF', 'inh'], 0x5C: ['INCF', 'inh'],
  0x5D: ['TSTF', 'inh'], 0x5F: ['CLRF', 'inh'], 0x80: ['SUBE', 'imm8'], 0x81: ['CMPE', 'imm8'],
  0x83: ['CMPU', 'imm16'], 0x86: ['LDE', 'imm8'], 0x8B: ['ADDE', 'imm8'], 0x8C: ['CMPS', 'imm16'],
  0x8D: ['DIVD', 'imm8'], 0x8E: ['DIVQ', 'imm16'], 0x8F: ['MULD', 'imm16'], 0x90: ['SUBE', 'dir'],
  0x91: ['CMPE', 'dir'], 0x93: ['CMPU', 'dir'], 0x96: ['LDE', 'dir'], 0x97: ['STE', 'dir'], 0x9B: ['ADDE', 'dir'],
  0x9C: ['CMPS', 'dir'], 0x9D: ['DIVD', 'dir'], 0x9E: ['DIVQ', 'dir'], 0x9F: ['MULD', 'dir'], 0xA0: ['SUBE', 'idx'],
  0xA1: ['CMPE', 'idx'], 0xA3: ['CMPU', 'idx'], 0xA6: ['LDE', 'idx'], 0xA7: ['STE', 'idx'], 0xAB: ['ADDE', 'idx'],
  0xAC: ['CMPS', 'idx'], 0xAD: ['DIVD', 'idx'], 0xAE: ['DIVQ', 'idx'], 0xAF: ['MULD', 'idx'], 0xB0: ['SUBE', 'ext'],
  0xB1: ['CMPE', 'ext'], 0xB3: ['CMPU', 'ext'], 0xB6: ['LDE', 'ext'], 0xB7: ['STE', 'ext'], 0xBB: ['ADDE', 'ext'],
  0xBC: ['CMPS', 'ext'], 0xBD: ['DIVD', 'ext'], 0xBE: ['DIVQ', 'ext'], 0xBF: ['MULD', 'ext'], 0xC0: ['SUBF', 'imm8'],
  0xC1: ['CMPF', 'imm8'], 0xC6: ['LDF', 'imm8'], 0xCB: ['ADDF', 'imm8'], 0xD0: ['SUBF', 'dir'],
  0xD1: ['CMPF', 'dir'], 0xD6: ['LDF', 'dir'], 0xD7: ['STF', 'dir'], 0xDB: ['ADDF', 'dir'], 0xE0: ['SUBF', 'idx'],
  0xE1: ['CMPF', 'idx'], 0xE6: ['LDF', 'idx'], 0xE7: ['STF', 'idx'], 0xEB: ['ADDF', 'idx'], 0xF0: ['SUBF', 'ext'],
  0xF1: ['CMPF', 'ext'], 0xF6: ['LDF', 'ext'], 0xF7: ['STF', 'ext'], 0xFB: ['ADDF', 'ext'],
};

export const dis6309 = { name: '6309', pages: [PAGE1, PAGE2, PAGE3] };
