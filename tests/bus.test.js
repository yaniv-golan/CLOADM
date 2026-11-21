// Expansion bus and interrupt hub: cartridge ROM/I-O mapping, CART autostart line, NMI/HALT lines,
// cartridge machines vs machines without a port, and cartridges in snapshots.
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };

// a test device: 8K ROM plus a register at $FF40 that counts writes and can raise lines (HALT included, so it
// declares it: a device that drives the line without canHalt is refused by the CoCo 3, coco3.js setLine)
class TestCart extends Emu.Device {
  constructor() { super('test'); this.bytes = new Uint8Array(0x2000).map((_, i) => i & 0xFF); this.reg = 0; }
  get canHalt() { return true; }
  rom() { return this.bytes; }
  readIO(a) { return a === 0xFF40 ? this.reg : undefined; }
  writeIO(a, v) { if (a === 0xFF40) this.reg = v; if (a === 0xFF41) this.host.setLine('testcart', 'nmi', !!v); if (a === 0xFF42) this.host.setLine('testcart', 'halt', !!v); }
  saveState() { return { reg: this.reg }; }
  static fromState(s) { const d = new TestCart(); d.reg = s.reg; return d; }
}
Emu.devices.test = TestCart;

for (const id of ['dragon64', 'coco', 'coco3']) {
  const m = Emu.createMachine(id);
  m.reset(true); m.runFrame();
  const d = new TestCart();
  m.insertCartridge(d);
  // cartridge ROM space (SAM map type 0; the CoCo 3's ROM modes are checked in tests/coco3.test.js)
  if (id !== 'coco3') check(`${id}: cartridge ROM mapped (and mirrored)`, m.read(0xC005) === 5 && m.read(0xE005) === 5);
  m.write(0xFF40, 0x5A);
  check(`${id}: cartridge I/O routed to the device`, d.reg === 0x5A && m.read(0xFF40) === 0x5A);
  // NMI: rising edge reaches the CPU
  m.cpu.nmiArmed = true;
  m.write(0xFF41, 1);
  check(`${id}: NMI line edge reaches the CPU`, m.cpu.nmiPending === true);
  m.write(0xFF41, 0);
  // HALT: the CPU stops executing instructions while held
  m.write(0xFF42, 1);
  const pc = m.cpu.pc; m.runFrame();
  check(`${id}: HALT line stops the CPU`, m.cpu.pc === pc);
  m.setLine('testcart', 'halt', false);   // (a halted CPU can't write the register; release the line directly)
  let ran = 0;
  m.cpu.trace = () => { ran++; };
  m.runFrame();
  m.cpu.trace = null;
  check(`${id}: CPU runs again after HALT is released`, ran > 1000, `(${ran} instructions in a frame)`);
  // snapshot keeps the cartridge
  const snap = Emu.state.fromJSON(Emu.state.toJSON(m.snapshot()));
  const r = Emu.restoreSnapshot(snap, m.roms);
  check(`${id}: cartridge restored from snapshot`, r.cartPort instanceof TestCart && r.cartPort.reg === 0x5A);
  m.ejectCartridge();
  check(`${id}: empty slot after eject`, id === 'coco3' ? m.cartPort === null : m.read(0xC005) === 0x00 && m.read(0xFF40) === 0xFF);
}

// CART tied to Q (autostart) sets PIA1 CB1's flag on SAM machines
{
  const m = Emu.createMachine('dragon64');
  m.reset(true); m.runFrame();
  // the pak ties CART to Q at reset (MAME coco_pak_device::device_reset), so a cartridge takes effect on reset
  m.insertCartridge(new Emu.RomCartridge(new Uint8Array(0x2000), { autostart: true }));
  m.reset(false); m.runFrame();
  m.pia1.read(2); // clear flags
  m.runFrame();
  check('autostart cartridge toggles CART (PIA1 CB1 flag set)', m.pia1.b.irq1 === true);
  m.insertCartridge(new Emu.RomCartridge(new Uint8Array(0x2000), { autostart: false }));
  m.reset(false); m.runFrame();
  m.pia1.read(2); m.runFrame();
  check('non-autostart cartridge leaves CART alone', m.pia1.b.irq1 === false);
}

// machines without a cartridge port
{
  const m = Emu.createMachine('mc10');
  check('MC-10 has no cartridge port', m.hasCartridgePort === false && throws(() => m.insertCartridge(new TestCart())));
}

