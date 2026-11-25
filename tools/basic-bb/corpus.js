#!/usr/bin/env node
// Corpus mode of the black-box harness (docs/clean-room-basic.md section 7): real tokenized BASIC programs on .cas
// tapes, run on any Dragon 64 32K-mode BASIC ROM. A maintainer runs it on their own machine, once with the real ROM
// and once with ours, and compares the two result files (tools/basic-bb/compare.js). The programs never leave their
// machine, and nothing of a program or the ROM is written but what this file says below.
//
//   node tools/basic-bb/corpus.js (--rom FILE | --ours) --corpus DIR --out results.jsonl
//        [--frames N] [--every N] [--full NAMES] [--only a,b]
//
// For each DIR/NAME.cas, on a fresh machine: boot to OK; CLOAD (the tape's first program); LIST the whole program
// (every line that scrolls by is caught: tests/basic/harness.js record()); RUN for --frames frames (default 1500, 30
// emulated seconds) with no input, or with the keys of an optional DIR/NAME.keys; every --every frames (default 50)
// a sample of the screen's text and the SHA-256 of its pixels. A run that comes back to OK and stays is "ended".
//
// NAME.keys: one event a line, "FRAME keys A+B [HOLD]" (hold the matrix keys for HOLD frames, default 6) or
// "FRAME type TEXT" (\n is ENTER); FRAME counts from the RUN. # starts a comment.
//
// What is written, one JSON object a program: { program (the file's name), sha256 (of the .cas), machine, rom (the
// ROM image's CRC-32), status, why, error (the last "?xx ERROR" line), listLines, list, samples: [{ frame, screen,
// pix }], lint }. By default the text is hashed: list holds one hash a line and a sample's screen one hash, the first
// 16 hex digits of a SHA-256, enough to find where two runs part. The programs named in --full NAMES (a file, one name
// or sha256 a line: the programs whose owners allow it) are written as text.
//
// Nothing read from the ROM may reach the results (docs/clean-room-basic.md section 7), so:
//   * the listing is linted first: a program that uses EXEC, USR, DEFUSR, CLOADM, CSAVEM or VARPTR, or PEEKs an
//     address that is not a literal in RAM ($0000-$7FFF) or the I/O page ($FF00-$FFDF) or "... AND 32767", is not
//     RUN: status "rom-read-possible", with the kinds and line numbers in lint (never the text);
//   * the guard (romGuard below) watches the RUN, after tools/census's structural rule: program code (machine code
//     the program put in RAM) reading $8000-$FFFF outside the I/O page, or a stretch of ROM code called from program
//     code reading ROM data and then returning to it, stops the recording there: status "rom-read", why.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Basic, Emu } = require('../../tests/basic/harness.js');
const { code, argAt, literal, maskedOk } = require('./lint.js');

const IO_LO = 0xFF00, IO_HI = 0xFFDF;
const masked = (a) => a >= 0x8000 && !(a >= IO_LO && a <= IO_HI);
const short = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// The listing's screen rows joined into program lines: a row 32 characters long runs on into the next one.
function joinListing(rows) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    cur = cur == null ? r : cur + r;
    if (r.length < 32) { out.push(cur); cur = null; }
  }
  if (cur != null) out.push(cur);
  return out;
}

// The corpus lint: -> [{ line (the program line's number), kind }]. kind is "machine-code" (EXEC, USR, DEFUSR,
// CLOADM, CSAVEM, VARPTR) or "peek" (an address that might be in the ROM).
function corpusLint(lines) {
  const out = [];
  for (const raw of lines) {
    const num = (/^\s*(\d+)/.exec(raw) || [])[1] || '?';
    const s = code(raw);
    if (/EXEC|USR|CLOADM|CSAVEM|VARPTR/.test(s)) out.push({ line: num, kind: 'machine-code' });
    for (let p = s.indexOf('PEEK'); p >= 0; p = s.indexOf('PEEK', p + 4)) {
      const open = s.indexOf('(', p);
      const arg = open >= 0 && /^\s*$/.test(s.slice(p + 4, open)) ? argAt(s, open) : null;
      const v = arg == null ? null : literal(arg);
      const ok = arg != null && ((v != null && !masked(v)) || maskedOk(arg));
      if (!ok) out.push({ line: num, kind: 'peek' });
    }
  }
  return out;
}

