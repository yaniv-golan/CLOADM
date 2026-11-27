#!/usr/bin/env node
// Compare two black-box result files (tools/basic-bb/run.js): the real ROM's and ours. Case by case, the status and
// the transcript line by line; the first differing line of each case is shown with its neighbours.
// Corpus results (tools/basic-bb/corpus.js, one record a program, matched by the tape's sha256): per program the
// status, whether the listing is identical (or its first differing line), the first RUN sample where the screen's text
// or pixels part, and the error lines.
// Sounds (#wav) are compared by their measures (compareSounds, below), tapes (#tape-blocks) by their summaries
// (compareTapes), the printer's bytes exactly (comparePrinter).
// No frame count is compared: a record's frames count from power-on and the two ROMs' cold starts differ in length
// (docs/clean-room-basic.md, section 10 decision 13); a timing read by hand from two records is lined up from each
// one's `start`, the frame at which the clean start's OK held (or, in a record made before that field, its first
// flag). Nothing here reads `start`.
// Pictures (#screenshot) are compared by the SHA-256 of their pixels; --shots DIR writes both PNGs of each one that
// differs. Two text-screen pictures that differ in one 8 x 12 cell only differ in the blinking cursor (cursorOnly):
// they are listed apart as "cursor only" and count as the same.
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
// multiplexer at #wav-stop. The hash tells runs apart and is not compared, nor is the number of periods (the length,
// compared, already says it).
// A tone's shape: its first level, its number of distinct levels and its writes are compared only when the first
// record's tone has `first` (a record made since the field was added; an older record, made when the wave's shape was
// ours alone, docs/clean-room-basic-p2.md section 14 decision 3, is not compared on any of the three, so its verdict
// stays what it was). Then the first level and the number of levels exactly: they are the wave's own (where its table
// or its steps start, how many steps), the same at whatever point in a field the note starts. The writes within a
// bound: a tone's length is allowed one field (where the field interrupt falls decides when a note's count of fields
// ends), and the writes come at the tone's own rate, so one field more or less of the tone is
// ceil(writes / length * 17,784) writes more or less, plus one for the write at either end; the bound is taken from
// the first record's tone.
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
      if (p.first != null) {
        if (p.first !== q.first) out.push(`${t}: first level ${p.first} vs ${q.first}`);
        if (p.levels !== q.levels) out.push(`${t}: ${p.levels} vs ${q.levels} distinct levels`);
        const bound = Math.ceil(p.writes / Math.max(p.length, 1) * FIELD) + 1;
        if (Math.abs(p.writes - q.writes) > bound) out.push(`${t}: ${p.writes} vs ${q.writes} writes (more than ${bound} apart)`);
      }
    });
  });
  return out;
}

// Tapes (#tape-blocks: tests/basic/harness.js tapeDeck): the same summaries by name; the blocks exactly (type, length,
// checksum, leader, the namefile's fields, the data's hash) and the number of bad ones; the motor's runs: as many, each
// carried or not alike, its start and length within one field (a run still going, length null, only matches another;
// a carried run's length is not compared: it ends when the next line is typed).
function compareTapes(tx = [], ty = []) {
  if (tx.length !== ty.length) return [`${tx.length} vs ${ty.length} tape summaries`];
  const out = [];
  tx.forEach((x, i) => {
    const y = ty[i], at = `tape ${x.name}`;
    if (x.name !== y.name) { out.push(`${at}: named ${y.name} in the second`); return; }
    const bx = x.blocks || null, by = y.blocks || null;
    if ((bx == null) !== (by == null)) out.push(`${at}: blocks recorded in only one`);
    else if (bx) {
      if (bx.length !== by.length) out.push(`${at}: ${bx.length} vs ${by.length} blocks`);
      else bx.forEach((k, j) => { if (JSON.stringify(k) !== JSON.stringify(by[j])) out.push(`${at} block ${j + 1}: ${JSON.stringify(k)} vs ${JSON.stringify(by[j])}`); });
      if (x.bad !== y.bad) out.push(`${at}: ${x.bad} vs ${y.bad} bad blocks`);
    }
    const mx = x.motor || [], my = y.motor || [];
    if (mx.length !== my.length) { out.push(`${at}: ${mx.length} vs ${my.length} motor runs`); return; }
    mx.forEach((r, j) => {
      const q = my[j], t = `${at} motor run ${j + 1}`;
      if (!!r.carried !== !!q.carried) out.push(`${t}: carried in only one`);
      if (Math.abs(r.start - q.start) > 1) out.push(`${t}: starts at ${r.start} vs ${q.start} fields`);
      if ((r.length == null) !== (q.length == null)) out.push(`${t}: ${r.length == null ? 'still running' : `${r.length} fields`} vs ${q.length == null ? 'still running' : `${q.length} fields`}`);
      else if (r.length != null && !r.carried && Math.abs(r.length - q.length) > 1) out.push(`${t}: ${r.length} vs ${q.length} fields`);
    });
  });
  return out;
}

