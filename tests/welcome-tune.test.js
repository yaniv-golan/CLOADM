// The welcome menu's tune plays only when the person asked for the menu. The Session decides, so the page, MCP
// and Claude's switches all follow it (js/session.js startWelcome, offerMenu, flushWelcome, welcomeSound).
//   PLAYS   the visit's own start, once the sound is unlocked (including an unlock while that menu is up), and the
//           menu chosen from Programs (the shelf);
//   SILENT  a machine switch (also a RAM change, the machine question, an opened snapshot), Reset, a power cycle and
//           the menu coming back from LIZA, a game or the demo.
// How: a silent start sets the firmware's own PLAYED flag ($6005 on the 6809 build, $5005 on the 6803 build; the
// firmware clears it at START, so the Session sets it after the first frame), and holds SOUNDOK back until then.
// Measured on the real firmware, headless: what the program writes to the DAC (6809: PIA1 port A at its high level;
// MC-10: the sound bit of the $BFFF latch) over about 3 s of frames, driven through Session.advance as the page does.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const read = (f) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples', f)));
const PLAYED = { 6809: Emu.WELCOME['6809'].played, 6803: Emu.WELCOME['6803'].played };

// the Session as the page drives it: a 'menu' event is the Session asking for the menu, and the page then fetches
// the bytes and calls startWelcome WITHOUT a reason of its own (the Session knows why it asked)
function visit(id, config) {
  const s = new Emu.Session();
  const asked = { arg: null };
  s.on((ev, arg) => { if (ev === 'menu') asked.arg = arg === undefined ? 'bye' : arg; });
  s.switchMachine(id, config || {}, { menu: false });
  return { s, asked };
}
const pageStart = (s, asked) => {
  const arg = asked.arg; asked.arg = null;
  if (arg === null) throw new Error('the Session did not ask for the menu');
  return s.startWelcome(read(s.welcomeFile), { greeting: arg === 'bye' ? 'bye' : 'back' });
};
// one tick per frame, counting tune output
function meter(s) {
  const m = s.shownMachine, c = { n: 0 }, mc10 = m.config.cpu === '6803';
  if (mc10) {
    const write = m.write.bind(m);
    m.write = (a, v) => { if ((a & 0xFFFF) === 0xBFFF && (v & 0x80)) c.n++; return write(a, v); };
  }
  c.on = (mm) => { if (mc10) return; for (let k = 2; k < mm.audioEvents.length; k += 2) if (mm.audioEvents[k + 1] > 0.9) c.n++; };
  return c;
}
const frames = (s, n, c) => { const ms = 1000 / s.shownMachine.fps + 0.0001; for (let i = 0; i < n; i++) s.advance(ms, { onFrame: c ? c.on : null }); };
const SECONDS = 3.2;
const play = (s, c, seconds = SECONDS) => { c.n = 0; frames(s, Math.ceil(s.shownMachine.fps * seconds), c); return c.n; };
// a silent menu: it is running (so no tune because it was held, not because nothing started), and has PLAYED set
const silent = (s) => { const c = meter(s), n = play(s, c); return { ok: n === 0 && s.welcomeRunning && flag(s) === 1, d: `n=${n} running=${s.welcomeRunning} PLAYED=${flag(s)}` }; };
const PLAYS = 20;   // the tune is ten notes of many edges each; a silent menu has none
const flag = (s) => s.shownMachine.ram[PLAYED[s.shownMachine.config.cpu === '6803' ? 6803 : 6809]];

