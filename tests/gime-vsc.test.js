// Run: node tests/gime-vsc.test.js
//
// The GIME's vertical fine scroll, $FF9C bits 0-3 (VSC), in the GIME (native) modes (js/chips/gime.js vscLine).
// Every expected picture here is worked out by hand from the sources, not by running the code under test:
//  * Sock Master's GIME reference, "FF9C Vertical scroll register - VSC": bits 7-4 unused; consecutive values
//    scroll the screen up one scanline at a time in modes where a text row or a graphics row is more than one
//    scanline;
//  * the CoCo 3 Service Manual (26-3334), section 1.5, printed p13: bits 3-0 are VSC3-0;
//  * Tepolt, Assembly Language Programming for the CoCo3 (1987), printed pp29-30: in 8-line native text, VSC 0-7
//    move the picture up, and the next row of the buffer enters at the bottom (a partial extra row);
//  * Super Extended BASIC Unravelled II, ch. 5, printed pp18-19: VSC never carries into the video start.
// So with rows of L scanlines and VSC = v < L, body line k (0 = the first) shows line (k + v) mod L of buffer row
// floor((k + v) / L). What the sources leave open is pinned to this model's choice (docs/verification.md,
// "Deviations from MAME"): v >= L, rows of 1 line and LPR 7 are not scrolled, and VSC is latched at the start of
// the field. config.mameCompat (MAME 0.264, which never scrolls) shows line k of row floor(k / L) always.
const Emu = require('./load')();
const { GIME } = Emu;

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };

const W = GIME.WIDTH;
const BASE = 0x60000;                 // the video start used throughout: $FF9D = $C0, $FF9E = 0
// a GIME on its own (no CPU): 512K, registers poked, the beam stepped one line at a time
function gime(opts = {}) {
  const g = new GIME(Object.assign({ ram: new Uint8Array(0x80000), rom: () => new Uint8Array(0x8000) }, opts));
  const r = g.regs;
  r[0] = 0x00;                        // $FF90: GIME modes
  r[13] = BASE >> 11; r[14] = 0;      // $FF9D/$FF9E
  r[10] = 0x3F;                       // border white
  for (let i = 0; i < 16; i++) g.palette[i] = i + 16;   // palette entry i shows colour code i + 16
  return g;
}
// run whole fields; a field starts when the GIME starts a new frame (newFrame, at the end of vertical blanking)
function field(g, count = 1) {
  for (let f = 0; f < count; f++) {
    const start = g.physical === 0 && g.zone === 0;
    let guard = 0;
    if (start) g.hsRise();
    while (!(g.physical === 0 && g.zone === 0) && guard++ < 400) { g.hsRise(); g.hsFall(); }
  }
}
const px = (g, x, y) => g.frame.data[y * W + x];
// 320x192x16 graphics ($FF99 $1E: 160 bytes a row, 4 bits a pixel), row r of the buffer filled with colour r & 15
function graphics(g, f98, rows = 40) {
  g.regs[8] = f98; g.regs[9] = 0x1E;
  for (let r = 0; r < rows; r++) g.ram.fill(((r & 15) << 4) | (r & 15), BASE + r * 160, BASE + (r + 1) * 160);
  g.updateGeometry();
}
const Y0 = 24;                        // the first body line of a 192-line picture (25 top border lines, from line 1)
// body line k's buffer row, from the colour drawn (palette entry = row & 15)
const rowAt = (g, k) => px(g, 320, Y0 + k) - 16;

// ---- 1. 8-line graphics rows: every VSC from 0 to 15 ----
for (let v = 0; v < 16; v++) {
  const g = gime();
  graphics(g, 0x83);                  // HRES, 8 lines a row
  g.regs[12] = v;
  field(g, 2);
  const s = v < 8 ? v : 0;            // the sources: v < 8 scrolls; above, this model's choice
  const want = [], got = [];
  for (let k = 0; k < 192; k++) { want.push(Math.floor((k + s) / 8) & 15); got.push(rowAt(g, k)); }
  check(`8-line graphics, VSC ${v}: body line k shows buffer row floor((k + ${s}) / 8)`, JSON.stringify(got) === JSON.stringify(want),
    `first lines ${got.slice(0, 12)}`);
  if (v >= 1 && v < 8) {
    check(`8-line graphics, VSC ${v}: the first row shows ${8 - v} lines, the last line is row 24 (the partial extra row)`,
      got.slice(0, 8 - v).every((r) => r === 0) && got[8 - v] === 1 && got[191] === 24 % 16);
  }
}

