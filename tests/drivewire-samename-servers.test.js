// DriveWire: the case rule reaches every server the Session builds, not only the Becker port's.
//
// The Session creates three DriveWire servers, each on the same media store and each given the store's case rule
// (`sameName`, Session.sameName) at construction: the Becker port's (`Session.drivewire`), the one a real CoCo is
// served from over Web Serial (`serveRealCoco`, `Session.serialLink.server`), and the chat's (`startChat(...,
// { drivewire: true })`, `Session.chatServer`). The Becker one was pinned (tests/drivewire.test.js); the other two
// were not, so deleting the sameName argument from either of them left every suite green.
//
// Each server is checked on fresh Sessions: on a case-insensitive store (where GAME.DSK and game.dsk are one file,
// as a folder on APFS or NTFS has them) with GAME.DSK in drive 0,
//   - a named-object MOUNT of game.dsk must resolve to drive 0 and add no drive (the server found the drive that
//     already holds that file), never mount a second drive on the same bytes;
//   - the drive guard must refuse a mount of game.dsk in another drive, naming drive 0;
// and on a case-sensitive store, as a control: game.dsk is a DIFFERENT file, so the named object mounts it in a
// free drive with its own bytes, and the mount in another drive is allowed. Without the control, a check that only
// ever expects "no second drive" would pass on a server that refuses every mount.
// The guard and the named object run on separate Sessions on purpose: under a broken comparison the guard's own
// mount of game.dsk in drive 9 succeeds, and a named mount on that same server would then match drive 9 exactly,
// so "added no drive" would pass green. Each check must see only its own effect.
//
// NAME MOUNT, not NAME CREATE: create replies 0 whether or not the comparison matched (the found drive, or the
// storage's own stat, which on a case-insensitive store finds the other spelling whatever the server's rule is),
// so no create case can tell the two rules apart. MOUNT's reply carries the free drive number when the comparison
// missed, which is what discriminates it. The drive guard covers the other reader of the same comparison.
//
// That claim is pinned rather than asserted here (a bare `check(name, true)` would be a summary, not an assertion):
// on one case-insensitive store, MOUNT and CREATE of the other spelling are sent to two servers with the two
// rules, and the test fails if CREATE answers anything but 0 under both, or if MOUNT does not answer 0 under the
// folding rule and a free drive under the exact one. That is the observation the choice rests on.
//
// Each leg gets its own Session and server (a named object mounts a drive, which would make a later guard call hit
// the duplicate rule instead of the case rule). The real CoCo is served over a STUB serial port (a pair of web
// streams), never Web Serial: this shows the server's rule, not a cable.
// Run: node tests/drivewire-samename-servers.test.js
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
// js/drivewire/server.js is not re-exported by js/emu.js; it is an ES module loaded through Node's require(esm),
// as tests/drivewire.test.js loads it.
const { DriveWireServer } = require('../js/drivewire/server.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const FIRMWARE = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'examples', 'chat.bin')));
const KEY = 'sk-ant-SAMENAME-SERVERS-0123456789';

// a NAME MOUNT / NAME CREATE packet's payload after the op code (DriveWire 4 specification, "Named Objects":
// length, then the name)
const nameObj = (name) => [name.length, ...[...name].map((c) => c.charCodeAt(0))];
const nameobjMount = (name) => [0x01, ...nameObj(name)];
// a server's answer to one transaction, once any store work is done
async function answer(server, bytes) {
  const before = server.output.length;
  for (const b of bytes) server.receive(b);
  while (server.busy) await server.busy;
  return server.output.splice(before);
}
// a stub Web Serial port: one port, its readable side fed by the test, what the link writes kept in `written`
function stubSerial() {
  let feed = null;
  const written = [];
  const port = {
    readable: new ReadableStream({ start(c) { feed = c; } }),
    writable: new WritableStream({ write(chunk) { written.push(...chunk); } }),
    async open() {}, async close() {},
  };
  return { serial: { async requestPort() { return port; } }, written, send: (bytes) => feed.enqueue(Uint8Array.from(bytes)) };
}
// wait (bounded) for `cond`, and report whether it held: every caller asserts the result, so a link that never
// answers fails the check instead of passing on an empty read
async function settles(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !cond()) await new Promise((r) => setTimeout(r, 5));
  return cond();
}

