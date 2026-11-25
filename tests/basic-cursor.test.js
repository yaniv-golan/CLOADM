// Run: node tests/basic-cursor.test.js
//
// The clean-room BASIC's cursor in the 32K configuration (docs/clean-room-basic.md, "The cursor"): the black-box
// observations of the real ROMs [BB 2026-11-25] and, where they say nothing, the [OWNER-SPEC] functional
// specification's acceptance tests, on our ROM in a Dragon 64 and in a Dragon 32 (tests/basic/harness.js). Nothing
// hooks the ROM: the machine is stepped one instruction at a time from outside while BASIC waits for a key, and an
// update is seen as what it does to RAM: a write tap on $008F (the countdown) sees each decrement (a write of the old
// value - 1, modulo 256) and each reload (a write of 50 just after a write of 0). The test sets RAM from outside
// between instructions (as a program's POKE would), and a few checks do it with POKE typed into BASIC.
//  * Countdown: 2 -> the first decrement changes nothing, the second toggles; a transition reloads 50; 0 -> 255, no
//    change; 51 writes per transition (the reload and 50 decrements) [BB].
//  * Transformations: $60/$20, $41/$01, $FF/$BF both ways [BB]; for every byte 0-255 (on the Dragon 64) one
//    transition toggles bit 6 only and two give the byte back.
//  * Memory: a new address in $0088-$0089 redirects the next transition [BB]; the countdown's value sets when it
//    comes; a byte written under the cursor is the one transformed; screen memory (and the display) holds the cursor
//    byte; PEEK(&H88), PEEK(&H89) is the cursor's address; KEYDLY ($0097-$0098) is the debounce delay a scan waits.
//  * Keyboard: it blinks while BASIC waits; accepting a key writes $60 to the cursor's cell first and leaves $008F
//    alone [BB]; moving keeps the countdown.
//  * Running programs: one that prints nothing (GOTO, PEEK, INKEY$, an empty FOR) never writes the countdown; one
//    that prints counts it down [BB] (ours: one decrement a character [OWN]).
//  * Timing: cycles per decrement and per transition within 1% of the real ROM's [BB]; our delay is PASSES passes
//    of an 8-cycle countdown (LEAX -1,X; BNE) after each update, timed in CPU cycles.
//  * Configurations: the same results on the Dragon 32 and the Dragon 64 in 32K mode. Native 64K mode is not
//    applicable: our ROM is the 32K-mode BASIC only (the 64K-mode BASIC is out of scope, open question 7).
// Then the mutants (built from edited source by buildBasic({ edit })) that must each fail the quick checks.
const { Basic } = require('./basic/harness.js');
const { buildBasic } = require('../tools/build-basic.js');

let fail = 0, n = 0, firstFail = null;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; firstFail = firstFail || name; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const CURPOS = 0x88, BLINK = 0x8F, KEYDLY = 0x97, RELOAD = 50, PASSES = 1065;
// the real ROMs, measured as a black box [BB 2026-11-25]: cycles per decrement and per transition (32K mode); ours
// must be within 1% of each (our delay, PASSES, is chosen for that: our keyboard scan is slower than theirs)
const BB_DEC = 9177, BB_TURN = 456471, TOL = 0.01;
const near = (v, want) => Math.abs(v - want) <= TOL * want;
const hex = (v) => '$' + v.toString(16).toUpperCase().padStart(2, '0');