// ---- 2. 2-line (double height) graphics: VSC 1 shifts by one line; 2 and up are not a scroll within a row ----
for (const [v, s] of [[1, 1], [2, 0], [3, 0], [15, 0]]) {
  const g = gime();
  graphics(g, 0x82, 100);
  g.regs[12] = v;
  field(g, 2);
  let ok = true;
  for (let k = 0; k < 192; k++) if (rowAt(g, k) !== (Math.floor((k + s) / 2) & 15)) ok = false;
  check(`2-line graphics, VSC ${v}: scrolled ${s} line${s === 1 ? '' : 's'}`, ok);
}

// ---- 3. 9, 10 and 11-line graphics rows ----
for (const [f98, L] of [[0x84, 9], [0x85, 10], [0x86, 11]]) {
  for (const v of [1, L - 1, L, 15]) {
    const g = gime();
    graphics(g, f98);
    g.regs[12] = v;
    field(g, 2);
    const s = v < L ? v : 0;
    let ok = true;
    for (let k = 0; k < 192; k++) if (rowAt(g, k) !== (Math.floor((k + s) / L) & 15)) ok = false;
    check(`${L}-line graphics, VSC ${v}: scrolled ${s}`, ok);
  }
}

// ---- 4. rows of one line (LPR 0 and 1) and LPR 7: never scrolled ----
for (const f98 of [0x80, 0x81, 0x87]) {
  for (const v of [1, 5, 15]) {
    const g = gime(), h = gime();
    graphics(g, f98, 200); graphics(h, f98, 200);
    g.regs[12] = v;
    field(g, 2); field(h, 2);
    check(`LPR ${f98 & 7}, VSC ${v}: the same picture as VSC 0`, g.frame.data.every((c, i) => c === h.frame.data[i]));
  }
}

// ---- 5. 8-line text: the underline marks the row's last line (line 7) ----
// 40 columns with attributes ($FF99 $05), every cell a space with attribute $40 + (row & 7): underlined, foreground
// palette 8, background palette (row & 7). Line k of the body is row r = floor((k + v) / 8), line (k + v) mod 8.
for (const v of [0, 1, 3, 7, 8]) {
  const g = gime();
  g.regs[8] = 0x03; g.regs[9] = 0x05; g.updateGeometry();
  for (let r = 0; r < 30; r++) for (let c = 0; c < 40; c++) { g.ram[BASE + r * 80 + c * 2] = 0x20; g.ram[BASE + r * 80 + c * 2 + 1] = 0x40 | (r & 7); }
  g.regs[12] = v;
  field(g, 2);
  const s = v < 8 ? v : 0;
  let ok = true, first = null;
  for (let k = 0; k < 192; k++) {
    const r = Math.floor((k + s) / 8), line = (k + s) % 8;
    const want = line === 7 ? 8 + 16 : (r & 7) + 16;   // underline: foreground (palette 8), else the background
    const got = px(g, 100, Y0 + k);
    if (got !== want) { ok = false; if (first === null) first = `line ${k}: ${got} not ${want}`; }
  }
  check(`8-line text, VSC ${v}: underlines on body lines k with (k + ${s}) mod 8 = 7, backgrounds of row floor((k + ${s}) / 8)`, ok, first || '');
}

// ---- 6. the 225-line picture (8 top border lines) scrolls the same way ----
{
  const g = gime();
  graphics(g, 0x83);
  g.regs[9] = 0x7E; g.updateGeometry();   // $FF99 bits 5-6 = 3: 225 lines (as a write to $FF99 updates it)
  g.regs[12] = 5;
  field(g, 2);
  let ok = true;
  for (let k = 0; k < 225; k++) if ((px(g, 320, 7 + k) - 16) !== (Math.floor((k + 5) / 8) & 15)) ok = false;
  check('225 lines, 8-line rows, VSC 5: body line k shows row floor((k + 5) / 8), from picture line 7', ok);
}

