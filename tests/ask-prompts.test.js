// Run: node tests/ask-prompts.test.js
//
// The Ask panel's example questions (js/claude/prompts.js), browser-free, no network, no ROMs.
//
// What is proved:
//  * promptsFor: every set's three questions, word for word as the specification gives them (written out here by
//    hand, not taken from the module), and the priority: for every pair of situations, the higher one wins;
//  * promptState on real Sessions: the Debugger stopped, a link arrival (and what ends it: a key, a message, a
//    launch), the welcome menu without and with ROMs for the machine, LIZA, 2048, Minesweeper, the demo, a machine-code
//    program of the person's, and BASIC (our own stand-in firmware in the BASIC socket, BASIC's pointers and CURLIN set
//    up by the test) at its prompt with and without a program, and running one;
//  * promptsNow: the fallback set when reading the state throws (never zero questions).
const fs = require('fs');
const path = require('path');
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const bin = (name) => new Uint8Array(fs.readFileSync(path.join(ROOT, `examples/${name}.bin`)));
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };

// ---- 1. the sets, word for word as specified ----
const SPEC = {
  stopped: ['Why did it stop here?', 'What does this code do?', 'What should I look at next?'],
  link: ['What am I looking at?', 'What can I do here?', 'How do I start this from the beginning?'],
  wyrmfire: ['How do I play this?', 'How does a 3D engine run on a 6809?', 'What are the controls?'],
  'welcome-norom': ['What is this computer?', 'What can I do without ROMs?', 'How do I add my ROMs?'],
  'welcome-rom': ['What is this computer?', 'Help me write my first BASIC program', 'What should I try first?'],
  liza: ['How does LIZA work?', 'Where does LIZA keep what I type?', 'How old is this kind of chatbot?'],
  2048: ['Give me a strategy for 2048', 'How is this game written?', 'Where does it keep the score?'],
  minesweeper: ['How do I play this?', 'How does it place the mines?', 'Where is the board in memory?'],
  demo: ['What are these colours?', 'Which graphics mode is this?', 'How does it make the sound?'],
  code: ['What is this program doing?', "Show me the code that's running now", 'Where does it keep its data?'],
  'basic-program': ['Explain my program', 'Find the bug in my program', 'Add a feature to my program'],
  'basic-empty': ['Help me write a short BASIC program', 'Draw something in colour', 'What can this BASIC do?'],
  'basic-busy': ['What is my program doing right now?', 'How do I stop it?', 'Why is it slow?'],
  fallback: ['What is this machine?', "What's on the screen right now?", 'What can I try here?'],
};
// one state per situation, in priority order (P1 first)
const SITUATIONS = [
  ['stopped', { stopped: true }],
  ['link', { fromLink: true }],
  ['wyrmfire', { program: 'wyrmfire' }],
  ['welcome-norom', { program: 'welcome', roms: false }],
  ['liza', { program: 'liza' }],
  ['2048', { program: '2048' }],
  ['minesweeper', { program: 'minesweeper' }],
  ['demo', { program: 'demo' }],
  ['code', { userCode: true }],
  ['basic-program', { basic: 'prompt', lines: 3 }],
  ['basic-busy', { basic: 'busy', lines: 3 }],
];
{
  const pf = Emu.promptsFor;
  for (const [id, words] of Object.entries(SPEC)) {
    check(`set ${id}: three questions, word for word`, JSON.stringify(Emu.PROMPT_SETS[id]) === JSON.stringify(words), JSON.stringify(Emu.PROMPT_SETS[id]));
  }
  check('no set beyond the specified ones', Object.keys(Emu.PROMPT_SETS).sort().join() === Object.keys(SPEC).sort().join());
  for (const [id, st] of SITUATIONS) check(`promptsFor ${JSON.stringify(st)} -> ${id}`, pf(st).id === id && JSON.stringify(pf(st).prompts) === JSON.stringify(SPEC[id]), pf(st).id);
  check('welcome with ROMs -> welcome-rom', pf({ program: 'welcome', roms: true }).id === 'welcome-rom');
  check('BASIC at the prompt, no program -> basic-empty', pf({ basic: 'prompt', lines: 0 }).id === 'basic-empty');
  check('nothing known -> fallback', pf({}).id === 'fallback' && pf(null).id === 'fallback' && pf({ program: 'something-else' }).id === 'fallback');
  // priority: every situation with every lower one at once still gives its own set (the bundled programs share P4
  // and exclude one another: one program field)
  const p4 = (id) => ['welcome-norom', 'liza', '2048', 'minesweeper', 'demo'].includes(id);
  let pairs = 0, bad = [];
  SITUATIONS.forEach(([hi, a], i) => SITUATIONS.slice(i + 1).forEach(([lo, b]) => {
    if (p4(hi) && p4(lo)) return;
    if (hi === 'basic-program' && lo === 'basic-busy') return;   // (one basic field)
    pairs++;
    const got = pf({ ...b, ...a }).id;
    if (got !== hi) bad.push(`${hi}+${lo}->${got}`);
  }));
  check(`priority: in each of ${pairs} pairs the higher situation wins`, !bad.length && pairs > 40, bad.join(' '));
  check('priority: all at once is the Debugger stop', pf(Object.assign({}, ...SITUATIONS.map(([, st]) => st).reverse())).id === 'stopped');
}

