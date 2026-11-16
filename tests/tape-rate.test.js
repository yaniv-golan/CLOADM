// A cassette load at the SAM's address-dependent rate (01) succeeds or fails through the loader's own timing.
// The loader (written here) times each cycle of the cassette input (PIA1 PA0) with a counting loop and
// takes a short cycle (2400 Hz) as a 1, with a threshold set for the slow rate: one cycle at 1200 Hz is 746
// ticks, about 62 loops of 12 cycles; at 2400 Hz about 31; the threshold is 46. It syncs on $3C and stores
// the bytes that follow. Nothing in the emulator knows about loading: the tape plays in machine ticks.
// - rate 00 from ROM: loads.
// - rate 01 from ROM: every cycle of the loop is fast (ROM, $FF20 and $FFFF; MC6883 data sheet p. 11), so
//   the counts double, every cycle reads as a 0 and it never finds the sync byte.
// - rate 01 from RAM: opcode fetches and dummy reads stay slow, only the $FF20 read and VMA cycles are fast,
//   and the speed changes cost what those save: one loop is 17+16+16+16+16+15+8+25+16+16+16+15 = 192 crystal
//   clocks (INCB, LDA $FF20, LSRA, BCS; 15/17/25 are the SAM's speed-change cycles, see tests/samrate.test.js),
//   the same as 12 slow cycles, so the counts stay as they were and the load works.
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) fail++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name} ${detail}`); };

const src = `
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F00
        CLR     $FF21           ; PIA1 A: PA0 input, motor on (CA2 high)
        LDA     #$FE
        STA     $FF20
        LDA     #$3C
        STA     $FF21
        LDX     #LOADER         ; copy the loader to RAM
        LDY     #$3000
CP      LDA     ,X+
        STA     ,Y+
        CMPX    #LEND
        BNE     CP
        LDA     $0000           ; mode, set by the test: bit 0 rate 01, bit 1 run from RAM
        BITA    #1
        BEQ     M1
        STA     $FFD7
M1      BITA    #2
        LBNE    $3000
LOADER  CLRA                    ; (position independent from here)
SYNC    BSR     BIT
        RORA
        CMPA    #$3C
        BNE     SYNC
        LDX     #$0100
NEXTB   LDA     #8
        STA     $0010
        CLRA
NBIT    BSR     BIT
        RORA
        DEC     $0010
        BNE     NBIT
        STA     ,X+
        CMPX    #$0106
        BNE     NEXTB
        LDA     #$AA            ; done
        STA     $0011
DONE    BRA     DONE
* one cycle of the input: count loops while high, then while low; C = 1 for a short (2400 Hz) cycle
BIT     PSHS    A
        CLRB
H1      INCB
        LDA     $FF20
        LSRA
        BCS     H1
L1      INCB
        LDA     $FF20
        LSRA
        BCC     L1
        STB     $0020           ; the last count, for the test
        CMPB    #46
        PULS    A,PC
LEND    EQU     *
        ORG     $BFFE
        FDB     RESET
`;
const asm = Emu.assemble(src);
if (!asm.ok) throw new Error(JSON.stringify(asm.errors));
const image = new Uint8Array(0x4000).fill(0x12);
for (const s of asm.segments) image.set(s.data, s.addr - 0x8000);
const PAYLOAD = [...'CLOADM'].map((c) => c.charCodeAt(0));

function load(mode) {
  const p = Emu.profiles.dragon64, m = Emu.createMachine('dragon64', { mameCompat: false });
  const roms = {};
  for (const sl of p.roms) roms[sl.id] = image.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size);
  m.setRoms(roms); m.reset(true);
  m.ram[0] = mode;
  // sync byte, payload, and a trailing byte so that the last bit's cycle ends
  m.deck.insert(new Emu.Tape(new Uint8Array([0x3C, ...PAYLOAD, 0x55]), m.tickHz, 'test'));
  const counts = new Set();
  for (let f = 0; f < 150 && m.ram[0x11] !== 0xAA; f++) { m.runFrame(); counts.add(m.ram[0x20]); }
  return { done: m.ram[0x11] === 0xAA, bytes: [...m.ram.subarray(0x100, 0x106)], counts: [...counts].filter((c) => c).sort((a, b) => a - b) };
}

const slow = load(0), romFast = load(1), ramFast = load(3);
const span = (r) => `counts ${r.counts[0]}-${r.counts[r.counts.length - 1]}`;
check('rate 00, loader in ROM: loads the bytes', slow.done && slow.bytes.join() === PAYLOAD.join(), span(slow));
check('rate 01, loader in ROM: no load (every count above the threshold)', !romFast.done && romFast.counts[0] >= 46, span(romFast));
check('rate 01, loader in ROM: counts about twice the slow ones', romFast.counts[0] >= 2 * slow.counts[0] - 4, `${romFast.counts[0]} vs ${slow.counts[0]}`);
check('rate 01, loader in RAM: loads the bytes', ramFast.done && ramFast.bytes.join() === PAYLOAD.join(), span(ramFast));
check('rate 01, loader in RAM: counts within one of the slow ones', Math.abs(ramFast.counts[0] - slow.counts[0]) <= 1 &&
  Math.abs(ramFast.counts[ramFast.counts.length - 1] - slow.counts[slow.counts.length - 1]) <= 1, `${span(ramFast)} vs ${span(slow)}`);

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
