// Run: node tests/screen-text-readers.test.js
//
// The screen-text readers - Claude's screen_text (the chat and MCP tool) and Session.screenText (the embed API's
// screenText, the Ask panel, the tape panel and the boot watchdog) - on the three screens the VDG page reader cannot
// read: the Dragon 64 Plus's HD6845S 80-column screen, the CoCo 3's GIME native text modes (40 and 80 columns, with and
// without attribute bytes), a CoCo 3 compatibility-mode text page the MMU has mapped away from where the CPU looks, and
// that same page at every $FF9C (lines a row) and body height; and the main (VDG) page read where the VDG fetches it:
// under the Dragon 64 Plus's banks, by the boot watchdog while the 80-column view is shown, and on a CoCo 3 screen that
// is not text with ROM mapped where the CPU would look.
//
// Each case is firmware of our own (assembled here, no ROM) that writes known text: every code of the character set,
// attributes, a scrolled or moved page, a page with more rows than 16. Three things are checked on each, at the same
// moment:
//  1. both readers return the rows the firmware wrote, derived here from the firmware's own data through literal
//     character tables written by hand (never by running the reader); Session.screenText gives every row at full
//     width, screen_text trims them;
//  2. the rendered frame shows those same characters, cell by cell: our picture of these modes is the one MAME
//     verifies (the regress hashes and `node tools/mame-diff/run.js coco3 --video --text --compat`, `d64plus --plustext
//     --video`), so the text is checked against what the hardware displays. The GIME cells are compared with the
//     GIME font's glyph for the expected character (as run-text.js 2b does); the compatibility-mode rows with the
//     frame's own row bands, ceil(body / lines a row) of them, so the count and the last cut row are checked too; the
//     Plus board's with a character generator of our own that draws each code as its own byte, so the picture decodes
//     back to codes;
//  3. where the screen is: `base` (the CPU address, or null when no slot maps it), `physicalBase`, `startAddress`.
// Cells with no known character (a VDG semigraphics block, a Plus code outside $20-$7E) read as spaces and are counted.
//
// Mutants (each a one-line edit; every one turns this file red - replay them when reviewing):
//  js/claude/readtools.js
//   1. compatibility page through the CPU map: in readScreen's legacyBase branch, compatRows(t.chars) ->
//      vdgRows((i) => readByte(((at & 0xFFFF) + i) & 0xFFFF))
//   2. compatibility page at the power-on page: GIME.legacyTextScreen's this.videoBase() -> 0x70400
//   2b. compatibility rows a fixed 16: compatRows(t.chars) -> compatRows(t.chars.slice(0, 16)) (section 3b)
//   2c. compatibility rows a fixed 12-line row: GIME.legacyTextScreen's COMPAT_TEXT_LPR[regs[12] & 0x0F] -> 12 (3b)
//   2d. short compatibility rows not declined: videoMode's `if (lpr < 8) return ...` -> `if (lpr < 0) return ...` (3b)
//   2e. the 8-line boundary declined too: `if (lpr < 8)` -> `if (lpr <= 8)` (3b's 8-line case: 24 rows at 192, 25 at
//       200, 29 at 225; 9 checks red by name)
//   3. attribute bytes read as characters (gimeText: interleave t.attrs into the rows)
//   4. 40 columns read as 80 (gimeText: pad each row to 80)
//   5. bit 7 not ignored (gimeText: chars[v & 0x7F] -> chars[v] || ' ')
//   6. Plus unknown codes not counted (plusText: drop unknown++)
//   7. Session.screenText main-only: screenRows' `if (r.text) return r.rows;` also refuses HD6845S and GIME native rows
//   8. VDG rows through the CPU map: readScreen's vdgRows(page.byte) -> vdgRows((i) => readByte(page.addr(i)))
//   9. fallback through the CPU map: screenRows' vdgRows(page.byte) -> vdgRows((i) => readByte(page.addr(i)))
//  10. fallback at the profile page: screenRows' vdgPage(m) -> { byte: (i) => m.ram[((m.profile.textScreen || 0x400) + i) & 0xFFFF] }
//  11. base without the CPU check: base: cpuSees ? page.at : null -> base: page.at
//  12. SAM offset ignored: vdgPage's at = m.sam.displayBase -> at = m.profile.textScreen || 0x400
//  13. wrong F shift in the reader: at = m.sam.displayBase -> at = ((m.sam.reg >> 2) & 0x7F) << 9
//  14. counter size ignored: (at + i) & mask -> (at + i) & 0xFFFF
//  15. base on row 0 only: the cpuSees loop's i < n -> i < 32
//  16. base without the last byte: i < n -> i < n - 1
//  js/session.js
//  17. Session.screenText always main: { main } -> { main: true }
//  18. the watchdog reads the shown screen: this.screenText(m, { main: true }) -> this.screenText(m)
//  js/chips/sam6883.js
//  19. wrong F shift: displayBase's << 9 -> << 8
//  js/machines/d64plus.js
//  20. Plus start address ignored: textScreen()'s ma = this.rowAddress(row) -> ma = row * cols
const Emu = require('./load')();
const T = require('../tools/mame-diff/coco3/text-screens.js');
const { romImage } = require('../tools/mame-diff/lib/firmware.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const J = JSON.stringify;
const hx = (v, w = 2) => '$' + v.toString(16).toUpperCase().padStart(w, '0');
const tool = (m) => Emu.runReadOnlyTool({ machine: m, readByte: (a) => m.peek(a) }, 'screen_text', {});
// trimmed as screen_text returns rows: trailing spaces, then trailing blank rows
const trim = (rows) => { const r = rows.map((l) => l.replace(/\s+$/, '')); while (r.length && !r[r.length - 1]) r.pop(); return r; };

// a Session showing machine `m` (the Session's reader reads the shown machine; nothing else of the Session is used)
function sessionOn(m) {
  const s = new Emu.Session({ store: { get() { return null; }, set() {}, remove() {} } });
  return { screenText: (opts) => s.screenText(m, opts) };
}

// ---- the firmware helpers: write `data` bytes at CPU address `at` ----
let label = 0;
function writes(e, list) {
  const data = [];
  for (const [at, bytes] of list) {
    const d = `D${label++}`;
    e(`        LDX     #${hx(at, 4)}`); e(`        LDU     #${d}`); e(`        LDB     #${bytes.length}`);
    e(`${d}W   LDA     ,U+`); e(`        STA     ,X+`); e(`        DECB`); e(`        BNE     ${d}W`);
    data.push([d, bytes]);
  }
  return data;
}
function tables(e, data) {
  for (const [d, bytes] of data) for (let i = 0; i < bytes.length; i += 16) e(`${i ? '      ' : d.padEnd(6)} FCB     ${bytes.slice(i, i + 16).map((v) => hx(v)).join(',')}`);
}
const bytes = (s) => Array.from(s, (c) => c.charCodeAt(0));
const range = (from, count) => Array.from({ length: count }, (_, i) => from + i);
// run until the firmware reaches HALT, then two more fields so the picture is drawn from what it wrote
function runToHalt(m, halt) {
  for (let f = 0; f < 600 && m.cpu.pc !== halt; f++) m.runFrame();
  if (m.cpu.pc !== halt) throw new Error(`the firmware never reached HALT (pc ${hx(m.cpu.pc, 4)})`);
  m.runFrame(); m.runFrame();
}

// =====================================================================================================================
// 1. The Dragon 64 Plus's 80-column screen
// =====================================================================================================================
// The board's character codes as the sources give them (js/claude/readtools.js PLUS_CHARS cites them): $20-$7E are
// ASCII, written out here; every other code has no known character and reads as a space.
const PLUS_ASCII = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
const plusChar = (c) => (c >= 0x20 && c <= 0x7E ? PLUS_ASCII[c - 0x20] : ' ');
// A character generator of our own (never a real one): every raster line of code c is c, so the picture decodes back
// to the codes it shows.
const CODEGEN = new Uint8Array(0x2000);
for (let a = 0; a < CODEGEN.length; a++) CODEGEN[a] = (a >> 4) & 0xFF;

// The CRTC set as Compusense's 80 x 22 screen (R0-R11, as tools/mame-diff/d64plus/plustext.asm does), start R12/R13
// = `start`; the video RAM holds VRAM (2K), written through $FFE2 = 1 (the video RAM over $0000-$07FF).
// Rows of the video RAM, 80 bytes apart: row 0 a title, rows 2-5 every code $00-$FF in order (80 a row), row 7 all
// 256 codes' row-7 check line, row 21 the last row, rows 22-24 below it (shown only when the start scrolls).
function plusVram() {
  const v = new Array(0x800).fill(0x20);
  const put = (row, col, data) => data.forEach((b, i) => { v[row * 80 + col + i] = b; });
  put(0, 0, bytes('DRAGON 64 PLUS: EVERY CODE $00-$FF BELOW, 80 A ROW'));
  put(2, 0, range(0x00, 80)); put(3, 0, range(0x50, 80)); put(4, 0, range(0xA0, 80)); put(5, 0, range(0xF0, 16));
  put(5, 20, bytes('<- $F0-$FF, then ASCII'));
  put(21, 0, bytes('ROW 21, THE LAST OF 22')); put(21, 79, bytes('!'));
  put(22, 0, bytes('ROW 22 (SEEN WHEN SCROLLED)')); put(24, 0, bytes('ROW 24'));
  return v;
}
function plusFirmware(start) {
  const L = [], e = (s) => L.push(s);
  e('        ORG     $8000');
  e('RESET   ORCC    #$50'); e('        LDS     #$7F00'); e('        CLRA'); e('        TFR     A,DP');
  e('        STA     $FFDD'); e('        STA     $FFE2');
  e('        STA     $FFC9');                                         // SAM F1: the VDG page at $0400, as BASIC sets it
  // PIA1 port B as outputs, all 0: the VDG in text mode (as tools/mame-diff/d64plus/plustext.asm sets it)
  for (const l of ['CLR     $FF23', 'LDA     #$F8', 'STA     $FF22', 'LDA     #$34', 'STA     $FF23', 'CLR     $FF22']) e(`        ${l}`);
  const regs = [0x71, 0x50, 0x60, 0x0F, 0x19, 0x04, 0x16, 0x18, 0x00, 0x0B, 0x20, 0x0B, start >> 8, start & 0xFF, 0x3F, 0xFF];
  regs.forEach((v, r) => { e(`        LDA     #${r}`); e('        STA     $FFE0'); e(`        LDA     #${hx(v)}`); e('        STA     $FFE1'); });
  e('        LDA     #$01'); e('        STA     $FFE2');                // the video RAM over $0000-$07FF
  const v = plusVram();
  const data = writes(e, range(0, 0x800 / 128).map((k) => [k * 128, v.slice(k * 128, k * 128 + 128)]));
  e('        CLR     $FFE2');                                         // the standard bank again
  e('HALT    BRA     HALT');
  tables(e, data);
  e('        ORG     $BFF2'); e('        FDB     HALT,HALT,HALT,HALT,HALT,HALT,RESET'); e('        END     RESET');
  return L.join('\n') + '\n';
}
function plusMachine(start) {
  const asm = Emu.assemble(plusFirmware(start), '6809');
  if (!asm.ok) throw new Error(J(asm.errors));
  const bank = romImage(asm, 0x8000, 0x4000, 0x12), profile = Emu.profiles.d64plus, slots = { chargen: CODEGEN, prom: new Uint8Array(0x200) };
  for (const sl of profile.roms) if (!sl.chip) slots[sl.id] = bank.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size);
  const m = Emu.createMachine('d64plus', { mameCompat: false });
  m.setRoms(slots); m.reset(true);
  runToHalt(m, asm.symbols.get('HALT'));
  m.view = 'plus';
  return m;
}
// the expected rows: 22 rows of 80 from video RAM row `first` (the start's row), read through plusChar
function plusExpect(first) {
  const v = plusVram();
  return range(first, 22).map((r) => v.slice(r * 80, r * 80 + 80).map(plusChar).join(''));
}
// the picture decoded: each cell's first raster line is its code (CODEGEN)
function plusPictureCodes(m) {
  const f = m.plusFrame, rows = [];
  for (let row = 0; row < 22; row++) {
    const line = [];
    for (let col = 0; col < 80; col++) {
      let code = 0;
      for (let bit = 0; bit < 8; bit++) code |= f.data[row * 12 * f.width + col * 8 + bit] ? 0x80 >> bit : 0;
      line.push(code);
    }
    rows.push(line);
  }
  return rows;
}

