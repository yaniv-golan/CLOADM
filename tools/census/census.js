#!/usr/bin/env node
// The ROM call census (tools/census/README.md). LOCAL ONLY: run by a maintainer, with their own ROM dump, as a black box.
//
//   node tools/census/census.js --roms PATH [--roms PATH...] [--out DIR] [--frames N] PROGRAM...
//
// Runs each PROGRAM (a machine-code .bin or .cas, loaded straight into memory and started, or a .cloadm script) on a
// Dragon 64 with the ROMs given, and logs every control transfer into $8000-$BFFF from outside it (tools/census/lib.js).
// Writes DIR/census.jsonl (one record per call, at most --max-per-site per call site) and DIR/census.json (the
// aggregate per ROM address). Addresses and effects only: no byte read from $8000-$FFFF (but the I/O page) is ever
// written, by the structural guard in lib.js.
'use strict';
const fs = require('fs');
const path = require('path');
const cli = require('../../cli/cloadm.js');
const Emu = require('../../js/emu.js');
const defaultLib = require('./lib.js');
const { staticRefs } = require('./static.js');
const { ROM_LO } = defaultLib;

// script steps a census run may take: input to the machine and time. Every step that reads the machine out (peek,
// disasm, registers, screen, screenshot, save-snapshot, recordings, traces, profiles...) is refused.
const ALLOWED = new Set(['option', 'fast-cas', 'timeout', 'asm', 'load', 'cart', 'tape', 'disk', 'type', 'frames', 'seconds', 'wait-for', 'hold', 'reset', 'power-cycle', 'poke']);

const HELP = `node tools/census/census.js --roms PATH [--roms PATH...] [options] PROGRAM...

  PROGRAM            a machine-code .bin or .cas, loaded straight into memory, started and run for --frames frames;
                     or a .cloadm script of CLI steps (load, asm, disk, type, wait-for, frames, ...; no step that reads
                     the machine out, and no machine or roms step: the census sets those). Recording begins when the
                     program is started by load or asm; a program BASIC starts records nothing.
  --roms PATH        your own ROM dumps (a file, a .zip or a directory), as the CLI takes them
  --out DIR          where census.jsonl and census.json go (default ./census-out)
  --frames N         frames to run a loaded file for (default 3000, a minute)
  --max-per-site N   records written per (program, from, target, kind) (default 20; all are counted)
  --max-targets N    distinct ROM entry points one program may use before it counts as a scan (default 512)
  --max-run-targets N  distinct ROM entry points all the programs of one run may use together; more, and nothing
                     is written (default 1024)
  --max-writes N     writes kept per record (default 256; the rest are counted)
  --sweep-window N   the boot sweep's shortest ROM run, 4 to 16 bytes (default 8): shorter marks more of
                     BASIC's leftovers as ROM data, which costs recording, never safety
  --no-roms          run on the built-in firmware (the self-test)`;

function parse(argv) {
  const o = { roms: [], out: 'census-out', frames: 3000, maxPerSite: 20, maxTargets: 512, maxRunTargets: 1024, maxWrites: 256, sweepWindow: 8, noRoms: false, programs: [] };
  const int = (v, what) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new Error(`${what} must be a whole number above 0`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--roms') o.roms.push(next());
    else if (a === '--out') o.out = next();
    else if (a === '--frames') o.frames = int(next(), '--frames');
    else if (a === '--max-per-site') o.maxPerSite = int(next(), '--max-per-site');
    else if (a === '--max-targets') o.maxTargets = int(next(), '--max-targets');
    else if (a === '--max-run-targets') o.maxRunTargets = int(next(), '--max-run-targets');
    else if (a === '--sweep-window') { o.sweepWindow = int(next(), '--sweep-window'); if (o.sweepWindow < 4 || o.sweepWindow > 16) throw new Error('--sweep-window is 4 to 16'); }
    else if (a === '--max-writes') o.maxWrites = int(next(), '--max-writes');
    else if (a === '--no-roms') o.noRoms = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else o.programs.push(a);
  }
  if (!o.help && !o.programs.length) throw new Error('no programs given');
  if (!o.help && !o.roms.length && !o.noRoms) throw new Error('--roms PATH is required (or --no-roms for the built-in firmware)');
  const names = o.programs.map((f) => path.basename(f));
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`two programs are both named ${dup}: records are keyed by file name, so give each a different one`);
  return o;
}

// the CLI steps for one program
function stepsFor(file, o) {
  if (/\.cloadm$/i.test(file)) {
    const steps = cli.parseArgs(['--script', file]).steps;
    for (const s of steps) {
      if (s.name === 'machine' && s.value === 'dragon64') continue;
      if (!ALLOWED.has(s.name)) throw new CensusError(`${s.where}: a census script may not use the step "${s.name}"`);
    }
    return steps.filter((s) => s.name !== 'machine');
  }
  return cli.parseArgs(['--load', file, '--frames', String(o.frames)]).steps;
}

