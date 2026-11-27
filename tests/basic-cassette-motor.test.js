// Run: node tests/basic-cassette-motor.test.js
//
// The clean-room BASIC's cassette searches and motor (basic/cassette.inc; docs/clean-room-basic.md), typed in through
// the keyboard on a Dragon 64 running our ROM (assembled at test time; no other ROM is used): CLOAD and SKIPF with no
// file on the tape search on with the motor running, and BREAK does not stop them [BB bb5 cas-errors]; MOTOR ON and
// OFF switch the deck's motor, MOTOR alone is ?SN ERROR, the cassette statements LIST as typed; MOTOR ON waits as the
// original's does [BB bb4 cas-motor-audio, bb10 time-motor], and a mutant of our source that does not wait is caught.
// The rest of the cassette tests: tests/basic-cassette.test.js.
const { buildBasic, check, tally, eq, rom, boot, line, after, listing } = require('./basic/basic-cassette-lib.js');

// ---------------- searches, BREAK, MOTOR ----------------
{
  const b = boot();
  b.type('CLOAD\n');
  b.run(100);
  check('CLOAD with no tape: the motor runs while it searches', b.m.deck.motor && !b.screen().includes('OK', 2));
  // [BB bb5 cas-errors] BREAK does not stop a search: the original searched on after BREAK with OK awaited 10 s
  const job = b.m.typist.holdPaced('BREAK');
  for (let i = 0; job.status === 'typing' && i < 300; i++) b.frame();
  b.run(500);
  check('BREAK does not stop CLOAD\'s search: still searching 10 s later, motor on, S alone on a clear screen', b.m.deck.motor && eq(b.screen(), ['S']) && b.m.ram[0x400] === 0x53, JSON.stringify(b.screen()));
}
{
  // SKIPF with no file on the tape searches as CLOAD does, motor on, and BREAK does not stop it either
  const b = boot();
  b.type('SKIPF\n');
  b.run(500);
  check('SKIPF with no file on the tape: still searching after 10 s, motor on, the screen cleared, S', b.m.deck.motor && eq(b.screen(), ['S']) && b.m.ram[0x400] === 0x53, JSON.stringify(b.screen()));
  const job = b.m.typist.holdPaced('BREAK');
  for (let i = 0; job.status === 'typing' && i < 300; i++) b.frame();
  b.run(500);
  check('BREAK does not stop SKIPF\'s search', b.m.deck.motor && eq(b.screen(), ['S']), JSON.stringify(b.screen()));
}
{
  const b = boot();
  line(b, 'MOTOR ON');
  check('MOTOR ON: the motor runs', b.m.deck.motor);
  line(b, 'MOTOR OFF');
  check('MOTOR OFF: the motor stops', !b.m.deck.motor);
  check('MOTOR without ON or OFF: ?SN ERROR', after(b, 'MOTOR').includes('?SN ERROR'));
  const st = ['10 CSAVEM "A",1,2,3', '15 CLOADM "B",4:CLOADM', '20 CSAVE "C",A:SKIPF "D"', '30 CLOAD "E":MOTOR OFF'];
  for (const l of st) line(b, l);
  check('the cassette statements LIST as typed', eq(listing(b), st), JSON.stringify(listing(b)));
}
// MOTOR ON waits, as the cassette does, for a motor that was off [BB bb4 cas-motor-audio: MOTOR ON, an empty FOR
// of 500 passes and MOTOR OFF on one line, a motor run of 54.02 fields], and again for one already running [BB bb10
// time-motor: MOTOR ON:MOTOR ON:B=TIMER:MOTOR OFF, a run of 50.72 fields, MOTOR ON:A=TIMER:MOTOR OFF 25.44]
{
  const { runCase } = require('./basic/harness.js');
  const runs = (rom, line) => { const r = runCase(rom, `#tape three-progs\n${line}\n#tape-blocks w\n`); return r.tapes[0].motor.map((x) => x.length); };
  const loop = 'MOTOR ON:FOR I=1 TO 500:NEXT:MOTOR OFF';
  const near = (rom) => { const m = runs(rom, loop); return m.length === 1 && Math.abs(m[0] - 54.02) <= 1 ? m[0] : `${m}`; };
  const got = near(rom);
  check('MOTOR ON:FOR I=1 TO 500:NEXT:MOTOR OFF: a run of 54.02 fields (within one), as on the original', typeof got === 'number', `${got}`);
  const twice = runs(rom, 'MOTOR ON:MOTOR ON:FOR I=1 TO 500:NEXT:MOTOR OFF');
  check('... a second MOTOR ON with the motor running waits again: one wait (about 25.3 fields on the original) longer', twice.length === 1 && twice[0] - got >= 25 && twice[0] - got <= 26.5, `${twice}`);
  const mrom = buildBasic({ edit: (f, t) => { if (f !== 'cassette.inc') return t; if (!t.includes('        LDX     #MOTDLY\n        BSR     CW0')) throw new Error('mutant source not found: MOTOR'); return t.replace('        LDX     #MOTDLY\n        BSR     CW0', '        LDX     #1\n        BSR     CW0'); } }).rom;
  check('mutant "MOTOR ON does not wait": the run is no longer 54.02 fields', typeof near(mrom) !== 'number', `${near(mrom)}`);
}
const total = tally();
console.log(`\n${total.n - total.fail}/${total.n} passed`);
process.exitCode = total.fail ? 1 : 0;
