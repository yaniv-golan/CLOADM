// Translated typing of every printable character on every keyboard family, with the host's Shift held the
// way a person holds it (js/host/input.js). The bug this guards: the host types ':' as Shift+; and the
// machines have ':' as a key of its own with '*' as its SHIFTed legend, so passing the host's Shift through
// typed '*' (likewise '@' -> SHIFT+@, '^' -> SHIFT+UP).
//
// The oracle is the machines' keyboard legends (tools/keyecho/gen-keyecho.js, which cites MAME 0.264's
// PORT_CHAR pairs for dragon_keyboard, coco3_keyboard, mc10 and alice and Color BASIC's control-key table),
// not js/machines/keyboards.js' charToKeys, the code under test. Host events are a US keyboard's
// (tests/us-layout.js): each character's KeyboardEvent.code, and Shift pressed first when the US layout needs it.
//  1. Mapping: for every character, the set the host holds on the machine is exactly the key whose legend it is,
//     plus SHIFT exactly when that legend is the key's upper one.
//  2. Screen: our key-echo firmware decodes the matrix as BASIC does and writes the characters to the text
//     screen; typing the whole printable set must put exactly those characters there (dragon64, dragon200e,
//     coco, coco3 with the 6809 and the 6309, mc10, alice).
//  3. The ways a person holds keys: Shift held across several symbols, Shift released before the symbol key,
//     key repeat, and fast typing with presses overlapping the previous key.
//  4. Claude's typing (Session.typeTextPaced) and pasted text (the typist) produce the same characters.
//  5. Positional mode stays positional: the host's Shift is the key at its position (the MC-10's left Shift is
//     CONTROL there), and a symbol key is its physical key whatever Shift says.
const Emu = require('./load')();
const { HostInput } = require('../js/host/input.js');
const { US } = require('./us-layout.js');
const { keyechoBinary, expectedCodes, vdg, inverse, legends: legendsOf, printable } = require('../tools/keyecho/gen-keyecho.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const FAMILIES = [['dragon64'], ['dragon200e'], ['coco'], ['coco3'], ['coco3', { cpu: '6309' }], ['mc10'], ['alice']];
const tag = (id, config) => (config ? `${id} ${config.cpu}` : id);

const legends = (layout) => legendsOf(Emu, layout);
const hostDown = (kb, ch, extra = {}) => kb.keydown({ key: ch, code: US[ch].code, shiftKey: US[ch].shift, repeat: false, ...extra });
const hostUp = (kb, ch) => kb.keyup({ key: ch, code: US[ch].code, shiftKey: US[ch].shift });
const SHIFT_DOWN = { key: 'Shift', code: 'ShiftLeft', shiftKey: true, repeat: false };
const SHIFT_UP = { key: 'Shift', code: 'ShiftLeft', shiftKey: false };

// ---- 1. mapping ----
for (const [id, config] of FAMILIES) {
  const m = Emu.createMachine(id, config), q = new Emu.KeyQueue(), kb = new HostInput(m, q);
  const want = legends(m.profile.keyboard), bad = [];
  let n = 0;
  for (let c = 32; c < 127; c++) {
    const ch = String.fromCharCode(c), u = ch.toUpperCase(), leg = want[u];
    if (!leg) continue;
    if (US[ch].shift) kb.keydown(SHIFT_DOWN);
    hostDown(kb, ch);
    // a letter takes the host's Shift (its case is the machine's own mode); every other character its legend's
    const shift = /[A-Za-z]/.test(ch) ? US[ch].shift : leg.shift;
    const exp = [leg.key, ...(shift ? ['SHIFT'] : [])].sort().join('+'), got = [...q.want].sort().join('+');
    if (got !== exp) bad.push(`${ch}: ${got || '-'} want ${exp}`);
    hostUp(kb, ch);
    if (US[ch].shift) kb.keyup(SHIFT_UP);
    if (q.want.size) bad.push(`${ch}: ${[...q.want].join('+')} still held after release`);
    n++;
  }
  check(`${tag(id, config)}: each of ${n} characters holds exactly its legend's key and SHIFT`, bad.length === 0 && n >= 60, bad.slice(0, 6).join('; '));
}

// a held key whose SHIFT a newer key contradicts leaves the matrix: ':' still down when '"' goes down would
// otherwise sit under SHIFT, which a program reading the matrix sees as '*'; and a letter pressed with the
// host's Shift while ':' is held takes ':' off rather than SHIFTing it
for (const [id, layoutKeys] of [['coco3', [':', '2']], ['mc10', [':', '2']]]) {
  const m = Emu.createMachine(id), q = new Emu.KeyQueue(), kb = new HostInput(m, q);
  kb.keydown(SHIFT_DOWN); hostDown(kb, ':'); hostDown(kb, '"');
  check(`${id}: ':' held, then '"': the matrix holds SHIFT+2 only`, [...q.want].sort().join('+') === ['SHIFT', layoutKeys[1]].sort().join('+'), [...q.want].join('+'));
  hostUp(kb, '"'); hostUp(kb, ':');
  hostDown(kb, ':'); hostDown(kb, 'A');
  check(`${id}: ':' held, then Shift+A: the matrix holds SHIFT+A only`, [...q.want].sort().join('+') === 'A+SHIFT', [...q.want].join('+'));
  hostUp(kb, 'A'); hostUp(kb, ':'); kb.keyup(SHIFT_UP);
  check(`${id}: all released`, q.want.size === 0, [...q.want].join('+'));
}

// SPACE takes the host's Shift as letters do: a game's Shift+Up+Left held, then SPACE (fire), keeps SHIFT
{
  const m = Emu.createMachine('coco3'), q = new Emu.KeyQueue(), kb = new HostInput(m, q);
  kb.keydown(SHIFT_DOWN);
  kb.keydown({ key: 'ArrowUp', code: 'ArrowUp', shiftKey: true }); kb.keydown({ key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: true });
  kb.keydown({ key: ' ', code: 'Space', shiftKey: true });
  check('coco3: Shift+Up+Left held, then SPACE: SHIFT stays down with all three', [...q.want].sort().join('+') === 'LEFT+SHIFT+SPACE+UP', [...q.want].join('+'));
  kb.keyup({ key: ' ', code: 'Space' }); kb.keyup({ key: 'ArrowLeft', code: 'ArrowLeft' }); kb.keyup({ key: 'ArrowUp', code: 'ArrowUp' }); kb.keyup(SHIFT_UP);
  check('coco3: all released', q.want.size === 0, [...q.want].join('+'));
}
// the newest held key decides SHIFT (js/host/input.js): '=' (SHIFT+-) held, then Shift+Up, then Shift let go -
// Up, the newest, follows the host's Shift, so SHIFT goes up though '=' (which fixed it) is still held
{
  const m = Emu.createMachine('coco3'), q = new Emu.KeyQueue(), kb = new HostInput(m, q);
  hostDown(kb, '=');
  kb.keydown(SHIFT_DOWN); kb.keydown({ key: 'ArrowUp', code: 'ArrowUp', shiftKey: true });
  check('coco3: "=" held, then Shift+Up: SHIFT, - and UP', [...q.want].sort().join('+') === '-+SHIFT+UP', [...q.want].join('+'));
  kb.keyup(SHIFT_UP);
  check('coco3: then Shift let go: the newest key (Up) decides, SHIFT goes up', [...q.want].sort().join('+') === '-+UP', [...q.want].join('+'));
  kb.keyup({ key: 'ArrowUp', code: 'ArrowUp' }); hostUp(kb, '=');
  check('coco3: all released', q.want.size === 0, [...q.want].join('+'));
}
// a keyboard mode change while Shift is held cannot leave SHIFT stuck, either way round
for (const [from, to] of [['translated', 'positional'], ['positional', 'translated']]) {
  const m = Emu.createMachine('coco3'), q = new Emu.KeyQueue(), kb = new HostInput(m, q);
  kb.mode = from;
  kb.keydown(SHIFT_DOWN);
  const during = [...q.want].join('+');
  kb.mode = to;
  kb.keyup(SHIFT_UP);
  hostDown(kb, '1');
  check(`coco3: Shift pressed in ${from} mode, released in ${to}: SHIFT went down and is up after`, during === 'SHIFT' && [...q.want].join('+') === '1', `${during} / ${[...q.want].join('+')}`);
  hostUp(kb, '1');
}

// ---- 2-4. the screen, through the key-echo firmware ----
const fr = (s) => s.advance(1000 / s.machine.fps + 0.001);
function echoSession(id, config) {
  const s = new Emu.Session();
  s.switchMachine(id, config);
  s.load('keyecho.bin', keyechoBinary(Emu, id), { remember: false });
  // the key-echo firmware stands in for BASIC: the host's keys and the typist go to the matrix, as they do with
  // a BASIC ROM, rather than into the no-ROM stub's key-code queue (which never reaches the matrix)
  Object.defineProperty(s.machine, 'useStub', { value: false });
  for (let i = 0; i < 10; i++) fr(s);
  return { s, kb: new HostInput(s.machine, s.keys) };
}
const drain = (s) => { for (let i = 0; i < 4000 && s.keys.pending; i++) fr(s); for (let i = 0; i < 10; i++) fr(s); };
const screen = (s, n) => [...s.machine.ram.subarray(s.machine.profile.textScreen || 0x400).slice(0, n)];
const show = (codes) => codes.map((v) => (v & 0x40 ? String.fromCharCode((v & 0x3F) < 32 ? (v & 0x3F) + 64 : v & 0x3F) : `[${String.fromCharCode((v & 0x3F) < 32 ? (v & 0x3F) + 64 : v & 0x3F)}]`)).join('');
const typable = (id) => printable(Emu, id);

// a person typing: Shift goes down before a run of US-shifted characters and up after it; events arrive a few
// per frame (fast typing), with each press overlapping the previous key's release when `overlap`
function typeLikeAPerson(s, kb, text, overlap) {
  const ev = [];
  let shift = false, held = null;   // held: a key pressed and not yet released (overlap)
  for (const ch of text) {
    if (US[ch].shift !== shift) {
      if (held) { ev.push(['u', held]); held = null; }
      ev.push(US[ch].shift ? ['kd', SHIFT_DOWN] : ['ku', SHIFT_UP]);
      shift = US[ch].shift;
    }
    if (held === ch) { ev.push(['u', held]); held = null; }
    ev.push(['d', ch]);
    if (held) ev.push(['u', held]);
    held = ch;
    if (!overlap) { ev.push(['u', ch]); held = null; }
  }
  if (held) ev.push(['u', held]);
  if (shift) ev.push(['ku', SHIFT_UP]);
  for (let i = 0; i < ev.length; i += 4) {
    for (const [what, x] of ev.slice(i, i + 4)) {
      if (what === 'kd') kb.keydown(x); else if (what === 'ku') kb.keyup(x); else if (what === 'd') hostDown(kb, x); else hostUp(kb, x);
    }
    fr(s);
  }
  drain(s);
}

for (const [id, config] of FAMILIES) {
  const text = typable(id);
  for (const overlap of [false, true]) {
    const { s, kb } = echoSession(id, config);
    typeLikeAPerson(s, kb, text, overlap);
    const got = screen(s, text.length + 2), exp = [...expectedCodes(text), 0x60, 0x60];
    check(`${tag(id, config)}${overlap ? ', overlapping presses' : ''}: the screen shows every character typed (${text.length})`,
      got.join() === exp.join(), `got ${show(got)}`);
  }
}

// the ways a person holds Shift, on a CoCo 3 (the owner's machine) and an MC-10 (another matrix and CPU)
for (const id of ['coco3', 'mc10']) {
  {
    // Shift held across ":" "*" "+" ":" - each key pressed and released while it stays down
    const { s, kb } = echoSession(id);
    kb.keydown(SHIFT_DOWN);
    for (const ch of ':*+:') { hostDown(kb, ch); fr(s); fr(s); hostUp(kb, ch); fr(s); }
    kb.keyup(SHIFT_UP);
    drain(s);
    check(`${id}: Shift held across several symbols`, screen(s, 4).join() === expectedCodes(':*+:').join(), show(screen(s, 4)));
  }
  {
    // Shift released before the symbol key: still ':' and nothing else
    const { s, kb } = echoSession(id);
    kb.keydown(SHIFT_DOWN); hostDown(kb, ':'); fr(s); kb.keyup(SHIFT_UP); fr(s); fr(s); hostUp(kb, ':');
    hostDown(kb, '1'); fr(s); hostUp(kb, '1');
    drain(s);
    check(`${id}: Shift released before the symbol key`, screen(s, 3).join() === [...expectedCodes(':1'), 0x60].join(), show(screen(s, 3)));
  }
  {
    // key repeat: a held ":" repeating keeps the machine's SHIFT off (it is one press on the matrix)
    const { s, kb } = echoSession(id);
    kb.keydown(SHIFT_DOWN); hostDown(kb, ':');
    for (let i = 0; i < 6; i++) { fr(s); hostDown(kb, ':', { repeat: true }); }
    hostUp(kb, ':'); kb.keyup(SHIFT_UP);
    drain(s);
    check(`${id}: a repeating ":" is ":" (no SHIFT reaches the matrix)`, screen(s, 2).join() === [...expectedCodes(':'), 0x60].join(), show(screen(s, 2)));
  }
  {
    // "=" is unshifted on the host and SHIFTed on the machine; the next key is unshifted again
    const { s, kb } = echoSession(id);
    for (const ch of '=-') { hostDown(kb, ch); fr(s); hostUp(kb, ch); }
    drain(s);
    check(`${id}: "=" adds SHIFT and the next key drops it`, screen(s, 2).join() === expectedCodes('=-').join(), show(screen(s, 2)));
  }
  {
    // overlap with opposite SHIFT needs: ":" still held when '"' goes down
    const { s, kb } = echoSession(id);
    kb.keydown(SHIFT_DOWN); hostDown(kb, ':'); fr(s); hostDown(kb, '"'); hostUp(kb, ':'); hostUp(kb, '"'); kb.keyup(SHIFT_UP);
    drain(s);
    check(`${id}: ":" overlapped by '"' types both, nothing else`, screen(s, 3).join() === [...expectedCodes(':"'), 0x60].join(), show(screen(s, 3)));
  }
}

// ---- 4. Claude's typing and pasted text, through the same firmware ----
for (const [id, config] of FAMILIES) {
  const text = typable(id).replace(/[A-Z]/g, '');   // the typist types letters as their capitals, unshifted
  {
    const { s } = echoSession(id, config);
    const job = s.typeTextPaced(text);
    for (let i = 0; i < 6000 && job.status === 'typing'; i++) fr(s);
    for (let i = 0; i < 20; i++) fr(s);
    const got = screen(s, text.length + 1);
    check(`${tag(id, config)}: Claude's typing (typeTextPaced) shows the same characters`, job.status === 'done' && got.join() === [...expectedCodes(text), 0x60].join(), `${job.status}, got ${show(got)}`);
  }
  {
    const { s } = echoSession(id, config);
    s.typeText(text);
    for (let i = 0; i < 6000 && s.machine.typist.busy; i++) fr(s);
    for (let i = 0; i < 20; i++) fr(s);
    const got = screen(s, text.length + 1);
    check(`${tag(id, config)}: pasted text (the typist) shows the same characters`, got.join() === [...expectedCodes(text), 0x60].join(), `got ${show(got)}`);
  }
}

// ---- 5. positional mode stays positional ----
{
  const m = Emu.createMachine('coco3'), q = new Emu.KeyQueue(), kb = new HostInput(m, q);
  kb.mode = 'positional';
  kb.keydown(SHIFT_DOWN); hostDown(kb, ':');
  check('coco3 positional: Shift + the ; key is SHIFT + ; (the key at that position)', [...q.want].sort().join('+') === ';+SHIFT', [...q.want].join('+'));
  hostUp(kb, ':'); kb.keyup(SHIFT_UP);
  hostDown(kb, '=');
  check('coco3 positional: the = key is the - key at its position, no SHIFT added', [...q.want].join('+') === '-', [...q.want].join('+'));
  hostUp(kb, '=');
  check('coco3 positional: all released', q.want.size === 0);
}
{
  // MAME mc10: the left Shift is CONTROL (js/machines/keyboards.js positionalKeys.mc10, ShiftLeft)
  const m = Emu.createMachine('mc10'), q = new Emu.KeyQueue(), kb = new HostInput(m, q);
  kb.mode = 'positional';
  kb.keydown(SHIFT_DOWN);
  check('mc10 positional: the left Shift is CONTROL', [...q.want].join('+') === 'CTRL', [...q.want].join('+'));
  kb.keyup(SHIFT_UP);
  kb.keydown({ key: 'Shift', code: 'ShiftRight', shiftKey: true });
  check('mc10 positional: the right Shift is SHIFT', [...q.want].join('+') === 'SHIFT', [...q.want].join('+'));
  kb.keyup({ key: 'Shift', code: 'ShiftRight' });
  check('mc10 positional: all released', q.want.size === 0);
}

// ---- 6. Mac modifiers: Option (Alt) and Cmd (Meta) never reach the matrix as SHIFT or CTRL ----
// Option+key and Cmd+key are the host's (special characters, browser shortcuts): the key is not taken. Option
// alone is the ALT cell of the CoCo matrix (the CoCo 3's ALT key; js/machines/keyboards.js lays the CoCo 1/2 out
// the same) and nothing on the MC-10, whose matrix has none; Cmd alone is nothing.
for (const id of ['coco3', 'coco', 'mc10']) {
  const m = Emu.createMachine(id), q = new Emu.KeyQueue(), kb = new HostInput(m, q);
  // what reaches the matrix: a name the machine has no cell for (ALT on a CoCo 1/2) is a no-op in setKey
  const heldNow = () => [...q.want].filter((k) => m.keyPos[k]).sort().join('+');
  kb.keydown({ key: 'Meta', code: 'MetaLeft', metaKey: true });
  const took = kb.keydown({ key: ';', code: 'Semicolon', metaKey: true });
  check(`${id}: Cmd and Cmd+; hold nothing on the machine`, heldNow() === '' && took === false, heldNow());
  kb.keyup({ key: ';', code: 'Semicolon' }); kb.keyup({ key: 'Meta', code: 'MetaLeft' });
  kb.keydown({ key: 'Alt', code: 'AltLeft', altKey: true });
  const opt = heldNow();
  const tookOpt = kb.keydown({ key: '…', code: 'Semicolon', altKey: true });   // Option+; on a Mac US layout
  check(`${id}: Option is ${id === 'mc10' ? 'nothing' : 'ALT'}, never SHIFT or CTRL, and Option+; types nothing`,
    opt === (id === 'mc10' ? '' : 'ALT') && heldNow() === opt && tookOpt === false, `${opt} / ${heldNow()}`);
  kb.keyup({ key: '…', code: 'Semicolon' }); kb.keyup({ key: 'Alt', code: 'AltLeft' });
  // Fn+Left Arrow and Fn+Delete on a Mac reach the page as Home and Delete: both are CLEAR
  for (const [key, code] of [['Home', 'Home'], ['Delete', 'Delete']]) {
    kb.keydown({ key, code });
    check(`${id}: ${key} (Fn+${key === 'Home' ? 'Left Arrow' : 'Delete'} on a Mac) is CLEAR`, id === 'mc10' || heldNow() === 'CLEAR', heldNow());
    kb.keyup({ key, code });
  }
  check(`${id}: all released`, q.want.size === 0, heldNow());
}

// Without ROMs the stub's POLCAT reads a code, not the matrix: every host key the matrix takes as BREAK or CLEAR gives
// that key's code (BREAK 3, CLEAR 12, as BASIC's POLCAT does), so a program on the stub (LIZA) sees BREAK and CLEAR
// from the same keys. Translated: Esc, Home, Delete; positional: Esc, End, Home, and on the MC-10 (whose positional
// layout has no CLEAR) the ] key, its BREAK.
for (const id of ['dragon64', 'coco', 'mc10']) {
  for (const mode of ['translated', 'positional']) {
    const m = Emu.createMachine(id), q = new Emu.KeyQueue(), kb = new HostInput(m, q);
    kb.mode = mode;
    const keys = mode === 'translated' ? [['Escape', 'Escape', 3], ['Home', 'Home', 12], ['Delete', 'Delete', 12]]
      : id === 'mc10' ? [[']', 'BracketRight', 3]] : [['Escape', 'Escape', 3], ['End', 'End', 3], ['Home', 'Home', 12]];
    const got = keys.map(([key, code]) => { m.stubKeys.length = 0; kb.keydown({ key, code }); kb.keyup({ key, code }); return m.stubKeys.join(','); });
    check(`${id} ${mode}: on the stub ${keys.map(([k]) => k).join(', ')} give POLCAT ${keys.map(([, , c]) => c).join(', ')}`,
      m.useStub && got.join(' ') === keys.map(([, , c]) => String(c)).join(' '), got.join(' '));
    if (mode === 'translated') {
      // a typed character stays itself: \ is SHIFT+CLEAR on the matrix, but the stub gets the character, 92
      m.stubKeys.length = 0; kb.keydown({ key: '\\', code: 'Backslash' }); kb.keyup({ key: '\\', code: 'Backslash' });
      check(`${id} translated: on the stub a typed \\ is 92, not CLEAR`, m.stubKeys.join(',') === '92', m.stubKeys.join(','));
    }
  }
}

// the expected screen codes are the 6847's, independent of the firmware: ':' is $7A, '*' $6A, inverse 'A' $01
check('VDG codes: ":" $7A, "*" $6A, "@" $40, inverse A $01', vdg(':') === 0x7A && vdg('*') === 0x6A && vdg('@') === 0x40 && inverse(vdg('A')) === 0x01);

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
