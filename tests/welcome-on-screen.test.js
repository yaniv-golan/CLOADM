// "On screen now" and "Last time" say what the screen and Run again will truly do.
//  1. Session.welcomeOnScreen (the shelf's "on screen now" tag): the welcome program loaded on the machine on screen,
//     not stopped by the Debugger, and drawn (a frame has run since it was loaded). welcomeRunning only says "loaded":
//     the tag used to follow it, so a menu started on a machine the Debugger had stopped was "on screen now" while the
//     screen showed what was there before.
//  2. setLastRun emits 'lastrun': runLiza and runGame record themselves AFTER their load emitted 'loaded', so a view
//     that refreshed on 'loaded' named the program before (the Media tab's "Last time" while Run again ran the new one).
// The page side (the tag, the canvas, the card) is the browser check's returning group (onScreenChecks).
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const bin = (file) => new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'examples', file)));
const session = () => {
  const s = new Emu.Session({ store: Emu.memoryStore(), media: new MemoryMediaStore() });
  s.switchMachine('dragon64');
  return s;
};
// the page's frame loop, by hand: 100 ms at a time (a few frames), with a clock of its own
const run = (s, ms = 100) => { let t = 0; return s.advance(ms, { now: () => (t += 0.001) }); };

// 1. the welcome program: loaded is not drawn, and a Debugger stop is not running
{
  const s = session();
  s.startWelcome(bin('welcome.bin'), { greeting: 'first', gen: s.welcomeGenNow() });
  check('on screen: the menu just loaded is running (welcomeRunning) but not yet drawn (welcomeOnScreen false)',
    s.welcomeRunning && !s.welcomeOnScreen);
  check('on screen: ...a frame later it is drawn and on screen', run(s) > 0 && s.welcomeOnScreen);
  s.debug.halt();
  check('on screen: a Debugger stop: still loaded, no longer on screen now', s.paused && s.welcomeRunning && !s.welcomeOnScreen);
  check('on screen: ...and the frame loop runs nothing', run(s) === 0 && !s.welcomeOnScreen);
  // the bug's path: back from the Debugger (still stopped), the shelf's "Welcome menu" starts the menu again
  s.startWelcome(bin('welcome.bin'), { greeting: 'back', gen: s.welcomeGenNow() });
  check('on screen: the menu started on a stopped machine is loaded but not on screen now', s.welcomeRunning && s.paused && !s.welcomeOnScreen);
  s.resume();
  check('on screen: resumed, the first frame draws it: on screen now', !s.welcomeOnScreen && run(s) > 0 && s.welcomeOnScreen);
  // a program loaded over it: not the menu
  s.runLiza(bin('liza.bin'));
  check('on screen: LIZA loaded over the menu: neither running nor on screen', !s.welcomeRunning && !s.welcomeOnScreen && run(s) > 0 && !s.welcomeOnScreen);
}

// 2. 'lastrun' comes after 'loaded', and a view that follows it names what Run again runs
{
  const s = session();
  const events = [];
  let card = null;   // the page's "Last time": refreshed on the events js/ui/welcome.js refreshes it on
  s.on((ev) => { events.push(ev); if (['machine', 'loaded', 'lastrun'].includes(ev)) card = s.lastRun && s.lastRun.name; });
  s.runLiza(bin('liza.bin'));
  check('last run: runLiza emits lastrun after loaded', events.indexOf('lastrun') > events.indexOf('loaded') && events.includes('loaded'), events.join());
  check('last run: after LIZA the card names LIZA', card === 'LIZA' && s.lastRun.kind === 'liza', String(card));
  events.length = 0;
  s.runGame('2048', bin('2048.bin'));
  check('last run: runGame emits lastrun after loaded', events.indexOf('lastrun') > events.indexOf('loaded') && events.includes('loaded'), events.join());
  check('last run: after 2048 the card names 2048, what Run again runs', card === '2048' && s.lastRun.kind === 'game', String(card));
  s.runGame('minesweeper', bin('minesweeper.bin'));
  check('last run: after Minesweeper the card names Minesweeper', card === s.lastRun.name && /mine/i.test(card), String(card));
}

console.log(fail ? `${fail} FAILED` : 'all welcome-on-screen checks passed');
process.exitCode = fail ? 1 : 0;
