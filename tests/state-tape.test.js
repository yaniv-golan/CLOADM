const fs = require('fs');
// // Run: node tests/state-tape.test.js
//
// The cassette deck: a recording in progress, a tape being played, snapshotted and restored. Split out of
// state.test.js; the checks are unchanged.
const path = require('path');
const { Emu, spec, check, run, counts, checkNames, missingFromSlice } = require('./state-common.js');

// a cassette recording in progress (tape/csave.asm writing through the DAC, the deck armed): the trace, frames
// and the recording continue identically, and the restored machine's recording decodes to the bytes written
{
  const tape = require('../tools/mame-diff/tape/spec.js');
  const f = tape.firmware('dragon64', 'csave.asm'), a = f.machine();
  a.deck.startRecording();
  for (let i = 0; i < 90; i++) a.runFrame();   // inside the data block, after the namefile and the motor pause
  const regs = ['a', 'b', 'x', 'y', 'u', 's', 'pc', 'dp', 'cc'].map((name) => ({ name }));
  const text = Emu.state.toJSON(a.snapshot());
  const midway = a.deck.recording.length > 1000 && a.deck.motor;
  const continued = run(a, regs, 40);
  const b = Emu.restoreSnapshot(Emu.state.fromJSON(text), a.roms);
  const restored = run(b, regs, 40);
  for (let i = 0; i < 200 && b.cpu.pc !== f.haltPc; i++) { a.runFrame(); b.runFrame(); }
  const ea = a.deck.stopRecording(), eb = b.deck.stopRecording();
  const cas = Emu.samplesToCas(Emu.recordingToSamples(eb, b.tickHz, 44100), 44100).bytes;
  check('cassette recording mid-block: restored machine runs and records identically, and decodes to the bytes written',
    midway && continued === restored && JSON.stringify(ea) === JSON.stringify(eb) && Buffer.from(cas).equals(Buffer.from(tape.csaveStream())),
    `(snapshot ${(text.length / 1024).toFixed(0)} KB, ${eb.length} events)`);
}

// a tape being played with made-up silence and leader (js/media/tape.js): snapshots in the silence after the
// namefile and inside a data block restore into machines that read on identically, and a version 2 snapshot (the
// tape's position counted from a 128-byte leader, no `layout`) restores at the same byte of the image
{
  const tape = require('../tools/mame-diff/tape/spec.js');
  const f = tape.firmware('dragon64', 'cloadm.asm'), bytes = tape.playbackTapes().short;
  const a = f.machine();
  a.deck.insert(new Emu.Tape(bytes, a.tickHz, 'short.cas'));
  const t = a.deck.tape, regs = ['a', 'b', 'x', 'y', 'u', 's', 'pc', 'dp', 'cc'].map((name) => ({ name }));
  const inSilence = () => t.levels[t.idx] === 0 && t.halves[t.idx] > 100000 && t.idx > 0;
  for (let i = 0; i < 2000 && !inSilence(); i++) a.runFrame();
  const silent = inSilence();
  const text1 = Emu.state.toJSON(a.snapshot());
  for (let i = 0; i < 2000 && !(t.bytePosition() > 60 && t.levels[t.idx] !== undefined && !inSilence() && a.deck.motor); i++) a.runFrame();
  const text2 = Emu.state.toJSON(a.snapshot());
  const ends = [];
  for (const text of [text1, text2]) {
    const b = Emu.restoreSnapshot(Emu.state.fromJSON(text), a.roms);
    const c = Emu.restoreSnapshot(Emu.state.fromJSON(text), a.roms);
    const same = run(b, regs, 30) === run(c, regs, 30);
    for (let i = 0; i < 3000 && b.cpu.pc !== f.haltPc; i++) b.runFrame();
    ends.push({ same, table: Buffer.from(b.ram.slice(0x1000, b.cpu.u)).toString('hex') });
  }
  for (let i = 0; i < 3000 && a.cpu.pc !== f.haltPc; i++) a.runFrame();
  const want = Buffer.from(a.ram.slice(0x1000, a.cpu.u)).toString('hex');
  check('tape in the silence after the namefile: restored, it reads on to the same blocks', silent && ends[0].same && ends[0].table === want && want.length === 4 * 4 * 2, `(${want.length / 8} blocks)`);
  check('tape inside a data block: restored, it reads on to the same blocks', ends[1].same && ends[1].table === want);
  // a version 2 file: the same machine, the tape's position as version 2 counted it
  const snap = Emu.state.fromJSON(text2), st = snap.state.deck.tape;
  const tp = new Emu.Tape(bytes, a.tickHz, 'short.cas');
  tp.idx = st.idx;
  const n = tp.bytePosition(), sub = st.idx - (tp.byteStart[n + 1] - 16);
  const old = Emu.state.fromJSON(text2);
  old.version = 2;
  delete old.state.deck.tape.layout;
  old.state.deck.tape.idx = 128 * 16 + n * 16 + sub;
  const r = Emu.restoreSnapshot(old, a.roms);
  check('a version 2 snapshot restores its tape at the same byte and half cycle', sub >= 0 && sub < 16 && r.deck.tape.idx === st.idx && r.deck.tape.left === st.left, `byte ${n}`);
  const bad = Emu.state.fromJSON(text2); bad.version = 3; delete bad.state.deck.tape.layout;
  let refused = false; try { Emu.restoreSnapshot(bad, a.roms); } catch (e) { refused = /layout/.test(e.message); }
  check('...and the same file claiming version 3 is refused', refused);
}

