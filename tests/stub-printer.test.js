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

console.log(`\n${n - fail}/${n} stub printer checks passed`);
process.exitCode = fail ? 1 : 0;
