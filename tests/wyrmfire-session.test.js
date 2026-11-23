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
  check('the engine was loaded as a DragonDOS binary at $0C00 and started', /WYRMFIRE\.BIN: DragonDOS binary \$0C00-/.test(msg) && /exec \$0C00/.test(msg), msg);
  const fields = toFirstFrame(s);
  check('the engine reads its level from the disk and draws an in-game picture, health 100', s.readByte(FRAME_MARKER) > 0 && s.readByte(HEALTH) === 100, `${fields} fields`);
  check('running: wyrmfireState says the Freedoom level', J(s.wyrmfireState) === J({ level: 'freedoom', name: null }) && s.wyrmfireRunning);
  const pc = s.programControls;
  check('programControls: arrows (the Pad), Z X 1 2 3 as extra keys, FIRE (SPACE) and USE (E) the big buttons', pc && pc.id === 'wyrmfire' && pc.input === 'arrows'
    && J(pc.extra) === J(['Z', 'X', '1', '2', '3']) && J(pc.big) === J([['SPACE', 'FIRE'], ['E', 'USE']]), J(pc));
  check('Freedoom: memory reads are refused as for any cartridge (romCodeIn "cartridge"), never "userdata"', s.romCodeIn() === 'cartridge');

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

  // MCP (the side panel's toolbox): screenshot allowed, peek refused as a cartridge's
  const T = await import(require('url').pathToFileURL(path.join(ROOT, 'js/mcp/tools.js')).href);
  const host = { roms: () => [], png: () => new Uint8Array([1]), program: () => new Uint8Array(0), now: () => 0, date: () => new Date(0), yield: () => new Promise(setImmediate),
    readMedia() { throw new T.McpToolError('no-media-root'); }, writeMedia() { throw new T.McpToolError('no-media-root'); } };
  const tb = T.createToolbox(host, { session: s, refuseRomReads: true, route: 'panel' });
  const shot = await tb.call('screenshot', { machine_id: 'm1' });
  const peek = await tb.call('peek', { machine_id: 'm1', address: 0x0C00, length: 4 });
  check('Freedoom: Claude\'s screenshot works (the level is BSD)', shot.ok && shot.image && shot.image.length === 1, J(shot.error));
  check('Freedoom: peek is refused as for a cartridge', !peek.ok && peek.error.code === 'rejected' && /a cartridge is plugged in/.test(peek.error.detail), J(peek.error));

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
  // the MCP tools (the side panel's), whatever refuseRomReads says
  for (const refuse of [true, false]) {
    const tbu = T.createToolbox(host, { session: u, refuseRomReads: refuse, route: 'panel' });
    const out = {};
    for (const [n, a] of [['screenshot', {}], ['screen_text', {}], ['peek', { address: 0x0C00 }], ['disassemble', { address: 0x0C00 }], ['find_bytes', { pattern: '00' }]]) out[n] = await tbu.call(n, Object.assign({ machine_id: 'm1' }, a));
    const runFrames = await tbu.call('run_frames', { machine_id: 'm1', frames: 1, until: { text: 'X' } });
    check(`own WAD (refuseRomReads ${refuse}): screenshot, screen_text, peek, disassemble and find_bytes refuse with the reason`,
      Object.values(out).every((r) => !r.ok && r.error.code === 'rejected' && r.error.detail.includes(USER_READS)),
      J(Object.fromEntries(Object.entries(out).map(([n, r]) => [n, r.ok ? 'ok' : r.error.detail]))));
    check(`own WAD (refuseRomReads ${refuse}): run_frames does not hand the screen out either`, !runFrames.ok && J(runFrames.error).includes('user-data'), J(runFrames).slice(0, 200));
  }
  // the embed API
  const api = new Emu.EmbedApi(u, () => {});
  const eRead = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  check('own WAD: the embed API\'s peek and screenText refuse with the reason', eRead(() => api.peek(0x0C00, 4)) === USER_READS && eRead(() => api.screenText()) === USER_READS);
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
  check('own WAD: once the disk is out, reads and snapshots work again', u.romCodeIn() === 'cartridge' && !(await attempt(() => u.snapshotFile())));

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