for (const [name, start, first] of [['80 columns from $0000', 0x0000, 0], ['scrolled three rows (start $00F0)', 0x00F0, 3]]) {
  const m = plusMachine(start), want = plusExpect(first);
  const got = tool(m), sess = sessionOn(m).screenText();
  check(`Plus ${name}: screen_text reads the rows the firmware wrote (codes outside $20-$7E as spaces)`,
    got.text === true && J(got.lines) === J(trim(want)), J({ got: got.lines, want: trim(want) }));
  check(`Plus ${name}: mode, 80 columns, 22 rows, startAddress`,
    got.mode === 'HD6845S text (the Dragon Plus), 80 columns, 22 rows' && got.cols === 80 && got.screenRows === 22 && got.startAddress === start,
    J({ mode: got.mode, cols: got.cols, screenRows: got.screenRows, startAddress: got.startAddress }));
  // the codes on screen with no character, counted from the data written: $00-$1F and $7F-$FF of rows 2-5 (161), less
  // row 2's 32 ($00-$1F) when the start has scrolled it off
  const unknown = first === 0 ? 161 : 129;
  check(`Plus ${name}: the ${unknown} cells with no known character are counted, with a note`,
    got.unknown === unknown && new RegExp(`${unknown} of the 1760 cells hold a code outside \\$20-\\$7E`).test(got.note || ''), J({ unknown: got.unknown, note: got.note }));
  check(`Plus ${name}: Session.screenText gives the same 22 rows at full width`, J(sess) === J(want), J(sess.slice(0, 6)));
  // the picture: every cell shows the code whose character was read
  const pic = plusPictureCodes(m), v = plusVram();
  let bad = 0;
  for (let r = 0; r < 22; r++) for (let c = 0; c < 80; c++) if (pic[r][c] !== v[(first + r) * 80 + c] || plusChar(pic[r][c]) !== want[r][c]) bad++;
  check(`Plus ${name}: the rendered picture shows the code in every cell, and its character is the one read`, bad === 0, `${bad} cells differ`);
  // the main screen (the VDG behind the board) is still what the boot watchdog reads
  const main = sessionOn(m).screenText({ main: true });
  check(`Plus ${name}: screenText({ main: true }) reads the VDG page, 16 rows of 32, not the board`, main.length === 16 && main[0].length === 32 && main[0] !== want[0].slice(0, 32));
}

