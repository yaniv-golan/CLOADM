// Run: node tests/dragon-printer.test.js
//
// The Dragons' parallel printer, on every Dragon profile, run on firmware written here (no ROM):
// * PIA1 PB0 is the printer's BUSY, high while the printer cannot take a character, low when it can (Smeed and
//   Sommerville, "Inside the Dragon" (1983), section 8.4.2 "Printer control", pp. 206-207; Dragon Data, "Dragon 32
//   Information for Machine Code Users" (March 1983), p. 4, PIO 1 B side (FF22) bit 0, "Printer busy input"). On the
//   Dragon 64 it is the printer's alone: the schematic (Dragon Data CD 41505 "CPU 64K (PAL)", issue 3, 3-8-83) wires
//   PIA1 PB0 only to the printer connector's BUSY (sheet 1, PL2 pin 20) and the RS-232 receivers only to the 6551
//   (sheet 3, IC11 RXD and CTS). CLOADM's printer is always attached and ready: PB0 reads 0, and the 6551's port
//   receives as it did.
// * A character goes out by pulsing PA1 high and low (the strobe line, inverted, taken HI-LO-HI: "Inside the Dragon",
//   p. 207; the schematic, sheet 1: PA1 through IC3's 74LS02 inverter to PL2 pin 1, STROBE). The printer takes PIA0
//   port B once per pulse, at its leading edge; DAC writes to the rest of port A print nothing.
// With config.mameCompat the machine keeps MAME 0.264's rules instead (dragon.cpp pia1_pa_changed: every port A
// output with PA1 high prints; coco.cpp pia1_pb_r: PB0 is the RS-232 port's RXD), so the lockstep comparisons run on.
const path = require('path');
const { pathToFileURL } = require('url');

let fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${extra}`}`); if (!ok) fail++; };

const DRAGONS = ['dragon32', 'dragon64', 'dragon200', 'dragon200e', 'tanodr64', 'd64plus', 'dgnalpha'];

// The firmware: waits for BUSY low as a printer routine does, then sends 'A' with one strobe pulse. A DAC tone plays
// inside the pulse (PA1 held high) and after it (PA1 held low); PIA0 port B changes to 'Z' while the strobe is still
// high, which the printer, having taken 'A' at the pulse's leading edge, must not see. The pulse's high half is cut in
// two by a marker (MID = 1) where a test can stop the machine with the strobe high; PRE = 1 marks the moment before the
// pulse, with 'A' on the data lines and the strobe low, the next port A write its leading edge.
// DONE = $FF at the end. Exactly one byte is printed: $41.
const SRC = `
DONE    EQU     $3000
MID     EQU     $3001
PRE     EQU     $3002
        ORG     $4000
START   ORCC    #$50
        CLR     DONE
        CLR     MID
        CLR     PRE
        ; PIA0 port B: all outputs (the printer's data lines)
        CLR     $FF03
        LDA     #$FF
        STA     $FF02
        LDA     #$04
        STA     $FF03
        ; PIA1 port A: PA1-PA7 outputs, the strobe low; the DDR through $00 lets PA1 go to its pull-up for a moment,
        ; which is no character
        CLR     $FF21
        CLR     $FF20
        LDA     #$FE
        STA     $FF20
        LDA     #$34
        STA     $FF21
        CLR     $FF20
        ; PIA1 port B: PB0 (BUSY) an input, data register selected
        CLR     $FF23
        LDA     #$FC
        STA     $FF22
        LDA     #$34
        STA     $FF23
BUSY    LDA     $FF22           ; wait while the printer is busy (PB0 high)
        LSRA
        BCS     BUSY
        LDA     #$41
        STA     $FF02           ; the character on the data lines
        INC     PRE
        LDA     #$02
        STA     $FF20           ; strobe high: the printer takes 'A'
        LDA     #$5A
        STA     $FF02           ; the data lines change while the strobe is high
        LDB     #64
HIGH    LDA     #$FE            ; a tone with the strobe held high
        STA     $FF20
        LDA     #$02
        STA     $FF20
        DECB
        BNE     HIGH
        INC     MID
        LDB     #64
HIGH2   LDA     #$AA
        STA     $FF20
        LDA     #$56
        STA     $FF20
        DECB
        BNE     HIGH2
        CLR     $FF20           ; strobe low: the pulse ends
        LDB     #128
TONE    LDA     #$FC            ; a tone with the strobe held low
        STA     $FF20
        LDA     #$A8
        STA     $FF20
        CLR     $FF20
        DECB
        BNE     TONE
        LDA     #$FF
        STA     DONE
HALT    BRA     HALT
`;

