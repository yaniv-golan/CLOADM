/*
 * Two-pass assembler engine with pluggable instruction sets (./isa6809.js, ./isa6803.js, ./isa7000.js).
 *   assemble(source, cpu, { include }) -> { ok, errors[], segments[{addr,data}], exec, symbols, listing[] }
 *   toBinary(result, { format, maxGap }) -> a DragonDOS ('dragondos') or DECB ('decb') binary; the format is required
 * Syntax: [label[:]] mnemonic operand ; comment   (lines starting with * or ; are comments; after a mnemonic that
 *   takes no operand, text is a comment, as in Motorola's assemblers: "LSRA  shift", unless it starts like an operand)
 * Directives: ORG EQU = FCB/DB FDB/DW FCC FCS FCN RMB/DS SETDP INCLUDE END
 * Expressions: + - * / & | ( ), $hex %binary decimal 'c' and * (current address)
 * INCLUDE "file" splices another source file in at that point; the caller supplies the text
 * (include(name) -> string | null) so the assembler stays free of a file system.
 */
import { AsmError, evalExpr, fit, splitArgs } from './syntax.js';
import { isa6809 } from './isa6809.js';
import { registry } from '../util.js';
import { writeDragonDos, writeDecb } from '../media/formats.js';

import { isa6803 } from './isa6803.js';
import { isa6309 } from './isa6309.js';
import { encode as encode7000 } from './isa7000.js';

const ISAS = registry({ '6809': isa6809, '6309': isa6309, '6803': isa6803, '7000': { name: '7000', encode: encode7000 } });

// replace character literals ('c or 'c') outside double quotes with their decimal value
function charLiterals(line) {
  let out = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { q = !q; out += c; continue; }
    if (!q && c === "'" && i + 1 < line.length && !/[A-Za-z0-9_]/.test(line[i - 1] || ' ')) {
      out += String(line.charCodeAt(i + 1));
      i++;
      if (line[i + 1] === "'") i++;
      continue;
    }
    out += c;
  }
  return out;
}

// FCC/FCS/FCN text: "text", or text between any of these delimiters (/text/, !text!), then optionally more
// bytes after a comma -> { text, rest } (rest '' when there is none), or null when the operand is not delimited
const DELIMS = '/!|:^~`\\?';
function delimited(opnd) {
  const d = opnd[0];
  if (!d || !DELIMS.includes(d)) return null;
  const end = opnd.indexOf(d, 1);
  if (end < 0) throw new AsmError(`missing closing ${d} in FCC`);
  const after = opnd.slice(end + 1).trim();
  if (after && after[0] !== ',') throw new AsmError(`junk after the closing ${d}`);
  return { text: opnd.slice(1, end), rest: after.slice(1).trim() };
}

// strip comment (";" outside quotes)
function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"') q = c;
    else if (c === "'") i++;
    else if (c === ';') return line.slice(0, i);
  }
  return line;
}

