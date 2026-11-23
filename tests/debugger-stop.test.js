// UX ruling R44, the Session's half: a Debugger stop stays until the person resumes it, or a launch releases it.
//  (b4) Reset, a power cycle, a load (a program, a tape, the welcome menu, LIZA, a game) and a machine switch each
//       release the stop (debugger.stopped false), keep the breakpoints, and emit ('released', pc) once.
//  (b3) The status line says "Stopped in the Debugger" or "Paused" in place of the speed.
//  (b5) The person's typing while stopped is refused (typeText returns 0 and queues nothing); 'typing-refused' is
//       emitted once per stop; after Resume typing works again.
// The page's half (the strip, the Pause button, the status line, the toasts) is the browser check's debuggerScreen
// group (debuggerStopChecks).
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const bin = (file) => new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'examples', file)));
const run = (s, ms = 100) => { let t = 0; return s.advance(ms, { now: () => (t += 0.001) }); };
// a session on the no-ROM stub running LIZA, stopped by the Debugger with a breakpoint set; events recorded
const stopped = () => {
  const s = new Emu.Session({ store: Emu.memoryStore(), media: new MemoryMediaStore() });
  s.switchMachine('dragon64', null, { menu: false });
  s.runLiza(bin('liza.bin'));
  run(s, 200);
  s.debug.addBreakpoint(0xBFF0);   // (never reached: it only has to survive the release)
  s.debug.halt();
  const events = [];
  s.on((ev, arg) => events.push([ev, arg]));
  return { s, events, pc: s.debug.pc };
};
const released = (events) => events.filter(([ev]) => ev === 'released');

for (const [what, act] of [
  ['Reset', (s) => s.reset()],
  ['a power cycle', (s) => s.powerCycle({ menu: false })],
  ['a load (a .bin)', (s) => s.load('prog.bin', new Uint8Array([0x55, 2, 0x30, 0x00, 0x00, 0x02, 0x30, 0x00, 0xAA, 0x20, 0xFE]), { remember: false })],
  ['LIZA from the shelf', (s) => s.runLiza(bin('liza.bin'))],
  ['the welcome menu', (s) => s.startWelcome(bin('welcome.bin'), { greeting: 'back', gen: s.welcomeGenNow() })],
]) {
  const { s, events, pc } = stopped();
  const before = s.debug.stopped && s.paused;
  act(s);
  const r = released(events);
  check(`R44 b4: ${what} releases a Debugger stop`, before && !s.debug.stopped && !s.paused, JSON.stringify({ before, stopped: s.debug.stopped }));
  check(`R44 b4: ...says so once, with the PC it was stopped at`, r.length === 1 && r[0][1] === pc, JSON.stringify(r));
  check(`R44 b4: ...and keeps the breakpoints`, s.debug.breakpoints().includes(0xBFF0), JSON.stringify(s.debug.breakpoints()));
  check(`R44 b4: ...emits 'launch' (the page lets go of its own Pause on it)`, events.some(([ev]) => ev === 'launch'));
  check(`R44 b4: ...and the machine runs`, (() => { const f = s.shownMachine.frameCount; run(s); return s.shownMachine.frameCount > f; })());
}
{
  const { s, events, pc } = stopped();
  s.switchMachine('coco', null, { menu: false });
  const r = released(events);
  check('R44 b4: a machine switch releases the stop (the Debugger goes with the machine) and says so', !s.paused && r.length === 1 && r[0][1] === pc, JSON.stringify(r));
}
{
  // nothing stopped: a launch says nothing
  const s = new Emu.Session({ store: Emu.memoryStore(), media: new MemoryMediaStore() });
  s.switchMachine('dragon64', null, { menu: false });
  const events = [];
  s.on((ev) => events.push(ev));
  s.debug; s.reset();
  check('R44 b4: a launch with no stop releases nothing (launch, no released)', events.includes('launch') && !events.includes('released'), events.join());
}

// b3: the status line says stopped or paused in place of the speed
{
  const { s } = stopped();
  check('R44 b3: stopped, the status line reads "Stopped in the Debugger", no fps', /^Stopped in the Debugger/.test(s.statusLine(50)) && !/fps/.test(s.statusLine(50)), s.statusLine(50));
  s.resume();
  check('R44 b3: the page\'s Pause: "Paused", no fps', /^Paused/.test(s.statusLine(0, true)) && !/fps/.test(s.statusLine(0, true)), s.statusLine(0, true));
  check('R44 b3: running: the speed', /^50 fps · 100%/.test(s.statusLine(50)), s.statusLine(50));
  check('R44 b3: running again, the speed not measured yet: "Running", nothing from before the stop', /^Running/.test(s.statusLine(null)), s.statusLine(null));
}