// ---- 7. bits 4-7 are unused ----
{
  const g = gime(), h = gime();
  graphics(g, 0x83); graphics(h, 0x83);
  g.regs[12] = 0xF3; h.regs[12] = 0x03;
  field(g, 2); field(h, 2);
  check('$FF9C $F3 scrolls as $03 (bits 4-7 unused)', g.frame.data.every((c, i) => c === h.frame.data[i]) && rowAt(g, 4) === 0 && rowAt(g, 5) === 1);
}

// ---- 8. VSC is latched at the start of the field ----
{
  const g = gime();
  graphics(g, 0x83);
  field(g, 2);
  // in the top border of a field that started with VSC 0: this field is not scrolled, the next one is
  let guard = 0;
  while (!(g.zone === 0 && g.physical === 5) && guard++ < 400) { g.hsRise(); g.hsFall(); }
  g.regs[12] = 4;
  field(g, 1);
  const unscrolled = rowAt(g, 7) === 0 && rowAt(g, 8) === 1;
  field(g, 1);
  check('a write in the top border shows from the next field, not this one', unscrolled && rowAt(g, 3) === 0 && rowAt(g, 4) === 1);
  // written mid-body, then put back before the field ends: never seen
  guard = 0;
  while (!(g.zone === 1 && g.logical === 100) && guard++ < 400) { g.hsRise(); g.hsFall(); }
  g.regs[12] = 0;
  guard = 0;
  while (!(g.zone === 2) && guard++ < 400) { g.hsRise(); g.hsFall(); }
  g.regs[12] = 4;
  field(g, 2);
  check('the field keeps the VSC it started with when it is changed mid-body', rowAt(g, 3) === 0 && rowAt(g, 4) === 1);
}

// ---- 9. compatibility mode: $FF9C is the lines-per-row table there, never a scroll of the native kind ----
{
  const g = gime(), h = gime();
  for (const x of [g, h]) { x.regs[0] = 0x80; x.ff22 = 0xF0; x.sam = 6; }   // COCO set, RG6
  g.regs[12] = 0x03; h.regs[12] = 0x00;
  field(g, 2); field(h, 2);
  check('compatibility mode graphics: VSC changes nothing', g.frame.data.every((c, i) => c === h.frame.data[i]));
}
// ... and with $FF98 holding a native 8-line setting ($03) and VSC 3, which would scroll a GIME mode: compatibility
// text, $FF9C 3 = 8 lines a row (the table; Marentes's SG modes), each row of 32 cells a solid semigraphics-4 block
// ($8F | colour << 4) in colour (row & 7), so body line k shows palette entry floor(k / 8) & 7: no scroll
{
  const g = gime();
  g.regs[0] = 0x80; g.ff22 = 0x00; g.sam = 0; g.regs[8] = 0x03; g.regs[12] = 0x03;
  for (let r = 0; r < 26; r++) g.ram.fill(0x8F | ((r & 7) << 4), BASE + r * 32, BASE + (r + 1) * 32);
  field(g, 2);
  let ok = true, first = null;
  for (let k = 0; k < 192; k++) {
    const want = (Math.floor(k / 8) & 7) + 16, got = px(g, 100, Y0 + k);
    if (got !== want) { ok = false; if (first === null) first = `line ${k}: ${got} not ${want}`; }
  }
  check('compatibility text, $FF98 $03 and $FF9C 3: 8-line rows from the top, not scrolled', ok, first || '');
}

// ---- 10. config.mameCompat (MAME 0.264): never scrolled ----
for (const [f98, v] of [[0x83, 3], [0x82, 1], [0x86, 10]]) {
  const g = gime({ mameCompat: true }), h = gime({ mameCompat: true });
  graphics(g, f98); graphics(h, f98);
  g.regs[12] = v;
  field(g, 2); field(h, 2);
  check(`mameCompat: LPR ${f98 & 7}, VSC ${v} is the same picture as VSC 0`, g.frame.data.every((c, i) => c === h.frame.data[i]));
}

