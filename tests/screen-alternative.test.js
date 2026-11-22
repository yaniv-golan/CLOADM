// Run: node tests/screen-alternative.test.js
//
// Session.screenAlternative: the screen canvas's text alternative on the page (play/index.html #screenAlt, kept by
// js/ui/screen.js), what a screen reader or a reader view gets instead of the picture. What this proves:
//  * a text screen reads as its rows, exactly as Claude's screen_text reads them (one reader), joined by newlines,
//    from the first row with text; the rows here are written into the text screen by the test and spelt out as literals;
//  * a screen of semigraphics blocks only, an empty screen and a graphics mode each say so in a sentence (the mode
//    named as machine_info names it), and are never read as rows;
//  * the CoCo 3's 80-column GIME text is read (the GIME reader's rows);
//  * reading changes nothing: the machine's state is the same before and after.
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const J = JSON.stringify;
const boot = (id, cfg) => { const s = new Emu.Session(); s.switchMachine(id, cfg); for (let i = 0; i < 50; i++) s.advance(1000 / s.shownMachine.fps + 0.01); return s; };
const frame = (s, n = 1) => { for (let i = 0; i < n; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };
// VDG codes for a string: A-Z @ [ ] are $00-$3F with bit 6 clear for letters, space and punctuation $20-$3F with
// bit 6 set (the MC6847's non-inverted internal characters: $40 | c for $20-$3F, c - $40 for $40-$5F)
const vdg = (str) => [...str].map((ch) => { const c = ch.charCodeAt(0); return c >= 0x40 ? c - 0x40 : 0x40 | c; });
// a program that stops the stub's own screen writes: it loops with interrupts masked
const park = (s) => {
  const r = Emu.assemble(' ORG $3000\nS ORCC #$50\nL BRA L\n', '6809');
  for (const seg of r.segments) for (const [i, b] of [...seg.data].entries()) s.shownMachine.poke(seg.addr + i, b);
  s.shownMachine.jump(0x3000);
  frame(s, 2);
};
const fill = (s, base, code) => { for (let i = 0; i < 512; i++) s.shownMachine.write(base + i, code); };

for (const id of ['dragon64', 'coco', 'mc10']) {
  const s = boot(id);
  if (id !== 'mc10') park(s);
  const base = s.shownMachine.profile.textScreen || 0x400;
  fill(s, base, 0x60);
  [...vdg('HELLO, WORLD')].forEach((c, i) => s.shownMachine.write(base + i, c));
  [...vdg('10 PRINT "OK"')].forEach((c, i) => s.shownMachine.write(base + 64 + i, c));
  const before = J(s.shownMachine.saveState());
  const alt = s.screenAlternative();
  const after = J(s.shownMachine.saveState());
  check(`${id}: a text screen reads as its rows, a blank row kept between them`, alt === 'HELLO, WORLD\n\n10 PRINT "OK"', J(alt));
  const tool = Emu.runReadOnlyTool({ machine: s.shownMachine, readByte: (a) => s.readByte(a) }, 'screen_text', {});
  check(`${id}: the same rows as screen_text`, alt === tool.lines.join('\n'), J(tool.lines));
  check(`${id}: reading changes nothing`, before === after);
  // text lower down: the blank rows above it are left out (they place it on the screen, they are not text)
  fill(s, base, 0x60);
  [...vdg('PRESS 1 TO 5')].forEach((c, i) => s.shownMachine.write(base + 32 * 5 + 4 + i, c));
  check(`${id}: the blank rows above the first text are left out, the indent kept`, s.screenAlternative() === '    PRESS 1 TO 5', J(s.screenAlternative()));
  fill(s, base, 0x60);
  check(`${id}: an empty screen says it is blank`, s.screenAlternative() === 'The screen is blank.', J(s.screenAlternative()));
  fill(s, base, 0x8F);
  check(`${id}: a screen of blocks says so, and is not read as rows`, s.screenAlternative() === 'The screen shows block graphics, no text.', J(s.screenAlternative()));
}

// a graphics mode (PIA1 port B: A/G set, RG6) says it is a picture and names the mode
{
  const s = boot('coco');
  const r = Emu.assemble(' ORG $3000\nS ORCC #$50\n LDA #$F0\n STA $FF22\nL BRA L\n', '6809');
  for (const seg of r.segments) for (const [i, b] of [...seg.data].entries()) s.shownMachine.poke(seg.addr + i, b);
  s.shownMachine.jump(0x3000);
  frame(s, 3);
  const alt = s.screenAlternative();
  check('a graphics mode: a sentence naming the mode, no rows', alt === 'The screen shows a picture, not text (MC6847 graphics, RG6 256x192 2-colour).', J(alt));
}

// the CoCo 3 in an 80-column GIME text mode: the GIME reader's rows. The screen is one of
// tools/mame-diff/coco3/text-screens.js (its firmware programs the GIME as tests/coco3-screen-text.test.js runs it)
{
  const T = require('../tools/mame-diff/coco3/text-screens.js');
  const { romImage } = require('../tools/mame-diff/lib/firmware.js');
  const asm = Emu.assemble(T.firmware(), '6809');
  const rom = romImage(asm, 0x8000, 0x8000, 0x12);
  const want = T.SCREENS.findIndex((x) => x.name === 'text 80');
  let at = null;
  T.runOurs(Emu, rom, { cpu: '6809', onScreen: (i, m) => { if (i === want) { at = m; return true; } return false; } });
  const s = new Emu.Session();
  const alt = s.screenAlternative(at);
  const tool = Emu.runReadOnlyTool({ machine: at, readByte: (a) => at.peek(a) }, 'screen_text', {});
  const rows = tool.lines.slice(tool.lines.findIndex((l) => l.trim()));
  check('coco3, text 80: the GIME reader\'s 80-column rows', want >= 0 && tool.text && tool.cols === 80 && rows.some((l) => l.length > 32)
    && alt === rows.join('\n'), J(alt.slice(0, 100)));
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;