// A fresh Session on a store with the given case rule, GAME.DSK in store and in DriveWire drive 0, and (on a
// case-sensitive store) a different game.dsk beside it. `server` is the named server on that Session and `reached`
// is the fact that ties it to its owner -- the thing that makes the leg test THIS server and not another object:
// the Becker port's server, the serial link's, the chat's. (Without `reached`, the Becker leg's identity check
// would compare `s.drivewire` with itself and could not fail.)
// The two images' first bytes differ, so a wrong mount is visible in what a drive reads back.
async function build(which, caseInsensitive) {
  const media = new Emu.MemoryMediaStore({ caseInsensitive });
  const s = new Emu.Session({ media });
  s.switchMachine('coco', { becker: true });
  await s.importDriveWireImage('GAME.DSK', Uint8Array.from({ length: 256 }, (_, i) => i & 0xFF));
  if (!caseInsensitive) await s.importDriveWireImage('game.dsk', Uint8Array.from({ length: 256 }, (_, i) => (i + 1) & 0xFF));
  await s.mountDriveWire(0, 'GAME.DSK');
  if (which === 'becker') {
    const server = s.drivewire;
    return { s, media, server, reached: !!s.machine.becker && s.machine.becker.server === server };
  }
  if (which === 'realCoco') {
    s.serial = stubSerial().serial;
    await s.serveRealCoco(115200);
    const server = s.serialLink.server;
    // `server` IS the link's by construction; what can fail is the link being up at all (a refused or closed port)
    return { s, media, server, reached: s.realCoco !== null && s.realCoco.state === 'open' };
  }
  s.setClaudeKey(KEY);
  const backend = new Emu.ClaudeBackend({ fetch: async () => null, apiKey: s.keyStore.get() });
  s.startChat({ backend, firmware: FIRMWARE, brief: 'BRIEF', tools: false, drivewire: true });
  const server = s.chatServer;
  // a chat with no server, or one whose machine got the BASIC session's server instead of its own, fails here
  return { s, media, server, reached: !!(server && s.machine.becker && s.machine.becker.server === server) && server !== s.drivewire };
}
// let a Session go before the next one is built: the serial link stopped, and a chat closed (it would otherwise keep
// its second machine and chatServer alive; nothing advances it here, so this is tidiness, not a correctness need)
const close = async (s) => { if (s.serialLink) await s.stopRealCoco(); if (s.chat) s.endChat(); };

