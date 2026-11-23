// A machine has one debugger: the Session, the page, the MCP tools and the CLI share it (session.debug), a
// restored snapshot's becomes the Session's, a switch leaves the old machine's behind (detached, its bus taps
// released), and one made directly on a machine that has one (the Node API exports Debugger) takes its place
// instead of stacking: no double watchpoint hit, no orphan holding taps, no snapshot that carries a different
// debugger from the one the Session drives. (js/debugger.js constructor and detach(), js/session.js debug,
// debugger, adopt() and install().)
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const mk = (id = 'dragon64') => { const s = new Emu.Session({ welcomeMenu: false }); s.switchMachine(id, {}, { menu: false }); return s; };
// the bus taps a machine has live: [reads, writes] (a watchpoint takes one of each kind)
const taps = (m) => `${m.busTaps.reads.length}r/${m.busTaps.writes.length}w`;
const bps = (d) => [...d.bps].join();

// ---- the paths through the Session: one debugger ----
{
  const s = mk();
  const a = s.debug, b = s.debug;
  check('one debugger: session.debug twice is the same instance, and it is the machine\'s', a === b && s.shownMachine.debugger === a && s.debugger === a);
}
{
  const s = mk(); const d = s.debug; d.addBreakpoint(0x3000); d.addWatchpoint(0x4000, 1);
  s.install(s.shownMachine); s.install(s.shownMachine);
  check('install(m) twice with the same machine keeps its debugger, its breakpoints and one set of taps',
    s.debugger === d && s.shownMachine.debugger === d && d.attached && bps(d) === '12288' && taps(s.shownMachine) === '1r/1w', `${taps(s.shownMachine)} ${bps(d)}`);
}
{
  const s = mk(); const d = s.debug; d.addBreakpoint(0x3000); d.addWatchpoint(0x4000, 1);
  const m = s.shownMachine;
  s.adopt(m);
  check('adopt(the machine already shown) keeps its debugger, its breakpoints and one set of taps (no fresh one)',
    s.debug === d && d.attached && bps(d) === '12288' && taps(m) === '1r/1w' && m.debugger === d, `${taps(m)} bps=${bps(s.debug)}`);
}

// ---- a snapshot opened while the Debugger is open ----
{
  const s = mk(); const d = s.debug; d.addBreakpoint(0x3000); d.addWatchpoint(0x4000, 1);
  const old = s.shownMachine;
  s.openSnapshot(old.snapshot());
  const nm = s.shownMachine;
  check('a snapshot opened with the Debugger open: the old machine\'s debugger is detached and its taps released', !d.attached && taps(old) === '0r/0w' && old.debugger === null, `${taps(old)} attached=${d.attached}`);
  check('... the restored machine has one debugger (its snapshot\'s breakpoints and watchpoint), and it is the Session\'s',
    nm !== old && nm.debugger && s.debugger === nm.debugger && nm.debugger !== d && bps(s.debugger) === '12288' && s.debugger.watchpoints().length === 1 && taps(nm) === '1r/1w', `${taps(nm)} bps=${bps(s.debugger)}`);
  check('... and it shows the Session\'s labels (the Session\'s symbols, as for one it made itself)', s.debugger._symbols !== null && typeof s.debugger._symbols === 'function');
  const lone = s.debug;
  check('... and session.debug gives that same one (no second is made)', lone === nm.debugger && taps(nm) === '1r/1w');
}
{
  const s = mk(); const clean = s.shownMachine.snapshot();
  const d = s.debug; d.addBreakpoint(0x3100); d.addWatchpoint(0x4100, 1);
  const old = s.shownMachine;
  s.openSnapshot(clean);
  check('a snapshot with no debugger section opened with the Debugger open: the open debugger is gone, none left attached anywhere',
    s.debugger === null && s.shownMachine.debugger === null && !d.attached && taps(old) === '0r/0w' && taps(s.shownMachine) === '0r/0w', `${taps(old)} ${taps(s.shownMachine)}`);
  const fresh = s.debug;
  check('... and session.debug then makes a fresh one with no breakpoints', fresh !== d && fresh.attached && fresh.bps.size === 0 && fresh.watchpoints().length === 0 && s.shownMachine.debugger === fresh);
}

