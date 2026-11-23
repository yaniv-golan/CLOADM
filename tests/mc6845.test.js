// Run: node tests/mc6845.test.js
// The MC6845 / HD6845S CRT controller (the Dragon 64 Plus's 80-column board).
//
// The expected values are worked out here from the register definitions and the frame geometry in the
// data sheet (Motorola MC6845, ADM30A 1977; Hitachi HD6845S for R12/R13 read-back, the vertical sync
// width and the cursor rule), not by running the chip: a frame is R4+1 character rows of R9+1 raster
// lines each, plus R5 extra scanlines; MA advances by R1 per row and reloads to R12/R13 at row R6.
const Emu = require('./load')();
const { MC6845 } = require('../js/chips/mc6845.js');

let fail = 0;
const check = (n, c, d = '') => { if (!c) { fail++; console.log('FAIL', n, d); } else console.log('ok  ', n, d); };

// a CRTC programmed like the Dragon 64 Plus's 80-column board: 80x24 characters of 8x12 on a 640x264
// field. R0 = 79 chars per line - 1, R1 = 80 displayed, R4 = 26 rows - 1, R6 = 24 displayed,
// R9 = 11 raster lines per row - 1, R5 = 0.
const crtc = (reg = {}) => {
  const c = new MC6845();
  const r = Object.assign({ 0: 0x4F, 1: 80, 2: 0x53, 3: 0x0F, 4: 0x1A, 5: 0, 6: 24, 7: 0x1C, 8: 0, 9: 11, 10: 0x0F, 11: 0x0F,
    12: 0, 13: 0, 14: 0, 15: 0 }, reg);
  for (const [k, v] of Object.entries(r)) { c.writeAddress(+k); c.writeRegister(v); }
  return c;
};

// ---- registers ----
{
  const c = new MC6845();
  c.writeAddress(0x00); c.writeRegister(0x4F);
  check('the address latch selects the register and R0 keeps its eight bits', c.reg[0] === 0x4F, c.reg[0].toString(16));
  c.writeAddress(0x01); c.writeRegister(0xFF);
  check('R1 is a full byte (up to 255 displayed characters)', c.reg[1] === 0xFF);
  c.writeAddress(0x04); c.writeRegister(0xFF);
  check('R4 (vertical total) is seven bits, as the data sheet says', c.reg[4] === 0x7F, c.reg[4].toString(16));
  c.writeAddress(0x05); c.writeRegister(0xFF);
  check('R5 (vertical total adjust) is five bits', c.reg[5] === 0x1F, c.reg[5].toString(16));
  c.writeAddress(0x09); c.writeRegister(0xFF);
  check('R9 (maximum raster address) is five bits', c.reg[9] === 0x1F, c.reg[9].toString(16));
  c.writeAddress(0x0B); c.writeRegister(0xFF);
  check('R11 (cursor end raster) is five bits', c.reg[11] === 0x1F, c.reg[11].toString(16));
  c.writeAddress(0x0C); c.writeRegister(0xFF);
  check('R12 (start address high) keeps six bits', c.reg[12] === 0x3F, c.reg[12].toString(16));
  c.writeAddress(0x1F); c.writeRegister(0xAA);
  check('a latch above CRTC R17 writes no register (there are eighteen)', c.reg[17] === 0x00);
}

// ---- HD6845S read-back ----
{
  const c = crtc({ 12: 0x12, 13: 0x34, 14: 0x05, 15: 0x67 });
  c.writeAddress(12); const hi = c.readRegister();
  c.writeAddress(13); const lo = c.readRegister();
  check('HD6845S reads R12/R13 (the start address) back', hi === 0x12 && lo === 0x34, `${hi.toString(16)} ${lo.toString(16)}`);
  check('the start address register pair is one 14-bit address',
    c.dispStartAddress === ((0x12 << 8) | 0x34), c.dispStartAddress.toString(16));
  c.writeAddress(14); const ch = c.readRegister();
  c.writeAddress(15); const cl = c.readRegister();
  check('HD6845S reads R14/R15 (the cursor address) back', ch === 0x05 && cl === 0x67);
  c.writeAddress(0); const r0 = c.readRegister();
  check('a register with no read path returns 0', r0 === 0);
  check('the HD6845S has no status register bits', c.readStatus() === 0);
}

// ---- frame geometry, straight from the register definitions ----
{
  const c = crtc();
  check('a frame is (R4+1) rows of (R9+1) lines, plus R5', c.vertTotal === 27 && c.linesPerRow === 12 && c.frameLines === 27 * 12, `${c.vertTotal} ${c.linesPerRow} ${c.frameLines}`);
  check('the line is (R0+1) characters', c.horizTotal === 80);
  check('24 rows of 12 lines are displayed', c.vertDisplayed === 24);
}

