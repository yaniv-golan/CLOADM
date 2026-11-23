// The SP0256 sequencer and its timing (js/chips/sp0256.js, stage 2), and its output (stage 3, at the end). The ROMs here are written out byte by byte from
// the encoding (bits LSB first; an instruction is its 4-bit immediate, then its 4-bit opcode; branch addresses most
// significant bit first), and every expected count is worked out by hand from the timing rules, in the comments:
//   - a sample() call runs the sequencer when the repeat count is spent, then one excitation step;
//   - voiced (pitch P > 0): an impulse when the countdown reaches 0, which reloads it with P and spends one repeat,
//     so impulses are P + 1 samples apart; unvoiced (P = 0): a repeat is spent every 64 samples;
//   - the step that spends the last repeat is not a sample: the sequencer runs and the same call goes on;
//   - a load sets the repeat count to its repeat + 1 and the countdown to 0 (the first step is an impulse);
//   - RTS with no return address halts: SBY goes high, and while halted the excitation keeps its last pitch.
// The chip's behaviour beyond GI's documents is MAME 0.264's, and tools/mame-diff/ssc/speech.js compares it with
// MAME on our own image (docs/verification.md); these tests pin it without MAME.
const Emu = require('./load')();
void Emu;
const { SP0256, OP, FIELDS, XTAL, SAMPLE_CLOCKS } = require('../js/chips/sp0256.js');
const { assemble } = require('../tools/mame-diff/ssc/sp0256-asm.js');

let fail = 0;
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

// a 2 KB image with `bytes` at chip address `at` (and entry 1, at $1002, a JMP to $1080 unless given)
function rom(code, { entry1 = [0xE0, 0x01] } = {}) {
  const img = new Uint8Array(0x800);
  img.set(entry1, 2);
  img.set(code, 0x80);
  return img;
}
// sample() calls until `cond`, counting the call during which it became true (the call that made it so)
function callsUntil(c, cond, limit = 100000) {
  for (let n = 1; n <= limit; n++) { c.sample(); if (cond()) return n; }
  return -1;
}

// ---------------------------------------------------------------- constants and reset
{
  is('the crystal is 3.12 MHz (Radio Shack SP0256 datasheet)', XTAL, 3120000);
  is('312 clocks a sample on the hardware (SP0250 manual, SYNC), 336 under mameCompat (MAME 0.264)', SAMPLE_CLOCKS, { hardware: 312, mame: 336 });
  const c = new SP0256({ rom: rom([]) });
  is('reset: halted, in standby, ready for an address', [c.halted, c.sby, c.lrq], [true, true, true]);
  is('reset: the page is $1000 (as a bit address)', c.page, 0x1000 << 3);
}

// ---------------------------------------------------------------- the host interface
{
  const c = new SP0256({ rom: rom([]) });
  is('ALD is taken', c.loadAddress(1), true);
  is('... LRQ drops, SBY drops, entry 1 is a bit offset of 16', [c.lrq, c.sby, c.ald], [false, false, 16]);
  is('a second ALD while one waits is ignored', c.loadAddress(2), false);
  is('... and the first is kept', c.ald, 16);
}

// ---------------------------------------------------------------- bit order and a voiced load
// Entry 1 at $1002: E0 01 = immediate 0, opcode 14 (JMP), then 8 bits 0x01 = rev(0x80): the target $1080.
// $1080: 10 = SETMODE mode 0. 72 = LOAD_E, repeat 2. Its fields, LSB first: AM (6 bits) = 8, PR (8 bits) = 40:
// byte 08 holds AM's 6 bits and PR's bits 0-1 (both 0); byte 0A holds PR's bits 2-7 (40 >> 2 = 10) and the next
// instruction's first two bits; 00 = RTS (its remaining bits).
// Timing: repeat 2 -> 3 repeats at pitch 40, impulses 41 samples apart: impulse at call 1 (2 left), at call 42 (1
// left), at call 83 the last is spent: not a sample; RTS halts, SBY rises, and call 83 makes its sample.
const VOICED = [0x10, 0x72, 0x08, 0x0A, 0x00];
{
  const c = new SP0256({ rom: rom(VOICED) });
  c.loadAddress(1);
  is('voiced: LRQ is back up as soon as the sequencer takes the address (call 1)', callsUntil(c, () => c.lrq), 1);
  // (call 1 was made by the check above, so 82 more)
  is('... and SBY rises on call 83: 2 pitch periods of 41, then the RTS', 1 + callsUntil(c, () => c.sby), 83);
  // Halted, the excitation keeps the last pitch: its countdown was 40 after the last impulse and 39 after call 83,
  // so it reaches 0 after 39 more calls and the 40th spends the idle repeat: that is when a waiting address is
  // taken.
  c.loadAddress(1);
  is('an address loaded while idle is taken when the idle period runs out: 40 calls', callsUntil(c, () => c.lrq), 40);
}

