// The CoCo 3 GIME text screens against MAME: node tools/mame-diff/run.js coco3 --video --text [--cpu 6309]
// (or node tools/mame-diff/coco3/run-text.js [6809|6309]).
// text-screens.js puts up each GIME text screen the screen-text reader must read (32, 40, 64 and 80 columns, with
// and without attributes, moved video starts, 9 and 11 lines per row, 200 and 225 lines, virtual rows and the
// horizontal offset). For each one this proves three things:
//  1. the picture: MAME's and ours, every pixel, as run-vdg.js compares them. Our hi-res font is our own design,
//     so a character cell may differ in glyph shape only (the cell shows just its foreground and background
//     colour in both pictures); every other pixel - attributes, colours, underlines, borders, where each row and
//     column falls - must be identical;
//  2. MAME's own picture shows the expected text where text-screens.js says it is, character by character: in
//     every cell whose expected character is a space (and not underlined) MAME draws only background; cells that
//     should hold the same character (same underline, same visible height) show the same MAME glyph; and cells
//     that should hold different characters show different MAME glyphs (in rows shown whole). That ties the literal expected rows to
//     MAME's screen without relying on our font;
//  2b. our picture shows the expected text exactly: every cell is our font's glyph for the expected character,
//     underlined where the expected attributes say, on the row the GIME documents for the lines per row;
//  3. our reader (screen_text) returns exactly the expected rows, attributes and base from our machine in that
//     state.
// Env: VDG_WORK (default: a fresh folder, removed at exit), SKIP_MAME=1 to reuse captures.
const fs = require('fs'), path = require('path');
const { loadEmu, romImage } = require('../lib/firmware');
const { runMame } = require('../lib/mame');
const { workDir, keepWorkDir } = require('../lib/workdir');
const T = require('./text-screens');

const Emu = loadEmu();
const CPU = process.argv.includes('6309') ? '6309' : '6809';
const SYSTEM = CPU === '6309' ? 'coco3h' : 'coco3';
const WORK = process.env.VDG_WORK || workDir(`coco3-text-${CPU}`);
if (process.env.SKIP_MAME && !process.env.VDG_WORK) { console.error('SKIP_MAME=1 reuses captures in VDG_WORK: set VDG_WORK too'); process.exitCode = 2; return; }
fs.mkdirSync(path.join(WORK, `roms/${SYSTEM}`), { recursive: true });
fs.mkdirSync(path.join(WORK, 'out'), { recursive: true });

const src = T.firmware();
fs.writeFileSync(path.join(__dirname, 'vdg-text.asm'), src);
const asm = Emu.assemble(src, '6809');
if (!asm.ok) { console.error(`assembling the text firmware failed: ${JSON.stringify(asm.errors)}`); process.exitCode = 1; return; }
const rom = romImage(asm, 0x8000, 0x8000, 0x12);
fs.writeFileSync(path.join(WORK, `roms/${SYSTEM}/coco3.rom`), rom);
const N = T.SCREENS.length;

