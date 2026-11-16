#!/usr/bin/env node
// The performance benchmark. Node only: no MAME,
// no dependencies, no build step.
//
//   node tools/bench.js                 every measurement, 3 runs each
//   node tools/bench.js --runs 5        more runs per measurement
//   node tools/bench.js --frames 900    more emulated frames per machine
//   node tools/bench.js --only cpu,zip    just some (comma-separated names from the list below)
//   node tools/bench.js --json          the numbers as one JSON object (save each branch's file to compare)
//   node tools/bench.js --compare OLD.json NEW.json
//                                       the change between two saved runs; measures nothing itself
//
// Every figure is the MEDIAN of --runs runs, with the min and max beside it. This machine is often loaded by
// other agents, so one number means little: compare two branches by running this in each, back to back, and
// look at the medians and the spread together. A change smaller than the spread is not shown by this tool;
// for those, use the paired method in the report (alternate the two builds in one process and take the median
// of the per-round ratios).
//
// What is measured (the numbers are the sections of an earlier performance review):
//   cpu            the 6809 core: instructions per second on a loop that touches every addressing mode (7)
//   frames         frames per second per machine on the stub firmware (the whole loop: CPU, video, events)
//   video          1000 frames converted to RGBA (5, 8)
//   snapshot       a snapshot taken, to JSON, and restored (4, 9)
//   zip            a ZIP written and read (9)
//   assembler      assembling a large source (the panel's work)
//   page           the modules /play/ loads: count and bytes (6)
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const Emu = require(path.join(ROOT, 'tests/load.js'))();

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : dflt; };
const RUNS = opt('--runs', 3), FRAMES = opt('--frames', 400);
const JSON_OUT = args.includes('--json');
const only = (() => { const i = args.indexOf('--only'); return i >= 0 && args[i + 1] ? new Set(args[i + 1].split(',')) : null; })();
const want = (name) => !only || only.has(name);

// median/min/max of `runs` timings of fn()
function timeIt(fn) {
  const all = [];
  for (let r = 0; r < RUNS; r++) {
    const t0 = process.hrtime.bigint();
    fn();
    all.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const s = [...all].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1], all };
}
const results = {};
const record = (name, value, unit, text) => {
  results[name] = { value, unit, ...(value && value.all ? { median: value.median, min: value.min, max: value.max } : {}) };
  if (!JSON_OUT) console.log(`${name.padEnd(18)} ${text}`);
};

// ---- --compare first: it reads two saved runs and measures nothing itself, so it must not be delayed by a
// full benchmark run before printing the answer
const ci = args.indexOf('--compare');
if (ci >= 0) {
  const oldFile = args[ci + 1], newFile = args[ci + 2];
  if (!oldFile || !newFile) { console.error('usage: node tools/bench.js --compare OLD.json NEW.json\n(save each branch\'s numbers with --json first)'); process.exitCode = 2; return; }
  const before = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
  const after = JSON.parse(fs.readFileSync(newFile, 'utf8'));
  console.log('change (better = faster or smaller):');
  for (const k of Object.keys(before)) {
    if (!(k in after)) continue;
    const a = before[k].median !== undefined ? before[k].median : before[k].value;
    const b = after[k].median !== undefined ? after[k].median : after[k].value;
    const unit = after[k].unit || '';
    const pct = a === 0 ? 0 : 100 * (a - b) / a;
    // lower is better for times and byte counts; higher is better for fps and instruction rates
    const higherIsBetter = /fps$/.test(unit) || /\/s$/.test(unit);
    const good = higherIsBetter ? pct < 0 : pct > 0;
    console.log(`  ${k.padEnd(18)} ${a.toFixed(2)} -> ${b.toFixed(2)} ${unit.padEnd(16)} ${(good ? '+' : '-')}${Math.abs(pct).toFixed(1)}% ${good ? 'better' : 'WORSE'}`);
  }
  process.exitCode = 0; return;   // --compare done: nothing below measures anything
}

// ---- cpu: instructions per second on a loop touching every addressing mode ----
if (want('cpu')) {
  const m = Emu.createMachine('dragon64');
  m.reset(true);
  // LDA <$10 (direct) ; LDA ,X (indexed) ; LDA $0300 (extended) ; LDX <$10 ; STA <$10 ; BRA (six
  // instructions a pass), written by hand so both branches run byte-identical code
  const CODE = [[0x96, 0x10], [0xA6, 0x84], [0xB6, 0x03, 0x00], [0x9E, 0x10], [0x97, 0x10], [0x20, 0xF3]];
  let o = 0x0200; for (const ins of CODE) { m.ram.set(ins, o); o += ins.length; }
  const STEPS = 1000000;
  const t = timeIt(() => { m.cpu.jump(0x0200); m.cpu.cc |= 0x50; m.cpu.x = 0x0300; for (let i = 0; i < STEPS; i++) m.cpu.step(); });
  const ips = STEPS * 1000 / t.median;
  record('cpu', ips, 'M instructions/s', `${(ips / 1e6).toFixed(1)} M instr/s  median of ${RUNS}: ${t.median.toFixed(1)} ms (${t.min.toFixed(1)}-${t.max.toFixed(1)}) per ${STEPS / 1e6}M`);
}

