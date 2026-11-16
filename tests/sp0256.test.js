// The SP0256 microsequencer and host interface (stage 1), against values worked out
// from GI's documents. Each ROM here is written out by hand as a BIT stream from the documented
// instruction format -- no assembler and no emulator code produces the expected values:
//
//   GI "SP0256 Design Objective Specification", Document Control #0380-20, rev 1981 -- instruction
//   framing and bit addressing (sheets 23, 25), branch control (sheets 20, 26-28), RCU (sheet 18),
//   PAGE power-up and the 12-bit branch address (sheet 26), entry-point spacing (sheet 29), the
//   LRQ/SBY/IBF handshake (sheets 27, 30), and the R x pitch-period timing (sheets 12, 17).
//   The 10 kHz sample rate is the SP0250 Applications Manual's SYNC pin (20) and the AL2 datasheet's
//   3.12 MHz crystal.
//
// The parameter-load instructions are NOT tested here: their data framing needs GI's bit-precision maps,
// which are held (see the chip's header). The test asserts that one is reported as unmapped rather than
// silently mis-framed.
const Emu = require('./load')();

let failures = 0, count = 0;
function is(name, got, want) {
  count++;
  if (got !== want) { failures++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
}

// Build a ROM image from a bit string. '0'/'1' are bits and '.' is a zero bit kept for layout, so a row
// can be grouped in instruction-sized runs; spaces are only for reading and are dropped. Bit 0 of the
// stream is the MSB of byte 0 (the chip addresses bits, and a missing byte reads 0).
function rom(bits, bytes = 0x2000) {
  const img = new Uint8Array(bytes);
  const s = bits.replace(/ /g, '').replace(/[^01.]/g, '.').replace(/\./g, '0');
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '1') img[i >> 3] |= 0x80 >> (i & 7);
  }
  return img;
}

const { SP0256, OPCODE_UNMAPPED } = Emu;

// ---------------------------------------------------------------- construction and reset state
{
  const c = new SP0256({ rom: rom('') });
  // GI sheet 26: PAGE "powers up to the value 0001"
  is('reset: PAGE = 1', c.pag, 1);
  is('reset: PC = 0', c.pc, 0);
  is('reset: not waiting', c.waiting, false);
  is('reset: IBF clear', c.ibf, false);
  is('reset: LRQ high when no address is waiting', c.lrq, false);
  is('reset: SBY low when not stopped', c.sby, false);
  is('sample rate is 3.12 MHz / 312 = 10 kHz', c.sampleRate, 10000);
}

// ---------------------------------------------------------------- the host handshake (GI sheet 30)
{
  const c = new SP0256({ rom: rom('') });
  c.loadAddress(0x42);
  is('ALD latches IB', c.ib, 0x42);
  is('ALD sets IBF', c.ibf, true);
  is('LRQ is asserted (low) while IBF is set', c.lrq, true);
  // GI sheet 27: SBY is high while the sequencer is stopped; a pending address means it is not stopped
  is('SBY stays low when an address is pending', c.sby, false);
}

// ---------------------------------------------------------------- entry points (GI sheet 29)
// "entry points are spaced at 2 byte increments", so entry n starts at bit n*16.
{
  const c = new SP0256({ rom: rom('') });
  c.loadAddress(3);
  c.beginAtCommand();
  is('entry 3 starts at bit 3*16 = 48', c.pc, 48);
  is('taking the entry point clears IBF', c.ibf, false);
  is('and drops the wait state', c.waiting, false);
}

// ---------------------------------------------------------------- PAG (GI sheet 20: 0000 + P0P1P2P3)
// PAG sets the PAGE register; the sequencer then fetches the next instruction from the following bits.
{
  const c = new SP0256({ rom: rom('0000 0110') });     // PAG $6
  const n = c.step();
  is('PAG returns no sample period', n, 0);
  is('PAG sets PAGE to its low nibble', c.pag, 6);
  is('PAG consumes one byte', c.pc, 8);
}
// "must be greater than zero": a PAG with a zero low nibble leaves PAGE as it was.
{
  const c = new SP0256({ rom: rom('0000 0000' + '0000') });
  c.pag = 9;
  c.step();
  is('PAG 0 does not clear PAGE', c.pag, 9);
}