// One machine with `rom`, waiting at OK, with the taps on. -> the helpers the checks use.
function rig(rom, machine = 'dragon64') {
  const b = new Basic(rom, { machine });
  if (!b.waitOk({ limit: 600, stable: 3 })) throw new Error(`our BASIC did not boot on the ${machine}`);
  const m = b.m;
  const log = [];        // every write to the countdown: { t, v, old, kind: 'dec' | 'reload' | 'other' }
  const scans = [];      // the times of the keyboard scan's column writes
  m.busTaps.addWriteTap({ start: BLINK, end: BLINK }, (a, v, old) => {
    const prev = log[log.length - 1];
    const kind = v === ((old - 1) & 0xFF) ? 'dec' : v === RELOAD && old === 0 && prev && prev.kind === 'dec' && prev.v === 0 ? 'reload' : 'other';
    log.push({ t: m.ioTime(), v, old, kind });
  }, { old: true });
  m.busTaps.addWriteTap({ start: 0xFF02, end: 0xFF02 }, () => scans.push(m.ioTime()));
  const cellWrites = [];  // writes to the screen: { a, v }
  m.busTaps.addWriteTap({ start: 0x400, end: 0x5FF }, (a, v) => cellWrites.push({ a, v }));
  // run instruction by instruction until pred() holds (false after `frames` frames)
  const stepUntil = (pred, frames = 400) => {
    for (let f = 0; f < frames; f++) {
      let hit = false;
      const done = m.runFrame((end) => {
        while (m.cycle < end) { m.runCycles(end, 1); if (pred()) { hit = true; return false; } }
        return true;
      });
      if (hit) return true;
      if (!done && !hit) continue;
    }
    return false;
  };
  const decs = () => log.filter((e) => e.kind === 'dec').length;
  // run to the next update's decrement: every update before it is complete. -> that write
  const upd = () => {
    const k = decs();
    if (!stepUntil(() => decs() > k)) throw new Error('no cursor update');
    return log.filter((e) => e.kind === 'dec')[k];
  };
  // run to an update that does not reach 0 (so no reload is pending): a safe moment to set RAM from outside
  const quiet = () => { for (;;) { const u = upd(); if (u.v !== 0) return u; } };
  const cur = () => (m.ram[CURPOS] << 8) | m.ram[CURPOS + 1];
  const type = (s) => { b.type(s + '\n'); b.waitOk(); };
  return { b, m, log, scans, cellWrites, stepUntil, upd, quiet, cur, type };
}

