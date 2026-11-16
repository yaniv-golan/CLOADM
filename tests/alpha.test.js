// Dragon Professional (Alpha) board wiring (js/machines/alpha.js), checked against MAME 0.264's dgnalpha.cpp
// as written there (the full behaviour, instruction by instruction, is compared with MAME by
// tools/mame-diff/run.js dgnalpha [--board | --fdc alphafdc | --sound | --video]):
//   ROM banks (dragon64_state::page_rom), PIA2 at $FF24 (pia2_pa_w: AY bus control, ROM switch gated by PIA2's
//   port B DDR bit 2), the modem stub at $FF28, the $FF30 mirror, the WD2797 reversed at $FF2C, INTRQ to NMI
//   through PIA2 CA2 (fdc_intrq_w), the AY's port A as the drive latch (psg_porta_write), drives 0 and 1 fitted.
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const throws = (name, fn, re) => { let msg = null; try { fn(); } catch (e) { msg = e.message; } check(name, msg !== null && re.test(msg), msg === null ? 'did not throw' : msg); };

// a boot ROM that loops at $A000; markers in both banks
const boot = new Uint8Array(0x2000).fill(0xB0);
boot.set([0x20, 0xFE]);                      // $A000: BRA *
boot[0x1FFE] = 0xA0; boot[0x1FFF] = 0x00;    // reset vector -> $A000
const basic = new Uint8Array(0x4000).fill(0xC0);
basic[0] = 0xB1; basic[0x2000] = 0xB2; basic[0x3FFE] = 0xA0; basic[0x3FFF] = 0x00;
const m = Emu.createMachine('dgnalpha');
m.setRoms({ boot, basic });
m.reset(true);
const r = (a) => m.read(a), w = (a, v) => m.write(a, v);
const bank = () => [r(0x8000), r(0xA002)].map((v) => v.toString(16)).join(' ');

check('profile: in the Dragon section of the menu, two ROM sockets', /^Dragon/.test(Emu.profiles.dgnalpha.name) && Emu.profiles.dgnalpha.roms.map((s) => s.id).join() === 'boot,basic');
check('after reset the boot bank: $8000-$9FFF reads 00, $A000-$BFFF the boot ROM', bank() === '0 b0', bank());
// PIA2 PA2 switches only while PIA2's port B DDR bit 2 is set
w(0xFF25, 0x00); w(0xFF24, 0x04);                       // DDRA = $04: PA2 low, DDRB bit 2 clear
check('PIA2 PA2 low with its port B DDR bit 2 clear: no switch (MAME tests port_b_z_mask)', bank() === '0 b0', bank());
w(0xFF27, 0x00); w(0xFF26, 0x04);                       // DDRB = $04
w(0xFF25, 0x04); w(0xFF24, 0x00);                       // PA = 00
check('PIA2 PA2 low with DDRB bit 2 set: the BASIC bank', bank() === 'b1 c0', bank());
w(0xFF24, 0x04);
check('PIA2 PA2 high: the boot bank again', bank() === '0 b0', bank());
// PIA1 PB2 as an output switches too; a DDR change to input leaves the bank as it was (a latch)
w(0xFF23, 0x00); w(0xFF22, 0x04);                       // PIA1 DDRB = $04, out 0
check('PIA1 PB2 an output, low: the BASIC bank', bank() === 'b1 c0', bank());
w(0xFF22, 0x00);                                        // DDRB = 0: PB2 an input
check('PIA1 PB2 back to an input: the bank stays (page_rom is only called for an output)', bank() === 'b1 c0', bank());
w(0xFF24, 0x04);
check('a PIA2 port A write switches it back', bank() === '0 b0', bank());

// $FF30 mirror, modem
w(0xFF35, 0x3C);
check('$FF30-$FF3F mirrors $FF20-$FF2F (PIA2 CRA through $FF35)', r(0xFF25) === 0x3C && r(0xFF35) === 0x3C);
check('the modem at $FF28-$FF2B reads $FF', [0xFF28, 0xFF29, 0xFF2A, 0xFF2B, 0xFF38].every((a) => r(a) === 0xFF));
w(0xFF2E, 0x5A); for (let i = 0; i < 5; i++) m.runFrame();
check('the WD2797 track register is at $FF2E (registers reversed: data $FF2C ... status $FF2F)', r(0xFF2E) === 0x5A && r(0xFF3E) === 0x5A);