// A picture's pixels from its PNG (8-bit RGBA, as tests/basic/harness.js writes it: no filter on any row) -> { w, h,
// at(x, y) } or null for any other PNG.
function pngPixels(b64) {
  const buf = Buffer.from(b64, 'base64'), idat = [];
  let w = 0, h = 0;
  for (let p = 8; p + 8 <= buf.length;) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); if (d[8] !== 8 || d[9] !== 6) return null; }
    if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  let raw;
  try { raw = require('zlib').inflateSync(Buffer.concat(idat)); } catch { return null; }
  if (!w || raw.length !== (w * 4 + 1) * h) return null;
  for (let y = 0; y < h; y++) if (raw[y * (w * 4 + 1)] !== 0) return null;
  return { w, h, at: (x, y) => raw.readUInt32BE(y * (w * 4 + 1) + 1 + x * 4) };
}

// The cursor: a picture taken at a prompt shows the cursor's cell, and the original's cursor changes colour as it
// blinks, so which colour a picture catches is timing luck (docs/clean-room-basic-p2.md section 11). Two pictures of
// the text screen (both borders black, as the VDG shows text) whose differing pixels all lie in one 8 x 12 cell of
// the 32 x 16 grid (the picture's 256 x 192 area centred in the frame), that cell a solid block of one colour in
// each (as the cursor is), differ only in the cursor: -> 'col,row' of that cell, or null.
function cursorOnly(p, q) {
  const A = pngPixels(p.png || ''), B = pngPixels(q.png || '');
  if (!A || !B || A.w !== B.w || A.h !== B.h || A.w < 256 || A.h < 192) return null;
  const x0 = (A.w - 256) >> 1, y0 = (A.h - 192) >> 1, black = (v) => (v >>> 8) === 0x0A0A0A;
  if (!black(A.at(0, 0)) || !black(B.at(0, 0))) return null;
  let cell = null;
  for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
    if (A.at(x, y) === B.at(x, y)) continue;
    const cx = x - x0, cy = y - y0;
    if (cx < 0 || cy < 0 || cx >= 256 || cy >= 192) return null;
    const c = [cx >> 3, Math.floor(cy / 12)];
    if (cell && (cell[0] !== c[0] || cell[1] !== c[1])) return null;
    cell = c;
  }
  if (!cell) return null;
  for (const P of [A, B]) {
    const at = (i) => P.at(x0 + cell[0] * 8 + (i & 7), y0 + cell[1] * 12 + (i >> 3));
    for (let i = 1; i < 96; i++) if (at(i) !== at(0)) return null;
  }
  return cell.join(',');
}

