/*
 * The two-PIA I/O board shared by the Dragons and every Color Computer (CoCo 3 included):
 * PIA0 scans the keyboard and joystick comparator and raises IRQ; PIA1 drives the 6-bit DAC, the
 * cassette motor and single-bit sound, reads the cassette input and raises FIRQ.
 *
 * Model differences are options:
 *   noTapeHigh  the cassette comparator reads high with no tape inserted (CoCo 3, as in MAME)
 *   pb1Input    PIA1 port B input (printer busy, RAM size sense, ...)
 *   onChange    extra work after any PIA output change (CoCo 3: GIME keyboard interrupt)
 *
 * Hi-Res joystick interfaces (option hires: 'none' | 'tandy-right' | 'tandy-left' | 'max3-right' | 'max3-left', MAME's
 * HIRES_INTF_TAG) replace the comparator for the joystick in that port: the hardware does not settle at once
 * but after a time that says where the stick is, and the machine sees that as PA7 (JOYIN) going high when
 * the time is up. The two interfaces are different circuits (MAME 0.264 src/mame/trs/coco.cpp,
 * poll_hires_joystick and the transition timers in keyboard_changed):
 *   Tandy Hi-Res    stopped while the DAC is below $20 (the module is idle), started when it reaches $20
 *                   and then, when it stops, waits 535 + 5850 x position microseconds
 *   CoCo Max 3      selected by a PIA0 data bit ($04 right port, $08 left) instead of the DAC, same idea,
 *                   waits 380 + 2885 x position microseconds
 * The position is the joystick axis in 0..1 (MAME: the 10-bit axis / 1023); the delay is measured from the
 * moment the circuit starts, and the module counts down in emulated time, so a program that reads JOYIN in a
 * loop sees it change at that moment. Nothing here is sampled at reset.
 */
// MAME 0.264 src/mame/trs/coco.cpp keyboard_changed, exactly: joystick.input() returns the 10-bit axis
// (0..1023), value = axis / 1023.0, then value = 535 + 5850 * value (Tandy) or 380 + 2885 * value (Max 3),
// and attotime::from_usec((s64)value) TRUNCATES that to WHOLE MICROSECONDS. The truncation matters: it moves
// the deadline by up to a microsecond, which is up to one machine tick, and a rounded-up deadline lands on the
// next polling loop. tests/input.test.js pins this down at a position whose time is not a whole microsecond.
const HIRES_TIME = {
  tandy: (axis) => Math.trunc(535 + 5850 * (axis / 1023)),   // whole microseconds, truncated as MAME does
  max3: (axis) => Math.trunc(380 + 2885 * (axis / 1023)),
};
// the machine's 0..63 axis as MAME's 10-bit one (machine.js: joy is 0..63; MAME's input ports are 0..1023)
const tenBit = (v) => Math.round((v * 1023) / 63);
// "The Rat" mouse (MAME 0.264 coco3.cpp INPUT_PORTS_START( coco_rat_mouse )): each axis is 2 bits, a
// quadrature count in 0..3, and the comparator answers against MAME's table (coco.cpp poll_joystick,
// joy_rat_table). MAME reads it as IPT_MOUSE_X/Y, so a host mouse position 0..1 maps onto the four counts.
const RAT_TABLE = [15, 24, 42, 33];

