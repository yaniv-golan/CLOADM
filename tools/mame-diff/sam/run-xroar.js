#!/usr/bin/env node
// Compare our SAM-family timing with XRoar, instruction by instruction, on our own firmware.
//
//   XROAR=/path/to/xroar node tools/mame-diff/sam/run-xroar.js [rate|ops|diag] [--instructions N]
//
// XRoar (Ciaran Anscomb, https://www.6809.org.uk/xroar/) emulates the SAM's MPU rates per bus cycle, which
// MAME 0.264 does not (it runs any non-zero rate at full speed everywhere). Built headless from its source
// (./configure --without-gtk3 --without-gtk2 --without-sdl2 --without-sdl3 --without-x ...; tested with
// 1.13), its trace (-trace -trace-timing) prints each instruction with dt= in crystal clocks (14.31818 MHz),
// 16 per slow cycle. We run the same firmware as the Dragon 64 BASIC ROMs on both, with config.mameCompat off
// (the hardware model), and require the same instruction sequence and the same dt for every instruction.
// Development tool only: XRoar is never part of CLOADM.
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const spec = require('./spec.js');

const XROAR = process.env.XROAR;
if (!XROAR || !fs.existsSync(XROAR)) { console.error('set XROAR to an XRoar binary (see the comment at the top)'); process.exitCode = 2; }
const which = ['diag', 'ops'].includes(process.argv[2]) ? process.argv[2] : 'rate';
const opt = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const LIMIT = opt('--instructions', 400000);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'xroar-fw-'));
const t = which !== 'diag' ? spec.rate('dragon64', { config: { mameCompat: false }, file: `${which}.asm` })
  : spec.trace('dragon64', { regenerate: false, config: { mameCompat: false }, work });
const files = t.files || (() => {
  t.install();
  const d = path.join(work, 'roms', t.system);
  return Object.fromEntries(fs.readdirSync(d).map((f) => [f, fs.readFileSync(path.join(d, f))]));
})();
fs.rmSync(work, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xroar-roms-'));
for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), data);

// XRoar: run for 3 emulated seconds with timing trace
const out = path.join(dir, 'trace.txt');
cp.execFileSync('sh', ['-c', `"${XROAR}" -ui null -ao null -machine dragon64 -no-machine-cart -rompath "${dir}" -trace -trace-timing -timeout 3 > "${out}" 2>/dev/null`], { stdio: 'ignore', timeout: 300000 });
const xr = [];
for (const l of fs.readFileSync(out, 'utf8').split('\n')) {
  if (!/^[0-9a-f]{4}\| /.test(l)) continue;
  const m = l.match(/dt=(-?\d+)/);
  xr.push({ pc: parseInt(l.slice(0, 4), 16), dt: m ? +m[1] : NaN, text: l.slice(0, 48).trim(), irq: /\[[A-Z0-9]+\]/.test(l) });
}
fs.rmSync(dir, { recursive: true });

// ours: time per instruction in crystal clocks
const m = t.machine({ mameCompat: false });
const ours = [];
let last = null;
m.cpu.trace = (c) => { const now = m.cycle; if (last) last.dt = Math.round((now - last.t) * 16); last = { pc: c.pc, t: now }; ours.push(last); };
while (ours.length < LIMIT + 2 && !(ours.length && last.pc === t.haltPc && ours.length > 10)) m.runFrame();
if (last.pc === t.haltPc) ours.pop();

// XRoar's video phase after reset differs from ours (ours is calibrated to MAME), so a loop polling the field
// sync may run a different number of times. Every instruction's own time doesn't depend on that, so when the
// streams part we resynchronise on the next stretch of 32 identical instruction addresses and carry on.
// XRoar prints the vector fetch of SWI and interrupts on a line of its own ([SWI], [IRQ], ...); we count it as
// part of the instruction (or interrupt entry) before it
const xs = [];
for (const x of xr) { if (x.irq && xs.length) xs[xs.length - 1].dt += x.dt; else if (!x.irq) xs.push(x); }
const n = Math.min(LIMIT, ours.length - 1);
const sameRun = (i, j) => { for (let k = 0; k < 32; k++) if (!ours[i + k] || !xs[j + k] || ours[i + k].pc !== xs[j + k].pc) return false; return true; };
// For the same reason an interrupt may be taken one instruction earlier or later, and CWAI/SYNC wait for a
// different time; such a step differs by exactly the interrupt entry (19 cycles for IRQ and NMI, 10 for FIRQ,
// in crystal clocks) or is a wait. These are counted and reported, never taken as matching times.
const ENTRY = [19 * 16, 10 * 16];
let i = 0, j = xs.findIndex((x) => x.pc === ours[0].pc), bad = 0, resyncs = 0, compared = 0, phased = 0;
while (i < n && j >= 0 && j < xs.length) {
  const a = ours[i], b = xs[j];
  if (a.pc !== b.pc) {
    let found = false;
    for (let di = 0; di < 4000 && !found; di++) for (let dj = 0; dj < 4000; dj++) {
      if (ours[i + di] && xs[j + dj] && ours[i + di].pc === xs[j + dj].pc && sameRun(i + di, j + dj)) { i += di; j += dj; found = true; break; }
    }
    if (!found) { console.log(`#${i}: could not resynchronise (ours ${a.pc.toString(16)}, XRoar ${b.text})`); bad++; break; }
    resyncs++;
    continue;
  }
  if (a.dt !== b.dt && (ENTRY.includes(Math.abs(a.dt - b.dt)) || /\b(CWAI|SYNC)\b/.test(b.text))) phased++;
  else if (a.dt !== b.dt && bad++ < (process.env.ALL ? 1e9 : 12)) console.log(`#${i} pc=${a.pc.toString(16)} ours dt=${a.dt}  XRoar ${b.text} dt=${b.dt}`);
  compared++; i++; j++;
}
console.log(`[${which}] ${compared} instructions compared with XRoar (${resyncs} resynchronisations after field-sync polling` +
  `${phased ? `, ${phased} interrupt entries or waits placed differently by the video phase` : ''}): ` +
  (bad ? `${bad} time differences` : `every ${phased ? 'other ' : ''}instruction takes the same time`));
process.exitCode = bad ? 1 : 0;
