// Run: node tests/zip-programs.test.js
//
// A ZIP of programs opened through Open… or a drop on the page loaded nothing and said "No ROMs could be
// used. Not ROMs: game.zip: liza.bin", although OPENS_TEXT (js/session.js) says CLOADM opens "programs
// (.bin, .bas, .txt) … and ZIPs of these". The rom panel's take() sorted every entry from an archive as
// either a ROM candidate or "other", and only `other` entries with no `from` (loose files) were ever given
// to the program loader — an archive's programs went to report.ignored ("Not ROMs") instead.
// rom-panel.js is DOM-bound, so take() is driven here in Node with the page stub view-order.test.js uses:
// a real Session classifies the entries (isRom, addRoms), and the ZIPs are real archives (js/media/zip.js).
// The browser check (group romInput) drives the same routing through the real page: a ZIP of liza.bin loads
// LIZA through Open…, a drop and a phone's Open…, and the Add ROMs screen still says "isn't a ROM image".
// Every image here is synthetic (seeded bytes) or our own example program; no real ROM is used.
const path = require('path');
const Emu = require('./load')();
const { writeZip } = require('../js/media/zip.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };

// ---- the DOM stub (view-order.test.js's: only what setupRomPanel's scope touches) ----
const mk = (id = '') => ({ id, hidden: false, classList: { contains: () => false, toggle() {}, add() {}, remove() {} },
  focus() {}, getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0 }), append() {}, appendChild() {},
  replaceChildren() {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute: () => null,
  style: {}, dataset: {}, querySelector: () => null, querySelectorAll: () => [], scrollIntoView() {}, textContent: '',
  innerHTML: '', value: '', checked: false, firstChild: null, removeAttribute() {}, insertBefore() {}, cloneNode: () => mk(id) });
const els = new Map();
globalThis.document = { getElementById: (id) => { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); },
  body: mk(), documentElement: mk(), createElement: () => mk(), createTextNode: () => mk(), querySelector: () => null,
  querySelectorAll: () => [], addEventListener() {} };
globalThis.location = { hash: '', href: 'http://localhost/play/', pathname: '/play/', search: '' };

// ---- a panel whose reports we capture: the Session, page and feedback are faked only where take() reads them ----
async function makePanel({ onRoms } = {}) {
  const session = new Emu.Session({ store: Emu.memoryStore() });
  session.switchMachine('dragon64');
  for (let i = 0; i < 3; i++) session.shownMachine.runFrame();
  // addRoms must really run: it is what fills sockets and files the report from (identifyRoms), and the fix must
  // not change what it does with ROM candidates. personMachine is the Dragon 64: a 8K or 16K image fits it by size.
  const captured = { reports: [], programs: [], statuses: [] };
  const page = {
    session,
    status: (text, error) => captured.statuses.push({ text, error }),
    toast: (text, opts) => captured.statuses.push({ text, details: opts && opts.details }),
    // keepStorage is asked after the first ROMs land: answer nothing, as a browser that has not decided would
    keepStorage: async () => null,
    feedback: { current: null },
    focus() {},
    attempt: (fn) => fn(),
  };
  const { setupRomPanel } = await import(path.join(__dirname, '../js/ui/rom-panel.js'));
  const panel = setupRomPanel(page);
  panel.onChange((report) => captured.reports.push(report));
  const onPrograms = onRoms === undefined ? (items) => captured.programs.push(...items.map((f) => f.name)) : onRoms;
  return { session, panel, captured, onPrograms };
}

// a File for take(): what droppedFiles()/pickedFiles() produce (item.file is the browser File)
const fileOf = (name, bytes) => ({ name, file: { name, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } });
const zipOf = (name, entries) => ({ name, file: { name, arrayBuffer: async () => {
  const { writeZip } = require('../js/media/zip.js');
  const b = writeZip(entries.map(([n, d]) => ({ name: n, data: d })));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
} } });

// seeded bytes (tools/browser-check.js's fake): a size-known image with no known CRC and no usual name
const fake = (size, seed) => { const b = new Uint8Array(size); let x = seed >>> 0; for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; } return b; };
// a real program of ours: LIZA (a DragonDOS binary, loadable by the stub). The routing must not depend on
// which program it is, only that it is not a ROM image.
const liza = new Uint8Array(require('node:fs').readFileSync(path.join(__dirname, '../examples/liza.bin')));