// interrupt hub: a line stays asserted while any source holds it
{
  const cpu = { irqLine: false, firqLine: false, haltLine: false, nmi() { this.n = (this.n || 0) + 1; } };
  const hub = new Emu.InterruptHub(cpu);
  hub.set('a', 'irq', true); hub.set('b', 'irq', true); hub.set('a', 'irq', false);
  check('hub: IRQ held while another source asserts it', cpu.irqLine === true);
  hub.set('b', 'irq', false);
  check('hub: IRQ released when all sources release', cpu.irqLine === false);
  hub.set('x', 'nmi', true); hub.set('x', 'nmi', true); hub.set('x', 'nmi', false); hub.set('x', 'nmi', true);
  check('hub: NMI fires on rising edges only', cpu.n === 2);
}
// one source driving several lines: each line keeps its own level
{
  const cpu = { irqLine: false, firqLine: false, haltLine: false, nmi() { this.n = (this.n || 0) + 1; } };
  const hub = new Emu.InterruptHub(cpu);
  hub.set('fdc', 'halt', true); hub.set('fdc', 'nmi', true);
  check('hub: a source raising HALT then NMI delivers the NMI', cpu.n === 1 && cpu.haltLine === true, `NMIs ${cpu.n || 0}, HALT ${cpu.haltLine}`);
  hub.set('dev', 'irq', true); hub.set('dev', 'firq', true); hub.set('o', 'irq', true); hub.set('o', 'irq', false);
  check('hub: IRQ stays asserted by a source that also drives FIRQ', cpu.irqLine === true && cpu.firqLine === true);
  hub.set('dev', 'firq', false);
  check('hub: releasing one line of a source leaves its others', cpu.irqLine === true && cpu.firqLine === false && cpu.haltLine === true);
  // NMI is one wired line: a second source raising it while it is already high is no new edge
  hub.set('a', 'nmi', true);
  check('hub: NMI already held high by another source: no new edge', cpu.n === 1);
  hub.set('fdc', 'nmi', false); hub.set('a', 'nmi', false); hub.set('a', 'nmi', true);
  check('hub: NMI after every source released: a new edge', cpu.n === 2);
}

// $FF60-$FFBF with nothing there read the floating bus on the SAM machines (MAME coco.cpp floating_bus_read, from
// Darren A's measurements): the byte at $FFFF for most modes, the next instruction's first byte for no-offset
// indexed reads (LDA ,X), so a CoCo 2 running LDX #$FF70 / LDA ,X / LDB $FF70 gets A = the opcode after LDA ,X
for (const id of ['coco', 'dragon64']) {
  const m = Emu.createMachine(id);
  const rom = new Uint8Array(0x4000).fill(0x12);
  rom[0x3FFE] = 0x80; rom[0x3FFF] = 0x27;                               // reset vector $8027: $FFFF reads $27
  const prog = [0x8E, 0xFF, 0x70, 0xA6, 0x84, 0xF6, 0xFF, 0x70, 0x20, 0xFE];  // LDX #$FF70; LDA ,X; LDB $FF70; BRA *
  rom.set(prog, 0x27);
  const slots = {};
  for (const sl of m.profile.roms) slots[sl.id] = rom.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size);
  m.setRoms(slots); m.reset(true);
  for (let i = 0; i < 4; i++) m.cpu.step();
  check(`${id}: floating bus: LDA ,X reads the next opcode ($F6), LDB $FF70 the byte at $FFFF ($27)`, m.cpu.a === 0xF6 && m.cpu.b === 0x27, `A=${m.cpu.a.toString(16)} B=${m.cpu.b.toString(16)}`);
}
// PIA1 port B's input pins (MAME coco.cpp pia1_pb_r, on every Dragon and CoCo): bit 2 senses the RAM size (64K:
// follows PIA0 PB6), bit 0 is the RS-232 port's received data (idle high on the Dragon 64's 6551 port; the Dragon
// 32 and the Alpha have no port; the CoCo's carries a printer that holds it low), the rest read 0
{
  const pb = (id, pb6) => {
    const m = Emu.createMachine(id);
    m.reset(true);
    m.write(0xFF03, 0x00); m.write(0xFF02, 0xFF); m.write(0xFF03, 0x04); m.write(0xFF02, pb6 ? 0x40 : 0x00);
    m.write(0xFF23, 0x00); m.write(0xFF22, 0x00); m.write(0xFF23, 0x04);
    return m.read(0xFF22);
  };
  check('CoCo 1/2: PIA1 port B inputs read $04 with PIA0 PB6 high, $00 low', pb('coco', true) === 0x04 && pb('coco', false) === 0x00 && pb('cd6809', true) === 0x04);
  check('CoCo 3: the same wiring', pb('coco3', true) === 0x04 && pb('coco3', false) === 0x00);
  check('Dragon 64: the same, with serial in idle high ($05 / $01)', pb('dragon64', true) === 0x05 && pb('dragon64', false) === 0x01);
  check('Dragon 32: the same, no serial port ($04 / $00)', pb('dragon32', true) === 0x04 && pb('dragon32', false) === 0x00);
  check('Dragon 200 and Tano: serial in idle high like the Dragon 64', pb('dragon200', true) === 0x05 && pb('tanodr64', false) === 0x01);
  // MAME's Alpha has a 6551 but no RS-232 port (dgnalpha.cpp: no rs232 device, so m_rs232 is null)
  check('Dragon Alpha: a 6551 but no serial port ($04 / $00)', pb('dgnalpha', true) === 0x04 && pb('dgnalpha', false) === 0x00);
  // bit 0 is the port's RXD itself: a terminal's start bit reads 0
  const m = Emu.createMachine('dragon64');
  m.reset(true);
  m.acia.attachSerial('terminal', { baud: 1200 });
  m.write(0xFF23, 0x00); m.write(0xFF22, 0x00); m.write(0xFF23, 0x04);
  const idle = m.read(0xFF22) & 1;
  m.acia.port.send([0x00], m.ioTime());
  check('Dragon 64: PB0 follows the serial port (idle 1, a start bit 0)', idle === 1 && (m.read(0xFF22) & 1) === 0);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
