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
const { readZip } = require('../js/media/zip.js');

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

    // a folder walk reaches take() the same way an archive does (from: "folder/"), so its programs load too
    const { panel: p2, captured: c2, onPrograms: op2 } = await makePanel();
    await p2.take([{ name: 'demo.bin', file: { name: 'demo.bin', arrayBuffer: async () => liza.buffer.slice(liza.byteOffset, liza.byteOffset + liza.byteLength) }, from: null }], { onPrograms: op2 });
    // (that is a loose file; the folder case is the browser check's job — here the archive case is what is unit-pinned)
    check('a loose program still goes to the loader (unchanged)', c2.programs.length === 1 && c2.programs[0] === 'demo.bin', JSON.stringify(c2.programs));
  }

  // ---- a ZIP holding a program AND a ROM-shaped image: the ROM goes in, the program loads ----
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

  // ---- without a program loader (the Add ROMs screen: all: true): a program in a ZIP is still not a ROM ----
  {
    const { session, panel, captured } = await makePanel({ onRoms: null });
    await panel.take([zipOf('game.zip', [['demo.bin', liza]])], { all: true, onPrograms: null });
    check('the Add ROMs screen (no program loader): a ZIP program is reported, not loaded',
      captured.reports.some((r) => r.ignored.length === 1 && r.ignored[0] === 'game.zip: demo.bin'), JSON.stringify(captured.reports.map((r) => r.ignored)));
    check('the Add ROMs screen: nothing went to a program loader', captured.programs.length === 0, JSON.stringify(captured.programs));
    check('the Add ROMs screen: no ROM was claimed', !session.machineRoms('dragon64').sockets.some((s) => s.crc), JSON.stringify(session.machineRoms('dragon64').sockets.map((s) => s.id + ':' + !!s.crc)));
  }

  // ---- Session.isRom on the archive's own entries: the routing's input, pinned where the guard lives ----
  {
    // a program file is not a ROM image by name or contents, whatever the drop's other files are
    check('Session.isRom: a DragonDOS program is not a ROM image', !Emu.Session.isRom('demo.bin', liza));
    check('Session.isRom: an 8K image with a usual ROM name is one', Emu.Session.isRom('d64_1.rom', fake(0x4000, 1)));
    check('Session.isRom: an 8K image of seeded bytes and no usual name is not (Add ROMs takes it by size anyway)', !Emu.Session.isRom('cart.rom', fake(8192, 0x22)));
  }

  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL the test itself threw:', e.stack); process.exitCode = 1; });
