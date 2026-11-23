// Run: node tests/tape-no-basic.test.js
//
// A tape put in the deck with no BASIC running says so, instead of telling the person to type CLOAD into nothing.
// "No BASIC" is the stub machine (no ROMs in use) or BASIC that has not printed OK yet; "BASIC running" is bootStatus's
// 'ok' (Session.basicRunning). The tape goes in either way; only the message differs, and the way to load it is
// Session.skipTape (the page's [Load it now] on the toast).
const Emu = require('./load')();
const { build } = require('./fixtures/reset-firmware');
const { basic, basic64 } = build(Emu);

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const frames = (s, n) => { for (let i = 0; i < n; i++) s.shownMachine.runFrame(); };

// a machine-code tape (type 2) of our own: 128 bytes of leader, a header block naming the file, a data block, the end block
const block = (type, data) => { let s = (type + data.length) & 255; for (const d of data) s = (s + d) & 255; return [0x3C, type, data.length, ...data, s, 0x55]; };
const nf = [...Buffer.from('HI      '), 2, 0, 0, 0x03, 0x00, 0x03, 0x00];
const TAPE = Uint8Array.from([...new Array(128).fill(0x55), ...block(0, nf), ...new Array(128).fill(0x55), ...block(1, [0x20, 0xFE]), ...block(0xFF, [])]);
const NO_BASIC = "T.cas is in the deck. There's no BASIC to type CLOAD into.";
const WITH_BASIC = 'Tape T.cas inserted. Type CLOAD or CLOADM.';

const session = (roms) => {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  if (roms) s.addRoms([{ name: 'd64_1.rom', bytes: basic }, { name: 'd64_2.rom', bytes: basic64 }]);
  return s;
};

{
  const s = session(false); frames(s, 10);
  check('the stub machine: no BASIC is running', s.basicRunning === false && s.bootStatus().state === 'stub');
  check('... and the tape says there is no BASIC to type CLOAD into', s.insertTape('T.cas', TAPE) === NO_BASIC, s.insertTape('T.cas', TAPE));
  check('... the tape is in the deck all the same', !!s.shownMachine.deck.tape && s.shownMachine.deck.tape.name === 'T.cas');
  const msg = s.skipTape();
  frames(s, 3);
  check('... and skipTape loads it and starts it: "started at $0300", the program in memory and running there', /^T\.cas loaded \(\$0300.\$0301\) and started at \$0300\.$/.test(msg) && s.shownMachine.read(0x300) === 0x20 && s.shownMachine.cpu.pc === 0x300, `${msg} pc=${s.shownMachine.cpu.pc.toString(16)}`);
}
{
  const s = session(true);   // (the stand-in prints OK in its first frame: none has run yet)
  check('ROMs in use but no OK seen yet: no BASIC is running', s.basicRunning === false && s.bootStatus().state === 'booting', s.bootStatus().state);
  check('... and the tape says so', s.insertTape('T.cas', TAPE) === NO_BASIC);
  frames(s, 2);
  check('BASIC prints OK: it is running', s.basicRunning === true && s.bootStatus().state === 'ok');
  check('... and the tape says what it always said: type CLOAD or CLOADM', s.insertTape('T.cas', TAPE) === WITH_BASIC, s.insertTape('T.cas', TAPE));
  frames(s, 10);
  check('... also when OK has scrolled away (the latch keeps it)', s.basicRunning === true);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