function assemble(source, cpu = '6809', { include = null, defines = {} } = {}) {
  const isa = ISAS[cpu];
  if (!isa) throw new Error('no instruction set for CPU ' + cpu);
  const lines = source.split(/\r?\n/);
  const symbols = new Map();
  // the caller's assemble-time symbols (see `conditional`): a map of name -> value, or a list of bare names
  // each worth 1, which is how a command line passes them
  if (Array.isArray(defines)) for (const d of defines) symbols.set(String(d).toUpperCase(), 1);
  else for (const [k, v] of Object.entries(defines || {})) symbols.set(String(k).toUpperCase(), v);
  // Kept separately from `symbols`, because the source must not silently overwrite one: `defines` is how a
  // build is told what variant it is, and a source that then EQUates or labels the same name is disagreeing
  // with its own command line (the two would otherwise produce different binaries depending on which won).
  // Every definition below - EQU and a plain code label alike - asks this set first, so the error names the
  // contradiction rather than looking like a source-side duplicate.
  const fromCaller = new Set(symbols.keys());
  // one place for that check, so EQU and a code label cannot drift apart again; raised in both passes on
  // purpose - the pass loop keeps a pass-1 error only for messages matching a small heuristic list, and this
  // one is not on it, and it must not depend on that list anyway
  const notFromCaller = (label) => {
    if (fromCaller.has(label)) throw new AsmError(`${label} is already defined by the caller (it was passed in as a define); the source cannot redefine it`);
  };
  const defined = new Set();     // names given a value by a label or EQU in pass 1 (a second definition is an error)
  const sizeHints = new Map();   // line -> chosen form from pass 1
  const errors = [];
  let result = null;
  // expand INCLUDE directives: the included text takes the directive's place (nested, cycle-checked).
  // `map` records, for every expanded line, the file it came from (null for the source itself) and its
  // line number in that file, so errors and listings name where the text really is.
  const expand = (text, name, stack) => {
    const out = [], map = [];
    const source = text.split(/\r?\n/);
    for (let n = 0; n < source.length; n++) {
      const raw = source[n];
      const m = /^\s*INCLUDE\s+("([^"]+)"|(\S+))\s*(;.*)?$/i.exec(raw);
      if (!m) { out.push(raw); map.push({ file: name, line: n + 1 }); continue; }
      const inc = m[2] ?? m[3];
      // carry the line the INCLUDE is on, so an error about the file it names points at the directive
      if (!include) throw new AsmError(`INCLUDE ${inc}: no file reader`, name, n + 1);
      const next = stack.concat(inc);
      if (next.filter((x) => x === inc).length > 1) throw new AsmError(`INCLUDE ${inc}: a file cannot include itself`, name, n + 1);
      const body = include(inc);
      if (body == null) throw new AsmError(`INCLUDE ${inc}: file not found`, name, n + 1);
      const sub = expand(body, inc, next);
      out.push(...sub.text); map.push(...sub.map);
    }
    return { text: out, map };
  };
  // An error raised outside either pass still says where it is: the AsmError carries the file and line of the
  // directive that raised it, and this turns it into the same {line, file, message} the line loop produces.
  const failure = (e) => ({ line: e.line ?? 0, file: e.file ?? null, message: e.message, src: e.message });
  let expanded, where;
  try { ({ text: expanded, map: where } = expand(source, null, [])); }
  catch (e) { if (!(e instanceof AsmError)) throw e; return { ok: false, errors: [failure(e)], segments: [], listing: [], symbols }; }

  // ---- IF / ELSE / ENDIF, resolved before either pass so both see the same text ----
  // An assemble-time switch: `defines` (a map, or a list of bare names) seeds symbols, and a block is kept
  // only when its expression is non-zero. Done here rather than in the line loop so labels, ORG and anything
  // else inside a block behave exactly as if the selected branch had been written as the source.
  try { ({ text: expanded, map: where } = conditional(expanded, where, symbols)); }
  catch (e) { if (!(e instanceof AsmError)) throw e; return { ok: false, errors: [failure(e)], segments: [], listing: [], symbols }; }

  for (let pass = 1; pass <= 2; pass++) {
    let pc = 0, exec = null, firstOrg = null;
    const segments = [];
    let seg = null;
    const listing = [];
    const emit = (bytes) => {
      if (!seg || seg.addr + seg.data.length !== pc) { seg = { addr: pc, data: [] }; segments.push(seg); }
      for (const b of bytes) { seg.data.push(b & 0xFF); pc = (pc + 1) & 0xFFFF; }
    };

    for (let ln = 0; ln < expanded.length; ln++) {
      const raw = expanded[ln];
      const at = where[ln] || { file: null, line: ln + 1 };   // where this line really is
      if (/^\s*([*;]|$)/.test(raw)) continue;
      const startPc = pc;
      const ctx = { pc, symbols, pass };
      const ev = (t) => evalExpr(t, ctx);
      const val = (t) => ev(t).value;
      // ORG and RMB move every label after them: their value must be known when pass 1 reaches them
      const known = (mn, t) => { const r = ev(t); if (r.unresolved) throw new AsmError(`${mn} needs a value defined before it`); return r.value; };
      try {
        const line = stripComment(charLiterals(raw)).replace(/\s+$/, '');
        let label = null, rest = line;
        const lm = /^([A-Za-z_.@][A-Za-z0-9_.@$]*):?(?=\s|$)/.exec(line);
        if (lm) { label = lm[1].toUpperCase(); rest = line.slice(lm[0].length); }
        else { const lm2 = /^\s+([A-Za-z_.@][A-Za-z0-9_.@$]*):(?=\s|$)/.exec(line); if (lm2) { label = lm2[1].toUpperCase(); rest = line.slice(lm2[0].length); } }
        rest = rest.trim();
        const sp = rest.search(/\s/);
        const mn = (sp < 0 ? rest : rest.slice(0, sp)).toUpperCase();
        const opnd = sp < 0 ? '' : rest.slice(sp).trim();

        if (mn === 'EQU' || mn === '=') {
          if (!label) throw new AsmError('EQU needs a label');
          // checked before the duplicate-label test, so a name the caller defined reports the contradiction
          // it is, rather than "duplicate label" (which would read as if the source had defined it twice)
          notFromCaller(label);
          if (pass === 1) { if (defined.has(label)) throw new AsmError('duplicate label ' + label); defined.add(label); }
          const r = ev(opnd);
          fit(r.value, 16);
          if (pass === 2 || !r.unresolved) symbols.set(label, r.value & 0xFFFF);
          listing.push({ line: at.line, file: at.file, addr: r.value & 0xFFFF, bytes: [], src: raw });
          continue;
        }
        if (label) {
          // a plain code label is a definition of that name too, and it silently replaced a caller's define
          // before; it is caught on the same line the label is on
          notFromCaller(label);
          if (pass === 1) { if (defined.has(label)) throw new AsmError('duplicate label ' + label); defined.add(label); }
          symbols.set(label, pc);
        }
        if (!mn) { listing.push({ line: at.line, file: at.file, addr: pc, bytes: [], src: raw }); continue; }
        // INCLUDE is handled when the text is expanded, before either pass; a label on it would be lost
        if (mn === 'INCLUDE') throw new AsmError('INCLUDE takes no label (it is not an instruction)');

        let bytes = [];
        if (mn === 'ORG') {
          const a = known(mn, opnd);
          if (a < 0 || a > 0xFFFF) throw new AsmError('ORG needs an address from 0 to $FFFF');
          pc = a; if (firstOrg === null) firstOrg = pc; seg = null;
        }
        else if (mn === 'END') { if (opnd) exec = fit(val(opnd), 16) & 0xFFFF; listing.push({ line: at.line, file: at.file, addr: pc, bytes: [], src: raw }); break; }
        else if (mn === 'SETDP') { /* direct page is only used with explicit '<' */ }
        else if (mn === 'RMB' || mn === 'DS') {
          const n = known(mn, opnd);
          if (n < 0 || n > 0xFFFF) throw new AsmError(`${mn} needs a count from 0 to 65535`);
          seg = null; pc = (pc + n) & 0xFFFF;
        }
        else if (mn === 'FCB' || mn === 'DB' || mn === 'FCC' || mn === 'FCS' || mn === 'FCN') {
          let args = opnd;
          const dl = mn === 'FCB' || mn === 'DB' ? null : delimited(opnd);
          if (dl) { for (const ch of dl.text) bytes.push(ch.charCodeAt(0)); args = dl.rest; }
          for (const a of dl && !args ? [] : splitArgs(args)) {
            const sm = /^"(.*)"$/.exec(a);
            if (sm) for (const ch of sm[1]) bytes.push(ch.charCodeAt(0));
            else if (a !== '') bytes.push(fit(val(a), 8));
          }
          if (mn === 'FCS' && bytes.length) bytes[bytes.length - 1] |= 0x80;
          if (mn === 'FCN') bytes.push(0);
        }
        else if (mn === 'FDB' || mn === 'DW') { for (const a of splitArgs(opnd)) { const v = fit(val(a), 16); bytes.push(v >> 8, v); } }
        else {
          bytes = isa.encode(mn, opnd, { pc, ev, pass, line: ln, hints: sizeHints });
          if (!bytes) throw new AsmError('unknown mnemonic ' + mn);
        }

        if (bytes.length) emit(bytes);
        listing.push({ line: at.line, file: at.file, addr: startPc, bytes: bytes.map((b) => b & 0xFF), src: raw });
      } catch (e) {
        if (!(e instanceof AsmError)) throw e;
        if (pass === 2 || /duplicate|unknown|bad|junk|missing|needs|invalid|range/.test(e.message)) {
          if (!errors.some((x) => x.line === at.line && x.file === at.file)) errors.push({ line: at.line, file: at.file, message: e.message, src: raw });
        }
      }
    }
    if (pass === 2) {
      const segs = segments.filter((s) => s.data.length).map((s) => ({ addr: s.addr, data: Uint8Array.from(s.data) }));
      const start = segs.length ? segs[0].addr : 0;
      result = {
        ok: errors.length === 0, errors, segments: segs, listing, symbols,
        exec: exec != null ? exec : (firstOrg != null ? firstOrg : start),
      };
    }
  }
  return result || { ok: false, errors, segments: [], listing: [], symbols };
}