function wireCocoPias(m, { noTapeHigh = false, pb1Input, onChange = null, hires = 'none' }) {
  const p0 = m.pia0, p1 = m.pia1;
  p0.onIrq = () => m.setLine('pia0', 'irq', p0.irqA() || p0.irqB());
  p1.onIrq = () => m.setLine('pia1', 'firq', p1.irqA() || p1.irqB());
  // a Hi-Res interface in one port: which joystick and which circuit
  const hiresPort = hires === 'none' ? -1 : hires.endsWith('left') ? 1 : 0;
  const hiresKind = hires.startsWith('max3') ? 'max3' : hires.startsWith('rat') ? 'rat' : 'tandy';
  // The Rat answers like the joystick comparator but against joy_rat_table: its own 2-bit count per axis
  const rat = (axis, v) => RAT_TABLE[Math.max(0, Math.min(3, Math.round((v || 0) * 3)))];
  // MAME 0.264 (coco.cpp keyboard_changed) re-arms the one-shot on the *falling edge* of the select
  // signal: a write that takes it from high to low starts a fresh wait; a write that leaves it low does
  // not. JOYIN (PIA0 PA7) is high when the wait is over (or no interface is fitted), low while it runs
  // (`joyin = remaining.is_zero() || remaining.is_never()`), so a program starts the wait and polls JOYIN
  // until it goes high.
  // The Rat is a comparator, not a one-shot: it never arms
  const hiresJet = { armed: false, due: -1 };
  const hiresSelect = () => {
    if (hiresPort < 0) return true;      // no interface: the line reads as idle (never started)
    if (hiresKind === 'max3') return hiresPort === 0 ? (p0.a.outValue() & 0x04) !== 0 : (p0.a.outValue() & 0x08) !== 0;
    return (p1.a.outValue() >> 2) >= 0x20;
  };
  const hiresUpdate = () => {
    const sel = hiresSelect();
    if (!sel && !hiresJet.armed) {
      hiresJet.armed = true;
      // the wait runs from the write that took the select low (MAME arms its timer in the write handler),
      // for the time MAME's own formula gives for this axis, truncated to whole microseconds
      const axis = m.joy[hiresPort][p0.a.c2() ? 1 : 0];
      hiresJet.due = m.ioTime() + Math.round(HIRES_TIME[hiresKind](tenBit(axis)) * m.tickHz / 1e6);
    } else if (sel) {
      hiresJet.armed = false;            // a low-to-high transition re-arms the edge detector, not the wait
    }
  };
  p0.a.input = () => {
    let rows = 0x7F & ~m.scanKeys(p0.b.outValue());
    if (m.fire[0]) rows &= ~0x01;
    if (m.fire[1]) rows &= ~0x02;
    // joystick comparator: DAC (PIA1 PA2-7) against the selected pot (mux PIA0 CB2 side, CA2 axis).
    // A Hi-Res interface in that port answers for its joystick instead: JOYIN is high until it fires.
    const joy = p0.b.c2() ? 1 : 0;
    if (joy === hiresPort && hiresKind === 'rat') {
      // the mouse's own position, converted to the comparator's table
      const dac = p1.a.outValue() >> 2;
      if (dac <= rat(p0.a.c2() ? 1 : 0, m.mouse ? m.mouse[p0.a.c2() ? 'y' : 'x'] : 0.5)) rows |= 0x80;
    } else if (joy === hiresPort) {
      // the read sees the bus at the time of its own access, not the CPU's position after it (as every other
      // time-dependent I/O here does): MAME's timer would have expired before the read's cycle
      if (!hiresJet.armed || m.ioTime() >= hiresJet.due) rows |= 0x80;   // expired or idle: high
    } else {
      const dac = p1.a.outValue() >> 2;
      if (m.joy[joy][p0.a.c2() ? 1 : 0] >= dac) rows |= 0x80;
    }
    return rows;
  };
  // for snapshots and tests: the interface fitted, and its one-shot (js/machines/sam.js, coco3.js save it)
  m.hires = { port: hiresPort, kind: hiresKind, jet: hiresJet, update: hiresUpdate, select: hiresSelect };
  p0.b.input = () => 0xFF & ~m.keyColsForRows(p0.a.outValue());
  p1.a.input = () => ((noTapeHigh && !m.deck.tape) || m.deck.level() ? 0x01 : 0x00) | 0xFE;   // PA0: cassette in
  p1.b.input = pb1Input;
  const changed = () => {
    m.deck.setMotor(p1.a.c2());
    m.deck.output((p1.a.outValue() >> 2) / 63);   // the DAC drives the cassette output too
    updateSound(m);
    if (hiresPort >= 0 && hiresKind !== 'rat') hiresUpdate();
    if (onChange) onChange();
  };
  p0.onChange = changed; p1.onChange = changed;
}

// sound: the DAC when the analogue mux selects it and sound is enabled (PIA1 CB2), plus the
// single-bit output (PIA1 PB1 as an output) at 32 DAC steps, the weight of the DAC's top bit: the Tandy service
// manual's parts list gives the DAC's resistors R10-R15 as 10K to 324K and the single-bit R22 as 10K (as cited in
// MAME 0.264's coco12.cpp), and MAME's -wavwrite agrees (tools/mame-diff/sam/dac-sound.js; docs/verification.md)
function updateSound(m) {
  const p0 = m.pia0, p1 = m.pia1;
  let lvl = 0;
  if (p1.b.c2()) {
    const mux = (p0.b.c2() ? 2 : 0) | (p0.a.c2() ? 1 : 0);
    if (mux === 0) lvl = (p1.a.outValue() >> 2) / 63;
    // the cassette input selected (BASIC's AUDIO ON): the sound chip biases that AC-coupled input at the middle of
    // its range, 32 DAC steps, as MAME 0.264's coco.cpp update_sound() does (0x40 on its 0..0x7E DAC scale). MAME
    // mixes in no tape signal there, so neither does the machine: the page's "Tape sound" plays the tape on the host
    // side instead (js/host/audio.js). tools/mame-diff/sam/cass-sound.js compares the level with MAME's -wavwrite.
    else if (mux === 1) lvl = 32 / 63;
  }
  if ((p1.b.ddr & 0x02) && (p1.b.or & 0x02)) lvl += 32 / 63;
  m.setSoundLevel(lvl);
}

export { wireCocoPias };
