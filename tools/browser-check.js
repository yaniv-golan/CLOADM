#!/usr/bin/env node
// Browser smoke test of the real page (needs Playwright with Chromium). Serves the repository on a
// local port, then for every model: switch to it, run, and require no page errors and a non-blank
// screen showing the stub banner. Finally assembles and runs LIZA on a CoCo and holds a short
// conversation through the keyboard. Exit code 0 only if everything passed.
//
// Then ROM input with synthetic images only: dropping files, a folder and a ZIP, the file and folder
// pickers, a ROM pack saved and restored in a fresh browser profile, URL configuration, and that nothing
// ever requests colorcomputerarchive.com.
//
// Then the ROMs card: every socket state, the switch-machine offer, "Run without ROMs", the boot
// watchdog with a deliberately wrong ROM, and ROMs surviving a reload (screenshots of each state).
//
// Then visits: a first visit opens on the welcome program with the no-ROM shelf and the machine question
// (asked once), sound unlocks on the first click and arms the tune, the menu keys (1 LIZA, 2 the demo and
// "Back to the menu", 3 the ROM sockets, 4 the chat notice), and a returning visit restores the machine and
// offers the last item.
//
// Then media: a binary for another machine offers to switch (or load anyway), a disk image says what it
// is, and pasted text types itself in.
//
// Then disks: the drives card under the screen. Our own firmware as BASIC and DragonDOS ROM, two disk images
// inserted through the drives' menus (one write-protected), the drive lights while the firmware writes, the
// write in OPFS and in the downloaded file byte for byte, write-protect and eject from a loaded drive's menu, a
// library disk inserted after a reload, a file that is no disk image; the Dragon Alpha's own two drives (no
// cartridge); no drives card on the MC-10.
//
// Then NitrOS-9 from the page (no ROM): the CoCo 3's NitrOS-9 slot, its errors, a dropped image, nitros9= links and
// Share with hand-built boot disks, and the official images (when fetched) booted to the shell with `dir` typed.
//
// Then the one-time keyboard hint and the Credits link.
//
// Then the SAM CPU rate: each speed POKE typed through the keyboard (and one clicked in the POKE book)
// into the stub firmware's command line, with the rate shown in the Machine card, the SAM chip lighting,
// the instructions run per frame, the picture lost at POKE 65497,0 and back at POKE 65496,0, and Turbo
// leaving the rate alone.
//
// Then the design tokens: the self-hosted fonts load and are used, the colours are the tokens', and no
// request leaves the local server.
//
// Then the emulator layout at desktop and phone width: machine menu and confirmation, bezel per family,
// controls and slots, drawer tabs, the CRT choice remembered, the phone header's Menu. Then the Display tab
// (displayChecks).
//
// Then cassette media: Record saves what the machine wrote as .CAS, Save .WAV, a WAV recording as a tape.
//
// Then the light variant of the reading pages (a light system setting; the emulator stays dark).
//
// Then the reading pages (/roms) at desktop and phone width, and that only /roms and the landing page link the archive's ROM folder.
//
// The emulator is served at /play/; the landing page at / is checked at desktop and phone width: its links
// resolve, "Try it now" opens the welcome program, the machine cards and "Talk to LIZA" open the emulator.
//
//   node tools/browser-check.js [--screenshots DIR]
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib');
// the snapshot format this tree writes (the version checks build a newer file from it)
const { SNAPSHOT_VERSION } = require('../tests/load')();
// Playwright is loaded once the run starts (--list-groups needs no browser, so the CI shard planner runs without it)
let chromium;

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown', '.json': 'application/json', '.asm': 'text/plain', '.bin': 'application/octet-stream', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.inc': 'text/plain' };
// --only a,b: run only those groups of checks (their function names without "Checks"); the default runs all. A name
// that is no group is a usage error (tools/browser-check-lib.js has the rules: isolation, waits, SKIP, exit codes).
// --list-groups prints the group names, one per line, and runs nothing.
const lib = require('./browser-check-lib');
const run = lib.makeRun();
const { check, skip } = run;
const shotDir = (() => { const i = process.argv.indexOf('--screenshots'); return i > 0 ? process.argv[i + 1] : null; })();

// a static server like the real host: a folder serves its index.html, and a folder named without its
// trailing slash redirects to it (/play -> /play/). Every path it can't serve is recorded: no page may ask for a
// missing resource (checked at the end of the run)
const missing = new Set();
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    if (!url.pathname.endsWith('/')) { res.writeHead(301, { Location: url.pathname + '/' + url.search }); res.end(); return; }
    file = path.join(file, 'index.html');
  }
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { missing.add(url.pathname); res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// ---------------- ROMs (synthetic images only) ----------------
const fake = (size, seed) => { const b = Buffer.alloc(size); let x = seed >>> 0; for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };
// a ZIP (stored + DEFLATE entries) built here, independently of js/media/zip.js
function zip(entries) {
  const table = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const v of b) c = table[(c ^ v) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; }, u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  const local = [], central = []; let off = 0;
  for (const [name, data, method] of entries) {
    const comp = method === 8 ? zlib.deflateRawSync(data) : data, n = Buffer.from(name);
    const hdr = Buffer.concat([u32(0x04034B50), u16(20), u16(0), u16(method), u16(0), u16(0), u32(crc(data)), u32(comp.length), u32(data.length), u16(n.length), u16(0), n]);
    central.push(Buffer.concat([u32(0x02014B50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0), u32(crc(data)), u32(comp.length), u32(data.length), u16(n.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off), n]));
    local.push(hdr, comp); off += hdr.length + comp.length;
  }
  const cd = Buffer.concat(central);
  return Buffer.concat([...local, cd, u32(0x06054B50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(off), u16(0)]);
}
// a context that records (and blocks) any request to the ROM archive
// ---------------- floppy disks (on the media store): mount, write from firmware, download ----------------
// Our own firmware (tools/mame-diff/fdc/gen-diag.js) as the Dragon 64's BASIC (boot.asm) and as the DragonDOS ROM
// (dragon-write.asm): it writes sector 3 of track 1 on drives 0 and 1 ($11 + 3i, $22 + 3i), reads it back and
// stops the motor. The disks go in through the Media tab; drive 1 is write-protected there.
async function diskChecks(browser, base, check) {
  const { assembleFile, romImage } = require('./mame-diff/lib/firmware');
  const images = require('./mame-diff/fdc/images');
  const FDC = path.join(__dirname, 'mame-diff/fdc');
  require(path.join(FDC, 'gen-diag')).write();
  const boot = Buffer.from(romImage(assembleFile(path.join(FDC, 'boot.asm'), '6809'), 0x8000, 0x4000, 0x12));
  const w = assembleFile(path.join(FDC, 'dragon-write.asm'), '6809');
  const dos = Buffer.from(romImage(w, 0xC000, 0x2000, 0x00)), halt = w.symbols.get('HALT');
  const d0 = Buffer.from(images.vdk(40, 2)), d1 = Buffer.from(images.vdk(40, 1));
  // expected: sector 3 of track 1 side 0 (VDK: 12-byte header, 18 sectors of 256 bytes per side) replaced
  const written = (img, heads) => { const o = Buffer.from(img); for (let i = 0; i < 256; i++) o[12 + (1 * heads * 18 + 2) * 256 + i] = (0x11 + 3 * i) & 0xff; return o; };
  const want0 = written(d0, 2);

  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const msg = () => page.textContent('#toast');
  // a drive's menu, then a file through the menu's file chooser
  const openDrive = async (n) => { if (await page.getAttribute(`#drives [data-drive="${n}"]`, 'aria-expanded') !== 'true') await page.click(`#drives [data-drive="${n}"]`); };
  const insertFile = async (n, name, buffer, wp = false) => {
    await page.evaluate(() => { window.emu.feedback.clear(); });
    await openDrive(n);
    if (wp) await page.check('#driveNewWp');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#driveFile')]);
    await chooser.setFiles({ name, mimeType: 'application/octet-stream', buffer });
    // done when the drive holds it or the status line says why not
    await waitFor(page, ([n, name]) => window.emu.session.diskStatus().drives.some((d) => d.drive === n && d.file === name) || document.getElementById('toast').classList.contains('error'), [n, name]);
  };
  await page.goto(`${base}?machine=dragon64`); await ready(page);
  // no DOS ROM yet: the header says so, and a drive's menu names the ROM and offers "Add ROMs…"
  await page.click('#drives [data-drive="0"]');
  check('disks: without a DOS ROM a drive\'s menu names the ROMs it takes, with Add ROMs…', await waitFor(page, () => /no disk ROM yet/.test(document.getElementById('driveSlot').textContent)
    && /DragonDOS \(ddos10\.rom\) or Delta DOS \(deltados\.rom\)/.test(document.getElementById('driveMenu').textContent) && !!document.getElementById('driveRoms')), await page.textContent('#driveMenu'));
  if (shotDir) await page.locator('#driveSlot').screenshot({ path: path.join(shotDir, 'drives-no-rom.png') });
  await page.click('#driveClose');
  await dropFiles(page, [['d64_1.rom', boot], ['ddos10.rom', dos]]);
  check('disks: our boot firmware and DOS ROM are stored', await waitFor(page, () => window.emu.session.machineRoms('dragon64').bootable && !!window.emu.session.roms.get('dragondos').rom));
  check('disks: the drives card under the screen: DragonDOS, four empty drives "n · Insert disk…"', await waitFor(page, () => !document.getElementById('driveSlot').hidden
    && /Drives · DragonDOS · click a drive to insert/.test(document.getElementById('driveSlot').textContent)
    && [...document.querySelectorAll('#drives [data-drive]')].map((b) => b.textContent).join('|') === '0 · Insert disk…|1 · Insert disk…|2 · Insert disk…|3 · Insert disk…'),
    await page.textContent('#driveSlot'));
  if (shotDir) await page.locator('#driveSlot').screenshot({ path: path.join(shotDir, 'drives-empty.png') });
  await insertFile(0, 'work.vdk', d0);
  check('disks: a file into drive 0 through its menu, with the DragonDOS cartridge', await waitFor(page, () => /work\.vdk in drive 0/.test(document.getElementById('toast').textContent)
    && window.emu.session.diskStatus().dos.id === 'dragondos' && /0 · work\.vdk/.test(document.querySelector('#drives [data-drive="0"]').textContent)), await msg());
  await insertFile(1, 'locked.vdk', d1, true);
  check('disks: drive 1 write-protected from its menu (WP on the drive)', await waitFor(page, () => { const d = window.emu.session.diskStatus().drives[1]; return d && d.file === 'locked.vdk' && d.writeProtected; })
    && /write-protected/.test(await page.textContent('#drives [data-drive="1"]')));
  // the activity light: watch the LEDs while the firmware runs (Reset: the power-up with the cartridge started it
  // before drive 1 had its disk)
  await page.evaluate(() => {
    window.__ledSeen = new Set();
    new MutationObserver(() => { for (const l of document.querySelectorAll('#drives .led.on')) window.__ledSeen.add(l.closest('[data-drive]').dataset.drive); })
      .observe(document.getElementById('drives'), { subtree: true, attributes: true, childList: true });
  });
  // The lights are sampled once per displayed frame from the controller's busy bit, and a page that falls behind
  // runs up to 4 machine frames per displayed frame (Session.advance), so under load drive 1's work could start
  // and end between two samples (seen on main: lights '0' only). Here the page loop is paused and the machine is
  // run one frame per displayed frame, two animation frames apart, so the lights see every frame as on an idle
  // page, however slow this one is.
  await page.click('#btnPause');
  await page.click('#btnReset');
  const reachedHalt = await page.evaluate(async (h) => {
    const s = window.emu.session, m = s.machine, frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (let f = 0; f < 3000 && m.cpu.pc !== h; f++) { s.advance(1000 / m.fps, { now: () => performance.now() }); await frame(); }
    return m.cpu.pc === h;
  }, halt);
  await page.click('#btnPause');
  check('disks: the firmware writes and reaches HALT', reachedHalt);
  check('disks: drive lights came on while the firmware used drives 0 and 1, and are off at HALT', await page.evaluate(() => [...window.__ledSeen].sort().join()) === '0,1'
    && await waitFor(page, () => !document.querySelector('#drives .led.on'), null, 2000), await page.evaluate(() => [...window.__ledSeen].join()));
  const opfs = (file) => page.evaluate(async (file) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('disks');
    return Array.from(new Uint8Array(await (await (await dir.getFileHandle(file)).getFile()).arrayBuffer()));
  }, file);
  await page.evaluate(() => window.emu.session.diskWritesDone());
  check('disks: the stored image in OPFS has the written sector, the rest unchanged', Buffer.from(await opfs('work.vdk')).equals(want0));
  check('disks: the write-protected image in OPFS is unchanged', Buffer.from(await opfs('locked.vdk')).equals(d1));
  await openDrive(0);
  check('disks: a loaded drive\'s menu: write-protect, Download, Eject', await page.isVisible('#driveWp') && await page.isVisible('#driveDownload') && await page.isVisible('#driveEject'));
  if (shotDir) await page.locator('#driveSlot').screenshot({ path: path.join(shotDir, 'drives-menu.png') });
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#driveDownload')]);
  const saved = path.join(os.tmpdir(), `cloadm-disk-${process.pid}.vdk`);
  await download.saveAs(saved);
  check('disks: Download gives the written image, byte for byte', download.suggestedFilename() === 'work.vdk' && fs.readFileSync(saved).equals(want0));
  fs.unlinkSync(saved);
  await page.check('#driveWp');
  check('disks: write-protect from a loaded drive\'s menu', await waitFor(page, () => window.emu.session.diskStatus().drives[0].writeProtected));
  // a reload: the image is still in the library (disks/); insert it again from the menu, download it again
  await page.reload(); await ready(page);
  await openDrive(2);
  check('disks: after a reload an empty drive offers the stored disks', await waitFor(page, () => !document.getElementById('driveStoredRow').hidden && /work\.vdk/.test(document.getElementById('driveStored').textContent)));
  await page.selectOption('#driveStored', 'disks/work.vdk');
  await page.click('#driveMount');
  check('disks: a disk from the library goes into drive 2', await waitFor(page, () => { const d = window.emu.session.diskStatus().drives.find((x) => x.drive === 2); return d && d.file === 'work.vdk'; }));
  await openDrive(2);
  const [again] = await Promise.all([page.waitForEvent('download'), page.click('#driveDownload')]);
  await again.saveAs(saved);
  check('disks: downloaded after the reload, the same bytes', fs.readFileSync(saved).equals(want0));
  fs.unlinkSync(saved);
  await openDrive(2);
  await page.click('#driveEject');
  check('disks: Eject empties the drive ("2 · Insert disk…" again)', await waitFor(page, () => !window.emu.session.diskStatus().drives.some((x) => x.drive === 2)
    && document.querySelector('#drives [data-drive="2"]').textContent === '2 · Insert disk…'));
  // a file that is no disk image: refused on the status line, nothing stored
  await insertFile(3, 'notes.dsk', Buffer.alloc(1000, 7));
  check('disks: a file that is no disk image is refused on the status line', await waitFor(page, () => /notes\.dsk: not a disk image/.test(document.getElementById('toast').textContent)
    && document.getElementById('toast').classList.contains('error')), await msg());
  // a new blank disk from an empty drive's menu: the sizes DragonDOS uses, VDK by default; it is stored, mounted, and
  // Download gives exactly the blank image (blankDisk: VDK header, 40 x 18 sectors of E5)
  await openDrive(1);
  if (await page.evaluate(() => !!document.getElementById('driveEject'))) { await page.click('#driveEject'); await openDrive(1); }
  check('disks: an empty drive offers a new blank disk in the sizes DragonDOS uses, VDK by default', await page.evaluate(() => [...document.querySelectorAll('#driveNewSize option')].map((o) => o.textContent).join('|')
    === '40 tracks, single-sided (180K)|40 tracks, double-sided (360K)|80 tracks, double-sided (720K)' && document.getElementById('driveNewFormat').value === 'vdk'));
  await page.selectOption('#driveNewSize', '1');
  const dmk2 = await page.evaluate(() => !document.querySelector('#driveNewFormat option[value="dmk"]').disabled);
  await page.selectOption('#driveNewSize', '0');
  check('disks: DMK is offered for a double-sided new disk, not for a single-sided one (MAME 0.264 cannot load it)', dmk2
    && await page.evaluate(() => document.querySelector('#driveNewFormat option[value="dmk"]').disabled && document.getElementById('driveNewFormat').value === 'vdk'));
  if (shotDir) await page.locator('#driveSlot').screenshot({ path: path.join(shotDir, 'drives-new-blank.png') });
  await page.click('#driveNew');
  check('disks: New blank disk stores disk-1.vdk and puts it in the drive', await waitFor(page, () => { const d = window.emu.session.diskStatus().drives.find((x) => x.drive === 1); return d && d.file === 'disk-1.vdk'; })
    && /1 · disk-1\.vdk/.test(await page.textContent('#drives [data-drive="1"]')), await msg());
  await openDrive(1);
  const [nd] = await Promise.all([page.waitForEvent('download'), page.click('#driveDownload')]);
  await nd.saveAs(saved);
  const blank = Buffer.concat([Buffer.from([0x64, 0x6b, 12, 0, 0x10, 0x10, 0x4d, 0x01, 40, 1, 0, 0]), Buffer.alloc(40 * 18 * 256, 0xe5)]);
  check('disks: the new disk downloads as the blank VDK, byte for byte', nd.suggestedFilename() === 'disk-1.vdk' && fs.readFileSync(saved).equals(blank));
  fs.unlinkSync(saved);

  // ---- a Multi-Pak with the DragonDOS controller in slot 4, chosen in the Multi-Pak panel's board menu (no image:
  // the controller's ROM is the DOS ROM stored above); the drives card then uses it and the firmware runs from slot 4
  await page.click('#mpak summary');
  await page.selectOption('#selMpBoard4', 'dos:dragondos');
  check('disks: the Multi-Pak panel offers the DragonDOS controller for a slot, which needs no image', await page.evaluate(() => {
    const b = document.getElementById('btnMpSlot4');
    return b.textContent === 'DragonDOS' && b.disabled && [...document.getElementById('selMpBoard1').options].some((o) => o.value === 'dos:deltados' && o.disabled && /ROM needed/.test(o.textContent));
  }));
  await page.click('#btnMpInsert');
  check('disks: Multi-Pak inserted with the controller in slot 4; the drives card uses it, its drives empty', await waitFor(page, () => {
    const c = window.emu.machine.cartPort;
    return c && c.type === 'multi' && c.cart(4) && c.cart(4).type === 'dragonfdc' && window.emu.session.diskController === c.cart(4)
      && /Drives · DragonDOS/.test(document.getElementById('driveSlot').textContent) && document.querySelectorAll('#drives .drive.loaded').length === 0;
  }), await msg());
  await insertFile(0, 'mpak.vdk', d0);
  await insertFile(1, 'mpak1.vdk', d1, true);
  await page.click('#btnReset');
  check('disks: Multi-Pak: the firmware in slot 4 reaches HALT', await waitFor(page, (h) => window.emu.machine.cpu.pc === h, halt, 20000));
  await openDrive(0);
  const [mpd] = await Promise.all([page.waitForEvent('download'), page.click('#driveDownload')]);
  await mpd.saveAs(saved);
  check('disks: Multi-Pak: Download gives the image with the sector the firmware wrote', fs.readFileSync(saved).equals(want0) && (await page.evaluate(() => window.emu.machine.cartPort.type)) === 'multi');
  fs.unlinkSync(saved);
  if (shotDir) await page.locator('#cartSlot').screenshot({ path: path.join(shotDir, 'multipak-disk.png') });

  // ---- the Dragon Alpha: its own two drives, no cartridge (alpha-write.asm as its boot ROM)
  const aw = assembleFile(path.join(FDC, 'alpha-write.asm'), '6809');
  await pickMachine(page, 'dgnalpha');
  await dropFiles(page, [['alpha_bt_10.rom', Buffer.from(romImage(aw, 0xA000, 0x2000, 0x00))], ['alpha_ba.rom', Buffer.alloc(0x4000, 0x12)]]);
  check('disks: Alpha: the card says "built-in" and shows two drives', await waitFor(page, () => /Drives · built-in · click a drive to insert/.test(document.getElementById('driveSlot').textContent)
    && document.querySelectorAll('#drives [data-drive]').length === 2), await page.textContent('#driveSlot'));
  await insertFile(0, 'alpha.vdk', d0);
  await insertFile(1, 'alpha1.vdk', d1);
  check('disks: Alpha: disks go into the built-in drives, no cartridge plugged in', await waitFor(page, () => window.emu.session.diskStatus().drives.length === 2 && window.emu.machine.cartPort === null));
  // the store refuses the writes: the drive is marked "not saved" and its menu says why; Download still has them
  await page.evaluate(() => { const st = window.emu.session.media; st.__writeRange = st.writeRange; st.writeRange = () => Promise.reject(Object.assign(new Error('the disk is full'), { code: 'quota' })); });
  await page.click('#btnReset');
  check('disks: Alpha: the firmware reaches HALT', await waitFor(page, (h) => window.emu.machine.cpu.pc === h, aw.symbols.get('HALT'), 20000));
  await page.evaluate(() => window.emu.session.flushDisks());
  check('disks: a refused write marks the drive "not saved" in orange', await waitFor(page, () => { const b = document.querySelector('#drives [data-drive="0"]'); return b.classList.contains('unsaved') && /not saved/.test(b.textContent); }));
  await openDrive(0);
  check('disks: ... and its menu says why and that Download keeps the changes', /No space left .*Download keeps them/.test(await page.textContent('#driveMenu')), await page.textContent('#driveMenu'));
  if (shotDir) await page.locator('#driveSlot').screenshot({ path: path.join(shotDir, 'drives-unsaved.png') });
  const [ad] = await Promise.all([page.waitForEvent('download'), page.click('#driveDownload')]);
  await ad.saveAs(saved);
  check('disks: Alpha: Download gives the written image (the store refused it)', fs.readFileSync(saved).equals(written(d0, 2)));
  fs.unlinkSync(saved);
  await page.evaluate(() => { const st = window.emu.session.media; st.writeRange = st.__writeRange; });
  if (shotDir) await page.locator('#driveSlot').screenshot({ path: path.join(shotDir, 'drives-alpha.png') });
  // the MC-10 has no drives
  await pickMachine(page, 'mc10');
  check('disks: no drives card on the MC-10', !(await page.isVisible('#driveSlot')));
  check('disks: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

// Service workers are blocked here: the routes below and the checks' own must see every request, and with the
// Playwright that CI pins (1.55), a request the page makes through sw.js is fetched by the service worker past
// ctx.route, straight to the server (a ?rom= the route should have answered reached it as a missing file)
async function guardedContext(browser, archive) {
  const ctx = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
  const isArchive = (u) => { try { return /(^|\.)colorcomputerarchive\.com$/i.test(new URL(u).hostname); } catch (e) { return false; } };
  await ctx.route((url) => isArchive(url.href), (route) => { archive.push(route.request().url()); route.abort(); });
  ctx.on('request', (req) => { if (isArchive(req.url()) && !archive.includes(req.url())) archive.push(req.url()); });
  return ctx;
}
// drop [name, bytes] files on the screen; `folder` wraps them in a directory entry (as a dragged folder). The page
// takes a drop asynchronously: every caller waits for what the drop must lead to.
const dropFiles = (page, files, folder = null, target = 'screenWrap') => page.evaluate(async ([files, folder, target]) => {
  const objs = files.map(([name, bytes]) => new File([new Uint8Array(bytes)], name));
  let dt;
  if (folder) {
    const fileEntry = (f) => ({ isFile: true, isDirectory: false, name: f.name, file: (ok) => ok(f) });
    const dir = { isFile: false, isDirectory: true, name: folder, createReader() { let done = false; return { readEntries: (ok) => { ok(done ? [] : objs.map(fileEntry)); done = true; } }; } };
    dt = { items: [{ kind: 'file', webkitGetAsEntry: () => dir }], files: [] };
  } else { dt = new DataTransfer(); objs.forEach((f) => dt.items.add(f)); }
  const ev = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dt });
  document.getElementById(target).dispatchEvent(ev);
}, [files.map(([n, b]) => [n, [...b]]), folder, target]);
// the Add ROMs screen (#add-roms) is open, or open it
const romsOpen = () => location.hash === '#add-roms' && !document.getElementById('romCard').hidden && document.body.classList.contains('roms-open')
  && getComputedStyle(document.querySelector('.layout')).display === 'none';
const openRoms = async (page) => { await page.evaluate(() => { location.hash = '#add-roms'; }); await waitFor(page, romsOpen); };
const romStatus = (page, id) => page.evaluate((id) => window.emu.session.machineRoms(id).sockets.map((s) => s.status).join(','), id);
// switch machine through the header menu, confirming the switch
async function pickMachine(page, id) {
  await page.click('#machineBtn');
  await waitFor(page, () => !document.getElementById('machineMenu').hidden);
  await page.click(`#machineMenu button[data-machine="${id}"]`);
  if (await page.isVisible('#switchConfirm')) await page.click('#btnSwitch');
  await waitFor(page, (id) => window.emu.machine.id === id, id);
  // a couple of frames of the new machine; a paused one runs none (the switch keeps the pause), so it is only drawn
  if (await page.evaluate(() => document.body.classList.contains('paused') || window.emu.session.paused)) await painted(page); else await emuFrames(page, 2);
}
// the Debugger screen (#debugger), where the assembler lives
const openDebugger = async (page) => { await page.evaluate(() => { location.hash = '#debugger'; }); await page.waitForSelector('#debugView:not([hidden])'); };
// open a tab of the settings drawer
const openTab = (page, name) => page.click(`[role="tab"]:text-is("${name}")`);
// The stub firmware's own prompt, for a check that types POKEs into it: a power-on of the machine itself, below the
// page. The page's Power cycle no longer lands there without ROMs: it starts the welcome menu.
// It waits for the page's start first (the welcome menu it may be starting would land on top otherwise).
const stubPrompt = async (page) => {
  await waitFor(page, () => window.emu && window.emu.started);
  await page.evaluate(() => { const s = window.emu.session; s.endWelcome(); s.stubRun = null; s.keys.clear(); window.emu.machine.reset(true); });
};
// The condition waits (tools/browser-check-lib.js makeWaits). Waits are on conditions, never fixed times: on a loaded
// machine the page and the emulation run slower than real time.
// waitFor(page, fn, arg, ms): true as soon as fn holds in the page; after ms (a limit, not a delay; 30 s by default)
//   it is a FAIL, printed with where it was called, and returns false. An evaluate that throws inside the page
//   (window.emu not there yet while the page starts) is "not ready yet"; one that fails because the page crashed,
//   closed or navigated away is a FAIL at once, in this wait and every other.
// maybeWaitFor(why, page, fn, arg, ms): the same wait where a timeout is an expected outcome (a check that something
//   does NOT happen); `why` says so, and its timeout fails nothing. Its timeout counts only if the condition was read
//   every time and the page is still the same live document at the end: any evaluate error, a crash or a navigation
//   is a FAIL, and it returns null rather than false, so a negative check tests === false.
// waitForFrames(page, fn, arg, frames, wallMs): a bound in the machine's own time, for what the machine itself takes
//   time to do (a program's pause). A page slowed by load runs fewer frames a second and gets the same machine time,
//   not the same wall time; wallMs only stops a page that has hung. Running out of either is a FAIL.
const { waitFor, maybeWaitFor, waitForFrames } = lib.makeWaits(run, __filename);
// the page is fully up: its storage init has run and the debug handle is there
const ready = (page) => waitFor(page, () => !!window.emu && window.emu.ready === true);
// the page has started: storage open, the visit's program (welcome, LIZA) running, ?rom= loaded
// the page has taken in its link (ROMs, media, a share link's snapshot: window.emu.linkDone); the limit only stops a
// page that hangs, it is not a time the link must open in
const linkIn = (page) => page.waitForFunction(() => !!window.emu && window.emu.linkDone === true, null, { timeout: 180000, polling: 50 });
const started = (page) => waitFor(page, () => !!window.emu && window.emu.started === true);
// n emulated frames have run from now (the frame loop is going)
// (the wall-clock limit only stops a page that has hung: 30 s, and longer for a long run of frames)
const emuFrames = async (page, n) => {
  await waitFor(page, () => !!(window.emu && window.emu.machine));
  const f0 = await page.evaluate(() => window.emu.machine.frameCount);
  return waitFor(page, ([f0, n]) => window.emu.machine.frameCount >= f0 + n, [f0, n], Math.max(30000, n * 500));
};
// every key typed so far has been read by the machine (the no-ROM stub's key queue is empty), then a frame
const keysTaken = async (page) => { await waitFor(page, () => window.emu.machine.stubKeys.length === 0); await emuFrames(page, 2); };
// the browser has laid out and painted (two animation frames)
const painted = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
// n animation frames have passed: n turns of the page's frame loop, the window a check that something does NOT happen
// (a paused machine stays stopped, nothing is redrawn) waits for. Counted in the page's own ticks, not wall time, so
// a page slowed by load gets the same number of chances to do the wrong thing.
const ticks = (page, n) => page.evaluate((n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
// the machine has drawn new frames and the browser has shown them (after a display setting changes)
const redrawn = async (page) => { await emuFrames(page, 2); await painted(page); };

async function romInputChecks(browser, base, check) {
  const archive = [];
  const ctx = await guardedContext(browser, archive);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const D1 = fake(16384, 3), D2 = fake(16384, 4), C3 = fake(32768, 5), MC = fake(8192, 6), AL = fake(8192, 7), CB = fake(8192, 8);
  await page.goto(`${base}?machine=coco`);
  await started(page);
  // several files at once; a program in the same drop still runs
  const demo = fs.readFileSync(path.join(ROOT, 'examples/demo.bin'));
  await dropFiles(page, [['d64_1.rom', D1], ['d64_2.rom', D2], ['demo.bin', demo]]);
  const okD64 = await waitFor(page, () => window.emu.session.machineRoms('dragon64').bootable && window.emu.session.machineRoms('tanodr64').bootable);
  check('drop: several ROM files set up every machine they fit', okD64, await romStatus(page, 'dragon64'));
  check('drop: a program in the same drop goes to the program loader (a Dragon binary on the CoCo: the switch offer)',
    await page.isVisible('#mediaOffer') && /demo\.bin is a DragonDOS binary for a Dragon/.test(await page.textContent('#mediaOffer')), await page.textContent('#mediaOffer'));
  await page.click('#btnMediaAnyway');
  // a dragged folder: ROMs taken, other files ignored and listed
  await dropFiles(page, [['coco3.rom', C3], ['readme.txt', Buffer.from('notes')]], 'MyROMs');
  check('drop: a folder is walked, its ROMs taken', await waitFor(page, () => window.emu.session.machineRoms('coco3').bootable));
  check('drop: other files in the folder are ignored and reported (under Details)', /Not ROMs: MyROMs\/readme\.txt/.test(await page.textContent('#toast')), await page.textContent('#toast'));
  // a ZIP (deflated ROM + a text file)
  await dropFiles(page, [['roms.zip', zip([['sub/alice.rom', AL, 8], ['info.txt', Buffer.from('hi'), 0]])]]);
  check('drop: a ZIP is opened and its ROMs taken', await waitFor(page, () => window.emu.session.machineRoms('alice').bootable));
  check('drop: other files in the ZIP are ignored and reported (under Details)', /Not ROMs: .*info\.txt/.test(await page.textContent('#toast')), await page.textContent('#toast'));
  // pickers: a real folder; several files including a ZIP (an unknown loose file fits the machine in use by size)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-roms-'));
  fs.writeFileSync(path.join(dir, 'mc10.rom'), MC); fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  await page.setInputFiles('#folderRom', dir);
  check('picker: a folder', await waitFor(page, () => window.emu.session.machineRoms('mc10').bootable));
  fs.rmSync(dir, { recursive: true });
  await page.setInputFiles('#fileRom', [{ name: 'mydump.bin', mimeType: 'application/octet-stream', buffer: CB },
    { name: 'more.zip', mimeType: 'application/zip', buffer: zip([['extbas11.rom', fake(8192, 9), 8]]) }]);
  check('picker: several files and a ZIP', await waitFor(page, () => window.emu.session.machineRoms('coco').sockets.every((s) => s.crc)), await romStatus(page, 'coco'));
  // ROM pack: save, then restore in a fresh browser profile
  await openRoms(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btnRomPack')]);
  const packFile = path.join(os.tmpdir(), `cloadm-pack-${process.pid}.zip`);
  await download.saveAs(packFile);
  check('ROM pack: saved as one file', download.suggestedFilename() === 'cloadm-roms.zip' && fs.statSync(packFile).size > 16384 * 2);
  const ctx2 = await guardedContext(browser, archive);
  const page2 = await ctx2.newPage();
  await page2.goto(`${base}?machine=coco`); await started(page2);
  await page2.setInputFiles('#fileRom', packFile);
  const restored = await waitFor(page2, () => ['dragon64', 'tanodr64', 'coco3', 'alice', 'mc10', 'coco'].every((id) => window.emu.session.machineRoms(id).bootable));
  const sameCrcs = JSON.stringify(await page.evaluate(() => window.emu.session.roms.sockets())) === JSON.stringify(await page2.evaluate(() => window.emu.session.roms.sockets()));
  check('ROM pack: restored in a fresh browser profile, socket for socket', restored && sameCrcs);
  check('ROM pack: the machine in use boots its restored ROMs', await page2.evaluate(() => window.emu.machine.hasRom));
  fs.rmSync(packFile);
  await ctx2.close();
  // URL configuration as share links write it
  await page.goto(`${base}?machine=coco3&ram=128`); await started(page);
  check('URL configuration: machine and options', await page.evaluate(() => window.emu.machine.id === 'coco3' && window.emu.machine.config.ram === 128));
  check('share link: machine and options only', await page.evaluate(() => { const u = new URL(window.emu.session.shareUrl(location.href)); return [...u.searchParams.keys()].join() === 'machine,cpu,ram,becker,ssc'; }));
  // ?rom= never requests the archive
  await page.goto(`${base}?machine=coco&rom=${encodeURIComponent('https://colorcomputerarchive.com/repo/ROMs/XRoar/bas13.rom')}`);
  check('?rom= on the Color Computer Archive is refused', await waitFor(page, () => /never downloads ROMs/.test(document.getElementById('toast').textContent)), await page.textContent('#toast'));
  check('no request ever went to colorcomputerarchive.com', archive.length === 0, archive.join(' '));
  // a URL of the user's that redirects to the archive: the redirect is not followed
  let movedAsked = 0;
  await ctx.route((url) => url.pathname.endsWith('/moved.rom'), (route) => { movedAsked++; route.fulfill({ status: 302, headers: { location: 'https://colorcomputerarchive.com/repo/ROMs/XRoar/bas13.rom' } }); });
  await page.goto(`${base}?machine=coco&rom=${encodeURIComponent(base + 'moved.rom')}`);
  // waited for: the page's answer to its fetch of the ROM URL, so that fetch has finished (through the route above)
  // before the context is closed and its routes go with it; a request still in flight then would reach the server
  await waitFor(page, () => /Could not load ROM from URL/.test(document.getElementById('toast').textContent));
  // the redirect answered the page's fetch (it was not a missing file at the server that refused it)
  check('?rom= that redirects: refused, saying so, the redirect not followed', movedAsked === 1 && /redirect/i.test(await page.textContent('#toast')) && archive.length === 0,
    `${movedAsked} ${await page.textContent('#toast')} ${archive.join(' ')}`);
  check('ROM input: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

// no pop from the speaker: with sound unlocked and a program holding the DAC high (raised in single DAC steps,
// so its own steps are at most 0.5/63), the samples played across a power cycle, a reset, reloading the program,
// pause and resume, turbo on and off, sound off and on, and a machine switch never jump by more than 0.01
// (tests/audio.test.js gives the reasoning for the bound)
const DAC_HIGH = ` ORG $3000
 ORCC #$50
 LDA $FF01
 ANDA #$F7
 ORA #$30
 STA $FF01
 LDA $FF03
 ANDA #$F7
 ORA #$30
 STA $FF03
 LDA $FF21
 ANDA #$FB
 STA $FF21
 LDA #$FE
 STA $FF20
 LDA $FF21
 ORA #4
 STA $FF21
 LDA $FF23
 ORA #$38
 STA $FF23
 CLRB
UP STB $FF20
 LDX #300
D LEAX -1,X
 BNE D
 ADDB #4
 CMPB #$FC
 BNE UP
H BRA H
 END`;
// cartridges through the page: the board select, the cartridge port's file input, the Multi-Pak API
async function cartridgeChecks(browser, base, check) {
  const Emu = require('../tests/load')();
  const image = (src, size) => {
    const img = new Uint8Array(size);
    for (const s of Emu.assemble(src, '6809').segments) img.set(s.data, s.addr - 0xC000);
    return Buffer.from(img);
  };
  // a tone on the Games Master's PSG, a value on the Orchestra-90's left DAC, a bank switch on a banked cartridge
  const gmc = image('        ORG $C000\n        LDA #$8E\n        STA $FF41\n        LDA #$0F\n        STA $FF41\n        LDA #$90\n        STA $FF41\nL       BRA L\n', 0x8000);
  const orch = image('        ORG $C000\n        LDA #$C0\n        STA $FF7A\nL       BRA L\n', 0x2000);
  const banked = image('        ORG $C000\n        LDA #$02\n        STA $FF40\nL       BRA L\n', 0xC000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?machine=coco`);
  await started(page);
  // done: the cartridge is in and its code has run (the condition the check then asserts)
  const insert = async (board, name, buffer, done) => {
    await page.selectOption('#selCartBoard', board);
    await page.setInputFiles('#fileCart', { name, mimeType: 'application/octet-stream', buffer });
    await waitFor(page, done);
    return page.evaluate(() => ({ type: window.emu.machine.cartPort && window.emu.machine.cartPort.type, label: document.getElementById('btnCart').textContent }));
  };
  let r = await insert('gmc', 'tune.ccc', gmc, () => { const c = window.emu.machine.cartPort; return c && c.type === 'gmc' && c.psg.volume[0] > 0; });
  const vol = await page.evaluate(() => window.emu.machine.cartPort.psg.volume[0]);
  check('cartridge board select: Games Master; the cartridge plays its PSG', r.type === 'gmc' && /Games Master/.test(r.label) && vol > 0, `${r.type} "${r.label}" volume ${vol}`);
  r = await insert('orch90', 'orch.rom', orch, () => { const c = window.emu.machine.cartPort; return c && c.type === 'orch90' && c.left === 0xC0; });
  const left = await page.evaluate(() => window.emu.machine.cartPort.left);
  check('cartridge board select: Orchestra-90 DAC written', r.type === 'orch90' && left === 0xC0, `${r.type} left ${left}`);
  r = await insert('auto', 'big.rom', banked, () => { const c = window.emu.machine.cartPort; return c && c.type === 'banked' && c.pos === 2; });
  const pos = await page.evaluate(() => window.emu.machine.cartPort.pos);
  check('automatic board: a 48K image goes on the banked board, which switches banks', r.type === 'banked' && pos === 2, `${r.type} bank ${pos}`);
  const multi = await page.evaluate(([a, b]) => {
    const s = window.emu.session;
    const msg = s.insertMultiPak([{ name: 'a.ccc', bytes: new Uint8Array(a), board: 'banked' }, null, null, { name: 'tune.ccc', bytes: new Uint8Array(b), board: 'gmc' }]);
    const m = window.emu.machine;
    return { msg, type: m.cartPort.type, slots: m.cartPort.slots.map((c) => c && c.type).join(), sel: m.read(0xFF7F) };
  }, [[...banked], [...gmc]]);
  check('Multi-Pak through the Session: slots filled, slot 4 selected at reset', multi.type === 'multi' && multi.slots === 'banked,,,gmc' && multi.sel === 0xFF, JSON.stringify(multi));
  // the Multi-Pak panel in the cartridge port: slot 1 a banked image, slot 4 the Games Master tune, switch on 4
  await page.click('#mpak summary');
  const pick = async (n, name, buffer) => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(`#btnMpSlot${n}`)]);
    await chooser.setFiles({ name, mimeType: 'application/octet-stream', buffer });
  };
  await pick(1, 'pages.rom', banked);
  await pick(4, 'tune.ccc', gmc);
  await page.selectOption('#selMpBoard4', 'gmc');
  await page.selectOption('#selMpSwitch', '4');
  await page.click('#btnMpInsert');
  await waitFor(page, () => { const c = window.emu.machine.cartPort; return c && c.type === 'multi' && c.slots[3] && c.slots[3].psg.volume[0] > 0; });
  const mp = await page.evaluate(() => {
    const m = window.emu.machine, c = m.cartPort;
    return { type: c && c.type, slots: c && c.slots.map((x) => x && x.type).join(), sel: m.read(0xFF7F), vol: c && c.slots[3] && c.slots[3].psg.volume[0],
      label: document.getElementById('btnCart').textContent, rows: [1, 2, 3, 4].map((n) => document.getElementById(`btnMpSlot${n}`).textContent).join('|'),
      msg: document.getElementById('toast').textContent };
  });
  check('Multi-Pak panel: slots chosen in the page go in, the switch\'s slot runs (its PSG plays)',
    mp.type === 'multi' && mp.slots === 'banked,,,gmc' && mp.sel === 0xFF && mp.vol > 0 && mp.label === 'Multi-Pak Interface' && mp.rows === 'pages.rom|Empty|Empty|tune.ccc', JSON.stringify(mp));
  // a board that cannot hold the image: refused with the reason on the status line, the Multi-Pak stays
  await page.selectOption('#selMpBoard1', 'orch90');
  await page.click('#btnMpInsert');
  await waitFor(page, () => document.getElementById('toast').classList.contains('error'));
  const bad = await page.evaluate(() => ({ msg: document.getElementById('toast').textContent, err: document.getElementById('toast').className, type: window.emu.machine.cartPort.type }));
  check('Multi-Pak panel: an image too big for its board is refused with the reason', /Multi-Pak: Orchestra-90: .*up to 8K/.test(bad.msg) && /error/.test(bad.err) && bad.type === 'multi', JSON.stringify(bad));
  // the Multi-Pak section shows only on the machines it has been compared with MAME on (profiles marked multiPak:
  // the Color Computer 1/2 and its clones, the Dragon 32 and 64, the CoCo 3); not on the other Dragons and the CP
  // 400, which have no comparison yet, and not on the MC-10, which has no cartridge port at all
  const mpVisible = () => page.evaluate(() => {
    const d = document.getElementById('mpak'), slot = document.getElementById('cartSlot');
    return { mpak: !d.hidden && !!d.offsetParent, slot: !slot.hidden };
  });
  const atCoco = await mpVisible();
  check('Multi-Pak section: shown on a Color Computer', atCoco.mpak && atCoco.slot, JSON.stringify(atCoco));
  // switch, then wait until the page shows the new machine (not a fixed delay: a loaded runner needs longer)
  const switchTo = async (id) => {
    await page.evaluate((m) => window.emu.session.switchMachine(m), id);
    await page.waitForFunction((m) => window.emu.machine && window.emu.machine.profile.id === m, id, { timeout: 15000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    return mpVisible();
  };
  for (const id of ['dragon64', 'coco3']) {
    const v = await switchTo(id);
    check(`Multi-Pak section: shown on ${id}, compared with MAME`, v.mpak && v.slot, JSON.stringify(v));
  }
  // not, until they are compared with MAME, on the Dragon 200, the Dragon 200-E and the CP 400 (a CoCo clone)
  for (const id of ['dragon200', 'dragon200e', 'cp400']) {
    const v = await switchTo(id);
    check(`Multi-Pak section: not shown on ${id}, not compared with MAME yet`, !v.mpak && v.slot, JSON.stringify(v));
  }
  const atMc10 = await switchTo('mc10');
  check('Multi-Pak section: not shown on the MC-10', !atMc10.mpak, JSON.stringify(atMc10));
  const back = await switchTo('coco');
  check('Multi-Pak section: shown again on switching back to a Color Computer', back.mpak, JSON.stringify(back));
  if (shotDir) await (await page.$('#cartSlot')).screenshot({ path: path.join(shotDir, 'multipak-panel.png') });
  check('cartridges: no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

// The Speech/Sound Pak as a BOARD on the page (stage 3): the board menu offers it on the four models whose
// lockstep with MAME matched (CoCo 1/2, CoCo 2B, CoCo 3, Dragon 64), the Insert button runs OUR tone firmware as
// the PIC, and the machine's music path runs. Every ROM here is built by our own tools (tools/mame-diff/ssc/), never a real dump.
async function sscBoardChecks(browser, base, check) {
  const { toneFirmware } = require('../tools/mame-diff/ssc/audio.js');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?machine=coco`);
  await started(page);
  // the board menu names it, music only, and offers it on the CoCo
  const menu = await page.evaluate(() => {
    const o = document.querySelector('#selCartBoard option[value="ssc"]');
    return o ? { text: o.textContent, hidden: o.hidden } : null;
  });
  check('Speech/Sound Pak: the board menu names it "music only; speech not yet", offered on the CoCo',
    menu && /music only/.test(menu.text) && /speech not yet/.test(menu.text) && menu.hidden === false, JSON.stringify(menu));
  // the ROM panel shows the Pak's PIC socket (required) and its optional speech socket
  await openRoms(page);
  const sockets = await page.evaluate(() => [...document.querySelectorAll('#romSockets .socket')]
    .map((c) => ({ id: c.dataset.socket, status: c.dataset.ssc })).filter((s) => s.id && s.id.startsWith('ssc-')));
  check('Speech/Sound Pak: the ROM panel shows its PIC and speech sockets, the PIC required',
    sockets.some((s) => s.id === 'ssc-tms7040' && s.status === 'missing-required') && sockets.some((s) => s.id === 'ssc-sp0256' && s.status === 'missing-optional'),
    JSON.stringify(sockets));
  await page.evaluate(() => { location.hash = ''; });
  await waitFor(page, () => !document.body.classList.contains('roms-open'));
  // insert it with no ROM: refused with a clear message naming the PIC ROM
  await page.selectOption('#selCartBoard', 'ssc');
  const label = await page.textContent('#btnCart');
  check('Speech/Sound Pak: on its board the button says it inserts the Pak, not a file', /Insert the Speech\/Sound Pak/.test(label), label);
  await page.click('#btnCart');
  await waitFor(page, () => document.getElementById('toast').classList.contains('error'));
  const noRom = await page.evaluate(() => ({ msg: document.getElementById('toast').textContent, cls: document.getElementById('toast').className, type: window.emu.machine.cartPort && window.emu.machine.cartPort.type }));
  check('Speech/Sound Pak: with no ROM it is refused, naming pic-7040-510.bin',
    /pic-7040-510\.bin/.test(noRom.msg) && /error/.test(noRom.cls) && !noRom.type, JSON.stringify(noRom));
  // Add our own ROMs through the page: the tone firmware as the PIC, and our 6809 firmware (with MUXON, which
  // opens the CoCo sound mux from the PIA control registers) as the machine's BASIC. The 6809 side is REQUIRED,
  // not a convenience: the PIC is held in reset until the 6809 writes $FF7D, so nothing programs the AY without
  // it. Both images are ours (tools/mame-diff/ssc/), never a real dump.
  const { buildAsm } = require('../tools/mame-diff/ssc/gen-roms.js');
  const { romImage } = require('../tools/mame-diff/lib/firmware.js');
  await page.setInputFiles('#fileRom', [
    { name: 'pic-7040-510.bin', mimeType: 'application/octet-stream', buffer: Buffer.from(toneFirmware()) },
    { name: 'bas12.rom', mimeType: 'application/octet-stream', buffer: Buffer.from(romImage(buildAsm({ mux: true }), 0xA000, 0x2000, 0x12)) },
  ]);
  await waitFor(page, () => window.emu.session.sscRoms().find((s) => s.id === 'tms7040').status === 'loaded');
  await page.selectOption('#selCartBoard', 'ssc');
  await page.click('#btnCart');
  await waitFor(page, () => { const c = window.emu.machine.cartPort; return c && c.type === 'ssc' && /Speech\/Sound Pak inserted/.test(document.getElementById('toast').textContent); });
  const ins = await page.evaluate(() => {
    const m = window.emu.machine, c = m.cartPort;
    return { msg: document.getElementById('toast').textContent, type: c && c.type, name: c && c.name,
      btn: document.getElementById('btnCart').textContent, hasAy: !!(c && c.ay), sp: c && c.sp0256Data };
  });
  check('Speech/Sound Pak: our tone firmware as the PIC; the Pak goes in (music, no speech ROM needed)',
    ins.type === 'ssc' && ins.name === 'Speech/Sound Pak' && ins.hasAy && ins.sp === null && /Speech\/Sound Pak inserted/.test(ins.msg),
    JSON.stringify(ins));
  // the card's own clock runs the PIC, whose tone firmware programs the AY: the AY's mixer leaves its reset value
  const plays = await waitFor(page, () => {
    const c = window.emu.machine.cartPort;
    return !!(c && c.ay && c.ay.regs && c.ay.regs[7] !== 0);
  }, null, 8000);
  const regs = await page.evaluate(() => { const a = window.emu.machine.cartPort.ay; return { mixer: a.regs[7], volA: a.regs[8], volB: a.regs[9], period: a.regs[0] | (a.regs[1] << 8) }; });
  check('Speech/Sound Pak: the PIC runs our tone firmware and programs the AY (mixer and volumes set)',
    plays && regs.mixer !== 0 && (regs.volA > 0 || regs.volB > 0), JSON.stringify(regs));
  // the button now shows the board's name and the machine keeps running
  await emuFrames(page, 5);
  const after = await page.evaluate(() => ({ btn: document.getElementById('btnCart').textContent, frames: window.emu.machine.frameCount }));
  check('Speech/Sound Pak: the cartridge button shows it, and the machine runs', /Speech\/Sound Pak/.test(after.btn) && after.frames > 0, JSON.stringify(after));
  // offered on the Dragon 64 too, which is what its `--ssc` lockstep and outcome comparison establish. The
  // machine is switched rather than reloaded, so the board menu has to update with it.
  await page.evaluate(() => window.emu.session.switchMachine('dragon64'));
  await page.waitForFunction(() => window.emu.machine && window.emu.machine.profile.id === 'dragon64', null, { timeout: 15000 });
  const onDragon = await page.evaluate(() => {
    const o = document.querySelector('#selCartBoard option[value="ssc"]');
    return { hidden: o && o.hidden, offers: window.emu.session.offersSsc, port: !!window.emu.machine.hasCartridgePort };
  });
  check('Speech/Sound Pak: offered on the Dragon 64 (its board-menu option is shown)',
    onDragon.hidden === false && onDragon.offers === true && onDragon.port === true, JSON.stringify(onDragon));
  // ...but a machine the Pak is NOT verified on still refuses it, so the offer is per model and not per family
  await page.evaluate(() => window.emu.session.switchMachine('dragon32'));
  await page.waitForFunction(() => window.emu.machine && window.emu.machine.profile.id === 'dragon32', null, { timeout: 15000 });
  const dragon32 = await page.evaluate(() => {
    const o = document.querySelector('#selCartBoard option[value="ssc"]');
    let msg = null; try { window.emu.session.insertSsc(); } catch (e) { msg = e.message; }
    return { hidden: o && o.hidden, msg };
  });
  check('Speech/Sound Pak: not offered on a Dragon 32, and the Session refuses it with a clear message',
    dragon32.hidden === true && /can't take the Speech\/Sound Pak/.test(dragon32.msg), JSON.stringify(dragon32));
  // back to the 64: it goes in with the same PIC ROM and the card's AY takes the tone firmware's programming, so
  // the Pak inserts and its PIC runs on this machine too (the offer itself rests on the `--ssc` lockstep and
  // `compare.js` runs, not on this case: the same firmware programs the AY on any model forced to take it).
  //
  // The 6809 side needs the Dragon's own ROM layout. `ssc.asm` is `ORG $A000` with its vectors at $BFF2, and the
  // Dragon 64's BASIC is one 16K chip at $8000 in either of two banks (PIA1 PB2), so the SAME assembled code is
  // laid into a 16K image covering $8000-$BFFF (`romImage(asm, 0x8000, 0x4000)`: the code stays at $A000, the
  // bytes below it are the $12 fill) and loaded under the 32K-mode name. The vectors at $BFF2 are the real
  // build's, so the machine starts where it should - but this check does not PROVE the vector: measured, with
  // $BFFE patched to $1234 the AY is still programmed (mixer 56, volA 12), so the assertion would pass on a
  // machine whose reset vector was wrong. The vector is covered by `run.js dragon64 --ssc`, which compares the
  // trace from reset.
  await page.evaluate(() => window.emu.session.switchMachine('dragon64'));
  await page.waitForFunction(() => window.emu.machine && window.emu.machine.profile.id === 'dragon64', null, { timeout: 15000 });
  await page.setInputFiles('#fileRom', [
    { name: 'd64_1.rom', mimeType: 'application/octet-stream', buffer: Buffer.from(romImage(buildAsm({ mux: true }), 0x8000, 0x4000, 0x12)) },
  ]);
  const bootable = await waitFor(page, () => window.emu.session.machineRoms('dragon64').bootable, null, 8000);
  await page.selectOption('#selCartBoard', 'ssc');
  await page.click('#btnCart');
  await page.waitForTimeout(500);
  const dragonPak = await page.evaluate(() => {
    const m = window.emu.machine, c = m.cartPort;
    return { type: c && c.type, msg: document.getElementById('toast').textContent, btn: document.getElementById('btnCart').textContent };
  });
  const dragonPlays = await waitFor(page, () => {
    const c = window.emu.machine.cartPort;
    return !!(c && c.ay && c.ay.regs && c.ay.regs[7] !== 0);
  }, null, 8000);
  const dragonRegs = await page.evaluate(() => { const a = window.emu.machine.cartPort.ay; return { mixer: a.regs[7], volA: a.regs[8] }; });
  check('Speech/Sound Pak: inserts on the Dragon 64 and its PIC programs the AY there',
    bootable && dragonPak.type === 'ssc' && /Speech\/Sound Pak/.test(dragonPak.btn) && dragonPlays && dragonRegs.mixer !== 0 && dragonRegs.volA > 0,
    JSON.stringify({ bootable, pak: dragonPak, regs: dragonRegs }));
  check('Speech/Sound Pak: no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

// the same set-up as DAC_HIGH, then a square wave on the DAC (two levels, a delay loop each): a steady tone
const DAC_SQUARE = DAC_HIGH.replace(/ CLRB\n[\s\S]*$/, ` LDA #$FC
L STA $FF20
 LDX #120
D1 LEAX -1,X
 BNE D1
 EORA #$7C
 BRA L
 END`);
// Counted in the page from before its own scripts run: every AudioWorkletNode made and every createScriptProcessor
// call. `noWorklet` takes AudioWorklet away (an insecure context or an old browser); `badModule` makes its module
// fail to load; `hangModule` makes it never load; `slowModule` makes it load only after 4 s, past the page's 3 s
// wait; `processorError` has the running processor fail: each must fall back to the ScriptProcessorNode. The worklet
// nodes' connect and disconnect calls are counted too.
const audioNodeCounter = ({ noWorklet = false, badModule = false, hangModule = false, slowModule = false, processorError = false } = {}) => {
  window.audioNodes = { worklet: 0, script: 0, connected: 0, disconnected: 0 };
  if (noWorklet) Object.defineProperty(AudioContext.prototype, 'audioWorklet', { configurable: true, get: () => undefined });
  if (badModule) AudioWorklet.prototype.addModule = () => Promise.reject(new Error('module failed to load (test)'));
  if (hangModule) AudioWorklet.prototype.addModule = () => new Promise(() => {});
  if (slowModule) {
    const add = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = function (...a) {
      return new Promise((res) => setTimeout(res, 4000)).then(() => add.apply(this, a)).then((r) => { window.slowLoaded = true; return r; });
    };
  }
  const W = window.AudioWorkletNode;
  window.AudioWorkletNode = class extends W {
    constructor(...a) {
      super(...a); window.audioNodes.worklet++;
      // the processor failing once running (as a throw in its process() would): the node fires processorerror
      if (processorError) setTimeout(() => this.dispatchEvent(new Event('processorerror')), 300);
    }
    connect(...a) { window.audioNodes.connected++; return super.connect(...a); }
    disconnect(...a) { window.audioNodes.disconnected++; return super.disconnect(...a); }
  };
  const csp = BaseAudioContext.prototype.createScriptProcessor;
  BaseAudioContext.prototype.createScriptProcessor = function (...a) { window.audioNodes.script++; return csp.apply(this, a); };
};

// Sound through the AudioWorkletNode (js/host/audio.js, js/host/audio-worklet.js). The worklet's test hook ({ tap:
// true }) posts back a copy of every block it plays; the page records every chunk the output stage makes. So:
// - no pop (DAC_HIGH, the steps below) is checked on what the worklet really played;
// - what it played EQUALS what the emulator made, value for value (tolerance 0): every block of queued samples at
//   full gain, at the index it reports, across all the steps; the blocks' indices run on without a gap or repeat;
// - the tone of DAC_SQUARE comes out at the frequency the machine plays it (the core's own events give it);
// - mute fades to exact silence and back; volume scales the output; pause, turbo, a hidden tab and machine
//   switches keep the one context and the one node (no leak); no ScriptProcessorNode and no deprecation warning.
async function audioChecks(browser, base, check) {
  const Emu = require('../tests/load')();
  const bin = [...Emu.toBinary(Emu.assemble(DAC_HIGH, '6809'))];
  const square = [...Emu.toBinary(Emu.assemble(DAC_SQUARE, '6809'))];
  const ctx = await browser.newContext();
  await ctx.addInitScript(audioNodeCounter);
  const page = await ctx.newPage();
  const errors = [], warnings = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (/ScriptProcessor|deprecat/i.test(m.text())) warnings.push(m.text()); });
  await page.goto(`${base}?machine=dragon64`);
  await started(page);
  await stubPrompt(page);
  check('sound: no audio node before the unlock gesture', await page.evaluate(() => !window.emu.audio.ctx && window.audioNodes.worklet === 0 && window.audioNodes.script === 0));
  await page.mouse.click(5, 5);                       // unlocks sound
  const running = await maybeWaitFor('if it never comes, the next check FAILs with what the page has instead, and the group stops there',
    page, () => window.emu.audioRunning() && window.emu.audio.path === 'worklet', null, 15000);
  const audioState = () => page.evaluate(() => {
    const a = window.emu.audio, r = performance.getEntriesByType('resource').filter((e) => /audio-worklet/.test(e.name));
    return { path: a.path, fallback: a.fallback, state: a.ctx && a.ctx.state, time: a.ctx && a.ctx.currentTime, ua: navigator.userAgent,
      fetched: r.map((e) => `${e.initiatorType} ${Math.round(e.duration)} ms`) };
  });
  if (!running) {
    // which part fails: addModule of a one-line processor (a Blob) and of ours, each on a fresh context, realtime and
    // offline, each given 5 s
    const probe = await page.evaluate(async () => {
      const blob = URL.createObjectURL(new Blob(['registerProcessor("p", class extends AudioWorkletProcessor { process() { return true; } });'], { type: 'text/javascript' }));
      const ours = new URL('js/host/audio-worklet.js', document.baseURI).href;
      const tryIt = async (make, url) => {
        const c = make(), t0 = performance.now();
        const r = await Promise.race([c.audioWorklet.addModule(url).then(() => 'loaded', (e) => `rejected: ${e.message}`), new Promise((res) => setTimeout(() => res('pending after 5 s'), 5000))]);
        return `${r} (${Math.round(performance.now() - t0)} ms, ${c.state})`;
      };
      const rt = () => new AudioContext(), off = () => new OfflineAudioContext(1, 128, 44100);
      return { blobRealtime: await tryIt(rt, blob), oursRealtime: await tryIt(rt, ours), blobOffline: await tryIt(off, blob), oursOffline: await tryIt(off, ours) };
    });
    check('sound: after the unlock an AudioWorkletNode plays it', false, JSON.stringify({ ...await audioState(), probe }));
    await ctx.close();
    return;
  }
  const made = await page.evaluate(() => {
    const a = window.emu.audio;
    window.firstAudio = { ctx: a.ctx, node: a.node, out: a.out };
    return { nodes: window.audioNodes, isWorklet: a.node instanceof AudioWorkletNode, sink: a.out.sink.constructor.name };
  });
  check('sound: after the unlock an AudioWorkletNode plays it, and no ScriptProcessorNode is made',
    running && made.isWorklet && made.nodes.worklet === 1 && made.nodes.script === 0 && made.sink === 'PortSink', JSON.stringify(made));
  await page.evaluate(() => {
    const a = window.emu.audio, sink = a.out.sink, write = sink.write.bind(sink);
    window.made = [];                                  // [index of its first sample, a copy of the chunk]
    sink.write = (c) => { window.made.push([sink.written, c.slice()]); write(c); };
    window.played = []; window.blocks = [];
    a.node.port.addEventListener('message', (e) => { const t = e.data.tap; if (!t) return; window.blocks.push(t); for (const v of t.out) window.played.push(v); });
    a.node.port.postMessage({ tap: true });
  });
  const load = (b = bin) => page.evaluate((b) => window.emu.session.load('dac.bin', new Uint8Array(b), { remember: false }), b);
  // after each step, a quarter of a second of sound played (however long the page takes)
  const wait = async () => { const n0 = await page.evaluate(() => window.played.length); await waitFor(page, (n0) => window.played.length >= n0 + 12000, n0); };
  const steps = [
    ['load', load], ['power cycle', () => page.click('#btnHardReset')], ['load', load], ['reset', () => page.click('#btnReset')],
    // (paused, no sound plays: the step waits until the output has faded and the context is suspended instead)
    ['load', load], ['pause', () => page.click('#btnPause'), () => waitFor(page, () => window.emu.audio.ctx.state === 'suspended')], ['resume', () => page.click('#btnPause')],
    ['turbo', () => page.click('#btnTurbo')], ['turbo off', () => page.click('#btnTurbo')],
    ['sound off', () => page.$eval('#chkSound', (c) => c.click())], ['sound on', () => page.$eval('#chkSound', (c) => c.click())],
    ['switch', () => page.evaluate(() => window.emu.session.switchMachine('coco'))], ['load', load], ['switch back', () => page.evaluate(() => window.emu.session.switchMachine('dragon64'))],
    // the page's thread busy for 200 ms (no frames, no messages): the audio thread plays on from its queue, and
    // when that runs dry fades to silence instead of glitching
    ['busy page', () => page.evaluate(() => { window.busyAt = window.emu.audio.ctx.currentTime; const t = performance.now(); while (performance.now() - t < 200); })],
  ];
  const marks = [];
  for (const [name, act, until = wait] of steps) { marks.push([name, await page.evaluate(() => window.played.length)]); await act(); await until(); }
  const { jump, at, n, peak } = await page.evaluate(() => {
    const p = window.played; let jump = 0, at = 0, peak = 0;
    for (let i = 1; i < p.length; i++) { const d = Math.abs(p[i] - p[i - 1]); if (d > jump) { jump = d; at = i; } peak = Math.max(peak, Math.abs(p[i])); }
    return { jump, at, n: p.length, peak };
  });
  const where = (marks.filter((m) => m[1] <= at).pop() || ['start'])[0];
  check('sound: no pop across power cycle, reset, load, pause, turbo, sound off/on, machine switch and a busy page',
    running && n > 48000 && jump < 0.01 && !errors.length, `${n} samples, largest step ${jump.toFixed(4)} (after "${where}"), peak ${peak.toFixed(3)}${errors.length ? ' ' + errors.join('; ') : ''}`);
  const busy = await page.evaluate(() => {
    const t0 = window.busyAt, rate = window.emu.audio.ctx.sampleRate;
    const during = window.blocks.filter((b) => b.time >= t0 && b.time < t0 + 0.15);
    return { blocks: during.length, expected: Math.floor(0.15 * rate / 128), queued: during.filter((b) => b.n > 0).length };
  });
  check('sound: with the page\'s thread busy for 200 ms the audio thread keeps rendering, playing what was queued first',
    busy.blocks >= busy.expected - 2 && busy.queued > 0, JSON.stringify(busy));
  // paused or hidden, the sound context is suspended once the output has faded, and runs again after
  const state = () => page.evaluate(() => window.emu.audio.ctx.state);
  // (each waits for the state the check then asserts: no sound plays while suspended, so a wait for more samples
  // could only time out)
  const ctxIs = (s) => waitFor(page, (s) => window.emu.audio.ctx.state === s, s);
  await page.click('#btnPause'); await ctxIs('suspended');
  const pausedState = await state();
  await page.click('#btnPause'); await ctxIs('running'); await wait();
  const resumedState = await state();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await ctxIs('suspended');
  const hiddenState = await state();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await ctxIs('running'); await wait();
  const shownState = await state();
  check('sound: the context is suspended while paused and while hidden, and runs again after',
    pausedState === 'suspended' && resumedState === 'running' && hiddenState === 'suspended' && shownState === 'running',
    `paused ${pausedState}, resumed ${resumedState}, hidden ${hiddenState}, shown ${shownState}`);

  // the tone: the machine's own events give its period in cycles; the played samples' rising zero crossings over
  // a second of full blocks give its frequency (to the resampler's steering, at most 0.5%, and one crossing)
  await load(square);
  await wait(); await wait();
  const tone = await page.evaluate(() => {
    const m = window.emu.machine, ev = m.audioEvents, ts = [];
    for (let i = 2; i < ev.length; i += 2) if (ev[i + 1] !== ev[i - 1]) ts.push(ev[i]);
    const period = 2 * (ts[ts.length - 1] - ts[0]) / (ts.length - 1), expected = m.frameCycles * m.fps / period;
    const rate = window.emu.audio.ctx.sampleRate, from = window.blocks.length;
    return new Promise((res) => {
      const done = () => {
        const bs = window.blocks.slice(from).filter((b) => b.full).slice(0, Math.ceil(rate / 128));
        let up = 0, prev = 0, nS = 0;
        for (const b of bs) for (const v of b.out) { if (prev < 0 && v >= 0) up++; prev = v; nS++; }
        // the queue running dry while the tone plays steadily: blocks that took fewer than 128 queued samples
        const all = window.blocks.slice(from), dry = all.filter((b) => b.n < b.out.length).length;
        res({ expected, heard: up * rate / nS, nS, edges: ts.length, rate, dry, blocks: all.length });
      };
      const t = setInterval(() => { if (window.blocks.slice(from).filter((b) => b.full).length >= rate / 128) { clearInterval(t); done(); } }, 20);
    });
  });
  check('sound: the square wave plays at the frequency the machine makes it',
    tone.edges > 4 && tone.nS >= tone.rate * 0.99 && Math.abs(tone.heard - tone.expected) <= tone.expected * 0.006 + 2,
    `machine ${tone.expected.toFixed(2)} Hz, played ${tone.heard.toFixed(2)} Hz over ${tone.nS} samples`);
  // headroom: with the page running normally the worklet's queue (kept 10 to 80 ms full by the steering, on the
  // processor's reported count) doesn't run dry; a stall longer than what is queued would, so the bound is 2% of
  // the blocks rather than none (each is a 5 ms fade to silence and back, not a click)
  check('sound: while a tone plays steadily the worklet\'s queue doesn\'t run dry (at most 2% of blocks)', tone.blocks > 300 && tone.dry <= tone.blocks * 0.02,
    `${tone.dry} of ${tone.blocks} blocks short`);
  // volume: the output stage's volume scales what the worklet plays (the page has no volume control; Audio.volume
  // is 0.5): at 0.25, the tone's peak is half what it was
  const peakNow = () => page.evaluate(() => new Promise((res) => {
    const from = window.blocks.length;
    const t = setInterval(() => {
      const bs = window.blocks.slice(from + 40).filter((b) => b.full);   // (after what was queued at the old volume)
      if (bs.length >= 200) { clearInterval(t); res(Math.max(...bs.map((b) => Math.max(...b.out.map(Math.abs))))); }
    }, 20);
  }));
  const loud = await peakNow();
  await page.evaluate(() => { window.emu.audio.out.volume = 0.25; });
  const soft = await peakNow();
  await page.evaluate(() => { window.emu.audio.out.volume = window.emu.audio.volume; });
  check('sound: the volume scales the output (0.25 plays the tone at half the peak of 0.5)', loud > 0.1 && Math.abs(soft / loud - 0.5) < 0.02,
    `peak ${loud.toFixed(4)} at 0.5, ${soft.toFixed(4)} at 0.25`);
  // mute: the output fades to exact silence (no frames are sent), and the tone comes back when sound is on again
  await page.$eval('#chkSound', (c) => c.click());
  const silent = await waitFor(page, () => window.played.length > 8192 && window.played.slice(-8192).every((v) => v === 0));
  const writesMuted = await page.evaluate(() => { const n = window.made.length; return new Promise((res) => setTimeout(() => res(window.made.length - n), 300)); });
  await page.$eval('#chkSound', (c) => c.click());
  const back = await waitFor(page, () => window.played.slice(-4096).some((v) => Math.abs(v) > 0.05));
  check('sound: sound off fades to exact silence with nothing sent, and sound on plays again', silent && writesMuted === 0 && back, `${writesMuted} chunks sent while off`);

  // what the worklet played equals what the emulator made, over everything above
  const eq = await page.evaluate(() => {
    const made = window.made, blocks = window.blocks, base = made[0][0];
    const last = made[made.length - 1], all = new Float32Array(last[0] + last[1].length - base);
    let gaps = 0;
    for (let i = 0; i < made.length; i++) { all.set(made[i][1], made[i][0] - base); if (i && made[i][0] !== made[i - 1][0] + made[i - 1][1].length) gaps++; }
    let order = 0, compared = 0, differ = 0, first = null, full = 0;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (i && b.start !== blocks[i - 1].start + blocks[i - 1].n) order++;
      if (!b.full || b.start < base) continue;
      full++;
      for (let k = 0; k < b.out.length; k++) {
        compared++;
        if (!Object.is(b.out[k], all[b.start - base + k])) { differ++; if (!first) first = [b.start + k, b.out[k], all[b.start - base + k]]; }
      }
    }
    return { gaps, order, compared, differ, first, full, blocks: blocks.length, rate: window.emu.audio.ctx.sampleRate };
  });
  check('sound: every sample the worklet played at full gain equals the one the emulator made (tolerance 0), in order',
    eq.gaps === 0 && eq.order === 0 && eq.differ === 0 && eq.compared > 5 * eq.rate, JSON.stringify(eq));   // (at least 5 s of it)
  // one context, one node, one output stage through all of it; no ScriptProcessorNode; no deprecation warning
  const kept = await page.evaluate(() => {
    const a = window.emu.audio, f = window.firstAudio;
    return { same: a.ctx === f.ctx && a.node === f.node && a.out === f.out, nodes: window.audioNodes, dropped: a.out.dropped };
  });
  check('sound: pause, turbo, sound off, hiding and machine switches keep one context and one node (nothing leaks)',
    kept.same && kept.nodes.worklet === 1 && kept.nodes.script === 0, JSON.stringify(kept));
  check('sound: no ScriptProcessorNode deprecation warning in the console', warnings.length === 0, warnings.join(' | '));
  check('sound: no page errors', !errors.length, errors.join('; '));
  await ctx.close();

  // Fallback: without AudioWorklet (or when its module fails to load) the ScriptProcessorNode plays the same
  // output stage on the page's thread: sound still works, and the program's tone is in the samples it plays
  for (const [label, opts] of [['no AudioWorklet', { noWorklet: true }], ['the worklet module fails to load', { badModule: true }], ['the worklet module never loads', { hangModule: true }], ['the worklet module loads only after the wait', { slowModule: true }], ['the processor fails', { processorError: true }]]) {
    const fctx = await browser.newContext();
    await fctx.addInitScript(audioNodeCounter, opts);
    const fp = await fctx.newPage();
    const ferr = [];
    fp.on('pageerror', (e) => ferr.push(e.message));
    await fp.goto(`${base}?machine=dragon64`);
    await started(fp);
    await stubPrompt(fp);
    await fp.mouse.click(5, 5);
    const ok = await waitFor(fp, () => window.emu.audioRunning() && window.emu.audio.path === 'script');
    await fp.evaluate(() => {
      const a = window.emu.audio, h = a.node.onaudioprocess;
      window.played = [];
      a.node.onaudioprocess = (e) => { h(e); for (const v of e.outputBuffer.getChannelData(0)) window.played.push(v); };
    });
    await fp.evaluate((b) => window.emu.session.load('sq.bin', new Uint8Array(b), { remember: false }), square);
    const sounds = await waitFor(fp, () => window.played.length > 24000 && window.played.slice(-8192).some((v) => Math.abs(v) > 0.05));
    const r = await fp.evaluate(() => ({ nodes: window.audioNodes, isScript: window.emu.audio.node instanceof ScriptProcessorNode, sink: window.emu.audio.out.sink.constructor.name, n: window.played.length, why: window.emu.audio.fallback }));
    check(`sound fallback (${label}): a ScriptProcessorNode plays the output stage, and the tone sounds`,
      ok && sounds && r.isScript && r.nodes.script === 1 && r.nodes.worklet === (opts.processorError ? 1 : 0) && r.sink === 'SampleQueue' && typeof r.why === 'string' && !ferr.length, JSON.stringify(r) + ferr.join('; '));
    if (opts.processorError) {
      check('sound fallback (the processor fails): the failed worklet node is disconnected, once',
        r.nodes.connected === 1 && r.nodes.disconnected === 1, JSON.stringify(r.nodes));
    }
    if (opts.slowModule) {
      // the module loads at last (4 s), after the fallback took over (3 s): the late load is ignored, no worklet node
      await waitFor(fp, () => window.slowLoaded === true, null, 15000);
      await fp.evaluate(() => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0))));   // (its .then has run)
      const late = await fp.evaluate(() => ({ nodes: window.audioNodes, path: window.emu.audio.path, isScript: window.emu.audio.node instanceof ScriptProcessorNode }));
      check('sound fallback: a worklet module that loads after the fallback took over is ignored (no worklet node, the fallback plays on)',
        late.nodes.worklet === 0 && late.nodes.script === 1 && late.path === 'script' && late.isScript, JSON.stringify(late));
    }
    await fctx.close();
  }
}

// fast typing through real keyboard events: a burst with the next key pressed before the previous is released,
// double letters and a shifted character, all within a few milliseconds. On the 6809 machines LIZA (no-ROM stub)
// must show it exactly; on every family the keyboard matrix, read at each frame start as a program reads it,
// must spell it (the Session's KeyQueue holds each key for some frames and keeps the order)
async function typingChecks(browser, base, check) {
  const typed = 'I FEEL GOOD, REALLY! 1122';
  for (const id of ['dragon64', 'coco', 'coco3', 'mc10']) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const lizaMachine = id !== 'mc10';
    await page.goto(`${base}?machine=${id}${lizaMachine ? '&start=liza' : ''}`);
    await started(page);
    if (lizaMachine) await waitFor(page, () => window.emu.session.screenText().join('').includes('I AM LIZA'));
    await page.evaluate(() => {
      const m = window.emu.machine, orig = m.runFrame.bind(m);
      const SH = { 1: '!', 2: '"' };
      let prev = new Set();
      window.decoded = '';
      m.runFrame = () => {
        const now = new Set();
        for (const [name, [r, c]] of Object.entries(m.keyPos)) if (m.keyRowsForCols(0xFF & ~(1 << c)) & (1 << r)) now.add(name);
        for (const k of now) if (!prev.has(k) && k !== 'SHIFT') window.decoded += k === 'SPACE' ? ' ' : now.has('SHIFT') && SH[k] ? SH[k] : k;
        prev = now;
        return orig();
      };
    });
    await page.focus('#screen');
    const keyName = (ch) => (ch === ' ' ? 'Space' : ch);
    const chars = [...typed];
    for (let i = 0; i < chars.length; i++) {
      const a = keyName(chars[i]), next = chars[i + 1];
      await page.keyboard.down(a);
      if (next && next !== chars[i] && chars[i] !== '!' && next !== '!') { await page.keyboard.down(keyName(next)); await page.keyboard.up(a); await page.keyboard.up(keyName(next)); i++; }
      else await page.keyboard.up(a);
    }
    await waitFor(page, () => window.emu.session.keys.pending === 0);
    await emuFrames(page, 2);
    if (lizaMachine) await waitFor(page, (t) => window.emu.session.screenText().some((l) => l.startsWith(`> ${t}`)), typed);
    const decoded = await page.evaluate(() => window.decoded);
    let ok = decoded === typed, detail = JSON.stringify(decoded);
    if (lizaMachine) {
      const line = await page.evaluate(() => window.emu.session.screenText().find((l) => l.startsWith('>') && l.includes('I FEEL')) || '');
      ok = ok && line.startsWith(`> ${typed}`) && !/[A-Z0-9!,]/.test(line.slice(typed.length + 2));
      detail += ` LIZA ${JSON.stringify(line.trim())}`;
    }
    check(`${id}: a fast typed burst reaches the machine exactly${lizaMachine ? ' (matrix and LIZA)' : ' (matrix)'}`, ok && !errors.length, errors.length ? errors.join('; ') : detail);
    await ctx.close();
  }
}

// The printer: bytes the machine prints appear in the Machine tab's Printer box, "Save
// printout" downloads them as received, and Clear empties it. The Dragon's parallel port, driven by writing its
// PIAs (the stub firmware does not print); the serial printers are checked against MAME (run.js --printer).
async function printerChecks(browser, base, check) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?machine=dragon64`);
  await waitFor(page, () => window.emu && window.emu.machine && window.emu.machine.id === 'dragon64', null, 5000);
  await openTab(page, 'Machine');
  await page.evaluate(() => {
    const m = window.emu.machine;
    m.write(0xFF03, 0x00); m.write(0xFF02, 0xFF); m.write(0xFF03, 0x04);
    m.write(0xFF21, 0x00); m.write(0xFF20, 0xFE); m.write(0xFF21, 0x04);
    for (const c of 'HELLO PRINTER\r') { m.write(0xFF02, c.charCodeAt(0)); m.write(0xFF20, 0x02); m.write(0xFF20, 0x00); }
  });
  await waitFor(page, () => document.getElementById('printout').textContent.includes('HELLO PRINTER'), null, 3000);
  check('printer: printed bytes appear in the Machine tab', (await page.textContent('#printout')).includes('HELLO PRINTER')
    && /Parallel printer port/.test(await page.textContent('#printerKind')));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnPrintSave')]);
  const bytes = fs.readFileSync(await dl.path());
  check('printer: "Save printout" downloads the bytes as received', dl.suggestedFilename() === 'dragon64-printout.prn'
    && bytes.toString('latin1').endsWith('HELLO PRINTER\r'), `${dl.suggestedFilename()}, ${bytes.length} bytes`);
  await page.click('#btnPrintClear');
  check('printer: Clear empties it', await page.textContent('#printout') === '' && await page.isDisabled('#btnPrintSave'));
  await pickMachine(page, 'coco');
  // switched on into the welcome menu, whose DAC writes to $FF20 drive the bit-banger's TXD too: the
  // serial checks below want a quiet machine, the stub's prompt
  await waitFor(page, () => window.emu.session.welcomeRunning);
  await stubPrompt(page);
  await openTab(page, 'Machine');
  check('printer: the CoCo shows its serial printer', /Serial printer on the RS-232 port, 600 baud/.test(await page.textContent('#printerKind')));
  // the serial port: plug in the terminal at 9600 baud, type a line (it goes to the machine), and what the machine
  // sends (frames driven onto its TXD here) shows in the terminal
  await page.selectOption('#selSerial', 'terminal');
  await page.selectOption('#selBaud', '9600');
  check('serial: the terminal is plugged in at 9600 baud', await page.evaluate(() => JSON.stringify(window.emu.session.serialDevice)) === JSON.stringify({ kind: 'terminal', baud: 9600, kinds: ['printer', 'terminal', 'loopback'], chip: 'bit-banger' })
    && await page.isVisible('#terminal') && /unplugged/.test(await page.textContent('#printerKind')));
  await page.fill('#termInput', 'DIR');
  await page.press('#termInput', 'Enter');
  check('serial: a typed line goes to the machine, with CR', await page.evaluate(() => window.emu.machine.bitBanger.queue.join(',')) === '68,73,82,13' && await page.inputValue('#termInput') === '');
  await page.evaluate(() => {
    const m = window.emu.machine, p = m.bitBanger, bit = m.tickHz / 9600;
    let t = m.now();
    for (const b of [0x48, 0x49, 0x0D]) {
      for (let k = 0; k < 10; k++) { p.txd(t, k === 0 ? 0 : k === 9 ? 1 : (b >> (k - 1)) & 1); t += bit; }
      t += 2 * bit;
    }
  });
  await waitFor(page, () => document.getElementById('terminal').textContent === 'HI\n', null, 3000);
  check('serial: what the machine sends shows in the terminal', await page.textContent('#terminal') === 'HI\n', JSON.stringify(await page.textContent('#terminal')));
  // the Dragon 64's 6551: its own list of devices; a terminal at 9600 baud gets what the chip sends (registers
  // written directly: 9600 baud 8N1, DTR and the transmitter on)
  await pickMachine(page, 'dragon64');
  await openTab(page, 'Machine');
  const d64opts = await page.$$eval('#selSerial option', (os) => os.map((o) => o.value).join());
  check('serial: the Dragon 64 offers nothing, terminal or loopback on its 6551', d64opts === 'none,terminal,loopback' && await page.inputValue('#selSerial') === 'none', d64opts);
  await page.selectOption('#selSerial', 'terminal');
  await page.selectOption('#selBaud', '9600');
  await page.evaluate(() => {
    const m = window.emu.machine;
    m.write(0xFF07, 0x1E); m.write(0xFF06, 0x0B);
    window.aciaOut = [0x4F, 0x4B, 0x0D];
    // feed one byte each time the transmit register is empty, between frames
    const frame = m.runFrame.bind(m);
    m.runFrame = () => { if (window.aciaOut.length && (m.read(0xFF05) & 0x10)) m.write(0xFF04, window.aciaOut.shift()); frame(); };
  });
  await waitFor(page, () => document.getElementById('terminal').textContent === 'OK\n', null, 3000);
  check('serial: what the Dragon 64\'s 6551 sends shows in the terminal', await page.textContent('#terminal') === 'OK\n', JSON.stringify(await page.textContent('#terminal')));
  await pickMachine(page, 'dragon32');
  await openTab(page, 'Machine');
  check('serial: no serial section on the Dragon 32', await page.isHidden('#serialSection'));
  check('printer: no page errors', !errors.length, errors.join('; '));
  await page.close();
}

// DriveWire: the Becker port option from the URL, an image added through the page (into the page's
// media store, OPFS here), mounted on drive 0, read and written by the guest through $FF41/$FF42, saved, still
// there after a reload; a channel connected to a local WebSocket server; the option off again
async function driveWireChecks(browser, base, check) {
  const { startWsServer } = require('../tests/ws-test-server.js');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?machine=coco&becker=true`);
  await waitFor(page, () => window.emu && window.emu.ready && window.emu.machine && !!window.emu.machine.becker, null, 5000);
  await openTab(page, 'Machine');
  check('drivewire: ?becker=true turns the Becker port on; the DriveWire box shows', await page.isVisible('#dwSection') && await page.isChecked('#chkBecker'));
  const image = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 7 + (i >> 8)) & 0xFF));
  await page.setInputFiles('#dwImport', { name: 'test.dsk', mimeType: 'application/octet-stream', buffer: image });
  await waitFor(page, () => [...document.querySelectorAll('#dwDrive0 option')].some((o) => o.value === 'test.dsk'), null, 5000);
  await page.selectOption('#dwDrive0', 'test.dsk');
  await waitFor(page, () => window.emu.session.driveWireMounts.length === 1, null, 3000);
  check('drivewire: an added image mounts on drive 0', await page.evaluate(() => JSON.stringify(window.emu.session.driveWireMounts)) === JSON.stringify([{ drive: 0, name: 'test.dsk', writeProtected: false }]));
  // the guest: Read drive 0 LSN 1, then Write LSN 0, through the Becker port
  const io = await page.evaluate(async () => {
    const m = window.emu.machine;
    const send = async (bytes) => { for (const b of bytes) m.write(0xFF42, b); while (m.stall) await m.stall; };
    const take = () => { const out = []; while (m.read(0xFF41) & 2) out.push(m.read(0xFF42)); return out; };
    await send([0x52, 0, 0, 0, 1]);
    const read = take();
    const data = Array.from({ length: 256 }, (_, i) => 255 - i);
    const ck = data.reduce((a, v) => a + v, 0) & 0xFFFF;
    await send([0x57, 0, 0, 0, 0, ...data, ck >> 8, ck & 0xFF]);
    return { read, write: take() };
  });
  check('drivewire: the guest reads a sector of it', io.read.length === 259 && io.read[0] === 0 && Buffer.from(io.read.slice(3)).equals(image.subarray(256)));
  check('drivewire: the guest writes a sector of it (result 0)', io.write.length === 1 && io.write[0] === 0);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnDwSave')]);
  const saved = fs.readFileSync(await dl.path());
  check('drivewire: "Save drive 0" downloads the image with the sector written', dl.suggestedFilename() === 'test.dsk' && saved.length === 512 && saved[0] === 255 && saved[255] === 0 && saved.subarray(256).equals(image.subarray(256)));
  await page.reload();
  await waitFor(page, () => window.emu && window.emu.ready && window.emu.machine && !!window.emu.machine.becker, null, 5000);
  const after = await page.evaluate(async () => { const f = await window.emu.session.driveWireFile('test.dsk'); return [f.bytes.length, f.bytes[0], f.bytes[256]]; });
  check('drivewire: the image, as written, is still in the store after a reload', after[0] === 512 && after[1] === 255 && after[2] === image[256], JSON.stringify(after));
  // a channel over a WebSocket
  let conn = null;
  const srv = await startWsServer((c) => { conn = c; c.send('HI'); });
  await openTab(page, 'Machine');
  await page.selectOption('#dwChan', '2');
  await page.fill('#dwUrl', srv.url);
  await page.click('#btnDwConnect');
  await waitFor(page, () => /channel 2: open/.test(document.getElementById('dwChanState').textContent), null, 5000);
  check('drivewire: channel 2 connects to a WebSocket server', /channel 2: open/.test(await page.textContent('#dwChanState')) && !!conn, await page.textContent('#dwChanState'));
  const hi = await page.evaluate(() => {
    const m = window.emu.machine;
    for (const b of [0x45, 2, 0x63, 2, 2]) m.write(0xFF42, b);
    const out = []; while (m.read(0xFF41) & 2) out.push(m.read(0xFF42)); return String.fromCharCode(...out);
  });
  check('drivewire: what the server sends reaches the guest on its channel', hi === 'HI', JSON.stringify(hi));
  await page.click('#btnDwConnect');
  await waitFor(page, () => /not connected/.test(document.getElementById('dwChanState').textContent), null, 3000);
  check('drivewire: Disconnect', /not connected/.test(await page.textContent('#dwChanState')));
  srv.close();
  await page.uncheck('#chkBecker');
  await waitFor(page, () => window.emu.machine && !window.emu.machine.becker, null, 3000);
  // (the box stays where the browser has Web Serial, for a real CoCo; the Becker port's channel controls go)
  const serialHere = await page.evaluate(() => window.emu.session.webSerialAvailable);
  check('drivewire: the option off power cycles without the port; its controls hide',
    await page.isHidden('#dwUrl') && (serialHere ? await page.isVisible('#dwSerialRow') : await page.isHidden('#dwSection')), `(Web Serial ${serialHere ? 'present' : 'absent'})`);
  check('drivewire: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

// NitrOS-9 from the page, without a ROM (Session.bootNitros9; js/ui/nitros9-panel.js): the slot under the screen on
// the CoCo 3, its errors, the dropped image's offer, the link (nitros9=) and Share, with hand-built boot disks (a
// DriveWire one and a floppy)
// (tools/nitros9/os9-image.js: our own bytes); then, when tools/nitros9/fetch.js has cached them (skipped with the reason
// otherwise), the official v3.3.0 Becker and _40d_1 floppy images: picked in the slot, booted to the NitrOS-9 shell
// (the floppy's setime prompt answered with Return), `dir` typed on the keyboard and the listing read from the screen.
async function nitros9Checks(browser, base, check) {
  const Emu = require('../tests/load')();
  const { makeOs9Disk } = require('./nitros9/os9-image.js');
  const { cached } = require('./nitros9/fetch.js');
  const { screenText } = require('./nitros9/lib.js');
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const open = async (q) => { await page.goto(`${base}${q}`); return waitFor(page, () => window.emu && window.emu.linkDone, null, 15000); };
  const msg = () => page.textContent('#toast');
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const file = (name, bytes) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  const running = () => ev(() => window.emu.session.nitros9Running);

  // ---- wrong machine, no image
  await open('?machine=dragon64&nitros9=1');
  check('nitros9: a link with another machine says NitrOS-9 boots on the CoCo 3; no NitrOS-9 slot there',
    /nitros9: NitrOS-9 boots on the CoCo 3/.test(await msg()) && await ev(() => window.emu.machine.id === 'dragon64') && await page.isHidden('#nitros9Slot'), await msg());
  await open('?nitros9=1');
  check('nitros9: ?nitros9=1 alone opens the CoCo 3; with no image it says where to get one',
    await ev(() => window.emu.machine.id === 'coco3') && /your library has none yet.*github\.com\/nitros9project\/nitros9\/releases/.test(await msg()) && !await running(), await msg());
  check('nitros9: the slot under the screen, Boot disabled with no image, the release link',
    await page.isVisible('#nitros9Slot') && await page.isDisabled('#btnN9Boot') &&
    await page.getAttribute('#n9Note a', 'href') === 'https://github.com/nitros9project/nitros9/releases');
  if (shotDir) await page.locator('#nitros9Slot').screenshot({ path: path.join(shotDir, 'nitros9-empty.png') });

  // ---- wrong images, picked with Add image…
  await page.setInputFiles('#n9File', file('notes.txt', Buffer.from('hello')));
  check('nitros9: a file that is no disk image', await waitFor(page, () => /notes\.txt: It isn't a disk image of whole 256-byte sectors/.test(document.getElementById('toast').textContent)), await msg());
  await page.setInputFiles('#n9File', file('blank.dsk', new Uint8Array(630 * 256)));
  check('nitros9: a disk that is not OS-9', await waitFor(page, () => /blank\.dsk: It isn't an OS-9 disk/.test(document.getElementById('toast').textContent)), await msg());
  await page.setInputFiles('#n9File', file('serial.dsk', makeOs9Disk(Emu, { port: 'bitbanger' })));
  check('nitros9: the bit-banger build: use _becker.dsk', await waitFor(page, () => /serial\.dsk: .*bit-banger.*_becker\.dsk/.test(document.getElementById('toast').textContent)), await msg());
  await page.setInputFiles('#n9File', file('floppy80.dsk', makeOs9Disk(Emu, { driver: 'rb1773', port: 'floppy', sides: 2, sectors: 2880 })));
  check('nitros9: an 80-track floppy: the drives have 40', await waitFor(page, () => /floppy80\.dsk: This NitrOS-9 floppy image has 80 tracks/.test(document.getElementById('toast').textContent)), await msg());
  check('nitros9: none of them was kept or booted', !await running() && await ev(async () => (await window.emu.session.driveWireImages()).length === 0 &&
    !(await window.emu.session.media.list('disks/')).length));

  // ---- a hand-built boot disk: added, booted, no ROM, no boot-help box
  await page.setInputFiles('#n9File', file('myboot.dsk', makeOs9Disk(Emu, { cpu: '6309' })));
  const booted = await waitForFrames(page, () => window.emu.session.nitros9Running && window.emu.machine.read(0x0100) === 1 && window.emu.machine.read(0x0102) === 0x5A, null, 600);
  check('nitros9: Add image… keeps it and boots it: the loader ran the boot track', booted, await msg());
  check('nitros9: a 6309 build makes the machine a 6309 CoCo 3 with the Becker port, the image in DriveWire drive 0',
    await ev(() => { const m = window.emu.machine, d = window.emu.session.driveWireMounts; return m.config.cpu === '6309' && m.config.becker === true && d[0].drive === 0 && d[0].name === 'myboot.dsk'; }) && /switched to the HD6309/.test(await msg()), await msg());
  await ev(() => window.emu.nitros9Shown());   // (the panel's update after the boot's session events)
  check('nitros9: the slot says it is running, offers Back to BASIC; no ROM pill, the ROMs line says they are not used',
    /running from myboot\.dsk/.test(await page.textContent('#n9State')) && await page.isVisible('#btnN9Leave') && await page.isHidden('#romPill') && /NitrOS-9/.test(await page.textContent('#romState')));
  await emuFrames(page, 6 * 60);   // 6 s of machine time, past the 5 s the box would wait for
  check('nitros9: no "No OK after 5 seconds" box (BASIC isn\'t meant to start)', await page.isHidden('#bootHelp'));
  if (shotDir) await page.locator('#nitros9Slot').screenshot({ path: path.join(shotDir, 'nitros9-running.png') });

  // ---- Share: the link boots NitrOS-9 from the recipient's own image, no snapshot
  await page.click('#btnShare');
  await waitFor(page, () => !document.getElementById('share').hidden && !!document.getElementById('shareLink').value);
  const link = await page.inputValue('#shareLink');
  check('nitros9: Share gives a link with nitros9=1 and no snapshot or image name; the snapshot download is off',
    /nitros9=1/.test(link) && /machine=coco3/.test(link) && !/#s=/.test(link) && !/myboot/.test(link) && await page.isDisabled('#btnShareDownload') &&
    /their own NitrOS-9 DriveWire image/.test(await page.textContent('#shareRecipient')), link);
  await page.click('#shareBack');

  // ---- the link, in a new page load: the library's image boots again
  await open(new URL(link).search);
  check('nitros9: the share link boots NitrOS-9 from the image in the library (after a reload)',
    await waitForFrames(page, () => window.emu.session.nitros9Running && window.emu.machine.read(0x0100) === 1 && window.emu.machine.read(0x0102) === 0x5A, null, 600), await msg());
  await page.click('#btnN9Leave');
  // (no ROMs in this browser: back on the built-in firmware, which starts the welcome menu as at power-on)
  check('nitros9: Back to BASIC puts the machine\'s own firmware back',
    await waitFor(page, () => !window.emu.session.nitros9Running && window.emu.machine.useStub && document.getElementById('btnN9Leave').hidden), await msg());

  // ---- a dropped (or loaded) NitrOS-9 image on another machine: the offer boots it on the CoCo 3
  await open('?machine=dragon32');
  await page.setInputFiles('#fileProgram', file('dropped.dsk', makeOs9Disk(Emu, { cpu: '6809' })));
  await waitFor(page, () => !document.getElementById('mediaOffer').hidden);
  check('nitros9: a dropped NitrOS-9 image offers to boot it (on the CoCo 3) or use it as a floppy',
    /dropped\.dsk is a NitrOS-9\/6809 DriveWire boot disk\. It boots on the CoCo 3\./.test(await page.textContent('#mediaOfferText')) &&
    await page.textContent('#btnMediaSwitch') === 'Boot NitrOS-9' && await page.textContent('#btnMediaAnyway') === 'Put it in a floppy drive');
  await page.click('#btnMediaSwitch');
  check('nitros9: Boot NitrOS-9 switches to the CoCo 3 and boots it',
    await waitForFrames(page, () => window.emu.machine.id === 'coco3' && window.emu.session.nitros9Running && window.emu.machine.read(0x0102) === 0x5A, null, 600), await msg());

  // ---- the release images: boot to the shell, dir
  const PROMPT = '{Term|02}/DD:';
  const shellText = `(${screenText.toString()})(window.emu.machine)`;
  const lines = () => page.evaluate(shellText);
  for (const cpu of ['6809', '6309']) {
    const name = `nos9${cpu}l2v030300coco3_becker.dsk`, { bytes, reason } = cached(name);
    // not cached (never fetched in CI): a SKIP. Present but not matching its pinned SHA-256: a FAIL, not a SKIP
    if (!bytes && /not found/.test(reason)) { skip(`nitros9 ${cpu}: the release image boots from the page to the NitrOS-9 shell`, reason); continue; }
    if (!bytes) { check(`nitros9 ${cpu}: the cached release image is the pinned one`, false, reason); continue; }
    await open('?machine=coco3&cpu=6809&ram=512');
    await page.setInputFiles('#n9File', file(name, bytes));
    const prompted = await waitForFrames(page, (s) => { const t = eval(s); return t.includes('{Term|02}/DD:'); }, shellText, 40 * 60);
    check(`nitros9 ${cpu}: the release image boots from the page to the NitrOS-9 shell`, prompted && (await lines()).includes(`NitrOS-9/${cpu} Level 2 V3.3.0`), JSON.stringify((await lines()).slice(-3)));
    await page.click('#screen');
    await page.keyboard.type('dir', { delay: 80 });
    await page.keyboard.press('Enter');
    const listed = await waitForFrames(page, (s) => { const l = eval(s), d = l.findIndex((x) => x.startsWith(' Directory of ')); return d >= 0 && l.slice(d + 1).includes('{Term|02}/DD:'); }, shellText, 20 * 60);
    const l = await lines(), d = l.findIndex((x) => x.startsWith(' Directory of '));
    const names = d >= 0 ? l.slice(d + 1, l.indexOf(PROMPT, d)).join(' ').split(/\s+/).filter(Boolean) : [];
    check(`nitros9 ${cpu}: dir typed on the keyboard lists the root`, listed && l.includes(`${PROMPT}dir`) && ['OS9Boot', 'CMDS', 'SYS', 'DEFS', 'sysgo', 'startup', 'NITROS9'].every((n) => names.includes(n)), JSON.stringify(names));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `nitros9-${cpu}-dir.png`) });
  }
  // ---- floppies: a hand-built one, then the release's _40d_1 (Return at setime's prompt, then dir)
  await open('?machine=coco3&cpu=6809&ram=128');
  await page.setInputFiles('#n9File', file('myfloppy.dsk', makeOs9Disk(Emu, { driver: 'rb1773', port: 'floppy', sides: 2, sectors: 1440 })));
  check('nitros9 floppy: Add image… keeps a floppy image with the disks and boots it with the floppy loader: its boot track ran',
    await waitForFrames(page, () => window.emu.session.nitros9Loader() === 'floppy' && window.emu.machine.read(0x0100) === 1 && window.emu.machine.read(0x0102) === 0x5A, null, 900) &&
    /from myfloppy\.dsk in floppy drive 0/.test(await msg()), await msg());
  await ev(() => window.emu.nitros9Shown());
  check('nitros9 floppy: the CoCo disk controller (no ROM) is in the port, the disk in drive 0, listed as a floppy in the slot',
    await ev(() => { const s = window.emu.session, c = s.machine.cartPort; return !!c && c.type === 'cocofdc' && !c.romBytes && s.diskStatus().drives.some((d) => d.drive === 0 && d.name === 'disks/myfloppy.dsk'); }) &&
    /myfloppy\.dsk \(6809, floppy\)/.test(await page.textContent('#n9Image')) && /running from myfloppy\.dsk/.test(await page.textContent('#n9State')), `${await page.textContent('#n9Image')} | ${await page.textContent('#n9State')}`);
  await page.click('#btnN9Leave');
  check('nitros9 floppy: Back to BASIC takes the ROM-less controller out', await waitFor(page, () => !window.emu.session.nitros9Running && !window.emu.machine.cartPort));
  for (const cpu of ['6809', '6309']) {
    const name = `nos9${cpu}l2v030300coco3_40d_1.dsk`, { bytes, reason } = cached(name);
    if (!bytes) { console.log(`skip nitros9 ${cpu} release floppy in the page: ${reason}`); continue; }
    await open('?machine=coco3&cpu=6809&ram=512');
    await page.setInputFiles('#n9File', file(name, bytes));
    const asked = await waitForFrames(page, (s) => eval(s).some((x) => x.startsWith('Time ?')), shellText, 60 * 60);
    check(`nitros9 ${cpu} floppy: the release floppy boots from the page to setime's prompt`, asked && (await lines()).includes(`NitrOS-9/${cpu} Level 2 V3.3.0`), JSON.stringify((await lines()).slice(-3)));
    await page.click('#screen');
    await page.keyboard.press('Enter');
    const prompted = await waitForFrames(page, (s) => { const t = eval(s); return t[t.length - 1] === '{Term|02}/DD:'; }, shellText, 30 * 60);
    await page.keyboard.type('dir', { delay: 80 });
    await page.keyboard.press('Enter');
    const listed = await waitForFrames(page, (s) => { const l = eval(s), d = l.findIndex((x) => x.startsWith(' Directory of ')); return d >= 0 && l.slice(d + 1).includes('{Term|02}/DD:'); }, shellText, 20 * 60);
    const l = await lines(), d = l.findIndex((x) => x.startsWith(' Directory of '));
    const names = d >= 0 ? l.slice(d + 1, l.indexOf(PROMPT, d)).join(' ').split(/\s+/).filter(Boolean) : [];
    check(`nitros9 ${cpu} floppy: Return, then dir typed on the keyboard lists the root`, prompted && listed && l.includes(`${PROMPT}dir`) &&
      ['OS9Boot', 'CMDS', 'SYS', 'DEFS', 'sysgo', 'startup'].every((n) => names.includes(n)) && names.length === 6, JSON.stringify(names));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `nitros9-${cpu}-floppy-dir.png`) });
  }
  check('nitros9: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

// DriveWire to a real CoCo over Web Serial, with navigator.serial MOCKED (a port of web streams in the page): the
// control, the port opened at the chosen rate, a Read answered from drive 0, stop. Real hardware is a manual test.
async function webSerialChecks(browser, base, check) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    const port = window.mockPort = { written: [], opened: null, closed: false,
      async open(o) { this.opened = o; }, async close() { this.closed = true; } };
    port.readable = new ReadableStream({ start(c) { port.feed = c; } });
    port.writable = new WritableStream({ write(chunk) { port.written.push(...chunk); } });
    Object.defineProperty(navigator, 'serial', { value: { async requestPort() { return port; } }, configurable: true });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?machine=dragon64`);
  await waitFor(page, () => window.emu && window.emu.ready && window.emu.machine && window.emu.machine.id === 'dragon64', null, 5000);
  await openTab(page, 'Machine');
  await waitFor(page, () => !document.getElementById('dwSerialRow').hidden, null, 3000);
  check('web serial: with Web Serial, the DriveWire box offers to serve a real CoCo (even on a Dragon 64)', await page.isVisible('#btnDwSerial') && await page.isHidden('#dwUrl'));
  await page.evaluate(async () => { await window.emu.session.importDriveWireImage('real.dsk', Uint8Array.from({ length: 256 }, (_, i) => i)); });
  await waitFor(page, () => [...document.querySelectorAll('#dwDrive0 option')].some((o) => o.value === 'real.dsk'), null, 5000);
  await page.selectOption('#dwDrive0', 'real.dsk');
  await waitFor(page, () => window.emu.session.driveWireMounts.length === 1, null, 3000);
  await page.selectOption('#dwSerialBaud', '57600');
  await page.click('#btnDwSerial');
  await waitFor(page, () => /open/.test(document.getElementById('dwSerialState').textContent), null, 3000);
  check('web serial: the port opens at 57600 baud, 8N1', await page.evaluate(() => JSON.stringify(window.mockPort.opened)) === JSON.stringify({ baudRate: 57600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' }));
  await page.evaluate(() => window.mockPort.feed.enqueue(Uint8Array.from([0x52, 0, 0, 0, 0])));
  await waitFor(page, () => window.mockPort.written.length >= 259, null, 3000);
  const answer = await page.evaluate(() => window.mockPort.written.slice(0, 5));
  check('web serial: a Read from the cable is answered from drive 0', JSON.stringify(answer) === JSON.stringify([0, 0x7F, 0x80, 0, 1]), JSON.stringify(answer));
  await page.click('#btnDwSerial');
  await waitFor(page, () => window.mockPort.closed, null, 3000);
  check('web serial: Stop closes the port', await page.evaluate(() => window.mockPort.closed));
  check('web serial: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

async function romUiChecks(browser, base, check) {
  const archive = [];
  const ctx = await guardedContext(browser, archive);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = async (name, sel = '#romCard') => { if (shotDir) await page.locator(sel).screenshot({ path: path.join(shotDir, `roms-${name}.png`) }); };
  const rows = () => page.$$eval('#romSockets [data-status]', (r) => r.map((x) => `${x.dataset.socket}:${x.dataset.status}`).join(' '));
  // synthetic images; BAS and EXT get "known-good" CRCs injected into the page's CoCo profile
  const BAS = fake(8192, 21), EXT = fake(8192, 22);
  const inject = () => page.evaluate(([b, e]) => {
    const crc = (bytes) => { let c = -1; for (const v of bytes) { c ^= v; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; } return ((c ^ -1) >>> 0).toString(16).toUpperCase().padStart(8, '0'); };
    const p = window.emu.profiles.coco.roms;
    if (!p[0].crcs.includes(crc(b))) { p[0].crcs.push(crc(b)); p[1].crcs.push(crc(e)); }
  }, [[...BAS], [...EXT]]);
  await page.goto(`${base}?machine=coco`); await started(page);
  await inject();
  await page.evaluate(() => window.emu.session.switchMachine('coco'));
  // the screen opens from the header's "No BASIC · Add ROMs" pill, and "← Emulator" closes it
  check('Add ROMs: closed until asked for', !(await page.evaluate(romsOpen)) && await page.isVisible('#romPill'));
  await page.click('#romPill');
  check('Add ROMs: the pill opens the screen in place of the emulator', await waitFor(page, romsOpen)
    && await page.evaluate(() => document.activeElement.id) === 'romHeading' && /ADD ROMS · COCO 1\/2/.test(await page.textContent('#romCard .eyebrow')));
  await page.click('#btnRomBack');
  check('Add ROMs: "← Emulator" goes back', await waitFor(page, () => location.hash === '' && document.getElementById('romCard').hidden && getComputedStyle(document.querySelector('.layout')).display !== 'none'));
  await openRoms(page);
  check('sockets: empty (required missing, optional not loaded), with what is needed', await rows() === 'bas:missing-required extbas:missing-optional'
    && await page.isVisible('#romNeeds') && /needs Color BASIC \(8 KB, usually bas12\.rom\)/.test(await page.textContent('#romNeedsText')), await rows());
  const state = (id) => page.textContent(`#romSockets [data-socket="${id}"] .state`);
  check('sockets: each says what it takes and why it matters', /8 KB · usually bas12\.rom/.test(await page.textContent('#romSockets [data-socket="bas"] .expect'))
    && /Without it there is no BASIC/.test(await state('bas')) && /without it you have Color BASIC only, with no PMODE graphics/.test(await state('extbas'))
    && await page.textContent('#romSockets [data-socket="bas"] .tag') === 'required' && await page.textContent('#romSockets [data-socket="extbas"] .tag') === 'optional', await state('extbas'));
  check('sockets: nothing dropped yet', /Nothing yet/.test(await page.textContent('#romFound')) && await page.isHidden('#btnRomSwitchOn'));
  check('sockets: the given copy, and the way to the /roms page', await page.$eval('#romsLink', (a) => new URL(a.href).pathname) === '/roms/'
    && /File names don't matter: CLOADM recognises ROMs by their contents\./.test(await page.textContent('#romCard'))
    && /ROMs stay in this browser\. They are never uploaded, put in share links or exported\./.test(await page.textContent('#romCard')));
  await shot('missing');
  await page.click('#btnRunStub');
  check('sockets: "Run without ROMs" runs without them: the welcome menu', await waitFor(page, () => window.emu.session.welcomeRunning && !window.emu.machine.hasRom)
    && await page.isVisible('#romStub') && !(await page.isVisible('#btnRomSwitchOn')));
  await shot('stub');
  // a verified Color BASIC and an Extended BASIC recognised only by name, dropped on the screen itself
  await dropFiles(page, [['my-dump.bin', BAS], ['extbas11.rom', fake(8192, 23)], ['notes.txt', Buffer.from('x')]], null, 'romCard');
  await waitFor(page, () => document.querySelector('#romSockets [data-status="verified"]'));
  check('sockets: verified and loaded-unrecognised', await rows() === 'bas:verified extbas:loaded-unrecognised', await rows());
  check('Your ROMs: what each ROM is', /✓ my-dump\.bin · Recognised/.test(await state('bas')) && /◆ extbas11\.rom · loaded, not recognised/.test(await state('extbas')), await state('bas'));
  const odd = await page.textContent('#romOdd');
  check('a ROM not recognised: what it means, its CRC32 and where to compare it', /extbas11\.rom: 8 KB, not recognised\. It is the size of the Extended Color BASIC, so it's in use as that/.test(odd)
    && /CRC32 \([0-9A-F]{8}\)/.test(odd) && await page.$eval('#romOdd a', (a) => new URL(a.href).pathname) === '/roms/', odd);
  const found = await page.$$eval('#romFound li', (l) => l.map((x) => `${x.className}|${x.textContent}`));
  check('what you dropped: every file, with its outcome', found.length === 3 && /^ok\|✓ my-dump\.bin: .*\(recognised\)/.test(found[0]) && /^warn\|◆ extbas11\.rom: .*\(not recognised: matched by/.test(found[1])
    && /^no\|✗ notes\.txt: not a ROM, ignored/.test(found[2]), found.join(' / '));
  check('Add ROMs: "Switch on" once a drop makes BASIC bootable', await page.isVisible('#btnRomSwitchOn') && /^Switch on the CoCo 1\/2/.test(await page.textContent('#btnRomSwitchOn')), await page.textContent('#btnRomSwitchOn'));
  await shot('verified-unrecognised');
  await dropFiles(page, [['x.rom', EXT]]);
  await waitFor(page, () => document.querySelectorAll('#romSockets [data-status="verified"]').length === 2);
  check('Your ROMs: a recognised ROM replaces one not recognised', await rows() === 'bas:verified extbas:verified', await rows());
  await shot('verified');
  await page.click('#btnRomSwitchOn');
  check('Add ROMs: "Switch on" boots BASIC and goes back to the emulator', await waitFor(page, () => window.emu.machine.hasRom && !window.emu.machine.useStub && location.hash === '')
    && !(await page.evaluate(romsOpen)));
  // running the stub by choice with ROMs present: "Switch on" boots them
  await page.evaluate(() => window.emu.session.runWithoutRoms());
  await openRoms(page);
  check('Add ROMs: on the stub by choice, "Switch on" is offered', await page.isVisible('#romStub') && await page.isVisible('#btnRomSwitchOn'));
  await page.click('#btnRomSwitchOn');
  check('Add ROMs: ... and boots the ROMs', await waitFor(page, () => window.emu.machine.hasRom && location.hash === ''));
  await openRoms(page);
  // a ROM for another machine: an offer to switch, not an error
  await dropFiles(page, [['d32.rom', fake(16384, 24)]]);
  await waitFor(page, () => !document.getElementById('romOffers').hidden);
  check('offer: a ROM for another machine offers to switch', /d32\.rom is for the Dragon 32\. The Dragon 32 is now ready too\./.test(await page.textContent('#romOffers'))
    && !(await page.evaluate(() => document.getElementById('toast').classList.contains('error'))), await page.textContent('#romOffers'));
  check('offer: the ready machines are summarised', /Also ready to run BASIC: Dragon 32/.test(await page.textContent('#romReady')));
  await shot('offer');
  await page.click('#romOffers button.primary');
  check('offer: "Switch to" switches machine and goes back to the emulator', await waitFor(page, () => window.emu.machine.id === 'dragon32' && location.hash === ''));
  // boot watchdog: the Dragon 32 "ROM" above is random bytes: no OK after 5 s of emulated time
  const failed = await waitFor(page, () => !document.getElementById('bootHelp').hidden, null, 30000);
  check('watchdog: shows the cause from the socket status', failed && /Dragon 32 BASIC is d32\.rom, which isn't recognised/.test(await page.textContent('#bootHelp')), await page.textContent('#bootHelp'));
  await shot('watchdog', '#screenWrap');
  await page.click('#btnBootSockets');
  check('watchdog: "Add ROMs" opens Add ROMs', await waitFor(page, romsOpen));
  await page.click('#btnRomBack');
  await page.click('#btnBootStub');
  check('watchdog: "Run without ROMs" runs the stub and the box goes', await waitFor(page, () => !window.emu.machine.hasRom && document.getElementById('bootHelp').hidden));
  // everything survives a reload (re-inject the test CRCs, which live in page memory only)
  await page.goto(`${base}?machine=coco`); await started(page);
  await inject();
  // a ROM dropped on the emulator that can't be used opens Add ROMs by itself, to say why
  await dropFiles(page, [['mc10.rom', fake(4096, 25)]]);
  check('Add ROMs: a drop that needs explaining opens it', await waitFor(page, romsOpen)
    && /✗ mc10\.rom: named like a .*MC-10.* ROM, but it is 4K instead of 8K\. Not loaded/.test(await page.textContent('#romFound')), await page.textContent('#romFound'));
  await page.click('#btnRomBack');
  // the Machine tab's "Add ROMs →" opens it too
  await page.click('#tab-machine');
  await page.click('#btnManageRoms');
  check('Add ROMs: the Machine tab\'s "Add ROMs →" opens it', await waitFor(page, romsOpen));
  await page.click('#btnRomJustLooking');
  check('Add ROMs: "Back to the emulator" closes it', await waitFor(page, () => !document.body.classList.contains('roms-open')));
  check('reload: ROMs survive, statuses intact', await rows() === 'bas:verified extbas:verified' && await page.evaluate(() => window.emu.machine.hasRom && window.emu.session.machineRoms('dragon32').bootable));
  check('ROMs card: no request ever went to colorcomputerarchive.com', archive.length === 0, archive.join(' '));
  check('ROMs card: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

async function visitChecks(browser, base, check) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = async (name, sel) => { if (shotDir) await page.locator(sel).screenshot({ path: path.join(shotDir, `visit-${name}.png`) }); };
  const screen = () => page.evaluate(() => window.emu.session.screenText().join('\n'));
  // first visit, no ROMs: the welcome program is already running on the stub
  await page.goto(base);
  const menu = () => waitFor(page, () => window.emu.session.welcomeRunning && window.emu.session.screenText()[14].includes('PRESS 1 TO 4'));
  check('first visit: opens on the welcome program running without ROMs', await menu() && !(await page.evaluate(() => window.emu.machine.hasRom))
    && /1 TALK TO LIZA/.test(await screen()), (await screen()).split('\n')[9]);
  check('first visit: "Runs without ROMs" is the welcome menu (on screen now), our programs and the Claude chat', (await page.$$eval('#shelf button', (b) => b.map((x) => x.textContent).join())) === 'Welcome menu on screen now,LIZA,Colour demo,Chat with Claude',
    await page.$$eval('#shelf button', (b) => b.map((x) => x.textContent).join()));
  check('first visit: "No BASIC · Add ROMs" in the header and the machine question', await page.isVisible('#romPill') && await page.isVisible('#askMachine'));
  check('first visit: "click for sound" until a click or key, no tune yet', await page.isVisible('#soundHint') && !(await page.evaluate(() => window.emu.audioRunning()))
    && await page.evaluate(() => window.emu.machine.ram[0x6004]) === 0);
  await shot('first', '.layout > main');
  if (shotDir) await page.locator('#screenWrap').screenshot({ path: path.join(shotDir, 'welcome-screen.png') });
  // sound unlocks on the first pointer event, and the welcome tune is armed
  await page.mouse.click(5, 5);
  check('sound: unlocked by the first click, hint gone, the welcome tune plays', await waitFor(page, () => window.emu.audioRunning() && document.getElementById('soundHint').hidden)
    && await page.evaluate(() => window.emu.session.welcomeSoundOn));
  // the menu keys: the welcome program reads them once its tune (about 2 s of emulated time) has played
  check('welcome: the tune plays to the end', await waitFor(page, () => window.emu.machine.ram[0x6005] === 1, null, 20000));
  const key = async (k) => { await page.focus('#screen'); await page.keyboard.press(k); };
  await key('3');
  check('welcome: 3 opens Add ROMs', await waitFor(page, romsOpen));
  await page.click('#btnRomBack');
  await key('4');
  check('welcome: 4 opens the Claude chat', await waitFor(page, () => document.body.classList.contains('claude-open') && window.emu.session.chatView === 'chat'
    && /app=claude/.test(location.search)));
  await page.click('#btnClaudeBack');
  check('the chat\'s "← Emulator" comes back to the welcome menu (the conversation is kept for Ask Claude)', await waitFor(page, () => !document.body.classList.contains('claude-open')
    && !window.emu.session.chatMachines && window.emu.session.welcomeRunning && !/app=claude/.test(location.search)));
  await key('2');
  check('welcome: 2 runs the colour demo', await waitFor(page, () => /Colour demo: press a key/.test(document.getElementById('toast').textContent) && window.emu.machine.cpu.pc >= 0x4000 && window.emu.machine.cpu.pc < 0x4200 && !window.emu.session.welcomeRunning));
  check('welcome: "Back to the menu" shows while the demo runs', await page.isVisible('#btnWelcomeBack'));
  await page.click('#btnWelcomeBack');
  check('welcome: "Back to the menu" returns to the menu, and hides', await menu() && await page.isHidden('#btnWelcomeBack'));
  await key('1');
  check('welcome: 1 runs LIZA', await waitFor(page, () => window.emu.session.screenText().join('').includes('I AM LIZA')));
  // "No BASIC · Add ROMs" opens Add ROMs, whose "Choose files…" opens the ROM file picker
  await page.click('#romPill');
  check('first visit: "No BASIC · Add ROMs" opens Add ROMs', await waitFor(page, romsOpen));
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null), page.click('#btnRomFiles')]);
  check('Add ROMs: "Choose files…" opens the ROM picker', !!chooser && chooser.isMultiple());
  await page.click('#btnRomBack');
  // the shelf runs the colour demo
  await page.click('#shelf button:text-is("Colour demo")');
  check('shelf: the colour demo runs', await waitFor(page, () => /demo\.bin/.test(document.getElementById('toast').textContent)));
  // the machine question, answered once
  await page.click('#askMachine button[data-machine="coco"]');
  check('machine question: switches machine and the welcome program runs there', await waitFor(page, () => window.emu.machine.id === 'coco' && window.emu.session.welcomeRunning && window.emu.session.screenText()[14].includes('PRESS 1 TO 4'))
    && !(await page.$('#askMachine')));
  // a program of the user's own, then a return visit
  await page.setInputFiles('#fileProgram', { name: 'mine.bin', mimeType: 'application/octet-stream', buffer: fs.readFileSync(path.join(ROOT, 'examples/demo.bin')) });
  await waitFor(page, () => !document.getElementById('mediaOffer').hidden);
  await page.click('#btnMediaAnyway');
  await waitFor(page, () => /mine\.bin/.test(document.getElementById('toast').textContent));
  await page.evaluate(() => window.emu.session.index.flush());
  await page.reload();
  await ready(page);
  // (the menu says welcome back and offers the last item; no welcome-back card)
  await waitFor(page, () => window.emu.session.welcomeRunning && window.emu.session.screenText()[12].includes('CARRY ON'));
  const back = await page.evaluate(() => ({ machine: window.emu.machine.id, greet: window.emu.session.screenText()[6].trim(), five: window.emu.session.screenText()[12].trim(),
    card: !document.getElementById('welcome').hidden, last: document.getElementById('lastTime').hidden ? null : document.getElementById('lastName').textContent }));
  check('returning: same machine, the menu says WELCOME BACK and offers the last item as 5; "Last time" in the Media tab; no card',
    back.machine === 'coco' && back.greet === 'WELCOME BACK' && back.five === '5 CARRY ON WITH MINE.BIN' && !back.card && back.last === 'mine.bin · CoCo 1/2', JSON.stringify(back));
  check('returning: the machine question is not asked again', !(await page.$('#askMachine')));
  await page.click('#btnRunAgain');
  check('returning: "Run again" loads it', await waitFor(page, () => /mine\.bin/.test(document.getElementById('toast').textContent) && window.emu.machine.cpu.pc >= 0x4000));
  check('visits: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

// Returning visits: leaving LIZA with BYE brings the menu back ("BYE FOR NOW.
// PICK ANOTHER?"); a returning visitor without ROMs lands on the menu ("WELCOME BACK", 5 CARRY ON WITH LIZA, PRESS 1
// TO 5), with "Last time · LIZA · Run again" and the menu "on screen now" in the Media tab; key 5 runs LIZA again.
// With ROMs the machine boots its ROMs (not the menu), "Last time" names the file and its machine, and the welcome
// menu is one click away in "Runs without ROMs". Screenshots of each state, to compare with the design.
async function returningChecks(browser, base, check) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1060 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const screen = () => page.evaluate(() => window.emu.session.screenText());
  const shot = async (name) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, `returning-${name}.png`) }); };
  await page.goto(base);
  // started, not only welcomeRunning (which the Session can report before the machine and the page's sound unlock are
  // there: a click then is lost, and the tune never plays)
  await waitFor(page, () => window.emu && window.emu.started && window.emu.session.welcomeRunning && !!window.emu.machine);
  await page.mouse.click(5, 5);
  await waitFor(page, () => window.emu.machine.ram[0x6005] === 1, null, 20000);   // the tune played: keys are read
  await page.focus('#screen'); await page.keyboard.press('1');
  await waitFor(page, () => window.emu.session.screenText().join('').includes('I AM LIZA'));
  await page.keyboard.type('BYE', { delay: 60 }); await page.keyboard.press('Enter');
  // LIZA keeps its goodbye on the screen for 3 s of machine time (Session LIZA_BYE_SECONDS) before the menu comes
  // back: bounded in machine frames (400, 8 s at 50 Hz), so a page running slowly under load is not cut short
  const bye = await waitForFrames(page, () => window.emu.session.welcomeRunning && window.emu.session.screenText()[7].trim() === 'BYE FOR NOW. PICK ANOTHER?', null, 400);
  const t = await screen();
  check('returning: BYE in LIZA brings the menu back, "BYE FOR NOW. PICK ANOTHER?", 1 to 4', bye && t[14].trim() === 'PRESS 1 TO 4' && t[9].trim() === '1 TALK TO LIZA', JSON.stringify(t.slice(7, 15)));
  await shot('back-from-liza');
  // a return visit, no ROMs
  await page.reload(); await ready(page);
  await waitFor(page, () => window.emu.session.welcomeRunning && window.emu.session.screenText()[12].includes('CARRY ON'));
  const r = await page.evaluate(() => ({ greet: window.emu.session.screenText()[6].trim(), five: window.emu.session.screenText()[12].trim(), gap: window.emu.session.screenText()[13].trim(), press: window.emu.session.screenText()[14].trim(),
    media: (document.querySelector('[role="tab"][aria-controls="panel-media"]').click(), document.getElementById('panel-media').innerText),
    card: !document.getElementById('welcome').hidden, last: document.getElementById('lastTime').hidden ? null : document.getElementById('lastName').textContent,
    shelf: [...document.querySelectorAll('#shelf button')].map((b) => b.textContent).join('|'), pill: getComputedStyle(document.getElementById('romPill')).display !== 'none' && !document.getElementById('romPill').hidden }));
  check('returning (no ROMs): the menu says WELCOME BACK and offers 5 CARRY ON WITH LIZA; "Last time · LIZA"; the menu on screen now; no card; No BASIC in the header',
    r.greet === 'WELCOME BACK' && r.five === '5 CARRY ON WITH LIZA' && r.gap === '' && r.press === 'PRESS 1 TO 5' && !r.card && r.last === 'LIZA'
    && r.shelf === 'Welcome menu on screen now|LIZA|Colour demo|Chat with Claude' && r.pill, JSON.stringify(r));
  // the Media tab as shown says "Last time · LIZA" with no "Nothing loaded yet" contradicting it, and the
  // menu keeps a blank row above PRESS 1 TO 5 (r.gap, above)
  check('returning (no ROMs): the Media tab shows "Last time · LIZA" and no "Nothing loaded yet"',
    /Last time\s*LIZA/.test(r.media) && !/Nothing loaded yet/.test(r.media), r.media.slice(0, 200));
  await shot('no-roms');
  await page.mouse.click(5, 5);
  await waitFor(page, () => window.emu.machine.ram[0x6005] === 1, null, 20000);
  await page.focus('#screen'); await page.keyboard.press('5');
  check('returning: key 5 carries on with LIZA', await waitFor(page, () => window.emu.session.screenText().join('').includes('I AM LIZA')));
  // with ROMs: a synthetic Dragon 64 set; the machine boots it (not the menu)
  await page.evaluate(() => { const s = window.emu.session, f = (n) => new Uint8Array(0x4000).fill(n); s.addRoms([{ name: 'd64_1.rom', bytes: f(0x12) }, { name: 'd64_2.rom', bytes: f(0x13) }]); });
  await page.setInputFiles('#fileProgram', { name: 'games.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0x55, 2, 0x30, 0x00, 0x00, 0x01, 0x30, 0x00, 0xAA, 0x39]) });
  await waitFor(page, () => /games\.bin/.test(document.getElementById('toast').textContent));
  await page.evaluate(() => window.emu.session.index.flush());
  await page.reload(); await ready(page); await started(page);
  const w = await page.evaluate(() => ({ menu: window.emu.session.welcomeRunning, rom: window.emu.machine.hasRom, card: !document.getElementById('welcome').hidden,
    last: document.getElementById('lastTime').hidden ? null : document.getElementById('lastName').textContent, shelf: [...document.querySelectorAll('#shelf button')].map((b) => b.textContent).join('|') }));
  check('returning (with ROMs): the machine boots its ROMs, not the menu; "Last time · games.bin · Dragon 64"; the welcome menu one click away; no card',
    !w.menu && w.rom && !w.card && w.last === 'games.bin · Dragon 64' && w.shelf === 'Welcome menu|LIZA|Colour demo|Chat with Claude', JSON.stringify(w));
  await shot('with-roms');
  await page.click('#shelf button[data-shelf="welcome"]');
  check('returning (with ROMs): "Welcome menu" runs it', await waitFor(page, () => window.emu.session.welcomeRunning && window.emu.session.screenText()[6].trim() === 'WELCOME BACK'));
  check('returning: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

// The HD6309 runs the 6809 programs. `?machine=dragon64&cpu=6309` (the Machine tab's choice, or a link)
// must open exactly as the 6809 does: the welcome menu fetched and running, no error toast, key 1 to LIZA,
// BYE back to the menu, key 2 the colour demo, key 4 the chat, and the same after a reload with no
// parameters (the choice is stored, and the Session's lookups are by CPU family, not by the literal CPU).
// The bug was that the lookups were keyed by `config.cpu` with no 6309 entry, so the page fetched
// examples/undefined (HTTP 404), the stub stayed blank and the Media tab lost the colour demo.
async function cpu6309Checks(browser, base, check) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1060 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // every toast the page shows, recorded as it appears: the error toast lives 4 s and the page clears both its
  // text and its error class when it ends, so sampling after a wait misses the bug's own symptom
  await page.addInitScript(() => {
    window.__toasts = [];
    const watch = () => {
      const box = document.getElementById('toast');
      if (!box) return setTimeout(watch, 0);
      new MutationObserver(() => { if (!box.hidden) window.__toasts.push({ text: document.getElementById('toastText').textContent, error: box.classList.contains('error') }); })
        .observe(box, { attributes: true, childList: true, subtree: true, characterData: true });
    };
    watch();
  });
  const open = async (q, within = 15000) => {
    await page.goto(`${base}${q}`);
    return waitFor(page, () => window.emu && window.emu.session && window.emu.session.machine
      && window.emu.session.machine.config.cpu === '6309' && window.emu.machine && window.emu.machine.config.cpu === '6309', null, within);
  };
  const msg = () => page.textContent('#toast');
  const ev = (fn) => page.evaluate(fn);
  const isError = () => page.evaluate(() => document.getElementById('toast').classList.contains('error'));
  // the menu is on screen and says PRESS 1 TO 4 or TO 5 (option 5 appears only when something ran last)
  const menu = () => waitFor(page, () => window.emu.session.welcomeRunning && /PRESS 1 TO [45]/.test(window.emu.session.screenText()[14]), null, 15000);
  const screenText = async () => (await ev(() => window.emu.session.screenText())).join('\n');
  const key = async (k) => { await page.focus('#screen'); await page.keyboard.press(k); };

  // the free-standing case: no missing file, no error toast, the menu, and the shelf offers LIZA and the demo
  const opened = await open('?machine=dragon64&cpu=6309');
  check('cpu=6309: the link opens on the 6309, welcome menu fetched and running', opened && await menu(), await msg());
  // the bug's symptom was a toast naming examples/undefined (an error). Recorded as it appeared, not sampled
  // after the wait: the toast clears itself after 4 s, so a sample taken after `menu()`'s 15 s wait would miss
  // it and this check would be unable to fail.
  const seen0 = await page.evaluate(() => window.__toasts || null);
  check('cpu=6309: no error toast and no "undefined" (the bug showed "Welcome: examples/undefined: HTTP 404")',
    Array.isArray(seen0) && !seen0.some((t) => t.error || /undefined/i.test(t.text)) && !(await isError()),
    JSON.stringify(seen0));
  const t0 = await screenText();
  check('cpu=6309: the menu is the 6809 build\'s, key 1 TO 4 and LIZA', /1 TALK TO LIZA/.test(t0) && /PRESS 1 TO 4/.test(t0), t0.split('\n')[9]);
  check('cpu=6309: "Colour demo" is still on the "Runs without ROMs" shelf (the Media tab keeps it)', /Colour demo/.test(await page.$$eval('#shelf button', (b) => b.map((x) => x.textContent).join('|'))),
    await page.$$eval('#shelf button', (b) => b.map((x) => x.textContent).join('|')));

  // keys 1 and BYE round-trip, all on the 6309
  await key('1');
  check('cpu=6309: key 1 runs LIZA', await waitFor(page, () => window.emu.session.screenText().join('').includes('I AM LIZA'), null, 20000));
  // running LIZA must not have switched the machine (the old path switched a 6309 to a 6809 Dragon 64)
  // (a precondition, not evidence that the bug is fixed: on the base commit LIZA never starts, so "the machine is
  // still the 6309" is trivially true. The discriminating check here is "key 1 runs LIZA" above.)
  check('cpu=6309: LIZA runs without leaving the 6309 (no switch to a 6809 machine)',
    await ev(() => window.emu.machine.config.cpu === '6309' && window.emu.machine.id === 'dragon64'), await ev(() => `${window.emu.machine.id} ${window.emu.machine.config.cpu}`));
  await page.focus('#screen'); await page.keyboard.type('BYE', { delay: 60 }); await page.keyboard.press('Enter');
  // the goodbye lasts LIZA_BYE_SECONDS of MACHINE time, so this is bounded in machine frames (400, 8 s at 50 Hz),
  // as returningChecks does: a page running slowly under load must not be cut short by a wall-clock limit
  check('cpu=6309: BYE returns to the welcome menu', await waitForFrames(page, () => window.emu.session.welcomeRunning && window.emu.session.screenText()[7].trim() === 'BYE FOR NOW. PICK ANOTHER?', null, 400), await screenText());
  // the menu is started by the page after `menu` arrives (a fetch of welcome.bin plus the program's frames), so
  // bound it in machine frames like the BYE wait above, not in wall time
  check('cpu=6309: the menu says "PRESS 1 TO 4" again',
    await waitForFrames(page, () => window.emu.session.welcomeRunning && /PRESS 1 TO [45]/.test(window.emu.session.screenText()[14]), null, 400), await screenText());

  // keys 2 and 4 (demo, chat) come up on the 6309 as on the 6809
  await key('2');
  check('cpu=6309: key 2 runs the colour demo', await waitFor(page, () => /Colour demo: press a key/.test(document.getElementById('toast').textContent) && window.emu.machine.cpu.pc >= 0x4000 && window.emu.machine.cpu.pc < 0x4200, null, 20000), await msg());
  // the demo is really executing on the 6309: over a short window its program counter is seen in the demo's own
  // code ($4000-$41FF, where demo.bin loads), the 6309's illegal-opcode trap flag (MD bit 6) is never set, and the
  // welcome program is no longer in charge. (A single sample is not enough: the demo calls the stub's POLCAT at
  // $B100 between frames. The trap bit, not a PC at $FFF0, is the signal: a 6309 trap jumps to the vector's
  // CONTENTS in one instruction, so the PC is never $FFF0 itself.)
  {
    const seen = await ev(async () => {
      const out = { inDemo: false, trapped: false, welcome: false };
      for (let i = 0; i < 40; i++) {
        const m = window.emu.machine, pc = m.cpu.pc;
        if (pc >= 0x4000 && pc < 0x4200) out.inDemo = true;
        if ((m.cpu.md & 0x40) !== 0) out.trapped = true;   // illegal-opcode trap taken
        out.welcome = out.welcome || window.emu.session.welcomeRunning;
        await new Promise((r) => setTimeout(r, 25));
      }
      return out;
    });
    check('cpu=6309: the demo executes its own code and takes no illegal-opcode trap', seen.inDemo && !seen.trapped && !seen.welcome, JSON.stringify(seen));
  }
  // "Back to the menu" starts the menu afresh (greeting 'first', no option 5): the same on 6809 and 6309
  await page.click('#btnWelcomeBack');
  check('cpu=6309: "Back to the menu" returns to the menu', await menu() && !(await isError()), await screenText());
  check('cpu=6309: "Back to the menu" starts it afresh, no option 5 (as on the 6809)', await ev(() => window.emu.session.screenText()[14].includes('PRESS 1 TO 4') && !window.emu.session.screenText().join('').includes('CARRY ON')), await screenText());
  await key('4');
  check('cpu=6309: key 4 opens the Claude chat (no switch to a 6809)', await waitFor(page, () => document.body.classList.contains('claude-open') && window.emu.session.chatView === 'chat', null, 15000), await msg());
  // the chat machine is the second machine startChat makes; session.machine alone is not evidence (with the bug,
  // startChat throws and session.machine is still the BASIC machine, which is a 6309 from the URL either way)
  check('cpu=6309: the chat machine is the 6309 the visitor chose',
    await ev(() => !!window.emu.session.chatMachines && window.emu.session.chatMachines.chat.config.cpu === '6309'),
    await ev(() => window.emu.session.chatMachines ? window.emu.session.chatMachines.chat.config.cpu : 'no chat machine'));
  await page.click('#btnClaudeBack');
  check('cpu=6309: "← Emulator" comes back to the welcome menu on the 6309', await waitFor(page, () => !document.body.classList.contains('claude-open') && window.emu.session.welcomeRunning && window.emu.machine.config.cpu === '6309'), await msg());

  // a new visit with NO parameters: the 6309 choice must come from storage, not from the link (reloading the
  // current URL would keep `?cpu=6309` in the address and prove nothing). The demo ran, so the menu offers it as
  // option 5 ("PRESS 1 TO 5"), exactly as the 6809 would.
  // (persistence is a precondition, not evidence: the base commit stores the choice too. The checks that fail
  // there are the menu, option 5 and the shelf below, which all need the lookups to work.)
  await page.goto(base);
  await waitFor(page, () => window.emu && window.emu.ready === true);
  check('cpu=6309: a visit with no parameters at all keeps the 6309 choice (from storage)', await waitFor(page, () => window.emu.machine && window.emu.machine.config.cpu === '6309')
    && await ev(() => location.search === ''), await ev(() => location.search));
  check('cpu=6309: the new visit opens on the welcome menu, no error', await menu() && !(await isError()), await msg());
  check('cpu=6309: the new visit offers what ran last (the demo) as option 5, as on the 6809',
    await waitFor(page, () => window.emu.session.screenText()[12].includes('CARRY ON WITH COLOUR') && window.emu.session.screenText()[14].includes('PRESS 1 TO 5')), await screenText());
  check('cpu=6309: "Colour demo" is still on the shelf (the new visit\'s Media tab keeps it)', /Colour demo/.test(await page.$$eval('#shelf button', (b) => b.map((x) => x.textContent).join('|'))),
    await page.$$eval('#shelf button', (b) => b.map((x) => x.textContent).join('|')));
  check('cpu=6309: no page errors in the whole case', !errors.length, errors.join('; '));
  await ctx.close();

  // one more model, by keyboard on the Machine tab: the CoCo 1/2 switches to the 6309 and the menu starts
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 1060 } });
  const p2 = await ctx2.newPage();
  const errors2 = [];
  p2.on('pageerror', (e) => errors2.push(e.message));
  await p2.goto(`${base}?machine=coco`);
  await waitFor(p2, () => window.emu && window.emu.ready === true);
  await p2.evaluate(() => {
    const s = window.emu.session, sel = document.getElementById('cpuSel');
    sel.value = '6309'; sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // (a precondition: the base commit accepts cpu=6309 in the profiles too, so this is not evidence by itself;
  // the discriminating check is that the welcome menu then starts, below)
  check('cpu=6309 (Machine tab, CoCo 1/2): the machine is a 6309', await waitFor(p2, () => window.emu.machine.config.cpu === '6309' && window.emu.machine.id === 'coco'));
  check('cpu=6309 (Machine tab, CoCo 1/2): the welcome menu starts', await waitFor(p2, () => window.emu.session.welcomeRunning && /PRESS 1 TO [45]/.test(window.emu.session.screenText()[14]), null, 15000),
    await p2.evaluate(() => window.emu.session.screenText().join('\n')));
  check('cpu=6309 (Machine tab, CoCo 1/2): no page errors', !errors2.length, errors2.join('; '));
  await ctx2.close();
}

// Reset and power without ROMs (like a real computer, never a dead end), through
// the page's buttons on a Dragon 64 without ROMs: Reset restarts what runs (the welcome menu stays the menu, LIZA
// restarts LIZA, a binary restarts at its exec address); "Switch off and on" and "Run without ROMs" turn the machine
// on into the welcome menu ("WELCOME BACK"). The stub's bare "NO ROM LOADED" screen never shows. Screenshots of
// each, to compare with the design.
async function powerOnChecks(browser, base, check) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1060 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const text = () => page.evaluate(() => window.emu.session.screenText().join('\n'));
  const bare = () => page.evaluate(() => window.emu.session.screenText().join('').includes('NO ROM LOADED'));
  const shot = async (name) => { if (shotDir) { await redrawn(page); await page.screenshot({ path: path.join(shotDir, `power-${name}.png`) }); } };
  await page.goto(`${base}?machine=dragon64`);
  await waitFor(page, () => window.emu && window.emu.session.welcomeRunning);
  // Reset on the welcome menu: the menu again
  await page.click('#btnReset');
  check('Reset (no ROMs) on the welcome menu: the welcome menu restarts', await waitFor(page, () => window.emu.session.welcomeRunning
    && window.emu.session.screenText()[9].trim() === '1 TALK TO LIZA') && !(await bare()), await text());
  // Reset in LIZA: LIZA from the start
  await openTab(page, 'Media');
  await page.click('#shelf button:text-is("LIZA")');
  await waitFor(page, () => window.emu.session.screenText().join('').includes('I AM LIZA'));
  await page.focus('#screen'); await page.keyboard.type('HELLO THERE', { delay: 60 }); await page.keyboard.press('Enter');
  await waitFor(page, () => window.emu.session.screenText().join('').includes('HELLO THERE'));
  await page.click('#btnReset');
  check('Reset (no ROMs) in LIZA: LIZA restarts from its greeting, what was typed gone', await waitFor(page, () => { const t = window.emu.session.screenText().join('');
    return t.includes('I AM LIZA') && !t.includes('HELLO THERE'); }) && !(await bare()), await text());
  await shot('reset-liza');
  // Switch off and on: the welcome menu, greeting the visitor back and offering LIZA again
  await page.click('#btnHardReset');
  check('Switch off and on (no ROMs): the welcome menu, WELCOME BACK, 5 CARRY ON WITH LIZA', await waitFor(page, () => window.emu.session.welcomeRunning
    && window.emu.session.screenText()[6].trim() === 'WELCOME BACK' && window.emu.session.screenText()[12].trim() === '5 CARRY ON WITH LIZA') && !(await bare()), await text());
  await shot('switch-off-and-on');
  // Reset in a binary of the visitor's: it restarts at its exec address (INC $0400 ; BRA $3000)
  await page.setInputFiles('#fileProgram', { name: 'loop.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0x55, 2, 0x30, 0x00, 0x00, 0x05, 0x30, 0x00, 0xAA, 0x7C, 0x04, 0x00, 0x20, 0xFB]) });
  await waitFor(page, () => /loop\.bin/.test(document.getElementById('toast').textContent));
  await page.evaluate(() => window.emu.machine.poke(0x3001, 0x05));
  await page.click('#btnReset');
  await waitFor(page, () => { const m = window.emu.machine; return m.cpu.pc >= 0x3000 && m.cpu.pc <= 0x3004 && m.ram[0x3001] === 0x04; });
  const run = await page.evaluate(() => ({ pc: window.emu.machine.cpu.pc, b: window.emu.machine.ram[0x3001], menu: window.emu.session.welcomeRunning }));
  check('Reset (no ROMs) in a binary: it restarts at its exec address, its own bytes back', run.pc >= 0x3000 && run.pc <= 0x3004 && run.b === 0x04 && !run.menu, JSON.stringify(run));
  // "Run without ROMs" in Add ROMs (shown while a required ROM is missing), from the binary: the welcome menu
  await page.evaluate(() => { location.hash = '#add-roms'; });
  await waitFor(page, () => !document.getElementById('romCard').hidden);
  await page.click('#btnRunStub');
  check('"Run without ROMs" (Add ROMs): the welcome menu, WELCOME BACK', await waitFor(page, () => window.emu.session.welcomeRunning
    && window.emu.session.screenText()[6].trim() === 'WELCOME BACK') && !(await bare()), await text());
  await page.evaluate(() => { location.hash = ''; });
  await waitFor(page, () => document.getElementById('romCard').hidden);
  await shot('run-without-roms');
  // "Run without ROMs" in the boot help, on a machine whose ROMs are in but don't start BASIC: the welcome menu
  await page.evaluate(() => { const s = window.emu.session, f = (n) => new Uint8Array(0x4000).fill(n); s.addRoms([{ name: 'd64_1.rom', bytes: f(0x12) }, { name: 'd64_2.rom', bytes: f(0x13) }]); });
  await waitFor(page, () => window.emu.machine.hasRom && !document.getElementById('bootHelp').hidden, null, 20000);
  await page.click('#btnBootStub');
  check('"Run without ROMs" (boot help) with ROMs in: the welcome menu, WELCOME BACK', await waitFor(page, () => window.emu.session.welcomeRunning && window.emu.machine.useStub
    && window.emu.session.screenText()[6].trim() === 'WELCOME BACK') && !(await bare()), await text());
  // "Remove ROMs" (Add ROMs) forgets the machine's ROMs and turns it on without them: the welcome menu. From the stub's
  // bare prompt (made below the page) so the menu that appears is the one Remove ROMs started.
  await stubPrompt(page);
  await page.evaluate(() => { location.hash = '#add-roms'; });
  await waitFor(page, () => !document.getElementById('romCard').hidden);
  await page.click('#btnRomClear');
  check('"Remove ROMs": the ROMs are forgotten and the machine starts on the welcome menu, WELCOME BACK', await waitFor(page, () => window.emu.session.welcomeRunning
    && window.emu.session.screenText()[6].trim() === 'WELCOME BACK' && !window.emu.session.machineRoms('dragon64').sockets.some((x) => x.status !== 'missing-required' && x.status !== 'missing-optional'))
    && !(await bare()), `${await text()} ${JSON.stringify(await page.evaluate(() => window.emu.session.machineRoms('dragon64').sockets.map((x) => x.status)))}`);
  await page.evaluate(() => { location.hash = ''; });
  await waitFor(page, () => document.getElementById('romCard').hidden);
  // Switching, from the machine menu, to a machine without its
  // ROMs turns it on into its welcome menu: the CoCo 3 (6809 build) and the MC-10 (its own 6803 build)
  for (const [id, sub] of [['coco3', 'DRAGON AND COLOR COMPUTER'], ['mc10', 'TANDY MC-10']]) {
    await pickMachine(page, id);
    check(`switching to the ${id} (no ROMs) from the machine menu: its welcome menu, WELCOME BACK`, await waitFor(page, (id) => window.emu.machine.id === id
      && window.emu.session.welcomeRunning && window.emu.session.screenText()[7].trim() === 'WELCOME BACK', id) && !(await bare()), `${sub} | ${await text()}`);
    // option 5 offers only what runs here: loop.bin was loaded on the Dragon 64, so not on this machine
    const five = await page.evaluate(() => [window.emu.session.screenText()[13].trim(), window.emu.session.screenText()[14].trim()]);
    check(`switching to the ${id}: the menu doesn't offer the Dragon 64's loop.bin (no option 5, PRESS 1 TO 4)`, five[0] === '' && five[1] === 'PRESS 1 TO 4', JSON.stringify(five));
  }
  await shot('switch-mc10');
  // the MC-10: Reset keeps its menu, Switch off and on brings it back (no more bare stub screen on the 6803)
  await page.click('#btnReset');
  check('MC-10 Reset (no ROMs) on its welcome menu: the menu restarts', await waitFor(page, () => window.emu.session.welcomeRunning
    && window.emu.session.screenText()[9].trim() === '1 TALK TO LIZA') && !(await bare()), await text());
  await page.click('#btnHardReset');
  check('MC-10 Switch off and on (no ROMs): its welcome menu, WELCOME BACK', await waitFor(page, () => window.emu.session.welcomeRunning
    && window.emu.session.screenText()[7].trim() === 'WELCOME BACK') && !(await bare()), await text());
  // a snapshot taken on the stub's bare prompt (made below the page: the page no longer gets there) opens on the
  // welcome menu; one taken in a program opens in it
  await pickMachine(page, 'dragon64');
  check('back on the Dragon 64, the menu offers its loop.bin again (5 CARRY ON WITH LOOP.BIN)', await waitFor(page, () => window.emu.session.welcomeRunning
    && window.emu.session.screenText()[12].trim() === '5 CARRY ON WITH LOOP.BIN'), await text());
  await stubPrompt(page);
  await waitFor(page, () => window.emu.machine.atStubPrompt() && window.emu.session.screenText().join('').includes('NO ROM LOADED'));
  const bareSnap = await page.evaluate(async () => [...(await window.emu.session.snapshotFile()).bytes]);
  await page.setInputFiles('#fileProgram', { name: 'loop.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0x55, 2, 0x30, 0x00, 0x00, 0x05, 0x30, 0x00, 0xAA, 0x7C, 0x04, 0x00, 0x20, 0xFB]) });
  await waitFor(page, () => /loop\.bin/.test(document.getElementById('toast').textContent));
  const loopSnap = await page.evaluate(async () => [...(await window.emu.session.snapshotFile()).bytes]);
  await dropFiles(page, [['bare.cloadm', bareSnap]]);
  check('a snapshot taken on the stub\'s bare prompt opens on the welcome menu', await waitFor(page, () => window.emu.session.welcomeRunning
    && window.emu.session.screenText()[6].trim() === 'WELCOME BACK') && !(await bare()), await text());
  await dropFiles(page, [['loop.cloadm', loopSnap]]);
  await waitFor(page, () => { const m = window.emu.machine; return m.cpu.pc >= 0x3000 && m.cpu.pc <= 0x3004 && !window.emu.session.welcomeRunning; });
  const inLoop = await page.evaluate(() => ({ pc: window.emu.machine.cpu.pc, menu: window.emu.session.welcomeRunning, msg: document.getElementById('toast').textContent }));
  check('a snapshot taken in a program opens in it', inLoop.pc >= 0x3000 && inLoop.pc <= 0x3004 && !inLoop.menu, JSON.stringify(inLoop));
  // the POKE book on the welcome menu: the POKE is done, not typed into the menu (its digits would be menu keys)
  await page.click('#btnHardReset');
  await waitFor(page, () => window.emu.session.welcomeRunning);
  const keysBefore = await page.evaluate(() => { window.__menuKeys = []; window.emu.session.on((e) => { if (e.startsWith('welcome:')) window.__menuKeys.push(e); }); return 0; });
  await openTab(page, 'POKEs');
  await page.click('#pokeBook button[data-poke="POKE 65495,0"]');
  // the POKE is done; then a few frames, in which a menu key it wrongly pressed would show
  await waitFor(page, () => window.emu.machine.sam.rate === 1);
  await emuFrames(page, 60);   // longer than typing "POKE 65495,0" into the key queue would take to reach its digits
  const poked = await page.evaluate(() => ({ rate: window.emu.machine.sam.rate, keys: window.__menuKeys.join(), menu: window.emu.session.welcomeRunning, msg: document.getElementById('toast').textContent }));
  check('the POKE book on the welcome menu: POKE 65495,0 sets the SAM rate; no menu key pressed; the menu stays', poked.rate === 1 && !poked.keys && poked.menu && keysBefore === 0,
    JSON.stringify(poked));
  await page.click('#pokeBook button[data-poke="POKE 65494,0"]');
  check('reset and power without ROMs: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

async function mediaChecks(browser, base, check) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?machine=dragon64`); await started(page);
  // a DECB binary (CoCo) on the Dragon 64: the offer, then "Open on" the CoCo
  const decb = Buffer.from([0, 0, 4, 0x30, 0x00, 0x86, 0x41, 0x20, 0xFE, 0xFF, 0, 0, 0x30, 0x00]);
  await page.setInputFiles('#fileProgram', { name: 'game.bin', mimeType: 'application/octet-stream', buffer: decb });
  await waitFor(page, () => !document.getElementById('mediaOffer').hidden);
  check('media: a CoCo binary on a Dragon offers to switch', /game\.bin is a DECB binary for a CoCo\..*Your Dragon 64 may not run it/.test(await page.textContent('#mediaOffer'))
    && await page.textContent('#btnMediaSwitch') === 'Open on CoCo 1/2', await page.textContent('#mediaOffer'));
  if (shotDir) await page.locator('#mediaOffer').screenshot({ path: path.join(shotDir, 'media-offer.png') });
  await page.click('#btnMediaSwitch');
  check('media: "Open on" switches machine and runs it there', await waitFor(page, () => window.emu.machine.id === 'coco' && window.emu.machine.cpu.a === 0x41 && window.emu.machine.cpu.pc === 0x3002));
  // "Load anyway" keeps the machine
  await pickMachine(page, 'dragon64');
  await page.setInputFiles('#fileProgram', { name: 'game.bin', mimeType: 'application/octet-stream', buffer: decb });
  await waitFor(page, () => !document.getElementById('mediaOffer').hidden);
  await page.click('#btnMediaAnyway');
  check('media: "Load anyway" loads it on the machine in use', await waitFor(page, () => window.emu.machine.id === 'dragon64' && window.emu.machine.cpu.pc === 0x3002));
  // a disk image made by MAME's imgtool, for the other family: says what it is and offers to switch
  await dropFiles(page, [['games.dsk', fs.readFileSync(path.join(ROOT, 'tests/fixtures/disks/rsdos.dsk'))]]);
  check('media: a disk image for another machine says its format and offers to switch', await waitFor(page, () => !document.getElementById('mediaOffer').hidden
    && /games\.dsk is a RS-DOS disk for a CoCo /.test(document.getElementById('mediaOffer').textContent)), await page.textContent('#mediaOffer'));
  await page.click('#btnMediaAnyway');
  check('media: a disk image loaded anyway without a DOS ROM says which ROM it needs', await waitFor(page, () => /Disks need a disk cartridge ROM: DragonDOS cartridge \(ddos10\.rom\)/.test(document.getElementById('toast').textContent)),
    await page.textContent('#toast'));
  // paste types into LIZA (on the stub)
  await openDebugger(page);
  await page.click('#btnAsmLiza');
  await waitFor(page, () => document.getElementById('asmSource').value.includes('READLN'));   // the source is fetched
  await page.click('#btnAsmRun');
  await waitFor(page, () => window.emu.session.screenText().join('').includes('I AM LIZA'));
  await page.click('#btnDbgBack');
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'I feel happy\n');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.getElementById('screen').dispatchEvent(ev);
  });
  check('paste: pasted text types itself in', await waitFor(page, () => window.emu.session.screenText().join('\n').includes('> I FEEL HAPPY')),
    (await page.evaluate(() => window.emu.session.screenText().slice(5, 9).join('|'))));
  check('media: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

async function mediaBackendChecks(browser, base, check) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // ---- real OPFS in Chromium: a ROM stored, then still there after a reload ----
  await page.goto(`${base}?machine=coco`); await started(page);
  check('OPFS: the page runs on the browser-private store', await page.evaluate(() => window.emu.session.media.kind) === 'opfs',
    await page.evaluate(() => window.emu.session.media.kind));
  const D1 = fake(16384, 31), D2 = fake(16384, 32);
  await dropFiles(page, [['d64_1.rom', D1], ['d64_2.rom', D2]]);
  const stored = await waitFor(page, () => window.emu.session.machineRoms('dragon64').bootable);
  // the store's writes are chained and best-effort until the index is flushed (js/media/library.js); the file
  // count below is what reached OPFS, so wait for that first. A drop now puts each image once per model it fits
  // (the Dragon 64 and the 64 Plus share these ROMs), which lengthened the chain enough for the count to race it.
  await page.evaluate(() => window.emu.session.index.flush());
  // the blob is really in OPFS, not just in the page's memory
  const inOpfs = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('roms', { create: false });
    let n = 0;
    for await (const [name, h] of dir.entries()) if (h.kind === 'file' && /\.rom$/.test(name)) n++;
    return n;
  });
  check('OPFS: the ROM images are files in browser-private storage', stored && inOpfs === 2, `(${inOpfs} image files)`);
  await page.reload(); await ready(page);
  check('OPFS: the ROM library survives a reload', await page.evaluate(() => window.emu.session.machineRoms('dragon64').bootable));
  const opfsList = await page.evaluate(async () => {
    const m = window.emu.session.media;
    return { missing: (await m.list('nothing-here/')).length, deep: (await m.list('roms/nothing/')).length, partial: (await m.list('rom')).every((f) => f.name.startsWith('rom')) && (await m.list('rom')).length > 0 };
  });
  check('OPFS: list() of a prefix with no directory is empty (not the whole store under that name); a partial name still filters',
    opfsList.missing === 0 && opfsList.deep === 0 && opfsList.partial, JSON.stringify(opfsList));
  check('OPFS: the recent list survives a reload', await page.evaluate(() => window.emu.session.recentMedia().length) >= 0);
  // a file removed between the directory listing and the read of its size (a Library delete in flight): listed
  // without it, not a NotFoundError for the whole list (seen under load in the library check)
  const vanished = await page.evaluate(async () => {
    const m = window.emu.session.media;
    await m.write('library/GONE.BIN', new Uint8Array([1, 2, 3])); await m.write('library/STAYS.BIN', new Uint8Array([4]));
    const P = FileSystemFileHandle.prototype, getFile = P.getFile;
    P.getFile = function () { return this.name === 'GONE.BIN' ? Promise.reject(new DOMException('gone', 'NotFoundError')) : getFile.call(this); };
    let names, err = null;
    try { names = (await m.list('library/')).map((x) => x.name); } catch (e) { err = e.name + ': ' + e.message; } finally { P.getFile = getFile; }
    await m.remove('library/GONE.BIN'); await m.remove('library/STAYS.BIN');
    return { err, names };
  });
  check('OPFS: a file removed while the list is taken is left out, the rest listed', !vanished.err && vanished.names.includes('library/STAYS.BIN') && !vanished.names.includes('library/GONE.BIN'), JSON.stringify(vanished));

  // ---- the one-time migration from the localStorage layout current main wrote ----
  {
    const mctx = await browser.newContext();
    const mp = await mctx.newPage();
    mp.on('pageerror', (e) => errors.push(e.message));
    const rom = fake(8192, 41), prog = Buffer.alloc(64, 0x5A);
    // write exactly what main stored, then load the page: it must migrate and leave nothing behind
    await mp.goto(`${base}?machine=coco`);   // gives the origin
    await mp.evaluate(async ([romB64, progB64]) => {
      // exactly the keys current main's localStore writes: the 'cloadm.' prefix on all of them
      localStorage.clear();
      localStorage.setItem('cloadm.machine', 'coco');
      localStorage.setItem('cloadm.visited', '1');
      localStorage.setItem('cloadm.recent', JSON.stringify([{ name: 'old.bin', crc: 'AAAA1111', size: 64, machine: 'coco', stored: true }]));
      localStorage.setItem('cloadm.media.AAAA1111', progB64);
      localStorage.setItem('cloadm.romdata.BBBB2222', romB64);
      localStorage.setItem('cloadm.romname.BBBB2222', 'bas12.rom');
      localStorage.setItem('cloadm.rom.coco.bas', 'BBBB2222');
    }, [rom.toString('base64'), prog.toString('base64')]);
    await mp.reload(); await ready(mp);
    // the socket now holds a ROM image whose bytes are the ones that were stored (the CRC key in
    // localStorage names the blob, it is not the blob's CRC32)
    const migratedRom = await mp.evaluate(() => {
      const s = window.emu.session.machineRoms('coco').sockets.find((x) => x.id === 'bas');
      const img = window.emu.session.roms.get('coco').bas;
      return { crc: s.crc, bytes: img ? Array.from(img).slice(0, 4) : null };
    });
    check('migration: the ROM is in the new library', !!migratedRom.crc && migratedRom.bytes.join() === [...rom.subarray(0, 4)].join(), JSON.stringify(migratedRom));
    check('migration: the recent item still loads', await mp.evaluate(() => window.emu.session.recentMedia().length === 1 && window.emu.session.recentMedia()[0].name === 'old.bin'));
    const left = await mp.evaluate(() => Object.keys(localStorage).filter((k) => /^cloadm\.(rom|romdata|romname|media)/.test(k) || k === 'cloadm.recent'));
    check('migration: nothing is left behind in localStorage', left.length === 0, left.join(','));
    check('migration: small settings stay in localStorage', await mp.evaluate(() => localStorage.getItem('cloadm.machine') === 'coco' && localStorage.getItem('cloadm.visited') === '1'));
    await mp.reload(); await ready(mp);
    check('migration: a second load keeps the ROM (it does not run again)', await mp.evaluate(() => !!window.emu.session.machineRoms('coco').sockets.find((s) => s.id === 'bas').crc));
    await mctx.close();
  }

  // ---- the import/download fallback, with OPFS disabled for the page ----
  {
    const fctx = await browser.newContext({ acceptDownloads: true });
    const fp = await fctx.newPage();
    fp.on('pageerror', (e) => errors.push(e.message));
    // remove OPFS before any page script runs
    await fp.addInitScript(() => {
      try { Object.defineProperty(navigator.storage, 'getDirectory', { value: undefined, configurable: true }); } catch (e) {}
    });
    await fp.goto(`${base}?machine=coco`); await started(fp);
    check('fallback: without OPFS the page runs on the fallback store', await fp.evaluate(() => window.emu.session.media.kind) === 'fallback',
      await fp.evaluate(() => window.emu.session.media.kind));
    const FB = fake(8192, 51);
    await dropFiles(fp, [['bas12.rom', FB]]);
    check('fallback: media still loads and stores for the visit', await waitFor(fp, () => window.emu.session.machineRoms('coco').bootable),
      await fp.evaluate(() => JSON.stringify(window.emu.session.machineRoms('coco').sockets.map((s) => s.status))));
    // the download path: give the store a named blob and take it out as a file
    const [download] = await Promise.all([
      fp.waitForEvent('download'),
      fp.evaluate(async () => {
        await window.emu.session.importMedia('keep/notes.txt', new TextEncoder().encode('hello from CLOADM'));
        const { name, bytes } = await window.emu.session.downloadMedia('keep/notes.txt');
        window.emu.downloadBytes = window.emu.downloadBytes || null;
        const url = URL.createObjectURL(new Blob([bytes]));
        const a = document.createElement('a'); a.href = url; a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 500);
      }),
    ]);
    const saved = path.join(os.tmpdir(), `cloadm-media-${process.pid}.txt`);
    await download.saveAs(saved);
    check('fallback: a stored blob downloads as a file', download.suggestedFilename() === 'notes.txt' && fs.readFileSync(saved, 'utf8') === 'hello from CLOADM');
    fs.rmSync(saved);
    // the import path: a picked file goes back into the store under its name
    const imported = await fp.evaluate(async () => {
      const f = new File([new Uint8Array([1, 2, 3, 4, 5])], 'tiny.bin');
      await window.emu.session.media.adopt('library/picked/tiny.bin', f);
      return Array.from(await window.emu.session.openMedia('picked/tiny.bin'));
    });
    check('fallback: a picked file is imported under its name', imported.join() === '1,2,3,4,5', imported.join());
    await fctx.close();
  }

  // ---- the File System Access path, through a mocked directory handle ----
  // A mocked handle: Chromium's showDirectoryPicker needs a user gesture and a real folder, which a
  // headless run cannot give. The mock implements just the parts of the API the store calls.
  {
    // Its own context: the mock is installed before any page script runs, and nothing here disturbs the
    // OPFS state the checks above used.
    const fsaCtx = await browser.newContext();
    const fsa = await fsaCtx.newPage();
    fsa.on('pageerror', (e) => errors.push(e.message));
    await fsa.addInitScript(mockDirectoryInit);
    await fsa.goto(`${base}?machine=coco`); await started(fsa);
    const mockOk = await fsa.evaluate(async () => {
      const store = new (await import('/js/host/media-store-fsa.js')).FsaMediaStore(window.__mockDirectory());
      await store.write('roms/x.rom', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
      await store.writeRange('roms/x.rom', 2, new Uint8Array([9, 9]));
      const read = await store.read('roms/x.rom');
      const st = await store.stat('roms/x.rom');
      await store.rename('roms/x.rom', 'roms/y.rom');
      const listed = (await store.list('roms/')).map((f) => f.name).join();
      await store.remove('roms/y.rom');
      const missing = (await store.list('disks/')).length;
      return { read: Array.from(read), size: st.size, listed, missing, after: (await store.list()).length };
    });
    check('File System Access (mocked handle): write, write in place, read, rename, remove; list() of a prefix with no directory is empty',
      mockOk.read.join() === '1,2,9,9,5,6,7,8' && mockOk.size === 8 && mockOk.listed === 'roms/y.rom' && mockOk.missing === 0 && mockOk.after === 0, JSON.stringify(mockOk));
    // and the same mock through a Session: the whole media path, not just the store
    const sessionOk = await fsa.evaluate(async () => {
      const { FsaMediaStore, } = await import('/js/host/media-store-fsa.js');
      const { Session } = await import('/js/session.js');
      const s = new Session({ store: { get: () => null, set() {}, remove() {}, keys: () => [] }, media: new FsaMediaStore(window.__mockDirectory()) });
      await s.ready();
      await s.importMedia('mine.bin', new Uint8Array(8192).fill(0x42));
      return { listed: (await s.listMedia()).map((f) => f.name), opened: Array.from(await s.openMedia('mine.bin')).slice(0, 2) };
    });
    check('File System Access (mocked handle): a Session lists and opens its media', sessionOk.listed.includes('library/mine.bin') && sessionOk.opened.join() === '66,66', JSON.stringify(sessionOk));
    await fsaCtx.close();
  }

  // ---- a store that cannot be opened: the page still starts, on an in-memory library, and says why ----
  {
    const brokenCtx = await browser.newContext();
    const broken = await brokenCtx.newPage();
    broken.on('pageerror', (e) => errors.push(e.message));
    // every OPFS entry point throws: opening the store fails before the Session exists
    await broken.addInitScript(() => {
      const boom = () => { throw new Error('storage is unavailable (forced by the test)'); };
      try { Object.defineProperty(navigator.storage, 'getDirectory', { value: boom, configurable: true }); } catch (e) {}
    });
    await broken.goto(`${base}?machine=coco`);
    const survives = await waitFor(broken, () => window.emu && window.emu.ready && window.emu.machine.id === 'coco');
    check('a store that will not open: the page still starts and runs', survives);
    check('a store that will not open: it fell back to an in-memory library', await broken.evaluate(() => window.emu.session.media.kind) === 'memory',
      await broken.evaluate(() => window.emu.session.media.kind));
    // a state true for the whole visit: an attention card over the screen (orange, role="alert"), until dismissed
    check('a store that will not open: an attention card says why, over the screen', await waitFor(broken, () => { const a = document.getElementById('attention');
      return !a.hidden && a.getAttribute('role') === 'alert' && !!a.closest('#monitor') && /could not be opened.*in memory only/i.test(a.textContent); }),
      await broken.textContent('#attention'));
    await broken.click('#attentionClose');
    check('a store that will not open: Dismiss closes the card', await broken.isHidden('#attention'));
    // and media still works for the visit
    const FB2 = fake(16384, 61);
    await dropFiles(broken, [['d64_1.rom', FB2]]);
    check('a store that will not open: media still loads for the visit', await waitFor(broken, () => window.emu.session.machineRoms('dragon64').sockets.some((s) => s.status !== 'missing-required')));
    await brokenCtx.close();
  }

  // ---- the Library's namespace: its methods never touch the index's own blobs ----
  {
    const libCtx = await browser.newContext();
    const lib = await libCtx.newPage();
    lib.on('pageerror', (e) => errors.push(e.message));
    await lib.goto(`${base}?machine=coco`); await ready(lib);
    const NS = await lib.evaluate(async () => {
      const s = window.emu.session;
      s.addRoms([{ name: 'bas12.rom', bytes: new Uint8Array(8192).fill(0x51) }]);
      await s.index.flush();
      const before = await s.media.read('roms/sockets.json').then((b) => new TextDecoder().decode(b));
      await s.importMedia('roms/sockets.json', new Uint8Array([0xDE, 0xAD]));
      const after = await s.media.read('roms/sockets.json').then((b) => new TextDecoder().decode(b));
      const listed = (await s.listMedia()).map((f) => f.name);
      return { same: before === after, listed, hasIndex: listed.some((n) => n.startsWith('roms/') || n.startsWith('recent/')) };
    });
    check('library: importing an index-looking name leaves the socket map untouched', NS.same, JSON.stringify(NS));
    check('library: listMedia shows only the user\'s media (library/ and disks/), not the index\'s names', !NS.hasIndex && NS.listed.every((n) => n.startsWith('library/')), JSON.stringify(NS.listed));
    await libCtx.close();
  }

  // ---- ?storage= picks the backend for that page load (the testing switch docs/development.md documents) ----
  {
    await page.goto(`${base}?machine=coco&storage=fallback`); await ready(page);
    check('?storage=fallback takes the fallback even where OPFS exists', await page.evaluate(() => window.emu.session.media.kind) === 'fallback');
    await page.goto(`${base}?machine=coco&storage=opfs`); await ready(page);
    check('?storage=opfs takes the private store', await page.evaluate(() => window.emu.session.media.kind) === 'opfs');
    // storage=fsa asks for a folder on this computer. Choosing one needs a real directory picker - a user gesture
    // the browser will not let a page or this harness supply - so the URL alone cannot open that store. What it
    // must do then is say so and keep the visit in memory, not silently land on a different store than was asked
    // for (openMediaStore throws for exactly that reason). That refusal IS the behaviour to pin; the store itself
    // is covered in Node, where FsaMediaStore takes a mock directory handle (tests/media-store.test.js).
    await page.goto(`${base}?machine=coco&storage=fsa`); await started(page);
    // (a state for the whole visit: the attention card, until dismissed)
    const fsa = await page.evaluate(() => ({
      kind: window.emu.session.media.kind,
      message: document.getElementById('attention').textContent,
      shown: !document.getElementById('attention').hidden,
    }));
    check('?storage=fsa without a folder says it needs one and keeps the visit in memory (an attention card)',
      fsa.kind === 'memory' && /needs a folder; choose one first/.test(fsa.message) && /in memory only/.test(fsa.message) && fsa.shown, JSON.stringify(fsa));
  }

  check('media backend: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}
// a stand-in for a File System Access directory handle: enough of the API for FsaMediaStore, backed by a
// Map. Installed into the page by addInitScript, because the mock has to live where the store runs.
function mockDirectoryInit() {
  const files = new Map();
  const stamp = 1700000000000;
  const mkFile = (bytes, name) => new File([bytes], name, { lastModified: stamp });
  const dir = (prefix) => ({
    name: prefix || 'mock',
    kind: 'directory',
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async getDirectoryHandle(name, { create } = {}) {
      const key = (prefix ? `${prefix}/${name}` : name) + '/';
      if (!create && ![...files.keys()].some((k) => k.startsWith(key))) { const e = new Error('not found'); e.name = 'NotFoundError'; throw e; }
      return dir(key.slice(0, -1));
    },
    async getFileHandle(name, { create } = {}) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (!create && !files.has(p)) { const e = new Error('not found'); e.name = 'NotFoundError'; throw e; }
      return {
        async getFile() { return mkFile(files.get(p) || new Uint8Array(0), name); },
        async createWritable(opts = {}) {
          let buf = opts.keepExistingData ? (files.get(p) || new Uint8Array(0)).slice() : new Uint8Array(0);
          return {
            write(d) {
              if (d && d.type === 'write') {
                const end = d.position + d.data.length;
                if (end > buf.length) { const n = new Uint8Array(end); n.set(buf); buf = n; }
                buf.set(d.data, d.position);
              } else if (d == null) { buf = new Uint8Array(0); }
              else { const b = d instanceof Uint8Array ? d : new Uint8Array(d); buf = b; }
              return Promise.resolve();
            },
            truncate(n) { buf = buf.slice(0, n); return Promise.resolve(); },
            close() { files.set(p, buf); return Promise.resolve(); },
          };
        },
      };
    },
    async removeEntry(name) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (!files.has(p)) { const e = new Error('not found'); e.name = 'NotFoundError'; throw e; }
      files.delete(p);
    },
    entries() {
      const key = prefix ? prefix + '/' : '';
      const kids = new Map();
      for (const full of files.keys()) {
        if (!full.startsWith(key)) continue;
        const rest = full.slice(key.length), slash = rest.indexOf('/');
        const leaf = slash < 0 ? rest : rest.slice(0, slash);
        kids.set(leaf, slash < 0 ? 'file' : 'directory');
      }
      return {
        [Symbol.asyncIterator]() {
          const it = kids.entries();
          return { next() {
            const r = it.next();
            if (r.done) return Promise.resolve({ done: true });
            const [n, kind] = r.value, p = key + n;
            return Promise.resolve({ done: false, value: [n, kind === 'file' ? { kind: 'file', async getFile() { return mkFile(files.get(p) || new Uint8Array(0), n); } } : dir(p)] });
          } };
        },
      };
    },
  });
  window.__mockDirectory = () => dir('');
}

async function hintChecks(browser, base, check) {
  // gone after the first BREAK, and not back after a reload
  let ctx = await browser.newContext();
  let page = await ctx.newPage();
  await page.goto(`${base}?machine=dragon64`); await started(page);
  // one note under the screen at a time: the sound note first, the key hint once sound has started (the first click)
  check('key hint: on a first visit the sound note has the line, the key hint waits', await page.isVisible('#soundHint') && !(await page.isVisible('#keyHint')));
  await page.click('#screen');
  check('key hint: shown on a first visit once sound has started', await waitFor(page, () => !document.getElementById('keyHint').hidden && getComputedStyle(document.getElementById('keyHint')).display !== 'none')
    && /^Esc = BREAK · Home = CLEAR · Backspace = ←$/.test(await page.textContent('#keyHint')));
  if (shotDir) await page.locator('#screenWrap').screenshot({ path: path.join(shotDir, 'key-hint.png') });
  await page.keyboard.press('A'); await keysTaken(page);
  check('key hint: stays while typing', await page.isVisible('#keyHint'));
  await page.keyboard.press('Escape');
  check('key hint: gone after the first BREAK', await waitFor(page, () => document.getElementById('keyHint').hidden));
  await page.reload(); await started(page);
  check('key hint: shown only once', await page.isHidden('#keyHint'));
  const credits = await page.$eval('footer a[href="credits/"]', (a) => a.href);   // resolved against <base>
  const res = await page.request.get(credits);
  check('credits: linked from the page and served', res.ok() && /On the shoulders of giants/.test(await res.text()));
  await ctx.close();
  // gone 30 s after the first key typed (time fast-forwarded)
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await page.clock.install();
  await page.goto(`${base}?machine=dragon64`);
  await page.clock.fastForward(1000);
  await page.click('#screen'); await page.keyboard.press('H');
  await page.clock.fastForward(29000);
  const at29 = await page.isVisible('#keyHint');
  await page.clock.fastForward(2000);
  check('key hint: gone 30 s after typing starts', at29 && await page.isHidden('#keyHint'));
  await ctx.close();
}

// Input: the keyboard modes and the keyboard joystick through the Input tab, and two gamepads through a
// mocked navigator.getGamepads. The pads are fake objects in the page, so nothing here needs a device.
async function inputChecks(browser, base, check) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?machine=coco`);
  await started(page);
  // what the browser reports for each key, so the checks can assert the layout-independent property
  await page.evaluate(() => window.addEventListener('keydown', (e) => { window.__lastKey = e.key; }, true));
  await openTab(page, 'Input');

  const joyOf = (n) => page.evaluate((n) => window.emu.machine.joy[n].slice(), n);
  const fireOf = (n) => page.evaluate((n) => window.emu.machine.fire[n], n);
  // what the machine's matrix holds down. Held keys go through the Session's KeyQueue and land at the next
  // frame start (js/machines/keyqueue.js), so a few frames are run before reading, with the key still down.
  const heldNow = async () => {
    await emuFrames(page, 3);
    return page.evaluate(() => Object.keys(window.emu.machine.keyPos)
      .filter((n) => window.emu.machine.keyCols[window.emu.machine.keyPos[n][1]] & (1 << window.emu.machine.keyPos[n][0])).sort());
  };

  // translated mode: whatever character the browser reports reaches the machine (Shift+2 is " on a US
  // keyboard and @ on the en_IL layout this machine runs, and translated mode types what was typed); and
  // positional mode sends the same physical keys to the same matrix position whatever the layout says
  await page.focus('#screen');
  await page.keyboard.down('Shift'); await page.keyboard.down('Digit2');
  const typedChar = await page.evaluate(() => window.__lastKey || null);
  const held = await heldNow();
  // the machine key the character needs: '"' is SHIFT+2 on the CoCos, '@' is a key of its own, and the
  // host's own Shift is held down in both cases (it is a matrix key on every machine)
  const want = { '"': '2', '@': '@' }[typedChar];
  const ok = typedChar === '"' ? held.includes('2') : held.includes(want);
  check('input: translated mode types the character that was typed (Shift+2)', !!want && ok, `${typedChar} -> ${held.join('+')}`);
  await page.keyboard.up('Digit2'); await page.keyboard.up('Shift');

  // positional mode: the same physical key reaches its matrix position, and the choice is remembered
  await page.click('#panel-input [data-mode="positional"]');
  check('input: the positional button shows as chosen', await page.getAttribute('#panel-input [data-mode="positional"]', 'aria-pressed') === 'true');
  check('input: the mode is remembered', await page.evaluate(() => window.emu.session.store.get('keyboardMode')) === 'positional');
  await page.focus('#screen');
  await page.keyboard.down('KeyQ');
  const posn = await heldNow();
  check('input: positional mode uses the physical key (Q is matrix Q on a CoCo)', posn.join('+') === 'Q', posn.join('+'));
  await page.keyboard.up('KeyQ');
  await page.click('#panel-input [data-mode="translated"]');

  // the keyboard joystick: WASD drives the left joystick and Space fires it, and W does not type
  await page.check('#chkKeyJoy');
  await page.focus('#screen'); await page.keyboard.down('KeyW');
  check('input: keyboard joystick moves the left joystick up', (await joyOf(1))[1] === 0, JSON.stringify(await joyOf(1)));
  check('input: a joystick key does not type', !(await page.evaluate(() => Object.keys(window.emu.machine.keyPos)
    .some((n) => window.emu.machine.keyCols[window.emu.machine.keyPos[n][1]] & (1 << window.emu.machine.keyPos[n][0])))));
  await page.keyboard.up('KeyW');
  await page.keyboard.down('Space');
  check('input: Space fires the left joystick', await fireOf(1) === true);
  await page.keyboard.up('Space');
  check('input: releasing centres and drops fire', (await joyOf(1))[1] === 32 && await fireOf(1) === false);
  await page.uncheck('#chkKeyJoy');

  // gamepads: a mocked navigator.getGamepads, read by the page's frame loop
  await page.evaluate(() => {
    const pad = (index, axes, buttons) => ({ index, id: `Mock pad ${index}`, connected: true, axes: [...axes], buttons: buttons.map((pressed) => ({ pressed, value: pressed ? 1 : 0 })) });
    window.__pads = [];
    navigator.getGamepads = () => [window.__pads[0] || null, window.__pads[1] || null, null, null];
    const set = (i, axes, buttons) => { window.__pads[i] = pad(i, axes, buttons); };
    window.__setPads = set;
    window.__setPads(0, [0, 0], [false, false]);
    window.__setPads(1, [0, 0], [false, false, false]);
    window.dispatchEvent(new Event('gamepadconnected'));
  });
  // the frame loop reads the pads: wait for what each check then asserts
  await waitFor(page, () => window.emu.machine.joy[0][0] === 32 && window.emu.machine.joy[1][0] === 32);
  check('input: a pad at rest leaves both joysticks centred', (await joyOf(0))[0] === 32 && (await joyOf(1))[0] === 32);
  await page.evaluate(() => { window.__setPads(0, [1, -1], [true, false]); window.__setPads(1, [-1, 0], [false, false, true]); });
  await waitFor(page, () => { const m = window.emu.machine; return m.joy[0][0] === 63 && m.joy[0][1] === 0 && m.fire[0] === true && m.joy[1][0] === 0 && m.fire[1] === true; });
  check('input: pad 0 drives the right joystick, full right and up', (await joyOf(0))[0] === 63 && (await joyOf(0))[1] === 0, JSON.stringify(await joyOf(0)));
  check('input: pad 0 button 0 is its fire button', await fireOf(0) === true);
  check('input: pad 1 drives the left joystick, full left', (await joyOf(1))[0] === 0, JSON.stringify(await joyOf(1)));
  check('input: pad 1 button 2 is its fire button', await fireOf(1) === true);
  await page.evaluate(() => { window.__setPads(0, [0.1, 0.1], [false, false]); window.__setPads(1, [0.1, 0.1], [false, false, false]); });
  await waitFor(page, () => { const m = window.emu.machine; return m.joy[0][0] === 32 && m.joy[1][0] === 32 && !m.fire[0] && !m.fire[1]; });
  check('input: a stick inside the dead zone centres again', (await joyOf(0))[0] === 32 && (await joyOf(1))[0] === 32 && !(await fireOf(0)) && !(await fireOf(1)));
  check('input: no page errors', errors.length === 0, errors.join('; '));
  await ctx.close();
}

async function pokeChecks(browser, base, check) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?machine=dragon64`);
  await started(page);
  await stubPrompt(page);
  await waitFor(page, () => /BUILT-IN STUB/.test(window.emu.session.screenText().join('\n')));
  const rate = () => page.evaluate(() => ({ rate: window.emu.machine.sam.rate, label: document.getElementById('cpuRate').textContent,
    lit: document.getElementById('chipSam').classList.contains('lit'),
    pokes: [...document.querySelectorAll('#pokeBook button')].filter((b) => b.querySelector('small.lit')).map((b) => b.dataset.poke).join() }));
  // the Machine tab's rows as shown: the select's options and value, or the fixed text
  const rows = () => page.evaluate(() => Object.fromEntries(['ram', 'cpu'].map((k) => {
    const f = document.getElementById(`${k}Field`), sel = document.getElementById(`${k}Sel`);
    return [k, f.hidden ? null : !sel.hidden ? `select ${[...sel.options].map((o) => o.textContent).join('/')} = ${sel.selectedOptions[0].textContent}`
      : document.getElementById(`${k}Fixed`).textContent];
  })));
  // instructions in one frame, and a hash of the top four text rows as displayed (active area from line 24)
  // (the mean over 10 frames: one frame of the stub runs a few instructions more or less, depending on where its loop falls)
  const steps = () => page.evaluate(() => { const m = window.emu.machine; let n = 0; m.cpu.trace = () => n++; for (let i = 0; i < 10; i++) m.runFrame(); m.cpu.trace = null; return n / 10; });
  const topRows = () => page.evaluate(() => {
    const f = window.emu.machine.render();
    let h = 0x811C9DC5;
    for (let y = 24; y < 24 + 48; y++) for (let x = 0; x < f.width; x++) h = Math.imul(h ^ f.data[y * f.width + x], 0x01000193) >>> 0;
    return h;
  });
  // type a POKE and wait until the stub has read every key (and run a frame after)
  const typePoke = async (text) => { await page.keyboard.type(text, { delay: 30 }); await page.keyboard.press('Enter'); await keysTaken(page); };
  await openTab(page, 'Machine');
  const card = await page.isVisible('#machineCard'), d64rows = await rows();
  // the Dragon 64 offers a 6809E / 6309 CPU choice (js/machines/profiles.js); 6809E is the default
  check('Machine tab on the Dragon 64: RAM 64K as text, a 6809E/6309 CPU choice, the CPU rate row',
    d64rows.ram === '64K' && d64rows.cpu === 'select 6809E/6309 = 6809E' && await page.isVisible('#turboNote'), JSON.stringify(d64rows));
  // choosing the 6309 power-cycles the machine onto the 6309 core, and back
  await page.selectOption('#cpuSel', '6309');
  await waitFor(page, () => window.emu.machine.config.cpu === '6309' && window.emu.machine.cpu.constructor.name === 'CPU6309');
  const cpu6309 = await page.evaluate(() => ({ cfg: window.emu.machine.config.cpu, cls: window.emu.machine.cpu.constructor.name }));
  check('choosing 6309 power-cycles the Dragon 64 onto the 6309 core',
    cpu6309.cfg === '6309' && cpu6309.cls === 'CPU6309' && (await rows()).cpu === 'select 6809E/6309 = 6309', JSON.stringify(cpu6309));
  await page.selectOption('#cpuSel', '6809');
  await waitFor(page, () => window.emu.machine.config.cpu === '6809' && window.emu.machine.cpu.constructor.name === 'CPU6809');
  const cpu6809 = await page.evaluate(() => ({ cfg: window.emu.machine.config.cpu, cls: window.emu.machine.cpu.constructor.name }));
  check('choosing 6809E power-cycles it back to the 6809 core',
    cpu6809.cfg === '6809' && cpu6809.cls === 'CPU6809', JSON.stringify(cpu6809));
  // a CPU change switches the machine on again, into the welcome menu; back to the stub's prompt to type
  await waitFor(page, () => window.emu.session.welcomeRunning);
  await stubPrompt(page);
  await openTab(page, 'POKEs');
  const book = await page.$$eval('#pokeBook button', (b) => b.map((x) => `${x.dataset.poke}${x.disabled ? ' (needs BASIC)' : ''}`));
  const r0 = await rate();
  check('SAM rate: the CPU rate in the Machine tab and the POKE book on the Dragon 64', card && r0.label === '0.89 MHz' && book.length === 6 &&
    book.filter((b) => b.endsWith('(needs BASIC)')).length === 2, `${r0.label}; ${book.join(', ')}`);
  await page.click('#screen'); await page.keyboard.press('Home'); await keysTaken(page);   // CLEAR
  const slow = await steps();
  await typePoke('POKE 65495,0');
  let r = await rate(), n = await steps();
  check('POKE 65495,0 typed: address-dependent rate, the SAM chip lights, more instructions per frame (stub in ROM)',
    r.rate === 1 && r.label === 'address-dependent (0.89 / 1.78 MHz)' && r.lit && r.pokes === 'POKE 65495,0' && n > slow * 1.3, `${r.label}; ${slow} -> ${n} per frame`);
  await typePoke('POKE 65494,0');
  r = await rate(); n = await steps();
  check('POKE 65494,0 typed: slow again, the same instructions per frame, its book entry lit', r.rate === 0 && r.label === '0.89 MHz' && r.pokes === 'POKE 65494,0' && Math.abs(n - slow) <= 1, `${r.label}; lit: ${r.pokes}; ${slow} -> ${n} per frame`);
  const normal = await topRows();
  await page.click('#pokeBook button[data-poke="POKE 65497,0"]');
  await waitFor(page, () => window.emu.machine.sam.rate === 2); await keysTaken(page);
  r = await rate();
  const garbage = await topRows();
  check('POKE 65497,0 from the POKE book: 1.78 MHz everywhere, the picture is lost', r.rate === 2 && r.label === '1.78 MHz' && r.lit && r.pokes === 'POKE 65497,0' && garbage !== normal, r.label);
  if (shotDir) await page.screenshot({ path: path.join(shotDir, 'poke-65497.png') });
  await page.click('#screen');
  await typePoke('POKE 65496,0');
  r = await rate();
  check('POKE 65496,0 typed: slow, the picture is back as it was', r.rate === 0 && (await topRows()) === normal, r.label);
  if (shotDir) await page.screenshot({ path: path.join(shotDir, 'poke-65496.png') });
  await page.click('#btnTurbo'); await emuFrames(page, 30);
  const turbo = await rate();
  await page.click('#btnTurbo');
  check('Turbo leaves the emulated rate alone', turbo.rate === 0 && turbo.label === '0.89 MHz');
  await pickMachine(page, 'coco3');
  check('no POKE book on the CoCo 3 yet, and it says so', await page.isVisible('#pokeNone') && /The CoCo 3's speed POKEs aren't in this book yet/.test(await page.textContent('#pokeNone'))
    && !(await page.$$('#pokeBook button')).length);
  await openTab(page, 'Machine');
  check('no CPU rate on the CoCo 3', await page.isHidden('#machineCard') && await page.isHidden('#turboNote'));
  await pickMachine(page, 'mc10');
  await openTab(page, 'Machine');
  const mc = await rows();
  check('Machine tab on the MC-10: a RAM choice (4K / 20K), CPU 6803, no SAM rate', mc.ram === 'select 4K/20K = 20K' && mc.cpu === '6803'
    && await page.isHidden('#machineCard'), JSON.stringify(mc));
  await page.selectOption('#ramSel', '4');
  await waitFor(page, () => window.emu.machine.config.ram === 4);
  const ram4 = await page.evaluate(() => window.emu.machine.config.ram);
  check('choosing 4K power-cycles the MC-10 with 4K', ram4 === 4 && (await rows()).ram === 'select 4K/20K = 4K', String(ram4));
  if (shotDir) await page.screenshot({ path: path.join(shotDir, 'machine-tab-mc10.png') });
  await openTab(page, 'POKEs');
  check('MC-10 POKEs tab: no SAM, says so', /no SAM/.test(await page.textContent('#pokeNone')) && !(await page.$$('#pokeBook button')).length);
  check('SAM rate: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

// snapshots: Capture & share (its share part), the snapshot file and screenshot it hands
// over, and opening snapshots by dropping them: the same machine, another machine (asks first), one that needs
// ROMs this browser hasn't got (the card, then it opens once they are added), and refused files
async function snapshotChecks(browser, base, check) {
  for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const errors = [];
    const ctx = await browser.newContext({ acceptDownloads: true, viewport });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?machine=dragon64`);
    await started(page);
    // the moment: the welcome menu, what a visit without ROMs runs (a moment of the stub's bare prompt opens on
    // the menu instead), with a marker in memory once the menu is drawn
    await waitFor(page, () => window.emu.session.welcomeRunning && window.emu.session.screenText()[14].includes('PRESS'));
    await page.evaluate(() => window.emu.machine.poke(1030, 42));
    await page.click('#btnPause');                                      // hold the moment still
    const memHash = () => page.evaluate(() => { const m = window.emu.machine.memoryArray(); let h = 0x811C9DC5; for (const v of m) h = Math.imul(h ^ v, 0x01000193) >>> 0; return h; });
    const held = await memHash();
    const screenBefore = await page.evaluate(() => { const c = document.getElementById('screen'); return `${c.style.width} x ${c.style.height}`; });
    if (label === 'phone') await page.click('#btnMenu');
    await page.click('#btnShare');
    await page.waitForSelector('#share', { state: 'visible' });
    const view = await page.evaluate(() => {
      const c = document.getElementById('sharePicture'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, f = window.emu.machine.render();
      let colours = new Set(); for (let i = 0; i < d.length; i += 4 * 97) colours.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
      const box = document.getElementById('share').getBoundingClientRect();
      return { w: c.width, h: c.height, fw: f.width, fh: f.height, colours: colours.size, title: document.getElementById('shareTitle').textContent,
        link: document.getElementById('shareLink').value, recipient: document.getElementById('shareRecipient').textContent,
        fits: box.left >= 0 && box.right <= innerWidth, scrollX: document.documentElement.scrollWidth <= innerWidth };
    });
    check(`snapshot (${label}): Share shows the captured picture at true size, the title, a link and what a recipient sees`,
      view.w === view.fw && view.h === view.fh && view.colours > 1 && view.title === 'Dragon 64 · CLOADM' && /\/play\/\?machine=dragon64/.test(view.link)
      && view.recipient === 'It ran without ROMs, so it opens anywhere.' && view.fits && view.scrollX, JSON.stringify(Object.assign({}, view, { link: view.link.slice(0, 80) + '…' })));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `share-${label}.png`) });
    // the screen area is hidden behind the share view and the page loop keeps running (paused): the screen keeps
    // its size, so it is there again the moment the view closes (it was shrunk to nothing, review of 4050c58)
    const screenBox = () => page.evaluate(() => { const c = document.getElementById('screen'); return `${c.style.width} x ${c.style.height}`; });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const shareBox = await screenBox();
    check(`snapshot (${label}): behind the share view the screen keeps its size`, !/^0px|x 0px$/.test(shareBox) && shareBox === screenBefore, `${screenBefore} -> ${shareBox}`);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnShareDownload')]);
    const snapBytes = fs.readFileSync(await dl.path()), snapName = dl.suggestedFilename();
    const json = JSON.parse(zlib.gunzipSync(snapBytes).toString('utf8'));
    check(`snapshot (${label}): "Download snapshot" hands over a gzip JSON .cloadm file, version ${SNAPSHOT_VERSION}, of this machine`,
      /^Dragon64-\d{8}-\d{6}\.cloadm$/.test(snapName) && json.format === 'cloadm-state' && json.version === SNAPSHOT_VERSION && json.machine === 'dragon64'
      && json.state.memory && Buffer.from(json.state.memory.b64, 'base64')[1030] === 42, `${snapName} ${snapBytes.length} bytes`);
    const [shot] = await Promise.all([page.waitForEvent('download'), page.click('#btnShareShot')]);
    const png = fs.readFileSync(await shot.path());
    check(`snapshot (${label}): the screenshot is a PNG at the machine's true pixels`, png.subarray(1, 4).toString() === 'PNG'
      && png.readUInt32BE(16) === view.fw && png.readUInt32BE(20) === view.fh, `${shot.suggestedFilename()} ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
    await page.click('#shareBack');
    check(`snapshot (${label}): "← Emulator" goes back to the machine`, await waitFor(page, () => document.getElementById('share').hidden && location.hash === '')
      // (the screen is waited for, not read once: the view closing and the page laying the screen out again are
      // separate steps, so one read straight after the click could land between them)
      && await page.waitForSelector('#screen', { state: 'visible', timeout: 5000 }).then(() => true, () => false) && await screenBox() === screenBefore);
    if (label === 'phone') { await ctx.close(); check(`snapshot (${label}): no page errors`, !errors.length, errors.join('; ')); continue; }

    // the same machine, after a power cycle: dropping the file brings the moment back
    await page.click('#btnHardReset');
    const wiped = await memHash();
    await dropFiles(page, [[snapName, snapBytes]]);
    await waitFor(page, () => /Snapshot opened/.test(document.getElementById('toast').textContent));
    check('snapshot: dropped on the same machine, the moment is back (memory identical, still paused)', wiped !== held && (await memHash()) === held
      && /Snapshot opened: Dragon 64, without ROMs/.test(await page.textContent('#toast')), await page.textContent('#toast'));
    // another machine: the switch confirmation first
    await pickMachine(page, 'coco');
    await dropFiles(page, [[snapName, snapBytes]]);
    await waitFor(page, () => !document.getElementById('switchConfirm').hidden);
    const asked = await page.isVisible('#switchConfirm') && (await page.textContent('#switchName')) === 'Dragon 64'
      && await page.evaluate(() => window.emu.machine.id) === 'coco';
    await page.click('#btnSwitch');
    check('snapshot: of another machine, it asks to switch, then opens there', asked && await waitFor(page, () => window.emu.machine.id === 'dragon64')
      && (await memHash()) === held);
    // refused files say why
    const bad = async (name, bytes, re) => {
      // (the last file's message cleared first: the wait is for this file's own message)
      await page.evaluate(() => window.emu.feedback.clear());
      await dropFiles(page, [[name, bytes]]);
      await waitFor(page, (n) => document.getElementById('toast').textContent.startsWith(n) || /newer CLOADM|damaged/.test(document.getElementById('toast').textContent), name);
      const msg = await page.textContent('#toast');
      check(`snapshot: refused, ${name}`, re.test(msg) && await page.evaluate(() => document.getElementById('toast').classList.contains('error')), msg);
    };
    await bad('junk.cloadm', Buffer.from('hello'), /junk\.cloadm: This file is not a CLOADM snapshot\./);
    await bad('newer.cloadm', zlib.gzipSync(Buffer.from(JSON.stringify(Object.assign({}, json, { version: SNAPSHOT_VERSION + 1 })))), new RegExp(`saved by a newer CLOADM \\(format version ${SNAPSHOT_VERSION + 1}; this page reads version ${SNAPSHOT_VERSION}\\)`));
    await bad('cut.cloadm', snapBytes.subarray(0, 300), /damaged/);
    // a file a pre-release build saved (another layout, identifier "cloadm-snapshot", version up to 19): refused as such,
    // not as newer
    await bad('prerelease.cloadm', zlib.gzipSync(Buffer.from(JSON.stringify(Object.assign({}, json, { format: 'cloadm-snapshot', version: 19 })))),
      /^prerelease\.cloadm: This snapshot was saved by a pre-release build of CLOADM, whose snapshots this version does not read\.$/);
    // a snapshot that needs ROMs: taken on a Dragon 32 with a (synthetic) ROM, opened where there is none
    const d32 = fake(16384, 91);
    await page.click('#btnPause');
    const romSnap = Buffer.from(await page.evaluate(async (rom) => {
      const s = window.emu.session;
      s.roms.put('dragon32', 'basic', new Uint8Array(rom), 'd32.rom');
      s.switchMachine('dragon32');
      for (let i = 0; i < 5; i++) s.machine.runFrame();
      const f = await s.snapshotFile();
      s.roms.clear('dragon32');
      s.switchMachine('dragon64');
      return [...f.bytes];
    }, [...d32]));
    await dropFiles(page, [['d32.cloadm', romSnap]]);
    await waitFor(page, () => !document.getElementById('snapNeeds').hidden);
    check('snapshot: needing ROMs this browser hasn\'t got shows the card, and nothing changes', await page.isVisible('#snapNeeds')
      && (await page.textContent('#snapNeedsText')) === 'This snapshot needs Dragon 32 BASIC. Add ROMs once and it opens right here.'
      && (await page.textContent('#btnSnapLook')) === 'Look around the Dragon 32 without them' && await page.evaluate(() => window.emu.machine.id) === 'dragon64');
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'snapshot-needs-roms.png') });
    await dropFiles(page, [['d32.rom', d32]]);                          // the ROM is added: the moment opens (after the switch question)
    await waitFor(page, () => !document.getElementById('switchConfirm').hidden);
    const askedD32 = await page.isVisible('#switchConfirm') && (await page.textContent('#switchName')) === 'Dragon 32';
    await page.click('#btnSwitch');
    check('snapshot: once the ROM is added it opens right there', askedD32 && await waitFor(page, () => document.getElementById('snapNeeds').hidden
      && window.emu.machine.id === 'dragon32' && !window.emu.machine.useStub));
    // "Look around without them"
    await page.evaluate(() => { window.emu.session.roms.clear('dragon32'); window.emu.session.switchMachine('dragon64'); });
    await dropFiles(page, [['d32.cloadm', romSnap]]);
    await waitFor(page, () => !document.getElementById('snapNeeds').hidden);
    await page.click('#btnSnapLook');
    check('snapshot: "Look around without them" opens that machine without the moment', await waitFor(page, () => document.getElementById('snapNeeds').hidden
      && window.emu.machine.id === 'dragon32' && window.emu.machine.useStub));
    check('snapshot: no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }
}

// LIZA for the 6803: on the MC-10 and on the Alice with no ROMs, LIZA starts from the
// shelf in the drawer's Media tab, a typed sentence gets the expected reply, the status line names the
// program that was loaded, and the page raises no error. On a 4K MC-10 the shelf offers the one-click 20K
// switch and runs LIZA once it is taken. On a 6809 machine the same LIZA comes from the welcome menu's key 1.
async function liza6803Checks(browser, base, check) {
  const screenOf = (page) => page.evaluate(() => window.emu.session.screenText().join('\n'));
  const shelfLiza = (page) => page.evaluate(() => {
    const b = [...document.querySelectorAll('#shelf button')].find((x) => x.textContent === 'LIZA');
    if (b) b.click();
    return !!b;
  });
  // A fresh context is a first visit. Pick the machine from the header menu and the RAM from the Machine tab,
  // then come back to Media, where the no-ROM shelf lives.
  const firstVisitOn = async (id, ram) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(base);
    await started(page);
    await pickMachine(page, id);
    await openTab(page, 'Machine');
    await page.selectOption('#ramSel', String(ram));
    await waitFor(page, (ram) => window.emu.machine.config.ram === ram, ram);
    await openTab(page, 'Media');
    return { ctx, page, errors };
  };
  for (const id of ['mc10', 'alice']) {
    const { ctx, page, errors } = await firstVisitOn(id, 20);
    check(`${id}: the shelf offers LIZA`, await shelfLiza(page));
    const greeted = await waitFor(page, () => window.emu.session.screenText().join('').includes('I AM LIZA'));
    check(`${id}: LIZA starts on the stub, with no ROMs`, greeted && !(await page.evaluate(() => window.emu.machine.hasRom)),
      (await screenOf(page)).split('\n')[2]);
    // the status line names the program, and it is THIS machine's build (its title names the machine): an
    // un-awaited startLiza would show "[object Promise]" here, and the wrong build would name the other one
    const fileRe = new RegExp(`liza6803-${id}\\.bin: .*binary`, 'i');
    check(`${id}: the status names this machine's build`, await waitFor(page, (p) => new RegExp(p, 'i').test(document.getElementById('toast').textContent), fileRe.source),
      await page.textContent('#toast'));
    await page.click('#screen');
    await page.keyboard.type('I need a holiday', { delay: 40 });
    await page.keyboard.press('Enter');
    const answered = await waitFor(page, () => /WHY DO YOU NEED A HOLIDAY\?/.test(window.emu.session.screenText().join(' ')));
    check(`${id}: a typed sentence gets the expected reply`, answered, (await screenOf(page)).split('\n').slice(-3).join(' | '));
    check(`${id}: no page errors`, !errors.length, errors.join('; '));
    if (shotDir) await page.locator('#screenWrap').screenshot({ path: path.join(shotDir, `liza6803-${id}.png`) });
    await ctx.close();
  }
  // a 4K MC-10: the shelf's LIZA says it needs 20K; choosing it brings the one-click offer above the screen;
  // "Not now" leaves the machine alone; taking it fits 20K and LIZA runs
  {
    const { ctx, page, errors } = await firstVisitOn('mc10', 4);
    const tag = await page.evaluate(() => { const b = [...document.querySelectorAll('#shelf button')].find((x) => x.textContent.startsWith('LIZA')); return b && `${b.textContent}|${b.dataset.needs}|${b.title}`; });
    check('4K MC-10: the shelf\'s LIZA says it needs 20K', tag === 'LIZA needs 20K|20|An ELIZA-style conversation program (the 6803 build; needs the 20K RAM option)', tag);
    await page.click('#shelf button[data-needs="20"]');
    await waitFor(page, () => !document.getElementById('lizaOffer').hidden && document.activeElement.id === 'btnLizaRam');
    const card = { shown: await page.isVisible('#lizaOffer'), text: await page.textContent('#lizaOfferText'), btn: await page.textContent('#btnLizaRam'),
      focus: await page.evaluate(() => document.activeElement.id), error: await page.evaluate(() => document.getElementById('toast').classList.contains('error')) };
    check('4K MC-10: choosing LIZA offers the 20K switch above the screen (focused, not an error)', card.shown && card.text === 'LIZA needs the 20K RAM option. This MC-10 has 4K.'
      && card.btn === 'Switch to 20K and run LIZA' && card.focus === 'btnLizaRam' && !card.error, JSON.stringify(card));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'liza-20k-offer.png') });
    await page.click('#btnLizaRamCancel');
    check('4K MC-10: "Not now" closes the offer and keeps 4K', await page.isHidden('#lizaOffer') && await page.evaluate(() => window.emu.machine.config.ram) === 4);
    await page.click('#shelf button[data-needs="20"]');
    await page.click('#btnLizaRam');
    const switched = await waitFor(page, () => window.emu.machine.config.ram === 20 && window.emu.session.screenText().join('').includes('I AM LIZA'), null, 8000);
    check('4K MC-10: one click fits 20K and LIZA runs; the offer and the tag are gone', switched && await page.isHidden('#lizaOffer')
      && !(await page.$('#shelf button[data-needs]')), `${await page.evaluate(() => window.emu.machine.config.ram)}K`);
    check('4K MC-10: no page errors', !errors.length, errors.join('; '));
    if (shotDir) await page.locator('#screenWrap').screenshot({ path: path.join(shotDir, 'liza6803-4k-switch.png') });
    await ctx.close();
  }
  // the landing page's "Talk to LIZA" link on a 4K Alice, at phone width: the same offer, then LIZA
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?machine=alice&ram=4&start=liza`);
    const offered = await waitFor(page, () => !document.getElementById('lizaOffer').hidden, null, 6000);
    const fits = await page.evaluate(() => { const r = document.getElementById('lizaOffer').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; });
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'liza-20k-offer-phone.png') });
    await page.click('#btnLizaRam');
    const ran = await waitFor(page, () => window.emu.machine.config.ram === 20 && window.emu.session.screenText().join('').includes('I AM LIZA'), null, 8000);
    check('?start=liza on a 4K Alice (phone): the 20K offer fits the screen, then LIZA runs', offered && fits && ran && (await page.textContent('#lizaOfferText')) === 'LIZA needs the 20K RAM option. This Matra Alice has 4K.'
      && !errors.length, errors.join('; '));
    await ctx.close();
  }
  // a 6809 machine: LIZA comes from the welcome menu's key 1, and the status names it too
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await started(page);   // the welcome program runs and the page has finished starting
    await page.click('#screen');
    await page.keyboard.press('1');
    const greeted = await waitFor(page, () => window.emu.session.screenText().join('').includes('I AM LIZA'));
    check('Dragon 64: welcome menu key 1 runs LIZA', greeted, (await screenOf(page)).split('\n')[2]);
    check('Dragon 64: the status names liza.bin, not a Promise', await waitFor(page, () => /liza\.bin: .*binary/i.test(document.getElementById('toast').textContent)),
      await page.textContent('#toast'));
    check('Dragon 64: no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }
}

// every page links the favicon (favicon.svg, the logo's mark) and loads with no failed request; /favicon.ico exists
// for clients that ask for it without a link
async function faviconChecks(browser, site, check) {
  for (const route of ['', 'play/', 'roms/', 'help/', 'credits/']) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage(), failed = [];
    page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
    page.on('requestfailed', (r) => failed.push(`failed ${r.url()}`));
    await page.goto(site + route, { waitUntil: 'networkidle' });
    const icon = await page.evaluate(async () => {
      const l = document.querySelector('link[rel="icon"]');
      if (!l) return null;
      const r = await fetch(l.href);
      return `${r.status} ${r.headers.get('content-type')} ${new URL(l.href).pathname}`;
    });
    check(`/${route}: favicon linked and served, no failed request`, icon === '200 image/svg+xml /favicon.svg' && !failed.length, `${icon}; ${failed.join(', ')}`);
    await ctx.close();
  }
  const ico = await fetch(site + 'favicon.ico'), bytes = Buffer.from(await ico.arrayBuffer());
  check('/favicon.ico: an ICO holding a 32x32 PNG', ico.status === 200 && bytes.readUInt16LE(2) === 1 && bytes[6] === 32 && bytes[7] === 32
    && bytes.subarray(22, 26).toString('latin1') === '\x89PNG', `${ico.status} ${bytes.length} bytes`);
}

// The Debugger screen through the page: the header link opens it in place of the
// emulator; assemble LIZA in its Source pane; a breakpoint added by label stops the running machine (the frame
// loop runs it through the debugger) with the status, registers, disassembly and trace showing where; Step,
// Over and Run by button and key; a register edited; a byte edited through the memory view and a write
// watchpoint set on it that stops the machine; breakpoints removed; the page at phone width.
async function debuggerScreenChecks(browser, base, check) {
  for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?machine=coco`);
    await ready(page);
    await page.evaluate(() => { window.__stayed = true; });   // gone if the link loads another page
    if (label === 'phone') await page.click('#btnMenu');
    await page.click('#navDebugger');
    await page.waitForSelector('#debugView:not([hidden])');
    const nav = await page.evaluate(() => ({ stayed: window.__stayed === true, path: location.pathname, hash: location.hash,
      appbar: getComputedStyle(document.getElementById('appbar')).display !== 'none', head: getComputedStyle(document.querySelector('.dbghead')).display !== 'none' }));
    check(`debugger screen (${label}): the header's Debugger link opens it inside /play/, no page load, with one header`,
      nav.stayed && nav.path === '/play/' && nav.hash === '#debugger' && !nav.appbar && nav.head, JSON.stringify(nav));
    const layoutHidden = await page.evaluate(() => getComputedStyle(document.querySelector('.layout')).display === 'none' && location.hash === '#debugger');
    await page.click('#btnAsmLiza');
    await waitFor(page, () => document.getElementById('asmSource').value.includes('READLN'));   // the source is fetched
    await page.click('#btnAsmRun');
    await waitFor(page, () => window.emu.session.labels.get('KLOOP') != null && window.emu.session.screenText().join('').includes('I AM LIZA'));
    const kloop = await page.evaluate(() => window.emu.session.labels.get('KLOOP'));
    await page.fill('#dbgBpAddr', 'KLOOP');
    await page.click('#dbgAddBp button');
    const listed = await page.textContent('#dbgBps');
    await page.evaluate(() => window.emu.session.typeText('I AM SAD\n'));
    const hit = await waitFor(page, () => window.emu.session.paused, null, 6000);
    await waitFor(page, () => /^● Stopped at breakpoint/.test(document.getElementById('dbgStatus').textContent));
    const at = await page.evaluate(() => ({
      status: document.getElementById('dbgStatus').textContent, pc: document.querySelector('[data-reg="pc"]').value,
      line: document.querySelector('#dbgDis .dis.pc').textContent, run: document.getElementById('btnDbgRun').textContent,
      trace: document.querySelectorAll('#dbgTrace .trow').length, fits: document.documentElement.scrollWidth <= innerWidth }));
    check(`debugger screen (${label}): opens from the header in place of the emulator; a breakpoint added by label stops the running machine there`,
      layoutHidden && /exec {2}KLOOP/.test(listed) && hit && /^● Stopped at breakpoint · KLOOP · cycle [\d,]+$/.test(at.status)
      && at.pc === `$${kloop.toString(16).toUpperCase()}` && /KLOOP/.test(at.line) && /TST/.test(at.line) && at.run === 'Run F5' && at.trace > 0 && at.fits, JSON.stringify(at));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `debugger-${label}.png`), fullPage: true });
    if (label === 'phone') { check(`debugger screen (${label}): no page errors`, !errors.length, errors.join('; ')); await ctx.close(); continue; }
    // Step (button) and Step by F11: one instruction each, still stopped, the trace grows
    const pc = () => page.evaluate(() => window.emu.session.debug.pc);
    const p0 = await pc();
    await page.click('#btnDbgStep');
    const p1 = await pc();
    await page.click('#dbgScreen');                       // focus away from inputs: the keys are the debugger's
    await page.keyboard.press('F11');
    const p2 = await pc();
    const stepStatus = await page.textContent('#dbgStatus');
    check('debugger screen: Step and F11 run one instruction each and stay stopped', p1 !== p0 && p2 !== p1 && await page.evaluate(() => window.emu.session.paused)
      && /^● Stepped to KLOOP\+\$0[0-9A-F] · cycle/.test(stepStatus), `${p0} ${p1} ${p2} ${stepStatus}`);
    // Over: through JSR FIND in one go (the instruction after it), via F10 until a JSR comes round
    let over = null;
    for (let i = 0; i < 12 && !over; i++) {
      const ins = await page.evaluate(() => { const d = window.emu.session.debug; const x = d.disassemble(d.pc, 1)[0]; return { pc: d.pc, m: x.mnemonic, size: x.size }; });
      await page.keyboard.press('F10');
      if (ins.m === 'JSR') over = { from: ins.pc, to: await pc(), want: ins.pc + ins.size };
    }
    check('debugger screen: Over (F10) runs a JSR to its return in one go', over && over.to === over.want, JSON.stringify(over));
    // a register edited
    await page.fill('[data-reg="b"]', '$5A'); await page.press('[data-reg="b"]', 'Enter');
    check('debugger screen: editing a register sets it', await page.evaluate(() => window.emu.session.debug.registers().b) === 0x5A);
    // the memory view: go to $0600, edit a byte, watch it, then a store to it stops the machine
    await page.fill('#dbgMemAddr', '$0600'); await page.press('#dbgMemAddr', 'Enter');
    await page.click('#dbgMem .byte[data-addr="1536"]');
    await page.fill('#dbgByteValue', '42'); await page.click('#dbgByteSet');
    const poked = await page.evaluate(() => window.emu.session.debug.peek(0x600));
    await page.click('#dbgByteWatch');
    const wps = await page.textContent('#dbgBps');
    // remove the breakpoint so Run goes on; then make the program store to $0600 from the debugger's own step path
    await page.click('#dbgBps [aria-label^="Remove the breakpoint"]');
    await page.evaluate(() => { const d = window.emu.session.debug; d.write(0x3FF0, [0xB7, 0x06, 0x00, 0x20, 0xFE]); d.setRegister('pc', 0x3FF0); });
    const aReg = await page.evaluate(() => window.emu.session.debug.registers().a);
    await page.click('#btnDbgRun');
    const watched = await waitFor(page, () => window.emu.session.paused && window.emu.session.debug.stopReason.kind === 'watchpoint', null, 3000);
    check('debugger screen: a byte edited in the memory view, a write watchpoint set on it, and Run stops after the store',
      poked === 0x42 && /write {2}\$0600/.test(wps) && watched
      && (await page.textContent('#dbgStatus')).startsWith(`● Stopped by a write of $0600 ($${aReg.toString(16).toUpperCase().padStart(2, '0')}) · at $3FF3`),
      `${poked} ${wps} ${await page.textContent('#dbgStatus')}`);
    // Over on a call that never returns: the screen stays stopped and says why (it never runs free)
    await page.click('#dbgBps [aria-label^="Remove the watchpoint"]');
    await page.evaluate(() => { const d = window.emu.session.debug; d.write(0x3FE0, [0xBD, 0x3F, 0xE5, 0x20, 0xFB, 0x20, 0xFE]); d.setRegister('pc', 0x3FE0); });
    await page.click('#btnDbgOver');
    const limitStatus = await page.textContent('#dbgStatus');
    await ticks(page, 20);   // the window in which a machine wrongly left running would move
    check('debugger screen: Over a call that never returns stops at its limit, says so, and the machine stays stopped',
      /^● Stopped after 1,000,000 instructions without coming back · at \$3FE5/.test(limitStatus)
      && await page.evaluate(() => window.emu.session.paused && window.emu.session.debug.pc === 0x3FE5), limitStatus);
    // Run and Pause by F5
    await page.click('#dbgScreen'); await page.keyboard.press('F5');
    const running = await page.evaluate(() => !window.emu.session.paused && document.getElementById('btnDbgRun').textContent === 'Pause F5');
    await page.keyboard.press('F5');
    check('debugger screen: F5 runs and pauses', running && await page.evaluate(() => window.emu.session.paused && /^● Paused at/.test(document.getElementById('dbgStatus').textContent)));
    // Step with the CPU halted (HALT asserted, as a disk controller does): no instruction runs in the frame it waits,
    // the screen says so, the PC and the trace stay as they were; with HALT released, Step runs one instruction again
    const held = await page.evaluate(() => {
      const s = window.emu.session, m = s.machine, d = s.debug;
      m.setLine('test', 'halt', true);
      return { pc: d.pc, steps: d.steps, trace: d.log.length };
    });
    await page.click('#btnDbgStep');
    const heldAfter = await page.evaluate(() => { const d = window.emu.session.debug; return { pc: d.pc, steps: d.steps, trace: d.log.length, kind: d.stopReason && d.stopReason.kind, status: document.getElementById('dbgStatus').textContent }; });
    await page.evaluate(() => window.emu.session.machine.setLine('test', 'halt', false));
    await page.click('#btnDbgStep');
    const freed = await page.evaluate(() => window.emu.session.debug.steps);
    check('debugger screen: Step with HALT asserted waits a frame and says "Halted", PC and trace unchanged; released, Step runs one instruction',
      heldAfter.kind === 'halted' && /^● Halted at .*: the CPU waits for HALT's release \(no instruction ran in a frame\) · cycle/.test(heldAfter.status)
      && heldAfter.pc === held.pc && heldAfter.steps === held.steps && heldAfter.trace === held.trace && freed === held.steps + 1,
      JSON.stringify({ held, heldAfter, freed }));
    await page.click('#btnDbgBack');
    const closed = await waitFor(page, () => document.getElementById('debugView').hidden && document.getElementById('screen').getClientRects().length > 0
      && getComputedStyle(document.getElementById('appbar')).display !== 'none');
    check('debugger screen: "← Emulator" closes it and the app bar is back; no page errors', closed && !errors.length, errors.join('; '));
    await ctx.close();
  }
}

// The Library's select mode, at desktop width and on a 390 px phone: "Select" beside "Add files…" swaps the filters for the selection
// bar (count, the hint when nothing is selected, Load and Rename for one item, Download, Delete, Select all, Done);
// a click selects instead of loading, and a selected item has the green border, the ticked box and the dark green
// fill; Rename is inline on the item (Enter saves, Esc cancels); Delete asks nothing, takes the items off the shelf
// at once and removes them only when its 8 s Undo toast ends; Done and Esc leave select mode. On the phone the
// actions sit in a bar along the bottom edge.
async function librarySelectChecks(browser, base, check) {
  const bin = Buffer.from([0x55, 2, 0x30, 0x00, 0x00, 0x04, 0x30, 0x00, 0xAA, 0x12, 0x34, 0x56, 0x78]);
  const block = (type, data) => { let sum = (type + data.length) & 0xFF; for (const v of data) sum = (sum + v) & 0xFF; return [0x55, 0x3C, type, data.length, ...data, sum]; };
  const cas = Buffer.from([...Array(128).fill(0x55), ...block(0, [...Buffer.from('HELLO   '), 2, 0, 0, 0x30, 0x00, 0x30, 0x00]), ...Array(64).fill(0x55), ...block(1, [0x39]), ...block(0xFF, [])]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-libsel-'));
  const files = { 'CHAT.BIN': bin, 'DEMO.BIN': bin, 'LIZA.BIN': bin, 'HELLO.CAS': cas };
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(tmp, n), b);
  const GREEN = 'rgb(61, 245, 90)', SEL_BG = 'rgb(19, 36, 15)';

  for (const [label, viewport] of [['desktop', { width: 1440, height: 980 }], ['phone', { width: 390, height: 844 }]]) {
    const L = `library select (${label})`;
    const errors = [];
    const ctx = await browser.newContext({ acceptDownloads: true, viewport });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => { errors.push(`a ${d.type()} box: ${d.message()}`); d.dismiss(); });
    await page.goto(`${base}?machine=dragon64#library`);
    await ready(page);
    await page.setInputFiles('#fileLib', Object.keys(files).map((n) => path.join(tmp, n)));
    await waitFor(page, () => document.querySelectorAll('#libTiles .tile, #libTapes .spine').length === 4);
    const stored = () => page.evaluate(async () => (await window.emu.session.listMedia()).map((x) => x.name.split('/').pop()).join());
    const tile = (name) => `#library [data-name="library/${name}"]`;
    // what the page shows of select mode
    const state = () => page.evaluate(() => {
      const vis = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && e.getClientRects().length > 0; };
      const items = [...document.querySelectorAll('#libTiles .tile, #libTapes .spine')];
      return {
        select: vis('btnLibSelect'), bar: vis('libSelBar'), filters: vis('libKinds'), count: vis('libSelBar') ? document.getElementById('libCount').textContent : '',
        hint: vis('libSelHint'), tapHint: vis('libTapHint'), load: vis('btnLibLoad'), download: vis('btnLibDownload'), rename: vis('btnLibRename'), renameOff: !!document.getElementById('btnLibRename') && document.getElementById('btnLibRename').disabled,
        del: vis('btnLibDelete'), all: vis('btnLibSelectAll'), done: vis('btnLibDone'),
        pressed: items.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.name.split('/').pop()).join(),
        ticks: items.filter((b) => { const t = b.querySelector('.tick'); return t && t.getClientRects().length > 0; }).length,
        footer: document.getElementById('libFooter').textContent, library: !document.getElementById('library').hidden,
        fits: document.documentElement.scrollWidth <= innerWidth };
    });
    const look = (name) => page.evaluate((sel) => { const b = document.querySelector(sel), cs = getComputedStyle(b), t = getComputedStyle(b.querySelector('.tick'));
      return { border: cs.borderTopColor, width: cs.borderTopWidth, bg: cs.backgroundColor, tick: t.backgroundColor, mark: b.querySelector('.tick').textContent }; }, tile(name));

    // browsing: the Select button beside Add files…, no tick boxes; a click loads
    let s = await state();
    check(`${L}: browsing shows "Select" beside the filters, no selection bar and no tick boxes`, s.select && !s.bar && s.filters && s.ticks === 0
      && await page.evaluate(() => document.getElementById('btnLibSelect').previousElementSibling === document.getElementById('btnLibAdd') || document.getElementById('btnLibSelect').nextElementSibling === document.getElementById('btnLibAdd')),
      JSON.stringify(s));
    // Select: the bar replaces the filters; nothing selected yet
    await page.click('#btnLibSelect');
    s = await state();
    check(`${L}: Select swaps the filters for the selection bar: "Select items", the hint (${label === 'phone' ? 'tap to select or clear' : 'what to click, and what then'}), Select all and Done; every item has a tick box`,
      !s.select && s.bar && !s.filters && s.count === 'Select items' && (label === 'phone' ? s.tapHint && !s.hint : s.hint && !s.tapHint) && !s.load && !s.download && !s.del && s.done && s.all && s.ticks === 4
      && /a (click|tap) selects instead of loading|Tap to select/.test(s.footer), JSON.stringify(s));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `library-select-none-${label}.png`) });
    // one item: a click selects it (it doesn't load); Load and Rename are there
    await page.click(tile('CHAT.BIN'));
    s = await state();
    const on = await look('CHAT.BIN'), off = await look('DEMO.BIN');
    check(`${L}: a click selects instead of loading; one selected offers Load, Download, Rename and Delete`, s.library && s.pressed === 'CHAT.BIN' && s.count === '1 selected'
      && !s.hint && s.load && s.download && s.rename && !s.renameOff && s.del, JSON.stringify(s));
    check(`${L}: the selected item has the green border, the ticked green box and the dark green fill`, on.border === GREEN && on.width === '2px' && on.bg === SEL_BG
      && on.tick === GREEN && on.mark === '✓' && off.border !== GREEN && off.bg !== SEL_BG && off.mark === '', `${JSON.stringify(on)} ${JSON.stringify(off)}`);
    // two items: Load and Rename are for one at a time
    await page.click(tile('DEMO.BIN'));
    s = await state();
    check(`${L}: two selected: "2 selected", Download and Delete; Load and Rename are for one item (${label === 'phone' ? 'Rename shown disabled, with the note' : 'not shown'})`,
      s.count === '2 selected' && s.pressed === 'CHAT.BIN,DEMO.BIN' && !s.load && s.download && s.del
      && (label === 'phone' ? s.rename && s.renameOff && await page.isVisible('#libOneNote') : !s.rename), JSON.stringify(s));
    if (label === 'phone') {
      const bar = await page.evaluate(() => { const r = document.getElementById('libSelActions').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: innerHeight, w: innerWidth }; });
      const head = await page.evaluate(() => { const c = document.getElementById('libCount').getBoundingClientRect(), d = document.getElementById('btnLibDone').getBoundingClientRect(),
        t = document.querySelector('#library .tile, #library .spine').getBoundingClientRect(); return { c: c.top, d: d.top, dRight: d.right, first: t.top, w: innerWidth }; });
      check(`${L}: the actions sit in a bar along the bottom edge, full width; the count and Done head the page, above the shelves`, Math.abs(bar.bottom - bar.h) <= 1 && bar.left <= 1 && bar.right >= bar.w - 1
        && head.c < head.first && head.d < head.first && head.dRight <= head.w, `${JSON.stringify(bar)} ${JSON.stringify(head)}`);
    }
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `library-select-two-${label}.png`) });
    // Download: each selected item, the same bytes
    const dls = [];
    page.on('download', (d) => dls.push(d));
    await page.click('#btnLibDownload');
    for (const t = Date.now(); dls.length < 2 && Date.now() - t < 10000;) await page.waitForTimeout(50);   // both downloads (the check names what came)
    check(`${L}: Download saves every selected item`, dls.map((d) => d.suggestedFilename()).sort().join() === 'CHAT.BIN,DEMO.BIN'
      && Buffer.compare(fs.readFileSync(await dls[0].path()), bin) === 0, dls.map((d) => d.suggestedFilename()).join());
    page.removeAllListeners('download');
    // rename inline: Esc cancels, Enter saves (a slash becomes a dash)
    await page.click(tile('DEMO.BIN'));
    await page.click('#btnLibRename');
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `library-select-rename-${label}.png`) });
    const editor = await page.evaluate(() => { const i = document.querySelector('#library .rename input'); return i && { value: i.value, focused: document.activeElement === i,
      inItem: !!i.closest('.item') && !!i.closest('.item').querySelector('[data-name="library/CHAT.BIN"]'), help: i.closest('.rename').textContent }; });
    check(`${L}: Rename opens a name field on the item itself, filled in and focused, with "Enter saves · Esc cancels"`, !!editor && editor.value === 'CHAT.BIN' && editor.focused && editor.inItem
      && /Enter saves · Esc cancels/.test(editor.help), JSON.stringify(editor));
    await page.keyboard.press('Escape');
    s = await state();
    check(`${L}: Esc in the name field cancels the rename and stays in select mode`, !(await page.$('#library .rename')) && s.bar && s.pressed === 'CHAT.BIN' && /CHAT\.BIN/.test(await stored()), JSON.stringify(s));
    await page.click('#btnLibRename');
    await page.fill('#library .rename input', 'MY/CHAT.BIN');
    await page.keyboard.press('Enter');
    await waitFor(page, () => !!document.querySelector('#library [data-name="library/MY-CHAT.BIN"]'));
    s = await state();
    check(`${L}: Enter saves the new name (a slash becomes a dash, and the status says so); the item stays selected`, (await stored()).split(',').includes('MY-CHAT.BIN')
      && !(await stored()).split(',').includes('CHAT.BIN') && await page.textContent('#toast') === 'Renamed to MY-CHAT.BIN' && s.pressed === 'MY-CHAT.BIN' && !(await page.$('#library .rename')),
      `${await stored()} ${await page.textContent('#toast')} ${JSON.stringify(s)}`);
    // Select all, then delete two with Undo
    await page.click('#btnLibSelectAll');
    s = await state();
    check(`${L}: Select all selects everything shown`, s.count === '4 selected' && s.pressed.split(',').length === 4, JSON.stringify(s));
    for (const n of ['HELLO.CAS', 'LIZA.BIN']) await page.click(tile(n));
    await page.click('#btnLibDelete');
    s = await state();
    const toast = await page.evaluate(() => { const t = document.getElementById('toast'); return t && !t.hidden && { text: document.getElementById('toastText').textContent, role: t.parentNode.getAttribute('role'), action: document.getElementById('toastAction').textContent }; });
    check(`${L}: Delete asks nothing: the items leave the shelf at once, select mode ends, and a toast offers Undo; the files are still stored until it ends`,
      !(await page.$(tile('MY-CHAT.BIN'))) && !(await page.$(tile('DEMO.BIN'))) && s.select && !s.bar && !!toast && toast.text === 'Deleted MY-CHAT.BIN and DEMO.BIN' && toast.role === 'status'
      && toast.action === 'Undo' && /MY-CHAT\.BIN/.test(await stored()) && /DEMO\.BIN/.test(await stored()), `${JSON.stringify(toast)} ${JSON.stringify(s)} ${await stored()}`);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `library-select-undo-${label}.png`) });
    await page.click('#toastAction');
    await waitFor(page, () => !!document.querySelector('#library [data-name="library/DEMO.BIN"]'));
    check(`${L}: Undo puts them back and the toast goes`, !!(await page.$(tile('MY-CHAT.BIN'))) && !!(await page.$(tile('DEMO.BIN'))) && await page.isHidden('#toast')
      && (await stored()).split(',').length === 4, await stored());
    // a delete the toast lets go of is real (desktop only: it takes the toast's 8 s)
    if (label === 'desktop') {
      await page.click('#btnLibSelect');
      await page.click(tile('DEMO.BIN'));
      await page.click('#btnLibDelete');
      const t0 = Date.now();
      // still stored while its toast is up; the toast's end (its 8 s, later under load) is what removes it
      const raised = await waitFor(page, () => /Deleted DEMO\.BIN/.test(document.getElementById('toastText').textContent), null, 8000);
      const keptMeanwhile = /DEMO\.BIN/.test(await page.evaluate(async () => (await window.emu.session.listMedia()).map((x) => x.name).join()));
      const ended = await waitFor(page, () => document.getElementById('toast').hidden, null, 30000);
      const took = Date.now() - t0;
      // removed from the store and from the shelf (the shelf redraws just after the store's delete); up to 10 s after
      // the toast ends, for a rare storage stall that was measured (1 run in 20 of `--only feedback` over 3 s)
      const gone = ended && await waitFor(page, async (sel) => !(await window.emu.session.listMedia()).some((x) => x.name === 'library/DEMO.BIN') && !document.querySelector(sel), tile('DEMO.BIN'), 10000);
      check(`${L}: without Undo the item is removed when the toast ends (8 s), and the toast goes`, raised && keptMeanwhile && gone && took >= 7000 && await page.isHidden('#toast'),
        `${took} ms; raised ${raised}, kept meanwhile ${keptMeanwhile}, ended ${ended}`);
    }
    // leaving select mode: Esc, and Done; then a click loads again
    await page.click('#btnLibSelect');
    await page.click(tile('LIZA.BIN'));
    await page.keyboard.press('Escape');
    s = await state();
    check(`${L}: Esc leaves select mode and clears the selection`, s.select && !s.bar && s.filters && s.pressed === '' && s.ticks === 0 && /to load/.test(s.footer), JSON.stringify(s));
    await page.click('#btnLibSelect');
    await page.click(tile('LIZA.BIN'));
    await page.click('#btnLibDone');
    s = await state();
    check(`${L}: Done leaves select mode`, s.select && !s.bar && s.pressed === '' && s.ticks === 0, JSON.stringify(s));
    await page.click(tile('LIZA.BIN'));
    await waitFor(page, () => document.getElementById('library').hidden && window.emu.machine.ram[0x3000] === 0x12);
    check(`${L}: after select mode a click loads again`, await page.isHidden('#library') && await page.evaluate(() => window.emu.machine.ram[0x3000] === 0x12));
    check(`${L}: no sideways scroll`, s.fits);
    check(`${L}: no page errors and no dialog boxes`, !errors.length, errors.join('; '));
    await ctx.close();
  }
  fs.rmSync(tmp, { recursive: true });
}

// The Library at #library: its empty state, adding files (ROMs go to their
// sockets instead), the shelves and filters, persistence across a reload, loading by click, select mode (rename,
// download, delete; librarySelectChecks has the rest), files loaded with Insert… kept, the links into it, and the type-in card typing a listing
// through the keyboard (the keys pressed compared with the keyboard map of the listing)
// ---------------- the feedback model (UX finding FB-1) ----------------
// Messages are said where the user is and go when they stop being true: a toast on the page the user is on (the
// Library too), cleared by the next action or after 4 s, waiting for its own page when raised for another one,
// errors with Details, Undo for a delete or a snapshot taken; buttons that can't work are disabled with the reason;
// what the machine shows itself is not repeated. Written before the feedback model and run first against the status
// line it replaces (25 of them failed there); each check asks whether the user can see the toast.
// The feedback model's own rules (js/ui/feedback.js), each checked where it decides something (review: each of these
// fails without its rule):
//  - a toast covers none of the on-screen keys (portrait: the keys under the screen; sideways: either side of it,
//    where the toast is narrowed to the screen's foot) and is still delivered, in view;
//  - it never covers the phone chat's sticky bar (with nothing else free it waits instead);
//  - a pointer gesture is the next action from its pointer-down (an old toast is gone before the gesture's own
//    handler runs), and its click does not clear a toast the gesture itself raised;
//  - a toast with no place free is not lost: unseen, its time does not run; a newer one goes first and it follows,
//    once there is room.
async function feedbackModelChecks(browser, base, check) {
  const state = (page) => page.evaluate(() => {
    const t = document.getElementById('toast'), b = t.getBoundingClientRect(), reg = document.getElementById('toastRegion');
    const meets = (sel) => [...document.querySelectorAll(sel)].filter((e) => { const o = e.getBoundingClientRect();
      return o.width && o.height && !(b.bottom <= o.top || b.top >= o.bottom || b.right <= o.left || b.left >= o.right); }).length;
    const up = !t.hidden, seen = up && getComputedStyle(reg).visibility !== 'hidden' && b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth;
    return { up, seen, text: document.getElementById('toastText').textContent, keys: seen ? meets('#touchKeys button') : 0, bar: seen ? meets('#claudeBar') : 0,
      box: [b.left, b.top, b.right, b.bottom].map(Math.round) };
  });
  const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));

  // ---- the on-screen keys: portrait and sideways, a touch phone ----
  for (const [label, viewport] of [['portrait', { width: 390, height: 844 }], ['sideways', { width: 844, height: 390 }]]) {
    const ctx = await browser.newContext({ viewport, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(`${base}?machine=dragon64`);
    await started(page);
    await waitFor(page, () => !document.getElementById('touchKeys').hidden && document.body.classList.contains('touch-keys'));
    await page.evaluate(() => { scrollTo(0, 0); window.emu.feedback.clear(); window.emu.feedback.toast('Delivered while the keys show'); });
    await frames(page);
    const k = await state(page);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `feedback-keys-${label}.png`) });
    // shown where it covers no key and none of the screen's text, or, with no such place, kept (past its 4 s) and
    // shown once the keys hide and there is room (a toast is never dropped and never covers the screen's text)
    let after = null;
    if (!k.seen) {
      await page.waitForTimeout(5000);
      const waiting = await state(page);
      await page.click('#tkMenu');
      await page.click('#tkMenuSheet [data-item="hide"]');
      await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
      await frames(page);
      after = { waiting, shown: await state(page) };
    }
    check(`feedback model (${label} phone, keys showing): a toast is delivered: in view covering none of the keys, or kept (past its 4 s) and shown once the keys hide`,
      k.up && k.text === 'Delivered while the keys show' && k.keys === 0
      && (k.seen || (after.waiting.up && !after.waiting.seen && after.waiting.text === k.text && after.shown.seen && after.shown.text === k.text)), JSON.stringify({ k, after }));
    await ctx.close();
  }

  // ---- the phone chat's sticky bar: with the screen out of the way and a row of controls along the bottom edge (set
  // up for the check), the only other place is the top edge, under the bar: the toast waits rather than cover it ----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(`${base}?machine=dragon64&app=claude`);
    await started(page);
    await waitFor(page, () => document.body.classList.contains('chat-phone') && !document.getElementById('claudeBar').hidden);
    await page.evaluate(() => {
      document.getElementById('monitor').style.display = 'none';
      const row = document.createElement('div');
      row.className = 'controls'; row.id = 'fbRow'; row.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:120px;z-index:1';
      row.append(Object.assign(document.createElement('button'), { textContent: 'a control' }));
      document.body.append(row);
      window.emu.feedback.toast('Not under the bar');
    });
    await frames(page);
    const c = await state(page);
    check('feedback model (phone chat): the toast never covers the chat\'s sticky bar (with no other place free it waits, unseen)',
      c.up && !c.seen && c.bar === 0, JSON.stringify(c));
    await ctx.close();
  }

  // ---- pointer gestures (on a desktop, where a toast has room) ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(`${base}?machine=dragon64`);
    await started(page);
    // a button that acts at pointer-down (as the on-screen keys do): it notes whether the old toast was already gone,
    // and raises its own
    await page.evaluate(() => {
      const b = document.createElement('button');
      b.id = 'fbProbe'; b.textContent = 'probe'; b.style.cssText = 'position:fixed;left:20px;top:200px;z-index:99';
      b.addEventListener('pointerdown', () => { window.__oldGoneAtDown = document.getElementById('toast').hidden; window.emu.feedback.toast('Raised at pointer-down'); });
      document.body.append(b);
      scrollTo(0, 0);
      window.emu.feedback.clear();
      window.emu.feedback.toast('The old one');
    });
    await frames(page);
    await page.click('#fbProbe');
    await frames(page);
    const g = await page.evaluate(() => ({ oldGoneAtDown: window.__oldGoneAtDown, text: document.getElementById('toastText').textContent, up: !document.getElementById('toast').hidden }));
    check('feedback model: a pointer gesture is the next action from its pointer-down (the old toast is gone before its handler runs)', g.oldGoneAtDown === true, JSON.stringify(g));
    check('feedback model: the gesture\'s own click does not clear the toast it raised', g.up && g.text === 'Raised at pointer-down', JSON.stringify(g));
    await page.evaluate(() => { document.getElementById('fbProbe').remove(); window.emu.feedback.clear(); });
    await ctx.close();
  }
  // ---- a toast with no place free: the top of a phone's emulator page (no place covers neither a control nor the
  // screen's text) ----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(`${base}?machine=dragon64`);
    await started(page);
    await page.evaluate(() => { scrollTo(0, 0); window.emu.feedback.clear(); window.emu.feedback.toast('First, held'); });
    await frames(page);
    const held = await state(page);
    await page.waitForTimeout(5000);   // longer than a toast's 4 s
    const still = await state(page);
    check('feedback model: with no place free a toast waits unseen, and its time does not run (still the current toast after 5 s)',
      held.up && !held.seen && still.up && !still.seen && still.text === 'First, held', JSON.stringify({ held, still }));
    // a newer one goes first; the one waiting is not lost, it comes after it
    await page.evaluate(() => window.emu.feedback.toast('Second, newer'));
    const order = await page.evaluate(() => window.emu.feedback.pending.map((m) => m.text));
    // scrolled to where there is room (the end of the page): the newer shows; when it ends, the waiting one follows
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await frames(page);
    const first = await state(page);
    await waitFor(page, () => document.getElementById('toastText').textContent === 'First, held', null, 8000);
    const second = await state(page);
    check('feedback model: a newer toast goes first and the one waiting follows once there is room (nothing dropped)',
      order.join('|') === 'Second, newer|First, held' && first.seen && first.text === 'Second, newer' && second.seen && second.text === 'First, held',
      JSON.stringify({ order, first, second }));
    await ctx.close();
  }
}

async function feedbackChecks(browser, base, check) {
  // a message the user can see now: shown, inside the viewport, matching re ("" for any text)
  // (in the page: [source of re, true for "shown" / false for "not shown"])
  const shownIs = ([src, want]) => {
    const re = new RegExp(src, 'i');
    const el = document.getElementById('toast');
    const r = el && el.getBoundingClientRect();
    const up = !!el && el.checkVisibility() && !!el.textContent.trim() && r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && re.test(el.textContent);
    return up === want;
  };
  const shown = (page, re = /\S/) => page.evaluate(shownIs, [re.source, true]);
  // shown within ms / gone within ms: condition waits, a timeout is a FAIL (the limits only stop a page that hangs)
  const shownWithin = (page, re, ms = 10000) => waitFor(page, shownIs, [re.source, true], ms);
  const goneWithin = (page, ms = 10000) => waitFor(page, shownIs, ['\\S', false], ms);
  // a check that a message does NOT show: the window it is given to (wrongly) show in. True only if the time ran out on
  // the same live page (maybeWaitFor's false); a message shown (true) or a page gone (null) is not quiet
  const quietFor = async (page, re, ms) => (await maybeWaitFor('a check that no message shows: the timeout is the expected outcome', page, shownIs, [re.source, true], ms)) === false;
  const bin = Buffer.from([0x55, 2, 0x30, 0x00, 0x00, 0x04, 0x30, 0x00, 0xAA, 0x12, 0x34, 0x56, 0x78]);
  const vdk = Buffer.from(require('./mame-diff/fdc/images').vdk(40, 1));

  for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const errors = [];
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.dismiss());           // a confirm box would be refused: the delete must not need one
    await page.goto(`${base}?machine=dragon64`);
    await started(page);
    const ev = (fn, arg) => page.evaluate(fn, arg).catch(() => false);   // false where the page has no such element
    // a click on a control every step below expects to be there: one that can't be clicked is a FAIL (a negative check
    // after it, "Reset says nothing", would otherwise pass on a click that never happened)
    const tryClick = (sel) => page.click(sel, { timeout: 10000 }).then(() => true, (e) => { check(`feedback (${label}): ${sel} can be clicked`, false, e.message.split('\n')[0]); return false; });
    // files through the Library's Add files… (name, buffer, name, buffer, ...)
    const add = async (...nb) => {
      // (the Add buttons' file input, as the Library's own checks fill it; the shelves render after it opens)
      await waitFor(page, () => ['btnLibAdd', 'btnLibAddEmpty'].some((x) => document.getElementById(x).checkVisibility()));
      const files = [];
      for (let i = 0; i < nb.length; i += 2) files.push({ name: nb[i], mimeType: 'application/octet-stream', buffer: nb[i + 1] });
      await page.setInputFiles('#fileLib', files);
    };

    // a message raised on the Library shows on the Library, where the user is
    await ev(() => { location.hash = '#library'; });
    await waitFor(page, () => !document.getElementById('library').hidden);
    await add('HELLO.BIN', bin);
    check(`feedback (${label}): a message raised on the Library is visible there`, await shownWithin(page, /added to (your|the) library/), await ev(() => document.getElementById('toast').textContent));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `feedback-library-${label}.png`) });
    if (label === 'phone') {
      const r = await ev(() => { const e = document.getElementById('toast'); const b = e && e.getBoundingClientRect(); return b && { left: b.left, right: innerWidth - b.right, bottom: innerHeight - b.bottom }; });
      check('feedback (phone): the toast is full width just above the bottom edge', !!r && r.left <= 16 && r.right <= 16 && r.bottom <= 24, JSON.stringify(r));
    } else {
      const r = await ev(() => { const e = document.getElementById('toast'); const b = e && e.getBoundingClientRect(); return b && { centre: Math.round(b.left + b.width / 2 - innerWidth / 2), bottom: innerHeight - b.bottom }; });
      check('feedback (desktop): the toast sits bottom centre of the window', !!r && Math.abs(r.centre) <= 2 && r.bottom <= 40, JSON.stringify(r));
    }
    // the next action clears it. The clearing is synchronous in the action's pointerdown (feedback.js next()), so it is
    // read as soon as the click returns: no window in which the toast's own 4 s could end it instead. (A toast not
    // seen yet is not cleared: wait until it has been.)
    await waitFor(page, () => window.emu.feedback.pending.some((m) => /added to (your|the) library/i.test(m.text) && m.seen));
    await page.click('[data-kind-filter="tape"]');
    check(`feedback (${label}): the next action clears the old message`, !(await shown(page)), JSON.stringify(await ev(() => window.emu.feedback.pending)));
    // and one left alone goes after 4 s (no action on it: two files)
    // its time up is measured in the page as it changes (page time, not the time a loaded runner takes to look): from
    // its text going up to the toast hiding. (On the Library it is in view at once, so its 4 s start then.)
    await page.evaluate(() => { const life = window.__life = {}, t = document.getElementById('toast');
      new MutationObserver(() => { const now = performance.now(), up = !t.hidden && /2 files added to your Library/.test(t.textContent);
        if (up && life.on == null) life.on = now;
        if (!up && life.on != null && life.off == null) life.off = now; })
        .observe(t, { attributes: true, attributeFilter: ['hidden'], childList: true, characterData: true, subtree: true }); });
    await add('WORLD.BIN', bin, 'MORE.BIN', bin);
    await shownWithin(page, /2 files added to your Library/);
    const gone = await goneWithin(page, 20000);
    const life = await page.evaluate(() => window.__life), shownMs = life.off - life.on;
    // 4 s from when it is first in view; a frame either side, and a timer that fires late on a loaded page
    // (bounds 3.9-8 s, was <= 6 s: 3.9 s so a toast that goes early still fails; 8 s for timers late on a loaded CI runner)
    check(`feedback (${label}): a toast left alone goes after 4 s`, gone && shownMs >= 3900 && shownMs <= 8000 && await ev(() => !document.getElementById('toast').textContent), `up ${Math.round(shownMs)} ms ${JSON.stringify(life)}`);
    // a single file added: the toast offers to load it
    await add('LOADME.BIN', bin);
    check(`feedback (${label}): one file added: "1 file added to your Library" with Load`, await shownWithin(page, /^1 file added to your Library/)
      && await ev(() => document.getElementById('toastAction').textContent === 'Load'));
    // what the page shows in view, sampled every frame in the page itself: a 4 s toast can come and go between two
    // polls from here on a loaded machine (seen: "Loaded LOADME" never caught, its toast already over)
    await page.evaluate((src) => { const inView = eval(src); window.__inView = new Set();
      const f = () => { const t = document.getElementById('toast'); if (t && inView(['\\S', true])) window.__inView.add(t.textContent); requestAnimationFrame(f); }; f(); }, `(${shownIs})`);
    await tryClick('#toastAction');
    // (on a phone the top of the emulator page has no place that covers neither a control nor the screen's text:
    // the toast waits, and shows where there is room, at the end of the page)
    const back = await waitFor(page, () => location.hash !== '#library', null, 3000);
    // (the page settles after the Library closes: kept at its end while waiting; queued behind the program's own load
    // message where that waited too, its turn comes after it, up to 4 s later)
    // (the pointer moved off where the toast was clicked: a toast is paused while hovered)
    const atEndUntil = async (re) => { await page.mouse.move(1, 1); return waitFor(page, (src) => { scrollTo(0, document.documentElement.scrollHeight);
      const t = document.getElementById('toast'), b = t.getBoundingClientRect();
      return !t.hidden && getComputedStyle(t.parentNode).visibility !== 'hidden' && b.bottom <= innerHeight && new RegExp(src).test(t.textContent); }, re.source, 10000); };
    check(`feedback (${label}): Load on the toast loads it and the emulator says so`, back
      && (label === 'phone' ? await atEndUntil(/Loaded LOADME from your Library/) : await waitFor(page, () => [...window.__inView].some((t) => /Loaded LOADME from your Library/.test(t)))),
      JSON.stringify(await ev(() => ({ p: window.emu.feedback.pending, y: scrollY, h: document.documentElement.scrollHeight, ih: innerHeight, vis: getComputedStyle(document.getElementById('toastRegion')).visibility, box: document.getElementById('toast').getBoundingClientRect().toJSON(), hash: location.hash }))));
    if (label === 'desktop') {
      // 1440 x 900: the slots run below the window's edge, so bottom centre would cover them; the toast goes where
      // nothing is under it. The rule: it never covers a control; off the
      // screen where the bottom edge has a free place, else over the foot of the screen (wholly inside the tube)
      // measured once the layout has settled: the toast is placed again every frame (feedback.js follow), so a control
      // that moved in this frame is answered in the next
      const settle = () => ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
      // (the drawer can still be filling in as the emulator comes back: the toast follows it each frame, so the
      // placement is read until it has settled, up to 2 s, and that settled placement is what is checked)
      const measure = () => ev(() => { const t = document.getElementById('toast').getBoundingClientRect();
        const meets = (o) => !(t.bottom <= o.top || t.top >= o.bottom || t.right <= o.left || t.left >= o.right);
        const controls = [...document.querySelectorAll('.controls, .slots, aside.drawer, header')].map((e) => e.getBoundingClientRect()).filter((o) => o.width && o.height);
        const tube = document.querySelector('#monitor .tube').getBoundingClientRect(), monitor = document.getElementById('monitor').getBoundingClientRect();
        const inTube = t.left >= tube.left && t.right <= tube.right && t.top >= tube.top && t.bottom <= tube.bottom;
        // with the toast on the screen: was there a free place along the bottom edge it should have taken?
        let edgeFree = false;
        for (let x = 16; x + t.width <= innerWidth - 16; x += 8) {
          const c = { left: x, right: x + t.width, top: innerHeight - 24 - t.height, bottom: innerHeight - 24 };
          if (![...controls, monitor].some((o) => !(c.bottom <= o.top || c.top >= o.bottom || c.right <= o.left || c.left >= o.right))) edgeFree = true;
        }
        const met = [...document.querySelectorAll('.controls, .slots, aside.drawer, header')].filter((e) => { const o = e.getBoundingClientRect(); return o.width && o.height && meets(o); }).map((e) => `${e.tagName}.${e.className}#${e.id} ${['left', 'top', 'right', 'bottom'].map((k) => Math.round(e.getBoundingClientRect()[k])).join(',')}`);
        const reg = document.getElementById('toastRegion').style;
        return { met, region: [reg.left, reg.top, reg.visibility].join('|'), box: [t.left, t.top, t.right, t.bottom].map(Math.round), height: t.height, controls: controls.filter(meets).length, screen: meets(monitor), inTube, edgeFree }; });
      const placed = (o) => o && o.height > 0 && o.controls === 0 && (!o.screen || (o.inTube && !o.edgeFree));
      let over = null;
      // (a toast of our own, held up by hovering it: the program's load message may already have run its 4 s on a loaded
      // machine; the rule is the same for any toast. Read for up to 120 frames, not a wall-clock time)
      await ev(() => { window.emu.feedback.clear(); window.emu.feedback.toast('Loaded LOADME from your Library'); });
      await shownWithin(page, /Loaded LOADME from your Library/);
      await page.hover('#toast');
      for (let i = 0; i < 60; i++) { await settle(); over = await measure(); if (placed(over)) break; }
      check('feedback (desktop): on the emulator the toast covers no control (controls, slots, drawer, header), and the screen only at its foot when the bottom edge has no free place',
        placed(over), JSON.stringify(over));
      if (shotDir) await page.screenshot({ path: path.join(shotDir, 'feedback-emulator-desktop.png') });
    }
    // A message of our own, seen on the emulator, held up by hovering it (its timer paused), so a slow runner can't let
    // it run out before the next action; that action must still clear it.
    await ev(() => { location.hash = ''; });
    await ev(() => { window.emu.feedback.clear(); window.emu.feedback.toast('Before the next action'); });
    if (label === 'phone') await atEndUntil(/Before the next action/); else await shownWithin(page, /Before the next action/);
    await waitFor(page, () => window.emu.feedback.pending.some((m) => m.text === 'Before the next action' && m.seen));
    await page.hover('#toast');
    const oldText = await ev(() => !document.getElementById('toast').hidden && document.getElementById('toastText').textContent);
    const pendBefore = await ev(() => window.emu.feedback.pending);
    await page.click('#btnPause'); await page.click('#btnPause');
    // (gone; or, where a message raised meanwhile was waiting for room, that one now in its place). Read at once: the
    // clearing is synchronous in the pointerdown, and a later read could see the toast's own timer end it instead.
    const after = await page.evaluate(() => ({ up: !document.getElementById('toast').hidden, text: document.getElementById('toastText').textContent }));
    check(`feedback (${label}): on the emulator too, the next action clears the old message`, !!oldText && (!after.up || after.text !== oldText), JSON.stringify({ oldText, after, pendBefore, pendAfter: await ev(() => window.emu.feedback.pending) }));

    // the rule: a toast never covers a control. On the emulator, scrolled to the top, to the slots and to the end,
    // and after a control grows under it, the toast's box meets neither the slots panel nor the cartridge card (nor
    // the controls, the drawer or the header); scrolled to the top it is in view (somewhere free), so this is not
    // passed by a toast that never shows
    const placement = async () => { await ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))); return ev(() => {
      const t = document.getElementById('toast');
      if (t.hidden) return { up: false };
      const b = t.getBoundingClientRect();
      // a toast held back (visibility hidden: no free place in view) covers nothing
      if (getComputedStyle(t.parentNode).visibility === 'hidden') return { up: true, seen: false, hit: [], held: true };
      const hit = [...document.querySelectorAll('.slots, #cartSlot, .controls, aside.drawer, header')].filter((e) => { const o = e.getBoundingClientRect();
        return o.width && o.height && !(b.bottom <= o.top || b.top >= o.bottom || b.right <= o.left || b.left >= o.right); }).map((e) => e.id || e.className);
      return { up: true, seen: b.top >= 0 && b.bottom <= innerHeight, hit, box: [b.left, b.top, b.right, b.bottom].map(Math.round) };
    }); };
    const raiseAt = async (y) => {
      await ev((y) => { scrollTo(0, y === 'end' ? document.documentElement.scrollHeight : y === 'slots' ? scrollY + document.querySelector('.slots').getBoundingClientRect().top - 40 : y); }, y);
      await ev(() => { window.emu.feedback.toast('Placed where no control is under it'); });
      await ticks(page, 3);   // the toast is placed again every frame (feedback.js follow)
      return placement();
    };
    const atTop = await raiseAt(0), atSlots = await raiseAt('slots'), atEnd = await raiseAt('end');
    check(`feedback (${label}): on the emulator the toast never meets the slots or the cartridge card (top, slots, end of the page)`,
      // (in view somewhere, so this is not passed by a toast that never shows: at the top on a desktop; on a phone the
      // top has no room and the toast waits, shown at the end of the page)
      atTop.up && (label === 'phone' || atTop.seen) && !atTop.hit.length && atSlots.up && !atSlots.hit.length && atEnd.up && atEnd.seen && !atEnd.hit.length,
      JSON.stringify({ atTop, atSlots, atEnd }));
    // a control that grows under a toast already shown (the drawer filling in): placed again, still clear of them
    await ev(() => { scrollTo(0, 0); window.emu.feedback.toast('Placed again when the layout changes'); });
    await ticks(page, 3);
    await ev(() => { for (const e of document.querySelectorAll('aside.drawer, .slots')) e.style.minHeight = `${innerHeight + 200}px`; });
    await ticks(page, 4);   // placed again in the frames after the layout changed
    const grown = await placement();
    await ev(() => { for (const e of document.querySelectorAll('aside.drawer, .slots')) e.style.minHeight = ''; });
    check(`feedback (${label}): after a control grows under it, the toast still meets no control`, grown.up && !grown.hit.length, JSON.stringify(grown));
    await ev(() => { scrollTo(0, 0); window.emu.feedback.clear(); });

    // a toast raised for the Library while the user is on the emulator waits for the Library
    const raised = await ev(() => { try { window.emu.feedback.toast('Waiting for the Library', { view: 'library' }); return true; } catch (e) { return false; } });
    check(`feedback (${label}): a toast for another page is not shown here`, raised && !(await shown(page, /Waiting for the Library/)));
    await ev(() => { location.hash = '#library'; });
    check(`feedback (${label}): it shows when the user is back on its page`, raised && await shownWithin(page, /Waiting for the Library/));

    // Delete: no confirm box, the item goes at once, Undo brings it back; otherwise it is removed when the toast ends
    const stored = () => page.evaluate(async () => (await window.emu.session.listMedia()).map((x) => x.name).join());
    const tileOf = (n) => page.evaluate((n) => !!document.querySelector(`#libTiles [data-name="library/${n}"]`), n);
    await page.click('[data-kind-filter="all"]');
    await page.click('#btnLibSelect');
    await page.click('#libTiles [data-name="library/WORLD.BIN"]');
    await page.click('#btnLibDelete');
    // ("at once": well inside the toast's 8 s, at whose end the delete would otherwise happen)
    // (3 s, was 2 s: the tile's redraw waits on the store's delete, slower on a loaded runner; still far below the 8 s)
    check(`feedback (${label}): Delete needs no confirm box: the tile goes at once, with "Deleted WORLD.BIN" and Undo`, await waitFor(page, () => !document.querySelector('#libTiles [data-name="library/WORLD.BIN"]'), null, 3000)
      && await shownWithin(page, /Deleted WORLD\.BIN/) && await ev(() => document.getElementById('toastAction').textContent === 'Undo'));
    await tryClick('#toastAction');
    check(`feedback (${label}): Undo brings it back, still stored`, await waitFor(page, () => !!document.querySelector('#libTiles [data-name="library/WORLD.BIN"]')) && /WORLD\.BIN/.test(await stored()));
    await page.click('#btnLibSelect');
    await page.click('#libTiles [data-name="library/WORLD.BIN"]');
    await page.click('#btnLibDelete');
    // the delete's own toast first (under load it can come after the click returns), then the next action ends it
    const raisedDelete = await shownWithin(page, /Deleted WORLD\.BIN/, 8000) && /WORLD\.BIN/.test(await stored());
    // the next action ends the toast: a click on a filter, brought to the middle of the window first (at the bottom
    // the toast can lie over it, and Playwright would wait for the toast to time out instead of clicking)
    await ev(() => document.querySelector('[data-kind-filter="all"]').scrollIntoView({ block: 'center' }));
    await page.click('[data-kind-filter="all"]');
    const ended = await goneWithin(page, 8000);
    // removed from the store and from the shelf (the shelf redraws just after the store's delete). Up to 10 s after
    // the toast ends: a rare storage stall was measured (1 run in 20 of `--only feedback` over 3 s); the delete
    // itself takes milliseconds. The order stays checked: still stored while the toast was up (raisedDelete)
    check(`feedback (${label}): the delete happens when its toast ends`, raisedDelete && ended
      && await waitFor(page, async () => !(await window.emu.session.listMedia()).some((x) => x.name === 'library/WORLD.BIN')
        && !document.querySelector('#libTiles [data-name="library/WORLD.BIN"]'), null, 10000),
      `raised ${raisedDelete}, ended ${ended}; now: toast "${await ev(() => document.getElementById('toast').textContent)}", stored ${await stored()}, tile ${await tileOf('WORLD.BIN')}`);
    if (await ev(() => !document.getElementById('libSelBar').hidden)) await page.click('#btnLibDone');

    // an error: its first sentence on the toast, the rest under Details (a disk with no DOS ROM)
    await add('DISK.VDK', vdk);
    await waitFor(page, () => !!document.querySelector('#libTiles [data-name="disks/DISK.VDK"]'));
    await tryClick('#libTiles [data-name="disks/DISK.VDK"]');
    check(`feedback (${label}): an error is a toast with Details (first sentence shown, the rest under Details)`, await shownWithin(page, /Disks need a disk cartridge ROM/)
      && await ev(() => document.getElementById('toast').classList.contains('error') && document.getElementById('toastAction').textContent === 'Details'
        && document.getElementById('toastDetails').hidden && /Load the ROM file first/.test(document.getElementById('toastDetails').textContent)));
    await tryClick('#toastAction');
    check(`feedback (${label}): Details shows the rest`, await ev(() => !document.getElementById('toastDetails').hidden));
    await ev(() => { location.hash = ''; });

    if (label === 'desktop') {
      // buttons that can't work are disabled with the reason: Rewind with no tape
      check('feedback: Rewind is disabled while the deck is empty, saying why', await ev(() => { const b = document.getElementById('btnRewind'); return b.disabled && b.title === 'No tape inserted'; })
        && /No tape · Insert tape…/.test(await page.textContent('#tapeName')));
      // what the machine shows itself is not repeated: a typed POKE, Reset
      await tryClick('#btnReset');
      check('feedback: Reset says nothing (the screen shows it)', await quietFor(page, /\S/, 500));
      await openTab(page, 'POKEs');
      await tryClick('#pokeBook button');
      check('feedback: a typed POKE says nothing (BASIC shows the typed line)', await quietFor(page, /Typed/, 800));
      // a snapshot taken in a slot: "Snapshot 1 taken" with Undo, which empties the slot again
      await openTab(page, 'Media');
      await tryClick('#slotList [aria-label="Take snapshot 1"]');
      check('feedback: a quick save says "Snapshot 1 taken" with Undo', await shownWithin(page, /Snapshot 1 taken/) && await ev(() => document.getElementById('toastAction').textContent === 'Undo'));
      await tryClick('#toastAction');
      check('feedback: Undo puts the slot back as it was (empty)', await waitFor(page, () => /Snapshot 1 · empty/.test(document.querySelector('#slotList .row').textContent)));
    }
    check(`feedback (${label}): no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }
}

async function libraryChecks(browser, base, check) {
  // a .CAS built here from the block format (leader, $3C sync, type, length, data, checksum)
  const block = (type, data) => { let sum = (type + data.length) & 0xFF; for (const v of data) sum = (sum + v) & 0xFF; return [0x55, 0x3C, type, data.length, ...data, sum]; };
  const nameBlock = [...Buffer.from('HELLO   '), 2, 0, 0, 0x30, 0x00, 0x30, 0x00];
  const cas = Buffer.from([...Array(128).fill(0x55), ...block(0, nameBlock), ...Array(64).fill(0x55), ...block(1, [0x39, 1, 2, 3]), ...block(0xFF, [])]);
  const bin = Buffer.from([0x55, 2, 0x30, 0x00, 0x00, 0x04, 0x30, 0x00, 0xAA, 0x12, 0x34, 0x56, 0x78]);
  const dsk = fs.readFileSync(path.join(ROOT, 'tests/fixtures/disks/rsdos.dsk'));
  const ccc = fake(8192, 5), d32 = fake(16384, 77);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-lib-'));
  const files = { 'HELLO.CAS': cas, 'HELLO.BIN': bin, 'UTILS.DSK': dsk, 'GAME.CCC': ccc, 'd32.rom': d32 };
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(tmp, n), b);

  for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const errors = [];
    const ctx = await browser.newContext({ acceptDownloads: true, viewport });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?machine=dragon64#library`);
    await ready(page);
    await waitFor(page, () => !document.getElementById('library').hidden && !document.getElementById('libEmpty').hidden);
    const empty = await page.evaluate(() => ({
      lib: !document.getElementById('library').hidden, emu: getComputedStyle(document.querySelector('.layout')).display === 'none',
      empty: !document.getElementById('libEmpty').hidden, filters: document.getElementById('libFilters').hidden,
      head: document.querySelector('#libEmpty h2').textContent, where: document.getElementById('libWhere').textContent,
      fits: document.documentElement.scrollWidth <= innerWidth }));
    check(`library (${label}): #library shows the Library instead of the emulator, empty state, where it is kept, no sideways scroll`,
      empty.lib && empty.emu && empty.empty && empty.filters && empty.head === 'Your tapes, disks and cartridges will appear here'
      && /^Stored in this browser \(OPFS\)/.test(empty.where) && empty.fits, JSON.stringify(empty));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `library-empty-${label}.png`), fullPage: true });
    if (label === 'phone') {
      await page.click('#btnLibLiza');
      await waitFor(page, () => document.getElementById('library').hidden && /liza/i.test(document.getElementById('toast').textContent));
      check('library (phone): the empty state\'s LIZA closes the Library and runs LIZA', await page.isHidden('#library') && /liza/i.test(await page.textContent('#toast')), await page.textContent('#toast'));
      check('library (phone): no page errors', !errors.length, errors.join('; '));
      await ctx.close();
      continue;
    }

    // adding files: four kept, the ROM goes to its socket
    await page.setInputFiles('#fileLib', Object.keys(files).map((n) => path.join(tmp, n)));
    await waitFor(page, () => document.querySelectorAll('#libTiles .tile, #libTapes .spine').length === 4);
    const shelf = () => page.evaluate(() => ({
      tapes: [...document.querySelectorAll('#libTapes .spine')].map((b) => b.textContent).join(),
      tiles: [...document.querySelectorAll('#libTiles .tile')].map((b) => `${b.querySelector('.tag').textContent}=${b.querySelector('.what').textContent}`).join(', ') }));
    let sh = await shelf();
    check('library: added files sit on the shelves (tape spine; disk, cartridge and program tiles; the disk under disks/, where the drives find it); the ROM went to Your ROMs',
      sh.tapes === 'HELLO' && sh.tiles === 'UTILS=RS-DOS disk · CoCo, GAME=CoCo cartridge · CoCo, HELLO=DragonDOS binary · Dragon'
      && /^4 files added to your Library · 1 ROM added to Your ROMs$/.test(await page.textContent('#toast'))
      && await page.evaluate(() => window.emu.session.machineRoms('dragon32').bootable && !!document.querySelector('#libTiles .tile[data-name="disks/UTILS.DSK"]')),
      `${JSON.stringify(sh)} ${await page.textContent('#toast')}`);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'library-filled-desktop.png'), fullPage: true });
    // filters
    await page.click('[data-kind-filter="disk"]');
    const disks = await shelf();
    await page.click('[data-kind-filter="all"]');
    await page.selectOption('#libMachine', 'coco');
    const coco = await shelf();
    await page.selectOption('#libMachine', '');
    check('library: filters by kind (Disks) and machine (CoCo)', disks.tapes === '' && disks.tiles === 'UTILS=RS-DOS disk · CoCo'
      && coco.tapes === '' && /^UTILS=.*, GAME=/.test(coco.tiles), `${JSON.stringify(disks)} ${JSON.stringify(coco)}`);
    // a reload keeps them
    await page.reload(); await ready(page);
    await waitFor(page, () => document.querySelectorAll('#libTiles .tile, #libTapes .spine').length === 4);
    check('library: still there after a reload (OPFS)', JSON.stringify(await shelf()) === JSON.stringify(sh));
    // click to load: the Library closes, the program is in memory
    await page.click('#libTiles .tile[data-name="library/HELLO.BIN"]');
    await waitFor(page, () => document.getElementById('library').hidden && window.emu.machine.ram[0x3000] === 0x12 && window.emu.machine.ram[0x3003] === 0x78);
    check('library: clicking a tile loads it and returns to the emulator', await page.isHidden('#library') && !/#library/.test(page.url())
      && await page.evaluate(() => window.emu.machine.ram[0x3000] === 0x12 && window.emu.machine.ram[0x3003] === 0x78), await page.textContent('#toast'));
    // links into the Library
    const libShown = (want) => waitFor(page, (want) => document.getElementById('library').hidden !== want, want);
    await page.click('#navLibrary'); await libShown(true);
    const viaNav = await page.isVisible('#library');
    await page.click('#btnLibBack'); await libShown(false);
    const back = await page.isHidden('#library') && await page.isVisible('#screen');
    await openTab(page, 'Media'); await page.click('#linkLibrary'); await libShown(true);
    check('library: the header link and the Media tab\'s "Open your library →" open it; "← Emulator" closes it', viaNav && back && await page.isVisible('#library'));
    // select mode: rename, download, delete
    await page.click('#btnLibSelect');
    await page.click('#libTapes .spine[data-name="library/HELLO.CAS"]');
    const selected = await page.textContent('#libCount');
    await page.click('#btnLibRename');
    await page.fill('#library .rename input', 'MY/GAME.CAS');
    await page.keyboard.press('Enter');
    await waitFor(page, () => !!document.querySelector('#libTapes .spine[data-name="library/MY-GAME.CAS"]'));
    const renamed = await page.textContent('#toast');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnLibDownload')]);
    const got = fs.readFileSync(await dl.path());
    await page.click('#btnLibDelete');
    await waitFor(page, () => !document.querySelector('#libTapes .spine'));
    check('library: Select selects; Rename (a slash becomes a dash, and the status says so), Download (the same bytes) and Delete work',
      selected === '1 selected' && renamed === 'Renamed to MY-GAME.CAS' && dl.suggestedFilename() === 'MY-GAME.CAS'
      && Buffer.compare(got, cas) === 0 && (await shelf()).tapes === '' && await page.isHidden('#libTapesBox'), `${selected} ${renamed} ${dl.suggestedFilename()}`);
    // a file loaded with Insert… is kept
    await page.click('#btnLibBack');
    fs.writeFileSync(path.join(tmp, 'KEPT.BIN'), bin);
    await page.setInputFiles('#fileProgram', path.join(tmp, 'KEPT.BIN'));
    // (waited for: the file is stored after the load, as fast as the store answers; listing it then is the check)
    const kept = await waitFor(page, async () => (await window.emu.session.listMedia()).some((x) => x.name === 'library/KEPT.BIN'));
    check('library: a program loaded with Insert… is kept in the Library', kept, (await page.evaluate(async () => (await window.emu.session.listMedia()).map((x) => x.name))).join(' '));
    // a disk image: clicking it mounts it in a drive (through mountDisk); while it is in, Rename and Delete refuse;
    // ejected, it can be deleted. (A CoCo with a synthetic RS-DOS cartridge ROM: a mount only needs one stored.)
    await page.evaluate(() => { const s = window.emu.session; s.roms.put('rsdos', 'rom', new Uint8Array(0x2000).fill(0x39), 'disk11.rom'); s.switchMachine('coco'); });
    await page.evaluate(() => { location.hash = '#library'; });
    await waitFor(page, () => !!document.querySelector('#libTiles .tile[data-name="disks/UTILS.DSK"]'));
    await page.click('#libTiles .tile[data-name="disks/UTILS.DSK"]');
    await waitFor(page, () => window.emu.session.diskStatus().drives.length === 1);
    const mounted = await page.evaluate(() => ({ drives: window.emu.session.diskStatus().drives.map((d) => `${d.drive}:${d.name}`).join(), lib: document.getElementById('library').hidden,
      msg: document.getElementById('toast').textContent }));
    check('library: clicking a disk mounts it in a drive and returns to the emulator', mounted.drives === '0:disks/UTILS.DSK' && mounted.lib && mounted.msg === 'UTILS.DSK in drive 0',
      JSON.stringify(mounted));
    await page.evaluate(() => { location.hash = '#library'; });
    await waitFor(page, () => !!document.querySelector('#libTiles .tile[data-name="disks/UTILS.DSK"]'));
    await page.click('#btnLibSelect');
    await page.click('#libTiles .tile[data-name="disks/UTILS.DSK"]');
    await page.click('#btnLibRename');
    await waitFor(page, () => /eject it before you rename it/.test(document.getElementById('toast').textContent));
    const renameMsg = await page.textContent('#toast');
    // a refused rename opens no name field and keeps the selection
    const stillSelected = !(await page.$('#library .rename')) && await page.isVisible('#libSelBar')
      && await page.getAttribute('#libTiles .tile[data-name="disks/UTILS.DSK"]', 'aria-pressed') === 'true';
    await page.click('#btnLibDelete');
    await waitFor(page, () => /eject it before you delete it/.test(document.getElementById('toast').textContent));
    const deleteMsg = await page.textContent('#toast');
    const still = await page.evaluate(async () => (await window.emu.session.listMedia()).some((x) => x.name === 'disks/UTILS.DSK'));
    check('library: a disk in a drive can be neither renamed nor deleted, and the status says which drive holds it',
      /^UTILS\.DSK is in drive 0; eject it before you rename it/.test(renameMsg) && /^UTILS\.DSK is in drive 0; eject it before you delete it/.test(deleteMsg) && still && stillSelected,
      `${renameMsg} | ${deleteMsg}`);
    await page.evaluate(() => window.emu.session.ejectDisk(0));
    await page.click('#btnLibDelete');
    await waitFor(page, () => !document.querySelector('#libTiles .tile[data-name="disks/UTILS.DSK"]'));
    // leaving the Library ends the Undo toast: the delete is done then
    await page.click('#btnLibBack');
    check('library: ejected, the disk can be deleted (done when the Library is left, which ends its Undo)',
      await waitFor(page, async () => !(await window.emu.session.listMedia()).some((x) => x.name === 'disks/UTILS.DSK'), null, 3000));

    // type-in: on the stub it asks for ROMs; with BASIC (the Dragon 32's synthetic ROM) the listing is typed key by key
    await page.evaluate(() => { location.hash = '#library'; });
    await libShown(true);
    const listing = '10 CLS\n20 PRINT "HI"\n30 GOTO 20\n';
    await page.fill('#typeinSource', listing);
    check('type-in: on the stub, the card asks for the ROMs and typing is off; the line check runs', await page.isVisible('#typeinNeeds')
      && await page.isDisabled('#btnTypein') && (await page.textContent('#typeinCheck')) === 'Line check: no problems');
    await page.evaluate(() => window.emu.session.switchMachine('dragon32'));
    await waitFor(page, () => window.emu.machine.id === 'dragon32');
    await page.evaluate(() => { const m = window.emu.machine, set = m.setKey.bind(m); window.__keys = []; m.setKey = (k, down) => { if (down && k !== 'SHIFT') window.__keys.push(k); return set(k, down); }; });
    await page.click('#btnTypein');
    await waitFor(page, () => /^Line \d+ of 30 · typing/.test(document.getElementById('typeinProgress').textContent));
    const during = await page.textContent('#typeinProgress');
    const locked = await page.isDisabled('#btnTypeinFast') && await page.isDisabled('#btnTypein');   // no second job while typing
    const done = await waitFor(page, () => /Typed in/.test(document.getElementById('typeinProgress').textContent), null, 30000);
    const keys = await page.evaluate(async (text) => {
      const { charToKeys } = await import('/js/machines/keyboards.js');
      const want = [...`NEW\r${text.trim().split('\n').join('\r')}\r`].map((c) => charToKeys(c).key);
      return { want: want.join(' '), got: window.__keys.join(' ') };
    }, listing);
    check('type-in: typed at keyboard speed with progress (both buttons off meanwhile), every key of NEW and the listing in order', done && locked && /^Line (10|20|30) of 30 · typing at 10 keys\/s$/.test(during)
      && keys.got === keys.want && (await page.evaluate(() => document.getElementById('typeinBar').style.width)) === '100%', `${during} | got ${keys.got} | want ${keys.want}`);
    await page.evaluate(() => { window.__keys = []; });
    const t0 = Date.now();
    await page.click('#btnTypeinFast');
    const fast = await waitFor(page, () => /Typed in/.test(document.getElementById('typeinProgress').textContent) && !window.emu.session.turbo, null, 30000);
    check('type-in: "Paste instantly" types the same keys flat out, then Turbo is as it was', fast && (await page.evaluate(() => window.__keys.join(' '))) === keys.want
      && Date.now() - t0 < 4000, `${Date.now() - t0} ms`);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'library-typein-desktop.png') });
    await page.fill('#typeinSource', '20 A=1\n10 B=2\nPRINT');
    check('type-in: the line check names what is wrong', /Line check: 10 comes after 20; line 3 has no line number/.test(await page.textContent('#typeinCheck')), await page.textContent('#typeinCheck'));
    check('library: no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// quick-save slots in the Media tab, kept in the media store: save, still there after a reload, load on
// another machine (the switch question first, then the same memory), listed in the Library's Snapshots
async function slotChecks(browser, base, check) {
  const errors = [];
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?machine=dragon64`);
  await started(page);
  // the moment: LIZA, with a marker in memory once she has greeted. Not the welcome menu: quick save stays hidden
  // while it is all that has run (FV-1), and a moment of the stub's bare prompt opens on the menu
  await openTab(page, 'Media');
  await page.click('#shelf button:text-is("LIZA")');
  await waitFor(page, () => window.emu.session.screenText().join('').includes('I AM LIZA'));
  await page.evaluate(() => window.emu.machine.poke(1030, 77));
  await page.click('#btnPause');
  const memHash = () => page.evaluate(() => { const m = window.emu.machine.memoryArray(); let h = 0x811C9DC5; for (const v of m) h = Math.imul(h ^ v, 0x01000193) >>> 0; return h; });
  const held = await memHash();
  await openTab(page, 'Media');
  const rows = () => page.$$eval('#slotList .row', (r) => r.map((x) => `${x.querySelector('span').textContent}|${x.querySelector('button[aria-label^="Restore"]').disabled ? 'off' : 'on'}`));
  const before = await rows();
  await page.click('#slotList [aria-label="Take snapshot 1"]');
  await waitFor(page, () => /Dragon 64/.test(document.querySelector('#slotList .row').textContent));
  const after = await rows();
  check('snapshots: three empty, then Snapshot 1 holds the Dragon 64', before.join() === 'Snapshot 1 · empty|off,Snapshot 2 · empty|off,Snapshot 3 · empty|off'
    && /^Snapshot 1 · Dragon 64 · .+\|on$/.test(after[0]) && /^Snapshot 1 taken/.test(await page.textContent('#toast')), `${before} / ${after}`);
  await page.reload(); await ready(page);
  await openTab(page, 'Media');
  await waitFor(page, () => /Dragon 64/.test(document.querySelector('#slotList .row').textContent));
  check('slots: still there after a reload', (await rows())[0] === after[0]);
  await pickMachine(page, 'coco');
  await openTab(page, 'Media');
  await page.click('#btnPause');
  await page.click('#slotList [aria-label="Restore snapshot 1"]');
  await waitFor(page, () => !document.getElementById('switchConfirm').hidden);
  const asked = await page.isVisible('#switchConfirm') && (await page.textContent('#switchName')) === 'Dragon 64';
  await page.click('#btnSwitch');
  await waitFor(page, () => window.emu.machine.id === 'dragon64');
  check('slots: loading on another machine asks to switch, then the moment is back', asked && await page.evaluate(() => window.emu.machine.id) === 'dragon64'
    && (await memHash()) === held);
  await page.evaluate(() => { location.hash = '#library'; });
  await waitFor(page, () => !!document.querySelector('#libTiles .tile'));
  await page.click('[data-kind-filter="snapshot"]');
  const listed = await page.$$eval('#libTiles .tile', (t) => t.map((x) => `${x.dataset.name}=${x.querySelector('.what').textContent}`));
  check('slots: the Library lists the slot under Snapshots', listed.join() === 'library/snapshots/slot-1.cloadm=snapshot', listed.join());
  // a slot a pre-release build saved (slot 1's file, as such a build wrote it): on the next visit the row says it is
  // unreadable, its tooltip gives the pre-release refusal, and it cannot be restored
  const slot1 = Buffer.from(await page.evaluate(async () => [...await window.emu.session.media.read('library/snapshots/slot-1.cloadm')]));
  const preJson = Object.assign(JSON.parse(zlib.gunzipSync(slot1).toString('utf8')), { format: 'cloadm-snapshot', version: 19 });
  const preBytes = [...zlib.gzipSync(Buffer.from(JSON.stringify(preJson)))];
  await page.evaluate(async (b) => { await window.emu.session.media.write('library/snapshots/slot-2.cloadm', new Uint8Array(b)); }, preBytes);
  await page.goto(`${base}?machine=dragon64`);   // (a reload would stay on the Library)
  await started(page);
  await openTab(page, 'Media');
  await waitFor(page, () => /unreadable/.test(document.querySelectorAll('#slotList .row')[1].textContent));
  const preRow = await page.$$eval('#slotList .row', (rs) => ({ text: rs[1].querySelector('span').textContent, title: rs[1].querySelector('span').title,
    off: rs[1].querySelector('button[aria-label^="Restore"]').disabled }));
  check('slots: a pre-release slot is listed as unreadable, saying it came from a pre-release build, and cannot be restored',
    preRow.text === 'Snapshot 2 · unreadable' && /pre-release build of CLOADM, whose snapshots this version does not read/.test(preRow.title) && preRow.off,
    JSON.stringify(preRow));
  check('slots: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

// the cassette panel: hidden without a tape; a tape inserted through the deck shows
// its label, length and blocks; the motor running fast-forward, then at real speed (one setting with the Media
// tab's); a read error (BASIC's ?IO ERROR as the motor stops) and its rewind; skipping the tape; recording; phone
async function tapePanelChecks(browser, base, check) {
  const block = (type, data) => { let sum = (type + data.length) & 0xFF; for (const v of data) sum = (sum + v) & 0xFF; return [0x55, 0x3C, type, data.length, ...data, sum]; };
  const code = [0x20, 0xFE, ...Array.from({ length: 7998 }, (_, i) => (i * 13) & 0xFF)];   // BRA * then data: it waits when run
  // A long leader (plain $55) before the blocks, so the tape lasts long enough at fast-forward for the panel's
  // own speed readout to settle. That readout is measured over 1 s windows and reads x1 until the first window
  // closes, so a tape that ran through in ~1.6 s showed "LOADING and fast-forward faster than real time" for
  // only ~0.6 s - and on a machine quick enough for the tape to finish inside that first second, it never showed
  // it at all. Padding the leader (not the data: the block count, the $3000-$4F3F load and the skip tests depend
  // on that) widens the window and keeps END OF TAPE out of the way, so the two states stay distinct.
  const bytes = [...Array(128).fill(0x55), ...Array(16000).fill(0x55), ...block(0, [...Buffer.from('DECK    '), 2, 0, 0, 0x30, 0x00, 0x30, 0x00])];
  for (let i = 0; i < code.length; i += 250) bytes.push(...Array(16).fill(0x55), ...block(1, code.slice(i, i + 250)));
  bytes.push(...block(0xFF, []));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-tape-'));
  fs.writeFileSync(path.join(tmp, 'deck.cas'), Buffer.from(bytes));
  for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const errors = [];
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?machine=dragon64`);
    await ready(page);
    await stubPrompt(page);
    const hiddenAtFirst = await page.isHidden('#tapePanel');
    await page.setInputFiles('#fileTape', path.join(tmp, 'deck.cas'));
    await waitFor(page, () => !document.getElementById('tapePanel').hidden);
    const text = (id) => page.textContent(`#${id}`);
    check(`tape panel (${label}): hidden without a tape; the inserted tape's label, length and blocks`, hiddenAtFirst && (await text('tapeLabel')) === 'deck.cas'
      && /^\d:\d\d$/.test(await text('tapeLength')) && (await text('tapeEyebrow')) === 'STOPPED · BLOCK 0 OF 34'
      && /^Counter 000 · 1200\/2400 Hz · motor off$/.test(await text('tapeCounter'))
      && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${await text('tapeEyebrow')} | ${await text('tapeCounter')}`);
    if (label === 'phone') {
      if (shotDir) { await (await page.$('#tapePanel')).screenshot({ path: path.join(shotDir, 'tape-panel-phone.png') }); }
      check(`tape panel (${label}): no page errors`, !errors.length, errors.join('; '));
      await ctx.close();
      continue;
    }
    // the motor on, fast tape (the default): loading, counting, fast-forward
    //
    // The state is waited for, not sampled after a fixed 1500 ms. The tape runs through in a few seconds of wall
    // clock at fast-forward, so a fixed sample landed after END OF TAPE whenever the machine was quick that
    // moment (x36 and x39 were both seen, and this check was flaky in consequence). The sampler is installed
    // BEFORE the motor switches on and records every state the panel shows, so a LOADING frame cannot be missed
    // however soon it comes, and the assertion is on what was shown rather than on one instant's luck.
    await page.evaluate(() => {
      window.__seen = [];
      const note = () => window.__seen.push({
        eyebrow: document.getElementById('tapeEyebrow').textContent,
        speed: document.getElementById('tapeSpeed').textContent,
        state: document.getElementById('tapePanel').dataset.state,
        leftReelWound: parseFloat(getComputedStyle(document.getElementById('reelL')).getPropertyValue('--wound')),
      });
      note();   // STOPPED, before the motor
      // the panel repaints every 250 ms on its own; sampling faster than that, and on the two texts changing
      // together, catches every state it shows
      window.__sampler = setInterval(note, 50);
      window.__mo = new MutationObserver(note);
      for (const id of ['tapeEyebrow', 'tapeSpeed']) window.__mo.observe(document.getElementById(id), { childList: true, characterData: true, subtree: true });
      window.__motor = setInterval(() => window.emu.machine.deck.setMotor(true), 20);
    });
    const isFastLoading = (s) => /^LOADING · BLOCK \d+ OF 34$/.test(s.eyebrow) && /^Fast-forward ×\d+$/.test(s.speed) && Number(s.speed.split('×')[1]) > 1;
    // waiting for the frame is the condition; the timeout only bounds a failure. The speed readout is measured
    // over 1 s windows and reads x1 until the first closes, so this is the frame that shows both at once.
    const sawLoading = await waitFor(page, () => window.__seen.some((s) => /^LOADING · BLOCK \d+ OF 34$/.test(s.eyebrow) && /^Fast-forward ×\d+$/.test(s.speed) && +s.speed.split('×')[1] > 1), null, 20000);
    const seen = await page.evaluate(() => window.__seen);
    const loading = seen.find(isFastLoading);
    check('tape panel: motor on: LOADING · BLOCK n OF 34, fast-forward faster than real time, the reels turn',
      sawLoading && !!loading && loading.state === 'playing' && loading.leftReelWound < 1,
      `loading=${JSON.stringify(loading)} states=${[...new Set(seen.map((s) => s.state))].join(',')} frames=${seen.length}`);
    // the end of the tape, checked on its own so that it cannot stand in for the LOADING assertion above
    // The rest of the tape is skipped to its last block first: at fast-forward the run to the end takes as long as the
    // page is fast, and under load (another test suite, MAME) 20 s were not enough (seen stuck at block 1 and 27 of
    // 34). What is checked is what the panel shows when the tape ends, not how fast it gets there.
    await page.evaluate(() => { const t = window.emu.machine.deck.tape; t.seekByte(t.bytes.length - 8); });
    const sawEnd = await waitFor(page, () => document.getElementById('tapeEyebrow').textContent === 'END OF TAPE · 34 BLOCKS', null, 20000);
    const endState = await page.evaluate(() => ({ eyebrow: document.getElementById('tapeEyebrow').textContent, state: document.getElementById('tapePanel').dataset.state }));
    check('tape panel: at the end: END OF TAPE with its block count, still playing', sawEnd && endState.state === 'playing', JSON.stringify(endState));
    // done with the tape here; stop the sampler so it is not still recording during the blocks below
    await page.evaluate(() => { clearInterval(window.__sampler); window.__mo.disconnect(); });
    // real speed: the same setting as the Media tab's checkbox
    await page.click('#btnRealSpeed');
    await waitFor(page, () => !window.emu.session.fastTape && document.getElementById('tapeSpeed').textContent === 'Real speed');
    const real = { pressed: await page.getAttribute('#btnRealSpeed', 'aria-pressed'), box: await page.isChecked('#chkFastTape'),
      fast: await page.evaluate(() => window.emu.session.fastTape), speed: await text('tapeSpeed') };
    check('tape panel: "Real speed" turns fast tape loading off (the Media tab\'s checkbox too)', real.pressed === 'true' && !real.box && !real.fast
      && real.speed === 'Real speed', JSON.stringify(real));
    if (shotDir) await (await page.$('#tapePanel')).screenshot({ path: path.join(shotDir, 'tape-panel-desktop.png') });
    // a read error: BASIC's report on the screen as the motor stops (written into the text screen here)
    await page.evaluate(() => {
      clearInterval(window.__motor);
      const m = window.emu.machine, put = (row, t) => { for (let i = 0; i < 32; i++) { const c = (t[i] || ' ').charCodeAt(0); m.ram[0x400 + row * 32 + i] = c >= 64 ? c - 64 : c; } };
      put(14, '?IO ERROR'); put(15, 'OK');
      m.deck.setMotor(false);
    });
    await waitFor(page, () => /^READ ERROR/.test(document.getElementById('tapeEyebrow').textContent));
    const err = { eyebrow: await text('tapeEyebrow'), retry: await page.isVisible('#btnTapeRetry') };
    await page.click('#btnTapeRetry');
    await waitFor(page, () => document.getElementById('tapeEyebrow').textContent === 'STOPPED · BLOCK 0 OF 34' && document.getElementById('btnTapeRetry').hidden);
    check('tape panel: a read error names its block and offers a rewind, which rewinds and clears it', /^READ ERROR · BLOCK \d+ OF 34$/.test(err.eyebrow) && err.retry
      && (await text('tapeEyebrow')) === 'STOPPED · BLOCK 0 OF 34' && await page.isHidden('#btnTapeRetry'), JSON.stringify(err));
    // skip the tape: the program, in memory at once
    await page.click('#btnSkipTape');
    await waitFor(page, () => /fast-loaded/.test(document.getElementById('toast').textContent));
    check('tape panel: "Skip the tape" loads it instantly', /deck\.cas: DECK fast-loaded \$3000-\$4F3F, exec \$3000/.test(await text('toast'))
      && await page.evaluate((c) => c.every((v, i) => window.emu.machine.ram[0x3000 + i] === v), code), await text('toast'));
    // a power cycle keeps the tape, so the panel stays
    await page.click('#btnHardReset');
    await emuFrames(page, 5);   // the power cycle has happened and the machine runs again
    check('tape panel: a power cycle keeps the tape, and the panel', await page.isVisible('#tapePanel') && await page.evaluate(() => !!window.emu.machine.deck.tape));
    // recording, with no tape in the deck (taken out through the deck: the page has no Eject control yet)
    await page.evaluate(() => window.emu.machine.deck.eject());
    const gone = await waitFor(page, () => document.getElementById('tapePanel').hidden);
    await page.click('#btnRecord');
    await waitFor(page, () => !document.getElementById('tapePanel').hidden && /^RECORDING/.test(document.getElementById('tapeEyebrow').textContent));
    check('tape panel: gone with the tape; shown while recording', gone && await page.isVisible('#tapePanel')
      && /^RECORDING/.test(await text('tapeEyebrow')), await text('tapeEyebrow'));
    await page.click('#btnRecord');
    check('tape panel: no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// The Library's remaining parts ("Stored in browser storage (OPFS), or linked to a folder on
// your computer so writes go straight back to the image file. Drag a spine onto the emulator, or click it, to load
// it."): a spine or a tile dragged onto the machine's screen (the type-in card's view of the running machine)
// loads it, as a click does; "Where your library is kept" moves the library between this browser, a folder and
// download-and-open, remembers the choice and the folder across a reload, offers to reconnect a folder whose
// permission the browser asks for again, and refuses while a stored disk is in a drive.
// The folder is a stand-in: headless Chromium has no folder picker to drive, so showDirectoryPicker is mocked to
// return a real directory handle (a folder inside the page's OPFS, outside what the OPFS store lists). The
// context is a persistent profile: in Playwright's incognito-like contexts, reading a directory handle back from
// IndexedDB closes the page, so the folder-remembering path is checked in a normal profile. That is a Playwright
// artefact: verified manually by the owner in desktop Chrome on macOS (at 67461a4) — the real folder picker works
// end to end, the linked folder survives a full Chrome restart, and in an incognito window a linked folder plus a
// reload doesn't crash, with the folder choice enabled; and dragging a spine onto the screen with a mouse loads
// it. Dragging by touch is not verified (HTML drag and drop is mouse-only; on touch screens a tap loads).
async function libraryStorageChecks(base, check) {
  const bin = Buffer.from([0x55, 2, 0x30, 0x00, 0x00, 0x04, 0x30, 0x00, 0xAA, 0x12, 0x34, 0x56, 0x78]);
  const block = (type, data) => { let sum = (type + data.length) & 0xFF; for (const v of data) sum = (sum + v) & 0xFF; return [0x55, 0x3C, type, data.length, ...data, sum]; };
  const cas = Buffer.from([...Array(128).fill(0x55), ...block(0, [...Buffer.from('HELLO   '), 2, 0, 0, 0x30, 0x00, 0x30, 0x00]), ...Array(64).fill(0x55), ...block(1, [0x39, 1, 2, 3]), ...block(0xFF, [])]);
  const dsk = fs.readFileSync(path.join(ROOT, 'tests/fixtures/disks/rsdos.dsk'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-profile-'));
  const ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  // the folder picker returns a folder inside OPFS; a test flag makes the browser "forget" the folder's permission
  await ctx.addInitScript(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('my-folder', { create: true });
    if (localStorage.getItem('test.forgetPermission')) FileSystemHandle.prototype.queryPermission = async () => 'prompt';
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const kind = () => page.evaluate(() => window.emu.session.media.kind);
  const names = () => page.evaluate(async () => (await window.emu.session.listMedia()).map((x) => x.name).join());
  const msg = () => page.textContent('#toast');
  // a choice is done when its status says so (the store changes first, then the index loads and the cards redraw)
  const settled = (re) => waitFor(page, (src) => new RegExp(src).test(document.getElementById('toast').textContent), re.source);
  const openLib = async () => { await page.evaluate(() => { location.hash = '#library'; }); await waitFor(page, () => !document.getElementById('library').hidden); };
  // a drag with the mouse, as a person does it: press on the item, move over the target, look, let go
  const drag = async (from, to, look = null) => {
    // the shelf redraws when the library's index settles, which can replace an element between finding it and
    // measuring it: measure until both are there
    const box = async (sel) => { for (let i = 0; i < 50; i++) { const r = await page.locator(sel).boundingBox().catch(() => null); if (r) return r; await page.waitForTimeout(100); } throw new Error(`${sel}: not on the page`); };
    const a = await box(from), b = await box(to);
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
    const seen = look ? await look() : null;
    await page.mouse.up();
    return seen;
  };

  await page.goto(`${base}?machine=dragon64#library`); await ready(page);
  const card = await page.evaluate(() => ({ choices: [...document.querySelectorAll('#libStorageChoices .choice')].map((b) => `${b.dataset.storage}:${b.getAttribute('aria-checked')}:${b.disabled}`).join(' '),
    labels: [...document.querySelectorAll('#libStorageChoices .choice strong')].map((s) => s.textContent).join(' | '),
    where: document.getElementById('libWhere').textContent, hint: document.getElementById('libFooter').textContent, reconnect: document.getElementById('libReconnect').hidden }));
  check('library storage: the three places, this browser chosen, and where it is kept now', card.choices === 'opfs:true:false fsa:false:false fallback:false:false'
    && card.labels === 'Inside this browser | A folder on this computer | Download and open files' && /^Stored in this browser \(OPFS\)/.test(card.where) && card.reconnect,
    JSON.stringify(card));
  check('library: the hint says a spine or a tile can be dragged onto the machine\'s screen', /drag it onto the machine's screen, to load it/.test(card.hint), card.hint);
  await page.setInputFiles('#fileLib', [{ name: 'HELLO.BIN', mimeType: 'application/octet-stream', buffer: bin }, { name: 'HELLO.CAS', mimeType: 'application/octet-stream', buffer: cas },
    { name: 'UTILS.DSK', mimeType: 'application/octet-stream', buffer: dsk }]);
  await waitFor(page, () => document.querySelectorAll('#libTiles .tile, #libTapes .spine').length === 3);
  const before = await names();

  // ---- drag to load ----
  check('drag: spines and tiles can be dragged', await page.evaluate(() => [...document.querySelectorAll('#libTiles .tile, #libTapes .spine')].every((b) => b.draggable)));
  const during = await drag('#libTiles .tile[data-name="library/HELLO.BIN"]', '#typeinDrop', async () => {
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'library-drag-desktop.png') });
    return page.evaluate(() => ({ dragging: document.getElementById('library').classList.contains('dragging'), over: document.getElementById('typeinDrop').classList.contains('over'),
      hint: document.getElementById('typeinDropHint').textContent, shown: getComputedStyle(document.getElementById('typeinDropHint')).display !== 'none' }));
  });
  check('drag: over the machine\'s screen it says what will load into which machine', during && during.dragging && during.over && during.shown && during.hint === 'Drop to load HELLO.BIN into the Dragon 64',
    JSON.stringify(during));
  await waitFor(page, () => document.getElementById('library').hidden);
  check('drag: a tile dropped on the machine\'s screen loads it and returns to the emulator, as a click does',
    await page.evaluate(() => window.emu.machine.ram[0x3000] === 0x12 && window.emu.machine.ram[0x3003] === 0x78 && !location.hash.includes('library')), await msg());
  await openLib();
  const msgBefore = await msg();
  await drag('#libTapes .spine[data-name="library/HELLO.CAS"]', '#libHeading');
  // the drag has ended; then the frames in which a wrong load or add would show
  await waitFor(page, () => !document.getElementById('library').classList.contains('dragging'));
  await ticks(page, 30);
  await page.evaluate(() => window.emu.session.index.settled());   // and the library's index has taken in any (wrong) add
  check('drag: a spine let go anywhere else loads nothing, adds nothing, and the hint goes', await page.isVisible('#library') && await names() === before && await msg() === msgBefore
    && await page.evaluate(() => !document.getElementById('library').classList.contains('dragging')), await msg());
  await page.click('#btnLibSelect');
  check('drag: in select mode, items are selected, not dragged', await page.evaluate(() => [...document.querySelectorAll('#libTiles .tile, #libTapes .spine')].every((b) => !b.draggable)));
  await page.click('#btnLibDone');
  // a disk tile dragged onto the screen mounts it (a CoCo with a synthetic RS-DOS cartridge ROM)
  await page.evaluate(() => { const s = window.emu.session; s.roms.put('rsdos', 'rom', new Uint8Array(0x2000).fill(0x39), 'disk11.rom'); s.switchMachine('coco'); });
  await openLib();
  await drag('#libTiles .tile[data-name="disks/UTILS.DSK"]', '#typeinDrop');
  check('drag: a disk tile dropped on the screen goes into a drive', await waitFor(page, () => window.emu.session.diskStatus().drives.map((d) => `${d.drive}:${d.name}`).join() === '0:disks/UTILS.DSK')
    && await page.isHidden('#library'), await msg());

  // ---- where it is kept ----
  await openLib();
  await page.click('#libStorageChoices .choice[data-storage="fallback"]');
  await waitFor(page, () => /^Eject the disks first/.test(document.getElementById('toast').textContent));
  check('storage: refused while a stored disk is in a drive, saying which', await kind() === 'opfs' && /^Eject the disks first \(drive 0: UTILS\.DSK\)/.test(await msg()), await msg());
  await page.evaluate(() => window.emu.session.ejectDisk(0));
  await page.click('#libStorageChoices .choice[data-storage="fsa"]');
  await settled(/^Your library is now kept in the folder/);
  const moved = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('my-folder');
    const size = async (d, p) => { try { const parts = p.split('/'); let h = d; for (const x of parts.slice(0, -1)) h = await h.getDirectoryHandle(x); return (await (await h.getFileHandle(parts.at(-1))).getFile()).size; } catch (e) { return -1; } };
    const root = await navigator.storage.getDirectory();
    return { folder: [await size(dir, 'library/HELLO.BIN'), await size(dir, 'library/HELLO.CAS'), await size(dir, 'disks/UTILS.DSK')], old: await size(root, 'library/HELLO.BIN'),
      checked: document.querySelector('#libStorageChoices .choice[aria-checked="true"]').dataset.storage, where: document.getElementById('libWhere').textContent };
  });
  check('storage: choosing a folder copies the library into it (the files at their sizes) and keeps the old copies', JSON.stringify(moved.folder) === JSON.stringify([bin.length, cas.length, dsk.length])
    && moved.old === bin.length && /^Your library is now kept in the folder “my-folder”: \d+ file\(s\) copied\. The old copies stay where they were\.$/.test(await msg()), `${JSON.stringify(moved)} ${await msg()}`);
  check('storage: the folder is chosen and named', moved.checked === 'fsa' && moved.where === 'Linked to the folder “my-folder” on your computer: writes go straight back to the files.', moved.where);
  if (shotDir) await page.locator('#libStorage').screenshot({ path: path.join(shotDir, 'library-storage-desktop.png') });
  await page.reload(); await ready(page);
  check('storage: after a reload the library is still in the folder (choice and folder remembered)', await kind() === 'fsa' && /library\/HELLO\.BIN/.test(await names())
    && await page.isHidden('#libReconnect'), `${await kind()} ${await names()}`);
  await page.evaluate(() => window.emu.session.importMedia('NEW.BIN', new Uint8Array([0x55, 2, 0x30, 0, 0, 1, 0x30, 0, 0xAA, 0x39])));
  check('storage: what is added now goes into the folder', await page.evaluate(async () => {
    const d = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('my-folder')).getDirectoryHandle('library');
    return !!(await d.getFileHandle('NEW.BIN').catch(() => null));
  }));
  // the browser asks for the folder's permission again: the library is kept in the browser until reconnected
  await page.evaluate(() => localStorage.setItem('test.forgetPermission', '1'));
  await page.reload(); await ready(page); await openLib();
  const asked = await page.evaluate(() => ({ kind: window.emu.session.media.kind, shown: !document.getElementById('libReconnect').hidden, text: document.getElementById('libReconnectText').textContent,
    status: document.getElementById('toast').textContent }));
  check('storage: a folder whose permission is asked again: kept in the browser meanwhile, and the Library offers to reconnect it', asked.kind === 'opfs' && asked.shown
    && /^Your library is in the folder “my-folder”, and the browser wants your permission again/.test(asked.text), JSON.stringify(asked));
  if (shotDir) await page.locator('#libStorage').screenshot({ path: path.join(shotDir, 'library-reconnect-desktop.png') });
  // something added while the folder waits for permission is kept in the browser, and must reach the folder
  await page.evaluate(() => window.emu.session.importMedia('WHILE.BIN', new Uint8Array([0x55, 2, 0x30, 0, 0, 1, 0x30, 0, 0xAA, 0x39])));
  await page.click('#btnLibReconnect');
  await settled(/^Your library is back in the folder/);
  const inFolder = await page.evaluate(async () => {
    const d = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('my-folder')).getDirectoryHandle('library');
    return !!(await d.getFileHandle('WHILE.BIN').catch(() => null));
  });
  check('storage: Reconnect uses the folder again, with its own library and what this visit added in the browser', /library\/NEW\.BIN/.test(await names())
    && /library\/WHILE\.BIN/.test(await names()) && inFolder && await page.isHidden('#libReconnect')
    && await msg() === 'Your library is back in the folder “my-folder”.', `${await names()} ${inFolder} ${await msg()}`);
  await page.reload(); await ready(page); await openLib();
  await page.click('#btnLibStayHere');
  await page.evaluate(() => localStorage.removeItem('test.forgetPermission'));
  await page.reload(); await ready(page);
  check('storage: "Keep it in this browser" makes this browser the choice (no reconnect offer after a reload)', await kind() === 'opfs' && await page.isHidden('#libReconnect'), await kind());
  // download and open: nothing kept by the browser, said so, and the choice remembered
  await openLib();
  await page.click('#libStorageChoices .choice[data-storage="fallback"]');
  await settled(/^Your library is now kept for this visit only/);
  const fb = await page.evaluate(() => document.getElementById('libWhere').textContent);
  await page.reload(); await ready(page);
  check('storage: "Download and open files" is used, explained, and remembered', await kind() === 'fallback' && /^Nothing is kept by the browser/.test(fb), fb);
  await openLib();
  await page.click('#libStorageChoices .choice[data-storage="opfs"]');
  await settled(/^Your library is now kept inside this browser/);
  check('storage: back to this browser, the library it kept is there', /library\/HELLO\.BIN/.test(await names()), await names());
  check('library storage: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });

  // a browser without folder access (no showDirectoryPicker): that choice is offered greyed out with the reason; phone width
  const browser = await chromium.launch();
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx2.addInitScript(() => { delete window.showDirectoryPicker; });
  const p2 = await ctx2.newPage();
  await p2.goto(`${base}?machine=dragon64#library`); await ready(p2);
  const no = await p2.evaluate(() => { const b = document.querySelector('#libStorageChoices .choice[data-storage="fsa"]'); return { disabled: b.disabled, text: b.textContent, fits: document.documentElement.scrollWidth <= innerWidth }; });
  check('storage: without folder access the folder choice is greyed out and says why; fits a phone', no.disabled && /can't open a folder for CLOADM \(Chrome and Edge can\)/.test(no.text) && no.fits, JSON.stringify(no));
  if (shotDir) await p2.locator('#libStorage').screenshot({ path: path.join(shotDir, 'library-storage-phone.png') });
  await browser.close();
}

// A quieter first visit: one call to add ROMs outside the emulated screen (the header's "No BASIC · Add ROMs"; the welcome
// card no longer repeats it), one key legend at a time (over the screen until the one-time hint is done, then the
// line under the slots), and no quick-save slots while the welcome program is all that has run.
async function firstVisitChecks(browser, base, check) {
  for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await waitFor(page, () => window.emu && window.emu.session.welcomeRunning && !document.getElementById('welcome').hidden && !document.getElementById('keyHint').hidden);
    const seen = () => page.evaluate(() => {
      const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
      // the calls to add ROMs outside the screen: the header pill and anything in the welcome card that offers ROMs
      const calls = [document.getElementById('romPill'), ...[...document.querySelectorAll('#welcome button')].filter((x) => /ROM/.test(x.textContent))];
      return { romCalls: calls.filter(shown).map((x) => x.id || x.textContent),
        legends: [['keyHint', document.getElementById('keyHint')], ['hint', document.querySelector('.layout .hint')]].filter(([, el]) => shown(el)).map(([n]) => n),
        sound: shown(document.getElementById('soundHint')), quickSave: shown(document.getElementById('quickSave')) };
    });
    const first = await seen();
    // the line under the screen holds one note at a time: "click for sound" first, so no key legend yet; sound starts on the
    // first click, and the key hint takes the line
    check(`first visit (${label}): one call to add ROMs outside the screen, the sound note on the line under the screen (no key legend yet), no quick-save slots yet`,
      JSON.stringify(first.romCalls) === '["romPill"]' && JSON.stringify(first.legends) === '[]' && first.sound && !first.quickSave, JSON.stringify(first));
    await page.mouse.click(5, 5);
    await waitFor(page, () => document.getElementById('soundHint').hidden, null, 5000);
    const unlocked = await seen();
    check(`first visit (${label}): once sound has started, one key legend (the hint under the screen)`, JSON.stringify(unlocked.legends) === '["keyHint"]' && !unlocked.sound, JSON.stringify(unlocked));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `first-visit-${label}.png`) });
    if (label === 'phone') {
      // the welcome program's file arriving after the slots were first listed (a slow network or a busy machine): the
      // start of the welcome program hides them again (it was shown and stayed shown, about 1 run in 5 under load)
      const late = await browser.newContext({ viewport });
      await late.route('**/examples/**', async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
      const lp = await late.newPage();
      await lp.goto(base);
      await waitFor(lp, () => window.emu && window.emu.session.welcomeRunning && !document.getElementById('welcome').hidden);
      const qs = await lp.evaluate(() => { const el = document.getElementById('quickSave'); return el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none'; });
      check('first visit, the welcome program arriving late: no quick-save slots yet', !qs, `quick-save shown: ${qs}`);
      await late.close();
    }
    if (label === 'desktop') {
      // the card dismissed: the header pill takes over; Esc ends the one-time hint: the line under the slots shows
      await page.click('#welcome .close');
      await page.focus('#screen'); await page.keyboard.press('Escape');
      const after = await seen();
      check('first visit: dismissed, still the one call to add ROMs; after Esc the key line under the slots shows instead of the hint',
        JSON.stringify(after.romCalls) === '["romPill"]' && JSON.stringify(after.legends) === '["hint"]', JSON.stringify(after));
      // something to save: LIZA from the Media tab's shelf
      await page.click('#shelf button:text-is("LIZA")');
      check('first visit: quick save appears once something else runs (LIZA)', await waitFor(page, () => {
        const q = document.getElementById('quickSave'); return q.getClientRects().length > 0 && document.querySelectorAll('#slotList .slot-row').length === 3;
      }));
    }
    check(`first visit (${label}): no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }
}

// The Library's type-in screen is drawn at a whole number of device pixels per frame pixel (with
// a fractional scale, nearest-neighbour pixels drew some strokes of the text thicker than others), unless that
// leaves it under 70% of the card's width (review: a phone at 2× got half the card), when it fills the card.
// Measured as the canvas's displayed size times devicePixelRatio over the frame's size, on a Dragon (320x240
// frame) and a CoCo 3 (640x240), at several device scale factors, on a desktop and a phone, and after a resize.
async function typeinScreenChecks(browser, base, check) {
  const measure = (page) => page.evaluate(() => {
    const c = document.getElementById('typeinScreen'), r = c.getBoundingClientRect(), f = window.emu.machine.render(), dpr = devicePixelRatio;
    return { sx: r.width * dpr / f.width, sy: r.height * dpr / f.height, css: [r.width, r.height], room: c.parentElement.clientWidth, frame: [f.width, f.height] };
  });
  const whole = (v) => v >= 1 - 1e-6 && Math.abs(v - Math.round(v)) < 0.01;   // CSS lengths are kept to 1/64 px
  const ok = (m, mode) => (mode === 'whole' ? whole(m.sx) && whole(m.sy) && m.css[0] >= 0.7 * m.room - 0.5 && m.css[0] <= m.room + 0.5
    : Math.abs(m.css[0] - m.room) <= 1 && Math.abs(m.css[1] - m.css[0] * 0.75) <= 1);
  const desktop = { width: 1440, height: 900 }, phone = { width: 390, height: 844 };
  for (const [label, viewport, dsf, machine, mode] of [['desktop', desktop, 1, 'dragon64', 'whole'], ['desktop', desktop, 2, 'dragon64', 'whole'],
    ['desktop', desktop, 1.5, 'dragon64', 'whole'], ['desktop', desktop, 2, 'coco3', 'whole'],
    ['phone', phone, 3, 'dragon64', 'fill'], ['phone', phone, 2, 'dragon64', 'fill'], ['phone', phone, 1, 'dragon64', 'fill']]) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: dsf });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?machine=${machine}#library`); await ready(page);
    await waitFor(page, () => document.getElementById('typeinScreen').style.width !== '');
    const m = await measure(page);
    check(`type-in screen (${label}, ${machine}, ×${dsf}): ${mode === 'whole' ? 'a whole number of device pixels per frame pixel, at least 70% of the card' : 'fills the card (a whole number would leave it under 70%)'}`,
      ok(m, mode) && !errors.length, JSON.stringify(m));
    if (shotDir && machine === 'dragon64' && (dsf === 2 || label === 'phone')) await page.locator('#typeinScreen').screenshot({ path: path.join(shotDir, `typein-screen-x${dsf}-${label}.png`) });
    if (label === 'desktop' && dsf === 2 && machine === 'dragon64') {
      await page.setViewportSize({ width: 600, height: 900 });
      await waitFor(page, (w) => document.getElementById('typeinScreen').getBoundingClientRect().width !== w, m.css[0]);
      const after = await measure(page);
      check('type-in screen: re-sized to whole device pixels when the window narrows', ok(after, 'whole'), JSON.stringify(after));
    }
    await ctx.close();
  }
}

// The Glossary: one name for each thing on every page. The
// visible text of every page, and of /play/ in each of its views and tabs, may not use a retired word. Proper names
// that contain one keep it (the Color Computer Archive, Color Computer Magazine, the Multi-Pak Interface), and a
// page may give a machine's full name once as "Tandy Color Computer 3 (CoCo 3)". The emulated screen and the drawings
// of the machines (their real nameplates) are pictures, not page text, and are not checked.
const RETIRED = [
  [/built-in stub|stub firmware|no-ROM mode|no-ROM shelf/i, 'without ROMs'],
  [/Manage ROMs|Check the sockets|Add or check your ROMs|Add your ROMs to get BASIC/i, 'Add ROMs'],
  [/\bsockets?\b|ROMs card/i, 'Your ROMs, or the ROM by name (BASIC, Extended BASIC…)'],
  // the files are ROMs; "dump" stays as the verb (reading a machine's ROMs out), the noun is retired
  [/known[- ]good dump|verified good dump|CRC verified|\bdumps\b|\bROM dump\b|\ba (bad |known |known-good )?dump\b|ROM images?/i, 'ROMs / Recognised'],
  [/welcome program|start screen/i, 'Welcome menu'],
  [/\bmount(ed|s)?\b/i, 'insert'],
  [/save state|quick[- ]save|quick slots|Keep this moment/i, 'Snapshot 1–3, Take snapshot'],
  [/\bSlot [1-3]\b|\b(to|Load) slot [1-3]\b/, 'Snapshot 1–3 (the Multi-Pak\'s own slots keep their name)'],
  [/Capture (&|and) share|share this moment|\bmoments?\b/i, 'Share, snapshot'],
  [/ROM bundle/i, 'ROM pack'],
  [/\bD(32|64|200)\b/, 'Dragon 32, Dragon 64…'],
  [/Tandy Color Computer(?! 3 \(CoCo 3\))|Color Computer (1\/2|2B|3)|Micro Color Computer|Tandy MC-10/, 'CoCo 1/2, CoCo 2B, CoCo 3, MC-10'],
  [/Power cycle|hard reset|soft reset/i, 'Switch off and on, Reset'],
  [/\bfast mode\b/i, 'Turbo'],
  [/SAM rate|CPU rate/, 'CPU speed'],
  [/\bthe Bench\b/i, 'Debugger'],
];
async function glossaryChecks(browser, site, check) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.dismiss());
  // the visible text (code samples aside), every visible control's title and aria-label, and the options of
  // visible menus
  const words = () => page.evaluate(() => {
    const out = [], w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const e = n.parentElement;
      if (e && !e.closest('pre, code, script, style, option, svg') && e.checkVisibility()) out.push(n.textContent.replace(/\s+/g, ' '));
    }
    for (const e of document.querySelectorAll('button, a, [role="tab"], label, input, select')) {
      if (!e.checkVisibility()) continue;
      out.push([e.title, e.getAttribute('aria-label')].filter(Boolean).join(' | '));
      if (e.tagName === 'SELECT') out.push(...[...e.options].map((o) => o.textContent));
    }
    return out.join('\n');
  });
  const found = [];
  const scan = async (where) => {
    const text = (await words()).replace(/Color Computer (Archive|Magazine)|Multi-Pak/g, '');
    for (const [re, say] of RETIRED) {
      const g = new RegExp(re.source, re.flags.includes('i') ? 'gi' : 'g');
      for (const m of text.matchAll(g)) {
        const at = `"${text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, ' ')}" (say: ${say})`;
        if (!found.some((f) => f.endsWith(at))) found.push(`${where}: ${at}`);
      }
    }
    // a lone "Insert…" says nothing about what goes in (Glossary: Insert tape…, Insert disk…, Insert cartridge…)
    for (const t of await page.$$eval('button', (b) => b.filter((e) => e.getClientRects().length).map((e) => e.textContent.trim()))) {
      if (/^(\d · )?Insert…$/.test(t) && !found.some((f) => f.endsWith(`a button "${t}"`))) found.push(`${where}: a button "${t}"`);
    }
  };
  for (const at of ['', 'help/', 'roms/', 'credits/']) { await page.goto(site + at); await scan(`/${at}`); }
  await page.goto(`${site}play/`);
  await waitFor(page, () => window.emu && window.emu.started);
  await scan('/play/ first visit');
  for (const tab of ['Display', 'Input', 'POKEs', 'Machine', 'Media']) { await openTab(page, tab); await scan(`/play/ ${tab} tab`); }
  await page.evaluate(() => { location.hash = '#add-roms'; });
  await waitFor(page, () => !document.getElementById('romCard').hidden);
  await scan('/play/ Add ROMs');
  await page.evaluate(() => { location.hash = '#library'; });
  await waitFor(page, () => !document.getElementById('library').hidden);
  await scan('/play/ Library');
  await page.evaluate(() => { location.hash = ''; });
  await page.click('#btnShare');
  await waitFor(page, () => location.hash === '#share' && !document.getElementById('share').hidden);
  await scan('/play/ Share');
  await page.click('#shareBack');
  await waitFor(page, () => document.getElementById('share').hidden);
  // Claude: the chat full screen (from the welcome menu, where "Ask Claude" opens it), then the Ask panel beside the
  // live machine (from the stub's prompt), each with its key form (no key in this browser)
  await page.click('#btnAsk');
  await waitFor(page, () => window.emu.session.claudeView === 'full');
  await scan('/play/ Claude chat, full screen');
  await page.click('#btnClaudeBack');
  await waitFor(page, () => window.emu.session.claudeView !== 'full');
  await stubPrompt(page);
  await page.click('#btnAsk');
  await waitFor(page, () => !document.getElementById('ask').hidden);
  await scan('/play/ Ask Claude panel');
  await page.click('#btnAsk');
  await waitFor(page, () => document.getElementById('ask').hidden);
  // the status line after a machine option changes (it switches the machine off and on)
  await page.evaluate(() => window.emu.session.switchMachine('coco'));
  await openTab(page, 'Machine');
  await page.selectOption('#ramSel', '16');
  await waitFor(page, () => window.emu.machine.config.ram === 16);
  await scan('/play/ after a RAM change');
  // with ROMs (synthetic) and a disk ROM: the drives offer disks, the sockets have files
  await page.evaluate(() => { const s = window.emu.session, f = (n, k) => new Uint8Array(k).fill(n);
    s.addRoms([{ name: 'bas13.rom', bytes: f(0x12, 0x2000) }, { name: 'extbas11.rom', bytes: f(0x13, 0x2000) }]); s.roms.put('rsdos', 'rom', f(0x39, 0x2000), 'disk11.rom'); s.switchMachine('coco'); });
  await scan('/play/ CoCo 1/2 with ROMs');
  await page.evaluate(() => { location.hash = '#add-roms'; });
  await waitFor(page, () => !document.getElementById('romCard').hidden);
  await scan('/play/ Add ROMs with ROMs');
  check('glossary: no retired word on any page or view', !found.length && !errors.length, `\n  ${[...new Set(found)].join('\n  ')}${errors.length ? `\n  errors: ${errors.join('; ')}` : ''}`);
  await ctx.close();
}


// Every page says what /play/ does today:
// nothing on the landing page is marked "coming" but the Claude chat (the drives, the tape's real-speed switch, the
// Library and the type-ins are in /play/ and checked elsewhere in this run; the chat ships in this release too, so
// its "coming" tags may go: none is fine); Help doesn't call the disk drives unemulated and says what a disk needs.
// Welcome key 4 opens the chat (checked in the welcome and Claude checks).
async function stateChecks(browser, site, check) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(site);
  const coming = await page.$$eval('.coming', (els) => els.map((e) => e.parentElement.textContent.replace(/\s+/g, ' ').trim()));
  check('state: the landing page marks nothing as coming but the Claude chat (if anything)', coming.every((t) => /Claude/.test(t)), JSON.stringify(coming));
  const landing = await page.evaluate(() => document.body.textContent.replace(/\s+/g, ' '));
  check('state: the landing page says the drives, the Library and the type-ins are there', /Four drives, real disks DragonDOS/.test(landing)
    && /A library and magazine type-ins are in it/.test(landing), landing.match(/Checked against MAME instruction by instruction[^.]*\.[^.]*\./)?.[0]);
  await page.goto(`${site}help/`);
  const help = await page.evaluate(() => document.body.textContent.replace(/\s+/g, ' '));
  check('state: Help doesn\'t call the drives unemulated, and says what a disk needs', !/aren't emulated|not emulated/i.test(help)
    && /Disk shows nothing\. A disk needs the machine's disk ROM/.test(help), help.match(/Disk shows nothing\.[^.]*\./)?.[0]);
  check('state: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

// One header per screen, the same links on every reading page, and deep links that land: the Library and Add ROMs views replace the app bar
// with their own "← Emulator" bar; Help, ROMs and Credits all
// have "← Emulator", their title, and Home · Help · ROMs · Credits · Report a problem (without the page itself);
// Help's "Add ROMs →" opens Add ROMs.
async function navChecks(browser, site, check) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const bars = () => page.evaluate(() => {
    const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
    return { appbar: shown(document.getElementById('appbar')), lib: shown(document.querySelector('#library .libhead')), roms: shown(document.querySelector('#romCard .libhead')) };
  });
  await page.goto(`${site}play/?machine=dragon64#library`); await ready(page);
  const lib = await bars();
  await page.click('#btnLibBack');
  const back = await bars();
  await page.evaluate(() => { location.hash = '#add-roms'; });
  await waitFor(page, () => !document.getElementById('romCard').hidden);
  const roms = await bars();
  check('nav: the Library and Add ROMs have one header each (their own "← Emulator" bar, no app bar); the app bar is back on the emulator',
    !lib.appbar && lib.lib && !roms.appbar && roms.roms && back.appbar, JSON.stringify({ lib, roms, back }));
  const ALL = [['Home', '/'], ['Help', '/help/'], ['ROMs', '/roms/'], ['Credits', '/credits/'], ['Report a problem', 'https://github.com/yaniv-golan/cloadm/issues']];
  for (const [title, at] of [['HELP', 'help/'], ['ROMS', 'roms/'], ['CREDITS', 'credits/']]) {
    await page.goto(site + at);
    const head = await page.evaluate(() => {
      const h = document.querySelector('header.page-head');
      return { back: [h.querySelector('a.back').textContent, new URL(h.querySelector('a.back').href).pathname], title: h.querySelector('.title').textContent,
        links: [...h.querySelectorAll('a:not(.back)')].map((a) => [a.textContent, a.href.startsWith(location.origin) ? new URL(a.href).pathname : a.href]) };
    });
    const want = ALL.filter(([, href]) => href !== `/${at}`);
    check(`nav: ${at} has "← Emulator", its title and the same links as the other reading pages`, head.back[0] === '← Emulator' && head.back[1] === '/play/'
      && head.title === title && JSON.stringify(head.links) === JSON.stringify(want), JSON.stringify(head));
  }
  await page.goto(`${site}help/`);
  await page.click('text=Add ROMs →');
  check('nav: Help\'s "Add ROMs →" opens Add ROMs', await waitFor(page, () => !!window.emu && location.hash === '#add-roms' && !document.getElementById('romCard').hidden),
    page.url());
  check('nav: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

// the command box (Ctrl/Cmd+K) lists every command, grouped, when nothing is typed; its other doors; the Help page; the Ask hint
async function commandsChecks(browser, site, check) {
  // R14's labels and order, written out here rather than read from COMMANDS (the page's own list is checked against them)
  const WANT = [
    ['Claude', ['Chat with Claude, full screen', 'What is this code doing?']],
    ['Files', ['Take snapshot', 'Open a program, tape, disk or cartridge…', 'Save the tape as .WAV', 'Record to tape', 'Share']],
    ['Views', ['Open the Library', 'Open the Debugger']],
    ['Settings', ['Display settings', 'Input settings', 'POKEs', 'Machine settings']],
    ['Machine', ['Pause or resume', 'Turbo', 'Fullscreen', 'Reset', 'Switch off and on']],
  ];
  const LABELS = WANT.flatMap(([, l]) => l);
  const CLAUDE_NOTE = "Claude reads this emulated machine's screen text and memory, and acts on it only with your permission.";
  const FOOT = 'Type to filter, or type a question for Claude. Commands run here and are never sent to Claude.';
  const errors = [];
  const open = async (opts, init) => {
    const ctx = await browser.newContext({ serviceWorkers: 'block', ...opts });
    // a key saved, so the Ask panel shows its empty state (with no key it shows the key form)
    await ctx.addInitScript(() => { try { localStorage.setItem('cloadm.anthropicKey', 'sk-ant-COMMANDS-CHECK-KEY-0123456789'); } catch (e) { /* none */ } });
    if (init) await ctx.addInitScript(init);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${site}play/?machine=dragon64`);
    await started(page);
    await stubPrompt(page);   // the live machine, not the welcome menu (with the menu on screen Ask Claude opens full screen)
    return { ctx, page };
  };
  const box = (page) => page.evaluate(() => {
    const b = document.getElementById('cmdBox'), l = document.getElementById('cmdList');
    return { open: !b.hidden, sel: [...l.querySelectorAll('[role="option"][aria-selected="true"]')].map((o) => o.firstChild.textContent),
      active: document.getElementById('cmdInput').getAttribute('aria-activedescendant') };
  });
  for (const [label, viewport] of [['1280x720', { width: 1280, height: 720 }], ['phone', { width: 390, height: 844 }]]) {
    const L = `commands (${label})`;
    const { ctx, page } = await open({ viewport });
    if (label === 'phone') { await page.click('#btnMenu'); await page.click('#navCommands'); } else await page.keyboard.press('Control+k');
    await waitFor(page, () => !document.getElementById('cmdBox').hidden);
    const r = await page.evaluate(() => {
      const l = document.getElementById('cmdList');
      return { groups: [...l.querySelectorAll('[role="group"]')].map((g) => ({ name: g.getAttribute('aria-labelledby') && document.getElementById(g.getAttribute('aria-labelledby')).textContent,
          rows: [...g.querySelectorAll('[role="option"]')].map((o) => o.firstChild.textContent), note: !!g.querySelector('.cmdnote') && g.querySelector('.cmdnote').textContent })),
        stray: [...l.children].filter((c) => c.getAttribute('role') !== 'group').length, foot: (() => { const f = document.querySelector('#cmdBox [role="note"]'); return f && f.textContent; })(),
        input: document.getElementById('cmdInput').value };
    });
    check(`${L}: the empty box lists every command, grouped, in R14's order (Reset and Switch off and on last)`,
      JSON.stringify(r.groups.map((g) => [g.name, g.rows])) === JSON.stringify(WANT) && r.stray === 0 && r.input === '', JSON.stringify(r.groups));
    check(`${L}: the Claude group says what Claude reads; the footer is a note`, r.groups[0].note === CLAUDE_NOTE && r.groups.slice(1).every((g) => !g.note) && r.foot === FOOT, JSON.stringify([r.groups[0].note, r.foot]));
    const b0 = await box(page), paused = await page.evaluate(() => window.emu.session.paused);
    await page.keyboard.press('Enter');
    const b1 = await box(page);
    check(`${L}: no row is selected, and Enter on the empty query does nothing`, b0.sel.length === 0 && b0.active === '' && b1.open && b1.sel.length === 0
      && await page.evaluate(() => window.emu.session.paused) === paused && await page.isHidden('#ask') && await page.evaluate(() => window.emu.session.claudeView !== 'full'), JSON.stringify([b0, b1]));
    await page.keyboard.press('ArrowDown');
    const first = await box(page);
    check(`${L}: the first ↓ selects the first row`, first.sel.length === 1 && first.sel[0] === LABELS[0] && first.active === 'cmdOpt0', JSON.stringify(first));
    const dim = await page.evaluate(() => { const l = document.getElementById('cmdList'), b = document.getElementById('cmdBox').getBoundingClientRect(), lr = l.getBoundingClientRect();
      return { overflow: getComputedStyle(l).overflowY, scroll: l.scrollHeight, client: l.clientHeight, boxBottom: b.bottom, listBottom: lr.bottom, vh: innerHeight }; });
    check(`${L}: the list is bounded to the viewport and scrolls`, dim.overflow === 'auto' && dim.scroll > dim.client && dim.boxBottom <= dim.vh && dim.listBottom <= dim.vh, JSON.stringify(dim));
    for (let i = 1; i < LABELS.length; i++) await page.keyboard.press('ArrowDown');
    const end = await page.evaluate(() => { const l = document.getElementById('cmdList'), lr = l.getBoundingClientRect(), o = document.querySelector('#cmdList [role="option"][aria-selected="true"]'), r = o.getBoundingClientRect();
      return { text: o.firstChild.textContent, top: r.top, bottom: r.bottom, lTop: lr.top, lBottom: lr.bottom, scrolled: l.scrollTop }; });
    check(`${L}: ↓ to the last row scrolls it into view`, end.text === 'Switch off and on' && end.scrolled > 0 && end.top >= end.lTop - 1 && end.bottom <= end.lBottom + 1, JSON.stringify(end));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `commands-${label}.png`) });
    await page.keyboard.press('Escape');
    // typing still filters, the first match selected and "Ask Claude" last
    await page.keyboard.press('Control+k');
    await page.keyboard.type('turbo');
    const typed = await page.evaluate(() => [...document.querySelectorAll('#cmdList [role="option"]')].map((o) => [o.firstChild.textContent, o.getAttribute('aria-selected')]));
    check(`${L}: typing filters the list, selects the first match and puts "Ask Claude" last`, typed[0][0] === 'Turbo' && typed[0][1] === 'true' && /^Ask Claude: "turbo"/.test(typed[typed.length - 1][0]), JSON.stringify(typed));
    await ctx.close();
  }
  // the app bar's "Commands…": desktop, a Mac, a phone behind Menu, and the touch keys' Menu
  {
    const { ctx, page } = await open({ viewport: { width: 1280, height: 720 } });
    // (whether the key hint shows depends on the fonts: the bar's "tight" mode hides it when the links would run past the bar)
    const nav = await page.evaluate(() => { const b = document.getElementById('navCommands'), k = document.getElementById('navCmdKbd');
      return { text: b.textContent.replace(/\s+/g, ' ').trim(), shown: b.getClientRects().length > 0, inNav: !!b.closest('.appbar nav'),
        tight: document.getElementById('appbar').classList.contains('tight'), kbdShown: k.getClientRects().length > 0 }; });
    await page.click('#navCommands');
    check('commands (desktop): the app bar has "Commands… Ctrl K" (the key shown unless the bar is tight); it opens the box, focused', nav.text === 'Commands… Ctrl K' && nav.shown && nav.inNav && nav.kbdShown === !nav.tight
      && await waitFor(page, () => !document.getElementById('cmdBox').hidden && document.activeElement === document.getElementById('cmdInput')), JSON.stringify(nav));
    await page.keyboard.press('Escape');
    await page.click('#btnAsk');
    await waitFor(page, () => !document.getElementById('ask').hidden && document.getElementById('askEmpty').getClientRects().length > 0);
    const ask = await page.evaluate(() => { const e = document.getElementById('askEmptyCmd'); return { shown: e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none', text: e.innerText.trim(), emptyShown: !document.getElementById('askEmpty').hidden }; });
    check('commands (desktop): the Ask panel\'s empty state says "Ctrl K: find a command or ask"', ask.emptyShown && ask.shown && ask.text === 'Ctrl K: find a command or ask', JSON.stringify(ask));
    await ctx.close();
  }
  // tight mode hides the RAM size: the machine button's title and aria-label still name the machine and its RAM
  {
    const { ctx, page } = await open({ viewport: { width: 1280, height: 720 } });
    const read = () => page.evaluate(() => { const b = document.getElementById('machineBtn'), sp = document.getElementById('machineSpec');
      return { title: b.title, aria: b.getAttribute('aria-label'), want: `${document.getElementById('machineName').textContent} ${sp.textContent}`.trim(),
        tight: document.getElementById('appbar').classList.contains('tight'), specShown: sp.getClientRects().length > 0 }; });
    const plain = await read();
    await page.addStyleTag({ content: 'body, button, a, input, select { font-family: "DejaVu Sans", Verdana, sans-serif !important; }' });
    await waitFor(page, () => document.getElementById('appbar').classList.contains('tight'));
    const tight = await read();
    check('commands (app bar): the machine button\'s title and aria-label are "<name> <ram>K" (e.g. "Dragon 64 64K"), also in tight mode where the RAM size is hidden',
      plain.title === plain.want && plain.aria === plain.want && /\d+K$/.test(plain.want)
      && tight.tight && !tight.specShown && tight.title === tight.want && tight.aria === tight.want, JSON.stringify({ plain, tight }));
    await ctx.close();
  }
  {
    const { ctx, page } = await open({ viewport: { width: 1280, height: 720 } }, () => Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }));
    const mac = await page.evaluate(() => [document.getElementById('navCommands').textContent.replace(/\s+/g, ' ').trim(), document.getElementById('askKbd').textContent, document.getElementById('askEmptyKbd').textContent]);
    check('commands (Mac): ⌘K in the app bar, the Ask button and the empty state', JSON.stringify(mac) === JSON.stringify(['Commands… ⌘K', '⌘K', '⌘K']), JSON.stringify(mac));
    await ctx.close();
  }
  {
    const { ctx, page } = await open({ viewport: { width: 390, height: 844 } });
    const before = await page.evaluate(() => document.getElementById('navCommands').getClientRects().length === 0);
    await page.click('#btnMenu');
    const nav = await page.evaluate(() => { const b = document.getElementById('navCommands'); return { text: b.innerText.replace(/\s+/g, ' ').trim(), shown: b.getClientRects().length > 0 }; });
    await page.click('#navCommands');
    check('commands (phone): "Commands…" (no key) sits behind Menu and opens the box, focused; the menu closes',
      before && nav.shown && nav.text === 'Commands…' && await waitFor(page, () => !document.getElementById('cmdBox').hidden && document.activeElement === document.getElementById('cmdInput')
        && !document.getElementById('appbar').classList.contains('menu-open')), JSON.stringify(nav));
    await page.keyboard.press('Escape');
    await page.click('#btnAsk');
    await waitFor(page, () => !document.getElementById('ask').hidden && document.getElementById('askEmpty').getClientRects().length > 0);
    const ask = await page.evaluate(() => { const e = document.getElementById('askEmptyCmd'); return { shown: e.getClientRects().length > 0, emptyShown: !document.getElementById('askEmpty').hidden }; });
    check('commands (phone): the Ask empty-state key hint is hidden on a narrow screen', ask.emptyShown && !ask.shown, JSON.stringify(ask));
    await ctx.close();
  }
  {
    const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await waitFor(page, () => !document.getElementById('touchKeys').hidden && document.body.classList.contains('touch-keys'));
    await page.tap('#tkMenu');
    const item = await page.evaluate(() => { const b = document.querySelector('#tkMenuSheet [data-item="commands"]'); return b && b.textContent; });
    await page.tap('#tkMenuSheet [data-item="commands"]', { timeout: 3000 }).catch(() => {});   // (a missing item is a FAIL below, not a throw)
    check('commands (touch keys): the keys\' Menu has "Commands…", which opens the box', item === 'Commands…'
      && await waitFor(page, () => !document.getElementById('cmdBox').hidden && document.activeElement === document.getElementById('cmdInput') && document.getElementById('tkMenuSheet').hidden), String(item));
    await ctx.close();
  }
  // Help: every command's label, verbatim, and the two sections
  {
    const { ctx, page } = await open({ viewport: { width: 1280, height: 720 } });
    const labels = await page.evaluate(async () => (await import(new URL('js/ui/command-box.js', document.baseURI))).COMMANDS.map((c) => c[0]));
    await page.goto(`${site}help/`);
    const help = await page.evaluate(() => ({ text: document.body.innerText.replace(/\s+/g, ' '), h2: [...document.querySelectorAll('h2')].map((h) => h.textContent) }));
    const missing = labels.filter((l) => !help.text.includes(l));
    check('commands: every COMMANDS label appears verbatim in Help, and COMMANDS is the R14 set', !missing.length && JSON.stringify(labels.slice().sort()) === JSON.stringify(LABELS.slice().sort()), JSON.stringify({ missing, labels }));
    check('commands: Help has "Commands and shortcuts" and "What Claude can do" with the shortcuts and the permission wording',
      help.h2.includes('Commands and shortcuts') && help.h2.includes('What Claude can do')
      && ['Ctrl B', '= BREAK', '= CLEAR', 'Fn', 'Esc in the full-screen chat:', 'Esc while Claude is paused:', 'Reads (always):', 'Acts (only with your permission):',
        'A restore point is made first.', 'What Claude reads goes to Anthropic with your key.'].every((t) => help.text.includes(t)) && !/Every action is listed in the chat/.test(help.text),
      help.h2.join('|'));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'help-commands.png'), fullPage: true });
    await ctx.close();
  }
  check('commands: no page errors', !errors.length, errors.join('; '));
}

// the landing page at / at desktop and phone width, and its links into /play/
async function landingChecks(browser, site, check) {
  for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const archive = [], foreign = [], errors = [];
    const ctx = await guardedContext(browser, archive);
    const page = await ctx.newPage();
    await page.setViewportSize(viewport);
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && u.host !== new URL(site).host) foreign.push(r.url()); });
    const res = await page.goto(site);
    await page.evaluate(() => document.fonts.ready);
    check(`landing (${label}): served at /`, res.ok() && await page.title() === 'CLOADM' && /Still says OK after forty years\./.test(await page.textContent('h1')));
    check(`landing (${label}): no sideways scrolling`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), String(await page.evaluate(() => document.documentElement.scrollWidth)));
    check(`landing (${label}): the hero screen is the emulator's own picture, loaded`, await page.evaluate(() => { const i = document.querySelector('img[src="img/welcome.png"]'); return !!i && i.complete && i.naturalWidth === 320; }));
    // the Claude chat ships: the landing page links it and marks nothing as coming (drives, real-speed tape, Library and
    // type-ins are in /play/: stateChecks)
    // ROMs are easy to find: a Get ROMs button beside the main call to action, and a line naming the archive and
    // the files the main machines take; both visible without scrolling past the hero
    check(`landing (${label}): "Get ROMs" beside the call to action, and the ROM line with the archive and the file names`, await page.evaluate(() => {
      const b = document.getElementById('getRoms'), line = document.getElementById('romFiles'), a = document.getElementById('archiveRomsLanding');
      const shown = (e) => !!e && e.offsetParent !== null && e.getBoundingClientRect().width > 0;
      return shown(b) && b.getAttribute('href') === 'roms/' && b.textContent.trim() === 'Get ROMs' && b.parentElement.contains(document.getElementById('tryIt'))
        && shown(line) && shown(a) && /d32\.rom/.test(line.textContent) && /coco3\.rom/.test(line.textContent) && /mc10\.rom/.test(line.textContent);
    }));
    check(`landing (${label}): a link opens the Claude chat, and nothing is tagged "coming"`,
      await page.$$eval('a[href="play/?app=claude"]', (a) => a.length === 1 && a[0].offsetParent !== null && /Chat with Claude/.test(a[0].textContent))
      && await page.$$eval('.coming', (c) => c.length === 0));
    check(`landing (${label}): the hero picture is smooth when scaled below 1x, pixelated otherwise`, await page.evaluate(() => {
      const i = document.querySelector('.hero-screen'), r = getComputedStyle(i).imageRendering;
      return i.getBoundingClientRect().width < i.naturalWidth ? r === 'auto' : r === 'pixelated';
    }));
    check(`landing (${label}): headings in Archivo, eyebrows in JetBrains Mono`, await page.evaluate(() => /^Archivo/.test(getComputedStyle(document.querySelector('h1')).fontFamily)
      && [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'JetBrains Mono' && f.status === 'loaded')));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `landing-${label}.png`), fullPage: true });
    if (label === 'desktop') {
      // every link on the page: same-site ones resolve; the archive's ROM folder is linked once, from the ROM line
      const links = await page.$$eval('a[href]', (a) => a.map((x) => x.href));
      const local = [...new Set(links.filter((h) => h.startsWith(site)).map((h) => h.split('#')[0]))];
      const broken = [];
      for (const h of local) { const r = await page.request.get(h); if (!r.ok()) broken.push(`${h} ${r.status()}`); }
      check('landing: every same-site link resolves', local.length >= 8 && !broken.length, broken.join(' '));
      check('landing: links the archive\'s ROM folder once, as a plain link in the ROM line', links.filter((h) => /colorcomputerarchive\.com\/repo\/ROMs/i.test(h)).length === 1
        && await page.getAttribute('#archiveRomsLanding', 'href') === 'https://colorcomputerarchive.com/repo/ROMs/XRoar/' && /noreferrer/.test(await page.getAttribute('#archiveRomsLanding', 'rel')));
      check('landing: links GitHub from the header and the footer', await page.$('nav a[href="https://github.com/yaniv-golan/cloadm"]') !== null && await page.$('footer a[href="https://github.com/yaniv-golan/cloadm"]') !== null);
      check('landing: every anchor target exists', await page.evaluate(() => [...document.querySelectorAll('a[href^="#"]')].every((a) => document.getElementById(a.getAttribute('href').slice(1)))));
    }
    check(`landing (${label}): nothing from other hosts, no page errors`, !foreign.length && !archive.length && !errors.length, foreign.concat(errors).join(' '));
    // "Try it now": the emulator with the welcome program running
    await page.click('#tryIt');
    check(`landing (${label}): "Try it now" opens /play/ with the welcome program`, await waitFor(page, () => window.emu && window.emu.session.welcomeRunning && window.emu.session.screenText()[14].includes('PRESS 1 TO 4'))
      && new URL(page.url()).pathname === '/play/');
    if (label === 'desktop') {
      await page.goto(site);
      await page.click('a[data-machine="coco3"]');
      check('landing: a machine card opens the emulator on that machine', await waitFor(page, () => window.emu && window.emu.machine.id === 'coco3'));
      await page.goto(site);
      await page.click('a[href="play/?start=liza"]');
      check('landing: "Talk to LIZA" opens the emulator running LIZA', await waitFor(page, () => window.emu && window.emu.session.screenText().join('').includes('I AM LIZA')));
      const r = await page.request.get(`${site}play`, { maxRedirects: 0 });
      check('/play redirects to /play/', r.status() === 301 && r.headers().location === '/play/');
    }
    await ctx.close();
  }
}

// The debugger through the real page and the Session, with no new screen: assemble a
// program, set a breakpoint on a symbol, run to it through the Session, check the machine stopped on the
// right instruction, step once, check the trace and the disassembly (with the assembler's symbol), set a
// watchpoint on a store the program makes, and check the stop and the value. Also that the page's frame loop
// leaves a stopped machine alone, and that the snapshot keeps the breakpoints.
async function debuggerChecks(browser, base, check) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?machine=dragon64`); await started(page);
  // a program with a loop, a store and a subroutine, run through the assembler panel's own path
  const SRC = ` ORG $3000
START   LDA     #$00
        STA     $4000
LOOP    INCA
        CMPA    #$03
        BNE     LOOP
        LDA     #$11
        BSR     SUB
        STA     $4001
HALT    BRA     HALT
SUB     INCA
        RTS
`;
  await openDebugger(page);
  await page.fill('#asmSource', SRC);
  await page.click('#btnAsmRun');
  // assembled, and run by the page's frame loop to its HALT loop
  await waitFor(page, () => { const s = window.emu.session; return s.labels.get('HALT') != null && s.machine.cpu.pc === s.labels.get('HALT'); });
  // the program's symbols, from what runAssembled was given
  const info = await page.evaluate(() => {
    const s = window.emu.session;
    return { loop: s.labels.get('LOOP'), start: s.labels.get('START'), sub: s.labels.get('SUB'), pc: s.machine.cpu.pc };
  });
  check('debugger: the assembled program shows its symbols to the Session', info.start === 0x3000 && info.loop === 0x3005 && info.sub > info.loop,
    JSON.stringify(info));
  // The page's frame loop has already run the program to its HALT loop by now, so each case below restarts it
  // at START (as a debugger's "run from the beginning" does), then sets its breakpoint and runs.
  const stopped = await page.evaluate(({ loop, start }) => {
    const s = window.emu.session;
    s.machine.cpu.jump(start);
    s.debug.addBreakpoint(loop);
    s.debug.run(50);
    return { stopped: s.debug.stopped, pc: s.debug.pc, reason: s.debug.stopReason, paused: s.paused };
  }, info);
  check('debugger: a breakpoint set through the Session stops the real page\'s machine at LOOP',
    stopped.stopped && stopped.pc === info.loop && stopped.reason.kind === 'breakpoint' && stopped.paused, JSON.stringify(stopped));
  await ticks(page, 20);   // turns of the frame loop, in which it would (wrongly) run the stopped machine on
  const stillStopped = await page.evaluate(() => ({ pc: window.emu.session.debug.pc, paused: window.emu.session.paused }));
  check('debugger: the frame loop leaves the stopped machine where it is', stillStopped.pc === info.loop && stillStopped.paused, JSON.stringify(stillStopped));
  // step once from START: one instruction, and the disassembly names the assembler's symbols
  const step = await page.evaluate((start) => {
    const d = window.emu.session.debug;
    d.clearBreakpoints();
    window.emu.session.machine.cpu.jump(start);
    d.resume();
    const before = d.pc;
    const cycles = d.step();
    const t = d.trace();
    return { before, after: d.pc, cycles, lastTrace: t[t.length - 1], dis: d.disassemble(start, 6).map((i) => i.text) };
  }, info.start);
  check('debugger: a step runs one instruction', step.after > step.before && step.cycles > 0 && step.lastTrace.pc === step.before, JSON.stringify(step));
  check('debugger: the disassembly shows the program with its LOOP symbol', step.dis.some((t) => /LOOP/.test(t)) && step.dis[0] === 'LDA #$00',
    JSON.stringify(step.dis));
  // a watchpoint on the store to $4000: restart, watch the store, run, and stop right after the STA
  const watch = await page.evaluate((start) => {
    const s = window.emu.session, d = s.debug;
    d.clearBreakpoints(); d.clearWatchpoints();
    d.addWatchpoint(0x4000, 1, { write: true, read: false });
    s.machine.cpu.jump(start);
    d.resume();
    d.run(200);
    return { stopped: d.stopped, reason: d.stopReason, pc: d.pc };
  }, info.start);
  check('debugger: a write watchpoint stops the real page after the store', !!(watch.stopped && watch.reason && watch.reason.kind === 'watchpoint'
    && watch.reason.address === 0x4000 && watch.reason.value === 0), JSON.stringify(watch));
  // the snapshot keeps the breakpoints: take one, then restore in a fresh Session and check the breakpoint is back
  const snapped = await page.evaluate(async () => {
    const s = window.emu.session, Emu = window.emu.Emu;
    s.debug.addBreakpoint(0x3005);
    const text = Emu.state.toJSON(s.machine.snapshot());
    const b = Emu.restoreSnapshot(Emu.state.fromJSON(text), s.machine.roms);
    return { bps: b.debugger ? b.debugger.breakpoints() : null };
  });
  check('debugger: a snapshot taken in the page keeps the breakpoints', JSON.stringify(snapped.bps) === '[12293]', JSON.stringify(snapped));
  check('debugger: no page errors', !errors.length, errors.join('; '));
  await ctx.close();

  // the 6309 option: a machine switched to the 6309 shows 6309 mnemonics and its own registers through the
  // same page and Session, with no new screen
  const ctx9 = await browser.newContext();
  const p9 = await ctx9.newPage();
  const errors9 = [];
  p9.on('pageerror', (e) => errors9.push(e.message));
  await p9.goto(`${base}?machine=dragon64`); await started(p9);
  await openTab(p9, 'Machine');                 // the CPU select lives in the Machine panel, which opens on click
  await p9.selectOption('#cpuSel', '6309');
  await waitFor(p9, () => window.emu.machine.cpu.constructor.name === 'CPU6309');
  const r9 = await p9.evaluate(() => {
    const s = window.emu.session, Emu = window.emu.Emu;
    const at = 0x3000;
    // LDQ immediate, AIM direct, TFM and SWI3: the four forms the 6309 adds or shares
    const r = Emu.assemble(' ORG $3000\nSTART LDQ #$11223344\n AIM #$80,<$10\n TFM X+,Y+\n SWI3\n', '6309');
    s.machine.cpu.jump(at);
    for (const [i, b] of [...r.segments[0].data].entries()) s.debug.write(at + i, [b]);
    const d = s.debug;
    return { cls: s.machine.cpu.constructor.name, cpu: d.cpu, dis: d.disassemble(at, 4).map((i) => i.text),
      regs: 'w' in d.registers() && 'q' in d.registers() && 'md' in d.registers() };
  });
  check('debugger: the 6309 option gives a 6309 core and debugger in the page', r9.cls === 'CPU6309' && r9.cpu === '6309', JSON.stringify(r9));
  check('debugger: the page disassembles 6309 instructions', JSON.stringify(r9.dis) === JSON.stringify(['LDQ #$11223344', 'AIM #$80,<$10', 'TFM X+,Y+', 'SWI3']),
    JSON.stringify(r9.dis));
  check('debugger: the 6309 registers are in the page', r9.regs);
  check('debugger: no page errors on the 6309', !errors9.length, errors9.join('; '));
  await ctx9.close();

  // The Debugger SCREEN on a 6309: opening it must not throw (a screen used to have no register set for a 6309
  // and threw "ORDER[cpu] is not iterable"), it must show the full 6309 set, and an edit through a register field
  // must reach the core. The CPU is switched in the Machine panel rather than linked: a ?cpu=6309 link reaches
  // the same screen, but it also starts the welcome menu, which looks its build up by CPU and has no 6309 entry
  // yet - the link would fail here on a missing examples/ file that has nothing to do with the Debugger.
  const ctxS = await browser.newContext();
  const pS = await ctxS.newPage();
  const errorsS = [];
  pS.on('pageerror', (e) => errorsS.push(e.message));
  await pS.goto(`${base}?machine=coco3`);
  await ready(pS);
  await openTab(pS, 'Machine');
  await pS.selectOption('#cpuSel', '6309');
  await waitFor(pS, () => window.emu.machine.cpu.constructor.name === 'CPU6309');
  await pS.click('#navDebugger');
  await pS.waitForSelector('#debugView:not([hidden])');
  await waitFor(pS, () => document.querySelectorAll('#dbgRegs [data-reg]').length > 0);
  const s9 = await pS.evaluate(() => ({
    cls: window.emu.session.machine.cpu.constructor.name,
    fields: [...document.querySelectorAll('#dbgRegs [data-reg]')].map((e) => e.dataset.reg),
    flags: [...document.querySelectorAll('#dbgRegs .cc .flag, #dbgRegs .cc .flag.on')].map((e) => e.textContent),
    qValue: (document.querySelector('[data-reg="q"]') || {}).value,
    mdValue: (document.querySelector('[data-reg="md"]') || {}).value,
  }));
  check('debugger screen 6309: opening it on a machine switched to the 6309 shows its register set',
    s9.cls === 'CPU6309' && ['pc', 'a', 'b', 'e', 'f', 'd', 'w', 'q', 'v', 'md', 'x', 'y', 'u', 's', 'dp'].every((r) => s9.fields.includes(r)),
    `${s9.cls} ${s9.fields.join()}`);
  check('debugger screen 6309: the condition codes are the 6809 set', s9.flags.join('') === 'EFHINZVC', s9.flags.join());
  check('debugger screen 6309: Q is four bytes wide and MD one', /^\$[0-9A-F]{8}$/.test(s9.qValue || '') && /^\$[0-9A-F]{2}$/.test(s9.mdValue || ''),
    `Q=${s9.qValue} MD=${s9.mdValue}`);
  // An edit through the field reaches the core. The machine is stopped first: a running welcome program would
  // overwrite the register between the edit and the read (the existing desktop case stops at a breakpoint first).
  // Each edit goes through the field's own change handler, and the field is read back after the refresh redraws
  // it - so a display that masks Q to 16 bits, or a W field that writes D, is caught here.
  const setField = (reg, value) => pS.evaluate(([reg, value]) => {
    const el = document.querySelector(`[data-reg="${reg}"]`);
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [reg, value]);
  await pS.evaluate(() => { const d = window.emu.session.debug; if (!d.stopped) d.halt(); });
  await setField('q', '$DEADBEEF');
  // the panel redraws the fields from the core on refresh; poll for the redrawn field
  await waitFor(pS, () => document.querySelector('[data-reg="q"]').value === '$DEADBEEF');
  const qAfter = await pS.evaluate(() => ({
    field: document.querySelector('[data-reg="q"]').value,
    q: window.emu.session.machine.cpu.q >>> 0,
  }));
  check('debugger screen 6309: an edit through the Q field sets it, and the field reads back all four bytes',
    qAfter.q === 0xDEADBEEF && qAfter.field === '$DEADBEEF', JSON.stringify(qAfter));
  // W and V: each writes its own register, and D and X are left alone
  const before = await pS.evaluate(() => { const c = window.emu.session.machine.cpu; return { d: c.d, x: c.x }; });
  await setField('w', '$1234');
  await setField('v', '$5678');
  await waitFor(pS, () => window.emu.session.machine.cpu.w === 0x1234 && window.emu.session.machine.cpu.v === 0x5678);
  const wv = await pS.evaluate(() => {
    const c = window.emu.session.machine.cpu;
    return { w: c.w, v: c.v, d: c.d, x: c.x, wField: document.querySelector('[data-reg="w"]').value, vField: document.querySelector('[data-reg="v"]').value };
  });
  check('debugger screen 6309: the W and V fields write W and V, leaving D and X alone',
    wv.w === 0x1234 && wv.v === 0x5678 && wv.d === before.d && wv.x === before.x && wv.wField === '$1234' && wv.vField === '$5678',
    JSON.stringify({ wv, before }));
  // An address register still takes a label: typing START into PC sets it from the assembled program's symbol,
  // on a 6309 as on any CPU (the field used to fall through to a plain hex parse, which rejects a label).
  const labelSet = await pS.evaluate(async () => {
    const s = window.emu.session, Emu = window.emu.Emu, d = s.debug;
    const r = Emu.assemble(' ORG $3000\nSTART LDA #$01\nHERE BRA HERE\n', '6309');
    for (const [i, b] of [...r.segments[0].data].entries()) d.write(0x3000 + i, [b]);
    s.labels = r.symbols;                          // what Assemble & run gives the Session (its own labels map)
    if (!d.stopped) d.halt();
    const el = document.querySelector('[data-reg="pc"]');
    el.value = 'START';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { start: r.symbols.get('START'), pc: s.machine.cpu.pc };
  });
  check('debugger screen 6309: typing a label into PC sets it from the program\'s symbols',
    labelSet.pc === labelSet.start && labelSet.start === 0x3000, JSON.stringify(labelSet));
  // A byte register takes a label too (it always has: an edit went through the address parser). DP holds a page
  // NUMBER, so the label's address is masked to a byte like any other byte register: a label at $0046 gives DP $46.
  const dpLabel = await pS.evaluate(async () => {
    const s = window.emu.session, d = s.debug;
    s.labels = new Map([['PAGE', 0x0046]]);
    if (!d.stopped) d.halt();
    const el = document.querySelector('[data-reg="dp"]');
    el.value = 'PAGE';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return s.machine.cpu.dp;
  });
  check('debugger screen 6309: typing a label into a byte register (DP) sets it', dpLabel === 0x46, '$' + Number(dpLabel).toString(16));
  check('debugger screen 6309: no page errors', !errorsS.length, errorsS.join('; '));
  await ctxS.close();

  // The same label entry on a 6809, so the rule is not only exercised on the 6309 path.
  const ctx8 = await browser.newContext();
  const p8 = await ctx8.newPage();
  const errors8 = [];
  p8.on('pageerror', (e) => errors8.push(e.message));
  await p8.goto(`${base}?machine=dragon64`);
  await ready(p8);
  await p8.click('#navDebugger');
  await p8.waitForSelector('#debugView:not([hidden])');
  await waitFor(p8, () => document.querySelectorAll('#dbgRegs [data-reg]').length > 0);
  const label6809 = await p8.evaluate(async () => {
    const s = window.emu.session, Emu = window.emu.Emu, d = s.debug;
    s.labels = new Map([['START', 0x3000]]);
    if (!d.stopped) d.halt();
    const el = document.querySelector('[data-reg="pc"]');
    el.value = 'START';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { cpu: s.machine.config.cpu, pc: s.machine.cpu.pc };
  });
  check('debugger screen 6809: typing a label into PC sets it from the symbols too',
    label6809.cpu === '6809' && label6809.pc === 0x3000, JSON.stringify(label6809));
  check('debugger screen 6809: no page errors', !errors8.length, errors8.join('; '));
  await ctx8.close();
}

// the emulator layout at desktop and phone width: header, grouped
// machine menu with a confirmation, monitor bezel per family, controls and slots, the drawer's tabs
async function layoutChecks(browser, base, check) {
  // The app bar stays ONE row at 1280 x 720 (first visit: the "No BASIC" pill is showing, the widest the bar gets),
  // in the runner's own system font and again in a deliberately wide one, so a runner whose fallback font is wider
  // than this machine's cannot push the links onto a second row (they did: 116 px in CI, 68 locally).
  // Measured with getBoundingClientRect: every item sits in one band the height of the tallest, the four links share a top.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    await page.goto(base);
    await started(page);
    await page.evaluate(() => document.fonts.ready);
    const measure = () => page.evaluate(() => {
      const bar = document.getElementById('appbar'), b = bar.getBoundingClientRect();
      const items = [...bar.children].filter((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0);
      const tops = items.map((e) => e.getBoundingClientRect().top), bottoms = items.map((e) => e.getBoundingClientRect().bottom);
      const links = [...bar.querySelectorAll('nav a')].map((a) => a.getBoundingClientRect());
      const nav = bar.querySelector('nav').getBoundingClientRect();
      return { h: Math.round(b.height), band: Math.round(Math.max(...bottoms) - Math.min(...tops)), links: links.length,
        linkSpread: links.length ? Math.round(Math.max(...links.map((r) => r.top)) - Math.min(...links.map((r) => r.top))) : -1,
        navInside: nav.right <= b.right + 0.5, romPill: !!document.getElementById('romPill').offsetParent, scroll: document.documentElement.scrollWidth <= innerWidth,
        font: getComputedStyle(document.body).fontFamily.slice(0, 40) };
    });
    const oneRow = (m) => m.links === 4 && m.romPill && m.linkSpread <= 2 && m.band <= 50 && m.h <= 80 && m.navInside && m.scroll;
    const m1 = await measure();
    check('layout (1280 x 720): the app bar is one row, the four links on one line, in the page font', oneRow(m1), JSON.stringify(m1));
    await page.addStyleTag({ content: 'body, button, a, input, select { font-family: "DejaVu Sans", Verdana, sans-serif !important; }' });
    await page.evaluate(() => document.fonts.ready);
    const m2 = await measure();
    check('layout (1280 x 720): ...and in a wide font too', oneRow(m2), JSON.stringify(m2));
    // what the bar clips is still readable: the status text is also its title (non-empty: the tick has run)
    const statusTitle = () => page.evaluate(() => { const e = document.getElementById('status'); return { text: e.textContent, title: e.title }; });
    const t1 = await statusTitle();
    check('layout (1280 x 720): the status text is also its title, so a clipped status can be read on hover', t1.text.length > 0 && t1.title === t1.text, JSON.stringify(t1));
    // at 1200 in a wide font the status is squeezed the most: something of it still shows, and the bar is still one row
    await page.setViewportSize({ width: 1200, height: 720 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const m3 = await measure(), w3 = await page.evaluate(() => document.getElementById('status').getBoundingClientRect().width);
    check('layout (1200 x 720, wide font): one row, and the status keeps room to show something', oneRow(m3) && w3 >= 16, `${JSON.stringify(m3)} status ${Math.round(w3)}px`);
    await ctx.close();
  }
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const shot = async (name, opts = {}) => { if (shotDir) await page.screenshot(Object.assign({ path: path.join(shotDir, `play-${label}-${name}.png`) }, opts)); };
    await page.goto(base);
    await started(page);   // the welcome program runs and the page has finished starting
    await page.evaluate(() => document.fonts.ready);
    await redrawn(page);
    await shot('first-visit');
    check(`layout (${label}): no sideways scrolling`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), String(await page.evaluate(() => document.documentElement.scrollWidth)));
    check(`layout (${label}): the screen sits in a bezel with its nameplate, controls and slots below`, await page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      return document.getElementById('monitor').dataset.family === 'dragon' && document.getElementById('badge').textContent === 'DRAGON 64'
        && r('screen').width > 300 && r('btnReset').top > r('screen').bottom && r('btnTape').top > r('btnReset').bottom;
    }));
    const aspectD = await page.evaluate(() => { const r = document.getElementById('screen').getBoundingClientRect(); return r.width / r.height; });
    check(`layout (${label}): the Dragon picture is shown at 4:3`, Math.abs(aspectD - 4 / 3) < 0.02, aspectD.toFixed(3));
    check(`layout (${label}): one "Runs without ROMs" shelf (Media tab), "Share"`, (await page.$$('#shelf')).length === 1 && await page.evaluate(() => !!document.querySelector('#panel-media #shelf'))
      && await page.textContent('#btnShare') === 'Share');
    check(`layout (${label}): first visit shows "No BASIC · Add ROMs" and the sound pill`, await page.isVisible('#romPill') && await page.isVisible('#soundHint')
      && /No ROMs needed · click anywhere for sound/.test(await page.textContent('#soundHint')));
    if (label === 'desktop') {
      check('layout (desktop): the screen fills the first view', await page.evaluate(() => { const r = document.getElementById('screen').getBoundingClientRect(); return r.bottom <= innerHeight && r.width >= 640; }));
      check('layout (desktop): the drawer is beside the screen', await page.evaluate(() => document.querySelector('.drawer').getBoundingClientRect().left > document.getElementById('monitor').getBoundingClientRect().right));
    } else {
      check('layout (phone): header nav behind Menu; the drawer below the slots', await page.isHidden('.appbar nav') && await page.isVisible('#btnMenu')
        && await page.evaluate(() => document.querySelector('.drawer').getBoundingClientRect().top > document.getElementById('btnTape').getBoundingClientRect().bottom));
      await page.click('#btnMenu');
      check('layout (phone): Menu shows the links', await page.isVisible('nav a[href="https://github.com/yaniv-golan/cloadm"]') && await page.getAttribute('#btnMenu', 'aria-expanded') === 'true');
      await shot('menu-open');
      await page.click('#btnMenu');
    }
    // the machine menu: every model, grouped, ✓ only where BASIC can run
    await page.click('#machineBtn');
    const groups = await page.$$eval('#machineMenu .group-name', (g) => g.map((x) => x.textContent));
    const listed = await page.$$eval('#machineMenu button[data-machine]', (b) => b.map((x) => x.dataset.machine));
    const all = await page.evaluate(() => Object.keys(window.emu.profiles));
    // the sections are js/machines/menu.js's, tested there; here the page must show every model exactly once,
    // under at least one section, with no empty section
    check(`layout (${label}): machine menu lists every model exactly once under a section`,
      groups.length > 0 && new Set(listed).size === all.length && all.every((id) => listed.includes(id)), `${groups.join()} | ${listed.join(' ')}`);
    check(`layout (${label}): no ROMs: every model says it needs them`, (await page.$$eval('#machineMenu .tag', (t) => t.map((x) => x.textContent))).filter((t) => t === 'needs ROMs').length === all.length);
    check(`layout (${label}): the CP 400 is in the menu (it matched no section before)`, listed.includes('cp400'), listed.join(' '));
    await shot('machine-menu');
    // a switch asks first; Cancel keeps the machine; Escape closes the menu
    await page.click('#machineMenu button[data-machine="coco3"]');
    check(`layout (${label}): switching asks first`, await page.isVisible('#switchConfirm') && /Switching to CoCo 3 resets the Dragon 64/.test(await page.textContent('#switchConfirm')));
    await shot('confirm');
    await page.click('#btnSwitchCancel');
    check(`layout (${label}): Cancel keeps the machine running`, await page.isHidden('#switchConfirm') && await page.evaluate(() => window.emu.machine.id) === 'dragon64');
    await page.click('#machineBtn'); await page.keyboard.press('Escape');
    check(`layout (${label}): Escape closes the menu`, await page.isHidden('#machineMenu'));
    await pickMachine(page, 'coco3');
    const shown = await page.evaluate(() => { const r = document.getElementById('screen').getBoundingClientRect(); return r.width / r.height; });
    check(`layout (${label}): the CoCo 3 picture is shown at 4:3`, Math.abs(shown - 4 / 3) < 0.02, shown.toFixed(3));
    check(`layout (${label}): Switch switches, with the light Tandy bezel`, await page.evaluate(() => window.emu.machine.id === 'coco3' && document.getElementById('monitor').dataset.family === 'coco3'
      && document.getElementById('machineName').textContent === 'CoCo 3'));
    // the drawer: tabs by click and by arrow keys
    await page.click('#tab-media'); await page.keyboard.press('ArrowRight');
    check(`layout (${label}): arrow keys move between the drawer's tabs`, await page.getAttribute('#tab-display', 'aria-selected') === 'true' && await page.isVisible('#panel-display') && await page.isHidden('#panel-media'));
    check(`layout (${label}): the CoCo 3 in CRT · composite shows the composite monitor and its artifact colours, with the phase choice`,
      await page.evaluate(() => window.emu.machine.monitor === 'composite' && window.emu.machine.gime.artifact === 1) && await page.isVisible('#lblPhase'));
    await page.click('#btnSharp');
    check(`layout (${label}): Sharp · RGB: the RGB monitor, the CRT look off`, await page.evaluate(() => window.emu.machine.monitor === 'rgb'
      && !document.getElementById('monitor').classList.contains('crt')) && await page.getAttribute('#btnSharp', 'aria-pressed') === 'true');
    await page.reload(); await started(page);
    check(`layout (${label}): the picture choice is remembered`, await page.evaluate(() => window.emu.session.display.view === 'sharp' && window.emu.machine.monitor === 'rgb')
      && await page.getAttribute('#btnSharp', 'aria-pressed') === 'true');
    await openTab(page, 'Display'); await page.click('#btnCrt');
    await openTab(page, 'Machine');
    await shot('machine-tab', { fullPage: true });
    // the cassette slot shows the tape
    await page.setInputFiles('#fileTape', { name: 'game.cas', mimeType: 'application/octet-stream', buffer: Buffer.alloc(300, 0x55) });
    check(`layout (${label}): the cassette slot shows the tape`, await waitFor(page, () => document.getElementById('tapeName').textContent === 'game.cas'));
    check(`layout (${label}): no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }
}

// reading pages: /roms at desktop and phone width, and the rule that only /roms links the
// archive's ROM folder, checked over every page of the site
const READING = ['roms/', 'help/', 'credits/'];
// The Display tab: CRT · composite and Sharp · RGB, the NTSC artifact phase, curvature and glow
// (the WebGL CRT look), integer scaling and the picture's shape, remembered. A 256x192 artifact-colour picture
// ($AA, $55 and stripes of two widths above, black, buff and two more stripes below, in PMODE 4 CSS 1) is put on the
// CoCo's screen and drawn
// at fixed settings for the screenshots (the CRT look has no automatic oracle: they are reviewed by eye).
async function displayChecks(browser, base, check) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = async (name) => { if (shotDir) await page.locator('#monitor').screenshot({ path: path.join(shotDir, `display-${name}.png`) }); };
  await page.goto(`${base}?machine=coco`);
  await waitFor(page, () => window.emu && window.emu.machine && window.emu.machine.id === 'coco');
  await openTab(page, 'Display');
  check('display: WebGL CRT presenter in use (no fallback note)', await page.isHidden('#crtNote'));
  check('display: defaults: CRT · composite, phase "Orange / blue" (MAME\'s default), 4:3', await page.getAttribute('#btnCrt', 'aria-pressed') === 'true'
    && await page.inputValue('#selPhase') === '1' && await page.inputValue('#selAspect') === '4:3' && await page.isVisible('#lblPhase'));
  // the test picture: PMODE 4 (PIA1 PB $F8, SAM V 6) over $0400-$1BFF; the stub keeps running but writes only text
  const picture = () => page.evaluate(() => {
    const m = window.emu.machine;
    for (let y = 0; y < 192; y++) for (let x = 0; x < 32; x++) {
      const band = Math.floor(x / 8);
      m.ram[0x400 + y * 32 + x] = y < 96 ? [0xAA, 0x55, 0xCC, 0xF0][band] : [0x00, 0xFF, 0x88, 0x66][band];
    }
    m.write(0xFF22, 0xF8);
    for (const a of [0xFFC0, 0xFFC3, 0xFFC5]) m.write(a, 0);   // SAM V0 = 0, V1 = 1, V2 = 1: V 6
    m.write(0xFFC9, 0);                                         // SAM F1 = 1: the display at $0400
    m.write(0xFFDD, 0);                                         // SAM M1 = 1: 64K RAM (the stub leaves it at 4K)
  });
  await picture(); await redrawn(page);
  const art = () => page.evaluate(() => window.emu.machine.vdg.artifact);
  check('display: CRT · composite: the CoCo draws artifact colours, phase 1', await art() === 1);
  await shot('crt-default');
  await page.selectOption('#selPhase', '2'); await redrawn(page);
  check('display: "Blue / orange" selects phase 2', await art() === 2 && await page.evaluate(() => window.emu.session.display.phase === 2));
  await shot('crt-phase2');
  await page.fill('#rng-curvature', '100'); await page.fill('#rng-glow', '100'); await redrawn(page);
  check('display: the sliders set curvature and glow, with their values shown', await page.evaluate(() => window.emu.session.display.curvature === 100 && window.emu.session.display.glow === 100)
    && await page.textContent('#val-curvature') === '100%' && await page.textContent('#val-glow') === '100%');
  await shot('crt-max');
  await page.fill('#rng-curvature', '0'); await page.fill('#rng-glow', '0'); await redrawn(page);
  await shot('crt-flat');
  await page.click('#btnSharp'); await redrawn(page);
  check('display: Sharp · RGB: composite colour off, sliders and phase disabled', await art() === 0 && await page.isDisabled('#rng-curvature') && await page.isDisabled('#selPhase'));
  await shot('sharp');
  // integer scaling: the picture's height a whole number of 240-line frames; fill: the whole screen area
  await page.check('#chkInteger'); await redrawn(page);
  const size = () => page.evaluate(() => { const c = document.getElementById('screen').getBoundingClientRect(), a = document.getElementById('screenWrap');
    return { w: Math.round(c.width), h: Math.round(c.height), aw: a.clientWidth, ah: a.clientHeight }; });
  const si = await size();
  check('display: integer scaling: a whole number of display pixels per line', si.h % 240 === 0 && si.h >= 240 && Math.abs(si.w / si.h - 4 / 3) < 0.01, JSON.stringify(si));
  await page.selectOption('#selAspect', 'fill'); await redrawn(page);
  const sf = await size();
  check('display: "Fill the screen area"', sf.w === sf.aw && sf.h === sf.ah, JSON.stringify(sf));
  // remembered, and the page draws with the WebGL presenter at the canvas's displayed size
  await page.reload();
  await waitFor(page, () => window.emu && window.emu.machine && window.emu.machine.id === 'coco');
  check('display: the settings are remembered', await page.evaluate(() => JSON.stringify(window.emu.session.display))
    === JSON.stringify({ view: 'sharp', phase: 2, curvature: 0, glow: 0, integer: true, aspect: 'fill', screen: 'main' }));
  await openTab(page, 'Display');
  check('display: the tab shows the remembered settings', await page.getAttribute('#btnSharp', 'aria-pressed') === 'true' && await page.isChecked('#chkInteger')
    && await page.inputValue('#selAspect') === 'fill' && await page.inputValue('#selPhase') === '2' && await page.inputValue('#rng-curvature') === '0');
  // PAL Dragon: composite on, no phase choice
  await pickMachine(page, 'dragon64');
  check('display: the Dragon 64 has no NTSC phase choice', await page.isHidden('#lblPhase'));
  check('display: and no second screen to choose', await page.isHidden('#lblScreen'));
  // The Dragon 64 Plus: the Display tab switches between the Dragon's own screen and the
  // 80-column one. The fonts are the user's to supply, so - as the ROM checks do with synthetic images - a
  // character generator built here is loaded (its CRC made known-good in the page) along with the BASIC banks,
  // then the page runs the firmware's own CRTC setup and the 80-column picture is checked for a real image.
  await pickMachine(page, 'd64plus');
  check('display: the Dragon 64 Plus offers its second screen, opening on the Dragon video',
    await page.isVisible('#lblScreen') && await page.inputValue('#selScreen') === 'main');
  // a generator whose every byte identifies its address (as tests/d64plus.test.js uses), and two plain banks
  const GEN = Buffer.alloc(0x2000); for (let i = 0; i < GEN.length; i++) GEN[i] = i & 0xFF;
  const crcOf = (bytes) => { let c = -1; for (const v of bytes) { c ^= v; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; } return ((c ^ -1) >>> 0).toString(16).toUpperCase().padStart(8, '0'); };
  await page.evaluate(([genCrc]) => {
    const p = window.emu.profiles.d64plus.roms, g = p.find((s) => s.id === 'chargen');
    if (!g.crcs.includes(genCrc)) { g.crcs.push(genCrc); p.find((s) => s.id === 'basic').crcs.length = 0; }
  }, [crcOf(GEN)]);
  await page.setInputFiles('#fileRom', [
    { name: 'chargen.ic22', mimeType: 'application/octet-stream', buffer: GEN },
    { name: 'd64_1.rom', mimeType: 'application/octet-stream', buffer: fake(0x4000, 31) },
    { name: 'd64_2.rom', mimeType: 'application/octet-stream', buffer: fake(0x4000, 32) },
  ]);
  // the import is done when the machine holds the generator and the library's OPFS writes have landed
  await waitFor(page, () => window.emu.machine && window.emu.machine.id === 'd64plus' && !!window.emu.machine.charGen, null, 10000);
  await page.evaluate(() => window.emu.session.index.flush());
  // as the firmware does: MAME's plus_screen geometry, the video-RAM bank, a character in every cell
  const setUpPlus = () => page.evaluate(() => {
    const m = window.emu.machine, w = (r, v) => { m.write(0xFFE0, r); m.write(0xFFE1, v); };
    for (const [r, v] of [[0, 113], [1, 80], [2, 96], [3, 0x0F], [4, 25], [5, 4], [6, 22], [7, 24], [9, 11], [10, 0], [11, 11], [13, 0]]) w(r, v);
    m.write(0xFFE2, 0x01);
    for (let i = 0; i < 0x800; i++) m.write(i, (i * 13) & 0xFF);
    m.drawPlus();
  });
  const shown = () => page.evaluate(() => { const f = window.emu.machine.render(); return { view: window.emu.machine.view, w: f.width, h: f.height }; });
  await page.selectOption('#selScreen', 'plus');
  await waitFor(page, () => window.emu.machine.view === 'plus');
  await setUpPlus();
  check('display: the 80-column screen: the machine draws the CRTC\'s 640 x 264 picture',
    JSON.stringify(await shown()) === JSON.stringify({ view: 'plus', w: 640, h: 264 }), JSON.stringify(await shown()));
  const lit = await page.evaluate(() => { const d = window.emu.machine.render().data; let on = 0; for (const v of d) if (v) on++; return on; });
  check('display: ... with a real picture from the character generator loaded', lit > 50000 && lit < 168960 * 0.75, `${lit} of 168960 lit`);
  if (shotDir) await page.locator('#monitor').screenshot({ path: path.join(shotDir, 'display-d64plus-80col.png') });
  await page.selectOption('#selScreen', 'main');
  await waitFor(page, () => window.emu.machine.view === 'vdg');
  check('display: back to the Dragon video: 320 x 240', JSON.stringify(await shown()) === JSON.stringify({ view: 'vdg', w: 320, h: 240 }), JSON.stringify(await shown()));
  // leave the store as this check found it, and let the removal reach OPFS before the reload
  await page.evaluate(async () => { window.emu.session.roms.clear('d64plus'); await window.emu.session.index.flush(); });
  await page.reload();
  // the page is up again (without its ROMs the D64 Plus is not what it reopens on, so its id is not the condition: the
  // wait for it timed out on every run)
  await started(page);
  check('display: the screen choice is remembered', await page.evaluate(() => window.emu.session.display.screen) === 'main'
    && await page.inputValue('#selScreen') === 'main');
  check('display: no page errors', !errors.length, errors.join('; '));
  await ctx.close();

  // Without WebGL (headless Chromium has it, so the page's canvas is denied it here): the 2D presenter draws the
  // pixels, the tab says the CRT look is off and disables its sliders, and composite colour still follows the view.
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx2.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) { return /webgl/.test(type) ? null : get.call(this, type, ...rest); };
  });
  const p2 = await ctx2.newPage();
  const errors2 = [];
  p2.on('pageerror', (e) => errors2.push(e.message));
  await p2.goto(`${base}?machine=coco`);
  await waitFor(p2, () => window.emu && window.emu.machine && window.emu.machine.id === 'coco');
  await p2.evaluate(() => window.emu.session.setDisplay({ view: 'crt', phase: 1, integer: false, aspect: '4:3' }));
  await openTab(p2, 'Display');
  await redrawn(p2);
  check('display, no WebGL: the tab says the CRT look is off and disables its sliders', await p2.isVisible('#crtNote')
    && await p2.isDisabled('#rng-curvature') && await p2.isDisabled('#rng-glow'));
  // the 2D canvas holds the frame itself (320 x 240) with more than one colour
  const drawn = await p2.evaluate(() => {
    const c = document.getElementById('screen'), g = c.getContext('2d');
    if (!g) return null;
    const d = g.getImageData(0, 0, c.width, c.height).data, set = new Set();
    for (let i = 0; i < d.length; i += 4 * 31) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return { w: c.width, h: c.height, colours: set.size };
  });
  check('display, no WebGL: the 2D presenter draws the frame', drawn && drawn.w === 320 && drawn.h === 240 && drawn.colours > 1, JSON.stringify(drawn));
  check('display, no WebGL: CRT · composite still gives composite colour', await p2.evaluate(() => window.emu.machine.vdg.artifact) === 1);
  await p2.click('#btnSharp'); await redrawn(p2);
  check('display, no WebGL: Sharp · RGB turns it off', await p2.evaluate(() => window.emu.machine.vdg.artifact) === 0);
  if (shotDir) await p2.locator('#monitor').screenshot({ path: path.join(shotDir, 'display-no-webgl.png') });
  check('display, no WebGL: no page errors', !errors2.length, errors2.join('; '));
  await ctx2.close();
}

// WebGL context loss (GPU reset, tab evicted on mobile, laptop sleep): forced through
// WEBGL_lose_context. While lost the page keeps running without errors; once restored the presenter rebuilds its
// program and texture and the screen shows the machine again (not black).
async function glLossChecks(browser, base, check) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}?machine=coco`);
  await waitFor(page, () => window.emu && window.emu.machine && window.emu.machine.id === 'coco', null, 5000);
  // (in the page) how many colours the screen shows
  const coloursIn = () => {
    const s = document.getElementById('screen'), c = document.createElement('canvas');
    c.width = s.width; c.height = s.height; c.getContext('2d').drawImage(s, 0, 0);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, set = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return set.size;
  };
  const colours = () => page.evaluate(coloursIn);
  await page.evaluate((src) => { window.__colours = eval(src); }, `(${coloursIn})`);
  await waitFor(page, () => window.__colours() > 1);   // the machine's picture is up
  const before = await colours();
  const ext = await page.evaluate(() => { const gl = document.getElementById('screen').getContext('webgl'); window.__lose = gl && gl.getExtension('WEBGL_lose_context'); return !!window.__lose; });
  check('WebGL loss: the context can be lost on purpose (WEBGL_lose_context)', ext);
  await page.evaluate(() => window.__lose.loseContext());
  await waitFor(page, () => document.getElementById('screen').getContext('webgl').isContextLost());
  const frames = await page.evaluate(() => window.emu.machine.frameCount ?? window.emu.machine.framesSinceReset);
  await waitFor(page, (f) => (window.emu.machine.frameCount ?? window.emu.machine.framesSinceReset) > f + 10, frames);
  const framesLater = await page.evaluate(() => window.emu.machine.frameCount ?? window.emu.machine.framesSinceReset);
  check('WebGL loss: while lost the machine keeps running, no page errors', framesLater > frames && !errors.length, errors.join('; '));
  await page.evaluate(() => window.__lose.restoreContext());
  await waitFor(page, () => !document.getElementById('screen').getContext('webgl').isContextLost() && window.__colours() > 1);
  const after = await colours();
  check('WebGL loss: restored, the screen shows the machine again', before > 1 && after > 1, `(${before} colours before, ${after} after)`);
  check('WebGL loss: no page errors', !errors.length, errors.join('; '));
  if (shotDir) await page.locator('#monitor').screenshot({ path: path.join(shotDir, 'webgl-restored.png') });
  await ctx.close();
}

// The frame loop (4.5): it uploads a picture to the GPU only when one changed (a frame ran, or the
// display settings or the size changed), not on every animation frame; paused, a Display change or a resize is still
// drawn. Uploads are counted on the WebGL context. Fullscreen: hidden where the browser has no API for it (1.30).
async function pageLoopChecks(browser, base, check) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => {
    // animation frames whose time the test can freeze: the ticks of a display faster than the machine, with no
    // emulated frame due
    window.__frozen = null;
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(window.__frozen ?? performance.now()), 4);
    window.__uploads = 0;
    for (const P of [WebGLRenderingContext.prototype]) for (const f of ['texImage2D', 'texSubImage2D']) {
      const o = P[f]; P[f] = function (...a) { window.__uploads++; return o.apply(this, a); };
    }
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?machine=dragon64`);
  await waitFor(page, () => window.emu && window.emu.machine && window.emu.machine.id === 'dragon64', null, 5000);
  await started(page);
  const sample = () => page.evaluate(() => ({ uploads: window.__uploads, frames: window.emu.machine.framesSinceReset }));
  // the windows below are counted in emulated frames or in the page's animation-frame ticks, not in wall time, so a
  // slow page measures over as many frames and ticks as a fast one
  const a = await sample();
  await waitFor(page, (f) => window.emu.machine.framesSinceReset >= f + 50, a.frames);
  const b = await sample();
  const ran = b.frames - a.frames, up = b.uploads - a.uploads;
  check('page loop: one upload per emulated frame at most', ran > 30 && up <= ran + 2, `${up} uploads for ${ran} frames`);
  await page.evaluate(() => { window.__frozen = performance.now(); });
  // the first tick at the frozen time still carries the time since the last real tick, which may complete a frame:
  // that frame was due before the freeze, so the count starts after it (ticks come every 4 ms)
  await ticks(page, 3);
  const e = await sample(); await ticks(page, 100); const f = await sample();
  await page.evaluate(() => { window.__frozen = null; });
  check('page loop: animation frames with no emulated frame upload nothing', f.frames === e.frames && f.uploads === e.uploads, `${f.uploads - e.uploads} uploads, ${f.frames - e.frames} frames`);
  await page.click('#btnPause');
  await waitFor(page, () => document.body.classList.contains('paused'));   // the page's Pause (not the debugger's stop)
  await ticks(page, 3);
  const c = await sample(); await ticks(page, 100); const d = await sample();
  check('page loop: paused, nothing is uploaded', d.uploads === c.uploads && d.frames === c.frames, `${d.uploads - c.uploads} uploads`);
  await page.evaluate(() => {
    window.__pixels = () => {
      const s = document.getElementById('screen'), cv = document.createElement('canvas');
      cv.width = s.width; cv.height = s.height; cv.getContext('2d').drawImage(s, 0, 0);
      const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let h = 0; for (let i = 0; i < px.length; i += 61) h = (h * 31 + px[i]) >>> 0;
      return { h, w: s.width, cssW: s.style.width };
    };
  });
  const pixels = () => page.evaluate(() => window.__pixels());
  const before = await pixels();
  await page.evaluate(() => window.emu.session.setDisplay({ view: 'sharp' }));
  await waitFor(page, (h) => window.__pixels().h !== h, before.h);
  const sharp = await pixels();
  check('page loop: paused, a Display change is drawn', sharp.h !== before.h, `${before.h} -> ${sharp.h}`);
  await page.setViewportSize({ width: 900, height: 700 });
  await waitFor(page, (w) => window.__pixels().cssW !== w, sharp.cssW);
  await ticks(page, 3);   // and drawn at that size
  const small = await pixels();
  check('page loop: paused, a resize is drawn', small.cssW !== sharp.cssW, `${sharp.cssW} -> ${small.cssW}`);
  // paused, the WebGL context is lost and restored: the restored canvas is blank, so the picture is drawn again
  await page.evaluate(() => { window.__lose = document.getElementById('screen').getContext('webgl').getExtension('WEBGL_lose_context'); window.__lose.loseContext(); });
  await waitFor(page, () => document.getElementById('screen').getContext('webgl').isContextLost());
  await page.evaluate(() => window.__lose.restoreContext());
  await waitFor(page, (h) => !document.getElementById('screen').getContext('webgl').isContextLost() && window.__pixels().h === h, small.h);
  const restored = await pixels();
  check('page loop: paused, a WebGL context restore is drawn (not left blank)', restored.h === small.h, `${small.h} before, ${restored.h} after`);
  await page.evaluate(() => window.emu.session.setDisplay({ view: 'crt' }));
  await page.click('#btnPause');
  check('page loop: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
  // no Fullscreen API (iPhone Safari): the button is hidden, nothing throws
  const ctx2 = await browser.newContext();
  await ctx2.addInitScript(() => { delete Element.prototype.requestFullscreen; delete Element.prototype.webkitRequestFullscreen; });
  const p2 = await ctx2.newPage();
  const errors2 = [];
  p2.on('pageerror', (e) => errors2.push(e.message));
  await p2.goto(`${base}?machine=coco`);
  await started(p2);
  check('no Fullscreen API: the button is hidden, no page errors', await p2.isHidden('#btnFull') && !errors2.length, errors2.join('; '));
  await ctx2.close();
}

async function readingChecks(browser, site, check) {
  const archiveRoms = (h) => /colorcomputerarchive\.com\/repo\/ROMs/i.test(h);
  for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const archive = [], errors = [], foreign = [];
    const ctx = await guardedContext(browser, archive);
    const page = await ctx.newPage();
    await page.setViewportSize(viewport);
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && u.host !== new URL(site).host) foreign.push(r.url()); });
    for (const p of READING) {
      const res = await page.goto(site + p);
      await page.evaluate(() => document.fonts.ready);
      check(`${p} (${label}): served, no sideways scrolling`, res.ok() && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (shotDir) await page.screenshot({ path: path.join(shotDir, `${p.replace(/\W/g, '')}-${label}.png`), fullPage: true });
    }
    if (label === 'desktop') {
      await page.goto(site + 'roms/');
      const text = await page.textContent('main');
      check('/roms: says it in one place: dump your own, the archive keeps the XRoar sets, copyright, never downloaded',
        /Dump your own/.test(text) && /The community-run Color Computer Archive keeps the ROM sets XRoar uses/.test(text)
        && /ROMs are copyrighted by Microsoft, Tandy, Dragon Data and others\. CLOADM doesn't include them and never\s+downloads them\./.test(text)
        && /File names don't matter: CLOADM recognises ROMs by their contents\./.test(text) && /ROMs stay in this browser\. They are never uploaded, put in share links or exported\./.test(text));
      check('/roms: links the archive\'s ROM folder as a plain link', await page.getAttribute('#archiveRoms', 'href') === 'https://colorcomputerarchive.com/repo/ROMs/XRoar/'
        && /noreferrer/.test(await page.getAttribute('#archiveRoms', 'rel')));
      const rows = await page.$$eval('table.plain tbody tr td:first-child', (r) => r.map((x) => x.textContent));
      await page.goto(site + 'play/'); await ready(page);
      const names = await page.evaluate(() => Object.values(window.emu.profiles).map((p) => p.name));
      check('/roms: the machine table lists every model', rows.length === names.length && names.every((n) => rows.includes(n)), rows.join(', '));
      // every page of the site: same-site links resolve; only /roms and the landing page link the archive's ROM folder
      const linksTo = {}, broken = [];
      for (const p of ['', 'play/', ...READING]) {
        await page.goto(site + p); if (p === 'play/') await started(page);
        const links = await page.$$eval('a[href]', (a) => a.map((x) => x.href));
        linksTo[p] = links.filter(archiveRoms).length;
        for (const h of new Set(links.filter((x) => x.startsWith(site)).map((x) => x.split('#')[0]))) { const r = await page.request.get(h); if (!r.ok()) broken.push(`${p}: ${h} ${r.status()}`); }
      }
      check('site: only /roms and the landing page link the archive\'s ROM folder, once each', linksTo['roms/'] === 1 && linksTo[''] === 1 && Object.entries(linksTo).every(([p, n]) => p === 'roms/' || p === '' || n === 0), JSON.stringify(linksTo));
      check('site: every same-site link on every page resolves', !broken.length, broken.join(' '));
      // Help: keys, ROMs (to /roms), quick fixes, GitHub
      await page.goto(site + 'help/');
      const help = await page.textContent('body');
      check('/help: the tape tip undoes both speed POKEs', /POKE 65496,0\s*undoes\s*POKE 65497,0/.test(help));
      check('/help: keys, ROMs, quick fixes, and links to /roms, the emulator and GitHub', /Esc\s*BREAK/.test(help) && /Home\s*CLEAR/.test(help) && /Quick fixes/.test(help)
        && await page.$eval('#romsLink', (a) => new URL(a.href).pathname) === '/roms/' && !!(await page.$('a[href="https://github.com/yaniv-golan/cloadm"]'))
        && await page.$eval('a[href="play/"]', (a) => new URL(a.href).pathname) === '/play/');
      // Credits: in step with CREDITS.md (every person and project below is on both)
      await page.goto(site + 'credits/');
      const credits = await page.textContent('body'), md = fs.readFileSync(path.join(ROOT, 'CREDITS.md'), 'utf8');
      const thanked = ['MAME', 'Nathan Woods', 'Phill Harvey-Smith', 'XRoar', 'Ciaran Anscomb', 'VCC', 'Joseph Forgione', 'DriveWire', 'Boisy Pitre', 'Aaron Wolfe',
        'Color Computer Archive', 'Dragon Archive', 'Ross Hamilton', 'Graham E. Kinns', 'Unravelled', 'PC-Dragon', 'os9projects.com', 'Centre for Computing History', 'Retromags',
        'Archivo', 'JetBrains Mono', 'MC6883', 'MC6801', 'HD6301', 'Darren Atkinson'];
      const missing = thanked.filter((n) => !credits.includes(n) || !md.includes(n));
      check('/credits and CREDITS.md both thank everyone on the list', !missing.length, missing.join(', '));
      check('/credits and CREDITS.md: no unsourced names (Jim Hathaway was dropped: no source)', !/Hathaway/.test(credits + md));
      check('/help and /credits use the shared reading stylesheet, no inline layout', await page.evaluate(async () => {
        const pages = await Promise.all(['help/', 'credits/'].map((p) => fetch(p).then((r) => r.text())));
        return pages.every((t) => t.includes('css/reading.css') && (t.match(/ style="/g) || []).length <= 4);
      }));
      await page.goto(site + 'play/');
      await page.click('nav a[href="help/"]');
      check('the emulator\'s header links Help', await waitFor(page, () => location.pathname === '/help/'));
      await page.goto(site); await page.click('text=Where do I get ROMs?');
      check('landing: "Where do I get ROMs?" opens /roms', await waitFor(page, () => location.pathname === '/roms/'));
    }
    check(`reading pages (${label}): nothing requested from other hosts, no page errors`, !foreign.length && !archive.length && !errors.length, foreign.concat(errors, archive).join(' '));
    await ctx.close();
  }
}

// the light variant: reading pages follow a light system setting; the emulator stays dark
async function lightChecks(browser, site, check) {
  for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ colorScheme: 'light', viewport });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    for (const p of ['', ...READING]) {
      await page.goto(site + p);
      await page.evaluate(() => document.fonts.ready);
      const st = await page.evaluate(() => { const b = getComputedStyle(document.body), h = getComputedStyle(document.querySelector('h1, h2'));
        const a = [...document.querySelectorAll('main a, section a, p a')].find((x) => !x.style.color && !x.style.background && x.offsetParent);
        return { bg: b.backgroundColor, h: h.color, link: a ? getComputedStyle(a).color : null }; });
      check(`light (${label}) ${p || '/'}: light ground, dark headings, dark green links`, st.bg === 'rgb(244, 242, 236)' && st.h === 'rgb(20, 24, 22)'
        && (st.link === null || st.link === 'rgb(11, 107, 30)'), JSON.stringify(st));
      if (shotDir) await page.screenshot({ path: path.join(shotDir, `light-${(p || 'landing').replace(/\W/g, '')}-${label}.png`), fullPage: true });
    }
    await page.goto(site);
    check(`light (${label}): primary buttons have a dark green edge (3:1 against the ground)`, await page.evaluate(() =>
      [...document.querySelectorAll('.btn-primary')].length >= 3 && [...document.querySelectorAll('.btn-primary')].every((b) => /rgb\(11, 107, 30\)/.test(getComputedStyle(b).boxShadow))));
    await page.goto(site + 'play/');
    check(`light (${label}): the emulator stays dark`, await page.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(11, 13, 12)');
    check(`light (${label}): no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }
  // and dark stays dark when the system asks for dark
  const ctx = await browser.newContext({ colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto(site + 'help/');
  check('dark system setting: reading pages are dark', await page.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(11, 13, 12)');
  await ctx.close();
}

// cassette media: Record captures what our writer firmware (tools/mame-diff/tape/csave.asm, installed as
// the ROM) writes and saves it as .CAS; Save .WAV exports it; a WAV recording inserted as a tape is decoded
async function tapeChecks(browser, base, check) {
  const Emu = require('../tests/load.js')();
  const { csaveStream } = require('./mame-diff/tape/spec.js');
  const stream = csaveStream();
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?machine=dragon32`);
  await ready(page);
  // paused while the writer firmware goes in and Record is armed, so the recording starts before the firmware
  // runs: it writes its first leader byte as soon as it is reset, and a page stall between the reset and the
  // click would otherwise let it get ahead of Record
  await page.click('#btnPause');
  // the writer firmware, assembled in the page and installed in the BASIC socket
  const halt = await page.evaluate(async () => {
    const { assemble } = await import(new URL('js/asm/assembler.js', document.baseURI).href);
    const res = assemble(await (await fetch('tools/mame-diff/tape/csave.asm')).text(), '6809');
    const img = new Uint8Array(0x4000).fill(0x12);
    for (const sgm of res.segments) img.set(sgm.data, sgm.addr - 0x8000);
    const m = window.emu.machine;
    m.setRoms({ basic: img }); m.reset(true);
    return res.symbols.get('HALT');
  });
  await page.click('#btnRecord');
  check('tape: Record arms the deck', await page.getAttribute('#btnRecord', 'aria-pressed') === 'true' && await page.evaluate(() => window.emu.session.tapeRecording));
  await page.click('#btnPause');      // resume: the firmware runs from its reset with the deck already recording
  check('tape: the firmware writes its tape', await waitFor(page, (h) => window.emu.machine.cpu.pc === h, halt, 15000));
  const [cas] = await Promise.all([page.waitForEvent('download'), page.click('#btnRecord')]);
  const casBytes = fs.readFileSync(await cas.path());
  check('tape: stopping saves recording.cas, exactly the bytes written', cas.suggestedFilename() === 'recording.cas' && Buffer.from(casBytes).equals(Buffer.from(stream))
    && /Recorded 3 block\(s\)/.test(await page.textContent('#toast')), await page.textContent('#toast'));
  const [wav] = await Promise.all([page.waitForEvent('download'), page.click('#btnTapeWav')]);
  const fromWav = Emu.wavToCas(new Uint8Array(fs.readFileSync(await wav.path())));
  check('tape: Save .WAV saves the recording as it was written, which decodes to the same bytes', wav.suggestedFilename() === 'recording.wav' && Buffer.from(fromWav.bytes).equals(Buffer.from(stream)));
  // a WAV recording inserted as a tape, then exported again
  await page.setInputFiles('#fileTape', { name: 'game.wav', mimeType: 'audio/wav', buffer: Buffer.from(Emu.casToWav(stream)) });
  check('tape: a WAV recording goes in the deck, decoded', await waitFor(page, () => /game\.wav inserted \(decoded from the recording: 3 blocks\)/.test(document.getElementById('toast').textContent))
    && await waitFor(page, () => document.getElementById('tapeName').textContent === 'game.wav'), await page.textContent('#toast'));
  const [wav2] = await Promise.all([page.waitForEvent('download'), page.click('#btnTapeWav')]);
  check('tape: Save .WAV exports the tape in the deck', wav2.suggestedFilename() === 'game.wav' && Buffer.from(Emu.wavToCas(new Uint8Array(fs.readFileSync(await wav2.path()))).bytes).equals(Buffer.from(stream)));
  if (shotDir) await page.locator('.slots').screenshot({ path: path.join(shotDir, 'tape-slot.png') });
  // recording again, then a machine switch before stopping: the page warns and offers the recording
  // first; accepted, it is downloaded, exactly the bytes written
  await page.click('#btnPause');
  await page.evaluate(() => window.emu.machine.reset(true));
  await page.click('#btnRecord');
  await page.click('#btnPause');
  check('tape: the firmware writes its tape again', await waitFor(page, (h) => window.emu.machine.cpu.pc === h, halt, 15000));
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); d.accept(); });
  const [kept] = await Promise.all([page.waitForEvent('download'), pickMachine(page, 'coco')]);
  check('tape: switching machine while recording asks to save it first, and saves it', /recording on the Dragon 32/.test(asked) && /3 blocks/.test(asked)
    && kept.suggestedFilename() === 'recording.cas' && Buffer.from(fs.readFileSync(await kept.path())).equals(Buffer.from(stream))
    && await page.evaluate(() => window.emu.machine.id === 'coco' && !window.emu.session.tapeRecording), asked);
  check('tape: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

// Touch joystick: the on-screen panel's Joystick mode (js/ui/touch-keys.js, js/host/input.js) on a phone held
// sideways, upright and on a tablet. It drives the right joystick (the machine's joy[0]) and its FIRE the
// button bit; the mode is remembered per machine; ?touch= sets it for the visit; a gamepad arriving stands it
// down; the MC-10 has no switch; nothing lies over #screen at any of the three sizes; and the welcome menu's
// taps never reach it while the stick is up.
// Every printable character, typed through real key events on a US layout (Playwright's keyboard: Shift held
// down for the characters the US layout shifts, as a person does), on one machine of each keyboard family. Our
// key-echo firmware (tools/keyecho/gen-keyecho.js) scans the matrix as BASIC does and writes what it decodes to
// the text screen, which must hold exactly the characters typed. Translated mode is the page's default; the bug
// this guards was the host's Shift reaching the matrix, so ':' (Shift+; on the host) typed '*'.
async function keyboardSymbolsChecks(browser, base, check) {
  const Emu = require('../tests/load')();
  const { US } = require('../tests/us-layout.js');
  const { keyechoBinary, expectedCodes, printable } = require('./keyecho/gen-keyecho.js');
  for (const [id, cpu] of [['dragon64'], ['dragon200e'], ['coco'], ['coco3', '6309'], ['mc10']]) {
    const tag = cpu ? `${id} ${cpu}` : id;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?machine=${id}${cpu ? `&cpu=${cpu}` : ''}`);
    await ready(page);
    // the welcome menu would take the typed digits (and could start after the load): end it first, as stubPrompt does
    await waitFor(page, () => window.emu && window.emu.started);
    await page.evaluate(() => window.emu.session.endWelcome());
    await page.evaluate((bin) => window.emu.session.load('keyecho.bin', new Uint8Array(bin), { remember: false }), [...keyechoBinary(Emu, id)]);
    await waitFor(page, () => window.emu.machine.ram[(window.emu.machine.profile.textScreen || 0x400)] === 0x60);
    const text = printable(Emu, id);
    await page.focus('#screen');
    let shift = false;
    for (const ch of text) {
      if (US[ch].shift !== shift) { shift = US[ch].shift; await (shift ? page.keyboard.down('Shift') : page.keyboard.up('Shift')); }
      await page.keyboard.press(US[ch].code);
    }
    if (shift) await page.keyboard.up('Shift');
    const want = expectedCodes(text);
    const screen = () => page.evaluate((n) => { const m = window.emu.machine; return [...m.ram.slice(m.profile.textScreen || 0x400, (m.profile.textScreen || 0x400) + n)]; }, want.length + 1);
    await waitFor(page, (n) => window.emu.session.keys.pending === 0 && window.emu.machine.ram[(window.emu.machine.profile.textScreen || 0x400) + n - 1] !== 0x60, want.length);
    const got = await screen();
    const show = (codes) => codes.map((v) => { const c = v & 0x3F, t = String.fromCharCode(c < 32 ? c + 64 : c); return v & 0x40 ? t : `[${t}]`; }).join('');
    check(`keyboard symbols (${tag}): ${text.length} characters typed with real key events appear on the screen exactly`,
      got.join() === [...want, 0x60].join(), `got ${show(got)}`);
    if (shotDir && id === 'coco3') await page.screenshot({ path: path.join(shotDir, 'keyboard-symbols-coco3.png') });
    check(`keyboard symbols (${tag}): no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }
}

async function touchJoystickChecks(browser, base, check) {
  // the panel's geometry and mode, as the page sees it
  const state = (page) => page.evaluate(() => {
    const r = (id) => { const e = document.getElementById(id); const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
    const box = document.getElementById('touchKeys'), screen = r('screen');
    const overlaps = (b) => b.w > 0 && b.h > 0 && !(b.b <= screen.y || b.y >= screen.b || b.r <= screen.x || b.x >= screen.r);
    const parts = ['touchStick', 'touchFire', 'touchStrip', 'tkModeSwitch', 'tkBreak', 'tkClear', 'tkMenu', 'touchFull', 'touchLeft', 'touchRight'].map((id) => [id, r(id), overlaps(r(id))]);
    return {
      // "stick up": joystick mode with the stick's pieces showing (not its ABC press, when the keyboard is)
      shown: !box.hidden, mode: box.dataset.mode,
      stick: box.classList.contains('joystick') && !box.classList.contains('keysonce'), body: document.body.classList.contains('touch-stick'),
      keysOnce: box.classList.contains('keysonce'),
      switchShown: !document.getElementById('tkModeSwitch').hidden, joy: window.emu.machine.joy[0].slice(), fire: window.emu.machine.fire[0],
      clipped: parts.filter(([, , o]) => o).map(([id]) => id), at: Object.fromEntries(parts.map(([id, b]) => [id, [Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)]])),
      screen: [Math.round(screen.x), Math.round(screen.y), Math.round(screen.w), Math.round(screen.h)],
      docFits: document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight + 1,
      noSideScroll: document.documentElement.scrollWidth <= innerWidth,
    };
  });
  // a touch drag on the stick zone, of (dx, dy) px from the point it goes down at: real touch events (one CDP
  // session per page: CDP tracks a touch's state per session, so a second session cannot lift the first's)
  const down = async (cdp, page, id, sel, dx = 0, dy = 0) => {
    const b = await page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x, y: b.y, id, radiusX: 8, radiusY: 8, force: 1 }] });
    if (dx || dy) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: b.x + dx, y: b.y + dy, id, radiusX: 8, radiusY: 8, force: 1 }] });
    await page.waitForTimeout(80);
  };
  const moveTo = async (cdp, page, points) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points.map(([id, x, y]) => ({ x, y, id, radiusX: 8, radiusY: 8, force: 1 })) });
    await page.waitForTimeout(80);
  };
  const endTouch = async (cdp, page, points = []) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: points.map(([id, x, y]) => ({ x, y, id, radiusX: 8, radiusY: 8, force: 1 })) });
    await page.waitForTimeout(80);
  };
  const centre = (page, sel) => page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, sel);
  const drag = async (cdp, page, dx, dy) => { await down(cdp, page, 1, '#touchStick', dx, dy); return page.evaluate(() => window.emu.machine.joy[0].slice()); };
  const lift = (cdp, page) => endTouch(cdp, page);
  const tapSel = async (cdp, page, sel) => { await down(cdp, page, 2, sel); await endTouch(cdp, page); };
  const setJoy = async (cdp, page) => { await tapSel(cdp, page, '#tkModeSwitch [data-touchmode="joystick"]'); };

  // ---- phone held sideways: the split keyboard in Keys, the stick left / FIRE and strip right in Joystick ----
  {
    const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?machine=dragon64`);
    await started(page);
    await waitFor(page, () => window.emu.machine && !document.getElementById('touchKeys').hidden && document.body.classList.contains('touch-keys'));
    const cdp = await page.context().newCDPSession(page);
    const keys = await state(page);
    check('touch joystick (sideways): Keys mode shows the split keyboard and the Keys | Joystick switch',
      keys.shown && !keys.stick && keys.switchShown && ['touchStick', 'touchFire', 'touchStrip'].every((id) => !keys.at[id][2]),
      JSON.stringify({ mode: keys.mode, switchShown: keys.switchShown, at: keys.at }));
    await setJoy(cdp, page);
    const joy = await state(page);
    check('touch joystick (sideways): Joystick mode puts the stick in the left half and FIRE with the strip on the right',
      joy.stick && joy.body && joy.mode === 'joystick' && joy.at.touchStick[2] > 0 && joy.at.touchStick[0] < joy.screen[0]
      && joy.at.touchFire[2] > 0 && joy.at.touchFire[0] > joy.screen[0] + joy.screen[2] && joy.at.touchStrip[2] > 0,
      JSON.stringify({ at: joy.at, screen: joy.screen }));
    check('touch joystick (sideways): nothing of the panel lies over #screen', joy.clipped.length === 0 && joy.docFits, JSON.stringify({ clipped: joy.clipped, screen: joy.screen }));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'touch-joystick-landscape.png') });
    // a drag of the full travel radius, and one of half it: the pad formula's values, hand-worked
    const right = await drag(cdp, page, 56, 0);
    check('touch joystick: a drag of the travel radius drives the right end', right[0] === 63 && right[1] === 32, `${right}`);
    await lift(cdp, page);
    const up = await drag(cdp, page, 0, -56);
    check('touch joystick: up the screen is the machine\'s up', up[1] === 0 && up[0] === 32, `${up}`);
    await lift(cdp, page);
    const half = await drag(cdp, page, 28, 0);
    check('touch joystick: half the travel radius is the axis\'s half', half[0] === 47, `${half}`);   // (0.5+1)/2*63 = 47.25 -> 47
    await lift(cdp, page);
    const centred = await page.evaluate(() => window.emu.machine.joy[0].slice());
    check('touch joystick: lifting the finger centres the stick', centred[0] === 32 && centred[1] === 32, `${centred}`);
    // the small drag stays in the dead zone
    const dead = await drag(cdp, page, 10, 0);
    check('touch joystick: a small drag stays inside the dead zone', dead[0] === 32 && dead[1] === 32, `${dead}`);
    await lift(cdp, page);
    // FIRE held down, and the stick and FIRE at the same time: two fingers, held
    await down(cdp, page, 3, '#touchFire');
    check('touch joystick: FIRE sets the button bit', await page.evaluate(() => window.emu.machine.fire[0]) === true);
    // a second finger on the stick, while FIRE is still down
    const [sx, sy] = await centre(page, '#touchStick');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy, id: 4, radiusX: 8, radiusY: 8, force: 1 }] });
    await moveTo(cdp, page, [[3, sx, sy], [4, sx, sy + 56]]);
    const both = await page.evaluate(() => ({ joy: window.emu.machine.joy[0].slice(), fire: window.emu.machine.fire[0] }));
    check('touch joystick: the stick and FIRE are held at the same time', both.fire === true && both.joy[1] === 63, JSON.stringify(both));
    // lifting the stick's finger alone leaves FIRE down (the two are separate pointers)
    await endTouch(cdp, page, [[4, sx, sy + 56]]);
    check('touch joystick: letting go of the stick leaves FIRE pressed', await page.evaluate(() => window.emu.machine.fire[0]) === true);
    await endTouch(cdp, page);
    check('touch joystick: lifting both centres and drops FIRE', await page.evaluate(() => window.emu.machine.joy[0][0] === 32 && !window.emu.machine.fire[0]));
    // the key strip: Y reaches the matrix, pressed and released
    await page.evaluate(() => { const m = window.emu.machine, set = m.setKey.bind(m); window.pressed = []; m.setKey = (k, d) => { window.pressed.push(`${k}${d ? '+' : '-'}`); return set(k, d); }; });
    await tapSel(cdp, page, '#touchStrip [data-key="Y"]');
    check('touch joystick: the strip\'s Y reaches the machine\'s matrix', await waitFor(page, () => window.pressed.includes('Y+') && window.pressed.includes('Y-')),
      await page.evaluate(() => window.pressed.join()));
    // ABC, ONE FINGER (H1): tap ABC, then tap one key, then the stick comes back -- a touch is implicitly captured
    // by the button it lands on, so the ABC finger's own lift must not end the keyboard before the key is pressed.
    // Sideways the screen has the whole height, so ABC brings back the SPLIT keyboard's halves, down the side
    // columns where the stick and FIRE were -- never a keyboard over the screen.
    await page.evaluate(() => { window.pressed = []; });   // (setKey is already recorded above)
    await tapSel(cdp, page, '#tkAbc');
    const atAbc = await state(page);
    check('touch joystick: ABC brings the split keyboard back, the stick away',
      atAbc.mode === 'joystick' && atAbc.at.touchLeft[2] > 0 && atAbc.at.touchRight[2] > 0
      && atAbc.at.touchStick[2] === 0 && atAbc.at.touchFire[2] === 0 && atAbc.at.touchFull[2] === 0,
      JSON.stringify({ mode: atAbc.mode, stick: atAbc.stick, at: atAbc.at }));
    check('touch joystick: ABC\'s halves lie clear of #screen', atAbc.clipped.length === 0, JSON.stringify({ clipped: atAbc.clipped, screen: atAbc.screen }));
    check('touch joystick: ABC stays after its own tap lifts (one finger can then type a key)', atAbc.keysOnce, JSON.stringify({ keysOnce: atAbc.keysOnce }));
    await tapSel(cdp, page, '#touchLeft [data-key="Q"]');
    check('touch joystick: one finger: the key after ABC reaches the machine',
      await waitFor(page, () => window.pressed.includes('Q+') && window.pressed.includes('Q-')), await page.evaluate(() => window.pressed.join()));
    const back = await state(page);
    check('touch joystick: one finger: after that key the stick is back', back.stick && back.at.touchStick[2] > 0 && !back.keysOnce,
      JSON.stringify({ mode: back.mode, stick: back.stick, keysOnce: back.keysOnce }));
    // the welcome menu's taps never reach it: with the menu on screen and the stick up, a tap on one of the menu's
    // lines must not choose it. The same tap with the keys showing DOES choose (2: the colour demo), so the check
    // below cannot pass on a page whose tap handler is simply broken.
    // the tap the welcome menu listens for; expectLeave waits (in the machine's frames) for the program the key
    // starts to take the menu's place, which is the machine's own pace, not wall time. On the stick page the tap
    // must be ignored, so there is nothing to wait for there: the menu is still up when the check reads it.
    const tapMenuLine = async (page, { expectLeave = false } = {}) => {
      const state = await page.evaluate(() => {
        const s = window.emu.session, r = document.getElementById('screen').getBoundingClientRect();
        document.getElementById('screen').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true,
          clientX: r.left + r.width / 2, clientY: r.top + (24 + 10 * 12 + 6) / 240 * r.height, pointerType: 'touch' }));
        return { stick: document.getElementById('touchKeys').classList.contains('joystick'), before: s.welcomeRunning };
      });
      if (expectLeave) await waitForFrames(page, () => !window.emu.session.welcomeRunning, null, 400);
      else await emuFrames(page, 30);   // a few frames in which a tap wrongly taken would begin its program
      return Object.assign(state, { after: await page.evaluate(() => window.emu.session.welcomeRunning) });
    };
    await page.goto(`${base}?machine=dragon64&touch=joystick`);
    await started(page);
    await waitFor(page, () => window.emu.machine && window.emu.session.welcomeRunning && document.getElementById('touchKeys').classList.contains('joystick'));
    const welcomeTap = await tapMenuLine(page);
    // (with the stick up, the tap is not a menu choice: the menu is still running)
    check('touch joystick: a tap on the welcome menu\'s lines does not choose while the stick is up', welcomeTap.stick && welcomeTap.before && welcomeTap.after === true,
      JSON.stringify(welcomeTap));
    // the control: the same page with the panel on the keys (?touch=keys: the switch was used above, so this
    // machine's remembered mode is joystick), the same tap, and the menu answers it
    await page.goto(`${base}?machine=dragon64&touch=keys`);
    await started(page);
    await waitFor(page, () => window.emu.machine && window.emu.session.welcomeRunning && !document.getElementById('touchKeys').hidden && !document.getElementById('touchKeys').classList.contains('joystick'));
    const controlTap = await tapMenuLine(page, { expectLeave: true });
    check('touch joystick: the same tap on the keys does choose (the check above is not blind)', !controlTap.stick && controlTap.before && controlTap.after === false,
      JSON.stringify(controlTap));
    // the mode is remembered per machine (the switch was used above): a plain visit, reloaded, brings the stick
    // back. Not a reload of the control page: that link's ?touch=keys is for its visit, and a reload is a new one.
    await page.goto(`${base}?machine=dragon64`);
    await started(page);
    await waitFor(page, () => window.emu.machine && !document.getElementById('touchKeys').hidden);
    await page.reload();
    await started(page);
    await waitFor(page, () => !document.getElementById('touchKeys').hidden && document.body.classList.contains('touch-keys'));
    check('touch joystick: the mode survives a reload', await page.evaluate(() => document.getElementById('touchKeys').dataset.mode) === 'joystick'
      && await page.evaluate(() => document.body.classList.contains('touch-stick')));
    // a gamepad arriving: the stick steps down, and says so; disconnecting brings it back
    await page.evaluate(() => {
      const pad = { index: 0, id: 'Mock pad', connected: true, axes: [0, 0], buttons: [{ pressed: false, value: 0 }] };
      navigator.getGamepads = () => [pad, null, null, null];
      window.__padGone = () => { pad.connected = false; navigator.getGamepads = () => [null, null, null, null]; };
      window.dispatchEvent(new Event('gamepadconnected'));
    });
    await page.waitForTimeout(250);
    const g = await state(page);
    check('touch joystick: a gamepad arriving shows the keys (the stick stands down)', !g.stick && g.mode === 'keys', JSON.stringify({ mode: g.mode, stick: g.stick }));
    // one toast, not two: screen.js's "Gamepad connected" is the page's word on it, and the panel adds none of
    // its own (a second, different wording here would be the panel's own toast, and is what this fails on)
    check('touch joystick: one gamepad toast, not two',
      await page.evaluate(() => /^Gamepad connected\.?$/.test(document.getElementById('toastText').textContent.trim())),
      await page.evaluate(() => document.getElementById('toastText').textContent));
    // TWO PADS (M2): one leaving must not bring the stick back while the other is still connected -- that pad
    // overwrites joy[0]/fire[0] every frame, so the stick would be lying about who has the joystick
    await page.evaluate(() => {
      const mk = (index) => ({ index, id: `Mock pad ${index}`, connected: true, axes: [0, 0], buttons: [{ pressed: false, value: 0 }] });
      const padsA = mk(0), padsB = mk(1);
      navigator.getGamepads = () => [padsA, padsB, null, null];
      window.__dropPad0 = () => { padsA.connected = false; navigator.getGamepads = () => [null, padsB, null, null]; };
      window.dispatchEvent(new Event('gamepadconnected'));
    });
    await page.waitForTimeout(200);
    // (the state before the second pad goes: down, and the remembered mode still joystick -- so the check below is
    // about what the disconnect does, not about a stick that was never up)
    const beforeDrop = await page.evaluate(() => ({
      stick: document.getElementById('touchKeys').classList.contains('joystick') && !document.getElementById('touchKeys').classList.contains('keysonce'),
      remembered: window.emu.session.store.get('touchMode.dragon64'),
    }));
    check('touch joystick: two pads: the stick is down and the choice is still joystick',
      !beforeDrop.stick && beforeDrop.remembered === 'joystick', JSON.stringify(beforeDrop));
    await page.evaluate(() => { window.__dropPad0(); window.dispatchEvent(new Event('gamepaddisconnected')); });
    await page.waitForTimeout(200);
    check('touch joystick: one of two pads going leaves the stick down (the other still drives the joystick)',
      !(await state(page)).stick, JSON.stringify({ mode: (await state(page)).mode }));
    // and with the last one gone, the stick comes back (the remembered mode was never overwritten)
    await page.evaluate(() => { window.__padGone(); window.dispatchEvent(new Event('gamepaddisconnected')); });
    await page.waitForTimeout(200);
    check('touch joystick: the last pad going brings the stick back (the mode was not overwritten)',
      await page.evaluate(() => document.getElementById('touchKeys').dataset.mode) === 'joystick');
    // the mouse set as the right joystick must not move the stick while the touch stick is up: a mousemove over
    // the screen (a touch screen with a stylus reports one) leaves the joystick where the finger holds it
    await page.evaluate(() => { document.getElementById('chkJoy').checked = true; document.getElementById('chkJoy').dispatchEvent(new Event('change')); });
    await down(cdp, page, 6, '#touchStick', 56, 0);
    await page.mouse.move(40, 40);
    await page.waitForTimeout(80);
    check('touch joystick: the mouse as the right joystick leaves the stick alone while it is held',
      await page.evaluate(() => window.emu.machine.joy[0][0]) === 63, await page.evaluate(() => `${window.emu.machine.joy[0]}`));
    await endTouch(cdp, page);
    await page.evaluate(() => { document.getElementById('chkJoy').checked = false; document.getElementById('chkJoy').dispatchEvent(new Event('change')); });
    check('touch joystick (sideways): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- upright: the switch, then the strip, the stick and FIRE, then the buttons, all under the screen ----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?machine=dragon64&touch=joystick`);
    await started(page);
    await waitFor(page, () => !document.getElementById('touchKeys').hidden && document.getElementById('touchKeys').dataset.mode === 'joystick');
    const s = await state(page);
    check('touch joystick (upright): ?touch=joystick opens in Joystick mode', s.stick && s.mode === 'joystick', JSON.stringify({ mode: s.mode, stick: s.stick }));
    // the link's mode is for this visit: the choice the switch remembers is untouched, so the next plain visit
    // to this machine starts on the keys
    check('touch joystick: ?touch= is not written to the remembered mode', await page.evaluate(() => window.emu.session.store.get('touchMode.dragon64')) === null,
      await page.evaluate(() => String(window.emu.session.store.get('touchMode.dragon64'))));
    check('touch joystick (upright): the stick and FIRE are under the screen, side by side, the strip above them',
      s.at.touchStick[2] > 0 && s.at.touchStick[1] >= s.screen[1] + s.screen[3] && s.at.touchFire[2] > 0 && s.at.touchFire[0] >= s.at.touchStick[0] + s.at.touchStick[2] - 1
      && s.at.touchStrip[1] <= s.at.touchStick[1], JSON.stringify({ at: s.at, screen: s.screen }));
    check('touch joystick (upright): nothing lies over #screen', s.clipped.length === 0, JSON.stringify({ clipped: s.clipped, screen: s.screen }));
    check('touch joystick (upright): the panel fits the width without sideways scrolling', s.noSideScroll, JSON.stringify({ noSideScroll: s.noSideScroll }));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'touch-joystick-portrait.png'), fullPage: true });
    const cdp = await page.context().newCDPSession(page);
    const d = await drag(cdp, page, 0, 56);
    check('touch joystick (upright): a drag down the screen drives 63 on Y', d[1] === 63, `${d}`);
    await lift(cdp, page);
    // ABC upright (H2): the strip shares the keyboard's grid row in this mode, so while ABC is up the strip, the
    // stick and FIRE are hidden; every key must be the element at its own centre, and a tap must type it. One
    // finger throughout: tap ABC, then tap keys.
    await page.evaluate(() => { const m = window.emu.machine, f = m.setKey.bind(m); window.pressed = []; m.setKey = (k, d) => { window.pressed.push(`${k}${d ? '+' : '-'}`); return f(k, d); }; });
    await tapSel(cdp, page, '#tkAbc');
    // the switch ends ABC: tapping Joystick while the keyboard is up must leave the panel showing what the
    // switch says (a panel in ABC's keyboard with its switch hidden is the mismatch this guards)
    await tapSel(cdp, page, '#tkModeSwitch [data-touchmode="joystick"]');
    const afterSwitch = await state(page);
    check('touch joystick (upright): the switch tapped during ABC ends it and shows the stick',
      afterSwitch.stick && !afterSwitch.keysOnce, JSON.stringify({ stick: afterSwitch.stick, keysOnce: afterSwitch.keysOnce }));
    await tapSel(cdp, page, '#tkAbc');
    const upAbc = await page.evaluate(() => {
      const keys = [...document.querySelectorAll('#touchFull .tk')];
      const hidden = (id) => { const e = document.getElementById(id); return e.getBoundingClientRect().width === 0; };
      const covered = keys.filter((k) => { const r = k.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !(at === k || k.contains(at)); })
        .map((k) => k.dataset.key);
      return { keys: keys.length, covered, strip: hidden('touchStrip'), stick: hidden('touchStick'), fire: hidden('touchFire'), keyboard: keys.filter((k) => k.getBoundingClientRect().width > 0).length };
    });
    check('touch joystick (upright): with ABC up the strip, the stick and FIRE are hidden and no key is covered',
      upAbc.keyboard === 49 && upAbc.covered.length === 0 && upAbc.strip && upAbc.stick && upAbc.fire, JSON.stringify(upAbc));
    await tapSel(cdp, page, '#touchFull [data-key="Q"]');
    check('touch joystick (upright): one finger: a key tapped after ABC reaches the machine, and the stick returns',
      await waitFor(page, () => window.pressed.includes('Q+') && window.pressed.includes('Q-')) && (await state(page)).stick,
      await page.evaluate(() => window.pressed.join()));
    check('touch joystick (upright): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- a tablet: the same arrangement, the switch offered, nothing over the screen ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(`${base}?machine=coco3&touch=joystick`);
    await started(page);
    await waitFor(page, () => !document.getElementById('touchKeys').hidden && document.getElementById('touchKeys').dataset.mode === 'joystick');
    const s = await state(page);
    check('touch joystick (tablet): the switch is offered and the stick shows', s.switchShown && s.stick && s.at.touchStick[2] > 0, JSON.stringify({ switchShown: s.switchShown, stick: s.stick }));
    // LOW: while the stick is not up the joystick is the mouse's (or the keyboard joystick's): an apply() that
    // changes nothing about the stick must leave both joy[0] and fire[0] as they are, not recentre them
    // (the panel is the page's own object, not on window.emu: the Input tab's setting calls its apply(), so a
    // change event on that select is the way to make it apply() with the stick in whatever state is set here)
    // The Keys switch first: the stick must really be DOWN (the check this replaces ran with it up, so the
    // stickWas guard could be deleted and it stayed green).
    await page.locator('#tkModeSwitch [data-touchmode="keys"]').click();
    await waitFor(page, () => !document.getElementById('touchKeys').classList.contains('joystick'));
    const kept = await page.evaluate(() => {
      const m = window.emu.machine;
      const sel = document.getElementById('selTouchKeys'), was = sel.value;
      const stickUp = document.getElementById('touchKeys').classList.contains('joystick');
      sel.value = was === 'on' ? 'auto' : 'on';
      m.joy[0][0] = 5; m.joy[0][1] = 60; m.fire[0] = true;
      sel.dispatchEvent(new Event('change'));
      sel.value = was; sel.dispatchEvent(new Event('change'));
      const after = { stickUp, joy: m.joy[0].slice(), fire: m.fire[0] };
      sel.value = was;
      return after;
    });
    check('touch joystick: with the stick down, apply() leaves a joystick held elsewhere alone',
      kept.stickUp === false && kept.joy[0] === 5 && kept.joy[1] === 60 && kept.fire === true, JSON.stringify(kept));
    // The complement of that: when the stick IS up and goes down through apply() alone, it does let go. Hide keys
    // is the vehicle -- apply(), not setMode (which releases directly) and not a gamepad (whose frames recentre
    // joy[0] by themselves). This is a release-happens check; the guard itself is what the case above kills.
    await page.locator('#tkModeSwitch [data-touchmode="joystick"]').click();
    await waitFor(page, () => document.getElementById('touchKeys').classList.contains('joystick'));
    const released = await page.evaluate(() => {
      const m = window.emu.machine;
      m.joy[0][0] = 5; m.joy[0][1] = 60; m.fire[0] = true;
      document.getElementById('tkMenu').click();
      document.querySelector('#tkMenuSheet [data-item="hide"]').click();
      return { joy: m.joy[0].slice(), fire: m.fire[0], hidden: document.getElementById('touchKeys').hidden };
    });
    check('touch joystick: hiding the panel with the stick up lets go of what it was holding',
      released.hidden === true && released.joy[0] === 32 && released.joy[1] === 32 && released.fire === false, JSON.stringify(released));
    await page.locator('#btnShowKeys').click();
    check('touch joystick (tablet): nothing lies over #screen', s.clipped.length === 0, JSON.stringify({ clipped: s.clipped, screen: s.screen }));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'touch-joystick-tablet.png'), fullPage: true });
    await ctx.close();
  }

  // ---- a mouse and ABC (MED): a mouse is ALWAYS pointer id 1, so an ABC guard that remembers the ABC press's
  // id for the whole of ABC swallows every click after it and ABC never ends. Keys mode -> Joystick, click ABC,
  // then click a key with the same mouse: it must type, and the stick must come back.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?machine=dragon64`);
    await started(page);
    await waitFor(page, () => window.emu.machine && !document.getElementById('touchKeys').hidden);
    await openTab(page, 'Input');
    await page.selectOption('#selTouchKeys', 'on');
    await page.locator('#tkModeSwitch [data-touchmode="joystick"]').click();
    await waitFor(page, () => document.getElementById('touchKeys').classList.contains('joystick'));
    await page.evaluate(() => { const m = window.emu.machine, f = m.setKey.bind(m); window.pressed = []; m.setKey = (k, d) => { window.pressed.push(`${k}${d ? '+' : '-'}`); return f(k, d); }; });
    await page.click('#tkAbc');
    const abcUp = await page.evaluate(() => document.getElementById('touchKeys').classList.contains('keysonce'));
    await page.click('#touchFull [data-key="Q"]');
    // the key goes through the KeyQueue, which applies it at a frame start: wait for it, don't read at once
    await waitFor(page, () => window.pressed.includes('Q+') && window.pressed.includes('Q-'));
    const mouse = await page.evaluate(() => ({ pressed: window.pressed.join(), keysOnce: document.getElementById('touchKeys').classList.contains('keysonce'),
      stick: document.getElementById('touchKeys').classList.contains('joystick') }));
    check('touch joystick (mouse): ABC from the mouse, then a key clicked with the same pointer types it and ends ABC',
      abcUp && mouse.pressed.includes('Q+') && mouse.pressed.includes('Q-') && mouse.keysOnce === false && mouse.stick === true,
      JSON.stringify({ abcUp, mouse }));
    check('touch joystick (mouse): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }
  // ---- the machine-swap release (LOW): only a stick the panel was showing is let go of; a joystick the mouse or
  // the keyboard joystick drives is the host's and must not be recentred by a switch ----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(`${base}?machine=dragon64&touch=joystick`);
    await started(page);
    await waitFor(page, () => !document.getElementById('touchKeys').hidden && document.getElementById('touchKeys').classList.contains('joystick'));
    // A real switchMachine builds a NEW machine (its joystick starts centred whichever path runs), so the panel's
    // handler is driven the way a switch drives it -- the session's 'machine' event -- with the same machine, so
    // what is observed is only what the handler does.
    // keys mode: a joystick held elsewhere must survive the event
    await page.locator('#tkModeSwitch [data-touchmode="keys"]').click();
    await waitFor(page, () => !document.getElementById('touchKeys').classList.contains('joystick'));
    const keptSwap = await page.evaluate(() => {
      const s = window.emu.session;
      s.machine.joy[0][0] = 5; s.machine.joy[0][1] = 60; s.machine.fire[0] = true;
      s.emit('machine');
      return { joy: s.machine.joy[0].slice(), fire: s.machine.fire[0] };
    });
    check('touch joystick: a machine event leaves a joystick the panel was not driving alone',
      keptSwap.joy[0] === 5 && keptSwap.joy[1] === 60 && keptSwap.fire === true, JSON.stringify(keptSwap));
    // and the inverse: the panel's stick up, the same event -> let go of
    await page.locator('#tkModeSwitch [data-touchmode="joystick"]').click();
    await waitFor(page, () => document.getElementById('touchKeys').classList.contains('joystick'));
    const releasedSwap = await page.evaluate(() => {
      const s = window.emu.session;
      s.machine.joy[0][0] = 5; s.machine.joy[0][1] = 60; s.machine.fire[0] = true;
      s.emit('machine');
      return { joy: s.machine.joy[0].slice(), fire: s.machine.fire[0] };
    });
    check('touch joystick: a machine event with the stick up lets go of it',
      releasedSwap.joy[0] === 32 && releasedSwap.joy[1] === 32 && releasedSwap.fire === false, JSON.stringify(releasedSwap));
    await ctx.close();
  }
  // ---- FIRE's window fallback (LOW): if the capture is refused and the finger lifts outside the button, no
  // pointerup reaches FIRE; the window's own release is the way out, and only FIRE's pointer may use it ----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(`${base}?machine=dragon64&touch=joystick`);
    await started(page);
    await waitFor(page, () => !document.getElementById('touchKeys').hidden && document.getElementById('touchKeys').classList.contains('joystick'));
    // A touch has IMPLICIT capture whatever setPointerCapture does, so its pointerup always reaches FIRE and would
    // not exercise the fallback. A MOUSE has none: with explicit capture refused, a press on FIRE and a release
    // over the screen sends the pointerup to the screen, and only the window's own listener can let go.
    await page.evaluate(() => { Element.prototype.setPointerCapture = function () { throw new Error('no capture'); }; });
    const fb = await page.evaluate(() => { const r = document.getElementById('touchFire').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    await page.mouse.move(fb[0], fb[1]);
    await page.mouse.down();
    await page.waitForTimeout(80);
    const down = await page.evaluate(() => window.emu.machine.fire[0]);
    await page.mouse.move(5, 5);     // off FIRE, onto the page
    await page.mouse.up();
    await page.waitForTimeout(120);
    const up = await page.evaluate(() => window.emu.machine.fire[0]);
    check('touch joystick: FIRE lets go when its capture is refused and the button is released away from it', down === true && up === false, JSON.stringify({ down, up }));
    await ctx.close();
  }
  // ---- the MC-10: no switch (no joystick port), and Keys mode only ----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(`${base}?machine=mc10&touch=joystick`);
    await started(page);
    await waitFor(page, () => !document.getElementById('touchKeys').hidden && document.body.classList.contains('touch-keys'));
    const s = await state(page);
    check('touch joystick: the MC-10 has no switch and no stick (no joystick port)', !s.switchShown && !s.stick && s.at.touchStick[2] === 0,
      JSON.stringify({ switchShown: s.switchShown, stick: s.stick }));
    await ctx.close();
  }
  // and ?touch= is not for embeds (js/config.js): an embedded page has no panel to set
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const said = [];
    await page.goto(`${base}?embed=1&machine=dragon64&touch=joystick`);
    await started(page);
    await waitFor(page, () => window.emu.linkDone);
    const msg = await page.evaluate(() => window.emu.feedback.pending.map((m) => m.text).join('\n') + '\n' + document.getElementById('toastText').textContent);
    said.push(msg);
    check('touch joystick: an embed is told touch= does not apply', /touch=joystick: an embedded page has no on-screen panel/.test(said.join('\n')), said.join('|').slice(0, 300));
    await ctx.close();
  }
}

// the phone screen and its touch behaviour: the on-screen keyboard shows by
// itself on a touch screen (split for the thumbs on a phone held sideways, ten columns in portrait) and types
// into the machine, SHIFT included; the Input tab's setting; Hide keys; the welcome menu's lines answer taps;
// the whole page is the drop target; the browser is asked to keep the ROMs, and the page says what it answered
async function inputScreenChecks(browser, base, check) {
  const stubText = (page) => page.evaluate(() => window.emu.session.screenText().join('\n'));
  // ---- a phone held sideways ----
  {
    const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?machine=dragon64`);
    await waitFor(page, () => window.emu && window.emu.ready && window.emu.machine);
    await stubPrompt(page);   // the stub's prompt echoes what is typed (the welcome menu would take the digit)
    const lay = await page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      const keys = document.getElementById('touchKeys'), l = r('touchLeft'), rt = r('touchRight'), s = r('screen');
      return { coarse: matchMedia('(pointer: coarse)').matches, shown: !keys.hidden, split: l.width > 0 && rt.width > 0 && r('touchFull').height === 0,
        between: s.left >= l.right - 1 && s.right <= rt.left + 1 && s.width > 150, fits: document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight + 1,
        keyH: document.querySelector('#touchLeft .tk').getBoundingClientRect().height, header: getComputedStyle(document.querySelector('.appbar')).display };
    });
    check('touch keys (phone, sideways): shown by themselves, split for the thumbs with the screen between, the page fits the screen',
      lay.coarse && lay.shown && lay.split && lay.between && lay.fits && lay.keyH >= 44 && lay.header === 'none', JSON.stringify(lay));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'touch-keys-landscape.png') });
    // typing on the stub: P R I N T, SHIFT 1 (!), ENTER
    for (const k of ['P', 'R', 'I', 'N', 'T']) await page.tap(`#touchLeft [data-key="${k}"], #touchRight [data-key="${k}"]`);
    await page.tap('#touchLeft [data-key="SHIFT"]');
    await page.tap('#touchLeft [data-key="1"]');
    check('touch keys: taps type into the machine, SHIFT shifts the next key', await waitFor(page, () => /PRINT!/.test(window.emu.session.screenText().join('\n'))), (await stubText(page)).split('\n').slice(4, 10).join('|'));
    check('touch keys: SHIFT lets go after one key', await page.getAttribute('#touchLeft [data-key="SHIFT"]', 'aria-pressed') === 'false');
    // the matrix: a tap holds the key long enough to be seen, then lets it go
    await page.evaluate(() => { const m = window.emu.machine, set = m.setKey.bind(m); window.pressed = []; m.setKey = (k, d) => { window.pressed.push(`${k}${d ? '+' : '-'}`); return set(k, d); }; });
    await page.tap('#touchRight [data-key="ENTER"]');
    await page.tap('#tkBreak');
    check('touch keys: ENTER and BREAK reach the matrix, pressed and released', await waitFor(page, () => ['ENTER+', 'ENTER-', 'BREAK+', 'BREAK-'].every((k) => window.pressed.includes(k))),
      await page.evaluate(() => window.pressed.join()));
    await page.tap('#tkMenu');
    await page.tap('#tkMenuSheet [data-item="hide"]');
    check('touch keys: Hide keys (Menu) hides them and offers Keys to bring them back', await page.isHidden('#touchKeys') && await page.isVisible('#btnShowKeys'));
    await page.tap('#btnShowKeys');
    check('touch keys: Keys brings them back', await page.isVisible('#touchKeys'));
    check('touch keys (sideways): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }
  // ---- portrait: ten columns; LIZA by taps ----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?machine=dragon64&start=liza`);
    await waitFor(page, () => window.emu && window.emu.session.screenText().join('').includes('I AM LIZA'));
    const lay = await page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      return { full: r('touchFull').height > 0 && r('touchLeft').width === 0, below: r('touchFull').top >= r('screen').bottom, fits: document.documentElement.scrollWidth <= innerWidth,
        cols: document.querySelector('#touchFull .tkrow').children.length, buttons: ['tkBreak', 'tkClear', 'tkMenu'].every((id) => r(id).height >= 44 && r(id).top >= r('touchFull').bottom),
        // the brief: in portrait the Keys | Joystick switch sits ABOVE the keys (the brief's "above the keys";
        // sideways it is in the strip with BREAK, CLEAR and Menu)
        switchShown: r('tkModeSwitch').height > 0 && r('tkModeSwitch').bottom <= r('touchFull').top && r('tkModeSwitch').top >= r('screen').bottom };
    });
    check('touch keys (phone, portrait): ten columns under the screen, the Keys | Joystick switch above the keys, no sideways scrolling',
      lay.full && lay.below && lay.fits && lay.cols === 10 && lay.buttons && lay.switchShown, JSON.stringify(lay));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'touch-keys-portrait.png'), fullPage: true });
    for (const ch of 'I AM SAD') await page.tap(`#touchFull [data-key="${ch === ' ' ? 'SPACE' : ch}"]`);
    await page.tap('#touchFull [data-key="ENTER"]');
    check('touch keys: LIZA answers what was tapped', await waitFor(page, () => /HOW LONG HAVE YOU BEEN SAD/.test(window.emu.session.screenText().join('\n'))), (await stubText(page)).split('\n').slice(4, 9).join('|'));
    check('touch keys (portrait): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }
  // ---- desktop: hidden unless asked; the setting is remembered ----
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}?machine=coco`);
    await waitFor(page, () => window.emu && window.emu.ready && window.emu.machine);
    check('touch keys: not shown on a mouse-and-keyboard computer', await page.isHidden('#touchKeys') && await page.isHidden('#btnShowKeys'));
    await openTab(page, 'Input');
    await page.selectOption('#selTouchKeys', 'on');
    check('touch keys: Input tab → Always shows them', await page.isVisible('#touchKeys') && await page.isVisible('#touchFull'));
    await page.reload();
    await waitFor(page, () => window.emu && window.emu.ready && window.emu.machine);
    check('touch keys: the setting is remembered', await page.isVisible('#touchKeys'));
    await openTab(page, 'Input');
    await page.selectOption('#selTouchKeys', 'off');
    check('touch keys: Never hides them', await page.isHidden('#touchKeys') && await page.isHidden('#btnShowKeys'));
    await ctx.close();
  }
  // ---- the welcome menu by taps ----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await page.goto(base);
    await waitFor(page, () => window.emu && window.emu.session.welcomeRunning && window.emu.session.screenText()[14].includes('PRESS 1 TO 4'));
    await page.tap('#screen', { position: { x: 5, y: 5 } });                      // unlocks sound: the tune plays first
    await waitFor(page, () => window.emu.machine.ram[0x6005] === 1, null, 20000);
    // the "2 COLOUR AND SOUND" line: text row 10, lines 144..155 of the 240-line frame
    const at = await page.evaluate(() => { const r = document.getElementById('screen').getBoundingClientRect(); return { x: r.width / 2, y: (24 + 10 * 12 + 6) / 240 * r.height }; });
    await page.tap('#screen', { position: at });
    // (said: shown, or on a phone waiting for room in the toast's queue: a toast never covers the screen's text)
    check('welcome: tapping a menu line chooses it (2: the colour demo)', await waitFor(page, () => window.emu.feedback.pending.some((m) => /Colour demo/.test(m.text)) && !window.emu.session.welcomeRunning),
      JSON.stringify(await page.evaluate(() => window.emu.feedback.pending)));
    await ctx.close();
  }
  // ---- on a 390 px phone the welcome menu is answered by typing: the
  // keyboard is there on a first visit with nothing to press, no hint covers the screen, and a typed 2 takes effect ----
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await waitFor(page, () => window.emu && window.emu.session.welcomeRunning && window.emu.session.screenText()[14].includes('PRESS 1 TO 4'));
    const first = await page.evaluate(() => {
      const r = (el) => el.getBoundingClientRect(), s = r(document.getElementById('screen'));
      const covers = (id) => { const el = document.getElementById(id); if (el.hidden || getComputedStyle(el).display === 'none') return false; const b = r(el); return b.bottom > s.top && b.top < s.bottom && b.width > 0; };
      const key = document.querySelector('#touchFull [data-key="2"]');
      // BREAK, CLEAR and Menu on screen as the page opens, with the keys: no scrolling to reach them
      const visible = (id) => { const b = r(document.getElementById(id)); return b.height >= 44 && b.top >= 0 && b.bottom <= innerHeight; };
      return { keys: !document.getElementById('touchKeys').hidden && !!key && r(key).height >= 44 && r(key).bottom <= innerHeight,
        controls: ['tkBreak', 'tkClear', 'tkMenu'].every(visible), soundHint: covers('soundHint'), keyHint: covers('keyHint') };
    });
    check('PHONE-1 (390 px): on a first visit the on-screen keyboard is there, and no hint covers the screen', first.keys && !first.soundHint && !first.keyHint, JSON.stringify(first));
    check('PHONE-1 (390 px, portrait): BREAK, CLEAR and Menu are on screen with the keys, no scrolling', first.controls, JSON.stringify(first));
    // every message the page says from here (a toast goes after its seconds; the colour demo's can come and go
    // while the check waits for the tune)
    await page.evaluate(() => { window.__said = []; const t = document.getElementById('toastText');
      new MutationObserver(() => { if (t.textContent) window.__said.push(t.textContent); }).observe(t, { childList: true, characterData: true, subtree: true }); });
    // The first tap unlocks sound and is also a key: the menu plays its tune first when the unlock reaches it before
    // the key does, and otherwise takes the 2 at once (seen with a warm cache: the colour demo started on the first
    // tap and the tune never played). Either is the menu answering; a second 2 is typed only while it is still up.
    await page.tap('#touchFull [data-key="2"]');
    await waitFor(page, () => window.emu.machine.ram[0x6005] === 1 || !window.emu.session.welcomeRunning, null, 20000);
    if (await page.evaluate(() => window.emu.session.welcomeRunning)) await page.tap('#touchFull [data-key="2"]');
    check('PHONE-1 (390 px): typing 2 on the on-screen keyboard answers the menu (the colour demo starts)', await waitFor(page, () => (window.__said.some((m) => /Colour demo/.test(m))
      || window.emu.feedback.pending.some((m) => /Colour demo/.test(m.text))) && !window.emu.session.welcomeRunning), JSON.stringify(await page.evaluate(() => [window.__said, window.emu.feedback.pending])));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'phone-welcome.png') });
    check('PHONE-1: no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }
  // ---- the whole page is the drop target; the browser keeps the ROMs ----
  for (const granted of [true, false]) {
    const ctx = await browser.newContext();
    await ctx.addInitScript((g) => {
      Object.defineProperty(navigator.storage, 'persisted', { value: async () => false, configurable: true });
      Object.defineProperty(navigator.storage, 'persist', { value: async () => { window.persistAsked = (window.persistAsked || 0) + 1; return g; }, configurable: true });
    }, granted);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?machine=coco`);
    await waitFor(page, () => window.emu && window.emu.ready && window.emu.machine);
    if (granted) {
      // files dragged over the page's footer: the overlay; dropped there: loaded, and the overlay goes
      const over = await page.evaluate(async (bytes) => {
        const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(bytes)], 'demo.bin'));
        const at = document.querySelector('footer');
        at.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        const shown = !document.getElementById('dropOverlay').hidden;
        const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
        at.dispatchEvent(ev);
        return { shown, prevented: ev.defaultPrevented };
      }, [...fs.readFileSync(path.join(ROOT, 'examples/demo.bin'))]);
      check('drop: files over any part of the page show "Drop to load"; dropped there they load, and the page stays',
        over.shown && over.prevented && await waitFor(page, () => /demo\.bin/.test(document.getElementById('mediaOffer').textContent + document.getElementById('toast').textContent))
        && await page.isHidden('#dropOverlay'), JSON.stringify(over));
    }
    // every message shown is recorded, so a slow runner can't miss one that came and went before it looked
    await page.evaluate(() => { window.__said = []; const t = document.getElementById('toastText');
      new MutationObserver(() => { if (t.textContent) window.__said.push(t.textContent); }).observe(t, { childList: true, characterData: true, subtree: true }); });
    await dropFiles(page, [['bas12.rom', fake(8192, 61)]]);
    const said = granted ? /Your ROMs are kept in this browser\./ : /This browser may clear them when space runs low: Save ROM pack… keeps a copy\./;
    check(`ROMs: the browser is asked to keep them, once, and the page says it ${granted ? 'will' : 'may not'}`, await waitFor(page, (s) => window.__said.concat(window.emu.feedback.pending.map((m) => m.text)).some((m) => new RegExp(s).test(m)), said.source)
      && await page.evaluate(() => window.persistAsked) === 1, JSON.stringify(await page.evaluate(() => [window.__said, window.emu.feedback.pending])));
    check('drop and ROMs: no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }
}

// ---------------- links, embedding, offline, settings files ----------------
// files at another host for the link parameters (served by a route, with CORS as a real host must)
async function filesHost(ctx) {
  const { csaveStream } = require('./mame-diff/tape/spec.js');
  const files = {
    'demo.bin': fs.readFileSync(path.join(ROOT, 'examples/demo.bin')),
    'game.cas': Buffer.from(csaveStream()),
    'pak.ccc': (() => { const b = Buffer.alloc(0x2000, 0x12); b[0] = 0x20; b[1] = 0xFE; return b; })(),   // BRA * at $C000
    'bas12.rom': fake(8192, 71),                                                                          // synthetic, never a real ROM
  };
  await ctx.route('https://files.example/**', (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (!files[name]) return route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
    return route.fulfill({ status: 200, body: files[name], headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/octet-stream' } });
  });
}
// every URL parameter (js/config.js) through the page
async function urlChecks(browser, base, check) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await filesHost(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const open = async (q) => { await page.goto(`${base}${q}`); return waitFor(page, () => window.emu && window.emu.linkDone, null, 10000); };
  const msg = () => page.textContent('#toast');
  const ev = (fn, arg) => page.evaluate(fn, arg);

  await open('?machine=coco3&cpu=6809&ram=512');
  check('link: machine=, cpu= and ram= (profile.options)', await ev(() => window.emu.machine.id === 'coco3' && window.emu.machine.config.ram === 512 && window.emu.machine.config.cpu === '6809'));
  await open('?machine=coco3&ram=48&foo=1');
  check('link: a RAM size the model hasn\'t, and an unknown parameter, are reported; the rest applies',
    await ev(() => window.emu.machine.id === 'coco3') && /ram=48: the CoCo 3 has 128K or 512K/.test(await msg()) && /foo: not a CLOADM setting/.test(await msg())
    && await ev(() => document.getElementById('toast').classList.contains('error')), await msg());
  await open('?machine=coco&becker=true');
  check('link: a yes/no option (becker=true) is taken, no error', await ev(() => window.emu.machine.config.becker === true && !document.getElementById('toast').classList.contains('error')), await msg());
  await open('?machine=coco&becker=0');
  check('link: becker=0 turns it off', await ev(() => window.emu.machine.config.becker === false), await msg());
  await open('?machine=zx81');
  check('link: an unknown machine is reported, the page still runs', /machine=zx81: no such machine/.test(await msg()) && await ev(() => !!window.emu.machine.id), await msg());
  // R8: the error names the machines as the picker shows them (never their ids), and app= / start= say what to try
  {
    const m = await msg();
    await page.click('#machineBtn');
    const names = await ev(() => [...document.querySelectorAll('#machineMenu button[data-machine] > span:first-child')].map((n) => n.textContent));
    await page.keyboard.press('Escape');
    check('link: the unknown-machine error lists the machine picker\'s display names, not ids', names.length > 5 && names.every((n) => m.includes(n)) && !/dragon64|coco3|mc10/.test(m), JSON.stringify({ names, m }));
  }
  await open('?app=bogus');
  check('link: app=bogus: "isn\'t something CLOADM has (try app=claude)"', (await msg()).includes("app=bogus isn't something CLOADM has (try app=claude)") && await ev(() => !!window.emu.machine.id), await msg());
  await open('?start=bogus');
  check('link: start=bogus says what to try', (await msg()).includes("start=bogus isn't something CLOADM has (try start=welcome or start=liza)"), await msg());
  // a file at a host that doesn't allow other sites (no CORS header) fails in fetch with a TypeError: plain words, not "Failed to fetch"
  await ctx.route('https://nocors.example/**', (route) => route.abort('failed'));   // what the browser's fetch gives for a cross-origin refusal (Playwright's fulfill adds CORS headers itself, so abort stands in): a TypeError
  await open('?machine=dragon64&load=https://nocors.example/demo.bin');
  check('link: a cross-origin load= the site doesn\'t allow says so in plain words (not "Failed to fetch")',
    /Could not load load=https:\/\/nocors\.example\/demo\.bin: Couldn't download it: the site may not allow other sites to load its files\./.test(await msg()) && !/Failed to fetch/.test(await msg()), await msg());

  await open('?machine=dragon64&load=https://files.example/demo.bin');
  check('link: load= fetches a program and runs it', await waitFor(page, () => /demo\.bin/.test(document.getElementById('toast').textContent) && window.emu.machine.cpu.pc >= 0x4000), await msg());
  await open('?machine=dragon64&tape=https://files.example/game.cas');
  check('link: tape= puts the tape in the deck, without running it', await waitFor(page, () => document.getElementById('tapeName').textContent === 'game.cas')
    && /Tape game\.cas inserted/.test(await msg()), await msg());
  await open('?machine=dragon64&tape=https://files.example/game.cas&autorun');
  check('link: tape= with autorun loads and runs it', /game\.cas: CLOADM fast-loaded/.test(await msg()), await msg());
  await open('?machine=coco&cart=https://files.example/pak.ccc');
  check('link: cart= plugs in a cartridge, which starts', await waitFor(page, () => window.emu.machine.cpu.pc === 0xC000) && /pak\.ccc: Program Pak inserted, running at \$C000/.test(await msg()), await msg());
  await open('?machine=coco&load=https://files.example/missing.bin');
  check('link: a file that can\'t be fetched is reported', /Could not load load=https:\/\/files\.example\/missing\.bin: .*HTTP 404/.test(await msg()), await msg());

  await open('?machine=coco&display=sharp&phase=2&aspect=fill&integer=1&curvature=0&glow=100');
  const d = await ev(() => Object.assign({}, window.emu.session.display));
  check('link: display=, phase=, aspect=, integer=, curvature=, glow= are in force', JSON.stringify(d) === JSON.stringify({ view: 'sharp', phase: 2, curvature: 0, glow: 100, integer: true, aspect: 'fill', screen: 'main' })
    && !(await ev(() => document.getElementById('monitor').classList.contains('crt'))), JSON.stringify(d));
  await open('?machine=coco');
  check('link: display settings hold for that visit only (not stored)', await ev(() => window.emu.session.display.view === 'crt' && localStorage.getItem('display.settings') === null));
  await open('?machine=coco&joy=mouse&sound=0&fasttape=0&turbo=1');
  check('link: joy=mouse, sound=0, fasttape=0, turbo=1 set the controls', await ev(() => document.getElementById('chkJoy').checked && !document.getElementById('chkSound').checked
    && !document.getElementById('chkFastTape').checked && !window.emu.session.fastTape && window.emu.session.turbo && document.getElementById('btnTurbo').classList.contains('active')));
  // joy=off is the other value the link accepts (js/config.js: mouse or off). The checkbox alone cannot prove it:
  // it has no `checked` attribute, so it starts off, and a parser that ignored "off" would leave it off too - the
  // first version of this case passed with ?joy=off silently dropped. So the assertion is on the PARSED value,
  // read through the page's own config module, which is what distinguishes "the link said off" from "nothing
  // said anything". The checkbox is still checked, as the visible result, against joy=mouse in the same run.
  await open('?machine=coco&joy=mouse');
  const joyOn = await ev(async () => ({ checked: document.getElementById('chkJoy').checked,
    parsed: (await import('/js/config.js')).parseUrlConfig(location.search).joy }));
  await open('?machine=coco&joy=off');
  const joyOff = await ev(async () => ({ checked: document.getElementById('chkJoy').checked,
    parsed: (await import('/js/config.js')).parseUrlConfig(location.search).joy,
    error: document.getElementById('toast').className }));
  await open('?machine=coco');
  const joyNone = await ev(async () => ({ checked: document.getElementById('chkJoy').checked,
    parsed: (await import('/js/config.js')).parseUrlConfig(location.search).joy }));
  check('link: joy=off parses to "off" (not null, not an error) and leaves the box off',
    joyOn.checked === true && joyOff.checked === false && joyOff.parsed === 'off' && !/error/.test(joyOff.error)
    && joyNone.parsed === null && joyNone.checked === false, JSON.stringify({ joyOn, joyOff, joyNone }));
  await open('?machine=coco&storage=fallback');
  check('link: storage=fallback picks the download/import store', await ev(() => window.emu.session.media.constructor.name) === 'FallbackMediaStore', await ev(() => window.emu.session.media.constructor.name));
  // rom= from an allowed address (CORS), and selftest=1: the ROM goes in its socket and the self-test runs on it
  await open('?machine=coco&rom=https://files.example/bas12.rom&selftest=1');
  check('link: rom= loads a ROM from an allowed address into the machine\'s socket', await waitFor(page, () => window.emu.session.machineRoms('coco').sockets.some((s) => s.crc)
    && window.emu.machine.hasRom), await page.evaluate(() => window.emu.session.machineRoms('coco').sockets.map((s) => s.status).join()));
  check('link: selftest=1 runs the ROM self-test on it', await waitFor(page, () => !document.getElementById('selftestCard').hidden
    && /ROM self-test: \d+\/\d+ passed/.test(document.getElementById('toast').textContent), null, 60000), await page.textContent('#toast'));
  await open('?machine=dragon64&start=liza');
  check('link: start=liza runs LIZA', await waitFor(page, () => window.emu.session.screenText().join('').includes('I AM LIZA')));
  await open('?machine=dragon64&embed=1');
  check('link: embed=1 shows the screen alone', await ev(() => document.body.classList.contains('embed')) && await page.isHidden('.appbar') && await page.isHidden('.drawer')
    && await ev(() => { const r = document.getElementById('screen').getBoundingClientRect(); return r.width > 300; }));
  if (shotDir) await page.screenshot({ path: path.join(shotDir, 'embed-alone.png') });
  check('links: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

// the embed API: a page on another origin puts /play/?embed=1 in an iframe and drives it with embed/cloadm.js
async function embedChecks(browser, site, check) {
  const host = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><title>A retro blog</title><h1>My blog</h1>
<iframe id="cl" src="${site}play/?embed=1&machine=dragon64" width="640" height="480" allow="gamepad; fullscreen"></iframe>
<iframe id="sib" srcdoc="<p>a sibling<iframe id=nest srcdoc='<p>nested'></iframe>"></iframe>
<script src="${site}embed/cloadm.js"></script>`);
  });
  await new Promise((r) => host.listen(0, '127.0.0.1', r));
  host.unref();   // a group that throws before host.close() must not keep the run from exiting
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${host.address().port}/`);   // another origin than the emulator's
  const r = await page.evaluate(async (liza) => {
    const out = {}, events = [];
    // (the embedded page is still starting: attach asks until it answers; its 15 s default is raised for a loaded machine)
    const m = await CLOADM.attach(document.getElementById('cl'), { timeout: 120000 });
    window.__cloadm = m;
    m.on('loaded', (d) => events.push(`loaded ${d.machine}`)).on('machine', (d) => events.push(`machine ${d.machine}`));
    out.info = await m.info();
    // a condition wait; the limit only stops a page that hangs (a loaded machine runs the emulator slower)
    const until = async (fn, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((ok) => setTimeout(ok, 50)); } return false; };
    // embedded, no welcome menu of its own: not on load, nor after reset, powerCycle or switchMachine.
    // Each waits long enough for a menu the page might start (it fetches its bytes first) to show up: 1.5 s, and at
    // least 60 emulated frames, so a page slowed by load gets as many frames to (wrongly) show it as an idle one.
    let ran = 0;
    m.on('frame', () => ran++);
    const settle = async () => { const t = Date.now(), f0 = ran; out.settled = (out.settled || 0) + (await until(() => Date.now() - t >= 1500 && ran - f0 >= 60) ? 1 : 0); };
    const menuShown = async () => (await m.screenText()).join('').includes('TALK TO LIZA');
    await settle();
    out.menu = { load: await menuShown() };
    await m.reset(); await settle(); out.menu.reset = await menuShown();
    await m.powerCycle(); await settle(); out.menu.powerCycle = await menuShown();
    await m.switchMachine('coco'); await settle(); out.menu.switchMachine = await menuShown();
    out.menu.stub = (await m.screenText()).join('').includes('NO ROM LOADED');
    await m.switchMachine('dragon64'); await settle();
    out.load = await m.load('liza.bin', liza);
    out.greeted = await until(async () => (await m.screenText()).join('').includes('I AM LIZA'));
    out.typed = await m.type('I AM SAD\n');
    out.answered = await until(async () => /HOW LONG HAVE YOU BEEN SAD/.test((await m.screenText()).join('\n')));
    out.poke = await m.poke(0x5000, [7, 8, 9]);
    out.peek = await m.peek(0x5000, 3);
    let frames = 0;
    m.on('frame', () => frames++);
    out.frames = await until(async () => frames >= 10);
    try { await m.peek(70000); out.error = null; } catch (e) { out.error = e.message; }
    // a sibling frame, and a frame nested in it, send calls to the emulator: it takes calls from its parent only
    const cl = document.getElementById('cl').contentWindow, sib = document.getElementById('sib').contentWindow;
    const nest = sib.document.getElementById('nest').contentWindow;
    const answered = [];
    for (const w of [sib, nest]) w.addEventListener('message', (e) => { if (e.data && e.data.cloadm) answered.push(e.data); });
    sib.eval(`parent.frames[0].postMessage({ cloadm: 1, id: 'sib', method: 'poke', args: [0x5100, [99]] }, '*')`);
    nest.eval(`parent.parent.frames[0].postMessage({ cloadm: 1, id: 'nest', method: 'poke', args: [0x5101, [98]] }, '*')`);
    await new Promise((ok) => setTimeout(ok, 1000));
    out.others = { mem: await m.peek(0x5100, 2), answered: answered.length, sameFrame: cl === window.frames[0] };
    out.switched = (await m.switchMachine('coco3', { ram: 128 })).machine;
    await until(async () => events.length >= 2);
    out.events = events;
    return out;
  }, [...fs.readFileSync(path.join(ROOT, 'examples/liza.bin'))]);
  check('embed: CLOADM.attach from another origin; info', r.info.machine === 'dragon64' && r.info.name === 'Dragon 64' && r.info.roms === false, JSON.stringify(r.info));
  check('embed: load runs a program, type types into it, screenText reads the answer', /liza\.bin/.test(r.load) && r.greeted && r.typed === 9 && r.answered, JSON.stringify(r));
  check('embed: poke and peek', r.poke === 3 && JSON.stringify(r.peek) === '[7,8,9]');
  check('embed: frame events once watched', r.frames);
  check('embed: a bad call rejects with the emulator\'s message', /not an address/.test(r.error || ''), r.error);
  check('embed: calls from a sibling frame or a frame nested in it are ignored (only the embedding page drives it)',
    r.others.sameFrame && JSON.stringify(r.others.mem) !== '[99,98]' && r.others.mem[0] !== 99 && r.others.mem[1] !== 98 && r.others.answered === 0, JSON.stringify(r.others));
  for (const k of ['load', 'reset', 'powerCycle', 'switchMachine']) {
    check(`embed: no welcome menu ${k === 'load' ? 'on load' : `after ${k}()`} (the embedding page drives a plain machine)`, r.menu[k] === false && r.settled === 5, JSON.stringify({ menu: r.menu, settled: r.settled }));
  }
  check('embed: without ROMs the embedded machine shows the stub\'s own screen', r.menu.stub, JSON.stringify(r.menu));
  check('embed: switchMachine, and the "loaded" and "machine" events', r.switched === 'coco3' && r.events.includes('loaded dragon64') && r.events.includes('machine coco3'), r.events.join());
  // the host page as a visitor sees it (taken before the fake ROM below, which leaves garbage on the stub's screen)
  if (shotDir) await page.screenshot({ path: path.join(shotDir, 'embed-host.png') });
  // with the user's ROMs in the embedded machine, peek refuses: its memory can hold copies of ROM code
  const emu = page.frames().find((f) => /\/play\/\?embed=1/.test(f.url()));
  await emu.evaluate(() => { const m = window.emu.machine, slot = m.profile.roms[0]; m.setRoms({ [slot.id]: new Uint8Array(slot.size || 0x4000).fill(0x39) }); });
  const refused = await page.evaluate(async () => { try { await window.__cloadm.peek(0x400, 4); return null; } catch (e) { return e.message; } });
  check('embed: peek is refused while the machine runs the user\'s ROMs', /not available while the machine runs your own ROMs/.test(refused || ''), refused);
  check('embed: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
  host.close();
}

// offline: the service worker installs, keeps the site, and with the network gone the page reloads and runs
async function pwaChecks(browser, site, check) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${site}play/?machine=coco`);
  const installed = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active && reg.scope;
  });
  check('PWA: the service worker installs, scoped to the whole site', installed === site, String(installed));
  const kept = await waitFor(page, async () => { const c = await caches.open('cloadm-v1'); return (await c.keys()).length; }, null, 15000)
    && await page.evaluate(async () => (await (await caches.open('cloadm-v1')).keys()).length);
  check('PWA: the site is kept for offline use', kept > 100, `${kept} files`);
  check('PWA: the manifest is linked and served', await page.evaluate(async () => { const l = document.querySelector('link[rel="manifest"]'); const m = await (await fetch(l.href)).json(); return m.start_url === '/play/'; }));
  await ctx.setOffline(true);
  await page.goto(`${site}play/?machine=dragon64&start=welcome`);
  check('PWA offline: /play/ reloads and runs the welcome program', await waitFor(page, () => window.emu && window.emu.session.welcomeRunning && window.emu.session.screenText()[14].includes('PRESS 1 TO 4'), null, 10000));
  // sound offline: the worklet's module comes from the kept copy, so a click starts the AudioWorkletNode and it
  // plays (the welcome tune: the processor reports samples taken, and its output is not silent)
  await page.mouse.click(5, 5);
  const offlineSound = await waitFor(page, () => window.emu.audio.path === 'worklet' && window.emu.audio.out.sink.removed > 0, null, 10000)
    && await page.evaluate(() => new Promise((res) => {
      const port = window.emu.audio.node.port; let loud = 0;
      port.addEventListener('message', (e) => { if (e.data.tap) for (const v of e.data.tap.out) loud = Math.max(loud, Math.abs(v)); });
      port.postMessage({ tap: true });
      const t0 = performance.now(), t = setInterval(() => { if (loud > 0.01 || performance.now() - t0 > 8000) { clearInterval(t); port.postMessage({ tap: false }); res(loud > 0.01); } }, 20);
    }));
  check('PWA offline: sound plays through the AudioWorkletNode (its module kept for offline use)', offlineSound,
    await page.evaluate(() => JSON.stringify({ path: window.emu.audio.path, fallback: window.emu.audio.fallback, removed: window.emu.audio.out && window.emu.audio.out.sink.removed, state: window.emu.audio.ctx && window.emu.audio.ctx.state, ua: navigator.userAgent })));
  check('PWA offline: the fonts came from the kept copy', await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Archivo' && f.status === 'loaded'); }));
  for (const p of ['', 'help/', 'roms/']) {
    const res = await page.goto(site + p);
    check(`PWA offline: /${p} opens`, res.ok() && /CLOADM/.test(await page.title()), String(res.status()));
  }
  await ctx.setOffline(false);
  check('PWA: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

// Consent in the full screen chat (?app=claude): "Let Claude use the emulator"
// starts off; the first time Claude wants to act, the BASIC session card asks (Allow / Just tell me the fix); "Just
// tell me the fix" refuses the tool, Claude is told why, and nothing changes; Allow lets it act and turns the switch
// on for the visit, so the next action does not ask; a reload starts with it off again. Lines are typed on the
// chat screen, as a person would.
// What lies over the machine's text, on the page (a recording dry run of the full screen chat): the
// text area is the VDG's active 256 x 192 in the frame, mapped to the page through the screen's canvas and the CRT
// shader's barrel (js/video/canvas.js: p = c (1 + curv c_other^2), curv = curvature / 100 x 0.12, solved for c).
// -> the overlays that meet it, whether row 0 lies wholly in view (inside the canvas less its rounded corners, and
// the tube), and whether row 0 holds text in the frame
const OVERLAYS = '.tube *:not(#screenWrap):not(#screen), #focusHint, #keyHint, #soundHint, #claudePip, #claudePipActing, #toast, #attention';
const textOverlay = (page) => page.evaluate((OVERLAYS) => {
  const E = window.emu.Emu, s = window.emu.session, d = s.display, f = s.machine.render();
  const cv = document.getElementById('screen').getBoundingClientRect(), tube = document.querySelector('.tube').getBoundingClientRect();
  const k = d.view === 'crt' ? d.curvature / 100 * 0.12 : 0;
  const toPage = (u, v) => {   // texture uv -> page: c from p = c (1 + k c_other^2), iterated
    const px = u * 2 - 1, py = v * 2 - 1;
    let cx = px, cy = py;
    for (let i = 0; i < 30; i++) { cx = px / (1 + k * cy * cy); cy = py / (1 + k * cx * cx); }
    return [cv.left + (cx + 1) / 2 * cv.width, cv.top + (cy + 1) / 2 * cv.height];
  };
  const box = (x0, y0, x1, y1) => {   // a frame rectangle on the page (its edges' extreme points)
    const pts = [];
    for (let i = 0; i <= 8; i++) { const x = x0 + (x1 - x0) * i / 8, y = y0 + (y1 - y0) * i / 8;
      pts.push(toPage(x / f.width, y0 / f.height), toPage(x / f.width, y1 / f.height), toPage(x0 / f.width, y / f.height), toPage(x1 / f.width, y / f.height)); }
    return { left: Math.min(...pts.map((p) => p[0])), right: Math.max(...pts.map((p) => p[0])), top: Math.min(...pts.map((p) => p[1])), bottom: Math.max(...pts.map((p) => p[1])) };
  };
  const bx = E.MC6847.BORDER_X, by = E.MC6847.BORDER_Y;
  const area = box(bx, by, bx + 256, by + 192), row0 = box(bx, by, bx + 256, by + 8);
  const meets = (a, o) => !(a.bottom <= o.top || a.top >= o.bottom || a.right <= o.left || a.left >= o.right);
  const over = [...document.querySelectorAll(OVERLAYS)].filter((e) => e.checkVisibility({ visibilityProperty: true }) && e.getBoundingClientRect().width > 0)   // (visibility: hidden covers nothing: a toast waiting for room)
   
    .filter((e) => meets(area, e.getBoundingClientRect())).map((e) => e.id || e.className);
  // what shows of the screen: the canvas inside the tube that clips it (a phone chat crops the border, the canvas
  // larger than the tube), less the larger of their rounded corners
  const radius = Math.max(parseFloat(getComputedStyle(document.getElementById('screen')).borderTopLeftRadius) || 0,
    parseFloat(getComputedStyle(document.querySelector('.tube')).borderTopLeftRadius) || 0);
  const vis = { left: Math.max(cv.left, tube.left), top: Math.max(cv.top, tube.top), right: Math.min(cv.right, tube.right), bottom: Math.min(cv.bottom, tube.bottom) };
  // a point shows if it is inside that box with its corners rounded
  const shows = (x, y) => {
    if (x < vis.left || x > vis.right || y < vis.top || y > vis.bottom) return false;
    const cx = x < vis.left + radius ? vis.left + radius : x > vis.right - radius ? vis.right - radius : x;
    const cy = y < vis.top + radius ? vis.top + radius : y > vis.bottom - radius ? vis.bottom - radius : y;
    return Math.hypot(x - cx, y - cy) <= radius;
  };
  const inside = shows(row0.left, row0.top) && shows(row0.right, row0.top) && shows(row0.left, row0.bottom) && shows(row0.right, row0.bottom);
  const px = E.frameToRGBA(f);
  let lit = 0;
  for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 256; x++) if ((px[y * f.width + x] & 0xff00) > 0x8000) lit++;
  const shown = (id) => { const e = document.getElementById(id); return !!e && e.checkVisibility(); };
  return { over, inside, lit, row0: [row0.left, row0.top, row0.right, row0.bottom].map(Math.round),
    hints: { focus: shown('focusHint'), keys: shown('keyHint'), sound: shown('soundHint') }, romPill: shown('romPill'), noRomsCard: shown('welcome'),
    keyHintLive: !document.getElementById('keyHint').hidden, focused: document.activeElement.id };
}, OVERLAYS);
// the screen reached by keyboard (the focus hint's case)
const focusScreenByKey = async (page) => {
  await page.evaluate(() => document.getElementById('screen').focus({ focusVisible: true }));
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
  if (await page.evaluate(() => document.activeElement.id !== 'screen')) await page.evaluate(() => document.getElementById('screen').focus({ focusVisible: true }));
};
const SCREEN_VIEWPORTS = [['desktop', { width: 1440, height: 900 }], ['laptop', { width: 1280, height: 720 }], ['tablet', { width: 820, height: 1180 }], ['phone', { width: 390, height: 844 }], ['landscape', { width: 844, height: 390 }]];   // five viewports

// The welcome menu on a first visit: its hints (keyboard focus, the keys, "click for sound") show, all
// three, and none lies over the menu's text, at every viewport (on a phone the key hint hid items 3-4)
async function welcomeScreenChecks(browser, base, check) {
  for (const [label, viewport] of SCREEN_VIEWPORTS) {
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?machine=dragon64`);
    await started(page);
    await waitFor(page, () => window.emu.session.welcomeRunning && !document.getElementById('keyHint').hidden && !document.getElementById('soundHint').hidden, null, 15000);
    await emuFrames(page, 3);
    // before any key (a key unlocks the sound, and its hint goes): the sound note, alone on the line under the screen; then
    // reached by keyboard: the focus hint, and the key hint in the sound note's place
    const w = await textOverlay(page);
    await focusScreenByKey(page);
    // (the keys unlock the sound, and the sound note leaves the line a moment later: showHint runs 100 ms after the unlock)
    await waitFor(page, () => document.getElementById('soundHint').hidden, null, 5000);
    await emuFrames(page, 3);
    const wf = await textOverlay(page);
    // the focus hint lies over the nameplate under the screen; a short window leaves the nameplate out, and with it
    // the hint (the tube's focus ring still shows the keyboard is on the screen)
    const plate = await page.evaluate(() => document.querySelector('.plate').checkVisibility());
    check(`welcome screen (${label}): on a first visit the sound note shows alone, then the focus hint (where the nameplate shows) and the key hint, and none lies over the menu's text`,
      !w.hints.keys && w.hints.sound && w.lit > 0 && !w.over.length && wf.focused === 'screen' && wf.hints.focus === plate && wf.hints.keys && !wf.over.length, JSON.stringify({ plate, w, wf }));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `welcome-screen-${label}.png`) });
    check(`welcome screen (${label}): no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }
}

// The full screen Claude chat's screen (a recording dry run, Dragon 64 without BASIC ROMs): nothing lies over the
// chat's text, before typing (keyboard focus, a first visit) or after a reply has scrolled it, and row 0 stays
// wholly in view through the CRT's curvature (U3); BASIC's key hint, the no-ROMs pill and the no-ROMs card are not
// shown with the chat on screen (U2, M2), at every viewport
async function chatScreenChecks(browser, base, check) {
  const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const msgStart = { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } };
  const text = (t) => sse([msgStart, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]);
  const tools = (uses) => sse([msgStart, ...uses.flatMap((u, i) => [
    { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_${i}`, name: u.name, input: {} } },
    { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(u.input) } },
    { type: 'content_block_stop', index: i }]), { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} }, { type: 'message_stop' }]);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  const ROWS = 30;   // more lines than the screen holds, so it scrolls
  const reply = Array.from({ length: ROWS }, (_, i) => `Line ${i + 1} of a long answer.`).join('\n');
  for (const [label, viewport] of SCREEN_VIEWPORTS) {
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
    // the replies in order: the long answer; then Claude acting (a POKE into the BASIC session) and a short answer
    const replies = [text(reply), tools([{ name: 'poke', input: { address: 0x3000, bytes: [1] } }]), text('Done.')];
    await ctx.route('https://api.anthropic.com/**', (route) => (route.request().method() === 'OPTIONS' ? route.fulfill({ status: 204, headers: cors })
      : route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: replies.shift() || text('ok') })));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('cloadm.anthropicKey', 'sk-ant-BROWSER-CHECK-KEY-0123456789'));
    await page.goto(`${base}?machine=dragon64&app=claude`);
    await started(page);
    const idle = () => waitFor(page, () => { const c = window.emu.session.chat; return c && !c.busy && c.channel.queued === 0 && window.emu.session.chatView === 'chat'; }, null, 30000);
    await idle();
    await focusScreenByKey(page);
    await emuFrames(page, 2);
    const before = await textOverlay(page);
    // the focus hint: under the screen where the nameplate shows; never in a phone chat (its sticky bar is the way out)
    const phoneChat = await page.evaluate(() => document.body.classList.contains('chat-phone'));
    const plateUp = await page.evaluate(() => document.querySelector('.plate').checkVisibility());
    check(`chat screen (${label}): before typing, nothing lies over the chat's text; the focus hint shows under the screen (not in a phone chat); BASIC's key hint, the no-ROMs pill and card do not`,
      before.focused === 'screen' && before.keyHintLive && !before.over.length && before.hints.focus === (!phoneChat && plateUp) && !before.hints.keys && !before.romPill && !before.noRomsCard,
      JSON.stringify({ phoneChat, plateUp, before }));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `chat-screen-start-${label}.png`) });
    // a reply longer than the screen: it scrolls
    await page.keyboard.type('tell me a long story');
    await page.keyboard.press('Enter');
    // the typed line has reached the chat (busy while the mocked reply streams; the reply can come and go between two
    // polls, so "busy" alone timed out on every run)
    await waitFor(page, () => { const c = window.emu.session.chat; return !!c && (c.busy || c.messages.some((m) => m.role === 'user' && m.content === 'tell me a long story')); });
    await idle();
    await emuFrames(page, 10);
    const after = await textOverlay(page);
    check(`chat screen (${label}): after the reply has scrolled the screen, row 0 holds text and is wholly in view (the canvas and the tube, through the curvature), and nothing lies over the text`,
      after.lit > 0 && after.inside && !after.over.length, JSON.stringify(after));
    if (shotDir) await page.locator('.tube').screenshot({ path: path.join(shotDir, `chat-screen-scrolled-${label}.png`) });
    // Claude acting on the BASIC session shows its window (hidden by default; when it shows, it stays
    // off the chat's text like the hints)
    await page.check('#chkClaudeTools');
    await page.focus('#screen');
    await page.keyboard.type('poke it');
    await page.keyboard.press('Enter');
    const pipUp = await waitFor(page, () => !document.getElementById('claudePip').hidden && window.emu.session.chatMachines.basic.ram[0x3000] === 1, null, 20000);
    await idle();
    await emuFrames(page, 3);
    const pip = await textOverlay(page);
    check(`chat screen (${label}): Claude acting shows the BASIC session's window, and it lies off the chat's text`,
      pipUp && await page.isVisible('#claudePip') && !pip.over.length, JSON.stringify(pip));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `chat-screen-pip-${label}.png`) });
    check(`chat screen (${label}): no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }
}

async function consentFullscreenChecks(browser, base, check) {
  const KEY = 'sk-ant-CONSENT-CHECK-KEY-0123456789';
  const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const msgStart = { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } };
  const text = (t) => sse([msgStart, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]);
  const tools = (uses) => sse([msgStart, ...uses.flatMap((u, i) => [
    { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_${i}`, name: u.name, input: {} } },
    { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(u.input) } },
    { type: 'content_block_stop', index: i }]), { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} }, { type: 'message_stop' }]);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript((k) => { try { localStorage.setItem('cloadm.anthropicKey', k); } catch (e) { /* none */ } }, KEY);
  const page = await ctx.newPage();
  const errors = [], requests = [], replies = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ctx.route('https://api.anthropic.com/**', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    requests.push(JSON.parse(req.postData()));
    const r = replies.shift() || { body: text('ok') };
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: r.body });
  });
  const L = 'consent (full screen)';
  // a line typed on the chat screen once the last turn has reached it (the firmware takes no typing before that)
  const typeLine = async (line) => {
    await waitFor(page, () => { const c = window.emu.session.chat; return c && !c.busy && c.channel && c.channel.queued === 0 && window.emu.session.chatView === 'chat'; }, null, 20000);
    await emuFrames(page, 3);
    await page.focus('#screen');
    await page.keyboard.type(line);
    await page.keyboard.press('Enter');
  };
  const asking = () => waitFor(page, () => !document.getElementById('claudeConsentAsk').hidden && document.getElementById('claudeSession').classList.contains('asking'), null, 15000);
  const done = (n) => waitFor(page, (want) => window.emu.session.chat && !window.emu.session.chat.busy && window.emu.__sent >= want, n, 20000);

  await page.goto(`${base}?machine=dragon64&app=claude`);
  await started(page);
  await waitFor(page, () => window.emu.session.claudeView === 'full', null, 15000);
  await page.evaluate(() => { const b = window.emu.session.chat.backend, f = b.fetch; window.emu.__sent = 0; b.fetch = (...a) => { window.emu.__sent++; return f(...a); }; });
  check(`${L}: "Let Claude use the emulator" starts off`, !(await page.isChecked('#chkClaudeTools')) && await page.evaluate(() => !window.emu.session.claudeAllowed));

  // the first acting tool asks; "Just tell me the fix" refuses it
  replies.push({ body: tools([{ name: 'type_text', input: { text: 'PRINT 1\n' } }]) }, { body: text('Type PRINT 1 yourself.') });
  await typeLine('fix it');
  check(`${L}: the first time Claude wants to act, the BASIC session card asks: Allow / Just tell me the fix`, await asking()
    && await page.isVisible('#btnClaudeAllow') && await page.isVisible('#btnClaudeTell')
    && /Claude wants to type into your BASIC session/.test(await page.textContent('#claudeConsentText')));
  if (shotDir) await page.screenshot({ path: path.join(shotDir, 'consent-fullscreen.png') });
  await page.click('#btnClaudeTell');
  await done(2);
  const refused = requests[1] && requests[1].messages.slice(-1)[0].content;
  check(`${L}: "Just tell me the fix" refuses the tool: Claude is told, nothing is typed into BASIC, the switch stays off`,
    Array.isArray(refused) && refused[0].is_error && /Just tell me the fix/.test(refused[0].content)
    && await page.evaluate(() => window.emu.session.chatMachines.basic.stubKeys.length === 0 && !window.emu.session.claudeAllowed && window.emu.session.chat.undo.length === 0)
    && !(await page.isChecked('#chkClaudeTools')) && await page.isHidden('#claudeConsentAsk'), JSON.stringify(refused));

  // asked again (the switch is still off); Allow lets it act and turns the switch on
  replies.push({ body: tools([{ name: 'type_text', input: { text: 'PRINT 2\n' } }]) }, { body: text('Typed.') });
  await typeLine('now do it');
  check(`${L}: with the switch still off, the next action asks again`, await asking());
  await page.click('#btnClaudeAllow');
  await done(4);
  const ran = requests[3] && requests[3].messages.slice(-1)[0].content;
  check(`${L}: Allow: the tool runs (typed into the BASIC session, a restore point first) and the switch turns on`,
    Array.isArray(ran) && !ran[0].is_error && await page.evaluate(() => window.emu.session.claudeAllowed && window.emu.session.chat.undo.length === 1)
    && await page.isChecked('#chkClaudeTools') && await page.isHidden('#claudeConsentAsk'), JSON.stringify(ran));

  // allowed for the visit: the next action does not ask
  replies.push({ body: tools([{ name: 'poke', input: { address: 0x3000, bytes: [7] } }]) }, { body: text('Poked.') });
  await typeLine('poke it');
  await done(6);
  check(`${L}: allowed for the visit: the next action does not ask`, await page.evaluate(() => window.emu.session.chatMachines.basic.ram[0x3000] === 7)
    && !(requests[5].messages.slice(-1)[0].content[0].is_error));

  // the read-only tools never ask, and the page shows what they read: the switch is
  // ON here from the Allow above, so this case first turns it OFF to prove reading does not need consent
  await page.evaluate(() => window.emu.session.setClaudeAllowed(false));
  check(`${L}: the switch is off again for the read-only case`, await page.evaluate(() => !window.emu.session.claudeAllowed));
  replies.push({ body: tools([{ name: 'machine_info', input: {} }]) }, { body: text('It is a Dragon 64.') });
  await typeLine('what machine is it');
  await done(8);
  const readBack = requests[7] && requests[7].messages.slice(-1)[0].content;
  const readState = await page.evaluate(() => ({ allowed: window.emu.session.claudeAllowed, undo: window.emu.session.chat.undo.length }));
  check(`${L}: with the switch OFF a read-only tool runs: no consent card, and the tool result carries the machine's name`,
    Array.isArray(readBack) && !readBack[0].is_error && /Tandy Color Computer|Dragon/.test(String(readBack[0].content))
    && !readState.allowed && await page.isHidden('#claudeConsentAsk'),
    `${JSON.stringify(readBack)} state ${JSON.stringify(readState)}`);

  // disassemble is read-only too: it runs with the switch off, and the result is the
  // machine's own instruction set - a Dragon's 6809 mnemonics, not prose
  replies.push({ body: tools([{ name: 'disassemble', input: { address: 0xC000, count: 2 } }]) }, { body: text('It is the ROM.') });
  await typeLine('what is the code at c000');
  await done(10);
  const dis = requests[9] && requests[9].messages.slice(-1)[0].content;
  let disJson = null;
  try { disJson = JSON.parse(dis[0].content); } catch (e) { /* checked below */ }
  check(`${L}: disassemble runs with the switch OFF and returns the machine's own CPU and mnemonics`,
    Array.isArray(dis) && !dis[0].is_error && disJson && disJson.cpu === '6809' && disJson.count === 2
    && disJson.instructions.length === 2 && disJson.instructions.every((i) => typeof i.text === 'string' && Array.isArray(i.bytes))
    && await page.isHidden('#claudeConsentAsk') && await page.evaluate(() => !window.emu.session.claudeAllowed),
    JSON.stringify(dis && dis[0]));

  // load_basic checks its program before its own card: on this machine (no BASIC ROMs) it is refused with a coded
  // error Claude can act on, no card comes up, and nothing changes (the card itself: askFollowupChecks, section 6)
  replies.push({ body: tools([{ name: 'load_basic', input: { program: '10 PRINT "HI"\n20 GOTO 10\n30 END\n40 REM\n' } }]) }, { body: text('No BASIC here.') });
  const undoBefore = await page.evaluate(() => window.emu.session.chat.undo.length);
  let lbCard = false;
  await typeLine('load my program');
  for (let i = 0; i < 40 && !lbCard && await page.evaluate(() => window.emu.__sent < 12); i++) {
    lbCard = await page.evaluate(() => !document.getElementById('claudeLoad').hidden || !document.getElementById('claudeConsentAsk').hidden);
    await emuFrames(page, 2);
  }
  await done(12);
  const lb = requests[11] && requests[11].messages.slice(-1)[0].content;
  let lbJson = null;
  try { lbJson = JSON.parse(lb[0].content); } catch (e) { /* checked below */ }
  check(`${L}: load_basic on a machine with no BASIC ROMs: no card, Claude gets the coded error no-basic with a remedy, and nothing changes`,
    !lbCard && Array.isArray(lb) && lb[0].is_error && lbJson && lbJson.error && lbJson.error.code === 'no-basic' && /assemble_and_load/.test(lbJson.error.remedy)
    && await page.evaluate((n) => window.emu.session.chat.undo.length === n, undoBefore), JSON.stringify(lb && lb[0]));
  const offered = requests[11] && requests[11].tools && requests[11].tools.find((t) => t.name === 'load_basic');
  check(`${L}: the request offers load_basic, and its description and the system prompt carry the typing policy`, !!offered
    && /3 lines or fewer/.test(offered.description) && /3 lines or fewer/.test(JSON.stringify(requests[11].system)));

  // a new visit starts with it off
  await page.reload();
  await started(page);
  await waitFor(page, () => window.emu.session.claudeView === 'full', null, 15000);
  check(`${L}: after a reload the switch is off again`, !(await page.isChecked('#chkClaudeTools')) && await page.evaluate(() => !window.emu.session.claudeAllowed));
  check(`${L}: no page errors`, !errors.length, errors.join('; '));
  await ctx.close();
}

// Ask Claude follow-ups: a key pressed on the machine while Claude types
// pauses Claude (Resume or Stop); the Debugger's "What is this code doing?" in the Ctrl K box, with the code at the
// program counter as context; on a phone the on-screen keyboard (the visual viewport shrinking) never covers the
// sheet; the panel docks beside the machine from 960 px and lies over the page below that; and the full screen
// chat's BASIC window starts hidden.
async function askFollowupChecks(browser, base, check) {
  const KEY = 'sk-ant-FOLLOWUP-CHECK-KEY-0123456789';
  const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const msgStart = { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } };
  const text = (t) => sse([msgStart, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]);
  const tools = (uses) => sse([msgStart, ...uses.flatMap((u, i) => [
    { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_${i}`, name: u.name, input: {} } },
    { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(u.input) } },
    { type: 'content_block_stop', index: i }]), { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} }, { type: 'message_stop' }]);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  // long enough to still be going in when the test presses its key (the no-ROM stub takes typed keys fast)
  const LISTING = Array.from({ length: 1500 }, (_, i) => `${(i + 1) * 10} PRINT "LINE ${i + 1}"`).join('\n') + '\n';
  async function open(viewport, init, opts = {}) {
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block', ...opts });
    if (init) await ctx.addInitScript(init);
    const page = await ctx.newPage();
    const errors = [], requests = [], replies = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await ctx.route('https://api.anthropic.com/**', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      requests.push(JSON.parse(req.postData()));
      const r = replies.shift() || { body: text('ok') };
      if (r.hold) await new Promise((res) => { r.release = res; replies.held = r; });
      try { await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: r.body }); } catch (e) { /* stopped */ }
    });
    await page.goto(`${base}?machine=dragon64`);
    await started(page);
    await stubPrompt(page);   // the live machine, not the welcome menu (where Ask Claude opens full screen)
    await page.evaluate((k) => localStorage.setItem('cloadm.anthropicKey', k), KEY);
    return { ctx, page, errors, requests, replies };
  }

  // ---- (1) a key on the machine pauses Claude; Resume carries on, Stop ends it ----
  {
    const { ctx, page, errors, replies } = await open({ width: 1440, height: 900 });
    await page.click('#btnAsk');
    replies.push({ body: tools([{ name: 'type_text', input: { text: LISTING } }]) }, { hold: true, body: text('Typed.') });
    await page.fill('#askInput', 'Type a long listing for me');
    await page.press('#askInput', 'Enter');
    await waitFor(page, () => !document.getElementById('askConsent').hidden);
    await page.click('#btnAskAllow');
    await waitFor(page, () => !document.getElementById('askActing').hidden && window.emu.machine.typist.queue.length > 100, null, 8000);
    await page.focus('#screen');
    await page.keyboard.press('x');
    const paused = await page.evaluate(() => { const m = window.emu.machine; const before = m.typist.queue.length; return { paused: !!window.emu.session.claudePaused, left: before,
      pill: document.getElementById('askActing').textContent, resume: !document.getElementById('btnAskResume').hidden, ring: document.getElementById('monitor').classList.contains('claude-acting') }; });
    await emuFrames(page, 30);
    const still = await page.evaluate(() => window.emu.machine.stubKeys.filter((c) => c !== 'X'.charCodeAt(0)).length + window.emu.machine.typist.queue.length);
    check('ask (keys): a key pressed on the machine while Claude types pauses Claude: the pill says Paused, with Resume and Stop; nothing more is typed',
      paused.paused && /Paused/.test(paused.pill) && paused.resume && still === 0 && await page.isVisible('#btnAskStop'), JSON.stringify(paused));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'ask-paused-desktop.png') });
    // compared in the same task as the click: the held keys are queued again, after the person's own
    const resumed = await page.evaluate(() => { const s = window.emu.session, held = s.claudePaused.held.queue.length, before = s.machine.typist.queue.length;
      document.getElementById('btnAskResume').click(); return { held, queued: s.machine.typist.queue.length - before, paused: !!s.claudePaused }; });
    check('ask (keys): Resume carries on typing where Claude stopped', resumed.held > 50 && resumed.queued === resumed.held && !resumed.paused
      && /Claude is typing/.test(await page.textContent('#askActing')), JSON.stringify(resumed));
    await page.focus('#screen');
    await page.keyboard.press('y');
    await waitFor(page, () => window.emu.session.claudePaused);
    await page.click('#btnAskStop');
    check('ask (keys): Stop while paused ends the turn; nothing held is typed later', await waitFor(page, () => !window.emu.session.claudePaused && !window.emu.session.chat.busy
      && document.getElementById('askActing').hidden) && (await emuFrames(page, 30), await page.evaluate(() => window.emu.machine.stubKeys.length === 0 && window.emu.machine.typist.queue.length === 0)));
    if (replies.held) replies.held.release();
    check('ask (keys): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (1b) a pause belongs to its turn: a key pressed while Claude thinks after acting pauses it; the reply
  // finishes; the next turn is not paused (no "Paused" status, no Resume needed) and its action runs ----
  {
    const { ctx, page, errors, replies, requests } = await open({ width: 1440, height: 900 });
    await page.click('#btnAsk');
    await page.click('#chkAskMachine');
    replies.push({ body: tools([{ name: 'poke', input: { address: 0x3000, bytes: [0x11] } }]) }, { hold: true, body: text('Poked it.') });
    await page.fill('#askInput', 'Poke 3000 for me');
    await page.press('#askInput', 'Enter');
    await waitFor(page, () => window.emu.session.claudeActing && window.emu.machine.ram[0x3000] === 0x11 && window.emu.session.chat.busy, null, 8000);
    await page.focus('#screen');
    await page.keyboard.press('x');
    const during = await page.evaluate(() => ({ paused: !!window.emu.session.claudePaused, status: document.getElementById('askStatusText').textContent }));
    replies.held.release();
    await waitFor(page, () => !window.emu.session.chat.busy, null, 8000);
    const after = await page.evaluate(() => ({ paused: !!window.emu.session.claudePaused, resume: !document.getElementById('btnAskResume').hidden, status: !document.getElementById('askStatus').hidden }));
    check('ask (pause scope): a key while Claude thinks after acting pauses it; when the reply finishes the pause is gone (no Resume, no status)',
      during.paused && /Paused/.test(during.status) && !after.paused && !after.resume && !after.status, JSON.stringify({ during, after }));
    replies.push({ hold: true, body: tools([{ name: 'poke', input: { address: 0x3001, bytes: [0x22] } }]) }, { body: text('Poked again.') });
    await page.fill('#askInput', 'Poke 3001 too');
    await page.press('#askInput', 'Enter');
    await waitFor(page, () => window.emu.session.chat.busy && !document.getElementById('askStatus').hidden, null, 8000);
    const next = await page.evaluate(() => ({ paused: !!window.emu.session.claudePaused, status: document.getElementById('askStatusText').textContent }));
    replies.held.release();
    const ran = await waitFor(page, () => window.emu.machine.ram[0x3001] === 0x22 && !window.emu.session.chat.busy, null, 8000);
    check('ask (pause scope): the next turn starts as Thinking…, not Paused, and its poke runs without a Resume',
      !next.paused && next.status === 'Thinking…' && ran && /Poked again\./.test(await page.textContent('#askMessages')) && requests.length === 4, JSON.stringify(next));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'ask-pause-scope.png') });
    // a later turn that only answers in text is not Claude acting: a key pressed on the machine during it is the
    // person's own key (no pause, no Resume, no pill), and the reply comes
    replies.push({ hold: true, body: text('Just words.') });
    await page.fill('#askInput', 'What did you change?');
    await page.press('#askInput', 'Enter');
    await waitFor(page, () => window.emu.session.chat.busy && !document.getElementById('askStatus').hidden, null, 8000);
    await page.focus('#screen');
    await page.keyboard.press('z');
    const textOnly = await page.evaluate(() => ({ paused: !!window.emu.session.claudePaused, acting: window.emu.session.claudeBusyActing, status: document.getElementById('askStatusText').textContent,
      resume: !document.getElementById('btnAskResume').hidden, pill: !document.getElementById('askActing').hidden }));
    replies.held.release();
    const replied = await waitFor(page, () => !window.emu.session.chat.busy && /Just words\./.test(document.getElementById('askMessages').textContent), null, 8000);
    check('ask (pause scope): a later text-only turn is not paused by a key: Thinking…, no Resume, no pill, and the reply comes',
      !textOnly.paused && !textOnly.acting && textOnly.status === 'Thinking…' && !textOnly.resume && !textOnly.pill && replied, JSON.stringify(textOnly));
    check('ask (pause scope): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (1d) a pause in the full-screen chat has its Resume beside Stop in the bar (the side panel's Resume is on
  // the screen, which full screen does not show); a later text-only turn is not paused; on the phone too, and the
  // phone's side-panel sheet keeps its Resume on the screen ----
  for (const [vp, tag] of [[{ width: 1440, height: 900 }, 'desktop'], [{ width: 390, height: 844 }, 'phone']]) {
    const { ctx, page, errors, replies } = await open(vp);
    const L = `ask (full-screen pause, ${tag})`;
    await page.click('#btnAsk');
    if (tag === 'phone') {
      // the phone's sheet (side panel): a pause shows Resume and Stop on the screen, and Resume carries on
      // (the switch is below the sheet's fold; its click is covered elsewhere)
      await page.evaluate(() => window.emu.session.setClaudeAllowed(true));
      replies.push({ body: tools([{ name: 'type_text', input: { text: LISTING } }]) }, { hold: true, body: text('Typed.') });
      await page.fill('#askInput', 'Type a long listing for me');
      await page.press('#askInput', 'Enter');
      await waitFor(page, () => !document.getElementById('askActing').hidden && window.emu.machine.typist.queue.length > 100, null, 8000);
      await page.focus('#screen');
      await page.keyboard.press('x');
      const sheet = await page.evaluate(() => ({ paused: !!window.emu.session.claudePaused, resume: !document.getElementById('btnAskResume').hidden }));
      // each button whole inside the screen (the pill is in the screen, which clips what overflows it) and on top
      const sheetVis = (await page.evaluate(() => { const t = document.querySelector('.tube').getBoundingClientRect();
        return ['btnAskResume', 'btnAskStop'].map((id) => { const b = document.getElementById(id), r = b.getBoundingClientRect();
          return r.width > 0 && r.left >= t.left && r.right <= t.right && r.top >= t.top && r.bottom <= t.bottom && b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); }); })).every(Boolean);
      if (shotDir) await page.screenshot({ path: path.join(shotDir, 'ask-paused-phone-sheet.png') });
      await page.click('#btnAskResume');
      const back = await page.evaluate(() => !window.emu.session.claudePaused && window.emu.machine.typist.queue.length > 50);
      check('ask (phone sheet): a pause shows Resume and Stop on the screen, and Resume carries on typing', sheet.paused && sheet.resume && sheetVis && back, JSON.stringify(sheet));
      await page.click('#btnAskStop');
      await waitFor(page, () => !window.emu.session.chat.busy, null, 8000);
      // (Stop during the tool: the turn's second reply was never asked for)
      if (replies.held) { replies.held.release(); replies.held = null; }
      replies.length = 0;
    } else await page.click('#chkAskMachine');
    // full screen, showing the BASIC session (the machine Claude types into, where the person's key goes)
    await page.click('#btnAskFull');
    await waitFor(page, () => window.emu.session.claudeView === 'full' && !!window.emu.session.chatMachines, null, 15000);
    await page.click('#btnClaudeView');
    await waitFor(page, () => window.emu.session.chatView === 'basic');
    const basic = () => window.emu.session.chatTarget().machine;
    replies.push({ body: tools([{ name: 'type_text', input: { text: LISTING } }]) }, { hold: true, body: text('Typed it.') });
    await page.evaluate(() => { window.emu.session.chat.sendLine('Type a long listing for me'); });
    await waitFor(page, `(${basic})().typist.queue.length > 100 && window.emu.session.claudeBusyActing`, null, 8000);
    await page.focus('#screen');
    await page.keyboard.press('x');
    const paused = await page.evaluate(() => ({ paused: !!window.emu.session.claudePaused, status: document.getElementById('claudeStatusText').textContent,
      resume: !document.getElementById('btnClaudeResume').hidden }));
    const shown = await page.isVisible('#btnClaudeResume') && await page.isVisible('#btnClaudeStop');
    check(`${L}: a key on the BASIC session pauses Claude; the bar says Paused with Resume and Stop, both on screen`, paused.paused && /Paused/.test(paused.status) && paused.resume && shown, JSON.stringify(paused));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `ask-paused-full-${tag}.png`) });
    const resumed = await page.evaluate((b) => { const s = window.emu.session, held = s.claudePaused.held.queue.length, m = (0, eval)(b)(), before = m.typist.queue.length;
      document.getElementById('btnClaudeResume').click(); return { held, queued: m.typist.queue.length - before, paused: !!s.claudePaused, hidden: document.getElementById('btnClaudeResume').hidden }; }, `(${basic})`);
    check(`${L}: Resume in the bar carries on typing where Claude stopped, and goes away`, resumed.held > 50 && resumed.queued === resumed.held && !resumed.paused && resumed.hidden, JSON.stringify(resumed));
    // paused again: Stop in the bar ends the turn and nothing held is typed later
    await page.focus('#screen');
    await page.keyboard.press('y');
    await waitFor(page, () => window.emu.session.claudePaused);
    await page.click('#btnClaudeStop');
    const stopped = await waitFor(page, () => !window.emu.session.claudePaused && !window.emu.session.chat.busy && document.getElementById('claudeStatus').hidden, null, 8000);
    await emuFrames(page, 30);
    check(`${L}: Stop in the bar while paused ends the turn; nothing held is typed later`, stopped && await page.evaluate((b) => { const m = (0, eval)(b)(); return m.stubKeys.length === 0 && m.typist.queue.length === 0; }, `(${basic})`));
    if (replies.held) { replies.held.release(); replies.held = null; }
    // a turn that acts and finishes, then a text-only turn: a key during it is the person's own
    replies.length = 0;
    replies.push({ body: tools([{ name: 'poke', input: { address: 0x3000, bytes: [0x33] } }]) }, { body: text('Poked.') });
    await page.evaluate(() => { window.emu.session.chat.sendLine('Poke 3000'); });
    await waitFor(page, `(${basic})().ram[0x3000] === 0x33 && !window.emu.session.chat.busy`, null, 8000);
    replies.push({ hold: true, body: text('Just words.') });
    await page.evaluate(() => { window.emu.session.chat.sendLine('What did you change?'); });
    await waitFor(page, () => window.emu.session.chat.busy && !document.getElementById('claudeStatus').hidden, null, 8000);
    await page.focus('#screen');
    await page.keyboard.press('z');
    const textOnly = await page.evaluate(() => ({ paused: !!window.emu.session.claudePaused, status: document.getElementById('claudeStatusText').textContent, resume: !document.getElementById('btnClaudeResume').hidden }));
    replies.held.release();
    const done = await waitFor(page, () => !window.emu.session.chat.busy, null, 8000);
    check(`${L}: a later text-only turn is not paused by a key (Thinking…, no Resume) and ends`, !textOnly.paused && textOnly.status === 'Thinking…' && !textOnly.resume && done, JSON.stringify(textOnly));
    check(`${L}: no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (1f) where the open side panel lies over the screen (701-959 px wide) it covers the pill: the panel's own
  // status line has Resume beside Stop; and the pill fits a 360 px phone ----
  for (const [vp, tag, opts] of [[{ width: 800, height: 800 }, '800 px'], [{ width: 360, height: 740 }, '360 px phone'],
    [{ width: 844, height: 390 }, 'phone sideways with its keyboard', { hasTouch: true, isMobile: true }]]) {
    const { ctx, page, errors, replies } = await open(vp, null, opts);
    const L = `ask (pause, ${tag})`;
    await page.evaluate(() => document.getElementById('btnAsk').click());
    await page.evaluate(() => window.emu.session.setClaudeAllowed(true));
    replies.push({ body: tools([{ name: 'type_text', input: { text: LISTING } }]) }, { hold: true, body: text('Typed.') });
    await page.evaluate(() => { window.emu.session.chat ? window.emu.session.chat.sendLine('Type a long listing for me') : null; });
    if (!(await page.evaluate(() => !!window.emu.session.chat))) { await page.fill('#askInput', 'Type a long listing for me'); await page.press('#askInput', 'Enter'); }
    await waitFor(page, () => window.emu.machine.typist.queue.length > 100 && window.emu.session.claudeBusyActing, null, 8000);
    await page.focus('#screen');
    await page.keyboard.press('x');
    await waitFor(page, () => !!window.emu.session.claudePaused);
    const where = await page.evaluate(() => { const t = document.querySelector('.tube').getBoundingClientRect();
      const on = (id) => { const b = document.getElementById(id), r = b.getBoundingClientRect(); return !b.hidden && r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); };
      const inTube = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return r.left >= t.left && r.right <= t.right; };
      const at = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; };
      return { statusResume: on('btnAskStatusResume'), statusStop: on('btnAskStatusStop'), pillResume: on('btnAskResume') && inTube('btnAskResume'), pillStop: on('btnAskStop') && inTube('btnAskStop'),
        at: [at('btnAskStatusResume'), at('btnAskStatusStop'), at('btnAskStop'), innerHeight] }; });
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `ask-paused-${tag.replace(/ /g, '-')}.png`) });
    // the 800 px panel covers the pill but its status has Resume and Stop; the phone's pill shows both whole
    // (sideways, the open panel covers part of the pill too: its status line has both)
    const ok = tag === '360 px phone' ? where.pillResume && where.pillStop : where.statusResume && where.statusStop;
    check(`${L}: Resume and Stop are on screen and uncovered while paused`, ok, JSON.stringify(where));
    if (opts) check(`${L}: (the touch keyboard is up)`, await page.evaluate(() => document.body.classList.contains('touch-keys')));
    await page.click(tag === '360 px phone' ? '#btnAskResume' : '#btnAskStatusResume');
    const resumed = await page.evaluate(() => !window.emu.session.claudePaused && window.emu.machine.typist.queue.length > 50);
    await page.focus('#screen');
    await page.keyboard.press('y');
    await waitFor(page, () => !!window.emu.session.claudePaused);
    await page.click(tag === '360 px phone' ? '#btnAskStop' : '#btnAskStatusStop');
    const stopped = await waitFor(page, () => !window.emu.session.claudePaused && !window.emu.session.chat.busy, null, 8000);
    check(`${L}: Resume carries on, and Stop ends the turn`, resumed && stopped);
    if (replies.held) replies.held.release();
    check(`${L}: no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (1e) a phone held sideways with its keyboard, full-screen chat: the keyboard covers the page, but the
  // turn's status with Resume and Stop stays above it, uncovered, and both work ----
  {
    const { ctx, page, errors, replies } = await open({ width: 844, height: 390 }, null, { hasTouch: true, isMobile: true });
    const L = 'ask (full-screen pause, sideways with the keyboard)';
    await page.evaluate(() => document.getElementById('btnAsk').click());
    await page.evaluate(() => window.emu.session.setClaudeAllowed(true));
    await page.evaluate(() => document.getElementById('btnAskFull').click());
    await waitFor(page, () => window.emu.session.claudeView === 'full' && !!window.emu.session.chatMachines && document.body.classList.contains('touch-keys')
      && document.body.classList.contains('chat-phone'), null, 15000);
    await page.evaluate(() => document.getElementById('btnClaudeView').click());
    await waitFor(page, () => window.emu.session.chatView === 'basic');
    replies.push({ body: tools([{ name: 'type_text', input: { text: LISTING } }]) }, { hold: true, body: text('Typed it.') });
    await page.evaluate(() => { window.emu.session.chat.sendLine('Type a long listing for me'); });
    await waitFor(page, () => window.emu.session.chatTarget().machine.typist.queue.length > 100 && window.emu.session.claudeBusyActing, null, 8000);
    await page.focus('#screen');
    await page.keyboard.press('x');
    await waitFor(page, () => !!window.emu.session.claudePaused && !document.getElementById('btnClaudeResume').hidden);
    // each button is on top where it is drawn (nothing covers it) and inside the window (the keyboard lets taps
    // through its gaps, pointer-events: none, which elementFromPoint skips: it is made hit-testable while measuring)
    const uncovered = await page.evaluate(() => { const tk = document.getElementById('touchKeys'), was = tk.style.pointerEvents; tk.style.pointerEvents = 'auto';
      const out = ['btnClaudeResume', 'btnClaudeStop'].map((id) => { const b = document.getElementById(id), r = b.getBoundingClientRect();
        return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); });
      tk.style.pointerEvents = was; return out; });
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'ask-paused-full-sideways.png') });
    check(`${L}: paused, Resume and Stop are on screen above the keyboard`, uncovered.every(Boolean), JSON.stringify(uncovered));
    await page.click('#btnClaudeResume');
    const resumed = await page.evaluate(() => !window.emu.session.claudePaused && window.emu.session.chatTarget().machine.typist.queue.length > 50);
    await page.focus('#screen');
    await page.keyboard.press('y');
    await waitFor(page, () => !!window.emu.session.claudePaused);
    await page.click('#btnClaudeStop');
    const stopped = await waitFor(page, () => !window.emu.session.claudePaused && !window.emu.session.chat.busy, null, 8000);
    check(`${L}: Resume carries on, and Stop ends the turn`, resumed && stopped);
    if (replies.held) replies.held.release();
    check(`${L}: no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (1c) Stop while assemble_and_load waits for an INCLUDE file that never arrives (side panel) ----
  {
    const { ctx, page, errors, replies, requests } = await open({ width: 1440, height: 900 });
    let includeAsked = 0;
    await ctx.route('**/examples/hang-forever.asm', () => { includeAsked++; /* never answered */ });
    await page.click('#btnAsk');
    await page.click('#chkAskMachine');
    const before = await page.evaluate(() => window.emu.machine.ram[0x3000]);
    replies.push({ body: tools([{ name: 'assemble_and_load', input: { source: ' INCLUDE "hang-forever.asm"\n FCB 9\n', org: 0x3000 } }]) }, { body: text('should not be asked') });
    await page.fill('#askInput', 'Assemble with the include');
    await page.press('#askInput', 'Enter');
    const shown = await waitFor(page, () => !document.getElementById('askStatus').hidden && document.getElementById('askStatusText').textContent === 'Using assemble_and_load…', null, 8000);
    for (let i = 0; i < 100 && !includeAsked; i++) await new Promise((r) => setTimeout(r, 50));
    check('ask (include): while the INCLUDE file hangs, the status says Using assemble_and_load… with Stop', shown && includeAsked === 1 && await page.isVisible('#btnAskStatusStop'), `asked ${includeAsked}`);
    await page.click('#btnAskStatusStop');
    const ended = await waitFor(page, () => !window.emu.session.chat.busy && document.getElementById('askStatus').hidden, null, 5000);
    check('ask (include): Stop ends the turn: no status, [stopped] shown, nothing written, no further request',
      ended && /\[stopped\]/.test(await page.textContent('#askMessages')) && await page.evaluate((b) => window.emu.machine.ram[0x3000] === b, before) && requests.length === 1, `requests ${requests.length}`);
    replies.length = 0;
    replies.push({ body: text('Still here.') });
    await page.fill('#askInput', 'Are you there?');
    await page.press('#askInput', 'Enter');
    check('ask (include): the next line is answered', await waitFor(page, () => /Still here\./.test(document.getElementById('askMessages').textContent) && !window.emu.session.chat.busy, null, 8000));
    // a refusal is not silent and not kept: the question and a note show; the next line is not glued to it
    replies.push({ body: sse([msgStart, { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: {} }, { type: 'message_stop' }]) }, { body: text('Sure.') });
    await page.fill('#askInput', 'Something refused');
    await page.press('#askInput', 'Enter');
    const declined = await waitFor(page, () => !window.emu.session.chat.busy && /Something refused\s*\[Claude declined to answer this one\.\]/.test(document.getElementById('askMessages').textContent), null, 8000);
    await page.fill('#askInput', 'Something else');
    await page.press('#askInput', 'Enter');
    await waitFor(page, () => /Sure\./.test(document.getElementById('askMessages').textContent), null, 8000);
    const last = requests[requests.length - 1].messages;
    check('ask (refusal): the question shows with "Claude declined", no empty bubble, and the refused question is not sent again',
      declined && !JSON.stringify(last).includes('Something refused') && last[last.length - 1].content === 'Something else'
      && await page.evaluate(() => [...document.querySelectorAll('#askMessages .msg')].every((m) => m.textContent.trim())), JSON.stringify(last));
    check('ask (include): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (2) the Debugger's opener in the Ctrl K box ----
  {
    const { ctx, page, errors, requests, replies } = await open({ width: 1440, height: 900 });
    // a small routine at $3000, the program counter there (the machine paused first, so it stays there)
    await page.click('#btnPause');
    await page.evaluate(() => { const m = window.emu.machine; [0x86, 0x41, 0xA7, 0x80, 0x5A, 0x26, 0xFB, 0x39].forEach((b, i) => m.poke(0x3000 + i, b)); m.cpu.pc = 0x3000; });
    await page.focus('#screen');
    await page.keyboard.press('Control+k');
    await page.keyboard.type('what is this code');
    const opts = await page.evaluate(() => [...document.querySelectorAll('#cmdBox [role="option"]')].map((o) => o.textContent));
    replies.push({ body: text('It stores A at X and counts B down.') });
    await page.keyboard.press('Enter');
    await waitFor(page, () => window.emu.session.chat && !window.emu.session.chat.busy && document.querySelectorAll('#askMessages .msg').length >= 2, null, 10000);
    const q = requests[0] && requests[0].messages.slice(-1)[0].content;
    check('ask (debugger): "What is this code doing?" is a command; it opens the panel and asks with the code at the program counter',
      /^What is this code doing\?/.test(opts[0]) && /^What is this code doing\? \(3000/.test(q || '') && /LDA\s+#\$41/.test(q) && /STA\s+,X\+/.test(q) && /RTS/.test(q) && /PC=3000/.test(q),
      `${JSON.stringify(opts)} ${JSON.stringify(q)}`);
    check('ask (debugger): the panel says Claude can read (emulator only) the code and the registers', /^Claude can read \(emulator only\):The code at \$3000Registers and symbols$/.test(await page.textContent('#askSee')));
    check('ask (debugger): none of the old wording is on the page', !(await oldCopy(page)).length, (await oldCopy(page)).join());
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'ask-debugger-desktop.png') });
    check('ask (debugger): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (3) the phone's own keyboard never covers the sheet ----
  {
    // a visual viewport the test can shrink, as the phone's keyboard does when the message box has focus
    const fake = () => {
      const vv = new EventTarget();
      Object.assign(vv, { width: innerWidth || 390, height: innerHeight || 844, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
      window.__vv = vv;
    };
    const { ctx, page, errors } = await open({ width: 390, height: 844 }, fake);
    await page.click('#btnAsk');
    await page.focus('#askInput');
    await page.evaluate(() => { window.__vv.height = 844 - 320; window.__vv.dispatchEvent(new Event('resize')); });
    const r = await page.evaluate(() => { const a = document.getElementById('ask').getBoundingClientRect(), i = document.getElementById('askInput').getBoundingClientRect(), s = document.getElementById('screen').getBoundingClientRect();
      return { bottom: a.bottom, top: a.top, input: i.bottom, inputTop: i.top, screenTop: s.top, screenBottom: s.bottom, height: a.height }; });
    check('ask (phone keyboard): with the phone\'s keyboard up, the sheet sits above it, the message box in view, the screen\'s top still visible',
      r.bottom <= 524 + 1 && r.input <= 524 && r.inputTop > r.top && r.height >= 150 && r.top > r.screenTop, JSON.stringify(r));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'ask-keyboard-phone.png') });
    await page.evaluate(() => { window.__vv.height = 844; window.__vv.dispatchEvent(new Event('resize')); });
    check('ask (phone keyboard): when it goes, the sheet goes back to the bottom edge', await waitFor(page, () => Math.abs(document.getElementById('ask').getBoundingClientRect().bottom - innerHeight) <= 1));
    check('ask (phone keyboard): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (5) full screen: the BASIC session's corner window starts hidden; Claude acting or
  // Ctrl+B shows it, and it stays until Ctrl+B again or its close button hides it ----
  for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const L = `full screen (${label})`;
    const { ctx, page, errors, replies } = await open(viewport);
    await page.goto(`${base}?machine=dragon64&app=claude`);
    await started(page);
    await waitFor(page, () => window.emu.session.claudeView === 'full', null, 15000);
    const pip = () => page.evaluate(() => ({ shown: !document.getElementById('claudePip').hidden, view: window.emu.session.chatView }));
    check(`${L}: on open the screen is the chat only; the BASIC session's window is hidden`, JSON.stringify(await pip()) === JSON.stringify({ shown: false, view: 'chat' }));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `full-chat-only-${label}.png`) });
    if (label === 'desktop') {
      await page.focus('#screen');
      await page.keyboard.press('Control+b');
      check(`${L}: Ctrl+B shows it (and swaps: the BASIC session big, the chat in the corner)`, await waitFor(page, () => !document.getElementById('claudePip').hidden && window.emu.session.chatView === 'basic'));
      await page.keyboard.press('Control+b');
      check(`${L}: Ctrl+B again swaps back and hides it`, await waitFor(page, () => document.getElementById('claudePip').hidden && window.emu.session.chatView === 'chat'));
    } else {
      await page.click('#btnClaudeView');
      check(`${L}: "Show my BASIC session" shows it (and swaps)`, await waitFor(page, () => !document.getElementById('claudePip').hidden && window.emu.session.chatView === 'basic'));
      await page.click('#btnClaudeView');
      check(`${L}: "Back to the chat" swaps back and hides it`, await waitFor(page, () => document.getElementById('claudePip').hidden && window.emu.session.chatView === 'chat'));
    }
    // the copy: the BASIC session's model in the card, nothing about "your screen" or "the machine switch"
    check(`${L}: the card says Claude reads this Dragon 64's screen text and memory, nothing outside the emulator`,
      (await page.textContent('#claudeConsentText')) === "Claude can read this Dragon 64's screen text and memory at any time, nothing outside the emulator. Typing, POKEs and running need your permission; loading a BASIC program asks every time (with the switch on, its card offers Don't ask again this session).", await page.textContent('#claudeConsentText'));
    check(`${L}: the switch is "Let Claude use the emulator"`, (await page.textContent('#claudeSession label.switch')).trim() === 'Let Claude use the emulator');
    check(`${L}: none of the old wording is on the page`, !(await oldCopy(page)).length, (await oldCopy(page)).join());
    // Claude acts: the window appears and stays after the turn
    await page.check('#chkClaudeTools');
    replies.push({ body: tools([{ name: 'type_text', input: { text: 'PRINT 1\n' } }]) }, { body: text('Typed it.') });
    await page.evaluate(() => window.emu.session.chat.sendLine('Type PRINT 1 for me'));
    check(`${L}: when Claude acts on the machine the window appears, with the chat still big`, await waitFor(page, () => !document.getElementById('claudePip').hidden
      && window.emu.session.chatView === 'chat' && !window.emu.session.chat.busy, null, 10000));
    await emuFrames(page, 60);
    check(`${L}: it stays shown after Claude's turn`, (await pip()).shown);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `full-after-acting-${label}.png`) });
    await page.click('#btnPipClose');
    check(`${L}: its close button hides it again`, JSON.stringify(await pip()) === JSON.stringify({ shown: false, view: 'chat' }));
    if (label === 'desktop') {
      // "What is this code doing?" from Ctrl+K while the chat is full screen: the code is the BASIC session's, not the chat firmware's
      // the BASIC session keeps running (so its program counter moves): the question names an address and the bytes there;
      // they must be the BASIC session's, and differ from the chat machine's at the same address
      // (asking opens the side panel and ends the full screen chat, so the chat machine's memory is copied first)
      await page.evaluate(() => { const c = window.emu.session.chatMachines.chat; window.__chatRam = Uint8Array.from(c.ram); });
      replies.push({ body: text('It stores A at X and counts B down.') });
      await page.focus('#screen');
      await page.keyboard.press('Control+k');
      await page.keyboard.type('what is this code');
      await page.keyboard.press('Enter');
      await waitFor(page, () => window.emu.session.chat.messages.some((m) => typeof m.content === 'string' && /^What is this code doing\?/.test(m.content)), null, 10000);
      await waitFor(page, () => !window.emu.session.chat.busy, null, 10000);
      const q = await page.evaluate(() => window.emu.session.chat.messages.filter((m) => typeof m.content === 'string' && /^What is this code doing\?/.test(m.content)).map((m) => m.content)[0] || '');
      const asked = await page.evaluate((qq) => { const s = window.emu.session, mm = /^What is this code doing\? \(([0-9A-F]{4})/.exec(qq), line = /\n\n([0-9A-F]{4}) {2}((?:[0-9A-F]{2} ?)+)/.exec(qq);
        if (!mm || !line) return null;
        const at = parseInt(line[1], 16), bytes = line[2].trim().split(' ').map((h) => parseInt(h, 16));
        return { at, basic: bytes.every((b, i) => s.readByte(at + i, s.machine) === b), chat: bytes.every((b, i) => window.__chatRam[at + i] === b), pcLine: /PC=([0-9A-F]{4})/.exec(qq)[1] }; }, q);
      check(`${L}: "What is this code doing?" in the full screen chat sends the BASIC session's code and registers, not the chat firmware's`,
        !!asked && asked.basic && !asked.chat && asked.pcLine === q.match(/\(([0-9A-F]{4})–/)[1], JSON.stringify([asked, q.slice(0, 120)]));
    }
    check(`${L}: no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (4) docking: from 960 px the panel docks beside the machine, which narrows but keeps at least 480 px;
  // below that (but above the phone layout) it lies over the page and the machine keeps its size ----
  {
    const { ctx, page, errors } = await open({ width: 1000, height: 800 });
    await page.click('#btnAsk');
    const d = await page.evaluate(() => { const a = document.getElementById('ask'), r = a.getBoundingClientRect(), m = document.getElementById('monitor').getBoundingClientRect();
      return { pos: getComputedStyle(a).position, left: r.left, right: r.right, width: r.width, monitorLeft: m.left, monitorRight: m.right, monitor: m.width, w: innerWidth,
        rail: getComputedStyle(document.getElementById('askRail')).display, fits: document.documentElement.scrollWidth <= innerWidth }; });
    check('ask (1000 px): the panel docks beside the machine (not over it); the machine narrows to at least 480 px; no sideways scroll',
      d.pos !== 'fixed' && d.left >= d.monitorRight && d.right <= d.w && d.width >= 320 && d.monitor >= 480 && d.rail === 'none' && d.fits, JSON.stringify(d));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'ask-docked-1000.png') });
    await page.fill('#askInput', 'hello');
    check('ask (1000 px): the message box is usable', await page.inputValue('#askInput') === 'hello');
    check('ask (1000 px): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open({ width: 900, height: 800 });
    const before = await page.evaluate(() => document.getElementById('monitor').getBoundingClientRect().width);
    await page.click('#btnAsk');
    const o = await page.evaluate(() => { const a = document.getElementById('ask'), r = a.getBoundingClientRect();
      return { pos: getComputedStyle(a).position, left: r.left, right: r.right, bottom: r.bottom, width: r.width, w: innerWidth, h: innerHeight,
        monitor: document.getElementById('monitor').getBoundingClientRect().width, fits: document.documentElement.scrollWidth <= innerWidth }; });
    check('ask (900 px, below the 960 px docking threshold): the panel lies over the page, inside the window; the machine keeps its size',
      o.pos === 'fixed' && o.right <= o.w && o.left >= 0 && o.bottom <= o.h && o.width >= 320 && Math.abs(o.monitor - before) < 1 && o.fits, JSON.stringify(Object.assign(o, { before })));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'ask-overlay-900.png') });
    check('ask (900 px): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (6) load_basic's own card: on every call, even with "Let Claude use the emulator" on, with "Don't ask again
  // this session". The machine in use gets BASIC's shape without a BASIC ROM: our idle firmware in the BASIC socket,
  // BASIC's pointers describing an empty program at $1E01 and OK on the screen (as tests/basic-load.test.js) ----
  {
    const { ctx, page, errors, requests, replies } = await open({ width: 1440, height: 900 });
    const ready = await page.evaluate(() => {
      const s = window.emu.session, m = s.machine, E = window.emu.Emu;
      const asm = E.assemble(' ORG $8000\nSTART STA $FFC9\n CLR $FF23\n LDA #$F8\n STA $FF22\n LDA #$04\n STA $FF23\n CLR $FF22\nIDLE BRA IDLE\n', '6809');
      const rom = new Uint8Array(0x4000).fill(0xFF); rom.set(asm.segments[0].data, 0);
      m.setRoms({ basic: rom }); m.reset(true); m.cpu.jump(asm.exec);
      const w = (a, v) => s.pokeBytes(a, [v >> 8, v & 0xFF], m);
      s.pokeBytes(0x1E00, [0, 0, 0], m);
      w(0x19, 0x1E01); w(0x1B, 0x1E03); w(0x1D, 0x1E03); w(0x1F, 0x1E03); w(0x21, 0x7E00);
      for (let i = 0; i < 512; i++) m.ram[0x400 + i] = 0x60;
      m.ram[0x440] = 0x0F; m.ram[0x441] = 0x0B;            // OK
      s.setClaudeAllowed(true);
      return m.hasRom;
    });
    await emuFrames(page, 3);
    const PROG = Array.from({ length: 20 }, (_, i) => `${(i + 1) * 10} PRINT "LINE ${i + 1}"`).join('\n');
    // (the BASIC session's memory, which is the machine in use until the conversation moves to full screen)
    const listing = () => page.evaluate(() => window.emu.Emu.listProgram((a) => window.emu.session.chatTarget().readByte(a), 0x1E01, 'dragon'));
    const loadCard = () => waitFor(page, () => !document.getElementById('askLoad').hidden, null, 15000);
    const askNow = async (q) => { await page.fill('#askInput', q); await page.press('#askInput', 'Enter'); };
    await page.click('#btnAsk');
    replies.push({ body: tools([{ name: 'load_basic', input: { program: PROG } }]) }, { body: text('Loaded.') });
    await askNow('Load my 20-line program');
    check('load card: with "Let Claude use the emulator" on, load_basic still asks with its own card, saying what it loads',
      ready && await loadCard() && await page.evaluate(() => window.emu.session.claudeAllowed) && await page.isHidden('#askConsent')
      && /20-line BASIC program \(lines 10 to 200, \d+ bytes\)/.test(await page.textContent('#askLoadText'))
      && /Don't ask again this session/.test(await page.textContent('#askLoad')) && !(await page.isChecked('#chkAskLoadNoAsk')), await page.textContent('#askLoad'));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'ask-load-basic-card.png') });
    await page.click('#btnAskLoad');
    await waitFor(page, (n) => !window.emu.session.chat.busy && window.emu.session.chat.messages.length >= n, 2, 15000);
    const r1 = requests[1] && requests[1].messages.slice(-1)[0].content;
    check('load card: Load it loads the program (the tool result and the program in memory)', Array.isArray(r1) && !r1[0].is_error && JSON.parse(r1[0].content).lines === 20
      && (await listing()).split('\n').length === 20 && await page.isHidden('#askLoad'), JSON.stringify(r1 && r1[0]).slice(0, 200));
    // the next call asks again; this time "Don't ask again this session" is ticked
    replies.push({ body: tools([{ name: 'load_basic', input: { program: '10 PRINT "TWO"' } }]) }, { body: text('Loaded again.') });
    await askNow('Load another');
    check('load card: the next load_basic asks again (every call), with the box unticked', await loadCard() && !(await page.isChecked('#chkAskLoadNoAsk')));
    await page.check('#chkAskLoadNoAsk');
    await page.click('#btnAskLoad');
    await waitFor(page, (n) => !window.emu.session.chat.busy && window.emu.session.chat.messages.length >= n, 4, 15000);
    check('load card: ticked and loaded: this session does not ask again', await page.evaluate(() => window.emu.session.claudeLoadNoAsk) && (await listing()) === '10 PRINT "TWO"');
    // a third load goes straight in: no card
    replies.push({ body: tools([{ name: 'load_basic', input: { program: '10 PRINT "THREE"' } }]) }, { body: text('Done.') });
    let carded = false;
    await askNow('And one more');
    for (let i = 0; i < 60 && await page.evaluate(() => window.emu.session.chat.messages.length < 6); i++) {
      carded = carded || !(await page.isHidden('#askLoad'));
      await emuFrames(page, 2);
    }
    check('load card: after "Don\'t ask again this session" the next load goes in with no card', !carded && (await listing()) === '10 PRINT "THREE"');

    // one turn that calls load_basic, sent by the side panel's box (or, in full screen, straight to the chat); returns
    // once the card is up, and settle() waits for the turn to end and gives the tool result Claude got
    const lbTurn = async (program, send) => {
      replies.push({ body: tools([{ name: 'load_basic', input: { program } }]) }, { body: text('Ok.') });
      const n = requests.length;
      await send();
      return { n, settle: async () => {
        await waitFor(page, () => !window.emu.session.chat.busy, null, 15000);
        for (const t = Date.now(); requests.length < n + 2 && Date.now() - t < 30000;) await page.waitForTimeout(50);   // the tool result's request (the caller checks what came)
        await waitFor(page, () => !window.emu.session.chat.busy, null, 15000);
        const c = requests[n + 1] && requests[n + 1].messages.slice(-1)[0].content;
        try { return { isError: !!c[0].is_error, out: JSON.parse(c[0].content) }; } catch (e) { return { isError: null, out: c }; }
      } };
    };
    const sidePanel = (q) => () => askNow(q);
    const boxShown = (id) => page.evaluate((x) => { const b = document.getElementById(x); return !b.closest('label').hidden && b.offsetParent !== null; }, id);

    // the switch off from the page: it is unticked, acting is no longer allowed, and "Don't ask again" is cleared
    await page.click('#chkAskMachine');
    await emuFrames(page, 1);
    check('switch off from the page (side panel): the box is unticked, acting is off and "Don\'t ask again" is cleared',
      !(await page.isChecked('#chkAskMachine')) && await page.evaluate(() => !window.emu.session.claudeAllowed && !window.emu.session.claudeLoadNoAsk));
    // with the switch off the card has no "Don't ask again" box, and ticking it anyway (as a script could) loads this
    // program but does not stop the next card: no load can go in silently
    let t = await lbTurn('10 PRINT "FOUR"', sidePanel('Load four'));
    check('switch off: load_basic has its card, without the "Don\'t ask again this session" box', await loadCard() && !(await boxShown('chkAskLoadNoAsk')));
    // ticked and clicked in one step, so no render between them can untick it before Load it reads it
    const sentTicked = await page.evaluate(() => { const b = document.getElementById('chkAskLoadNoAsk'); b.checked = true; document.getElementById('btnAskLoad').click(); return b.checked; });
    let res = await t.settle();
    check('switch off: Load it loads, and a ticked hidden box does not turn the card off', sentTicked && res.isError === false && res.out.lines === 1 && (await listing()) === '10 PRINT "FOUR"'
      && await page.evaluate(() => !window.emu.session.claudeLoadNoAsk), JSON.stringify(res));
    t = await lbTurn('10 PRINT "FIVE"', sidePanel('Load five'));
    check('switch off: the next load_basic asks again (no silent load), still without the box', await loadCard() && !(await boxShown('chkAskLoadNoAsk')));
    // the side panel's Don't load: Claude gets load-declined, the card goes, the program in memory stays
    await page.click('#btnAskLoadNo');
    res = await t.settle();
    check('side panel: Don\'t load gives Claude load-declined, closes the card and leaves the program in memory as it was',
      res.isError === true && res.out.error && res.out.error.code === 'load-declined' && await page.isHidden('#askLoad') && (await listing()) === '10 PRINT "FOUR"', JSON.stringify(res));
    // switch on again: the box is back, unticked; ticked and then Don't load, the next card starts unticked again
    await page.click('#chkAskMachine');
    t = await lbTurn('10 PRINT "SIX"', sidePanel('Load six'));
    check('switch on: the card offers "Don\'t ask again this session", unticked', await loadCard() && await boxShown('chkAskLoadNoAsk') && !(await page.isChecked('#chkAskLoadNoAsk')));
    await page.check('#chkAskLoadNoAsk');
    await page.click('#btnAskLoadNo');
    res = await t.settle();
    check('side panel: ticked, then Don\'t load: load-declined, nothing loaded, and the session still asks', res.out.error && res.out.error.code === 'load-declined'
      && (await listing()) === '10 PRINT "FOUR"' && await page.evaluate(() => !window.emu.session.claudeLoadNoAsk), JSON.stringify(res));
    t = await lbTurn('10 PRINT "SEVEN"', sidePanel('Load seven'));
    check('side panel: the next card starts with the box unticked (a tick does not carry over to the next card)', await loadCard() && !(await page.isChecked('#chkAskLoadNoAsk')));
    await page.click('#btnAskLoadNo');
    res = await t.settle();
    check('side panel: Don\'t load on the next card: load-declined', !!(res.out && res.out.error && res.out.error.code === 'load-declined'), JSON.stringify(res));

    // the full-screen card (#claudeLoad): the conversation moves to full screen, the machine in use is the BASIC session
    await page.click('#btnAskFull');
    await waitFor(page, () => window.emu.session.claudeView === 'full' && !!window.emu.session.chatMachines, null, 15000);
    const fullCard = () => waitFor(page, () => !document.getElementById('claudeLoad').hidden, null, 15000);
    const fullSend = (q) => () => page.evaluate((x) => { window.emu.session.chat.sendLine(x); }, q);
    t = await lbTurn('10 PRINT "EIGHT"', fullSend('load eight'));
    check('full screen: load_basic has its card with the switch on, offering the box unticked', await fullCard() && await page.isChecked('#chkClaudeTools')
      && await boxShown('chkClaudeLoadNoAsk') && !(await page.isChecked('#chkClaudeLoadNoAsk')) && /1-line BASIC program \(line 10, \d+ bytes\)/.test(await page.textContent('#claudeLoadText')));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'claude-load-basic-card.png') });
    await page.check('#chkClaudeLoadNoAsk');
    await page.click('#btnClaudeLoadNo');
    res = await t.settle();
    check('full screen: ticked, then Don\'t load: Claude gets load-declined, the card goes, nothing is loaded, the session still asks',
      res.isError === true && res.out.error && res.out.error.code === 'load-declined' && await page.isHidden('#claudeLoad') && (await listing()) === '10 PRINT "FOUR"'
      && await page.evaluate(() => !window.emu.session.claudeLoadNoAsk), JSON.stringify(res));
    t = await lbTurn('10 PRINT "NINE"', fullSend('load nine'));
    check('full screen: the next card starts with the box unticked', await fullCard() && !(await page.isChecked('#chkClaudeLoadNoAsk')));
    await page.click('#btnClaudeLoad');
    res = await t.settle();
    check('full screen: Load it loads the program (the tool result and the program in memory)', res.isError === false && res.out.lines === 1 && await page.isHidden('#claudeLoad')
      && (await listing()) === '10 PRINT "NINE"', JSON.stringify(res));
    // the full-screen switch off: acting off, and the next card has no box
    await page.click('#chkClaudeTools');
    t = await lbTurn('10 PRINT "TEN"', fullSend('load ten'));
    check('full screen: switch off from the page: acting is off and the card has no "Don\'t ask again" box', await fullCard() && !(await page.isChecked('#chkClaudeTools'))
      && await page.evaluate(() => !window.emu.session.claudeAllowed) && !(await boxShown('chkClaudeLoadNoAsk')));
    await page.click('#btnClaudeLoadNo');
    res = await t.settle();
    check('full screen: Don\'t load with the switch off: load-declined, nothing loaded', res.out.error && res.out.error.code === 'load-declined' && (await listing()) === '10 PRINT "NINE"', JSON.stringify(res));
    check('load card: no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }
}

// Ask Claude's turn status (the live bug of 0.1.1-pre: "yes" sent in the side panel, then nothing at all while
// Claude thought, streamed a long load_basic call or waited on its card). Every state of a turn shows a status with
// Stop, in the side panel, the full-screen chat and the phone sheet: "Thinking…" while the reply streams or the model
// thinks, "Waiting for your OK" with the card in view, "Using <tool>…" while a tool runs. Errors (HTTP, network, an
// SSE error event, an exception in the tool loop) and a stalled stream end the turn with a message, and the input
// works again. The API is a mocked fetch in the page (a stream the check controls, so it can be slow or stall), never
// the real API, and the key never shows in a log or on the page.
// R10 and the pause's reach: while Claude is paused (a key pressed while it acted), Esc stops Claude in every view
// and is not also BREAK; a confirmation, menu or card open during the pause takes the first Esc; the browser's
// Fullscreen shows Claude's status with Stop (and Resume while paused); a Reset, a power cycle, a snapshot load or
// a machine switch during a pause stops Claude. Every case ends with resumeClaude(): it must type nothing.
async function askEscChecks(browser, base, check) {
  const KEY = 'sk-ant-ESC-CHECK-KEY-0123456789';
  const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const msgStart = { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } };
  const text = (t) => sse([msgStart, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]);
  const tools = (uses) => sse([msgStart, ...uses.flatMap((u, i) => [
    { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_${i}`, name: u.name, input: {} } },
    { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(u.input) } },
    { type: 'content_block_stop', index: i }]), { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} }, { type: 'message_stop' }]);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  const LISTING = Array.from({ length: 1500 }, (_, i) => `${(i + 1) * 10} PRINT "LINE ${i + 1}"`).join('\n') + '\n';
  async function open(viewport, opts = {}) {
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block', ...opts });
    const page = await ctx.newPage();
    const errors = [], replies = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await ctx.route('https://api.anthropic.com/**', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const r = replies.shift() || { body: text('ok') };
      if (r.hold) await new Promise((res) => { r.release = res; replies.held = r; });
      try { await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: r.body }); } catch (e) { /* stopped */ }
    });
    await page.goto(`${base}?machine=dragon64`);
    await started(page);
    await stubPrompt(page);
    await page.evaluate((k) => localStorage.setItem('cloadm.anthropicKey', k), KEY);
    // every code the page puts into a machine's stub key queue from now on (a BREAK from Esc is code 3)
    await page.evaluate(() => {
      window.__pushed = [];
      const tap = (m) => { if (!m || m.__tapped) return; m.__tapped = true; const push = m.stubKeys.push.bind(m.stubKeys); m.stubKeys.push = (...c) => { window.__pushed.push(...c); return push(...c); }; };
      tap(window.emu.machine);
      window.emu.session.on(() => { tap(window.emu.session.machine); if (window.emu.session.chatMachines) { tap(window.emu.session.chatMachines.basic); tap(window.emu.session.chatMachines.chat); } });
    });
    return { ctx, page, errors, replies };
  }
  // the side panel (or the full-screen chat), the switch on, Claude typing a long listing into the BASIC session
  async function typing(page, replies, { full = false, basicView = true } = {}) {
    await page.evaluate(() => document.getElementById('btnAsk').click());
    await page.evaluate(() => window.emu.session.setClaudeAllowed(true));
    if (full) {
      await page.evaluate(() => document.getElementById('btnAskFull').click());
      await waitFor(page, () => window.emu.session.claudeView === 'full' && !!window.emu.session.chatMachines, null, 15000);
      if (basicView) { await page.evaluate(() => document.getElementById('btnClaudeView').click()); await waitFor(page, () => window.emu.session.chatView === 'basic'); }
    }
    replies.push({ body: tools([{ name: 'type_text', input: { text: LISTING } }]) }, { hold: true, body: text('Typed.') });
    await page.evaluate(() => { window.emu.session.chat.sendLine('Type a long listing for me'); });
    return waitFor(page, () => window.emu.session.chatTarget().machine.typist.queue.length > 100 && window.emu.session.claudeBusyActing, null, 8000);
  }
  // the page's Fullscreen button, under a real click (Fullscreen needs the person's gesture; where the layout hides
  // the button, a test button clicks it)
  async function goFull(page) {
    await page.evaluate(() => { const b = document.createElement('button'); b.id = 'testFull'; b.textContent = 'F';
      Object.assign(b.style, { position: 'fixed', left: '0', bottom: '0', zIndex: 99999 }); b.onclick = () => document.getElementById('btnFull').click(); document.body.append(b); });
    await page.click('#testFull');
    await page.evaluate(() => document.getElementById('testFull').remove());
  }
  async function pause(page) {
    await page.focus('#screen');
    await page.keyboard.press('x');
    return waitFor(page, () => !!window.emu.session.claudePaused);
  }
  // stopped: not paused, the turn over; then Resume (as the page's buttons call it) types nothing, now or later
  async function stoppedForGood(page) {
    const ended = await waitFor(page, () => !window.emu.session.claudePaused && !(window.emu.session.chat && window.emu.session.chat.busy), null, 8000);
    const r = await page.evaluate(() => { const s = window.emu.session, m = s.chatTarget().machine; window.__pushed.length = 0;
      return { paused: !!s.claudePaused, busy: !!(s.chat && s.chat.busy), resumed: s.resumeClaude(), queued: m.typist.queue.length + m.stubKeys.length }; });
    await emuFrames(page, 30);
    const later = await page.evaluate(() => { const m = window.emu.session.chatTarget().machine; return m.typist.queue.length + m.stubKeys.length + window.__pushed.length; });
    return { ok: ended && !r.paused && !r.busy && r.resumed === false && r.queued === 0 && later === 0, ...r, later };
  }

  // ---- (1) R10: Esc during a pause stops Claude in every view, and is not BREAK ----
  const views = [
    ['side panel, 1440', { width: 1440, height: 900 }],
    ['side panel over the screen, 800', { width: 800, height: 800 }],
    ['phone sheet', { width: 390, height: 844 }, { hasTouch: true, isMobile: true }],
    ['minimised', { width: 1440, height: 900 }, null, { min: true }],
    ['side panel sideways with the touch keyboard', { width: 844, height: 390 }, { hasTouch: true, isMobile: true }],
    ['full-screen chat, BASIC view', { width: 1440, height: 900 }, null, { full: true }],
    ['full-screen chat, chat view', { width: 1440, height: 900 }, null, { full: true, back: true }],
    ['full-screen chat sideways with the touch keyboard, BASIC view', { width: 844, height: 390 }, { hasTouch: true, isMobile: true }, { full: true }],
    ['full-screen chat sideways with the touch keyboard, chat view', { width: 844, height: 390 }, { hasTouch: true, isMobile: true }, { full: true, back: true }],
  ];
  for (const [tag, vp, opts, how = {}] of views) {
    const { ctx, page, errors, replies } = await open(vp, opts || {});
    const L = `askEsc (Esc while paused, ${tag})`;
    const going = await typing(page, replies, { full: how.full });
    if (how.min) await page.evaluate(() => document.getElementById('btnAskMin').click());
    const paused = await pause(page);
    const status = await page.evaluate(() => window.emu.session.claudeStatus && window.emu.session.claudeStatus.text);
    // (the chat view: back to the chat after the pause, by Ctrl+B)
    if (how.back) { await page.keyboard.press('Control+b'); await waitFor(page, () => window.emu.session.chatView === 'chat'); }
    if (opts) check(`${L}: (the touch keyboard is up)`, await page.evaluate(() => document.body.classList.contains('touch-keys') || !matchMedia('(orientation: landscape)').matches));
    await page.focus('#screen');
    await page.evaluate(() => { window.__pushed.length = 0; });
    await page.keyboard.press('Escape');
    const breakSent = await page.evaluate(() => window.__pushed.includes(3));
    const after = await stoppedForGood(page);
    check(`${L}: Esc ends the pause and the turn, sends no BREAK, and a Resume afterwards types nothing`,
      going && paused && /Esc stops Claude/.test(status) && !breakSent && after.ok, JSON.stringify({ going, paused, status, breakSent, after }));
    if (replies.held) replies.held.release();
    check(`${L}: no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (1a) the pausing key and the Esc in one task (a busy page: no timer has run between them): Esc still stops ----
  for (const [tag, vp, opts] of [['1440', { width: 1440, height: 900 }], ['phone sheet', { width: 390, height: 844 }, { hasTouch: true, isMobile: true }]]) {
    const { ctx, page, errors, replies } = await open(vp, opts || {});
    await typing(page, replies);
    const r = await page.evaluate(() => { const c = document.getElementById('screen'); c.focus(); window.__pushed.length = 0;
      const key = (type, key, code) => c.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true }));
      key('keydown', 'x', 'KeyX'); key('keyup', 'x', 'KeyX');
      const paused = !!window.emu.session.claudePaused;
      key('keydown', 'Escape', 'Escape'); key('keyup', 'Escape', 'Escape');
      return { paused, breakSent: window.__pushed.includes(3) }; });
    const after = await stoppedForGood(page);
    check(`askEsc (Esc right after the pausing key, ${tag}): Esc stops Claude, no BREAK, Resume afterwards types nothing`, r.paused && !r.breakSent && after.ok, JSON.stringify({ r, after }));
    if (replies.held) replies.held.release();
    check(`askEsc (Esc right after the pausing key, ${tag}): no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (1b) Esc when not paused is unchanged: an Esc that pauses Claude is the person's BREAK (the pause goes on) ----
  {
    const { ctx, page, errors, replies } = await open({ width: 1440, height: 900 });
    await typing(page, replies);
    await page.focus('#screen');
    await page.evaluate(() => { window.__pushed.length = 0; });
    await page.keyboard.press('Escape');
    const r = await page.evaluate(() => ({ paused: !!window.emu.session.claudePaused, busy: window.emu.session.chat.busy, breakSent: window.__pushed.includes(3) }));
    check('askEsc (Esc not paused): Esc while Claude types pauses Claude and is BREAK, as before (the turn goes on)', r.paused && r.busy && r.breakSent, JSON.stringify(r));
    await page.click('#btnAskStop');
    check('askEsc (Esc not paused): Stop then ends it', (await stoppedForGood(page)).ok);
    if (replies.held) replies.held.release();
    check('askEsc (Esc not paused): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (1b') Esc held down (autorepeat) while Claude types: the first press pauses and is BREAK; its repeats are the
  // same press, so they do not stop Claude ----
  {
    const { ctx, page, errors, replies } = await open({ width: 1440, height: 900 });
    await typing(page, replies);
    await page.focus('#screen');
    await page.keyboard.down('Escape');
    await page.keyboard.down('Escape');
    await page.keyboard.down('Escape');
    await page.keyboard.up('Escape');
    const r = await page.evaluate(() => ({ paused: !!window.emu.session.claudePaused, busy: window.emu.session.chat.busy }));
    check('askEsc (Esc held): an Esc held down while Claude types pauses Claude and its repeats do not stop it', r.paused && r.busy, JSON.stringify(r));
    await page.keyboard.press('Escape');
    check('askEsc (Esc held): the next Esc press stops Claude', (await stoppedForGood(page)).ok);
    if (replies.held) replies.held.release();
    check('askEsc (Esc held): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // a modifier let go while Esc is held does not end the press: Shift down, Esc down, Shift up, Esc repeats
  {
    const { ctx, page, errors, replies } = await open({ width: 1440, height: 900 });
    await typing(page, replies);
    await page.focus('#screen');
    await page.keyboard.down('Shift');
    await page.keyboard.down('Escape');
    await page.keyboard.up('Shift');
    await page.keyboard.down('Escape');
    await page.keyboard.up('Escape');
    const r = await page.evaluate(() => ({ paused: !!window.emu.session.claudePaused, busy: window.emu.session.chat.busy }));
    check('askEsc (Esc held, Shift let go): the repeat after letting go of Shift is the same press, not a Stop', r.paused && r.busy, JSON.stringify(r));
    await page.keyboard.press('Escape');
    check('askEsc (Esc held, Shift let go): the next Esc press stops Claude', (await stoppedForGood(page)).ok);
    if (replies.held) replies.held.release();
    check('askEsc (Esc held, Shift let go): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // and a modifier pressed while Esc is held: Esc down, Shift down, Esc repeats
  {
    const { ctx, page, errors, replies } = await open({ width: 1440, height: 900 });
    await typing(page, replies);
    await page.focus('#screen');
    await page.keyboard.down('Escape');
    await page.keyboard.down('Shift');
    await page.keyboard.down('Escape');
    await page.keyboard.up('Escape');
    await page.keyboard.up('Shift');
    const r = await page.evaluate(() => ({ paused: !!window.emu.session.claudePaused, busy: window.emu.session.chat.busy }));
    check('askEsc (Esc held, Shift pressed): the repeat after pressing Shift is the same press, not a Stop', r.paused && r.busy, JSON.stringify(r));
    await page.keyboard.press('Escape');
    check('askEsc (Esc held, Shift pressed): the next Esc press stops Claude', (await stoppedForGood(page)).ok);
    if (replies.held) replies.held.release();
    check('askEsc (Esc held, Shift pressed): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // AltGr (AltGraph) and CapsLock pressed and let go while Esc is held: the same press
  for (const key of ['AltGraph', 'CapsLock']) {
    const { ctx, page, errors, replies } = await open({ width: 1440, height: 900 });
    await typing(page, replies);
    await page.focus('#screen');
    await page.keyboard.down('Escape');
    await page.keyboard.down(key);
    await page.keyboard.up(key);
    await page.keyboard.down('Escape');
    await page.keyboard.up('Escape');
    const r = await page.evaluate(() => ({ paused: !!window.emu.session.claudePaused, busy: window.emu.session.chat.busy }));
    check(`askEsc (Esc held, ${key} pressed): the repeat is the same press, not a Stop`, r.paused && r.busy, JSON.stringify(r));
    await page.click('#btnAskStop');
    if (replies.held) replies.held.release();
    check(`askEsc (Esc held, ${key}): no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }
  // an Esc that only closes a card above the screen while Claude types (not paused) is not a key on the machine:
  // no BREAK, and it does not pause Claude
  {
    const { ctx, page, errors, replies } = await open({ width: 1440, height: 900 });
    await typing(page, replies);
    await page.evaluate(() => { document.getElementById('mediaOfferText').textContent = 'A test offer'; document.getElementById('mediaOffer').hidden = false; window.__pushed.length = 0; });
    await page.focus('#screen');
    await page.keyboard.press('Escape');
    const r = await page.evaluate(() => ({ closed: document.getElementById('mediaOffer').hidden, paused: !!window.emu.session.claudePaused, busy: window.emu.session.chat.busy, breakSent: window.__pushed.includes(3) }));
    check('askEsc (card, not paused): Esc closes the card above the screen, sends no BREAK and does not pause Claude', r.closed && !r.paused && r.busy && !r.breakSent, JSON.stringify(r));
    await page.click('#btnAskStop');
    if (replies.held) replies.held.release();
    check('askEsc (card, not paused): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (1c) Esc order: a menu (the command box) or a card open during the pause takes the first Esc; the next stops ----
  {
    const { ctx, page, errors, replies } = await open({ width: 1440, height: 900 });
    await typing(page, replies);
    await pause(page);
    await page.keyboard.press('Control+k');
    const boxOpen = await waitFor(page, () => !document.getElementById('cmdBox').hidden);
    await page.keyboard.press('Escape');
    const first = await page.evaluate(() => ({ paused: !!window.emu.session.claudePaused, closed: document.getElementById('cmdBox').hidden }));
    await page.keyboard.press('Escape');
    const after = await stoppedForGood(page);
    check('askEsc (order): with the command box open during a pause, the first Esc closes it (still paused), the next stops Claude',
      boxOpen && first.closed && first.paused && after.ok, JSON.stringify({ boxOpen, first, after }));
    if (replies.held) replies.held.release();
    check('askEsc (order): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // a card above the screen (the media offer, page.onEscape rank card) with the focus on the screen: the same order
  {
    const { ctx, page, errors, replies } = await open({ width: 1440, height: 900 });
    await typing(page, replies);
    await pause(page);
    await page.evaluate(() => { document.getElementById('mediaOfferText').textContent = 'A test offer'; document.getElementById('mediaOffer').hidden = false; });
    await page.focus('#screen');
    await page.keyboard.press('Escape');
    const first = await page.evaluate(() => ({ paused: !!window.emu.session.claudePaused, closed: document.getElementById('mediaOffer').hidden, breakSent: window.__pushed.includes(3) }));
    await page.focus('#screen');
    await page.keyboard.press('Escape');
    const after = await stoppedForGood(page);
    check('askEsc (order): with a card above the screen during a pause, Esc on the screen closes the card first (still paused, no BREAK), the next stops Claude',
      first.closed && first.paused && !first.breakSent && after.ok, JSON.stringify({ first, after }));
    if (replies.held) replies.held.release();
    check('askEsc (order, card): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (2) the browser's Fullscreen: Claude's status with Stop (and Resume while paused) inside it ----
  for (const [tag, vp, opts] of [['1440', { width: 1440, height: 900 }], ['800', { width: 800, height: 800 }],
    ['390 touch', { width: 390, height: 844 }, { hasTouch: true, isMobile: true }], ['844×390 touch', { width: 844, height: 390 }, { hasTouch: true, isMobile: true }]]) {
    const { ctx, page, errors, replies } = await open(vp, opts || {});
    const L = `askEsc (browser Fullscreen, ${tag})`;
    await typing(page, replies);
    await goFull(page);
    const isFull = await waitFor(page, () => document.fullscreenElement === document.getElementById('screenWrap'));
    const hit = (ids) => page.evaluate((ids) => ids.map((id) => { const b = document.getElementById(id), r = b.getBoundingClientRect();
      return !b.hidden && r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); }), ids);
    await waitFor(page, () => !document.getElementById('fsClaude').hidden);
    const acting = { stop: (await hit(['btnFsStop']))[0], resumeHidden: await page.evaluate(() => document.getElementById('btnFsResume').hidden), text: await page.textContent('#fsClaudeText') };
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `ask-fullscreen-acting-${tag.replace(/[ ×]/g, '-')}.png`) });
    check(`${L}: acting, unpaused: the status with Stop is on the fullscreen screen and clickable`, isFull && acting.stop && acting.resumeHidden && /Claude is typing/.test(acting.text), JSON.stringify(acting));
    await page.focus('#screen');
    await page.keyboard.press('x');
    await waitFor(page, () => !!window.emu.session.claudePaused && !document.getElementById('btnFsResume').hidden);
    const paused = { both: await hit(['btnFsResume', 'btnFsStop']), text: await page.textContent('#fsClaudeText'), still: await page.evaluate(() => document.fullscreenElement === document.getElementById('screenWrap')) };
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `ask-fullscreen-paused-${tag.replace(/[ ×]/g, '-')}.png`) });
    check(`${L}: paused: Resume and Stop are on the fullscreen screen and clickable, the status says Esc stops Claude`, paused.both.every(Boolean) && /Esc stops Claude/.test(paused.text) && paused.still, JSON.stringify(paused));
    await page.click('#btnFsResume');
    const resumed = await page.evaluate(() => !window.emu.session.claudePaused && window.emu.machine.typist.queue.length > 50);
    await page.focus('#screen');
    await page.keyboard.press('y');
    await waitFor(page, () => !!window.emu.session.claudePaused);
    await page.click('#btnFsStop');
    const after = await stoppedForGood(page);
    check(`${L}: Resume carries on; Stop ends the turn and nothing is typed later`, resumed && after.ok, JSON.stringify({ resumed, after }));
    if (replies.held) replies.held.release();
    check(`${L}: no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }
  // leaving Fullscreen while paused (the browser's Esc there) stops Claude
  {
    const { ctx, page, errors, replies } = await open({ width: 1440, height: 900 });
    await typing(page, replies);
    await goFull(page);
    await waitFor(page, () => document.fullscreenElement === document.getElementById('screenWrap'));
    await pause(page);
    await page.evaluate(() => document.exitFullscreen());
    const after = await stoppedForGood(page);
    check('askEsc (browser Fullscreen): leaving it while paused (Esc there) stops Claude; Resume afterwards types nothing', after.ok, JSON.stringify(after));
    if (replies.held) replies.held.release();
    check('askEsc (browser Fullscreen, leave): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (2b) what the program on the machine asks for itself is not the person's doing: Claude typing 1 on the
  // welcome menu starts LIZA through the page's handler, and Claude's turn goes on ----
  {
    const { ctx, page, errors, replies } = await open({ width: 1440, height: 900 });
    await page.evaluate(() => document.getElementById('btnAsk').click());
    await page.evaluate(async () => { const s = window.emu.session; s.setClaudeAllowed(true);
      const r = await fetch(`examples/${s.welcomeFile}`); s.startWelcome(new Uint8Array(await r.arrayBuffer())); });
    await emuFrames(page, 120);
    replies.push({ body: tools([{ name: 'type_text', input: { text: '1' } }]) }, { hold: true, body: text('LIZA is up.') });
    await page.evaluate(() => { window.emu.session.chat.sendLine('Start LIZA for me'); });
    const up = await waitFor(page, () => !!window.emu.session.lastRun && window.emu.session.lastRun.kind === 'liza', null, 15000);
    await emuFrames(page, 30);
    const r = await page.evaluate(() => ({ busy: window.emu.session.chat.busy, err: window.emu.session.chat.error && window.emu.session.chat.error.code, note: document.getElementById('askMessages').textContent }));
    check('askEsc (welcome menu): Claude choosing LIZA with its own key starts LIZA, and Claude\'s turn goes on (not stopped, no note)',
      up && r.busy && !r.err && !/stopped/.test(r.note), JSON.stringify({ up, ...r, note: r.note.slice(-80) }));
    if (replies.held) replies.held.release();
    check('askEsc (welcome menu): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ... but only the start itself is the machine's: the person's Reset while the page fetches what the machine
  // asked for (LIZA's bytes held back here) stops Claude, and nothing stays exempt afterwards
  {
    const { ctx, page, errors, replies } = await open({ width: 1440, height: 900 });
    let release = null;
    await ctx.route('**/examples/liza.bin', async (route) => { await new Promise((r) => { release = r; }); await route.continue(); });
    await typing(page, replies);
    await page.evaluate(() => { window.emu.session.emit('welcome:liza'); });
    for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 50));
    await page.evaluate(() => document.getElementById('btnReset').click());
    const stopped = await waitFor(page, () => !window.emu.session.chat.busy && !window.emu.session.claudeBusyActing, null, 8000);
    const note = await page.textContent('#askMessages');
    if (release) release();
    const after = await waitFor(page, () => !!window.emu.session.lastRun && window.emu.session.lastRun.kind === 'liza', null, 15000);
    const driven = await page.evaluate(() => window.emu.session.machineDriven);
    check('askEsc (welcome menu): the person\'s Reset while the machine\'s LIZA is fetched stops Claude ("you reset the machine"); the exemption covers only the start',
      !!release && stopped && /\[stopped: you reset the machine\]/.test(note) && after && driven === null, JSON.stringify({ fetched: !!release, stopped, after, driven, note: note.slice(-60) }));
    if (replies.held) replies.held.release();
    check('askEsc (welcome menu, Reset meanwhile): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (3) a Reset, a power cycle, a snapshot load or a machine switch during a pause stops Claude ----
  for (const [tag, act, full] of [
    ['Reset', (page) => page.evaluate(() => document.getElementById('btnReset').click())],
    ['power cycle', (page) => page.evaluate(() => document.getElementById('btnHardReset').click())],
    ['Reset, full-screen chat', (page) => page.evaluate(() => document.getElementById('btnReset').click()), true],
    ['snapshot load', async (page) => page.evaluate(async () => { const s = window.emu.session; await s.saveSlot(1); s.openSnapshot(await s.readSlot(1)); s.emit('chat'); })],
    ['machine switch', (page) => page.evaluate(() => { window.emu.session.chooseMachine('coco2'); })],
    // (any other restart of the machine, here a program file opened from the page: it starts on a reset)
    // (a DECB .bin: the page offers a CoCo first, and Load anyway loads it here)
    ['program load', async (page) => {
      await page.setInputFiles('#fileCart', { name: 'loop.bin', mimeType: 'application/octet-stream',
        buffer: Buffer.from([0x00, 0x00, 0x02, 0x40, 0x00, 0x20, 0xFE, 0xFF, 0x00, 0x00, 0x40, 0x00]) });
      await waitFor(page, () => !document.getElementById('mediaOffer').hidden);
      await page.click('#btnMediaAnyway');
    }],
  ]) {
    const { ctx, page, errors, replies } = await open({ width: 1440, height: 900 });
    const L = `askEsc (${tag} while paused)`;
    await typing(page, replies, { full });
    await pause(page);
    await act(page);
    const after = await stoppedForGood(page);
    const note = await page.evaluate(() => [document.getElementById('askMessages').textContent, window.emu.session.chat ? 'open' : 'closed']);
    const keeps = /Reset|power/.test(tag);
    check(`${L}: Claude stops (the pause ends, the turn ends, held keys dropped) and a Resume afterwards types nothing`, after.ok, JSON.stringify(after));
    if (keeps && !full) check(`${L}: the conversation says why`, /\[stopped: you (reset|power cycled) the machine\]/.test(note[0]), note[0].slice(-120));
    if (replies.held) replies.held.release();
    check(`${L}: no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (4) F1: the page views (Share, the Library, Add ROMs, the Debugger) hide the emulator and the panel: Claude's
  // status pill (#viewClaude, outside .layout) shows there with Stop, and Resume while paused; both can be clicked
  // (nothing lies over them), the view's own "← Emulator" is not covered, and Stop ends the turn ----
  const VIEW_BACK = { '#share': '#shareBack', '#library': '#btnLibBack', '#add-roms': '#romCard .libhead a', '#debugger': '#debugView .dbghead a' };
  // what is at the centre of an element: itself (or inside it), so a click there reaches it
  const clickable = (page, sel) => page.evaluate((q) => { const e = document.querySelector(q); if (!e) return 'missing';
    const r = e.getBoundingClientRect(); if (!r.width || !r.height) return 'not shown';
    if (r.bottom > innerHeight || r.right > innerWidth || r.left < 0 || r.top < 0) return 'off screen';
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return at && (at === e || e.contains(at)) ? 'ok' : `covered by ${at && (at.id || at.tagName)}`; }, sel);
  for (const [tag, vp, opts] of [['1440', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }, { hasTouch: true, isMobile: true }]]) {
    for (const view of ['#share', '#library', '#add-roms', '#debugger']) {
      for (const paused of [false, true]) {
        const { ctx, page, errors, replies } = await open(vp, opts || {});
        const L = `askEsc (F1 ${view}, ${tag}, ${paused ? 'paused' : 'Claude typing'})`;
        await typing(page, replies);
        if (paused) await pause(page);
        await page.evaluate((h) => { location.hash = h; }, view);
        const shown = await waitFor(page, (h) => location.hash === h && !document.getElementById('viewClaude').hidden, view, 8000);
        const r = await page.evaluate(() => ({ text: document.getElementById('viewClaudeText').textContent, resume: !document.getElementById('btnViewResume').hidden,
          inLayout: !!document.getElementById('viewClaude').closest('.layout'), status: window.emu.session.claudeStatus && window.emu.session.claudeStatus.text }));
        const stop = await clickable(page, '#btnViewStop'), resume = paused ? await clickable(page, '#btnViewResume') : 'n/a', back = await clickable(page, VIEW_BACK[view]);
        const textOk = paused ? /^Paused.*Esc stops Claude/.test(r.text) : /^(Using type_text…|Thinking…)$/.test(r.text);
        check(`${L}: the pill shows the state with Stop${paused ? ' and Resume' : ''}, both clickable, and "← Emulator" is not covered`,
          shown && !r.inLayout && textOk && r.text === r.status && r.resume === paused && stop === 'ok' && (!paused || resume === 'ok') && back === 'ok', JSON.stringify({ shown, ...r, stop, resume, back }));
        if (paused) {
          if (resume === 'ok') await page.click('#btnViewResume');
          const resumed = await waitFor(page, () => !window.emu.session.claudePaused && window.emu.session.claudeBusyActing && document.getElementById('btnViewResume').hidden, null, 5000);
          check(`${L}: Resume lets Claude go on, and the pill stays`, resumed && await page.evaluate(() => !document.getElementById('viewClaude').hidden));
        }
        if (stop === 'ok') await page.click('#btnViewStop'); else await page.evaluate(() => document.getElementById('btnAskStop').click());
        const after = await stoppedForGood(page);
        const gone = await waitFor(page, () => document.getElementById('viewClaude').hidden, null, 5000);
        check(`${L}: Stop ends the turn (nothing typed afterwards) and the pill goes`, after.ok && gone, JSON.stringify(after));
        if (replies.held) replies.held.release();
        check(`${L}: no page errors`, !errors.length, errors.join('; '));
        await ctx.close();
      }
    }
  }
  // Claude's own "3" at the welcome menu opens Add ROMs: the pill is there, and Claude's turn goes on
  for (const [tag, vp, opts] of [['1440', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }, { hasTouch: true, isMobile: true }]]) {
    const { ctx, page, errors, replies } = await open(vp, opts || {});
    await page.evaluate(() => document.getElementById('btnAsk').click());
    await page.evaluate(async () => { const s = window.emu.session; s.setClaudeAllowed(true);
      const r = await fetch(`examples/${s.welcomeFile}`); s.startWelcome(new Uint8Array(await r.arrayBuffer())); });
    await emuFrames(page, 120);
    replies.push({ body: tools([{ name: 'type_text', input: { text: '3' } }]) }, { hold: true, body: text('Add ROMs is open.') });
    await page.evaluate(() => { window.emu.session.chat.sendLine('Show me how to add ROMs'); });
    const up = await waitFor(page, () => location.hash === '#add-roms' && !document.getElementById('viewClaude').hidden, null, 15000);
    const r = await page.evaluate(() => ({ busy: window.emu.session.chat.busy, text: document.getElementById('viewClaudeText').textContent }));
    const stop = await clickable(page, '#btnViewStop');
    if (stop === 'ok') await page.click('#btnViewStop');
    const after = await waitFor(page, () => !window.emu.session.chat.busy, null, 5000);
    check(`askEsc (F1 Claude's own 3 at the welcome menu, ${tag}): Add ROMs opens with the pill (status, Stop clickable), and Stop ends the turn`,
      up && r.busy && !!r.text && stop === 'ok' && after, JSON.stringify({ up, ...r, stop, after }));
    if (replies.held) replies.held.release();
    check(`askEsc (F1 Claude's own 3, ${tag}): no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }
  // a card raised while a view is up closes the view (back to the emulator, the panel open on the card), where it is
  // seen and answered; a card already waiting when the person opens a view: the pill says so, and Answer goes to it
  for (const [tag, vp, opts] of [['1440', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }, { hasTouch: true, isMobile: true }]]) {
    for (const view of ['#library', '#debugger']) {
      const { ctx, page, errors, replies } = await open(vp, opts || {});
      const L = `askEsc (F1 card under ${view}, ${tag})`;
      await page.evaluate(() => document.getElementById('btnAsk').click());
      const first = { hold: true, body: tools([{ name: 'type_text', input: { text: 'PRINT 1' } }]) };
      replies.push(first, { hold: true, body: text('Done.') });
      await page.evaluate(() => { window.emu.session.chat.sendLine('Type PRINT 1'); });
      for (let i = 0; i < 100 && !replies.held; i++) await new Promise((res) => setTimeout(res, 20));
      await page.evaluate((h) => { location.hash = h; }, view);
      await waitFor(page, (h) => location.hash === h && !document.getElementById('viewClaude').hidden, view, 5000);
      const thinking = await page.evaluate(() => document.getElementById('viewClaudeText').textContent);
      const held = replies.held; replies.held = null; held.release();
      const back = await waitFor(page, () => !!window.emu.session.claudePending && location.hash === '' && !document.getElementById('askConsent').hidden, null, 8000);
      await new Promise((res) => setTimeout(res, 300));
      const allow = await clickable(page, '#btnAskAllow');
      if (allow === 'ok') await page.click('#btnAskAllow');
      const typed = await waitFor(page, () => !window.emu.session.claudePending && window.emu.session.claudeAllowed, null, 5000);
      check(`${L}: the pill says Thinking… under the view; the card closes the view and shows on the emulator, and Allow answers it`,
        thinking === 'Thinking…' && back && allow === 'ok' && typed, JSON.stringify({ thinking, back, allow, typed }));
      for (let i = 0; i < 400 && !replies.held; i++) await new Promise((res) => setTimeout(res, 20));
      if (replies.held) { replies.held.release(); replies.held = null; }
      const ended = await waitFor(page, () => !window.emu.session.chat.busy, null, 8000);
      check(`${L}: (the first turn ended)`, ended);
      // a card already up, then the person opens a view: the pill shows "Waiting for your OK" with Answer
      await page.evaluate(() => window.emu.session.setClaudeAllowed(false));
      replies.push({ body: tools([{ name: 'type_text', input: { text: 'PRINT 2' } }]) }, { hold: true, body: text('Done.') });
      await page.evaluate(() => { window.emu.session.chat.sendLine('Type PRINT 2'); });
      const pending = await waitFor(page, () => !!window.emu.session.claudePending, null, 8000);
      check(`${L}: (the second turn's card is up)`, pending);
      await page.evaluate((h) => { location.hash = h; }, view);
      const waiting = await waitFor(page, (h) => location.hash === h && document.getElementById('viewClaudeText').textContent === 'Waiting for your OK' && !document.getElementById('btnViewAnswer').hidden, view, 5000);
      const answer = await clickable(page, '#btnViewAnswer');
      if (answer === 'ok') await page.click('#btnViewAnswer');
      const shownCard = await waitFor(page, () => location.hash === '' && !document.getElementById('askConsent').hidden && document.getElementById('askConsent').getClientRects().length > 0, null, 5000);
      await new Promise((res) => setTimeout(res, 300));
      const tell = await clickable(page, '#btnAskTell');
      if (tell === 'ok') await page.click('#btnAskTell');
      const answered = await waitFor(page, () => !window.emu.session.claudePending, null, 5000);
      check(`${L}: a card already waiting shows "Waiting for your OK" with Answer in the view; Answer brings the card into view and it is answered`,
        waiting && answer === 'ok' && shownCard && tell === 'ok' && answered, JSON.stringify({ waiting, answer, shownCard, tell, answered }));
      if (replies.held) replies.held.release();
      check(`${L}: no page errors`, !errors.length, errors.join('; '));
      await ctx.close();
    }
  }

  // Stop from the pill while an acting call waits at its gate (the merged Ask + acting-tools contract): (i) a card
  // already up when the person opens a view: Stop on the pill ends the call stopped, the card goes, nothing is typed;
  // (ii) the person's key on the screen while the card is up pauses Claude (the card stays, unanswered); in a view the
  // pill says Paused with Answer (the card), Resume and Stop (R11), and Stop ends it, the card answered stopped,
  // nothing typed. (Allow while paused is "Allow and resume" since R11: section (7) covers it.)
  for (const [tag, vp, opts] of [['1440', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }, { hasTouch: true, isMobile: true }]]) {
    for (const keyFirst of [false, true]) {
      const { ctx, page, errors, replies } = await open(vp, opts || {});
      const L = `askEsc (F1 Stop on the pill during a gate wait, ${keyFirst ? 'the person\'s key while the card waits' : 'the card waiting'}, ${tag})`;
      await page.evaluate(() => document.getElementById('btnAsk').click());
      await page.evaluate(() => window.emu.session.setClaudeAllowed(false));
      replies.push({ body: tools([{ name: 'type_text', input: { text: 'PRINT 2' } }]) }, { hold: true, body: text('Done.') });
      await page.evaluate(() => { window.emu.session.chat.sendLine('Type PRINT 2'); });
      const pending = await waitFor(page, () => !!window.emu.session.claudePending && !document.getElementById('askConsent').hidden, null, 8000);
      let paused = 'n/a';
      if (keyFirst) {
        await page.focus('#screen');
        await page.keyboard.press('x');
        paused = await waitFor(page, () => !!window.emu.session.claudePaused && !!window.emu.session.claudePending, null, 5000);
        await page.evaluate(() => { window.__pushed.length = 0; });
        await emuFrames(page, 30);
      }
      const held = await page.evaluate(() => { const s = window.emu.session, m = s.chatTarget().machine;
        return { pushed: window.__pushed.length, queued: m.typist.queue.length + m.stubKeys.length, undo: s.chat.undo.length, busy: s.chat.busy }; });
      await page.evaluate(() => { location.hash = '#library'; });
      const want = keyFirst ? /^Paused.*Esc stops Claude$/ : /^Waiting for your OK$/;
      const shown = await waitFor(page, (w) => location.hash === '#library' && !document.getElementById('viewClaude').hidden && new RegExp(w).test(document.getElementById('viewClaudeText').textContent), want.source, 8000);
      const r = await page.evaluate(() => ({ text: document.getElementById('viewClaudeText').textContent, answer: !document.getElementById('btnViewAnswer').hidden, resume: !document.getElementById('btnViewResume').hidden }));
      const stop = await clickable(page, '#btnViewStop');
      check(`${L}: the card is up${keyFirst ? '; the key pauses Claude, nothing of Claude\'s is typed, no restore point' : ''}; the pill shows ${keyFirst ? 'Paused with Answer and Resume' : '"Waiting for your OK" with Answer'} and a clickable Stop`,
        pending && (!keyFirst || (paused && held.pushed === 0 && held.queued === 0 && held.undo === 0 && held.busy)) && shown
          && r.answer && r.resume === keyFirst && stop === 'ok', JSON.stringify({ pending, paused, held, shown, ...r, stop }));
      if (stop === 'ok') await page.click('#btnViewStop'); else await page.evaluate(() => document.getElementById('btnAskStop').click());
      const after = await stoppedForGood(page);
      const res = await page.evaluate(() => { const s = window.emu.session; return { pending: !!s.claudePending, call: s.claudeCall, undo: s.chat.undo.length, msgs: document.getElementById('askMessages').textContent.slice(-200) }; });
      const gone = await waitFor(page, () => document.getElementById('viewClaude').hidden, null, 5000);
      check(`${L}: Stop on the pill ends the call (stopped) and the turn: no card left, nothing typed then or later, no restore point, the pill goes`,
        after.ok && !res.pending && res.call === null && res.undo === 0 && gone, JSON.stringify({ after, ...res, gone }));
      if (replies.held) replies.held.release();
      check(`${L}: no page errors`, !errors.length, errors.join('; '));
      await ctx.close();
    }
  }

  // ---- (5) F2: every way the person's input reaches the machine Claude acts on pauses Claude, as a key on the screen
  // does: an on-screen key, a paste, a key with the focus on the page's body, the type-in panel, a tap on the welcome
  // menu; and the person's "1" at the welcome menu while Claude acts no longer runs under Claude's ticket ----
  const inputs = [
    ['an on-screen key', { width: 390, height: 844 }, { hasTouch: true, isMobile: true }, (page) => page.evaluate(() => {
      const b = [...document.querySelectorAll('#touchKeys .tk')].find((x) => x.dataset.key === 'Q' && x.getClientRects().length);
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch' }));
      b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch' })); })],
    ['a paste on the screen', { width: 1440, height: 900 }, null, (page) => page.evaluate(() => { const c = document.getElementById('screen'); c.focus();
      const dt = new DataTransfer(); dt.setData('text/plain', 'HELLO'); c.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })],
    ['a key with the focus on the page\'s body', { width: 1440, height: 900 }, null, async (page) => { await page.evaluate(() => { document.activeElement.blur(); });
      await page.keyboard.press('x'); }],
    ['the type-in panel', { width: 1440, height: 900 }, null, (page) => page.evaluate(() => { document.getElementById('typeinSource').value = '10 PRINT "HI"';
      document.getElementById('btnTypein').onclick(); })],
  ];
  for (const [tag, vp, opts, act] of inputs) {
    const { ctx, page, errors, replies } = await open(vp, opts || {});
    const L = `askEsc (F2 ${tag})`;
    const going = await typing(page, replies);
    await act(page);
    const r = await page.evaluate(() => ({ paused: !!window.emu.session.claudePaused, busy: window.emu.session.chat.busy,
      status: window.emu.session.claudeStatus && window.emu.session.claudeStatus.phase }));
    check(`${L}: pauses Claude while it types (as a key on the screen does)`, going && r.paused && r.busy && r.status === 'paused', JSON.stringify({ going, ...r }));
    await page.evaluate(() => document.getElementById('btnAskStop').click());
    check(`${L}: Stop then ends it`, (await stoppedForGood(page)).ok);
    if (replies.held) replies.held.release();
    check(`${L}: no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }
  // the repro: Claude acting at the welcome menu (it has poked, its next reply is on the way), the person types "1"
  // (on the page's body, an on-screen key, a tap on the menu line): LIZA starts and Claude's turn stops, not Claude's
  for (const [tag, vp, opts, act] of [
    ['a key on the page\'s body', { width: 1440, height: 900 }, null, async (page) => { await page.evaluate(() => document.activeElement.blur()); await page.keyboard.press('1'); }],
    ['an on-screen key', { width: 390, height: 844 }, { hasTouch: true, isMobile: true }, (page) => page.evaluate(() => {
      const b = [...document.querySelectorAll('#touchKeys .tk')].find((x) => x.dataset.key === '1' && x.getClientRects().length);
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch' }));
      setTimeout(() => b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch' })), 120); })],
    ['a tap on the menu line', { width: 1440, height: 900 }, null, (page) => page.evaluate(() => { const c = document.getElementById('screen'), r = c.getBoundingClientRect(), f = window.emu.session.machine.render();
      c.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + (24 + 12 * 9 + 6) / f.height * r.height })); })],
  ]) {
    const { ctx, page, errors, replies } = await open(vp, opts || {});
    await page.evaluate(() => document.getElementById('btnAsk').click());
    await page.evaluate(async () => { const s = window.emu.session; s.setClaudeAllowed(true);
      const r = await fetch(`examples/${s.welcomeFile}`); s.startWelcome(new Uint8Array(await r.arrayBuffer())); });
    await emuFrames(page, 120);
    replies.push({ body: tools([{ name: 'poke', input: { address: 0x3000, bytes: [7] } }]) }, { hold: true, body: text('ok') });
    await page.evaluate(() => { window.emu.session.chat.sendLine('Poke for me'); });
    const acting = await waitFor(page, () => window.emu.session.claudeBusyActing && window.emu.session.claudeStatus.phase === 'thinking', null, 8000);
    await act(page);
    const up = await waitFor(page, () => !!window.emu.session.lastRun && window.emu.session.lastRun.kind === 'liza', null, 15000);
    const stopped = await waitFor(page, () => !window.emu.session.chat.busy && window.emu.session.chat.error && window.emu.session.chat.error.code === 'aborted', null, 8000);
    check(`askEsc (F2 the welcome-menu repro, ${tag}): the person's "1" while Claude acts pauses Claude, and LIZA it starts stops Claude's turn`, acting && up && stopped, JSON.stringify({ acting, up, stopped }));
    if (replies.held) replies.held.release();
    check(`askEsc (F2 the welcome-menu repro, ${tag}): no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (5b) the Ask rail's open tab is a menu: Esc on the screen closes it and is neither BREAK nor a pause; Shift
  // alone (a key on the machine) pauses Claude ----
  {
    const { ctx, page, errors, replies } = await open({ width: 1440, height: 900 });
    await typing(page, replies);
    await page.evaluate(() => document.querySelector('#askRail button').click());
    await page.focus('#screen');
    await page.evaluate(() => { window.__pushed.length = 0; });
    await page.keyboard.press('Escape');
    const r = await page.evaluate(() => ({ rail: document.body.classList.contains('ask-rail-drawer'), paused: !!window.emu.session.claudePaused, breakSent: window.__pushed.includes(3) }));
    check('askEsc (rail): with a rail tab open, Esc on the screen closes the tab, sends no BREAK and does not pause Claude', !r.rail && !r.paused && !r.breakSent, JSON.stringify(r));
    await page.keyboard.press('Escape');
    const r2 = await page.evaluate(() => ({ paused: !!window.emu.session.claudePaused, breakSent: window.__pushed.includes(3) }));
    check('askEsc (rail): the next Esc is BREAK and pauses Claude, as before', r2.paused && r2.breakSent, JSON.stringify(r2));
    await page.click('#btnAskStop');
    check('askEsc (rail): Stop then ends it', (await stoppedForGood(page)).ok);
    if (replies.held) replies.held.release();
    check('askEsc (rail): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }
  {
    const { ctx, page, errors, replies } = await open({ width: 1440, height: 900 });
    await typing(page, replies);
    await page.focus('#screen');
    await page.keyboard.down('Shift');
    const paused = await page.evaluate(() => !!window.emu.session.claudePaused);
    await page.keyboard.up('Shift');
    check('askEsc (Shift): Shift alone, the machine\'s SHIFT key, pauses Claude while it types', paused);
    await page.click('#btnAskStop');
    check('askEsc (Shift): Stop then ends it', (await stoppedForGood(page)).ok);
    if (replies.held) replies.held.release();
    check('askEsc (Shift): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (5c) where no other Stop can be reached: a phone held sideways with its touch keyboard (the drawer's strip is
  // hidden under it), the side panel closed or minimised while Claude only thinks: #viewClaude, over the screen ----
  for (const how of ['closed', 'minimised']) {
    const { ctx, page, errors, replies } = await open({ width: 844, height: 390 }, { hasTouch: true, isMobile: true });
    const L = `askEsc (sideways with touch keys, panel ${how})`;
    await page.evaluate(() => document.getElementById('btnAsk').click());
    replies.push({ hold: true, body: text('ok') });
    await page.evaluate(() => { window.emu.session.chat.sendLine('hello'); });
    await page.evaluate((h) => document.getElementById(h === 'closed' ? 'btnAskClose' : 'btnAskMin').click(), how);
    const shown = await waitFor(page, () => !document.getElementById('viewClaude').hidden && document.getElementById('viewClaudeText').textContent === 'Thinking…', null, 5000);
    const keys = await page.evaluate(() => document.body.classList.contains('touch-keys'));
    const stop = await clickable(page, '#btnViewStop');
    if (stop === 'ok') await page.click('#btnViewStop');
    const ended = await waitFor(page, () => !window.emu.session.chat.busy && document.getElementById('viewClaude').hidden, null, 5000);
    check(`${L}: Claude's status with a clickable Stop shows, and Stop ends the turn`, keys && shown && stop === 'ok' && ended, JSON.stringify({ keys, shown, stop, ended }));
    if (replies.held) replies.held.release();
    check(`${L}: no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }
  // ... and in the full-screen chat held sideways, a card is not left under the touch keyboard: it stands aside
  {
    const { ctx, page, errors, replies } = await open({ width: 844, height: 390 }, { hasTouch: true, isMobile: true });
    const L = 'askEsc (full-screen chat sideways, a card)';
    await page.evaluate(() => document.getElementById('btnAsk').click());
    await page.evaluate(() => document.getElementById('btnAskFull').click());
    await waitFor(page, () => window.emu.session.claudeView === 'full' && !!window.emu.session.chatMachines, null, 15000);
    replies.push({ body: tools([{ name: 'type_text', input: { text: 'PRINT 1' } }]) }, { hold: true, body: text('Done.') });
    await page.evaluate(() => { window.emu.session.chat.sendLine('Type PRINT 1'); });
    const pending = await waitFor(page, () => !!window.emu.session.claudePending && document.getElementById('touchKeys').hidden, null, 8000);
    await page.evaluate(() => document.getElementById('btnClaudeAllow').scrollIntoView({ block: 'center' }));
    const allow = await clickable(page, '#btnClaudeAllow');
    if (allow === 'ok') await page.click('#btnClaudeAllow');
    const back = await waitFor(page, () => !window.emu.session.claudePending && !document.getElementById('touchKeys').hidden, null, 5000);
    check(`${L}: the touch keyboard stands aside while the card waits, Allow can be clicked, and the keyboard comes back`, pending && allow === 'ok' && back, JSON.stringify({ pending, allow, back }));
    if (replies.held) replies.held.release();
    check(`${L}: no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (5d) from a second review: a toast over the bottom of a phone while only the sheet's Stop shows does not make the
  // pill come and go (#viewClaude moves the toasts up); a modifier let go in another window leaves no mark (the next Esc stops); the rail's tab closes with a page
  // view; held sideways at 1100 px or more with the touch keyboard on, a Stop can be clicked, and a card makes the
  // keyboard stand aside ----
  {
    const { ctx, page, errors, replies } = await open({ width: 390, height: 844 });
    const L = 'askEsc (a toast over the sheet\'s Stop)';
    await page.evaluate(() => document.getElementById('btnAsk').click());
    replies.push({ hold: true, body: text('ok') });
    await page.evaluate(() => { window.emu.session.chat.sendLine('hello'); });
    await page.evaluate(() => document.getElementById('btnAskClose').click());   // (during a turn the sheet goes to peek)
    await waitFor(page, () => document.getElementById('ask').dataset.height === 'peek' && !document.getElementById('btnAskPeekStop').hidden, null, 5000);
    await page.evaluate(() => { window.__flips = 0; let was = document.getElementById('viewClaude').hidden;
      window.__obs = new MutationObserver(() => { const h = document.getElementById('viewClaude').hidden; if (h !== was) { window.__flips++; was = h; } });
      window.__obs.observe(document.getElementById('viewClaude'), { attributes: true }); window.emu.feedback.toast('A toast over the bottom of the window, long enough to wrap onto several lines on a phone, so that it lies over the sheet\'s Stop button at the bottom edge of the window for as long as it shows'); });
    await emuFrames(page, 90);
    const flips = await page.evaluate(() => window.__flips);
    check(`${L}: the pill does not come and go while the toast shows`, flips <= 1, `flips ${flips}`);
    await page.evaluate(() => window.emu.session.stopClaude());
    if (replies.held) replies.held.release();
    check(`${L}: no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }
  // the pill at the bottom of a portrait phone with the touch keyboard (no other Stop in the window): a toast goes above
  // it, so its Stop stays clickable
  {
    const { ctx, page, errors, replies } = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
    const L = 'askEsc (a toast and the pill, portrait with touch keys)';
    await page.evaluate(() => document.getElementById('btnAsk').click());
    replies.push({ hold: true, body: text('ok') });
    await page.evaluate(() => { window.emu.session.chat.sendLine('hello'); });
    await page.evaluate(() => document.getElementById('btnAskMin').click());   // (the strip's Stop: under the keys, scrolled out)
    await page.evaluate(() => { document.getElementById('askStrip').hidden = true; window.scrollTo(0, 0); });
    const shown = await waitFor(page, () => !document.getElementById('viewClaude').hidden && document.body.classList.contains('touch-keys'), null, 5000);
    await page.evaluate(() => window.emu.feedback.toast('A toast while the pill is up, long enough to wrap onto two lines on a phone'));
    await emuFrames(page, 10);
    // (the toast lets clicks through, so it is its picture over the pill that matters: the boxes must not meet)
    const stop = await clickable(page, '#btnViewStop');
    const apart = await page.evaluate(() => { const a = document.getElementById('toast').getBoundingClientRect(), b = document.getElementById('btnViewStop').getBoundingClientRect();
      return document.getElementById('toast').hidden || a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left; });
    check(`${L}: the pill's Stop is not under the toast`, shown && stop === 'ok' && apart, JSON.stringify({ shown, stop, apart }));
    await page.evaluate(() => window.emu.session.stopClaude());
    if (replies.held) replies.held.release();
    check(`${L}: no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }
  {
    const { ctx, page, errors, replies } = await open({ width: 1440, height: 900 });
    await typing(page, replies);
    await page.focus('#screen');
    await page.keyboard.down('Shift');                                   // pauses Claude: the mark is Shift's
    const paused = await page.evaluate(() => !!window.emu.session.claudePaused);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));  // its keyup goes to another window
    await page.evaluate(() => document.getElementById('screen').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })));
    const after = await stoppedForGood(page);
    await page.keyboard.up('Shift');
    check('askEsc (a modifier let go in another window): the next Esc stops Claude', paused && after.ok, JSON.stringify({ paused, after }));
    if (replies.held) replies.held.release();
    check('askEsc (a modifier let go in another window): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open({ width: 1440, height: 900 });
    await page.evaluate(() => document.getElementById('btnAsk').click());
    await page.evaluate(() => document.querySelector('#askRail button').click());
    const was = await page.evaluate(() => document.body.classList.contains('ask-rail-drawer'));
    await page.evaluate(() => { location.hash = '#library'; });
    const closed = await waitFor(page, () => location.hash === '#library' && !document.body.classList.contains('ask-rail-drawer'), null, 5000);
    check('askEsc (rail and a page view): the rail\'s tab closes when a page view opens', was && closed);
    check('askEsc (rail and a page view): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }
  {
    const { ctx, page, errors, replies } = await open({ width: 1200, height: 450 }, { hasTouch: true });
    const L = 'askEsc (sideways at 1200 px, touch keyboard on)';
    await page.evaluate(() => { const sel = document.getElementById('selTouchKeys'); sel.value = 'on'; sel.dispatchEvent(new Event('change')); });
    await page.evaluate(() => document.getElementById('btnAsk').click());
    replies.push({ hold: true, body: tools([{ name: 'type_text', input: { text: 'PRINT 1' } }]) }, { hold: true, body: text('Done.') });
    await page.evaluate(() => { window.emu.session.chat.sendLine('Type PRINT 1'); });
    const keys = await page.evaluate(() => document.body.classList.contains('touch-keys') && !document.getElementById('touchKeys').hidden);
    await waitFor(page, () => !!window.emu.session.claudeStatus, null, 5000);
    await emuFrames(page, 20);
    // (a Stop the person can click: the panel's own beside the keyboard, else the pill; never neither)
    const panelStop = await clickable(page, '#btnAskStatusStop'), pill = await page.evaluate(() => !document.getElementById('viewClaude').hidden);
    const shown = panelStop === 'ok' || pill, stop = panelStop === 'ok' ? 'panel' : await clickable(page, '#btnViewStop');
    for (let i = 0; i < 200 && !replies.held; i++) await new Promise((res) => setTimeout(res, 20));
    const held = replies.held; replies.held = null; if (held) held.release();
    const aside = await waitFor(page, () => !!window.emu.session.claudePending && document.getElementById('touchKeys').hidden, null, 8000);
    // (no scroll of its own: the page must bring the card's Allow into view, js/ui/ask.js)
    const allow = await clickable(page, '#btnAskAllow');
    if (allow === 'ok') await page.click('#btnAskAllow');
    const back = await waitFor(page, () => !window.emu.session.claudePending && !document.getElementById('touchKeys').hidden, null, 5000);
    check(`${L}: a Stop can be clicked (the panel's beside the keyboard, or else the pill, not both), and a card makes the keyboard stand aside so Allow can be clicked`,
      keys && shown && (stop === 'panel' || stop === 'ok') && pill === (panelStop !== 'ok') && aside && allow === 'ok' && back, JSON.stringify({ keys, panelStop, pill, stop, aside, allow, back }));
    await page.evaluate(() => window.emu.session.stopClaude());
    if (replies.held) replies.held.release();
    check(`${L}: no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (6) M2: a "[stopped]" note is the stopped turn's: a turn the full-screen chat starts (its own line, through
  // the firmware's channel, not the panel's box) clears it ----
  {
    const { ctx, page, errors, replies } = await open({ width: 1440, height: 900 });
    await typing(page, replies);
    await page.click('#btnAskStop');
    await waitFor(page, () => !window.emu.session.chat.busy && /\[stopped\]/.test(document.getElementById('askMessages').textContent), null, 5000);
    if (replies.held) replies.held.release();
    replies.length = 0;
    replies.push({ body: text('Hello again.') });
    await page.evaluate(() => { window.emu.session.chat.sendLine('hello'); });
    const cleared = await waitFor(page, () => !window.emu.session.chat.busy && /Hello again\./.test(document.getElementById('askMessages').textContent), null, 8000);
    const note = await page.textContent('#askMessages');
    check('askEsc (M2): a turn started outside the panel\'s box clears the last turn\'s "[stopped]" note', cleared && !/\[stopped/.test(note), note.slice(-80));
    check('askEsc (M2): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (7) R11: while Claude is paused a card's accept button is "Allow and resume" (one click: consent and Resume);
  // a no never resumes; the switch off while a call waits paused refuses it; Esc while paused with a card up is Stop.
  // Each in the side panel and in the full-screen chat (its BASIC session view, where a key reaches that machine) ----
  const UI = {
    panel: { allow: '#btnAskAllow', tell: '#btnAskTell', paused: '#askConsentPaused', status: '#askStatusText', resume: '#btnAskStatusResume', sw: '#chkAskMachine' },
    full: { allow: '#btnClaudeAllow', tell: '#btnClaudeTell', paused: '#claudeConsentPaused', status: '#claudeStatusText', resume: '#btnClaudeResume', sw: '#chkClaudeTools' },
  };
  // the Ask panel (or the full-screen chat on its BASIC session), the switch off, and one acting call whose consent
  // card comes up; an INCLUDE file (examples/r11.inc) the test holds until it says
  async function r11(vp, full, use, then = null) {
    const o = await open(vp);
    const { ctx, page, replies } = o;
    o.inc = null;
    await ctx.route('**/examples/r11.inc', async (route) => { await new Promise((res) => { o.inc = res; }); await route.fulfill({ status: 200, body: ' FCB $55,$AA\n' }); });
    await page.evaluate(() => document.getElementById('btnAsk').click());
    await page.evaluate(() => window.emu.session.setClaudeAllowed(false));
    if (full) {
      await page.evaluate(() => document.getElementById('btnAskFull').click());
      await waitFor(page, () => window.emu.session.claudeView === 'full' && !!window.emu.session.chatMachines, null, 15000);
      await page.evaluate(() => document.getElementById('btnClaudeView').click());
      await waitFor(page, () => window.emu.session.chatView === 'basic');
    }
    replies.push({ body: tools([use]) }, ...(then ? [{ hold: true, body: tools([then]) }] : []), { hold: true, body: text('Done.') });
    await page.evaluate(() => { window.emu.session.chat.sendLine('Do it'); });
    o.carded = await waitFor(page, () => !!window.emu.session.claudePending, null, 8000);
    return o;
  }
  const key = async (page) => { await page.focus('#screen'); await page.keyboard.press('x'); return waitFor(page, () => !!window.emu.session.claudePaused, null, 5000); };
  const at = (page, a, k) => page.evaluate(([a2, k2]) => Array.from(window.emu.session.chatTarget().machine.ram.slice(a2, a2 + k2)).join(), [a, k]);
  const POKE = { name: 'poke', input: { address: 0x3000, bytes: [0x55] } };
  const ASM = { name: 'assemble_and_load', input: { source: ' INCLUDE "r11.inc"\n', org: 0x3000 } };
  for (const full of [false, true]) {
    const u = UI[full ? 'full' : 'panel'], where = full ? 'full-screen chat' : 'side panel', vp = { width: 1440, height: 900 };
    // (a) a key while the card waits: "Allow and resume", the line saying why, the paused status; (b) one click acts once
    {
      const { ctx, page, errors, replies, carded } = await r11(vp, full, POKE);
      const L = `askEsc (R11 ${where})`;
      const plain = await page.textContent(u.allow);
      const paused = await key(page);
      const shown = await waitFor(page, (q) => document.querySelector(q.allow).textContent === 'Allow and resume' && !document.querySelector(q.paused).hidden, u, 5000);
      const r = await page.evaluate((q) => ({ line: document.querySelector(q.paused).textContent, status: document.querySelector(q.status).textContent, tell: document.querySelector(q.tell).textContent }), u);
      check(`${L}: a key while the card waits: the button reads "Allow and resume" (was "${plain}"), the card says why, the status is the pause's, the decline label is unchanged`,
        carded && plain === 'Allow' && paused && shown && /^Paused because you pressed a key\. Allow and resume lets Claude/.test(r.line) && /^Paused: you pressed a key · Claude's next action waits · Esc stops Claude$/.test(r.status) && r.tell === 'Just tell me the fix', JSON.stringify({ carded, plain, paused, shown, ...r }));
      await page.click(u.allow);
      const resumedAtOnce = await page.evaluate(() => !window.emu.session.claudePaused);
      for (let i = 0; i < 200 && !replies.held; i++) await new Promise((res) => setTimeout(res, 20));
      const res = await page.evaluate(() => ({ undo: window.emu.session.chat.undo.length, allowed: window.emu.session.claudeAllowed }));
      check(`${L}: one click on "Allow and resume" gives consent and resumes; the poke acts exactly once (one restore point), the switch is on`,
        resumedAtOnce && !!replies.held && await at(page, 0x3000, 1) === '85' && res.undo === 1 && res.allowed, JSON.stringify({ resumedAtOnce, ...res }));
      const label = await page.textContent(u.allow);
      check(`${L}: no longer paused: the button is plain "Allow" again`, label === 'Allow', label);
      if (replies.held) replies.held.release();
      check(`${L}: no page errors`, !errors.length, errors.join('; '));
      await ctx.close();
    }
    // (c) decline while paused: nothing acts, the pause stays
    {
      const { ctx, page, errors, replies } = await r11(vp, full, POKE);
      const L = `askEsc (R11 ${where}, decline)`;
      await key(page);
      await page.click(u.tell);
      await waitFor(page, () => !window.emu.session.claudePending, null, 5000);
      for (let i = 0; i < 200 && !replies.held; i++) await new Promise((res) => setTimeout(res, 20));
      const r = await page.evaluate((q) => ({ paused: !!window.emu.session.claudePaused, undo: window.emu.session.chat.undo.length, resume: !document.querySelector(q.resume).hidden }), u);
      check(`${L}: "Just tell me the fix" while paused acts on nothing (no restore point) and Claude stays paused, with Resume`,
        r.paused && r.undo === 0 && r.resume && await at(page, 0x3000, 1) === '0', JSON.stringify(r));
      await page.evaluate(() => window.emu.session.stopClaude());
      if (replies.held) replies.held.release();
      check(`${L}: no page errors`, !errors.length, errors.join('; '));
      await ctx.close();
    }
    // (d) a key after the click and before the act (during the INCLUDE read): it waits at the re-check, Resume shown;
    // (e) the same with the switch turned off while paused: Resume then refuses the call
    const ASM2 = { name: 'assemble_and_load', input: { source: ' INCLUDE "r11.inc"\n', org: 0x3040 } };
    for (const off of [false, true]) {
      const o = await r11(vp, full, ASM, off ? ASM2 : null);
      const { ctx, page, errors, replies } = o;
      const L = `askEsc (R11 ${where}, a key after the click${off ? ', then the switch off' : ''})`;
      await key(page);
      await page.click(u.allow);
      const resumed = await waitFor(page, () => !window.emu.session.claudePaused && !window.emu.session.claudePending, null, 5000);
      // the check is reading the INCLUDE file (held): the person presses a key now
      for (let i = 0; i < 250 && !o.inc; i++) await new Promise((res) => setTimeout(res, 20));
      const reading = !!o.inc;
      const again = await key(page);
      if (off) await page.click(u.sw);
      if (o.inc) o.inc();
      await emuFrames(page, 10);
      const r = await page.evaluate((q) => ({ paused: !!window.emu.session.claudePaused, busy: window.emu.session.chat.busy, undo: window.emu.session.chat.undo.length, resume: !document.querySelector(q.resume).hidden }), u);
      check(`${L}: the call waits at the re-check: nothing written, no restore point, Resume shown`,
        resumed && reading && again && r.paused && r.busy && r.undo === 0 && r.resume && await at(page, 0x3000, 2) === '0,0', JSON.stringify({ resumed, reading, again, ...r }));
      await page.click(u.resume);
      for (let i = 0; i < 200 && !replies.held; i++) await new Promise((res) => setTimeout(res, 20));
      const after = await page.evaluate(() => ({ undo: window.emu.session.chat.undo.length }));
      const bytes = await at(page, 0x3000, 2);
      check(off ? `${L}: Resume: the call is refused (the switch went off while it waited), nothing written, no restore point`
        : `${L}: Resume: the call acts once`, off ? bytes === '0,0' && after.undo === 0 : bytes === '85,170' && after.undo === 1, JSON.stringify({ bytes, ...after }));
      if (off) {
        // F3: the refusal was that pause's: the switch back on, the turn's next acting call (held reply released),
        // paused by a key during its INCLUDE read and resumed, acts once (one restore point)
        await page.click(u.sw);
        const sw = await page.evaluate(() => window.emu.session.claudeAllowed);
        o.inc = null;
        const held2 = replies.held; replies.held = null; if (held2) held2.release();
        for (let i = 0; i < 250 && !o.inc; i++) await new Promise((res) => setTimeout(res, 20));
        const reading2 = !!o.inc;
        const paused2 = await key(page);
        if (o.inc) o.inc();
        await emuFrames(page, 10);
        const waits = await at(page, 0x3040, 2);
        await page.click(u.resume);
        for (let i = 0; i < 200 && !replies.held; i++) await new Promise((res) => setTimeout(res, 20));
        const r2 = await page.evaluate(() => ({ undo: window.emu.session.chat.undo.length, paused: !!window.emu.session.claudePaused }));
        const bytes2 = await at(page, 0x3040, 2);
        check(`${L}: the switch back on in the same turn: the next acting call, paused during its check and resumed, acts once (one restore point)`,
          sw && reading2 && paused2 && waits === '0,0' && bytes2 === '85,170' && r2.undo === 1 && !r2.paused, JSON.stringify({ sw, reading2, paused2, waits, bytes2, ...r2 }));
      }
      if (replies.held) replies.held.release();
      check(`${L}: no page errors`, !errors.length, errors.join('; '));
      await ctx.close();
    }
    // (g) a card ends the browser's Fullscreen by itself; a key that pauses Claude before the browser reports the leave
    // must not turn the page's own leave into Stop (only a leave the person makes stops Claude). The leave is held
    // until the key has paused Claude, so the order is certain.
    if (!full) {
      const { ctx, page, errors, replies } = await open(vp);
      const L = 'askEsc (R11 the page leaves Fullscreen for a card, a key first)';
      await page.evaluate(() => document.getElementById('btnAsk').click());
      await page.evaluate(() => window.emu.session.setClaudeAllowed(false));
      await goFull(page);
      const isFull = await waitFor(page, () => document.fullscreenElement === document.getElementById('screenWrap'));
      await page.evaluate(() => { const orig = document.exitFullscreen.bind(document); window.__leaves = 0;
        document.exitFullscreen = () => { window.__leaves++; return new Promise((res, rej) => { window.__leave = () => orig().then(res, rej); }); }; });
      replies.push({ body: tools([POKE]) }, { hold: true, body: text('Done.') });
      await page.evaluate(() => { window.emu.session.chat.sendLine('Do it'); });
      const asked = await waitFor(page, () => !!window.emu.session.claudePending && window.__leaves > 0, null, 8000);
      const paused = await key(page);
      await page.evaluate(() => window.__leave());
      const left = await waitFor(page, () => !document.fullscreenElement, null, 5000);
      await emuFrames(page, 5);
      const r = await page.evaluate(() => ({ paused: !!window.emu.session.claudePaused, card: !!window.emu.session.claudePending, busy: window.emu.session.chat.busy, leaves: window.__leaves }));
      check(`${L}: Claude stays paused with the card up (the leave was the page's, not the person's), and the page asked to leave once`,
        isFull && asked && paused && left && r.paused && r.card && r.busy && r.leaves === 1, JSON.stringify({ isFull, asked, paused, left, ...r }));
      await page.evaluate(() => window.emu.session.stopClaude());
      if (replies.held) { replies.held.release(); replies.held = null; }
      // F2: that page leave is over; a later leave the person makes while Claude is paused stops Claude as before
      await waitFor(page, () => !window.emu.session.chat.busy, null, 5000);
      await page.evaluate(() => { delete document.exitFullscreen; window.emu.session.setClaudeAllowed(true); });
      replies.length = 0;   // (the stopped turn never asked for its last reply)
      await typing(page, replies);
      await goFull(page);
      const full2 = await waitFor(page, () => document.fullscreenElement === document.getElementById('screenWrap'));
      const paused2 = await pause(page);
      await page.evaluate(() => document.exitFullscreen());
      const after = await stoppedForGood(page);
      check(`${L}: afterwards, a Fullscreen leave the person makes while Claude is paused stops Claude`, full2 && paused2 && after.ok, JSON.stringify({ full2, paused2, after }));
      if (replies.held) replies.held.release();
      check(`${L}: no page errors`, !errors.length, errors.join('; '));
      await ctx.close();
    }
    // (f) Esc while paused with a card up: Stop (the card answered stopped, the turn ends), not a no
    {
      const { ctx, page, errors, replies } = await r11(vp, full, POKE);
      const L = `askEsc (R11 ${where}, Esc)`;
      await key(page);
      await page.focus('#screen');
      await page.keyboard.press('Escape');
      const ended = await waitFor(page, () => !window.emu.session.chat.busy && !window.emu.session.claudePending && !window.emu.session.claudePaused, null, 5000);
      const r = await page.evaluate(() => ({ err: window.emu.session.chat.error && window.emu.session.chat.error.code, undo: window.emu.session.chat.undo.length }));
      check(`${L}: Esc while paused with the card up stops Claude: the card goes, the turn ends stopped (no further request), nothing acts`,
        ended && r.err === 'aborted' && r.undo === 0 && !replies.held && await at(page, 0x3000, 1) === '0', JSON.stringify({ ended, ...r, held: !!replies.held }));
      if (replies.held) replies.held.release();
      check(`${L}: no page errors`, !errors.length, errors.join('; '));
      await ctx.close();
    }
    // (h) F1: the click does what the button said when it was drawn: a stale plain "Allow" (data-resume empty) clicked
    // while paused answers yes only (no resume: nothing acts, still paused); a stale "Allow and resume" clicked after
    // a Resume the page has not redrawn is harmless (one act, no error)
    for (const stale of ['plain', 'resume']) {
      const { ctx, page, errors, replies } = await r11(vp, full, POKE);
      const L = `askEsc (R11 ${where}, a stale ${stale === 'plain' ? '"Allow"' : '"Allow and resume"'} clicked)`;
      await key(page);
      await waitFor(page, (q) => document.querySelector(q.allow).dataset.resume === '1', u, 5000);
      if (stale === 'plain') await page.evaluate((q) => { const b = document.querySelector(q.allow); b.dataset.resume = ''; }, u);
      else await page.evaluate((q) => { window.emu.session.resumeClaude(); const b = document.querySelector(q.allow); b.textContent = 'Allow and resume'; b.dataset.resume = '1'; }, u);
      await page.click(u.allow);
      await waitFor(page, () => !window.emu.session.claudePending, null, 5000);
      for (let i = 0; i < 100 && !replies.held; i++) await new Promise((res) => setTimeout(res, 20));
      const r = await page.evaluate(() => ({ paused: !!window.emu.session.claudePaused, undo: window.emu.session.chat.undo.length }));
      const poked = await at(page, 0x3000, 1);
      check(stale === 'plain' ? `${L}: answers yes without resuming: nothing acts, no restore point, still paused`
        : `${L}: no error, the poke acts exactly once`, stale === 'plain' ? poked === '0' && r.undo === 0 && r.paused : poked === '85' && r.undo === 1 && !r.paused && !!replies.held, JSON.stringify({ poked, ...r }));
      await page.evaluate(() => window.emu.session.stopClaude());
      if (replies.held) replies.held.release();
      check(`${L}: no page errors`, !errors.length, errors.join('; '));
      await ctx.close();
    }
  }

  // ---- (8) F2: the Debugger's edits and a gamepad are the person's input too: while Claude's acting call waits at
  // its card, a byte set in the Debugger and a gamepad's fire press each pause Claude; a pad resting with noise
  // inside the dead zone does not ----
  for (const how of ['debugger', 'gamepad']) {
    const { ctx, page, errors, replies } = await open({ width: 1440, height: 900 });
    const L = `askEsc (F2 ${how === 'debugger' ? 'the Debugger\'s byte set' : 'a gamepad\'s fire press'})`;
    if (how === 'gamepad') {
      await page.evaluate(() => {
        const pad = (index, axes, buttons) => ({ index, id: `Mock pad ${index}`, connected: true, axes: [...axes], buttons: buttons.map((pressed) => ({ pressed, value: pressed ? 1 : 0 })) });
        window.__pads = [];
        navigator.getGamepads = () => [window.__pads[0] || null, null, null, null];
        window.__setPad = (axes, buttons) => { window.__pads[0] = pad(0, axes, buttons); };
        window.__setPad([0, 0], [false, false]);
        window.dispatchEvent(new Event('gamepadconnected'));
      });
    }
    await page.evaluate(() => document.getElementById('btnAsk').click());
    await page.evaluate(() => window.emu.session.setClaudeAllowed(false));
    replies.push({ body: tools([{ name: 'poke', input: { address: 0x3000, bytes: [0x55] } }]) }, { hold: true, body: text('Done.') });
    await page.evaluate(() => { window.emu.session.chat.sendLine('Do it'); });
    const carded = await waitFor(page, () => !!window.emu.session.claudePending, null, 8000);
    let quiet = 'n/a';
    if (how === 'debugger') {
      await page.evaluate(() => { location.hash = '#debugger'; });
      await waitFor(page, () => location.hash === '#debugger' && !document.getElementById('debugView').hidden, null, 8000);
      await page.fill('#dbgMemAddr', '$3100'); await page.press('#dbgMemAddr', 'Enter');
      await page.click('#dbgMem .byte[data-addr="12544"]');
      await page.fill('#dbgByteValue', '42'); await page.click('#dbgByteSet');
    } else {
      // resting with noise inside the dead zone, polled for a while: not the person's input
      for (let i = 0; i < 20; i++) { await page.evaluate((k) => window.__setPad([(k % 3 - 1) * 0.1, (k % 2) * 0.1], [false, false]), i); await emuFrames(page, 2); }
      quiet = await page.evaluate(() => !window.emu.session.claudePaused);
      await page.evaluate(() => window.__setPad([0, 0], [true, false]));
    }
    const paused = await waitFor(page, () => !!window.emu.session.claudePaused, null, 5000);
    const r = await page.evaluate(() => ({ card: !!window.emu.session.claudePending, byte: window.emu.session.chatTarget().machine.ram[0x3100] }));
    check(`${L}: while Claude's call waits at its card, it pauses Claude${how === 'gamepad' ? ' (a pad resting with noise did not)' : ', and the byte is set'}`,
      carded && paused && r.card && (how === 'gamepad' ? quiet === true : r.byte === 0x42), JSON.stringify({ carded, paused, quiet, ...r }));
    await page.evaluate(() => window.emu.session.stopClaude());
    if (replies.held) replies.held.release();
    check(`${L}: no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (9) F5: the joystick hook per source, with hysteresis. The mouse as joystick pauses Claude once per deflection
  // out of the dead zone, not once per mousemove; a pad resting at the dead zone's edge with jitter pauses once ----
  for (const how of ['mouse', 'pad']) {
    const { ctx, page, errors, replies } = await open({ width: 1440, height: 900 });
    const L = `askEsc (F5 ${how === 'mouse' ? 'the mouse as joystick' : 'a pad resting at the dead zone\'s edge'})`;
    if (how === 'pad') {
      await page.evaluate(() => {
        const pad = (index, axes) => ({ index, id: `Mock pad ${index}`, connected: true, axes: [...axes], buttons: [false, false, false].map((p) => ({ pressed: p, value: 0 })) });
        window.__pads = [];
        navigator.getGamepads = () => [window.__pads[0] || null, null, null, null];
        window.__setPad = (axes) => { window.__pads[0] = pad(0, axes); };
        window.__setPad([0, 0]);
        window.dispatchEvent(new Event('gamepadconnected'));
      });
    } else await page.evaluate(() => { document.getElementById('chkJoy').checked = true; });
    await page.evaluate(() => document.getElementById('btnAsk').click());
    await page.evaluate(() => window.emu.session.setClaudeAllowed(false));
    replies.push({ body: tools([{ name: 'poke', input: { address: 0x3000, bytes: [0x55] } }]) }, { hold: true, body: text('Done.') });
    await page.evaluate(() => { window.emu.session.chat.sendLine('Do it'); });
    const carded = await waitFor(page, () => !!window.emu.session.claudePending, null, 8000);
    const pauses = () => page.evaluate(() => window.emu.session.claudePauses);
    const resume = () => page.evaluate(() => window.emu.session.resumeClaude());
    const p0 = await pauses();
    let counts;
    if (how === 'mouse') {
      const box = await page.evaluate(() => { const r = document.getElementById('screen').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
      const at = (fx, fy) => page.mouse.move(box.x + box.w * fx, box.y + box.h * fy);
      await at(0.5, 0.5); await at(0.52, 0.5);                     // moves inside the dead zone: nothing
      const inside = (await pauses()) - p0;
      for (const fx of [0.6, 0.7, 0.8, 0.9]) await at(fx, 0.5);    // out: once
      const first = (await pauses()) - p0;
      await resume();
      for (const fx of [0.92, 0.95, 0.85, 0.9, 0.97]) await at(fx, 0.55);   // still out, many moves: nothing new
      const stays = (await pauses()) - p0;
      await at(0.5, 0.5); await at(0.1, 0.5);                      // back in, then out again: a new deflection
      const again = (await pauses()) - p0;
      counts = { inside, first, stays, again };
    } else {
      await page.evaluate(() => window.__setPad([0.26, 0])); await emuFrames(page, 3);
      const first = (await pauses()) - p0;
      await resume();
      for (let i = 0; i < 20; i++) { await page.evaluate((k) => window.__setPad([k % 2 ? 0.26 : 0.24, 0]), i); await emuFrames(page, 2); }
      const stays = (await pauses()) - p0;
      await page.evaluate(() => window.__setPad([0, 0])); await emuFrames(page, 3);
      await page.evaluate(() => window.__setPad([0.3, 0])); await emuFrames(page, 3);
      const again = (await pauses()) - p0;
      counts = { inside: 0, first, stays, again };
    }
    check(`${L}: while Claude's call waits at its card: one pause per deflection out of the dead zone, none for moves inside it or jitter at its edge, a new one after coming back in`,
      carded && counts.inside === 0 && counts.first === 1 && counts.stays === 1 && counts.again === 2, JSON.stringify({ carded, ...counts }));
    await page.evaluate(() => window.emu.session.stopClaude());
    if (replies.held) replies.held.release();
    check(`${L}: no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }

  // ---- (10) the touch stick and its FIRE (js/ui/touch-keys.js) go through the joystick hook as the source 'touch':
  // while Claude types into the machine, a drag out of the dead zone pauses Claude once, a FIRE press once; a finger
  // resting near the centre, or jittering at the dead zone's edge, does not. Real touch events (CDP). (Claude types
  // rather than waits at a card: the touch keyboard steps aside while a card waits.)
  {
    const { ctx, page, errors, replies } = await open({ width: 844, height: 390 }, { hasTouch: true, isMobile: true });
    const L = 'askEsc (touch stick and FIRE)';
    const cdp = await page.context().newCDPSession(page);
    const touch = async (type, id, x, y) => { await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id, radiusX: 8, radiusY: 8, force: 1 }] }); await page.waitForTimeout(60); };
    const centreOf = (sel) => page.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, sel);
    const [mx, my] = await centreOf('#tkModeSwitch [data-touchmode="joystick"]');
    await touch('touchStart', 2, mx, my); await touch('touchEnd', 2);
    const stickUp = await waitFor(page, () => document.getElementById('touchKeys').classList.contains('joystick') && document.getElementById('touchStick').getBoundingClientRect().width > 0, null, 5000);
    // Claude types a long listing; the panel is closed again so the stick is not covered
    const carded = await typing(page, replies);
    await page.evaluate(() => { if (!document.getElementById('ask').hidden) document.getElementById('btnAskClose').click(); });
    await waitFor(page, () => document.getElementById('touchStick').getBoundingClientRect().width > 0, null, 5000);
    const pauses = () => page.evaluate(() => window.emu.session.claudePauses);
    const resume = () => page.evaluate(() => window.emu.session.resumeClaude());
    const R = 56;   // STICK_RADIUS (js/host/input.js)
    const p0 = await pauses();
    const [sx, sy] = await centreOf('#touchStick');
    // resting near the centre, with a little wobble: nothing
    await touch('touchStart', 1, sx, sy);
    for (const dx of [3, -4, 5, -2, 4]) await touch('touchMove', 1, sx + dx, sy);
    const rest = (await pauses()) - p0;
    // dragged out: once
    await touch('touchMove', 1, sx + R * 0.8, sy);
    const out = (await pauses()) - p0;
    await resume();
    // jitter at the dead zone's edge (0.24 / 0.26 of the radius), finger down throughout: nothing new
    for (let i = 0; i < 10; i++) await touch('touchMove', 1, sx + R * (i % 2 ? 0.26 : 0.24), sy);
    const jitter = (await pauses()) - p0;
    await touch('touchEnd', 1);
    // FIRE: once
    const [fx, fy] = await centreOf('#touchFire');
    await touch('touchStart', 3, fx, fy);
    const fire = (await pauses()) - p0;
    await touch('touchEnd', 3);
    const still = await page.evaluate(() => window.emu.session.claudeBusyActing);
    check(`${L}: while Claude types: resting and jitter at the dead zone's edge do not pause it; a drag out pauses it once, a FIRE press once`,
      stickUp && carded && still && rest === 0 && out === 1 && jitter === 1 && fire === 2, JSON.stringify({ stickUp, carded, still, rest, out, jitter, fire }));
    await page.evaluate(() => window.emu.session.stopClaude());
    if (replies.held) replies.held.release();
    check(`${L}: no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }
}

async function askStatusChecks(browser, base, check) {
  const KEY = 'sk-ant-STATUS-CHECK-KEY-0123456789abcdef';
  const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const msgStart = { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } };
  const end = (why) => [{ type: 'message_delta', delta: { stop_reason: why }, usage: {} }, { type: 'message_stop' }];
  const text = (t) => sse([msgStart, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, { type: 'content_block_stop', index: 0 }, ...end('end_turn')]);
  const toolEvents = (uses, at = 0) => uses.flatMap((u, i) => [
    { type: 'content_block_start', index: at + i, content_block: { type: 'tool_use', id: `toolu_${at + i}`, name: u.name, input: {} } },
    { type: 'content_block_delta', index: at + i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(u.input) } },
    { type: 'content_block_stop', index: at + i }]);
  const tools = (uses) => sse([msgStart, ...toolEvents(uses), ...end('tool_use')]);
  // a long thinking block, then the tool call: one chunk per event, so the stream takes a while
  const thinkingThen = (uses, n = 16) => [sse([msgStart, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }]),
    ...Array.from({ length: n }, (_, i) => sse([{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: `step ${i}. ` } }])),
    sse([{ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }, { type: 'content_block_stop', index: 0 }, ...toolEvents(uses, 1), ...end('tool_use')])];
  const slowText = (words) => [sse([msgStart, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]),
    ...words.map((w) => sse([{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${w} ` } }])),
    sse([{ type: 'content_block_stop', index: 0 }, ...end('end_turn')])];
  const PROG = Array.from({ length: 30 }, (_, i) => `${(i + 1) * 10} PRINT "BREAKOUT ${i + 1}"`).join('\n');
  // the page's fetch toward the API: scripted replies from window.__api.queue, each a whole body, a stream of chunks
  // (gapMs apart), held before its headers (holdMs), left open (stall), an HTTP error (status) or a network error.
  // Stop's abort ends it as the browser's fetch would (an AbortError)
  const MOCK = () => {
    const real = window.fetch.bind(window);
    const api = window.__api = { queue: [], requests: 0 };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.fetch = (url, init = {}) => {
      if (!String(url).startsWith('https://api.anthropic.com/')) return real(url, init);
      api.requests++;
      const r = api.queue.shift() || { chunks: [] }, signal = init.signal;
      const abortErr = () => new DOMException('The operation was aborted.', 'AbortError');
      return new Promise((resolve, reject) => {
        if (signal) signal.addEventListener('abort', () => reject(abortErr()), { once: true });
        if (r.network) { reject(new TypeError('Failed to fetch')); return; }
        if (r.status) { resolve(new Response(JSON.stringify(r.json || {}), { status: r.status, headers: { 'content-type': 'application/json' } })); return; }
        let ctl = null;
        const body = new ReadableStream({ start(c) { ctl = c; } });
        if (signal) signal.addEventListener('abort', () => { try { ctl.error(abortErr()); } catch (e) { /* closed */ } }, { once: true });
        (async () => {
          if (r.holdMs) await sleep(r.holdMs);
          if (signal && signal.aborted) return;
          resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
          for (const c of r.chunks) {
            if (signal && signal.aborted) return;
            try { ctl.enqueue(new TextEncoder().encode(c)); } catch (e) { return; }
            if (r.gapMs) await sleep(r.gapMs);
          }
          if (!r.stall) try { ctl.close(); } catch (e) { /* aborted */ }
        })();
      });
    };
  };
  const views = {
    side: { status: 'askStatus', text: 'askStatusText', stop: 'btnAskStatusStop', load: 'askLoad', loadYes: 'btnAskLoad', loadNo: 'btnAskLoadNo', consent: 'askConsent', allow: 'btnAskAllow', msg: 'askKeyMsg' },
    full: { status: 'claudeStatus', text: 'claudeStatusText', stop: 'btnClaudeStop', load: 'claudeLoad', loadYes: 'btnClaudeLoad', loadNo: 'btnClaudeLoadNo', consent: 'claudeConsentAsk', allow: 'btnClaudeAllow', msg: 'claudeHelp' },
  };
  async function open(viewport) {
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
    await ctx.addInitScript(MOCK);
    const page = await ctx.newPage();
    const errors = [], logs = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => logs.push(m.text()));
    await page.goto(`${base}?machine=dragon64`);
    await started(page);
    await stubPrompt(page);
    await page.evaluate((k) => localStorage.setItem('cloadm.anthropicKey', k), KEY);
    // BASIC's shape without a BASIC ROM, as askFollowupChecks (6): our idle firmware in the BASIC socket, an empty
    // program at $1E01 and OK on the screen. "Let Claude use the machine" stays off, as in the report
    await page.evaluate(() => {
      const s = window.emu.session, m = s.machine, E = window.emu.Emu;
      const asm = E.assemble(' ORG $8000\nSTART STA $FFC9\n CLR $FF23\n LDA #$F8\n STA $FF22\n LDA #$04\n STA $FF23\n CLR $FF22\nIDLE BRA IDLE\n', '6809');
      const rom = new Uint8Array(0x4000).fill(0xFF); rom.set(asm.segments[0].data, 0);
      m.setRoms({ basic: rom }); m.reset(true); m.cpu.jump(asm.exec);
      const w = (a, v) => s.pokeBytes(a, [v >> 8, v & 0xFF], m);
      s.pokeBytes(0x1E00, [0, 0, 0], m);
      w(0x19, 0x1E01); w(0x1B, 0x1E03); w(0x1D, 0x1E03); w(0x1F, 0x1E03); w(0x21, 0x7E00);
      for (let i = 0; i < 512; i++) m.ram[0x400 + i] = 0x60;
      m.ram[0x440] = 0x0F; m.ram[0x441] = 0x0B;
    });
    await emuFrames(page, 3);
    return { ctx, page, errors, logs };
  }
  const reply = (page, r) => page.evaluate((x) => window.__api.queue.push(x), r);
  // a turn ended by Stop leaves its later replies unasked: a new turn starts from an empty script
  const fresh = (page) => page.evaluate(() => { window.__api.queue.length = 0; });
  // the view's status: shown (laid out, inside the window), its text, and Stop shown and enabled
  const status = (page, v) => page.evaluate((v) => {
    const s = document.getElementById(v.status), t = document.getElementById(v.text), b = document.getElementById(v.stop);
    const shown = (e) => { if (!e || e.closest('[hidden]') || !e.offsetParent) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
    return { shown: shown(s), text: t ? t.textContent : null, stop: shown(b) && !b.disabled };
  }, v);
  // an element is wholly in view: laid out, inside the window and inside every scrolling box around it
  const inView = (page, id) => page.evaluate((id) => {
    const e = document.getElementById(id);
    if (!e || e.closest('[hidden]') || !e.offsetParent) return false;
    const r = e.getBoundingClientRect();
    if (r.top < -1 || r.bottom > innerHeight + 1 || r.left < -1 || r.right > innerWidth + 1) return false;
    for (let p = e.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (!/(auto|scroll|hidden)/.test(cs.overflowY)) continue;
      const pr = p.getBoundingClientRect();
      if (p.scrollHeight > p.clientHeight + 1 && (r.top < pr.top - 1 || r.bottom > pr.bottom + 1)) return false;
    }
    return true;
  }, id);
  const statusIs = (page, v, re, ms = 15000) => waitFor(page, ([v, src]) => {
    const s = document.getElementById(v.status), t = document.getElementById(v.text), b = document.getElementById(v.stop);
    return !!(s && t && b && !s.closest('[hidden]') && s.offsetParent && new RegExp(src).test(t.textContent) && b.offsetParent && !b.disabled);
  }, [v, re.source], ms);
  const idle = (page) => waitFor(page, () => !window.emu.session.chat.busy, null, 20000);
  // the turn has ended and the person can go on: no status, the box (side panel) or the chat (full screen) takes a line
  const usable = (page, v, full) => page.evaluate(([v, full]) => {
    const s = document.getElementById(v.status);
    const free = !window.emu.session.chat.busy && !window.emu.session.claudePending && (!s || !!s.closest('[hidden]') || !s.offsetParent);
    if (full) return free;
    const i = document.getElementById('askInput'), b = document.getElementById('btnAskSend');
    return free && !!i.offsetParent && !i.disabled && !b.disabled;
  }, [v, full]);

  // one view's variants. send(q) sends a line from the view; shot(name) takes a screenshot
  async function variants(page, v, send, label, full, shot, set = 'all') {
    const all = set === 'all';
    // the report's turn: Claude calls load_basic (its request held a while first, as a long tool call streams no text)
    await reply(page, { holdMs: 6000, chunks: [tools([{ name: 'load_basic', input: { program: PROG } }])] });
    await send('yes');
    check(`${label}: while Claude thinks (no text yet) the status says Thinking…, with Stop`, await statusIs(page, v, /Thinking…/, 4000), JSON.stringify(await status(page, v)));
    await shot('thinking');
    check(`${label}: load_basic's card: the status says Waiting for your OK, with Stop, and the card is in view`,
      await statusIs(page, v, /Waiting for your OK/) && await waitFor(page, (id) => !document.getElementById(id).hidden, v.load) && await inView(page, v.load), JSON.stringify(await status(page, v)));
    await shot('consent');
    let n = await page.evaluate(() => window.__api.requests);
    await page.click(`#${v.stop}`);
    check(`${label}: Stop at the card ends the turn: the card goes, nothing more is asked, and the input works again`,
      await idle(page) && await usable(page, v, full) && await page.isHidden(`#${v.load}`) && (await page.evaluate(() => window.__api.requests)) === n);
    if (!all) {
      // the phone sheet lowered to peek while Claude thinks: its peek line keeps the status and a Stop
      if (full) return;
      await fresh(page);
      await reply(page, { holdMs: 30000, chunks: [text('late')] });
      await send('and now?');
      await statusIs(page, v, /Thinking…/);
      for (let i = 0; i < 3 && await page.evaluate(() => document.getElementById('ask').dataset.height !== 'peek'); i++) await page.click('#askHandle');
      const peek = await page.evaluate(() => ({ h: document.getElementById('ask').dataset.height, text: document.getElementById('askPeekText').textContent, stop: !!document.getElementById('btnAskPeekStop').offsetParent }));
      check(`${label}: lowered to peek while Claude thinks, the peek line says Thinking… with a Stop`, peek.h === 'peek' && /Thinking…/.test(peek.text) && peek.stop, JSON.stringify(peek));
      await page.click('#btnAskPeekStop');
      check(`${label}: the peek line's Stop ends the turn`, await idle(page));
      await page.click('#btnAskPeekOpen');
      // the sheet closed (✕) while Claude thinks lowers to peek: the status and its Stop stay in view
      await fresh(page);
      await reply(page, { holdMs: 30000, chunks: [text('late')] });
      await send('and then?');
      await statusIs(page, v, /Thinking…/);
      await page.click('#btnAskClose');
      const shut = await page.evaluate(() => ({ h: document.getElementById('ask').dataset.height, open: !document.getElementById('ask').hidden, text: document.getElementById('askPeekText').textContent }));
      check(`${label}: closed while Claude thinks, the sheet lowers to peek with Thinking… and its Stop in view`, shut.open && shut.h === 'peek' && /Thinking…/.test(shut.text) && await inView(page, 'btnAskPeekStop'), JSON.stringify(shut));
      await page.click('#btnAskPeekStop');
      check(`${label}: and that Stop ends the turn, and the sheet the person closed then closes`, await idle(page)
        && await waitFor(page, () => document.getElementById('ask').hidden && !document.body.classList.contains('ask-open')));
      // lowered by ✕, then raised again by the person: it stays open when the turn ends
      await page.click('#btnAsk');
      await fresh(page);
      await reply(page, { holdMs: 30000, chunks: [text('late')] });
      await send('still here?');
      await statusIs(page, v, /Thinking…/);
      await page.click('#btnAskClose');
      await page.click('#btnAskPeekOpen');
      await page.click('#btnAskStatusStop');
      check(`${label}: closed, then raised again during the turn: the sheet stays open when the turn ends`, await idle(page)
        && (await emuFrames(page, 5), await page.evaluate(() => !document.getElementById('ask').hidden && document.getElementById('ask').dataset.height !== 'peek')));
      // to full screen in the middle of a turn: the sheet goes, the full screen's status and Stop take over
      await fresh(page);
      await reply(page, { holdMs: 30000, chunks: [text('late')] });
      await send('one more');
      await statusIs(page, v, /Thinking…/);
      await page.click('#btnAskFull');
      await waitFor(page, () => window.emu.session.claudeView === 'full', null, 15000);
      const fv = views.full;
      check(`${label}: to full screen mid-turn, the sheet is gone and the full screen shows Thinking… with Stop`, await statusIs(page, fv, /Thinking…/)
        && await page.evaluate(() => document.getElementById('ask').hidden && !document.body.classList.contains('ask-open')));
      await page.click(`#${fv.stop}`);
      check(`${label}: and its Stop ends the turn`, await idle(page));
      await page.click('#btnFullSide');
      await waitFor(page, () => window.emu.session.claudeView === 'panel' && !document.getElementById('ask').hidden, null, 15000);
      return;
    }
    await fresh(page);
    if (!full) {
      // minimised while Claude thinks: the strip says Thinking… and has its own Stop
      await reply(page, { holdMs: 30000, chunks: [text('late')] });
      await send('and you?');
      await statusIs(page, v, /Thinking…/);
      await page.click('#btnAskMin');
      const strip = await page.evaluate(() => ({ text: document.getElementById('askStripText').textContent, stop: !!document.getElementById('btnAskStripStop').offsetParent }));
      check(`${label}: minimised while Claude thinks, the strip says Thinking… with a Stop`, /Thinking…/.test(strip.text) && strip.stop, JSON.stringify(strip));
      await page.click('#btnAskStripStop');
      check(`${label}: the strip's Stop ends the turn`, await idle(page) && await page.isHidden('#btnAskStripStop'));
      // closed (✕) while Claude thinks: the strip stays with the status and Stop, and the card, when it comes, opens the panel
      await page.click('#btnAsk');
      await fresh(page);
      await reply(page, { holdMs: 1500, chunks: [tools([{ name: 'load_basic', input: { program: PROG } }])] });
      await send('load it');
      await statusIs(page, v, /Thinking…/);
      await page.click('#btnAskClose');
      const closed = await page.evaluate(() => ({ text: document.getElementById('askStripText').textContent, stop: !!document.getElementById('btnAskStripStop').offsetParent }));
      check(`${label}: closed while Claude thinks, the strip keeps Thinking… and a Stop`, /Thinking…/.test(closed.text) && closed.stop, JSON.stringify(closed));
      check(`${label}: then the card opens the panel, in view, with Waiting for your OK`, await statusIs(page, v, /Waiting for your OK/) && await inView(page, v.load));
      await page.click(`#${v.loadNo}`);
      await idle(page);
      // a card that comes while a page view (the Library) covers the emulator: the panel opens on it, in view, when
      // the person comes back
      await fresh(page);
      await reply(page, { holdMs: 1500, chunks: [tools([{ name: 'load_basic', input: { program: PROG } }])] });
      await send('load it again');
      await page.evaluate(() => { location.hash = '#library'; });
      await waitFor(page, () => !!window.emu.session.claudePending, null, 15000);
      await page.evaluate(() => { location.hash = ''; });
      const back = await statusIs(page, v, /Waiting for your OK/) && await inView(page, v.load);
      check(`${label}: a card that came under a page view is in view with Waiting for your OK on coming back`, back, JSON.stringify(await page.evaluate(() => ({ hidden: document.getElementById('ask').hidden, rects: document.getElementById('ask').getClientRects().length, hash: location.hash, card: !document.getElementById('askLoad').hidden, st: document.getElementById('askStatusText').textContent, body: document.getElementById('askBody').scrollTop + '/' + document.getElementById('askBody').scrollHeight }))));
      await page.click(`#${v.loadNo}`);
      await idle(page);
      await fresh(page);
    }
    // a long thinking block streamed before the tool call; then Load it, and Claude's reply ends the turn
    await reply(page, { gapMs: 120, chunks: thinkingThen([{ name: 'load_basic', input: { program: PROG } }]) });
    await reply(page, { chunks: [text('Loaded. LIST shows all 30 lines.')] });
    await send('yes, load it');
    check(`${label}: a long thinking block streams: Thinking…, with Stop`, await statusIs(page, v, /Thinking…/, 3000), JSON.stringify(await status(page, v)));
    check(`${label}: then the card, with Waiting for your OK`, await statusIs(page, v, /Waiting for your OK/) && await inView(page, v.load));
    await page.click(`#${v.loadYes}`);
    check(`${label}: Load it: the turn ends with Claude's reply, and the input works again`, await idle(page) && await usable(page, v, full)
      && await page.evaluate(() => window.emu.session.chat.messages.slice(-1)[0].content === 'Loaded. LIST shows all 30 lines.'));
    // a tool that runs a while: type_text, after the consent card (the switch is off: an earlier Allow turned it on)
    await page.evaluate(() => window.emu.session.setClaudeAllowed(false));
    await reply(page, { chunks: [tools([{ name: 'type_text', input: { text: Array.from({ length: 30 }, (_, i) => `${i + 1}0 REM LINE ${i + 1}`).join('\n') + '\n' } }])] });
    await reply(page, { chunks: [text('Typed.')] });
    await send('type it instead');
    check(`${label}: the consent card: Waiting for your OK, with Stop, the card in view`, await statusIs(page, v, /Waiting for your OK/) && await inView(page, v.consent));
    await page.click(`#${v.allow}`);
    check(`${label}: while a tool runs the status says Using type_text…, with Stop`, await statusIs(page, v, /Using type_text…/), JSON.stringify(await status(page, v)));
    await shot('using');
    await page.click(`#${v.stop}`);
    check(`${label}: Stop while the tool runs ends the turn and the typing, nothing more is asked, and the input works again`, await idle(page) && await usable(page, v, full)
      && await page.evaluate(() => window.emu.session.chatTarget().machine.typist.queue.length === 0 && window.__api.queue.length === 1));
    // a slow reply: text streams in a word at a time; Stop mid-way
    await fresh(page);
    // (what has streamed so far, as the chat hands it to the view: in full screen it is drawn on the machine's screen)
    await page.evaluate(() => { const c = window.emu.session.chat, f = c.onText; window.__seen = ''; c.onText = (t) => { window.__seen += t; if (f) f(t); }; });
    await reply(page, { gapMs: 400, chunks: slowText('Here is the program as text instead so you can read it first and then decide'.split(' ')) });
    await send('show me');
    check(`${label}: a reply streaming slowly: Thinking…, with Stop, while its text comes in`, await statusIs(page, v, /Thinking…/) && await waitFor(page, () => /Here is/.test(window.__seen)));
    await page.click(`#${v.stop}`);
    check(`${label}: Stop mid-stream ends the turn before the reply is complete, and the input works again`, await idle(page) && await usable(page, v, full)
      && await page.evaluate(() => !/decide/.test(window.__seen)));
    // a stream that stalls: Stop before the limit works
    await fresh(page);
    await reply(page, { stall: true, chunks: [sse([msgStart])] });
    await send('again');
    check(`${label}: a stalled stream: Thinking…, with Stop`, await statusIs(page, v, /Thinking…/));
    await page.click(`#${v.stop}`);
    check(`${label}: Stop on a stalled stream ends the turn`, await idle(page) && await usable(page, v, full));
  }
  // the failures: each ends the turn with its message in the conversation, and the input works again
  async function failures(page, v, send, label, full, shot, set = 'all') {
    const cases = [
      ['an HTTP error (529 overloaded)', { status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }, /overloaded/i],
      ['a network error', { network: true }, /Could not reach Claude/],
      ['an SSE error event mid-stream', { chunks: [sse([msgStart, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])] }, /overloaded/i],
      ['a stalled stream past the limit', { stall: true, chunks: [sse([msgStart])] }, /stopped answering/i],
    ];
    await fresh(page);
    for (const [what, r, re] of set === 'all' ? cases : cases.slice(0, 1)) {
      if (/stalled/.test(what)) await page.evaluate(() => { const b = window.emu.session.chat.backend; window.__stallMs = b.stallMs; b.stallMs = 1500; });
      await reply(page, r);
      await send('try');
      const ok = await idle(page) && await waitFor(page, ([id, src]) => { const e = document.getElementById(id); return !!e && !e.closest('[hidden]') && new RegExp(src).test(e.textContent); }, [v.msg, re.source]);
      const free = await usable(page, v, full);
      check(`${label}: ${what} ends the turn with its message shown, and the input works again`, ok && free,
        `${ok} ${free} ${await page.evaluate((id) => document.getElementById(id).textContent, v.msg)}`);
      if (what === cases[0][0]) await shot('error');
      if (/stalled/.test(what)) await page.evaluate(() => { window.emu.session.chat.backend.stallMs = window.__stallMs; });
    }
    if (set !== 'all') return;
    // an exception in the tool loop (the page's own handler throws): the turn ends with a message
    await page.evaluate(() => { const c = window.emu.session.chat, f = c.onToolUse; c.onToolUse = () => { c.onToolUse = f; throw new Error('the tool loop broke'); }; });
    await reply(page, { chunks: [tools([{ name: 'machine_info', input: {} }])] });
    await send('what machine?');
    check(`${label}: an exception in the tool loop ends the turn with its message, and the input works again`, await idle(page) && await usable(page, v, full)
      && await waitFor(page, (id) => /the tool loop broke/.test(document.getElementById(id).textContent), v.msg));
    // and the conversation goes on
    await reply(page, { chunks: [text('Still here.')] });
    await send('still there?');
    check(`${label}: after the failures a new question is answered`, await idle(page) && await page.evaluate(() => window.emu.session.chat.messages.slice(-1)[0].content === 'Still here.'));
  }

  for (const [vp, tag] of [[{ width: 1440, height: 900 }, 'desktop'], [{ width: 390, height: 844 }, 'phone']]) {
    const phone = tag === 'phone', set = phone ? 'some' : 'all';
    const { ctx, page, errors, logs } = await open(vp);
    const shotter = (view) => async (name) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, `ask-status-${view}-${tag}-${name}.png`) }); };
    // the report's first turn: a question, and Claude asking in prose
    await page.click('#btnAsk');
    // (a long answer, so the conversation fills the panel and a card that comes up later starts below its fold)
    await reply(page, { chunks: [text(`It is about 30 lines. I can load it straight into memory for you.\n${Array.from({ length: 24 }, (_, i) => `${(i + 1) * 10} REM PART ${i + 1}`).join('\n')}`)] });
    const askNow = async (q) => { await page.fill('#askInput', q); await page.press('#askInput', 'Enter'); };
    await askNow('can you write a breakout game?');
    await idle(page);
    await variants(page, views.side, askNow, `ask status (side panel, ${tag})`, false, shotter('side'), set);
    await failures(page, views.side, askNow, `ask status (side panel, ${tag})`, false, shotter('side'), set);
    // the same conversation in full screen; lines go to the chat as the firmware sends them
    await page.click('#btnAskFull');
    await waitFor(page, () => window.emu.session.claudeView === 'full' && !!window.emu.session.chatMachines, null, 15000);
    const fullSend = (q) => page.evaluate((x) => { window.emu.session.chat.sendLine(x); }, q);
    await variants(page, views.full, fullSend, `ask status (full screen, ${tag})`, true, shotter('full'), set);
    await failures(page, views.full, fullSend, `ask status (full screen, ${tag})`, true, shotter('full'), set);
    const shown = await page.evaluate(() => document.body.innerText);
    check(`ask status (${tag}): the API key is in no console log and nowhere on the page`, !logs.some((l) => l.includes(KEY)) && !shown.includes(KEY));
    check(`ask status (${tag}): no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }
}

// Ask Claude against a mocked Messages API, at desktop width and on a 390 px phone: the header's "Ask Claude"
// button and Ctrl+K (a command runs and is never sent; anything else asks Claude), the API key states (no key,
// refused, rate limited, offline, each with its text, and Try again), a question and its streamed answer, consent
// the first time Claude wants to act (Allow), the activity pill and Stop, the restore point and Undo, and the move
// to full screen and back with the same conversation.
// the strings the Ask Claude copy fix removed: none may be anywhere in the page text (hidden elements included)
const OLD_COPY = ['Your screen', 'Your memory', 'your screen or program', 'Claude can see', 'use the machine'];
const oldCopy = (page) => page.evaluate((list) => { const t = document.body.textContent + ' ' + [...document.querySelectorAll('[aria-label],[placeholder]')].map((e) => (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('placeholder') || '')).join(' '); return list.filter((x) => t.includes(x)); }, OLD_COPY);

async function askChecks(browser, base, check) {
  const KEY = 'sk-ant-ASK-CHECK-KEY-0123456789';
  const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const msgStart = { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } };
  const text = (t) => sse([msgStart, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]);
  const tools = (uses) => sse([msgStart, ...uses.flatMap((u, i) => [
    { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_${i}`, name: u.name, input: {} } },
    { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(u.input) } },
    { type: 'content_block_stop', index: i }]), { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} }, { type: 'message_stop' }]);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  const LISTING = Array.from({ length: 40 }, (_, i) => `${(i + 1) * 10} PRINT "LINE ${i + 1}"`).join('\n') + '\n';

  for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const L = `ask (${label})`, phone = label === 'phone';
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block', acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const requests = [], replies = [];
    let release = null;
    await ctx.route('https://api.anthropic.com/**', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      requests.push(JSON.parse(req.postData()));
      const r = replies.shift() || { body: text('ok') };
      if (r.offline) return route.abort('internetdisconnected');
      if (r.hold) await new Promise((res) => { release = res; });
      try { await route.fulfill({ status: r.status || 200, headers: { ...cors, 'content-type': r.status ? 'application/json' : 'text/event-stream' }, body: r.body }); }
      catch (e) { /* the page stopped the request */ }
    });
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const vis = (sel) => page.isVisible(sel);
    const idle = () => waitFor(page, () => window.emu.session.chat && !window.emu.session.chat.busy, null, 15000);
    const ask = async (t) => { await page.fill('#askInput', t); await page.press('#askInput', 'Enter'); };
    const shot = async (name) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, `ask-${name}-${label}.png`) }); };

    await page.goto(`${base}?machine=dragon64`);
    await started(page);
    // the live machine, not the welcome menu (a link that names a machine opens on it; with the menu on
    // screen "Ask Claude" opens full screen instead of beside the machine)
    await stubPrompt(page);
    // ---- the header button; no key yet ----
    check(`${L}: the header has "Ask Claude"${phone ? '' : ' with its Ctrl K hint'}`, await vis('#btnAsk') && /Ask Claude/.test(await page.textContent('#btnAsk'))
      && (phone || /Ctrl K|⌘K/.test(await page.textContent('#btnAsk'))) && await page.getAttribute('#btnAsk', 'aria-pressed') === 'false');
    await shot('closed');
    await page.click('#btnAsk');
    const opened = await ev(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(), s = r('screen'), a = r('ask');
      return { ask: !document.getElementById('ask').hidden, s: { top: s.top, bottom: s.bottom, right: s.right }, a: { top: a.top, left: a.left, bottom: a.bottom, width: a.width },
        drawer: getComputedStyle(document.querySelector('.drawer')).display, rail: !!document.getElementById('askRail') && getComputedStyle(document.getElementById('askRail')).display !== 'none',
        railButtons: [...document.querySelectorAll('#askRail button')].map((b) => b.textContent.trim()).join(), h: innerHeight, w: innerWidth,
        view: window.emu.session.claudeView, machine: window.emu.machine === window.emu.session.chat.target.machine }; });
    check(`${L}: "Ask Claude" opens the ${phone ? 'bottom sheet under the screen' : 'side panel beside the live machine; the drawer folds into the icon rail'}`, opened.ask && opened.view === 'panel' && opened.machine
      && (phone ? Math.abs(opened.a.bottom - opened.h) <= 1 && opened.a.top >= opened.s.bottom - 1
        : opened.a.left >= opened.s.right && opened.a.width >= 320 && opened.a.width <= 560 && opened.drawer === 'none' && opened.rail && opened.railButtons === 'Media,Display,Input,POKEs,Machine')
      && await page.getAttribute('#btnAsk', 'aria-pressed') === 'true', JSON.stringify(opened));
    check(`${L}: no key: the key form replaces the message box, with "Your key stays yours"`, await vis('#askKeyForm') && !(await vis('#askComposer'))
      && /Your Anthropic API key/.test(await page.textContent('#askKeyForm')) && /Your key stays yours/.test(await page.textContent('#askKeyForm')));
    await shot('key-no-key');
    await page.fill('#askKeyInput', KEY);
    await page.click('#btnAskKeySave');
    check(`${L}: Save key: the message box comes back, and the key is saved in this browser`, await vis('#askComposer') && !(await vis('#askKeyForm'))
      && await ev((k) => localStorage.getItem('cloadm.anthropicKey') === k, KEY) && /Saved in this browser/.test(await page.textContent('#ask')));
    check(`${L}: the panel says what Claude can read (emulator only), and the switch "Let Claude use the emulator" is off`, await page.textContent('#askSee') === 'Claude can read (emulator only):Screen textMemory'
      && await page.getAttribute('#askInput', 'placeholder') === 'Ask about this machine…' && await page.textContent('#askPeekText') === 'Ask about this machine'
      && !(await page.isChecked('#chkAskMachine')));
    check(`${L}: the empty state says Claude reads only this emulated machine, visible${phone ? ' on the phone sheet (where "Claude can read" is hidden)' : ''}, and names it`, await vis('#askEmpty') && !(await vis('#askSee')) === phone
      && (await page.textContent('#askEmptyText')) === 'Claude reads only this emulated Dragon 64 (its screen text and memory), never your computer. It types or changes things only if you allow it.', await page.textContent('#askEmptyText'));
    check(`${L}: the footer line about Anthropic is visible`, await vis('#askSendNote') && await page.textContent('#askSendNote') === 'Your messages and what Claude reads go to Anthropic with your key.');
    // the empty state follows a machine switch (the panel text updates whether or not the panel is showing)
    await page.evaluate(() => window.emu.session.switchMachine('coco'));
    const named = await waitFor(page, () => /CoCo 1\/2/.test(document.getElementById('askEmptyText').textContent), null, 5000);
    check(`${L}: switching machines updates the name in the empty state`, named && /emulated CoCo 1\/2 \(/.test(await page.textContent('#askEmptyText')), await page.textContent('#askEmptyText'));
    await page.evaluate(() => window.emu.session.switchMachine('dragon64'));
    check(`${L}: and back`, await waitFor(page, () => /Dragon 64/.test(document.getElementById('askEmptyText').textContent), null, 5000));
    // a machine switch shows the welcome menu (where "Ask Claude" opens the full screen chat) and can leave the panel up:
    // back on the live machine, close whatever is open and open the side panel, checking each step
    await stubPrompt(page);
    if (await vis('#ask')) {
      await page.click('#btnAsk');
      check(`${L}: (setup) the panel left up by the switch closes`, await waitFor(page, () => document.getElementById('ask').hidden, null, 5000));
    }
    await page.click('#btnAsk');
    check(`${L}: (setup) "Ask Claude" opens the side panel again, not the full screen chat`, await waitFor(page, () => window.emu.session.claudeView === 'panel' && !document.getElementById('ask').hidden, null, 5000),
      await page.evaluate(() => String(window.emu.session.claudeView)));
    check(`${L}: none of the old wording is on the page`, !(await oldCopy(page)).length, (await oldCopy(page)).join());
    await shot('open-ready');
    // ---- a question and its streamed answer ----
    replies.push({ body: text('A syntax error: a quote is missing.') });
    await ask('What does ?SN ERROR mean?');
    await idle();
    const msgs = () => ev(() => [...document.querySelectorAll('#askMessages .msg')].map((m) => `${m.dataset.role}:${m.textContent}`));
    check(`${L}: the question goes to Claude with the brief and the tools; the answer shows in the panel`, requests.length === 1 && requests[0].messages.slice(-1)[0].content === 'What does ?SN ERROR mean?'
      && /CLOADM/.test(Array.isArray(requests[0].system) ? requests[0].system.map((b) => b.text).join('') : requests[0].system) && requests[0].tools.length >= 3
      && JSON.stringify(await msgs()) === JSON.stringify(['user:What does ?SN ERROR mean?', 'claude:A syntax error: a quote is missing.']), JSON.stringify(await msgs()));
    // ---- consent, acting, the pill and Stop, the restore point and Undo ----
    // type_text answers once the machine has read every key, so Stop ends this turn inside the tool: no second
    // request is made, and none is queued for it (a queued one would answer the next question instead)
    replies.push({ body: tools([{ name: 'type_text', input: { text: LISTING } }]) });
    await ask('Type a listing in for me');
    check(`${L}: the first time Claude wants to act it asks: Allow / Just tell me the fix`, await waitFor(page, () => !document.getElementById('askConsent').hidden)
      && /Let Claude use the emulator\?/.test(await page.textContent('#askConsent')) && await vis('#btnAskAllow') && await vis('#btnAskTell'));
    await shot('consent');
    await page.click('#btnAskAllow');
    const acting = await waitFor(page, () => { const p = document.getElementById('askActing'); return p && !p.hidden && /Claude is typing line \d+/.test(p.textContent); }, null, 8000);
    check(`${L}: Allow: Claude types into the machine; the screen shows "Claude is typing line …" with Stop, and the switch is now on`, acting && await vis('#btnAskStop')
      && await page.isChecked('#chkAskMachine') && await ev(() => document.getElementById('monitor').classList.contains('claude-acting')), await page.textContent('#askActing'));
    check(`${L}: the panel's log says a restore point was made`, /restore point made/.test(await page.textContent('#askActivity')));
    await shot('acting');
    await page.click('#btnAskStop');
    check(`${L}: Stop ends the turn and the typing; the pill goes`, await waitFor(page, () => { const s = window.emu.session, m = s.machine;
      return !s.chat.busy && m.stubKeys.length === 0 && document.getElementById('askActing').hidden && !document.getElementById('monitor').classList.contains('claude-acting'); }));
    if (release) { release(); release = null; }
    check(`${L}: after Claude's changes the restore card offers "Restore to before Claude's changes"`, await waitFor(page, () => !document.getElementById('askRestore').hidden)
      && /Restore to before Claude's changes/.test(await page.textContent('#askRestore')));
    // (on a phone the card itself sits in the ⋯ menu, so there the note is checked as part of the card, like the card above)
    check(`${L}: the restore card says the points are kept in memory only`, (phone || await vis('#askPointNote'))
      && await ev(() => { const n = document.getElementById('askPointNote'); return !!n && document.getElementById('askRestore').contains(n) && !n.hidden; })
      && /kept only while this chat is open: reloading the page, ending the chat or switching machine loses them/.test(await page.textContent('#askPointNote')));
    // a restore that fails (mocked: the machine refuses the point, as after Forget ROMs): an error toast, nothing changed, the points kept
    check(`${L}: a restore that fails shows why as an error, and changes nothing: machine, points and the card stay`, await ev(() => {
      const s = window.emu.session, m = s.machine, before = window.emu.Emu.state.toJSON(m.snapshot()), n = s.chat.undo.length;
      m.checkSnapshot = () => { throw new Error('snapshot was taken with a different basic ROM'); };
      try { document.getElementById('btnAskRestore').click(); } finally { delete m.checkSnapshot; }
      const t = document.getElementById('toast');
      // one sentence, so all of it is in the toast's first line (the toast keeps later sentences under Details)
      return t.classList.contains('error') && document.getElementById('toastText').textContent === "Can't restore that point (snapshot was taken with a different basic ROM): nothing was changed, and your restore points are kept."
        && window.emu.Emu.state.toJSON(m.snapshot()) === before && s.chat.undo.length === n && n > 0;
    }) && !(await ev(() => document.getElementById('askRestore').hidden)), await page.textContent('#toast'));
    // (mocked: Session.restorePoint, the one restore path, reports a disk the Library has changed since the point, as
    // tests/restore-points.test.js shows it does; no disk system here, since that needs a DOS ROM)
    const NOTICE = "Drive 0 was changed since this point; the restored disk isn't saved to the Library. Download it to keep it.";
    check(`${L}: Restore puts the machine back exactly to the restore point, and the panel shows the disk notice with it`, await ev((notice) => {
      const s = window.emu.session, want = window.emu.Emu.state.toJSON(s.chat.undo[s.chat.undo.length - 1]);
      const real = s.restorePoint.bind(s);
      s.restorePoint = (m, snap) => [...real(m, snap), notice];
      try { document.getElementById('btnAskRestore').click(); } finally { delete s.restorePoint; }
      const t = document.getElementById('toast');
      return window.emu.Emu.state.toJSON(s.machine.snapshot()) === want && s.chat.undo.length === 0
        && !t.classList.contains('error') && document.getElementById('toastText').textContent === `Restored: the machine is as it was before Claude's changes. ${notice}`;
    }, NOTICE), await page.textContent('#toast'));
    // ---- assemble_and_load and run: consent off means no change; Allow, then the round trip; Restore undoes it ----
    const PROG = ' ORG $3000\nSTART LDA #$41\n STA $4000\n BRA START\n';
    await ev(() => window.emu.session.setClaudeAllowed(false));   // the switch's own effect (on a phone it sits under the sheet)
    check(`${L}: the switch is off again, so Claude has to ask`, await ev(() => !window.emu.session.claudeAllowed));
    replies.push({ body: tools([{ name: 'assemble_and_load', input: { source: PROG } }]) }, { body: text('Loaded.') });
    await ask('Load a little program');
    check(`${L}: with consent off assemble_and_load asks first, and nothing is written`, await waitFor(page, () => !document.getElementById('askConsent').hidden)
      && /load a program into memory/.test(await page.textContent('#askConsent'))
      && await ev(() => window.emu.session.machine.ram[0x3000] === 0 && window.emu.session.chat.undo.length === 0));
    await page.click('#btnAskTell');
    await idle();
    check(`${L}: "Just tell me the fix": still nothing written, no restore point, and the tool result says why`, await ev(() => window.emu.session.machine.ram[0x3000] === 0 && window.emu.session.chat.undo.length === 0 && !window.emu.session.claudeAllowed)
      && JSON.stringify(requests[requests.length - 1].messages.slice(-1)[0].content).includes('consent-declined'));
    replies.push({ body: tools([{ name: 'assemble_and_load', input: { source: PROG } }]) }, { body: tools([{ name: 'run', input: { target: '$3000' } }]) }, { body: text('Running.') });
    await ask('Load it and run it');
    await waitFor(page, () => !document.getElementById('askConsent').hidden);
    await page.click('#btnAskAllow');
    await idle();
    check(`${L}: Allow: the program is loaded (bytes) and run (it writes $4000), in one turn with one restore point`, await waitFor(page, () => window.emu.session.machine.ram[0x4000] === 0x41, null, 8000)
      && await ev(() => [0x86, 0x41, 0xB7, 0x40, 0x00, 0x20, 0xF9].every((b, i) => window.emu.session.machine.ram[0x3000 + i] === b) && window.emu.session.chat.undo.length === 1)
      && /\\"bytes\\":7/.test(JSON.stringify(requests[requests.length - 2].messages.slice(-1)[0].content)));
    check(`${L}: Restore puts the machine back: the program and what it wrote are gone`, await ev(() => {
      document.getElementById('btnAskRestore').click();
      const m = window.emu.session.machine;
      return m.ram[0x3000] === 0 && m.ram[0x4000] === 0 && window.emu.session.chat.undo.length === 0;
    }));
    if (!phone) {
      // the rail: a drawer tab over the panel, Esc closes it; minimised: the strip at the top of the drawer, Open
      await page.click('#askRail button[aria-label="Display"]');
      const railed = await ev(() => getComputedStyle(document.querySelector('.drawer')).display !== 'none' && !document.getElementById('panel-display').hidden && !document.getElementById('ask').hidden);
      await page.keyboard.press('Escape');
      check(`${L}: a rail icon opens that drawer tab over the panel; Esc closes it`, railed && await ev(() => getComputedStyle(document.querySelector('.drawer')).display === 'none'));
      await page.click('#btnAskMin');
      check(`${L}: Minimise: the panel goes, a strip at the top of the drawer says Ask Claude with Open`, await page.isHidden('#ask') && await vis('#askStrip')
        && /Ask Claude/.test(await page.textContent('#askStrip')) && /Open/.test(await page.textContent('#askStrip')));
      await shot('minimised');
      await page.click('#askStrip');
      check(`${L}: Open brings the panel back with the conversation`, await vis('#ask') && (await msgs()).length >= 2);
    }
    // ---- the key states ----
    replies.push({ status: 429, body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }) });
    await ask('again');
    await idle();
    const n0 = requests.length;
    check(`${L}: rate limited: the message and Try again; nothing retries by itself`, await waitFor(page, () => /Your API account is rate limited/.test(document.getElementById('askKeyMsg').textContent))
      && await vis('#btnAskRetry') && (await page.waitForTimeout(500), requests.length === n0));
    await shot('key-rate-limited');
    replies.push({ body: text('Back again.') });
    await page.click('#btnAskRetry');
    await idle();
    check(`${L}: Try again sends the same question once more`, requests.length === n0 + 1 && requests[n0].messages.slice(-1)[0].content === 'again' && await page.isHidden('#askKeyMsg'));
    replies.push({ offline: true });
    await ask('are you there?');
    await idle();
    check(`${L}: offline: "Could not reach Claude. Check your connection." with Try again`, await waitFor(page, () => /Could not reach Claude\. Check your connection\./.test(document.getElementById('askKeyMsg').textContent))
      && await vis('#btnAskRetry'));
    await shot('key-offline');
    replies.push({ status: 401, body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
    await ask('and now?');
    await idle();
    check(`${L}: refused: "[The API key was refused: check it and try again.]" and the key form reopens with a red border`,
      await waitFor(page, () => document.getElementById('askKeyMsg').textContent.includes('[The API key was refused: check it and try again.]'))
      && await vis('#askKeyForm') && await ev(() => getComputedStyle(document.getElementById('askKeyInput')).borderTopColor === 'rgb(255, 122, 112)'));
    await shot('key-refused');
    await page.fill('#askKeyInput', KEY);
    await page.click('#btnAskKeySave');
    // ---- Ctrl+K: a command runs (never sent to Claude); anything else asks ----
    const said = (await msgs()).length;
    await page.click('#btnAskClose');
    check(`${L}: Close: the panel goes and the ${phone ? 'machine has the screen again' : 'drawer comes back'}`, await page.isHidden('#ask') && await page.getAttribute('#btnAsk', 'aria-pressed') === 'false'
      && (phone || await ev(() => getComputedStyle(document.querySelector('.drawer')).display !== 'none')));
    await page.click('#btnAsk');
    check(`${L}: reopened, the panel has the same conversation`, (await msgs()).length === said && said > 0);
    await page.click('#btnAskClose');
    await page.click('#screen');
    const sent = requests.length;
    await page.keyboard.press('Control+k');
    check(`${L}: Ctrl+K opens "Ask Claude or find a command", focused, and the machine gets no key`, await waitFor(page, () => !document.getElementById('cmdBox').hidden && document.activeElement === document.getElementById('cmdInput')));
    await page.keyboard.type('turbo');
    const listed = await ev(() => [...document.querySelectorAll('#cmdBox [role="option"]')].map((o) => o.textContent));
    check(`${L}: matching commands first, "Ask Claude: …" always last, the first selected`, /Turbo/.test(listed[0]) && /^Ask Claude: "turbo"/.test(listed[listed.length - 1])
      && await ev(() => document.querySelector('#cmdBox [role="option"]').getAttribute('aria-selected') === 'true'), JSON.stringify(listed));
    await shot('cmdbox');
    await page.keyboard.press('Enter');
    check(`${L}: Enter runs the command (Turbo on), closes the box, and nothing is sent to Claude`, await waitFor(page, () => window.emu.session.turbo && document.getElementById('cmdBox').hidden)
      && requests.length === sent && await page.isHidden('#ask'));
    await page.click('#btnTurbo');
    // the Glossary's "Take snapshot": a snapshot file of everything, never sent to Claude
    await page.keyboard.press('Control+k');
    await page.keyboard.type('save my prog');
    const snapList = await ev(() => [...document.querySelectorAll('#cmdBox [role="option"]')].map((o) => o.textContent));
    const [snapFile] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
    check(`${L}: "save my prog" finds Take snapshot first; Enter saves a snapshot file, nothing sent`, /^Take snapshot/.test(snapList[0]) && /\.cloadm$/.test(snapFile.suggestedFilename())
      && requests.length === sent, `${JSON.stringify(snapList)} ${snapFile.suggestedFilename()}`);
    await page.keyboard.press('Control+k');
    await page.keyboard.type('why is the sky blue');
    const only = await ev(() => [...document.querySelectorAll('#cmdBox [role="option"]')].map((o) => o.textContent));
    replies.push({ body: text('Rayleigh scattering.') });
    await page.keyboard.press('Enter');
    check(`${L}: with no command matching, Enter asks Claude in the side panel`, only.length === 1 && /^Ask Claude: "why is the sky blue"/.test(only[0])
      && await waitFor(page, () => !document.getElementById('ask').hidden) && (await idle(), requests.length === sent + 1)
      && requests[sent].messages.slice(-1)[0].content === 'why is the sky blue', JSON.stringify(only));
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Escape');
    check(`${L}: Esc closes the box`, await waitFor(page, () => document.getElementById('cmdBox').hidden));
    // ---- the same conversation in full screen and back ----
    const count = (await msgs()).length;
    await ev(() => { window.__chat = window.emu.session.chat; });
    await page.click('#btnAskFull');
    check(`${L}: Full screen: the chat machine, the same conversation, the switch says Full screen`, await waitFor(page, () => document.body.classList.contains('claude-open')
      && window.emu.session.chatView === 'chat' && window.emu.session.chat === window.__chat && window.emu.session.claudeView === 'full', null, 15000)
      && await page.getAttribute('#btnFullFull', 'aria-pressed') === 'true' && await page.isHidden('#ask'));
    check(`${L}: the chat screen is chat only (the BASIC session's window starts hidden); "Show my BASIC session" is there`, await page.isHidden('#claudePip')
      && await vis('#btnClaudeView') && /Show my BASIC session/.test(await page.textContent('#btnClaudeView')));
    await waitFor(page, () => window.emu.session.chat.channel && window.emu.session.chat.channel.queued === 0, null, 15000);
    await emuFrames(page, 20);
    await shot('full');
    if (!phone) {
      await page.focus('#screen');
      await page.keyboard.press('Control+b');
      check(`${L}: Ctrl+B swaps the big screen to the BASIC session, and back`, await waitFor(page, () => window.emu.session.chatView === 'basic')
        && (await page.keyboard.press('Control+b'), await waitFor(page, () => window.emu.session.chatView === 'chat')));
    }
    await page.click('#btnFullSide');
    check(`${L}: Side panel: back beside the machine, the same conversation, nothing lost`, await waitFor(page, () => !document.getElementById('ask').hidden && window.emu.session.claudeView === 'panel'
      && window.emu.session.chat === window.__chat && !document.body.classList.contains('claude-open'))
      && (await msgs()).length === count, JSON.stringify(await msgs()));
    check(`${L}: no sideways scroll`, await ev(() => document.documentElement.scrollWidth <= innerWidth));
    check(`${L}: no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }
  await askGimeTextChecks(browser, base, check);
}

// Ask Claude on a CoCo 3 in an 80-column GIME text mode with attributes (as NitrOS-9 uses): Claude's screen_text
// (the mocked API asks for it) reads the GIME's rows, attributes decoded, not the old 32-column VDG page. The
// screen is set up through the machine's own bus writes to the GIME ($FF90, $FF98, $FF99, $FF9D, $FF9E) and text
// in physical RAM at $74000 (the CPU's $4000, away from the built-in stub's own page); the expected rows are
// literals. tests/coco3-screen-text.test.js and run.js coco3 --video --text cover every mode.
async function askGimeTextChecks(browser, base, check) {
  const L = 'ask (CoCo 3, 80 columns)';
  const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const msgStart = { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } };
  const text = (t) => sse([msgStart, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]);
  const tool = (name) => sse([msgStart, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_0', name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} }, { type: 'message_stop' }]);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const requests = [], replies = [tool('screen_text'), text('Your directory listing.')];
  await ctx.route('https://api.anthropic.com/**', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    requests.push(JSON.parse(req.postData()));
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: replies.shift() || text('ok') });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('cloadm.anthropicKey', 'sk-ant-GIME-TEXT-CHECK-KEY-0123456789'));
  await page.goto(`${base}?machine=coco3`);
  await started(page);
  await stubPrompt(page);
  await emuFrames(page, 10);   // the stub has set up its own screen after stubPrompt's reset, so it does not undo ours
  // the rows as written: [row, column, bytes, attribute]; $00 and $01 are the GIME's C-cedilla and u-umlaut
  const ROWS = [[0, 0, 'CLOADM 80 COLUMNS - GIME TEXT FOR CLAUDE', 0x08], [1, 0, 'Directory of /DD  2026/11/18', 0x08],
    [2, 4, '\x00a va? \x01ber', 0x48], [23, 70, 'BOTTOM ROW', 0x08]];
  const WANT = ['CLOADM 80 COLUMNS - GIME TEXT FOR CLAUDE', 'Directory of /DD  2026/11/18', '    \u00c7a va? \u00fcber', ...new Array(20).fill(''), ' '.repeat(70) + 'BOTTOM ROW'];
  await page.evaluate((rows) => {
    const m = window.emu.machine, ram = m.gime.ram;
    for (let i = 0; i < 160 * 24; i += 2) { ram[0x74000 + i] = 0x20; ram[0x74001 + i] = 0x08; }
    for (const [r, c, t, a] of rows) for (let i = 0; i < t.length; i++) { ram[0x74000 + r * 160 + (c + i) * 2] = t.charCodeAt(i); ram[0x74001 + r * 160 + (c + i) * 2] = a; }
    for (const [a, v] of [[0xFF90, 0x4E], [0xFF98, 0x03], [0xFF99, 0x15], [0xFF9D, 0xE8], [0xFF9E, 0x00], [0xFF9F, 0x00], [0xFFB0, 0], [0xFFB9, 63]]) m.write(a, v);   // palette: black, white text
  }, ROWS);
  await emuFrames(page, 3);
  if (shotDir) await page.screenshot({ path: path.join(shotDir, 'ask-coco3-80-columns.png') });
  await page.click('#btnAsk');
  await waitFor(page, () => !document.getElementById('ask').hidden && !document.getElementById('askComposer').hidden, null, 5000);
  await page.fill('#askInput', 'What is on my screen?');
  await page.press('#askInput', 'Enter');
  await waitFor(page, () => window.emu.session.chat && !window.emu.session.chat.busy && document.querySelectorAll('#askMessages .msg[data-role="claude"]').length > 0, null, 15000);
  const sent = requests[1] && requests[1].messages.slice(-1)[0];
  const block = sent && Array.isArray(sent.content) && sent.content.find((b) => b.type === 'tool_result');
  let res = null;
  try { res = JSON.parse(typeof block.content === 'string' ? block.content : block.content.map((c) => c.text).join('')); } catch (e) { res = null; }
  check(`${L}: Claude's screen_text reads the GIME's 80-column rows, exactly`, !!res && res.text === true && JSON.stringify(res.lines) === JSON.stringify(WANT),
    JSON.stringify(res || block || sent));
  check(`${L}: the mode, columns, rows and where it was read from`, !!res && res.mode === 'GIME native text, 80 columns with attributes, 24 rows'
    && res.cols === 80 && res.rows === 24 && res.physicalBase === 0x74000 && res.base === 0x4000, JSON.stringify(res && { mode: res.mode, base: res.base, physicalBase: res.physicalBase }));
  check(`${L}: the attribute bytes are decoded into runs (row 2: underlined from column 4), not shown as characters`, !!res && Array.isArray(res.attributes)
    && JSON.stringify(res.attributes[2]) === JSON.stringify([{ from: 0, to: 3, fg: 1, bg: 0, underline: false, blink: false },
      { from: 4, to: 14, fg: 1, bg: 0, underline: true, blink: false }, { from: 15, to: 79, fg: 1, bg: 0, underline: false, blink: false }]),
    JSON.stringify(res && res.attributes && res.attributes[2]));
  check(`${L}: Claude's answer shows in the panel`, /Your directory listing\./.test(await page.textContent('#askMessages')));
  check(`${L}: no page errors`, !errors.length, errors.join('; '));
  await ctx.close();
}

// settings to a file and back into another browser profile; ROMs never go along
// The Claude chat (?app=claude) against a mocked Messages API: the page's real fetch, routed.
// The key card, a chat whose scripted tool calls POKE and type RUN on the BASIC session (allowed with the switch;
// the BASIC session stays live in the picture-in-picture), the restore point back to the state before, the swap,
// the switch off (reading tools still go), a rate-limit error, the key surviving a reload, Forget, and the key
// absent from the machines' memory, their snapshots and the settings export.
// The chat, full screen, on a phone: portrait
// 390x844 and held sideways 844x390, a touch screen. Without a key the key entry is on screen as the page opens,
// the words say where it is, and the machine keyboard doesn't cover it; the screen shows the chat's picture area
// without its border, so a text row (8 frame lines) is at least PHONE_ROW px tall (it was 7.5 and 7.0); nothing
// lies over the text; a line typed on the on-screen keys reaches Claude (mocked) and the reply is drawn.
const PHONE_ROW = 11;
async function phoneChatChecks(browser, base, check) {
  const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const reply = (t) => sse([{ type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  const REPLY = 'Hello from Claude. The Dragon 64 has a Motorola 6809 running at 0.89 MHz.';   // two lines of 42 columns
  // the visible part of the screen (the canvas inside the tube that clips it) has the canvas on top at a 7 x 7 grid
  // of points, and a text row's height in CSS px
  const screenState = (page) => page.evaluate(() => {
    const c = document.getElementById('screen'), t = c.closest('.tube'), cr = c.getBoundingClientRect(), tr = t.getBoundingClientRect();
    const box = { left: Math.max(cr.left, tr.left, 0), top: Math.max(cr.top, tr.top, 0), right: Math.min(cr.right, tr.right, innerWidth), bottom: Math.min(cr.bottom, tr.bottom, innerHeight) };
    const covered = [];
    for (let i = 1; i <= 7; i++) for (let j = 1; j <= 7; j++) {
      const x = box.left + (box.right - box.left) * i / 8, y = box.top + (box.bottom - box.top) * j / 8, el = document.elementFromPoint(x, y);
      if (el !== c) covered.push(`${Math.round(x)},${Math.round(y)}:${el ? el.id || el.className || el.tagName : 'none'}`);
    }
    const f = window.emu.machine.render();
    return { row: 8 * cr.height / f.height, crop: !!f.active && cr.width > tr.width, covered, visibleH: box.bottom - box.top };
  });
  // the chat's picture: which 8-line text rows of the active area have lit pixels (the background is the colour at
  // its bottom right corner, which the reply never reaches)
  const litRows = (page) => page.evaluate(() => {
    const f = window.emu.machine.render(), a = f.active, bg = f.data[(a.y + a.height - 1) * f.width + a.x + a.width - 1], rows = [];
    for (let r = 0; r < a.height / 8; r++) {
      let lit = false;
      for (let y = a.y + r * 8; y < a.y + r * 8 + 8 && !lit; y++) for (let x = a.x; x < a.x + a.width; x++) if (f.data[y * f.width + x] !== bg) { lit = true; break; }
      rows.push(lit);
    }
    return rows.map((l, i) => (l ? i : -1)).filter((i) => i >= 0);
  });
  for (const [label, viewport] of [['portrait', { width: 390, height: 844 }], ['sideways', { width: 844, height: 390 }]]) {
    const ctx = await browser.newContext({ viewport, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [], requests = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await ctx.route('https://api.anthropic.com/**', (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      requests.push(JSON.parse(req.postData()));
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: reply(REPLY) });
    });
    await page.goto(`${base}?machine=dragon64&app=claude`);
    await waitFor(page, () => window.emu && window.emu.session && window.emu.session.claudeView === 'full' && document.body.classList.contains('chat-phone'), null, 20000);
    await emuFrames(page, 5);
    const key = await page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      const inView = (b) => b.height > 0 && b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth;
      const i = r('claudeKeyInput'), s = r('btnClaudeKeySave');
      return { scrollY, input: inView(i), save: inView(s), onTop: document.elementFromPoint(i.left + i.width / 2, i.top + i.height / 2) === document.getElementById('claudeKeyInput'),
        keys: !document.getElementById('touchKeys').hidden, help: document.getElementById('claudeHelp').textContent, appbar: getComputedStyle(document.querySelector('.appbar')).display };
    });
    check(`phone chat (${label}): no key: the key field and Save are on screen as the chat opens, not covered, the machine keyboard stands aside`,
      key.scrollY === 0 && key.input && key.save && key.onTop && !key.keys, JSON.stringify(key));
    if (label === 'portrait') check('phone chat (portrait): no key: the help line says the key goes above (the card comes first), not "on the right"', /add one above/.test(key.help) && !/right/.test(key.help), key.help);
    else {
      // held sideways the card sits beside the screen, so both fit the height (PC-M2: the screen was a screen and a half down)
      const side = await page.evaluate(() => { const s = document.getElementById('screen').closest('.tube').getBoundingClientRect(), c = document.getElementById('claudeKeyCard').getBoundingClientRect();
        return { screen: s.top >= 0 && s.bottom <= innerHeight && s.height > 200, beside: c.left >= s.right }; });
      check('phone chat (sideways): no key: the key card is beside the screen, both on screen, and the help line says "on the right"', side.screen && side.beside && /add one on the right/.test(key.help),
        JSON.stringify({ ...side, help: key.help }));
    }
    check(`phone chat (${label}): the app bar gives way to the chat bar (its "← Emulator" leads back)`, key.appbar === 'none' && await page.isVisible('#btnClaudeBack'));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `phone-chat-${label}-nokey.png`) });
    await page.fill('#claudeKeyInput', 'sk-ant-PHONE-CHECK-0123456789');
    await page.tap('#btnClaudeKeySave');
    check(`phone chat (${label}): with the key saved the machine keyboard is back`, await waitFor(page, () => !document.getElementById('touchKeys').hidden && document.getElementById('claudeKeyCard').hidden));
    check(`phone chat (${label}): and the screen has the focus, so a keyboard types into the chat at once (PC-M3)`, await page.evaluate(() => document.activeElement.id) === 'screen',
      await page.evaluate(() => document.activeElement.id || document.activeElement.tagName));
    await emuFrames(page, 3);
    const s = await screenState(page);
    check(`phone chat (${label}): the screen shows the picture area without its border: a text row is at least ${PHONE_ROW} px tall`, s.crop && s.row >= PHONE_ROW, `${s.row.toFixed(1)} px`);
    check(`phone chat (${label}): nothing lies over the screen's text (7 x 7 points of it are the screen itself)`, !s.covered.length && s.visibleH > 150, JSON.stringify(s.covered));
    // a line on the on-screen keys, the reply on the screen
    await waitFor(page, () => { const c = window.emu.session.chat; return c && !c.busy && c.channel.queued === 0; }, null, 20000);
    for (const k of ['H', 'I', 'ENTER']) { await page.locator(`#touchKeys [data-key="${k}"]:visible`).first().tap(); await emuFrames(page, 4); }
    const answered = await waitFor(page, (r) => { const c = window.emu.session.chat; return c && !c.busy && c.channel.queued === 0 && c.messages.some((m) => m.role === 'assistant' && m.content === r); }, REPLY, 20000);
    check(`phone chat (${label}): a line typed on the on-screen keys reaches Claude (mocked)`, answered && requests.length === 1 && requests[0].messages.slice(-1)[0].content === 'HI',
      JSON.stringify(requests.map((r) => r.messages.slice(-1)[0])));
    await emuFrames(page, 10);
    const rows = await litRows(page);
    // the prompt and HI, "Thinking...", then the reply's two lines: rows 0 to 3 (and the fresh prompt)
    check(`phone chat (${label}): the reply is drawn on the screen, both of its lines`, [0, 1, 2, 3].every((r) => rows.includes(r)), JSON.stringify(rows));
    const after = await screenState(page);
    check(`phone chat (${label}): and nothing lies over it`, !after.covered.length, JSON.stringify(after.covered));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `phone-chat-${label}-reply.png`) });
    // the way out is always there (PC-M1): upright, the chat bar stays at the top when the page scrolls; either way
    // the keyboard's Menu is "← Emulator" and leaves the chat
    if (label === 'portrait') {
      await page.evaluate(() => scrollTo(0, 500));
      check('phone chat (portrait): scrolled down, the chat bar and its "← Emulator" stay at the top', await page.evaluate(() => {
        const b = document.getElementById('btnClaudeBack'), r = b.getBoundingClientRect();
        return scrollY > 0 && r.top >= 0 && r.bottom <= 80 && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b;
      }));
    }
    check(`phone chat (${label}): the on-screen keyboard's Menu says "← Emulator"`, await page.textContent('#tkMenu') === '← Emulator');
    await page.tap('#tkMenu');
    check(`phone chat (${label}): and leaves the chat for the emulator`, await waitFor(page, () => !document.body.classList.contains('claude-open') && !/app=claude/.test(location.search)
      && document.getElementById('tkMenu').textContent === 'Menu'));
    check(`phone chat (${label}): no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }
  // M1: the phone's full-screen chat is not a BASIC machine's screen, so a remembered Joystick mode must not put
  // the stick, FIRE or the switch there. The path that shows it needs no machine event: the full-screen chat on a
  // tablet (chat-phone false), then the window narrowing across the phone breakpoint (chat-phone true) -- the class
  // flips with no session event, so only claude.js's own apply() hides the panel. Fails without that call.
  {
    const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const widths = () => page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect().width;
      return { chat: document.body.classList.contains('chat-phone'), stick: r('touchStick'), fire: r('touchFire'), sw: r('tkModeSwitch'), mode: document.getElementById('touchKeys').dataset.mode };
    });
    await page.goto(`${base}?machine=dragon64`);
    await started(page);
    await page.evaluate(() => { localStorage.setItem('cloadm.anthropicKey', 'sk-ant-M1-CHECK'); window.emu.session.store.set('touchMode.dragon64', 'joystick'); });
    await page.reload();
    await started(page);
    await waitFor(page, () => !document.getElementById('touchKeys').hidden && document.getElementById('touchKeys').dataset.mode === 'joystick');
    // into the full-screen chat at tablet width (not a phone chat yet), then narrow to a phone
    await page.click('#btnAsk');
    await page.click('#btnFullFull');
    await waitFor(page, () => window.emu.session.claudeView === 'full' && document.body.classList.contains('claude-open'));
    const tablet = await widths();
    await page.setViewportSize({ width: 390, height: 844 });
    await waitFor(page, () => document.body.classList.contains('chat-phone'));
    const phoneChat = await widths();
    check('phone chat (joystick mode remembered): narrowing into the phone chat hides the stick, FIRE and the switch',
      tablet.chat === false && tablet.stick > 0 && phoneChat.chat === true && phoneChat.stick === 0 && phoneChat.fire === 0 && phoneChat.sw === 0,
      JSON.stringify({ tablet, phoneChat }));
    // and back out of the phone breakpoint: the tablet layout is not a phone chat, so the machine's stick is back
    await page.setViewportSize({ width: 820, height: 1180 });
    await waitFor(page, () => !document.body.classList.contains('chat-phone'));
    const back = await widths();
    check('phone chat (joystick mode remembered): leaving the phone breakpoint gives the stick back',
      back.stick > 0 && back.fire > 0 && back.sw > 0 && back.mode === 'joystick', JSON.stringify(back));
    check('phone chat (joystick mode remembered): no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }
  // PC-M1: the browser's Back leaves the chat, and so does Esc from the chat bar (on the screen Esc is BREAK)
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const opened = async () => {
      await page.goto(`${base}?machine=dragon64&app=claude`);
      return waitFor(page, () => window.emu && window.emu.started && document.body.classList.contains('chat-phone') && /app=claude/.test(location.search), null, 20000);
    };
    await opened();
    const before = await page.evaluate(() => { window.__samePage = true; return history.length; });
    await page.goBack();
    check('phone chat: the browser\'s Back leaves the chat, on the same page', await waitFor(page, () => !document.body.classList.contains('claude-open') && !/app=claude/.test(location.search)
      && window.__samePage === true), `history ${before}`);
    await opened();
    await page.focus('#btnFullSide');
    await page.keyboard.press('Escape');
    check('phone chat: Esc from the chat bar leaves the chat', await waitFor(page, () => !document.body.classList.contains('claude-open')));
    await ctx.close();
  }
  // PC-M4: a tablet (820 x 1180) stacks the chat under the screen too: without a key the card comes first, on screen
  {
    const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(`${base}?machine=dragon64&app=claude`);
    await waitFor(page, () => window.emu && window.emu.session && window.emu.session.claudeView === 'full', null, 20000);
    await emuFrames(page, 5);
    const tab = await page.evaluate(() => {
      const i = document.getElementById('claudeKeyInput').getBoundingClientRect(), s = document.getElementById('screen').getBoundingClientRect();
      return { input: i.top >= 0 && i.bottom <= innerHeight, above: i.bottom <= s.top, help: document.getElementById('claudeHelp').textContent };
    });
    check('tablet chat (820 x 1180): no key: the key field is on screen, above the screen, and the help line says "above"', tab.input && tab.above && /add one above/.test(tab.help), JSON.stringify(tab));
    await ctx.close();
  }
  // U4: a phone held sideways without the on-screen keyboard (or any window under 500 px high): the app bar is one
  // row, Capture & share and the links behind Menu, and the screen takes the height (it was 181 px under two rows)
  {
    const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(`${base}?machine=dragon64`);
    await waitFor(page, () => window.emu && window.emu.machine, null, 20000);
    await emuFrames(page, 3);
    const bar = await page.evaluate(() => ({ bar: Math.round(document.querySelector('.appbar').getBoundingClientRect().height),
      screen: Math.round(document.getElementById('screen').getBoundingClientRect().height), fits: document.getElementById('screen').getBoundingClientRect().bottom <= innerHeight,
      links: getComputedStyle(document.querySelector('.appbar nav')).display, scrollX: document.documentElement.scrollWidth > innerWidth }));
    await page.click('#btnMenu');
    const open = await page.evaluate(() => ({ links: [...document.querySelectorAll('.appbar nav a')].every((a) => a.getBoundingClientRect().height > 0), share: getComputedStyle(document.getElementById('btnShare')).display !== 'none' }));
    check('sideways, 844 x 390: the app bar is one row and the screen takes the height; the links and Capture & share are behind Menu',
      bar.bar <= 64 && bar.screen >= 220 && bar.fits && bar.links === 'none' && !bar.scrollX && open.links && open.share, JSON.stringify({ ...bar, open }));
    await ctx.close();
  }
  // on a phone the Ctrl K box opened over the app bar's Ask Claude and Menu. It opens under the bar,
  // on screen, and both buttons stay uncovered (the button itself is what is at its centre)
  for (const [label, viewport, touch] of [['390 x 844', { width: 390, height: 844 }, true], ['844 x 390', { width: 844, height: 390 }, false], ['844 x 390, touch', { width: 844, height: 390 }, true]]) {
    const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(`${base}?machine=dragon64`);
    await waitFor(page, () => window.emu && window.emu.machine, null, 20000);
    await emuFrames(page, 3);
    await page.keyboard.press('Control+k');
    const box = await page.evaluate(() => {
      const b = document.getElementById('cmdBox'), r = b.getBoundingClientRect();
      const clear = (id) => { const e = document.getElementById(id), x = e.getBoundingClientRect(); if (!x.height || getComputedStyle(e).display === 'none') return 'not shown';
        const over = !(r.bottom <= x.top || r.top >= x.bottom || r.right <= x.left || r.left >= x.right);
        return !over && document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2) === e ? 'clear' : 'covered'; };
      return { open: !b.hidden, inView: r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth, ask: clear('btnAsk'), menu: clear('btnMenu'), focus: document.activeElement.id };
    });
    check(`Ctrl K box on a phone (${label}): it opens on screen, under the app bar: Ask Claude and Menu are not covered`,
      box.open && box.inView && box.ask !== 'covered' && box.menu !== 'covered' && box.focus === 'cmdInput', JSON.stringify(box));
    await ctx.close();
  }
  // a wide page keeps its layout: the card on the right, the bezel and the whole picture
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(`${base}?machine=dragon64&app=claude`);
    await waitFor(page, () => window.emu && window.emu.session && window.emu.session.claudeView === 'full', null, 20000);
    await emuFrames(page, 3);
    const wide = await page.evaluate(() => ({ phone: document.body.classList.contains('chat-phone'), help: document.getElementById('claudeHelp').textContent,
      crop: document.getElementById('screen').getBoundingClientRect().width > document.querySelector('.tube').getBoundingClientRect().width }));
    check('phone chat: on a wide page none of it applies: the help line says "on the right", the whole picture shows', !wide.phone && /add one on the right/.test(wide.help) && !wide.crop, JSON.stringify(wide));
    await ctx.close();
  }
}

// Every "← Emulator" returns to the emulator, whatever the address and the history under it (the owner's report:
// on /play/?app=claude, the Debugger's "← Emulator" did not leave it). Each view, opened the way a person opens it,
// is closed by its "← Emulator", by Esc and by the browser's Back, from a plain /play/ and from ?app=claude (where the
// full-screen chat is open under the header); then the same after a reload on the view, after a page loaded on the
// view, and for the full-screen chat itself.
async function emulatorBackChecks(browser, base, check) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const VIEWS = [
    ['Debugger', 'debugView', '#btnDbgBack', () => page.click('#navDebugger')],
    ['Library', 'library', '#btnLibBack', () => page.click('#navLibrary')],
    ['Share', 'share', '#shareBack', () => page.click('#btnShare')],
    ['Add ROMs', 'romCard', '#btnRomBack', () => page.click('#romPill')],
  ];
  // the emulator is shown: no view, no full-screen chat, the address neither (a reload would open what is shown)
  const onEmulator = () => waitFor(page, () => location.hash === '' && !/app=claude/.test(location.search)
    && ['debugView', 'library', 'share', 'romCard', 'claude'].every((id) => document.getElementById(id).hidden)
    && !document.body.classList.contains('claude-open') && window.emu.session.claudeView !== 'full'
    && getComputedStyle(document.querySelector('.layout')).display !== 'none' && getComputedStyle(document.getElementById('appbar')).display !== 'none');
  const where = () => page.evaluate(() => JSON.stringify({ url: location.pathname + location.search + location.hash, state: history.state,
    shown: ['debugView', 'library', 'share', 'romCard', 'claude'].filter((id) => !document.getElementById(id).hidden), body: document.body.className }));
  const load = async (query) => {
    await page.goto(`${base}${query}`);
    await started(page);
    if (/app=claude/.test(query)) await waitFor(page, () => window.emu.session.claudeView === 'full' && document.body.classList.contains('claude-open'));
  };
  // the full-screen chat as a person opens it once the welcome is over: Ask Claude, then the panel's full screen
  const openChat = async () => {
    // (the Ask button closes an open panel: after a view opened from the full-screen chat the panel is already open)
    if (await page.evaluate(() => document.getElementById('ask').hidden)) await page.click('#btnAsk');
    await waitFor(page, () => window.emu.session.claudeView === 'full' || !document.getElementById('btnAskFull').hidden);
    if (await page.evaluate(() => window.emu.session.claudeView !== 'full')) await page.click('#btnAskFull');
    return waitFor(page, () => window.emu.session.claudeView === 'full' && document.body.classList.contains('claude-open'));
  };
  const closeBy = {
    '← Emulator': (back) => page.click(back),
    Esc: async () => { await page.evaluate(() => document.activeElement && document.activeElement.blur()); await page.keyboard.press('Escape'); },
    'browser Back': () => page.goBack(),
  };
  for (const query of ['?machine=dragon64', '?machine=dragon64&app=claude', '?app=claude']) {
    // (Add ROMs has no way in from the full-screen chat: its pill is the emulator's, and the chat machine needs no ROM)
    for (const [name, id, back, open] of VIEWS.filter(([name]) => !(/app=claude/.test(query) && name === 'Add ROMs'))) {
      for (const [how, close] of Object.entries(closeBy)) {
        await load(query);
        await open();
        const shown = await waitFor(page, (id) => !document.getElementById(id).hidden, id);
        await close(back);
        check(`emulator back: /play/${query} → ${name} → ${how} shows the emulator`, shown && await onEmulator(), await where());
      }
    }
    // deeper history: the Debugger, closed and opened again, then a reload on it; its "← Emulator", then the
    // browser's Back, never land on the Debugger (or the chat) again
    await load(query);
    await page.click('#navDebugger'); await waitFor(page, () => !document.getElementById('debugView').hidden);
    await page.click('#btnDbgBack'); await onEmulator();
    await page.click('#navDebugger'); await waitFor(page, () => !document.getElementById('debugView').hidden);
    await page.reload(); await started(page);
    const reloaded = await waitFor(page, () => !document.getElementById('debugView').hidden);
    await page.click('#btnDbgBack');
    check(`emulator back: /play/${query} → Debugger → reload → "← Emulator" shows the emulator`, reloaded && await onEmulator(), await where());
  }
  // a page loaded on the view (a link to it), with and without app=claude: its "← Emulator" stays on the page
  for (const query of ['#debugger', '?app=claude#debugger', '#library']) {
    await page.goto(`${base}${query}`); await started(page);
    const shown = await page.evaluate(() => [...document.querySelectorAll('#debugView, #library')].some((v) => !v.hidden) || !document.getElementById('claude').hidden);
    await page.click(await page.evaluate(() => (!document.getElementById('library').hidden ? '#btnLibBack' : !document.getElementById('debugView').hidden ? '#btnDbgBack' : '#btnClaudeBack')));
    check(`emulator back: a page loaded on /play/${query}: "← Emulator" shows the emulator, on the same page`, shown && await onEmulator()
      && await page.evaluate(() => !!window.emu), await where());
  }
  // the full-screen chat's own "← Emulator", Esc and Back, after a reload on it and after a view opened and closed
  for (const [how, close] of Object.entries(closeBy)) {
    await load('?app=claude');
    await page.reload(); await started(page);
    await waitFor(page, () => window.emu.session.claudeView === 'full');
    await close('#btnClaudeBack');
    check(`emulator back: ?app=claude → reload → chat ${how} shows the emulator`, await onEmulator(), await where());
    await openChat();
    await page.click('#navDebugger'); await waitFor(page, () => !document.getElementById('debugView').hidden);
    await page.click('#btnDbgBack'); await onEmulator();
    await openChat();
    await close('#btnClaudeBack');
    check(`emulator back: chat → Debugger → "← Emulator" → chat again → ${how} shows the emulator`, await onEmulator(), await where());
  }
  // R2: a view opened from the full-screen chat moves the conversation to the side panel, closed while the view is up;
  // coming back to the emulator, by "← Emulator", Esc or Back, reopens the Ask panel on the same conversation. A view
  // opened from the plain emulator leaves the panel closed. Wide (the app bar's links open the views) and narrow (under
  // 700 px the full-screen chat hides the app bar, so Ctrl K is the way to a view; Add ROMs has none there).
  const MARK = 'R2-MARK-conversation';
  const panelState = (mark) => page.evaluate((mark) => {
    const s = window.emu.session, ask = document.getElementById('ask');
    return { open: !ask.hidden && document.body.classList.contains('ask-open'), view: s.claudeView, same: s.chat === window.__r2chat,
      shows: document.getElementById('askMessages').textContent.includes(mark), url: location.pathname + location.search + location.hash };
  }, mark);
  const panelBack = (mark) => waitFor(page, (mark) => { const s = window.emu.session, ask = document.getElementById('ask');
    return !ask.hidden && document.body.classList.contains('ask-open') && s.claudeView === 'panel' && s.chat === window.__r2chat
      && document.getElementById('askMessages').textContent.includes(mark); }, mark);
  const tag = () => page.evaluate((mark) => { const s = window.emu.session; window.__r2chat = s.chat; s.chat.messages.push({ role: 'user', content: mark }); s.emit('chat'); }, MARK);
  // a view by Ctrl K, as a person on a narrow window does
  const byCtrlK = async (words) => {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('Control+k');
    await page.fill('#cmdInput', words);
    await page.keyboard.press('Enter');
  };
  for (const [label, viewport] of [['wide', { width: 1440, height: 900 }], ['narrow', { width: 600, height: 900 }]]) {
    await page.setViewportSize(viewport);
    for (const [name, id, back, open, words] of [
      ['Debugger', 'debugView', '#btnDbgBack', () => page.click('#navDebugger'), 'Open the Debugger'],
      ['Library', 'library', '#btnLibBack', () => page.click('#navLibrary'), 'Open the Library'],
      ['Share', 'share', '#shareBack', () => page.click('#btnShare'), 'Share']]) {
      for (const [how, close] of Object.entries(closeBy)) {
        await load('?machine=dragon64&app=claude');
        const phone = await page.evaluate(() => ({ phone: document.body.classList.contains('chat-phone'), bar: getComputedStyle(document.getElementById('appbar')).display }));
        if (label === 'narrow' && how === '← Emulator' && name === 'Debugger') check('emulator back (narrow): at 600 px the full-screen chat is the phone layout with the app bar hidden', phone.phone && phone.bar === 'none', JSON.stringify(phone));
        await tag();
        await (label === 'narrow' ? byCtrlK(words) : open());
        const shown = await waitFor(page, (id) => !document.getElementById(id).hidden, id);
        const during = await panelState(MARK);
        await close(back);
        const reopened = await onEmulator() && await panelBack(MARK);
        if (shotDir && how === '← Emulator' && name === 'Debugger') await page.screenshot({ path: path.join(shotDir, `emulator-back-panel-${label}.png`) });
        check(`emulator back (${label}): chat → ${name} (${label === 'narrow' ? 'Ctrl K' : 'app bar'}) → ${how}: the Ask panel reopens on the same conversation`,
          shown && !during.open && reopened, JSON.stringify({ during, after: await panelState(MARK) }));
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [name, id, back, open] of VIEWS) {
    for (const [how, close] of Object.entries(closeBy)) {
      await load('?machine=dragon64');
      // a conversation exists (the panel opened, then closed with its ✕), so only the rule keeps the panel closed
      await page.click('#btnAsk');
      await waitFor(page, () => window.emu.session.chat && (window.emu.session.claudeView === 'full' || !document.getElementById('ask').hidden));
      if (await page.evaluate(() => window.emu.session.claudeView === 'full')) await page.click('#btnFullSide');   // the welcome menu opens it full screen
      await waitFor(page, () => !document.getElementById('ask').hidden && window.emu.session.claudeView !== 'full');
      await tag();
      await page.click('#btnAskClose');
      await waitFor(page, () => document.getElementById('ask').hidden);
      await open();
      const shown = await waitFor(page, (id) => !document.getElementById(id).hidden, id);
      await close(back);
      const gone = await onEmulator();
      await ticks(page, 10);   // the frames in which the panel would (wrongly) reopen
      const after = await panelState(MARK);
      check(`emulator back: plain emulator, conversation kept → ${name} → ${how}: the Ask panel stays closed`, shown && gone && !after.open && after.same, JSON.stringify(after));
    }
  }
  check('emulator back: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

// R7: the controls under the screen stay put on a first visit. #screenNotes is one line of fixed height with one note
// in it at a time ("click for sound", then the key hint, then nothing), and the monitor leaves room for it, so Reset is
// inside the window and does not move when a note comes or goes (sound starts, the key hint finishes, the boot help
// shows and hides).
async function foldChecks(browser, base, check) {
  const NOTE_TEXT = { sound: 'No ROMs needed · click anywhere for sound', keys: 'Esc = BREAK · Home = CLEAR · Backspace = ←' };
  const probe = (page) => page.evaluate(() => {
    const vis = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden'; };
    const notes = document.getElementById('screenNotes'), r = document.getElementById('btnReset').getBoundingClientRect(), n = notes.getBoundingClientRect(), s = getComputedStyle(notes);
    return { resetY: r.y, resetBottom: r.bottom, vh: innerHeight, notesH: n.height, notesY: n.y, notesShown: s.display !== 'none' && s.visibility !== 'hidden' && n.height > 0,
      sound: vis('soundHint'), keys: vis('keyHint'), text: [...notes.children].filter((c) => vis(c.id)).map((c) => c.textContent.trim()), boot: vis('bootHelp'),
      monitorBottom: document.getElementById('monitor').getBoundingClientRect().bottom };
  });
  const run = async (label, viewport, query) => {
    const L = `fold (${label})`;
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}${query}`); await started(page);
    await waitFor(page, () => !document.getElementById('soundHint').hidden);
    const at = {};
    at.load = await probe(page);
    check(`${L}: first visit: Reset is inside the window (bottom ≤ innerHeight)`, at.load.resetBottom <= at.load.vh, JSON.stringify(at.load));
    check(`${L}: first visit, before sound: one note under the screen, the sound note`, at.load.notesShown && at.load.text.length === 1 && at.load.text[0] === NOTE_TEXT.sound, JSON.stringify(at.load));
    // the boot help shows (the key hint, if it were up, yields to it) and hides again
    const bootToggle = async (on) => { await page.evaluate((on) => { document.getElementById('bootHelp').hidden = !on; }, on); await emuFrames(page, 2); };
    await bootToggle(true); at.bootOn1 = await probe(page); await bootToggle(false); at.bootOff1 = await probe(page);
    // sound unlocks on the first click anywhere
    await page.mouse.click(5, 5);
    await waitFor(page, () => document.getElementById('soundHint').hidden, null, 5000);
    await emuFrames(page, 2);
    at.sound = await probe(page);
    check(`${L}: sound started: the key hint takes the line (one note, the sound note is gone)`, at.sound.notesShown && at.sound.text.length === 1 && at.sound.text[0] === NOTE_TEXT.keys, JSON.stringify(at.sound));
    await bootToggle(true); at.bootOn2 = await probe(page);
    check(`${L}: the boot help showing takes the key hint's place (the line stays, empty)`, at.bootOn2.boot && at.bootOn2.notesShown && at.bootOn2.text.length === 0, JSON.stringify(at.bootOn2));
    await bootToggle(false); at.bootOff2 = await probe(page);
    await waitFor(page, () => !document.getElementById('keyHint').hidden);
    at.keys = await probe(page);
    // the key hint finishes (Esc on the screen ends it for good)
    await page.focus('#screen'); await page.keyboard.press('Escape');
    await waitFor(page, () => document.getElementById('keyHint').hidden);
    await emuFrames(page, 2);
    at.done = await probe(page);
    check(`${L}: the hints done: an empty line that keeps its height (still laid out, nothing in it)`, at.done.notesShown && at.done.text.length === 0 && at.done.notesH === at.load.notesH, JSON.stringify(at.done));
    const ys = Object.entries(at).map(([k, v]) => [k, v.resetY]), heights = new Set(Object.values(at).map((v) => v.notesH)), tops = new Set(Object.values(at).map((v) => v.notesY));
    check(`${L}: Reset's y is identical (0 px) across load, sound starting, the key hint, the boot help showing and hiding, and the hint finishing`,
      new Set(ys.map(([, y]) => y)).size === 1 && heights.size === 1 && tops.size === 1, JSON.stringify(ys));
    check(`${L}: Reset's bottom edge stays inside the window throughout`, Object.values(at).every((v) => v.resetBottom <= v.vh), JSON.stringify(Object.values(at).map((v) => v.resetBottom)));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `fold-${label}.png`) });
    // a returning visit (the key hint is done): the sound note still appears, and nothing moves
    await page.goto(`${base}${query}`); await started(page);
    await waitFor(page, () => !document.getElementById('soundHint').hidden);
    const r0 = await probe(page);
    await page.mouse.click(5, 5);
    await waitFor(page, () => document.getElementById('soundHint').hidden, null, 5000);
    await emuFrames(page, 2);
    const r1 = await probe(page);
    check(`${L}: a returning visit: the sound note appears, then the empty line; Reset does not move and stays inside the window`,
      r0.sound && r0.text.length === 1 && r0.text[0] === NOTE_TEXT.sound && r1.text.length === 0 && r1.notesShown && r0.resetY === r1.resetY && r0.resetBottom <= r0.vh, JSON.stringify({ r0, r1 }));
    check(`${L}: no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  };
  for (const [w, h] of [[1280, 720], [1366, 768], [1440, 900]]) await run(`${w}x${h}`, { width: w, height: h }, '');
  // any model: the same on each family at one size
  for (const id of ['dragon32', 'coco2', 'coco3', 'mc10']) await run(`1366x768 ${id}`, { width: 1366, height: 768 }, `?machine=${id}`);
}

// R7b: every note under the screen is shown whole. The notes line is one line (44 px) when its container is at least
// 360 px wide, otherwise a fixed two-line box (64 px); in both, nothing is cut off, nothing leaves the box, and Reset
// stays where it is for both notes. A touch screen has no notes line at all.
async function noteFitChecks(browser, base, check) {
  const probe = (page) => page.evaluate(() => {
    const vis = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && getComputedStyle(e).display !== 'none'; };
    const box = document.getElementById('screenNotes'), bb = box.getBoundingClientRect();
    const el = [...box.children].find((c) => vis(c.id));
    if (!el) return { none: true };
    const cs = getComputedStyle(el), pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom), r = el.getBoundingClientRect();
    return { id: el.id, text: el.textContent.trim(), sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight, lines: (el.clientHeight - pad) / 20,
      bottom: r.bottom, boxBottom: bb.bottom, boxW: box.clientWidth, resetY: document.getElementById('btnReset').getBoundingClientRect().y };
  });
  for (const [w, h] of [[1280, 720], [1366, 657], [1440, 900], [600, 800], [390, 844], [320, 568]]) {
    const L = `note fit (${w}x${h})`;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base); await started(page);
    await waitFor(page, () => !document.getElementById('soundHint').hidden);
    const a = await probe(page);
    await page.mouse.click(5, 5);
    await waitFor(page, () => document.getElementById('soundHint').hidden && !document.getElementById('keyHint').hidden, null, 8000);
    await emuFrames(page, 2);
    const b = await probe(page);
    for (const n of [a, b]) {
      const max = n.boxW >= 360 ? 1 : 2;
      check(`${L}: the ${n.id} is shown whole (no clipping, inside the notes box, at most ${max} line${max > 1 ? 's' : ''})`,
        !n.none && n.sw <= n.cw && n.sh <= n.ch && n.bottom <= n.boxBottom && n.lines <= max, JSON.stringify(n));
    }
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `note-fit-${w}x${h}.png`) });
    check(`${L}: Reset's y is the same for both notes`, a.resetY === b.resetY, `${a.resetY} vs ${b.resetY}`);
    check(`${L}: no page errors`, !errors.length, errors.join('; '));
    await ctx.close();
  }
  // the chat's focus pill fits on its line at the desktop sizes
  for (const [w, h] of [[1280, 720], [1366, 657], [1440, 900]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
    await ctx.addInitScript(() => { try { localStorage.setItem('cloadm.anthropicKey', 'sk-ant-FIT-CHECK-KEY-0123456789'); } catch (e) { /* none */ } });
    const page = await ctx.newPage();
    await page.goto(`${base}?machine=dragon64&app=claude`); await started(page);
    await waitFor(page, () => window.emu.session.claudeView === 'full' && document.body.classList.contains('chat-screen'), null, 15000);
    await page.focus('#screen');
    const p = await page.evaluate(() => { const e = document.getElementById('focusHint'); return { shown: getComputedStyle(e).display !== 'none', sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight }; });
    check(`note fit (${w}x${h}): the chat focus pill fits whole`, p.shown && p.sw <= p.cw && p.sh <= p.ch && p.ch <= 28, JSON.stringify(p));
    await ctx.close();
  }
  // a touch screen: no notes line
  const tctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  const tpage = await tctx.newPage();
  await tpage.goto(base); await started(tpage);
  await emuFrames(tpage, 3);
  const th = await tpage.evaluate(() => ({ display: getComputedStyle(document.getElementById('screenNotes')).display, h: document.getElementById('screenNotes').getBoundingClientRect().height }));
  check('note fit (390x844 touch): #screenNotes is hidden', th.display === 'none' && th.h === 0, JSON.stringify(th));
  await tctx.close();
}

// R6: Esc in the full-screen chat escalates. On the chat screen it is BREAK while a reply streams (it stops the reply)
// or while a line is typed (the firmware drops it); on an empty, idle prompt it leaves the chat as "← Emulator" does.
// The API is mocked (page.route); a reply is "streaming" while the route holds the request open.
async function escChatChecks(browser, base, check) {
  const KEY = 'sk-ant-ESC-CHECK-KEY-0123456789';
  const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const msgStart = { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } };
  const text = (t) => sse([msgStart, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript((k) => { try { localStorage.setItem('cloadm.anthropicKey', k); } catch (e) { /* none */ } }, KEY);
  const page = await ctx.newPage();
  const errors = [], requests = [];
  let release = null;
  page.on('pageerror', (e) => errors.push(e.message));
  await ctx.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    requests.push(JSON.parse(req.postData()));
    await new Promise((res) => { release = res; });            // the reply is still on its way until the page stops it (or the test lets it go)
    try { await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: text('A long answer.') }); } catch (e) { /* the page stopped the request */ }
  });
  const L = 'chat Esc';
  const where = () => page.evaluate(() => ({ full: window.emu.session.claudeView === 'full', open: document.body.classList.contains('claude-open'), url: location.pathname + location.search + location.hash,
    focus: document.activeElement && (document.activeElement.id || document.activeElement.tagName), busy: !!(window.emu.session.chat && window.emu.session.chat.busy),
    blen: window.emu.session.chatMachines ? window.emu.session.readByte(0x6013, window.emu.session.chatMachines.chat) : null }));
  const idle = () => waitFor(page, () => window.emu.session.chatPromptEmpty === true, null, 15000);
  const left = () => waitFor(page, () => window.emu.session.claudeView !== 'full' && document.getElementById('claude').hidden && !/app=claude/.test(location.search), null, 5000);
  const openChat = async () => {
    if (await page.evaluate(() => document.getElementById('ask').hidden)) await page.click('#btnAsk');
    await waitFor(page, () => window.emu.session.claudeView === 'full' || !document.getElementById('btnAskFull').hidden);
    if (await page.evaluate(() => window.emu.session.claudeView !== 'full')) await page.click('#btnAskFull');
    await waitFor(page, () => window.emu.session.claudeView === 'full' && document.body.classList.contains('claude-open'));
    await idle(); await emuFrames(page, 3);
  };
  await page.goto(`${base}?machine=dragon64&app=claude`); await started(page);
  await idle(); await emuFrames(page, 3);
  let w = await where();
  check(`${L}: the chat opens with the focus on the screen`, w.full && w.focus === 'screen', JSON.stringify(w));
  // the focus pill says what Esc does here, and the emulator's pill is back once the chat is left
  const pill = () => page.evaluate(() => { const h = document.getElementById('focusHint'); return { shown: getComputedStyle(h).display !== 'none', text: h.innerText.replace(/\s+/g, ' ').trim() }; });
  const p1 = await pill();
  check(`${L}: the focus pill in the chat reads "Esc stops a reply, clears the line, then leaves the chat"`, p1.shown && p1.text === 'Esc stops a reply, clears the line, then leaves the chat', JSON.stringify(p1));
  if (shotDir) await page.screenshot({ path: path.join(shotDir, 'chat-esc-pill.png') });

  // 1. an idle, empty prompt: Esc leaves, exactly as "← Emulator" does (the emulator's address, the focus on the screen)
  await page.keyboard.press('Escape');
  check(`${L}: an idle, empty prompt: Esc leaves the chat for the emulator (no app=claude, focus on the screen)`, await left() && (await where()).focus === 'screen', JSON.stringify(await where()));
  const p2 = await pill();
  check(`${L}: back on the emulator the focus pill is the emulator's`, /^Typing goes to the machine · Tab leaves the screen$/.test(p2.text), JSON.stringify(p2));

  // 2. a typed line: the first Esc drops it (BREAK) and the chat stays; the second leaves
  await openChat();
  await page.focus('#screen'); await page.keyboard.type('half a thought'); await emuFrames(page, 3);
  w = await where();
  check(`${L}: a typed line is in the firmware's buffer (BLEN = 14)`, w.blen === 14 && w.full, JSON.stringify(w));
  await page.keyboard.press('Escape'); await emuFrames(page, 3);
  w = await where();
  check(`${L}: a typed line: the first Esc clears it and stays in the chat`, w.full && w.open && w.blen === 0 && /app=claude/.test(w.url), JSON.stringify(w));
  await page.keyboard.press('Escape');
  check(`${L}: a typed line: the second Esc (empty prompt) leaves`, await left(), JSON.stringify(await where()));

  // 3. a streaming reply: Esc stops it and stays; the second leaves
  await openChat();
  await page.focus('#screen'); await page.keyboard.type('tell me a story'); await page.keyboard.press('Enter');
  const streaming = await waitFor(page, () => window.emu.session.chat.busy && window.emu.session.chatView === 'chat', null, 10000);
  await waitFor(page, () => true); await emuFrames(page, 3);
  check(`${L}: a reply is streaming (the request is held open by the mock)`, streaming && requests.length >= 1, JSON.stringify(await where()));
  await page.keyboard.press('Escape');
  const stopped = await waitFor(page, () => !window.emu.session.chat.busy, null, 5000);
  w = await where();
  check(`${L}: streaming reply: Esc aborts it and stays in the chat`, stopped && w.full && w.open && /app=claude/.test(w.url), JSON.stringify(w));
  if (release) release();
  await idle(); await emuFrames(page, 2);
  check(`${L}: the prompt is idle and empty again after the stop`, await page.evaluate(() => window.emu.session.chatPromptEmpty === true));
  await page.keyboard.press('Escape');
  check(`${L}: streaming reply: the second Esc leaves`, await left(), JSON.stringify(await where()));

  // 4. the keys reach the machine the way they did: Esc is still BREAK for the BASIC session on the emulator
  await page.focus('#screen');
  await page.evaluate(() => { const m = window.emu.machine, push = m.stubKeys.push.bind(m.stubKeys); window.__reached = []; m.stubKeys.push = (...v) => { window.__reached.push(...v); return push(...v); }; });
  await page.keyboard.press('Escape');
  check(`${L}: on the emulator, Esc on the screen is still the machine's BREAK`, await waitFor(page, () => window.__reached.length > 0));
  check(`${L}: no page errors`, !errors.length, errors.join('; '));
  await ctx.close();
}

// The browser's Back from a view is the same as "← Emulator" and Esc: the focus lands on the screen (also when the Ask
// panel reopens over a conversation, which stays visible), and the emulator's address never keeps app=claude, also after
// a reload while a view was open. Opening the full-screen chat from a view that fails (the firmware does not load) keeps
// the Ask panel to reopen when that view closes.
async function backFocusChecks(browser, base, check) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const VIEWS = [['Debugger', 'debugView', '#btnDbgBack', '#navDebugger'], ['Library', 'library', '#btnLibBack', '#navLibrary'], ['Share', 'share', '#shareBack', '#btnShare']];
  const focusId = () => page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName));
  const onEmulator = () => waitFor(page, () => location.hash === '' && !/app=claude/.test(location.search) && ['debugView', 'library', 'share', 'romCard', 'claude'].every((id) => document.getElementById(id).hidden)
    && window.emu.session.claudeView !== 'full', null, 5000);
  const MARK = 'D2-MARK-conversation';
  const load = async (query) => { await page.goto(`${base}${query}`); await started(page); };
  // the full-screen chat as a person opens it from the emulator: Ctrl K, "Chat with Claude, full screen"
  const openChat = async () => {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('Control+k'); await page.fill('#cmdInput', 'Chat with Claude, full screen'); await page.keyboard.press('Enter');
    await waitFor(page, () => window.emu.session.claudeView === 'full' && document.body.classList.contains('claude-open'));
  };
  const tag = () => page.evaluate((mark) => { const s = window.emu.session; window.__d2chat = s.chat; s.chat.messages.push({ role: 'user', content: mark }); s.emit('chat'); }, MARK);
  const closeBy = {
    '← Emulator': (back) => page.click(back),
    Esc: async () => { await page.evaluate(() => document.activeElement && document.activeElement.blur()); await page.keyboard.press('Escape'); },
    'browser Back': () => page.goBack(),
  };
  // D2: focus after the view closes, from the plain emulator and from the full-screen chat (the Ask panel reopens)
  for (const [name, id, back, open] of VIEWS) {
    for (const [how, close] of Object.entries(closeBy)) {
      await load('?machine=dragon64');
      await page.click(open); await waitFor(page, (id) => !document.getElementById(id).hidden, id);
      await close(back);
      check(`back focus: emulator → ${name} → ${how}: the focus is on the screen`, await onEmulator() && await waitFor(page, () => document.activeElement.id === 'screen'), await focusId());
      await load('?machine=dragon64');
      await openChat(); await tag();
      await page.click(open); await waitFor(page, (id) => !document.getElementById(id).hidden, id);
      await close(back);
      const shown = await onEmulator() && await waitFor(page, (mark) => { const a = document.getElementById('ask'); return !a.hidden && document.body.classList.contains('ask-open') && window.emu.session.chat === window.__d2chat
        && document.getElementById('askMessages').textContent.includes(mark); }, MARK);
      check(`back focus: full-screen chat → ${name} → ${how}: the Ask panel reopens on the conversation and the screen keeps the focus`, shown && await waitFor(page, () => document.activeElement.id === 'screen'), await focusId());
    }
  }
  // D3: a reload while a view is open (the full-screen chat under it), then Back: the emulator's address has no app=claude
  for (const [name, id, back, open] of VIEWS) {
    for (const query of ['?machine=dragon64', '?machine=dragon64&app=claude']) {
      await load(query);
      if (!/app=claude/.test(query)) await openChat();
      await page.click(open); await waitFor(page, (id) => !document.getElementById(id).hidden, id);
      await page.reload(); await started(page);
      const reloaded = await waitFor(page, (id) => !document.getElementById(id).hidden, id);
      await page.goBack();
      const w = await page.evaluate(() => ({ url: location.pathname + location.search + location.hash, claude: window.emu && window.emu.session.claudeView }));
      check(`back address: ${query} → chat → ${name} → reload → Back: the address has no app=claude`, reloaded && await waitFor(page, () => !/app=claude/.test(location.search) && location.hash === ''), JSON.stringify(w));
    }
  }
  // D1: from a view, the full-screen chat fails to open (the firmware does not load): the view's close still reopens the panel
  await load('?machine=dragon64');
  await openChat(); await tag();
  await page.click('#navDebugger'); await waitFor(page, () => !document.getElementById('debugView').hidden);
  await ctx.route('**/examples/chat.bin', (route) => route.abort('failed'));
  await page.keyboard.press('Control+k'); await page.fill('#cmdInput', 'Chat with Claude, full screen'); await page.keyboard.press('Enter');
  const failed = await waitFor(page, () => /Chat:/.test(document.getElementById('toast').textContent) && document.getElementById('toast').classList.contains('error'), null, 8000);
  await ctx.unroute('**/examples/chat.bin');
  check('back focus: opening the full-screen chat from a view fails (the firmware did not load): the view stays open', failed && await page.evaluate(() => !document.getElementById('debugView').hidden));
  await page.click('#btnDbgBack');
  check('back focus: …and closing the view still reopens the Ask panel on the conversation (the pending reopen was kept)', await onEmulator() && await waitFor(page, (mark) => { const a = document.getElementById('ask'); return !a.hidden
    && window.emu.session.claudeView === 'panel' && document.getElementById('askMessages').textContent.includes(mark); }, MARK), await focusId());
  check('back focus: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

async function claudeChecks(browser, base, check) {
  // the system prompt goes as text blocks (the last one carries the cache breakpoint): their text
  const sysText = (body) => (Array.isArray(body.system) ? body.system.map((b) => b.text).join('') : '');
  const ctx = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const KEY = 'sk-ant-BROWSER-CHECK-KEY-0123456789';
  const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const msgStart = { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [] } };
  const text = (t) => sse([msgStart, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]);
  const tools = (uses) => sse([msgStart, ...uses.flatMap((u, i) => [
    { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_${i}`, name: u.name, input: {} } },
    { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(u.input) } },
    { type: 'content_block_stop', index: i }]), { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} }, { type: 'message_stop' }]);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  const requests = [], replies = [];
  await ctx.route('https://api.anthropic.com/**', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    requests.push({ headers: req.headers(), body: JSON.parse(req.postData()) });
    const r = replies.shift() || { body: text('ok') };
    return route.fulfill({ status: r.status || 200, headers: { ...cors, 'content-type': r.status ? 'application/json' : 'text/event-stream' }, body: r.body });
  });
  // a line, typed once the last turn has fully reached the screen (the firmware takes no typing before that)
  const say = async (line, want) => {
    await waitFor(page, () => { const c = window.emu.session.chat; return c && !c.busy && c.channel.queued === 0 && window.emu.session.chatView === 'chat'; }, null, 20000);
    await emuFrames(page, 3);
    await page.focus('#screen');
    await page.keyboard.type(line);
    await page.keyboard.press('Enter');
    return waitFor(page, ([want]) => window.emu.session.chat && !window.emu.session.chat.busy && window.emu.__requests >= want, [want], 20000);
  };
  // the page counts its requests through the chat (the route above sees the same ones)
  const counted = () => page.evaluate(() => {
    const b = window.emu.session.chat.backend, f = b.fetch;
    window.emu.__requests = 0;
    b.fetch = (...a) => { window.emu.__requests++; return f(...a); };
  });

  await page.goto(`${base}?app=claude`);
  await started(page);
  check('claude: ?app=claude opens the chat beside the screen, the drawer gives way', await page.evaluate(() => document.body.classList.contains('claude-open')
    && !document.getElementById('claude').hidden && getComputedStyle(document.querySelector('.drawer')).display === 'none' && window.emu.session.chatView === 'chat'));
  check('claude: the chat machine runs the chat firmware with no ROM', await waitFor(page, () => { const m = window.emu.machine; return !m.hasRom && m.cpu.pc >= 0x6000 && m.cpu.pc < 0x7000; }));
  check('claude: the BASIC session is kept alongside, the same model', await page.evaluate(() => { const c = window.emu.session.chatMachines; return c.basic !== c.chat && c.basic.id === c.chat.id; }));
  check('claude: no key yet: the key form shows and the help line says so', await page.evaluate(() => !document.getElementById('claudeKeyCard').hidden
    && document.getElementById('claudeKeySaved').hidden && /No API key yet/.test(document.getElementById('claudeHelp').textContent)));
  await counted();
  await say('hello', 0);
  check('claude: a line sent without a key is refused on the page, with no request', await waitFor(page, () => window.emu.session.chat.error && window.emu.session.chat.error.code === 'no-key')
    && requests.length === 0);
  await page.fill('#claudeKeyInput', 'not-a-key');
  await page.click('#btnClaudeKeySave');
  check('claude: a value that is not an Anthropic key is refused', /sk-ant-/.test(await page.textContent('#claudeKeyMsg')) && await page.evaluate(() => !localStorage.getItem('cloadm.anthropicKey')));
  await page.fill('#claudeKeyInput', KEY);
  await page.click('#btnClaudeKeySave');
  check('claude: Save key keeps it in this browser only, as cloadm.anthropicKey, empties the field, and says "Saved in this browser."', await page.evaluate((k) => localStorage.getItem('cloadm.anthropicKey') === k
    && document.getElementById('claudeKeyInput').value === '' && document.getElementById('claudeKeyCard').hidden && !document.getElementById('claudeKeySaved').hidden
    && document.getElementById('claudeKeyTag').textContent === 'Saved in this browser.', KEY));
  if (shotDir) await page.screenshot({ path: path.join(shotDir, 'claude-ready.png') });

  // a scripted turn: Claude POKEs and types RUN on the BASIC session, then answers (the switch allows it first)
  check('claude: "Let Claude use the emulator" starts off', !(await page.isChecked('#chkClaudeTools')));
  await page.check('#chkClaudeTools');
  replies.push({ body: tools([{ name: 'poke', input: { address: 0x3000, bytes: [1, 2, 3] } }, { name: 'type_text', input: { text: 'RUN\n' } }]) }, { body: text('Done: it ran.') });
  await say('Poke it, then run it.', 2);
  const r0 = requests[0] || { headers: {}, body: {} };
  // how many machine tools the page offers, read from the page itself rather than written out here: adding a
  // tool (as disassemble did) then does not need this file edited as well
  const TOOL_COUNT = await page.evaluate(() => window.emu.Emu.machineTools().length);
  check('claude: the typed line reaches the API as typed (lowercase kept)', r0.body.messages && r0.body.messages.slice(-1)[0].content === 'Poke it, then run it.', JSON.stringify(r0.body.messages));
  check('claude: the request carries the key, the version and the browser-access header', r0.headers['x-api-key'] === KEY && !!r0.headers['anthropic-version']
    && r0.headers['anthropic-dangerous-direct-browser-access'] === 'true');
  check('claude: the brief and the machine tools go with it', /CLOADM/.test(sysText(r0.body)) && /Dragon 64/.test(sysText(r0.body)) && r0.body.tools.length === TOOL_COUNT);
  check('claude: the tool results go back in the second request', requests.length === 2 && requests[1].body.messages.slice(-1)[0].content.length === 2);
  check('claude: poke wrote the BASIC session; the chat stays on screen, the BASIC session live in the picture-in-picture', await page.evaluate(() => { const s = window.emu.session, b = s.chatMachines.basic;
    return b.ram[0x3000] === 1 && b.ram[0x3001] === 2 && b.ram[0x3002] === 3 && s.chatView === 'chat' && s.machine === s.chatMachines.chat
      && !document.getElementById('claudePip').hidden; }));
  check('claude: the BASIC session card offers "Restore to before Claude\'s changes"', await page.evaluate(() => !document.getElementById('claudeRestore').hidden
    && /Restore point · .*before Claude's changes/.test(document.getElementById('claudeRestoreWhen').textContent)));
  check('claude: the BASIC session card says the points are kept in memory only', await page.evaluate(() => /kept only while this chat is open: reloading the page, ending the chat or switching machine loses them/
    .test(document.getElementById('claudePointNote').textContent)) && await page.isVisible('#claudePointNote'));
  // compared in the same task as the click: the BASIC session runs on from the restored state
  check('claude: Restore puts the BASIC session back exactly to the restore point', await page.evaluate(() => {
    const s = window.emu.session, want = window.emu.Emu.state.toJSON(s.chat.undo[s.chat.undo.length - 1]);
    document.getElementById('btnClaudeUndo').click();
    return window.emu.Emu.state.toJSON(s.chatMachines.basic.snapshot()) === want && s.machine === s.chatMachines.chat;
  }) && await page.isHidden('#claudeRestore'));
  await page.click('#btnClaudeView');
  check('claude: "Show my BASIC session" swaps the big screen to it', await waitFor(page, () => window.emu.session.chatView === 'basic'
    && document.getElementById('btnClaudeView').textContent === 'Back to the chat'));
  check('claude: in the BASIC-session view the corner label is "The chat · live" and only the button says "Back to the chat"', await page.evaluate(() =>
    document.getElementById('claudePipLabel').textContent === 'The chat · live' && document.getElementById('btnClaudeView').textContent === 'Back to the chat'));
  await page.click('#btnClaudeView');
  check('claude: "Back to the chat" shows the chat, and the reply reaches its firmware', await waitFor(page, () => window.emu.session.chatView === 'chat'
    && window.emu.session.chat.channel.queued === 0, null, 20000));
  await emuFrames(page, 30);
  if (shotDir) await page.screenshot({ path: path.join(shotDir, 'claude-chat.png') });

  // the switch off (reading still works, acting would ask); then a rate limit, said once, not retried
  await page.uncheck('#chkClaudeTools');
  replies.push({ body: text('Only reading now.') });
  await say('can you still read?', 3);
  check('claude: with "Let Claude use the emulator" off the tools still go (reading always works; acting asks first)', requests.length === 3 && requests[2].body.tools.length === TOOL_COUNT
    && await page.evaluate(() => !window.emu.session.claudeAllowed));
  replies.push({ status: 429, body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }) });
  await say('again', 4);
  check('claude: a rate limit is said in the help line and not retried', await waitFor(page, () => /rate limited/.test(document.getElementById('claudeHelp').textContent)) && requests.length === 4);
  check('claude: the key is in neither machine, nor their snapshots', await page.evaluate((k) => {
    const c = window.emu.session.chatMachines, has = (m) => new TextDecoder('latin1').decode(m.ram).includes(k) || window.emu.Emu.state.toJSON(m.snapshot()).includes(k);
    return !has(c.chat) && !has(c.basic);
  }, KEY));

  // a reload keeps the key and reopens the chat
  await page.reload();
  await started(page);
  check('claude: after a reload the key is still saved and ?app=claude reopens the chat', await page.evaluate(() => document.body.classList.contains('claude-open')
    && !document.getElementById('claudeKeySaved').hidden && window.emu.session.hasClaudeKey));
  // back to the emulator, then the settings export
  await page.click('#btnClaudeBack');
  check('claude: "← Emulator" leaves full screen (the conversation is kept for the side panel) and the address drops app=claude', await waitFor(page, () => !document.body.classList.contains('claude-open')
    && !window.emu.session.chatMachines && window.emu.session.claudeView === 'panel' && !/app=claude/.test(location.search) && getComputedStyle(document.querySelector('.drawer')).display !== 'none'));
  await page.click('#btnShare'); await page.waitForSelector('#share', { state: 'visible' });   // Export settings is on the Share screen
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnSettingsExport')]);
  const file = path.join(os.tmpdir(), `cloadm-claude-settings-${process.pid}.json`);
  await dl.saveAs(file);
  const exported = fs.readFileSync(file, 'utf8');
  fs.rmSync(file);
  check('claude: the settings export has no key', !exported.includes(KEY) && !/anthropicKey|sk-ant/.test(exported));
  // a CoCo with the Becker port on: the chat firmware talks to the backend over DriveWire channel 14
  await page.goto(`${base}?machine=coco&becker=true&app=claude`);
  await started(page);
  check('claude (DriveWire): on a CoCo with the Becker port the firmware finds the server and opens channel 14', await waitFor(page, () => {
    const s = window.emu.session;
    return !!s.chatServer && s.machine.becker && s.machine.becker.server === s.chatServer && s.chatServer.channels[14].open;
  }, null, 8000));
  await counted();
  const sent = requests.length;
  replies.push({ body: text('Yes, over DriveWire.') });
  await say('Over DriveWire?', 1);
  check('claude (DriveWire): the line reaches the API and the reply comes back through the DriveWire channel',
    requests.length === sent + 1 && requests[sent].body.messages.slice(-1)[0].content === 'Over DriveWire?'
    && await waitFor(page, () => window.emu.session.chat.messages.slice(-1)[0].content === 'Yes, over DriveWire.' && window.emu.session.chatServer.channels[14].queue.length === 0, null, 8000),
    JSON.stringify(requests[sent] && requests[sent].body.messages.slice(-1)));
  await page.goto(`${base}?app=claude`);
  await started(page);
  await page.click('#btnClaudeKeyForget');
  check('claude: Forget key removes it from this browser; the key form comes back', await page.evaluate(() => !localStorage.getItem('cloadm.anthropicKey') && !document.getElementById('claudeKeyCard').hidden));
  check('claude: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

async function settingsChecks(browser, base, check) {
  const ctx = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?machine=coco3`);
  await waitFor(page, () => window.emu && window.emu.linkDone);
  await openTab(page, 'Display'); await page.click('#btnSharp');
  await dropFiles(page, [['coco3.rom', fake(32768, 5)]]);
  await waitFor(page, () => window.emu.session.machineRoms('coco3').sockets.some((s) => s.crc));
  await page.click('#btnShare'); await page.waitForSelector('#share', { state: 'visible' });   // the Share screen
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnSettingsExport')]);
  const file = path.join(os.tmpdir(), `cloadm-settings-${process.pid}.json`);
  await dl.saveAs(file);
  const text = fs.readFileSync(file, 'utf8'), data = JSON.parse(text);
  check('settings: Export saves cloadm-settings.json with the settings', dl.suggestedFilename() === 'cloadm-settings.json' && data.format === 'cloadm-settings'
    && JSON.parse(data.settings['display.settings']).view === 'sharp' && data.settings.machine === 'coco3');
  check('settings: no ROMs in the file', !Object.keys(data.settings).some((k) => /^(rom|romdata|romname|media)\./.test(k)) && !text.includes(fake(32768, 5).subarray(0, 24).toString('hex'))
    && !text.includes(fake(32768, 5).subarray(0, 24).toString('base64')));
  const ctx2 = await browser.newContext({ serviceWorkers: 'block' });
  const p2 = await ctx2.newPage();
  await p2.goto(`${base}?machine=dragon64`);
  await waitFor(p2, () => window.emu && window.emu.linkDone);
  await p2.click('#btnShare'); await p2.waitForSelector('#share', { state: 'visible' });
  await Promise.all([p2.waitForEvent('load'), p2.setInputFiles('#fileSettings', file)]);
  await waitFor(p2, () => window.emu && window.emu.linkDone);
  check('settings: Import in a fresh profile, then the page reloads with them', await p2.evaluate(() => window.emu.session.display.view === 'sharp'
    && !document.getElementById('monitor').classList.contains('crt')));
  check('settings: the imported profile has no ROMs', await p2.evaluate(() => window.emu.session.machinesWithRoms().length === 0));
  await p2.goto(`${base}?machine=dragon64`);
  await waitFor(p2, () => window.emu && window.emu.linkDone);
  await p2.click('#btnShare'); await p2.waitForSelector('#share', { state: 'visible' });
  await p2.setInputFiles('#fileSettings', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"name":"not settings"}') });
  check('settings: a file that isn\'t CLOADM settings is refused', await waitFor(p2, () => /not a CLOADM settings file/.test(document.getElementById('toast').textContent)));
  fs.rmSync(file);
  check('settings: no page errors', !errors.length, errors.join('; '));
  await ctx2.close();
  await ctx.close();
}

// the Share screen: layout at desktop and phone width; the link that carries the moment
// opens it in a fresh browser profile (and a damaged one says so); the clip is a video of the screen; the embed
// builder writes an iframe that, put in a page on another origin, runs the chosen machine and program
async function shareChecks(browser, base, site, check) {
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport, acceptDownloads: true, serviceWorkers: 'block' });
    await filesHost(ctx);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?machine=dragon64`);
    await linkIn(page);
    // the moment: the welcome menu, what a visit without ROMs runs (a moment of the stub's bare prompt opens on
    // the menu instead), with a marker in memory once the menu is drawn
    await waitFor(page, () => window.emu.session.welcomeRunning && window.emu.session.screenText()[14].includes('PRESS'), null, 60000);
    await page.evaluate(() => window.emu.machine.poke(1030, 42));
    if (label === 'phone') await page.click('#btnMenu');
    await page.click('#btnShare');
    await page.waitForSelector('#share', { state: 'visible' });
    await page.evaluate(() => document.fonts.ready);
    const lay = await page.evaluate(() => {
      const cols = [...document.querySelectorAll('#share > .col')].map((c) => c.getBoundingClientRect());
      return { hash: location.hash, emulatorHidden: getComputedStyle(document.querySelector('.layout')).display === 'none', scrollX: document.documentElement.scrollWidth <= innerWidth,
        side: cols[1].left > cols[0].right - 1, stacked: cols[1].top >= cols[0].bottom - 1,
        heading: document.getElementById('shareHeading').textContent, embed: document.getElementById('embedHeading').textContent,
        fieldsWide: ['embedMachine', 'embedProgram'].every((id) => { const r = document.getElementById(id).getBoundingClientRect(); return Math.abs(r.left - cols[1].left) < 1 && Math.abs(r.width - cols[1].width) < 1; }) };
    });
    check(`share (${label}): the Share screen replaces the emulator view, ${label === 'desktop' ? 'two columns' : 'one column'}, no sideways scrolling`,
      lay.hash === '#share' && lay.emulatorHidden && lay.scrollX && (label === 'desktop' ? lay.side : lay.stacked)
      && lay.heading === 'A link that opens exactly here' && lay.embed === 'Put a machine in your blog post' && lay.fieldsWide, JSON.stringify(lay));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `share-screen-${label}.png`), fullPage: true });
    if (label === 'phone') { check('share (phone): no page errors', !errors.length, errors.join('; ')); await ctx.close(); continue; }

    // the link carries the moment: a fresh profile opens it, POKE included, and the fragment is cleared. The
    // options are matched as a group rather than pinned one by one (`ssc=none` included): shareUrl (js/session.js)
    // emits every non-LOCAL profile option, so a list here would drift with the next option or default. The
    // machine is pinned; the rest is "whatever options this model has".
    const link = await page.inputValue('#shareLink');
    check('share: the link points at /play/ with this machine, the snapshot in the fragment', /\/play\/\?machine=dragon64(&[a-z]+=[^&#]*)*#s=[A-Za-z0-9_-]{1000,}$/.test(link), link.slice(0, 80));
    const ctx2 = await browser.newContext({ serviceWorkers: 'block' });
    // every message the page says, recorded from its start: a 4 s toast can end before a loaded machine reads it
    await ctx2.addInitScript(() => { window.__said = []; document.addEventListener('DOMContentLoaded', () => { const t = document.getElementById('toastText');
      if (t) new MutationObserver(() => { if (t.textContent) window.__said.push(`${document.getElementById('toast').classList.contains('error') ? 'ERROR ' : ''}${t.textContent}`); }).observe(t, { childList: true, characterData: true, subtree: true }); }); });
    const said = (p) => p.evaluate(() => window.__said.join(' | '));
    const p2 = await ctx2.newPage();
    // waited for: the page's own "the link is in" (linkDone is set once the link's snapshot has been opened or
    // refused), then the moment is checked once. Opening a link takes the visit's start plus the snapshot, which on
    // a loaded machine (CI) can exceed a 10 s wall clock; the limit here only stops a page that hangs.
    await p2.goto(link);
    await linkIn(p2);
    check('share: the link opens exactly that moment in another browser profile', await p2.evaluate(() => window.emu.machine.ram[1030] === 42 && location.hash === '')
      && await waitFor(p2, () => window.__said.some((m) => /^Snapshot opened: Dragon 64/.test(m))) && await p2.evaluate(() => !window.__said.some((m) => /^ERROR /.test(m))),
      `${await said(p2)} · ram[1030] ${await p2.evaluate(() => window.emu.machine.ram[1030])}`);
    const p2b = await ctx2.newPage();   // a link that differs only after # wouldn't reload the same page
    await p2b.goto(link.slice(0, link.length - 400));
    await linkIn(p2b);
    check('share: a cut-short link says its snapshot is damaged', await waitFor(p2b, () => window.__said.some((m) => /damaged/.test(m)))
      && await p2b.evaluate(() => !window.__said.some((m) => /Snapshot opened/.test(m))), await said(p2b));
    await ctx2.close();

    // the clip
    const clipLabel = await page.textContent('#btnShareClip');
    const [clip] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#btnShareClip')]);
    const clipBytes = fs.readFileSync(await clip.path());
    const mp4 = clipBytes.toString('latin1', 4, 8) === 'ftyp', webm = clipBytes.readUInt32BE(0) === 0x1A45DFA3;
    check('share: "Save 6-second clip" records the screen, in the format the button names', clipBytes.length > 2000
      && ((/MP4/.test(clipLabel) && mp4 && /\.mp4$/.test(clip.suggestedFilename())) || (/WebM/.test(clipLabel) && webm && /\.webm$/.test(clip.suggestedFilename()))),
      `${clipLabel}: ${clip.suggestedFilename()} ${clipBytes.length} bytes`);

    // the embed builder, and the iframe it writes running on another origin
    await page.selectOption('#embedMachine', 'coco');
    await page.fill('#embedProgram', 'https://files.example/game.cas');
    await page.check('#embedAutorun'); await page.uncheck('#embedCrt');
    const snippet = await page.textContent('#embedFrame');
    const src = (/src="([^"]+)"/.exec(snippet) || [])[1];
    check('share: the embed snippet is an iframe of /play/ with the machine, the tape, autorun, the display and embed=1',
      !!src && new URL(src).pathname === '/play/' && new URL(src).search === '?machine=coco&tape=https%3A%2F%2Ffiles.example%2Fgame.cas&autorun=1&display=sharp&embed=1'
      && /allow="gamepad; fullscreen"/.test(snippet), snippet);
    check('share: the script snippet includes embed/cloadm.js and attaches', /<script src="[^"]+\/embed\/cloadm\.js"><\/script>/.test(await page.textContent('#embedScript'))
      && /CLOADM\.attach/.test(await page.textContent('#embedScript')));
    const host = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<!doctype html><title>blog</title>${snippet}<script src="${site}embed/cloadm.js"></script>`); });
    await new Promise((r) => host.listen(0, '127.0.0.1', r));
    host.unref();   // a group that throws before host.close() must not keep the run from exiting
    const ctx3 = await browser.newContext({ serviceWorkers: 'block' });
    await filesHost(ctx3);
    const p3 = await ctx3.newPage();
    await p3.goto(`http://localhost:${host.address().port}/`);
    // the tape's program (tools/mame-diff/tape/csave.asm's file) loads at $3000: its first bytes must be there
    const tapeFile = require('../tests/load.js')().formats.identify('game.cas', Buffer.from(require('./mame-diff/tape/spec.js').csaveStream())).files[0];
    const want = [...tapeFile.data.subarray(0, 8)];
    const got = await p3.evaluate(async ([load, want]) => {
      const m = await CLOADM.attach(document.querySelector('iframe'), { timeout: 120000 });
      const t0 = Date.now();
      let mem = [];
      // a condition wait (the embedded page starts, then loads the tape); the limit only stops a page that hangs
      while (Date.now() - t0 < 60000) { mem = await m.peek(load, want.length); if (JSON.stringify(mem) === JSON.stringify(want)) break; await new Promise((ok) => setTimeout(ok, 100)); }
      return { info: await m.info(), mem };
    }, [tapeFile.load, want]);
    check('share: the written iframe, on another origin, runs that machine and loads the tape into memory', got.info.machine === 'coco' && tapeFile.load === 0x3000
      && JSON.stringify(got.mem) === JSON.stringify(want), JSON.stringify(got));
    await ctx3.close(); host.close();

    // with the user's own ROMs (stand-ins made from this project's firmware, never real ROMs): the link names them
    // and carries none of their bytes, not even BASIC's copy of itself in RAM (the Dragon 64 in its 64K mode)
    const ours = Buffer.concat(['liza.bin', 'welcome.bin', 'demo.bin', 'chat.bin'].map((f) => fs.readFileSync(path.join(ROOT, 'examples', f))));
    const standIn = (seed) => [...Array(0x4000)].map((_, i) => ours[(i * 3 + seed) % ours.length] ^ ((i >> 8) + seed) & 0xFF);
    const roms = { basic: standIn(101), basic64: standIn(138) };
    const putRoms = (p, r) => p.evaluate(async (r) => { const s = window.emu.session; for (const [k, v] of Object.entries(r)) s.roms.put('dragon64', k, Uint8Array.from(v), `${k}.rom`); s.switchMachine('dragon64'); await s.index.settled(); }, r);
    const Emu = require('../tests/load')();
    await page.click('#shareBack');
    await putRoms(page, roms);
    await page.evaluate((b) => { window.emu.machine.ram.set(Uint8Array.from(b), 0x8000); }, roms.basic64);
    await page.click('#btnPause');                                      // hold the moment still
    await page.click('#btnShare');
    await page.waitForSelector('#share', { state: 'visible' });
    const shared = await page.evaluate(() => ({ link: document.getElementById('shareLink').value, recipient: document.getElementById('shareRecipient').textContent }));
    check('share: with your own ROMs the moment is shared, and the page says the recipient needs their own', /#s=/.test(shared.link)
      && /They need their own 32K-mode BASIC and 64K-mode BASIC\./.test(shared.recipient) && /holds none of them/.test(shared.recipient), shared.recipient);
    const W = 16, uni = (a, k) => a.slice(k, k + W).every((v) => v === a[k]);
    const romWindows = new Set();
    for (const r of Object.values(roms)) for (let k = 0; k + W <= r.length; k++) if (!uni(r, k)) romWindows.add(Buffer.from(r.slice(k, k + W)).toString('hex'));
    const decoded = Emu.state.fromJSON(zlib.gunzipSync(Buffer.from(new URL(shared.link).hash.slice(3), 'base64url')).toString('utf8'));
    const leaks = [];
    const scan = (v, at) => { if (ArrayBuffer.isView(v)) { const a = [...new Uint8Array(v.buffer, v.byteOffset, v.byteLength)]; for (let k = 0; k + W <= a.length; k++) if (!uni(a, k) && romWindows.has(Buffer.from(a.slice(k, k + W)).toString('hex'))) { leaks.push(`${at}@${k}`); break; } }
      else if (v && typeof v === 'object') for (const [key, x] of Object.entries(v)) scan(x, `${at}.${key}`); };
    scan(decoded, 'snapshot');
    check('share: the link holds no 16-byte run of either ROM (BASIC\'s RAM copy is a reference)', !leaks.length && decoded.share.refs.some((r) => r.at === 0x8000 && r.len === 0x4000), leaks.join() || JSON.stringify(decoded.share.refs));
    const held = await page.evaluate(() => window.emu.Emu.state.toJSON(window.emu.machine.snapshot().state.memory));
    // the recipient: no ROMs (the needs-ROMs card), another version (refused), the same ROMs (opens exactly)
    for (const [who, theirs] of [['no ROMs', null], ['another version', { basic: standIn(7), basic64: roms.basic64 }], ['the same ROMs', roms]]) {
      const rctx = await browser.newContext({ serviceWorkers: 'block' });
      const rp = await rctx.newPage();
      await rp.goto(`${base}?machine=dragon64`);
      await linkIn(rp);
      if (theirs) await putRoms(rp, theirs);
      await rp.goto(shared.link);   // (another query than the page's: a new page, not a hash change)
      await linkIn(rp);
      const r = await rp.evaluate(() => ({ needs: !document.getElementById('snapNeeds').hidden ? document.getElementById('snapNeedsText').textContent : null,
        msg: document.getElementById('toast').textContent, mem: window.emu.Emu.state.toJSON(window.emu.machine.snapshot().state.memory) }));
      if (who === 'no ROMs') check('share link, recipient without ROMs: the needs-ROMs card names them, nothing opens', /This snapshot needs 32K-mode BASIC and 64K-mode BASIC/.test(r.needs || '') && r.mem !== held, r.needs || r.msg);
      else if (who === 'another version') check('share link, recipient with another version: refused with a clear message, nothing opens', /another version of 32K-mode BASIC/.test(r.needs || r.msg) && r.mem !== held, r.needs || r.msg);
      else {
        // the page opened it; and opened again through the Session, compared before a frame runs, it is the moment
        const exact = await rp.evaluate(async (link) => { const s = window.emu.session; s.openSnapshot(await s.readSnapshotLink(new URL(link).hash));
          return window.emu.Emu.state.toJSON(s.machine.snapshot().state.memory); }, shared.link);
        check('share link, recipient with the same ROMs: it opens, exactly the moment (memory rebuilt from their ROMs)', /Snapshot opened: Dragon 64/.test(r.msg) && exact === held, r.msg);
      }
      await rctx.close();
    }
    check('share: no page errors', !errors.length, errors.join('; '));
    await ctx.close();
  }
}

// the keyboard belongs to the page unless the screen has focus: Tab moves focus, Enter and Space press the
// focused button or tick a box, arrows move a slider, Esc closes a dialog; none of it reaches the machine.
// With the screen focused, keys type into the machine (on the no-ROM stub: its key queue)
async function focusChecks(browser, base, check) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?machine=dragon64`);
  await ready(page);
  await waitFor(page, () => window.emu && window.emu.machine);
  await stubPrompt(page);
  // count what reaches the machine: stub key codes and matrix presses
  await page.evaluate(() => {
    const m = window.emu.machine, push = m.stubKeys.push.bind(m.stubKeys), set = m.setKey.bind(m);
    window.reached = [];
    m.stubKeys.push = (...v) => { window.reached.push(...v); return push(...v); };
    m.setKey = (k, d) => { if (d) window.reached.push(k); return set(k, d); };
  });
  const reached = () => page.evaluate(() => window.reached.length);
  const paused = () => page.evaluate(() => document.body.classList.contains('paused'));

  await page.focus('#btnPause');
  await page.keyboard.press('Enter');
  check('keyboard: Enter on a focused button presses it (Pause), the machine gets nothing', await waitFor(page, () => document.body.classList.contains('paused')) && await reached() === 0);
  await page.keyboard.press('Space');
  check('keyboard: Space on a focused button presses it (Resume)', await waitFor(page, () => !document.body.classList.contains('paused')) && await reached() === 0);
  await page.keyboard.press('Tab');
  check('keyboard: Tab moves focus to the next control, the machine gets nothing', await page.evaluate(() => document.activeElement && document.activeElement.id !== 'btnPause' && document.activeElement !== document.body)
    && await reached() === 0, await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName)));
  await openTab(page, 'Input');
  const snd = await page.isChecked('#chkSound');
  await page.focus('#chkSound'); await page.keyboard.press('Space');
  check('keyboard: Space ticks a focused checkbox (Sound)', await page.isChecked('#chkSound') === !snd && await reached() === 0);
  await page.keyboard.press('Space');
  await openTab(page, 'Display');
  const g0 = Number(await page.inputValue('#rng-glow'));
  await page.focus('#rng-glow'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  check('keyboard: arrows move a focused slider (Phosphor glow)', Number(await page.inputValue('#rng-glow')) === g0 + 2 && await reached() === 0, `${g0} -> ${await page.inputValue('#rng-glow')}`);
  if (await page.$('#shareDialog')) {
    await page.click('#btnShare');
    await page.waitForSelector('#shareDialog[open]');
    await page.keyboard.press('Escape');
    check('keyboard: Esc closes a dialog and no BREAK reaches the machine behind it', await waitFor(page, () => !document.querySelector('dialog[open]')) && await reached() === 0);
  }
  // the screen focused: keys reach the machine
  await page.click('#screen');
  await page.keyboard.type('AB');
  await page.keyboard.press('Escape');
  check('keyboard: with the screen focused, keys (and Esc as BREAK) reach the machine', await waitFor(page, () => window.reached.includes(65) && window.reached.includes(66) && window.reached.includes('BREAK')),
    await page.evaluate(() => JSON.stringify(window.reached)));
  // a key held on the screen is released when focus leaves it
  await page.click('#screen');
  await page.keyboard.down('Z');
  await page.focus('#btnPause');
  // A matrix key reaches the machine through the KeyQueue: its press is applied at a frame start and held for a few
  // frames, and leaving the screen queues the release behind it. Until the queue has drained the press may still be
  // on its way (the matrix all up only because it has not gone down yet: a page under load runs its frames late),
  // and it then lands in the count the Tab checks below start from. So: the queue drained and the matrix all up.
  check('keyboard: a key held on the screen is let go when the screen loses focus', await waitFor(page, () => window.emu.session.keys.pending === 0 && !window.emu.machine.keyCols.some((c) => c)),
    await page.evaluate(() => `pending ${window.emu.session.keys.pending}`));
  await page.keyboard.up('Z');
  // no keyboard trap: Tab and Shift+Tab leave the screen and come back; neither reaches the
  // machine, and reached by keyboard the screen shows its ring and how to leave it
  await page.focus('#btnPause');
  let n = 0;
  while (n++ < 60 && await page.evaluate(() => !document.activeElement || document.activeElement.id !== 'screen')) await page.keyboard.press('Shift+Tab');
  const onScreen = await page.evaluate(() => document.activeElement && document.activeElement.id === 'screen');
  const hint = await page.evaluate(() => getComputedStyle(document.getElementById('focusHint')).display !== 'none');
  check('keyboard: Shift+Tab reaches the screen, which shows "Tab leaves the screen"', onScreen && hint, `${n} presses, hint shown: ${hint}`);
  await page.evaluate(() => { window.reached.length = 0; });
  await page.keyboard.press('Tab');
  const next = await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName));
  check('keyboard: Tab on the screen moves focus to the next control, the machine gets nothing', next !== 'screen' && next !== 'BODY' && await reached() === 0,
    `${next}, reached ${await page.evaluate(() => JSON.stringify(window.reached))}`);
  const hintGone = await page.evaluate(() => getComputedStyle(document.getElementById('focusHint')).display === 'none');
  await page.keyboard.press('Shift+Tab');
  check('keyboard: Shift+Tab comes back to the screen, the machine gets nothing (the hint shows only on the screen)', hintGone && await page.evaluate(() => document.activeElement.id === 'screen') && await reached() === 0,
    `hint gone ${hintGone}, focus ${await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName))}, reached ${await page.evaluate(() => JSON.stringify(window.reached))}`);
  await page.keyboard.type('C');
  // the stub takes the key at once (67), the matrix at the next frame start (the KeyQueue): both, before the count
  // below starts again, or the matrix press lands in it
  check('keyboard: back on the screen, keys reach the machine again', await waitFor(page, () => window.reached.includes(67) && window.reached.includes('C')), await page.evaluate(() => JSON.stringify(window.reached)));
  // a first visit: nothing focused, keys go to the machine, but Tab moves focus onto the page
  await page.evaluate(() => { document.activeElement.blur(); window.reached.length = 0; });
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName));
  check('keyboard: with nothing focused, Tab moves onto the page, the machine gets nothing', first !== 'BODY' && await reached() === 0, first);
  check('keyboard: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

// the phone's machine menu reaches the window's bottom and fades while more models are
// below, the last one reachable by scrolling (U5); from a fresh load the header is one Shift+Tab from the screen (M1);
// Esc closes every view, panel, menu, card and the full-screen chat, and is BREAK only on the screen (U7, R2-U3);
// every view adds one history entry, so Back returns to the emulator (R2-U4)
async function uiQaChecks(browser, base, check) {
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}?machine=dragon64`); await ready(page);
    await page.click('#machineBtn');
    await waitFor(page, () => !document.getElementById('machineMenu').hidden);
    const m = await page.evaluate(() => { const el = document.getElementById('machineMenu'), r = el.getBoundingClientRect();
      return { bottom: r.bottom, vh: innerHeight, scrolls: el.scrollHeight > el.clientHeight, fade: el.classList.contains('more-below') }; });
    check('phone: the machine menu reaches the bottom of the window and fades while more models are below',
      m.scrolls && m.fade && m.bottom > m.vh - 24 && m.bottom <= m.vh, JSON.stringify(m));
    const last = await page.evaluate(() => { const el = document.getElementById('machineMenu'); el.scrollTop = el.scrollHeight;
      const b = [...el.querySelectorAll('button[data-machine]')].pop(); return b.dataset.machine; });
    await waitFor(page, () => !document.getElementById('machineMenu').classList.contains('more-below'));
    const end = await page.evaluate((id) => { const el = document.getElementById('machineMenu'), r = el.getBoundingClientRect(),
      b = el.querySelector(`button[data-machine="${id}"]`).getBoundingClientRect();
      return { inside: b.top >= r.top && b.bottom <= r.bottom + 1, fade: el.classList.contains('more-below') }; }, last);
    check('phone: scrolled to the end, the last model is in view and the fade is gone', end.inside && !end.fade, JSON.stringify(end));
    await page.click(`#machineMenu button[data-machine="${last}"]`);
    if (await page.isVisible('#switchConfirm')) await page.click('#btnSwitch');
    check('phone: the last model can be picked', await waitFor(page, (id) => window.emu.machine.id === id, last), last);
    check('phone: no page errors', !errors.length, errors.join(' | '));
    await ctx.close();
  }
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?machine=dragon64`); await ready(page);
  const focused = () => page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName));
  check('a fresh load puts the focus on the screen', await waitFor(page, () => document.activeElement && document.activeElement.id === 'screen'), await focused());
  await page.keyboard.press('Shift+Tab');
  const back = await page.evaluate(() => { const a = document.activeElement; return { id: a.id, header: !!a.closest('header') }; });
  check('Shift+Tab from the screen goes to the header', back.header, JSON.stringify(back));
  await stubPrompt(page);
  const watchKeys = () => page.evaluate(() => { const m = window.emu.machine, push = m.stubKeys.push.bind(m.stubKeys); window.reached = [];
    m.stubKeys.push = (...v) => { window.reached.push(...v); return push(...v); }; });
  await watchKeys();
  const hidden = (id) => page.evaluate((id) => document.getElementById(id).hidden, id);
  // every surface that closes, opened the way a person opens it, then Esc with the focus where it lands and with
  // the focus on the page itself (as after a click on empty space)
  const surfaces = [
    ['Share', 'share', () => page.click('#btnShare')],
    ['Library', 'library', () => page.click('#navLibrary')],
    ['Add ROMs', 'romCard', () => page.click('#romPill')],
    ['Debugger', 'debugView', () => page.click('#navDebugger')],
    ['drive menu', 'driveMenu', () => page.click('#drives [data-drive="0"]')],
    ['switch confirmation', 'switchConfirm', async () => { await page.click('#machineBtn'); await page.click('#machineMenu button[data-machine="coco3"]'); }],
    ['Ask Claude panel', 'ask', () => page.click('#btnAsk')],
    ['Ctrl+K box', 'cmdBox', async () => { await page.focus('#btnPause'); await page.keyboard.press('Control+k'); }],
    ['ROMs-needed card of a snapshot (shown directly)', 'snapNeeds', () => page.evaluate(() => { document.getElementById('snapNeeds').hidden = false; })],
  ];
  for (const [name, id, open] of surfaces) {
    for (const from of ['where it lands', 'page']) {
      await open();
      const shown = await waitFor(page, (id) => !document.getElementById(id).hidden, id);
      if (from === 'page') await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
      await page.keyboard.press('Escape');
      const closed = await waitFor(page, (id) => document.getElementById(id).hidden && location.hash === '', id);
      check(`Esc closes the ${name} (focus ${from})`, shown && closed, `shown ${shown} ${await focused()} ${await page.evaluate(() => location.hash)}`);
    }
  }
  await page.click('#machineBtn'); await page.click('#machineMenu button[data-machine="coco3"]');
  await waitFor(page, () => !document.getElementById('switchConfirm').hidden);
  await page.focus('#screen'); await page.keyboard.press('Escape');
  check('Esc with the focus on the screen answers the switch confirmation "Cancel"', await waitFor(page, () => document.getElementById('switchConfirm').hidden)
    && await page.evaluate(() => window.emu.machine.id) === 'dragon64');
  check('those Esc presses never reached the machine as BREAK', await page.evaluate(() => window.reached.length) === 0, await page.evaluate(() => window.reached.join()));
  await page.focus('#screen'); await page.keyboard.press('Escape');
  check('Esc on the screen is still the machine\'s BREAK', await waitFor(page, () => window.reached.length > 0));

  // R2-U4: every view adds one history entry: Back from it returns to the emulator, and so does "← Emulator" from a
  // view opened over another view (one entry above the emulator, not two)
  // (in a new tab: history.length stops counting at 50, and the surfaces' openers follow the variable \`page\`)
  await page.close();
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?machine=dragon64`); await ready(page);
  for (const [name, id, open] of surfaces.slice(0, 4)) {
    await open(); await waitFor(page, (id) => !document.getElementById(id).hidden, id);
    // its own entry (history.length can't say: an entry opened after a Back replaces the forward one)
    const added = await page.evaluate(() => history.state && history.state.view === location.hash) ? 1 : 0;
    await page.goBack();
    const back = await waitFor(page, (id) => document.getElementById(id).hidden && location.hash === '' && !!window.emu, id);
    check(`${name} adds one history entry and Back returns to the emulator`, added === 1 && back && await page.evaluate(() => location.pathname.endsWith('/play/')),
      `added ${added}, ${await page.evaluate(() => location.href)}`);
  }
  await page.click('#navLibrary'); await waitFor(page, () => !document.getElementById('library').hidden);
  const one = await page.evaluate(() => history.length);
  // the header is out of sight in a view: its link's own handler, as a click would run it
  await page.evaluate(() => document.getElementById('navDebugger').click()); await waitFor(page, () => !document.getElementById('debugView').hidden);
  const replaced = await page.evaluate(() => history.length) === one;
  await page.click('#btnDbgBack');
  check('a view opened over another replaces it; "← Emulator" returns to the emulator', replaced
    && await waitFor(page, () => location.hash === '' && document.getElementById('library').hidden && document.getElementById('debugView').hidden));
  // a view the page was loaded on (a link to #library): closing it stays on the page, on the emulator
  await page.goto(`${base}?machine=dragon64#library`); await ready(page);
  await waitFor(page, () => !document.getElementById('library').hidden);
  await page.click('#btnLibBack');
  check('a view the page opened on closes to the emulator, not off the page', await waitFor(page, () => location.hash === '' && document.getElementById('library').hidden && !!window.emu));

  // a CoCo program on the Dragon 64: the offer
  await page.setInputFiles('#fileProgram', { name: 'game.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 0, 4, 0x30, 0x00, 0x86, 0x41, 0x20, 0xFE, 0xFF, 0, 0, 0x30, 0x00]) });
  await waitFor(page, () => !document.getElementById('mediaOffer').hidden);
  await page.keyboard.press('Escape');
  check('Esc dismisses the "made for another machine" offer, loading nothing', await waitFor(page, () => document.getElementById('mediaOffer').hidden) && await page.evaluate(() => window.emu.machine.id) === 'dragon64');
  // the full-screen chat: Esc off the screen leaves it (as "← Emulator"); on the screen it is the chat machine's BREAK while it has something to do
  await page.goto(`${base}?machine=dragon64`); await ready(page);
  await waitFor(page, () => window.emu.session.welcomeRunning);
  // a marked entry of our own under the chat's history step, to see where Esc leaves history
  await page.evaluate(() => { history.pushState({ mark: 'before chat' }, ''); window.__samePage = true; });
  await page.click('#btnAsk');
  await waitFor(page, () => window.emu.session.claudeView === 'full');
  const stepped = await page.evaluate(() => !!(history.state && history.state.claudeChat));
  // (with a line typed, BREAK has something to do: the firmware drops the line; the empty, idle prompt is leave-the-chat, in escChatChecks)
  await page.focus('#screen'); await emuFrames(page, 3); await page.keyboard.type('x');
  const typed = await waitFor(page, () => window.emu.session.readByte(0x6013, window.emu.session.chatMachines.chat) === 1);
  await page.keyboard.press('Escape'); await emuFrames(page, 3);
  check('in the full-screen chat, Esc on the screen with a line typed is BREAK (the line is dropped) and keeps the chat open', typed
    && await page.evaluate(() => window.emu.session.claudeView === 'full' && window.emu.session.readByte(0x6013, window.emu.session.chatMachines.chat) === 0));
  await page.focus('#btnFullSide'); await page.keyboard.press('Escape');
  check('in the full-screen chat, Esc off the screen closes it', await waitFor(page, () => window.emu.session.claudeView !== 'full' && document.getElementById('claude').hidden));
  // and takes the chat's history step back, as "← Emulator" and the browser's Back do (phone-chat's leave()): the
  // entry is the one under the step again, so a later Back doesn't land on a stale chat step
  const hist = await page.evaluate(() => ({ state: history.state, search: location.search, same: window.__samePage === true }));
  check('Esc off the screen takes the chat\'s history step back (not only closing it)', stepped && hist.same && !/app=claude/.test(hist.search)
    && await waitFor(page, () => !!(history.state && history.state.mark === 'before chat')), JSON.stringify(hist));
  await page.goBack();
  check('then Back goes to the entry before, on the same page, with the chat closed', await waitFor(page, () => window.__samePage === true
    && !(history.state && (history.state.mark || history.state.claudeChat)) && !document.body.classList.contains('claude-open')));
  // a 4K MC-10's LIZA offer
  await page.goto(`${base}?machine=mc10&ram=4`); await ready(page);
  await page.click('#shelf button[data-needs="20"]');
  await waitFor(page, () => !document.getElementById('lizaOffer').hidden);
  await page.keyboard.press('Escape');
  check('Esc closes the LIZA RAM offer ("Not now")', await waitFor(page, () => document.getElementById('lizaOffer').hidden) && await page.evaluate(() => window.emu.machine.config.ram) === 4);
  // a question above the screen answers "no" to Esc with the focus on the screen too (reviewer: the offer stayed),
  // and that Esc is not BREAK
  await page.click('#shelf button[data-needs="20"]');
  await waitFor(page, () => !document.getElementById('lizaOffer').hidden);
  await page.focus('#screen');
  await watchKeys();
  await page.keyboard.press('Escape');
  check('Esc with the focus on the screen closes the LIZA RAM offer too, and is not BREAK', await waitFor(page, () => document.getElementById('lizaOffer').hidden)
    && await page.evaluate(() => window.emu.machine.config.ram === 4 && window.reached.length === 0), await page.evaluate(() => window.reached.join()));
  check('desktop: no page errors', !errors.length, errors.join(' | '));
  await ctx.close();
}

async function designChecks(browser, base, check) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const foreign = [], errors = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && u.host !== new URL(base).host) foreign.push(r.url()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?machine=dragon64`);
  await page.evaluate(() => document.fonts.ready);
  await started(page);
  const fonts = await page.evaluate(async () => {
    await Promise.all([document.fonts.load('800 20px Archivo'), document.fonts.load('14px "JetBrains Mono"')]);
    return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, ''));
  });
  check('tokens: Archivo and JetBrains Mono load from the site', fonts.includes('Archivo') && fonts.includes('JetBrains Mono'), [...new Set(fonts)].join(', '));
  const styles = await page.evaluate(() => {
    const cs = (el) => getComputedStyle(el);
    return { body: cs(document.body).fontFamily, bg: cs(document.body).backgroundColor, color: cs(document.body).color,
      mono: cs(document.getElementById('asmSource')).fontFamily, primary: cs(document.querySelector('button.primary')).backgroundColor };
  });
  check('tokens: body in Archivo on the ground colour with the text colour', /^Archivo/.test(styles.body) && styles.bg === 'rgb(11, 13, 12)' && styles.color === 'rgb(232, 237, 230)', JSON.stringify(styles));
  check('tokens: code in JetBrains Mono, primary buttons phosphor green', /^"?JetBrains Mono/.test(styles.mono) && styles.primary === 'rgb(61, 245, 90)');
  check('tokens: nothing is requested from another host', !foreign.length, foreign.join(' '));
  check('tokens: no page errors', !errors.length, errors.join('; '));
  await ctx.close();
}

// every model runs (its welcome menu, a screenshot), LIZA assembled and run from the Debugger and answering typed
// input, and the file:// notice
async function modelsChecks(browser, base, check) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // text screen of the current machine (32x16 at its text address)
  const screenText = () => page.evaluate(() => {
    const m = window.emu.machine, base = m.profile.textScreen || 0x400;
    let s = '';
    for (let i = 0; i < 512; i++) { const c = m.ram[base + i] & 0x3F; s += String.fromCharCode(c < 32 ? c + 64 : c); }
    return s.match(/.{32}/g).join('\n');
  });
  await page.goto(`${base}?machine=dragon64`);
  await started(page);
  await page.click('#machineBtn');
  const ids = await page.$$eval('#machineMenu button[data-machine]', (o) => o.map((x) => x.dataset.machine));
  await page.click('#machineBtn');
  check('model list', ids.length >= 13, `(${ids.length} models)`);
  for (const id of ids) {
    errors.length = 0;
    await pickMachine(page, id);
    // without ROMs every model is switched on into its welcome menu, never the stub's bare screen
    await waitFor(page, () => (window.emu.session.welcomeRunning && window.emu.session.screenText()[9].trim() === '1 TALK TO LIZA') || window.emu.machine.hasRom);
    await redrawn(page);
    const colours = await page.evaluate(() => {
      // what the page drew (WebGL or 2D), copied to a 2D canvas to read it
      const s = document.getElementById('screen'), c = document.createElement('canvas');
      c.width = s.width; c.height = s.height; c.getContext('2d').drawImage(s, 0, 0);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const set = new Set();
      for (let i = 0; i < d.length; i += 4 * 97) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      return set.size;
    });
    const text = await screenText();
    const banner = (/1 TALK TO LIZA/.test(text) && !/BUILT-IN STUB/.test(text)) || await page.evaluate(() => window.emu.machine.hasRom);
    check(`${id}: runs`, !errors.length && colours > 1 && banner, errors.length ? errors.join('; ') : `(${colours} colours)`);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `${id}.png`) });
  }
  // LIZA end to end: assembler panel -> run -> keyboard conversation
  errors.length = 0;
  await pickMachine(page, 'coco');
  await openDebugger(page);
  await page.click('#btnAsmLiza');
  await waitFor(page, () => document.getElementById('asmSource').value.includes('READLN'));   // the source is fetched
  await page.click('#btnAsmRun');
  await waitFor(page, () => window.emu.session.screenText().join('').includes('I AM LIZA'));
  await page.click('#btnDbgBack');
  await page.click('#screen');
  await page.keyboard.type('I AM SAD', { delay: 70 }); await page.keyboard.press('Enter');
  const answered = await waitFor(page, () => /HOW LONG HAVE YOU BEEN SAD/.test(window.emu.session.screenText().join('\n')));
  check('LIZA: assemble, run and answer typed input', answered && !errors.length, errors.length ? errors.join('; ') : await screenText());
  // opening from disk shows the instructions instead of a broken page
  const local = await browser.newPage();
  await local.goto('file://' + path.join(ROOT, 'play/index.html'));
  check('file:// open shows how to serve the page', await local.waitForSelector('#startError', { state: 'visible', timeout: 10000 }).then(() => true, () => false));
}

// The groups, in run order: [name, (browser) => the group's checks]. --only takes these names.
const GROUPS = (base, site) => [
  ['models', (b) => modelsChecks(b, base, check)],
  ['romUi', (b) => romUiChecks(b, base, check)],
  ['mediaBackend', (b) => mediaBackendChecks(b, base, check)],
  ['audio', (b) => audioChecks(b, base, check)],
  ['cartridge', (b) => cartridgeChecks(b, base, check)],
  ['sscBoard', (b) => sscBoardChecks(b, base, check)],
  ['typing', (b) => typingChecks(b, base, check)],
  ['visit', (b) => visitChecks(b, base, check)],
  ['returning', (b) => returningChecks(b, base, check)],
  ['powerOn', (b) => powerOnChecks(b, base, check)],
  ['cpu6309', (b) => cpu6309Checks(b, base, check)],
  ['firstVisit', (b) => firstVisitChecks(b, base, check)],
  ['media', (b) => mediaChecks(b, base, check)],
  ['disk', (b) => diskChecks(b, base, check)],
  ['hint', (b) => hintChecks(b, base, check)],
  ['input', (b) => inputChecks(b, base, check)],
  ['poke', (b) => pokeChecks(b, base, check)],
  ['feedback', (b) => feedbackChecks(b, base, check)],
  ['feedbackModel', (b) => feedbackModelChecks(b, base, check)],
  ['debuggerScreen', (b) => debuggerScreenChecks(b, base, check)],
  ['library', (b) => libraryChecks(b, base, check)],
  ['libraryStorage', (b) => libraryStorageChecks(base, check)],
  ['librarySelect', (b) => librarySelectChecks(b, base, check)],
  ['typeinScreen', (b) => typeinScreenChecks(b, base, check)],
  ['slot', (b) => slotChecks(b, base, check)],
  ['tapePanel', (b) => tapePanelChecks(b, base, check)],
  ['printer', (b) => printerChecks(b, base, check)],
  ['driveWire', (b) => driveWireChecks(b, base, check)],
  ['nitros9', (b) => nitros9Checks(b, base, check)],
  ['webSerial', (b) => webSerialChecks(b, base, check)],
  ['snapshot', (b) => snapshotChecks(b, base, check)],
  ['liza6803', (b) => liza6803Checks(b, base, check)],
  ['romInput', (b) => romInputChecks(b, base, check)],
  ['design', (b) => designChecks(b, base, check)],
  ['inputScreen', (b) => inputScreenChecks(b, base, check)],
  ['touchJoystick', (b) => touchJoystickChecks(b, base, check)],
  ['keyboardSymbols', (b) => keyboardSymbolsChecks(b, base, check)],
  ['focus', (b) => focusChecks(b, base, check)],
  ['uiQa', (b) => uiQaChecks(b, base, check)],
  ['emulatorBack', (b) => emulatorBackChecks(b, base, check)],
  ['debugger', (b) => debuggerChecks(b, base, check)],
  ['tape', (b) => tapeChecks(b, base, check)],
  ['layout', (b) => layoutChecks(b, base, check)],
  ['display', (b) => displayChecks(b, base, check)],
  ['glLoss', (b) => glLossChecks(b, base, check)],
  ['pageLoop', (b) => pageLoopChecks(b, base, check)],
  ['landing', (b) => landingChecks(b, site, check)],
  ['glossary', (b) => glossaryChecks(b, site, check)],
  ['state', (b) => stateChecks(b, site, check)],
  ['nav', (b) => navChecks(b, site, check)],
  ['reading', (b) => readingChecks(b, site, check)],
  ['light', (b) => lightChecks(b, site, check)],
  ['url', (b) => urlChecks(b, base, check)],
  ['embed', (b) => embedChecks(b, site, check)],
  ['pwa', (b) => pwaChecks(b, site, check)],
  ['settings', (b) => settingsChecks(b, base, check)],
  ['backFocus', (b) => backFocusChecks(b, base, check)],
  ['fold', (b) => foldChecks(b, base, check)],
  ['noteFit', (b) => noteFitChecks(b, base, check)],
  ['escChat', (b) => escChatChecks(b, base, check)],
  ['claude', (b) => claudeChecks(b, base, check)],
  ['ask', (b) => askChecks(b, base, check)],
  ['commands', (b) => commandsChecks(b, site, check)],
  ['askFollowup', (b) => askFollowupChecks(b, base, check)],
  ['askStatus', (b) => askStatusChecks(b, base, check)],
  ['askEsc', (b) => askEscChecks(b, base, check)],
  ['consentFullscreen', (b) => consentFullscreenChecks(b, base, check)],
  ['welcomeScreen', (b) => welcomeScreenChecks(b, base, check)],
  ['chatScreen', (b) => chatScreenChecks(b, base, check)],
  ['phoneChat', (b) => phoneChatChecks(b, base, check)],
  ['share', (b) => shareChecks(b, base, site, check)],
  ['favicon', (b) => faviconChecks(b, site, check)],
];

(async () => {
  const names = GROUPS('', '').map(([n]) => n);
  // --list-groups: the group names, one per line, in run order (what --only takes; the CI shard check reads them)
  if (process.argv.includes('--list-groups')) { console.log(names.join('\n')); return; }
  const sel = lib.parseOnly(process.argv, names);
  if (sel.error) { console.error(sel.error); process.exitCode = 2; return; }
  ({ chromium } = require('playwright'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const site = `http://127.0.0.1:${server.address().port}/`;
  const base = `${site}play/`;
  let browser = await chromium.launch();
  try {
    for (const [name, fn] of GROUPS(base, site)) {
      if (sel.only && !sel.only.includes(name)) continue;
      const before = new Set(browser.contexts());
      await run.group(name, () => fn(browser), async () => {
        // what the group left open (all of it, when it threw part-way) is closed, so it can't run on into the next
        // group; a browser that went away is started again for the next group
        if (!browser.isConnected()) { browser = await chromium.launch(); return; }
        for (const c of browser.contexts()) if (!before.has(c)) await c.close();
      });
    }
    await run.group('missing files', async () => check('no request in the whole run asked for a missing file', !missing.size, [...missing].join(', ')));
  } finally {
    await browser.close();
    server.close();
    server.closeAllConnections();   // (kept-alive connections would hold the run open after its summary)
  }
  process.exitCode = run.summary();
})();
