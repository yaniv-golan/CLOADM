#!/usr/bin/env node
// The token probe (tools/census/README.md). LOCAL ONLY: run by a maintainer, with their own ROM dump, as a black box.
//
//   node tools/census/tokens.js --roms PATH --keywords FILE [--out FILE]
//
// For each keyword in FILE (one per line, typed by hand from the public Dragon 64 manual: this tool ships no
// list), boots BASIC, types "10 <KEYWORD>" and RETURN, and reads the stored program line back from RAM: the
// tokenised USER program, never ROM. Writes [{ keyword, bytes }] as JSON.
//
// The line is found by its shape alone (no address of BASIC's is built in): a run of RAM below $8000 that is
// [address of the next line][0, 10][bytes][0] whose next-line address is just past its own terminator and points
// at [0][0], the end of the program.
//
// Guard: the keywords are checked before anything is typed (a word of letters, digits and $, or one operator
// character), and a line's bytes are written only if each is a token (bit 7 set) or a character of the typed line,
// and there are no more of them than characters typed; the stream of every keyword's bytes also goes through the
// romrefs window tripwire (tools/census/lib.js).
'use strict';
const fs = require('fs');
const path = require('path');
const cli = require('../../cli/cloadm.js');
const { romImages, Tripwire } = require('./lib.js');

// an error whose message the probe wrote itself (safe to print); any other is printed by its code only
class ProbeError extends Error {}
const BOOT_ALLOWED = new Set(['option', 'timeout', 'asm', 'load', 'type', 'frames', 'seconds', 'wait-for']);
const KEYWORD = /^(?:[A-Z][A-Z0-9]*\$?|[-+*/^<>=&'])$/;
const LINE = 10;

const HELP = `node tools/census/tokens.js --roms PATH --keywords FILE [--out FILE]

  --roms PATH       your own ROM dumps (a file, a .zip or a directory), as the CLI takes them
  --keywords FILE   one keyword per line (# comments), typed from the public Dragon 64 manual
  --out FILE        where the JSON goes (default: standard output)
  --boot FILE       a .cloadm script that brings the machine to its OK prompt (default: wait for OK)
  --no-roms         run on the built-in firmware (the self-test, with --boot)`;

function parse(argv) {
  const o = { roms: [], keywords: null, out: null, boot: null, noRoms: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--roms') o.roms.push(next());
    else if (a === '--keywords') o.keywords = next();
    else if (a === '--out') o.out = next();
    else if (a === '--boot') o.boot = next();
    else if (a === '--no-roms') o.noRoms = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.help) return o;
  if (!o.keywords) throw new Error('--keywords FILE is required');
  if (!o.roms.length && !o.noRoms) throw new Error('--roms PATH is required (or --no-roms for the built-in firmware)');
  return o;
}

// the keyword file -> [keyword]; throws on anything that is not a keyword
function readKeywords(file) {
  const out = [];
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
    const t = line.replace(/#.*/, '').trim().toUpperCase();
    if (!t) return;
    if (t.length > 10 || !KEYWORD.test(t)) throw new Error(`${file}:${i + 1}: "${t}" is not a keyword (a word of letters, digits and $, or one operator character)`);
    if (!out.includes(t)) out.push(t);
  });
  if (!out.length) throw new Error(`${file}: no keywords`);
  return out;
}

// the stored program line `lineNo` in RAM below $8000 -> its bytes (between the line number and the terminator),
// or null when no single line of that shape is found
function findLine(peek, lineNo, maxLen = 64) {
  const found = new Map();
  for (let p = 0; p + 5 < 0x8000; p++) {
    if (peek(p + 2) !== (lineNo >> 8) || peek(p + 3) !== (lineNo & 0xFF)) continue;
    const next = (peek(p) << 8) | peek(p + 1);
    let e = p + 4;
    while (e < 0x8000 && e - p - 4 <= maxLen && peek(e) !== 0) e++;
    if (e - p - 4 > maxLen || e === p + 4) continue;
    if (next !== e + 1 || next + 1 >= 0x8000 || peek(next) !== 0 || peek(next + 1) !== 0) continue;
    const bytes = [];
    for (let a = p + 4; a < e; a++) bytes.push(peek(a));
    found.set(bytes.join(','), bytes);
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

// -> null when the bytes may be written, else why not
function guardLine(typedText, bytes) {
  if (!bytes) return 'no stored line found';
  if (bytes.length > typedText.length) return 'more bytes than were typed';
  const chars = new Set([...typedText].map((c) => c.charCodeAt(0)));
  for (const b of bytes) if (b < 0x80 && !chars.has(b)) return 'a byte that is neither a token nor a typed character';
  return null;
}

async function main(argv, { log = (t) => process.stderr.write(t + '\n'), out = (t) => process.stdout.write(t + '\n') } = {}) {
  let o, keywords;
  try { o = parse(argv); if (o.help) { log(HELP); return 0; } keywords = readKeywords(o.keywords); } catch (e) { log(`tokens: ${e.message}\n\n${HELP}`); return 2; }
  const runner = new cli.Runner();
  runner.setup.machine = 'dragon64';
  runner.setup.roms = o.noRoms ? [] : o.roms.slice();
  runner.setup.noRoms = o.noRoms;
  let boot = cli.parseArgs(['--wait-for', 'text:(^|\n)OK *(\n|$)']).steps;
  try {
    if (o.boot) {
      boot = cli.parseArgs(['--script', o.boot]).steps;
      for (const s of boot) if (!BOOT_ALLOWED.has(s.name)) throw new ProbeError(`${s.where}: a boot script may not use the step "${s.name}"`);
    }
    for (const s of boot.filter((x) => cli.STEPS[x.name].setup)) await runner.run(s);
    runner.start();
    for (const s of boot.filter((x) => !cli.STEPS[x.name].setup)) await runner.run(s);
  } catch (e) { log(`tokens: could not boot: ${e instanceof ProbeError ? e.message : e.code || 'error'}`); return 1; }
  const m = runner.m, booted = m.saveState();
  const tw = new Tripwire(romImages(m));
  const results = [], failed = [];
  for (const kw of keywords) {
    const text = `${LINE} ${kw}`;
    let bytes = null;
    try {
      m.loadState(booted);
      for (const s of cli.parseArgs(['--type', `${text}\\n`, '--frames', '10']).steps) await runner.run(s);
      bytes = findLine((a) => m.peek(a), LINE);
    } catch (e) { failed.push({ keyword: kw, error: `step failed: ${e.code || 'error'}` }); continue; }
    const why = guardLine(text, bytes);
    if (why) { failed.push({ keyword: kw, error: why }); continue; }
    if (tw.add(bytes)) { log('tokens: tripwire: ROM bytes in the output; nothing written'); return 1; }
    results.push({ keyword: kw, bytes });
  }
  const json = JSON.stringify({ line: LINE, results, failed }, null, 1);
  if (o.out) { fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true }); fs.writeFileSync(o.out, json + '\n'); } else out(json);
  log(`tokens: ${results.length} keywords probed, ${failed.length} not`);
  return failed.length ? 1 : 0;
}

module.exports = { main, parse, readKeywords, findLine, guardLine, KEYWORD };
if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
