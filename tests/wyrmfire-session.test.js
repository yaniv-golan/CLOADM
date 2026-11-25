// WYRMFIRE in the Session (js/session.js startWyrmfire, js/wyrmfire/pin.js): it boots on the Dragon 64 with the
// ROM-less DragonDOS controller and the Freedoom level, whatever machine was in use; it is a program the touch pad plays
// with FIRE and USE; snapshots are off; a share link starts it afresh; and with a level converted from the person's own
// WAD, nothing hands out the screen or memory (Session.romCodeIn 'userdata': the page's chat, the MCP tools, the embed
// API), and that disk is in no snapshot, share link, Library, recent list, settings export, download or insert_disk.
// No id Software data is used: the "own WAD" level here is the Freedoom disk, started as level 'user' (what the page
// does with the converter's output), so every guard is exercised on bytes CLOADM may hold.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
const { WYRMFIRE_PIN: PIN } = require('../js/wyrmfire/pin.js');

const ROOT = path.join(__dirname, '..');
let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const J = JSON.stringify;
const ENGINE = new Uint8Array(fs.readFileSync(path.join(ROOT, PIN.files.engine.path)));
const LEVEL = new Uint8Array(fs.readFileSync(path.join(ROOT, PIN.files.level.path)));
const USER_READS = 'Claude can\'t look at the screen or memory while your own WAD is loaded: it\'s id Software\'s game data.';
const SNAP_OFF = 'Snapshots are off while WYRMFIRE runs.';
const FRAME_MARKER = 0x200, HEALTH = 0x204;   // the engine's RAM map (wyrmfire src/disk.h, test/smoke.test.mjs)
const attempt = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// play until the engine has drawn its first in-game picture (ENTER skips the title cue)
function toFirstFrame(s) {
  const m = s.personMachine;
  let f = 0;
  while (s.readByte(FRAME_MARKER) === 0 && f < 3000) { m.setKey('ENTER', f % 50 < 25); s.runFrames(1); f++; }
  m.setKey('ENTER', false);
  return f;
}

