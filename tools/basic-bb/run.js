#!/usr/bin/env node
// Black-box runner for Dragon 64 BASIC (docs/clean-room-basic.md section 7): runs BASIC cases on any Dragon 64
// 32K-mode BASIC ROM, headless, and records only what the screen shows. A maintainer runs it on the real ROM on
// their own machine and hands back the results file; we run it on ours and compare (tools/basic-bb/compare.js).
//
//   node tools/basic-bb/run.js --rom FILE [--cases DIR] [--only a,b] --out results.jsonl
//   node tools/basic-bb/run.js --ours ...          our clean-room BASIC, assembled from basic/
//   ... --local --only NAME                       also run a local-only case: its shape is printed, never written
//
// --rom is the 16K image for the Dragon 64's "basic" socket (the 32K-mode BASIC, d64_1). --cases is a folder of
// .bas case files (default tests/basic/cases); every case is linted first (tools/basic-bb/lint.js) and a case that
// might read the ROM is refused. Each case runs on a fresh machine typed through the keyboard; the output is one
// JSON object a line: { case, machine, rom (the CRC-32 of the ROM image, to tell runs apart), status, frames,
// transcript (the lines that reached the screen, in order), flags, and shots (each #screenshot: the picture as a PNG
// and the SHA-256 of its pixels), and sounds (each #wav ... #wav-stop: measures only, tests/basic/harness.js
// soundMeasures), and tapes (each #tape-blocks: the blocks written, a data block's SHA-256 in place of its bytes, and
// the motor's runs) }. Nothing of the ROM but its CRC is written, no sound but its measures, no tape but its summary.
// A case's #tape NAME plays the fixture tests/basic/tapes/NAME.json (tools/basic-bb/tapes.js).
const fs = require('fs'), path = require('path');
const { runCase, Emu } = require('../../tests/basic/harness.js');
const { lintCase } = require('./lint.js');

function main() {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const usage = (msg) => { console.error(`basic-bb: ${msg}\nusage: node tools/basic-bb/run.js (--rom FILE | --ours) [--cases DIR] [--only a,b] --out FILE`); process.exitCode = 2; };

  let rom;
  if (args.includes('--ours')) rom = require('../build-basic.js').buildBasic().rom;
  else if (opt('--rom')) rom = new Uint8Array(fs.readFileSync(opt('--rom')));
  else return usage('give --rom FILE or --ours');
  if (rom.length !== 0x4000) return usage(`the ROM image is ${rom.length} bytes, not 16384`);
  const out = opt('--out');
  if (!out) return usage('give --out FILE');
  const dir = opt('--cases') || path.join(__dirname, '../../tests/basic/cases');
  const only = opt('--only') ? new Set(opt('--only').split(',')) : null;
  const crc = Emu.crc32(rom).toString(16).toUpperCase().padStart(8, '0');

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.bas')).sort();
  const lines = [];
  let failed = 0;
  for (const f of files) {
    const name = f.replace(/\.bas$/, '');
    if (only && !only.has(name)) continue;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    // a local-only case (its output may hold ROM text, such as a hidden message) is never written to the results
    // file: it runs only with --local, and its transcript is printed as its shape (localShape)
    if (/^# local-only\b/m.test(text)) {
      if (!args.includes('--local')) { if (only) console.log(`skipped  ${name} (local-only: run it with --local; its shape is printed, never written)`); continue; }
      const r = runCase(rom, text);
      console.log(`${r.status.padEnd(8)} ${name} (local-only, not written to ${out}):`);
      for (const l of localShape(r.transcript, text)) console.log(`  ${l}`);
      continue;
    }
    const problems = lintCase(text);
    if (problems.length) { console.error(`${name}: refused by the lint:\n  ${problems.join('\n  ')}`); failed++; continue; }
    const r = runCase(rom, text);
    lines.push(JSON.stringify({ case: name, machine: 'dragon64', rom: crc, status: r.status, ...(r.at ? { at: r.at } : {}), ...(r.ended ? { ended: r.ended } : {}), ...(r.why ? { why: r.why } : {}), frames: r.frames, transcript: r.transcript, flags: r.flags, ...(r.shots ? { shots: r.shots } : {}), ...(r.typist ? { typist: r.typist } : {}), ...(r.sounds ? { sounds: r.sounds } : {}), ...(r.tapes ? { tapes: r.tapes } : {}), ...(r.clears ? { clears: r.clears } : {}) }));
    console.log(`${r.status.padEnd(8)} ${name} (${r.frames} frames${r.flags.length ? `, ${r.flags.length} flags` : ''})`);
    if (r.status !== 'ok') failed++;
  }
  fs.writeFileSync(out, lines.join('\n') + (lines.length ? '\n' : ''));
  console.log(`${lines.length} cases written to ${out}`);
  // a record is a result only when its status is ok: one that stopped on a wait (status timeout, with the step it
  // was at) is written too, so that it can be read, and named here
  const bad = lines.map((l) => JSON.parse(l)).filter((r) => r.status !== 'ok');
  console.log(`${lines.length - bad.length} of ${lines.length} ok${bad.length ? `; not results: ${bad.map((r) => `${r.case} (${r.status}${r.at ? ` at ${r.at}` : ''})`).join(', ')}` : ''}`);
  process.exitCode = failed ? 1 : 0;
}

// A local-only case's transcript reduced to its shape, with no text that BASIC printed: the lines the case typed
// (its own text), OK, an empty line and an error line's code stay; any other line becomes <text N> (its length).
function localShape(transcript, caseText) {
  const typed = new Set(caseText.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.trim()));
  return transcript.map((l) => {
    if (l === '' || l === 'OK' || typed.has(l.trim())) return l;
    const e = /^\?([A-Z0-9/]{2}) ERROR( IN \d+)?$/.exec(l);
    if (e) return l;
    return `<text ${l.length}>`;
  });
}
module.exports = { localShape };
if (require.main === module) main();
