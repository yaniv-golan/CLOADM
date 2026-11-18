// Run: node tests/coco3.test.js  -- CoCo 3: GIME MMU, interrupts, timer, CPU speed, video, stub mode
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
let fail = 0;
const check = (n, c) => { if (!c) { fail++; console.log('FAIL', n); } else console.log('ok  ', n); };
const asm = (src) => { const r = Emu.assemble(src, '6809'); if (!r.ok) throw new Error(r.errors.join('\n')); return r; };

// ---------------- stub smoke test ----------------
{
  const m = Emu.createMachine('coco3');
  m.reset(true);
  for (let i = 0; i < 5; i++) m.runFrame();
  const text = () => { let s = ''; for (let i = 0x400; i < 0x600; i++) { const c = m.ram[i] & 0x3F; s += String.fromCharCode(c < 0x20 ? c + 0x40 : c); } return s; };
  check('stub banner on screen', text().includes('COCO 3') && text().includes('BUILT-IN STUB'));
  check('screen size 640x240', m.screenWidth === 640 && m.screenHeight === 240 && m.render().data.length === 640 * 240);
  check('compatibility text rendered', new Set(Emu.frameToRGBA(m.render())).size >= 2);
  check('frame timing', m.frameCycles === 228 * 262 && Math.abs(m.fps - 59.94) < 0.1);
  check('stub keys via POLCAT', (() => { m.stubKeys.push(65); m.runFrame(); return text().includes('A'); })());
  // the demo binary from the examples (written for the Dragon/CoCo VDG modes) runs in compatibility mode
  const bin = new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/demo.bin')));
  const d = Emu.formats.identify('demo.bin', bin);
  m.injectAndRun(d.segments, d.exec);
  for (let i = 0; i < 10; i++) m.runFrame();
  check('demo printed message', text().includes('PRESS ANY KEY'));
  m.stubKeys.push(32);
  for (let i = 0; i < 30; i++) m.runFrame();
  check('demo set a graphics mode', (m.gime.ff22 & 0x80) !== 0 && new Set(Emu.frameToRGBA(m.render())).size >= 4);
  const p = Emu.createMachine('coco3p');
  p.reset(true); for (let i = 0; i < 3; i++) p.runFrame();
  check('PAL model: 312 lines, stub runs', p.frameCycles === 228 * 312 && p.ram[0x400] !== 0xFF);
}

// run a program from RAM in stub mode until it stores $FF at $0FFF (or a frame limit)
function run(src, frames = 50, config) {
  const m = Emu.createMachine('coco3', config);
  const r = asm(src);
  m.injectAndRun(r.segments, r.segments[0].addr);
  m.ram[0x0FFF] = 0;                                // RAM powers up as $FF
  for (let i = 0; i < frames && m.ram[0x0FFF] !== 0xFF; i++) m.runFrame();
  return m;
}