(async () => {
  // ---------------- the Freedoom level, started from another machine ----------------
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine('coco3', {}, { menu: false });
  const msg = s.startWyrmfire(ENGINE, LEVEL);
  const m = s.personMachine, fdc = m.cartPort;
  check('starts on the Dragon 64, 64K, 6809, without ROMs', m.id === 'dragon64' && m.config.ram === 64 && m.config.cpu === '6809' && !m.hasRom, `${m.id} ${J(m.config)}`);
  check('the bare DragonDOS controller (no ROM) in the port, the level write-protected in drive 0', fdc && fdc.type === 'dragonfdc' && fdc.romBytes === null
    && fdc === s.drives.bareController && fdc.drives[0].loaded && fdc.drives[0].wpt && s.drives.status().drives[0].gameData === 'freedoom', J(s.drives.status()));
  check('the engine was loaded as a DragonDOS binary at $0C00 and started', /WYRMFIRE\.BIN loaded and started\. DragonDOS binary \$0C00-/.test(msg) && /exec \$0C00/.test(msg), msg);
  const fields = toFirstFrame(s);
  check('the engine reads its level from the disk and draws an in-game picture, health 100', s.readByte(FRAME_MARKER) > 0 && s.readByte(HEALTH) === 100, `${fields} fields`);
  check('running: wyrmfireState says the Freedoom level', J(s.wyrmfireState) === J({ level: 'freedoom', name: null }) && s.wyrmfireRunning);
  const pc = s.programControls;
  check('programControls: arrows (the Pad), Z X 1 2 3 as extra keys, FIRE (SPACE) and USE (E) the big buttons', pc && pc.id === 'wyrmfire' && pc.input === 'arrows'
    && J(pc.extra) === J(['Z', 'X', '1', '2', '3']) && J(pc.big) === J([['SPACE', 'FIRE'], ['E', 'USE']]), J(pc));
  check('Freedoom: romCodeIn says "cartridge" (the Freedoom disk in the cartridge port), never "userdata": the level is not the person\'s own WAD, so no read is held back', s.romCodeIn() === 'cartridge');

  // snapshots off, share link
  const snapErr = await attempt(() => s.snapshotFile());
  const shareErr = await attempt(() => s.shareFile());
  const slotErr = await attempt(() => s.saveSlot(1));
  check('snapshots are off: snapshotFile, shareFile and a quick-save slot refuse with the muted reason', [snapErr, shareErr, slotErr].every((e) => e && e.message === SNAP_OFF), J([snapErr, shareErr, slotErr].map((e) => e && e.message)));
  check('the share link starts WYRMFIRE afresh: ?start=wyrmfire only', s.shareUrl('https://cloadm.dev/play/') === 'https://cloadm.dev/play/?start=wyrmfire');
  check('... and parses back to the Dragon 64 with WYRMFIRE, no errors', (() => { const c = Emu.parseUrlConfig('?start=wyrmfire', 'coco3'); return c.machine === 'dragon64' && c.start === 'wyrmfire' && !c.errors.length; })());
  check('the chat\'s link (app=claude) never carries start=wyrmfire (they conflict)', !/start=/.test(s.shareUrl('https://cloadm.dev/play/', { app: 'claude' })));
  const link = await s.claudeLink('https://cloadm.dev/play/');
  check('Ask Claude\'s pop-out link: a fresh machine with the chat, no snapshot', !link.carried && /app=claude/.test(link.href) && !/#s=|start=/.test(link.href), link.href);

  // the person's DragonDOS ROM stays out (our own bytes stand in for it: 8K of RTS)
  s.roms.put('dragondos', 'rom', new Uint8Array(0x2000).fill(0x39), 'ddos10.rom');
  s.emit('roms');
  check('a disk ROM the person has stored is not waiting to go in while WYRMFIRE runs', !s.drives.romWaiting && s.drives.fitRom() === null && fdc.romBytes === null);
  s.reset();
  check('a Reset keeps the bare controller and the level (the engine restarts)', m.cartPort === fdc && fdc.romBytes === null && s.wyrmfireRunning, J(s.drives.status().dos));

  // MCP (the side panel's toolbox): screenshot and peek are both allowed -- the Freedoom level is not the person's own
  // WAD, so the user-data guard does not apply; screenshot reads the frame, peek reads memory, neither is held back
  const T = await import(require('url').pathToFileURL(path.join(ROOT, 'js/mcp/tools.js')).href);
  const host = { roms: () => [], png: () => new Uint8Array([1]), program: () => new Uint8Array(0), now: () => 0, date: () => new Date(0), yield: () => new Promise(setImmediate),
    readMedia() { throw new T.McpToolError('no-media-root'); }, writeMedia() { throw new T.McpToolError('no-media-root'); } };
  const tb = T.createToolbox(host, { session: s, route: 'panel' });
  const shot = await tb.call('screenshot', { machine_id: 'm1' });
  const peek = await tb.call('peek', { machine_id: 'm1', address: 0x0C00, length: 4 });
  check('Freedoom: Claude\'s screenshot works (the level is BSD)', shot.ok && shot.image && shot.image.length === 1, J(shot.error));
  // Reading the machine is allowed on every host (6bc5e6fd), and the Freedoom level is BSD-licensed, so a peek reads
  // it. The one rule left is the person's own WAD; that is exercised below, with a real marked machine.
  check('Freedoom: peek reads the engine\'s memory (the level is BSD, and reading is allowed on every host)',
    peek.ok && peek.data && peek.data.machine_output && peek.data.machine_output.hex, J(peek.error));

  // a program loaded over WYRMFIRE ends it
  s.load('demo.bin', new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples/demo.bin'))), { remember: false });
  check('a program loaded over it ends WYRMFIRE: snapshots work again, the link is the machine\'s', !s.wyrmfireRunning && s.programControls === null && !(await attempt(() => s.snapshotFile()))
    && /machine=dragon64/.test(s.shareUrl('https://cloadm.dev/play/')));

  // ---------------- a level converted from the person's own WAD (stand-in: the Freedoom disk, level 'user') ----------------
  const u = new Emu.Session({ welcomeMenu: false });
  u.switchMachine('dragon64', {}, { menu: false });
  u.startWyrmfire(ENGINE, LEVEL.slice(), { level: 'user', name: 'DOOM1.WAD' });
  toFirstFrame(u);
  check('own WAD: running, the source file\'s name kept, romCodeIn "userdata"', J(u.wyrmfireState) === J({ level: 'user', name: 'DOOM1.WAD' }) && u.romCodeIn() === 'userdata');
  // the page's chat (its read-only tools)
  const pageRead = (name, input = {}) => { try { return { out: Emu.runReadOnlyTool(u.chatTarget(), name, input) }; } catch (e) { return { error: e }; } };
  const reads = ['screen_text', 'peek', 'disassemble'].map((n) => [n, pageRead(n, n === 'screen_text' ? {} : { address: 0x0C00 })]);
  check('own WAD: the chat\'s screen_text, peek and disassemble refuse with the reason', reads.every(([, r]) => r.error && r.error.code === 'user-data' && r.error.message.includes(USER_READS)), J(reads.map(([n, r]) => [n, r.error && r.error.message])));
  check('own WAD: machine_info still answers', !!pageRead('machine_info').out);
  // the MCP tools (the side panel's): the own-WAD rule is the only refusal and it does not depend on ROM policy
  {
    const tbu = T.createToolbox(host, { session: u, route: 'panel' });
    const out = {};
    for (const [n, a] of [['screenshot', {}], ['screen_text', {}], ['peek', { address: 0x0C00 }], ['disassemble', { address: 0x0C00 }], ['find_bytes', { pattern: '00' }]]) out[n] = await tbu.call(n, Object.assign({ machine_id: 'm1' }, a));
    const runFrames = await tbu.call('run_frames', { machine_id: 'm1', frames: 1, until: { text: 'X' } });
    check('own WAD: screenshot, screen_text, peek, disassemble and find_bytes refuse with the reason',
      Object.values(out).every((r) => !r.ok && r.error.code === 'rejected' && r.error.detail.includes(USER_READS)),
      J(Object.fromEntries(Object.entries(out).map(([n, r]) => [n, r.ok ? 'ok' : r.error.detail]))));
    check('own WAD: run_frames does not hand the screen out either', !runFrames.ok && J(runFrames.error).includes('user-data'), J(runFrames).slice(0, 200));
  }
  // the side panel's toolbox on a session (as the panel builds it)
  function tbOwn(sess) { return T.createToolbox(host, { session: sess, route: 'panel' }); }
  // the embed API
  const api = new Emu.EmbedApi(u, () => {});
  const eRead = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  check('own WAD: the embed API\'s peek and screenText refuse with the reason', eRead(() => api.peek(0x0C00, 4)) === USER_READS && eRead(() => api.screenText()) === USER_READS);

  // THE CONVERSE, which pins 6bc5e6fd: with ROMs in the machine and NO own WAD, a peek SUCCEEDS. Without this the
  // user-data guard could be widened to any code in memory and every other check here would still pass.
  {
    const r = new Emu.Session({ welcomeMenu: false });
    r.switchMachine('dragon64', { ram: 64 }, { menu: false });
    // a synthetic ROM image is enough: romCodeIn answers 'roms' from the sockets being filled (m.romCrcs())
    r.personMachine.setRoms(Object.fromEntries(r.personMachine.profile.roms.map((x) => [x.id, new Uint8Array(x.size || 0x2000).fill(0x12)])));
    const why = r.romCodeIn();
    const tbr = T.createToolbox(host, { session: r, route: 'panel' });
    const got = await tbr.call('peek', { machine_id: 'm1', address: 0xA000, length: 2 });
    check('ROMs in, no own WAD: peek reads ROM memory (the ROM rule is retired; only the own WAD is refused)',
      why === 'roms' && got.ok, JSON.stringify({ why, peek: got.ok ? 'ok' : got.error }));
  }
  // the disk goes nowhere
  check('own WAD: snapshots (file, share, slot) refuse', (await Promise.all([attempt(() => u.snapshotFile()), attempt(() => u.shareFile()), attempt(() => u.saveSlot(2))])).every((e) => e && e.message === SNAP_OFF));
  check('own WAD: the share link is ?start=wyrmfire (the Freedoom level), never the person\'s', u.shareUrl('https://cloadm.dev/play/') === 'https://cloadm.dev/play/?start=wyrmfire');
  const dl = await attempt(() => u.drives.download(0)), keep = await attempt(() => u.drives.keepSnapshot(0));
  check('own WAD: the drive\'s Download and keep-in-Library refuse', dl && /converted from your own WAD/.test(dl.message) && keep && /not kept in the Library/.test(keep.message), J([dl && dl.message, keep && keep.message]));
  const kept = await u.saveGameFile(LEVEL, 'DOOM1.WAD');
  check('own WAD: Node\'s store keeps nothing past the visit, and says so (the page shows the storage message)', !kept.kept && kept.why === 'memory');
  check('own WAD: not in the Library, the recent list, the drives\' Library list or the settings export', !(await u.library.listMedia()).length && !u.library.recentMedia().length
    && !(await u.drives.list()).length && !/WYRMFIRE|DOOM1|games\//.test(J(u.exportSettings())), J(await u.library.listMedia()));
  check('own WAD: insert_disk is not a tool of the side panel, and the local server\'s insert_disk reads files only from its own folder (never the browser\'s store)',
    (await import(require('url').pathToFileURL(path.join(ROOT, 'connector/view/tools.js')).href)).LEFT_OUT.includes('insert_disk'));
  // a restore point put back (Claude's undo) keeps the disk marked as the person's
  const point = u.personMachine.snapshot();
  const back = Emu.restoreSnapshot(Emu.state.fromJSON(Emu.state.toJSON(point)), u.personMachine.roms);
  check('own WAD: a machine state saved and restored keeps the disk marked as the person\'s', back.cartPort.drives[0].media.gameData === 'user');
  // a program loaded over it: still no reads while the disk is in the drive
  u.load('demo.bin', new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples/demo.bin'))), { remember: false });
  check('own WAD: a program loaded over it leaves the disk in, and reads and snapshots stay refused', !u.wyrmfireRunning && u.romCodeIn() === 'userdata' && !!(await attempt(() => u.snapshotFile())));
  await u.drives.eject(0);
  // the mark is the MACHINE's: its RAM held the level, so taking the disk out frees nothing
  const ejected = { why: u.romCodeIn(), snap: await attempt(() => u.snapshotFile()), share: await attempt(() => u.shareFile()), shot: await tbOwn(u).call('screenshot', { machine_id: 'm1' }), peek: await tbOwn(u).call('peek', { machine_id: 'm1', address: 0x0C00 }) };
  check('own WAD: the disk taken out keeps every refusal (reads, MCP screenshot and peek, snapshots, Share)', ejected.why === 'userdata' && ejected.snap && ejected.snap.message === SNAP_OFF
    && ejected.share && ejected.share.message === SNAP_OFF && !ejected.shot.ok && !ejected.peek.ok, JSON.stringify({ why: ejected.why, shot: ejected.shot.ok, peek: ejected.peek.ok }));
  u.reset();
  check('own WAD: a Reset keeps them refused', u.romCodeIn() === 'userdata' && !!(await attempt(() => u.snapshotFile())));
  {
    const USER_PICTURE = 'No picture: this moment is your own WAD\'s level, which is id Software\'s game data. The picture and the clip stay off.';
    const refused = await attempt(() => u.sharePicture('WYRMFIRE'));
    check('own WAD: the Share card\'s picture is refused by name, with the picture\'s own reason', !!refused && refused instanceof Emu.SessionError && refused.message === USER_PICTURE, refused && refused.message);
  }
  u.powerCycle({ menu: false });
  // a power cycle with the disk out frees the own-WAD mark, and with it every refusal: the bare controller is still in
  // the port, and reading a machine with a cartridge fitted is allowed (6bc5e6fd), so the peek now reads.
  {
    const peeked = await tbOwn(u).call('peek', { machine_id: 'm1', address: 0x0C00 });
    const card = await u.sharePicture('WYRMFIRE');
    check('own WAD: with the mark freed the Share card\'s picture is made again (a PNG)', card[0] === 0x89 && card[1] === 0x50 && card[2] === 0x4E && card[3] === 0x47, `${card.length} bytes`);
    check('own WAD: switching the machine off and on frees them (the disk out, its RAM cleared)', u.romCodeIn() !== 'userdata' && !(await attempt(() => u.snapshotFile()))
      && peeked.ok === true /* a cartridge is in, and reading is allowed */, JSON.stringify({ why: u.romCodeIn(), peek: peeked.ok }));
  }
  // a power cycle with the disk still in drive 0: the disk is the level, readable through the bare controller by a
  // program an agent loads, so the refusal stays until the disk is out as well
  {
    const p = new Emu.Session({ welcomeMenu: false });
    p.switchMachine('dragon64', {}, { menu: false });
    p.startWyrmfire(ENGINE, LEVEL.slice(), { level: 'user', name: 'DOOM1.WAD' });
    p.powerCycle({ menu: false });
    const tbp = tbOwn(p), r = { peek: await tbp.call('peek', { machine_id: 'm1', address: 0x0C00 }), registers: await tbp.call('registers', { machine_id: 'm1' }), step: await tbp.call('step', { machine_id: 'm1' }) };
    check('own WAD: a power cycle with the disk still in keeps "userdata": MCP peek, registers and step refuse with the reason; snapshots too',
      !p.userDataIn() && p.userDiskIn() && p.romCodeIn() === 'userdata' && Object.values(r).every((x) => !x.ok && x.error.detail.includes(USER_READS)) && !!(await attempt(() => p.snapshotFile())),
      JSON.stringify({ why: p.romCodeIn(), r: Object.fromEntries(Object.entries(r).map(([k, x]) => [k, x.ok])) }));
    await p.drives.eject(0);
    p.powerCycle({ menu: false });
    check('own WAD: the disk out and a power cycle lift the rule', p.romCodeIn() === 'cartridge' && (await tbOwn(p).call('registers', { machine_id: 'm1' })).ok && !(await attempt(() => p.snapshotFile())));
  }
  // (a new machine is never marked: a switch, or a snapshot opened)
  {
    const v = new Emu.Session({ welcomeMenu: false });
    v.switchMachine('dragon64', {}, { menu: false });
    v.startWyrmfire(ENGINE, LEVEL.slice(), { level: 'user', name: 'DOOM1.WAD' });
    v.switchMachine('dragon64', {}, { menu: false });
    check('own WAD: a switch is a new machine, not marked', v.romCodeIn() === null && !v.userDataIn());
  }
  // MCP: registers, step and run_frames until a memory byte or pc read the machine: refused with the mark
  {
    const w = new Emu.Session({ welcomeMenu: false });
    w.switchMachine('dragon64', {}, { menu: false });
    w.startWyrmfire(ENGINE, LEVEL.slice(), { level: 'user', name: 'DOOM1.WAD' });
    const tbw = tbOwn(w), r = {};
    r.registers = await tbw.call('registers', { machine_id: 'm1' });
    r.step = await tbw.call('step', { machine_id: 'm1', count: 1 });
    r.memory = await tbw.call('run_frames', { machine_id: 'm1', frames: 1, until: { address: 0x0C00, value: 1 } });
    r.pc = await tbw.call('run_frames', { machine_id: 'm1', frames: 1, until: { pc: 0x0C00 } });
    const plain = await tbw.call('run_frames', { machine_id: 'm1', frames: 1 });
    check('own WAD: MCP registers, step and run_frames until a memory byte or the pc refuse with the reason; a plain run_frames runs',
      Object.values(r).every((x) => !x.ok && x.error.code === 'rejected' && x.error.detail.includes(USER_READS)) && plain.ok, JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, x]) => [k, x.ok]))));
    const f = new Emu.Session({ welcomeMenu: false });
    f.switchMachine('dragon64', {}, { menu: false });
    f.startWyrmfire(ENGINE, LEVEL.slice());
    check('Freedoom: registers and step answer (no mark)', (await tbOwn(f).call('registers', { machine_id: 'm1' })).ok && (await tbOwn(f).call('step', { machine_id: 'm1' })).ok);
  }

  // ---------------- the person's ROMs come back when WYRMFIRE ends, on every way out ----------------
  // (our own bytes stand in for Dragon 64 ROMs: CLOADM recognises them by their file names)
  const fakeRoms = [{ name: 'd64_1.rom', bytes: Uint8Array.from({ length: 16384 }, (_, i) => (i * 7 + 3) & 255) }, { name: 'd64_2.rom', bytes: Uint8Array.from({ length: 16384 }, (_, i) => (i * 11 + 5) & 255) }];
  const withRoms = (stub = false) => {
    const r = new Emu.Session({ welcomeMenu: false });
    r.switchMachine('dragon64', {}, { menu: false });
    r.addRoms(fakeRoms);
    if (stub) r.runWithoutRoms({ menu: false });
    return r;
  };
  const before = withRoms();
  const snapWithRoms = await before.readSnapshot((await before.snapshotFile()).bytes);
  const exits = [
    ['a load over it, then a power cycle', async (r) => { r.load('demo.bin', new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples/demo.bin'))), { remember: false }); r.powerCycle({ menu: false }); }],
    ['its disk taken out, then a power cycle', async (r) => { await r.drives.eject(0); r.powerCycle({ menu: false }); }],
    ['a power cycle', async (r) => { r.powerCycle({ menu: false }); }],
    ['a switch away and back', async (r) => { r.switchMachine('coco3', {}, { menu: false }); r.switchMachine('dragon64', {}, { menu: false }); }],
    ['a snapshot opened', async (r) => { r.openSnapshot(snapWithRoms); }],
  ];
  for (const [how, exit] of exits) {
    const r = withRoms();
    const had = r.personMachine.hasRom && !r.stubChosen.has('dragon64');
    r.startWyrmfire(ENGINE, LEVEL.slice());
    const during = !r.personMachine.hasRom && r.stubChosen.has('dragon64');
    await exit(r);
    check(`ROMs back after WYRMFIRE: ${how}: the Dragon 64 has its ROMs again, and "run without ROMs" is as it was`, had && during && r.personMachine.id === 'dragon64' && r.personMachine.hasRom && !r.stubChosen.has('dragon64') && !r.wyrmfireRunning,
      JSON.stringify({ had, during, id: r.personMachine.id, hasRom: r.personMachine.hasRom, stub: r.stubChosen.has('dragon64') }));
  }
  {
    const r = withRoms(true);   // the person chose to run without ROMs: WYRMFIRE leaves that choice alone
    r.startWyrmfire(ENGINE, LEVEL.slice());
    r.powerCycle({ menu: false });
    check('ROMs: a "run without ROMs" the person chose stays chosen after WYRMFIRE', r.stubChosen.has('dragon64') && !r.personMachine.hasRom);
  }

  // ---------------- "Your game files" on a store that keeps them ----------------
  class KeptStore extends Emu.MemoryMediaStore { get kind() { return 'opfs'; } get synchronous() { return false; } }
  const g = new Emu.Session({ welcomeMenu: false, media: new KeptStore() });
  await g.ready();
  const posts = [];
  g.mediaShare = { channel: { postMessage: (x) => posts.push(x) } };
  const events = [];
  g.on((ev) => { if (ev === 'gamefiles') events.push(ev); });
  check('game files: none at first', !(await g.gameFiles()).length && (await g.readGameFile()) === null);
  const k = await g.saveGameFile(LEVEL, 'DOOM.WAD');
  const files = await g.gameFiles(), back2 = await g.readGameFile();
  const stored = (await g.media.list('')).map((f) => f.name).sort();
  check('game files: the converted disk and the source file\'s name are kept, nothing else (no WAD)', k.kept && J(files) === J([{ id: 'wyrmfire', source: 'DOOM.WAD', size: LEVEL.length }])
    && back2.source === 'DOOM.WAD' && back2.disk.length === LEVEL.length && J(stored.filter((n) => n.startsWith('games/'))) === J(['games/wyrmfire-own.json', 'games/wyrmfire-own.vdk']), J(stored));
  check('game files: other pages are told ("games"), and this page hears it', posts.some((p) => p.what === 'games') && events.length === 1, J(posts));
  check('game files: not in the Library or the drives\' list', !(await g.library.listMedia()).length && !(await g.drives.list()).length);
  await g.mediaElsewhere({ store: 'opfs', what: 'games' });
  check('game files: another page\'s change is heard as "gamefiles"', events.length === 2);
  await g.removeGameFile();
  check('game files: Remove takes both away', !(await g.gameFiles()).length && !(await g.media.list('games/')).length);

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log(`FAIL ${e.stack}`); process.exitCode = 1; });