// ---- a machine switch, and back ----
{
  const s = mk('dragon64'); const d = s.debug; d.addBreakpoint(0x3000); d.addWatchpoint(0x4000, 1);
  const m64 = s.shownMachine;
  s.switchMachine('coco', {}, { menu: false });
  check('a switch away detaches the debugger and releases the old machine\'s taps', !d.attached && taps(m64) === '0r/0w' && m64.debugger === null && s.debugger === null, `${taps(m64)}`);
  const dc = s.debug; dc.addBreakpoint(0x3200);
  s.switchMachine('dragon64', {}, { menu: false });
  check('... and back: the CoCo\'s is detached too, and the new machine has none until asked',
    !dc.attached && s.debugger === null && s.shownMachine.debugger === null && taps(s.shownMachine) === '0r/0w');
  const again = s.debug;
  check('... then session.debug makes a fresh one on it (the breakpoints do not follow a machine)', again !== d && again.attached && again.bps.size === 0);
}

// ---- a debugger made directly on a machine that has one replaces it ----
{
  const s = mk(); const d1 = s.debug; d1.addWatchpoint(0x4000, 1); d1.addBreakpoint(0x3000);
  const m = s.shownMachine;
  const d2 = new Emu.Debugger(m);
  check('new Debugger(m) on a machine that has one takes its place: the old is detached, only the new is attached, one set of taps (none until a watchpoint)',
    !d1.attached && d2.attached && m.debugger === d2 && taps(m) === '0r/0w', `${taps(m)} d1=${d1.attached} d2=${d2.attached}`);
  check('... and it is the Session\'s from then on (session.debugger and session.debug are the machine\'s)', s.debugger === d2 && s.debug === d2);
  d2.addWatchpoint(0x4000, 1);
  m.write(0x4000, 1);
  check('... a write to a watched byte is seen once, by the one debugger (the replaced one\'s taps are gone)', !!d2.hit && d1.hit === null && taps(m) === '1r/1w', `d1.hit=${!!d1.hit} d2.hit=${!!d2.hit} ${taps(m)}`);
  d2.addBreakpoint(0x3300);
  const st = m.saveState();
  check('... the snapshot carries the debugger the Session drives', JSON.stringify(st.debugger.breakpoints) === JSON.stringify([0x3300]) && bps(s.debugger) === '13056', JSON.stringify(st.debugger.breakpoints));
  s.switchMachine('coco', {}, { menu: false });
  check('... a switch away leaves no orphan: nothing holds a tap on the old machine', !d2.attached && taps(m) === '0r/0w' && m.debugger === null, `${taps(m)}`);
}
{
  // twice in a row, and with a debugger the Session never saw
  const s = mk(); const m = s.shownMachine;
  const d0 = new Emu.Debugger(m); d0.addBreakpoint(0x3000); d0.addWatchpoint(0x4000, 1);
  check('a debugger made directly on a machine the Session has not asked about is the Session\'s: session.debug returns it (breakpoints and all), no second is made',
    s.debug === d0 && d0.attached && bps(d0) === '12288' && taps(m) === '1r/1w', `${taps(m)}`);
  const d3 = new Emu.Debugger(m), d4 = new Emu.Debugger(m);
  check('a third and a fourth in a row each replace the last: one attached, no taps held by the replaced', [d0, d3].every((x) => !x.attached) && d4.attached && m.debugger === d4 && taps(m) === '0r/0w' && s.debugger === d4, taps(m));
}
{
  const s = mk(); const m = s.shownMachine;
  const d = new Emu.Debugger(m);
  s.labels = new Map([['MAIN', 0x3000]]);
  const got = s.debug;
  check('session.debug gives a machine-carried debugger the Session\'s labels when it has none', got === d && d._symbols !== null && [...(typeof d._symbols === 'function' ? d._symbols() : d._symbols).keys()].join() === 'MAIN');
  const own = new Map([['OWN', 0x3100]]);
  const s2 = mk(), d2 = new Emu.Debugger(s2.shownMachine, { symbols: own });
  s2.labels = new Map([['MAIN', 0x3000]]);
  check('... and leaves one that has its own symbols alone', s2.debug === d2 && d2._symbols === own);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
