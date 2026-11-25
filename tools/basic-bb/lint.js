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
//     a "... AND 32767" address: its POKEs are reviewed by hand.
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
  const endLine = (s) => /^\s*\d+\s*END\s*:/.test(s);
  const usesCont = lines.some((l) => !endLine(code(l.line)) && code(l.line).includes('CONT'));
  // memory set aside with CLEAR n,top as the first line typed: POKE may write from top up
  const first = lines.find((l) => l.line.trim());
  const reserve = first && /^\s*CLEAR\s*\d+\s*,\s*(\d+)\s*$/i.exec(first.line);
  const top = reserve ? Number(reserve[1]) : null;
  for (const { line, at } of lines) {
    const s = code(line), where = `line ${at}`;
    if (!usesCont && endLine(s)) continue;
    if (/EXEC|USR|CLOADM|CSAVEM|VARPTR/.test(s)) problems.push(`${where}: EXEC, USR, DEFUSR, CLOADM, CSAVEM and VARPTR are not allowed in a black-box case`);
    for (let p = s.indexOf('PEEK'); p >= 0; p = s.indexOf('PEEK', p + 4)) {
      const open = s.indexOf('(', p);
      const arg = open >= 0 && /^\s*$/.test(s.slice(p + 4, open)) ? argAt(s, open) : null;
      if (arg == null || !(literalOk(arg) || maskedOk(arg))) problems.push(`${where}: PEEK(${arg == null ? '?' : arg}) might read the ROM: use a literal below 32768 or "... AND 32767"`);
    }
    for (let p = s.indexOf('POKE'); p >= 0; p = s.indexOf('POKE', p + 4)) {
      const addr = addrArg(s, p + 4), v = addr == null ? null : literal(addr);
      const ok = v != null ? (v >= 0x400 && v < 0x600) || (top != null && v >= top && v < 0x8000) : bbOnly && addr != null && maskedOk(addr);
      if (!ok) problems.push(`${where}: POKE ${addr == null ? '?' : addr}: only to the text screen ($0400-$05FF) or above the top a first line CLEAR n,top set aside`);
    }
  }
  return problems;
}
module.exports = { lintCase };

if (require.main === module) {
  let bad = 0;
  for (const f of process.argv.slice(2)) {
    const p = lintCase(fs.readFileSync(f, 'utf8'));
    for (const x of p) console.log(`${f}: ${x}`);
    bad += p.length;
  }
  process.exitCode = bad ? 1 : 0;
}
