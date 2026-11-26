// Run: node tests/moved-text-page.test.js
//
// A text page moved by the SAM's display offset (F6-F0) on the Dragon and CoCo 1/2, read by every screen-text reader:
// Claude's screen_text (the chat and the MCP server), Session.screenText (the embed API, the Ask panel, the tape panel,
// the boot watchdog), the screen's text alternative (Session.screenAlternative: the page's reading mode and screen
// readers), the welcome menu's taps (textCell, js/ui/screen.js) and the ROM self-test's screen (js/selftest.js).
//
// The firmware is our own (tools/mame-diff/sam/movedtext.js, assembled from movedtext.asm): known text on the pages at
// $0400, $0E00 and $1C00, shown in turn (phases 1-3), then PIA1 PB4 high over $1C00 (phase 4: INT/EXT high,
// semigraphics-6 and the external-character input on the Dragon and the CoCo 1; on the CoCo 2B's MC6847T1 PB4 is GM0,
// its lowercase enable, still text) and RG6 graphics over it (phase 5). On the Dragon 200-E PB4 is the character generator's bank input, not
// INT/EXT (which comes from each byte's bit 7), so its phase 4 is still text. The pictures of phases 1-4 are MAME's
// (`node tools/mame-diff/run.js <profile> --video --movedtext`, sam/run-movedtext.js); here, on the same firmware:
//  1. each reader returns exactly the text the firmware wrote on the page the SAM shows, derived from the firmware's
//     text through a VDG character table written out by hand (never by running a reader);
//  2. the picture is the page's: the same bytes shown from $0400 at F = 2 draw the same frame, and it differs from the
//     default page's frame;
//  3. in a mode that is not alphanumeric / semigraphics-4 (INT/EXT high on a plain MC6847, a graphics mode) the readers
//     decline, as for a graphics mode today, and Session.screenText falls back to the page the SAM selects;
//  4. the MCP server's screen_text reads a page a program has moved, and declines INT/EXT high.
//
// Reading is not emulation: no regression hash changes (node tests/regress.test.js).
//
// Mutants (each a one-line edit; each turns this file red):
//  js/claude/readtools.js
//   1. the base ignored: vdgPage's `const at = m.sam.displayBase` -> `const at = m.profile.textScreen || 0x400`
//   2. the mode ignored: videoMode's `if (m.sam && (mode & 0x10) && !vdg.t1 && !vdg.extIntFromData)` -> `if (false)`
//   3. the T1 not exempted: drop `&& !vdg.t1` (the CoCo 2B's phase 4 is declined)
//   3b. the 200-E not exempted: drop `&& !vdg.extIntFromData` (the Dragon 200-E's phase 4 is declined)
//   4. textCell without the mode check: drop `!screenReadable(mode).readable ||`
//  js/selftest.js
//   5. the self-test at the profile's page: `page.byte(r * 32 + c)` -> `this.m.ram[0x400 + r * 32 + c]`
const fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const Emu = require('./load')();
const MT = require('../tools/mame-diff/sam/movedtext.js');
const spec = require('../tools/mame-diff/sam/spec.js');

let fail = 0, n = 0;
process.exitCode = 1;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const J = JSON.stringify;

// The VDG's 64 characters by code & $3F, written out from the MC6847 data sheet's character set: $00-$1F @ A-Z [ \ ]
// and the up and left arrows (read as ^ and _, their ASCII codes, as BASIC's own text does), $20-$3F space to ? - a
// table of literals, not the reader's arithmetic.
const VDG = '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_ !"#$%&\'()*+,-./0123456789:;<=>?';
const vdgChar = (v) => (v & 0x80 ? ' ' : VDG[v & 0x3F]);

