// Arriving on a shared moment (Session.sharedMoment): a share link's snapshot that runs without ROMs is someone
// else's moment, and the page holds back its side card and "Add ROMs…" while the person looks at it
// (js/ui/drawer.js, js/ui/welcome.js). The Session decides when that is: opened from a link (shared) AND without
// ROMs; and it ends, with one 'arrival' event, when the person leaves the moment: a Reset (back to the menu), a
// power cycle (Switch off and on: start over) or a machine switch. The page's side is the browser check's
// "shared-arrival" group.
const Emu = require('./load')();
const { build } = require('./fixtures/reset-firmware');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const frames = (m, n) => { for (let i = 0; i < n; i++) m.runFrame(); };
const BASE = 'https://cloadm.dev/play/';
// a small program on the stub: fills the text screen with 'A' and loops. BNE's offset is $F9, as in the golden
// fixtures (tools/gen-link-fixtures.js): from just past it back to the STA ,X+, which stores 'A' ($41) and moves X on.
// At $F8 (one short) it lands on $7004, the LDA's operand $41, which our 6809 core runs as NEGA: opcodes $40-$4F all
// go to unary(), where low nibble 1 is treated like 0, so A = -A in 2 cycles (our disassembler marks it illegal:
// "FCB $41"). A then flips $41 <-> $BF on each pass - negation, not COM, which would give $BE - while STA ,X+ still
// advances X, so the screen alternates $41/$BF and the program parks at $700C with X=$0600. The LDA at $7003 runs
// once, on the first pass; the BNE goes back to $7004, so its $86 is never fetched again. $BF has bit 7 set, reads as
// a semigraphics block and shows as a space, which the old `replace(/ /g, '').startsWith('AAAA')` checks could not
// tell from a filled screen.
const FILL = [{ addr: 0x7000, data: Uint8Array.from([0x8E, 0x04, 0x00, 0x86, 0x41, 0xA7, 0x80, 0x8C, 0x06, 0x00, 0x26, 0xF9, 0x20, 0xFE]) }];

// the program's whole job is filling the screen, so both screen checks want all 16 rows of 32 'A', not just the top
// one: a loop that stops early still leaves row 0 perfect.
const fullScreen = (s) => { const rows = s.screenText(); return rows.length === 16 && rows.every((r) => r.slice(0, 32) === 'A'.repeat(32)); };

const session = (roms) => {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64', undefined, { menu: false });
  if (roms) s.addRoms([{ name: 'd64_1.rom', bytes: roms.basic }, { name: 'd64_2.rom', bytes: roms.basic64 }]);
  return s;
};
// a moment on the stub, as its share link carries it
const noRomLink = async () => {
  const a = session(null);
  a.inject(FILL, 0x7000);
  frames(a.shownMachine, 5);
  return a.snapshotLink(BASE);
};
// the link opened in another browser (no ROMs there), with the events it emits from then on
const arrive = async (link, { shared = true } = {}) => {
  const b = session(null), events = [];
  b.on((ev) => events.push(ev));
  const snap = await b.readSnapshotLink(new URL(link).hash);
  let seen = null;   // what the page sees at the 'machine' event openSnapshot emits (its first look at the machine)
  b.on((ev) => { if (ev === 'machine' && seen === null) seen = b.sharedMoment; });
  b.openSnapshot(snap, { shared });
  return { b, events, seen };
};

