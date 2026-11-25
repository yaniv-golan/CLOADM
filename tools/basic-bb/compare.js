#!/usr/bin/env node
// Compare two black-box result files (tools/basic-bb/run.js): the real ROM's and ours. Case by case, the status and
// the transcript line by line; the first differing line of each case is shown with its neighbours.
// Corpus results (tools/basic-bb/corpus.js, one record a program, matched by the tape's sha256): per program the
// status, whether the listing is identical (or its first differing line), the first RUN sample where the screen's text
// or pixels part, and the error lines.
// Sounds (#wav) are compared by their measures (compareSounds, below).
// Pictures (#screenshot) are compared by the SHA-256 of their pixels; --shots DIR writes both PNGs of each one that
// differs.
//   node tools/basic-bb/compare.js real.jsonl ours.jsonl [--shots DIR]     exit 1 if any case or program differs or is missing
const fs = require('fs');

const records = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const read = (f) => new Map(records(f).map((r) => [r.case != null ? r.case : r.sha256, r]));

// two corpus result files' records (Maps by sha256) -> { same, report }
function compareCorpus(a, b) {
  const out = [];
  let same = 0;
  for (const [key, x] of a) {
    const y = b.get(key), name = x.program;
    if (!y) { out.push(`${name}: missing from the second file`); continue; }
    const notes = [];
    if (x.status !== y.status) notes.push(`status ${x.status} vs ${y.status}`);
    const lx = x.list || [], ly = y.list || [];
    let at = -1;
    for (let i = 0; i < Math.max(lx.length, ly.length); i++) if (lx[i] !== ly[i]) { at = i; break; }
    if (at >= 0) notes.push(`LIST differs from line ${at + 1} of ${lx.length} vs ${ly.length}${x.full && y.full ? `: ${JSON.stringify(lx[at] ?? '(none)')} vs ${JSON.stringify(ly[at] ?? '(none)')}` : ''}`);
    else if (x.list || y.list) notes.push(`LIST identical (${lx.length} lines)`);
    const sx = x.samples || [], sy = y.samples || [];
    let part = null;
    for (let i = 0; i < Math.min(sx.length, sy.length); i++) {
      const t = JSON.stringify(sx[i].screen) !== JSON.stringify(sy[i].screen), p = sx[i].pix !== sy[i].pix;
      if (t || p || sx[i].frame !== sy[i].frame) { part = `${sx[i].frame}${t ? ' (text' + (p ? ' and pixels)' : ')') : ' (pixels)'}`; break; }
    }
    if (part == null && sx.length !== sy.length) part = `after frame ${(sx[Math.min(sx.length, sy.length) - 1] || { frame: 0 }).frame} (${sx.length} vs ${sy.length} samples)`;
    if (part) notes.push(`RUN parts at frame ${part}`);
    if ((x.error || null) !== (y.error || null)) notes.push(`error ${JSON.stringify(x.error || null)} vs ${JSON.stringify(y.error || null)}`);
    const differs = notes.some((n) => !n.startsWith('LIST identical'));
    if (!differs) { same++; continue; }
    out.push(`${name}: ${notes.join('; ')}`);
  }
  for (const [key, y] of b) if (!a.has(key)) out.push(`${y.program}: missing from the first file`);
  return { same, report: out };
}