// An error whose message the census wrote itself (safe to print); any other error is printed by its code only, since
// a message could quote the screen.
class CensusError extends Error {}
const errorText = (e) => (e instanceof CensusError ? e.message : `could not run: ${e.code || 'error'}`);

// Why a program the census ran was never started by its loader (Machine.injectAndRun), from the file itself (its
// format, never its bytes): a tape that starts with a BASIC program (a BASIC loader: BASIC runs it, then it loads the
// rest), a file with no exec address, a script that never loads a program.
function notStartedWhy(file) {
  if (/\.cloadm$/i.test(file)) return 'the script never started a machine-code program with load or asm';
  let d;
  try { d = Emu.formats.identify(path.basename(file), fs.readFileSync(file)); } catch (e) { return 'the file could not be identified'; }
  if (d.kind === 'cas') {
    const first = d.files && d.files[0];
    if (!first) return 'no file found on the tape';
    if (first.fileType !== 2) return `the tape starts with a ${first.fileType === 0 ? 'BASIC program (a BASIC loader: BASIC runs it, and it loads the rest)' : 'data file'}; only machine code the census loads itself is recorded`;
    if (first.exec == null) return 'the machine-code file on the tape has no exec address';
    return 'the tape did not start';
  }
  if (d.kind === 'binary') return d.basic ? 'the file is a BASIC program: BASIC runs it' : d.exec == null ? 'the binary has no exec address' : 'the binary did not start';
  return `a ${d.kind} file is not started by the census loader (a machine-code .bin or .cas, or an asm step)`;
}

// one program -> { records, refused, stopped, error }. lib: the tracer (tests pass a changed one).
async function runProgram(file, o, lib = defaultLib) {
  const name = path.basename(file);
  const steps = stepsFor(file, o);
  const runner = new cli.Runner();
  runner.setup.machine = 'dragon64';
  runner.setup.roms = o.noRoms ? [] : o.roms.slice();
  runner.setup.noRoms = o.noRoms;
  runner.setup.fastCas = true;     // a .cas goes straight into memory: the census loader starts it (lib.js, rule 1)
  for (const s of steps.filter((x) => cli.STEPS[x.name].setup)) await runner.run(s);
  runner.start();
  const m = runner.m, images = lib.romImages(m);
  const t = lib.trace(m, { program: name, maxWrites: o.maxWrites, maxTargets: o.maxTargets, sweepWindow: o.sweepWindow });
  let failed = null;
  try {
    for (const s of steps.filter((x) => !cli.STEPS[x.name].setup)) {
      await runner.run(s);
      if (t.error) break;
      if (runner.m !== m) { failed = 'the machine was replaced during the run'; break; }
    }
  } catch (e) { failed = `step failed: ${e.code || 'error'}`; }
  const r = t.finish();
  if (failed || r.error) return { records: [], refused: [], stopped: null, error: failed || r.error };
  if (!r.started) return { records: [], refused: [], stopped: null, error: `not started by the census loader: ${notStartedWhy(file)}` };
  // the tripwire: no WINDOW-byte run of a ROM image anywhere in the values this program outputs
  const tw = new lib.Tripwire(images);
  for (const x of r.records) if (tw.add(lib.valueBytes(x))) return { records: [], refused: [], stopped: null, error: 'tripwire: ROM bytes in the output values' };
  // the static census: the references in the program's own file, as loaded (lib's loads), never RAM after a run
  const statics = [];
  for (const ld of r.loads || []) {
    const st = staticRefs(ld.segments, images);
    if (st.skipped) statics.skipped = st.skipped;
    for (const x of st.refs) statics.push(Object.assign({ program: name }, x, { source: 'static' }));
  }
  return { records: r.records, refused: r.refused, afterStop: r.afterStop || [], statics, stopped: r.stopped, error: null };
}

const hex = (v, n = 4) => '$' + v.toString(16).toUpperCase().padStart(n, '0');