// ---- the counters run one frame ----
// Clock a whole frame line by line and record what the CRTC presents: which lines have DE, and the MA of
// each line. The data sheet's geometry says what these must be.
//
// The first frame after reset displays nothing: MAME's mc6845.cpp device_reset() clears
// m_line_enable_ff ("all outputs go low"), and it is set again only when the vertical total adjust ends -
// at the start of the second frame. The data sheet's reset section says the same ("all outputs are low").
// So the frame whose contents are the data sheet's geometry is the second one, and the first is checked
// to be blank.
{
  const c = crtc();
  const blank = [];
  for (let i = 0; i < c.frameLines; i++) { c.clockLine(); blank.push(c.de_r()); }
  check('the first frame after reset displays nothing (DE stays low until the second frame)',
    blank.every((d) => !d) && c.frameStarts === 0, `${c.frameStarts} frame boundaries`);
  // (a fresh chip, so this does not consume the line the checks below start from)
  const c1 = crtc();
  for (let i = 0; i < c1.frameLines; i++) c1.clockLine();
  c1.clockLine();
  check('the second frame begins at the boundary after the first frame\'s 324 lines',
    c1.frameStarts === 1 && c1.de_r(), `${c1.frameStarts} frame boundaries`);  const seen = [];
  for (let i = 0; i < c.frameLines; i++) { c.clockLine(); seen.push({ de: c.de_r(), ma: c.ma_r, ra: c.ra_r, vs: c.vs_r() }); }
  const lines = c.frameLines;
  check('a frame takes exactly R4+1 rows of R9+1 lines', lines === 324 && seen.length === 324, String(lines));
  // RA walks 0..11 within each row
  const raOk = seen.every((s, i) => s.ra === i % 12);
  check('RA counts 0..R9 within every character row', raOk, JSON.stringify(seen.slice(0, 14).map((s) => s.ra)));
  // DE is on for the first R6 rows (24 x 12 = 288 lines) and off for the rest
  const deOn = seen.filter((s) => s.de).length;
  check('DE is on for R6 rows (24 x 12 = 288 line periods)', deOn === 288, String(deOn));
  check('DE is on at the start of the frame and off after row R6', seen[0].de && !seen[289].de && !seen[323].de);
  // MA starts at the start address and advances by R1 each row while the display is on; after row R6 it
  // reloads to the start address (the data sheet: MA is reset to R12/R13 when the display ends)
  const maRow = seen.filter((_, i) => i % 12 === 0).map((s) => s.ma);
  check('MA advances by R1 (80) at the end of every displayed row, then reloads to R12/R13',
    maRow.slice(0, 24).every((m, i) => m === ((c.dispStartAddress + i * 80) & 0x3FFF))
    && maRow.slice(24).every((m) => m === c.dispStartAddress), JSON.stringify(maRow.slice(0, 5)) + ' … ' + JSON.stringify(maRow.slice(24)));
}

// ---- display enable and the vertical total adjust ----
{
  const c = crtc({ 4: 0x1A, 5: 4 });          // 27 rows of 12, then 4 extra scanlines
  check('R5 adds its scanlines to the frame', c.frameLines === 27 * 12 + 4 && c.frameLines === 328);
  // taken in the second frame (the first after reset is blank; see above)
  for (let i = 0; i < c.frameLines; i++) c.clockLine();
  let adjustSeen = 0;
  for (let i = 0; i < c.frameLines; i++) { c.clockLine(); if (!c.de_r()) adjustSeen++; }
  const off = 27 * 12 - 24 * 12;               // rows 24..26 are not displayed
  check('the adjust scanlines and the undisplayed rows have DE off', adjustSeen === off + 4, `${adjustSeen} vs ${off + 4}`);
}

// ---- horizontal and vertical sync ----
{
  const c = crtc({ 3: 0xF0, 7: 0x10 });           // VS at row 16, width 15 lines (R3 high nibble 15)
  let low = 0, first = null;
  for (let i = 0; i < c.frameLines; i++) { c.clockLine(); if (!c.vs_r()) { low++; if (first === null) first = i; } }
  check('VS is low for R3\'s high nibble lines (HD6845S vertical sync width)', low === 15, String(low));
  check('VS starts at the first line of row R7 (16 x 12 = line 192)', first === 16 * 12, String(first));
  // MAME counts the width in a four-bit counter, so a programmed 0 is 16 lines (the wrap)
  const c2 = crtc({ 3: 0x00, 7: 0x10 });
  let low2 = 0;
  for (let i = 0; i < c2.frameLines; i++) { c2.clockLine(); if (!c2.vs_r()) low2++; }
  check('a zero vertical sync width is 16 lines (the four-bit counter wraps)', low2 === 16, String(low2));
}

