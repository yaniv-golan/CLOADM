// Compares the Hi-Res joystick interface firmware (tools/mame-diff/sam/hires.asm, hires-max3.asm) with MAME
// in instruction lockstep: every register and every cycle count must be identical, and the firmware must
// reach HALT. That is the proof; a run that only compared the final counts missed a one-cycle difference in
// when the one-shot expired.
//
// MAME cannot change a port CONFIG field while it runs (the Lua API has no setter: ioport_field::set_value
// only sets live input fields), so the interface is selected in MAME's per-system cfg (lib/firmware.js
// writeCfg) and only the joystick analogue ports are set from Lua, which are live inputs.
//
//   node tools/mame-diff/sam/run-hires.js <profile> [max3|rat]
//
// dragon64 and coco use the sam spec; coco3 uses the coco3 spec (whose stick ports are named AD Stick X/Y).
const { lockstep } = require('../lib/lockstep');

const args = process.argv.slice(2);
const kind = args.find((a) => a === 'max3' || a === 'rat') || 'tandy';
const profileId = args.find((a) => !a.startsWith('--') && !['max3', 'rat'].includes(a)) || 'coco';
const family = profileId.startsWith('coco3') ? 'coco3' : 'sam';
const spec = require(`../${family}/spec`);
// MAME's stick is 10-bit and ours 6-bit: compare the positions both can hold exactly (multiples of 63/1023).
// For the Rat those become its four 2-bit counts.
const positions = [0, 341, 682, 1023];
if (kind === 'rat' && family !== 'coco3') {
  console.error('the Rat mouse is a CoCo 3 device (MAME coco3.cpp coco_rat_mouse): use `run-hires.js coco3 rat`');
  process.exitCode = 2;
  return;   // module top level: nothing below runs
}

(async () => {
  for (const pos of positions) {
    const t = spec.hiresLockstep(profileId, { kind, pos });
    t.install();
    const code = await lockstep(Object.assign({}, t, { machine: t.machine() }));
    // stop the comparison here rather than report the line below as a success
    if (code !== 0) { console.log(`FAIL stick ${pos}`); process.exitCode = 1; return; }
  }
  console.log(`[${profileId} hires ${kind}] lockstep identical at every stick position (${positions.join(', ')}), HALT reached in each`);
  process.exitCode = 0;
})();
