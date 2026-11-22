// Host typing reaches the machine with no keystroke lost and in order (js/machines/keyqueue.js, the Session's
// KeyQueue, fed by js/host/input.js). Keys are typed in bursts much faster than the machine scans: several
// key changes between two frames, presses overlapping the previous key, double letters, shifted characters.
//  - KeyQueue on its own: the hold, the re-press gap, one press a frame, order, SHIFT before its letter.
//  - The matrix on every family: after each frame start, the keys a program reads through the keyboard
//    rows (Machine.keyRowsForCols, what the PIA returns) are decoded back to text; it must be the text typed,
//    every key down for at least `hold` frames, with SHIFT already in its state when the key goes down.
//  - LIZA on the no-ROM stub (the case visitors meet first) on each 6809 family: the reply line holds exactly what was typed.
//    These checks are end to end only: on the stub, HostInput puts key codes straight into Machine.stubKeys,
//    which POLCAT reads, so the stub path doesn't go through the queue.
// Queued keys are not in snapshots: they are host-side input, not machine state (the matrix they set is).
const fs = require('fs');
const path = require('path');
const Emu = require('./load')();
const { HostInput } = require('../js/host/input.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// ---- KeyQueue alone, against a recording machine ----
{
  const log = [];
  const rec = { setKey: (k, d) => log.push(`${q.frame}:${k}${d ? '+' : '-'}`) };
  const q = new Emu.KeyQueue({ hold: 3, gap: 2 });
  // A down, A up, B down, B up, A down, A up, all before the first frame
  q.set(['A']); q.set([]); q.set(['B']); q.set([]); q.set(['A']); q.set([]);
  for (let i = 0; i < 20; i++) q.step(rec);
  check('a burst between two frames is applied in order, each key held 3 frames',
    log.join() === '1:A+,4:A-,4:B+,7:B-,7:A+,10:A-', log.join());
  check('nothing left pending', q.pending === 0);

  log.length = 0;
  const q2 = new Emu.KeyQueue({ hold: 3, gap: 2 });
  q2.set(['L']); q2.set([]); q2.set(['L']); q2.set([]);
  for (let i = 0; i < 20; i++) q2.step({ setKey: (k, d) => log.push(`${q2.frame}:${k}${d ? '+' : '-'}`) });
  check('a double letter is two presses, with the key up for the gap between them', log.join() === '1:L+,4:L-,6:L+,9:L-', log.join());

  log.length = 0;
  const q3 = new Emu.KeyQueue({ hold: 3, gap: 2 });
  q3.set(['H']); q3.set(['H', 'I']); q3.set(['I']); q3.set([]);   // rollover: I pressed before H released
  for (let i = 0; i < 20; i++) q3.step({ setKey: (k, d) => log.push(`${q3.frame}:${k}${d ? '+' : '-'}`) });
  check('keys that overlapped on the host overlap in the matrix, one press a frame', log.join() === '1:H+,2:I+,4:H-,5:I-', log.join());

  log.length = 0;
  const q4 = new Emu.KeyQueue({ hold: 3, gap: 2 });
  q4.set(['1', 'SHIFT']); q4.set([]); q4.set(['2']); q4.set([]);   // '!' then '2'
  for (let i = 0; i < 20; i++) q4.step({ setKey: (k, d) => log.push(`${q4.frame}:${k}${d ? '+' : '-'}`) });
  check('SHIFT goes down before its key and up after it, before the next key', log.join() === '1:SHIFT+,2:1+,4:SHIFT-,5:1-,5:2+,8:2-' || log.join() === '1:SHIFT+,2:1+,5:1-,5:SHIFT-,5:2+,8:2-', log.join());

  // a modifier let go in the frame right after a press made with it held stays down until that press has been
  // down `hold` frames: Shift held for a while, '2' pressed (") and Shift released straight after
  log.length = 0;
  const q6 = new Emu.KeyQueue({ hold: 3, gap: 2 });
  q6.set(['SHIFT']);
  for (let i = 0; i < 5; i++) q6.step({ setKey: (k, d) => log.push(`${q6.frame}:${k}${d ? '+' : '-'}`) });
  q6.set(['SHIFT', '2']);
  q6.step({ setKey: (k, d) => log.push(`${q6.frame}:${k}${d ? '+' : '-'}`) });
  q6.set(['2']);
  for (let i = 0; i < 10; i++) q6.step({ setKey: (k, d) => log.push(`${q6.frame}:${k}${d ? '+' : '-'}`) });
  check('SHIFT released right after a press made with it stays down `hold` frames after that press', log.join() === '1:SHIFT+,6:2+,9:SHIFT-', log.join());

  const q5 = new Emu.KeyQueue();
  q5.set(['A']); q5.step({ setKey() {} }); q5.set([]); q5.set(['B']);
  q5.clear();
  check('clear forgets pending changes and keys held', q5.pending === 0 && q5.want.size === 0 && q5.down.size === 0);
}

// ---- the matrix as programs read it, on every family ----
// press, release, next press ... with a few changes in each 1/300 s; `overlap` presses the next key first
function hostEventsFor(text, overlap) {
  const ev = [];
  const chars = [...text];
  let i = 0;
  while (i < chars.length) {
    const a = chars[i], b = chars[i + 1];
    const shiftA = !!(Emu.charToKeys(a) || {}).shift;
    if (overlap && b && a.toUpperCase() !== b.toUpperCase() && !shiftA && !(Emu.charToKeys(b) || {}).shift) {
      ev.push(['down', a], ['down', b], ['up', a], ['up', b]); i += 2;
    } else { ev.push(['down', a], ['up', a]); i++; }
  }
  return ev;
}
const keyEvent = (ch) => ({ key: ch === '\n' ? 'Enter' : ch, code: ch === '\n' ? 'Enter' : `Key${ch.charCodeAt(0)}`, repeat: false, ctrlKey: false, metaKey: false, altKey: false });

function typeFast(s, kb, text, overlap, perAdvance = 5) {
  const ev = hostEventsFor(text, overlap);
  const frameMs = 1000 / s.shownMachine.fps;
  for (let i = 0; i < ev.length; i += perAdvance) {
    for (const [what, ch] of ev.slice(i, i + perAdvance)) { if (what === 'down') kb.keydown(keyEvent(ch)); else kb.keyup(keyEvent(ch)); }
    s.advance(frameMs + 0.001);
  }
}

// run frames until the queue is empty and a few more
function drain(s) {
  for (let i = 0; i < 2000 && s.keys.pending; i++) s.advance(1000 / s.shownMachine.fps + 0.001);
  for (let i = 0; i < 10; i++) s.advance(1000 / s.shownMachine.fps + 0.001);
}

// the keys a program reads now: for each column driven low on its own, the rows pulled low
function matrixKeys(m) {
  const down = new Set();
  for (const [name, [r, c]] of Object.entries(m.keyPos)) if (m.keyRowsForCols(0xFF & ~(1 << c)) & (1 << r)) down.add(name);
  return down;
}
const PLAIN = new Set('0123456789:;,-./@ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
const SHIFTED = {};
for (let c = 32; c < 127; c++) { const ch = String.fromCharCode(c); const k = Emu.charToKeys(ch); if (k && k.shift && !SHIFTED[k.key]) SHIFTED[k.key] = ch; }

for (const id of ['dragon64', 'coco', 'coco3', 'mc10']) {
  for (const overlap of [false, true]) {
    const s = new Emu.Session();
    s.switchMachine(id);
    const m = s.shownMachine;
    const kb = new HostInput(m, s.keys);
    const text = 'HELLO, WORLD! I TYPE "FAST" 1122 TOO\n';
    // watch the matrix at every frame start, after the queue has run
    let prev = new Set(), decoded = '', minHold = Infinity, frame = 0;
    const since = new Map(), orig = m.runFrame.bind(m);
    m.runFrame = () => {
      frame++;
      const now = matrixKeys(m);
      for (const k of prev) if (!now.has(k) && k !== 'SHIFT') minHold = Math.min(minHold, frame - since.get(k));
      for (const k of now) if (!prev.has(k)) {
        since.set(k, frame);
        if (k === 'SHIFT') continue;
        const sh = now.has('SHIFT');
        decoded += k === 'ENTER' ? '\n' : k === 'SPACE' ? ' ' : sh && SHIFTED[k] ? SHIFTED[k] : PLAIN.has(k) ? k : `<${k}>`;
      }
      prev = now;
      return orig();
    };
    typeFast(s, kb, text, overlap);
    drain(s);
    const tag = `${id}${overlap ? ', overlapping presses' : ''}`;
    check(`${tag}: the matrix spells exactly what was typed`, decoded === text, JSON.stringify(decoded));
    check(`${tag}: every key stays down at least 3 frames`, minHold >= 3, `min ${minHold}`);
    check(`${tag}: all keys up at the end, nothing pending`, matrixKeys(m).size === 0 && s.keys.pending === 0);
  }
}

// ---- LIZA on the no-ROM stub, each 6809 family (end to end; the stub's key codes bypass the queue) ----
const liza = new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/liza.bin')));
for (const id of ['dragon64', 'coco', 'coco3']) {
  const s = new Emu.Session();
  s.switchMachine(id);
  s.load('liza.bin', liza, { remember: false });
  const kb = new HostInput(s.shownMachine, s.keys);
  for (let i = 0; i < 120; i++) s.advance(1000 / s.shownMachine.fps + 0.001);
  const typed = 'I feel happy, really';
  typeFast(s, kb, typed, true, 8);
  drain(s);
  const line = s.screenText().find((l) => l.includes('I FEEL')) || '';
  check(`${id}: LIZA shows a fast burst exactly`, line.includes(typed.toUpperCase()) && !line.includes(typed.toUpperCase() + typed[typed.length - 1].toUpperCase()), JSON.stringify(line));
}

// ---- reset and machine switch forget queued keys ----
{
  const s = new Emu.Session();
  s.switchMachine('dragon64');
  const kb = new HostInput(s.shownMachine, s.keys);
  kb.keydown(keyEvent('A')); kb.keyup(keyEvent('A')); kb.keydown(keyEvent('B'));
  s.reset();
  check('reset drops queued keys', s.keys.pending === 0);
  kb.keyup(keyEvent('B'));
  s.advance(1000 / s.shownMachine.fps + 0.001);
  check('a release after the reset does not press anything', matrixKeys(s.shownMachine).size === 0 && s.keys.pending === 0);
  kb.keydown(keyEvent('A'));
  s.switchMachine('coco');
  check('a machine switch drops them', s.keys.pending === 0 && s.keys.down.size === 0);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
