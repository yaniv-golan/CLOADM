// Touch joystick: the vector -> axis mapping (js/host/input.js), hand-computed values; and the stick's path
// into the machine compared with the gamepad's, on the same firmware reading the same port.
//
// Oracle: the mapping's expected values are worked out from the formulas in the brief by hand (centre 32,
// ends 0 and 63, DEAD_ZONE 0.25 on each axis, a push past the radius clamped per axis - not to the unit circle).
// The machine path is our own firmware: it scans PIA0 (the row port the joystick's button bit lives on) and
// records what it reads, so the touch stick and a gamepad can be compared by what the CPU itself saw. MAME has
// no touch panel, but the joystick port is already verified against MAME (tools/mame-diff/sam/spec.js
// hiresLockstep and the diag.asm axis reads), so the hardware here is not in question: only which path the
// page's input takes.
const path = require('path');
const Emu = require('./load')();
const { HostInput, DEAD_ZONE, STICK_RADIUS, stickVector, touchJoystickOffered, stickAxis } = require('../js/host/input.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };

const machine = (id, config) => { const m = Emu.createMachine(id, config); m.reset(true); return m; };
// the axis a dead-zone test needs: inside the zone -> 32, outside -> the axis formula
const axis = (v) => (Math.abs(v) < DEAD_ZONE ? 32 : Math.round((Math.max(-1, Math.min(1, v)) + 1) / 2 * 63));

// ---------------- the vector: pixels -> the -1..1 a pad reports ----------------
{
  const r = STICK_RADIUS;
  const v = (dx, dy) => stickVector(dx, dy).map((n) => Math.round(n * 1000) / 1000);
  check('a finger at the base is the stick at rest', JSON.stringify(v(0, 0)) === '[0,0]', JSON.stringify(v(0, 0)));
  check('a straight push to the travel radius is full deflection', JSON.stringify(v(r, 0)) === '[1,0]' && JSON.stringify(v(0, -r)) === '[0,-1]', JSON.stringify(v(r, 0)));
  check('half the travel radius is half deflection', JSON.stringify(v(r / 2, 0)) === '[0.5,0]', JSON.stringify(v(r / 2, 0)));
  // a pad's axes are independent, so a diagonal is full on both: the corner is (1,1), which the axis formula
  // turns into 63,63 (the pad's own corner, not a squashed circle: there is no touch-only rescale)
  check('a diagonal push is full on both axes, as a pad\'s corner is', JSON.stringify(v(r, r)) === '[1,1]', JSON.stringify(v(r, r)));
  // a push past the radius is clamped at each end, not compressed along its direction
  check('a push past the travel radius is clamped, not scaled', JSON.stringify(v(3 * r, 0)) === '[1,0]' && JSON.stringify(v(2 * r, 2 * r)) === '[1,1]', JSON.stringify(v(3 * r, 0)));
  // up the screen is -1 (the machines' 0 is up): a finger 56 px above the base is axis 0
  const m = machine('dragon64'), input = new HostInput(m, new Emu.KeyQueue());
  input.touchStick(0, -r);
  check('a finger up the screen drives the machines\' 0 (up)', m.joy[0][1] === 0, `${m.joy[0]}`);
  input.touchStick(0, r);
  check('a finger down the screen drives the machines\' 63 (down)', m.joy[0][1] === 63, `${m.joy[0]}`);
  input.touchStick(-r, 0);
  check('a finger left drives 0, right 63', m.joy[0][0] === 0, `${m.joy[0]}`);
  input.touchStick(r, 0);
  check('a finger right drives 63', m.joy[0][0] === 63, `${m.joy[0]}`);
  // the dead zone, at its edges: 0.24 of the radius centres, 0.26 deflects (to an axis value worked out
  // from 0.26: (0.26 + 1) / 2 * 63 = 39.69 -> 40; -0.26: (0.74) / 2 * 63 = 23.31 -> 23)
  input.touchStick(0.24 * r, 0);
  check('inside the dead zone the stick is centred', m.joy[0][0] === 32, `${m.joy[0]}`);
  input.touchStick(0.26 * r, 0);
  check('just outside the dead zone it deflects to the pad formula', m.joy[0][0] === 40, `${m.joy[0]}`);
  input.touchStick(-0.26 * r, 0);
  check('and to the left, the same formula the other side', m.joy[0][0] === 23, `${m.joy[0]}`);
  // a small diagonal whose components are each inside the zone stays centred (each axis is tested alone)
  input.touchStick(0.1 * r, -0.1 * r);
  check('a diagonal inside the zone is centred on both axes', m.joy[0][0] === 32 && m.joy[0][1] === 32, `${m.joy[0]}`);
  // releasing centres both axes
  input.touchStick(r, -r);
  input.touchStickRelease();
  check('letting go centres the stick', m.joy[0][0] === 32 && m.joy[0][1] === 32, `${m.joy[0]}`);
  // FIRE is the joystick's button bit, and it is joystick 0's (the right one)
  input.touchFire(true);
  check('FIRE is the right joystick\'s button', m.fire[0] === true && m.fire[1] === false, `${m.fire}`);
  input.touchFire(false);
  check('letting go drops it', m.fire[0] === false);
}

// ---------------- the dead zone's own boundary, exactly ----------------
// The zone is STRICT (`<` DEAD_ZONE): exactly DEAD_ZONE deflects, a hair less centres. A `<=` mutant passes every
// other case here (0.24 vs 0.26 straddles the boundary without touching it), so this is the case that kills it.
// axisValue(DEAD_ZONE) = round((0.25 + 1) / 2 * 63) = round(39.375) = 39.
{
  const just = DEAD_ZONE - 1e-9;
  check('exactly DEAD_ZONE deflects (strict <): 39, not centred', stickAxis(DEAD_ZONE) === 39, `${stickAxis(DEAD_ZONE)}`);
  check('exactly DEAD_ZONE to the left: 24, not centred', stickAxis(-DEAD_ZONE) === 24, `${stickAxis(-DEAD_ZONE)}`);   // (0.75)/2*63 = 23.6 -> 24
  check('a hair inside DEAD_ZONE still centres', stickAxis(just) === 32 && stickAxis(-just) === 32, `${stickAxis(just)},${stickAxis(-just)}`);
  // and the touch stick goes through the same function: the boundary reads the same on the machine
  const m = machine('dragon64'), input = new HostInput(m, new Emu.KeyQueue());
  input.touchStick(DEAD_ZONE * STICK_RADIUS, 0);
  const onEdge = m.joy[0][0];
  input.touchStick(just * STICK_RADIUS, 0);
  const inside = m.joy[0][0];
  check('the touch stick at the boundary: 39, a hair inside: centred', onEdge === 39 && inside === 32, `${onEdge},${inside}`);
}

// ---------------- the mapping agrees with the pads' ----------------
{
  const a = machine('coco'), b = machine('coco');
  const ia = new HostInput(a, new Emu.KeyQueue()), ib = new HostInput(b, new Emu.KeyQueue());
  // the same deflection through both paths: the stick's vector equals the pad's axes, so the machine sees the
  // same pair on both (the brief: the same dead-zone function, no touch-only rescale)
  for (const [x, y] of [[0, 0], [0.24, 0], [0.26, 0], [1, -1], [-0.6, 0.35], [0.5, 0.5]]) {
    ia.touchStick(x * STICK_RADIUS, y * STICK_RADIUS);
    // the pad reports the same vector directly
    ib.setGamepad(0, { axes: [x, y], buttons: [false, false] });
    const want = [axis(x), axis(y)];
    check(`stick (${x},${y}) maps as the pad does`, JSON.stringify(ia.m.joy[0]) === JSON.stringify(want) && JSON.stringify(ib.m.joy[0]) === JSON.stringify(want)
      && JSON.stringify(a.joy[0]) === JSON.stringify(b.joy[0]), `touch ${a.joy[0]} pad ${b.joy[0]} want ${want}`);
  }
}

// ---------------- the panel's offer: which machines, and which ports ----------------
{
  check('the Dragon 64 offers the stick', touchJoystickOffered(machine('dragon64')) === true);
  check('the CoCo 3 offers it', touchJoystickOffered(machine('coco3')) === true);
  check('the MC-10 has no joystick port: no stick offered', touchJoystickOffered(machine('mc10')) === false);
  check('the Matra Alice too', touchJoystickOffered(machine('alice')) === false);
  // a Hi-Res interface in the right port takes that port (the stick's own): the panel offers no stick
  const h = machine('coco3', { hires: 'tandy-right' });
  check('a Tandy Hi-Res interface in the right port: no stick offered', touchJoystickOffered(h) === false);
  const h2 = machine('dragon64', { hires: 'max3-right' });
  check('a CoCo Max 3 interface in the right port: no stick offered', touchJoystickOffered(h2) === false);
  const rat = machine('coco', { hires: 'rat-right' });
  check('The Rat in the right port: no stick offered', touchJoystickOffered(rat) === false);
  // the left port's interface leaves the right port's stick alone
  const l = machine('dragon64', { hires: 'tandy-left' });
  check('an interface in the left port only: the right port\'s stick is still offered', touchJoystickOffered(l) === true);
}

// ---------------- FIRE reaches the CPU on the joystick's row, as the gamepad's does ----------------
// Our firmware (tools/mame-diff/sam/fire-scan.asm, in the BASIC socket; this test is what runs it): it
// sets PIA0 up as the machine's own scan does and stores the row byte with no button down and again once one
// shows. Joystick 0's button pulls PA0 low and joystick 1's PA1 (cocopia.js), so the byte names the button that
// was down. The touch FIRE and a gamepad's button must leave the firmware the same byte: that is the check that
// the two paths meet the machine in the same place.
const { assembleFile } = require('../tools/mame-diff/lib/firmware');
const FW_ASM = assembleFile(path.join(__dirname, '../tools/mame-diff/sam/fire-scan.asm'), '6809');
const slotFor = { dragon64: 0x4000, coco3: 0x8000 };
const runFire = (id, press) => {
  const rom = new Uint8Array(slotFor[id]).fill(0xFF);
  rom.set(FW_ASM.segments[0].data, 0);
  const s = new Emu.Session();
  s.switchMachine(id);
  s.machine.setRoms({ basic: rom });
  s.machine.reset(true);
  s.machine.cpu.jump(FW_ASM.exec);
  for (let i = 0; i < 3; i++) s.advance(1000 / s.machine.fps + 0.01);
  if (press) press(s.machine);
  for (let i = 0; i < 4; i++) s.advance(1000 / s.machine.fps + 0.01);
  const base = FW_ASM.symbols.get('MARK');
  return { m: s.machine, base };
};
for (const id of ['dragon64', 'coco3']) {
  const idle = runFire(id, null);
  check(`${id}: the firmware ran`, idle.m.ram[idle.base] === 0x5A, `$${idle.m.ram[idle.base].toString(16)}`);
  check(`${id}: no button, both button rows high`, (idle.m.ram[idle.base + 1] & 0x03) === 0x03, `$${idle.m.ram[idle.base + 1].toString(16)}`);
  const byTouch = runFire(id, (m) => { const input = new HostInput(m, new Emu.KeyQueue()); input.touchFire(true); });
  const byPad = runFire(id, (m) => { const input = new HostInput(m, new Emu.KeyQueue()); input.setGamepad(0, { axes: [0, 0], buttons: [true, false] }); });
  check(`${id}: the firmware saw the touch FIRE on PA0`, byTouch.m.ram[byTouch.base + 3] === 0xA5 && (byTouch.m.ram[byTouch.base + 2] & 0x01) === 0,
    `$${byTouch.m.ram[byTouch.base + 2].toString(16)} done $${byTouch.m.ram[byTouch.base + 3].toString(16)}`);
  check(`${id}: the gamepad's button reads exactly as the touch FIRE did`, byTouch.m.ram[byTouch.base + 2] === byPad.m.ram[byPad.base + 2],
    `touch $${byTouch.m.ram[byTouch.base + 2].toString(16)} pad $${byPad.m.ram[byPad.base + 2].toString(16)}`);
  check(`${id}: the first reading is the one with nothing down (both button bits high)`, (byTouch.m.ram[byTouch.base + 1] & 0x03) === 0x03,
    `$${byTouch.m.ram[byTouch.base + 1].toString(16)}`);
}
// the left joystick's button is PA1, a different bit: the firmware's wait is on either bit, so it shows PA1 low
// and PA0 high. (The touch stick sets joystick 0's only - one stick, the right joystick - so this is the pad alone.)
{
  const p = runFire('dragon64', (m) => { const input = new HostInput(m, new Emu.KeyQueue()); input.setGamepad(1, { axes: [0, 0], buttons: [false, false, true] }); });
  check('dragon64: the left joystick\'s button is PA1, not PA0', p.m.ram[p.base + 3] === 0xA5 && (p.m.ram[p.base + 2] & 0x02) === 0 && (p.m.ram[p.base + 2] & 0x01) === 0x01,
    `$${p.m.ram[p.base + 2].toString(16)}`);
}

// ---------------- the welcome menu's taps never reach it in joystick mode ----------------
// That is the page's rule (js/ui/screen.js checks page.touchKeys.stickActive before a tap becomes a menu
// choice); the page-level behaviour is in tools/browser-check.js (touchJoystickChecks), where a tap on the
// menu's lines during a joystick session must not start the demo.

console.log(`\n${n - fail}/${n} touch joystick checks passed`);
process.exitCode = fail ? 1 : 0;