(async () => {
  for (const which of ['becker', 'realCoco', 'chat']) {
    // ---------------- a case-insensitive store: the server reads the store's rule ----------------
    {
      // The drive guard and the named object get a server each (the control below does the same with s2). They must
      // not share one: under a mutation that drops the server's sameName, the guard's own mount of game.dsk in
      // drive 9 SUCCEEDS, and a named mount on that same server would then match drive 9 exactly -- "added no
      // drive" would pass green while the comparison was broken. That is the defect this leg exists to catch.
      const { s, media, server, reached } = await build(which, true);
      check(`${which}: precondition, a store that folds case`, media.caseInsensitive === true && s.caseInsensitive === true);
      const tied = !!server && reached && server.drives === s.drivewire.drives && server.store === s.media;
      check(`${which}: the server under test is the one this Session reached (the port's, the link's, the chat's), on its drives and store`,
        tied, `reached=${reached}`);
      // If that failed, `server` is not the thing under test and every check below would report its own symptom of
      // the same cause: stop the leg with one clear failure instead of a cascade.
      if (tied) {
        let guard = '';
        try { await server.mount(9, 'drivewire/game.dsk'); guard = ''; } catch (e) { guard = e.message; }
        check(`${which}: mounting game.dsk in drive 9 is refused, naming drive 0`,
          /is already in DriveWire drive 0: eject it there first/.test(guard), guard || '(allowed)');
        check(`${which}: ... and drive 9 was not mounted`, !server.drives.has(9));
      }
      await close(s);

      const { s: s2, server: server2, reached: reached2 } = await build(which, true);
      // the same guard as above, so a server that is not the Session's own fails once here instead of throwing on the
      // dereference below or reporting its own symptoms as if they were the comparison's
      const tied2 = !!server2 && reached2 && server2.drives === s2.drivewire.drives && server2.store === s2.media;
      if (tied2) {
        const before = server2.drives.size;
        const reply = await answer(server2, nameobjMount('game.dsk'));
        check(`${which}: a named-object MOUNT of game.dsk resolves to drive 0, which holds GAME.DSK`,
          reply.length === 1 && reply[0] === 0, `reply=${JSON.stringify(reply)}`);
        check(`${which}: ... and it added no drive (it did not mount the same file twice)`, server2.drives.size === before, `drives ${before}->${server2.drives.size}`);
      } else {
        check(`${which}: the second Session's server is the one it reached, on its drives and store`, false, `reached=${reached2}`);
      }
      await close(s2);
    }
    // ---------------- a case-sensitive store: the control -- they are two files ----------------
    {
      const { s, media, server } = await build(which, false);
      check(`${which} control: precondition, a store that tells cases apart`, media.caseInsensitive === false && s.caseInsensitive === false);
      // the guard: a different file may mount in another drive
      let err = '';
      try { await server.mount(9, 'drivewire/game.dsk'); } catch (e) { err = e.message; }
      check(`${which} control: mounting game.dsk in drive 9 is allowed (a different file from GAME.DSK)`, err === '', err || '(allowed)');
      await close(s);
      // the named object, on another fresh server: the comparison must MISS drive 0 and mount a free drive
      const { s: s2, server: server2 } = await build(which, false);
      const before = server2.drives.size;
      const reply = await answer(server2, nameobjMount('game.dsk'));
      check(`${which} control: named-object MOUNT of the other spelling mounts it in a free drive`,
        reply.length === 1 && reply[0] !== 0 && server2.drives.has(reply[0]), `reply=${JSON.stringify(reply)}`);
      check(`${which} control: ... adding that second drive`, server2.drives.size === before + 1, `drives ${before}->${server2.drives.size}`);
      const other = await answer(server2, [0x52, reply[0], 0, 0, 0]);
      check(`${which} control: the drive it mounted holds game.dsk's bytes, not GAME.DSK's`,
        other.length === 259 && other[0] === 0 && other[3] === 1, `first byte ${other[3]}`);
      await close(s2);
    }
  }

  // ---------------- why the test uses NAME MOUNT: CREATE cannot tell the two rules apart ----------------
  {
    const media = new Emu.MemoryMediaStore({ caseInsensitive: true });
    await media.write('drivewire/GAME.DSK', Uint8Array.from({ length: 256 }, (_, i) => i & 0xFF));
    const exact = (a, b) => a === b, fold = (a, b) => a.toLowerCase() === b.toLowerCase();
    const answers = {};
    for (const [ruleName, rule] of [['exact', exact], ['folding', fold]]) {
      for (const [opName, op] of [['MOUNT', 0x01], ['CREATE', 0x02]]) {
        const server = new DriveWireServer({ store: media, namePrefix: 'drivewire/', sameName: rule });
        await server.mount(0, 'drivewire/GAME.DSK');
        answers[`${opName}/${ruleName}`] = await answer(server, [op, ...nameObj('game.dsk')]);
      }
    }
    // exactly one byte from each, so an empty reply fails rather than making a later `!== 0` true by accident
    const one = (k) => answers[k].length === 1;
    check('NAME CREATE answers 0 under BOTH rules (so it cannot discriminate; the suite uses MOUNT)',
      one('CREATE/exact') && answers['CREATE/exact'][0] === 0 && one('CREATE/folding') && answers['CREATE/folding'][0] === 0,
      JSON.stringify(answers));
    check('... while NAME MOUNT answers 0 under the folding rule and a free drive under the exact one (the discriminating reply)',
      one('MOUNT/folding') && answers['MOUNT/folding'][0] === 0
      && one('MOUNT/exact') && answers['MOUNT/exact'][0] !== 0, JSON.stringify(answers));
  }

  // ---------------- serveRealCoco over the stub cable: the same answer through the transport ----------------
  // (the direct server checks above are the rule; this one shows the reply really travels the stub cable, so a
  // defect in the link's wiring cannot hide behind the direct call)
  {
    const media = new Emu.MemoryMediaStore({ caseInsensitive: true });
    const s = new Emu.Session({ media });
    s.switchMachine('coco', { becker: true });
    await s.importDriveWireImage('GAME.DSK', Uint8Array.from({ length: 256 }, (_, i) => i & 0xFF));
    await s.mountDriveWire(0, 'GAME.DSK');
    const stub = stubSerial();
    s.serial = stub.serial;
    await s.serveRealCoco(115200);
    const pkt = nameobjMount('game.dsk');
    stub.send(pkt);
    check('realCoco cable: the NAME MOUNT packet reached the link', await settles(() => s.realCoco.bytesIn >= pkt.length),
      `bytesIn=${s.realCoco.bytesIn}`);
    check('realCoco cable: the answer on the cable is drive 0 (game.dsk is GAME.DSK here)',
      await settles(() => stub.written.length >= 1) && stub.written[0] === 0, `written=${JSON.stringify(stub.written)}`);
    await close(s);
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL', e.stack); process.exitCode = 1; });