// The guard (tools/census/lib.js's structural rule, for a BASIC program): arm() at the RUN. Program code is an
// instruction in RAM whose first byte was written since watch() and that BASIC itself never ran before arm() (BASIC's
// own code in RAM, if a ROM has any, runs while it boots, loads and lists). -> { watch(), arm(), tripped: null | why }
//   * program code reading $8000-$FFFF outside the I/O page trips it, except two consecutive bytes whose value is
//     where control goes next (an interrupt vector, a JMP or JSR through a table): they pick a target, no data;
//   * ROM code entered from program code that reads ROM data (not its own instruction bytes) and then hands control
//     back to program code trips it.
function romGuard(m) {
  const written = new Uint8Array(0x8000), before = new Uint8Array(0x8000);
  let armed = false, watching = false, cur = 0, prev = null, reads = [], dirty = false, inStretch = false, lastProg = 0;
  const g = { tripped: null, frame: null };
  const program = (pc) => pc < 0x8000 && written[pc] && !before[pc];
  const trip = (why) => { if (!g.tripped) g.tripped = why; };
  m.busTaps.addWriteTap({ start: 0, end: 0x7FFF }, (a) => { if (watching) written[a] = 1; });
  m.busTaps.addReadTap({ start: 0x8000, end: 0xFFFF }, (a, v) => {
    if (!armed || !masked(a)) return;
    if (program(cur)) reads.push([a, v]);
    else if (cur >= 0x8000 && inStretch && !(a >= cur && a < cur + 5)) dirty = true;
  });
  m.addProbe((pc) => {
    if (!armed) { if (pc < 0x8000) before[pc] = 1; return; }
    if (reads.length) {
      const picks = reads.length === 2 && reads[1][0] === reads[0][0] + 1 && ((reads[0][1] << 8) | reads[1][1]) === pc;
      if (!picks) trip(`program code at $${hex(cur)} read $${hex(reads[0][0])}`);
      reads = [];
    }
    if (prev != null && program(prev) && pc >= 0x8000) { inStretch = true; dirty = false; }
    else if (prev != null && prev >= 0x8000 && program(pc)) {
      if (inStretch && dirty) trip(`ROM code called from $${hex(lastProg)} read ROM data and returned to $${hex(pc)}`);
      inStretch = false; dirty = false;
    }
    if (program(pc)) lastProg = pc;
    prev = pc; cur = pc;
  });
  g.watch = () => { watching = true; };
  g.arm = () => { armed = true; };
  return g;
}
const hex = (v) => v.toString(16).toUpperCase().padStart(4, '0');

const ERR = /\?[A-Z/]{2} ERROR/;

// Run one program. -> the record (without program, sha256, rom).
function runProgram(rom, cas, { name = 'PROGRAM', frames = 1500, every = 50, keys = [], full = false, loadFrames = 50 * 600 } = {}) {
  const b = new Basic(rom), m = b.m;
  const text = (rows) => (full ? rows : short(rows.join('\n')));
  const rec = { status: 'ok' };
  const lastError = (rows) => { for (let i = rows.length - 1; i >= 0; i--) if (ERR.test(rows[i])) return rows[i]; return null; };
  if (!b.waitOk({ limit: 600, stable: 3 })) return { status: 'no-boot' };
  const guard = romGuard(m);
  guard.watch();
  m.deck.insert(new Emu.Tape(cas, m.tickHz, name, m.profile.tape));
  b.record();
  if (b.type('CLOAD\n') !== 'done') return { status: 'no-keyboard', at: 'CLOAD' };
  if (!b.waitOk({ limit: loadFrames })) return { status: 'load-timeout' };
  const loadErr = lastError(b.transcript());
  if (loadErr) return { status: 'load-error', error: loadErr };
  // the listing
  b.type('CLS\n'); b.waitOk();
  b.record();
  if (b.type('LIST\n') !== 'done') return { status: 'no-keyboard', at: 'LIST' };
  if (!b.waitOk({ limit: 50 * 600, stable: 5 })) return { status: 'list-timeout' };
  const t = b.transcript();
  const rows = t.slice(t[0] === 'LIST' ? 1 : 0, t[t.length - 1] === 'OK' ? -1 : undefined);
  const list = joinListing(rows);
  rec.listLines = list.length;
  rec.list = full ? list : list.map(short);
  const lint = corpusLint(list);
  if (lint.length) return { ...rec, status: 'rom-read-possible', lint };
  // the run
  b.type('CLS\n'); b.waitOk();
  b.record();
  guard.arm();
  if (b.type('RUN\n') !== 'done') return { ...rec, status: 'no-keyboard', at: 'RUN' };
  const events = keys.slice().sort((x, y) => x.frame - y.frame);
  const held = [];
  rec.samples = [];
  let lastKey = null;
  for (let f = 1; f <= frames; f++) {
    while (events.length && events[0].frame < f) {
      const e = events.shift();
      if (e.type === 'keys') { for (const k of e.keys) m.setKey(k, true); held.push({ keys: e.keys, until: f + e.hold }); }
      else m.typist.typePaced(e.text);
    }
    b.frame();
    for (let i = held.length - 1; i >= 0; i--) if (held[i].until <= f) { for (const k of held[i].keys) m.setKey(k, false); held.splice(i, 1); }
    if (guard.tripped) { rec.status = 'rom-read'; rec.why = guard.tripped; rec.at = f; rec.samples = rec.samples.filter((s) => s.frame < f); break; }
    if (f % every === 0) {
      const s = b.screen(), pix = b.pixHash().slice(0, 16), key = s.join('\n') + pix;
      rec.samples.push({ frame: f, screen: text(s), pix });
      const e = lastError(s);
      if (e) rec.error = e;
      // back at OK and unchanged since the last sample: the program has ended
      if (s[s.length - 1] === 'OK' && key === lastKey) { rec.status = 'ended'; break; }
      lastKey = key;
    }
  }
  if (rec.status !== 'rom-read' && !rec.error) { const e = lastError(b.transcript()); if (e) rec.error = e; }
  rec.frames = b.frames;
  return rec;
}

