// Scanline video: unit tests whose expected values are worked out independently of the
// code under test. The authority for the whole behaviour is the MAME comparison
// (node tools/mame-diff/run.js <profile> --raster, every pixel of mid-line changes at every beam position);
// these tests pin the rules so that a change to them is noticed without MAME.
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// ---------------- position from clocks: MAME's rule ----------------
// mc6847.cpp scanline_position_from_clock: (clocks - 25) / 4 in C integer arithmetic, which truncates
// toward zero. So 21 clocks -> -4/4 = -1; 22..28 -> -3/4..3/4 = 0; 29 -> 1; 25 + 4*31 = 149 -> 31.
{
  const p = (c) => Emu.MC6847.positionFromClock(c);
  for (const [c, want] of [[0, -6], [21, -1], [22, 0], [24, 0], [25, 0], [28, 0], [29, 1], [149, 31], [153, 32]]) {
    check(`${c} clocks after the line starts is byte position ${want}`, p(c) === want, `(${p(c)})`);
  }
}

// ---------------- the SAM display counter: line start addresses ----------------
// The MC6883 data sheet's V2..V0 table gives, per mode, the bytes fetched per line and the lines that
// repeat each fetched row; so line k of a field starts at bytesPerLine * floor(k / linesPerRow), and its
// bytes follow on consecutively. V7 is DMA mode: horizontal sync leaves the counter alone, so line k
// starts 32 bytes after line k - 1.
{
  const table = [[0, 32, 12], [1, 16, 3], [2, 32, 3], [3, 16, 2], [4, 32, 2], [5, 16, 1], [6, 32, 1], [7, 32, 1]];
  const ram = new Uint8Array(0x10000);
  for (const [v, bpl, lpr] of table) {
    const sam = new Emu.SAM6883();
    sam.reg = v;                          // F bits 0: the field starts at $0000
    sam.resetVideoCounter();
    let ok = true, detail = '';
    for (let line = 0; line < 48 && ok; line++) {
      const want = bpl * Math.floor(line / lpr);
      for (let i = 0; i < bpl; i++) {
        sam.displayRead((a) => ram[a], i);
        if (sam.counter !== want + i) { ok = false; detail = `(line ${line} byte ${i}: $${sam.counter.toString(16)}, want $${(want + i).toString(16)})`; break; }
      }
      sam.horizontalSync();
    }
    check(`SAM V=${v}: ${bpl} bytes a line, ${lpr} line(s) a row`, ok, detail);
  }
}

// ---------------- a mode change part-way along a line, as seen in the picture ----------------
// The firmware waits for a horizontal sync, then after n NOPs switches the VDG from text to CG1. The
// display holds $41, which is a dark-green-on-green text cell but a CG1 byte of green and yellow, so the
// row the write lands in changes colour where the switch took effect. A NOP is 2 CPU cycles = 8 VDG
// clocks = 2 byte positions = 16 pixels, so each extra NOP must move that boundary 16 pixels right.
function splitColumn(px, W, rows) {
  // the first pixel of the active area that is CG1 yellow, on the first row that has one
  for (const y of rows) for (let x = 0; x < 256; x++) if ((px[y * W + 32 + x] & 0xFFFFFF) === YELLOW) return x;
  return null;
}
const YELLOW = (() => { const t = Emu.MC6847.TABLE; return t[1] & 0xFFFFFF; })();   // CG1 colour 1 (CSS 0)
function sweep(name, cpu, build, at, size, machineId) {
  const cols = [];
  for (let n = 0; n < 4; n++) {
    const asm = Emu.assemble(build(n), cpu);
    if (!asm.ok) { check(`${name}: firmware assembles`, false, asm.errors.map((e) => e.message).join('; ')); return; }
    const rom = new Uint8Array(size).fill(0x12);
    for (const s of asm.segments) if (s.addr >= at) rom.set(s.data.subarray(0, at + size - s.addr), s.addr - at);
    const m = Emu.createMachine(machineId);
    m.setRoms({ basic: rom });
    m.reset(true);
    // the firmware writes once: look at each frame for the split row, the one row with both a text cell
    // and CG1 yellow (the rows above it are text, the rows below CG1)
    let col = null;
    for (let f = 0; f < 10 && col === null; f++) {
      m.runFrame();
      const px = Emu.frameToRGBA(m.render()), W = Emu.MC6847.WIDTH;
      for (let y = Emu.MC6847.BORDER_Y; y < Emu.MC6847.BORDER_Y + 192 && col === null; y++) {
        const c = splitColumn(px, W, [y]);
        if (c !== null && c > 0) col = c;
      }
    }
    cols.push(col);
  }
  check(`${name}: a mid-line write splits a row`, cols[0] !== null && cols[0] > 0 && cols[0] < 256, `(column ${cols[0]})`);
  check(`${name}: each extra NOP moves the split 16 pixels`, cols.every((c, i) => i === 0 || c - cols[i - 1] === 16), `(columns ${cols.join(', ')})`);
}
// Dragon 64: HS on PIA0 CA1 with its interrupt enabled and masked; SYNC resumes at a fixed point after it
sweep('Dragon 64', '6809', (n) => `
        ORG     $8000
RESET   ORCC    #$50
        STA     $FFDD
        LDS     #$7F00
        LDX     #$0000
        LDA     #$41
FILL    STA     ,X+
        CMPX    #$2000
        BNE     FILL
        CLR     $FF23
        LDA     #$FF
        STA     $FF22
        LDA     #$34
        STA     $FF23
        CLR     $FF22           ; text, display at $0000 (SAM F = 0)
        CLR     $FF01
        CLR     $FF00
        LDA     #$35
        STA     $FF01
        LDB     #60
SKIP    TST     $FF00
        SYNC
        DECB
        BNE     SKIP
        TST     $FF00
        SYNC
        LDA     #$80
${'        NOP\n'.repeat(n + 2)}        STA     $FF22           ; CG1 from part-way along this line
HALT    BRA     HALT
        ORG     $BFFE
        FDB     RESET
        END     RESET`, 0x8000, 0x4000, 'dragon64');
// MC-10: no raster signals for the CPU, so the write's place is fixed by counting cycles from reset (the
// same in every run); the latch value $20 is CG1, the display RAM starts at $4000
sweep('MC-10', '6803', (n) => `
        ORG     $E000
RESET   SEI
        LDS     #$8EFF
        LDX     #$4000
        LDAA    #$41
FILL    STAA    ,X
        INX
        CPX     #$4200
        BNE     FILL
        CLR     $BFFF
        LDX     #2100           ; to row 60 of the active area
DLY     DEX
        BNE     DLY
        LDAA    #$20
${'        NOP\n'.repeat(n + 2)}        STAA    $BFFF
HALT    BRA     HALT
        ORG     $FFFE
        FDB     RESET
        END     RESET`, 0xE000, 0x2000, 'mc10');

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