for (const [id, label] of [['dragon64', '6809'], ['mc10', 'MC-10']]) {
  const L = `${id}`;
  // ---- the visit: plays (sound unlocked first, and unlocked while the menu is up) ----
  {
    const { s } = visit(id); s.welcomeSound();
    s.startWelcome(read(s.welcomeFile), { reason: 'visit' });
    const c = meter(s);
    check(`${L}: a visit start with the sound already unlocked plays the tune`, play(s, c) >= PLAYS, `${c.n}`);
    check(`${L}: ... and plays it once (nothing more a second later)`, play(s, c, 1) === 0);
  }
  {
    const { s } = visit(id);
    s.startWelcome(read(s.welcomeFile), { reason: 'visit' });
    const c = meter(s);
    check(`${L}: a locked visit is silent`, play(s, c, 1.5) === 0);
    s.welcomeSound();
    check(`${L}: ... and the unlock while that menu is up plays it`, play(s, c) >= PLAYS, `${c.n}`);
    check(`${L}: ... once`, play(s, c, 1) === 0);
  }
  {
    // no reason at all and nothing asked for the menu (a start from a script): a visit
    const { s } = visit(id); s.welcomeSound();
    s.startWelcome(read(s.welcomeFile));
    check(`${L}: a start with no reason and no menu asked for is a visit: it plays`, play(s, meter(s)) >= PLAYS);
  }
  // ---- the shelf: plays, also right after a silent switch ----
  {
    const { s, asked } = visit(id); s.welcomeSound();
    s.switchMachine(id, {}, { menu: true });
    pageStart(s, asked);
    const c = meter(s);
    check(`${L}: (set-up) the menu after a switch is silent`, play(s, c, 1.5) === 0 && s.welcomeRunning && flag(s) === 1);
    s.startWelcome(read(s.welcomeFile), { greeting: 'back', reason: 'shelf' });
    const c2 = meter(s);
    check(`${L}: the Welcome menu chosen from Programs plays the tune, even after a silent start`, play(s, c2) >= PLAYS, `${c2.n}`);
  }
  // ---- silent: a machine switch, with the sound unlocked before it, and the unlock after it ----
  {
    const { s, asked } = visit(id); s.welcomeSound();
    s.startWelcome(read(s.welcomeFile), { reason: 'visit' }); const c0 = meter(s); play(s, c0);
    s.switchMachine(id === 'mc10' ? 'dragon64' : 'coco');
    pageStart(s, asked);
    const c = meter(s);
    check(`${L}: a machine switch with the sound unlocked: the new menu is silent`, play(s, c) === 0 && flag(s) === 1, `${c.n} PLAYED=${flag(s)}`);
    s.welcomeSound();
    check(`${L}: ... and unlocking the sound afterwards (while that menu is up) stays silent`, play(s, c) === 0, `${c.n}`);
  }
  {
    // the unlock comes before the silent start's first frame
    const { s, asked } = visit(id);
    s.switchMachine(id, {}, { menu: true });
    pageStart(s, asked);
    s.welcomeSound();
    const soundOk = Emu.WELCOME[s.shownMachine.config.cpu === '6803' ? '6803' : '6809'].soundOk;
    check(`${L}: an unlock before the silent menu's first frame does not arm the tune yet (SOUNDOK stays 0)`, s.shownMachine.ram[soundOk] === 0, String(s.shownMachine.ram[soundOk]));
    const c = meter(s);
    check(`${L}: ... and the tune stays silent, PLAYED set and SOUNDOK let through after the first frame`, play(s, c) === 0 && flag(s) === 1 && s.shownMachine.ram[soundOk] === 1, `${c.n} PLAYED=${flag(s)} SOUNDOK=${s.shownMachine.ram[soundOk]}`);
  }
  {
    // a tick with no frame due (the page ticks faster than the machine's frames) must not set PLAYED early: the
    // firmware clears it at START, and the tune would then play
    const { s, asked } = visit(id); s.welcomeSound();
    s.switchMachine(id, {}, { menu: true });
    pageStart(s, asked);
    s.advance(0.1);
    const c = meter(s);
    check(`${L}: a tick that runs no frame does not spend the silent start's wait (still silent)`, play(s, c) === 0 && flag(s) === 1, `${c.n}`);
  }
  {
    const { s, asked } = visit(id); s.welcomeSound();
    s.switchMachine(id, { ram: id === 'mc10' ? 20 : 64 });
    pageStart(s, asked);
    { const r = silent(s); check(`${L}: a RAM change is silent`, r.ok, r.d); }
  }
  {
    const { s, asked } = visit(id); s.welcomeSound();
    s.startWelcome(read(s.welcomeFile), { reason: 'visit' }); play(s, meter(s));
    s.reset();
    { const r = silent(s); check(`${L}: Reset (the menu restarts itself) is silent`, r.ok, r.d); }
  }
  {
    const { s, asked } = visit(id); s.welcomeSound();
    s.startWelcome(read(s.welcomeFile), { reason: 'visit' }); play(s, meter(s));
    s.powerCycle();
    pageStart(s, asked);
    { const r = silent(s); check(`${L}: a power cycle is silent`, r.ok, r.d); }
  }
  // ---- silent: back from LIZA ----
  {
    const { s, asked } = visit(id); s.welcomeSound();
    s.startWelcome(read(s.welcomeFile), { reason: 'visit' }); play(s, meter(s), 1);
    s.runLiza(read(s.lizaFile));
    frames(s, 30);
    s.typeText('BYE\n');
    for (let i = 0; i < Math.ceil(s.shownMachine.fps * 8) && asked.arg === null; i++) frames(s, 1);
    check(`${L}: (set-up) leaving LIZA asks for the menu`, asked.arg === 'bye', String(asked.arg));
    pageStart(s, asked);
    const c = meter(s);
    check(`${L}: the menu coming back from LIZA is silent`, play(s, c) === 0 && flag(s) === 1, `${c.n}`);
  }
}

// ---- the page's pieces: an explicit reason beats the one the Session was offered, and a bad one is refused ----
{
  const { s } = visit('dragon64'); s.welcomeSound();
  s.switchMachine('coco');                                   // asks for the menu with 'switch' ...
  s.startWelcome(read(s.welcomeFile), { reason: 'shelf' });  // ... but the person chose it from Programs
  check('a start that names its own reason uses it over the one offered (shelf after a switch plays)', play(s, meter(s)) >= PLAYS);
  let threw = null;
  try { s.startWelcome(read(s.welcomeFile), { reason: 'sometimes' }); } catch (e) { threw = e; }
  check('an unknown reason is refused with a SessionError', threw instanceof Emu.SessionError && /unknown welcome reason/.test(threw.message), threw && threw.message);
}
{
  // an offered reason is spent by the start that takes it, and ended with the machine: a later start with no reason is a visit
  const { s } = visit('dragon64'); s.welcomeSound();
  s.switchMachine('coco');                                   // the menu is asked for, and the page never starts it ...
  s.switchMachine('dragon64', {}, { menu: false });          // ... and the machine changed: nothing is offered any more
  s.startWelcome(read(s.welcomeFile));
  check('the offered reason does not leak into a later start (a plain start after a machine change that left it unspent plays)', play(s, meter(s)) >= PLAYS);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
