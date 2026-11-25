#!/usr/bin/env node
// The ROM call census (tools/census/README.md). LOCAL ONLY: run by a maintainer, with their own ROM dump, as a black box.
//
//   node tools/census/census.js --roms PATH [--roms PATH...] [--out DIR] [--frames N] PROGRAM...
//
// Runs each PROGRAM (.cas, .bin, .vdk or any file the CLI's --load takes, or a .cloadm script) on a Dragon 64
// with the ROMs given, and logs every control transfer into $8000-$BFFF from outside it (tools/census/lib.js).
// Writes DIR/census.jsonl (one record per call, at most --max-per-site per call site) and DIR/census.json (the
// aggregate per ROM address). Addresses and effects only: no byte read from $8000-$FEFF is ever written.
'use strict';
const fs = require('fs');
const path = require('path');
const cli = require('../../cli/cloadm.js');
const { trace, romImages, Tripwire, valueBytes, ROM_LO } = require('./lib.js');

// script steps a census run may take: input to the machine and time. Every step that reads the machine out (peek,
// disasm, registers, screen, screenshot, save-snapshot, recordings, traces, profiles...) is refused.
const ALLOWED = new Set(['option', 'fast-cas', 'timeout', 'asm', 'load', 'cart', 'tape', 'disk', 'type', 'frames', 'seconds', 'wait-for', 'hold', 'reset', 'power-cycle', 'poke']);

const HELP = `node tools/census/census.js --roms PATH [--roms PATH...] [options] PROGRAM...

  PROGRAM            a .cas, .bin, .vdk (anything the CLI's --load takes), loaded and run for --frames frames;
                     or a .cloadm script of CLI steps (load, type, wait-for, frames, ...; no step that reads the
                     machine out, and no machine or roms step: the census sets those)
  --roms PATH        your own ROM dumps (a file, a .zip or a directory), as the CLI takes them
  --out DIR          where census.jsonl and census.json go (default ./census-out)
  --frames N         frames to run a loaded file for (default 3000, a minute)
  --max-per-site N   records written per (program, from, target, kind) (default 20; all are counted)
  --max-targets N    distinct ROM entry points one program may use before it counts as a scan (default 512)
  --max-writes N     writes kept per record (default 256; the rest are counted)
  --no-roms          run on the built-in firmware (the self-test)`;

function parse(argv) {
  const o = { roms: [], out: 'census-out', frames: 3000, maxPerSite: 20, maxTargets: 512, maxWrites: 256, noRoms: false, programs: [] };
  const int = (v, what) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new Error(`${what} must be a whole number above 0`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--roms') o.roms.push(next());
    else if (a === '--out') o.out = next();
    else if (a === '--frames') o.frames = int(next(), '--frames');
    else if (a === '--max-per-site') o.maxPerSite = int(next(), '--max-per-site');
    else if (a === '--max-targets') o.maxTargets = int(next(), '--max-targets');
    else if (a === '--max-writes') o.maxWrites = int(next(), '--max-writes');
    else if (a === '--no-roms') o.noRoms = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else o.programs.push(a);
  }
  if (!o.help && !o.programs.length) throw new Error('no programs given');
  if (!o.help && !o.roms.length && !o.noRoms) throw new Error('--roms PATH is required (or --no-roms for the built-in firmware)');
  return o;
}

// the CLI steps for one program
function stepsFor(file, o) {
  if (/\.cloadm$/i.test(file)) {
    const steps = cli.parseArgs(['--script', file]).steps;
    for (const s of steps) {
      if (s.name === 'machine' && s.value === 'dragon64') continue;
      if (!ALLOWED.has(s.name)) throw new Error(`${s.where}: a census script may not use the step "${s.name}"`);
    }
    return steps.filter((s) => s.name !== 'machine');
  }
  return cli.parseArgs(['--load', file, '--frames', String(o.frames)]).steps;
}

// one program -> { records, refused, error }
async function runProgram(file, o) {
  const name = path.basename(file);
  const steps = stepsFor(file, o);
  const runner = new cli.Runner();
  runner.setup.machine = 'dragon64';
  runner.setup.roms = o.noRoms ? [] : o.roms.slice();
  runner.setup.noRoms = o.noRoms;
  for (const s of steps.filter((x) => cli.STEPS[x.name].setup)) await runner.run(s);
  runner.start();
  const images = romImages(runner.m);
  const all = { records: [], refused: [], error: null };
  let m = runner.m, t = trace(m, { program: name, maxWrites: o.maxWrites, maxTargets: o.maxTargets });
  const collect = () => { const r = t.finish(); all.records.push(...r.records); all.refused.push(...r.refused); if (r.error) all.error = r.error; };
  try {
    for (const s of steps.filter((x) => !cli.STEPS[x.name].setup)) {
      await runner.run(s);
      if (t.error) break;
      if (runner.m !== m) { collect(); m = runner.m; t = trace(m, { program: name, maxWrites: o.maxWrites, maxTargets: o.maxTargets }); }
    }
  } catch (e) {
    // only the error's code and where: a message could quote the screen
    all.error = `step failed: ${e.code || 'error'}`;
  }
  collect();
  if (all.error) return { records: [], refused: [], error: all.error };
  // the tripwire: no WINDOW-byte run of a ROM image anywhere in the values this program outputs
  const tw = new Tripwire(images);
  for (const r of all.records) {
    const hit = tw.add(valueBytes(r));
    if (hit) return { records: [], refused: [], error: 'tripwire: ROM bytes in the output values' };
  }
  return all;
}

