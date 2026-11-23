// Run: node tests/stub-printer.test.js
//
// The no-ROM stub must not print. On a CoCo, PIA1 PA1 is the RS-232 out to the 600-baud serial printer, and the stub
// used to make it an output while its output register held 0: the line dropped to space, the printer took the drop
// for a start bit and every machine the stub started (power-on, injectAndRun) printed one NUL, so a program's printout
// began with $00. MAME 0.264 prints the same NUL from that order (tools/mame-diff/sam/printer-stubinit.asm, run.js
// coco --printer --stub-init: that firmware sets PIA1 up as the stub now does, and MAME and ours print nothing before
// the first byte sent). Here, on the printed bytes:
//  * every CoCo-lineage model (the stub of js/machines/sam.js and of coco3.js) prints nothing at power-on, nor when a
//    program is started on it with injectAndRun;
//  * a program of our own that prints "OK" through the bit-banger, as BASIC's printer routine does (start bit, eight
//    data bits least significant first, stop bit, 600 baud), started on the stub, prints exactly "OK";
//  * the Dragons, whose port A is the parallel printer's, print what they printed before: the one byte every reset
//    prints (MAME's too: tools/mame-diff/sam/spec.js printer, atReset), and nothing from the stub.
//  * the MC-10 and the Alice: their stub wrote port 2's DDR before its data register, so P20 (the serial printer's
//    line) dropped to space and they printed a $FF at power-on and at every injectAndRun (MAME printed nothing:
//    tools/mame-diff/mc10/printer-stubinit.asm, run.js mc10 --printer --stub-init). They print nothing at power-on,
//    and a program of our own (6803) that prints "OK" on P20 at 600 baud prints exactly "OK".
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const frames = (m, k) => { for (let i = 0; i < k; i++) m.runFrame(); };

// "OK" through the bit-banger at 600 baud (the routine of tools/mame-diff/sam/printer-serial.asm, in RAM at $3000);
// $3100 = $FF once done
const PRINT_OK = `
        ORG     $3000
START   ORCC    #$50
        LDA     #'O
        BSR     SEND
        LDA     #'K
        BSR     SEND
        LDA     #$FF
        STA     $3100
DONE    BRA     DONE
SEND    PSHS    A,B,X,Y
        CLRB
        BSR     BITT
        LDA     ,S
        LDY     #8
DATA    CLRB
        LSRA
        BCC     ZERO
        LDB     #$02
ZERO    BSR     BITT
        LEAY    -1,Y
        BNE     DATA
        LDB     #$02
        BSR     BITT
        PULS    A,B,X,Y,PC
BITT    STB     $FF20
        LDX     #182
WAIT    LEAX    -1,X
        BNE     WAIT
        RTS
`;

const cocos = Object.keys(Emu.profiles).filter((id) => Emu.profiles[id].lineage === 'coco' && !Emu.profiles[id].hidden);
const dragons = Object.keys(Emu.profiles).filter((id) => Emu.profiles[id].lineage === 'dragon' && !Emu.profiles[id].hidden);
check('there are CoCo-lineage models to check', cocos.includes('coco') && cocos.includes('coco3'), cocos.join());

const prog = Emu.assemble(PRINT_OK, '6809');
check('the printing program assembles', prog.ok && prog.segments.length > 0, JSON.stringify(prog.errors));
const segments = prog.segments;
for (const id of cocos) {
  const m = Emu.createMachine(id, {});
  m.reset(true);
  frames(m, 60);
  check(`${id}: the stub prints nothing at power-on`, m.printed.length === 0, JSON.stringify(Array.from(m.printed)));
  const p = Emu.createMachine(id, {});
  p.reset(true);
  p.injectAndRun(segments, 0x3000);
  frames(p, 60);
  const done = p.read(0x3100) === 0xFF;
  check(`${id}: a program started on the stub prints exactly "OK", nothing before it`,
    done && Array.from(p.printed).join() === '79,75', `done ${done}, printed ${JSON.stringify(Array.from(p.printed))}`);
}
for (const id of dragons) {
  const m = Emu.createMachine(id, {});
  m.reset(true);
  frames(m, 60);
  check(`${id}: the Dragon stub prints only the byte a reset prints`, Array.from(m.printed).join() === '255', JSON.stringify(Array.from(m.printed)));
}

// "OK" on the MC-10's P20 at 600 baud (the SEND/BITT routine of tools/mame-diff/mc10/printer.asm, in RAM at $5000);
// $5100 = $FF once done
const PRINT_OK_6803 = `
        ORG     $5000
START   SEI
        LDAA    #'O
        BSR     SEND
        LDAA    #'K
        BSR     SEND
        LDAA    #$FF
        STAA    $5100
DONE    BRA     DONE
SEND    STAA    $5102
        CLRB
        BSR     BITT
        LDAB    #8
        STAB    $5103
DATA    CLRB
        LSR     $5102
        BCC     ZERO
        LDAB    #$01
ZERO    BSR     BITT
        DEC     $5103
        BNE     DATA
        LDAB    #$01
        BSR     BITT
        RTS
BITT    STAB    $03
        LDX     #243
WAIT    DEX
        BNE     WAIT
        RTS
`;
const prog6803 = Emu.assemble(PRINT_OK_6803, '6803');
check('the 6803 printing program assembles', prog6803.ok && prog6803.segments.length > 0, JSON.stringify(prog6803.errors));
for (const id of ['mc10', 'alice']) {
  const m = Emu.createMachine(id, {});
  m.reset(true);
  frames(m, 60);
  check(`${id}: the stub prints nothing at power-on`, m.printed.length === 0, JSON.stringify(Array.from(m.printed)));
  const p = Emu.createMachine(id, {});
  p.reset(true);
  p.injectAndRun(prog6803.segments, 0x5000);
  frames(p, 60);
  const done = p.read(0x5100) === 0xFF;
  check(`${id}: a program started on the stub prints exactly "OK", nothing before it`,
    done && Array.from(p.printed).join() === '79,75', `done ${done}, printed ${JSON.stringify(Array.from(p.printed))}`);
}