(async () => {
  const link = await noRomLink();

  // ---- 1. arriving: a link's moment without ROMs is quiet, and already so at the first 'machine' event ----
  {
    const { b, seen } = await arrive(link);
    check('arrival: a shared no-ROM moment is a shared moment', b.sharedMoment === true);
    check('arrival: already set when the page first hears of the machine', seen === true, String(seen));
    check('arrival: the moment itself is back (the program\'s screen)', fullScreen(b), b.screenText()[0]);
  }
  // ---- 2. the same snapshot not from a link (a dropped file) is not an arrival ----
  {
    const { b } = await arrive(link, { shared: false });
    check('a dropped file: not a shared moment', b.sharedMoment === false);
  }
  // ---- 3. leaving: Reset, power cycle, switch; each ends it once, with one 'arrival' ----
  for (const [what, leave] of [
    ['Reset (back to the menu)', (b) => b.reset()],
    ['Switch off and on (start over)', (b) => b.powerCycle()],
    ['a machine switch', (b) => b.switchMachine('coco')],
  ]) {
    const { b, events } = await arrive(link);
    events.length = 0;
    leave(b);
    check(`leave by ${what}: no longer a shared moment`, b.sharedMoment === false);
    check(`leave by ${what}: one 'arrival' event`, events.filter((e) => e === 'arrival').length === 1, JSON.stringify(events));
    events.length = 0;
    b.reset();
    check(`leave by ${what}: a second Reset says nothing more`, !events.includes('arrival'), JSON.stringify(events));
  }
  // ---- 4. running the moment on is not leaving it ----
  {
    const { b, events } = await arrive(link);
    events.length = 0;
    frames(b.shownMachine, 60);
    check('running on: still the shared moment', b.sharedMoment === true && !events.includes('arrival'));
  }
  // ---- 5. a shared moment that runs WITH ROMs is not quiet (the person has BASIC: there is no pill or card) ----
  {
    const { basic, basic64 } = build(Emu);
    const roms = { basic, basic64 };
    const a = session(roms);
    frames(a.shownMachine, 30);
    const withRoms = await a.snapshotLink(BASE);
    const b = session(roms);
    b.openSnapshot(await b.readSnapshotLink(new URL(withRoms).hash), { shared: true });
    check('with ROMs: a shared moment that uses them is not quiet', b.sharedMoment === false);
  }
  // ---- 6. a later, non-shared snapshot ends the quiet too ----
  {
    const { b } = await arrive(link);
    b.openSnapshot(await b.readSnapshotLink(new URL(link).hash));
    check('another snapshot opened from a file: no longer quiet', b.sharedMoment === false);
  }

  // ---- 7. a moment of the stub's BARE prompt has nothing running: opening it offers the welcome menu ----
  // (js/session.js, openSnapshot's atStubPrompt branch: "a moment taken on the stub's bare prompt has nothing running
  // to come back to: the welcome menu, as a power-on"). The page's 'menu' handler then runs the welcome program, which
  // overwrites the restored RAM: that is expected for this moment, and it is why the browser check that opens a link's
  // moment uses one with a PROGRAM running (browser-check.js, "keeps the fragment through the redirect").
  {
    const a = session(null);
    frames(a.shownMachine, 30);                       // the stub's own idle screen: still at the prompt
    const stubLink = await a.snapshotLink(BASE);
    const b = session(null), events = [];
    b.on((ev) => events.push(ev));
    const snap = await b.readSnapshotLink(new URL(stubLink).hash);
    b.openSnapshot(snap, { shared: true });
    check('a moment of the stub\'s bare prompt is at the prompt', snap && b.shownMachine.atStubPrompt() === true);
    check('a moment of the stub\'s bare prompt offers the welcome menu', events.includes('menu'), JSON.stringify(events));
  }
  // ---- 8. a moment with a PROGRAM running does not: it opens and stays ----
  {
    const a = session(null);
    a.inject(FILL, 0x7000);                            // the same 14-byte program the browser check now uses
    frames(a.shownMachine, 5);
    a.shownMachine.poke(0x3000, 0xA7);
    const progLink = await a.snapshotLink(BASE);
    const b = session(null), events = [];
    b.on((ev) => events.push(ev));
    b.openSnapshot(await b.readSnapshotLink(new URL(progLink).hash), { shared: true });
    frames(b.shownMachine, 60);                        // long enough for any menu to have replaced it
    check('a moment with a program running is not at the prompt', b.shownMachine.atStubPrompt() === false);
    check('a moment with a program running does not offer the menu', !events.includes('menu'), JSON.stringify(events));
    check('a moment with a program running keeps its memory, 60 frames on', b.shownMachine.read(0x3000) === 0xA7, String(b.shownMachine.read(0x3000)));
    check('a moment with a program running keeps its screen, 60 frames on', fullScreen(b), b.screenText()[0]);
  }

  // ---- 9. just arrived from a link (Session.arrivedFromLink, the page's arrival card: js/ui/arrival.js) ----
  // set by openSnapshot({ link }), already at the first 'machine' event; cleared, with one 'arrival' event, by the
  // person's first input (a key, typed text, a POKE, a load: touch), another snapshot, a switch, a Reset or a power
  // cycle. Running on is not acting.
  {
    const arriveLink = async (l, link) => {
      const b = session(null), events = [];
      b.on((ev) => events.push(ev));
      let seen;
      b.on((ev) => { if (ev === 'machine' && seen === undefined) seen = b.arrivedFromLink; });
      b.openSnapshot(await b.readSnapshotLink(new URL(l).hash), { shared: true, link });
      return { b, events, seen };
    };
    {
      const { b, seen } = await arriveLink(link, { kind: 'long' });
      check('arrivedFromLink: a long link\'s moment: { kind long, id null, machine, program null }',
        JSON.stringify(b.arrivedFromLink) === JSON.stringify({ kind: 'long', id: null, machine: 'Dragon 64', program: null }), JSON.stringify(b.arrivedFromLink));
      check('arrivedFromLink: already set when the page first hears of the machine', !!seen && seen.kind === 'long');
    }
    {
      const { b } = await arriveLink(link, { kind: 'short', id: 'Ab3_-9xZ' });
      check('arrivedFromLink: a short link\'s moment carries its id', b.arrivedFromLink && b.arrivedFromLink.kind === 'short' && b.arrivedFromLink.id === 'Ab3_-9xZ', JSON.stringify(b.arrivedFromLink));
    }
    {
      const b = session(null);
      b.openSnapshot(await b.readSnapshotLink(new URL(link).hash), { shared: true });
      check('arrivedFromLink: a moment opened from no link (a file, a slot) is not an arrival', b.arrivedFromLink === null);
    }
    for (const [what, act] of [
      ['the first key', (b) => b.personInput()],
      ['typed text', (b) => b.typeText('A')],
      ['a POKE (a memory change by a tool)', (b) => b.pokeBytes(0x3000, Uint8Array.of(1), b.shownMachine)],
      // (a DECB binary of FILL: one segment at $7000, exec $7000)
      ['a load', (b) => b.load('fill.bin', Uint8Array.from([0, 0, FILL[0].data.length, 0x70, 0, ...FILL[0].data, 0xFF, 0, 0, 0x70, 0]))],
      ['another snapshot', async (b) => b.openSnapshot(await b.readSnapshotLink(new URL(link).hash))],
      ['a machine switch', (b) => b.switchMachine('coco')],
      ['Reset', (b) => b.reset()],
      ['a power cycle', (b) => b.powerCycle()],
    ]) {
      const { b, events } = await arriveLink(link, { kind: 'long' });
      events.length = 0;
      try { await act(b); } catch (e) { check(`arrivedFromLink: ${what} ran`, false, e.message); continue; }
      check(`arrivedFromLink: ${what} ends the arrival, with one 'arrival' event`, b.arrivedFromLink === null && events.filter((e) => e === 'arrival').length === 1, JSON.stringify(events));
    }
    {
      const { b, events } = await arriveLink(link, { kind: 'long' });
      events.length = 0;
      frames(b.shownMachine, 60);
      check('arrivedFromLink: running on is not acting', !!b.arrivedFromLink && !events.includes('arrival'));
      check('arrivedFromLink: the first key ends the arrival but not the shared moment (only leaving does)', (b.personInput(), b.arrivedFromLink === null && b.sharedMoment === true));
    }
  }

  // ---- 10. the moment's program: a bundled program's snapshot records it (shareFile, snapshotFile, the long link),
  // so whoever opens it can start that program from its beginning; nothing else does, and an unknown one is ignored ----
  {
    const fs = require('fs'), path = require('path');
    const a = new Emu.Session({ store: Emu.memoryStore(), welcomeMenu: true });
    a.switchMachine('dragon64', undefined, { menu: false });
    a.runGame('2048', fs.readFileSync(path.join(__dirname, '..', 'examples', a.gameFile('2048'))));
    frames(a.shownMachine, 20);
    a.personInput();   // played: a moment of 2048 all the same
    const gameLink = await a.snapshotLink(BASE);
    const b = session(null);
    const snap = await b.readSnapshotLink(new URL(gameLink).hash);
    b.openSnapshot(snap, { shared: true, link: { kind: 'long' } });
    check('program: a played 2048 moment\'s link records program 2048, and the arrival says so', snap.program === '2048' && b.arrivedFromLink.program === '2048', `${snap.program} ${JSON.stringify(b.arrivedFromLink)}`);
    check('program: the snapshot file and the shared file record it too', (await b.readSnapshot((await a.snapshotFile()).bytes)).program === '2048'
      && (await b.readSnapshot((await a.shareFile()).bytes)).program === '2048');
    // shared on again from where it arrived (Send it back, a re-share), and a slot or file taken after arriving: the
    // program goes with it until something else runs there
    const back = await b.readSnapshotLink(new URL(await b.snapshotLink(BASE)).hash);
    check('program: an arrived 2048 moment shared on again (Send it back) still records program 2048', back.program === '2048' && b.momentProgram() === '2048', String(back.program));
    frames(b.shownMachine, 30); b.personInput();
    check('program: a snapshot file taken after arriving (and playing on) keeps it', (await b.readSnapshot((await b.snapshotFile()).bytes)).program === '2048');
    await b.saveSlot(1);
    check('program: a slot taken after arriving keeps it', (await b.readSlot(1)).program === '2048');
    const again = session(null);
    again.openSnapshot(back, { shared: true, link: { kind: 'long' } });
    check('program: the moment that came back arrives as 2048 again (its Start from the beginning starts 2048)', again.arrivedFromLink.program === '2048');
    for (const [what, act] of [
      ['a load', (x) => x.load('fill.bin', Uint8Array.from([0, 0, FILL[0].data.length, 0x70, 0, ...FILL[0].data, 0xFF, 0, 0, 0x70, 0]))],
      ['a power cycle', (x) => x.powerCycle()],
      ['Reset', (x) => x.reset()],
      ['a program injected', (x) => x.inject(FILL, 0x7000)],
    ]) {
      const x = session(null);
      x.openSnapshot(back, { link: { kind: 'long' } });
      act(x);
      check(`program: ${what} after arriving ends it (something else runs)`, x.momentProgram() === null && !('program' in await x.readSnapshotLink(new URL(await x.snapshotLink(BASE)).hash)));
    }
    {
      // a load that goes through neither inject nor a reset: a BASIC listing on a machine with BASIC (our stand-in,
      // tests/fixtures/basic-standin.js), which load() types in. load()'s own forgetOpenedProgram is what ends it here
      const { build } = require('./fixtures/basic-standin');
      const y = session(build(Emu, 'dragon64'));
      frames(y.shownMachine, 10);
      const own = await y.readSnapshot((await y.snapshotFile()).bytes);
      y.openSnapshot(Object.assign({}, own, { program: '2048' }), { link: { kind: 'long' } });
      const before = y.momentProgram(), resetAt = y.shownMachine.resetAt, injected = y.shownMachine.injectAndRun;
      let inj = false;
      y.shownMachine.injectAndRun = (...a) => { inj = true; return injected.apply(y.shownMachine, a); };
      const msg = y.load('typed.bas', new TextEncoder().encode('10 PRINT "HI"\n20 GOTO 10\n'));
      check('program: a BASIC listing loaded after arriving (typed in: no inject, no reset) ends it', before === '2048' && /typing BASIC listing/.test(msg) && !inj
        && y.shownMachine.resetAt === resetAt && y.momentProgram() === null && !('program' in await y.readSnapshotLink(new URL(await y.snapshotLink(BASE)).hash)),
        `${before} -> ${y.momentProgram()} ${msg}`);
    }
    const c = session(null);
    c.inject(FILL, 0x7000);
    frames(c.shownMachine, 5);
    check('program: a moment of no bundled program records none (the field is not written)', !('program' in await c.readSnapshotLink(new URL(await c.snapshotLink(BASE)).hash))
      && !('program' in await c.readSnapshot((await c.snapshotFile()).bytes)));
    const odd = Object.assign({}, snap, { program: 'rm -rf' });
    const d = session(null);
    d.openSnapshot(odd, { link: { kind: 'long' } });
    check('program: a program this page does not have is ignored (null)', d.arrivedFromLink.program === null
      && Emu.Session.momentProgramId('liza') === 'liza' && Emu.Session.momentProgramId('minesweeper') === 'minesweeper' && Emu.Session.momentProgramId('__proto__') === null && Emu.Session.momentProgramId(7) === null);
  }

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