// b5: typing while stopped
{
  const { s, events } = stopped();
  const m = s.shownMachine, keys = m.stubKeys.length;
  const n = [s.typeText('A'), s.typeText('B'), s.typeText('C')];
  const told = events.filter(([ev]) => ev === 'typing-refused').length;
  check('R44 b5: three keys typed while stopped are refused: nothing queued', n.every((x) => x === 0) && m.stubKeys.length === keys, JSON.stringify({ n, keys, now: m.stubKeys.length }));
  check('R44 b5: ...and the person is told once for the stop', told === 1, String(told));
  s.resume();
  run(s);
  check('R44 b5: ...after Resume nothing typed while stopped arrives', m.stubKeys.length === keys);
  check('R44 b5: ...and typing goes in again', s.typeText('D') === 1 && m.stubKeys.length === keys + 1);
  s.debug.halt();
  s.typeText('E');
  check('R44 b5: a new stop tells again, once', events.filter(([ev]) => ev === 'typing-refused').length === 2);
}

// b4: a load is a launch only once it is accepted. A refused one leaves the stop (and the page's Pause) as it was.
for (const [what, name, bytes] of [
  ['a .wav that is no recording', 'noise.wav', new Uint8Array(64).fill(0x41)],
  ['a BASIC listing on a machine with no BASIC ROM', 'prog.bas', new TextEncoder().encode('10 PRINT "HI"\n20 GOTO 10\n')],
]) {
  const { s, events, pc } = stopped();
  let threw = null;
  try { s.load(name, bytes, { remember: false }); } catch (e) { threw = e; }
  check(`R44 b4: ${what} is refused`, threw instanceof Emu.SessionError, String(threw));
  check(`R44 b4: ...and keeps the stop where it was: no 'released', no 'launch'`, s.paused && s.debug.pc === pc
    && !events.some(([ev]) => ev === 'released' || ev === 'launch'), JSON.stringify(events.map(([ev]) => ev)));
}
// b4: a launch on ANOTHER machine leaves this machine's stop in place (a power cycle of another machine: the chat's
// own power, or a load's target that is not the machine on screen)
{
  const { s, events, pc } = stopped();
  const other = s.shownMachine;
  s.switchMachine('coco', null, { menu: false });   // (a fresh machine on screen; the old one is "another machine")
  s.debug.halt();
  events.length = 0;
  s.powerCycle({ menu: false, on: other, reason: 'test' });
  check('R44 b4: a power cycle of another machine leaves the stop on the machine on screen', s.paused && !events.some(([ev]) => ev === 'released'),
    JSON.stringify({ paused: s.paused, events: events.map(([ev]) => ev), pc }));
}

(async () => {
  // b4 (the reviewer's F4): a disk the person puts in - from the Library or a drive's menu (mountDisk), or a drop or
  // Open (importDisk, which mounts) - is a launch, once it is in; a refused mount leaves the stop
  const s = new Emu.Session({ store: Emu.memoryStore(), media: new MemoryMediaStore() });
  await s.ready();
  s.switchMachine('dragon64', null, { menu: false });
  s.runLiza(bin('liza.bin'));
  run(s, 200);
  const disk = Emu.blankDisk('vdk', 40, 1);
  await s.importDisk('stored.vdk', disk, 0);
  await s.ejectDisk(0);
  const events = [];
  s.on((ev, arg) => events.push([ev, arg]));
  s.debug.halt();
  let refused = null;
  try { await s.mountDisk(0, 'nosuch.vdk'); } catch (e) { refused = e; }
  check('R44 b4: a refused mount (no such disk) keeps the stop and says nothing', refused instanceof Emu.SessionError && s.paused
    && !events.some(([ev]) => ev === 'released'), String(refused));
  const pc = s.debug.pc;
  await s.mountDisk(0, 'stored.vdk');
  let r = events.filter(([ev]) => ev === 'released');
  check('R44 b4: a disk mounted from the Library (mountDisk) is a launch: the stop is released, once, with its PC', !s.paused && r.length === 1 && r[0][1] === pc, JSON.stringify(r));
  await s.ejectDisk(0);
  s.debug.halt();
  events.length = 0;
  await s.importDisk('dropped.vdk', Emu.blankDisk('vdk', 40, 1), 1);
  r = events.filter(([ev]) => ev === 'released');
  check('R44 b4: a disk dropped or opened (importDisk) is a launch too, released once', !s.paused && r.length === 1, JSON.stringify(r));

  console.log(fail ? `${fail} FAILED` : 'all debugger-stop checks passed');
  process.exitCode = fail ? 1 : 0;
})();
