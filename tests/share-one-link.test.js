// The Share screen's "one link": a bundled program nobody has touched since it started has nothing of its own to
// share, so its program page is the primary link and nothing is uploaded (Session.untouchedBundledProgram).
// The rule: "untouched" means untouched since the program started. Any key or joystick input (Session.personInput,
// which every way the person's hand reaches the machine goes through), a load, a typed line, a press of BREAK, a disk
// or a tape going in, or a memory change by a tool (pokeBytes, injectAssembled) makes it a moment, and the primary shares
// the moment as played. A program's OWN running - frames, its timers, LIZA's prompt - is not a touch: else "untouched"
// could never be true a second after it started. The page's side (the primary button, "Link to <program> from the
// start", the offline and failure fallbacks) is the browser check's "share" group.
const fs = require('fs');
const path = require('path');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}${detail ? ' ' + detail : ''}`); };
const frames = (m, n) => { for (let i = 0; i < n; i++) m.runFrame(); };
const BASE = 'https://cloadm.dev/play/';
const example = (file) => fs.readFileSync(path.join(__dirname, '..', 'examples', file));

// a Dragon 64 on the built-in firmware, at the stub's prompt
const session = () => {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64', undefined, { menu: false });
  frames(s.shownMachine, 40);
  return s;
};
const startGame = (s, name = '2048') => { s.runGame(name, example(s.gameFile(name))); frames(s.shownMachine, 20); };

(async () => {
  // ---------------- the page it gives ----------------
  {
    const s = session();
    startGame(s, '2048');
    const u = s.untouchedBundledProgram(BASE);
    check('2048, untouched: its program page, named for the note "Opens 2048 from the start, for anyone."',
      !!u && u.id === '2048' && u.name === '2048' && /\/2048\/$/.test(u.page), JSON.stringify(u));
    check('the page is the one Session.programPageUrl makes for the page the person is on', !!u && u.page === s.programPageUrl('2048', BASE), u && u.page);
  }

  // ---------------- its own running is not a touch ----------------
  {
    const s = session();
    startGame(s, '2048');
    const t0 = s.touches(s.shownMachine);
    frames(s.shownMachine, 180);   // three seconds of the game: its animation and timers, no input
    check('its own running (180 frames) is not a touch: still untouched', s.touches(s.shownMachine) === t0 && !!s.untouchedBundledProgram(BASE), `${t0} -> ${s.touches(s.shownMachine)}`);
  }

  // ---------------- every way in makes it a moment, and it is still a bundled program ----------------
  const cases = [
    ['a key on the screen or the page (personInput)', (x) => x.personInput()],
    ['a typed line (typeText)', (x) => x.typeText('P')],
    ['a memory change by a tool (pokeBytes)', (x) => x.pokeBytes(0x2000, [0x42])],
    ['a program a tool assembled (injectAssembled)', (x) => x.injectAssembled({ segments: [{ addr: 0x7000, data: Uint8Array.from([0x20, 0xFE]) }], symbols: {} })],
    ['a tape going in (insertTape)', (x) => x.insertTape('t.cas', Uint8Array.from([0x55, 0x3C, 0x01, 0x00, 0xFF, 0x00, 0x00]))],
    ['BREAK (pressBreak)', (x) => x.pressBreak()],
  ];
  for (const [what, touch] of cases) {
    const x = session();
    startGame(x, '2048');
    let err = null;
    try { touch(x); } catch (e) { err = e; }
    check(`${what} makes it a moment: not untouched, though still a bundled program`, err === null && !x.untouchedBundledProgram(BASE) && !!x.bundledProgram(BASE),
      err ? `threw: ${err.message}` : `touches ${x.touches(x.shownMachine)}`);
  }
  // a disk going in, through the drives (a Dragon with its disk controller plugged in bare, a blank image in drive 0)
  {
    const x = session();
    startGame(x, '2048');
    let err = null, mounted = false;
    try {
      x.drives.plugBareController(x.drives.bareChoice());
      await x.media.write('disks/m.vdk', Emu.blankDisk('vdk', 40, 1));
      await x.drives.mount(0, 'disks/m.vdk');
      mounted = true;
    } catch (e) { err = e; }
    check('a disk going in (drives.mount) makes it a moment: not untouched', !err && mounted && !x.untouchedBundledProgram(BASE), err ? `threw: ${err.message}` : `touches ${x.touches(x.shownMachine)}`);
  }

  // ---------------- a load replaces the program: no bundled program at all ----------------
  {
    const s = session();
    startGame(s, '2048');
    s.load('demo.bin', example('demo.bin'), { remember: false });
    frames(s.shownMachine, 5);
    check('a load takes the program away: no bundled program, so no page offered either', s.untouchedBundledProgram(BASE) === null && s.bundledProgram(BASE) === null);
  }

  // ---------------- LIZA, and the colour demo (no page) ----------------
  {
    const s = session();
    s.runLiza(example(s.lizaFile));
    frames(s.shownMachine, 120);   // LIZA draws its prompt and waits: its own running
    const t = s.touches(s.shownMachine), u = s.untouchedBundledProgram(BASE);
    check('LIZA, untouched: its page (/liza/); its own drawing is no touch', !!u && u.id === 'liza' && /\/liza\/$/.test(u.page) && s.touches(s.shownMachine) === t, JSON.stringify(u));
    s.pressBreak();
    check('LIZA after BREAK (a key): not untouched', s.untouchedBundledProgram(BASE) === null);

    const d = session();
    d.load('demo.bin', example('demo.bin'), { remember: false });
    frames(d.shownMachine, 5);
    check('the colour demo (no program page) is never offered as a program link', d.untouchedBundledProgram(BASE) === null && d.bundledProgram(BASE) === null);
  }

  // ---------------- nothing running ----------------
  {
    const s = session();
    check('nothing running (the stub at its prompt): no bundled program', s.untouchedBundledProgram(BASE) === null && s.bundledProgram(BASE) === null);
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL the suite threw:', e.stack); process.exitCode = 1; });