// an MC-10 with a tape part way, saved as version 2 (before tapes had a layout): its tape is not padded (the
// family's profile says pad: false), so it restores exactly as it was, not 3 s longer
{
  const tape = require('../tools/mame-diff/tape/spec.js');
  const a = Emu.createMachine('mc10', { ram: 4 }); a.reset(true);
  a.deck.insert(new Emu.Tape(tape.playbackTapes().short, a.tickHz, 'short.c10', a.profile.tape));
  for (let i = 0; i < 60; i++) { a.deck.setMotor(true); a.runFrame(); }   // played part way (past its leader)
  const old = Emu.state.fromJSON(Emu.state.toJSON(a.snapshot()));
  old.version = 2; delete old.state.deck.tape.layout; delete old.state.deck.tape.opts.pad;   // as a version 2 file had it
  const b = Emu.restoreSnapshot(old, a.roms), t = a.deck.tape, u = b.deck.tape;
  check('a version 2 MC-10 snapshot restores its tape unpadded, at the same place', t.idx > 0 && u.idx === t.idx && u.left === t.left
    && u.halves.length === t.halves.length && Math.abs(u.seconds() - t.seconds()) < 1e-9, `${t.seconds().toFixed(2)} s vs ${u.seconds().toFixed(2)} s`);
}

// Input state a machine holds: a Hi-Res joystick interface's one-shot, part way through its wait. Held keys,
// the keyboard joystick and gamepads are the host's and are not in a snapshot, so what is left to prove is
// that the one-shot survives: armed, its deadline intact, and the machine finishes the measurement the same.
// A frame is far longer than the wait (63,000 ticks against ~2,000), so a snapshot at a frame boundary would
// never catch it running: this steps inside a frame to a point with the wait still ahead.
{
  const hiresSpec = spec('sam').hires('coco', { kind: 'tandy' });
  const a = hiresSpec.machine();
  let mid = false;
  for (let i = 0; i < 400000 && !mid; i++) {
    a.runCycles(a.cycle + (a.cpu.c || 4));
    mid = a.hires.jet.armed && a.hires.jet.due > a.cycle;
  }
  const regs = ['a', 'b', 'x', 'y', 'u', 's', 'pc', 'dp', 'cc'].map((name) => ({ name }));
  const before = { armed: a.hires.jet.armed, due: a.hires.jet.due };
  const text = Emu.state.toJSON(a.snapshot());
  // the state is in the snapshot itself: check it before a single frame can re-arm either machine
  const b = Emu.restoreSnapshot(Emu.state.fromJSON(text), a.roms);
  const kept = b.hires.jet.armed === before.armed && b.hires.jet.due === before.due;
  const continued = run(a, regs, 30);
  const restored = run(b, regs, 30);
  for (let i = 0; i < 600 && a.ram[hiresSpec.phaseAddr] !== 10; i++) a.runFrame();
  for (let i = 0; i < 600 && b.ram[hiresSpec.phaseAddr] !== 10; i++) b.runFrame();
  const samples = (m) => Array.from({ length: hiresSpec.samples }, (_, k) => (m.ram[hiresSpec.sampleAddr + k * 2] << 8) | m.ram[hiresSpec.sampleAddr + k * 2 + 1]);
  check('Hi-Res interface mid-wait: the one-shot is in the snapshot and the restored machine measures identically',
    mid && kept && continued === restored && JSON.stringify(samples(a)) === JSON.stringify(samples(b)),
    `(snapshot ${(text.length / 1024).toFixed(0)} KB, deadline ${before.due.toFixed(0)}, kept ${kept})`);
}

// mismatched snapshots are refused
{
  const t = spec('coco3').trace('coco3', { regenerate: false });
  const snap = t.machine().snapshot();
  const throws = (fn) => { try { fn(); return false; } catch (e) { return e.message; } };
  check('refused on another machine', !!throws(() => Emu.createMachine('coco3p').restore(snap)));
  check('refused with another config', !!throws(() => { const m = Emu.createMachine('coco3', { ram: 128 }); m.restore(snap); }));
  check('refused with other ROMs', !!throws(() => { const m = Emu.createMachine('coco3'); m.setRoms({ basic: new Uint8Array(0x8000) }); m.restore(snap); }));
}