// ---------------- MMU ----------------
{
  const m = run(`
        ORG $1000
START   ORCC #$50
        LDA #$01
        STA $FFA2       ; task 0: slot 2 ($4000) -> block 1
        LDA #$11
        STA $4000
        LDA #$02
        STA $FFA2       ; block 2
        LDA #$22
        STA $4000
        LDA #$01
        STA $FFA2
        LDA $4000
        STA $0F00       ; $11
        LDA #$02
        STA $FFAA       ; task 1: slot 2 -> block 2
        LDA #$01
        STA $FF91       ; switch to task 1 (slots 0,1 and 4-7 identical in both tasks)
        LDA $4000
        STA $0F01       ; $22
        CLR $FF91
        LDA $FFA2
        STA $0F02       ; MMU register reads back (low 6 bits)
        LDA #$3A
        STA $FFA2
        LDA #$FF
        STA $0FFF
        BRA *
`);
  check('MMU: slot 2 maps block 1', m.ram[0xF00] === 0x11 && m.mem[0x2000] === 0x11);
  check('MMU: task 1 register set', m.ram[0xF01] === 0x22 && m.mem[0x4000] === 0x22);
  check('MMU register readback', (m.ram[0xF02] & 0x3F) === 0x01);
}
{
  const m = Emu.createMachine('coco3');
  m.reset(true);
  const g = m.gime;
  const rom = new Uint8Array(0x8000); for (let i = 0; i < 0x8000; i++) rom[i] = i >> 13;  // ROM page number
  const cart = new Uint8Array(0x4000).fill(0xCA);
  m.setRoms({ basic: rom }); m.insertCartridge(new Emu.RomCartridge(cart, { autostart: false }));
  m.write(0xFF90, 0x00);
  check('ROM mode 0: $8000 internal, $C000 cartridge', m.read(0x8000) === 0 && m.read(0xA000) === 1 && m.read(0xC000) === 0xCA);
  m.write(0xFF90, 0x02);
  check('ROM mode 2: 32K internal', m.read(0xC000) === 2 && m.read(0xE000) === 3);
  m.write(0xFF90, 0x03);
  check('ROM mode 3: 32K cartridge', m.read(0x8000) === 0xCA && m.read(0xE000) === 0xCA);
  check('vectors always from internal ROM', m.read(0xFFFE) === 3);
  m.write(0xFF90, 0x42);
  m.write(0xFFA0, 0x3D);
  check('ROM block mapped in slot 0 uses the page of slot 0', m.read(0x0000) === 0);
  m.write(0xFFA0, 0x38);
  m.write(0xFFDF, 0);                               // SAM TY: all RAM
  m.write(0x8000, 0x5A);
  check('TY=1: ROM blocks become RAM', m.read(0x8000) === 0x5A && m.mem[0x78000] === 0x5A);
  m.write(0xFFDE, 0);
  check('TY=0: ROM again, RAM kept', m.read(0x8000) === 0 && m.mem[0x78000] === 0x5A);
  m.write(0xFFA7, 0x30);
  m.write(0xFF90, 0x4A);                            // MC3: $FExx fixed to block $3F
  m.write(0xFE20, 0x77);
  check('constant page $FExx -> block $3F', m.mem[0x7FE20] === 0x77 && m.read(0xFE20) === 0x77);
  m.write(0xFF90, 0x42);
  check('without MC3 $FExx follows slot 7', m.gime.physAddr(0xFE20) === 0x61E20);
  const s = Emu.createMachine('coco3', { ram: 128 });
  s.reset(true);
  s.write(0xFF90, 0x40); s.write(0xFFA2, 0x31); s.write(0x4000, 0x99);
  check('128K: blocks wrap modulo 16', s.mem.length === 0x20000 && s.mem[0x02000] === 0x99 && s.ram.length === 0x10000);
}

