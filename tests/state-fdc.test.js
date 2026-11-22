const fs = require('fs');
// // Run: node tests/state-fdc.test.js
//
// Floppy controllers snapshotted in the middle of a transfer, one machine per controller. Split out of
// state.test.js so this slow part can be run on its own; the checks are unchanged.
const path = require('path');
const { Emu, spec, check, run, counts, checkNames, missingFromSlice } = require('./state-common.js');

// floppy controllers in the middle of a transfer (fdc/ firmware): the chip's bit-level state, the drives'
// rotation, the flux written so far and the slot's pending NMI/HALT timers must all come back.
// These are checked separately below, one machine per controller: each machine is built once and snapshotted at
// every point in turn instead of once per point, so the run up to each point is not repeated.
const FDC_MIDWAY = { 4: 'read sector', 7: 'write track', 8: 'write sector' };
const fdcCases = [];
for (const [id, controller, at, what] of [['dragon64', 'dragonfdc', 104, 4], ['dragon64', 'dragonfdc', 247, 7], ['dragon64', 'dragonfdc', 286, 8],
  ['coco', 'cocofdc', 244, 8], ['coco', 'cocofdc', 305, 7], ['coco', 'cocofdc', 482, 4], ['coco3', 'cocofdc', 244, 8], ['coco3', 'cocofdc', 305, 7], ['coco3', 'cocofdc', 482, 4], ['coco', 'multifdc', 244, 8], ['coco', 'multifdc', 482, 4], ['dragon64', 'premierfdc', 120, 4], ['dragon64', 'premierfdc', 184, 8],
  ['dgnalpha', 'alphafdc', 104, 4], ['dgnalpha', 'alphafdc', 251, 7], ['dgnalpha', 'alphafdc', 192, 8]]) {
  fdcCases.push({ id, controller, at, what, name: `${id} ${controller} ${FDC_MIDWAY[what]}` });
}
// in a Multi-Pak's slot 4 (<board>-multi.asm): a write in the diagnostic; the Dragon's read while CTS selects slot 1
// (the firmware running from RAM, DRQ's CART held back); the CoCo's read with the CPU halted while SCS selects slot 1
for (const [id, controller, at, what, select] of [['dragon64', 'dragonfdc', 286, 8, 0xff], ['dragon64', 'dragonfdc', 425, 4, 0x03], ['coco', 'cocofdc', 537, 4, 0x30]]) {
  fdcCases.push({ id, controller, at, what, multi: true, select, name: `${id} ${controller} in a Multi-Pak ${FDC_MIDWAY[what]} (select $${select.toString(16).toUpperCase()})` });
}
// The floppy controllers, one machine per controller: build it, then snapshot at each of its points in turn and
// let the machine carry on between them. Every check is the same as above (the controller is mid-transfer, the
// restored copy runs identically); the machine is built once instead of once per point, which is what made
// these eleven cases three quarters of this suite's run time.
{
  const byController = new Map();
  for (const c of fdcCases) { const k = `${c.id} ${c.controller}${c.multi ? ' multi' : ''}`; if (!byController.has(k)) byController.set(k, []); byController.get(k).push(c); }
  for (const [key, list] of byController) {
    const t = spec('fdc').trace(list[0].id, { controller: list[0].controller, regenerate: false, multi: !!list[0].multi });
    const a = t.machine();
    let frame = 0;
    for (const c of [...list].sort((x, y) => x.at - y.at)) {
      for (; frame < c.at; frame++) a.runFrame();
      const wd = t.fdcOf(a).wd;
      check(`snapshot taken during the ${FDC_MIDWAY[c.what]} (${key})`, wd.mainState === c.what && wd.live.state !== 0 && (!c.multi || a.cartPort.select === c.select),
        `(main ${wd.mainState} live ${wd.live.state}${a.cpu.haltLine ? ', CPU halted' : ''}${c.multi ? `, select $${a.cartPort.select.toString(16)}` : ''})`);
      const text = Emu.state.toJSON(a.snapshot());
      const b = Emu.restoreSnapshot(Emu.state.fromJSON(text), a.roms);
      for (const k of t.keys || []) b.setKey(k, true);
      const aTrace = run(a, t.regs, 40), bTrace = run(b, t.regs, 40);
      check(`${c.name}: restored machine runs identically`, aTrace === bTrace, `(snapshot ${(text.length / 1024).toFixed(0)} KB at frame ${c.at})`);
      // restored in place, over its own later state: the controller is detached before the snapshot's event queue
      // comes back, so the restored controller's events (same names) stay; the machine is then where the run left it
      a.restore(Emu.state.fromJSON(text));
      for (const k of t.keys || []) a.setKey(k, true);
      check(`${c.name}: restored in place over the running machine, runs identically`, run(a, t.regs, 40) === aTrace);
      frame += 40;   // those 40 frames are part of the run, so the next point is measured from here
    }
  }
}


// THE SPLIT IS FAITHFUL: this suite's check names must be exactly its slice of the names the unsplit suite ran.
// Counting alone would let a dropped check and a duplicated one cancel out; the names cannot.
{
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'state-check-names.json'), 'utf8'))['state-fdc'];
  const { missing, extra } = missingFromSlice(checkNames(), manifest);
  // an ordinary check of its own, so a slice mismatch is COUNTED like every other failure and the summary's
  // "ok/total" adds up (it used to bump the failure count without a matching name, printing 14/15 when 15 ran)
  check('state-fdc: its checks are exactly its slice of the unsplit suite\'s names', !missing.length && !extra.length,
    missing.length || extra.length ? `${missing.length} missing, ${extra.length} extra` : '');
  for (const n of missing.slice(0, 3)) console.log(`  missing: ${n}`);
  for (const n of extra.slice(0, 3)) console.log(`  extra:   ${n}`);
}
const __c = counts();
console.log(`\n${__c.ok}/${__c.ok + __c.fail} state-fdc checks passed`);
process.exitCode = __c.fail ? 1 : 0;
