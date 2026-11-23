// Compare rendered CoCo 3 video against MAME: node tools/mame-diff/coco3/run-vdg.js
// Generates vdg.asm (our own firmware) that shows a list of display modes for 30 fields each,
// runs it on both emulators with MAME's RGB monitor and compares the whole 640x240 picture pixel by pixel in
// exact RGB. ARTIFACT=N (run.js coco3 --video --artifact N) sets MAME's "Artifacting" option and ours alike:
// 0 off (the default here), 1 Standard, 2 Reverse - the NTSC artifact colours of the compatibility modes'
// 256-pixel two-colour mode, which MAME draws through the MC6847's artifacter (gime.cpp render_scanline) with
// the palette in use, on either monitor. With the RGB monitor their mixes are of exact GIME RGB colours, so they
// are compared exactly too.
//
// Our text-mode fonts are our own designs, so text glyphs are not expected to match MAME's: in
// text modes a differing character cell counts as a "font" difference when the two pictures
// together use only two colours (its foreground and background) in that cell; anything else is
// a real difference. Not compared: MAME's last visible scanline (see below).
// Env: VDG_WORK (default: a fresh folder, removed at exit), SKIP_MAME=1 to reuse captures, REV=1 to show the
// modes in reverse order (checks that results do not depend on the previous mode).
//
// ATTR=1 (run.js coco3 --video --attr): the GIME text attributes instead, compared exactly with no allowance for
// glyph shapes (vdg-attr.asm). The screen holds only blank characters ($20, and $A0, which the GIME draws from
// the same glyph: it uses the low seven bits), so the fonts never show, and each cell's attribute byte is its
// cell number: every one of the 256 attribute bytes appears, in 32, 40, 64 and 80 columns and at every
// lines-per-row setting that has a defined underline (0-6; MAME gives 7 0xFFFF lines a row and reads its font
// past the end of the table). What shows is the background (bits 0-2), the underline (bit 6) drawn in the
// foreground (bits 3-5) on the row MAME and the GIME pick for the lines-per-row, and blink (bit 7), which blanks
// the character and drops its underline while the GIME's timer has toggled the blink state: each mode is shown
// with blink off, then again after one timer expiry, with the timer stopped so the state holds.
const fs = require('fs'), path = require('path');
const { loadEmu, romImage } = require('../lib/firmware');
const { runMame } = require('../lib/mame');
const assemble = (src) => {
  const res = loadEmu().assemble(src, '6809');
  // a failed assembly is fatal: throw, and let the top-level handler set exitCode. `process.exitCode = 1; return`
  // would only leave this arrow function and carry on with an undefined result.
  if (!res.ok) { const e = new Error(`assembling the video firmware failed: ${JSON.stringify(res.errors)}`); e.asm = res.errors; throw e; }
  return res;
};
const Emu = loadEmu();
const ATTR = !!process.env.ATTR;
// MONITOR=composite (run.js coco3 --video --composite): MAME's composite monitor and ours, every mode plus the
// $FF98 BPI (burst phase invert) and MOCH (monochrome) variants, in vdg-composite.asm
const COMPOSITE = process.env.MONITOR === 'composite';
// COMPAT=1 (run.js coco3 --video --compat): the compatibility-mode text screen at $FF9C values other than BASIC's
// 12 lines a row (vdg-compat.asm). $FF9C sets the lines each text row takes (COMPAT_TEXT_LPR: 8, 9, 4, 1 lines and so
// on), so the screen shows more rows than BASIC's 16 - 24 at 8 lines on a 192-line body, 25 on a 200-line one. Each is
// compared cell for cell, a cell tall as $FF9C says, so the row count and the last cut row are checked.
const COMPAT = !!process.env.COMPAT;
const { png } = require('../lib/png');
const { workDir, keepWorkDir } = require('../lib/workdir');
const ARTIFACT = process.env.ARTIFACT === undefined ? 0 : +process.env.ARTIFACT;
// VDG_WORK: a folder of your own, kept (and needed by SKIP_MAME=1); otherwise a fresh one, removed at exit
const VARIANT = ATTR ? 'attr' : COMPAT ? 'compat' : COMPOSITE ? 'composite' : `artifact${ARTIFACT}`;
const WORK = process.env.VDG_WORK || workDir(`coco3-vdg-${VARIANT}`);
if (process.env.SKIP_MAME && !process.env.VDG_WORK) { console.error('SKIP_MAME=1 reuses captures in VDG_WORK: set VDG_WORK too'); process.exitCode = 2; return; }
fs.mkdirSync(path.join(WORK, 'roms/coco3'), { recursive: true });
fs.mkdirSync(path.join(WORK, 'out'), { recursive: true });