// ---------------------------------------------------------------- unvoiced
// 10 = SETMODE; 71 = LOAD_E repeat 1. AM = 8, PR = 0: bytes 08, 00 (PR's bits 2-7 and the RTS's first two), 00. Repeat 1 -> 2 repeats of 64 samples: the countdown starts at 0 and drops first, to -1, which
// spends a repeat (call 1, a sample), reloads 64; it reaches 0 on call 65, the last repeat: RTS, then the sample.
{
  const c = new SP0256({ rom: rom([0x10, 0x71, 0x08, 0x00, 0x00]) });
  c.loadAddress(1);
  is('unvoiced: 64 samples a repeat, SBY on call 65', callsUntil(c, () => c.sby), 65);
}

// ---------------------------------------------------------------- a repeat of 0 reads no fields
// 10 = SETMODE; 70 = LOAD_E with repeat 0 (immediate 0, opcode 7: no fields); F1 = PAUSE repeat 1; 00 = RTS. A
// PAUSE holds pitch 64: impulses 65 apart, at calls 1 and 66, the second the last: SBY on call 66. Had the LOAD_E
// read its 14 bits, they would have been the PAUSE and the RTS (amplitude $31, pitch 3) and the zeros after them an
// RTS: SBY on call 1.
{
  const c = new SP0256({ rom: rom([0x10, 0x70, 0xF1, 0x00]) });
  c.loadAddress(1);
  is('repeat 0: the load reads none of its fields (the PAUSE after it runs: SBY on call 66)', callsUntil(c, () => c.sby), 66);
}

// ---------------------------------------------------------------- SETMODE's repeat high bits
// 11 = SETMODE mode 0 with repeat high bits 01: the next instruction's repeat is 16 + its own. 71 = LOAD_E repeat
// 1 -> 17, so 18 repeats; AM 8, PR 4: 08, 01 (4 >> 2) with the RTS: 01, 00. Impulses 5 apart from call 1: the 18th,
// the last, on call 1 + 17 x 5 = 86.
{
  const c = new SP0256({ rom: rom([0x11, 0x71, 0x08, 0x01, 0x00]) });
  c.loadAddress(1);
  is('SETMODE high bits: repeat 1 + 16 (SBY on call 86)', callsUntil(c, () => c.sby), 86);
}

// ---------------------------------------------------------------- JSR, RTS and the page
// $1080: D0 = JSR, immediate 0 (target bits 11-8 = 0); 05 = rev(0xA0): the subroutine at $10A0. Then 00 = RTS.
// $10A0: 10 SETMODE; 71 LOAD_E repeat 1, AM 8, PR 2: 08 | (2 << 6) = 88, then 00 (2 >> 2 = 0, and RTS): 00.
// Impulses 3 apart: calls 1 and 4; the RTS returns to $1083 (the byte after the JSR), whose RTS halts: SBY on call 4.
{
  const img = rom([0xD0, 0x05, 0x00]);
  img.set([0x10, 0x71, 0x88, 0x00, 0x00], 0xA0);
  const c = new SP0256({ rom: img });
  c.loadAddress(1);
  is('JSR to $10A0 and back (SBY on call 4)', callsUntil(c, () => c.sby), 4);
  is('... with no return address left', c.stack, 0);
}
{
  // PAGE: opcode 0 with a non-zero immediate, the page most significant bit first: 04 = immediate rev(2) = 4. The
  // page starts at 1 ($1000), so 2 shows the instruction took effect. The RTS (00) then halts.
  const c = new SP0256({ rom: rom([0x04, 0x00]) });
  c.loadAddress(1);
  c.sample();
  is('PAGE 2 sets the page to $2000', c.page, 0x2000 << 3);
}