// =====================================================================================================================
// 2. The CoCo 3's GIME native text modes, on a page the MMU maps
// =====================================================================================================================
// The GIME's 128 characters, written out by hand in tools/mame-diff/coco3/text-screens.js (the codes $00-$1F are the
// international letters the GIME draws, $7F a ▒); bit 7 is not part of the character.
const GIME_CHARS = T.CODES_00_3F + T.CODES_40_7F;
const PAL = [0, 63, 18, 36, 9, 54, 27, 45, 63, 63, 38, 52, 25, 11, 56, 7];
const COCO_HALT = (asm) => asm.symbols.get('HALT');
function cocoMachine(source) {
  const asm = Emu.assemble(source, '6809');
  if (!asm.ok) throw new Error(J(asm.errors));
  const m = Emu.createMachine('coco3', { mameCompat: true });
  m.setRoms({ basic: romImage(asm, 0x8000, 0x8000, 0x12) }); m.reset(true);
  runToHalt(m, COCO_HALT(asm));
  return m;
}
function cocoStart(e) {
  e('        ORG     $8000');
  e('RESET   ORCC    #$50'); e('        LDS     #$7FF0'); e('        CLRA'); e('        TFR     A,DP');
  e('        CLR     $FF90');                                         // GIME mode, MMU off
  PAL.forEach((c, i) => { e(`        LDA     #${c}`); e(`        STA     ${hx(0xFFB0 + i, 4)}`); });
  // the MMU's task 0 as the machine leaves it with the MMU off: slot n = block $38 + n
  range(0, 8).forEach((s) => { e(`        LDA     #${hx(0x38 + s)}`); e(`        STA     ${hx(0xFFA0 + s, 4)}`); });
}
function cocoEnd(e, data) {
  e('HALT    BRA     HALT');
  tables(e, data);
  e('        ORG     $FFFE'); e('        FDB     RESET'); e('        END     RESET');
}

// A native text screen at physical $60000 (block $30), which the firmware writes through CPU slot 2 ($4000) mapped to
// it, then maps slot 2 back to block $3A and `seeAt` (a slot, or null) to block $30: the screen is where the GIME reads
// it whichever CPU address shows it, and with no slot mapping it the CPU cannot see it at all.
// `rows`: the bytes of each row (characters, interleaved with attribute bytes when `attr`); `scroll`: rows above the
// video start (the start is `scroll` rows into the page, so the screen shows rows scroll..scroll+23).
function gimeFirmware({ f99, cols, attr, rows, scroll, seeAt }) {
  const L = [], e = (s) => L.push(s), pitch = cols * (attr ? 2 : 1);
  cocoStart(e);
  e('        LDA     #$40'); e('        STA     $FF90');                // MMU on, task 0
  e('        LDA     #$30'); e('        STA     $FFA2');                // slot 2 ($4000-$5FFF) -> block $30
  e('        LDX     #$4000'); e(attr ? '        LDD     #$2008' : '        LDA     #$20');
  e(`CLR     ${attr ? 'STD     ,X++' : 'STA     ,X+'}`); e(`        CMPX    #${hx(0x4000 + pitch * (24 + scroll), 4)}`); e('        BLO     CLR');
  const data = writes(e, rows.map((r, i) => [0x4000 + i * pitch, r]).filter(([, r]) => r && r.length));
  const start = 0x60000 + scroll * pitch;
  for (const [a, v] of [[0xFF98, 0x03], [0xFF99, f99], [0xFF9C, 0], [0xFF9D, (start >> 11) & 0xFF], [0xFF9E, (start >> 3) & 0xFF], [0xFF9F, 0]]) {
    e(`        LDA     #${hx(v)}`); e(`        STA     ${hx(a, 4)}`);
  }
  e('        LDA     #$3A'); e('        STA     $FFA2');                // slot 2 back: the CPU's $4000 is not the screen
  if (seeAt != null) { e('        LDA     #$30'); e(`        STA     ${hx(0xFFA0 + seeAt, 4)}`); }
  cocoEnd(e, data);
  return L.join('\n') + '\n';
}
// characters (and attributes) of a row: [code, attr] pairs, or codes
const attrRow = (pairs) => pairs.flatMap(([c, a]) => [c, a]);
const textCells = (s, a) => Array.from(s, (ch) => [ch.charCodeAt(0), a]);

// Our picture of a GIME text cell against the GIME font's glyph for the expected character (run-text.js 2b): wide
// modes (40/80) fill 640 pixels from x 0, rows of 8 lines from line 24 (the top border, 25 lines, less one), the
// underline on the row's line 7. The cell's background is its top-left pixel (the font never sets the leftmost pixel).
function gimeCellsBad(m, cols, lines, underlined) {
  const f = m.render(), W = f.width, cw = 640 / cols, scale = cw / 8, top = 24;
  let bad = 0;
  for (let r = 0; r < 24; r++) {
    const line = lines[r].padEnd(cols);
    for (let c = 0; c < cols; c++) {
      const code = GIME_CHARS.indexOf(line[c]), bx = c * cw, by = top + r * 8, bg = f.data[by * W + bx], ul = underlined(r, c);
      let same = code >= 0;
      for (let y = 0; same && y < 8; y++) {
        const bits = ul && y === 7 ? 0xFF : Emu.GIME.HIRES_FONT[code * 12 + y];
        for (let x = 0; x < cw; x++) if ((f.data[(by + y) * W + bx + x] !== bg) !== !!(bits & (0x80 >> Math.floor(x / scale)))) { same = false; break; }
      }
      if (!same) bad++;
    }
  }
  return bad;
}

// ---- 2a. 40 columns with attributes: every code, bit 7 set and clear, colours and underline; seen at $C000 ----
{
  const A = 0x08;                                   // fg 1 (palette 9), bg 0
  const rows = [];
  rows[0] = attrRow(textCells('GIME 40 COLUMNS, ATTRIBUTES, MMU PAGE', A));
  rows[2] = attrRow(range(0x00, 40).map((c) => [c, A]));
  rows[3] = attrRow(range(0x28, 40).map((c) => [c, A]));
  rows[4] = attrRow(range(0x50, 40).map((c) => [c, A]));
  // $78-$7F, then $80-$9F: bit 7 set, the same characters as $00-$1F
  rows[5] = attrRow(range(0x78, 40).map((c) => [c, A]));
  // underlined (bit 6), then colours: fg 2-7 on bg 0, fg 2 on bg 3 - never blink (bit 7), which blanks the cell
  rows[7] = attrRow([...textCells('UNDERLINED', 0x48), ...textCells(' ', A), ...range(0, 6).map((k) => [0x43, (2 + k) << 3]), [0x44, 0x13]]);
  rows[23] = attrRow([...textCells(' '.repeat(32), A), ...textCells('LAST ROW', A)]);
  const want = new Array(24).fill('');
  want[0] = 'GIME 40 COLUMNS, ATTRIBUTES, MMU PAGE';
  want[2] = GIME_CHARS.slice(0x00, 0x28); want[3] = GIME_CHARS.slice(0x28, 0x50); want[4] = GIME_CHARS.slice(0x50, 0x78);
  want[5] = GIME_CHARS.slice(0x78, 0x80) + GIME_CHARS.slice(0x00, 0x20);
  want[7] = 'UNDERLINED CCCCCCD'; want[23] = ' '.repeat(32) + 'LAST ROW';
  const full = want.map((l) => l.padEnd(40));
  const m = cocoMachine(gimeFirmware({ f99: 0x05, cols: 40, attr: true, rows, scroll: 0, seeAt: 6 }));
  const got = tool(m), sess = sessionOn(m).screenText();
  check('GIME 40 attr: screen_text reads every code, bit 7 ignored, attributes stripped',
    got.text === true && J(got.lines) === J(trim(full)), J({ got: got.lines, want: trim(full) }));
  check('GIME 40 attr: the mode, 40 columns, 24 rows; physicalBase $60000; base $C000 (slot 6 maps block $30)',
    got.mode === 'GIME native text, 40 columns with attributes, 24 rows' && got.cols === 40 && got.screenRows === 24
    && got.physicalBase === 0x60000 && got.base === 0xC000, J({ mode: got.mode, base: got.base, physicalBase: got.physicalBase }));
  const run = (from, to, a) => ({ from, to, fg: (a >> 3) & 7, bg: a & 7, underline: !!(a & 0x40), blink: !!(a & 0x80) });
  check('GIME 40 attr: row 7\'s attribute runs (underline, colours) as written',
    J(got.attributes[7]) === J([run(0, 9, 0x48), run(10, 10, A), ...range(0, 6).map((k) => run(11 + k, 11 + k, (2 + k) << 3)), run(17, 17, 0x13), run(18, 39, A)]),
    J(got.attributes[7]));
  check('GIME 40 attr: Session.screenText gives the 24 rows at full width', J(sess) === J(full), J(sess.slice(0, 8)));
  const ul = (r, c) => r === 7 && c <= 9;
  check('GIME 40 attr: the rendered picture shows the expected glyph in every cell', gimeCellsBad(m, 40, full, ul) === 0, `${gimeCellsBad(m, 40, full, ul)} cells differ`);
}

