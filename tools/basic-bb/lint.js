#!/usr/bin/env node
// The black-box case lint (docs/clean-room-basic.md section 7): a case may not read the ROM, so no recorded result
// can carry ROM contents. Refused:
//   * EXEC, USR and DEFUSR anywhere (machine code a case POKEs could read the ROM; those are tested in our own suite);
//   * CLOADM and CSAVEM (they move memory images);
//   * PEEK( whose argument is not a literal below 32768 or an expression ending in "AND 32767" with no OR in it
//     (AND binds after arithmetic and relations, and its result is a 16-bit integer, so that keeps it in RAM).
// Strings and remarks are not checked (they are not run), nor a line that starts with END: (a line is only ever
// entered at its start, so nothing after that END runs; the token probe lists keywords that way).
//   node tools/basic-bb/lint.js FILE...      exit 1 if any case is refused
const fs = require('fs');

// the program text a line runs: string literals and the remark after REM or ' blanked
function code(line) {
  let out = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { q = !q; out += c; continue; }
    if (q) { out += ' '; continue; }
    if (c === "'" || /^REM/i.test(line.slice(i))) break;
    out += c;
  }
  return out.toUpperCase();
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

const literalOk = (a) => {
  const t = a.replace(/\s+/g, '');
  if (/^\d+$/.test(t)) return Number(t) < 32768;
  if (/^&H[0-9A-F]+$/.test(t)) return parseInt(t.slice(2), 16) < 0x8000;
  return false;
};
const maskedOk = (a) => /AND\s*32767\s*$/.test(a) && !/\bOR\b/.test(a);

// -> [] or a list of problems, each "line N: why"
function lintCase(text) {
  const problems = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (raw.startsWith('#')) return;
    const s = code(raw), where = `line ${i + 1}`;
    if (/^\s*\d+\s*END\s*:/.test(s)) return;
    if (/\b(EXEC|USR|DEFUSR|CLOADM|CSAVEM)/.test(s)) problems.push(`${where}: EXEC, USR, DEFUSR, CLOADM and CSAVEM are not allowed in a black-box case`);
    for (let at = s.indexOf('PEEK'); at >= 0; at = s.indexOf('PEEK', at + 4)) {
      const open = s.indexOf('(', at);
      const arg = open >= 0 && /^\s*$/.test(s.slice(at + 4, open)) ? argAt(s, open) : null;
      if (arg == null || !(literalOk(arg) || maskedOk(arg))) problems.push(`${where}: PEEK(${arg == null ? '?' : arg}) might read the ROM: use a literal below 32768 or "... AND 32767"`);
    }
  });
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
