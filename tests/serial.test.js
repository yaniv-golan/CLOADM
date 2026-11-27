// Printer and serial without MAME: the serial line receiver (js/machines/serial.js), the PIA's
// output callback, and the printer paths of each machine family. Waveforms are built here bit by bit, so the
// expected bytes do not come from the code under test. The authority for the machines' behaviour is
// node tools/mame-diff/run.js <profile> --printer (byte for byte against MAME's printer file).
const Emu = require('./load')();
const { SerialRx } = require('../js/machines/serial.js');
const { terminalText } = require('../js/ui/terminal-text.js');   // the serial panel's text (no DOM)

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// 8N1 frames for `bytes`, starting at tick t0, `bit` ticks per bit, `gap` idle bits between frames; an optional
// per-bit time error. Returns the edges as [tick, level].
function frames(bytes, { t0 = 1000, bit = 100, gap = 2, skew = () => 0 } = {}) {
  const levels = [];
  for (const b of bytes) {
    levels.push(0);
    for (let k = 0; k < 8; k++) levels.push((b >> k) & 1);
    levels.push(1);
    for (let g = 0; g < gap; g++) levels.push(1);
  }
  return levels.map((l, i) => [Math.round(t0 + i * bit + skew(i)), l]);
}
const feed = (rx, edges) => { for (const [t, l] of edges) rx.write(t, l); };

// ---------------- the receiver ----------------
{
  const got = [], rx = new SerialRx(100, (b) => got.push(b));
  const bytes = [0x00, 0xFF, 0x55, 0xAA, 0x41, 0x0D, 0x80, 0x01];
  feed(rx, frames(bytes));
  rx.flush(1e9);
  check('8N1 frames decode to the bytes sent', eq(got, bytes), got.map((b) => b.toString(16)).join(' '));
}
{
  // a character is complete at its stop bit's sample, 9.5 bits after the start edge (MAME diserial.cpp)
  const got = [], rx = new SerialRx(100, (b) => got.push(b));
  feed(rx, frames([0x41], { t0: 1000 }));
  rx.flush(1000 + 949);
  check('nothing before the stop bit\'s sample (9.5 bits after the start edge)', got.length === 0);
  rx.flush(1000 + 951);
  check('the character once it is sampled', eq(got, [0x41]));
}
{
  // sampled at the middle of each bit, timed from the start edge: every later edge up to 40% of a bit early or
  // late still decodes (frames are 12 levels long: start, 8 data, stop, 2 idle)
  const got = [], rx = new SerialRx(100, (b) => got.push(b));
  feed(rx, frames([0x5A, 0xC3, 0x99], { skew: (i) => (i % 12 === 0 ? 0 : ((i * 37) % 81) - 40) }));
  rx.flush(1e9);
  check('bit timing errors up to 40% of a bit', eq(got, [0x5A, 0xC3, 0x99]), got.map((b) => b.toString(16)).join(' '));
}
{
  // a stop bit at space still delivers the character (MAME's serial printer prints it regardless)
  const got = [], rx = new SerialRx(100, (b) => got.push(b));
  const e = frames([0x41]).map(([t, l], i) => [t, i === 9 ? 0 : l]);
  feed(rx, e);
  rx.flush(1e9);
  check('framing error: the character is still received', eq(got, [0x41]));
}
{
  // decoded in pieces, and through a save / load in the middle of a character, the same bytes
  const bytes = [0x12, 0x34, 0x56, 0x78];
  const got = [], rx = new SerialRx(100, (b) => got.push(b));
  const e = frames(bytes);
  feed(rx, e.slice(0, 15));
  rx.flush(1000 + 15 * 100);
  const saved = JSON.parse(JSON.stringify(rx.saveState()));
  const rx2 = new SerialRx(100, (b) => got.push(b));
  rx2.loadState(saved);
  feed(rx2, e.slice(15));
  rx2.flush(1e9);
  check('save and load in the middle of a character', eq(got, bytes), got.map((b) => b.toString(16)).join(' '));
  check('repeated levels are not edges', (() => { const r = new SerialRx(100, () => {}); r.write(5, 1); r.write(6, 1); return r.edges.length === 0; })());
}