// ---- 2b. 80 columns, no attributes, scrolled: the video start 3 rows into the page; no slot maps it ----
{
  const rows = range(0, 27).map((r) => bytes(`PAGE ROW ${String(r).padStart(2, '0')}`));
  rows[5] = bytes('PAGE ROW 05 ').concat(range(0x00, 68));   // codes $00-$43 after the label, 80 cells in all
  rows[26] = bytes(' '.repeat(69) + 'PAGE ROW 26');
  const want = range(3, 24).map((r) => (r === 5 ? 'PAGE ROW 05 ' + GIME_CHARS.slice(0, 68) : r === 26 ? ' '.repeat(69) + 'PAGE ROW 26' : `PAGE ROW ${String(r).padStart(2, '0')}`).padEnd(80));
  const m = cocoMachine(gimeFirmware({ f99: 0x14, cols: 80, attr: false, rows, scroll: 3, seeAt: null }));
  const got = tool(m), sess = sessionOn(m).screenText();
  check('GIME 80 scrolled: screen_text reads rows 3-26 of the page', got.text === true && J(got.lines) === J(trim(want)), J({ got: got.lines, want: trim(want) }));
  check('GIME 80 scrolled: 80 columns, no attributes; physicalBase $600F0; base null (no slot maps block $30)',
    got.mode === 'GIME native text, 80 columns, 24 rows' && got.attributes === undefined && got.physicalBase === 0x600F0 && got.base === null,
    J({ mode: got.mode, base: got.base, physicalBase: got.physicalBase }));
  check('GIME 80 scrolled: Session.screenText gives the same 24 rows', J(sess) === J(want), J(sess.slice(0, 4)));
  check('GIME 80 scrolled: the rendered picture shows the expected glyph in every cell', gimeCellsBad(m, 80, want, () => false) === 0,
    `${gimeCellsBad(m, 80, want, () => false)} cells differ`);
}

// =====================================================================================================================
// 3. The CoCo 3's compatibility-mode (VDG) text page, mapped away by the MMU
// =====================================================================================================================
// The MC6847's 64 characters as the readers write them (codes $00-$1F are @A-Z[\]^_, $20-$3F space to ?), written
// out by hand; bit 6 (inverse) is not part of the character; bit 7 is a semigraphics block (a space, counted).
const VDG_CHARS = '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_ !"#$%&\'()*+,-./0123456789:;<=>?';
const vdgChar = (v) => (v & 0x80 ? ' ' : VDG_CHARS[v & 0x3F]);
// The page, 16 rows of 32: a title, every code $00-$7F (normal and inverse), a row of semigraphics $80-$9F, a last row.
function vdgPage() {
  const p = new Array(512).fill(0x60);                // $60: an inverse space (BASIC's green screen)
  const put = (row, data) => data.forEach((b, i) => { p[row * 32 + i] = b; });
  put(0, bytes('MMU PAGE AT $60400').map((c) => c | 0x40));   // normal video: bit 6 set ($40-$7F)
  put(2, range(0x00, 32)); put(3, range(0x20, 32)); put(4, range(0x40, 32)); put(5, range(0x60, 32));
  put(7, range(0x80, 32));
  put(15, bytes('LAST ROW').map((c) => c | 0x40));
  return p;
}
// Legacy mode ($FF90 = $C0: compatibility mode, MMU on), VDG text ($FF22 = 0) in rows of 12 lines ($FF9C = $0F, as
// BASIC sets it), the SAM's page bits F1 ($0400), and
// $FF9D = $C0, which puts the page at physical $60000 + $400 = $60400. The firmware maps CPU slot 0 to block $30 and
// writes the page at CPU $0400; then maps slot 0 back to block $38 and writes "WRONG PAGE" over CPU $0400 (physical
// $70400, where a reader that followed the CPU, or the power-on page, would look); then maps `seeAt` (a slot, or
// null) to block $30.
function legacyFirmware(seeAt) {
  const L = [], e = (s) => L.push(s);
  cocoStart(e);
  e('        LDA     #$C0'); e('        STA     $FF90');                // compatibility mode, MMU on
  e('        CLR     $FF22');                                         // VDG text
  e('        STA     $FFC9');                                         // SAM F1 set: the page at $0400
  e('        LDA     #$C0'); e('        STA     $FF9D'); e('        CLR     $FF9E');
  e('        LDA     #$0F'); e('        STA     $FF9C');                // 12 lines a text row, as BASIC sets it
  e('        LDA     #$30'); e('        STA     $FFA0');                // slot 0 -> block $30
  const page = vdgPage();
  const data = writes(e, range(0, 4).map((k) => [0x0400 + k * 128, page.slice(k * 128, k * 128 + 128)]));
  e('        LDA     #$38'); e('        STA     $FFA0');                // slot 0 back to block $38
  data.push(...writes(e, range(0, 16).map((r) => [0x0400 + r * 32, bytes('WRONG PAGE, CPU $0400 = $70400  ')])));
  if (seeAt != null) { e('        LDA     #$30'); e(`        STA     ${hx(0xFFA0 + seeAt, 4)}`); }
  cocoEnd(e, data);
  return L.join('\n') + '\n';
}
// Our picture of a compatibility-mode text cell against the GIME's 32-column font (js/chips/gime.js drawLegacy, the
// GIME as an MC6847T1): rows of 12 lines from line 24, cells 16 pixels wide from x 64; bit 6 inverts the glyph.
// Each text cell must split into exactly two colours along the glyph's lit pixels (semigraphics cells are skipped).
function legacyCellsBad(m, page) {
  const f = m.render(), W = f.width, top = 24, x0 = 64;
  let bad = 0;
  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 32; c++) {
      const v = page[r * 32 + c], bx = x0 + c * 16, by = top + r * 12;
      if (v & 0x80) continue;
      const fontCode = VDG_CHARS.indexOf(vdgChar(v));      // the character the readers give, back to its glyph
      const colours = new Map();
      let same = fontCode >= 0;
      for (let y = 0; same && y < 12; y++) {
        let bits = Emu.GIME.LOWRES_FONT[fontCode * 12 + y];
        if (v & 0x40) bits ^= 0xFF;
        for (let x = 0; x < 16; x++) {
          const lit = !!(bits & (0x80 >> Math.floor(x / 2))), px = f.data[(by + y) * W + bx + x];
          if (!colours.has(lit)) colours.set(lit, px);
          if (colours.get(lit) !== px) { same = false; break; }
        }
      }
      if (same && colours.size === 2 && colours.get(true) === colours.get(false)) same = false;
      if (!same) bad++;
    }
  }
  return bad;
}