// The checks; quick leaves out the slow ones (the mutants run quick).
function suite(rom, { machine = 'dragon64', quick = false, tag = '' } = {}) {
  const T = (s) => `${tag}${s}`;
  const r = rig(rom, machine);
  const { m, log, upd, quiet, cur } = r;

  // ---- countdown ----
  quiet();
  let at = cur(), c0 = m.ram[at];
  m.ram[BLINK] = 2;
  let u1 = upd(), cA = m.ram[at];
  let u2 = upd(), cB = m.ram[at];
  let u3 = upd(), cC = m.ram[at];
  check(T('countdown 2: the first update writes 1 and changes nothing'), u1.v === 1 && cA === c0, `${u1.v} ${hex(c0)} ${hex(cA)}`);
  check(T('countdown 2: the second writes 0 and toggles the cell'), u2.v === 0 && cB === c0 && cC === (c0 ^ 0x40), `${hex(cB)} ${hex(cC)}`);
  const reload = log[log.indexOf(u2) + 1];
  check(T('a transition reloads 50 (the next update writes 49)'), reload && reload.kind === 'reload' && u3.v === RELOAD - 1, `${reload && reload.v} ${u3.v}`);
  quiet();
  c0 = m.ram[at];
  m.ram[BLINK] = 0;
  u1 = upd(); upd();
  check(T('countdown 0: the next update writes 255 and changes nothing'), u1.v === 255 && m.ram[at] === c0, `${u1.v} ${hex(m.ram[at])}`);

  // ---- transformations ----
  const transition = (byte) => {   // the cell after one transition of `byte` (set it, countdown 1, two updates)
    quiet();
    m.ram[at] = byte;
    m.ram[BLINK] = 1;
    upd(); upd();
    return m.ram[at];
  };
  const examples = [[0x60, 0x20], [0x20, 0x60], [0x41, 0x01], [0x01, 0x41], [0xFF, 0xBF], [0xBF, 0xFF]];
  const got = examples.map(([x]) => transition(x));
  check(T('the examples: $60>$20 $20>$60 $41>$01 $01>$41 $FF>$BF $BF>$FF'), examples.every(([, y], i) => got[i] === y), got.map(hex).join(' '));
  if (!quick && machine === 'dragon64') {
    const bad = [];
    for (let x = 0; x < 256; x++) {
      const once = transition(x), twice = transition(once);
      if (once !== (x ^ 0x40) || twice !== x) bad.push(`${hex(x)}>${hex(once)}>${hex(twice)}`);
    }
    check(T('every byte 0-255: one transition toggles bit 6 only, two give the byte back'), !bad.length, bad.slice(0, 8).join(' '));
  }

  // ---- memory ----
  quiet();
  const old = cur(), there = 0x0500, cOld = m.ram[old], cThere = m.ram[there];
  m.ram[CURPOS] = there >> 8; m.ram[CURPOS + 1] = there & 0xFF;
  m.ram[BLINK] = 1;
  upd(); upd();
  check(T('a new address in $0088-$0089 redirects the next transition'), m.ram[there] === (cThere ^ 0x40) && m.ram[old] === cOld, `${hex(m.ram[there])} ${hex(m.ram[old])}`);
  m.ram[there] = cThere; m.ram[CURPOS] = old >> 8; m.ram[CURPOS + 1] = old & 0xFF;
  at = old;
  for (const k of [3, 10]) {
    quiet();
    c0 = m.ram[at];
    m.ram[BLINK] = k;
    let i = 0;
    while (m.ram[at] === c0 && i < 300) { upd(); i++; }
    // the i-th decrement is the first one after the toggle: the k-th update made it
    check(T(`countdown set to ${k}: the transition comes with update number ${k}`), i === k + 1, `${i - 1}`);
  }
  quiet();
  m.ram[at] = 0x41;
  m.ram[BLINK] = 1;
  upd(); upd();
  check(T('a byte written under the cursor is the one transformed ($41 > $01)'), m.ram[at] === 0x01, hex(m.ram[at]));
  check(T('screen memory and the display show the cursor byte'), m.displayByte(at) === m.ram[at] && m.ram[at] === 0x01, hex(m.displayByte(at)));
  m.ram[at] = 0x60;

  // ---- the delay, in cycles ----
  // From an update's decrement to the next column write of the scan, with no transition and no interrupt between
  // them (the smallest gap seen), the CPU runs: BNE 3, LDX # 3, BSR 7, the countdown, RTS 5, JSR 8, and the scan's
  // start up to its first column write: PSHS B,X,U 10, LDU # 3, LDA # 2, STA < 4, CLR < 6, LDB # 2, STB > 5 (the
  // MC6809 data sheet's cycle counts): 58 cycles around it.
  const gaps = [];
  for (let i = 0; i < 12; i++) {
    const u = upd();
    r.stepUntil(() => r.scans.length && r.scans[r.scans.length - 1] > u.t);
    gaps.push(r.scans.find((t) => t > u.t) - u.t);
  }
  const g = Math.min(...gaps);
  check(T(`the delay after an update: ${PASSES} passes of 8 cycles`), (g - 58) / 8 === PASSES, `smallest gap ${g} cycles: ${(g - 58) / 8} passes`);

  // ---- keyboard ----
  // blinking while BASIC waits: six seconds of frames
  r.cellWrites.length = 0;
  let k0 = log.length;
  r.b.run(300);
  const tr = r.cellWrites.filter((w) => w.a === at);
  const dec = log.slice(k0).filter((e) => e.kind === 'dec');
  const turns = [];   // the times of the decrements to 0
  for (const e of dec) if (e.v === 0) turns.push(e.t);
  const iv = turns.slice(1).map((t, i) => t - turns[i]);
  check(T('it blinks while BASIC waits: transitions toggle $60 and $20 at the cursor'), tr.length >= 3 && tr.every((w, i) => w.v === (i % 2 ? tr[0].v ^ 0x40 : tr[0].v)) && [0x60, 0x20].includes(tr[0].v), tr.map((w) => hex(w.v)).join(' '));
  // [BB] 51 writes of $008F per transition: the reload to 50 and 50 decrements, the last of them to 0 (so a
  // countdown of 2 blinks on its second decrement)
  const i0 = log.findIndex((e, i) => i >= k0 && e.kind === 'dec' && e.v === 0), i1 = log.findIndex((e, i) => i > i0 && e.kind === 'dec' && e.v === 0);
  const per = log.slice(i0 + 1, i1 + 1);
  check(T('51 writes of the countdown per transition: the reload to 50, then 50 decrements'), per.length === 51 && per[0].kind === 'reload' && per.slice(1).every((e, i) => e.kind === 'dec' && e.v === RELOAD - 1 - i), `${per.length}`);
  const perDec = (dec[dec.length - 1].t - dec[0].t) / (dec.length - 1), perTurn = (turns[turns.length - 1] - turns[0]) / (turns.length - 1);
  check(T(`cycles per decrement within 1% of the real ROM's ${BB_DEC}`), near(perDec, BB_DEC), perDec.toFixed(0));
  check(T(`cycles per transition within 1% of the real ROM's ${BB_TURN}`), turns.length >= 5 && near(perTurn, BB_TURN), `${perTurn.toFixed(0)} (${iv.join(' ')})`);
  check(T('the countdown\'s writes are only decrements and reloads while it waits'), log.slice(k0).every((e) => e.kind !== 'other'));
  // accepting a key: wait for the cursor to show ($20), press DOWN (the line editor takes it and prints nothing)
  // (the countdown is set high first, so no transition writes the cell while the key is down)
  r.stepUntil(() => m.ram[at] === 0x20);
  m.ram[BLINK] = 200;
  r.cellWrites.length = 0; k0 = log.length;
  m.setKey('DOWN', true);
  r.stepUntil(() => r.cellWrites.some((w) => w.a === at), 50);
  m.setKey('DOWN', false);
  const w0 = r.cellWrites.find((w) => w.a === at), atAccept = m.ram[BLINK];
  check(T('accepting a key writes $60 to the cursor\'s cell'), w0 && w0.v === 0x60 && m.ram[at] === 0x60, w0 ? hex(w0.v) : 'no write');
  const nextDec = upd();
  check(T('accepting a key keeps the countdown (the next update counts on from it)'), log.slice(k0).every((e) => e.kind !== 'other') && nextDec.old === atAccept, `${atAccept}, then ${nextDec.old}>${nextDec.v}`);
  // moving: typed characters move the cursor; the countdown goes on through it
  k0 = log.length;
  const pos0 = cur();
  m.ram[BLINK] = 200;          // far from a transition, so every step of it is seen
  r.b.type('AB');
  const moved = log.slice(k0).filter((e) => e.kind === 'dec');
  check(T('moving the cursor keeps the countdown (no reload, no jump: 200 counting down)'), cur() === pos0 + 2 && log.slice(k0).every((e) => e.kind === 'dec') && moved.every((e, i) => e.v === 199 - i), `${moved.length} updates, last ${moved.length && moved[moved.length - 1].v}`);
  // a transition after moving goes to the new cell
  quiet();
  const nc = cur(), ncv = m.ram[nc];
  m.ram[BLINK] = 1; upd(); upd();
  check(T('after moving, the transition is at the new address'), m.ram[nc] === (ncv ^ 0x40) && m.ram[pos0] === 0x41, `${hex(m.ram[nc])} ${hex(m.ram[pos0])}`);
  // A running program that prints nothing never writes the countdown [BB]: a GOTO loop, PEEK, INKEY$ polling, an
  // empty FOR loop, a second each, then BREAK
  r.b.type('\n'); r.b.waitOk();
  const runFor = (line, frames) => {
    r.type('NEW');
    r.b.type(line + '\n');
    r.b.run(10);
    r.b.type('RUN\n');
    const k = log.length, v = m.ram[BLINK];
    r.b.run(frames);
    const w = log.slice(k), still = r.b.screen().slice(-1)[0] !== 'OK', after = m.ram[BLINK];
    r.b.keys(['BREAK']);
    r.b.waitOk();
    return { w, still, v, after };
  };
  for (const line of ['10 GOTO 10', '10 A=PEEK(1024):GOTO 10', '10 A$=INKEY$:GOTO 10', '10 FOR I=1 TO 30000:NEXT']) {
    const x = runFor(line, 50);
    check(T(`a running program that prints nothing leaves the countdown alone: ${line}`), x.still && !x.w.length && x.after === x.v, `${x.w.length} writes`);
  }
  // [BB] a running program that writes to the screen does count it down; ours: one decrement per character put on the
  // screen, reloaded at 0 like an update but never transforming the cell [OWN] (open: tests/basic/cases/cursor-print.bas)
  {
    const x = runFor('10 FOR J=1 TO 300:NEXT:FOR I=1 TO 20:PRINT "AB";:NEXT:FOR I=1 TO 30000:NEXT', 80);   // (a pause first, so the count starts before the output)
    const d = x.w.filter((e) => e.kind === 'dec').length;
    check(T('printing counts the countdown down: one decrement per character (40), reloads only at 0'), x.still && d === 40 && x.w.every((e) => e.kind !== 'other'), `${d} decrements, ${x.w.length} writes`);
  }
  // POKE and PEEK from BASIC: the cursor's address at $0088, the countdown at $008F
  r.type('CLS:PRINT PEEK(&H88)*256+PEEK(&H89)');
  check(T('PEEK(&H88), PEEK(&H89): the cursor\'s address (1024 after CLS)'), r.b.screen()[0] === ' 1024', JSON.stringify(r.b.screen()));
  quiet();
  m.ram[BLINK] = 250;          // (high: the POKE's write is then no decrement)
  k0 = log.length;
  r.b.type('POKE 143,0\n');
  const pi = () => log.findIndex((e, i) => i >= k0 && e.kind === 'other');
  r.stepUntil(() => pi() >= 0 && log.length > pi() + 1);
  const pk = log.slice(pi());
  check(T('POKE 143,0: the next update writes 255'), pk[0].v === 0 && pk[1].kind === 'dec' && pk[1].v === 255, pk.slice(0, 2).map((e) => e.v).join(' '));
  r.b.waitOk();
  // the debounce delay: KEYDLY passes before the key is looked at again (from the first column write to the
  // second one that drives the key's column, with one key down); POKE a bigger delay and the gap grows by 8 a pass
  const keyGap = (dly) => {
    r.b.run(3);                // (the scan sees the last key let go first)
    quiet();
    m.ram[KEYDLY] = dly >> 8; m.ram[KEYDLY + 1] = dly & 0xFF;
    m.ram[BLINK] = 200;        // (no transition writes the cell meanwhile)
    r.cellWrites.length = 0;
    const s0 = r.scans.length;
    m.setKey('DOWN', true);
    r.stepUntil(() => r.cellWrites.some((w) => w.a === cur()), 50);
    m.setKey('DOWN', false);
    const t = r.scans.slice(s0);
    let big = 0;
    for (let i = 1; i < t.length; i++) big = Math.max(big, t[i] - t[i - 1]);
    return big;
  };
  // (both longer than the cursor's delay, so the longest gap is the debounce; the field interrupt may land in one
  // gap more than the other: up to 100 cycles)
  const gA = keyGap(3000), gB = keyGap(4000);
  check(T('KEYDLY ($0097-$0098, big-endian) is the debounce delay: 1,000 more passes, 8,000 more cycles'), Math.abs(gB - gA - 8000) <= 100, `${gA} ${gB}`);
  m.ram[KEYDLY] = 300 >> 8; m.ram[KEYDLY + 1] = 300 & 0xFF;
  return r;
}