// ---- display modes: [name, $FF90, $FF98, $FF99, $FF9A, $FF9F, $FF22, SAM V, text columns (0 = graphics)] ----
const C = 0xC0; // CoCo-compatible mode, MMU off
// the compatibility-mode text screens at $FF9C values other than BASIC's $0F (12 lines a row): 8, 9, 4 and 1 lines
// (S5's SG modes are the 4, 3, 2 and 1-line settings), on a 192-line body and 8 lines on a 200-line one. COMPAT=1.
const COMPAT_MODES = [
  ['compat text 8 lines ($FF9C 3)', C, 0, 0, 0, 0, 0x00, 0, 32], ['compat text 9 lines ($FF9C 2)', C, 0, 0, 0, 0, 0x00, 0, 32],
  ['compat text 4 lines ($FF9C B)', C, 0, 0, 0, 0, 0x00, 0, 32], ['compat text 1 line ($FF9C A)', C, 0, 0, 0, 0, 0x00, 0, 32],
  ['compat text 8 lines, 200 ($FF9C 3)', C, 0, 0x20, 0, 0, 0x00, 0, 32],
];
const COMPAT_FF9C = [0x03, 0x02, 0x0B, 0x0A, 0x03];   // each compat mode's $FF9C, in MODES order
const MODES_ALL = [
  ['compat text CSS0', C, 0, 0, 0, 0, 0x00, 0, 32], ['compat text CSS1', C, 0, 0, 0, 0, 0x08, 0, 32],
  ['compat text lower case', C, 0, 0, 0, 0, 0x10, 0, 32], ['compat text GM1 inverse', C, 0, 0, 0, 0, 0x20, 0, 32],
  ['compat text GM2 CSS1', C, 0, 0, 0, 0, 0x48, 0, 32],
  ['CG1 CSS0', C, 0, 0, 0, 0, 0x80, 1, 0], ['CG1 CSS1', C, 0, 0, 0, 0, 0x88, 1, 0],
  ['RG1', C, 0, 0, 0, 0, 0x90, 1, 0], ['CG2', C, 0, 0, 0, 0, 0xA0, 2, 0], ['RG2 CSS1', C, 0, 0, 0, 0, 0xB8, 3, 0],
  ['CG3', C, 0, 0, 0, 0, 0xC0, 4, 0], ['RG3', C, 0, 0, 0, 0, 0xD0, 5, 0],
  ['CG6 CSS0', C, 0, 0, 0, 0, 0xE0, 6, 0], ['CG6 CSS1', C, 0, 0, 0, 0, 0xE8, 6, 0],
  ['RG6 CSS0', C, 0, 0, 0, 0, 0xF0, 6, 0], ['RG6 CSS1', C, 0, 0, 0, 0, 0xF8, 6, 0],
  ['text 32', 0, 0x03, 0x00, 0x05, 0, 0, 0, 32], ['text 32 attr', 0, 0x03, 0x01, 0x0A, 0, 0, 0, 32],
  ['text 40', 0, 0x03, 0x04, 0x11, 0, 0, 0, 40], ['text 40 attr', 0, 0x03, 0x05, 0x16, 0, 0, 0, 40],
  ['text 64', 0, 0x03, 0x10, 0x21, 0, 0, 0, 64], ['text 64 attr', 0, 0x03, 0x11, 0x2C, 0, 0, 0, 64],
  ['text 80', 0, 0x03, 0x14, 0x33, 0, 0, 0, 80], ['text 80 attr', 0, 0x03, 0x15, 0x38, 0, 0, 0, 80],
  ['text 80 attr 9 lines', 0, 0x04, 0x15, 0x07, 0, 0, 0, 80], ['text 40 attr 11 lines', 0, 0x06, 0x05, 0x09, 0, 0, 0, 40],
  ['128x192x2', 0, 0x80, 0x00, 0x12, 0, 0, 0, 0], ['256x192x2', 0, 0x80, 0x08, 0x13, 0, 0, 0, 0],
  ['128x192x4', 0, 0x80, 0x09, 0x14, 0, 0, 0, 0], ['64x192x16', 0, 0x80, 0x0A, 0x15, 0, 0, 0, 0],
  ['160x192x2', 0, 0x80, 0x04, 0x16, 0, 0, 0, 0], ['320x192x2', 0, 0x80, 0x0C, 0x17, 0, 0, 0, 0],
  ['160x192x4', 0, 0x80, 0x0D, 0x18, 0, 0, 0, 0], ['512x192x2', 0, 0x80, 0x10, 0x19, 0, 0, 0, 0],
  ['256x192x4', 0, 0x80, 0x11, 0x1A, 0, 0, 0, 0], ['128x192x16', 0, 0x80, 0x12, 0x1B, 0, 0, 0, 0],
  ['640x192x2', 0, 0x80, 0x14, 0x1C, 0, 0, 0, 0], ['320x192x4', 0, 0x80, 0x15, 0x1D, 0, 0, 0, 0],
  ['160x192x16', 0, 0x80, 0x16, 0x1E, 0, 0, 0, 0], ['512x192x4 (128 bytes)', 0, 0x80, 0x19, 0x1F, 0, 0, 0, 0],
  ['256x192x16', 0, 0x80, 0x1A, 0x20, 0, 0, 0, 0], ['640x192x4', 0, 0x80, 0x1D, 0x22, 0, 0, 0, 0],
  ['320x192x16', 0, 0x80, 0x1E, 0x24, 0, 0, 0, 0],
  ['320x200x16', 0, 0x80, 0x3E, 0x25, 0, 0, 0, 0], ['320x225x16', 0, 0x80, 0x7E, 0x26, 0, 0, 0, 0],
  ['640x200x4', 0, 0x80, 0x3D, 0x27, 0, 0, 0, 0],
  ['320x16 2 lines/row', 0, 0x82, 0x1E, 0x28, 0, 0, 0, 0],
  ['320x16 h-offset', 0, 0x80, 0x1E, 0x29, 0x05, 0, 0, 0], ['320x16 virtual 256', 0, 0x80, 0x1E, 0x2A, 0x83, 0, 0, 0],
];