for (const [name, seeAt, base] of [['no slot maps it', null, null], ['slot 6 maps it at $C000', 6, 0xC400]]) {
  const m = cocoMachine(legacyFirmware(seeAt)), page = vdgPage();
  const want = range(0, 16).map((r) => page.slice(r * 32, r * 32 + 32).map(vdgChar).join(''));
  const got = tool(m), sess = sessionOn(m).screenText();
  check(`CoCo 3 compatibility page, ${name}: (setup) the display reads $60400 and CPU $0400 holds WRONG PAGE`,
    m.gime.videoBase() === 0x60400 && m.peek(0x400) === 0x57 && m.gime.physAddr(0x400) === 0x70400);
  check(`CoCo 3 compatibility page, ${name}: screen_text reads the displayed page, every code, semigraphics as spaces`,
    got.text === true && J(got.lines) === J(trim(want)) && got.semigraphics === 32, J({ got: got.lines, want: trim(want), sg: got.semigraphics }));
  check(`CoCo 3 compatibility page, ${name}: physicalBase $60400, base ${base == null ? 'null' : hx(base, 4)}`,
    got.mode === 'GIME legacy: MC6847 text' && got.physicalBase === 0x60400 && got.base === base, J({ mode: got.mode, base: got.base, physicalBase: got.physicalBase }));
  check(`CoCo 3 compatibility page, ${name}: Session.screenText reads the same 16 rows`, J(sess) === J(want), J(sess.slice(0, 3)));
  check(`CoCo 3 compatibility page, ${name}: the rendered picture shows the expected glyph in every text cell`,
    legacyCellsBad(m, page) === 0, `${legacyCellsBad(m, page)} cells differ`);
}

// =====================================================================================================================
// 3b. The CoCo 3's compatibility-mode (VDG) text screen at every $FF9C, and a 200- or 225-line screen
// =====================================================================================================================
// In compatibility mode $FF9C sets the lines each text row takes (js/chips/gime.js COMPAT_TEXT_LPR: $0F is 12 lines,
// $03 is 8, $0B is 4, $0A is 1, and so on), and $FF99 bits 5-6 set how many lines the body draws (192, 200 or 225).
// The screen therefore shows ceil(body / lpr) rows, not always 16: 24 rows at 8 lines a row on a 192-line screen, 25
// on a 200-line one, 17 rows at 12 lines a row where the body is 200 lines, and so on. The reader walked a fixed 16.
// Rows under 8 lines are declined, as below.
// Oracle, per screen: the rendered FRAME, row by row and cell by cell. Our picture of these modes is the one MAME
// verifies (`node tools/mame-diff/run.js coco3 --video --compat` compares 'compat text' pixel for pixel); each row
// band in the frame is lpr scanlines from the body's first line, and every cell must show the glyph of the character
// the reader returns for that row and column. The expected text is derived here from the page bytes and the character
// table, never from the reader, and the row count from the frame's own geometry (topBorder/body/lpr), never from the
// reader either. Rows under 8 lines show no glyph whole, so the reader declines them (as the GIME native reader does
// for $FF98 lines per row under 8): that is checked too.
const LPR_COMPAT = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 4, 3, 2, 1, 12];   // js/chips/gime.js COMPAT_TEXT_LPR
// A page of 32 rows, each a distinctive label then a letter, so a misaligned or missing row is visible.
function tallPage() {
  const p = new Array(32 * 32).fill(0x60);
  const put = (row, data) => data.forEach((b, i) => { p[row * 32 + i] = b; });
  for (let r = 0; r < 32; r++) {
    const lbl = bytes(`ROW ${String(r).padStart(2, '0')} `).map((c) => c | 0x40);
    put(r, [...lbl, ...range(0, 32 - lbl.length).map(() => 0x40 + (r % 26))]);
  }
  return p;
}
// Legacy mode at physical $60000 ($FF9D = $C0), the SAM's page at $0400, `ff9c` lines a row, `ff99` resolution; the
// page is 32 rows, written through CPU slot 0 mapped to block $30.
function tallCompatFirmware(ff9c, ff99) {
  const L = [], e = (s) => L.push(s);
  cocoStart(e);
  e('        LDA     #$C0'); e('        STA     $FF90');                // compatibility mode, MMU on
  e('        CLR     $FF22');                                         // VDG text
  e('        STA     $FFC9');                                         // SAM F1: the page at $0400
  e('        LDA     #$C0'); e('        STA     $FF9D'); e('        CLR     $FF9E');
  e(`        LDA     #${hx(ff99)}`); e('        STA     $FF99');         // 192, 200 or 225 lines of body
  e(`        LDA     #${hx(ff9c)}`); e('        STA     $FF9C');         // lines a text row
  e('        LDA     #$30'); e('        STA     $FFA0');                // slot 0 -> block $30
  const page = tallPage();
  const data = writes(e, range(0, 8).map((k) => [0x0400 + k * 128, page.slice(k * 128, k * 128 + 128)]));
  cocoEnd(e, data);
  return L.join('\n') + '\n';
}
// The rows the FRAME shows, derived from the GIME's own geometry (not the reader): the body's first line is
// topBorder - 1 (recordBody's y = physical - 1 - pad), each row band is lpr lines, the body runs ceil(body/lpr) rows,
// the last perhaps cut short.
const frameRowBands = (g, lpr) => ({ first: g.topBorder - 1, count: Math.ceil(g.body / lpr), lpr });
// Every cell of every row band in the frame shows the glyph of `rows[r][c]` (the character read back from the page
// through the table below), over the scanlines the band actually has, or the cell is blank (an inverse space's glyph
// is empty). Returns the number of cells that do not. `bg` per cell is its top-left pixel, so the test does not need
// the palette; a cell is "lit" where it differs from that pixel. `inverse` is the page byte's bit 6, which the GIME
// draws as the glyph XOR $FF.
function compatFrameBad(m, rows, lpr) {
  const f = m.render(), W = f.width, H = f.height, { first, count } = frameRowBands(m.gime, lpr);
  const bodyEnd = Math.min(H, first + m.gime.body);
  const font = Emu.GIME.LOWRES_FONT;
  let bad = 0;
  for (let r = 0; r < count; r++) {
    const by = first + r * lpr, lines = Math.min(lpr, bodyEnd - by, 12);
    const line = rows[r] || '';
    for (let c = 0; c < 32; c++) {
      const bx = 64 + c * 16, ch = line[c] || ' ';
      // the character back to its font code and its inverse bit: the row carries what the reader gave, so the code
      // comes from the same 64-character table (bit 6 is not part of the character the reader returns)
      const code = ch >= '@' && ch <= '_' ? ch.charCodeAt(0) - 64 : ch >= ' ' && ch <= '?' ? ch.charCodeAt(0) : -1;
      if (code < 0) { bad++; continue; }
      const bg = f.data[by * W + bx];
      let same = true;
      for (let y = 0; same && y < lines; y++) {
        const bits = font[code * 12 + y];
        for (let x = 0; x < 16; x++) {
          const lit = !!(bits & (0x80 >> Math.floor(x / 2)));
          if ((f.data[(by + y) * W + bx + x] !== bg) !== lit) { same = false; break; }
        }
      }
      if (!same) bad++;
    }
  }
  return bad;
}
// The page's rows as the reader should give them: page byte -> character, bit 7 a semigraphics block (a space).
const tallWant = (page) => range(0, 32).map((r) => page.slice(r * 32, r * 32 + 32).map(vdgChar).join(''));
// $FF9C values whose rows are 8 lines or more: a glyph is 12 lines, so a shorter row shows only its top lines and no
// character whole - the same rule the GIME native reader applies ($FF98 lines per row under 8 is declined). Measured
// on our own font: every glyph's ink ends by line 7, so at 8 lines ($FF9C $03) all 63 are shown whole, at 7 only 10,
// at 4 only 2, at 1 none. 8 is the boundary: it is READ, and 7 and below are declined (a `<= 8` decline must not pass).
const READABLE_FF9C = [0x0F, 0x03, 0x02, 0x01, 0x00];   // 12, 8, 9, 10, 11 lines a row
for (const [res, ff99] of [['192', 0x00], ['200', 0x20], ['225', 0x60]]) {
  for (const ff9c of READABLE_FF9C) {
    const lpr = LPR_COMPAT[ff9c & 0x0F], page = tallPage(), all = tallWant(page);
    const m = cocoMachine(tallCompatFirmware(ff9c, ff99));
    m.runFrame(); m.runFrame();
    const { count } = frameRowBands(m.gime, lpr);
    const want = all.slice(0, count);                       // the rows the screen shows, from the frame's geometry
    const got = tool(m), sess = sessionOn(m).screenText();
    const label = `CoCo 3 compatibility ${res} lines, ${lpr} lines a row ($FF9C ${hx(ff9c)})`;
    check(`${label}: (setup) the body shows ${count} rows (${m.gime.body} lines / ${lpr}) and the page has them all written`,
      m.gime.body === { '192': 192, '200': 200, '225': 225 }[res] && count === Math.ceil(m.gime.body / lpr) && all.length === 32);
    check(`${label}: screen_text reads the ${count} rows the screen shows, row for row`,
      got.text === true && J(got.lines) === J(trim(want)), J({ rows: got.lines && got.lines.length, want: count, first: got.lines && got.lines[0], last: got.lines && got.lines[got.lines.length - 1] }));
    check(`${label}: Session.screenText gives the same ${count} rows at full width, and screenRows is ${count}`,
      J(sess) === J(want) && got.screenRows === count, J({ sess: sess.length, screenRows: got.screenRows, want: count }));
    check(`${label}: the rendered frame shows the reader's character in every cell of every row it reports`,
      compatFrameBad(m, sess, lpr) === 0, `${compatFrameBad(m, sess, lpr)} cells of the frame do not match`);
  }
}

