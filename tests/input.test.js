// Host input mapping, DOM-free: the translated and positional keyboard modes for every machine family,
// the keyboard joystick, gamepad state, and the CoCo Max Hi-Res mouse. No browser, no DOM.
//
// The matrices are the machines' published ones. Every expected position below was read from MAME 0.264's
// input-port definitions of the same keyboard: src/mame/trs/dragon.cpp (dragon_keyboard),
// src/mame/trs/coco3.cpp (coco3_keyboard, which the CoCo 1/2 shares in js/machines/keyboards.js),
// src/mame/trs/mc10.cpp (mc10 and alice). There a port is a matrix row and a bit a column for the Dragons
// and CoCos; for the MC-10 and Alice port 1 strobes the columns and $BFFF reads the rows, so the two are
// the other way round. js/machines/keyboards.js lays out the same matrices, so a key's own legend and the
// positional map must agree, which is what the cross-check below asserts.
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log('ok   ', name, detail); };

const machine = (id, config) => { const m = Emu.createMachine(id, config); m.reset(true); return m; };
// What the mapping decided the machine should hold. HostInput hands its held set to the machine's KeyQueue
// (js/machines/keyqueue.js), which applies it at frame starts so a fast typist loses nothing, so the mapping
// is read from the queue here; tests/keyqueue.test.js proves the queue puts it into the matrix.
const held = (q) => [...q.want].sort();
// step the queue until the machine's matrix holds exactly `want` and confirm it does
const onMatrix = (m, q, want, steps = 6) => {
  for (let i = 0; i < steps; i++) q.step(m);
  const got = Object.keys(m.keyPos).filter((n) => m.keyCols[m.keyPos[n][1]] & (1 << m.keyPos[n][0])).sort();
  return { got, ok: want.every((k) => got.includes(k)) };
};

// ---------------- translated mode: the character typed reaches the machine ----------------
// Shift+2 is " on a Dragon and on a CoCo (the matrices are the same shape; only the rows differ), and on the
// MC-10 too. The physical key need not be the one with the legend: the character decides.
const translated = [
  ['dragon64', { key: '"', code: 'Digit2', shiftKey: true }, ['SHIFT', '2']],
  ['dragon32', { key: '"', code: 'Digit2', shiftKey: true }, ['SHIFT', '2']],
  ['coco', { key: '"', code: 'Digit2', shiftKey: true }, ['SHIFT', '2']],
  ['coco3', { key: '"', code: 'Digit2', shiftKey: true }, ['SHIFT', '2']],
  ['mc10', { key: '"', code: 'Digit2', shiftKey: true }, ['SHIFT', '2']],
  ['alice', { key: '"', code: 'Digit2', shiftKey: true }, ['SHIFT', '2']],
  ['mc10', { key: 'a', code: 'KeyA' }, ['A']],            // Micro Color BASIC has capitals only
  ['alice', { key: 'a', code: 'KeyA' }, ['A']],
  ['dragon64', { key: ':', code: 'Semicolon' }, [':']],     // physical ; is matrix ;, but ':' is a legend of its own
  ['coco', { key: ':', code: 'Semicolon', shiftKey: false }, [':']],
  ['coco3', { key: '^', code: 'Digit6', shiftKey: true }, ['UP']],  // SHIFT+6 is ^ on the CoCos' own legends
];
for (const [id, ev, want] of translated) {
  const m = machine(id), q = new Emu.KeyQueue(), input = new Emu.HostInput(m, q);
  if (ev.shiftKey) input.keydown({ key: 'Shift', code: 'ShiftLeft', shiftKey: true });
  input.keydown(ev);
  const got = held(q);
  check(`${id} translated: ${ev.key} reaches the machine`, want.every((k) => got.includes(k)), `held ${got.join('+') || '-'}`);
  // and the queue carries it into the matrix the machine reads (the queue's rules are keyqueue.test.js's)
  const onM = onMatrix(m, q, want);
  check(`${id} translated: the matrix holds it`, onM.ok, `matrix ${onM.got.join('+') || '-'}`);
  input.keyup(ev);
  if (ev.shiftKey) input.keyup({ key: 'Shift', code: 'ShiftLeft' });
  check(`${id} translated: release clears the matrix`, held(q).length === 0, held(q).join('+'));
}

