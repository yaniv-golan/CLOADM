// Run: node tests/d64plus-screen-text.test.js
//
// Claude's screen_text on the Dragon 64 Plus's 80-column screen (its HD6845S CRTC). What this proves, and why:
//  * the reader returns the expected rows for every screen of tools/mame-diff/d64plus/text-screens.js - 80 columns,
//    40 columns from $0100, scrolled three rows, wrapping round the 2K video RAM, a 14-bit start that mirrors, and
//    64 columns of 20 rows of 13 lines. The expected rows are literals in that file, written from the screens' own
//    writes; `node tools/mame-diff/run.js d64plus --plustext` keeps the firmware in lockstep with MAME 0.264 and
//    `--plustext --video` shows MAME draws those same screens, cell for cell;
//  * the reader and the picture agree: with a character generator that draws each code as its own byte, the picture
//    decodes to the rows read - also after a register is written mid-frame, once the next frame is drawn;
//  * it works from the video RAM's codes: no character generator is needed (the answer then says the picture is blank);
//  * the VDG screen is still read by the VDG reader when the Display tab shows it;
//  * `base` is the CPU address only while $FFE2 maps the video RAM over $0000-$07FF and the screen does not wrap;
//  * every decline: an interlace mode, no rows or columns, R1/R6 not less than the totals, wider than 80 columns,
//    taller than 264 lines, rows shorter than 10 lines, display skew non-output, a code outside $20-$7E;
//    machine_info agrees;
//  * reading changes nothing, also mid-frame (the state at once, and the trace and frames after);
//  * a snapshot restores the same screen and the same answer.
const Emu = require('./load')();
const spec = require('../tools/mame-diff/d64plus/spec.js');
const T = require('../tools/mame-diff/d64plus/text-screens.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const read = (m) => Emu.runReadOnlyTool({ machine: m, readByte: (a) => m.peek(a) }, 'screen_text', {});
const info = (m) => Emu.runReadOnlyTool({ machine: m, readByte: (a) => m.peek(a), bootStatus: () => ({ state: 'ok' }), screenText: () => [] }, 'machine_info', {});
const stateOf = (m) => JSON.stringify(m.saveState());
const J = JSON.stringify;

// the firmware on our machine: the hardware model (the banks reach memory), so its writes fill the video RAM
const machine = (config = {}) => spec.plusText('d64plus', { regenerate: false, config: Object.assign({ mameCompat: false }, config) }).machine();
// a machine left on screen `i` of the firmware (T.SCREENS.length: the VDG phase)
function onScreen(i, config) {
  const m = machine(config);
  let at = null;
  T.runOurs(m, { onScreen: (k, mm) => { if (k === i) { at = mm; return true; } return false; } });
  if (!at) throw new Error(`screen ${i} never came up`);
  at.view = 'plus';
  return at;
}

// A character generator of our own (never a real one) that draws every code as its own byte on every raster line,
// so the picture can be decoded back to codes: the cell's first raster line is the code.
const CODEGEN = new Uint8Array(0x2000);
for (let a = 0; a < CODEGEN.length; a++) CODEGEN[a] = (a >> 4) & 0xFF;
function pictureRows(m) {
  const f = m.plusFrame, t = m.textScreen(), out = [];
  for (let row = 0; row < t.rows; row++) {
    let line = '';
    for (let col = 0; col < t.cols; col++) {
      let code = 0;
      for (let bit = 0; bit < 8; bit++) code |= f.data[row * t.perRow * f.width + col * 8 + bit] ? 0x80 >> bit : 0;
      line += Emu.PLUS_CHARS[code] == null ? '\u0000' : Emu.PLUS_CHARS[code];
    }
    out.push(line);
  }
  let last = out.length - 1;
  while (last >= 0 && !out[last].trim()) last--;
  return out.slice(0, last + 1).map((l) => l.replace(/\s+$/, ''));
}

// ---- 1. every screen: the rows, the counts, the mode, the start; reading changes nothing ----
{
  const m = machine();
  const seen = T.runOurs(m, { onScreen: (i, mm) => {
    if (i === T.SCREENS.length) return false;
    const s = T.SCREENS[i], want = s.expect;
    mm.view = 'plus';
    const before = stateOf(mm);
    const got = read(mm);
    check(`${s.name}: the rows`, got.text === true && J(got.lines) === J(want.lines), J({ got: got.lines, want: want.lines }));
    check(`${s.name}: cols ${s.r1}, ${want.rows} rows shown, rows = rows returned, mode named`,
      got.cols === s.r1 && got.screenRows === want.rows && got.rows === want.lines.length
      && got.mode === `HD6845S text (the Dragon Plus), ${s.r1} columns, ${want.rows} rows`, J({ cols: got.cols, screenRows: got.screenRows, rows: got.rows, mode: got.mode }));
    check(`${s.name}: startAddress is R12/R13 ($${s.start.toString(16)}), base null (the video RAM is not mapped), no note (a generator is loaded)`,
      got.startAddress === s.start && got.base === null && got.note === undefined, J({ startAddress: got.startAddress, base: got.base, note: got.note }));
    check(`${s.name}: reading changes nothing`, stateOf(mm) === before);
    const mi = info(mm);
    check(`${s.name}: machine_info says readable text, same mode`, mi.video.kind === 'text' && mi.video.readable === true && mi.video.mode === got.mode, J(mi.video));
    // the picture, drawn with a generator that shows each code as its byte, decodes to the same rows
    const gen = mm.charGen;
    mm.setRoms({ chargen: CODEGEN }); mm.drawPlus();
    check(`${s.name}: the picture shows the rows read`, J(pictureRows(mm)) === J(got.lines), J(pictureRows(mm)));
    mm.setRoms({ chargen: gen }); mm.drawPlus();
    return false;
  } });
  check('every screen of the firmware and the VDG phase were shown', seen === T.SCREENS.length + 1, String(seen));
}

// ---- 2. the VDG screen: the Display tab picks which screen is read ----
{
  const m = onScreen(T.SCREENS.length);
  m.view = 'vdg';
  const vdg = read(m);
  check('VDG view: the VDG reader reads the MC6847 page', vdg.text === true && vdg.mode === 'MC6847 text' && vdg.cols === 32 && J(vdg.lines) === J(T.VDG_EXPECT), J(vdg));
  m.view = 'plus';
  const last = T.SCREENS[T.SCREENS.length - 1];
  const plus = read(m);
  check('Plus view on the same machine: the 80-column board\'s screen (the last one set), not the VDG page',
    plus.cols === last.r1 && J(plus.lines) === J(last.expect.lines), J(plus.lines));
}

// ---- 2b. atPrompt searches the screen shown: OK on the 80-column screen counts, OK only on the VDG page behind it does not ----
{
  const m = onScreen(0);
  const okTarget = (vdgLines) => ({ machine: m, readByte: (a) => m.peek(a), bootStatus: () => ({ state: 'ok' }), screenText: () => vdgLines });
  const atPrompt = (vdgLines) => Emu.runReadOnlyTool(okTarget(vdgLines), 'machine_info', {}).atPrompt;
  check('Plus view, OK only on the hidden VDG page: atPrompt false', atPrompt(['OK']) === false);
  m.videoRam.set([0x4F, 0x4B], 2 * 80);
  check('Plus view, OK on a row of the 80-column screen: atPrompt true', atPrompt([]) === true);
  m.view = 'vdg';
  check('VDG view: the VDG page decides again', atPrompt([]) === false && atPrompt(['OK']) === true);
}

// ---- 3. no character generator: the codes are still read, and the answer says the picture is blank ----
{
  const m = onScreen(0);
  m.setRoms({ chargen: null });
  const got = read(m);
  check('no character generator: the same rows, from the video RAM', got.text === true && J(got.lines) === J(T.SCREENS[0].expect.lines), J(got.lines));
  check('no character generator: a note says the picture is blank', /no character generator/.test(got.note || ''), J(got.note));
}

// ---- 4. base: the CPU address while $FFE2 maps the video RAM, and only when the screen is one run ----
{
  const m = onScreen(1);           // 40 x 22 from $0100: $0100-$046F
  m.write(0xFFE2, 0x01);
  let got = read(m);
  check('bank C mapped: base is the start in the CPU\'s $0000-$07FF', got.base === 0x100, J(got.base));
  check('and peek at base reads the first row', String.fromCharCode(...Array.from({ length: 24 }, (_, k) => m.peek(got.base + k))) === T.SCREENS[1].expect.lines[0]);
  m.write(0xFFE2, 0x00);
  check('bank C unmapped again: base null', read(m).base === null);
  const w = onScreen(3);           // wrapping at 2K
  w.write(0xFFE2, 0x01);
  check('a screen that wraps round the 2K is not one CPU run: base null', read(w).base === null && read(w).text === true);
  const c = onScreen(1, { mameCompat: true });
  c.write(0xFFE2, 0x01);
  c.videoRam.fill(0x20);           // under mameCompat the firmware's writes never reach it: fill it as a program would on hardware
  check('under mameCompat the bank never reaches memory (MAME 0.264): read, base null', read(c).text === true && read(c).base === null, J(read(c)));
}

// ---- 5. declines: never a guess ----
{
  const decline = (label, poke, reasonRe) => {
    const m = onScreen(0);
    poke(m);
    const before = stateOf(m);
    const got = read(m), mi = info(m);
    check(`decline, ${label}`, got.text === false && got.rows === 0 && got.lines.length === 0 && /HD6845S/.test(got.mode) && reasonRe.test(got.reason || ''), J(got));
    check(`decline, ${label}: machine_info says text, not readable, atPrompt null`,
      mi.video.kind === 'text' && mi.video.readable === false && mi.atPrompt === null, J({ video: mi.video, atPrompt: mi.atPrompt }));
    check(`decline, ${label}: reading changes nothing`, stateOf(m) === before);
  };
  const reg = (r, v) => (m) => { m.write(0xFFE0, r); m.write(0xFFE1, v); };
  decline('R8 interlace sync', reg(8, 0x01), /interlace/);
  decline('R8 $A3 (interlace sync, Compusense\'s upper bits)', reg(8, 0xA3), /interlace/);
  decline('R8 $30 (display skew non-output)', reg(8, 0x30), /non-output/);
  decline('R8 $F2 (display skew non-output, cursor skew non-output, non-interlace)', reg(8, 0xF2), /non-output/);
  decline('R8 interlace sync and video', reg(8, 0x03), /interlace/);
  decline('R1 = 0', reg(1, 0), /no characters/);
  decline('R6 = 0', reg(6, 0), /no characters/);
  decline('R1 not less than R0 + 1', (m) => { reg(0, 79)(m); }, /R0 \+ 1/);
  decline('R6 not less than R4 + 1', reg(4, 21), /R4 \+ 1/);
  decline('R1 over 80 columns', reg(1, 90), /wider than the board's picture/);
  decline('rows taller than 264 lines', reg(6, 23), /taller than the board's 264-line picture/);
  decline('rows just taller than 264 lines (25 rows of 11 = 275)', (m) => { reg(9, 10)(m); reg(6, 25)(m); }, /taller than the board's 264-line picture/);
  decline('rows of 9 lines (R9 = 8)', reg(9, 8), /shorter than the board's 10-line character/);
  for (const code of [0x00, 0x1F, 0x7F, 0x80, 0xFF]) {
    decline(`code $${code.toString(16)} on screen`, (m) => { m.videoRam[3 * 80 + 5] = code; },
      new RegExp(`row 3, column 5 holds code \\$${code.toString(16).toUpperCase().padStart(2, '0')}: only codes \\$20-\\$7E are read`));
  }
  // a code with no character outside the displayed area does not matter
  const m = onScreen(1);
  m.videoRam[0x10] = 0x80; m.videoRam[0x7FF] = 0x00;
  check('a code with no character outside the screen (before the start, after the last row) is not on it', read(m).text === true);
  // the shortest row the board's character fits: R9 = 9, 10 lines (a 7 x 9 matrix below a blank row)
  const r = onScreen(0);
  reg(9, 9)(r);
  check('R9 = 9 (10 lines, the board\'s character exactly): read', read(r).text === true && read(r).screenRows === 22);
  // skew of 1 or 2 characters moves the picture, it does not blank it: read (bits 5-4 = 01, 10; cursor skew 7-6 too)
  for (const v of [0x10, 0x20, 0x50, 0xA0]) {
    const k = onScreen(0);
    reg(8, v)(k);
    check(`R8 = $${v.toString(16)} (a skew of 1 or 2 characters): read`, read(k).text === true && J(read(k).lines) === J(T.SCREENS[0].expect.lines));
  }
  // Compusense's own register table, its technical notes p. 4 (ITAB): 80 x 24 rows of 11 lines (264), R8 = $A2
  // (bits 1-0 = 10: non-interlace), the cursor at 0
  const c = onScreen(0);
  [112, 80, 93, 55, 25, 30, 24, 25, 0xA2, 10, 96, 10, 0, 0, 0, 0].forEach((v, k) => reg(k, v)(c));
  for (let k = 0; k < 2; k++) c.runFrame();
  const cg = read(c);
  check('Compusense\'s ITAB (p. 4): read, 80 columns, 24 rows, R8 = $A2 not taken for interlace',
    cg.text === true && cg.mode === 'HD6845S text (the Dragon Plus), 80 columns, 24 rows' && cg.screenRows === 24
    && J(cg.lines) === J(T.SCREENS[0].expect.lines), J(cg));
}

// ---- 6. mid-frame: a register written mid-frame is read at once; the picture shows it from the next frame ----
{
  const m = onScreen(0);
  m.setRoms({ chargen: CODEGEN });
  let guard = 0;
  while (guard++ < 400000 && !(m.crtc.rowCounter > 5 && m.crtc.rowCounter < 15)) m.runCycles(m.cycle + 1);
  check('(setup) stopped mid-frame, inside the displayed rows', m.crtc.rowCounter > 5 && m.crtc.rowCounter < 15, String(m.crtc.rowCounter));
  // start three rows down: the second row (lower case) goes up two rows... the first row read is row 3's
  m.write(0xFFE0, 13); m.write(0xFFE1, 80);
  const got = read(m);
  check('mid-frame: the reader answers for the start just written (what the next frame draws)', J(got.lines) === J(T.SCREENS[0].expect.lines.slice(1)), J(got.lines));
  check('mid-frame: the picture still shows the frame drawn before the write', J(pictureRows(m)) === J(T.SCREENS[0].expect.lines), J(pictureRows(m)));
  const starts = m.crtc.frameStarts;
  while (m.crtc.frameStarts === starts) m.runCycles(m.cycle + 1);
  check('after the next frame restart the picture shows exactly the rows read', J(pictureRows(m)) === J(got.lines), J(pictureRows(m)));
}
{
  // reading mid-frame changes nothing: the state at once, and the trace and frames after (a copy that did not read)
  const m = onScreen(3);
  let guard = 0;
  while (guard++ < 400000 && !(m.crtc.rowCounter > 5 && m.crtc.raster > 3)) m.runCycles(m.cycle + 1);
  check('(setup) mid-row, mid-frame', m.crtc.rowCounter > 5 && m.crtc.raster > 3);
  const snap = Emu.state.toJSON(m.saveState());
  const other = machine();
  other.loadState(Emu.state.fromJSON(snap));
  const before = stateOf(m);
  read(m); info(m);
  check('mid-frame: reading leaves the saved state byte for byte as it was', stateOf(m) === before);
  const fnv = (h, v) => Math.imul(h ^ (v & 0xFFFFFFFF), 0x01000193) >>> 0;
  const runOn = (x) => {
    let h = 0x811C9DC5;
    x.cpu.trace = (c) => { for (const k of ['pc', 'a', 'b', 'x', 'y', 'u', 's', 'cc', 'dp', 'totalCycles']) h = fnv(h, c[k] | 0); };
    for (let f = 0; f < 3; f++) { x.runFrame(); const d = x.render().data; for (let i = 0; i < d.length; i++) h = fnv(h, d[i]); }
    x.cpu.trace = null;
    return h;
  };
  const hRead = runOn(m), hNot = runOn(other);
  check('mid-frame: after the read, the trace and the next 3 frames are the same as a run that did not read', hRead === hNot, `${hRead} vs ${hNot}`);
}

// ---- 7. a snapshot restores the same screen, and the run goes on to the same screens ----
{
  const m = onScreen(3);
  const fresh = machine();
  fresh.loadState(Emu.state.fromJSON(Emu.state.toJSON(m.saveState())));
  check('snapshot: the view and the rows come back', fresh.view === 'plus' && J(read(fresh)) === J(read(m)), J(read(fresh).lines));
  const after = (x) => { const out = []; T.runOurs(x, { onScreen: (i, mm) => { mm.view = 'plus'; out.push(J(read(mm))); } }); return out; };
  const a = after(m), b = after(fresh);
  check('snapshot: the screens after it read the same as in the uninterrupted run', a.length >= 2 && J(a) === J(b), `${a.length} ${b.length}`);
  // (the first callback comes a few frames into the restored run, by when the firmware may be clearing for the next
  // screen; the screens after it are whole)
  check('snapshot: and the next screen is the firmware\'s next one', J(JSON.parse(a[1]).lines) === J(T.SCREENS[4].expect.lines), a[1]);
}

// ---- 8. the description names the board and its declines ----
{
  const d = Emu.SCREEN_TEXT_DESCRIPTION;
  check('description: the 80-column board, its registers, ASCII, and each decline', /Dragon 64 Plus's 80-column screen/.test(d) && /R12\/R13/.test(d)   // the CRTC start address registers
    && /\$20-\$7E are read as ASCII \(P\. Mooney's IC22 EPROM dump/.test(d) && /interlace/.test(d) && /non-output/.test(d) && /fewer than 10 raster lines/.test(d) && /code outside \$20-\$7E/.test(d), d);
}

console.log(`\n${n - fail}/${n} passed`);
if (fail) process.exitCode = 1;