const hex = (v, n = 4) => '$' + v.toString(16).toUpperCase().padStart(n, '0');

// the aggregate per ROM address
function aggregate(records, refused) {
  const by = new Map();
  const entry = (a) => {
    if (!by.has(a)) by.set(a, { address: a, hex: hex(a), programs: new Set(), calls: 0, refused: 0, kinds: {}, inRegs: {}, outRegs: {}, ramEffects: new Map() });
    return by.get(a);
  };
  const note = (bag, k, v) => {
    const r = bag[k] || (bag[k] = { values: [], more: false });
    if (r.values.includes(v)) return;
    if (r.values.length < 8) r.values.push(v); else r.more = true;
  };
  for (const r of records) {
    const e = entry(r.target);
    e.programs.add(r.program); e.calls++;
    e.kinds[r.kind] = (e.kinds[r.kind] || 0) + 1;
    for (const [k, v] of Object.entries(r.regsIn)) note(e.inRegs, k, v);
    for (const [k, v] of Object.entries(r.regsOut)) if (k === 'pc' || v !== r.regsIn[k]) note(e.outRegs, k, v);
    for (const w of r.ramWritesOutsideRom) {
      const x = e.ramEffects.get(w.addr) || { addr: w.addr, hex: hex(w.addr), writes: 0, values: [], more: false };
      x.writes++;
      if (!x.values.includes(w.value)) { if (x.values.length < 8) x.values.push(w.value); else x.more = true; }
      e.ramEffects.set(w.addr, x);
    }
  }
  for (const r of refused) {
    const e = entry(r.target);
    e.programs.add(r.program); e.calls++; e.refused++;
    e.kinds[r.kind] = (e.kinds[r.kind] || 0) + 1;
  }
  return [...by.values()]
    .map((e) => Object.assign(e, { programs: [...e.programs].sort(), ramEffects: [...e.ramEffects.values()].sort((a, b) => a.addr - b.addr) }))
    .sort((a, b) => b.programs.length - a.programs.length || b.calls - a.calls || a.address - b.address);
}

// the records written to census.jsonl: at most maxPerSite per (program, from, target, kind)
function capped(records, refused, maxPerSite) {
  const seen = new Map(), out = [];
  for (const r of [...records, ...refused]) {
    const k = `${r.program}|${r.from}|${r.target}|${r.kind}`;
    const n = seen.get(k) || 0;
    if (n < maxPerSite) out.push(r);
    seen.set(k, n + 1);
  }
  return out;
}

async function main(argv, { log = (t) => process.stderr.write(t + '\n') } = {}) {
  let o;
  try { o = parse(argv); } catch (e) { log(`census: ${e.message}\n\n${HELP}`); return 2; }
  if (o.help) { log(HELP); return 0; }
  const records = [], refused = [], failed = [];
  for (const file of o.programs) {
    let r;
    try { r = await runProgram(file, o); } catch (e) { r = { records: [], refused: [], error: `could not run: ${e.code || e.message}` }; }
    if (r.error) { failed.push({ program: path.basename(file), error: r.error }); log(`census: ${path.basename(file)}: discarded (${r.error})`); continue; }
    records.push(...r.records); refused.push(...r.refused);
    log(`census: ${path.basename(file)}: ${r.records.length} calls recorded, ${r.refused.length} refused by the guard`);
  }
  fs.mkdirSync(o.out, { recursive: true });
  fs.writeFileSync(path.join(o.out, 'census.jsonl'), capped(records, refused, o.maxPerSite).map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(o.out, 'census.json'), JSON.stringify({ range: [ROM_LO, 0xBFFF], programs: o.programs.map((f) => path.basename(f)), failed, entries: aggregate(records, refused) }, null, 1) + '\n');
  log(`census: wrote ${path.join(o.out, 'census.jsonl')} and census.json`);
  return failed.length ? 1 : 0;
}

module.exports = { main, parse, aggregate, capped, runProgram, ALLOWED };
if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