// ---------------- the serial port's devices (js/machines/rs232.js) ----------------
{
  const { SerialPort } = require('../js/machines/rs232.js');
  const printed = [];
  const p = new SerialPort(1000, (b) => printed.push(b));      // 1000 ticks a second
  check('default device: the printer, at 600 baud, RXD 0, DCD and CTS low (MAME rs_printer)', p.kind === 'printer' && p.baud === 600 && p.rxd(0) === 0 && p.dcd === 0 && p.cts === 0);
  p.attach('loopback');
  p.txd(10, 0);
  check('loopback: RXD follows TXD; DCD and CTS stay high (not driven)', p.rxd(11) === 0 && (p.txd(12, 1), p.rxd(13) === 1) && p.dcd === 1 && p.cts === 1);
  // terminal at 100 baud: 10 ticks a bit. 'A' = $41 = 0100 0001: start 0, bits 1 0 0 0 0 0 1 0, stop 1
  p.attach('terminal', { baud: 100 });
  const got = [];
  p.listeners.add({ tx: (b) => got.push(b) });
  p.send([0x41, 0x0D], 100);
  const levels = [];
  for (let t = 105; t < 300; t += 10) levels.push(p.rxd(t));
  check('terminal: bytes sent to the machine are 8N1 frames back to back on RXD',
    levels.join('') === '0' + '10000010' + '1' + '0' + '10110000' + '1', levels.join(''));
  check('terminal: idle RXD is mark', p.rxd(1000) === 1);
  for (const [t, l] of frames([0x52], { t0: 400, bit: 10 })) p.txd(t, l);
  p.flush(1000);
  check('terminal: bytes the machine sends are received', eq(got, [0x52]) && printed.length === 0);
  const t2 = new SerialPort(1000, () => {}); t2.attach('terminal', { baud: 100 });
  t2.send([0x55], 0); t2.rxd(5);
  const s = JSON.parse(JSON.stringify(t2.saveState())), t3 = new SerialPort(1000, () => {});
  t3.loadState(s);
  check('terminal: save and load in the middle of a byte', [15, 25, 35].map((t) => t3.rxd(t)).join('') === [15, 25, 35].map((t) => t2.rxd(t)).join(''));
  check('terminal: a later send starts when it is sent, not in the past', (() => { const q = new SerialPort(1000, () => {}); q.attach('terminal', { baud: 100 }); q.send([0xFF], 0); q.send([0x00], 500); return q.rxd(499) === 1 && q.rxd(505) === 0; })());
  check('unknown device refused', (() => { try { p.attach('modem'); return false; } catch (e) { return /no serial device/.test(e.message); } })());
}

// ---------------- the PIA's output callback (MAME 6821pia.cpp port_a_w, ddr_a_w, device_reset) ----------------
{
  const p = new Emu.MC6821(), seen = [];
  p.a.onOutput = (v) => seen.push(v);
  p.reset();
  check('reset: the callback sees $FF (all inputs, pulled high)', eq(seen, [0xFF]));
  seen.length = 0;
  p.write(0, 0xF0);                 // DDR (CR bit 2 clear): changed
  p.write(0, 0xF0);                 // DDR: unchanged
  p.write(1, 0x04);                 // CR: never
  p.write(0, 0x50);                 // output register
  p.write(0, 0x50);                 // output register again: every write
  check('DDR writes call it when the DDR changes; every output-register write calls it; CR writes never',
    eq(seen, [0x0F, 0x5F, 0x5F]), seen.map((v) => v.toString(16)).join(' '));
}