// ---------------- interrupts and timer ----------------
const irqProgram = (setup, handlerRead) => `
        ORG $1000
START   ORCC #$50
        LDA #$7E
        STA $010C
        LDX #HANDLER
        STX $010D       ; IRQ: $FFF8 -> $FEF7 -> $010C -> HANDLER
        CLR $3000
        LDA #$34
        STA $FF03       ; the stub enabled the PIA field-sync IRQ; turn it off
${setup}
        ANDCC #$EF
        BRA *
HANDLER INC $3000
        LDA ${handlerRead}
        RTI
`;
{
  // timer, 63.5us input: 20 + 2 lines per interrupt
  const m = run(irqProgram(`
        LDA #$20
        STA $FF92       ; TMR -> IRQ
        LDA #$EE
        STA $FF90       ; CoCo bit, MMU, IEN, MC3, ROM mode 2
        LDA #$14
        STA $FF95
        CLR $FF94       ; start: 20 + 2 lines`, '$FF92'), 0);
  const c0 = m.ram[0x3000];
  for (let i = 0; i < 11; i++) m.runFrame();
  const n = (m.ram[0x3000] - c0) & 0xFF;
  check(`timer IRQ rate (${n} in 11 fields, expect 131)`, n >= 130 && n <= 132);
  check('IRQ acknowledged by reading $FF92', m.gime.irq === 0 || m.gime.irq === 0x20);
}
{
  // VBORD: once per field, through FIRQ
  const m = run(`
        ORG $1000
START   ORCC #$50
        LDA #$7E
        STA $010F
        LDX #HANDLER
        STX $0110       ; FIRQ: $FFF6 -> $FEF4 -> $010F -> HANDLER
        CLR $3000
        LDA #$08
        STA $FF93       ; VBORD -> FIRQ
        LDA #$DE
        STA $FF90       ; FEN
        ANDCC #$AF
        BRA *
HANDLER INC $3000
        TST $FF93
        RTI
`, 0);
  m.runFrame();
  const c0 = m.ram[0x3000];
  for (let i = 0; i < 10; i++) m.runFrame();
  check(`VBORD FIRQ once per field (${(m.ram[0x3000] - c0) & 0xFF} in 10)`, ((m.ram[0x3000] - c0) & 0xFF) === 10);
}
{
  // HBORD polled through $FF92 with the GIME IRQ output off; count lines in one field
  const m = Emu.createMachine('coco3');
  m.reset(true);
  m.write(0xFF92, 0x10);
  let n = 0;
  for (let i = 0; i < m.frameCycles; i += 50) { m.cycle += 50; m.processEvents(m.cycle); if (m.read(0xFF92) & 0x10) n++; }
  check(`HBORD status once per line (${n})`, n >= 260 && n <= 263);
  check('interrupt status clears on read', m.read(0xFF92) === 0);
  m.write(0xFF90, 0x00);
  check('GIME IRQ output gated by IEN', !m.cpu.irqLine);
}
{
  // keyboard interrupt (EI1) on a key press
  const m = Emu.createMachine('coco3');
  m.reset(true);
  m.write(0xFF92, 0x02);
  m.write(0xFF03, 0x00); m.write(0xFF02, 0xFF); m.write(0xFF03, 0x04); m.write(0xFF02, 0x00); // all columns low
  m.setKey('A', true);
  check('keyboard interrupt on key press', (m.read(0xFF92) & 0x02) !== 0);
}
{
  // CPU speed: cycles executed per field double at 1.79 MHz
  const prog = (poke) => `
        ORG $1000
START   ORCC #$50
        ${poke}
LOOP    NOP
        BRA LOOP
`;
  const cyc = (src) => { const m = run(src, 0); m.runFrame(); const c0 = m.cpu.totalCycles; m.runFrame(); return m.cpu.totalCycles - c0; };
  const slow = cyc(prog('STA $FFD8')), fast = cyc(prog('STA $FFD9'));
  check(`0.89 MHz: ${slow} cycles per field`, Math.abs(slow - 14934) <= 4);
  check(`1.79 MHz: ${fast} cycles per field`, Math.abs(fast - 2 * 14934) <= 4);
}
{
  // A write to the SAM rate bits from outside the CPU (the debugger's memory write; anything else that reaches
  // machine.write() between instructions) sets the CPU clock divider as well as gime.fast: no instruction is in
  // flight, so the next one runs at the new rate. (A program's own write keeps the mid-instruction model measured
  // above; the regression hashes and the MAME lockstep cover that path.)
  for (const mameCompat of [false, true]) {
    const tag = mameCompat ? ' (mameCompat)' : '';
    // a tight loop that waits on $0FFE, so a frame's cycle count depends on the divider alone (the stub's own
    // polling jitters); when the flag is set the loop stores $FFD9 (the rate the GIME already holds, see below)
    const m = run(' ORG $1000\n ORCC #$50\nW LDA $0FFE\n CMPA #1\n BNE W\n LDA #$5A\n STA $1002\n STA $FFD9\nL NOP\n BRA L\n', 0, { mameCompat });
    m.ram[0x0FFE] = 0;
    const dbg = new Emu.Debugger(m);
    for (let i = 0; i < 3; i++) m.runFrame();
    const per = () => { const c0 = m.cpu.totalCycles; m.runFrame(); return m.cpu.totalCycles - c0; };
    const slow0 = per();
    check(`outside write${tag}: 0.89 MHz first (${slow0} cycles per field)`, Math.abs(slow0 - 14934) <= 4);
    dbg.write(0xFFD9, [0]);
    check(`outside $FFD9${tag}: gime.fast and the divider at 2`, m.gime.fast && m.div === 2);
    m.runFrame();                                   // the frame the change landed in is only partly at the new rate
    const fast = per();
    check(`outside $FFD9${tag}: ${fast} cycles per field (1.79 MHz)`, Math.abs(fast - 2 * 14934) <= 4);
    // a program write of the rate the GIME already holds changes nothing in the GIME, so on the old code it left
    // the divider at 4 (the GIME said "no change", so nothing re-timed); it must not undo the outside write.
    // The loop must actually have run its store, so it leaves a witness byte ($1002 gets $5A just before the STA)
    m.ram[0x0FFE] = 1;                              // the loop at $1001 waits for this, then STA $FFD9
    for (let i = 0; i < 3; i++) m.runFrame();
    check(`outside $FFD9${tag}: the program ran its store`, m.ram[0x1002] === 0x5A);
    const same = per();
    check(`outside $FFD9${tag}: a program write of the same rate leaves ${same} cycles per field`,
      m.gime.fast && m.div === 2 && Math.abs(same - 2 * 14934) <= 4);
    // a snapshot taken while the outside write is in force restores at the same rate (div is in the state)
    const snap = Emu.state.fromJSON(Emu.state.toJSON(m.snapshot()));
    const r = Emu.restoreSnapshot(snap, m.roms);
    for (let i = 0; i < 2; i++) r.runFrame();
    const rc = r.cpu.totalCycles;
    r.runFrame();
    check(`outside $FFD9${tag}: a restored machine still runs at ${r.cpu.totalCycles - rc} cycles per field`,
      r.gime.fast && r.div === 2 && Math.abs((r.cpu.totalCycles - rc) - 2 * 14934) <= 4);
    dbg.write(0xFFD8, [0]);
    check(`outside $FFD8${tag}: the divider back at 4`, !m.gime.fast && m.div === 4);
    m.runFrame();
    const slow = per();
    check(`outside $FFD8${tag}: ${slow} cycles per field (0.89 MHz)`, Math.abs(slow - 14934) <= 4);

    // SAM R1 alone is fast too, and clearing R1 with R0 still set must leave it fast: a divider derived from
    // the register's parity rather than from gime.fast passes everything above and fails here
    dbg.write(0xFFD9, [0]);                        // R1 set
    dbg.write(0xFFD7, [0]);                        // R0 set as well
    check(`outside $FFD7${tag}: R0 or R1 is fast`, m.gime.fast && m.div === 2);
    dbg.write(0xFFD8, [0]);                        // R1 cleared, R0 remains: still fast
    check(`outside $FFD8 with R0 set${tag}: still fast`, m.gime.fast && m.div === 2);
    m.runFrame();
    check(`outside $FFD8 with R0 set${tag}: ${per()} cycles per field`, Math.abs(per() - 2 * 14934) <= 4);
    dbg.write(0xFFD6, [0]);                        // R0 cleared: slow again
    check(`outside $FFD6${tag}: back to 0.89 MHz`, !m.gime.fast && m.div === 4);

    // a snapshot saved while the bug was live holds gime.fast with the divider still at 4. Loading it must
    // re-derive the divider, or the machine stays at the slow rate for good (a later write of the same rate
    // does not re-time: gime.js reports no change)
    dbg.write(0xFFD9, [0]);                        // fast, divider 2
    m.div = 4;                                      // as an old snapshot of the bug would hold it
    const old = Emu.state.fromJSON(Emu.state.toJSON(m.snapshot()));
    const r2 = Emu.restoreSnapshot(old, m.roms);
    check(`restore mid-rate${tag}: the divider follows gime.fast`, r2.gime.fast && r2.div === 2);
    for (let i = 0; i < 2; i++) r2.runFrame();
    const c2 = r2.cpu.totalCycles;
    r2.runFrame();
    check(`restore mid-rate${tag}: ${r2.cpu.totalCycles - c2} cycles per field`, Math.abs((r2.cpu.totalCycles - c2) - 2 * 14934) <= 4);
  }
}

