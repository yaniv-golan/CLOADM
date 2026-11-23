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
const prompt = (sess = s, frames = 60, row = 14) => { sess.runFrames(frames); return (sess.screenText()[row] || "").trim(); };   // the stub reaches the menu in ~40

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
  s2.chooseMachine('coco', { offer: 'none' });   // the machine QUESTION's call (js/ui/welcome.js)
  check('welcome: the machine question offers the menu ONCE, and without a carry-on',
    offered.length === 1 && offered[0] === 'none', JSON.stringify(offered));
  // the machine question appears on a FIRST visit only, so the menu it starts greets a first-time visitor: the
  // title row, not "WELCOME BACK". (main's handler started the menu with runWelcome()'s default greeting, 'first'.)
  // The greeting is BEHAVIOUR, not a string in the page: Session.greetingFor decides it (the page calls it), and
  // the machine question's answer must produce the first-visit screen, not WELCOME BACK.
  check('welcome: the machine question\'s greeting is the first visit\'s', s2.greetingFor('none') === 'first', JSON.stringify(s2.greetingFor('none')));
  check('welcome: and every other offer greets a returning visitor', s2.greetingFor('back') === 'back' && s2.greetingFor(null) === 'back');
  // a visit that began as the browser's first never greets "back" (a machine picked in the header menu, the shelf's
  // Welcome menu): only a later visit does
  const store = Emu.memoryStore();
  const visit1 = new Emu.Session({ store, media: new MemoryMediaStore() });
  check('welcome: the first visit is recognised', visit1.visit().first && visit1.greetingFor('back') === 'first' && visit1.greetingFor(null) === 'first');
  visit1.setLastRun('liza', 'LIZA');
  check('welcome: ...until something has run in it: then the menu greets "back"', visit1.greetingFor('back') === 'back' && visit1.greetingFor('none') === 'first');
  const visit2 = new Emu.Session({ store, media: new MemoryMediaStore() });
  check('welcome: the next visit in that browser is a returning one: "back"', !visit2.visit().first && visit2.greetingFor('back') === 'back' && visit2.greetingFor('none') === 'first');
  s2.startWelcome(welcome, { greeting: s2.greetingFor('none'), carryOn: null });
  check('welcome: the machine question\'s menu shows the first-visit title, not WELCOME BACK',
    prompt(s2, 60, 6) === 'DRAGON AND COLOR COMPUTER', prompt(s2, 60, 6));

  // what the page does from that one offer
  s2.startWelcome(welcome, { greeting: 'back', carryOn: null });
  check('welcome: and the menu it starts says PRESS 1 TO 5 (no carry-on line)', prompt(s2) === 'PRESS 1 TO 5', prompt(s2));
}

// 2b. the HEADER machine menu (and the ROM screen's switch) is NOT the machine question: it keeps the usual offer,
// so a returning visitor still sees "6 CARRY ON WITH ..." there. The machine question is the only caller that asks
// for 'none'.
{
  const s3 = new Emu.Session({ store: Emu.memoryStore(), media: new MemoryMediaStore() });
  s3.switchMachine('dragon64');
  s3.setLastRun('demo', 'Colour demo');
  const offered = [];
  s3.on((ev, arg) => { if (ev === 'menu') offered.push(arg); });
  s3.chooseMachine('coco');               // as the header menu does
  check('welcome: the header machine menu offers the usual menu (the carry-on one)', offered.length === 1 && offered[0] === 'back', JSON.stringify(offered));
}

// 3. the rule the ticket exists for still holds: a start overtaken by something the page did NOT ask for is refused
{
  const s3 = new Emu.Session({ store: Emu.memoryStore(), media: new MemoryMediaStore() });
  s3.switchMachine('dragon64');
  const gen = s3.welcomeGenNow();
  s3.load('mine.bin', Emu.toBinary(Emu.assemble(' ORG $3000\nL BRA L\n END', '6809'), { format: 'dragondos' }));
  const r = s3.startWelcome(welcome, { greeting: 'first', gen });
  check('welcome: a start overtaken by a load is still refused', r === null && !s3.welcomeRunning, String(r));
}

console.log(fail ? `${fail} FAILED` : 'all welcome-after-switch checks passed');
process.exitCode = fail ? 1 : 0;
