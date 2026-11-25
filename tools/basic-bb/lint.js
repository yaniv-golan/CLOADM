#!/usr/bin/env node
// The black-box case lint (docs/clean-room-basic.md section 7): a case may not read the ROM, so no recorded result
// can carry ROM contents. Only functional results are recorded: what the screen shows. Every line a case types is
// checked, the #type lines' text included. Refused:
//   * EXEC, USR, DEFUSR, CLOADM, CSAVEM and VARPTR anywhere, matched as plain text (so EXEC glued to another word is
//     refused too): machine code could read the ROM, and VARPTR finds string descriptors a POKE could point into it;
//   * PEEK( whose argument is not a literal below 32768 or an expression ending in "AND 32767" with no OR in it (AND
//     binds after arithmetic and relations, and its result is a 16-bit integer, so that keeps it in RAM);
//   * POKE except to a literal address on the text screen ($0400-$05FF) or in memory the case set aside above BASIC
//     with CLEAR n,top as its first line (top and up): a POKE anywhere else could change BASIC's own pointers, a
//     string descriptor or the program, and make BASIC show the ROM. A probe file marked "# bb-only" may also POKE to
//     a "... AND 32767" address: its POKEs are reviewed by hand. In a case with no PCLEAR, a POKE may also write a
//     literal address in the cold-start graphics pages ($0600-$1DFF), which cannot then overlap the program;
//   * graphics (docs/clean-room-basic-p2.md section 12), so that no picture, PPOINT, POINT or GET can show memory
//     above $7FFF, whether or not the ROM checks its ranges: PCLEAR's argument not a literal 0-9; PMODE's start page
//     not a literal 1-8, or the mode's pages (1, 2, 2, 4, 4; 4 for a mode that is not a literal 0-4) not within the
//     pages the case reserves (the smallest PCLEAR it gives, else 4; a PMODE without a page is taken at the highest
//     page any PMODE gives); PCOPY's pages not literals within those pages; and a point of PSET, PRESET, SET, RESET,
//     LINE, CIRCLE, PAINT, GET, PUT, PPOINT or POINT, or CIRCLE's radius, that is not a literal (x 0-511, y and the
//     radius 0-255) or an expression ending in "AND n" with n up to 255. DRAW's moves come from strings and are not
//     checked: a case's DRAW strings are reviewed by hand to stay on the picture;
//   * a directive tests/basic/harness.js does not know, or a malformed #joy, #frames, #timeout or #wait-text.
// Strings, remarks and DATA are not checked as code, except that REM and ' inside DATA are text (BASIC runs what
// follows them). A program line that starts with END: is not checked either (a line is only ever entered at its
// start, so nothing after that END runs; the token probe lists keywords that way), unless the case uses CONT.
// tests/basic/harness.js adds a guard at run time: a case whose code runs instructions from RAM it wrote is stopped
// and nothing of it is recorded.
//   node tools/basic-bb/lint.js FILE...      exit 1 if any case is refused
const fs = require('fs');

// the program text a line runs: string literals blanked, and the remark after REM or ' (outside DATA) dropped
function code(line) {
  let out = '', q = false, data = false;
  const up = line.toUpperCase();
  for (let i = 0; i < up.length; i++) {
    const c = up[i];
    if (c === '"') { q = !q; out += c; continue; }
    if (q) { out += ' '; continue; }
    if (data) { if (c === ':') data = false; out += c; continue; }
    if (up.startsWith('DATA', i)) { data = true; out += 'DATA'; i += 3; continue; }
    if (c === "'" || up.startsWith('REM', i)) break;
    out += c;
  }
  return out;
}

// the text inside the parentheses that open at `at` (the "("), or null if they never close
function argAt(s, at) {
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return s.slice(at + 1, i);
  }
  return null;
}
// POKE's address: the text up to the first comma outside parentheses
function addrArg(s, at) {
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) return s.slice(at, i).trim();
    else if (s[i] === ':' && depth === 0) return null;
  }
  return null;
}
// an argument with its outer parentheses taken off: (A AND 32767) is A AND 32767
function unwrap(a) {
  let t = a.trim();
  while (t[0] === '(' && argAt(t, 0) === t.slice(1, -1)) t = t.slice(1, -1).trim();
  return t;
}
// a literal address's value, or null
function literal(a) {
  const t = unwrap(a).replace(/\s+/g, '');
  if (/^\d+$/.test(t)) return Number(t);
  if (/^&H[0-9A-F]+$/.test(t)) return parseInt(t.slice(2), 16);
  return null;
}
const literalOk = (a) => { const v = literal(a); return v != null && v < 0x8000; };
const maskedOk = (a) => /AND\s*32767\s*$/.test(unwrap(a)) && !/OR/.test(a);
// an expression ending in "AND n" (no OR in it) with n at most `max`: its value is 0..n
const maskedTo = (a, max) => { const m = /AND\s*(\d+)\s*$/.exec(unwrap(a)); return !!m && Number(m[1]) <= max && !/OR/.test(a); };

const DIRECTIVES = ['type', 'keys', 'break', 'frames', 'wait-text', 'timeout', 'nowait', 'screenshot', 'wav', 'wav-stop', 'joy'];

