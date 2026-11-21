// Run: node tests/coco3-screen-text.test.js
//
// Claude's screen_text on the CoCo 3's GIME text modes. What this proves, and why:
//  * the reader returns the expected rows for every screen of tools/mame-diff/coco3/text-screens.js - 32, 40, 64
//    and 80 columns, with and without attributes, a moved video start, a scrolled start, 9 and 11 lines per row,
//    200 and 225 lines, virtual rows with a horizontal offset, the offset wrapping, and all 128 character codes -
//    on the 6809 and the 6309 CoCo 3. The expected rows are literals in that file; `node tools/mame-diff/run.js
//    coco3 --video --text` shows MAME 0.264 draws those same screens (pixels and glyph placement);
//  * attribute bytes are decoded into runs and never read as characters;
//  * the vertical scroll register does not move GIME text rows (in this model, as in MAME's) and the reader agrees
//    with the picture;
//  * the answer comes from the emulator's own GIME state, not the CPU-readable registers (a read of $FF98-$FF9F
//    tells a program nothing): a target whose every byte reads $FF gets the same answer;
//  * the screen is read from physical RAM: `base` is the CPU address the memory map gives it, or null;
//  * a graphics mode, rows too short for a glyph, and a vertical resolution with no rows are declined;
//  * the VDG reading (MC-10, Dragon, CoCo 1/2, CoCo 3 compatibility mode) is unchanged;
//  * reading changes nothing, also mid-frame (the state at once, and the trace and frames after), and the tool
//    description names the machines and modes.
const Emu = require('./load')();
const T = require('../tools/mame-diff/coco3/text-screens.js');
const { romImage } = require('../tools/mame-diff/lib/firmware.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const read = (m, peek) => Emu.runReadOnlyTool({ machine: m, readByte: peek || ((a) => m.peek(a)) }, 'screen_text', {});
const info = (m) => Emu.runReadOnlyTool({ machine: m, readByte: (a) => m.peek(a), bootStatus: () => ({ state: 'ok' }), screenText: () => [] }, 'machine_info', {});
const frameHash = (m) => { const d = m.render().data; let h = 0; for (let i = 0; i < d.length; i++) h = (Math.imul(h, 31) + d[i]) | 0; return h; };
const stateOf = (m) => JSON.stringify(m.saveState());

const asm = Emu.assemble(T.firmware(), '6809');
if (!asm.ok) throw new Error(JSON.stringify(asm.errors));
const rom = romImage(asm, 0x8000, 0x8000, 0x12);

// ---- 1. every screen, both CPUs: rows, row count, base, attribute runs ----
for (const cpu of ['6809', '6309']) {
  const seen = T.runOurs(Emu, rom, { cpu, onScreen: (i, m) => {
    const s = T.SCREENS[i], want = s.expect;
    const before = stateOf(m);
    const got = read(m);
    check(`${cpu} ${s.name}: the rows`, got.text === true && JSON.stringify(got.lines) === JSON.stringify(want.lines),
      JSON.stringify({ got: got.lines, want: want.lines }));
    check(`${cpu} ${s.name}: columns, rows and attributes named in the mode; rows = rows returned, screenRows = rows shown`,
      got.cols === s.cols && got.mode === `GIME native text, ${s.cols} columns${s.attr ? ' with attributes' : ''}, ${want.rows} rows`
      && got.rows === want.lines.length && got.screenRows === want.rows, JSON.stringify({ mode: got.mode, cols: got.cols, rows: got.rows, screenRows: got.screenRows }));
    check(`${cpu} ${s.name}: base (CPU) and physicalBase`,
      got.physicalBase === s.base && got.base === (want.base !== undefined ? want.base : s.base - 0x70000), JSON.stringify({ base: got.base, physicalBase: got.physicalBase }));
    if (s.attr) {
      check(`${cpu} ${s.name}: one attribute row per text row, each a cover of all ${s.cols} columns`,
        got.attributes.length === got.lines.length && got.attributes.every((runs) => runs[0].from === 0 && runs[runs.length - 1].to === s.cols - 1
          && runs.every((u, k) => k === 0 || u.from === runs[k - 1].to + 1)), JSON.stringify(got.attributes));
      for (const [r, runs] of Object.entries(want.attributes || {})) {
        check(`${cpu} ${s.name}: row ${r} attribute runs`, JSON.stringify(got.attributes[r]) === JSON.stringify(runs), JSON.stringify(got.attributes[r]));
      }
    } else check(`${cpu} ${s.name}: no attributes field without attribute bytes`, got.attributes === undefined);
    check(`${cpu} ${s.name}: reading changes nothing`, stateOf(m) === before);
    // the answer comes from the emulator's GIME, not from what a program could read: every byte reads $FF
    check(`${cpu} ${s.name}: same answer when the CPU's reads all return $FF`, JSON.stringify(read(m, () => 0xFF)) === JSON.stringify(got));
    const mi = info(m);
    check(`${cpu} ${s.name}: machine_info says readable text, same mode`, mi.video.kind === 'text' && mi.video.readable === true && mi.video.mode === got.mode, JSON.stringify(mi.video));
  } });
  check(`${cpu}: every screen of the firmware was shown`, seen === T.SCREENS.length, `${seen}`);
}

// a machine on one screen of the firmware: run it until screen `name` is up, then stop
function onScreen(name, cpu = '6809') {
  let at = null;
  const want = T.SCREENS.findIndex((s) => s.name === name);
  T.runOurs(Emu, rom, { cpu, onScreen: (i, m) => { if (i === want) { at = m; return true; } return false; } });
  return at;
}

// ---- 1b. reading mid-frame changes nothing: the state at once, and the trace and frames after ----
// Stepped into the body of a field, partway through a text row (the GIME's line-in-row counter not 0), the machine is
// copied through a snapshot; one copy is read with screen_text and machine_info, the other is not. The read copy's
// state must be unchanged at once, and both must then run on with the same instruction trace and the same frames.
{
  const m = onScreen('text 80 attr');
  const g = m.gime;
  let guard = 0;
  while (guard++ < 200000 && !(g.zone === 1 && g.lineInRow > 2 && g.physical > g.topBorder + 40)) m.runCycles(m.cycle + 1);
  check('(setup) stopped mid-frame, in the body, partway through a text row', g.zone === 1 && g.lineInRow > 2, JSON.stringify({ zone: g.zone, lineInRow: g.lineInRow, physical: g.physical }));
  const snap = Emu.state.toJSON(m.saveState());
  const other = Emu.createMachine('coco3', { mameCompat: true });
  other.setRoms({ basic: rom });
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

// ---- 2. attribute bytes are not characters ----
{
  const m = onScreen('text 80 attr');
  const g = m.gime, base = g.nativeVideoBase();
  // row 5: attributes that are printable codes ('A', 'Z', '~'), characters spaces: the row reads empty
  [0x41, 0x5A, 0x7E].forEach((a, i) => { g.ram[base + 5 * 160 + i * 2] = 0x20; g.ram[base + 5 * 160 + i * 2 + 1] = a; });
  const got = read(m);
  check('attributes $41 $5A $7E under spaces read as nothing', got.lines[5] === '', JSON.stringify(got.lines[5]));
  check('and are decoded: fg/bg/underline/blink', JSON.stringify(got.attributes[5].slice(0, 3)) === JSON.stringify([
    { from: 0, to: 0, fg: 0, bg: 1, underline: true, blink: false }, { from: 1, to: 1, fg: 3, bg: 2, underline: true, blink: false },
    { from: 2, to: 2, fg: 7, bg: 6, underline: true, blink: false }]), JSON.stringify(got.attributes[5].slice(0, 3)));
  // the same screen with attributes switched off ($FF99 bit 0): the bytes are now all characters, two per pair
  g.regs[9] &= ~1;
  const off = read(m);
  check('attributes off: the same memory reads as characters ($08 is the GIME\'s \u00ea), 80 a row, no attributes field',
    off.attributes === undefined && off.cols === 80 && off.lines[0].slice(0, 6) === 'N\u00eai\u00eat\u00ea', JSON.stringify(off.lines[0].slice(0, 12)));
}

// ---- 3. the vertical scroll ($FF9C) does not move GIME text rows: the picture and the reader agree ----
{
  const m = onScreen('text 80 attr');
  const lines0 = JSON.stringify(read(m).lines);
  m.runFrame(); m.runFrame();
  const h0 = frameHash(m);
  for (const v of [1, 5, 9, 15]) {
    m.gime.regs[12] = v;
    m.runFrame(); m.runFrame();
    check(`$FF9C = ${v}: the picture is the same, and so are the rows read`, frameHash(m) === h0 && JSON.stringify(read(m).lines) === lines0);
  }
}

// ---- 4. not a text screen: graphics, short rows, no rows ----
{
  const m = onScreen('text 80 attr');
  const g = m.gime;
  g.regs[8] |= 0x80;
  let got = read(m);
  check('HRES set (a bitmap): not a text screen', got.text === false && got.rows === 0 && got.lines.length === 0 && /bitmap/.test(got.mode)
    && /no character cells/.test(got.reason), JSON.stringify(got));
  check('machine_info agrees: graphics, not readable', info(m).video.kind === 'graphics' && info(m).video.readable === false);
  g.regs[8] = 0x02;                                   // 2 lines per row
  got = read(m);
  check('2 lines per row: a text mode, declined (no glyph shown whole)', got.text === false && /GIME native text/.test(got.mode) && /2 scanlines per text row/.test(got.reason), JSON.stringify(got));
  check('machine_info: kind text, not readable', info(m).video.kind === 'text' && info(m).video.readable === false);
  g.regs[8] = 0x00;
  check('1 line per row: declined', read(m).text === false && /1 scanline per text row/.test(read(m).reason));
  g.regs[8] = 0x03;
  g.regs[9] = (g.regs[9] & ~0x60) | 0x40; g.updateGeometry();   // LPF 2: no body lines
  got = read(m);
  check('$FF99 lines per field 2 (no body): declined, no rows', got.text === false && /no text rows/.test(got.reason), JSON.stringify(got));
  g.regs[9] = (g.regs[9] & ~0x60); g.updateGeometry();
  check('back to 192 lines: read again', read(m).text === true && read(m).lines[0].startsWith('NitrOS-9 style'));
  g.regs[0] = 0x80; g.ff22 = 0x00;
  check('compatibility mode: the VDG reader, not the GIME one', /GIME legacy: MC6847 text/.test(read(m).mode) && read(m).cols === 32);
}

// ---- 5. the VDG machines read as before: the rows Session.screenText decodes ----
for (const id of ['mc10', 'dragon32', 'dragon64', 'coco', 'coco2b']) {
  const s = new Emu.Session(); s.switchMachine(id);
  for (let i = 0; i < 30; i++) s.advance(1000 / s.shownMachine.fps + 0.01);
  const base = s.shownMachine.profile.textScreen || 0x400;
  'HELLO, VDG 123'.padEnd(32).split('').forEach((c, i) => { s.shownMachine.ram[base + 3 * 32 + i] = c.charCodeAt(0) & 0x3F; });
  const got = Emu.runReadOnlyTool({ machine: s.shownMachine, readByte: (a) => s.readByte(a) }, 'screen_text', {});
  const want = s.screenText().map((l) => l.replace(/\s+$/, ''));
  while (want.length && !want[want.length - 1]) want.pop();
  check(`${id}: screen_text reads the VDG page as Session.screenText does`, got.text === true && got.cols === 32 && got.mode === 'MC6847 text'
    && got.base === base && got.physicalBase === undefined && got.attributes === undefined && JSON.stringify(got.lines) === JSON.stringify(want)
    && got.lines[3] === 'HELLO, VDG 123', JSON.stringify(got));
}

// ---- 6. atPrompt reads the GIME rows in a GIME text mode ----
{
  const m = onScreen('text 80 attr');
  const g = m.gime, base = g.nativeVideoBase();
  const t = { machine: m, readByte: (a) => m.peek(a), bootStatus: () => ({ state: 'ok' }), screenText: () => new Array(16).fill(' '.repeat(32)) };
  check('no OK row on the GIME screen: atPrompt false', Emu.runReadOnlyTool(t, 'machine_info', {}).atPrompt === false);
  g.ram[base + 4 * 160] = 0x4F; g.ram[base + 4 * 160 + 2] = 0x4B;    // 'OK' on row 4
  check('an OK row on the GIME screen: atPrompt true', Emu.runReadOnlyTool(t, 'machine_info', {}).atPrompt === true);
}

// ---- 6b. `base` is the CPU address the memory map gives the screen, or null; the rows do not depend on it ----
{
  const m = onScreen('text 80 attr');
  const rows = JSON.stringify(read(m).lines);
  // MMU on, task 0: slot 0 ($0000) to block 0 and slot 6 ($C000) to block 56, physical $70000 where the screen is
  m.write(0xFF90, 0x40); m.write(0xFFA0, 0x00); m.write(0xFFA6, 56);
  const moved = read(m);
  check('MMU remapped: base is the CPU address that now reaches the screen ($C000), the rows unchanged',
    moved.base === 0xC000 && moved.physicalBase === 0x70000 && JSON.stringify(moved.lines) === rows, JSON.stringify({ base: moved.base, physicalBase: moved.physicalBase }));
  m.write(0xFFA6, 0x06);
  const hidden = read(m);
  check('no slot maps the screen: base is null, and the rows are still read (from physical RAM)',
    hidden.base === null && hidden.physicalBase === 0x70000 && JSON.stringify(hidden.lines) === rows, JSON.stringify({ base: hidden.base }));
}
// a screen that crosses an 8K block: base only while the CPU sees the blocks in order
{
  const m = onScreen('text 80 attr');
  const g = m.gime;
  // start at $73E00: the 3840-byte screen runs from block 57 ($72000-$73FFF) into block 58 ($74000-)
  m.write(0xFF9D, 0xE7); m.write(0xFF9E, 0xC0);
  check('(setup) the screen starts at $73E00 and crosses into the next 8K block', g.nativeVideoBase() === 0x73E00 && 0x73E00 + 24 * 160 > 0x74000);
  m.write(0xFF90, 0x40);                              // MMU on, task 0 as reset leaves it: slot n = block 56 + n
  const inOrder = read(m);
  check('blocks 57 and 58 in slots 1 and 2: base is $3E00, the whole screen contiguous', inOrder.base === 0x3E00, JSON.stringify({ base: inOrder.base }));
  m.write(0xFFA2, 0x00);                              // slot 2 ($4000) now block 0: the start maps, the rest does not
  const split = read(m);
  check('slot 2 remapped: the start still maps at $3E00 but the screen does not continue there, so base is null; rows unchanged',
    split.base === null && JSON.stringify(split.lines) === JSON.stringify(inOrder.lines), JSON.stringify({ base: split.base }));
  m.write(0xFFA4, 57); m.write(0xFFA5, 58);          // blocks 57, 58 in slots 4 and 5 (slot 1 still holds 57, but not followed by 58)
  check('blocks 57 and 58 in slots 4 and 5: base is $9E00, where the run is whole', read(m).base === 0x9E00, JSON.stringify({ base: read(m).base }));
  m.write(0xFF9F, 0x02);                              // a horizontal offset: the last row's cells can reach its 256th byte
  check('with a horizontal offset the run reaches the last row\'s 256th byte: still whole here, base $9E00', read(m).base === 0x9E00);
  m.write(0xFF9F, 0x80);                              // HVEN: 256-byte virtual rows
  check('HVEN (256-byte virtual rows): base is null, the screen is a window on a wider page', read(m).base === null);
}
// a screen that ends exactly at an 8K block's end: whole without a horizontal offset, but with one the last row's
// cells reach on to its 256th byte, into the next slot, which here is not the next block
{
  const m = onScreen('text 80 attr');
  m.write(0xFF9D, 0xEA); m.write(0xFF9E, 0x20);      // $75100: 24 x 160 = 3840 bytes, to $75FFF, the end of block 58
  m.write(0xFF90, 0x40); m.write(0xFFA3, 0x00);      // MMU on; slot 2 is block 58 ($4000), slot 3 ($6000) block 0
  check('ending at the block\'s end, no offset: base $5100', read(m).base === 0x5100, JSON.stringify({ base: read(m).base }));
  m.write(0xFF9F, 0x02);
  check('the same with a horizontal offset: the last row runs on into slot 3 (block 0), so base is null', read(m).base === null, JSON.stringify({ base: read(m).base }));
}

// ---- 7. a snapshot restores the same screen ----
{
  const m = onScreen('text 80 attr start $72348');
  const want = JSON.stringify(read(m));
  const fresh = Emu.createMachine('coco3', { mameCompat: true });
  fresh.setRoms({ basic: rom });
  fresh.loadState(Emu.state.fromJSON(Emu.state.toJSON(m.saveState())));
  check('saved, through JSON, and restored into a fresh machine: the same answer', JSON.stringify(read(fresh)) === want);
}

// ---- 8. the description Claude sees names the machines and modes ----
{
  const d = Emu.readOnlyTools().find((t) => t.name === 'screen_text').description;
  check('description: names the CoCo 3 GIME text modes, 32/40/64/80 columns, with or without attributes, 6809 or 6309',
    /CoCo 3 GIME text mode/.test(d) && /32, 40, 64 or 80 columns/.test(d) && /with or without attribute bytes/.test(d) && /6809 or 6309/.test(d), d);
  check('description: names the VDG machines', /MC-10/.test(d) && /Dragon/.test(d) && /CoCo 1\/2/.test(d) && /CoCo-compatible mode/.test(d), d);
  check('description: says how non-ASCII characters and attributes come back, and that graphics is declined',
    /Unicode/.test(d) && /▒/.test(d) && /never shown as characters/.test(d) && /graphics mode/.test(d) && /[Dd]eclined/.test(d), d);
  check('description: every decline is named - rows too short, no rows, the MMU-moved VDG page, the HD6845S',
    /rows are too short to show a character/.test(d) && /shows no rows/.test(d) && /memory map \(MMU\) has moved/.test(d) && /HD6845S/.test(d), d);
  check('description: fg/bg are palette slots, not colours; rows vs screenRows; base only when contiguous',
    /palette slots, not colours/.test(d) && /palette register 8\+fg/.test(d) && /`rows` counts the rows returned/.test(d) && /`screenRows`/.test(d)
    && /contiguous/.test(d), d);
  check('description: no longer says GIME text is declined', !/GIME native text\) is declined/.test(d) && !/wider GIME text mode/.test(d));
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