function compare(a, b, shotDir = null) {
  const out = [], cursor = [];
  let same = 0;
  for (const [name, x] of a) {
    const y = b.get(name);
    if (!y) { out.push(`${name}: missing from the second file`); continue; }
    if (x.status !== y.status) { out.push(`${name}: status ${x.status} vs ${y.status}`); continue; }
    // (a case that ended at an expected timeout: where, on both)
    const endA = x.ended ? `${x.ended.as} at ${x.ended.at}` : 'the end', endB = y.ended ? `${y.ended.as} at ${y.ended.at}` : 'the end';
    if (endA !== endB) { out.push(`${name}: ended at ${endA} vs ${endB}`); continue; }
    const n = Math.max(x.transcript.length, y.transcript.length);
    let at = -1;
    for (let i = 0; i < n; i++) if (x.transcript[i] !== y.transcript[i]) { at = i; break; }
    // the pictures: the same names, the same pixels (with --shots DIR, both PNGs of a differing one are written there)
    // (a picture that differs only in the cursor's cell is listed apart, as "cursor only", and is not a difference)
    const sx = x.shots || [], sy = y.shots || [], onlyCursor = [];
    const badShot = sx.length !== sy.length ? `${sx.length} vs ${sy.length} pictures` : sx.map((p, i) => {
      if (p.name !== sy[i].name) return p.name;
      if (p.sha256 === sy[i].sha256) return null;
      const cell = cursorOnly(p, sy[i]);
      if (cell) { onlyCursor.push(`${p.name} (cell ${cell})`); return null; }
      return p.name;
    }).filter(Boolean).join(', ');
    if (onlyCursor.length) cursor.push(`${name}: cursor only: ${onlyCursor.join(', ')}`);
    if (badShot) {
      out.push(`${name}: pictures differ: ${badShot}`);
      if (shotDir) sx.forEach((p, i) => { if (sy[i] && p.sha256 !== sy[i].sha256) for (const [tag, q] of [['first', p], ['second', sy[i]]]) fs.writeFileSync(require('path').join(shotDir, `${name}-${q.name}-${tag}.png`), Buffer.from(q.png, 'base64')); });
    }
    const badSound = compareSounds(x.sounds, y.sounds), badTape = compareTapes(x.tapes, y.tapes), badClear = compareClears(x.clears, y.clears);
    const badPrinter = comparePrinter(x.printer, y.printer);
    for (const l of [...badSound, ...badTape, ...badClear, ...badPrinter]) out.push(`${name}: ${l}`);
    if (at < 0 && !badShot && !badSound.length && !badTape.length && !badClear.length && !badPrinter.length) { same++; continue; }
    if (at < 0) continue;
    const show = (t, i) => (i < t.length ? JSON.stringify(t[i]) : '(none)');
    out.push(`${name}: line ${at + 1} differs`);
    for (let i = Math.max(0, at - 2); i <= Math.min(n - 1, at + 2); i++) out.push(`  ${i === at ? '>' : ' '} ${show(x.transcript, i).padEnd(36)} ${show(y.transcript, i)}`);
  }
  for (const name of b.keys()) if (!a.has(name)) out.push(`${name}: missing from the first file`);
  return { same, report: out, cursor };
}
// the screens clears wiped (runCase's clears): compared only when both records have the field (a record made before
// it existed has none), screen by screen, their frames not (timing differs) -> lines describing each difference
function compareClears(p, q) {
  if (!p || !q) return [];
  const out = [];
  if (p.length !== q.length) out.push(`clears: ${p.length} vs ${q.length}`);
  for (let i = 0; i < Math.min(p.length, q.length); i++)
    if (JSON.stringify(p[i].screen) !== JSON.stringify(q[i].screen)) out.push(`clear ${i + 1}: the screen before it differs (${JSON.stringify(p[i].screen.slice(-2))} vs ${JSON.stringify(q[i].screen.slice(-2))})`);
  return out;
}
// the printer's bytes (runCase's printer, { length, hex }: written only when the case printed): compared exactly when
// the first record has the field; a first record without it (nothing printed, or made before the field existed) is
// not compared, so older records keep their verdicts -> lines describing the difference
// Only a first record taken under the strobe rule of `rule: 2` (tests/basic/harness.js isPrinterStrobe) is compared:
// one without it (bb10's) was taken under the rule before, which counted a sound's DAC writes as printing.
function comparePrinter(p, q) {
  if (!p || p.rule !== 2) return [];
  if (!q) return [`printer: ${p.length} bytes vs none`];
  if (p.length !== q.length || p.hex !== q.hex) {
    let i = 0;
    while (i < p.hex.length && p.hex[i] === q.hex[i]) i++;
    return [`printer: ${p.length} vs ${q.length} bytes, first difference at byte ${i >> 1}`];
  }
  return [];
}
module.exports = { compare, compareCorpus, compareSounds, compareTapes, compareClears, comparePrinter, cursorOnly };

if (require.main === module) {
  const args = process.argv.slice(2), si = args.indexOf('--shots');
  const shotDir = si >= 0 ? args[si + 1] : null;
  const [f1, f2] = args.filter((a, i) => !a.startsWith('--') && (si < 0 || i !== si + 1));
  if (!f1 || !f2) {
    console.error('usage: node tools/basic-bb/compare.js real.jsonl ours.jsonl');
    process.exitCode = 2;
  } else {
    const a = read(f1), b = read(f2), corpus = [...a.values()].some((r) => r.program != null);
    const { same, report, cursor = [] } = corpus ? compareCorpus(a, b) : compare(a, b, shotDir);
    for (const l of report) console.log(l);
    for (const l of cursor) console.log(l);
    console.log(`${same} ${corpus ? 'programs' : 'cases'} identical${cursor.length ? ` (${cursor.length} with pictures that differ only in the cursor)` : ''}`);
    process.exitCode = report.length ? 1 : 0;
  }
}