// the aggregate per ROM address
function aggregate(records, refused, statics = [], afterStop = []) {
  const by = new Map();
  const entry = (a) => {
    if (!by.has(a)) by.set(a, { address: a, hex: hex(a), programs: new Set(), calls: 0, refused: 0, kinds: {}, inRegs: {}, outRegs: {}, ramEffects: new Map(), callsAfterStop: 0, staticPrograms: new Set() });
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
  // calls counted after the stop (addresses and counts only), and the static census: the programs whose own file
  // refers to the address. A vector slot (the $A00x address itself) is an entry of its own.
  for (const x of afterStop) {
    const e = entry(x.target != null ? x.target : x.slot);
    if (x.slot != null) e.vectorSlot = true;
    e.programs.add(x.program);
    e.callsAfterStop += x.count;
    e.kinds[x.kind] = (e.kinds[x.kind] || 0) + x.count;
  }
  for (const x of statics) {
    const e = entry(x.target != null ? x.target : x.slot);
    if (x.slot != null) e.vectorSlot = true;
    e.staticPrograms.add(x.program);
  }
  return [...by.values()]
    .map((e) => Object.assign(e, { programs: [...e.programs].sort(), staticPrograms: [...e.staticPrograms].sort(), ramEffects: [...e.ramEffects.values()].sort((a, b) => a.addr - b.addr) }))
    .sort((a, b) => b.programs.length - a.programs.length || b.staticPrograms.length - a.staticPrograms.length || (b.calls + b.callsAfterStop) - (a.calls + a.callsAfterStop) || a.address - b.address);
}

// the records written to census.jsonl: at most maxPerSite per (program, from, target, kind)
function capped(records, refused, maxPerSite) {
  const seen = new Map(), out = [];
  for (const r of records.concat(refused)) {
    const k = `${r.program}|${r.from}|${r.target}|${r.kind}`;
    const n = seen.get(k) || 0;
    if (n < maxPerSite) out.push(r);
    seen.set(k, n + 1);
  }
  return out;
}

async function main(argv, { log = (t) => process.stderr.write(t + '\n'), lib = defaultLib } = {}) {
  let o;
  try { o = parse(argv); } catch (e) { log(`census: ${e.message}\n\n${HELP}`); return 2; }
  if (o.help) { log(HELP); return 0; }
  const records = [], refused = [], afterStop = [], statics = [], failed = [], runs = [];
  // census.jsonl is written as each program finishes, to census.jsonl.partial, renamed when the run is done: a crash
  // later in the run keeps the programs already done (in the .partial file), and a run that ends refused leaves none
  const jsonl = path.join(o.out, 'census.jsonl'), partial = `${jsonl}.partial`, summary = path.join(o.out, 'census.json');
  fs.mkdirSync(o.out, { recursive: true });
  for (const f of [jsonl, summary]) fs.rmSync(f, { force: true });
  fs.writeFileSync(partial, '');
  let targets = new Set();
  for (const file of o.programs) {
    const name = path.basename(file);
    let r;
    try { r = await runProgram(file, o, lib); } catch (e) { r = { error: errorText(e) }; }
    if (r.error) { failed.push({ program: name, error: r.error }); log(`census: ${name}: discarded (${r.error})`); continue; }
    // the run-wide scan limit, checked before this program's lines are written: entering ROM is how its constants
    // come out (effects of running ROM code), so the whole run, not just each program, has a bound on how many
    // places it may enter, and nothing on disk ever goes past it
    const next = new Set(targets);
    for (const x of r.records) next.add(x.target);
    for (const x of r.refused) next.add(x.target);
    for (const x of r.afterStop) next.add(x.target != null ? x.target : x.slot);
    if (next.size > o.maxRunTargets) {
      fs.rmSync(partial, { force: true });
      log(`census: the run entered ${next.size} distinct ROM addresses, more than --max-run-targets ${o.maxRunTargets}: nothing written`);
      return 1;
    }
    targets = next;
    // (one at a time: a spread of thousands of records into push() overflows the call stack)
    for (const x of r.records) records.push(x);
    for (const x of r.refused) refused.push(x);
    for (const x of r.statics) statics.push(x);
    for (const x of r.afterStop) afterStop.push(x);
    const lines = capped(r.records, r.refused, o.maxPerSite).concat(r.afterStop, r.statics);
    if (lines.length) fs.appendFileSync(partial, lines.map((x) => JSON.stringify(x)).join('\n') + '\n');
    runs.push({ program: name, recorded: r.records.length, refused: r.refused.length, stopped: r.stopped,
      callsAfterStop: r.afterStop.reduce((n, x) => n + x.count, 0), static: r.statics.length, staticSkipped: r.statics.skipped || null });
    log(`census: ${name}: ${r.records.length} calls recorded, ${r.refused.length} refused${r.stopped ? `; recording stopped (${r.stopped})` : ''}`);
  }
  fs.renameSync(partial, jsonl);
  fs.writeFileSync(summary, JSON.stringify({ range: [ROM_LO, 0xBFFF], programs: runs, failed, entries: aggregate(records, refused, statics, afterStop) }, null, 1) + '\n');
  log(`census: wrote ${jsonl} and census.json`);
  return failed.length ? 1 : 0;
}

module.exports = { main, parse, aggregate, capped, runProgram, notStartedWhy, ALLOWED, CensusError };
if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
