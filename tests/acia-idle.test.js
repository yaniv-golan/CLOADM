// The Dragon 64's 6551 ACIA with nothing in the serial port: the diagnostic firmware tools/mame-diff/sam/acia-idle.asm run in Node,
// its log compared with what the hardware gives. The expected bytes are worked out from the 6551's status register (data sheet: bit 7
// IRQ, 6 DSR, 5 DCD - set when the input is not asserted -, 4 transmitter data register empty, 3 receiver full) and the idle inputs
// of MAME's dragon64, which fits no RS-232 device by default (nothing drives CTS, DSR or DCD, so all three are high): DSR and DCD
// read set, TDRE is masked by CTS and never reads 1, a byte written goes nowhere, no interrupt. MAME 0.264 reads $FF05 = $60 at the
// BASIC prompt; the lockstep with the same firmware is `node tools/mame-diff/run.js dragon64 --serial-idle`.
const spec = require('../tools/mame-diff/sam/spec.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const hex = (a) => a.map((b) => b.toString(16).padStart(2, '0')).join(' ');

function run(plug) {
  const t = spec.aciaIdle('dragon64'), m = t.machine();
  if (plug) { m.acia.attachSerial(plug); m.reset(true); }
  for (let f = 0; f < 600 && m.cpu.pc !== t.haltPc; f++) m.runFrame();
  return Object.assign({ m }, t.result(m));
}
// log layout (acia-idle.asm): 0-3 status, command, control, data after reset; 4 status a while later; 5 after the control write;
// 6 after the command write; 7 status after the transmit poll, 8-9 its passes (16 bit), 10 the data register; 11-12 status twice
// with the transmitter interrupt enabled; 13-14 status twice with the receiver interrupt enabled, 15 the command; 16 status with
// DTR off, 17 with DTR on; 18-20 status, command, control after the programmed reset
const idle = run(null);
check('nothing in the port: the firmware reaches its end', idle.done, hex(idle.log));
const DSR_DCD = 0x60, TDRE = 0x10, IRQ = 0x80;
check('status after reset (and later, and after control and command writes): DSR and DCD set, TDRE clear', [0, 4, 5, 6].every((i) => idle.log[i] === DSR_DCD), hex(idle.log));
check('a byte written to the data register never goes out: TDRE still clear after 3000 polls, the data register reads 0',
  idle.log[7] === DSR_DCD && ((idle.log[8] << 8) | idle.log[9]) === 3000 && idle.log[10] === 0, hex(idle.log));
check('the transmitter interrupt enabled raises no IRQ (TDRE is masked): bit 7 clear, twice', idle.log[11] === DSR_DCD && idle.log[12] === DSR_DCD, hex(idle.log));
check('the receiver interrupt enabled, DTR off and on: still $60, and the command reads back $01',
  idle.log[13] === DSR_DCD && idle.log[14] === DSR_DCD && idle.log[15] === 0x01 && idle.log[16] === DSR_DCD && idle.log[17] === DSR_DCD, hex(idle.log));
check('after a programmed reset: status $60, command $00, control kept ($1E)', idle.log[18] === DSR_DCD && idle.log[19] === 0x00 && idle.log[20] === 0x1E, hex(idle.log));
check('no IRQ bit in any status read', [0, 4, 5, 6, 7, 11, 12, 13, 14, 16, 17, 18].every((i) => (idle.log[i] & IRQ) === 0), hex(idle.log));
// the same firmware with a terminal plugged in (MAME's null modem asserts CTS, DSR and DCD): the lines are asserted, so TDRE comes
const term = run('terminal');
check('with a terminal plugged in the same firmware sees DSR and DCD clear and the byte go out (TDRE set)',
  term.done && term.log[0] === TDRE && (term.log[7] & TDRE) !== 0 && ((term.log[8] << 8) | term.log[9]) < 3000, hex(term.log));
// the port's line levels, as the chip reads them
const lines = (kind, opts) => { const m = spec.aciaIdle('dragon64').machine(); m.acia.attachSerial(kind, opts); return [m.acia.port.cts, m.acia.port.dsr, m.acia.port.dcd]; };
check('lines: none idles high (1,1,1); a terminal asserts them (0,0,0); a plain loopback leaves them high; one that holds them asserted drives 0',
  lines('none').join() === '1,1,1' && lines('terminal').join() === '0,0,0' && lines('loopback').join() === '1,1,1' && lines('loopback', { handshake: 'asserted' }).join() === '0,0,0',
  [lines('none'), lines('terminal'), lines('loopback'), lines('loopback', { handshake: 'asserted' })].map((x) => x.join()).join(' | '));

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
