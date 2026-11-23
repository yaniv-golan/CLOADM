/*
 * What Claude did in a turn, as the person sees it. Browser-free.
 *
 * Every acting call leaves one record on its turn (ChatSession.noteAction, js/claude/chat.js), made from what the
 * call returned or threw, never guessed: { seq, tool, what, outcome, time, ... }. The views draw one small line per
 * record (actionLine), and a turn with more than COLLAPSE_AFTER acting calls folds its ✓ lines into one button
 * (actionBlock). A read-only call that worked is never a line: a turn counts them (reads), and the folded button or,
 * when nothing folds, a plain muted line says how many. A read that failed is a ✗ line of its own.
 *
 * Outcomes, from the call's own result or error code:
 *   done        the change was made (✓)
 *   partial     some of the bytes did not land: poke and assemble_and_load's skipped / not_taken (✓, never folded)
 *   declined    the person said no (consent-declined, load-declined) (–)
 *   stopped     the person pressed Stop: `delivered` keys (the ToolError's count) tells "before" from "while" (–)
 *   restarted   the machine reset while the keys went in (machine-restarted, with `delivered`): not a Stop (–)
 *   not-read    the keys went down but the machine did not read them all: the not-consumed code, with `delivered` (–)
 *   debugger-stopped  the Debugger had the machine stopped, or stopped it while the keys went in (machine-stopped,
 *               with `delivered`): what was not typed was dropped (–)
 *   error       anything else, with the line a person reads for it (failureText) (✗)
 */
import { TOOL_CODES } from './toolerrors.js';

export const COLLAPSE_AFTER = 3;

// The line a person sees for a failed tool: the remedy for a coded error (its .tool.remedy), else its short
// message. Never the JSON the model received and never String(result) - a person reads a line on screen, not a
// blob.
export function failureText(value) {
  const tool = value && value.tool;
  // tool-failed's remedy is for the model; the person is shown what went wrong
  if (tool && tool.code === 'tool-failed' && tool.detail) return `failed: ${tool.detail}`.slice(0, 80);
  if (tool && tool.remedy) return tool.remedy;
  return String((value && value.message) || value || 'failed').slice(0, 80);
}

// an address as the person reads it: $0400; one out of range is shown as it was given, never wrapped
const hex4 = (n) => (Number.isInteger(n) && n >= 0 && n <= 0xFFFF ? `$${n.toString(16).toUpperCase().padStart(4, '0')}` : String(n));
const lines = (s) => String(s || '').split('\n').filter((l) => l.trim());
const bytes = (n) => `${n} byte${n === 1 ? '' : 's'}`;

// what the call was asked to do, kept small (never a whole program or listing)
function what(tool, input) {
  const i = input || {};
  switch (tool) {
    case 'type_text': { const l = lines(i.text); return l.length === 1 ? { line: l[0].trim() } : { lines: l.length }; }
    case 'poke': return { address: i.address, count: Array.isArray(i.bytes) ? i.bytes.length : 0 };
    case 'load_basic': return { lines: lines(i.program).length };
    case 'assemble_and_load': return i.org != null ? { org: Number(i.org) } : {};
    case 'run': {
      const t = i.target == null ? 'RUN' : i.target;
      if (typeof t === 'string' && t.trim().toUpperCase() === 'RUN') return { run: true };
      const m = typeof t === 'string' ? /^(?:\$|0x)?([0-9A-F]+)$/i.exec(t.trim()) : null;
      return { address: typeof t === 'number' ? t : m ? parseInt(m[1], 16) : null, text: String(t) };
    }
    default: return {};
  }
}

// one acting call's record. err: the ToolError it threw (null on success); result: what it returned
export function actionRecord(tool, input, { result = null, err = null, time = Date.now(), seq = 0 } = {}) {
  const rec = { seq, tool, what: what(tool, input), time, outcome: 'done' };
  if (err) {
    const code = err.code || (err.tool && err.tool.code);
    if (code === TOOL_CODES.CONSENT_DECLINED || code === TOOL_CODES.LOAD_DECLINED) rec.outcome = 'declined';
    else if (code === TOOL_CODES.STOPPED) { rec.outcome = 'stopped'; rec.delivered = Number(err.delivered) || 0; }
    else if (code === TOOL_CODES.MACHINE_RESTARTED) { rec.outcome = 'restarted'; rec.delivered = Number(err.delivered) || 0; }
    else if (code === TOOL_CODES.NOT_CONSUMED) { rec.outcome = 'not-read'; rec.delivered = Number(err.delivered) || 0; }
    else if (code === TOOL_CODES.MACHINE_STOPPED) { rec.outcome = 'debugger-stopped'; rec.delivered = Number(err.delivered) || 0; }
    else { rec.outcome = 'error'; rec.failure = failureText(err); }
    return rec;
  }
  const r = result || {};
  if (tool === 'poke') { rec.written = r.written; rec.count = r.length; if (r.skipped > 0) rec.outcome = 'partial'; }
  if (tool === 'assemble_and_load') {
    rec.written = r.written; rec.count = r.bytes;
    rec.at = Array.isArray(r.ranges) && r.ranges.length ? r.ranges[0].from : null;
    if (r.skipped > 0) rec.outcome = 'partial';
  }
  if (tool === 'load_basic' && Number.isInteger(r.lines)) rec.lines = r.lines;
  return rec;
}