// ---- P2: graphics (docs/clean-room-basic-p2.md section 12) ----
const PAGE = 0x600, PAGES_OF_MODE = [1, 2, 2, 4, 4];   // PMODE 0-4's pages [UM]
// the arguments of a statement: its text from `at` up to a ':' (or ELSE) outside parentheses, split at top-level commas
function statementAt(s, at) {
  let depth = 0, i = at;
  for (; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (depth === 0 && (s[i] === ':' || s.startsWith('ELSE', i))) break;
  }
  return s.slice(at, i);
}
function splitTop(t) {
  const out = [];
  let depth = 0, from = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '(') depth++;
    else if (t[i] === ')') depth--;
    else if (t[i] === ',' && depth === 0) { out.push(t.slice(from, i)); from = i + 1; }
  }
  out.push(t.slice(from));
  return out.map((x) => x.trim());
}
// a coordinate kept small: a literal from 0 to `lit`, or "... AND n" with n at most 255. Whatever the ROM does with a
// point off the picture, page 8's start ($2D00) plus 255 rows of 32 bytes plus 511 stays below $8000.
const coordOk = (a, lit) => { const v = literal(a); return v != null ? v <= lit : maskedTo(a, 255); };
// the (x,y) groups of a graphics statement's text: a "(" at the start, or after "-" or ",", outside other parentheses
function pointGroups(t) {
  const out = [];
  let depth = 0, prev = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '(' && depth === 0 && (prev === '' || prev === '-' || prev === ',')) { const g = argAt(t, i); if (g == null) { out.push(null); break; } out.push(g); i += g.length + 1; prev = ')'; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c !== ' ') prev = c;
  }
  return out;
}
const pointProblem = (g) => {
  if (g == null) return 'an unclosed (';
  const [x, y] = splitTop(g);
  if (y == null || !coordOk(x, 511) || !coordOk(y, 255)) return `(${g}): each coordinate a literal (x 0-511, y 0-255) or "... AND n" with n up to 255`;
  return null;
};

// the lines a case types: its own lines, and each line of a #type directive (\n separates them)
function typedLines(text) {
  const out = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const m = /^#type\s?(.*)$/.exec(raw);
    if (m) for (const part of m[1].split('\\n')) out.push({ line: part, at: i + 1 });
    else if (!raw.startsWith('#')) out.push({ line: raw, at: i + 1 });
  });
  return out;
}