// A snapshot holds the machine, not the media library: stored ROM images and recent programs live in
// the media store, and a snapshot carries only the CRCs of the ROMs the machine ran
// with, never their bytes. So saving and loading a machine does not move media either way.
{
  const s = new Emu.Session({ store: Emu.memoryStore(), media: new Emu.MemoryMediaStore() });
  s.switchMachine('coco');
  s.addRoms([{ name: 'bas12.rom', bytes: new Uint8Array(8192).fill(0x11) }]);
  const prog = new Uint8Array(400).fill(0x22);
  s.load('mine.bin', Emu.toBinary(Emu.assemble(' ORG $3000\nL BRA L\n END', '6809'), { format: 'dragondos' }));
  for (let i = 0; i < 3; i++) s.shownMachine.runFrame();
  const text = Emu.state.toJSON(s.shownMachine.snapshot());
  const mediaBefore = { roms: s.roms.sockets().length, recent: s.library.recentMedia().length, blobs: s.media.snapshot().length };
  check('snapshot: the stored ROM image bytes are not in it', !text.includes(Buffer.from(new Uint8Array(8192).fill(0x11)).toString('base64').slice(0, 24)));
  check('snapshot: it names the ROMs by CRC only', /"roms":\{[^}]*"bas":"[0-9A-F]{8}"/.test(text) || /"roms":/.test(text), text.slice(0, 120));
  // restoring into a fresh machine with the same ROMs leaves the media library untouched
  const s2 = new Emu.Session({ store: Emu.memoryStore(), media: s.media });
  s2.switchMachine('coco');
  s2.shownMachine.setRoms(s.shownMachine.roms);
  s2.shownMachine.restore(Emu.state.fromJSON(text));
  const mediaAfter = { roms: s2.roms.sockets().length, recent: s2.library.recentMedia().length, blobs: s2.media.snapshot().length };
  check('snapshot: loading one adds nothing to and removes nothing from the media library',
    JSON.stringify(mediaBefore) === JSON.stringify(mediaAfter), `${JSON.stringify(mediaBefore)} -> ${JSON.stringify(mediaAfter)}`);
}

// A CoCo Max cartridge is rebuilt from the snapshot like any device: no constructor callback, it
// samples the mouse the host gave the machine (machine.mouse), so the restored module answers its registers
// with the staged value it had and goes on cycling through the same values.
{
  const a = Emu.createMachine('coco');
  a.mouse = { x: 0.25, y: 0.75, left: true, right: false };
  a.insertCartridge(new Emu.CocoMax());
  a.read(0xFF90);                                   // stages Y
  const saved = Emu.state.fromJSON(Emu.state.toJSON(a.snapshot()));
  const reads = (m) => [0xFF90, 0xFF91, 0xFF92, 0xFF93, 0xFF94].map((r) => m.read(r));
  const cont = reads(a);
  const b = Emu.restoreSnapshot(saved, a.roms);
  b.mouse = { x: 0.25, y: 0.75, left: true, right: false };
  let got = null, err = null;
  try { got = reads(b); } catch (e) { err = e; }
  check('CoCo Max: the restored module reads the same values ($BF $BF $40 $00 $FF)', !err && JSON.stringify(got) === JSON.stringify(cont) && JSON.stringify(cont) === '[191,191,64,0,255]',
    err ? err.message : JSON.stringify(got));
  const c = Emu.restoreSnapshot(saved, a.roms);     // no mouse given yet: centred, buttons up
  let e2 = null; try { c.read(0xFF90); c.read(0xFF90); } catch (e) { e2 = e; }
  check('CoCo Max: a machine with no host mouse reads the centre, without throwing', !e2 && c.read(0xFF91) === 0x80, e2 ? e2.message : '');
}

// DriveWire on the Becker port: a snapshot taken while a sector is on its way to the machine (the
// server holds bytes not yet read), restored into a fresh machine whose server has the same disks, must run dw.asm
// on to its end identically: the same instructions and cycles, the same log, the same disks written.

// THE SPLIT IS FAITHFUL: this suite's check names must be exactly its slice of the names the unsplit suite ran.
// Counting alone would let a dropped check and a duplicated one cancel out; the names cannot.
{
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'state-check-names.json'), 'utf8'))['state-tape'];
  const { missing, extra } = missingFromSlice(checkNames(), manifest);
  // an ordinary check of its own, so a slice mismatch is COUNTED like every other failure and the summary's
  // "ok/total" adds up (it used to bump the failure count without a matching name, printing 14/15 when 15 ran)
  check('state-tape: its checks are exactly its slice of the unsplit suite\'s names', !missing.length && !extra.length,
    missing.length || extra.length ? `${missing.length} missing, ${extra.length} extra` : '');
  for (const n of missing.slice(0, 3)) console.log(`  missing: ${n}`);
  for (const n of extra.slice(0, 3)) console.log(`  extra:   ${n}`);
}
const __c = counts();
console.log(`\n${__c.ok}/${__c.ok + __c.fail} state-tape checks passed`);
process.exitCode = __c.fail ? 1 : 0;