// NAME.keys -> events
function parseKeys(text) {
  const out = [];
  text.split(/\r?\n/).forEach((l, i) => {
    if (!l.trim() || l.trim().startsWith('#')) return;
    const m = /^\s*(\d+)\s+(keys|type)\s+(.*)$/.exec(l);
    if (!m) throw new Error(`line ${i + 1}: "FRAME keys A+B [HOLD]" or "FRAME type TEXT"`);
    if (m[2] === 'keys') { const [k, hold] = m[3].trim().split(/\s+/); out.push({ frame: Number(m[1]), type: 'keys', keys: k.split('+'), hold: hold ? Number(hold) : 6 }); }
    else out.push({ frame: Number(m[1]), type: 'type', text: m[3].replace(/\\n/g, '\n') });
  });
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const usage = (msg) => { console.error(`basic-bb corpus: ${msg}\nusage: node tools/basic-bb/corpus.js (--rom FILE | --ours) --corpus DIR --out FILE [--frames N] [--every N] [--full NAMES] [--only a,b]`); process.exitCode = 2; };
  let rom;
  if (args.includes('--ours')) rom = require('../build-basic.js').buildBasic().rom;
  else if (opt('--rom')) rom = new Uint8Array(fs.readFileSync(opt('--rom')));
  else return usage('give --rom FILE or --ours');
  if (rom.length !== 0x4000) return usage(`the ROM image is ${rom.length} bytes, not 16384`);
  const dir = opt('--corpus'), out = opt('--out');
  if (!dir || !out) return usage('give --corpus DIR and --out FILE');
  const frames = Number(opt('--frames') || 1500), every = Number(opt('--every') || 50);
  const fullSet = new Set(opt('--full') ? fs.readFileSync(opt('--full'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []);
  const only = opt('--only') ? new Set(opt('--only').split(',')) : null;
  const crc = Emu.crc32(rom).toString(16).toUpperCase().padStart(8, '0');
  const files = fs.readdirSync(dir).filter((f) => /\.cas$/i.test(f)).sort();
  const fd = fs.openSync(out, 'w');
  for (const f of files) {
    const name = f.replace(/\.cas$/i, '');
    if (only && !only.has(name)) continue;
    const cas = new Uint8Array(fs.readFileSync(path.join(dir, f)));
    const sha256 = crypto.createHash('sha256').update(cas).digest('hex');
    const kf = path.join(dir, `${name}.keys`);
    const keys = fs.existsSync(kf) ? parseKeys(fs.readFileSync(kf, 'utf8')) : [];
    const full = fullSet.has(name) || fullSet.has(f) || fullSet.has(sha256);
    const r = runProgram(rom, cas, { name, frames, every, keys, full });
    fs.writeSync(fd, JSON.stringify({ program: f, sha256, machine: 'dragon64', rom: crc, full, ...r }) + '\n');
    console.log(`${r.status.padEnd(17)} ${f}${r.listLines != null ? ` (${r.listLines} lines` + (r.samples ? `, ${r.samples.length} samples)` : ')') : ''}${r.why ? `: ${r.why}` : ''}`);
  }
  fs.closeSync(fd);
}

module.exports = { runProgram, romGuard, corpusLint, joinListing, parseKeys };
if (require.main === module) main();