// ---- the 6803's output compare drives P21 and counts as a write to port 2 ----
// MAME 0.264 m6801.cpp (the output compare's handler, which sets OLVL on the P21 pin): the compare drives port 2 and
// sets m_port2_written, so a printer line that has had its DDR set but no data register write starts being driven
// once the compare fires. js/cpu/cpu6803.js timerSync does the same (p2Written), and port 2 is then written with
// P21 at OLVL.
{
  const compare = (ddr2, olvl) => {
    const writes = [];
    const cpu = new Emu.CPU6803({ read: () => 0xFF, write: () => {}, portWrite: (n, v, d) => writes.push([n, v, d]) });
    cpu.regWrite(0x01, ddr2);        // port 2's DDR first: nothing is driven yet (no data register write)
    const before = writes.length, flagBefore = cpu.p2Written;
    cpu.regWrite(0x08, olvl);        // TCSR: OLVL
    cpu.regWrite(0x0B, 0x00); cpu.regWrite(0x0C, 0x10);   // OCR = $0010
    cpu.timerSync(0x2000);           // the counter has passed the compare
    return { before, flagBefore, flag: cpu.p2Written, ocf: !!(cpu.tcsr & 0x40), writes: writes.slice(before) };
  };
  const hi = compare(0x02, 1), lo = compare(0x02, 0), inp = compare(0x01, 1);
  check('6803: a DDR write alone drives nothing and sets no p2Written (the premise)', hi.before === 0 && !hi.flagBefore);
  check('6803: the output compare with P21 an output sets p2Written, as MAME\'s m6801 does', hi.flag && hi.ocf, JSON.stringify(hi));
  check('6803: ... and drives port 2 with P21 at OLVL = 1', hi.writes.length === 1 && hi.writes[0][0] === 2 && (hi.writes[0][1] & 0x02) === 0x02, JSON.stringify(hi.writes));
  check('6803: ... and with P21 at OLVL = 0 (the line is still driven, low)', lo.flag && lo.writes.length === 1 && (lo.writes[0][1] & 0x02) === 0, JSON.stringify(lo.writes));
  check('6803: the compare with P21 an input (only P20 an output) drives nothing and sets no p2Written', inp.ocf && !inp.flag && inp.writes.length === 0, JSON.stringify(inp));
}

// ---- glitches on the printer line, against what MAME 0.264 recorded ----
// The glitch firmware (tools/mame-diff/{mc10,sam}/printer-glitch.asm, run.js <profile> --printer --glitch) drops the
// line for a few cycles once it idles at mark, then prints every byte value and its text; on the MC-10 and the Alice
// it first sets port 2 up DDR first. MAME's printer files from it, recorded: one $FF (its receiver takes any drop for
// a start bit and samples mark after it), then the print; and nothing from the DDR-first order (MAME's m6801 drives
// port 2 only once its data register has been written: js/cpu/cpu6803.js resetPeripherals).
const MAME_RECORDED = {
  mc10: { bytes: 307, text: 'CLOADM PRINTER TEST, MC-10 SERIAL PORT, 600 BAUD\r\n' },
  alice: { bytes: 307, text: 'CLOADM PRINTER TEST, MC-10 SERIAL PORT, 600 BAUD\r\n' },
  coco: { bytes: 306, text: 'CLOADM PRINTER TEST, COCO SERIAL PORT, 600 BAUD\r\n' },
};
for (const [id, rec] of Object.entries(MAME_RECORDED)) {
  const spec = require(`../tools/mame-diff/${id === 'coco' ? 'sam' : 'mc10'}/spec.js`);
  const t = spec.printer(id, { glitch: true });
  const m = t.machine();
  // the rule lib/printer.js runs both emulators by: until the done flag, then 30 more frames
  let after = -1;
  for (let f = 0; f < 60 * 60 && after !== 0; f++) {
    m.runFrame();
    if (after < 0 && m.read(t.doneAddr) === 0xFF) after = 30;
    else if (after > 0) after--;
  }
  const want = [0xFF, ...Array(256).keys(), ...Buffer.from(rec.text, 'latin1')];
  const got = Array.from(m.printed);
  check(`${id}: the glitch firmware prints the ${rec.bytes} bytes MAME recorded: the glitch's $FF, then every byte value and the text`,
    want.length === rec.bytes && got.length === want.length && got.every((v, i) => v === want[i]),
    `${got.length} bytes, first ${JSON.stringify(got.slice(0, 3))}`);
}

console.log(`\n${n - fail}/${n} stub printer checks passed`);
process.exitCode = fail ? 1 : 0;