// -> [] or a list of problems, each "line N: why"
function lintCase(text) {
  const problems = [], lines = typedLines(text);
  const bbOnly = /^# bb-only\b/m.test(text);
  // the directives tests/basic/harness.js knows, well formed, so a case never stops at a bad one on the real ROM
  text.split(/\r?\n/).forEach((raw, i) => {
    const d = /^#(\S*)\s?(.*)$/.exec(raw);
    if (!d || d[1] === '') return;
    const [, cmd, arg] = d, at = `line ${i + 1}`;
    if (!DIRECTIVES.includes(cmd)) problems.push(`${at}: unknown directive #${cmd}`);
    else if (cmd === 'joy' && !(/^([0-3])\s+(\d+)$/.test(arg.trim()) && Number(arg.trim().split(/\s+/)[1]) <= 63)) problems.push(`${at}: #joy N V: N 0-3, V 0-63`);
    else if ((cmd === 'frames' || cmd === 'timeout') && !/^\d+$/.test(arg.trim())) problems.push(`${at}: #${cmd} takes a number`);
    else if (cmd === 'wait-text') { try { new RegExp(arg, 'm'); } catch (e) { problems.push(`${at}: #wait-text: ${e.message}`); } }
  });
  const endLine = (s) => /^\s*\d+\s*END\s*:/.test(s);
  const usesCont = lines.some((l) => !endLine(code(l.line)) && code(l.line).includes('CONT'));
  // memory set aside with CLEAR n,top as the first line typed: POKE may write from top up
  const first = lines.find((l) => l.line.trim());
  const reserve = first && /^\s*CLEAR\s*\d+\s*,\s*(\d+)\s*$/i.exec(first.line);
  const top = reserve ? Number(reserve[1]) : null;
  // P2: the pages the case reserves (the smallest PCLEAR it gives, 4 at cold start), and the highest start page any
  // PMODE gives (a PMODE without one keeps the current page)
  const run = lines.map((l) => ({ ...l, s: code(l.line) })).filter((l) => usesCont || !endLine(l.s));
  const all = (word) => run.flatMap((l) => { const r = []; for (let p = l.s.indexOf(word); p >= 0; p = l.s.indexOf(word, p + word.length)) r.push({ ...l, p, args: statementAt(l.s, p + word.length) }); return r; });
  const pclears = all('PCLEAR').map((x) => ({ ...x, n: literal(x.args) }));
  const pages = pclears.length ? Math.min(...pclears.map((x) => (x.n == null ? 0 : x.n))) : 4;
  const pmodes = all('PMODE').map((x) => { const [m, p] = splitTop(x.args); return { ...x, m: literal(m || ''), p: p == null || p === '' ? null : literal(p), hasP: p != null && p !== '' }; });
  const highest = Math.max(1, ...pmodes.map((x) => x.p || 0));
  for (const x of pclears) if (x.n == null || x.n > 9) problems.push(`line ${x.at}: PCLEAR ${x.args.trim()}: a literal 0-9 (1-8 reserve pages; 0 and 9 are there for the error)`);
  for (const x of pmodes) {
    const need = x.m != null && x.m <= 4 ? PAGES_OF_MODE[x.m] : 4, p = x.hasP ? x.p : highest;
    if ((x.hasP && (p == null || p < 1 || p > 8)) || p + need - 1 > pages) problems.push(`line ${x.at}: PMODE ${x.args.trim()}: the start page a literal 1-8, and the mode's pages (${need}) within the ${pages} the case reserves`);
  }
  for (const x of all('PCOPY')) {
    const m = /^\s*(\S+)\s*TO\s*(\S+)\s*$/.exec(x.args), ok = (v) => v != null && v >= 1 && v <= pages;
    if (!m || !ok(literal(m[1])) || !ok(literal(m[2]))) problems.push(`line ${x.at}: PCOPY ${x.args.trim()}: both pages literals within the ${pages} the case reserves`);
  }
  const gfxEnd = pclears.length ? 0 : 0x600 + 4 * PAGE;     // POKE to a graphics page: only with no PCLEAR
  for (const { line, at } of lines) {
    const s = code(line), where = `line ${at}`;
    if (!usesCont && endLine(s)) continue;
    // the points of PSET, PRESET, SET, RESET, LINE, CIRCLE, PAINT, GET and PUT, and of PPOINT and POINT
    const pts = new Set();
    for (const word of ['PSET', 'PRESET', 'SET', 'LINE', 'CIRCLE', 'PAINT', 'GET', 'PUT']) {
      for (let p = s.indexOf(word); p >= 0; p = s.indexOf(word, p + word.length)) {
        const after = p + word.length;
        if (word === 'PUT' && s.slice(0, p).endsWith('IN')) continue;          // INPUT
        if (word === 'LINE' && /^\s*INPUT/.test(s.slice(after))) continue;    // LINE INPUT
        const t = statementAt(s, after);
        for (const g of pointGroups(t)) { const why = pointProblem(g); if (why) pts.add(`a point ${why}`); }
        if (word === 'CIRCLE') {
          // CIRCLE (x,y),r,...: the centre's commas are in its parentheses. No radius at all (an error case) passes.
          const r = splitTop(t)[1];
          if (r != null && !coordOk(r, 255)) pts.add(`CIRCLE ${t.trim()}: the radius a literal 0-255 or "... AND n" with n up to 255`);
        }
      }
    }
    for (const word of ['PPOINT', 'POINT']) {
      for (let p = s.indexOf(word); p >= 0; p = s.indexOf(word, p + word.length)) {
        const open = s.indexOf('(', p), g = open >= 0 && /^\s*$/.test(s.slice(p + word.length, open)) ? argAt(s, open) : null;
        const why = pointProblem(g);
        if (why) pts.add(`a point ${why}`);
      }
    }
    for (const why of pts) problems.push(`${where}: ${why}`);
    if (/EXEC|USR|CLOADM|CSAVEM|VARPTR/.test(s)) problems.push(`${where}: EXEC, USR, DEFUSR, CLOADM, CSAVEM and VARPTR are not allowed in a black-box case`);
    for (let p = s.indexOf('PEEK'); p >= 0; p = s.indexOf('PEEK', p + 4)) {
      const open = s.indexOf('(', p);
      const arg = open >= 0 && /^\s*$/.test(s.slice(p + 4, open)) ? argAt(s, open) : null;
      if (arg == null || !(literalOk(arg) || maskedOk(arg))) problems.push(`${where}: PEEK(${arg == null ? '?' : arg}) might read the ROM: use a literal below 32768 or "... AND 32767"`);
    }
    for (let p = s.indexOf('POKE'); p >= 0; p = s.indexOf('POKE', p + 4)) {
      const addr = addrArg(s, p + 4), v = addr == null ? null : literal(addr);
      const ok = v != null ? (v >= 0x400 && v < 0x600) || (v >= 0x600 && v < gfxEnd) || (top != null && v >= top && v < 0x8000) : bbOnly && addr != null && maskedOk(addr);
      if (!ok) problems.push(`${where}: POKE ${addr == null ? '?' : addr}: only to the text screen ($0400-$05FF), the cold-start graphics pages ($0600-$1DFF) in a case with no PCLEAR, or above the top a first line CLEAR n,top set aside`);
    }
  }
  return problems;
}
module.exports = { lintCase, code, argAt, literal, unwrap, maskedOk };

if (require.main === module) {
  let bad = 0;
  for (const f of process.argv.slice(2)) {
    const p = lintCase(fs.readFileSync(f, 'utf8'));
    for (const x of p) console.log(`${f}: ${x}`);
    bad += p.length;
  }
  process.exitCode = bad ? 1 : 0;
}