// ---------------- GIME video ----------------
{
  const m = Emu.createMachine('coco3');
  m.reset(true);
  m.runFrame();                                     // let the stub initialise first
  m.cpu.cc |= 0x50;
  const w = (a, v) => m.write(a, v);
  w(0xFF90, 0x40); w(0xFF98, 0x80); w(0xFF99, 0x1E); w(0xFF9A, 0x3F); w(0xFF9D, 0xE0); w(0xFF9E, 0x00);
  for (let i = 0; i < 16; i++) w(0xFFB0 + i, i * 4);
  for (let i = 0; i < 0x8000; i++) m.poke(i, (i & 0xFF) * 0x11 & 0xFF);
  m.runFrame(); m.runFrame();
  const px = Emu.frameToRGBA(m.render());
  const cols = new Set(px.subarray(30 * 640, 31 * 640));
  check(`320x192x16: ${cols.size} colours on a body line`, cols.size === 16);
  check('wide mode has no side border', px[30 * 640] !== px[2 * 640]);
  check('border colour from $FF9A', px[2 * 640] === Emu.GIME.RGB_PALETTE[0x3F]);
  w(0xFF98, 0x03); w(0xFF99, 0x15);                 // 80-column text with attributes
  m.runFrame(); m.runFrame();
  check('80-column text renders', new Set(Emu.frameToRGBA(m.render()).subarray(40 * 640, 41 * 640)).size >= 2);
  m.monitor = 'composite'; m.runFrame(); m.runFrame();
  check('composite palette option', Emu.frameToRGBA(m.render())[2 * 640] === Emu.GIME.COMPOSITE_PALETTE[0x3F]);
  // The composite colours are MAME's measured table (gime.cpp get_composite_color); spot values written here as
  // 0xRRGGBB from that source: code $16 is $B63402, code $16 with BPI set (its phase-inverted table) $0077A9.
  // MOCH shows each as grey, (r + g + b) / 3 rounded down (mc6847.h black_and_white): $B6 + $34 + $02 = 236, / 3 = 78 = $4E.
  const abgr = (rgb) => (0xFF000000 | ((rgb & 0xFF) << 16) | (rgb & 0xFF00) | ((rgb >> 16) & 0xFF)) >>> 0;
  w(0xFF9A, 0x16);                                  // border colour $16
  const border = () => { m.runFrame(); m.runFrame(); return Emu.frameToRGBA(m.render())[2 * 640]; };
  check('composite: MAME\'s colour for $16', border() === abgr(0xB63402));
  w(0xFF98, 0x23);
  check('composite, $FF98 BPI: the phase-inverted colour', border() === abgr(0x0077A9));
  w(0xFF98, 0x13);
  check('composite, $FF98 MOCH: grey', border() === abgr(0x4E4E4E));
  w(0xFF98, 0x33);
  check('composite, BPI and MOCH: the inverted colour in grey', border() === abgr(0x606060));   // (0 + $77 + $A9) / 3 = 96 = $60
  m.monitor = 'rgb';
  check('the RGB monitor ignores BPI and MOCH', border() === Emu.GIME.RGB_PALETTE[0x16]);
  // the table follows a snapshot: restored with BPI set, the composite colour is the inverted one
  m.monitor = 'composite';
  const snap = Emu.state.fromJSON(Emu.state.toJSON(m.snapshot()));
  const r = Emu.restoreSnapshot(snap, m.roms); r.monitor = 'composite';
  r.runFrame(); r.runFrame();
  check('a restored machine keeps the BPI / MOCH palette', Emu.frameToRGBA(r.render())[2 * 640] === abgr(0x606060));
  w(0xFF98, 0x03);
}