// the attribute suite: [name, $FF90, $FF98, $FF99, $FF9A, $FF9F, $FF22, SAM V, 0 (compared exactly), blink]
const ATTR_MODES = [];
for (const [cols, f99] of [[32, 0x01], [40, 0x05], [64, 0x11], [80, 0x15]]) {
  for (let lpr = 0; lpr <= 6; lpr++) ATTR_MODES.push([`attr ${cols} lpr ${lpr}`, 0, lpr, f99, 0x30 + lpr, 0, 0, 0, 0, false]);
}
// blink on: the GIME's blink state toggles at each timer expiry (MAME gime.cpp timer_elapsed); these come last, so
// every mode above is shown with it off, as reset leaves it
for (const [cols, f99] of [[40, 0x05], [80, 0x15]]) for (const lpr of [3, 4, 6]) ATTR_MODES.push([`attr ${cols} lpr ${lpr} blink`, 0, lpr, f99, 0x30 + lpr, 0, 0, 0, 0, true]);

// the composite monitor's palette choices: $FF98 bit 5 (BPI) selects MAME's phase-inverted colour table, bit 4
// (MOCH) grey; in the GIME modes, and in the compatibility modes, whose $FF98 the firmware writes too
const COMPOSITE_MODES = [...MODES_ALL];
for (const [name, f90, f98, f99, f9a, f9f, f22, v, cols] of MODES_ALL.filter((m) => ['RG6 CSS0', 'CG3', 'compat text CSS1', 'text 80 attr', '320x192x16', '640x192x4'].includes(m[0]))) {
  COMPOSITE_MODES.push([`${name} BPI`, f90, f98 | 0x20, f99, f9a, f9f, f22, v, cols]);
  COMPOSITE_MODES.push([`${name} MOCH`, f90, f98 | 0x10, f99, f9a, f9f, f22, v, cols]);
  COMPOSITE_MODES.push([`${name} BPI MOCH`, f90, f98 | 0x30, f99, f9a, f9f, f22, v, cols]);
}