// the object of each tool's verb, for the lines that say what did not happen
function object(rec) {
  const w = rec.what;
  switch (rec.tool) {
    case 'type_text': return w.line != null ? `"${w.line}"` : `${w.lines} lines`;
    case 'press_break': return 'BREAK';
    case 'poke': return `${bytes(w.count)} at ${hex4(w.address)}`;
    case 'load_basic': return 'the program';
    case 'assemble_and_load': return w.org != null ? `the code at ${hex4(w.org)}` : 'the code';
    case 'run': return w.run ? 'RUN' : w.address != null ? hex4(w.address) : w.text;
    default: return READS[rec.tool] || rec.tool;
  }
}
// verb forms per tool: [done, not done, -ing]
const VERB = {
  type_text: ['typed', 'type', 'typing'],
  press_break: ['pressed', 'press', 'pressing'],
  poke: ['poked', 'poke', 'poking'],
  load_basic: ['loaded', 'load', 'loading'],
  assemble_and_load: ['assembled and loaded', 'assemble and load', 'assembling and loading'],
  run: ['ran', 'run', 'running'],
  // the read-only tools: only a failed one is a line ("✗ couldn't read memory: …")
  screen_text: ['read', 'read', 'reading'], peek: ['read', 'read', 'reading'], machine_info: ['read', 'read', 'reading'], disassemble: ['read', 'read', 'reading'],
};

// the line for one record: { glyph, text } (the views hide the glyph from screen readers) and its full text
export function actionLine(rec) {
  const [done, base, ing] = VERB[rec.tool] || [rec.tool, rec.tool, rec.tool];
  const obj = object(rec);
  let glyph, text;
  switch (rec.outcome) {
    case 'done':
      glyph = '✓';
      if (rec.tool === 'load_basic') text = `loaded a ${rec.lines != null ? rec.lines : rec.what.lines}-line BASIC program`;
      else if (rec.tool === 'assemble_and_load') text = `assembled and loaded ${bytes(rec.count)}${rec.at != null ? ` at ${hex4(rec.at)}` : ''}`;
      else if (rec.tool === 'run') text = rec.what.run ? 'ran RUN' : `started ${obj}`;
      else text = `${done} ${obj}`;
      break;
    case 'partial':
      glyph = '✓';
      text = rec.tool === 'poke' ? `poked ${rec.written} of ${bytes(rec.count)} at ${hex4(rec.what.address)}`
        : `loaded ${rec.written} of ${bytes(rec.count)}${rec.at != null ? ` at ${hex4(rec.at)}` : ''} (${rec.count - rec.written} not taken)`;
      break;
    case 'declined': glyph = '–'; text = `didn't ${base} ${obj}: you said no`; break;
    case 'stopped': glyph = '–'; text = `stopped ${rec.delivered > 0 ? 'while' : 'before'} ${ing} ${obj}`; break;
    // ("– typed "1", then the machine restarted"; with nothing typed yet, the restart came first)
    case 'restarted': glyph = '–'; text = rec.delivered > 0 ? `${rec.tool === 'run' ? 'typed' : done} ${obj}, then the machine restarted` : `the machine restarted before ${ing} ${obj}`; break;
    // ("– typed part of "HELLO", then the Debugger stopped the machine"; refused while stopped: nothing typed)
    case 'debugger-stopped': glyph = '–'; text = rec.delivered > 0 ? `${rec.tool === 'run' ? 'typed' : done} part of ${obj}, then the Debugger stopped the machine` : `didn't ${base} ${obj}: the Debugger has the machine stopped`; break;
    case 'not-read': glyph = '–'; text = `${rec.tool === 'run' ? 'typed' : done} ${obj}, but the machine didn't read the ${rec.tool === 'press_break' ? 'key' : 'keys'}`; break;
    default: glyph = '✗'; text = `couldn't ${base} ${obj}: ${rec.failure || 'failed'}`; break;
  }
  if (rec.undoneAt) text += ` · undone at ${clock(rec.undoneAt)}`;
  return { glyph, text, full: `${glyph} ${text}` };
}

// "23:58": the time the views give restore points and undone lines
export const clock = (ms) => (ms ? new Date(ms).toTimeString().slice(0, 5) : 'earlier');

// what a read-only call was, for the folded button's counts
const READS = { screen_text: 'the screen', peek: 'memory', machine_info: 'the machine', disassemble: 'the code' };
export const readKind = (tool) => READS[tool] || null;
export function readCounts(reads) {
  const parts = Object.keys(READS).filter((t) => reads && reads[t]).map((t) => `${READS[t]} ${reads[t]}×`);
  return parts.length ? `read ${parts.join(', ')}` : '';
}

// A turn's lines as the views draw them: { lines: [{ seq, glyph, text, full, folded }], summary, reads } where
// `summary` is the folded button's text, or null when nothing folds. Only plain ✓ lines fold (a partial line, –, ✗
// never do), and only when the turn has more than COLLAPSE_AFTER acting calls (a failed read is a line, not an acting
// call). The summary never starts with a ✓: it counts what folded, then the reads ("7 actions · read the screen 2×").
// `reads` is the plain line for the reads when nothing folds ("read the screen 2×, memory 1×"), else null: a turn's
// reads are always shown, once.
export function actionBlock(actions = [], reads = null) {
  const all = actions.map((rec) => ({ seq: rec.seq, outcome: rec.outcome, ...actionLine(rec) }));
  const fold = actions.filter((rec) => !readKind(rec.tool)).length > COLLAPSE_AFTER;
  const out = all.map((l) => ({ ...l, folded: fold && l.outcome === 'done' }));
  const n = out.filter((l) => l.folded).length;
  const r = readCounts(reads);
  const summary = fold && n ? [`${n} action${n === 1 ? '' : 's'}`, r].filter(Boolean).join(' · ') : null;
  return { lines: out, summary, reads: !summary && r ? r : null };
}
