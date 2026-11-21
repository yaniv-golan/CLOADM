/* Assembler syntax shared by the engine and the instruction-set plugins: errors, expressions, operand lists. */
class AsmError extends Error {
  // file and line are optional so an error raised where they are not known yet still works; when they are
  // known the caller gets a real line instead of 0, which points at no line of the source at all. Held on the
  // error rather than passed around, because an expression deep inside a parser has no other way to say where
  // it was.
  constructor(message, file = null, line = null) {
    super(message);
    this.file = file;
    this.line = line;
  }
}

// What follows a mnemonic that takes no operand. Motorola's convention makes it a comment ("LSRA   shift the row bit",
// no ; needed), but text that starts like an operand ("ABX 1", "LSRA ,X") is almost always a mistake, not a remark, so
// it stays an error.
function noOperand(mn, rest) {
  if (rest && /^[#$%0-9,[<>(+\-'@]/.test(rest)) throw new AsmError(`${mn} takes no operand (a comment after it that starts like one needs ;)`);
}

// ---------- expressions ----------
function evalExpr(text, ctx) {
  let p = 0;
  const s = text.trim();
  let unresolved = false;
  const ws = () => { while (s[p] === ' ' || s[p] === '\t') p++; };
  function primary() {
    ws();
    const c = s[p];
    if (c === '(') { p++; const v = sum(); ws(); if (s[p] !== ')') throw new AsmError('missing )'); p++; return v; }
    if (c === '-') { p++; return -primary(); }
    if (c === '+') { p++; return primary(); }
    if (c === '$') { const m = /^\$[0-9A-Fa-f]+/.exec(s.slice(p)); if (!m) throw new AsmError('bad hex'); p += m[0].length; return parseInt(m[0].slice(1), 16); }
    if (c === '%') { const m = /^%[01]+/.exec(s.slice(p)); if (!m) throw new AsmError('bad binary'); p += m[0].length; return parseInt(m[0].slice(1), 2); }
    if (c === "'") { const ch = s.charCodeAt(p + 1); p += 2; if (s[p] === "'") p++; return ch; }
    if (c === '*') { p++; return ctx.pc; }
    let m = /^[0-9]+/.exec(s.slice(p));
    if (m) { p += m[0].length; return parseInt(m[0], 10); }
    m = /^[A-Za-z_.@][A-Za-z0-9_.@$]*/.exec(s.slice(p));
    if (m) {
      p += m[0].length;
      const name = m[0].toUpperCase();
      if (ctx.symbols.has(name)) return ctx.symbols.get(name);
      if (ctx.pass === 2) throw new AsmError('undefined symbol ' + m[0]);
      unresolved = true;
      return 0;
    }
    throw new AsmError('bad expression "' + text + '"');
  }
  function prod() {
    let v = primary();
    for (;;) {
      ws();
      const c = s[p];
      if (c === '*') { p++; v *= primary(); } else if (c === '/') {
        p++;
        const d = primary();
        // a symbol not yet defined reads 0 in pass 1: only a known divisor of 0 is an error
        if (d === 0 && !unresolved) throw new AsmError('division by zero');
        v = d === 0 ? 0 : Math.trunc(v / d);
      }
      else if (c === '&') { p++; v &= primary(); } else return v;
    }
  }
  function sum() {
    let v = prod();
    for (;;) {
      ws();
      const c = s[p];
      if (c === '+') { p++; v += prod(); } else if (c === '-') { p++; v -= prod(); }
      else if (c === '|' || c === '!') { p++; v |= prod(); } else return v;
    }
  }
  const v = sum();
  ws();
  // an operand may hold spaces ("1 + 2"), so a comment after one needs its ;
  if (p !== s.length) throw new AsmError('junk in expression "' + text + '"' + (/\s/.test(text) ? ' (a comment after an operand needs ;)' : ''));
  return { value: v, unresolved };
}

// a value for a field of `bits` bits: signed or unsigned (-128..255 for a byte), else an error
function fit(v, bits) {
  const lo = -(2 ** (bits - 1)), hi = 2 ** bits - 1;
  if (v < lo || v > hi) throw new AsmError(`value ${v} out of range for ${bits} bits (${lo} to ${hi})`);
  return v;
}

// split on commas not inside quotes/brackets
function splitArgs(s) {
  const out = []; let cur = '', q = null, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"') { q = c; cur += c; continue; }
    if (c === "'" ) { cur += c + (s[i + 1] || ''); i++; if (s[i + 1] === "'") { cur += "'"; i++; } continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

export { AsmError, splitArgs, evalExpr, fit, noOperand };