// $FF9C rows shorter than a glyph (1 to 7 lines) show no character whole: the reader declines, as the GIME native
// reader declines rows under 8 lines, rather than return rows of glyph fragments. The frame really shows fragments:
// at 1 line a row none of the 63 glyphs is whole, so there is no text to read.
for (const ff9c of [0x04, 0x0B, 0x0A, 0x0C, 0x0D, 0x0E]) {   // 7, 4, 1, 3, 2, 1 lines a row (all under 8)
  const lpr = LPR_COMPAT[ff9c & 0x0F];
  const m = cocoMachine(tallCompatFirmware(ff9c, 0x00));
  m.runFrame(); m.runFrame();
  const got = tool(m), sess = sessionOn(m).screenText();
  const info = Emu.runReadOnlyTool({ machine: m, readByte: (a) => m.peek(a) }, 'machine_info', {});
  check(`CoCo 3 compatibility at ${lpr} lines a row ($FF9C ${hx(ff9c)}): a text mode, declined, no rows (no glyph shown whole)`,
    got.text === false && /MC6847 text/.test(got.mode) && new RegExp(`draws ${lpr} scanline`).test(got.reason || '') && got.rows === 0
    && /no character is shown whole/.test(got.reason || ''), J(got));
  check(`CoCo 3 compatibility at ${lpr} lines a row: machine_info says kind text but not readable`, info.video.kind === 'text' && info.video.readable === false, J(info.video));
  // Session.screenText's fallback still shows the page it decodes (a screen screen_text declines), as a VDG page of 16 rows
  check(`CoCo 3 compatibility at ${lpr} lines a row: Session.screenText keeps its VDG fallback, 16 rows`, sess.length === 16, J(sess.length));
}

// A 12-line-row screen is 16 rows on 192 lines but 17 on 200 (a last row cut short to 8 lines) and 19 on 225 (the last
// row 9 lines): the cut is shown, and read.
{
  const page = tallPage(), all = tallWant(page);
  for (const [res, ff99, rows] of [['200', 0x20, 17], ['225', 0x60, 19]]) {
    const m = cocoMachine(tallCompatFirmware(0x0F, ff99));
    m.runFrame(); m.runFrame();
    const want = all.slice(0, rows);
    check(`CoCo 3 compatibility ${res} lines, 12 lines a row: the last row (cut to ${({ '200': 8, '225': 9 })[res]} lines) is shown and read`,
      sessionOn(m).screenText().length === rows && J(sessionOn(m).screenText()) === J(want) && compatFrameBad(m, want, 12) === 0,
      J({ got: sessionOn(m).screenText().length, want: rows }));
  }
}

// =====================================================================================================================
// 4. The main (VDG) page is read where the VDG fetches it, not through the CPU's map
// =====================================================================================================================
// The Dragon 64 Plus's $FFE2 pages the 2K video RAM (bit 0) or bank A/B (bits 1-2) in under $8000 for the CPU, but the
// MC6847 always fetches the motherboard RAM (js/machines/d64plus.js). So with "OK" on the VDG page and a bank in, the
// VDG still shows OK: the readers must say so, and `base` is null while the CPU reads something else at $0400.
{
  const m = plusMachine(0x0000);
  m.view = 'vdg';
  const page = (r) => `OK${' '.repeat(30)}`;
  for (let i = 0; i < 512; i++) m.ram[0x400 + i] = 0x60;            // inverse spaces (BASIC's green screen)
  m.ram[0x400] = 0x4F; m.ram[0x401] = 0x4B;                           // OK, row 0
  check('(setup) the banks reach memory: this is the hardware model, not mameCompat', m.banksReachMemory === true);
  for (const [name, v] of [['no bank', 0x00], ['the video RAM over $0000-$07FF ($FFE2 = $01)', 0x01], ['bank A ($FFE2 = $02)', 0x02], ['bank B ($FFE2 = $06)', 0x06]]) {
    m.write(0xFFE2, v);
    const got = tool(m), main = sessionOn(m).screenText({ main: true });
    const cpuOther = m.peek(0x400) !== 0x4F;
    check(`Plus VDG page, ${name}: screen_text and Session.screenText read OK where the VDG fetches it`,
      got.text === true && got.lines[0] === 'OK' && main[0] === page(0), J({ tool: got.lines && got.lines[0], session: main[0] }));
    check(`Plus VDG page, ${name}: base is $0400 only while the CPU reads the same page there (${cpuOther ? 'it does not' : 'it does'})`,
      got.base === (cpuOther ? null : 0x400), J({ base: got.base, cpu400: m.peek(0x400) }));
    // and the Plus view shows the board while the watchdog's main:true reads this page
    m.view = 'plus';
    check(`Plus VDG page, ${name}: with the 80-column view shown, screenText({ main: true }) still reads OK`, sessionOn(m).screenText({ main: true })[0] === page(0));
    m.view = 'vdg';
  }
  // `base` needs all 512 bytes, every row, to be the same for the CPU: the video RAM paged over $0000-$07FF holding
  // the page's row 0 exactly, and something else from row 1 on, still gives null
  m.write(0xFFE2, 0x01);
  for (let i = 0; i < 512; i++) m.videoRam[0x400 + i] = i < 32 ? m.ram[0x400 + i] : 0x41;
  const rowOne = tool(m);
  check('Plus VDG page, the video RAM paged in with the same row 0 and a different row 1 on: base null, rows still the VDG\'s',
    m.peek(0x400) === m.ram[0x400] && m.peek(0x420) !== m.ram[0x420] && rowOne.base === null && rowOne.lines[0] === 'OK', J({ base: rowOne.base, line0: rowOne.lines[0] }));
  for (let i = 0; i < 511; i++) m.videoRam[0x400 + i] = m.ram[0x400 + i];    // all but the very last byte
  check('Plus VDG page, the video RAM differing only in the page\'s last byte: base still null', tool(m).base === null);
  m.videoRam[0x5FF] = m.ram[0x5FF];
  check('Plus VDG page, the video RAM holding the same 512 bytes: base $0400 (the CPU reads the page there)', tool(m).base === 0x400);
  m.write(0xFFE2, 0x00);
}

