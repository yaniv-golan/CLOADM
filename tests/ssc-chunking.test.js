// Card-level chunking invariance: a fresh card advanced to the same target in one call vs in many chunks must
// end in the same state. This is the property the card's clock must have: cardPos is its only notion of "when",
// so splitting a catch-up must not change what the PIC has executed.
//
// If this ever fails, catchUp() carries state through the chunking and the fix belongs there. It passes, and
// tests/ssc.test.js's access-invariance case covers the other half: the card's state at a given machine time
// must not depend on how the 6809 is driven either.
const path = require('path');
const Emu = require('./load')();
const { buildPic, buildSp0256 } = require('../tools/mame-diff/ssc/gen-roms.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const PIC = buildPic(), SP = buildSp0256();

// a card on a host whose clock we drive by hand (ioTime is the card's machine time, AGENTS section 2)
function makeCard(startAt) {
  const host = { ioTime: () => Number(now), clockUnits: () => Number(now), powerOnTick: () => 0, unitAttos: 1n, tickHz: 894886.25, cartClockHz: 894886.25, schedule() {}, cancel() {} };
  let now = startAt;
  const p = new Emu.SpeechSoundPak({ tms7040Rom: PIC, sp0256Rom: SP });
  p.host = host;
  p.clock = { now: () => BigInt(now), timer: () => ({ adjust() {} }) };
  p.buildChips();
  p.reset(false);
  p.cardPos = BigInt(startAt);
  return { p, set: (t) => { now = t; } };
}

// advance from `startAt` to `target`, stopping at each chunk first
function advance(startAt, target, chunks) {
  const { p, set } = makeCard(startAt);
  for (const c of chunks) { set(c); p.catchUp(); }
  set(target); p.catchUp();
  return { picPC: p.tms7040.pc, picCyc: p.tms7040.totalCycles, cardPos: p.cardPos.toString(), busy: p.busy };
}
const show = (x) => `picPC=${x.picPC.toString(16)} picCyc=${x.picCyc} cardPos=${x.cardPos} busy=${x.busy ? 'SET' : 'clear'}`;

const START = 4, TARGET = 59;
// the frame path's real catch-up targets, from the instrumented run
const observed = [7, 11, 11, 11, 11, 15, 15, 15, 15, 23, 23, 23, 23, 23, 23, 25, 25, 30, 30, 30];
const random = (() => {
  const out = []; let seed = 12345;
  for (let i = 0; i < 30; i++) { seed = (seed * 1103515245 + 12345) >>> 0; out.push(START + (seed % (TARGET - START))); }
  return out.sort((a, b) => a - b);
})();

const one = advance(START, TARGET, []);
const perByte = advance(START, TARGET, Array.from({ length: TARGET - START - 1 }, (_, i) => START + 1 + i));
const seen = advance(START, TARGET, observed);
const rand = advance(START, TARGET, random);

check('one catch-up and byte-by-byte catch-ups reach the same card state', show(one) === show(perByte), `${show(one)} vs ${show(perByte)}`);
check('the frame path\'s real target sequence gives the same state as one catch-up', show(one) === show(seen), `${show(one)} vs ${show(seen)}`);
check('a random target sequence gives the same state as one catch-up', show(one) === show(rand), `${show(one)} vs ${show(rand)}`);
check('the card advanced to the target', one.cardPos === String(TARGET), one.cardPos);

console.log(`${n - fail}/${n} card chunking checks passed`);
process.exitCode = fail ? 1 : 0;