// COMPAT: its modes carry their $FF9C as a per-mode byte (a tenth field the firmware reads after $FF22); the other
// suites keep the fixed $0F the firmware sets once, so their firmware is unchanged.
if (COMPAT) for (const [i, m] of COMPAT_MODES.entries()) m.push(COMPAT_FF9C[i]);
const MODES = ATTR ? ATTR_MODES : COMPOSITE ? COMPOSITE_MODES : COMPAT ? COMPAT_MODES : process.env.REV ? MODES_ALL.slice().reverse() : MODES_ALL;

// ---- firmware ----
const L = [];
const e = (s) => L.push(s);
e(`PHASE   EQU     $7F00`);
e(`        ORG     $8000`);
e(`RESET   ORCC    #$50`);
e(`        LDS     #$7FF0`);
e(`        CLRA`);
e(`        TFR     A,DP`);
e(`        CLR     $FF03`);
e(`        LDA     #$FF`);
e(`        STA     $FF02`);
e(`        LDA     #$34`);
e(`        STA     $FF03`);
e(`        CLR     $FF23`);
e(`        LDA     #$F8`);
e(`        STA     $FF22`);
e(`        LDA     #$34`);
e(`        STA     $FF23`);
if (!ATTR) {
  // display data at $0000-$7EFF (physical $70000): byte = low(addr) + 3*high(addr)
  e(`        LDX     #$0000`);
  e(`GX      TFR     X,D`);
  e(`        PSHS    B`);
  e(`        LDB     #3`);
  e(`        MUL`);
  e(`        ADDB    ,S+`);
  e(`        STB     ,X+`);
  e(`        CMPX    #$7F00`);
  e(`        BLO     GX`);
} else {
  // (character, attribute) pairs from $0000: the character $20 or, every other 256 cells, $A0; the attribute the
  // cell number's low byte (B counts the cells, A the 256-cell pages)
  e(`        LDX     #$0000`);
  e(`        CLRA`);
  e(`        CLRB`);
  e(`GX      PSHS    A`);
  e(`        ANDA    #1`);
  e(`        BEQ     GX1`);
  e(`        LDA     #$A0`);
  e(`        BRA     GX2`);
  e(`GX1     LDA     #$20`);
  e(`GX2     STA     ,X+`);
  e(`        STB     ,X+`);
  e(`        PULS    A`);
  e(`        INCB`);
  e(`        BNE     GX3`);
  e(`        INCA`);
  e(`GX3     CMPX    #$7F00`);
  e(`        BLO     GX`);
}
e(`        LDA     #$E0`);
e(`        STA     $FF9D`);      // video at physical $70000 (CPU $0000 with the MMU off)
e(`        CLR     $FF9E`);
e(`        LDA     #$0F`);
e(`        STA     $FF9C`);
e(`        CLR     PHASE`);
e(`        LDY     #MODES`);
e(`NEXT    LDA     ,Y+`);
e(`        CMPA    #$FF`);
e(ATTR ? `        LBEQ    DONE` : `        BEQ     DONE`);   // (the attribute suite's blink step puts DONE out of short range)
e(`        STA     $FF90`);
for (const r of ['$FF98', '$FF99', '$FF9A', '$FF9F', '$FF22']) { e(`        LDA     ,Y+`); e(`        STA     ${r}`); }
if (COMPAT) { e(`        LDA     ,Y+`); e(`        STA     $FF9C`); }   // this mode's lines a text row
e(`        LDB     ,Y+`);         // SAM V
e(`        LDX     #$FFC0`);
e(`        LDA     #3`);
e(`        PSHS    A`);
e(`SB1     LSRB`);
e(`        BCS     SB2`);
e(`        STA     ,X`);
e(`        BRA     SB3`);
e(`SB2     STA     1,X`);
e(`SB3     LEAX    2,X`);
e(`        DEC     ,S`);
e(`        BNE     SB1`);
e(`        PULS    A`);
e(`        LDX     ,Y++`);        // palette table
e(`        LDU     #$FFB0`);
e(`PL      LDA     ,X+`);
e(`        STA     ,U+`);
e(`        CMPU    #$FFC0`);
e(`        BNE     PL`);
if (ATTR) {
  // blink: one GIME timer expiry toggles the blink state; then the timer stops (value 0) so it holds
  e(`        LDA     ,Y+`);
  e(`        BEQ     NOBL`);
  e(`        LDA     #$20`);         // TMR in the GIME's IRQ enables, so $FF92 reports it
  e(`        STA     $FF92`);
  e(`        LDA     $FF92`);         // clear anything pending
  e(`        CLR     $FF94`);
  e(`        LDA     #$40`);
  e(`        STA     $FF95`);
  e(`        CLR     $FF94`);         // (a write to $FF94 starts the timer: 64 + 2 lines)
  e(`BLW     LDA     $FF92`);
  e(`        BITA    #$20`);
  e(`        BEQ     BLW`);
  e(`        CLR     $FF95`);
  e(`        CLR     $FF94`);         // value 0: the timer stops
  e(`        CLR     $FF92`);
  e(`NOBL    EQU     *`);
}
e(`        INC     PHASE`);
e(`        LDB     #30`);
e(`WAIT    LDA     $FF02`);
e(`W1      LDA     $FF03`);
e(`        BPL     W1`);
// Just after field sync (in the border): change palette 0 and put it back. Nothing is displayed
// in between, but MAME's GIME then sees new palette "rotations" on every line and redraws the
// whole picture; otherwise MAME can keep showing parts of an earlier mode after a mode change.
e(`        LDA     -16,X`);
e(`        EORA    #$01`);
e(`        STA     $FFB0`);
e(`        EORA    #$01`);
e(`        STA     $FFB0`);
e(`        DECB`);
e(`        BNE     WAIT`);
e(ATTR ? `        LBRA    NEXT` : `        BRA     NEXT`);
e(`DONE    BRA     DONE`);
const hx = (v) => '$' + v.toString(16).toUpperCase().padStart(2, '0');
e(`MODES   EQU     *`);
for (const m of [...MODES, MODES[MODES.length - 1]]) {   // the extra entry lets the last mode be captured
  const [, f90, f98, f99, f9a, f9f, f22, v] = m;
  // the other suites emit one line (byte-identical to before); COMPAT splits it so $FF9C sits between $FF22 and SAM V,
  // the order the firmware reads them in
  if (COMPAT) { e(`        FCB     ${[f90, f98, f99, f9a, f9f, f22].map(hx).join(',')},${hx(m[9])},${hx(v)}`); }
  else e(`        FCB     ${[f90, f98, f99, f9a, f9f, f22, v].map(hx).join(',')}`);
  e(`        FDB     ${f90 & 0x80 ? 'PALC' : 'PALG'}`);
  // toggle the blink state once, at the first blink mode; it then holds for the rest (the timer is stopped)
  if (ATTR) e(`        FCB     ${m[9] && m === MODES.find((x) => x[9]) ? 1 : 0}`);
}
e(`        FCB     $FF`);
e(`PALC    FCB     18,54,9,36,63,27,45,38,0,18,0,63,0,18,0,38`);   // CoCo 3 BASIC compatibility palette
e(`PALG    FCB     ${Array.from({ length: 16 }, (_, i) => (i * 5 + 3) & 63).join(',')}`);
e(`        ORG     $FFFE`);
e(`        FDB     RESET`);
fs.writeFileSync(path.join(__dirname, ATTR ? 'vdg-attr.asm' : COMPAT ? 'vdg-compat.asm' : COMPOSITE ? 'vdg-composite.asm' : 'vdg.asm'), '; CoCo 3 video comparison firmware, generated by run-vdg.js - do not edit\n' + L.join('\n') + '\n        END     RESET\n');
let asm;
try { asm = assemble(L.join('\n')); } catch (e) { console.error(e.asm || e.message); process.exitCode = 1; return; }   // module scope: nothing below runs
const rom = romImage(asm, 0x8000, 0x8000, 0x12);
fs.writeFileSync(path.join(WORK, 'roms/coco3/coco3.rom'), rom);