// ---------------- positional mode: the physical key position maps to the matrix ----------------
// The Alice has an AZERTY legend on the MC-10 matrix: the physical Q types A there, where the MC-10's Q
// types Q. Positional mode must ignore the legend of the character and use the position instead.
{
  const m = machine('alice'), q = new Emu.KeyQueue(), input = new Emu.HostInput(m, q);
  input.mode = 'positional';
  input.keydown({ key: 'a', code: 'KeyQ' });
  check('alice positional: physical Q types A (MAME alice pb1 bit 0x01, legend Q)', held(q).join('+') === 'Q', `held ${held(q).join('+')}`);
  input.keyup({ key: 'a', code: 'KeyQ' });
  input.keydown({ key: 'q', code: 'KeyA' });
  check('alice positional: physical A types Q (MAME alice pb1 bit 0x04, legend A)', held(q).join('+') === 'A', `held ${held(q).join('+')}`);
  input.keyup({ key: 'q', code: 'KeyA' });
}
{
  const m = machine('mc10'), q = new Emu.KeyQueue(), input = new Emu.HostInput(m, q);
  input.mode = 'positional';
  input.keydown({ key: ';', code: 'Semicolon' });      // MC-10: ; is row 5, column 3 (MAME mc10 pb3 bit 0x20)
  check('mc10 positional: physical ; types ;', held(q).join('+') === ';', `held ${held(q).join('+')}`);
  input.keyup({ key: ';', code: 'Semicolon' });
  input.keydown({ key: 'a', code: 'KeyQ' });           // MAME mc10 pb1 bit 0x04 is the legend Q
  check('mc10 positional: physical Q types Q', held(q).join('+') === 'Q', `held ${held(q).join('+')}`);
  input.keyup({ key: 'a', code: 'KeyQ' });
}

// Every physical key in each layout's positional map reaches the matrix position its legend names. This is
// the check that would catch a mistyped legend or position in the tables.
for (const [id, layout] of [['dragon64', 'dragon'], ['coco', 'coco'], ['coco3', 'coco'], ['mc10', 'mc10'], ['alice', 'alice']]) {
  const m = machine(id), q = new Emu.KeyQueue(), input = new Emu.HostInput(m, q);
  input.mode = 'positional';
  const map = Emu.positionalKeys[layout], bad = [];
  let n = 0;
  for (const [code, legend] of Object.entries(map)) {
    input.keydown({ key: '', code });
    const got = held(q);
    if (got.length !== 1 || got[0] !== legend) bad.push(`${code}->${got.join('+') || '-'} want ${legend}`);
    if (got.length) n++;
    input.keyup({ key: '', code });
  }
  check(`${id} positional: all ${n} mapped keys reach their legend's matrix position`, bad.length === 0 && n >= 40, bad.slice(0, 3).join('; '));
}

// ---------------- keyboard joystick ----------------
// The chosen keys drive one joystick at a time, both axes and the button, through the machine's own joystick
// state (m.joy / m.fire), so any ROM sees it however it reads the comparator.
{
  const m = machine('coco'), q = new Emu.KeyQueue(), input = new Emu.HostInput(m, q);
  input.joyKeys = true;
  input.keydown({ key: 'w', code: 'KeyW' });            // left joystick up
  check('keyboard joystick: W drives the left joystick up', m.joy[1][1] < 32, `y=${m.joy[1][1]}`);
  check('keyboard joystick: W does not also type W', !held(q).includes('W'), held(q).join('+'));
  input.keyup({ key: 'w', code: 'KeyW' });
  check('keyboard joystick: releasing centres the left joystick', m.joy[1][1] === 32, `y=${m.joy[1][1]}`);
  input.keydown({ key: ' ', code: 'Space' });
  check('keyboard joystick: Space fires the left joystick', m.fire[1] === true && m.fire[0] === false);
  input.keyup({ key: ' ', code: 'Space' });
  check('keyboard joystick: releasing Space drops fire', m.fire[1] === false);
  input.keydown({ key: '8', code: 'Numpad8' });         // numpad drives the right joystick
  check('keyboard joystick: numpad 8 drives the right joystick up', m.joy[0][1] < 32, `y=${m.joy[0][1]}`);
  input.keyup({ key: '8', code: 'Numpad8' });
  input.joyKeys = false;
  input.keydown({ key: 'w', code: 'KeyW' });
  check('keyboard joystick off: keys type again', held(q).includes('W') && m.joy[1][1] === 32);
  input.keyup({ key: 'w', code: 'KeyW' });
}