// Sounds (#wav ... #wav-stop: tests/basic/harness.js soundMeasures): the same names, the same number of tones, and
// for each tone the period within 0.5%, the length and the silence before it (from the end of the tone before;
// the first tone's start is not compared, as it depends on how fast each ROM takes the typed line) within one field
// (17,784 cycles: 312 lines of 57 on the Dragon 64), the lowest and highest level exactly, and the sound enable and
// multiplexer at #wav-stop. The number of distinct levels, writes and periods are the wave's shape, which is ours
// (docs/clean-room-basic-p2.md section 14, decision 3), and the hash tells runs apart: neither is compared.
const FIELD = 312 * 57;
function compareSounds(sx = [], sy = []) {
  if (sx.length !== sy.length) return [`${sx.length} vs ${sy.length} sounds`];
  const out = [];
  sx.forEach((x, i) => {
    const y = sy[i], at = `sound ${x.name}`;
    if (x.name !== y.name) { out.push(`${at}: named ${y.name} in the second`); return; }
    if (JSON.stringify(x.end) !== JSON.stringify(y.end)) out.push(`${at}: at the end ${JSON.stringify(x.end)} vs ${JSON.stringify(y.end)}`);
    if (x.tones.length !== y.tones.length) { out.push(`${at}: ${x.tones.length} vs ${y.tones.length} tones`); return; }
    x.tones.forEach((p, j) => {
      const q = y.tones[j], t = `${at} tone ${j + 1}`;
      if ((p.period == null) !== (q.period == null) || (p.period != null && Math.abs(p.period - q.period) > 0.005 * p.period)) out.push(`${t}: period ${p.period} vs ${q.period} cycles`);
      if (Math.abs(p.length - q.length) > FIELD) out.push(`${t}: length ${p.length} vs ${q.length} cycles`);
      if (j > 0) {
        const gap = (s, k) => s.tones[k].start - (s.tones[k - 1].start + s.tones[k - 1].length);
        if (Math.abs(gap(x, j) - gap(y, j)) > FIELD) out.push(`${t}: silence before it ${gap(x, j)} vs ${gap(y, j)} cycles`);
      }
      if (p.low !== q.low || p.high !== q.high) out.push(`${t}: levels ${p.low}-${p.high} vs ${q.low}-${q.high}`);
    });
  });
  return out;
}

function compare(a, b, shotDir = null) {
  const out = [];
  let same = 0;
  for (const [name, x] of a) {
    const y = b.get(name);
    if (!y) { out.push(`${name}: missing from the second file`); continue; }
    if (x.status !== y.status) { out.push(`${name}: status ${x.status} vs ${y.status}`); continue; }
    const n = Math.max(x.transcript.length, y.transcript.length);
    let at = -1;
    for (let i = 0; i < n; i++) if (x.transcript[i] !== y.transcript[i]) { at = i; break; }
    // the pictures: the same names, the same pixels (with --shots DIR, both PNGs of a differing one are written there)
    const sx = x.shots || [], sy = y.shots || [];
    const badShot = sx.length !== sy.length ? `${sx.length} vs ${sy.length} pictures` : sx.map((p, i) => (p.name !== sy[i].name || p.sha256 !== sy[i].sha256 ? p.name : null)).filter(Boolean).join(', ');
    if (badShot) {
      out.push(`${name}: pictures differ: ${badShot}`);
      if (shotDir) sx.forEach((p, i) => { if (sy[i] && p.sha256 !== sy[i].sha256) for (const [tag, q] of [['first', p], ['second', sy[i]]]) fs.writeFileSync(require('path').join(shotDir, `${name}-${q.name}-${tag}.png`), Buffer.from(q.png, 'base64')); });
    }
    const badSound = compareSounds(x.sounds, y.sounds);
    for (const l of badSound) out.push(`${name}: ${l}`);
    if (at < 0 && !badShot && !badSound.length) { same++; continue; }
    if (at < 0) continue;
    const show = (t, i) => (i < t.length ? JSON.stringify(t[i]) : '(none)');
    out.push(`${name}: line ${at + 1} differs`);
    for (let i = Math.max(0, at - 2); i <= Math.min(n - 1, at + 2); i++) out.push(`  ${i === at ? '>' : ' '} ${show(x.transcript, i).padEnd(36)} ${show(y.transcript, i)}`);
  }
  for (const name of b.keys()) if (!a.has(name)) out.push(`${name}: missing from the first file`);
  return { same, report: out };
}
module.exports = { compare, compareCorpus, compareSounds };

if (require.main === module) {
  const args = process.argv.slice(2), si = args.indexOf('--shots');
  const shotDir = si >= 0 ? args[si + 1] : null;
  const [f1, f2] = args.filter((a, i) => !a.startsWith('--') && (si < 0 || i !== si + 1));
  if (!f1 || !f2) {
    console.error('usage: node tools/basic-bb/compare.js real.jsonl ours.jsonl');
    process.exitCode = 2;
  } else {
    const a = read(f1), b = read(f2), corpus = [...a.values()].some((r) => r.program != null);
    const { same, report } = corpus ? compareCorpus(a, b) : compare(a, b, shotDir);
    for (const l of report) console.log(l);
    console.log(`${same} ${corpus ? 'programs' : 'cases'} identical`);
    process.exitCode = report.length ? 1 : 0;
  }
}
