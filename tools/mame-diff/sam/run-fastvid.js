#!/usr/bin/env node
// SAM fast rate (R1) video: node tools/mame-diff/sam/run-fastvid.js [profile]
//
// Runs fastvid.asm (a text screen at the slow rate, then R1 set for good) in MAME and in ours. MAME 0.264
// keeps the VDG's display at any rate (https://mametesters.org/view.php?id=6774), so with config.mameCompat
// our frames at the fast rate must equal those at the slow rate, as MAME's do: MAME's bitmap is compared
// with itself, ours with itself, bit for bit (the text mode itself is compared with MAME by run-vdg.js).
// Without mameCompat (the data sheet model) the fast rate must change the picture and keep it the same in
// every field (the loop divides a field; see fastvid.asm). The fast-rate picture has no automatic oracle:
// XRoar is the second opinion, by screenshot (docs/verification.md, "SAM CPU rate").
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '../../..');
const Emu = require(path.join(ROOT, 'tests/load.js'))();
const spec = require('./spec.js');
const { runMame } = require('../lib/mame');
const { workDir } = require('../lib/workdir');

const PROFILE_ID = process.argv[2] || 'dragon64';
const WORK = workDir(`${PROFILE_ID}-fastvid`);
const SLOW = 20, FAST = [97, 98, 99];   // frames: well inside the slow second, and after R1 is set
const t = spec.rate(PROFILE_ID, { file: 'fastvid.asm', work: WORK });
t.install();
fs.mkdirSync(path.join(WORK, 'out'), { recursive: true });

runMame({ work: WORK, system: t.system, seconds: 3, args: [...t.args, '-frameskip', '0', '-noautoframeskip'], lua: `
local scr = nil
for tag, s in pairs(manager.machine.screens) do scr = s end
local n = 0
local want = { [${SLOW}] = true, ${FAST.map((f) => `[${f}] = true`).join(', ')} }
emu.register_frame_done(function()
  n = n + 1
  if want[n] then
    local px, w, h = scr:pixels()
    local f = io.open(string.format("${WORK}/out/f%d.raw", n), "wb")
    f:write(px); f:close()
  end
end)
` });
const mame = (f) => { const p = path.join(WORK, 'out', `f${f}.raw`); return fs.existsSync(p) ? fs.readFileSync(p) : null; };
const ours = (compat) => {
  const m = t.machine({ mameCompat: compat }), got = {};
  for (let f = 1; f <= FAST[FAST.length - 1]; f++) { m.runFrame(); if (f === SLOW || FAST.includes(f)) got[f] = Buffer.from(Emu.frameToRGBA(m.render()).buffer); }
  return { got, rate: m.sam.rate };
};

let fail = 0;
const check = (name, ok) => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); };
const ms = mame(SLOW);
check('MAME captured the frames', ms && FAST.every((f) => mame(f)));
if (ms) check(`MAME: fast-rate frames ${FAST.join(', ')} identical to slow-rate frame ${SLOW} (screen intact)`, FAST.every((f) => mame(f) && mame(f).equals(ms)));
const c = ours(true);
check(`ours, mameCompat: rate ${c.rate} at the end; fast-rate frames identical to frame ${SLOW}`, c.rate === 2 && FAST.every((f) => c.got[f].equals(c.got[SLOW])));
const h = ours(false);
check('ours, hardware model: fast-rate frames differ from the slow-rate frame', FAST.every((f) => !h.got[f].equals(h.got[SLOW])));
check('ours, hardware model: the fast-rate picture is the same in every field', FAST.every((f) => h.got[f].equals(h.got[FAST[0]])));
fs.rmSync(WORK, { recursive: true, force: true });
console.log(`[${PROFILE_ID} fastvid.asm] ${fail ? `${fail} FAILED` : 'all checks passed'}`);
process.exitCode = fail ? 1 : 0;
