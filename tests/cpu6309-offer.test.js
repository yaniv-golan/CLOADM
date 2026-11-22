// The welcome menu is OFFERED on a 6309 machine, and the example set it loads is the 6809 build.
//
// `?machine=coco3&cpu=6309` once opened on "Welcome: examples/undefined: HTTP 404": the menu's lookups
// (Session.offerMenu, Session.welcomeFile) were keyed by the CPU name, and the table has a 6809 family entry, no
// 6309 one (ds/cpu6309-welcome fixed it by looking up the CPU's family). tests/cpu6309-session.test.js proves
// that the menu, LIZA and the demo RUN on a 6309 once started, always with { menu: false }; what it does not
// cover is the OFFER: switching to a 6309 machine, with no ROMs, emits ('menu', 'back') so the page starts the
// menu, and the file it fetches for the 6309 is examples/welcome.bin, the 6809 build, which exists.
//
// Offering is Session.offerMenu's rule (a stub machine, the menu not turned off by an embed, a family with a
// welcome build); the page's part (fetch the file, start it) is in js/ui/welcome.js and is covered by the browser
// check (cpu6309 group, and the literal ?machine=coco3&cpu=6309 link). The models with a 6309 option come from
// the profiles, so a new one is covered without an edit here.
// Run: node tests/cpu6309-offer.test.js
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };
const ROOT = path.join(__dirname, '..');
const store = () => { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: (k) => m.delete(k), keys: () => [...m.keys()] }; };
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };
// the 'menu' events a session emits while `fn` runs, as the page sees them (arg undefined = after a goodbye)
const menusDuring = (s, fn) => { const got = []; s.on((e, arg) => { if (e === 'menu') got.push(arg || 'bye'); }); fn(); return got; };

const with6309 = Object.values(Emu.profiles).filter((p) => p.options && p.options.cpu && p.options.cpu.values.includes('6309')).map((p) => p.id);
check('the CoCo 3 is among the models with a 6309 option', with6309.includes('coco3'), with6309.join(' '));
check('there are at least four models with a 6309 option', with6309.length >= 4, with6309.join(' '));

for (const id of with6309) {
  const tag = `${id} 6309`;

  // switching to the model with the CPU (the Machine tab's choice, a menu: true switch) offers the menu once
  {
    const s = new Emu.Session({ store: store() });
    const events = menusDuring(s, () => s.switchMachine(id, { cpu: '6309' }));
    check(`${tag}: switching to it offers the welcome menu, once, as a return ('menu', 'back')`, events.join() === 'back', events.join());
    check(`${tag}: it is the 6309 on the stub firmware (no ROMs): what the menu is offered for`, s.shownMachine.config.cpu === '6309' && s.shownMachine.useStub === true,
      `${s.shownMachine.config.cpu} stub ${s.shownMachine.useStub}`);
  }

  // the page's own start: the link's switch asks for no menu (menu: false), then the visit offers it
  {
    const s = new Emu.Session({ store: store() });
    const none = menusDuring(s, () => s.switchMachine(id, { cpu: '6309' }, { menu: false }));
    check(`${tag}: a switch with menu: false offers nothing by itself (the page's start decides)`, none.length === 0, none.join());
    const offered = menusDuring(s, () => s.offerMenu());
    check(`${tag}: offerMenu() then offers it: ('menu', 'back')`, offered.join() === 'back', offered.join());
  }

  // the build it fetches: the 6809 one, an existing file, the very file a 6809 machine of this model gets
  {
    const s = new Emu.Session({ store: store() }), s6809 = new Emu.Session({ store: store() });
    s.switchMachine(id, { cpu: '6309' }, { menu: false });
    s6809.switchMachine(id, { cpu: '6809' }, { menu: false });
    const file = s.welcomeFile;
    check(`${tag}: the file the page fetches is examples/welcome.bin, not "undefined"`, file === 'welcome.bin', String(file));
    check(`${tag}: ... the same file the 6809 ${id} gets`, file === s6809.welcomeFile, `${file} vs ${s6809.welcomeFile}`);
    check(`${tag}: ... and it exists in examples/`, !!file && fs.existsSync(path.join(ROOT, 'examples', file)), String(file));
    // the offered menu, started as the page does with what it fetched, is on screen on the 6309
    const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples', file)));
    s.startWelcome(bytes, { greeting: 'back', carryOn: null });
    frames(s, 50);
    const t = s.screenText();
    check(`${tag}: the file starts as the welcome menu on the 6309 ("1 TALK TO LIZA", "PRESS 1 TO 5")`,
      s.welcomeRunning && /1 TALK TO LIZA/.test(t[8]) && /PRESS 1 TO 5/.test(t[14]), JSON.stringify(t.slice(8, 15)));
  }

  // no offer where it is not wanted: an embed turns the menu off, and a machine with ROMs is not on the stub
  {
    const embed = new Emu.Session({ store: store(), welcomeMenu: false });
    const e1 = menusDuring(embed, () => embed.switchMachine(id, { cpu: '6309' }));
    check(`${tag}: an embedded session (welcomeMenu: false) is not offered the menu`, e1.length === 0, e1.join());
    const s = new Emu.Session({ store: store() });
    s.switchMachine(id, { cpu: '6309' }, { menu: false });
    // as if its ROMs were loaded: every required slot holds an image (zeros, a stand-in; these tests ship and use no ROM)
    for (const slot of s.shownMachine.profile.roms) if (slot.required) s.shownMachine.roms[slot.id] = new Uint8Array(slot.size || 0x4000);
    check(`${tag}: (precondition) with a stand-in in every required ROM slot the machine is off the stub`, s.shownMachine.hasRom && !s.shownMachine.useStub);
    const e2 = menusDuring(s, () => s.offerMenu());
    check(`${tag}: a machine that is not on the stub firmware is not offered the menu`, e2.length === 0, e2.join());
  }
}

// the CPU lookups the offer relies on: 6309 is the 6809 family, 6803 is its own
check('the offer needs a welcome build for the 6309: the family table maps 6309 to the 6809 one', Emu.cpuFamily('6309') === '6809' && Emu.cpuFamily('6803') === '6803' && Emu.cpuFamily('6809') === '6809',
  `${Emu.cpuFamily('6309')} ${Emu.cpuFamily('6803')} ${Emu.cpuFamily('6809')}`);

console.log(fail ? `${fail} FAILED` : 'all 6309 welcome offer checks passed');
process.exitCode = fail ? 1 : 0;