// ---------------------------------------------------------------- RET with no return flag and no address
// GI sheets 27/30: the sequencer stops, SBY goes high, and it resumes from IB when an address arrives.
{
  const c = new SP0256({ rom: rom('0000 0000') });
  c.step();
  is('RET with nothing pending stops the sequencer', c.waiting, true);
  is('... and raises SBY', c.sby, true);
  is('a stopped step returns no period', c.step(), 0);
  // now the host writes an address: the sequencer picks it up and starts there
  c.loadAddress(2);
  c.step();
  is('a pending address resumes at entry 2', c.pc, 32);
  is('... and lowers SBY', c.sby, false);
}

// ---------------------------------------------------------------- RET with an address pending
// "If Return Flag not Set: IB -> PC, IBF reset" (GI sheet 20).
{
  const c = new SP0256({ rom: rom('0000 0000') });
  c.loadAddress(5);
  c.step();
  is('RET with an address pending starts there', c.pc, 5 * 16);
  is('... and clears IBF', c.ibf, false);
  is('... without stopping', c.waiting, false);
}

// ---------------------------------------------------------------- JSR / RET round trip
// JSR is 1101 A11 A10 A9 A8 then 8 more address bits (GI sheet 20). At bit 0, after the 16-bit
// instruction the return address is bit 16. The target is PAGE($1) << 12 | $112 = $1112.
{
  const c = new SP0256({ rom: rom('1101 0001 0001 0010') });
  c.step();
  is('JSR jumps to the PAGE-relative 12-bit target', c.pc, 0x1112);
  is('JSR saves the return address in the one-deep register', c.rb, 16);
  is('JSR sets the return flag', c.retFlag, true);
  is('JSR clears IBF', c.ibf, false);
  // now a RET must come back to bit 16
  const c2 = new SP0256({ rom: rom(Array(16).fill('0').join('') + '0000 0000') });
  c2.pc = 0x1112;
  c2.rb = 16; c2.retFlag = true;
  c2.step();
  is('RET returns to the saved address', c2.pc, 16);
  is('RET clears the return flag', c2.retFlag, false);
}

// ---------------------------------------------------------------- JMP
// JMP is 1110 A11 A10 A9 A8 then 8 address bits; it must not touch the return state (GI sheet 26).
{
  const c = new SP0256({ rom: rom('1110 0011 0100 0101') });
  c.rb = 0xBEEF; c.retFlag = true;
  c.step();
  is('JMP target', c.pc, 0x1345);
  is('JMP leaves the return register alone', c.rb, 0xBEEF);
  is('JMP leaves the return flag alone', c.retFlag, true);
}

// ---------------------------------------------------------------- PAGE supplies the top 4 bits
{
  const c = new SP0256({ rom: rom('1110 0111 1111 1111') });
  c.pag = 0xA;
  c.step();
  is('branch target = PAGE:a + 12-bit address', c.pc, 0xA7FF);
}

// ---------------------------------------------------------------- RCU (GI sheet 18: 0001 MP N4 N3)
// M is bit 1, P is bit 0, N4 N3 are bits 3 and 2.
{
  const c = new SP0256({ rom: rom('0001 1011') });      // N4=1 N3=0 M=1 P=1
  c.step();
  is('RCU sets the mode bits (M=1, P=1)', c.mode, 0b11);
  is('RCU sets the repeat prefix N4,N3 = 10', c.repeatPrefix, 0b10);
  is('RCU leaves R holding the repeat prefix in its top bits', c.R, 0b100000);
  is('RCU is one byte', c.pc, 8);
}
{
  const c = new SP0256({ rom: rom('0001 0100') });      // N4=0 N3=1 M=0 P=0
  c.step();
  is('RCU sets M=0, P=0', c.mode, 0);
  is('RCU sets the repeat prefix N4,N3 = 01', c.repeatPrefix, 0b01);
}

