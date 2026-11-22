// Run: node tests/liza6803.test.js
// LIZA for the 6803: the MC-10 / Matra Alice build, assembled with the project's own
// 6803 assembler. It must give exactly the same conversation as the 6809 build, character for character,
// read back from screen memory, on the profiles that run a 6803 (mc10 and alice).
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
let fail = 0;
const check = (n, c, d = '') => { if (!c) { fail++; console.log('FAIL', n, d); } else console.log('ok  ', n, d); };

const root = path.join(__dirname, '..');
const INCLUDE = (name) => {
  for (const dir of ['examples', 'tools/asm-tests']) {
    const p = path.join(root, dir, name);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  return null;
};

// ---- assemble both builds ----
const s6809 = Emu.assemble(fs.readFileSync(path.join(root, 'examples/liza.asm'), 'utf8'), '6809', { include: INCLUDE });
check('liza.asm (6809) assembles clean', s6809.ok, s6809.ok ? '' : JSON.stringify(s6809.errors.slice(0, 3)));
// The 6803 build is one per machine: its title names the machine (the same per-machine flags the welcome
// program uses). Both are assembled here; the two images must differ only in the title, checked below.
const src6803 = fs.readFileSync(path.join(root, 'examples/liza6803.asm'), 'utf8');
const build6803 = (id) => Emu.assemble(src6803, '6803', { include: INCLUDE, defines: { MC10: id === 'mc10' ? 1 : 0, ALICE: id === 'alice' ? 1 : 0 } });
const b6803 = { mc10: build6803('mc10'), alice: build6803('alice') };
const s6803 = b6803.mc10;
check('liza6803.asm (6803) assembles clean for both machines', b6803.mc10.ok && b6803.alice.ok,
  [b6803.mc10, b6803.alice].filter((r) => !r.ok).map((r) => JSON.stringify(r.errors.slice(0, 3))).join(' '));
if (!s6803.ok || !b6803.alice.ok || !s6809.ok) { console.log(fail ? `${fail} FAILED` : ''); process.exitCode = 1; return; }   // top-level return: stop here, let Node exit
const imageEnd = Math.max(...s6803.segments.map((s) => s.addr + s.data.length));
const varsEnd = s6803.symbols.get('OUTBUF') + 200;
const size = imageEnd - s6803.segments[0].addr;
console.log(`liza6803: ${size} bytes of code, data and variables from $${s6803.segments[0].addr.toString(16)} ` +
  `to $${(varsEnd - 1).toString(16)}, exec $${s6803.exec.toString(16)}`);
console.log(`liza (6809): ${Emu.toBinary(s6809, { format: 'dragondos' }).length} bytes as a DragonDOS file`);

// the 6803 build must be the shared data file plus the MC-10 code, not a copy of the tables
check('the 6803 build includes the shared keyword/reply data file', INCLUDE('liza-data.inc') !== null);
const dataInc = INCLUDE('liza-data.inc') || '';
check('both builds read their keywords, replies and swaps from that file',
  /INCLUDE\s+"liza-data\.inc"/.test(fs.readFileSync(path.join(root, 'examples/liza.asm'), 'utf8')) &&
  /INCLUDE\s+"liza-data\.inc"/.test(fs.readFileSync(path.join(root, 'examples/liza6803.asm'), 'utf8')));
check('the tables appear once, in the data file', /^KEYTAB/m.test(dataInc) && /^RTAB/m.test(dataInc) &&
  !/^KEYTAB/m.test(fs.readFileSync(path.join(root, 'examples/liza.asm'), 'utf8')));

// ---- the per-machine title, and the two builds differ in nothing else ----
// The title names the machine the build runs on. Both titles are the same length with the 0 terminator at the
// same offset, so the two images are the same size and differ ONLY in the name: any other difference would be
// a mistake in the split. The title is read from the assembled bytes (FCB "LIZA - A ... THERAPIST",0), not
// from the source, so it is what the machine would print.
const title = (asm) => {
  const a = asm.symbols.get('TITLE'), body = Emu.toBinary(asm, { format: 'dragondos' });
  const start = 9 + a - asm.segments[0].addr;     // past the MLOAD header
  let s = '';
  for (let i = start; body[i]; i++) s += String.fromCharCode(body[i]);
  return s;
};
const TITLES = { mc10: 'LIZA - AN MC-10 THERAPIST', alice: 'LIZA - AN ALICE THERAPIST' };
for (const id of ['mc10', 'alice']) check(`${id}: the title names the machine`, title(b6803[id]) === TITLES[id], JSON.stringify(title(b6803[id])));
{
  const a = Emu.toBinary(b6803.mc10, { format: 'dragondos' }), b = Emu.toBinary(b6803.alice, { format: 'dragondos' });
  const diff = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diff.push(i);
  // "MC-10" vs "ALICE" inside "LIZA - AN ... THERAPIST",0: the MC-10 build is byte-identical to the pre-split
  // single build (same length, same title), and the Alice build differs only in the name - 5 bytes
  check('the two machine builds are the same length', a.length === b.length, `${a.length} ${b.length}`);
  check('the two machine builds differ only in the title name', diff.length === 5 && diff[diff.length - 1] - diff[0] < 6,
    `${diff.length} bytes differ at ${diff[0].toString(16)}..${diff[diff.length - 1].toString(16)}`);
}

// Each response list is count, next index, then the pointers (see the data file). RESPN3 writes the
// "next index" byte at list+1; that one byte per list is the program's own state.
const ROTATION = new Set([...s6803.symbols].filter(([name]) => /^R_[A-Z]/.test(name)).map(([, addr]) => addr + 1));

// ---- run a scripted conversation on a machine and read the screen back ----
// The screen is 32x16 at the profile's textScreen; LIZA's own cursor is the current cell so it is drawn
// as '#', exactly like the 6809 build does on the Dragon.
function screenOf(m) {
  const base = m.profile.textScreen || 0x400, out = [];   // the Session's default for the Dragon/CoCo
  for (let r = 0; r < 16; r++) {
    let l = '';
    for (let c = 0; c < 32; c++) {
      const v = m.ram[base + r * 32 + c], ch = v & 0x3F;
      l += v & 0x80 ? '#' : String.fromCharCode(ch < 0x20 ? ch + 0x40 : ch);
    }
    out.push(l.replace(/\s+$/, ''));
  }
  return out;
}
const flat = (lines) => lines.join(' ').replace(/#/g, '').replace(/ +/g, ' ').trim();

// type a line the way the stub keyboard delivers it: one key code per frame, then let LIZA answer
function say(m, text) {
  for (const ch of (text + '\r').toUpperCase()) { m.stubKeys.push(ch.charCodeAt(0)); m.runFrame(); m.runFrame(); }
  for (let i = 0; i < 30; i++) m.runFrame();
  return screenOf(m);
}

const CONVERSATION = [
  ['Hello', 'HELLO. WHAT WOULD YOU LIKE TO TALK ABOUT?'],
  ['I need a holiday', 'WHY DO YOU NEED A HOLIDAY?'],
  ['My boss says I work too much', 'WHY DO YOU SAY YOUR BOSS SAYS YOU WORK TOO MUCH?'],
  ['i think you are a good listener', 'DO YOU REALLY THINK I AM A GOOD LISTENER?'],
];

// The 6809 build on the Dragon 64, the reference: every reply, as the conversation gives it.
// It goes in as the .bin the page loads, so the console is set up exactly as it is on the real page.
function converse(profileId, load) {
  const m = Emu.createMachine(profileId);
  load(m);
  for (let i = 0; i < 20; i++) m.runFrame();
  const rows = [screenOf(m)];              // every turn's 16 rows, for a row-for-row comparison
  for (const [line] of CONVERSATION) rows.push(say(m, line));
  return { m, rows, seen: rows.map(flat) };
}
const ref = converse('dragon64', (m) => {
  const d = Emu.formats.identify('liza.bin', Emu.toBinary(s6809, { format: 'dragondos' }));
  m.injectAndRun(d.segments, d.exec);
});
check('6809 reference: the intro is on screen', /I AM LIZA/.test(ref.seen[0]), ref.seen[0].slice(0, 40));
for (const [, want] of CONVERSATION) {
  check(`6809 reference: reply "${want.slice(0, 28)}…"`, ref.seen.some((t) => t.includes(want)));
}

// ---- the 6803 build on the MC-10 and the Alice: the same conversation, reply for reply ----
// each machine runs its OWN build (its title names the machine)
for (const id of ['mc10', 'alice']) {
  const build = b6803[id];
  const { m, rows, seen } = converse(id, (mm) => mm.injectAndRun(build.segments, build.exec));
  check(`${id}: the title and intro are on screen`, seen[0].includes(TITLES[id]), seen[0].slice(0, 48));
  for (let i = 0; i < CONVERSATION.length; i++) {
    const [, want] = CONVERSATION[i];
    check(`${id}: reply "${want.slice(0, 26)}…" exactly`, seen[i + 1].includes(want), seen[i + 1].slice(-90));
  }
  // every screen after each turn is the 6809 build's, row for row, except the title row (each build
  // names its own machine; the per-machine title the follow-up asked for)
  const noTitle = (screens) => screens.map((scr) => scr.slice(1));
  check(`${id}: every screen after each turn matches the 6809 build, row for row`,
    JSON.stringify(noTitle(rows)) === JSON.stringify(noTitle(ref.rows)), firstDiff(noTitle(rows), noTitle(ref.rows)));
  // repeat detection and goodbye, as on the 6809 build
  const rep = flat(say(m, 'i think you are a good listener'));
  check(`${id}: a repeated line is noticed`, rep.includes("DON'T REPEAT"), rep.slice(-70));
  const bye = flat(say(m, 'bye'));
  check(`${id}: BYE ends the conversation`, bye.includes('GOODBYE'), bye.slice(-70));
  check(`${id}: the program halts at the end-of-conversation loop`, m.cpu.pc === build.symbols.get('DONE'));
  // The program's variables live after the code, and the only bytes of the loaded image it may change are
  // the response rotation counters it owns (RESPN3 writes "next index" into each list, as the 6809 build
  // does). Everything else - all the code, all the text - must be untouched: a return address pushed over
  // the first instruction used to rewrite it ($5000: 8e -> 47).
  const rot = ROTATION;
  const changed = [];
  for (const seg of build.segments) for (let i = 0; i < seg.data.length; i++) {
    const addr = seg.addr + i;
    if (rot.has(addr) || m.ram[addr] === seg.data[i]) continue;
    changed.push(`$${addr.toString(16)} ${seg.data[i].toString(16)}->${m.ram[addr].toString(16)}`);
  }
  check(`${id}: only the reply rotation changed in the loaded image`, changed.length === 0, changed.slice(0, 5).join(' '));
}

// where two screens first differ, for the failure message
function firstDiff(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `turn ${i}: ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`;
  }
  return '';
}

// ---- BREAK, CLEAR and backspace while a line is typed ----
// POLCAT gives BREAK as 3 and CLEAR as 12 (BASIC's codes; the stub's for Esc and Home). Each build is checked against
// what the brief asks for, and the 6803 builds against the 6809 build row for row (the title row aside).
const keys = (m, codes) => { for (const c of codes) { m.stubKeys.push(c); m.runFrame(); m.runFrame(); } for (let i = 0; i < 30; i++) m.runFrame(); return screenOf(m); };
const codes = (text) => [...text.toUpperCase()].map((c) => c.charCodeAt(0));
function keySession(id, load, title) {
  const m = longSession(id, load), out = { m };
  say(m, 'I need a holiday');
  // the stack pointers seen while LIZA waits at a prompt: CLEAR leaves READLN without returning, so it must reset the
  // stack, or every CLEAR would leave READLN's return address (and more) behind
  // (the shallowest one: the waiting loop's own; deeper ones are the POLCAT calls and interrupts it makes)
  const stackAtPrompt = () => { let top = 0; m.cpu.trace = (c) => { top = Math.max(top, c.s); }; m.runFrame(); m.runFrame(); m.cpu.trace = null; return top.toString(16); };
  const before = stackAtPrompt();
  // CLEAR mid-line: a clear screen with the title, a blank row and a fresh prompt; the half-typed line is gone
  out.cleared = keys(m, [...codes('MY BOSS IS'), 12]);
  check(`${id}: CLEAR mid-line clears the screen to the title, a blank row and "> " with the cursor`,
    JSON.stringify(out.cleared) === JSON.stringify([title, '', '> #', ...Array(13).fill('')]), JSON.stringify(out.cleared.slice(0, 4)));
  for (let i = 0; i < 5; i++) keys(m, [...codes('X'), 12]);
  check(`${id}: CLEAR keeps the stack where it is at every prompt (six CLEARs leave nothing behind)`, stackAtPrompt() === before, `${before} / ${stackAtPrompt()}`);
  // the next line is answered normally (the conversation went on: no repeat, no lost state)
  out.after = say(m, 'I am tired');
  // ("I AM" + the rest: the data file's first I AM reply, "HOW LONG HAVE YOU BEEN *?")
  check(`${id}: after CLEAR the next line is answered normally`, out.after[2] === '> I AM TIRED' && out.after[3] === 'HOW LONG HAVE YOU BEEN TIRED?',
    JSON.stringify(out.after.slice(2, 6)));
  // backspace still works: "I NEEX" + backspace + "D A HOLIDAY" is "I NEED A HOLIDAY", answered with the data file's
  // second I NEED reply (the first was given before CLEAR: the rotation went on through it)
  out.bs = keys(m, [...codes('I NEEX'), 8, ...codes('D A HOLIDAY'), 13]);
  check(`${id}: backspace still corrects the line ("I NEEX", BS, "D A HOLIDAY")`,
    flat(out.bs).endsWith('> I NEED A HOLIDAY WOULD IT REALLY HELP YOU TO GET A HOLIDAY? >'), flat(out.bs).slice(-80));
  // BREAK at the prompt: the goodbye BYE gives, and the program stops at the DONE loop
  out.brk = keys(m, [3]);
  const done = load.done;
  check(`${id}: BREAK at the prompt says goodbye as BYE does`, /> +GOODBYE\. IT WAS NICE TALKING TO YOU\. TAKE CARE OF YOURSELF\.$/.test(flat(out.brk)), flat(out.brk).slice(-70));
  check(`${id}: ... and stops at BYE's DONE loop`, m.cpu.pc === done, m.cpu.pc.toString(16));
  return out;
}
const refLoad = (m) => { const d = Emu.formats.identify('liza.bin', Emu.toBinary(s6809, { format: 'dragondos' })); m.injectAndRun(d.segments, d.exec); };
refLoad.done = s6809.symbols.get('DONE');
const refKeys = keySession('dragon64', refLoad, 'LIZA - A DRAGON 64 THERAPIST');
for (const id of ['mc10', 'alice']) {
  const load = (m) => m.injectAndRun(b6803[id].segments, b6803[id].exec);
  load.done = b6803[id].symbols.get('DONE');
  const ours = keySession(id, load, TITLES[id]);
  const strip = (o) => [o.cleared, o.after, o.bs, o.brk].map((scr) => JSON.stringify(scr.slice(1)));
  check(`${id}: CLEAR, the next line, backspace and BREAK give the 6809 build's screens, row for row`,
    JSON.stringify(strip(ours)) === JSON.stringify(strip(refKeys)), firstDiff(strip(ours), strip(refKeys)));
}

// ---- the screen scrolls, and a line longer than the screen ----
// The 6809 build on the Dragon is the oracle for both: same conversation, same screen.
function longSession(profileId, load) {
  const m = Emu.createMachine(profileId);
  load(m);
  for (let i = 0; i < 20; i++) m.runFrame();
  return m;
}
// enough turns to scroll the 16-row screen several times, ending with the reply on screen
const SCROLL_LINES = ['I need a holiday', 'I feel sad', 'I want a friend', 'My mother is ill', 'I am tired',
  'I think you are right', 'I cannot sleep', 'Because it is late', 'Sorry', 'I dream of the sea'];
const longLine = 'I feel ' + 'very '.repeat(15) + 'tired';   // well over one 60-character input line
for (const id of ['mc10', 'alice']) {
  // scrolling: every turn's reply appears, and the screen holds the last 16 rows of the conversation
  const refM = longSession('dragon64', (m) => { const d = Emu.formats.identify('liza.bin', Emu.toBinary(s6809, { format: 'dragondos' })); m.injectAndRun(d.segments, d.exec); });
  const ourM = longSession(id, (m) => m.injectAndRun(b6803[id].segments, b6803[id].exec));
  const refScreens = [], ourScreens = [];
  for (const line of SCROLL_LINES) { refScreens.push(say(refM, line)); ourScreens.push(say(ourM, line)); }
  check(`${id}: the screen scrolls (the title has scrolled off the top)`, !flat(ourScreens[ourScreens.length - 1]).includes('THERAPIST'),
    flat(ourScreens[ourScreens.length - 1]).slice(-100));
  // every row matches the 6809 build's; only the title says which machine it is running on
  const strip = (screens) => screens.map((s) => s.slice(1));
  check(`${id}: the last replies are what the 6809 build shows, row for row`,
    JSON.stringify(strip(ourScreens)) === JSON.stringify(strip(refScreens)), firstDiff(strip(ourScreens), strip(refScreens)));
  // every turn of the long conversation printed the reply the 6809 build printed for that same line
  const replyOf = (screens) => screens.map((scr) => {
    // the reply is the row after the echoed line: in a 16-row screen that is the third non-blank row from
    // the bottom of what the turn added, so take the flat text and keep the part after the last '> '
    const t = flat(scr);
    const i = t.lastIndexOf('> ');
    return i >= 0 ? t.slice(i + 2) : t;
  });
  const wantReply = replyOf(refScreens), gotReply = replyOf(ourScreens);
  const missing = gotReply.map((r, i) => [i, wantReply[i], r]).filter(([, w, g]) => !g.includes(w) && w.length > 0);
  check(`${id}: every turn of the long conversation printed the 6809 build's reply`, missing.length === 0,
    missing.map(([i, w, g]) => `turn ${i + 1}: wanted "${w.slice(0, 40)}", got "${g.slice(0, 40)}"`).join('; '));
  // a line longer than the screen width: typed characters fill the screen and the reply still arrives
  const refLong = flat(say(refM, longLine));
  const ourLong = flat(say(ourM, longLine));
  check(`${id}: a line longer than the screen is accepted and answered`, /WHEN DID YOU FIRST FEEL|TELL ME MORE ABOUT FEELING|DO YOU OFTEN FEEL/.test(ourLong),
    ourLong.slice(-90));
  check(`${id}: the long line's reply is the 6809 build's`, ourLong === refLong,
    JSON.stringify(ourLong.slice(-60)) + ' vs ' + JSON.stringify(refLong.slice(-60)));
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
