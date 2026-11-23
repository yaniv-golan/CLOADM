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

// ---- with a chat on screen, the tape and the answer are the person's BASIC machine's, not the chat's ----
{
  const fs = require('fs'), path = require('path');
  const FIRMWARE = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'examples/chat.bin')));
  const s = session(true); frames(s, 2);
  check('(set-up) BASIC is at OK', s.basicRunning === true);
  s.startChat({ backend: new Emu.ClaudeBackend({ fetch: async () => { throw new Error('no network in this test'); }, apiKey: 'sk-ant-TAPE-NO-BASIC-0123456789' }), channel: new Emu.MemoryChannel(), firmware: FIRMWARE, brief: '', tools: false });
  frames(s, 2);
  check('(set-up) the chat is on screen, a different machine from the BASIC one', s.chatMachines && s.shownMachine === s.chatMachines.chat && s.personMachine === s.chatMachines.basic && s.shownMachine !== s.personMachine);
  const msg = s.insertTape('T.cas', TAPE);
  check('chat on screen, BASIC at OK: the message is the Type CLOAD one (the chat machine\'s boot state does not count)', msg === WITH_BASIC && s.basicRunning === true, msg);
  check('... and the tape is in the BASIC machine\'s deck, not the chat\'s', !!s.chatMachines.basic.deck.tape && s.chatMachines.basic.deck.tape.name === 'T.cas' && !s.chatMachines.chat.deck.tape);
}

// ---- a power cycle: no BASIC until it prints OK again ----
{
  const s = session(true); frames(s, 2);
  check('(set-up) BASIC is at OK', s.basicRunning === true);
  s.powerCycle({ menu: false });
  check('right after a power cycle BASIC is not running yet, and the tape says so', s.basicRunning === false && s.insertTape('T.cas', TAPE) === NO_BASIC, s.bootStatus().state);
  frames(s, 2);
  check('once OK shows again it is running, and the tape says Type CLOAD', s.basicRunning === true && s.insertTape('T.cas', TAPE) === WITH_BASIC, s.bootStatus().state);
}

// ---- a snapshot opened: not a power-on, so no OK is waited for; with BASIC's ROMs it is BASIC running ----
(async () => {
  // a game on screen (no OK, as in tests/snapshot-boot.test.js), saved and opened in another session, at once and 6 s on
  const { game } = build(Emu);
  const a = session(true); frames(a, 10);
  a.inject(game, 0x4022); frames(a, 5);
  const bytes = (await a.snapshotFile()).bytes;
  const open = async () => { const b = session(true); b.openSnapshot(await b.readSnapshot(bytes)); return b; };
  const b = await open();
  check('a restored moment right after opening: no OK on screen, yet BASIC counts as running (it is not a power-on)', !b.screenText().some((l) => l.trim() === 'OK') && b.basicRunning === true, b.bootStatus().state);
  check('... and the tape says Type CLOAD, not that there is no BASIC', b.insertTape('T.cas', TAPE) === WITH_BASIC);
  frames(b, Math.ceil(b.shownMachine.fps * 6));
  check('... and after the boot window: bootStatus is \'restored\' and BASIC counts as running', b.bootStatus().state === 'restored' && b.basicRunning === true, b.bootStatus().state);
  b.powerCycle({ menu: false });
  check('... a power cycle ends that: not running until OK shows again', b.basicRunning === false);
  // the stub's moment restored stays "no BASIC": a snapshot does not give it ROMs
  const c = session(false); frames(c, 2);
  const stubBytes = (await c.snapshotFile()).bytes;
  const d = session(false);
  d.openSnapshot(await d.readSnapshot(stubBytes));
  check('a restored moment on the stub is still no BASIC, and the tape says so', d.bootStatus().state === 'stub' && d.basicRunning === false && d.insertTape('T.cas', TAPE) === NO_BASIC, d.bootStatus().state);

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