// ---- the cartridge's I/O on a CoCo 3 (a disk controller) ----
// $FF40-$FF5F reach the cartridge only while the GIME's INIT0 bit 2 (SCS, "standard SCS") is set; CoCo 3 BASIC
// sets it, the power-on value 0 leaves the cartridge's registers unreachable. Observed in MAME 0.264 coco3
// (-ext fdc): with INIT0 = 0 the WD1773 reads $00 and ignores writes; once $04 is written to $FF90 it answers.
// Lockstep: node tools/mame-diff/run.js coco3 --fdc (tools/mame-diff/fdc/boot3.asm sets it).
{
  const m = Emu.createMachine('coco3');
  const f = new Emu.devices.cocofdc({ rom: new Uint8Array(0x2000) });
  m.insertCartridge(f);
  m.reset(true);
  m.runFrame();
  m.write(0xFF90, m.gime.regs[0] & ~0x04);            // SCS off (the stub firmware set INIT0), the rest as it is
  m.write(0xFF4A, 0x5A);                              // the WD1773's sector register
  for (let i = 0; i < 2; i++) m.runFrame();
  check('CoCo 3: INIT0 SCS off: the cartridge\'s $FF4A reads $00 and the write did not reach it', m.read(0xFF4A) === 0x00 && f.wd.read(2) !== 0x5A);
  m.write(0xFF90, m.gime.regs[0] | 0x04);            // SCS on
  m.write(0xFF4A, 0x5A);
  for (let i = 0; i < 2; i++) m.runFrame();
  check('CoCo 3: INIT0 SCS on: the cartridge answers at $FF40-$FF5F', m.read(0xFF4A) === 0x5A);
}
// The cartridge slot's line delays count the slot's clock (MAME coco.cpp: NMI 12, HALT 6; cococart.cpp turns them
// into time with the slot device's clocks_to_attotime; coco3.cpp: COCOCART_SLOT DERIVED_CLOCK(1, 1), XTAL / 32),
// not the machine's tick, which on a CoCo 3 is a GIME clock, and not the CPU's speed. INTRQ from a D8 force
// interrupt to the NMI line: 12 clocks at 894886 Hz = 13.41 us.
{
  const m = Emu.createMachine('coco3');
  const f = new Emu.devices.cocofdc({ rom: new Uint8Array(0x2000) });
  m.insertCartridge(f);
  m.reset(true);
  m.runFrame();
  m.write(0xFF90, m.gime.regs[0] | 0x04);
  let intrqAt = null, nmiAt = null;
  const onIntrq = f.wd.onIntrq;
  f.wd.onIntrq = (v) => { if (v && intrqAt === null) intrqAt = f.clock.now(); onIntrq(v); };
  // the slot's line timers run on the controller's clock: its now() is the timer's exact time when the line changes
  const setLine = m.setLine.bind(m);
  m.setLine = (src, l, v) => { if (l === 'nmi' && v && v !== 'clear' && nmiAt === null) nmiAt = f.clock.now(); setLine(src, l, v); };
  m.write(0xFF40, 0x20);                              // DSKREG: double density and NMI enable
  for (let i = 0; i < 2; i++) m.runFrame();
  m.write(0xFF48, 0xD8);                              // force interrupt, at once
  for (let i = 0; i < 2; i++) m.runFrame();
  const want = 12n * (10n ** 18n / 894886n);
  check(`CoCo 3: NMI follows INTRQ by 12 CPU cycles (13.41 us; got ${nmiAt !== null && intrqAt !== null ? (Number(nmiAt - intrqAt) / 1e12).toFixed(2) : '-'} us)`,
    intrqAt !== null && nmiAt !== null && nmiAt - intrqAt === want);
  // the slot's clock is derived from the driver's (coco3.cpp COCOCART_SLOT DERIVED_CLOCK(1, 1)), which the SAM's speed
  // change sets (6883sam.cpp update_cpu_clock: m_cpu->owner()->set_unscaled_clock), so it follows the CPU rate: the
  // line delays are 6 and 12 cycles of whichever rate runs (run.js coco3 --fdc cocofdc --halt compares this with MAME)
  m.write(0xFFD9, 0);                                 // 1.79 MHz
  check('CoCo 3: the slot clock follows the CPU to 1.79 MHz', Math.floor(m.slotHz) === 1789772, String(m.slotHz));
  m.write(0xFFD8, 0);                                 // 0.89 MHz
  check('CoCo 3: and back to 0.89 MHz', Math.floor(m.slotHz) === 894886, String(m.slotHz));
  check('SAM machines: the slot clock is the machine tick (CoCo 894886 Hz, Dragon 888625 Hz)',
    Math.floor(Emu.createMachine('coco').slotHz) === 894886 && Math.floor(Emu.createMachine('dragon64').slotHz) === 888625);
}