// ---- frames: frames per second, per machine, through the whole frame loop ----
if (want('frames')) {
  for (const id of ['dragon64', 'coco', 'coco3', 'mc10']) {
    const m = Emu.createMachine(id);
    m.reset(true);
    for (let i = 0; i < 30; i++) m.runFrame();          // past the boot
    const t = timeIt(() => { for (let i = 0; i < FRAMES; i++) m.runFrame(); });
    const fps = FRAMES * 1000 / t.median;
    record(`frames ${id}`, fps, 'fps', `${String(Math.round(fps)).padStart(5)} fps  median of ${RUNS}: ${t.median.toFixed(1)} ms (${t.min.toFixed(1)}-${t.max.toFixed(1)}) per ${FRAMES} frames`);
  }
}

// ---- video: a frame converted to RGBA ----
if (want('video')) {
  const m = Emu.createMachine('coco');
  m.reset(true);
  m.write(0xFF22, 0xE0);                                // a graphics mode: real work for the renderer
  for (let i = 0; i < 10; i++) m.runFrame();
  const t = timeIt(() => { for (let i = 0; i < 1000; i++) Emu.frameToRGBA(m.render()); });
  record('video', t.median, 'ms/1000', `${(t.median / 1000).toFixed(3)} ms each  median of ${RUNS}: ${t.median.toFixed(1)} ms (${t.min.toFixed(1)}-${t.max.toFixed(1)}) per 1000`);
}

// ---- snapshot: take, encode to JSON, restore ----
if (want('snapshot')) {
  const m = Emu.createMachine('dragon64');
  m.reset(true);
  for (let i = 0; i < 30; i++) m.runFrame();
  const N = 20;
  const t = timeIt(() => { for (let i = 0; i < N; i++) Emu.state.toJSON(m.snapshot()); });
  record('snapshot', t.median / N, 'ms each', `${(t.median / N).toFixed(2)} ms each  median of ${RUNS}: ${t.median.toFixed(1)} ms (${t.min.toFixed(1)}-${t.max.toFixed(1)}) per ${N}`);
}

// ---- zip: write and read a small archive ----
if (want('zip')) {
  const files = [...Array(20)].map((_, i) => ({ name: `file${i}.bin`, data: new Uint8Array(4096).fill(i) }));
  const N = 20;
  const t = timeIt(() => { for (let i = 0; i < N; i++) Emu.readZip(Emu.writeZip(files)); });
  record('zip', t.median / N, 'ms each', `${(t.median / N).toFixed(2)} ms each  median of ${RUNS}: ${t.median.toFixed(1)} ms (${t.min.toFixed(1)}-${t.max.toFixed(1)}) per ${N}`);
}

// ---- assembler: a large source through the panel's assembler ----
if (want('assembler')) {
  const lines = [];
  for (let i = 0; i < 2000; i++) lines.push(`\tLDA\t#${i & 0xFF}`, `\tSTA\t$${(0x1000 + i).toString(16).toUpperCase()}`);
  const src = `\tORG\t$1000\n${lines.join('\n')}\n\tEND\n`;
  const t = timeIt(() => { const r = Emu.assemble(src, '6809'); if (!r.ok) throw new Error('assemble failed'); });
  record('assembler', t.median, 'ms', `${t.median.toFixed(1)} ms for 4000 lines  median of ${RUNS}: (${t.min.toFixed(1)}-${t.max.toFixed(1)})`);
}

// ---- page: what /play/ loads (count and bytes of its module graph) ----
if (want('page')) {
  const seen = new Map();                                 // file -> bytes
  const visit = (file) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    seen.set(file, text.length);
    for (const m of text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      if (m[1].startsWith('.')) visit(path.resolve(path.dirname(file), m[1]));
    }
  };
  visit(path.join(ROOT, 'js/ui/main.js'));
  const bytes = [...seen.values()].reduce((a, b) => a + b, 0);
  record('page', seen.size, 'modules', `${seen.size} modules, ${(bytes / 1024).toFixed(0)} KB of JS  (loaded by /play/)`);
}

if (JSON_OUT) { console.log(JSON.stringify(results, null, 2)); process.exitCode = 0; }
