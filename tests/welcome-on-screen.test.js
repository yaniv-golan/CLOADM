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

// to the frame the menu is on screen at (the program sets the screen up first: it takes a good number of frames)
const draws = (s) => { for (let i = 0; i < 50 && !s.welcomeOnScreen; i++) run(s); return s.welcomeOnScreen; };

// 1. the welcome program: loaded is not drawn, and a Debugger stop is not running
{
  const s = session();
  s.startWelcome(bin('welcome.bin'), { greeting: 'first', gen: s.welcomeGenNow() });
  check('on screen: the menu just loaded is running (welcomeRunning) but not yet drawn (welcomeOnScreen false)',
    s.welcomeRunning && !s.welcomeOnScreen);
  // frames have run, but the menu is not drawn yet (the screen shows what was there): the tag waits for the menu itself
  check('on screen: ...frames have run but the menu is not drawn yet: not on screen yet', run(s) > 0 && !s.screenText().some((r) => r.includes('PRESS 1 TO')) && !s.welcomeOnScreen);
  check('on screen: ...once the menu is drawn it is on screen', draws(s) && s.screenText().some((r) => r.includes('PRESS 1 TO')));
  s.debug.halt();
  check('on screen: a Debugger stop: still loaded, no longer on screen now', s.paused && s.welcomeRunning && !s.welcomeOnScreen);
  check('on screen: ...and the frame loop runs nothing', run(s) === 0 && !s.welcomeOnScreen);
  // a stop the Debugger made on the menu itself: resumed, it is on screen again at once (frames ran before the stop)
  s.resume();
  check('on screen: resumed, the menu is on screen now again', run(s) > 0 && s.welcomeOnScreen);   // (it was drawn before the stop)
  // the shelf's "Welcome menu" on a stopped machine: a launch, which releases the stop; the
  // menu just loaded is not on screen until its first frame
  s.debug.halt();
  s.startWelcome(bin('welcome.bin'), { greeting: 'back', gen: s.welcomeGenNow() });
  check('on screen: the menu started on a stopped machine releases the stop, and is not on screen until a frame runs',
    s.welcomeRunning && !s.paused && !s.welcomeOnScreen);
  check('on screen: ...and once it is drawn: on screen now', draws(s));
  // a program loaded over it: not the menu
  s.runLiza(bin('liza.bin'));
  check('on screen: LIZA loaded over the menu: neither running nor on screen', !s.welcomeRunning && !s.welcomeOnScreen && run(s) > 0 && !s.welcomeOnScreen);
}

// 1b. the machine clauses: the menu loaded on the person's machine is not "on screen now" while another machine is
// shown (the chat full screen), nor once a machine switch has replaced it
{
  const s = session();
  s.startWelcome(bin('welcome.bin'), { greeting: 'first', gen: s.welcomeGenNow() });
  check('on screen: (before the chat) the menu is on screen now', draws(s));
  s.startChat({ backend: new Emu.ClaudeBackend({ fetch: async () => null, apiKey: 'sk-ant-test' }), channel: new Emu.MemoryChannel(), firmware: bin('chat.bin') });
  run(s);
  check('on screen: the chat full screen: the person\'s menu is still running (welcomeRunning) but not on screen now',
    s.shownMachine !== s.personMachine && s.welcomeRunning && !s.welcomeOnScreen);
}
{
  const s = session();
  s.startWelcome(bin('welcome.bin'), { greeting: 'first', gen: s.welcomeGenNow() });
  run(s);
  const old = s.personMachine;
  s.switchMachine('coco', null, { menu: false });
  run(s);
  // (the switch ends the menu itself - endWelcome - so this guards the natural path; the chat case above is the one
  // only the machine clauses catch)
  check('on screen: after a machine switch the old machine\'s menu is neither running nor on screen now',
    s.personMachine !== old && old.frameCount > 0 && !s.welcomeRunning && !s.welcomeOnScreen);
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

// 3. the program last run is "on screen now" until something takes the machine from it
(async () => {
  const s = session();
  check('running: nothing has run: no program on screen', !s.lastRunOnScreen);
  s.load('mine.bin', bin('minesweeper.bin'));
  check('running: a file loaded from Open… (recorded as what ran last) is on screen now', s.lastRun.kind === 'recent' && s.lastRunOnScreen);
  s.debug.halt();
  check('running: a Debugger stop: not on screen now', s.paused && !s.lastRunOnScreen);
  s.resume();
  check('running: resumed: on screen again', s.lastRunOnScreen);
  s.reset();
  check('running: a reset takes it off the screen', !s.lastRunOnScreen && !!s.lastRun);
  s.load('mine.bin', bin('minesweeper.bin'));
  s.startWelcome(bin('welcome.bin'), { greeting: 'back', gen: s.welcomeGenNow() });
  check('running: the welcome menu takes it off the screen', !s.lastRunOnScreen);
  s.load('mine.bin', bin('minesweeper.bin'));
  s.load('demo.bin', bin('demo.bin'), { remember: false });
  check('running: a file loaded without being remembered (the colour demo) is not the last run: not on screen as it', !s.lastRunOnScreen);
  s.runLiza(bin('liza.bin'));
  check('running: LIZA, recorded after its load, is on screen now', s.lastRun.kind === 'liza' && s.lastRunOnScreen);
  // a snapshot opened over it
  const snap = await s.readSnapshot((await s.snapshotFile()).bytes);
  s.openSnapshot(snap);
  check('running: opening a snapshot takes it off the screen', !s.lastRunOnScreen);
  s.runLiza(bin('liza.bin'));
  s.switchMachine('coco3');
  check('running: a machine switch takes it off the screen', !s.lastRunOnScreen);
})().then(() => {
  console.log(fail ? `${fail} FAILED` : 'all welcome-on-screen checks passed');
  process.exitCode = fail ? 1 : 0;
});
