#!/usr/bin/env node
// SAM display-counter probe (the V=1 text question): compare which video-memory bytes the
// SAM fetches, ours against MAME's, at SAM V 0 and V 1.
//
//   node tools/mame-diff/sam/run-samv.js [<profile> ...]     (default: dragon64 dragon200e)
//
// samv.asm puts a byte tagged with its address at every display address and shows the same range at V=0 and
// V=1 in text mode, so the picture encodes the fetched addresses directly (see the firmware's header). Both
// emulators capture each phase's settled picture 12 fields into its 20; every pixel of the active area is
// compared through a colour map learned from the pictures (MAME's palette values are its own). The firmware
// flips a byte that draws black either way every field, so MAME redraws both of its screen bitmaps each field
// and the capture never holds a stale one.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '../../..');
const Emu = require(path.join(ROOT, 'tests/load.js'))();
const { runMame } = require('../lib/mame');
const { writeRoms } = require('../lib/firmware');
const spec = require('./spec');

const PHASE = 0x7000;
const ARTIFACT = process.env.ARTIFACT === undefined ? 1 : +process.env.ARTIFACT;
let fail = 0;
const check = (name, ok, detail = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${detail}`); };

for (const id of process.argv.slice(2).length ? process.argv.slice(2) : ['dragon64', 'dragon200e']) {
  const profile = Emu.profiles[id], t = spec.samv(id);
  const work = `/tmp/mame-diff/samv-${id}`;
  fs.rmSync(work, { recursive: true, force: true });
  writeRoms(work, profile.mame, t.files);
  if (t.inverse !== null) spec.inverseCfg(work, profile.mame, t.inverse);
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

  const pictures = {};
  for (const [ph, name] of [[1, 'V=0'], [2, 'V=1']]) {
    const file = path.join(work, 'out', `phase${String(ph).padStart(2, '0')}.raw`);
    if (!fs.existsSync(file) || !ours[ph]) { check(`${id} ${name}: capture`, false, 'missing'); continue; }
    const buf = fs.readFileSync(file);
    const nl = buf.indexOf(10);
    const [mw, mh] = buf.slice(0, nl).toString().split(' ').map(Number);
    const mp = new Uint32Array(buf.buffer.slice(buf.byteOffset + nl + 1, buf.byteOffset + buf.length));
    const yoff = mh >= 290 ? 50 : 25;
    const M = (x, y) => mp[(yoff + y) * mw + 58 + x] & 0xFFFFFF;
    const O = (x, y) => ours[ph][(Emu.MC6847.BORDER_Y + y) * Emu.MC6847.WIDTH + Emu.MC6847.BORDER_X + x] & 0xFFFFFF;
    // the colour map by majority vote, one to one
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
    pictures[ph] = ours[ph];
  }
  // not vacuous: V=1 fetches other bytes than V=0, so the two pictures must differ
  if (pictures[1] && pictures[2]) {
    let d = 0;
    for (let i = 0; i < pictures[1].length; i++) if (pictures[1][i] !== pictures[2][i]) d++;
    check(`${id}: the V=0 and V=1 pictures differ`, d > 0, `${d} px`);
  }
  if (!process.env.KEEP) fs.rmSync(work, { recursive: true, force: true });
}
console.log(fail ? `${fail} FAILED` : 'SAM counter probe passed');
process.exitCode = fail ? 1 : 0;