const N = MODES.length;
if (!process.env.SKIP_MAME) {
  for (const f of fs.readdirSync(path.join(WORK, 'out'))) fs.unlinkSync(path.join(WORK, 'out', f));
  fs.rmSync(path.join(WORK, 'cfg'), { recursive: true, force: true });   // saved settings would override ours
  runMame({ work: WORK, system: 'coco3', lua: `local function setup()
  manager.machine.ioport.ports[":screen_config"].fields["Monitor Type"]:set_value(${COMPOSITE ? 0 : 1})   -- ${COMPOSITE ? 'composite' : 'RGB'} monitor
  manager.machine.ioport.ports[":gime:artifacting"].fields["Artifacting"].user_value = ${ARTIFACT}
end
setup()
local space = manager.machine.devices[":maincpu"].spaces["program"]
local scr = nil
for tag, s in pairs(manager.machine.screens) do scr = s end
local last, wait = -1, -1
emu.register_frame_done(function()
  setup()
  local ph = space:read_u8(0x7F00)
  if ph ~= last then last = ph; wait = 16 end
  if wait > 0 then wait = wait - 1 end
  if wait == 1 or wait == 0 then
    local px, w, h = scr:pixels()
    local f = io.open(string.format("${WORK}/out/phase%02d%s.raw", ph, wait == 1 and "a" or "b"), "wb")
    f:write(string.format("%d %d\\n", w, h)); f:write(px); f:close()
    if wait == 0 then wait = -1 end
    if ph == ${N + 1} and wait == -1 then manager.machine:exit() end
  end
end)
`, seconds: 60, args: ['-ext', ''], video: true });
}

