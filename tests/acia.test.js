// The MOS 6551 ACIA (js/chips/mos6551.js) on its own, driven clock edge by clock edge. Frames are
// built here bit by bit from the word format, and the rates come from the 6551 data sheet's baud rate table
// (MOS / Rockwell R6551 data sheet, control register bits 0-3: 50 ... 19200 baud from the 1.8432 MHz crystal, 16
// clocks a bit), so the expected values do not come from the code under test. The authority for the chip's timing
// in a machine is node tools/mame-diff/run.js dragon64 --serial (lockstep with MAME).
const { MOS6551, ACIA_XTAL } = require('../js/chips/mos6551.js');
const { state } = require('../js/util.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// a chip with every line asserted (CTS, DSR, DCD low), reset; it records TXD and the IRQ output
function chip({ cts = 0, dsr = 0, dcd = 0 } = {}) {
  const c = new MOS6551();
  c.irqs = [];
  c.onIrq = (a) => c.irqs.push(a);
  c.start();
  c.setCts(cts); c.setDsr(dsr); c.setDcd(dcd);
  c.reset();
  return c;
}
// run n whole clock periods (rising edge then falling edge), feeding RXD from rxAt(clock) and sampling TXD after
// each period
function clocks(c, n, rxAt = null, from = 0) {
  const out = [];
  for (let k = 0; k < n; k++) {
    if (rxAt) c.setRxd(rxAt(from + k));
    c.clockEdge(1); c.clockEdge(0);
    out.push(c.txd);
  }
  return out;
}
// the bits of one frame: start, data LSB first, parity, stop bits (as whole bits)
function frameBits(v, { bits = 8, parity = 'none', stops = 1 } = {}) {
  const out = [0];
  let ones = 0;
  for (let k = 0; k < bits; k++) { const b = (v >> k) & 1; out.push(b); ones += b; }
  if (parity === 'odd') out.push(ones % 2 ? 0 : 1);
  else if (parity === 'even') out.push(ones % 2);
  else if (parity === 'mark') out.push(1);
  else if (parity === 'space') out.push(0);
  for (let s = 0; s < stops; s++) out.push(1);
  return out;
}
// decode TXD samples (one per clock) as frames: find a start bit, sample each bit in its middle
function decode(samples, nbits) {
  const frames = [];
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] !== 0) continue;
    const bits = [];
    for (let k = 0; k < nbits; k++) { const at = i + k * 16 + 8; if (at >= samples.length) return frames; bits.push(samples[at]); }
    frames.push(bits);
    i += (nbits - 1) * 16 + 8;
  }
  return frames;
}

// ---------------- reset and the registers ----------------
{
  const c = chip();
  check('reset: status $10 (transmit register empty) with CTS, DSR and DCD asserted', c.read(1) === 0x10, c.peek(1).toString(16));
  check('reset: command and control 0', c.read(2) === 0 && c.read(3) === 0);
  const u = chip({ cts: 1, dsr: 1, dcd: 1 });
  // (with CTS high the transmitter is held off and TDRE reads 0, as MAME 0.264 reads $60 on the Dragon 64 with
  // its RS-232 lines unconnected)
  check('reset: status $60 with CTS, DSR and DCD not asserted', u.read(1) === 0x60, u.peek(1).toString(16));
  c.write(3, 0x9E); c.write(2, 0xEB);
  check('control and command read back', c.read(3) === 0x9E && c.read(2) === 0xEB);
  c.write(1, 0x00);   // programmed reset: command bits 0-4 cleared, 5-7 and control kept (data sheet)
  check('programmed reset: command bits 0-4 cleared, bits 5-7 kept', c.read(2) === 0xE0, c.read(2).toString(16));
  check('programmed reset: control unchanged', c.read(3) === 0x9E);
  c.write(0, 0x41);
  check('writing the data register clears TDRE', (c.read(1) & 0x10) === 0);
  check('peek has no side effects', c.peek(1) === c.peek(1) && c.peek(0) === c.rdr);
}