// ---------------- gamepad ----------------
// A gamepad arrives as numbers from js/host/gamepad.js: two sticks in -1..1, a dead zone, buttons. The
// dead zone matters: a stick at rest must not hold a direction, and one past the dead zone must.
{
  const m = machine('coco'), q = new Emu.KeyQueue(), input = new Emu.HostInput(m, q);
  input.setGamepad(0, { axes: [0.1, 0.1], buttons: [false, false] });
  check('gamepad: a stick inside the dead zone is centred', m.joy[0][0] === 32 && m.joy[0][1] === 32, `${m.joy[0]}`);
  input.setGamepad(0, { axes: [1, -1], buttons: [true, false] });
  check('gamepad: full right and up reach the machine at its extremes', m.joy[0][0] === 63 && m.joy[0][1] === 0, `${m.joy[0]}`);
  check('gamepad: button 0 is the joystick button', m.fire[0] === true);
  input.setGamepad(1, { axes: [-1, 0], buttons: [false, false, true] });   // its button is the third
  check('gamepad 1 drives the left joystick', m.joy[1][0] === 0 && m.fire[1] === true, `${m.joy[1]} fire ${m.fire[1]}`);
  input.setGamepad(0, { axes: [0, 0], buttons: [false, false] });
  input.setGamepad(1, { axes: [0, 0], buttons: [false, false] });
  check('gamepad: sticks at rest centre both joysticks and drop fire', m.joy[0][0] === 32 && m.joy[1][0] === 32 && !m.fire[0] && !m.fire[1]);
  // the dead zone is a property of the wrapper's mapping, and the button map is a pair of indices
  input.setGamepad(0, { axes: [0, 1], buttons: [false, true] });
  check('gamepad: only the mapped button fires', m.fire[0] === false && m.fire[1] === false);
}

// ---------------- CoCo Max Hi-Res mouse ----------------
// The module is a cartridge. Each read returns the value the previous read staged and stages the next one,
// cycling Y ($FF90), X ($FF91), left button ($FF92), right button ($FF93); $FF94-$FF97 have nothing
// connected, so the staged value stays. MAME 0.264 src/devices/bus/coco/coco_max.cpp, ff90_read: the first
// read after power-on returns 0 because nothing has been sampled yet, so a program reads twice per axis.
{
  const m = machine('coco'), q = new Emu.KeyQueue(), input = new Emu.HostInput(m, q);
  input.setMouse({ x: 0.25, y: 0.75, left: true, right: false });
  check('CoCo Max: the host input gives the machine its mouse', m.mouse === input.mouse);
  // the page makes its HostInput before any machine exists (js/ui/screen.js), then hands it one
  let early = null; try { const hi = new Emu.HostInput(null, q); hi.setMouse({ x: 0.1 }); hi.setMachine(m); early = hi; } catch (e) { early = e; }
  check('HostInput: made before a machine, then given one', early instanceof Emu.HostInput && m.mouse === early.mouse && m.mouse.x === 0.1, early && early.message);
  input.setMachine(m);
  const dev = new Emu.CocoMax();
  m.insertCartridge(dev);
  check('CoCo Max: the first read returns the staged 0', m.read(0xFF90) === 0x00);
  // a program reading one register twice gets Y the second time (the first read staged it)
  const y2 = m.read(0xFF90);
  check('CoCo Max: reading $FF90 again returns Y', y2 === 0xBF, `got $${y2.toString(16).toUpperCase()}`);
  check('CoCo Max: Y is the mouse position in 0..255 (0.75 -> $BF)', m.read(0xFF91) === 0xBF);
  check('CoCo Max: X is the mouse position in 0..255 (0.25 -> $40)', m.read(0xFF92) === 0x40);
  check('CoCo Max: the left button pressed reads $00', m.read(0xFF93) === 0x00);
  check('CoCo Max: the right button released reads $FF', m.read(0xFF94) === 0xFF);
  check('CoCo Max: $FF97 has nothing connected and keeps the staged value', m.read(0xFF97) === 0xFF);
  check('CoCo Max: the mode is not the joystick comparator (JOYIN low with the stick at rest)',
    (m.read(0xFF00) & 0x80) === 0, `PA $${m.read(0xFF00).toString(16)}`);
  // $FF90-$FF9F is the GIME's on a CoCo 3, so the module (a CoCo 1/2 device) must not answer there: every
  // register reads as it does on a machine without the module, and nothing is staged
  const c3 = machine('coco3'), bare = machine('coco3');
  c3.mouse = { x: 0.5, y: 0.75, left: true, right: false };
  c3.insertCartridge(new Emu.CocoMax());
  let same = true;
  for (const a of [0xFF90, 0xFF91, 0xFF92, 0xFF93, 0xFF94, 0xFF9F]) if (c3.read(a) !== bare.read(a)) same = false;
  check('CoCo Max: not driven on a CoCo 3, whose $FF9x belongs to the GIME', same);
}