// ---- the boot watchdog reads the main screen while the Plus shows its 80 columns ----
// A stand-in ROM of our own that never prints (it loops), so OK is put on the VDG page by hand, as BASIC prints it.
{
  const s = new Emu.Session({ store: { get() { return null; }, set() {}, remove() {} }, welcomeMenu: false });
  s.switchMachine('d64plus', {}, { menu: false });
  const m = s.shownMachine;
  // (it sets the SAM's display offset to $0400, F1 at $FFC9, as BASIC does, so the VDG shows the page OK is put on)
  const r = Emu.assemble(' ORG $8000\nSTART STA $FFC9\nLOOP BRA LOOP\n ORG $BFFE\n FDB START\n', '6809');
  const bank = romImage(r, 0x8000, 0x4000, 0x12), slots = { chargen: CODEGEN };
  for (const sl of Emu.profiles.d64plus.roms) if (!sl.chip) slots[sl.id] = bank.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size);
  m.setRoms(slots); m.reset(true);
  m.runFrame();
  // the board set up as the firmware above sets it (80 x 22), so the 80-column screen is readable text, blank
  [0x71, 0x50, 0x60, 0x0F, 0x19, 0x04, 0x16, 0x18, 0x00, 0x0B, 0x20, 0x0B, 0, 0, 0x3F, 0xFF].forEach((v, r) => { m.write(0xFFE0, r); m.write(0xFFE1, v); });
  m.videoRam.fill(0x20);
  m.view = 'plus';
  check('(setup) the 80-column screen shown is readable, blank text: what the shown-screen reader would read',
    tool(m).mode === 'HD6845S text (the Dragon Plus), 80 columns, 22 rows' && tool(m).text === true && tool(m).lines.length === 0, J(tool(m)));
  check('(setup) the stand-in ROM counts as BASIC and has not printed OK: booting', m.hasRom && s.bootStatus().state === 'booting', J(s.bootStatus()));
  for (let i = 0; i < 32; i++) m.ram[0x400 + i] = 0x60;
  m.ram[0x400] = 0x4F; m.ram[0x401] = 0x4B;
  check('the 80-column view is shown and OK is on the VDG page: bootStatus() is ok (the watchdog reads the main screen)',
    m.view === 'plus' && s.bootStatus().state === 'ok', J(s.bootStatus()));
}

// ---- a CoCo 3 screen screen_text declines still gives the page from RAM, never the ROM a slot maps ----
// Session.screenText's fallback for a screen that is not text (here a compatibility-mode graphics mode) is the
// profile's page as the display RAM holds it (physical $70400), whatever CPU slot 0 maps: here ROM.
{
  const m = cocoMachine(legacyFirmware(null));
  const g = m.gime;
  for (let i = 0; i < 512; i++) g.ram[(0x70400 + i) & g.ramMask] = 0x4B;   // K
  g.ff22 = 0x80;                                                          // graphics: screen_text declines
  g.regs[0] |= 0x40; g.mmu[0] = 0x3C; g.mapSlot(0);                       // slot 0 -> ROM
  check('(setup) a graphics mode, and CPU $0400 is ROM', tool(m).text === false && g.physAddr(0x400) === -1);
  const rows = sessionOn(m).screenText();
  check('CoCo 3 fallback: Session.screenText reads the page at physical $70400 (all K), not the ROM slot 0 maps',
    rows.length === 16 && rows.every((l) => l === 'K'.repeat(32)), J(rows[0]));
}

// ---- the readers agree with each other and change nothing ----
{
  const m = cocoMachine(legacyFirmware(null));
  const before = J(m.saveState());
  tool(m); sessionOn(m).screenText(); sessionOn(m).screenText({ main: true });
  check('reading (screen_text, Session.screenText) changes nothing in the machine', J(m.saveState()) === before);
}

// =====================================================================================================================
// 5. A VDG page the SAM's display offset (F6-F0) has moved, on the Dragon 32 and the CoCo 2
// =====================================================================================================================
// Firmware of our own: SAM M = 10 (32K/64K, $FFDD), the VDG in text mode, "OK" written at $0400 (BASIC's page), a page
// of "MOVED PAGE" text and every VDG code written at $0C00, then the SAM's F bits set to 6 (F1 $FFC9, F2 $FFCB: 6 x 512
// = $0C00), so the VDG shows $0C00. The control firmware writes the same $0C00 page's bytes at $0400 and leaves F = 2:
// if the two pictures are identical, the VDG really shows the moved page's text.
const MOVED = (() => {
  const p = new Array(512).fill(0x60);
  const put = (row, data) => data.forEach((b, i) => { p[row * 32 + i] = b; });
  put(0, bytes('MOVED PAGE AT $0C00').map((c) => c | 0x40));
  put(2, range(0x00, 32)); put(3, range(0x20, 32)); put(4, range(0x40, 32)); put(5, range(0x60, 32));
  put(15, bytes('LAST ROW, F = 6').map((c) => c | 0x40));
  return p;
})();
const OK_PAGE = (() => { const p = new Array(512).fill(0x60); p[0] = 0x4F; p[1] = 0x4B; return p; })();
function samFirmware({ pageAt, fBits, okAt }) {
  const L = [], e = (x) => L.push(x);
  e('        ORG     $8000');
  e('RESET   ORCC    #$50'); e('        LDS     #$7F00'); e('        CLRA'); e('        TFR     A,DP');
  e('        STA     $FFDD');                                         // SAM M1: 32K/64K
  for (const l of ['CLR     $FF23', 'LDA     #$F8', 'STA     $FF22', 'LDA     #$34', 'STA     $FF23', 'CLR     $FF22']) e(`        ${l}`);
  const data = [];
  if (okAt != null) data.push(...writes(e, range(0, 4).map((k) => [okAt + k * 128, OK_PAGE.slice(k * 128, k * 128 + 128)])));
  data.push(...writes(e, range(0, 4).map((k) => [pageAt + k * 128, MOVED.slice(k * 128, k * 128 + 128)])));
  // F6-F0: each bit k set at $FFC7 + 2k, cleared at $FFC6 + 2k
  for (let k = 0; k < 7; k++) e(`        STA     ${hx(0xFFC6 + 2 * k + ((fBits >> k) & 1), 4)}`);
  e('HALT    BRA     HALT');
  tables(e, data);
  e('        ORG     $BFF2'); e('        FDB     HALT,HALT,HALT,HALT,HALT,HALT,RESET'); e('        END     RESET');
  return L.join('\n') + '\n';
}
function samMachine(id, opts) {
  const asm = Emu.assemble(samFirmware(opts), '6809');
  if (!asm.ok) throw new Error(J(asm.errors));
  const img = romImage(asm, 0x8000, 0x4000, 0x12), slots = {};
  for (const sl of Emu.profiles[id].roms) if (!sl.chip) slots[sl.id] = img.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size);
  const m = Emu.createMachine(id, {});
  m.setRoms(slots); m.reset(true);
  runToHalt(m, asm.symbols.get('HALT'));
  return m;
}
const samWant = range(0, 16).map((r) => MOVED.slice(r * 32, r * 32 + 32).map(vdgChar).join(''));
const frameOf = (m) => J(Array.from(m.render().data));