// An I/O access first brings in the events less than a cycle after its time (ioTime). The bound was written
// ioTime() + 1 - 1e-6; from 2^34 ticks on the double's step (2^-18, about 3.8e-6) is large enough that it
// rounded to ioTime() + 1 and an event a whole tick later fired early. The bound now stays below it.
for (const base of [1000, 2 ** 34 + 5, 2 ** 40 + 7]) {
  const m = Emu.createMachine('coco3');
  m.reset(true);
  m.queue.length = 0;
  m.cycle = base;
  const t = m.ioTime(), fired = [];
  m.on('probe', (arg) => fired.push(arg));
  m.schedule(t + 0.5, 'probe', 'half', 0);
  m.schedule(t + 1, 'probe', 'whole', 0);
  m.read(0xFF00);
  check(`I/O read at tick ${base}: the event half a tick after its time fired, the one a whole tick after did not (${fired})`, fired.join() === 'half');
  fired.length = 0;
  m.queue.length = 0;
  m.schedule(t + 0.5, 'probe', 'half', 0);
  m.schedule(t + 1, 'probe', 'whole', 0);
  m.write(0xFF02, 0xFF);
  check(`I/O write at tick ${base}: the same (${fired})`, fired.join() === 'half');
}

// ---- the GIME's cartridge pages ----
// A cartridge mapped in is shown through four 8K pages chosen by CPU slot (as MAME). They are built once per
// cartridge (or bank): a remap for another reason reuses them; a cartridge change (cartridgeChanged, which a banked
// cartridge also signals) builds them again.
{
  const m = Emu.createMachine('coco3');
  const cart = new Uint8Array(0x4000); for (let i = 0; i < cart.length; i++) cart[i] = (i >> 8) ^ 0x5A;
  m.insertCartridge(new Emu.RomCartridge(cart, { autostart: false }));
  m.write(0xFF90, 0x03);                         // INIT0: MMU off, 32K external (the cartridge at $8000-$FEFF)
  const page = m.gime.rd[4];                     // $8000-$9FFF
  let same = true;
  for (let a = 0x8000; a < 0xFE00; a += 0x101) if (m.read(a) !== cart[(((a >> 13) & 3) ^ 2) * 0x2000 % cart.length + (a & 0x1FFF)]) same = false;
  check('GIME: the cartridge shows through its pages', same);
  m.write(0xFF91, 0x00); m.gime.updateMemory();  // a remap that changes nothing about the cartridge
  check('GIME: a remap reuses the cartridge pages (no new 8K page)', m.gime.rd[4] === page);
  const other = new Uint8Array(0x4000).fill(0xA5);
  m.insertCartridge(new Emu.RomCartridge(other, { autostart: false }));
  check('GIME: another cartridge: new pages with its bytes', m.gime.rd[4] !== page && m.read(0x8000) === 0xA5 && m.read(0xC123) === 0xA5);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
