// Run: node tests/halt-replay-split.test.js
//
// The CoCo 3's HALT inside an instruction moved out of the machine into js/machines/halt-replay.js (machine.halt, a
// HaltReplay), its members under their old names:
//  * no cycle and no byte changed: the scenario in tests/halt-replay-split-scenario.js (held for good on an empty drive;
//    the same with an outside write queued in the held window; a 6309 TFM over its own destination, held three frames
//    and released; coco-halt.asm's halted reads with a snapshot every 7 frames) gives, hash for hash, what it gave at
//    the commit before the move (tests/fixtures/halt-replay/expected.json, made with the old names on the machine):
//    every snapshot taken while an instruction is held, every instruction's registers and cycle count after it, every
//    frame's pixels, and the same continuation from each snapshot restored into a fresh machine;
//  * the machine holds one HaltReplay as `halt`, whose machine is the machine; of the moved names only the Machine
//    interface stays on the machine (replaying, cpuHeld, cpuCheck, stepN: js/machines/machine.js), answered by the
//    HaltReplay.
// (The MAME comparisons are tools/mame-diff/run.js coco3 --fdc cocofdc --halt [--empty] and the regression hashes.)
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
const { scenario } = require('./halt-replay-split-scenario');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/halt-replay/expected.json'), 'utf8'));
const MOVED = ['stepS', 'haltAt', 'haltS', 'haltK', 'haltN', 'haltDefer', 'ioShift', 'heldIo', 'outsideWrites', 'busA', 'busV', 'busN', 'busAt',
  'replayN', 'busHalt', 'waitLimit', 'logBus', 'busLogged', 'replayRead', 'replayWrite', 'replayEnd', 'outsideWrite', 'flushOutsideWrites',
  'haltWait', 'haltRun', 'haltFinish', 'haltSuspend', 'haltPark', 'haltResume', 'haltCancel', 'replayDropped', 'haltKeep', 'haltArrived', 'haltReleased'];
const INTERFACE = ['replaying', 'cpuHeld', 'cpuCheck', 'stepN'];

// ---- the fixtures ----
const got = scenario((m) => m.halt);
for (const k of Object.keys(expected)) {
  const a = JSON.stringify(got[k]), b = JSON.stringify(expected[k]);
  check(`${k}: the snapshots, traces, frames and restored continuations are the parent commit's`, a === b, a === b ? '' : `got ${a.slice(0, 400)} want ${b.slice(0, 400)}`);
}
check('the cases hold what they are for: held for good, a queued write, a held TFM, held and released through the run',
  got.empty.held && got.empty.log > 0 && got.queued.owed === 1 && got.queued.palette0 === 5 && got.tfm.held === 3 && got.tfm.after.instructions > 0
  && got.halted.snaps.some((s) => s.held) && got.halted.snaps.some((s) => !s.held));

// ---- the machine holds one HaltReplay, and none of the moved names ----
{
  const m = Emu.createMachine('coco3', {});
  check('machine.halt is a HaltReplay whose machine is the machine', m.halt && m.halt.constructor.name === 'HaltReplay' && m.halt.machine === m);
  const left = MOVED.filter((k) => k in m);
  check('none of the moved names is on the machine or its prototype', left.length === 0, left.join());
  const missing = MOVED.filter((k) => !(k in m.halt));
  check('every moved name is on the HaltReplay', missing.length === 0, missing.join());
  check('the Machine interface stays on the machine, answered by the HaltReplay',
    INTERFACE.every((k) => k in m) && m.cpuHeld === false && m.replaying() === false && m.stepN === m.halt.stepN);
  // the interface follows the HaltReplay: an instruction held there is held for the machine
  m.halt.haltDefer = { s: 0, k: 1, rel: -1, n: 2, speedChange: -1, log: [], resume: false, regs: null, mem: [] };
  check('cpuHeld answers from the HaltReplay', m.cpuHeld === true);
  // the machine's halting flag (what read and write test) follows logBus whoever sets its two fields
  const flags = [m.halting];
  m.halt.haltDefer = null; flags.push(m.halting);
  m.halt.busHalt = true; flags.push(m.halting);
  m.halt.haltDefer = { s: 0, k: 1, rel: -1, n: 2, speedChange: -1, log: [], resume: false, regs: null, mem: [] }; flags.push(m.halting);
  m.halt.busHalt = false; flags.push(m.halting);
  m.halt.haltDefer = null; flags.push(m.halting);
  check('the machine\'s halting flag follows logBus (an instruction held, or a HALT-capable device attached)',
    flags.join() === 'true,false,true,true,true,false' && flags.every((f, i) => i === 0 || typeof f === 'boolean'), flags.join());
  // and attaching the CoCo FDC, which can assert HALT, raises it through the machine's own devicesAttached
  const f = new Emu.devices.cocofdc({ rom: new Uint8Array(0x2000) });
  m.insertCartridge(f);
  const attached = m.halting && m.halt.logBus;
  m.ejectCartridge();
  check('a HALT-capable cartridge raises the flag, and taking it out lowers it', attached && m.halting === false && m.halt.logBus === false);
}

console.log(`\n${n - fail}/${n} HALT replay split checks passed`);
process.exitCode = fail ? 1 : 0;