// ---------------------------------------------------------------- interpolation and deltas (layout by sp0256-asm)
// These use the assembler for the long field layouts; its encoding is pinned against hand-written bytes below.
{
  // LOADALL in mode 1 has the interpolation fields. Repeat 2 -> 3 repeats; PR 4 and IP 1: each impulse adds 1 to
  // the pitch. Impulse at call 1 (reload 4, pitch becomes 5), at call 6 (reload 5, pitch 6), the last at call 12.
  const fields = [8, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
  const { image } = assemble([{ entry: 1, to: 'a' }, { label: 'a' }, { op: 'SETMODE', mode: 1 }, { op: 'LOADALL', repeat: 2, fields }, { op: 'RTS' }]);
  const c = new SP0256({ rom: image });
  c.loadAddress(1);
  is('interpolation: the pitch grows by 1 at each impulse (SBY on call 12)', callsUntil(c, () => c.sby), 12);
}
{
  // LOAD_E repeat 1 at pitch 10: impulses at calls 1 and 12; the second is the last, and DELTA_9 (mode 0) adds
  // -2 to the pitch (5 bits, 11110), repeat 1: impulse on call 12 (reload 8), the last on call 21; then RTS.
  const fields = [0, 0b11110, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const { image } = assemble([{ entry: 1, to: 'a' }, { label: 'a' }, { op: 'SETMODE', mode: 0 },
    { op: 'LOAD_E', repeat: 1, fields: [8, 10] }, { op: 'DELTA_9', repeat: 1, fields }, { op: 'RTS' }]);
  const c = new SP0256({ rom: image });
  c.loadAddress(1);
  is('delta: a 5-bit -2 is sign-extended and added to the pitch (SBY on call 21)', callsUntil(c, () => c.sby), 21);
  // halting clears the parameter registers, but the excitation keeps the pitch it was running at
  is('... and the excitation keeps pitch 8 after the halt (the registers are cleared)', [c.per, c.r[1]], [8, 0]);
}

// ---------------------------------------------------------------- the assembler against hand-written bytes
{
  const { image } = assemble([{ entry: 1, to: 'a' }, { label: 'a' }, { op: 'SETMODE', mode: 0 }, { op: 'LOAD_E', repeat: 2, fields: [8, 40] }, { op: 'RTS' }]);
  is('sp0256-asm: entry 1 is JMP $1080', Array.from(image.slice(2, 4)), [0xE0, 0x01]);
  is('sp0256-asm: SETMODE, LOAD_E repeat 2 (AM 8, PR 40), RTS', Array.from(image.slice(0x80, 0x85)), VOICED);
  const msb = assemble([{ entry: 1, to: 'a' }, { label: 'a' }, { op: 'SETMODE', mode: 2, msb: 1 }]).image;
  is('sp0256-asm: SETMODE mode 2 is immediate bit 2 (with the repeat high bits in bits 1-0)', msb[0x80], 0x15);
  let threw = null;
  try { assemble([{ op: 'LOAD_E', repeat: 1, fields: [64, 0] }]); } catch (e) { threw = e.message; }
  is('sp0256-asm: a field value too wide for its bits is refused', /6 bits/.test(threw || ''), true);
}

// ---------------------------------------------------------------- the parameter table's shape
{
  // every load has a field list for each mode; the branches, SETMODE and RTS have none
  const loads = Object.keys(OP).filter((k) => !['RTS_PAG', 'SETMODE', 'JSR', 'JMP'].includes(k));
  is('FIELDS covers every load in all four modes', loads.every((k) => FIELDS[OP[k]] && FIELDS[OP[k]].length === 4), true);
  is('... and nothing else', Object.keys(FIELDS).length, loads.length);
}

// ---------------------------------------------------------------- snapshot mid-utterance
{
  const mk = () => new SP0256({ rom: rom(VOICED) });
  const a = mk();
  a.loadAddress(1);
  for (let i = 0; i < 30; i++) a.sample();
  const b = mk();
  b.loadState(JSON.parse(JSON.stringify(a.saveState())));
  const trace = (c) => { const out = []; for (let i = 0; i < 200; i++) { c.sample(); out.push(`${c.sby}${c.lrq}${c.cnt}${c.rpt}`); } return out.join(','); };
  is('a snapshot in the middle of an allophone continues sample for sample', trace(b), trace(a));
  let threw = null;
  const s = a.saveState();
  delete s.r;
  try { mk().loadState(s); } catch (e) { threw = e.message; }
  is('a snapshot without the registers is refused', threw, 'snapshot: missing "r"');
}

// ---------------------------------------------------------------- the output (stage 3)
// The coefficient table's breakpoints, from the SP0250 Applications Manual's quantization: steps of 8 to 297 (code
// 37), of 4 to 425 (69), of 2 to 481 (97), of 1 to 511 (127). A clear sign bit gives a negative multiplier of the
// code's magnitude; a set one, the positive magnitude of the code's two's complement negation.
{
  const { coefficient } = require('../js/chips/sp0256.js');
  is('coefficients at the breakpoints, sign clear (negative)', [0, 1, 37, 38, 69, 70, 97, 98, 127].map(coefficient),
    [-0, -9, -297, -301, -425, -427, -481, -482, -511]);
  // 0xFF negates to 1 (9), 0x81 to 127 (511), 0x80 to 0 (0), 0xDB to 37 (297)
  is('coefficients with the sign bit set (positive)', [0xFF, 0x81, 0x80, 0xDB].map(coefficient), [9, 511, 0, 297]);
}
// The filter, worked by hand: v = x; for each stage v += (B x older) >> 9, v += (F x newer) >> 8, then the stage's
// delays shift (older = newer, newer = v); the output is v held to -8192..8191, times 4.
{
  const c = new SP0256();
  c.f[0] = 128;                                                     // stage 0: v += newer / 2
  is('one stage, F = 128: 1000, then 0, 0 in: 4000, 2000, 1000 out', [c.filter(1000), c.filter(0), c.filter(0)], [4000, 2000, 1000]);
  c.reset(); c.f[0] = 128; c.b[0] = -256;                          // and v += -older / 2
  is('the same with B = -256: the third is 250 - 500 = -250, x 4', [c.filter(1000), c.filter(0), c.filter(0)], [4000, 2000, -1000]);
  c.reset(); c.b[0] = -1; c.z[1] = 1;                               // (-1 x 1) >> 9 rounds down, to -1
  is('a product is shifted with its sign: (-1 x 1) >> 9 is -1', c.filter(0), -4);
  c.reset();
  is('the output is held to 14 bits: 3000, 9000, -9000 in give 12000, 32764, -32768', [c.filter(3000), c.filter(9000), c.filter(-9000)], [12000, 32764, -32768]);
  c.reset(); c.f[0] = 256; c.z[0] = 30000;                          // 10000 + 30000 = 40000 wraps to -25536
  is('the stages add in 16 bits that wrap: 10000 + 30000 is -25536, held to -8192', c.filter(10000), -32768);
}
// The excitation, worked by hand from the state it starts in.
{
  const c = new SP0256();
  c.per = 5; c.cnt = 0; c.rpt = 5; c.amp = 100; c.z.fill(7);
  is('voiced: the impulse is the amplitude, and it clears the stages\' delays', [c.excite(), Array.from(c.z), c.cnt, c.rpt], [100, Array(12).fill(0), 5, 4]);
  is('voiced: between impulses the excitation is 0', c.excite(), 0);
  c.reset(); c.per = 0; c.cnt = 1; c.rpt = 5; c.amp = 50; c.rng = 1; c.z.fill(7);
  // rng 1: bit 1 -> +50, rng (1 >> 1) ^ 0x4001 = 0x4001; that call also spends a repeat (the count reached 0) and
  // clears the delays. rng 2: bit 0 -> -50, rng 1.
  is('unvoiced: the noise bit gives +amplitude, the register shifts with taps 0x4001, a repeat clears the delays',
    [c.excite(), c.rng, c.rpt, c.cnt, Array.from(c.z)], [50, 0x4001, 4, 64, Array(12).fill(0)]);
  c.rng = 2;
  is('unvoiced: a 0 bit gives -amplitude', [c.excite(), c.rng], [-50, 1]);
}
// Halted, the chip keeps its last amplitude, pitch and coefficients (MAME's behaviour): a voiced sound falls silent,
// an unvoiced one goes on as noise until the next address. One LOAD_C (mode 0) each, then RTS.
{
  const halt = (pitch) => {
    const img = assemble([{ entry: 1, to: 'a' }, { label: 'a' }, { op: 'SETMODE', mode: 0 },
      { op: 'LOAD_C', repeat: 1, fields: [20, pitch, 3, 2, 3, 2, 3, 2, 5, 3, 9, 4] }, { op: 'RTS' }]).image;
    const c = new SP0256({ rom: img });
    c.loadAddress(1);
    callsUntil(c, () => c.sby);
    const after = [];
    for (let k = 0; k < 3000; k++) after.push(c.sample());
    return after;
  };
  const voiced = halt(60), noise = halt(0);
  // the stale pitch still counts impulses, but each one is the step that spends the halted chip's one repeat, which is
  // not a sample: nothing new is heard
  is('halted after a voiced sound: silent from then on (its impulses are never output)', voiced.every((v) => v === 0), true);
  is('halted after an unvoiced sound: the noise goes on', noise.slice(-500).filter((v) => v !== 0).length > 400, true);
}
// the output's state in a snapshot
{
  const c = new SP0256();
  c.b[2] = -301; c.f[5] = 9; c.z[7] = -1234; c.out = 812; c.rng = 0x1234;
  const d = new SP0256();
  d.loadState(JSON.parse(JSON.stringify(c.saveState())));
  is('a snapshot keeps the coefficients, the delays, the noise register and the output',
    [d.b[2], d.f[5], d.z[7], d.out, d.rng], [-301, 9, -1234, 812, 0x1234]);
  const bad = JSON.parse(JSON.stringify(c.saveState()));
  bad.z = bad.z.slice(1);
  let threw = null;
  try { d.loadState(bad); } catch (e) { threw = e.message; }
  is('a snapshot with the wrong number of delays is refused', threw, 'snapshot: "z" has 11 entries, not 12');
}

console.log(fail ? `${fail} failed` : 'all passed');
process.exitCode = fail ? 1 : 0;
