// Arriving on a shared moment (Session.sharedMoment): a share link's snapshot that runs without ROMs is someone
// else's moment, and the page holds back its no-ROM card and "No BASIC" pill while the person looks at it
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
// a small program on the stub: fills the text screen with 'A' and loops
const FILL = [{ addr: 0x7000, data: Uint8Array.from([0x8E, 0x04, 0x00, 0x86, 0x41, 0xA7, 0x80, 0x8C, 0x06, 0x00, 0x26, 0xF8, 0x20, 0xFE]) }];

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
    check('arrival: the moment itself is back (the program\'s screen)', b.screenText()[0].replace(/ /g, '').startsWith('AAAA'), b.screenText()[0]);
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
    check('a moment with a program running keeps its screen, 60 frames on', b.screenText()[0].replace(/ /g, '').startsWith('AAAA'), b.screenText()[0]);
  }

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