// a page's 16 rows as the firmware wrote them (MT.PAGES), every row 32 wide: text, codes, blocks as spaces
function wantRows(page, block = ' ') {
  const cells = new Array(512).fill(' ');
  for (const [row, col, text] of page.rows) Array.from(text).forEach((ch, i) => { cells[row * 32 + col + i] = ch; });
  for (const [row, col, list] of page.codes || []) list.forEach((v, i) => { cells[row * 32 + col + i] = vdgChar(v); });
  for (const [row, col, list] of page.blocks || []) list.forEach((v, i) => { cells[row * 32 + col + i] = block; });
  cells[MT.TOGGLE] = block;
  return Array.from({ length: 16 }, (_, r) => cells.slice(r * 32, r * 32 + 32).join(''));
}
const trim = (rows) => { const r = rows.map((l) => l.replace(/\s+$/, '')); while (r.length && !r[r.length - 1]) r.pop(); return r; };
const blocksOf = (page) => 1 + (page.blocks || []).reduce((s, [, , l]) => s + l.length, 0);

const tool = (m) => Emu.runReadOnlyTool({ machine: m, readByte: (a) => m.peek(a) }, 'screen_text', {});
const store = { get() { return null; }, set() {}, remove() {} };
const session = new Emu.Session({ store, welcomeMenu: false });
const sessionText = (m) => session.screenText(m);
const altText = (m) => session.screenAlternative(m);
const selfTestLines = (m) => Emu.SelfTest.prototype.screenLines.call({ m });
const frameOf = (m) => Buffer.from(m.render().data).toString('base64');

// the machine running the firmware until `phase` has been on screen for 3 fields
function at(id, phase) {
  const t = spec.movedtext(id), m = t.machine();
  let f = 0;
  while (m.ram[MT.PHASE] !== phase && f++ < 400) m.runFrame();
  if (m.ram[MT.PHASE] !== phase) throw new Error(`${id}: phase ${phase} never came`);
  for (let i = 0; i < 3; i++) m.runFrame();
  return { m, t };
}

// the committed firmware is the generator's
check('movedtext.asm is what movedtext.js --write writes', fs.readFileSync(MT.ASM, 'utf8') === MT.source());