// ---------------- the machines ----------------
{
  // Dragon parallel printer: PIA0 port B is printed once per strobe pulse, as PA1 rises ("Inside the Dragon",
  // section 8.4.2; tests/dragon-printer.test.js has the rest, and MAME's rule under mameCompat)
  const m = Emu.createMachine('dragon64');
  m.reset(true);
  check('Dragon: power-on prints nothing', eq(m.printed, []), m.printed.join(','));
  m.write(0xFF03, 0x00); m.write(0xFF02, 0xFF); m.write(0xFF03, 0x04);   // PIA0 PB outputs
  m.write(0xFF21, 0x00); m.write(0xFF20, 0xFE); m.write(0xFF21, 0x04);   // PIA1 PA1-7 outputs
  m.write(0xFF02, 0x41);
  m.write(0xFF20, 0x00);                // strobe low: nothing
  m.write(0xFF20, 0x02);                // strobe high: 'A'
  m.write(0xFF20, 0x02);                // written again while high: nothing
  m.write(0xFF20, 0xFE);                // DAC bits with the strobe still high: nothing
  m.write(0xFF02, 0x42); m.write(0xFF20, 0xFC); m.write(0xFF20, 0xFE);   // strobe low, then high: 'B'
  check('Dragon: one byte per strobe pulse, at PA1\'s rising edge', eq(m.printed, [0x41, 0x42]), m.printed.join(','));
}
{
  // CoCo and MC-10: a serial printer on the bit-banger, at 600 baud; the firmware waveform is driven here by
  // writing the port directly at chosen ticks
  for (const [id, set] of [
    ['coco', (m, l) => m.write(0xFF20, l ? 0x02 : 0x00)],
    ['coco3', (m, l) => m.write(0xFF20, l ? 0x02 : 0x00)],
    ['mc10', (m, l) => m.portWrite(2, l ? 0xFF : 0xFE)],
  ]) {
    const m = Emu.createMachine(id);
    m.reset(true);
    // PA1 to mark before the DDR makes it an output (output register first)
    if (id !== 'mc10') { m.write(0xFF21, 0x04); m.write(0xFF20, 0x02); m.write(0xFF21, 0x00); m.write(0xFF20, 0xFE); m.write(0xFF21, 0x04); }
    set(m, 1);
    const bit = m.tickHz / 600, t0 = m.cycle + 10 * bit;
    for (const [t, l] of frames([0x43, 0x6F], { t0, bit })) { m.cycle = t; set(m, l); }
    m.bitBanger.flush(m.cycle + 20 * bit);
    check(`${id}: bit-banger frames reach the serial printer`, eq(m.printed, [0x43, 0x6F]), m.printed.join(','));
  }
}

{
  // making PA1 an output while its output register holds 0 drops the line to space: a start bit, and with the
  // line back at mark afterwards the printer receives $FF
  const m = Emu.createMachine('coco');
  m.reset(true);
  m.write(0xFF21, 0x00); m.write(0xFF20, 0xFE); m.write(0xFF21, 0x04);
  const bit = m.tickHz / 600;
  m.cycle += Math.round(bit / 2);
  m.write(0xFF20, 0x02);
  m.bitBanger.flush(m.cycle + 20 * bit);
  check('coco: PA1 made an output at space, then mark: one $FF', eq(m.printed, [0xFF]), m.printed.join(','));
}