// ---- IF / ELSE / ENDIF ----
// Drops the lines of every block whose condition is false, so the two passes see only the selected text.
// `symbols` already holds the caller's `defines`; an EQU before an IF cannot be seen here (this runs before
// the passes), so a condition may use the caller's symbols, constants and expressions over them, and nothing
// that the source itself defines later. Nesting is tracked with a stack: a block inside a false block is
// skipped without being evaluated, so its ELSE/ENDIF still pair correctly.
function conditional(lines, where, symbols) {
  const out = [], map = [];
  // One entry per open IF: `taken` is whether a branch of this IF has already been selected, `active` is
  // whether the branch now being read runs, and `at` is where the IF is, so an unclosed one can name it.
  const stack = [];
  const enclosingActive = () => stack.every((s) => s.active);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const at = where[i] || { file: null, line: i + 1 };
    // the directives stand alone on their line (a label in front would change how the engine reads it)
    const m = /^\s*(IF|ELSE|ENDIF)\b\s*(.*)$/i.exec(raw);
    const mn = m && m[1].toUpperCase();
    if (mn === 'IF') {
      // A condition inside a false block is not evaluated: it may name anything at all. In an active block
      // an undefined symbol is an ERROR, not a false: a misspelled flag would otherwise build the wrong
      // variant silently, which is the class of miscompile this project has already been bitten by. Every
      // build passes its flags explicitly.
      let take = false;
      if (enclosingActive()) {
        // The condition is evaluated here, outside either pass, so every error it raises has to be given the
        // line by hand - and a comment after it is a comment, as it is after an instruction: "IF DEBUG ; why"
        // is how anyone writes a build flag, and reading the ";" as part of the expression made every such
        // line fail with "junk in expression".
        const cond = stripComment(charLiterals(m[2])).trim();
        try { take = evalExpr(cond, { pc: 0, symbols, pass: 2 }).value !== 0; }
        catch (e) { if (e instanceof AsmError && e.line == null) { e.file = at.file; e.line = at.line; } throw e; }
      }
      stack.push({ taken: take, active: take, at });
      continue;
    }
    if (mn === 'ELSE') {
      if (!stack.length) throw new AsmError('ELSE without IF', at.file, at.line);
      const top = stack[stack.length - 1];
      const outer = stack.slice(0, -1).every((s) => s.active);
      top.active = outer && !top.taken;
      if (top.active) top.taken = true;
      continue;
    }
    if (mn === 'ENDIF') {
      if (!stack.length) throw new AsmError('ENDIF without IF', at.file, at.line);
      stack.pop();
      continue;
    }
    if (enclosingActive()) { out.push(raw); map.push(at); }
  }
  // name the IF that was never closed, not the end of the file
  if (stack.length) { const open = stack[stack.length - 1].at; throw new AsmError('IF without ENDIF', open.file, open.line); }
  return { text: out, map };
}

// The assembled program as a file: format 'dragondos' (one contiguous range, small gaps zero-filled) or 'decb' (the segments as
// they are). There is no default: which one a program wants depends on the machine that loads it, so the caller says.
function toBinary(res, { format, maxGap } = {}) {
  if (format !== 'dragondos' && format !== 'decb') throw new Error(`toBinary needs { format: 'dragondos' | 'decb' }, not ${JSON.stringify(format)}`);
  return format === 'dragondos' ? writeDragonDos(res.segments, res.exec, maxGap == null ? {} : { maxGap }) : writeDecb(res.segments, res.exec);
}

export { assemble, toBinary };