const { rom } = buildBasic();
suite(rom);
{
  // a cold start [OWN]: the countdown set to 1, so the first update shows the cursor; the debounce delay 300
  const b = new Basic(rom), w = [];
  b.m.busTaps.addWriteTap({ start: BLINK, end: BLINK }, (a, v) => w.push(v));
  b.waitOk({ limit: 600, stable: 3 });
  // (cleared, set to 1, then the banner's first character takes it to 0 and it is reloaded)
  check('cold start: the countdown is cleared, set to 1, and reloaded at the first character (writes 0, 1, 0, 50)', w.slice(0, 4).join() === '0,1,0,50', w.slice(0, 4).join());
  check('cold start: the debounce delay is 300', ((b.m.ram[KEYDLY] << 8) | b.m.ram[KEYDLY + 1]) === 300);
}
suite(rom, { machine: 'dragon32', tag: 'Dragon 32: ' });   // (every byte 0-255 on the Dragon 64 only: the same code)
console.log('not applicable: native 64K mode ($AF/$8F blocks): our ROM is the 32K-mode BASIC only');

// ---- mutants: each must fail the quick checks ----
const MUTANTS = [
  ['reload 49', 'keyboard.inc', 'LDA     #50', 'LDA     #49'],
  ['toggle bit 5', 'keyboard.inc', 'EORA    #$40', 'EORA    #$20'],
  ['$60 not written on accept', 'keyboard.inc', 'LDB     #$60\n        LDX     <CURPOS\n        STB     ,X', 'LDB     #$60\n        LDX     <CURPOS\n        TST     ,X'],
  ['moving resets the countdown', 'screen.inc', 'CHRDON  STX     <CURPOS', 'CHRDON  STX     <CURPOS\n        LDB     #50\n        STB     <BLINK'],
  ['accepting resets the countdown', 'keyboard.inc', '        STB     ,X\n        PULS    B,X,PC', '        STB     ,X\n        LDB     #50\n        STB     <BLINK\n        PULS    B,X,PC'],
  ['delay 1,064 passes', 'keyboard.inc', 'LDX     #1065', 'LDX     #1064'],
  ['the cursor address not read from RAM', 'keyboard.inc', '        LDX     <CURPOS\n        LDA     ,X', '        LDX     #SCREEN\n        LDA     ,X'],
  ['a 0 countdown toggles at once', 'keyboard.inc', 'KW1     DEC     <BLINK\n        BNE     KW2', 'KW1     DEC     <BLINK\n        BGT     KW2'],
  ['debounce delay not from KEYDLY', 'keyboard.inc', 'LDX     <KEYDLY', 'LDX     #300'],
  ['printing leaves the countdown alone', 'screen.inc', 'DEC     <BLINK', 'TST     <BLINK'],
  ['the delay 10% longer', 'keyboard.inc', 'LDX     #1065', 'LDX     #1170'],
];
for (const [name, file, from, to] of MUTANTS) {
  let used = false;
  const mrom = buildBasic({ edit: (f, text) => { if (f !== file) return text; if (!text.includes(from)) throw new Error(`mutant ${name}: no ${from}`); used = true; return text.replace(from, to); } }).rom;
  const f0 = fail, n0 = n, out = console.log;
  console.log = () => {};
  firstFail = null;
  let crashed = null;
  try { suite(mrom, { quick: true }); } catch (e) { crashed = e.message; }
  console.log = out;
  const failed = crashed || fail > f0;
  fail = f0; n = n0;
  check(`mutant "${name}" fails the checks`, used && failed, crashed ? `(it stopped: ${crashed})` : `(first: ${firstFail})`);
}

console.log(`\n${n - fail}/${n} passed`);
process.exitCode = fail ? 1 : 0;