// the AY through PIA2: port B its bus, port A $07 address, $05 write, $06 read
const ay = (reg, val) => {
  w(0xFF27, 0x00); w(0xFF26, 0xFF); w(0xFF27, 0x04);
  w(0xFF26, reg); w(0xFF24, 0x07); w(0xFF24, 0x04);
  w(0xFF26, val); w(0xFF24, 0x05); w(0xFF24, 0x04);
};
const ayRead = (reg) => {
  w(0xFF27, 0x00); w(0xFF26, 0xFF); w(0xFF27, 0x04);
  w(0xFF26, reg); w(0xFF24, 0x07); w(0xFF24, 0x04);
  w(0xFF27, 0x00); w(0xFF26, 0x00); w(0xFF27, 0x04);
  w(0xFF24, 0x06); w(0xFF24, 0x04);
  return r(0xFF26);
};
w(0xFF25, 0x00); w(0xFF24, 0x07); w(0xFF25, 0x34); w(0xFF24, 0x04);
ay(8, 0x0B);
check('an AY register written and read back through PIA2', ayRead(8) === 0x0B);
check('register 14 reads the port A input (00 on the Alpha)', ayRead(14) === 0x00);
ay(14, 0x21); ay(7, 0x7F);
check('AY port A $21 (output): drive 0, single density, the motors on', m.fdc.wd.floppy === m.fdc.drives[0] && m.fdc.wd.dden === true && m.fdc.drives[0].mon === 0 && m.fdc.drives[1].mon === 0);
ay(14, 0x02);
check('AY port A $02: drive 1, double density', m.fdc.wd.floppy === m.fdc.drives[1] && m.fdc.wd.dden === false);
ay(14, 0x04);
check('AY port A $04: drive 2 is not fitted, so no drive', m.fdc.wd.floppy === null);
ay(14, 0x0A);
check('two select bits: the higher drive wins ($0A -> drive 3, not fitted)', m.fdc.wd.floppy === null);
throws('drive 2 takes no disk (not fitted)', () => m.fdc.mount(2, { bytes: new Uint8Array(10), format: 'vdk' }), /no drive 2 \(drives 0-1\)/);

// INTRQ -> NMI, gated by PIA2 CA2 as INTRQ rises
const nmi = () => m.interrupts.level('alphafdc', 'nmi');
w(0xFF25, 0x34);                        // CA2 output, low
r(0xFF2F); w(0xFF2F, 0xD8);             // force interrupt, immediate: INTRQ
m.runFrame();
check('INTRQ with PIA2 CA2 low: no NMI', !nmi());
w(0xFF2F, 0xD0); m.runFrame();         // a new command: INTRQ falls (D8 holds it until then)
w(0xFF25, 0x3C);                        // CA2 high
w(0xFF2F, 0xD8); m.runFrame();
check('INTRQ with PIA2 CA2 high: NMI', nmi());
w(0xFF2F, 0xD0); m.runFrame();
check('INTRQ falls: NMI released', !nmi());
w(0xFF25, 0x04);                        // CA2 an input: pulled up
w(0xFF2F, 0xD8); m.runFrame();
check('INTRQ with PIA2 CA2 an input (pulled up): NMI', nmi());
w(0xFF2F, 0xD0); m.runFrame();
w(0xFF25, 0x34);
w(0xFF2F, 0xD8); m.runFrame();
w(0xFF25, 0x3C); m.runFrame();
check('raising CA2 while INTRQ is already high does not raise NMI (only INTRQ edges count)', !nmi());

// snapshots carry the Alpha's own state
{
  const s = Emu.state.toJSON(m.snapshot());
  const b = Emu.restoreSnapshot(Emu.state.fromJSON(s), m.roms);
  check('snapshot: ROM bank, PIA2, CA2, AY and the disk latch come back', b.romBank === m.romBank && b.pia2Ca2 === m.pia2Ca2 && b.ay.peek(8) === 0x0B
    && b.fdc.dskreg === m.fdc.dskreg && b.pia2.a.cr === m.pia2.a.cr);
  const snap = Emu.state.fromJSON(s);
  delete snap.state.alpha;
  throws('a snapshot without the Alpha state is refused', () => Emu.restoreSnapshot(snap, m.roms), /missing "alpha"/);
}

console.log(fail ? `${fail} failed` : 'all passed');
process.exitCode = fail ? 1 : 0;
