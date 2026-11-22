// Run: node tests/restore-points.test.js
//
// Ask Claude's restore points (one per turn, before the turn's first acting tool call), browser-free, no network,
// no ROMs: the "ROMs" here are our own idle firmware, and the disk test runs the FDC writer firmware of
// tools/mame-diff/fdc (as tests/disks.test.js does). The oracle is the snapshot itself (AGENTS.md 4.5): the
// machine's whole state as JSON just before the turn's first action against the state after the restore.
//
// What is proved:
//  * every tool in ACTING_TOOL_NAMES (load_basic included) takes the turn's point through the one shared path,
//    ChatSession.withRestorePoint: with that path stubbed out none of them changes the machine at all, and with it
//    each calls it exactly once; a tool with no entry in the input table below fails the test, so a new acting
//    tool can't go untested;
//  * for every acting tool on a 6809 (Dragon 64), a 6803 (MC-10) and a CoCo 3: the point is the state just before
//    the action, and Session.restoreClaude() brings the machine back to exactly that state;
//  * a restore that can't happen (the ROMs changed since the point: Forget ROMs, Run without ROMs) throws a
//    SessionError with a clear message, keeps every point and leaves the machine and Claude as they were; once
//    the ROMs are back the same point restores; a restore that fails part way through loading is rolled back;
//  * after a restore the mounted disks still write to the media store, also from the 11th turn on (when each new
//    point pushes the oldest out): the stored image is first put back to the image the drive holds (writes made
//    during the undone turn are not left mixed in), and firmware writing a sector after the restore reaches it;
//  * a restore relinks a disk to the Library only when the same continuous mount is still in the same drive (each
//    mount has its own link): ejected and replaced in the Library and mounted again, another stored image under the
//    same name, the disk moved to another drive - the store is left untouched, the drive comes back unlinked and the
//    restore says so (also through the chat's undoLast, the same path); in the full-screen view the Library's
//    guards see the BASIC session's drives;
//  * the store is written only when the machine wrote the disk since the point (a spy on the store), never for a
//    write-protected disk or a file the store refuses to write (unlinked, with a notice), and a store write that
//    fails part way through a restore is reported and leaves that drive unlinked, with nothing more written to it.
const path = require('path');
const Emu = require('./load')();
const { assembleFile, romImage } = require('../tools/mame-diff/lib/firmware');
const images = require('../tools/mame-diff/fdc/images');
const fs = require('fs');
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');
const { MediaStoreError } = require('../js/host/media-store.js');

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };
// a backend per chat: startAsk binds the backend's runTool to its own chat
const dead = () => new Emu.ClaudeBackend({ fetch: async () => { throw new Error('no network in this test'); }, apiKey: 'sk-ant-RESTORE-TEST-KEY-0123456789' });
const call = (chat, name, input = {}) => Promise.resolve(chat.backend.runTool(name, input)).then((out) => ({ ok: true, out }), (err) => ({ ok: false, err }));
// the same, with the machine running until the call settles (type_text waits for the machine to read its keys)
const callFrames = async (s, chat, name, input = {}, max = 4000) => {
  let done = false; const p = call(chat, name, input).then((r) => { done = true; return r; });
  for (let i = 0; i < max && !done; i++) { frames(s, 1); await new Promise((r) => setImmediate(r)); }
  return done ? p : { ok: false, err: { code: 'TEST-TIMEOUT', message: 'the call did not settle' } };
};
const json = (m) => Emu.state.toJSON(m.snapshot());
const throwsMsg = (f) => { try { f(); return null; } catch (e) { return e; } };
// restoreClaude's result for a restore that happened: { notices }
const restored = (r, notices = []) => !!r && Array.isArray(r.notices) && JSON.stringify(r.notices) === JSON.stringify(notices);
const CHANGED = (drive) => `Drive ${drive} was changed since this point; the restored disk isn't saved to the Library. Download it to keep it.`;

// A session whose BASIC socket holds our own idle firmware, with BASIC's program pointers describing an empty
// program and OK on the screen, so load_basic can act (the layout of tests/basic-load.test.js); acting allowed,
// load_basic's own card answered yes. With scan: true the firmware reads the keyboard without end (every column
// driven low, the rows read), as a program waiting for a key does, so a paced key (press_break) is consumed.
const SLOT = { dragon64: 0x4000, coco3: 0x8000, mc10: 0x2000 };
const LAYOUT = { dragon64: { start: 0x1E01, fretop: 0x7E00, p: 0x19 }, coco3: { start: 0x2601, fretop: 0x7E00, p: 0x19 }, mc10: { start: 0x4346, fretop: 0x4E00, p: 0x93 } };
function basicSession(id, { scan = false } = {}) {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine(id);
  const m = s.shownMachine, six = id === 'mc10' ? '6803' : '6809';
  const coco3 = id === 'coco3' ? ' LDX #$FFA0\n LDA #$38\nMMU STA ,X+\n INCA\n CMPX #$FFA8\n BNE MMU\n LDA #$CE\n STA $FF90\n LDD #$E000\n STD $FF9D\n' : '';
  const idle6809 = scan ? ' CLR $FF03\n LDA #$FF\n STA $FF02\n LDA #$04\n STA $FF03\n CLR $FF02\n CLR $FF01\n CLR $FF00\n LDA #$04\n STA $FF01\nIDLE LDA $FF00\n BRA IDLE\n' : 'IDLE BRA IDLE\n';
  const idle6803 = scan ? ' LDAA #$FF\n STAA $00\n CLRA\n STAA $02\nIDLE LDAA $BFFF\n BRA IDLE\n' : 'IDLE BRA IDLE\n';
  const asm = Emu.assemble(six === '6803' ? ` ORG $E000\nSTART EQU *\n${idle6803}`
    : ` ORG $8000\nSTART\n${coco3} STA $FFC9\n CLR $FF23\n LDA #$F8\n STA $FF22\n LDA #$04\n STA $FF23\n CLR $FF22\n${idle6809}`, six);
  if (!asm.ok) throw new Error(JSON.stringify(asm.errors));
  const rom = new Uint8Array(SLOT[id]).fill(0xFF); rom.set(asm.segments[0].data, 0);
  m.setRoms({ basic: rom }); m.reset(true); m.cpu.jump(asm.exec);
  if (six === '6803') m.cpu.ramc = (m.cpu.ramc || 0) | 0x40;
  const L = LAYOUT[id], w = (a, v) => s.pokeBytes(a, [v >> 8, v & 0xFF], m);
  s.pokeBytes(L.start - 1, [0, 0, 0], m);
  w(L.p, L.start); w(L.p + 2, L.start + 2); w(L.p + 4, L.start + 2); w(L.p + 6, L.start + 2); w(L.p + 8, L.fretop);
  const screen = m.profile.textScreen || 0x400;
  for (let i = 0; i < 512; i++) m.ram[screen + i] = 0x60;
  m.ram[screen + 64] = 0x0F; m.ram[screen + 65] = 0x0B;   // "OK" on the third row
  frames(s, 3);
  s.setClaudeAllowed(true);
  s.claudeGate = () => { Promise.resolve().then(() => s.answerClaude(true)); };
  return s;
}
// a session on the stub firmware (it reads the keyboard, so type_text completes); acting allowed
function stubSession(id) {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine(id); frames(s, 40);
  s.setClaudeAllowed(true);
  return s;
}
// One valid call per acting tool, and the session it runs on. A tool missing here fails the coverage check.
const ACT = {
  poke: { on: stubSession, input: (id) => ({ address: id === 'mc10' ? 0x4200 : 0x3000, bytes: [1, 2] }) },
  type_text: { on: stubSession, input: () => ({ text: 'AB' }), frames: true },
  // (BREAK is a matrix key: the stub reads none, so press_break acts on firmware that scans the keyboard)
  press_break: { on: (id) => basicSession(id, { scan: true }), input: () => ({}), frames: true },
  assemble_and_load: { on: stubSession, input: () => ({ source: ' FCB 7\n', org: 0x4100 }) },
  run: { on: stubSession, input: () => ({ target: 0x4100 }) },
  load_basic: { on: basicSession, input: () => ({ program: '10 PRINT "HI"\n20 GOTO 10\n' }) },
};

