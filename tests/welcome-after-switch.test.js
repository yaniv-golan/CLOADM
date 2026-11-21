// After a machine switch the menu starts TWICE: once from switchMachine's offerMenu (the 'menu' event, which
// builds its carry-on from session.carryOn) and once from the page's own runWelcome() in the askMachine handler,
// which passes carryOn: null. On main the second start wins and the menu reads "PRESS 1 TO 5". With the welcome
// generation ticket the second start shares the ticket the first one bumped, so it is REFUSED and the first stays,
// reading "PRESS 1 TO 6" (the colour demo's carry-on).
//
// The question this test settles: which start is the RIGHT one? The page's own (carryOn: null) is the intended
// one -- offerMenu's comes from a 'menu' event emitted inside switchMachine, before the page has decided anything.
// So a start must not be refused merely because an EARLIER start in the same turn bumped the ticket.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const welcome = new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples/welcome.bin')));

const s = new Emu.Session({ store: Emu.memoryStore(), media: new MemoryMediaStore() });
s.switchMachine('dragon64');
// what the menu shows after a start: the prompt row says the count of options, so 6 means a carry-on line was
// drawn and 5 means none
// the prompt is drawn when the welcome program next runs: run it on to a frame boundary first
const prompt = (sess = s) => { sess.runFrames(60); return (sess.screenText()[14] || "").trim(); };   // the stub reaches the menu in ~40

// 1. a plain start with no carry-on: PRESS 1 TO 5
{
  const gen = s.welcomeGenNow();
  s.startWelcome(welcome, { greeting: 'first', gen });
  check('welcome: a menu with no carry-on says PRESS 1 TO 5', prompt() === 'PRESS 1 TO 5', prompt());
}

// 2. the machine question's switch (Session.chooseMachine): the menu is offered ONCE, saying it wants no
// carry-on, even though the Session HAS one for what ran on the old machine. There used to be a second start from
// the page, with a different carry-on, and which won was an accident ("PRESS 1 TO 6" after the ticket landed).
{
  const s2 = new Emu.Session({ store: Emu.memoryStore(), media: new MemoryMediaStore() });
  s2.switchMachine('dragon64');
  const demo = new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples/demo.bin')));
  s2.load('demo.bin', demo, { remember: false });
  s2.setLastRun('demo', 'Colour demo');
  check('welcome: the Session has a carry-on for the old machine\'s demo',
    JSON.stringify(s2.carryOn) === '{"kind":"demo","name":"Colour demo"}', JSON.stringify(s2.carryOn));
  const offered = [];
  s2.on((ev, arg) => { if (ev === 'menu') offered.push(arg); });
  s2.chooseMachine('coco');
  check('welcome: the machine question offers the menu ONCE, and without a carry-on',
    offered.length === 1 && offered[0] === 'none', JSON.stringify(offered));
  // what the page does from that one offer
  s2.startWelcome(welcome, { greeting: 'back', carryOn: null });
  check('welcome: and the menu it starts says PRESS 1 TO 5 (no carry-on line)', prompt(s2) === 'PRESS 1 TO 5', prompt(s2));
}

// 3. the rule the ticket exists for still holds: a start overtaken by something the page did NOT ask for is refused
{
  const s3 = new Emu.Session({ store: Emu.memoryStore(), media: new MemoryMediaStore() });
  s3.switchMachine('dragon64');
  const gen = s3.welcomeGenNow();
  s3.load('mine.bin', Emu.toBinary(Emu.assemble(' ORG $3000\nL BRA L\n END', '6809')));
  const r = s3.startWelcome(welcome, { greeting: 'first', gen });
  check('welcome: a start overtaken by a load is still refused', r === null && !s3.welcomeRunning, String(r));
}

console.log(fail ? `${fail} FAILED` : 'all welcome-after-switch checks passed');
process.exitCode = fail ? 1 : 0;