(async () => {
  for (const id of ['dragon32', 'coco2b']) {
    const m = samMachine(id, { pageAt: 0x0C00, fBits: 6, okAt: 0x0400 });
    const control = samMachine(id, { pageAt: 0x0400, fBits: 2, okAt: null });
    check(`${id} SAM page: (setup) the SAM's display offset is $0C00, and $0400 holds OK`, m.sam.displayBase === 0x0C00 && m.ram[0x400] === 0x4F);
    check(`${id} SAM page: (oracle) the picture is the control's, which shows the same bytes from $0400 with F = 2`,
      frameOf(m) === frameOf(control) && frameOf(m) !== frameOf(samMachine(id, { pageAt: 0x0C00, fBits: 2, okAt: 0x0400 })));
    const got = tool(m), sess = sessionOn(m).screenText();
    check(`${id} SAM page: screen_text reads the page the VDG shows ($0C00), not $0400's OK; base $0C00`,
      got.text === true && J(got.lines) === J(trim(samWant)) && got.base === 0x0C00, J({ base: got.base, line0: got.lines && got.lines[0] }));
    check(`${id} SAM page: Session.screenText reads the same 16 rows`, J(sess) === J(samWant), J(sess[0]));
    check(`${id} SAM page: the control (F = 2) reads the same rows at base $0400`, J(tool(control).lines) === J(trim(samWant)) && tool(control).base === 0x0400);
    // the readers see only the displayed page: OK at $0400 is not on screen
    check(`${id} SAM page: no row reads OK while it is only at $0400`, !sessionOn(m).screenText({ main: true }).some((l) => l.trim() === 'OK'));
    // the SAM's video counter is sized by M (MC6883 data sheet, "Memory Size"): under a 4K counter (M = 00) an offset
    // of $1000 (F = 8) wraps to $0000, which is what the VDG shows; the page is not where the CPU sees $1000: base null
    for (let i = 0; i < 32; i++) m.ram[i] = 'WRAPPED TO $0000 UNDER A 4K SAM '.charCodeAt(i) & 0x3F | 0x40;
    m.sam.reg = (m.sam.reg & ~(3 << 13) & ~(0x7F << 3)) | (8 << 3);
    const w = tool(m);
    check(`${id} SAM page: F = 8 under a 4K counter (M = 00) reads the page the counter wraps to, $0000; base null`,
      m.sam.displayBase === 0x1000 && w.lines[0] === 'WRAPPED TO $0000 UNDER A 4K SAM' && w.base === null, J({ base: w.base, line0: w.lines && w.lines[0] }));
  }

  // ---- the fallback for a screen screen_text declines reads the page the SAM selects ----
  // A graphics mode (screen_text declines it) on a SAM machine: Session.screenText's fallback rows are the page at the
  // SAM's display offset, not BASIC's $0400; and with the SAM at power-on (F = 0), the page at $0000.
  for (const id of ['dragon32', 'coco2b']) {
    const m = samMachine(id, { pageAt: 0x0C00, fBits: 6, okAt: 0x0400 });
    m.write(0xFF22, 0xF8);                                                // the VDG to RG6 graphics (A/G set)
    m.runFrame();
    check(`${id} fallback: (setup) a graphics mode, which screen_text declines`, tool(m).text === false, J(tool(m).mode));
    const rows = sessionOn(m).screenText(), main = sessionOn(m).screenText({ main: true });
    check(`${id} fallback: Session.screenText reads the page at the SAM's offset ($0C00), not $0400's OK`,
      J(rows) === J(samWant) && J(main) === J(samWant), J(rows[0]));
    for (let k = 0; k < 7; k++) m.write(0xFFC6 + 2 * k, 0);              // F = 0, as at power-on
    for (let i = 0; i < 32; i++) m.ram[i] = 'PAGE ZERO, WHERE F = 0 POINTS   '.charCodeAt(i) & 0x3F | 0x40;
    check(`${id} fallback: with F = 0 (a ROM that has not set up the SAM) it reads $0000`,
      m.sam.displayBase === 0 && sessionOn(m).screenText()[0] === 'PAGE ZERO, WHERE F = 0 POINTS   ', J(sessionOn(m).screenText()[0]));
  }

  // ---- the boot watchdog sees only the displayed page ----
  {
    const st = new Emu.Session({ store: { get() { return null; }, set() {}, remove() {} }, welcomeMenu: false });
    st.switchMachine('dragon32', {}, { menu: false });
    const m = st.shownMachine;
    // a stand-in BASIC of our own that shows the page at $0C00 (F = 6) and loops; it never prints OK
    const r = Emu.assemble(' ORG $8000\nSTART STA $FFC9\n STA $FFCB\n CLR $FF23\n LDA #$F8\n STA $FF22\n LDA #$34\n STA $FF23\n CLR $FF22\nLOOP BRA LOOP\n ORG $BFFE\n FDB START\n', '6809');
    m.setRoms({ basic: romImage(r, 0x8000, 0x4000, 0x12) }); m.reset(true);
    for (let i = 0; i < 3; i++) m.runFrame();
    for (let i = 0; i < 1024; i++) m.ram[0x400 + i] = 0x60;
    m.ram[0x400] = 0x4F; m.ram[0x401] = 0x4B;
    check('watchdog: (setup) the VDG shows $0C00', m.sam.displayBase === 0x0C00);
    check('watchdog: OK only at $0400, which is not on screen: still booting', st.bootStatus().state === 'booting', J(st.bootStatus()));
    m.ram[0xC00] = 0x4F; m.ram[0xC01] = 0x4B; for (let i = 2; i < 32; i++) m.ram[0xC00 + i] = 0x60;
    check('watchdog: OK on the displayed page at $0C00: ok', st.bootStatus().state === 'ok', J(st.bootStatus()));
  }

  // ---------------- a full-screen chat: the shown screen and the person's machine ----------------
  // Session.screenText() means "the screen": in a full-screen chat, the chat machine's. screenTextTool(chatTarget())
  // reads the person's machine, the BASIC session beside it. Both are pinned here, and they must differ.
  {
    const fsx = require('fs'), pathx = require('path');
    const firmware = new Uint8Array(fsx.readFileSync(pathx.join(__dirname, '..', 'examples/chat.bin')));
    const s = new Emu.Session({ welcomeMenu: false, store: Emu.memoryStore(), media: new Emu.MemoryMediaStore() });
    s.switchMachine('dragon64', {}, { menu: false });
    const basic = s.shownMachine;
    s.runAssembled(Emu.assemble([
      '        ORG     $3000',
      'START   ORCC    #$50',
      '        LDX     #$0400',
      'CLR     LDA     #$60',
      '        STA     ,X+',
      '        CMPX    #$0600',
      '        BNE     CLR',
      '        LDX     #MSG',
      '        LDY     #$0400',
      'COPY    LDA     ,X+',
      '        BEQ     SPIN',
      '        STA     ,Y+',
      '        BRA     COPY',
      'SPIN    BRA     SPIN',
      "MSG     FCC     /BASIC SESSION HERE/",
      '        FCB     0',
      '        END     START'].join('\n'), '6809'));
    s.runFrames(3);
    s.startChat({ backend: new Emu.ClaudeBackend({ fetch: async () => null, apiKey: 'sk-ant-test' }), channel: new Emu.MemoryChannel(), firmware, brief: '', tools: false });
    s.runFrames(10);
    const chatM = s.shownMachine;
    const shown = s.screenText().map((l) => l.replace(/\s+$/, '')).join('\n');
    const person = Emu.screenTextTool(s.chatTarget());
    check('full-screen chat: screenText() reads the chat machine on screen (its own screen, not the BASIC session\'s)',
      chatM !== basic && shown === s.screenText(chatM).map((l) => l.replace(/\s+$/, '')).join('\n') && !shown.includes('BASIC SESSION HERE'), J(shown.slice(0, 80)));
    check('full-screen chat: screenTextTool(chatTarget()) reads the person\'s machine, the BASIC session beside it',
      s.chatTarget().machine === basic && person.text && person.lines[0] === 'BASIC SESSION HERE', J(person.lines && person.lines.slice(0, 2)));
    check('full-screen chat: the two differ', person.lines.join('\n') !== shown);
  }

  console.log(`\n${n - fail}/${n} passed`);
  process.exitCode = fail ? 1 : 0;
})();
