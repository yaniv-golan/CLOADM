// The names docs/automation.md's "What is stable" table promises a headless script (the keyboard, emulated time, the Frame and
// framePng), imported through their public paths (js/emu.js, cli/cloadm.js) and checked for shape: a function's arity, a
// Frame's field types and sizes, framePng's PNG signature and size. Renaming or dropping one turns this red; so does a table
// that stops naming one. Not promoted (and so not tested here): machine.serialPort, pcWatch, stubKeys, the typist's internals.
// Only the project's own built-in firmware. Run: node tests/devapi-stable.test.js
'use strict';
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };

(async () => {
  const Emu = await import(pathToFileURL(path.join(ROOT, 'js/emu.js')).href);
  const cli = require(path.join(ROOT, 'cli/cloadm.js'));
  const doc = fs.readFileSync(path.join(ROOT, 'docs/automation.md'), 'utf8');
  const stable = doc.slice(doc.indexOf('### What is stable'), doc.indexOf('## Packaging'));

  const start = (id) => { const s = new Emu.Session({ welcomeMenu: false }); s.switchMachine(id, {}, { menu: false }); return s; };
  const d64 = start('dragon64'), coco = start('coco'), coco3 = start('coco3'), mc10 = start('mc10');
  d64.runFrames(3); coco.runFrames(3); coco3.runFrames(3); mc10.runFrames(3);

  // ---------------- the table names each promoted thing ----------------
  for (const name of ['machine.setKey(name, down)', 'Object.keys(machine.keyPos)', 'machine.frameCount', 'machine.now()', 'machine.tickHz',
    'machine.cpu.totalCycles', '`Frame`', '`width`', '`height`', '`aspect`', '`active`', '`data`', '`table`', 'framePng(frame, scale)', 'cli/cloadm.js'])
    check(`the stable table names ${name}`, stable.includes(name));
  check('the stable table lists what is not promoted: serialPort, pcWatch, stubKeys, the typist internals',
    /Not promoted[^\n]*\n?[^\n]*`machine\.serialPort`, `pcWatch`, `stubKeys`/.test(stable) && /typist/.test(stable.slice(stable.indexOf('Not promoted'))));

  // ---------------- keyboard ----------------
  for (const [id, s] of [['dragon64', d64], ['coco', coco], ['coco3', coco3], ['mc10', mc10]]) {
    const m = s.shownMachine, names = Object.keys(m.keyPos);
    check(`${id}: setKey is a function of two arguments`, typeof m.setKey === 'function' && m.setKey.length === 2);
    check(`${id}: keyPos has key names whose values are [row, column] pairs, and SPACE and ENTER are among the names`,
      names.length >= 40 && names.includes('SPACE') && names.includes('ENTER') && names.every((k) => Array.isArray(m.keyPos[k]) && m.keyPos[k].length === 2));
    const [r, c] = m.keyPos.SPACE, before = m.keyCols[c];
    m.setKey('SPACE', true);
    const down = m.keyCols[c];
    m.setKey('SPACE', false);
    check(`${id}: setKey(name, true) sets that key's bit in the matrix and setKey(name, false) clears it`, (down & (1 << r)) !== 0 && m.keyCols[c] === before);
    const snap = Array.from(m.keyCols);
    m.setKey('NOT A KEY', true);
    check(`${id}: an unknown key name does nothing`, Array.from(m.keyCols).every((v, i) => v === snap[i]));
  }

  // ---------------- emulated time ----------------
  for (const [id, s] of [['dragon64', d64], ['coco', coco], ['coco3', coco3], ['mc10', mc10]]) {
    const m = s.shownMachine, f0 = m.frameCount, t0 = m.now(), c0 = m.cpu.totalCycles;
    s.runFrames(2);
    check(`${id}: frameCount is a number that goes up by one a frame`, Number.isInteger(f0) && m.frameCount === f0 + 2);
    check(`${id}: now() is a function without arguments returning a number that goes up`, typeof m.now === 'function' && m.now.length === 0 && typeof t0 === 'number' && m.now() > t0);
    check(`${id}: tickHz is the clock's rate in Hz`, typeof m.tickHz === 'number' && m.tickHz > 800000 && m.tickHz < 8e6, String(m.tickHz));
    check(`${id}: cpu.totalCycles counts CPU cycles and goes up`, Number.isInteger(c0) && m.cpu.totalCycles > c0);
  }
  check('on the Dragon 64 the machine clock is the CPU cycle (they differ by the reset offset, a constant 4 cycles)', Math.abs(d64.shownMachine.now() - d64.shownMachine.cpu.totalCycles) <= 8, `${d64.shownMachine.now()} vs ${d64.shownMachine.cpu.totalCycles}`);
  const g3 = coco3.shownMachine, ratio = (g3.now() - 0) / g3.cpu.totalCycles;
  check('on the CoCo 3 the machine clock is the GIME\'s, 2 to 4 times the CPU cycle count (the CPU runs at two speeds)', ratio > 2 && ratio <= 4.01, String(ratio));

  // ---------------- Frame ----------------
  for (const [id, s] of [['dragon64', d64], ['coco', coco], ['coco3', coco3]]) {
    const fr = s.shownMachine.render();
    check(`${id}: render() gives a Frame with integer width and height and a numeric aspect`, Number.isInteger(fr.width) && Number.isInteger(fr.height) && fr.width > 0 && fr.height > 0 && typeof fr.aspect === 'number' && fr.aspect > 1);
    check(`${id}: Frame.data is a Uint8Array of one byte a pixel`, fr.data instanceof Uint8Array && fr.data.length === fr.width * fr.height);
    check(`${id}: Frame.table is a Uint32Array of 256 RGBA entries and every colour code in data has one`, fr.table instanceof Uint32Array && fr.table.length === 256 && fr.data.every((v) => v < 256));
    check(`${id}: Frame.active is null or { x, y, width, height } inside the frame`,
      fr.active === null || (['x', 'y', 'width', 'height'].every((k) => Number.isInteger(fr.active[k])) && fr.active.x + fr.active.width <= fr.width && fr.active.y + fr.active.height <= fr.height));
    check(`${id}: frameToRGBA(frame) turns data and table into one Uint32 a pixel`, typeof Emu.frameToRGBA === 'function' && Emu.frameToRGBA(fr).length === fr.width * fr.height);
  }
  check('the VDG\'s frame says where its picture sits (the Dragon 64\'s is 256x192 in the frame)', (() => { const a = d64.shownMachine.render().active; return a && a.width === 256 && a.height === 192; })());

  // ---------------- framePng ----------------
  check('framePng is exported by cli/cloadm.js as a function of one required argument', typeof cli.framePng === 'function' && cli.framePng.length === 1);
  const fr = d64.shownMachine.render(), png = cli.framePng(fr), png2 = cli.framePng(fr, 2);
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  check('framePng(frame) is a PNG: the signature, an IHDR the frame\'s size, 8-bit RGBA, and an IEND at the end',
    Buffer.isBuffer(png) && sig.every((b, i) => png[i] === b) && png.toString('latin1', 12, 16) === 'IHDR' && png.readUInt32BE(16) === fr.width && png.readUInt32BE(20) === fr.height
    && png[24] === 8 && png[25] === 6 && png.toString('latin1', png.length - 8, png.length - 4) === 'IEND');
  check('framePng(frame, 2) is the same picture twice the size across and down', sig.every((b, i) => png2[i] === b) && png2.readUInt32BE(16) === 2 * fr.width && png2.readUInt32BE(20) === 2 * fr.height);

  console.log(fail ? `${fail} FAILED` : `${n}/${n} devapi-stable checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