(async () => {
  // ---- 1. one shared path for every acting tool ----
  check('every acting tool has a case in this test (a new acting tool must be added here)',
    Emu.ACTING_TOOL_NAMES.length > 0 && Emu.ACTING_TOOL_NAMES.every((name) => ACT[name]), Emu.ACTING_TOOL_NAMES.filter((name) => !ACT[name]).join(' '));
  for (const name of Emu.ACTING_TOOL_NAMES) {
    if (!ACT[name]) continue;
    // the shared path stubbed out (it never runs the change): the tool must change nothing, so it has no other way to act
    {
      // a twin session left alone is the control: the emulation is deterministic, so after the same frames the two
      // are identical unless the call changed something (typing and BREAK act over the frames after the call)
      const s = ACT[name].on('dragon64'); const chat = s.startAsk({ backend: dead() }); const m = s.shownMachine;
      const twin = ACT[name].on('dragon64'); twin.startAsk({ backend: dead() });
      check(`${name}: the twin starts identical`, json(m) === json(twin.shownMachine));
      chat.withRestorePoint = () => ({ stubbed: true });
      let r = null; call(chat, name, ACT[name].input('dragon64')).then((x) => { r = x; });
      for (let i = 0; i < 60; i++) { frames(s, 1); frames(twin, 1); await new Promise((res) => setImmediate(res)); }
      r = r || { ok: false, err: { code: 'did not settle' } };
      check(`${name}: with the restore-point path stubbed out the call changes nothing (it acts only through withRestorePoint)`,
        r.ok && r.out && r.out.stubbed === true && json(m) === json(twin.shownMachine) && chat.undo.length === 0, r.ok ? JSON.stringify(r.out) : r.err.code);
    }
    // and with it in place, the path runs exactly once per call
    {
      const s = ACT[name].on('dragon64'); const chat = s.startAsk({ backend: dead() });
      let calls = 0; const real = typeof chat.withRestorePoint === 'function' ? chat.withRestorePoint.bind(chat) : null;
      if (real) chat.withRestorePoint = (act) => { calls++; return real(act); };
      const r = ACT[name].frames ? await callFrames(s, chat, name, ACT[name].input('dragon64')) : await call(chat, name, ACT[name].input('dragon64'));
      check(`${name}: withRestorePoint runs once and leaves one point`, r.ok && calls === 1 && chat.undo.length === 1, `${calls} calls, ${chat.undo.length} points ${r.ok ? '' : r.err.code}`);
    }
  }

  // ---- 2. the point is the state just before the action; restoreClaude returns to it, on three CPUs/models ----
  for (const id of ['dragon64', 'mc10', 'coco3']) {
    for (const name of Emu.ACTING_TOOL_NAMES) {
      if (!ACT[name]) continue;
      const s = ACT[name].on(id); const chat = s.startAsk({ backend: dead() }); const m = s.shownMachine;
      const was = json(m);
      const r = ACT[name].frames ? await callFrames(s, chat, name, ACT[name].input(id)) : await call(chat, name, ACT[name].input(id));
      frames(s, 5);
      const changed = json(m) !== was;
      const pt = s.claudePoints;
      check(`${id}: ${name}: one point holding the machine as it was just before the action, timestamped`,
        r.ok && chat.undo.length === 1 && Emu.state.toJSON(chat.undo[0]) === was && pt.length === 1 && typeof pt[0].at === 'number',
        `${r.ok ? '' : r.err.code} ${chat.undo.length} ${chat.undo.length && Emu.state.toJSON(chat.undo[0]) === was} ${JSON.stringify(pt)}`);
      check(`${id}: ${name}: restoreClaude() puts the whole machine back to that state and drops the point`,
        changed && restored(s.restoreClaude()) && json(m) === was && s.claudePoints.length === 0);
    }
  }

  // ---- 3. a restore that can't happen keeps everything ----
  {
    const romFor = () => { const a = Emu.assemble(' ORG $8000\nS BRA S\n', '6809'); const r = new Uint8Array(0x4000).fill(0xFF); r.set(a.segments[0].data, 0); return r; };
    for (const op of ['clearRoms', 'runWithoutRoms']) {
      const s = new Emu.Session({ store: Emu.memoryStore() }); s.switchMachine('dragon64');
      s.roms.put('dragon64', 'basic', romFor(), 'idle.rom'); s.loadSavedRoms(); s.powerCycle(); frames(s, 10);
      s.setClaudeAllowed(true);
      const chat = s.startAsk({ backend: dead() }); const m = s.shownMachine;
      await call(chat, 'poke', { address: 0x3000, bytes: [0x11] });
      chat.snapped = false;    // a second turn: a second point
      await call(chat, 'poke', { address: 0x3001, bytes: [0x22] });
      s[op]();
      frames(s, 5);
      const points = JSON.stringify(s.claudePoints), undo = chat.undo.slice(), acting = s.claudeActing, was = json(m);
      let aborted = false; chat.abort = () => { aborted = true; };
      const e = throwsMsg(() => s.restoreClaude());
      check(`${op}: restoring a point taken with other ROMs throws a SessionError saying why and that nothing changed`,
        e instanceof Emu.SessionError && /different basic ROM/.test(e.message) && /^Can't restore that point \(snapshot was taken with a different basic ROM\): nothing was changed, and your restore points are kept\.$/.test(e.message), e ? e.message : 'no error');
      check(`${op}: every point is kept, in place`, JSON.stringify(s.claudePoints) === points && chat.undo.length === 2 && chat.undo.every((p, i) => p === undo[i]));
      check(`${op}: the machine is exactly as it was, and Claude was not stopped`, json(m) === was && !aborted && s.claudeActing === acting);
      const e0 = throwsMsg(() => s.restoreClaude(0));
      check(`${op}: the older point is refused the same way`, e0 instanceof Emu.SessionError && chat.undo.length === 2 && json(m) === was);
      // "Restore to before Claude's changes" (the chat's undoLast) is the same guarded path: a restore that throws keeps the point
      const eu = throwsMsg(() => chat.undoLast());
      check(`${op}: undoLast with a refused point throws the same SessionError and keeps every point`,
        eu instanceof Emu.SessionError && /different basic ROM/.test(eu.message) && chat.undo.length === 2 && chat.undo.every((p, i) => p === undo[i]) && json(m) === was && JSON.stringify(s.claudePoints) === points,
        eu ? `${eu.message} (${chat.undo.length} points)` : 'no error');
      delete chat.abort;
      // the ROMs back as they were: the same point now restores
      s.roms.put('dragon64', 'basic', romFor(), 'idle.rom'); s.stubChosen.delete('dragon64'); s.loadSavedRoms();
      check(`${op}: with the ROMs back, the kept point restores (0x3000 back to 0, the newer point dropped)`,
        restored(s.restoreClaude(0)) && m.ram[0x3000] === 0 && chat.undo.length === 0);
    }
    // a restore that passes the checks but fails while loading is rolled back: the machine as it was, points kept
    {
      const s = stubSession('coco3'); const chat = s.startAsk({ backend: dead() }); const m = s.shownMachine;
      await call(chat, 'poke', { address: 0x3000, bytes: [0x33] });
      frames(s, 3);
      const good = chat.undo[0];
      chat.undo[0] = Object.assign({}, good, { state: Object.assign({}, good.state, { cpu: null }) });
      const was = json(m);
      const e = throwsMsg(() => s.restoreClaude());
      check('a point that fails part way through loading: SessionError, the machine rolled back exactly, the point kept',
        e instanceof Emu.SessionError && json(m) === was && chat.undo.length === 1, e ? e.message : 'no error');
      chat.undo[0] = good;
      check('and the machine still runs and restores normally afterwards', (frames(s, 2), true) && s.restoreClaude() && m.ram[0x3000] !== 0x33);
    }
  }

  // ---- 4. after a restore the mounted disks still write to the media store ----
  {
    const FDC = path.join(__dirname, '../tools/mame-diff/fdc');
    require(path.join(FDC, 'gen-diag')).write();
    const boot = romImage(assembleFile(path.join(FDC, 'boot.asm'), '6809'), 0x8000, 0x4000, 0x12);
    const wa = assembleFile(path.join(FDC, 'dragon-write.asm'), '6809');
    const halt = wa.symbols.get('HALT');
    const pattern = (first) => Array.from({ length: 256 }, (_, i) => (first + 3 * i) & 0xff);
    const sectorOffset = (header, heads) => header + ((1 * heads + 0) * 18 + 2) * 256;   // sector 3 of track 1, side 0
    const expectImage = (bytes, header, heads, data) => { const e = bytes.slice(); e.set(data, sectorOffset(header, heads)); return e; };
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    {
      const view = 'Dragon 64, DragonDOS';
      const media = new MemoryMediaStore();
      const s = new Emu.Session({ media });
      s.switchMachine('dragon64');
      for (const sl of Emu.profiles.dragon64.roms) s.roms.put('dragon64', sl.id, boot.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size), 'boot.rom');
      s.loadSavedRoms();
      s.roms.put('dragondos', 'rom', romImage(wa, 0xC000, 0x2000, 0x00), 'firmware.rom');
      const d0 = images.vdk(40, 2), d1 = images.vdk(40, 1);
      await s.importDisk('work.vdk', d0, 0);
      await s.importDisk('other.vdk', d1, 1);
      s.setClaudeAllowed(true);
      const chat = s.startAsk({ backend: dead() });
      const m = s.chatTarget().machine;
      // eleven turns (more than the 10 points kept, so the newest point is one that pushed an older one out), each
      // a poke, all before the firmware has written anything
      for (let i = 0; i < 11; i++) { chat.snapped = false; await call(chat, 'poke', { address: 0x7F00, bytes: [i] }); }
      check(`${view}: eleven turns keep the last 10 points, the newest timestamped`, chat.undo.length === 10 && typeof s.claudePoints[0].at === 'number');
      // during the last turn the firmware writes sector 3 of track 1 on drives 0 and 1, and the writes reach the store
      let f = 0; while (m.cpu.pc !== halt && f < 600) { m.runFrame(); f++; }
      await s.diskWritesDone();
      const w0 = expectImage(d0, 12, 2, pattern(0x11)), w1 = expectImage(d1, 12, 1, pattern(0x22));
      check(`${view}: the turn's writes reached the store`, m.cpu.pc === halt && same(await media.read('disks/work.vdk'), w0) && same(await media.read('disks/other.vdk'), w1));
      // restore the newest point (before those writes): first a point whose disk was ejected and replaced in the
      // Library since: drive 1's disk comes back in the drive, but unlinked, and the stored file is left alone
      await s.ejectDisk(1);
      const other = images.vdk(40, 1).fill(0xA5, 12);
      await media.write('disks/other.vdk', other);
      check(`${view}: a restore after drive 1 was ejected and its file replaced: drive 1 is back but unlinked (with the notice), its stored file untouched`,
        restored(s.restoreClaude(), [CHANGED(1)]) && m.ram[0x7F00] === 9 && (await s.diskWritesDone(), same(await media.read('disks/other.vdk'), other))
        && s.diskStatus().drives.some((d) => d.drive === 1 && !d.stored) && s.diskStatus().drives.some((d) => d.drive === 0 && d.stored));
      // then a turn with both disks mounted from the store throughout: drive 1 back to its blank image, a new point,
      // the firmware's writes during the turn
      await s.ejectDisk(1); await media.write('disks/other.vdk', d1); await s.mountDisk(1, 'other.vdk');
      chat.snapped = false; await call(chat, 'poke', { address: 0x7F00, bytes: [9] });
      f = 0; while (m.cpu.pc !== halt && f < 600) { m.runFrame(); f++; }
      await s.diskWritesDone();
      check(`${view}: restoreClaude() works`, restored(s.restoreClaude()) && m.ram[0x7F00] === 9 && m.cpu.pc !== halt);
      check(`${view}: after the restore both drives are still linked to the store`, s.diskStatus().drives.length === 2 && s.diskStatus().drives.every((d) => d.stored), JSON.stringify(s.diskStatus().drives));
      await s.diskWritesDone();
      check(`${view}: the stored images are the images the drives hold again (the undone writes are not left mixed in)`,
        same(await media.read('disks/work.vdk'), d0) && same(await media.read('disks/other.vdk'), d1));
      // now the firmware writes again: the writes after the restore must reach the stored images
      f = 0; while (m.cpu.pc !== halt && f < 600) { m.runFrame(); f++; }
      check(`${view}: the writer firmware reaches HALT after the restore`, m.cpu.pc === halt);
      await s.diskWritesDone();
      check(`${view}: drive 0's write after the restore reached the store`, same(await media.read('disks/work.vdk'), w0));
      check(`${view}: drive 1's write after the restore reached the store`, same(await media.read('disks/other.vdk'), w1));
    }
  }


  // ---- 5. the disk rollback is safe: only the same continuous mount, only when written, never a protected file ----
  {
    const FDC = path.join(__dirname, '../tools/mame-diff/fdc');
    const boot = romImage(assembleFile(path.join(FDC, 'boot.asm'), '6809'), 0x8000, 0x4000, 0x12);
    const wa = assembleFile(path.join(FDC, 'dragon-write.asm'), '6809');
    const halt = wa.symbols.get('HALT');
    const pattern = (first) => Array.from({ length: 256 }, (_, i) => (first + 3 * i) & 0xff);
    const at = (header, heads) => header + ((1 * heads + 0) * 18 + 2) * 256;
    const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
    const CHAT_FW = new Uint8Array(fs.readFileSync(path.join(__dirname, '../examples/chat.bin')));
    // A Dragon 64 with DragonDOS (our writer firmware) and two stored disks, work.vdk in drive 0 and other.vdk in
    // drive 1; the store counts every write (whole or in place) per name, and can be told to refuse some.
    const rig = async () => {
      const media = new MemoryMediaStore();
      const writes = [], refuse = { range: new Set(), whole: new Set(), code: 'unsupported' };
      const w = media.write.bind(media), wr = media.writeRange.bind(media);
      media.write = async (name, bytes) => { writes.push(name); if (refuse.whole.has(name)) throw new MediaStoreError(refuse.code, `${name}: refused`); return w(name, bytes); };
      media.writeRange = async (name, o, bytes) => { writes.push(name); if (refuse.range.has(name)) throw new MediaStoreError(refuse.code, `${name}: permission was refused`); return wr(name, o, bytes); };
      const s = new Emu.Session({ media });
      s.switchMachine('dragon64');
      for (const sl of Emu.profiles.dragon64.roms) s.roms.put('dragon64', sl.id, boot.slice(sl.at - 0x8000, sl.at - 0x8000 + sl.size), 'boot.rom');
      s.loadSavedRoms();
      s.roms.put('dragondos', 'rom', romImage(wa, 0xC000, 0x2000, 0x00), 'firmware.rom');
      const d0 = images.vdk(40, 2), d1 = images.vdk(40, 1);
      await s.importDisk('work.vdk', d0, 0);
      await s.importDisk('other.vdk', d1, 1);
      s.setClaudeAllowed(true);
      const chat = s.startAsk({ backend: dead() });
      const m = s.chatTarget().machine;
      let k = 0;
      const r = {
        s, chat, m, media, writes, refuse, d0, d1,
        w0: (() => { const e = d0.slice(); e.set(pattern(0x11), at(12, 2)); return e; })(),
        w1: (() => { const e = d1.slice(); e.set(pattern(0x22), at(12, 1)); return e; })(),
        // a new turn's restore point (a poke)
        point: async () => { chat.snapped = false; await call(chat, 'poke', { address: 0x7F00, bytes: [++k] }); },
        // the firmware writes sector 3 of track 1 on drives 0 and 1 -> reached HALT; the store's error, if any
        write: async () => { let f = 0; while (m.cpu.pc !== halt && f < 600) { m.runFrame(); f++; } r.err = await s.diskWritesDone().then(() => null, (e) => e); return m.cpu.pc === halt; },
        stored: (drive) => { const d = s.diskStatus().drives.find((x) => x.drive === drive); return d ? d.stored : null; },
        // the drives as the BASIC session has them (in full screen this.machine is the chat machine)
        basicStored: (drive) => { const d = s.diskControllerOf(m).drives[drive]; return d.loaded ? !!d.media.onWrite : null; },
        read: (name) => media.read(`disks/${name}`),
      };
      return r;
    };
    const writesAfter = (r, from, name) => r.writes.slice(from).filter((x) => x === `disks/${name}`).length;

    // the repro: eject work.vdk, replace it in the Library, mount it again, restore
    {
      const r = await rig(), { s } = r;
      await r.point();
      check('repro: the writer firmware ran during the turn (drive 0 written since the point)', await r.write() && same(await r.read('work.vdk'), r.w0));
      await s.ejectDisk(0);
      const lib = images.vdk(40, 2).fill(0x5A, 12);
      await s.importMedia('work.vdk', lib);
      await s.mountDisk(0, 'work.vdk');
      const from = r.writes.length;
      const res = s.restoreClaude();
      await s.diskWritesDone();
      check('repro: eject, replace in the Library, mount again, restore: the stored file is left as the Library has it, with the notice',
        restored(res, [CHANGED(0)]) && same(await r.read('work.vdk'), lib) && writesAfter(r, from, 'work.vdk') === 0, res && JSON.stringify(res.notices));
      check('repro: drive 0 comes back unlinked, holding the point\'s image', r.stored(0) === false && same(s.diskControllerOf(r.m).drives[0].media.bytes, r.d0));
      // the drive no longer writes to the store
      const from2 = r.writes.length;
      await r.write();
      check('repro: the firmware writing again after the restore does not touch the stored file', writesAfter(r, from2, 'work.vdk') === 0 && same(await r.read('work.vdk'), lib));
    }
    // another stored image under the same name
    {
      const r = await rig(), { s } = r;
      await r.point(); await r.write();
      await s.ejectDisk(0);
      await s.deleteMedia('disks/work.vdk');
      const fresh = images.vdk(40, 2).fill(0x3C, 12);
      await s.importDisk('work.vdk', fresh, 0);
      const from = r.writes.length;
      const res = s.restoreClaude();
      await s.diskWritesDone();
      check('same name, another stored image (deleted, a new work.vdk imported into drive 0): store untouched, unlinked, notice',
        restored(res, [CHANGED(0)]) && same(await r.read('work.vdk'), fresh) && writesAfter(r, from, 'work.vdk') === 0 && r.stored(0) === false);
    }
    // the same disk, now in another drive
    {
      const r = await rig(), { s } = r;
      await r.point(); await r.write();
      await s.ejectDisk(0); await s.ejectDisk(1);
      await s.mountDisk(1, 'work.vdk');
      const from = r.writes.length;
      const res = s.restoreClaude();
      await s.diskWritesDone();
      check('the disk moved to another drive (work.vdk now in drive 1): neither drive relinked, both files untouched, a notice per drive',
        restored(res, [CHANGED(0), CHANGED(1)]) && same(await r.read('work.vdk'), r.w0) && same(await r.read('other.vdk'), r.w1)
        && r.writes.length === from && r.stored(0) === false && r.stored(1) === false, res && JSON.stringify(res.notices));
    }
    // the full-screen view: the Library sees the BASIC session's drives while the chat machine is on screen
    {
      const r = await rig(), { s } = r;
      s.startChat({ backend: dead(), channel: new Emu.MemoryChannel(), firmware: CHAT_FW });
      check('full screen: the chat machine is on screen, the BASIC session keeps its drives', s.shownMachine !== r.m && s.chatTarget().machine === r.m && r.basicStored(0) === true);
      await r.point(); await r.write();
      const lib = images.vdk(40, 2).fill(0x5A, 12);
      const imp = await s.importMedia('work.vdk', lib).then(() => null, (e) => e);
      const ren = await s.renameMedia('disks/work.vdk', 'gone.vdk').then(() => null, (e) => e);
      const del = await s.deleteMedia('disks/work.vdk').then(() => null, (e) => e);
      const mov = await s.moveMedia(new MemoryMediaStore()).then(() => null, (e) => e);
      check('full screen: replacing, renaming, deleting a disk in the BASIC session\'s drive, or moving the library, is refused, naming the BASIC session',
        [imp, ren, del, mov].every((e) => e instanceof Emu.SessionError && /drive 0 of your BASIC session/.test(e.message)) && same(await r.read('work.vdk'), r.w0),
        [imp, ren, del, mov].map((e) => (e ? e.message : 'accepted')).join(' | '));
      // the page hides (pagehide/visibilitychange flush the disks): the BASIC session's drives are flushed too
      for (let i = 0; i < 5; i++) r.m.runFrame();
      const fdc = s.diskControllerOf(r.m);
      fdc.drives[0].imageDirty = true;   // as if a write were still in the drive (the firmware's motor may have stopped)
      let flushed = false; const realFlush = fdc.flush.bind(fdc); fdc.flush = () => { flushed = true; realFlush(); };
      s.flushDisks();
      delete fdc.flush;
      check('full screen: flushDisks flushes the BASIC session\'s drives while the chat machine is on screen', flushed);
      const res = s.restoreClaude();
      await s.diskWritesDone();
      check('full screen: the restore puts the same continuous mounts back (stores = the restored images, both linked)',
        restored(res) && same(await r.read('work.vdk'), r.d0) && same(await r.read('other.vdk'), r.d1) && r.basicStored(0) && r.basicStored(1));
    }
    // the same continuous mount, written since the point -> the store equals the restored image
    {
      const r = await rig(), { s } = r;
      await r.point(); await r.write();
      const res = s.restoreClaude();
      await s.diskWritesDone();
      const fdc = s.diskControllerOf(r.m);
      check('same continuous mount, written since the point: the stored images equal the restored drives\' images, byte for byte, still linked',
        restored(res) && same(await r.read('work.vdk'), fdc.drives[0].media.bytes) && same(await r.read('other.vdk'), fdc.drives[1].media.bytes)
        && same(await r.read('work.vdk'), r.d0) && r.stored(0) && r.stored(1));
    }
    // the same continuous mount, not written since the point -> no store write at all
    {
      const r = await rig(), { s } = r;
      await r.write(); s.flushDisks(); await s.diskWritesDone();
      await r.point();
      for (let i = 0; i < 5; i++) r.m.runFrame();
      const from = r.writes.length;
      const res = s.restoreClaude();
      await s.diskWritesDone();
      check('same continuous mount, not written since the point: the restore writes nothing to the store, and the disks stay linked',
        restored(res) && r.writes.length === from && r.stored(0) && r.stored(1) && same(await r.read('work.vdk'), r.w0), `${r.writes.length - from} writes`);
    }
    // a write-protected disk
    {
      const r = await rig(), { s } = r;
      await r.point(); await r.write();
      s.setDiskWriteProtect(0, true);
      const from = r.writes.length;
      const res = s.restoreClaude();
      await s.diskWritesDone();
      check('a disk written since the point and then write-protected: not written, comes back unlinked, with the notice',
        restored(res, ["Drive 0 is write-protected; the restored disk isn't saved to the Library. Download it to keep it."])
        && writesAfter(r, from, 'work.vdk') === 0 && same(await r.read('work.vdk'), r.w0) && r.stored(0) === false && r.stored(1) === true
        && s.diskStatus().drives.find((d) => d.drive === 0).writeProtected === true,
        res && JSON.stringify(res.notices));
    }
    // write-protected after the point, nothing written: the restore keeps the person's protection (it isn't machine state)
    {
      const r = await rig(), { s } = r;
      await r.point();
      s.setDiskWriteProtect(0, true);
      const from = r.writes.length;
      const res = s.restoreClaude();
      await s.diskWritesDone();
      const st = s.diskStatus().drives.find((d) => d.drive === 0);
      check('write-protected after the point, not written: the restore keeps it write-protected and linked, and writes nothing',
        restored(res) && r.writes.length === from && st.writeProtected === true && st.stored === true && s.diskControllerOf(r.m).drives[0].wpt === 1);
      await r.write();
      check('and the firmware can\'t write to it afterwards: the stored file is untouched', writesAfter(r, from, 'work.vdk') === 0 && same(await r.read('work.vdk'), r.d0));
    }
    // a write refused before the point (the store may lack it): the restore puts the whole image back
    {
      const r = await rig(), { s } = r;
      r.refuse.range.add('disks/work.vdk'); r.refuse.code = 'quota';
      await r.write();
      r.refuse.range.clear();
      s.flushDisks();
      await r.point();
      const from = r.writes.length;
      const res = s.restoreClaude();
      const e = await s.diskWritesDone().then(() => null, (x) => x);
      check('a write the store refused before the point: the restore writes the whole image the drive holds, and it is linked',
        restored(res) && e === null && writesAfter(r, from, 'work.vdk') === 1 && same(await r.read('work.vdk'), s.diskControllerOf(r.m).drives[0].media.bytes)
        && same(await r.read('work.vdk'), r.w0) && r.stored(0) === true);
    }
    // a stored file the store refuses to write (a read-only file in a folder)
    {
      const r = await rig(), { s } = r;
      r.refuse.range.add('disks/work.vdk'); r.refuse.whole.add('disks/work.vdk');
      await r.point(); await r.write();
      check('read-only file: the machine\'s write was refused and reported', r.err instanceof Emu.SessionError && /permission was refused/.test(r.err.message));
      const from = r.writes.length;
      const res = s.restoreClaude();
      const e = await s.diskWritesDone().then(() => null, (x) => x);
      check('read-only file: the restore does not try to write it; it comes back unlinked, with the notice, and no new error',
        restored(res, ["Drive 0 is a read-only file; the restored disk isn't saved to the Library. Download it to keep it."])
        && writesAfter(r, from, 'work.vdk') === 0 && e === null && r.stored(0) === false && r.stored(1) === true, res && JSON.stringify(res.notices));
    }
    // a store write that fails part way through a restore (drive 0's put back, drive 1's refused)
    {
      const r = await rig(), { s } = r;
      await r.point(); await r.write();
      r.refuse.whole.add('disks/other.vdk'); r.refuse.code = 'io';
      const res = s.restoreClaude();
      const e = await s.diskWritesDone().then(() => null, (x) => x);
      check('a put-back that fails part way: reported, saying the restored disk isn\'t saved to the Library',
        restored(res) && e instanceof Emu.SessionError && /^Drive 1: the Library's other\.vdk couldn't be put back to the restored disk \(.*refused\); the restored disk isn't saved to the Library\. Download it to keep it\.$/.test(e.message), e && e.message);
      check('a put-back that fails part way: drive 0 is put back and linked; drive 1 is unlinked, its file as it was before the restore',
        same(await r.read('work.vdk'), r.d0) && r.stored(0) === true && r.stored(1) === false && same(await r.read('other.vdk'), r.w1)
        && s.diskStatus().drives.every((d) => !d.unsaved));
      const from = r.writes.length;
      await r.write();
      check('a put-back that fails part way: afterwards drive 0\'s writes reach the store and nothing more is written to other.vdk',
        same(await r.read('work.vdk'), r.w0) && writesAfter(r, from, 'other.vdk') === 0 && same(await r.read('other.vdk'), r.w1));
    }
    // a disk mounted again in the drive it is in, with writes still in the drive: the drive and the store agree after
    {
      const r = await rig(), { s, m } = r;
      for (let f = 0; f < 15; f++) m.runFrame();   // the firmware has written, the motor still runs: not yet in the store
      await s.mountDisk(0, 'work.vdk');
      await s.diskWritesDone();
      const d = s.diskControllerOf(m).drives[0];
      check('mounting a disk again in its own drive reads it after the drive\'s writes reached the store (drive == store)', same(await r.read('work.vdk'), d.media.bytes));
    }
    // a restore while a disk is being mounted again in its drive: the drive ends up with the image the store has
    {
      const r = await rig(), { s, m } = r;
      await r.point(); await r.write();
      const p = s.mountDisk(0, 'work.vdk').then(() => null, (e) => e);
      const res = s.restoreClaude();          // runs while the mount waits for the store
      const e = await p; await s.diskWritesDone();
      const d = s.diskControllerOf(m).drives[0];
      check('a restore during a mount of the same disk again: the mount reads after the put-back, so drive and store hold the same image',
        restored(res) && e === null && r.stored(0) === true && same(await r.read('work.vdk'), d.media.bytes) && same(d.media.bytes, r.d0), e && e.message);
    }
    // two mounts of the same image into two drives at once: one is refused
    {
      const r = await rig(), { s } = r;
      await s.importMedia('x.vdk', images.vdk(40, 1));
      const [a, b] = await Promise.all([s.mountDisk(2, 'x.vdk'), s.mountDisk(3, 'x.vdk')].map((q) => q.then(() => null, (e) => e)));
      const held = s.diskStatus().drives.filter((d) => d.name === 'disks/x.vdk');
      check('two mounts of one image into two drives at once: exactly one goes in, the other is refused saying where it is',
        held.length === 1 && [a, b].filter((x) => x instanceof Emu.SessionError && /x\.vdk is already in drive [23]\./.test(x.message)).length === 1 && [a, b].filter((x) => x === null).length === 1,
        [a, b].map((x) => (x ? x.message : 'ok')).join(' | '));
    }
    // a write the drive hands to the store while the image is being read: the mount reads again
    {
      const r = await rig(), { s, m } = r;
      const realRange = r.media.readRange.bind(r.media);
      let once = true;
      r.media.readRange = async (name, o, len) => {
        const out = await realRange(name, o, len);
        if (once && name === 'disks/work.vdk') { once = false; const d = s.diskControllerOf(m).drives[0]; d.media.onWrite(4096, new Uint8Array(16).fill(0x55), d.media.bytes.length); d.media.bytes.fill(0x55, 4096, 4112); }
        return out;
      };
      await s.mountDisk(0, 'work.vdk');
      await s.diskWritesDone();
      const d = s.diskControllerOf(m).drives[0];
      check('a write reaching the store while the mount reads the image: the mount reads it again (drive == store, the write in both)',
        same(await r.read('work.vdk'), d.media.bytes) && d.media.bytes[4096] === 0x55);
    }
    // a slow store (OPFS latency): a write queued while the mount waits is waited for too
    {
      const r = await rig(), { s, m, media } = r;
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      const wr = media.writeRange.bind(media), w = media.write.bind(media);
      media.writeRange = async (...a) => { await sleep(30); return wr(...a); };
      media.write = async (...a) => { await sleep(30); return w(...a); };
      const fdc = s.diskControllerOf(m), d0 = fdc.drives[0], d1 = fdc.drives[1];
      d1.media.onWrite(0x100, new Uint8Array([1, 2, 3]), d1.media.bytes.length);   // a write in flight on drive 1
      const p = s.mountDisk(0, 'work.vdk');
      await sleep(5);
      const data = new Uint8Array(256).fill(0xA5);
      d0.media.bytes.set(data, 0x1000); d0.media.onWrite(0x1000, data, d0.media.bytes.length);   // drive 0 commits a sector meanwhile
      await p; await s.diskWritesDone();
      const now = fdc.drives[0].media.bytes;
      check('slow store: a sector drive 0 hands over while its disk is mounted again is in both the store and the new mount',
        (await r.read('work.vdk'))[0x1000] === 0xA5 && now[0x1000] === 0xA5 && same(await r.read('work.vdk'), now));
    }
    // a slow store: an import racing a mount of the same name
    {
      const r = await rig(), { s, media } = r;
      await s.ejectDisk(0); await s.ejectDisk(1);
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      const w = media.write.bind(media);
      media.write = async (...a) => { await sleep(30); return w(...a); };
      const fresh = images.vdk(40, 2); fresh.fill(0x77, 0x2000, 0x2100);
      const [ei, em] = await Promise.all([s.importDisk('work.vdk', fresh, 0), s.mountDisk(2, 'work.vdk')].map((q) => q.then(() => null, (e) => e)));
      await s.diskWritesDone();
      const stored = await r.read('work.vdk'), fdc = s.diskControllerOf(r.m);
      const holders = fdc.drives.filter((d) => d.loaded && d.media.name === 'disks/work.vdk');
      check('slow store: an import and a mount of the same name at once: one drive holds it, the same image as the store, and the import message says whether it replaced it',
        holders.length === 1 && same(holders[0].media.bytes, stored) && (ei === null || /^work\.vdk was saved to your Library but not put in drive 0: /.test(ei.message) ? same(stored, fresh) : same(stored, r.d0)),
        `${ei ? ei.message : 'import ok'} | ${em ? em.message : 'mount ok'}`);
    }
    // a slow store: the Library renames disks while a mount reads one
    {
      const r = await rig(), { s, media } = r;
      await s.ejectDisk(0); await s.ejectDisk(1);
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      const rr = media.readRange.bind(media);
      media.readRange = async (...a) => { const out = await rr(...a); await sleep(30); return out; };
      const pm = s.mountDisk(0, 'work.vdk').then(() => null, (e) => e);
      await sleep(10);
      const r1 = await s.renameMedia('disks/work.vdk', 'moved.vdk').then(() => null, (e) => e);
      const r2 = await s.renameMedia('disks/other.vdk', 'work.vdk').then(() => null, (e) => e);
      const em = await pm;
      const d = s.diskControllerOf(r.m).drives[0];
      const stored = await media.read('disks/work.vdk').catch(() => null);
      check('slow store: renames in the Library while a mount reads: the drive holds the image now stored under its name (or the mount is refused)',
        em ? !d.loaded : same(d.media.bytes, stored) && same(stored, r.d1), `${em ? em.message : 'mounted'} ${r1 ? r1.message : ''} ${r2 ? r2.message : ''}`);
    }
    // diskWritesDone ends while the drives keep queueing writes (it waits for the ones queued when it was called)
    {
      const r = await rig(), { s, m, media } = r;
      const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
      const wr = media.writeRange.bind(media);
      media.writeRange = async (...a) => { await sleep(5); return wr(...a); };
      const d1 = s.diskControllerOf(m).drives[1];
      let go = true;
      (async () => { while (go) { d1.media.onWrite(0x100, new Uint8Array([7]), d1.media.bytes.length); await sleep(2); } })();
      await sleep(5);
      const done = await Promise.race([s.diskWritesDone().then(() => true), sleep(2000).then(() => false)]);
      go = false; await s.diskWritesDone();
      check('diskWritesDone ends while another drive keeps writing', done);
    }
    // a page listener that throws on a disk error: the write chain goes on, every write lands, diskWritesDone ends
    {
      const r = await rig(), { s, media, m } = r;
      let throwOnce = true, uncaught = null;
      const onUncaught = (e) => { uncaught = e; };
      process.once('uncaughtException', onUncaught);
      s.on((ev) => { if (ev === 'diskerror' && throwOnce) { throwOnce = false; throw new Error('listener bug'); } });
      const orig = media.writeRange.bind(media); let fail = true;
      media.writeRange = async (...a) => { if (fail) { fail = false; throw new MediaStoreError('quota', 'full'); } return orig(...a); };
      const d0 = s.diskControllerOf(m).drives[0];
      d0.media.onWrite(10, new Uint8Array([1]), d0.media.bytes.length);
      const e1 = await s.diskWritesDone().then(() => null, (e) => e);
      d0.media.onWrite(20, new Uint8Array([7]), d0.media.bytes.length);
      const e2 = await Promise.race([s.diskWritesDone().then(() => 'done', (e) => e), new Promise((res) => setTimeout(() => res('hung'), 2000))]);
      await new Promise((res) => setImmediate(res));
      process.removeListener('uncaughtException', onUncaught);
      check('a listener that throws on a disk error: the refused write is reported, the next write lands, diskWritesDone ends, the listener\'s error is reported on its own',
        e1 instanceof Emu.SessionError && /No space left/.test(e1.message) && e2 === 'done' && (await r.read('work.vdk'))[20] === 7
        && s.diskLanded === s.diskQueued && uncaught && uncaught.message === 'listener bug', `${e1 && e1.message} | ${e2 && (e2.message || e2)} | ${uncaught && uncaught.message}`);
    }
    // moving the library waits for the disks' last writes, and no disk goes in while it moves
    {
      const r = await rig(), { s, media } = r;
      const fdc = s.diskControllerOf(r.m), link = fdc.drives[0].media.onWrite;
      const orig = media.writeRange.bind(media);
      media.writeRange = async (...a) => { await new Promise((res) => setTimeout(res, 50)); return orig(...a); };
      link(100, new Uint8Array([0xAB]), fdc.drives[0].media.bytes.length);
      fdc.eject(0); fdc.eject(1);
      const dst = new MemoryMediaStore();
      await s.moveMedia(dst);
      check('moving the library: a disk write still on its way when the disks were ejected reaches the new place', s.media === dst && (await dst.read('disks/work.vdk'))[100] === 0xAB);
    }
    {
      const r = await rig(), { s } = r;
      await s.ejectDisk(0); await s.ejectDisk(1);
      const dst = new MemoryMediaStore();
      const theirs = images.vdk(40, 1); theirs.fill(0x55, 100, 4000);
      dst.writeSync('disks/work.vdk', theirs);   // the folder already has a different work.vdk
      const slowStat = dst.stat.bind(dst); dst.stat = async (nm) => { await new Promise((res) => setTimeout(res, 5)); return slowStat(nm); };
      const [mv, mt] = await Promise.all([s.moveMedia(dst), s.mountDisk(0, 'work.vdk')].map((q) => q.then((x) => x, (e) => e)));
      const d = s.diskControllerOf(r.m).drives[0];
      check('a mount while the library moves is refused (it would read one place and write the other); the move completes',
        mt instanceof Emu.SessionError && /library is being moved/.test(mt.message) && !(mv instanceof Error) && s.media === dst && !d.loaded,
        mt instanceof Error ? mt.message : 'mounted');
    }
    // the Library changes nothing while the library moves (the copy would miss it)
    {
      const r = await rig(), { s } = r;
      await s.ejectDisk(0); await s.ejectDisk(1);
      const dst = new MemoryMediaStore();
      const slowStat = dst.stat.bind(dst); dst.stat = async (nm) => { await new Promise((res) => setTimeout(res, 5)); return slowStat(nm); };
      const mv = s.moveMedia(dst);
      await new Promise((res) => setTimeout(res, 7));
      const tries = await Promise.all([s.importMedia('fresh.vdk', images.vdk(40, 1)), s.deleteMedia('disks/other.vdk'), s.renameMedia('disks/work.vdk', 'moved.vdk')].map((q) => q.then(() => null, (e) => e)));
      const mvErr = await mv.then(() => null, (e) => e);
      const names = (await dst.list('disks/')).map((f) => f.name).join(',');
      check('while the library moves, importing, deleting and renaming disks are refused; the moved library has exactly the disks it had',
        !mvErr && tries.every((e) => e instanceof Emu.SessionError && /library is being moved/.test(e.message)) && names === 'disks/other.vdk,disks/work.vdk', `${mvErr ? mvErr.message : 'moved'} | ${tries.map((e) => (e ? e.message : 'done')).join(' | ')} | ${names}`);
    }
    // a restore whose put-back fails on both drives: both are reported
    {
      const r = await rig(), { s } = r;
      await r.point(); await r.write();
      r.refuse.whole.add('disks/work.vdk'); r.refuse.whole.add('disks/other.vdk'); r.refuse.code = 'io';
      const res = s.restoreClaude();
      const e = await s.diskWritesDone().then(() => null, (x) => x);
      check('put-backs failing on two drives: one error naming both drives, both unlinked',
        restored(res) && e instanceof Emu.SessionError && /^Drive 0: .*work\.vdk.* Drive 1: .*other\.vdk.*Download it to keep it\.$/.test(e.message)
        && r.stored(0) === false && r.stored(1) === false, e && e.message);
    }
    // the chat's undoLast takes the same path
    {
      const r = await rig(), { s, chat } = r;
      await r.point(); await r.write();
      await s.ejectDisk(0);
      const lib = images.vdk(40, 2).fill(0x5A, 12);
      await s.importMedia('work.vdk', lib);
      await s.mountDisk(0, 'work.vdk');
      let calls = 0; const real = s.restorePoint.bind(s); s.restorePoint = (m, snap) => { calls++; return real(m, snap); };
      const from = r.writes.length;
      const ok = chat.undoLast();
      await s.diskWritesDone();
      check('undoLast goes through Session.restorePoint: the replaced file is untouched and drive 0 comes back unlinked',
        ok === true && calls === 1 && same(await r.read('work.vdk'), lib) && writesAfter(r, from, 'work.vdk') === 0 && r.stored(0) === false && r.stored(1) === true);
    }
  }

  // ---- restorePoint loads a point in its snapshot version's layout (Machine.loadSnapshotState, shared with
  // restore()): a CoCo 3 point in the version 1 layout (no haltDefer) restores; the same state marked as the
  // current version is refused part way through loading and the machine is put back as it was ----
  {
    const s = stubSession('coco3'), m = s.shownMachine;
    const point = m.snapshot();
    frames(s, 5); m.ram[0x3000] ^= 0xFF;
    const after = json(m);
    const v1 = Emu.state.fromJSON(Emu.state.toJSON(point)); delete v1.state.haltDefer; v1.version = 1;
    const bad = Object.assign({}, v1, { version: Emu.SNAPSHOT_VERSION });
    const e = throwsMsg(() => s.restorePoint(m, bad));
    check(`restorePoint: a version ${Emu.SNAPSHOT_VERSION} point without haltDefer is refused and the machine is put back as it was`,
      e instanceof Emu.SessionError && /missing "haltDefer".*put back as it was/.test(e.message) && json(m) === after, e ? e.message : 'restored');
    const e1 = throwsMsg(() => s.restorePoint(m, v1));
    check('restorePoint: a version 1 point (no haltDefer) restores, nothing suspended, the state is the point\'s',
      e1 === null && m.haltDefer === null && m.restoringVersion === Emu.SNAPSHOT_VERSION
      && JSON.stringify(m.saveState()) === JSON.stringify(point.state), e1 ? e1.message : '');
  }

  console.log(`\n${n - fail}/${n} restore-point checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