// ---------------- the CoCo 3's Rat mouse and Hi-Res interfaces ----------------
// "The Rat" is a comparator like a stick but against MAME's four-value table (coco.cpp poll_joystick,
// joy_rat_table = {15, 24, 42, 33}; the axis is a 2-bit quadrature count). Both Hi-Res interfaces fitted to a
// CoCo 3 answer as they do on a CoCo 1/2: the timing is the same and the lockstep is run on both (run-hires.js).
const RAT = [15, 24, 42, 33];
for (let count = 0; count < 4; count++) {
  const m = machine('coco3', { hires: 'rat-right' });
  const p0 = m.pia0, p1 = m.pia1;
  p1.write(1, 0x00); p1.write(0, 0xFF); p1.write(1, 0x34);   // PIA1 PA: the DAC, all output
  p0.write(1, 0x34); p0.write(3, 0x34);                      // CA2 low = X, CB2 low = the right port
  m.mouse = { x: count / 3, y: count / 3, left: false, right: false };
  const at = (dac) => { p1.a.or = (dac << 2) & 0xFF; return (p0.a.input() >>> 7) & 1; };
  check(`Rat: count ${count} answers at MAME's table value ${RAT[count]}`, at(RAT[count]) === 1 && at(RAT[count] + 1) === 0,
    `table ${RAT[count]}: ${at(RAT[count])} then ${at(RAT[count] + 1)}`);
}
{
  // the Hi-Res one-shot runs on a CoCo 3 exactly as on a CoCo 1/2 (same PIA wiring)
  const m = machine('coco3', { hires: 'tandy-right' });
  m.joy[0] = [0, 0];
  const p0 = m.pia0, p1 = m.pia1;
  p1.write(1, 0x00); p1.write(0, 0xFF); p1.write(1, 0x34);
  p0.write(1, 0x34); p0.write(3, 0x34);
  p1.a.or = 0x80; m.read(0xFF00);                 // DAC $20: stopped
  p1.a.or = 0x00;                                 // DAC 0: started
  let settled = null;
  const t0 = m.cycle;
  for (let i = 0; i < 100000 && settled === null; i++) { m.cycle += 40; m.read(0xFF00); if ((p0.a.input() >>> 7) & 1) settled = m.cycle - t0; }
  const us = settled === null ? null : settled / m.tickHz * 1e6;
  check('CoCo 3: the Tandy Hi-Res interface waits about 535 us at position 0', us !== null && Math.abs(us - 535) < 60, `${us && us.toFixed(0)} us`);
}
// The delay is TRUNCATED to whole microseconds, as MAME's attotime::from_usec does (coco.cpp keyboard_changed).
// At 10-bit axis 1 the formula gives 540.718 us: truncation sets the deadline 540 us out, rounding would set
// 541. That is 4 machine ticks on a CoCo 3, so a rounded deadline lands on a different cycle and this catches it.
{
  const m = machine('coco3', { hires: 'tandy-right' });
  m.joy[0] = [11, 11];                                // axis 11 of 63 -> MAME's 10-bit axis 179
  const p0 = m.pia0, p1 = m.pia1;
  p1.write(1, 0x00); p1.write(0, 0xFF); p1.write(1, 0x34);
  p0.write(1, 0x34); p0.write(3, 0x34);
  p1.a.or = 0x80; m.read(0xFF00);                     // DAC $20: stopped
  const at = m.ioTime();                              // the write's own bus cycle is where the wait starts
  p1.a.or = 0x00;                                     // DAC 0: started
  const due = m.hires.jet.due;
  // MAME's formula at that axis: truncated to whole microseconds, then that many microseconds in ticks
  const exactUs = 535 + 5850 * (Math.round(11 * 1023 / 63) / 1023);
  const wantUs = Math.trunc(exactUs), roundedUs = Math.round(exactUs);
  const wantTicks = Math.round(wantUs * m.tickHz / 1e6);
  const gotTicks = Math.round(due - at);
  check('Hi-Res delay is truncated to whole microseconds, not rounded',
    roundedUs !== wantUs && gotTicks === wantTicks,
    `${gotTicks} ticks; truncated ${wantUs} us = ${wantTicks} ticks, rounding ${roundedUs} us = ${Math.round(roundedUs * m.tickHz / 1e6)} ticks`);
  void at;
}

console.log(fail ? `${fail} FAILED` : 'all input checks passed');
process.exitCode = fail ? 1 : 0;