// ---- 2. promptState on real Sessions ----
const START = 0x1E01, FRETOP = 0x7E00, P = 0x19, CURLIN = 0x68;
// our stand-in BASIC (as tests/claude-acting-contract.test.js): idle firmware in the BASIC socket, BASIC's pointers and
// the OK prompt set up by the test, an empty program, and CURLIN $FFFF (direct mode)
function basic() {
  const s = new Emu.Session({ store: Emu.memoryStore() }); s.switchMachine('dragon64');
  const m = s.shownMachine;
  const asm = Emu.assemble(' ORG $8000\nSTART STA $FFC9\n CLR $FF23\n LDA #$F8\n STA $FF22\n LDA #$04\n STA $FF23\n CLR $FF22\nIDLE BRA IDLE\n', '6809');
  const rom = new Uint8Array(0x4000).fill(0xFF); rom.set(asm.segments[0].data, 0);
  m.setRoms({ basic: rom }); m.reset(true); m.cpu.jump(asm.exec);
  const w = (a, v) => s.pokeBytes(a, [v >> 8, v & 0xFF], m);
  s.pokeBytes(START - 1, [0, 0, 0], m);
  w(P, START); w(P + 2, START + 2); w(P + 4, START + 2); w(P + 6, START + 2); w(P + 8, FRETOP);
  w(CURLIN, 0xFFFF);
  for (let i = 0; i < 512; i++) m.ram[0x400 + i] = 0x60;
  m.ram[0x400 + 64] = 0x0F; m.ram[0x400 + 65] = 0x0B;   // "OK"
  frames(s, 3);
  return s;
}
const stub = () => { const s = new Emu.Session({ store: Emu.memoryStore() }); s.switchMachine('dragon64'); frames(s, 40); return s; };
const id = (s) => Emu.promptsNow(s).id;
{
  const s = stub();
  check('ROM-less machine at the stub\'s prompt: the fallback', id(s) === 'fallback', JSON.stringify(Emu.promptState(s)));
  s.debug.halt();
  check('the Debugger stopped: stopped', s.paused && id(s) === 'stopped');
  s.resume();
  check('resumed: the fallback again', id(s) === 'fallback');
}
{
  const s = stub();
  const events = [];
  s.on((e) => events.push(e));
  s.arriveByLink();
  check('a link arrival: link, and the Session says so (\'link\')', id(s) === 'link' && events.includes('link'));
  s.personInput();
  check('the person\'s first key ends it', !s.linkArrival && id(s) === 'fallback');
  s.arriveByLink();
  s.leaveLinkArrival();   // (what the chat's ask does with the first message)
  check('a message ends it', !s.linkArrival);
  s.arriveByLink();
  s.reset();
  check('a reset (a launch) ends it', !s.linkArrival);
  s.arriveByLink();
  s.powerCycle();
  check('Start over (a launch) ends it', !s.linkArrival);
  s.arriveByLink();
  s.load('liza.bin', bin('liza'), { remember: false });
  check('a load ends it', !s.linkArrival);
  s.arriveByLink();
  s.switchMachine('coco2');
  check('a switch ends it', !s.linkArrival);
  s.arriveByLink();
  s.debug.halt();
  check('the Debugger stop outranks the link', id(s) === 'stopped');
}
{
  const s = stub();
  s.startWelcome(bin('welcome'), { greeting: 'back' });
  frames(s, 5);
  check('the welcome menu, no ROMs for this machine: welcome-norom', s.bundledProgram === 'welcome' && id(s) === 'welcome-norom', id(s));
  // the ROM library says this machine's ROMs would start BASIC (no ROM is used: the library's answer is stood in for)
  const real = s.machineRoms.bind(s);
  s.machineRoms = (mid) => Object.assign(real(mid), { bootable: true });
  check('the welcome menu with ROMs for this machine: welcome-rom', id(s) === 'welcome-rom', id(s));
  s.machineRoms = real;
  s.runLiza(bin('liza'));
  frames(s, 5);
  check('LIZA: liza', s.bundledProgram === 'liza' && id(s) === 'liza', id(s));
  s.runGame('2048', bin('2048'));
  frames(s, 5);
  check('2048: the 2048 set', s.bundledProgram === '2048' && id(s) === '2048', id(s));
  s.runGame('minesweeper', bin('minesweeper'));
  frames(s, 5);
  check('Minesweeper: minesweeper', s.bundledProgram === 'minesweeper' && id(s) === 'minesweeper', id(s));
  // the demo, as the page starts it (js/ui/welcome.js): a load, then the last run
  s.load('demo.bin', bin('demo'), { remember: false });
  s.setLastRun('demo', 'Colour demo');
  frames(s, 5);
  check('the demo: demo', s.bundledProgram === 'demo' && id(s) === 'demo', id(s));
  s.reset();
  frames(s, 5);
  check('a reset ends the bundled program', s.bundledProgram === null && id(s) !== 'demo', id(s));
}
{
  const s = stub();
  s.runAssembled(Emu.assemble(' ORG $3000\nLOOP INC $0400\n BRA LOOP\n', '6809'));
  frames(s, 3);
  check('a machine-code program of the person\'s (running from RAM): code', id(s) === 'code', `${id(s)} pc=${s.shownMachine.cpu.pc.toString(16)}`);
}
{
  const s = basic();
  check('BASIC at the prompt, no program: basic-empty', id(s) === 'basic-empty', JSON.stringify(Emu.promptState(s)));
  // a two-line program, laid out as BASIC keeps it: link, line number, tokens, 0
  const m = s.shownMachine, w = (a, v) => s.pokeBytes(a, [v >> 8, v & 0xFF], m);
  const l1 = START, l2 = l1 + 7, end = l2 + 7;
  s.pokeBytes(l1, [l2 >> 8, l2 & 0xFF, 0, 10, 0x87, 0x31, 0], m);   // 10 PRINT1
  s.pokeBytes(l2, [end >> 8, end & 0xFF, 0, 20, 0x81, 0x31, 0], m);  // 20 GOTO1 (the bytes need not be sense)
  s.pokeBytes(end, [0, 0], m);
  w(P + 2, end + 2); w(P + 4, end + 2); w(P + 6, end + 2);
  check('BASIC at the prompt with a program: basic-program', id(s) === 'basic-program' && Emu.promptState(s).lines === 2, JSON.stringify(Emu.promptState(s)));
  w(CURLIN, 10);
  check('BASIC running line 10 (CURLIN): basic-busy', id(s) === 'basic-busy');
  s.debug.halt();
  check('stopped in the Debugger outranks BASIC', id(s) === 'stopped');
  s.resume();
  w(CURLIN, 0xFFFF);
  s.arriveByLink();
  check('a link arrival outranks BASIC', id(s) === 'link');
}
{
  const s = stub();
  const safe = (fn) => { try { return fn(); } catch (e) { return { id: `threw: ${e.message}`, prompts: [] }; } };
  const t = safe(() => Emu.promptsNow(s, { read: () => { throw new Error('broken'); } }));
  check('promptsNow: a reader that throws gives the fallback', t.id === 'fallback', t.id);
  const b = basic();
  b.shownMachine.peek = () => { throw new Error('no memory'); };
  const r = safe(() => Emu.promptsNow(b));
  check('promptsNow: a machine that cannot be read gives the fallback, three questions', r.id === 'fallback' && r.prompts.length === 3, r.id);
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
