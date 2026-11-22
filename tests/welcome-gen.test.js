// The welcome generation ticket: a start whose bytes were overtaken must be refused, but the start itself must
// NOT invalidate its own ticket. startWelcome -> runWithoutRoms -> powerCycle calls endWelcome(), which bumps the
// ticket the caller just took, so a start on a machine that is not yet on the stub returns null and the menu never
// appears (measured: after a machine switch, the visit check waits 30 s for "PRESS 1 TO 5" and never sees it).
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const welcome = (file) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples', file)));

const session = () => {
  const s = new Emu.Session({ store: Emu.memoryStore(), media: new MemoryMediaStore() });
  s.switchMachine('dragon64');
  return s;
};

// 1. the plain first start: the ticket taken before the bytes is still good when they arrive
{
  const s = session();
  const gen = s.welcomeGenNow();
  const msg = s.startWelcome(welcome('welcome.bin'), { greeting: 'first', gen });
  check('welcome gen: a start with the current ticket starts the menu', msg !== null && s.welcomeRunning, String(msg));
}

// 2. RED before the fix: a start AFTER a machine switch. The page takes the ticket, the switch adopts the new
// machine (bumping it), then the bytes arrive. The switch is the thing that must cancel an OLD start -- but the
// ticket must be taken AFTER it, which is what the page does; here the page's order is reproduced exactly.
{
  const s = session();
  s.switchMachine('coco');                 // adopt() bumps the ticket
  const gen = s.welcomeGenNow();           // the page takes it now (runWelcome does this after the switch)
  const msg = s.startWelcome(welcome('welcome.bin'), { greeting: 'first', gen });
  check('welcome gen: a start taken after a machine switch starts the menu', msg !== null && s.welcomeRunning, String(msg));
}

// 3. a start on a machine that is NOT yet on the stub (the visit check's exact shape): startWelcome itself powers
// the machine without ROMs, which calls endWelcome -> the ticket would be bumped under its own feet
{
  const s = session();
  s.runWithoutRoms({ menu: false });       // put it on BASIC first, as a machine with stored ROMs would be
  const gen = s.welcomeGenNow();
  const msg = s.startWelcome(welcome('welcome.bin'), { greeting: 'first', gen });
  check('welcome gen: a start that powers the machine without ROMs itself still starts', msg !== null && s.welcomeRunning, String(msg));
}

// 4. the rule the ticket exists for: a start whose bytes were overtaken IS refused
{
  const s = session();
  const gen = s.welcomeGenNow();
  s.switchMachine('coco');                 // something else took the machine while the bytes were in flight
  const msg = s.startWelcome(welcome('welcome.bin'), { greeting: 'first', gen });
  check('welcome gen: a start overtaken by a machine switch is refused', msg === null && !s.welcomeRunning, String(msg));
}

// 5. and the same for a program loaded while the bytes were in flight
{
  const s = session();
  const gen = s.welcomeGenNow();
  s.load('mine.bin', Emu.toBinary(Emu.assemble(' ORG $3000\nL BRA L\n END', '6809'), { format: 'dragondos' }));
  const msg = s.startWelcome(welcome('welcome.bin'), { greeting: 'first', gen });
  check('welcome gen: a start overtaken by a load is refused', msg === null && !s.welcomeRunning, String(msg));
}

console.log(fail ? `${fail} FAILED` : 'all welcome-gen checks passed');
process.exitCode = fail ? 1 : 0;
