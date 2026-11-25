#!/usr/bin/env node
// The black-box case lint (docs/clean-room-basic.md section 7): a case may not read the ROM, so no recorded result
// can carry ROM contents. Refused:
//   * EXEC, USR and DEFUSR anywhere (machine code a case POKEs could read the ROM; those are tested in our own suite);
//   * CLOADM and CSAVEM (they move memory images);
//   * PEEK( whose argument is not a literal below 32768 or an expression ending in "AND 32767" with no OR in it
//     (AND binds after arithmetic and relations, and its result is a 16-bit integer, so that keeps it in RAM);
//   * POKE whose address is not such a literal or expression either, and VARPTR anywhere: a case must not find
//     a string descriptor and point it into the ROM, so that PRINT would show the ROM's bytes.
// Only functional results are recorded: what the screen shows. tests/basic/harness.js adds a guard at run time:
// a case whose code runs instructions from RAM it wrote is stopped and nothing of it is recorded.
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
const literalOk = (a) => {
  const t = unwrap(a).replace(/\s+/g, '');
  if (/^\d+$/.test(t)) return Number(t) < 32768;
  if (/^&H[0-9A-F]+$/.test(t)) return parseInt(t.slice(2), 16) < 0x8000;
  return false;
};
// an argument with its outer parentheses taken off: (A AND 32767) is A AND 32767
function unwrap(a) {
  let t = a.trim();
  while (t[0] === '(' && argAt(t, 0) === t.slice(1, -1)) t = t.slice(1, -1).trim();
  return t;
}
const maskedOk = (a) => /AND\s*32767\s*$/.test(unwrap(a)) && !/\bOR\b/.test(a);

// -> [] or a list of problems, each "line N: why"
function lintCase(text) {
  const problems = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (raw.startsWith('#')) return;
    const s = code(raw), where = `line ${i + 1}`;
    if (/^\s*\d+\s*END\s*:/.test(s)) return;
    if (/\b(EXEC|USR|DEFUSR|CLOADM|CSAVEM|VARPTR)/.test(s)) problems.push(`${where}: EXEC, USR, DEFUSR, CLOADM, CSAVEM and VARPTR are not allowed in a black-box case`);
    for (let at = s.indexOf('PEEK'); at >= 0; at = s.indexOf('PEEK', at + 4)) {
      const open = s.indexOf('(', at);
      const arg = open >= 0 && /^\s*$/.test(s.slice(at + 4, open)) ? argAt(s, open) : null;
      if (arg == null || !(literalOk(arg) || maskedOk(arg))) problems.push(`${where}: PEEK(${arg == null ? '?' : arg}) might read the ROM: use a literal below 32768 or "... AND 32767"`);
    }
    for (let at = s.indexOf('POKE'); at >= 0; at = s.indexOf('POKE', at + 4)) {
      const addr = addrArg(s, at + 4);
      if (addr == null || !(literalOk(addr) || maskedOk(addr))) problems.push(`${where}: POKE ${addr == null ? '?' : addr} must write RAM: use a literal below 32768 or "... AND 32767"`);
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