// ---- our captures (same rule: 15 fields after the phase changes) ----
const m = Emu.createMachine('coco3', { mameCompat: true }); // MAME's speed-switch scheduling
m.setRoms({ basic: rom }); m.reset(true);
m.gime.artifact = ARTIFACT;
if (COMPOSITE) m.monitor = 'composite';
const ours = {};
let last = -1, wait = -1;
for (let f = 0; f < 60 * 40 && !ours[N]; f++) {
  m.runFrame();
  const ph = m.ram[0x7F00];
  if (ph !== last) { last = ph; wait = 15; }
  if (wait > 0) wait--;
  else if (wait === 0) { wait = -1; ours[ph] = Emu.frameToRGBA(m.render()); }
}

const W = 640, H = 240;
let same = 0, fontOnly = 0, failed = 0;
for (let ph = 1; ph <= N; ph++) {
  const [name, f90, f98, f99, , , , , cols] = MODES[ph - 1];
  // (MAME renders with a dummy SDL display: with -video none its bitmap is only partly refreshed)
  // MAME double-buffers its screen bitmap and skips the redraw when the GIME reports that nothing
  // changed, so one of two consecutive captured fields can still hold an older picture; the
  // field that is closer to ours is compared.
  const files = ['a', 'b'].map((s) => path.join(WORK, 'out', `phase${String(ph).padStart(2, '0')}${s}.raw`));
  if (!files.every((f) => fs.existsSync(f)) || !ours[ph]) { console.log(`MISSING ${name}`); failed++; continue; }
  const score = (f) => { const b = fs.readFileSync(f), nl = b.indexOf(10), [w] = b.slice(0, nl).toString().split(' ').map(Number);
    const p = new Uint32Array(b.buffer.slice(b.byteOffset + nl + 1, b.byteOffset + b.length)); let n = 0;
    for (let y = 0; y < 238; y++) for (let x = 0; x < w; x++) { const c = ours[ph][y * W + x]; if ((p[y * w + x] & 0xFFFFFF) !== (((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF))) n++; }
    return n; };
  const buf = fs.readFileSync(score(files[0]) <= score(files[1]) ? files[0] : files[1]);
  const nl = buf.indexOf(10);
  const [mw, mh] = buf.slice(0, nl).toString().split(' ').map(Number);
  const mp = new Uint32Array(buf.buffer.slice(buf.byteOffset + nl + 1, buf.byteOffset + buf.length));
  const op = ours[ph];
  // MAME's screen:pixels() returns the visible area minus its last row and column (639 x 239)
  // Its last row (scanline 239, in the bottom border) is not refreshed on every mode change in
  // MAME (it can still show the border of an earlier mode), so it is not compared either.
  const M = (x, y) => (x < mw && y < mh - 1 ? mp[y * mw + x] & 0xFFFFFF : O(x, y));   // MAME: xRGB
  function O(x, y) { const c = op[y * W + x]; return ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF); }
  const bad = new Uint8Array(W * H);
  let nbad = 0;
  // artifact-coloured pixels (not one of the 64 GIME colours), counted to show the comparison covers them
  const LV = new Set([0, 0x55, 0xAA, 0xFF]);
  const isGime = (c) => LV.has(c >> 16) && LV.has((c >> 8) & 0xFF) && LV.has(c & 0xFF);
  let mixed = 0;
  for (let y = 0; y < Math.min(H, mh); y++) for (let x = 0; x < Math.min(W, mw); x++) {
    if (!isGime(M(x, y))) mixed++;
    if (M(x, y) === O(x, y)) continue;
    bad[y * W + x] = 1; nbad++;
  }
  let realBad = nbad, cells = 0;
  if (nbad && cols) {
    // text: classify differences per character cell
    const legacy = !!(f90 & 0x80);
    const cw = legacy ? 16 : ((f99 & 0x04) ? 640 : 512) / cols, x0 = legacy || !(f99 & 0x04) ? 64 : 0;
    // a compatibility text cell is $FF9C's lines tall (12 at BASIC's $0F; the COMPAT suite is other values), a GIME one $FF98's
    const ch = legacy ? (COMPAT ? [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 4, 3, 2, 1, 12][MODES[ph - 1][9]] : 12) : [1, 1, 2, 8, 9, 10, 11, 1][f98 & 7];
    // the body's first picture line and height, from $FF99 bits 5-6 (192, 200 or 225 lines: the top border is 25, 23 or
    // 8 lines, and recordBody's y = physical - 1, so the first body line is 24, 22 or 7). A fixed 24 and 192 cut every
    // cell wrong on a 200- or 225-line screen: the grid straddled two text rows and a two-colour cell read as three.
    // 10xxxxxx (LPF 2) is the GIME's "zero/infinite" line count (js/chips/gime.js updateGeometry, MAME's LPF 2): the
    // body never ends, so there is no character grid to classify against. No mode in any suite sets it; if one did
    // there is nothing to grade, so it is counted as a difference rather than thrown on.
    const body = { 0x00: [24, 192], 0x20: [22, 200], 0x60: [7, 225] }[f99 & 0x60];
    if (!body) { failed++; console.log(`DIFF  ${name.padEnd(24)} $FF99 bits 5-6 = 0x${(f99 & 0x60).toString(16)} is the GIME's no-body line count: no character grid to compare`); continue; }
    const [y0, bodyLines] = body;
    realBad = 0;
    for (let cy = y0; cy < y0 + bodyLines; cy += ch) for (let cx = x0; cx < x0 + cols * cw; cx += cw) {
      let any = false; const sm = new Set(), so = new Set();
      for (let y = cy; y < Math.min(cy + ch, y0 + bodyLines); y++) for (let x = cx; x < cx + cw; x++) { if (bad[y * W + x]) any = true; sm.add(M(x, y)); so.add(O(x, y)); }
      if (!any) continue;
      // a character cell only ever shows its foreground and background colour, so if both
      // pictures together use no more than two colours in it, only the glyph shapes differ
      const sameSet = new Set([...sm, ...so]).size <= 2;
      if (sameSet) cells++;
      else for (let y = cy; y < Math.min(cy + ch, y0 + bodyLines); y++) for (let x = cx; x < cx + cw; x++) if (bad[y * W + x]) realBad++;
    }
    // differences outside the character grid are real
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (bad[y * W + x] && (y < y0 || y >= y0 + bodyLines || x < x0 || x >= x0 + cols * cw)) realBad++;
  }
  if (realBad) {
    failed++;
    const img = Buffer.alloc(W * 3 * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const put = (xx, c) => { const i = (y * W * 3 + xx) * 4; img[i] = (c >> 16) & 0xFF; img[i + 1] = (c >> 8) & 0xFF; img[i + 2] = c & 0xFF; img[i + 3] = 255; };
      put(x, M(x, y)); put(W + x, O(x, y)); put(2 * W + x, bad[y * W + x] ? 0xFF0000 : 0x202020);
    }
    fs.writeFileSync(path.join(WORK, `diff-${String(ph).padStart(2, '0')}.png`), png(W * 3, H, img));
    keepWorkDir(WORK, 'difference images');
  } else if (nbad) fontOnly++; else same++;
  console.log(`${realBad ? 'DIFF' : nbad ? 'FONT' : 'SAME'}  ${name.padEnd(24)} ${nbad} of ${W * H} pixels differ` +
    (cols && nbad ? ` (${cells} character cells differ only in glyph shape${realBad ? `, ${realBad} other pixels` : ''})` : '') +
    (mixed ? ` (${mixed} artifact-coloured pixels, compared)` : ''));
}
console.log(`${same} modes identical, ${fontOnly} identical apart from our own font design, ${failed} different, of ${N} (artifacting ${ARTIFACT})`);
if (COMPOSITE) {
  // not vacuous: each BPI / MOCH variant must change our picture from the plain mode
  for (let ph = 1; ph <= N; ph++) {
    const name = MODES[ph - 1][0], m = / (BPI|MOCH|BPI MOCH)$/.exec(name);
    if (!m) continue;
    const base = MODES.findIndex((x) => x[0] === name.slice(0, m.index)) + 1;
    let d = 0;
    if (ours[ph] && ours[base]) for (let i = 0; i < ours[ph].length; i++) if (ours[ph][i] !== ours[base][i]) d++;
    console.log(`${d ? 'ok  ' : 'FAIL'} ${name}: ${d} pixels differ from the plain mode`);
    if (!d) failed++;
  }
}
if (ATTR) {
  // not vacuous: each blink mode must differ from the same mode with blink off (blinking cells lose their
  // underline), or the timer never toggled the blink state
  for (let ph = 1; ph <= N; ph++) {
    const [name, , , , , , , , , blink] = MODES[ph - 1];
    if (!blink) continue;
    const off = MODES.findIndex((m) => m[0] === name.replace(/ blink$/, '')) + 1;
    let d = 0;
    if (ours[ph] && ours[off]) for (let i = 0; i < ours[ph].length; i++) if (ours[ph][i] !== ours[off][i]) d++;
    console.log(`${d ? 'ok  ' : 'FAIL'} ${name}: ${d} pixels differ from blink off`);
    if (!d) failed++;
  }
}
process.exitCode = failed ? 1 : 0;