// ---------------- the baud rate generator ----------------
{
  const nominal = [0, 50, 75, 109.92, 134.58, 150, 300, 600, 1200, 1800, 2400, 3600, 4800, 7200, 9600, 19200];
  const c = chip();
  let worst = 0, all = true;
  const rates = [];
  c.onClock = (hz) => rates.push(hz);
  c.write(2, 0x0B);   // DTR on
  for (let r = 1; r < 16; r++) {
    c.write(3, 0x10 | r);
    const baud = c.clockHz / 16, err = Math.abs(baud - nominal[r]) / nominal[r];
    worst = Math.max(worst, err);
    if (c.clockHz !== Math.floor(ACIA_XTAL * c.clockScale)) all = false;
  }
  check('rates 1-15: 16 clocks a bit within 0.1% of the data sheet baud rates', worst < 0.001, `(worst ${(worst * 100).toFixed(3)}%)`);
  check('the clock is whole Hz', all);
  check('a rate change re-times the clock', rates.length >= 15);
  rates.length = 0;
  c.write(3, 0x1E); c.write(3, 0x1E);
  check('writing the same rate again does not re-time the clock', rates.length <= 1, `(${rates.length})`);
  c.write(2, 0x00);
  check('DTR off stops the clock', c.clockHz === 0 && rates[rates.length - 1] === 0);
  c.write(2, 0x01);
  check('DTR on starts it again', c.clockHz === Math.floor(ACIA_XTAL / 12));
}

// ---------------- transmit ----------------
const formats = [
  ['8N1', 0x1E, 0x0B, { bits: 8 }],
  ['7O1', 0x3E, 0x2B, { bits: 7, parity: 'odd' }],
  ['7E1', 0x3E, 0x6B, { bits: 7, parity: 'even' }],
  ['8N2', 0x9E, 0x0B, { bits: 8, stops: 2 }],
  ['8 mark parity', 0x1E, 0xAB, { bits: 8, parity: 'mark' }],
  ['8O1', 0x1E, 0x2B, { bits: 8, parity: 'odd' }],
  ['8 space parity', 0x1E, 0xEB, { bits: 8, parity: 'space' }],
  ['6N1', 0x5E, 0x0B, { bits: 6 }],
];
for (const [name, ctrl, cmd, f] of formats) {
  const c = chip();
  c.write(3, ctrl); c.write(2, cmd);
  const bytes = [0x00, 0xFF, 0x55, 0x2A];
  let samples = clocks(c, 40);
  for (const b of bytes) {
    // wait for TDRE, then write the next byte
    while (!(c.read(1) & 0x10)) samples = samples.concat(clocks(c, 1));
    c.write(0, b);
  }
  samples = samples.concat(clocks(c, 16 * 14 * 2));
  const n = 1 + f.bits + (f.parity ? 1 : 0) + (f.stops || 1);
  const got = decode(samples, n), want = bytes.map((b) => frameBits(b & ((1 << f.bits) - 1), f));
  check(`transmit ${name}: every frame bit for bit`, got.length === bytes.length && got.every((g, i) => eq(g, want[i])), JSON.stringify(got[0]));
  check(`transmit ${name}: the line idles at mark`, samples.slice(0, 40).every((v) => v === 1) && samples[samples.length - 1] === 1);
}
{
  const c = chip({ cts: 1 });
  c.write(3, 0x1E); c.write(2, 0x0B); c.write(0, 0x00);
  check('CTS not asserted: nothing is sent', clocks(c, 400).every((v) => v === 1));
  const d = chip();
  d.write(3, 0x1E); d.write(2, 0x0F);   // transmitter control 11: break
  const s = clocks(d, 400);
  check('break: TXD held at space', s.slice(40).every((v) => v === 0));
}

