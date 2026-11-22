// What the state suites share: the loader, the check counter and its total, the trace hash, and the run helper that
// compares a machine with the one restored from its snapshot. Nothing here runs on its own; tests/state.test.js and
// its siblings (state-fdc, state-carts, state-tape) require it. The counts are shared so the split can be required to
// add up to the suite it came from.
const path = require('path');
const Emu = require('./load')();

let fail = 0, n = 0;
const names = [];   // every check name, in order: each suite asserts its own against tests/state-check-names.json
const check = (name, cond, detail = '') => {
  n++; names.push(name);
  if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`);
};

const spec = (family) => require(path.join(__dirname, '../tools/mame-diff', family, 'spec.js'));
const fnv = (h, v) => { h ^= v & 0xFFFFFFFF; return Math.imul(h, 0x01000193) >>> 0; };

// hash `frames` frames of execution: every instruction's registers and cycle count, every frame's pixels and its
// sound (the machine's level events, a cartridge's sound mixed in)
function run(m, regs, frames) {
  let h = 0x811C9DC5;
  m.cpu.trace = (c) => { for (const r of regs) h = fnv(h, c[r.name]); h = fnv(h, c.totalCycles); };
  for (let f = 0; f < frames; f++) {
    m.runFrame();
    for (const v of m.audioEvents) h = fnv(h, Math.round(v * 1e6));
    if (f > 0) { const px = m.render().data; for (let i = 0; i < px.length; i += 7) h = fnv(h, px[i]); } // frame 0 may hold a pre-snapshot picture
  }
  m.cpu.trace = null;
  return h >>> 0;
}

// how many checks this process has run: each suite prints its own, and the totals are added up by the guard
const counts = () => ({ ok: n - fail, fail });
const checkNames = () => names.slice();
// a suite's end: its own check names must be exactly its slice of the unsplit suite's names. Counting cannot prove
// this (a drop and a duplicate cancel out); names can. Returns the problems, so the caller prints them as FAILs.
const missingFromSlice = (mine, want) => ({
  missing: want.filter((n) => !mine.includes(n)),
  extra: mine.filter((n) => !want.includes(n)),
});

module.exports = { Emu, check, spec, fnv, run, counts, checkNames, missingFromSlice };
