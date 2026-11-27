#!/usr/bin/env node
// The moved text page against MAME: every pixel of phases 1-4 of movedtext.asm (the default page $0400, the page
// moved to $0E00 and to $1C00 through the SAM's display offset, and INT/EXT high over $1C00), ours against MAME's.
//
//   node tools/mame-diff/run.js <profile> --video --movedtext     (or: node tools/mame-diff/sam/run-movedtext.js <profile> ...)
//
// This is the oracle for the screen-text readers on a moved page (tests/moved-text-page.test.js): it proves that
// the picture of each phase - and so what the machine shows - is MAME's, and that test proves the readers return
// exactly the text that picture shows. Both emulators capture each phase's settled picture 12 fields into its 20
// (the firmware's toggle cell makes every field a redraw: movedtext.js). The colour map is learned from the pictures
// by majority vote, one to one (MAME's palette values are its own). Phase 5 (a graphics mode) is not compared: the
// toggle cell would show there, and the VDG's graphics modes are run-vdg.js's comparison.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '../../..');
const Emu = require(path.join(ROOT, 'tests/load.js'))();
const { runMame } = require('../lib/mame');
const { writeRoms } = require('../lib/firmware');
const { workDir, keepWorkDir } = require('../lib/workdir');
const spec = require('./spec');
const { PHASE } = require('./movedtext');

const ARTIFACT = process.env.ARTIFACT === undefined ? 1 : +process.env.ARTIFACT;
const NAMES = { 1: 'default page $0400 (F = 2)', 2: 'moved to $0E00 (F = 7)', 3: 'moved to $1C00 (F = 14)', 4: '$1C00, INT/EXT high' };
let fail = 0;
const check = (name, ok, detail = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${detail}`); };

for (const id of process.argv.slice(2).length ? process.argv.slice(2) : ['dragon64', 'coco2b']) {
  const profile = Emu.profiles[id], t = spec.movedtext(id);
  const work = workDir(`movedtext-${id}`);
  writeRoms(work, profile.mame, t.files);
  fs.mkdirSync(path.join(work, 'out'), { recursive: true });
  runMame({ work, system: profile.mame, seconds: 12, args: [...t.args, '-frameskip', '0', '-noautoframeskip'], lua: `
manager.machine.ioport.ports[":vdg:artifacting"].fields["Artifacting"].user_value = ${ARTIFACT}
local space = manager.machine.devices[":maincpu"].spaces["program"]
local scr = nil
for tag, s in pairs(manager.machine.screens) do scr = s end
local last, wait = -1, -1
emu.register_frame_done(function()
  local ph = space:read_u8(${PHASE})
  if ph ~= last then last = ph; wait = 12 end
  if wait > 0 then wait = wait - 1
  elseif wait == 0 then
    wait = -1
    local px, w, h = scr:pixels()
    local f = io.open(string.format("${work}/out/phase%02d.raw", ph), "wb")
    f:write(string.format("%d %d\\n", w, h)); f:write(px); f:close()
  end
end)
` });

  const m = t.machine();
  m.vdg.artifact = ARTIFACT;
  const ours = {};
  let last = -1, wait = -1;
  for (let f = 0; f < 300; f++) {
    m.runFrame();
    const ph = m.ram[PHASE];
    if (ph !== last) { last = ph; wait = 12; }
    if (wait > 0) wait--;
    else if (wait === 0) { wait = -1; ours[ph] = Emu.frameToRGBA(m.render()); }
  }
  check(`${id}: the firmware reached HALT`, m.cpu.pc === t.halt, `pc $${m.cpu.pc.toString(16)}`);

  for (const ph of [1, 2, 3, 4]) {
    const name = NAMES[ph];
    const file = path.join(work, 'out', `phase${String(ph).padStart(2, '0')}.raw`);
    if (!fs.existsSync(file) || !ours[ph]) { check(`${id} ${name}: capture`, false, 'missing'); continue; }
    const buf = fs.readFileSync(file);
    const nl = buf.indexOf(10);
    const [mw, mh] = buf.slice(0, nl).toString().split(' ').map(Number);
    const mp = new Uint32Array(buf.buffer.slice(buf.byteOffset + nl + 1, buf.byteOffset + buf.length));
    const yoff = mh >= 290 ? 50 : 25;
    const M = (x, y) => mp[(yoff + y) * mw + 58 + x] & 0xFFFFFF;
    const O = (x, y) => ours[ph][(Emu.MC6847.BORDER_Y + y) * Emu.MC6847.WIDTH + Emu.MC6847.BORDER_X + x] & 0xFFFFFF;
    const votes = new Map();
    for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) { const k = M(x, y) + ':' + O(x, y); votes.set(k, (votes.get(k) || 0) + 1); }
    const map = new Map(), used = new Set();
    for (const [k] of [...votes.entries()].sort((a, b) => b[1] - a[1])) {
      const [mc, oc] = k.split(':').map(Number);
      if (!map.has(mc) && !used.has(oc)) { map.set(mc, oc); used.add(oc); }
    }
    let bad = 0, first = null;
    for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) if (map.get(M(x, y)) !== O(x, y)) { bad++; if (!first) first = [x, y]; }
    check(`${id} ${name}: every pixel identical`, bad === 0, bad ? `${bad} of 49152 differ, first at (${first})` : '49152 pixels');
    if (bad) keepWorkDir(work, 'the captures');
  }
  // not vacuous: the three pages hold different text, so their pictures differ
  for (const [a, b] of [[1, 2], [2, 3]]) {
    if (!ours[a] || !ours[b]) continue;
    let d = 0;
    for (let i = 0; i < ours[a].length; i++) if (ours[a][i] !== ours[b][i]) d++;
    check(`${id}: phases ${a} and ${b} differ`, d > 0, `${d} px`);
  }
}
console.log(fail ? `${fail} FAILED` : 'moved text page: identical');
process.exitCode = fail ? 1 : 0;