// ---------------------------------------------------------------- timing (GI sheets 12, 17)
// "the controller waits until the completion of the last of R pitch periods (or 64 X R samples in
// unvoiced mode)". R comes from the repeat prefix (top two bits) and, for a parameter instruction, the
// low nibble; P is the pitch period, only changed by the parameter instructions, so it is set directly
// here to isolate the timing rule.
{
  const c = new SP0256({ rom: rom('') });
  c.P = 0;                                  // unvoiced
  c.R = 2;
  is('unvoiced: 64 samples per repeat', c.period(), 2 * 64);
  c.P = 7;                                  // voiced with a 7-sample pitch period
  c.R = 3;
  is('voiced: P samples per repeat', c.period(), 3 * 7);
  c.P = 7; c.R = 0;                         // a zero repeat still means one period
  is('R of zero is one period', c.period(), 7);
}

// ---------------------------------------------------------------- framing is bit-addressed
// GI sheet 25: instructions may begin and end on any bit boundary. Two one-byte instructions laid out
// from bit 4 must both be fetched correctly, which only works if the PC counts bits.
{
  const bits = '....' + '0001 0011' + '0001 0110' + '.';   // RCU then RCU, starting at bit 4
  const c = new SP0256({ rom: rom(bits) });
  c.pc = 4;
  c.step();
  // 0001 0011: N4N3 = 00, M = 1, P = 1, so the mode bits are 11
  is('a bit-4 instruction is fetched correctly (first RCU)', c.mode, 0b11);
  c.step();
  // 0001 0110: N4N3 = 01, M = 1, P = 0
  is('... and the next one follows on the bit boundary', c.repeatPrefix, 0b01);
  is('PC advanced by 16 bits in total', c.pc, 20);
}

// ---------------------------------------------------------------- the ROM is read MSB first
// A '1' in the first bit position of the image must be the top bit of byte 0. The opcode 0001 1000 read
// as RCU with N4=0 N3=0 M=0 P=0 proves the whole byte came through in order.
{
  const img = rom('0001 1000');
  is('first bit is the MSB of byte 0', img[0], 0x18);
  const c = new SP0256({ rom: img });
  c.step();
  is('the top nibble decodes as RCU', c.lastStep.op, 'RCU');
}

// ---------------------------------------------------------------- an empty / missing ROM
// With no ROM every bit reads 0, which decodes as RET: the sequencer stops rather than running wild.
{
  const c = new SP0256({});
  c.step();
  is('a missing ROM decodes as RET and stops', c.waiting, true);
}

// ---------------------------------------------------------------- parameter instructions are held, not guessed
// Every register-modification code other than RCU needs the precision maps to know its data length. The
// chip must say so, and must not consume a guessed number of bits.
{
  for (const [name, code] of Object.entries(Emu.SP0256.RM_OPCODE)) {
    if (name === 'RCU') continue;
    const c = new SP0256({ rom: rom(code.toString(2).padStart(4, '0') + '0001') });
    const r = c.step();
    is(`${name} reports as unmapped rather than guessing its data length`, r, OPCODE_UNMAPPED);
    is(`${name} leaves the PC where the opcode byte ended`, c.pc, 8);
    is(`${name} marks itself unmapped`, c.lastStep.unmapped, true);
  }
}

// ---------------------------------------------------------------- snapshots round-trip
{
  const src = new SP0256({ rom: rom('1101 0001 0001 0010') });
  src.step();
  src.loadAddress(7);
  src.mode = 3; src.repeatPrefix = 2; src.R = 5; src.P = 9;
  const saved = JSON.parse(JSON.stringify(src.saveState()));
  const dst = new SP0256({ rom: src.rom });
  dst.loadState(saved);
  for (const k of ['pc', 'pag', 'rb', 'retFlag', 'ib', 'ibf', 'repeatPrefix', 'mode', 'R', 'P', 'waiting', 'halted']) {
    is(`snapshot restores ${k}`, dst[k], src[k]);
  }
  const s2 = JSON.parse(JSON.stringify(dst.saveState()));
  is('a saved snapshot re-saves identically', JSON.stringify(s2), JSON.stringify(saved));
}

console.log(`${count - failures}/${count} checks passed`);
process.exitCode = failures ? 1 : 0;