if (!process.env.SKIP_MAME) {
  for (const f of fs.readdirSync(path.join(WORK, 'out'))) fs.unlinkSync(path.join(WORK, 'out', f));
  fs.rmSync(path.join(WORK, 'cfg'), { recursive: true, force: true });
  // the same capture rule as run-vdg.js: two consecutive fields, 15 and 16 after the phase changes
  runMame({ work: WORK, system: SYSTEM, lua: `local function setup()
  manager.machine.ioport.ports[":screen_config"].fields["Monitor Type"]:set_value(1)   -- RGB monitor
  manager.machine.ioport.ports[":gime:artifacting"].fields["Artifacting"].user_value = 0
end
setup()
local space = manager.machine.devices[":maincpu"].spaces["program"]
local scr = nil
for tag, s in pairs(manager.machine.screens) do scr = s end
local last, wait = -1, -1
emu.register_frame_done(function()
  setup()
  local ph = space:read_u8(${T.PHASE})
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

// ---- ours: the picture and the reader's answer at the same moment ----
const ours = [], read = [];
const seen = T.runOurs(Emu, rom, { cpu: CPU, onScreen: (i, m) => {
  ours[i] = Emu.frameToRGBA(m.render());
  read[i] = Emu.runReadOnlyTool({ machine: m, readByte: (a) => m.peek(a) }, 'screen_text', {});
} });

const W = 640, H = 240;
const xrgb = (c) => ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF);
let failed = 0;
for (let i = 0; i < N; i++) {
  const s = T.SCREENS[i];
  const files = ['a', 'b'].map((x) => path.join(WORK, 'out', `phase${String(i + 1).padStart(2, '0')}${x}.raw`));
  if (!files.every((f) => fs.existsSync(f)) || !ours[i]) { console.log(`MISSING ${s.name}`); failed++; continue; }
  const load = (f) => { const b = fs.readFileSync(f), nl = b.indexOf(10), [w, h] = b.slice(0, nl).toString().split(' ').map(Number);
    return { w, h, p: new Uint32Array(b.buffer.slice(b.byteOffset + nl + 1, b.byteOffset + b.length)) }; };
  const O = (x, y) => xrgb(ours[i][y * W + x]);
  // MAME's last row is not compared (run-vdg.js: not refreshed on every mode change); of the two fields captured,
  // the one closer to ours
  const diff = (mm) => { let n = 0; for (let y = 0; y < Math.min(H, mm.h - 1); y++) for (let x = 0; x < Math.min(W, mm.w); x++) if ((mm.p[y * mm.w + x] & 0xFFFFFF) !== O(x, y)) n++; return n; };
  const caps = files.map(load);
  const mm = diff(caps[0]) <= diff(caps[1]) ? caps[0] : caps[1];
  const M = (x, y) => (x < mm.w && y < mm.h - 1 ? mm.p[y * mm.w + x] & 0xFFFFFF : O(x, y));

  // the character grid, from the GIME's documented geometry: wide modes (40/80) fill 640 pixels, the others 512
  // inside 64-pixel borders; the body starts below the top border (25, 23 or 8 lines for 192, 200 or 225) and each
  // row is the $FF98 lines-per-row tall
  const wide = !!(s.f99 & 0x04), x0 = wide ? 0 : 64, cw = (wide ? 640 : 512) / s.cols;
  const lpf = (s.f99 >> 5) & 3, top = [25, 23, 0, 8][lpf] - 1, body = [192, 200, 0, 225][lpf];
  const lpr = [1, 1, 2, 8, 9, 10, 11, 0x10000][s.f98 & 7];
  const cellH = (r) => Math.min(lpr, body - r * lpr);

  // 1. every pixel; character cells may differ in glyph shape only
  let px = 0, glyphCells = 0, other = 0;
  const cellOf = (x, y) => (y >= top && y < top + body && x >= x0 && x < x0 + s.cols * cw ? [Math.floor((y - top) / lpr), Math.floor((x - x0) / cw)] : null);
  const cellBad = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (M(x, y) === O(x, y)) continue;
    px++;
    const c = cellOf(x, y);
    if (!c) { other++; continue; }
    cellBad.set(c.join(), c);
  }
  for (const [, [r, c]] of cellBad) {
    const cols = new Set();
    for (let y = top + r * lpr; y < top + r * lpr + cellH(r); y++) for (let x = x0 + c * cw; x < x0 + (c + 1) * cw; x++) { cols.add(M(x, y)); cols.add(O(x, y)); }
    if (cols.size <= 2) glyphCells++; else other++;
  }

  // 2. MAME's glyphs against the expected text. A cell's background is our picture's colour at its top-left
  // pixel: our font never sets the leftmost pixel and the underline is never on a row's first line, and (1) has
  // shown the two pictures use the same two colours in every cell.
  const underlined = (r, c) => {
    const runs = s.expect.attributes && s.expect.attributes[r];
    const run = runs && runs.find((u) => c >= u.from && c <= u.to);
    if (run) return run.underline;
    return s.attr && s.clear.fill.length === 2 && !!(s.clear.fill[1] & 0x40);
  };
  const groups = new Map();
  let blankBad = 0, cells = 0;
  const rows = Math.ceil(body / lpr);
  for (let r = 0; r < rows; r++) {
    const line = (s.expect.lines[r] || '').padEnd(s.cols);
    for (let c = 0; c < s.cols; c++) {
      const bx = x0 + c * cw, by = top + r * lpr, bg = O(bx, by);
      let pat = '';
      for (let y = by; y < by + cellH(r); y++) for (let x = bx; x < bx + cw; x++) pat += M(x, y) === bg ? '.' : '#';
      const ch = line[c], ul = underlined(r, c);
      cells++;
      if (ch === ' ' && !ul) { if (pat.includes('#')) blankBad++; continue; }
      const key = `${ch}|${ul}|${cellH(r)}`;
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(pat);
    }
  }
  // 2b. our picture against the same expected text, exactly: every cell is our font's glyph for the expected
  // character ($20 for a space), the underline (attribute bit 6) on the row the GIME documents for the lines per
  // row (8: row 7, 9 and 10: row 8, 11: row 9). With (1) and (2) this closes the font allowance: our glyphs are where
  // the text is, and MAME's are too.
  const ul = lpr === 8 ? 7 : lpr === 9 || lpr === 10 ? 8 : lpr === 11 ? 9 : -1, scale = cw / 8;
  let oursBad = 0;
  for (let r = 0; r < rows; r++) {
    const line = (s.expect.lines[r] || '').padEnd(s.cols);
    for (let c = 0; c < s.cols; c++) {
      const code = Emu.GIME.TEXT_CHARS.indexOf(line[c]), under = underlined(r, c);
      const bx = x0 + c * cw, by = top + r * lpr, bg = O(bx, by);
      let same = code >= 0;
      for (let y = 0; same && y < cellH(r); y++) {
        const bits = under && y === ul ? 0xFF : y < 12 ? Emu.GIME.HIRES_FONT[code * 12 + y] : 0;
        for (let x = 0; x < cw; x++) if ((O(bx + x, by + y) !== bg) !== !!(bits & (0x80 >> Math.floor(x / scale)))) { same = false; break; }
      }
      if (!same) oursBad++;
    }
  }
  const inconsistent = [...groups].filter(([, p]) => p.size !== 1).map(([k]) => k);
  const byPattern = new Map();
  // (distinct characters are only required to look distinct in whole rows: the top few lines of a row cut short
  // can be the same for different letters, as the tops of H, U and W are)
  for (const [k, p] of groups) if (p.size === 1 && Number(k.split('|')[2]) === lpr) { const pat = [...p][0], h = k.split('|')[2]; const id = `${h}:${pat}`; byPattern.set(id, [...(byPattern.get(id) || []), k]); }
  const clashes = [...byPattern.values()].filter((ks) => ks.length > 1);

  // 3. our reader
  const got = read[i];
  const want = s.expect;
  const readerOk = got && got.text === true && got.cols === s.cols && JSON.stringify(got.lines) === JSON.stringify(want.lines)
    && new RegExp(`, ${want.rows} rows$`).test(got.mode) && got.screenRows === want.rows && got.physicalBase === s.base
    && got.base === (want.base !== undefined ? want.base : s.base - 0x70000)
    && Object.entries(want.attributes || {}).every(([r, runs]) => JSON.stringify(got.attributes[r]) === JSON.stringify(runs))
    && (s.attr ? Array.isArray(got.attributes) && got.attributes.length === got.lines.length : got.attributes === undefined);

  const ok = !other && !blankBad && !inconsistent.length && !clashes.length && !oursBad && readerOk;
  if (!ok) { failed++; keepWorkDir(WORK, 'captures'); }
  console.log(`${ok ? 'SAME' : 'DIFF'}  ${s.name.padEnd(34)} ${px} of ${W * H} pixels differ, all in ${glyphCells} cells of glyph shape only` +
    `${other ? ` - ${other} OTHER DIFFERENCES` : ''}; MAME glyphs: ${cells} cells, ${groups.size} distinct characters` +
    `${blankBad ? `, ${blankBad} BLANK CELLS NOT BLANK` : ''}${inconsistent.length ? `, INCONSISTENT ${inconsistent.join(' ')}` : ''}` +
    `${clashes.length ? `, CLASH ${JSON.stringify(clashes)}` : ''}; ours: ${oursBad ? `${oursBad} CELLS NOT THE EXPECTED GLYPH` : 'every cell the expected glyph'}; reader ${readerOk ? 'exact' : 'WRONG ' + JSON.stringify(got)}`);
}
console.log(`${N - failed} of ${N} GIME text screens identical apart from our font design, MAME's glyphs and ours as expected, and read exactly (${CPU}, ${seen} screens run)`);
process.exitCode = failed || seen !== N ? 1 : 0;