// ---- the cursor ----
// The cursor output is only drawn in displayed lines, so these measure the second frame (see above). CRTC R10's
// blink bits: 00 always on, so the state the first frame boundary set (on) holds.
const twoFrames = (c) => { for (let i = 0; i < c.frameLines; i++) c.clockLine(); };
{
  // cursor at MA 200, rows of 12 lines, cursor rasters 0..11: the row containing MA 200 is rows 2 (160..239)
  const c = crtc({ 14: 200 >> 8, 15: 200 & 0xFF, 10: 0x00, 11: 0x0B });
  twoFrames(c);
  let cursorLines = 0, first = null;
  for (let i = 0; i < c.frameLines; i++) {
    c.clockLine();
    if (c.cursor_r()) { cursorLines++; if (first === null) first = i; }
  }
  check('the cursor is drawn for its row\'s raster lines (start 0 .. end 11 = all 12)',
    cursorLines === 12 && first === 2 * 12, `${cursorLines} lines, first at ${first}`);
  const c2 = crtc({ 14: 200 >> 8, 15: 200 & 0xFF, 10: 0x03, 11: 0x05 });
  twoFrames(c2);
  let lines2 = 0;
  for (let i = 0; i < c2.frameLines; i++) { c2.clockLine(); if (c2.cursor_r()) lines2++; }
  check('a cursor from raster 3 to 5 is drawn on 3 lines', lines2 === 3, String(lines2));
  // HD6845S: start raster > end raster draws nothing (the MC6845 would wrap)
  const c3 = crtc({ 14: 200 >> 8, 15: 200 & 0xFF, 10: 0x09, 11: 0x02 });
  twoFrames(c3);
  let lines3 = 0;
  for (let i = 0; i < c3.frameLines; i++) { c3.clockLine(); if (c3.cursor_r()) lines3++; }
  check('HD6845S: a start raster after the end raster draws no cursor at all', lines3 === 0, String(lines3));
  // the cursor column within the row
  const c4 = crtc({ 14: 203 >> 8, 15: 203 & 0xFF, 10: 0, 11: 11 });
  twoFrames(c4);
  let col = null;
  for (let i = 0; i < c4.frameLines; i++) { c4.clockLine(); if (col === null && c4.cursorX_r >= 0) col = c4.cursorX_r; }
  check('the cursor column is the cursor MA less the row\'s start MA', col === 203 - 160, String(col));
  // a cursor outside the displayed window is not drawn
  const c5 = crtc({ 14: 22 >> 8, 15: 22, 10: 0, 11: 11 });   // MA 22 is in row 0 (MA 0..79): drawn
  const c6 = crtc({ 14: (24 * 80 + 5) >> 8, 15: (24 * 80 + 5) & 0xFF, 10: 0, 11: 11 });  // past row 23
  twoFrames(c5); twoFrames(c6);
  let inWin = 0, pastWin = 0;
  for (let i = 0; i < c5.frameLines; i++) { c5.clockLine(); if (c5.cursor_r()) inWin++; }
  for (let i = 0; i < c6.frameLines; i++) { c6.clockLine(); if (c6.cursor_r()) pastWin++; }
  check('a cursor inside the displayed rows is drawn; one past them is not', inWin === 12 && pastWin === 0, `${inWin} ${pastWin}`);
}

// ---- the start address ----
{
  const c = crtc({ 12: 0x01, 13: 0x00 });     // start at MA 0x100
  c.clockLine();
  check('the first line of the frame starts at R12/R13', c.ma_r === 0x100, c.ma_r.toString(16));
  // R12/R13 is read at the end of every character row (the data sheet: the start address is sampled at
  // the row rate), so a write takes effect from the next row
  c.writeAddress(12); c.writeRegister(0x02);
  c.clockLine();
  check('a new start address takes effect at the next character row', c.ma_r === 0x200, c.ma_r.toString(16));
}

// ---- state ----
{
  const a = crtc({ 12: 1, 13: 0x20, 14: 1, 15: 0x25, 5: 3, 7: 0x12 });
  for (let i = 0; i < 200; i++) a.clockLine();
  const s = JSON.parse(JSON.stringify(a.saveState()));
  const b = new MC6845();
  b.loadState(s);
  let same = true;
  for (let i = 0; i < 2 * a.frameLines; i++) {
    a.clockLine(); b.clockLine();
    if (a.ma_r !== b.ma_r || a.ra_r !== b.ra_r || a.de_r() !== b.de_r() || a.vs_r() !== b.vs_r() || a.cursor_r() !== b.cursor_r()) { same = false; break; }
  }
  check('a restored CRTC produces the same MA, RA, DE, VS and cursor line for line', same);
  check('the snapshot holds plain data (registers and counters)', Array.isArray(s.reg) && s.reg.length === 18 && typeof s.rowCounter === 'number');
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
