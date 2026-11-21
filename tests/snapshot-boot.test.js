// The boot watchdog through a snapshot: restoring a moment is not a power-on, so the box must never say BASIC
// failed after one. A restored machine is made fresh and then has the snapshot's state loaded, so it carries the
// snapshot's frameCount and framesSinceReset (both are in Machine.STATE) - not a power-on's 0/0. The watchdog
// elapses on framesSinceReset, so a moment taken more than 5 s into its run is already past the window the instant
// it opens: the box was decided on open, not 5 s after it. The state is what is asserted, not the timing.
//
// Every check counts EMULATED time (machine frames), never wall time.
const Emu = require('./load')();
const { build } = require('./fixtures/reset-firmware');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const K = 1024;
const frames = (m, n) => { for (let i = 0; i < n; i++) m.runFrame(); };
// 5 s of the machine's own frames, plus a few: the watchdog's `seconds * m.fps`
const past = (m) => 5 * m.fps + 5;
// a fresh Session with our BASIC stand-in in both Dragon 64 sockets (the same bytes for a writer and a reader)
const dragon64 = (roms) => {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64');
  if (roms) s.addRoms([{ name: 'd64_1.rom', bytes: roms.basic }, { name: 'd64_2.rom', bytes: roms.basic64 }]);
  return s;
};
// the same moment, opened as another browser would: read the file, take the machine it needs, restore
const reopen = async (bytes, roms) => {
  const b = dragon64(roms);
  b.openSnapshot(await b.readSnapshot(bytes));
  return b;
};

const { basic, basic64, game } = build(Emu);
const roms = { basic, basic64 };
// a program that is not BASIC and does not touch the warm-start vector: it clears the text screen and loops
const PLAIN = [{
  addr: 0x7000,
  data: Uint8Array.from([
    0x8E, 0x04, 0x00,   // LDX  #$0400
    0x86, 0x60,         // LDA  #$60
    0xA7, 0x80,         // STA  ,X+
    0x8C, 0x06, 0x00,   // CMPX #$0600
    0x26, 0xF8,         // BNE  clear
    0x20, 0xFE,         // BRA  *
  ]),
}];