(async () => {
  const Emu = await import(pathToFileURL(path.join(__dirname, '..', 'js', 'emu.js')).href);
  const asm = Emu.assemble(SRC, '6809');
  const DONE = asm.symbols.get('DONE'), MID = asm.symbols.get('MID'), PRE = asm.symbols.get('PRE');
  const start = (id, config = {}) => {
    const m = Emu.createMachine(id, config);
    m.injectAndRun(asm.segments, asm.symbols.get('START'));
    m.printed.length = 0;
    return m;
  };
  const runUntil = (m, cond, step = 1000) => { for (let n = 0; n < 50000000 / step && !cond(); n++) m.runCycles(m.cycle + step); return cond(); };

  for (const id of DRAGONS) {
    // the firmware strobes one byte
    const m = start(id);
    const done = runUntil(m, () => m.read(DONE) === 0xFF);
    check(`${id}: the firmware got past BUSY and finished`, done);
    check(`${id}: one strobe pulse prints exactly one byte, the data at its leading edge ($41)`, m.printed.length === 1 && m.printed[0] === 0x41, m.printed.join(','));
    // BUSY: the printer is ready
    check(`${id}: PIA1 PB0 (printer BUSY) reads 0, the printer ready`, (m.read(0xFF22) & 0x01) === 0);

    // a snapshot inside the pulse (strobe high) and just before it (strobe low, the next port A write its leading
    // edge): the restored machine prints what the uninterrupted one does, and nothing more
    for (const [where, mark] of [['with the strobe high', MID], ['with the strobe low, just before the pulse', PRE]]) {
      const a = start(id);
      check(`${id}: stopped ${where}`, runUntil(a, () => a.read(mark) === 1, 1) && ((a.pia1.a.outValue() & 0x02) !== 0) === (mark === MID));   // one instruction at a time
      const saved = Emu.state.fromJSON(Emu.state.toJSON(a.snapshot()));
      // a second pulse after the firmware: 'B', which a restored machine must also take exactly once
      const finish = (mm) => {
        runUntil(mm, () => mm.read(DONE) === 0xFF);
        mm.write(0xFF02, 0x42); mm.write(0xFF20, 0x02); mm.write(0xFF20, 0xFE); mm.write(0xFF20, 0x00);
        return mm.printed.join(',');
      };
      const before = a.printed.length;
      const cont = finish(a);
      const b = Emu.restoreSnapshot(saved, a.roms);
      b.printed.length = before;   // what had been printed when the snapshot was taken, as restored
      check(`${id}: snapshot ${where}: the restored machine prints the same as the uninterrupted one`, finish(b) === cont && cont === '65,66', `${b.printed.join(',')} vs ${cont}`);
    }
  }

  // The 6551's RS-232 port still receives on every Dragon that has it, and PB0 no longer follows its RXD
  for (const id of DRAGONS.filter((i) => Emu.profiles[i].rs232)) {
    const m = start(id);
    runUntil(m, () => m.read(DONE) === 0xFF);
    m.acia.attachSerial('terminal', { baud: 1200 });
    m.write(0xFF06, 0x0B);          // command: DTR on, receiver IRQ off, no parity
    m.write(0xFF07, 0x18);          // control: 8 bits, 1 stop, 1200 baud
    const pb0 = [m.read(0xFF22) & 1];
    m.acia.port.send([0x00, 0x55], m.ioTime());
    let got = [], sawLow = false;
    for (let i = 0; i < 4000 && got.length < 2; i++) {
      m.runCycles(m.cycle + 100);
      pb0.push(m.read(0xFF22) & 1);
      if (!m.acia.port.rxd(m.ioTime())) sawLow = true;
      if (m.read(0xFF05) & 0x08) got.push(m.read(0xFF04));
    }
    check(`${id}: the 6551 receives over RS-232 as before ($00, $55)`, got.join(',') === '0,85', got.join(','));
    check(`${id}: ...the line went to space for the start bits, and PIA1 PB0 stayed 0 (it is the printer's BUSY, not RXD)`, sawLow && pb0.every((v) => v === 0), `sawLow ${sawLow}, PB0 ${[...new Set(pb0)]}`);
    // MAME's model, kept for the lockstep comparisons: PB0 is the port's RXD
    const c = Emu.createMachine(id, { mameCompat: true });
    c.reset(true);
    c.write(0xFF23, 0x00); c.write(0xFF22, 0x00); c.write(0xFF23, 0x04);
    c.acia.attachSerial('terminal', { baud: 1200 });
    const idle = c.read(0xFF22) & 1;
    c.acia.port.send([0x00], c.ioTime());
    check(`${id}: with mameCompat, PB0 is MAME's RS-232 RXD (idle 1, a start bit 0)`, idle === 1 && (c.read(0xFF22) & 1) === 0);
  }

  // MAME's printing rule under mameCompat: every PIA1 port A output with PA1 high prints, the reset's too
  {
    const m = Emu.createMachine('dragon64', { mameCompat: true });
    m.reset(true);
    check('mameCompat: reset prints PIA0 port B ($FF), as MAME device_reset', m.printed.join() === '255', m.printed.join());
    m.printed.length = 0;
    m.write(0xFF03, 0x00); m.write(0xFF02, 0xFF); m.write(0xFF03, 0x04);
    m.write(0xFF21, 0x00); m.write(0xFF20, 0xFE); m.write(0xFF21, 0x04);
    m.write(0xFF02, 0x41); m.write(0xFF20, 0x00); m.write(0xFF20, 0x02); m.write(0xFF20, 0x02);
    check('mameCompat: every port A output with the strobe high prints (MAME dragon_state::pia1_pa_changed)', m.printed.join() === '65,65', m.printed.join());
  }
  // without it: PA1 let go to its pull-up is no character: power-on, a reset with the strobe low, a DDR write
  for (const id of DRAGONS) {
    const m = Emu.createMachine(id);
    m.reset(true);
    check(`${id}: power-on prints nothing`, m.printed.length === 0, m.printed.join());
    m.write(0xFF21, 0x00); m.write(0xFF20, 0xFE); m.write(0xFF21, 0x04); m.write(0xFF20, 0x00);
    m.reset(false);
    m.write(0xFF21, 0x00); m.write(0xFF20, 0xFE); m.write(0xFF21, 0x04); m.write(0xFF20, 0x00);
    m.write(0xFF21, 0x00); m.write(0xFF20, 0x00); m.write(0xFF20, 0xFE); m.write(0xFF21, 0x04);
    check(`${id}: a reset, or a DDR write, letting the strobe go high from low prints nothing`, m.printed.length === 0, m.printed.join());
    m.write(0xFF20, 0x02); m.write(0xFF20, 0x00);
    check(`${id}: ...and the next pulse prints`, m.printed.length === 1, m.printed.join());
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