(async () => {
  // ---- with a program loader (the page's Open… and every drop on the screen): the ZIP's program loads ----
  {
    const { session, panel, captured, onPrograms } = await makePanel();
    await panel.take([zipOf('game.zip', [['demo.bin', liza]])], { onPrograms });
    check('a ZIP of one program through a drop path (onPrograms): the program goes to the loader',
      captured.programs.length === 1 && captured.programs[0] === 'demo.bin', JSON.stringify(captured.programs));
    check('a ZIP of one program through a drop path: no "Not ROMs" report for it',
      !captured.reports.some((r) => r.ignored.length), JSON.stringify(captured.reports.map((r) => r.ignored)));
    check('a ZIP of one program through a drop path: nothing was said as a ROM summary (no ROMs, no failures)',
      captured.statuses.length === 0, JSON.stringify(captured.statuses));

    // a loose program file (from: null) still goes to the loader, as it always did
    const { panel: p2, captured: c2, onPrograms: op2 } = await makePanel();
    await p2.take([fileOf('demo.bin', liza)], { onPrograms: op2 });
    check('a loose program still goes to the loader (unchanged)', c2.programs.length === 1 && c2.programs[0] === 'demo.bin', JSON.stringify(c2.programs));
    // a program out of a dragged FOLDER (from: "MyROMs/", the shape expand() gives a walked folder's files)
    // loads too: the CHANGELOG claims it, so it is pinned here, not left to the archive case's code path
    const { panel: p3, captured: c3, onPrograms: op3 } = await makePanel();
    await p3.take([{ name: 'demo.bin', file: { name: 'demo.bin', arrayBuffer: async () => liza.buffer.slice(liza.byteOffset, liza.byteOffset + liza.byteLength) }, from: 'MyROMs/' }], { onPrograms: op3 });
    check('a program out of a dragged folder goes to the loader (the same from-tagged path as a ZIP)',
      c3.programs.length === 1 && c3.programs[0] === 'demo.bin', JSON.stringify(c3.programs));
  }

  // ---- a ZIP of a program AND a ROM-shaped image: the ROM goes in, the program loads ----
  {
    const { session, panel, captured, onPrograms } = await makePanel();
    // Session.isRom's own bar, as the brief defines it: a usual ROM file name (d64_1.rom) with patterned bytes.
    // No known CRC, nothing from local/: the name is what a real dump usually carries, the bytes are seeded.
    const rom = fake(16384, 0x21);
    await panel.take([zipOf('mix.zip', [['prog.bin', liza], ['d64_1.rom', rom]])], { onPrograms });
    const sockets = session.machineRoms('dragon64').sockets;
    check('a ZIP of a program and a ROM image: the ROM goes into a socket it fits',
      sockets.some((s) => s.crc && s.size === 16384), JSON.stringify(sockets.map((s) => ({ id: s.id, crc: !!s.crc, size: s.size }))));
    check('a ZIP of a program and a ROM image: the program still goes to the loader',
      captured.programs.length === 1 && captured.programs[0] === 'prog.bin', JSON.stringify(captured.programs));
    check('a ZIP of a program and a ROM image: the ROM is reported as added, not as a failure',
      !captured.statuses.some((s) => /No ROMs could be used/.test(s.text)), JSON.stringify(captured.statuses.map((s) => s.text)));
  }

  // ---- a README in a ZIP of ROMs is still "Not ROMs", not a load error per file ----
  // The loader refuses what it cannot open one file at a time ("unknown format"), which is its answer for a
  // file someone meant to load; a readme riding along in a folder or archive of ROMs is not that. It keeps the
  // report a drop of ROMs makes (romInput's pinned "Not ROMs: MyROMs/readme.txt" and "Not ROMs: roms.zip: info.txt").
  {
    const { session, panel, captured, onPrograms } = await makePanel();
    const rom = fake(16384, 0x21);
    const notes = new TextEncoder().encode('notes');
    await panel.take([zipOf('roms.zip', [['d64_1.rom', rom], ['readme.txt', notes]])], { onPrograms });
    check('a ZIP of a ROM and a readme through a drop path: the ROM goes in, the readme stays "Not ROMs"',
      captured.reports.some((r) => r.ignored.length === 1 && r.ignored[0] === 'roms.zip: readme.txt')
      && session.machineRoms('dragon64').sockets.some((s) => s.crc), JSON.stringify(captured.reports.map((r) => r.ignored)));
    check('a ZIP of a ROM and a readme: the readme never reaches the program loader',
      !captured.programs.includes('readme.txt'), JSON.stringify(captured.programs));
    // a snapshot is openable (gzip/JSON is looksLikeSnapshot), so a ZIP of snapshots loads them
    const { panel: p3, captured: c3, onPrograms: op3 } = await makePanel();
    const gzip = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0x03]);
    await p3.take([zipOf('snaps.zip', [['save.cloadm', gzip]])], { onPrograms: op3 });
    check('a ZIP of a snapshot goes to the loader (it is not raw junk)',
      c3.programs.length === 1 && c3.programs[0] === 'save.cloadm', JSON.stringify(c3.programs));
  }

  // ---- without a program loader (the Add ROMs screen: all: true): a program in a ZIP is still not a ROM ----
  {
    const { session, panel, captured } = await makePanel({ onRoms: null });
    await panel.take([zipOf('game.zip', [['demo.bin', liza]])], { all: true, onPrograms: null });
    check('the Add ROMs screen (no program loader): a ZIP program is reported, not loaded',
      captured.reports.some((r) => r.ignored.length === 1 && r.ignored[0] === 'game.zip: demo.bin'), JSON.stringify(captured.reports.map((r) => r.ignored)));
    check('the Add ROMs screen: nothing went to a program loader', captured.programs.length === 0, JSON.stringify(captured.programs));
    check('the Add ROMs screen: no ROM was claimed', !session.machineRoms('dragon64').sockets.some((s) => s.crc), JSON.stringify(session.machineRoms('dragon64').sockets.map((s) => s.id + ':' + !!s.crc)));
  }

  // ---- a .rom that is not a ROM image, inside a ZIP: reported, never loaded as a cartridge ----
  // detectMedia calls any .rom up to 128K a cartridge (js/media/formats.js identify), so without this rule the
  // openable() gate sent an unrecognised ROM dump from a ZIP to the program loader, whose cart case plugs it
  // into the cartridge slot — a machine's BASIC in the slot, the same trap the open-rom fix closed
  // (js/session.js load()'s own guard catches only what Session.isRom recognises, and a dump with no known CRC
  // and no usual name is not one of those). The .rom is seeded bytes under a plausible name: synthetic only.
  // This case's onPrograms is a REAL loader (it calls session.load), so the cartridge-slot assertions below can
  // genuinely fail; the other cases use the recording stub, which pins the routing alone.
  {
    const { session, panel, captured, onPrograms } = await makePanel();
    const rom = fake(16384, 0x35);   // 16K, no known CRC, no usual name: detectMedia kind 'cart'
    // a REAL loader (it calls session.load) so the cartridge-slot assertion below can genuinely fail; it also
    // records what it was given, so the routing checks read the same captured.programs as every other case
    const loadIt = async (items) => { for (const f of items) { captured.programs.push(f.name); try { session.load(f.name, f.bytes); } catch (e) { captured.statuses.push('load threw: ' + e.message); } } };
    await panel.take([zipOf('mix.zip', [['prog.bin', liza], ['Dragon 64 BASIC.rom', rom]])], { onPrograms: loadIt });
    const sockets = session.machineRoms('dragon64').sockets;
    check('a ZIP of a program and an unrecognised .rom: the .rom never reaches the program loader',
      captured.programs.length === 1 && captured.programs[0] === 'prog.bin', JSON.stringify(captured.programs));
    check('a ZIP of a program and an unrecognised .rom: it is reported "Not ROMs" as before',
      captured.reports.some((r) => r.ignored.length === 1 && r.ignored[0] === 'mix.zip: Dragon 64 BASIC.rom'),
      JSON.stringify(captured.reports.map((r) => r.ignored)));
    check('a ZIP of a program and an unrecognised .rom: no socket took it and no ROM was claimed',
      !sockets.some((s) => s.crc), JSON.stringify(sockets.map((s) => s.id + ':' + !!s.crc)));
    // the cartridge slot: this case's loader is real, so a wrong routing WOULD have plugged the .rom in as a
    // Program Pak — this assert can fail, and the mutant proves it does
    const cart = session.shownMachine.cartPort;
    check('a ZIP of a program and an unrecognised .rom: the cartridge slot is empty',
      !cart, String(cart && cart.name));
    // the folder's .rom rides the same from-tagged path, with a real loader as well
    const { session: s2, panel: p2, captured: c2, onPrograms: op2 } = await makePanel();
    const loadIt2 = async (items) => { for (const f of items) { c2.programs.push(f.name); try { s2.load(f.name, f.bytes); } catch (e) { c2.statuses.push('load threw: ' + e.message); } } };
    await p2.take([{ name: 'basic.rom', file: { name: 'basic.rom', arrayBuffer: async () => rom.buffer.slice(rom.byteOffset, rom.byteOffset + rom.byteLength) }, from: 'MyROMs/' }], { onPrograms: loadIt2 });
    check('a folder\'s unrecognised .rom goes to the report too, not the loader',
      c2.programs.length === 0 && c2.reports.some((r) => r.ignored.length === 1 && r.ignored[0] === 'MyROMs/basic.rom')
        && !s2.machineRoms('dragon64').sockets.some((s) => s.crc) && !s2.shownMachine.cartPort,
      JSON.stringify({ programs: c2.programs, ignored: c2.reports.map((r) => r.ignored) }));
    // a LOOSE .rom keeps today's behaviour: it goes to the loader, and the loader plugs it in as a Program Pak
    // (this case's loader is real, so the cartridge really appears — the routing mutant for the loose case is
    // the routing filter made from-tagged-only, which must leave THIS case green while reddening the ZIP one)
    {
      const { session: s3, panel: p3, captured: c3, onPrograms: op3 } = await makePanel();
      const loadIt3 = async (items) => { for (const f of items) { c3.programs.push(f.name); try { s3.load(f.name, f.bytes); } catch (e) { c3.statuses.push('load threw: ' + e.message); } } };
      await p3.take([fileOf('game.rom', fake(8192, 0x36))], { onPrograms: loadIt3 });
      const cart3 = s3.shownMachine.cartPort;
      check('a loose .rom keeps today\'s behaviour: it goes to the loader',
        c3.programs.length === 1 && c3.programs[0] === 'game.rom', JSON.stringify(c3.programs));
      check('a loose .rom still loads as a cartridge (the loader plugged it in)',
        !!(cart3 && cart3.name === 'Program Pak'), String(cart3 && cart3.name));
    }
    // the content rule: a .rom whose CONTENT CLOADM recognises routes by its content, from a ZIP as loose —
    // a WAV tape renamed .rom (identify: kind 'wav' by its RIFF bytes, not 'cart') goes to the loader
    {
      const { panel: p5, captured: c5, onPrograms: op5 } = await makePanel();
      const wavRom = new Uint8Array([0x52, 0x49, 0x46, 0x46, 10, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
      await p5.take([zipOf('tapes.zip', [['tape.rom', wavRom]])], { onPrograms: op5 });
      check('a WAV named .rom out of a ZIP goes to the loader (its content is a tape, not a cartridge)',
        c5.programs.length === 1 && c5.programs[0] === 'tape.rom', JSON.stringify(c5.programs));
      check('a WAV named .rom out of a ZIP is never reported "Not ROMs"',
        !c5.reports.some((r) => r.ignored.length), JSON.stringify(c5.reports.map((r) => r.ignored)));
    }
    // a snapshot renamed .rom does NOT load by content, and the CHANGELOG must not claim it does: identify
    // calls a .rom up to 128K a cart whatever its bytes are (the extension rule fires on the file's size, and
    // gzip compresses small), so romShaped excludes it and looksLikeSnapshot never runs. Pinned so the
    // sentence in the bullet stays honest; the .cloadm-named snapshot case above is the one that loads.
    {
      const { session: s5b, panel: p5b, captured: c5b, onPrograms: op5b } = await makePanel();
      const loadIt5b = async (items) => { for (const f of items) { c5b.programs.push(f.name); try { s5b.load(f.name, f.bytes); } catch (e) { c5b.statuses.push('load threw: ' + e.message); } } };
      const gzip = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0x03]);
      await p5b.take([zipOf('snaps.zip', [['save.rom', gzip]])], { onPrograms: loadIt5b });
      check('a snapshot renamed .rom out of a ZIP is reported like any other cart-shaped .rom',
        c5b.programs.length === 0 && c5b.reports.some((r) => r.ignored.length === 1 && r.ignored[0] === 'snaps.zip: save.rom')
          && !s5b.shownMachine.cartPort,
        JSON.stringify({ programs: c5b.programs, ignored: c5b.reports.map((r) => r.ignored) }));
    }
    // uppercase: 8.3 archives commonly carry GAME.ROM, and the extension test must be case-insensitive
    {
      const { session: s6, panel: p6, captured: c6, onPrograms: op6 } = await makePanel();
      const loadIt6 = async (items) => { for (const f of items) { c6.programs.push(f.name); try { s6.load(f.name, f.bytes); } catch (e) { c6.statuses.push('load threw: ' + e.message); } } };
      await p6.take([zipOf('upper.zip', [['GAME.ROM', fake(16384, 0x39)]])], { onPrograms: loadIt6 });
      check('an uppercase GAME.ROM out of a ZIP is reported "Not ROMs", never loaded',
        c6.programs.length === 0 && c6.reports.some((r) => r.ignored.length === 1 && r.ignored[0] === 'upper.zip: GAME.ROM')
          && !s6.shownMachine.cartPort,
        JSON.stringify({ programs: c6.programs, ignored: c6.reports.map((r) => r.ignored) }));
    }
    // the boundary: .ccc and .dgn from an archive still go to the loader — those extensions name cartridge
    // images and nothing else, so they are cartridges by their own declaration. A .ccc too big for the slot
    // (formats.identify caps a cart at 128K) would be raw, so an 8K image keeps this about the extension alone.
    {
      const { panel: p4, captured: c4, onPrograms: op4 } = await makePanel();
      const ccc = fake(8192, 0x37);
      await p4.take([zipOf('carts.zip', [['game.ccc', ccc]])], { onPrograms: op4 });
      check('a .ccc out of a ZIP still goes to the loader (cartridge by its own extension)',
        c4.programs.length === 1 && c4.programs[0] === 'game.ccc', JSON.stringify(c4.programs));
      check('a .ccc out of a ZIP is never reported "Not ROMs"',
        !c4.reports.some((r) => r.ignored.length), JSON.stringify(c4.reports.map((r) => r.ignored)));
    }
  }

  // ---- a .txt that looks like a BASIC listing, inside a ZIP: loads as a program (looksLikeBasicText) ----
  {
    const { panel, captured, onPrograms } = await makePanel();
    const listing = new TextEncoder().encode('10 PRINT "HI"\n20 GOTO 10\n');
    await panel.take([zipOf('listing.zip', [['game.txt', listing]])], { onPrograms });
    check('a .txt out of a ZIP that looks like a BASIC listing goes to the loader',
      captured.programs.length === 1 && captured.programs[0] === 'game.txt', JSON.stringify(captured.programs));
    check('a .txt listing out of a ZIP is never reported "Not ROMs"',
      !captured.reports.some((r) => r.ignored.length), JSON.stringify(captured.reports.map((r) => r.ignored)));
  }

  {
    // a program file is not a ROM image by name or contents, whatever the drop's other files are
    check('Session.isRom: a DragonDOS program is not a ROM image', !Emu.Session.isRom('demo.bin', liza));
    check('Session.isRom: an 8K image with a usual ROM name is one', Emu.Session.isRom('d64_1.rom', fake(0x4000, 1)));
    check('Session.isRom: an 8K image of seeded bytes and no usual name is not (Add ROMs takes it by size anyway)', !Emu.Session.isRom('cart.rom', fake(8192, 0x22)));
    // the trap itself, pinned where it lives: detectMedia calls the same bytes a cartridge by their extension,
    // which is why the panel's gate — not detectMedia — is what keeps an archive's unrecognised .rom out
    check('detectMedia: an unrecognised .rom is detected as a cartridge (the trap the panel guards against)',
      require('../js/media/detect.js').detectMedia('basic.rom', fake(8192, 0x38)).kind === 'cart',
      require('../js/media/detect.js').detectMedia('basic.rom', fake(8192, 0x38)).kind);
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL the test itself threw:', e.stack); process.exitCode = 1; });