(async () => {
  // ---- 1. a game that holds the warm-start vector: restored, no 'failed' after 5 s of emulated time ----
  {
    const a = dragon64(roms);
    frames(a.shownMachine, 10);
    a.inject(game, 0x4022);
    frames(a.shownMachine, 5);
    const bytes = (await a.snapshotFile()).bytes;
    const b = await reopen(bytes, roms);
    const top = b.screenText()[0].slice(0, 4);
    check('restore a game: the moment is back (the game on screen)', top === 'GGGG', top);
    frames(b.shownMachine, past(b.shownMachine));
    const st = b.bootStatus(5);
    check('restore a game: the answer is restored, never a boot failure', st.state === 'restored', JSON.stringify(st));
  }

  // ---- 2. a plain non-BASIC program that never printed OK and never armed the vector ----
  {
    const a = dragon64(roms);
    frames(a.shownMachine, 10);
    check('the program\'s session started from BASIC\'s OK', a.bootStatus().state === 'ok');
    a.inject(PLAIN, 0x7000);
    frames(a.shownMachine, 5);
    check('the program took the screen (no OK, no warm-start vector)', !a.screenText().some((l) => l.trim() === 'OK') && a.shownMachine.ram[0x71] !== 0x55);
    const bytes = (await a.snapshotFile()).bytes;
    const b = await reopen(bytes, roms);
    frames(b.shownMachine, past(b.shownMachine));
    const st = b.bootStatus(5);
    check('restore a plain program: the answer is restored, never a boot failure', st.state === 'restored', JSON.stringify(st));
  }

  // ---- 3. a snapshot taken at BASIC's prompt: no change, straight to ok ----
  {
    const a = dragon64(roms);
    frames(a.shownMachine, 10);
    check('BASIC printed OK before the snapshot', a.bootStatus().state === 'ok');
    const bytes = (await a.snapshotFile()).bytes;
    const b = await reopen(bytes, roms);
    const st = b.bootStatus(5);
    check('restore at the BASIC prompt: ok at once, and still ok after 5 s', st.state === 'ok'
      && (frames(b.shownMachine, past(b.shownMachine)), b.bootStatus(5).state === 'ok'), JSON.stringify(st));
  }

  // ---- 4. a real power-on with no OK still fails: the watchdog is for a power-on ----
  {
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine('dragon32');
    s.addRoms([{ name: 'wrong.bin', bytes: new Uint8Array(16 * K).fill(0x39) }]);
    frames(s.shownMachine, past(s.shownMachine));
    const st = s.bootStatus(5);
    check('power-on with no OK: still failed, with its cause', st.state === 'failed' && /wrong\.bin, which isn't recognised/.test(st.cause), JSON.stringify(st.state));
  }
  // ...and after a restore, a power-on arms the watchdog again: the mistake must not be fixed by never arming it
  {
    const a = dragon64(roms);
    frames(a.shownMachine, 10);
    a.inject(PLAIN, 0x7000);
    frames(a.shownMachine, 5);
    const b = await reopen((await a.snapshotFile()).bytes, roms);
    frames(b.shownMachine, past(b.shownMachine));
    b.roms.clear('dragon64');
    b.addRoms([{ name: 'wrong.bin', bytes: new Uint8Array(16 * K).fill(0x39) }]);   // ROMs changed: a power cycle
    frames(b.shownMachine, past(b.shownMachine));
    const st = b.bootStatus(5);
    check('a power-on after a restore (ROMs changed) arms the watchdog: failed', st.state === 'failed', JSON.stringify(st.state));
  }
  // the same in the frame a snapshot was taken in: a moment taken on its run's first frame, opened, then switched
  // off and on with no frame in between. Both runs have the same frame arithmetic (0), so only where the run came
  // from tells them apart: the restore stays 'restored' and the power-on is 'failed'.
  {
    const wrong = new Uint8Array(16 * K).fill(0x39);                                 // never prints OK
    const a = dragon64(roms);
    a.addRoms([{ name: 'wrong.bin', bytes: wrong }]);                               // the machine now runs it
    const bytes = (await a.snapshotFile()).bytes;                                   // frameCount 0: resetAt 0
    const b = dragon64(roms);
    b.addRoms([{ name: 'wrong.bin', bytes: wrong }]);
    b.openSnapshot(await b.readSnapshot(bytes));
    b.powerCycle();                                                                  // a power-on, still resetAt 0
    frames(b.shownMachine, past(b.shownMachine));
    const st = b.bootStatus(5);
    check('a power-on in the same frame as a restored moment is still a power-on: failed', st.state === 'failed', JSON.stringify(st.state));
  }

  // ---- 5. the same through the quick-save slots (the page's own path) ----
  {
    const a = dragon64(roms);
    frames(a.shownMachine, 10);
    a.inject(PLAIN, 0x7000);
    frames(a.shownMachine, 5);
    await a.saveSlot(1);
    const snap = await a.readSlot(1);
    const b = dragon64(roms);
    b.openSnapshot(snap);
    frames(b.shownMachine, past(b.shownMachine));
    const st = b.bootStatus(5);
    check('restore from a quick-save slot: the answer is restored, never a boot failure', st.state === 'restored', JSON.stringify(st));
    await a.clearSlot(1);
  }

  // ---- 6. the chat's view of the restored machine agrees (one implementation, two views) ----
  {
    const a = dragon64(roms);
    frames(a.shownMachine, 10);
    a.inject(PLAIN, 0x7000);
    frames(a.shownMachine, 5);
    const b = await reopen((await a.snapshotFile()).bytes, roms);
    frames(b.shownMachine, past(b.shownMachine));
    const one = b.bootStatus(5), two = b.chatTarget().bootStatus();
    check('the restored machine: bootStatus and the chat target agree on restored',
      one.state === 'restored' && two.state === 'restored', JSON.stringify({ one: one.state, two: two.state }));
  }

  // ---- 7. Claude's atPrompt reads the same state: a restored game is not BASIC's prompt, so a model is told
  // false, not null (null means "cannot be told", which would leave a model guessing). The screen is made readable
  // first: the reader declines a graphics screen, and this check is about the bootStatus branch, not the video one.
  // A guard, green on the base too (the base answered 'failed', also false): it pins that the new value does not
  // fall through as "unknown". ----
  {
    const readable = (m) => m.vdg.firstMode.fill(0x00);
    const a = dragon64(roms);
    frames(a.shownMachine, 10);
    a.inject(game, 0x4022);
    frames(a.shownMachine, 5);
    const b = await reopen((await a.snapshotFile()).bytes, roms);
    frames(b.shownMachine, past(b.shownMachine));
    readable(b.shownMachine);
    const info = Emu.runReadOnlyTool(b.chatTarget(), 'machine_info', {});
    check('a restored game on a readable screen: atPrompt is false, not null',
      info.video.readable === true && info.atPrompt === false && b.bootStatus().state === 'restored',
      JSON.stringify({ atPrompt: info.atPrompt, boot: b.bootStatus().state, readable: info.video.readable }));
    const c = dragon64(roms);
    frames(c.shownMachine, 10);
    const d = await reopen((await c.snapshotFile()).bytes, roms);
    readable(d.shownMachine);
    const info2 = Emu.runReadOnlyTool(d.chatTarget(), 'machine_info', {});
    check('a snapshot at BASIC\'s prompt: bootStatus ok, atPrompt true', d.bootStatus().state === 'ok' && info2.atPrompt === true,
      JSON.stringify({ atPrompt: info2.atPrompt, boot: d.bootStatus().state }));
  }

  // ---- 8. Claude's restore point (undoLast -> Session.restorePoint -> loadSnapshotState, which deliberately does
  // not mark `restored` itself): a point taken on a game, put back, must not answer 'failed' with the socket cause. ----
  {
    const s = dragon64(roms);
    frames(s.shownMachine, 10);
    s.powerCycle();
    frames(s.shownMachine, 300);                       // past the 5 s window, on a real power-on
    s.inject(game, 0x4022);
    frames(s.shownMachine, 10);
    const point = s.shownMachine.snapshot();           // the restore point, taken on the game
    s.powerCycle();                               // a real power-on after the point (framesSinceReset resets)
    frames(s.shownMachine, 50);
    s.restorePoint(s.shownMachine, point);
    frames(s.shownMachine, past(s.shownMachine));
    const st = s.bootStatus(5);
    check('a restore point put back on a game: restored, never a boot failure', st.state === 'restored',
      JSON.stringify({ state: st.state, cause: (st.cause || '').slice(0, 60), restored: s.shownMachine.restored }));
    // and a power-on after that undo is a power-on again, not a restored run
    s.powerCycle();
    s.roms.clear('dragon64');
    s.addRoms([{ name: 'wrong.bin', bytes: new Uint8Array(16 * K).fill(0x39) }]);
    frames(s.shownMachine, past(s.shownMachine));
    check('a power-on after a restore point is a power-on: failed', s.bootStatus(5).state === 'failed', s.bootStatus(5).state);
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