// ---------------- receive ----------------
// RXD from a list of frames, 16 clocks a bit, after `lead` idle clocks
const line = (bits, lead = 37) => (k) => (k < lead ? 1 : bits[Math.floor((k - lead) / 16)] ?? 1);
for (const [name, ctrl, cmd, f] of formats) {
  const c = chip();
  c.write(3, ctrl); c.write(2, cmd | 0x02);   // receiver interrupt off
  const got = [];
  for (const b of [0x3C, 0x81]) {
    const bits = frameBits(b & ((1 << f.bits) - 1), f);
    clocks(c, (bits.length + 2) * 16 + 37, line(bits));
    const st = c.read(1);
    got.push([st & 0x0F, c.read(0)]);
  }
  check(`receive ${name}: the bytes, no errors`, eq(got.map((g) => g[1]), [0x3C, 0x81].map((b) => b & ((1 << f.bits) - 1))) && got.every((g) => g[0] === 0x08), JSON.stringify(got));
}
{
  const c = chip();
  c.write(3, 0x3E); c.write(2, 0x2B | 0x02);   // 7 bits, odd parity
  const bits = frameBits(0x41, { bits: 7, parity: 'odd' });
  bits[8] ^= 1;   // wrong parity
  clocks(c, 14 * 16, line(bits));
  check('receive: a parity error sets status bit 0', (c.read(1) & 0x09) === 0x09);
  c.read(0);
  check('reading the data clears the error bits', (c.read(1) & 0x0F) === 0);
  const d = chip();
  d.write(3, 0x1E); d.write(2, 0x0B);
  const fb = frameBits(0x00, { bits: 8 }); fb[9] = 0;   // no stop bit
  clocks(d, 13 * 16, line(fb.concat([0, 0])));
  check('receive: a missing stop bit sets the framing error', (d.read(1) & 0x0A) === 0x0A, d.peek(1).toString(16));
  const e = chip();
  e.write(3, 0x1E); e.write(2, 0x0B);
  const two = frameBits(0x11).concat([1, 1], frameBits(0x22));
  clocks(e, (two.length + 4) * 16 + 37, line(two));
  check('receive: a second byte before the first is read is an overrun; the first is kept', (e.read(1) & 0x0C) === 0x0C && e.read(0) === 0x11);
  const g = chip();
  g.write(3, 0x1E); g.write(2, 0x02);   // DTR off
  clocks(g, 20 * 16, line(frameBits(0x55)));
  check('receive: nothing with DTR off', !(g.read(1) & 0x08));
}

// ---------------- interrupts ----------------
{
  const c = chip();
  c.write(3, 0x1E); c.write(2, 0x09);   // receiver interrupt on, transmitter interrupt off
  check('no interrupt at reset', c.irqs.every((v) => v === false) && !(c.peek(1) & 0x80));
  clocks(c, 14 * 16, line(frameBits(0x5A)));
  check('receiver interrupt: IRQ asserted when the byte arrives, status bit 7 set', c.irqs[c.irqs.length - 1] === true && (c.peek(1) & 0x88) === 0x88);
  c.read(1);
  check('reading the status clears the interrupt', c.irqs[c.irqs.length - 1] === false && !(c.peek(1) & 0x80));
  c.read(0);
  c.irqs.length = 0;
  c.write(2, 0x05);   // transmitter interrupt on
  c.write(0, 0xA5);
  clocks(c, 32);
  check('transmitter interrupt: IRQ when the transmitter takes the byte', c.irqs[0] === true && (c.peek(1) & 0x90) === 0x90);
  c.read(1);
  const d = chip({ dcd: 0 });
  d.write(3, 0x1E); d.write(2, 0x0B);
  d.setDcd(1);
  clocks(d, 2);
  check('a DCD change: status bit 5 follows and IRQ is asserted', (d.peek(1) & 0xA0) === 0xA0 && d.irqs[d.irqs.length - 1] === true);
  d.read(1);
  check('reading the status clears it', d.irqs[d.irqs.length - 1] === false);
}

// ---------------- the state ----------------
{
  const run = (c) => { const s = clocks(c, 300, line(frameBits(0x99), 0)); return s.join('') + c.read(1) + ',' + c.read(0); };
  const a = chip();
  a.write(3, 0x1E); a.write(2, 0x0B); a.write(0, 0xC3);
  clocks(a, 5 * 16 + 7, line(frameBits(0x99), 0));   // part way through a byte each way
  const saved = JSON.parse(state.toJSON(a.saveState()));
  const b = new MOS6551(); b.loadState(state.fromJSON(JSON.stringify(saved)));
  check('state: saved mid-frame, the restored chip finishes both bytes identically', run(b) === run(a));
  const broken = Object.assign({}, saved); delete broken.rxShift;
  let msg = '';
  try { new MOS6551().loadState(broken); } catch (e) { msg = e.message; }
  check('state: a snapshot with a field missing is refused', /missing "rxShift"/.test(msg), msg);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