// ---------------- the Session ----------------
const refused = (fn, re) => { try { fn(); return false; } catch (e) { return e instanceof Emu.SessionError && re.test(e.message); } };
{
  const s = new Emu.Session();
  s.switchMachine('coco');
  check('Session: the CoCo starts with the printer on its serial port', JSON.stringify(s.serial.device) === JSON.stringify({ chip: 'bit-banger', kind: 'printer', baud: 600, kinds: ['printer', 'terminal', 'loopback'] }));
  check('Session: sending needs the terminal', refused(() => s.serial.send('X', { text: true }), /Plug in the terminal first/));
  check('Session: unknown device and baud refused', refused(() => s.serial.attach('modem'), /No serial device/) && refused(() => s.serial.attach('terminal', { baud: 1234 }), /not offered/));
  s.serial.attach('terminal', { baud: 1200 });
  const got = [];
  s.serial.subscribe({ tx: (b) => got.push(...b) });
  const n = s.serial.send('RUN\n', { text: true }), m = s.shownMachine, bit = m.tickHz / 1200;
  // 'R' = $52 = 0101 0010: start, then 0 1 0 0 1 0 1 0
  const levels = [];
  for (let k = 0; k < 10; k++) levels.push(m.bitBanger.rxd(m.now() + (k + 0.5) * bit));
  check('Session: typed text goes to the machine as 8N1 frames, newline as CR', n === 4 && levels.join('') === '0010010101', levels.join(''));
  // what the machine sends shows as text: 'O', 'K', CR LF, through the port's receiver
  let t = m.now() + 100 * bit;
  for (const [at, l] of frames([0x4F, 0x4B, 0x0D, 0x0A, 0x3E], { t0: t, bit })) m.bitBanger.txd(at, l);
  m.bitBanger.flush(t + 60 * bit);
  s.serial.flush();
  check('Session: what the machine sends reaches a subscriber, and shows as terminal text', terminalText(got) === 'OK\n>', JSON.stringify(terminalText(got)));
  check('terminalText: 7-bit, CR LF / CR / LF end lines, a backspace takes a character back, other controls dropped',
    terminalText([0xC1, 0x42, 0x08, 0x43, 13, 10, 0x44, 13, 0x45, 10, 0x01, 9, 0x46]) === 'AC\nD\nE\n\tF');
  s.switchMachine('dragon32');
  check('Session: the Dragon 32 has no serial port', s.serial.device === null && refused(() => s.serial.attach('terminal'), /has no serial port here/));
}

// ---------------- the Dragon 64's 6551 through the Session ----------------
// The registers are written directly (9600 baud 8N1, DTR on, transmitter on, no interrupts), so the frames come
// from the chip and the terminal decodes them; the authority for the chip's timing is run.js dragon64 --serial.
{
  const s = new Emu.Session();
  s.switchMachine('dragon64');
  const m = s.shownMachine;
  check('Session: the Dragon 64 starts with nothing on its 6551', JSON.stringify(s.serial.device) === JSON.stringify({ chip: '6551', kind: 'none', baud: 9600, kinds: ['none', 'terminal', 'loopback'] }));
  check('Session: no serial printer on a Dragon (it prints on the parallel port)', refused(() => s.serial.attach('printer'), /No serial device "printer" on the Dragon 64/));
  s.serial.attach('terminal', { baud: 9600 });
  const sentBack = [];
  s.serial.subscribe({ tx: (b) => sentBack.push(...b) });
  m.write(0xFF07, 0x1E); m.write(0xFF06, 0x0B);
  const sent = [...'HI\r\n'].map((c) => c.charCodeAt(0));
  for (const b of sent) {
    for (let g = 0; g < 1000 && !(m.read(0xFF05) & 0x10); g++) m.runCycles(m.cycle + 10);
    m.write(0xFF04, b);
  }
  for (let f = 0; f < 3; f++) m.runFrame();
  s.serial.flush();
  check('Session: what the 6551 sends reaches a subscriber', terminalText(sentBack) === 'HI\n', JSON.stringify(terminalText(sentBack)));
  s.serial.send('Z', { text: true });
  let got = -1;
  for (let g = 0; g < 4000 && got < 0; g++) { m.runCycles(m.cycle + 10); if (m.read(0xFF05) & 0x08) got = m.read(0xFF04); }
  check('Session: a typed byte reaches the 6551', got === 0x5A, got.toString(16));
  s.serial.attach('loopback');
  check('Session: the loopback plug holds the 6551\'s CTS, DSR and DCD asserted', (m.read(0xFF05) & 0x60) === 0 && !m.acia.chip.cts);
  s.serial.attach('none');
  check('Session: unplugged, the 6551\'s receive line idles at mark', s.serial.device.kind === 'none' && m.serialPort.rxd(m.now()) === 1);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