// ---- 11. the text screen as the field on the screen draws it (textScreen, which screen_text reads) ----
{
  const g = gime();
  g.regs[8] = 0x03; g.regs[9] = 0x05; g.updateGeometry();
  const text = (s, at) => [...s].forEach((ch, i) => { g.ram[BASE + at * 80 + i * 2] = ch.charCodeAt(0); g.ram[BASE + at * 80 + i * 2 + 1] = 0; });
  for (let r = 0; r < 26; r++) text(`ROW ${String(r).padStart(2, '0')}`, r);
  field(g, 2);
  let t = g.textScreen();
  check('VSC 0: 24 rows of 8 lines', t.vsc === 0 && t.rows === 24);
  g.regs[12] = 3;
  field(g, 2);
  t = g.textScreen();
  const lines = t.chars.map((c) => String.fromCharCode(...c.slice(0, 6)));
  check('VSC 3: 25 rows (192 + 3 lines), the 25th the buffer\'s row 24, shown in part', t.vsc === 3 && t.rows === 25 && lines[24] === 'ROW 24' && lines[0] === 'ROW 00');
  g.regs[12] = 8;
  field(g, 2);
  check('VSC 8 (not below the row height): 24 rows, vsc 0', g.textScreen().vsc === 0 && g.textScreen().rows === 24);
  const c = gime({ mameCompat: true });
  c.regs[8] = 0x03; c.regs[9] = 0x05; c.regs[12] = 3; c.updateGeometry();
  field(c, 2);
  check('mameCompat: VSC 3 reads 24 rows, vsc 0', c.textScreen().vsc === 0 && c.textScreen().rows === 24);
  // written mid-field: the field being drawn keeps its latched scroll, and so does the reading, until the next
  // field starts with the new value. h is the same screen left at VSC 0 throughout.
  const h = gime();
  h.regs[8] = 0x03; h.regs[9] = 0x05; h.updateGeometry(); h.ram.set(g.ram);
  g.regs[12] = 0; field(g, 2); field(h, 2);
  let guard = 0;
  while (!(g.zone === 1 && g.logical === 100) && guard++ < 400) { g.hsRise(); g.hsFall(); }
  g.regs[12] = 3;
  guard = 0;
  while (!(g.zone === 1 && g.logical === 150) && guard++ < 400) { g.hsRise(); g.hsFall(); }
  const drawn = g.frame.data.subarray(0, (Y0 + 150) * W), ref = h.frame.data.subarray(0, (Y0 + 150) * W);
  t = g.textScreen();
  check('VSC 3 written mid-field: the lines drawn so far are not scrolled, and textScreen agrees (vsc 0, 24 rows)',
    drawn.every((v, i) => v === ref[i]) && t.vsc === 0 && t.rows === 24, JSON.stringify({ vsc: t.vsc, rows: t.rows }));
  field(g, 2);
  t = g.textScreen();
  check('... and from the next field both are scrolled (vsc 3, 25 rows; the picture differs)', t.vsc === 3 && t.rows === 25
    && !g.frame.data.every((v, i) => v === h.frame.data[i]));
}

// ---- 12. through a machine: the snapshot carries the latched VSC (vsc), and an older file restores as 0 ----
{
  const m = Emu.createMachine('coco3');
  m.runFrame();
  const g = m.gime;
  graphics(g, 0x83);
  g.regs[0] &= ~0x80;
  g.regs[12] = 6;
  m.runFrame(); m.runFrame();
  check('(setup) the machine latched VSC 6', g.vsc === 6);
  const snap = m.snapshot();
  check(`the snapshot is version ${Emu.SNAPSHOT_VERSION} and holds the GIME's vsc`, snap.version === Emu.SNAPSHOT_VERSION && snap.state.gime.vsc === 6);
  const old = JSON.parse(Emu.state.toJSON(snap)); old.version = 3; delete old.state.gime.vsc;
  const b = Emu.createMachine('coco3');
  b.restore(Emu.state.fromJSON(JSON.stringify(old)));
  check('a version 3 snapshot (no vsc) restores with vsc 0', b.gime.vsc === 0);
  const cur = JSON.parse(Emu.state.toJSON(snap)); delete cur.state.gime.vsc;
  let err = null;
  try { Emu.createMachine('coco3').restore(Emu.state.fromJSON(JSON.stringify(cur))); } catch (e) { err = e; }
  check(`a version ${Emu.SNAPSHOT_VERSION} snapshot without vsc is refused`, !!err && /missing "vsc"/.test(err.message), err ? err.message : 'restored');
}

console.log(`${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