for (const id of ['dragon64', 'coco2b', 'coco', 'dragon200e']) {
  // ---- phases 1-3: the default page and the moved pages ----
  let defaultFrame = null;
  MT.PAGES.forEach((page, k) => {
    const phase = k + 1, { m } = at(id, phase), where = `${id} phase ${phase} (${page.name} at $${page.at.toString(16).toUpperCase().padStart(4, '0')})`;
    const want = wantRows(page);
    check(`${where}: (setup) the SAM shows the page, the VDG is in text mode`, m.sam.displayBase === page.at && !(m.vdg.firstMode[0] & 0x90), J({ base: m.sam.displayBase }));
    const got = tool(m);
    check(`${where}: screen_text reads the page the SAM shows, base its address`, got.text === true && J(got.lines) === J(trim(want)) && got.base === page.at, J({ base: got.base, lines: got.lines }));
    check(`${where}: screen_text counts the page's semigraphics-4 blocks (the toggle cell included)`, got.semigraphics === blocksOf(page), J(got.semigraphics));
    check(`${where}: Session.screenText gives the same 16 rows at full width`, J(sessionText(m)) === J(want), J(sessionText(m)));
    const from = want.findIndex((l) => l.trim());
    check(`${where}: the screen's text alternative is that text`, altText(m) === trim(want).slice(from).join('\n'), J(altText(m)));
    check(`${where}: the ROM self-test's screen reads the same page (blocks as #)`, J(selfTestLines(m)) === J(wantRows(page, '#').map((l) => l.replace(/\s+$/, ''))), J(selfTestLines(m)));
    const bytes = Array.from({ length: 512 }, (_, i) => m.ram[page.at + i]);
    check(`${where}: textCell gives the shown page's bytes (row 0 col 4, row 15 col 0)`, Emu.textCell(m, 0, 4) === bytes[4] && Emu.textCell(m, 15, 0) === bytes[480] && Emu.textCell(m, 16, 0) === null);
    // the oracle: the picture is the page's. The same 512 bytes shown from $0400 at F = 2 draw the same frame.
    const frame = frameOf(m);
    if (k === 0) defaultFrame = frame;
    else check(`${where}: the picture differs from the default page's`, frame !== defaultFrame);
    bytes.forEach((v, i) => { m.ram[0x400 + i] = v; });
    for (let b = 0; b < 7; b++) m.write(0xFFC6 + 2 * b + ((2 >> b) & 1), 0);
    m.runFrame(); m.runFrame();
    check(`${where}: (oracle) the same bytes shown from $0400 (F = 2) draw the same picture`, m.sam.displayBase === 0x400 && frameOf(m) === frame);
  });

  // ---- phase 4: INT/EXT high over $1C00 ----
  {
    const page = MT.PAGES[2], { m } = at(id, 4), got = tool(m), where = `${id} phase 4 (INT/EXT high)`;
    if (id === 'coco2b') {
      // the MC6847T1: PB4 is its GM0, which enables lowercase for codes $00-$1F; the page has none, so its text is unchanged
      check(`${where}: the CoCo 2B's MC6847T1 still shows text: screen_text reads it`, got.text === true && J(got.lines) === J(trim(wantRows(page))) && got.base === page.at, J(got));
    } else if (id === 'dragon200e') {
      // the Dragon 200-E: the VDG's INT/EXT comes from each fetched byte (its bit 7 inverted, so every text byte is
      // drawn by the character generator) and PIA1 PB4 is the generator's bank input, not INT/EXT: $FF22 = $10 picks
      // the other bank of a text screen, which stays text
      check(`${where}: (setup) the 200-E's INT/EXT comes from the data, and PB4 is high (the bank input)`, m.vdg.extIntFromData === true && (m.vdg.firstMode[0] & 0x10) !== 0);
      check(`${where}: the 200-E's PB4 is its character bank, not INT/EXT: screen_text still reads the page`, got.text === true && J(got.lines) === J(trim(wantRows(page))) && got.base === page.at, J(got));
      const info = Emu.runReadOnlyTool({ machine: m, readByte: (a) => m.peek(a) }, 'machine_info', {});
      check(`${where}: machine_info says readable text, and textCell gives the page's bytes`, info.video.readable === true && info.video.kind === 'text' && Emu.textCell(m, 0, 0) === m.ram[page.at], J(info.video));
    } else {
      check(`${where}: semigraphics-6 / external characters: screen_text declines with the reason`, got.text === false && /semigraphics-6/.test(got.mode) && /INT\/EXT/.test(got.reason) && got.lines.length === 0, J(got));
      const info = Emu.runReadOnlyTool({ machine: m, readByte: (a) => m.peek(a) }, 'machine_info', {});
      check(`${where}: machine_info says the screen is not readable text`, info.video.readable === false && info.video.kind === 'graphics', J(info.video));
      check(`${where}: the text alternative says it is a picture; textCell gives nothing`, /^The screen shows a picture, not text \(MC6847 semigraphics-6/.test(altText(m)) && Emu.textCell(m, 0, 0) === null, J(altText(m)));
      check(`${where}: Session.screenText falls back to the page the SAM selects ($1C00), as for graphics`, J(sessionText(m)) === J(wantRows(page)));
    }
  }

  // ---- phase 5: RG6 graphics over $1C00: as today ----
  {
    const page = MT.PAGES[2], { m, t } = at(id, 5), got = tool(m), where = `${id} phase 5 (RG6 graphics)`;
    check(`${where}: (setup) the firmware reached HALT`, m.cpu.pc === t.halt);
    check(`${where}: screen_text declines a graphics mode, named as before`, got.text === false && got.mode === 'MC6847 graphics, RG6 256x192 2-colour', J(got));
    check(`${where}: Session.screenText falls back to the page at $1C00; textCell gives nothing`, J(sessionText(m)) === J(wantRows(page)) && Emu.textCell(m, 0, 0) === null);
  }
}

// ---- the MCP server: a program that moves the page ----
function server() {
  const home = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cloadm-moved-'));
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'cli', 'cloadm.js'), '--mcp'], { env: Object.assign({}, process.env, { HOME: home, APPDATA: home }), stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', id = 0;
  const waiting = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  const request = (method, params) => new Promise((resolve) => { const rid = ++id; waiting.set(rid, resolve); p.stdin.write(J({ jsonrpc: '2.0', id: rid, method, params }) + '\n'); });
  return {
    async init() { await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'moved-text-page.test', version: '1' } }); p.stdin.write(J({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); },
    async call(name, args = {}) { const r = await request('tools/call', { name, arguments: args }); return JSON.parse(r.result.content[0].text); },
    close() { p.kill(); },
  };
}
// a RAM program: `text` on the page at `page`, the SAM's F set to show it, $FF22 = `ff22`, then a loop
function program(page, f, text, ff22) {
  // the SAM's M1/M0 = 10 (64K), so the video counter reaches $1C00 (the built-in firmware leaves it smaller)
  const L = [' ORG $3000', 'START ORCC #$50', ' STA $FFDA', ' STA $FFDD',` LDX #$${page.toString(16)}`, ' LDA #$60', 'CLR1 STA ,X+', ` CMPX #$${(page + 512).toString(16)}`, ' BLO CLR1',
    ` LDX #$${page.toString(16)}`, ' LDU #MSG', 'CPY LDA ,U+', ' BEQ SHOW', ' STA ,X+', ' BRA CPY'];
  // PIA1 B: CRB bit 2 clear selects the direction register, all outputs, then the data register gets the VDG's mode
  L.push('SHOW CLR $FF23', ' LDA #$FF', ' STA $FF22', ' LDA #$34', ' STA $FF23', ` LDA #$${ff22.toString(16)}`, ' STA $FF22');
  for (let b = 0; b < 7; b++) L.push(` STA $${(0xFFC6 + 2 * b + ((f >> b) & 1)).toString(16).toUpperCase()}`);
  L.push('LOOP BRA LOOP', `MSG FCB ${Array.from(text, (ch) => '$' + (ch.charCodeAt(0) < 0x40 ? ch.charCodeAt(0) + 0x40 : ch.charCodeAt(0)).toString(16)).join(',')},0`);
  return L.join('\n') + '\n';
}

(async () => {
  const s = server();
  try {
    await s.init();
    const boot = await s.call('boot', { model: 'dragon64' });
    const M = { machine_id: boot.machine.machine_id };
    for (const [page, f, text] of [[0x0E00, 7, 'MCP READS $0E00'], [0x1C00, 14, 'MCP READS $1C00']]) {
      const asm = await s.call('assemble_and_load', Object.assign({ source: program(page, f, text, 0) }, M));
      await s.call('run', Object.assign({ target: '$3000' }, M));
      const waited = await s.call('run_frames', Object.assign({ until: { pc: asm.symbols.LOOP } }, M));
      await s.call('run_frames', Object.assign({ frames: 2 }, M));
      const st = await s.call('screen_text', M), out = st.machine_output;
      check(`MCP: screen_text reads the page a program moved to $${page.toString(16).toUpperCase()}`, waited.status === 'met' && out.text === true && out.lines[0] === text && out.lines.length === 1 && out.base === page, J(st).slice(0, 300));
    }
    const asm = await s.call('assemble_and_load', Object.assign({ source: program(0x1C00, 14, 'NOT TEXT NOW', 0x10) }, M));
    await s.call('run', Object.assign({ target: '$3000' }, M));
    await s.call('run_frames', Object.assign({ until: { pc: asm.symbols.LOOP } }, M));
    await s.call('run_frames', Object.assign({ frames: 2 }, M));
    const st = await s.call('screen_text', M);
    check('MCP: INT/EXT high (semigraphics-6 / external characters): screen_text declines', st.machine_output.text === false && /semigraphics-6/.test(st.machine_output.mode), J(st).slice(0, 300));
  } finally { s.close(); }
  console.log(`\n${n - fail}/${n} passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log(`FAIL ${e.stack}`); process.exitCode = 1; });
