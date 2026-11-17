/*
 * Loading a BASIC program straight into a machine's program memory, as a load from tape or disk would: the one
 * implementation behind Claude's load_basic tool (js/claude/chat.js), Session.loadBasic and the embed API's
 * loadBasic. Browser-free. The text is tokenized by js/media/basic.js; this file decides whether the machine can
 * take it and writes it.
 *
 * `target` is the shape Session.chatTarget() builds for the BASIC session: { machine, readByte(addr),
 * pokeBytes(addr, bytes), writeKind(addr), bootStatus(), screenText() }. Failures are ToolErrors (codes in
 * js/claude/toolerrors.js), so a model, an automation script and an embedding page all get the same code.
 */
import { BasicError, DIALECTS, buildProgram, parseProgram, readProgram } from '../media/basic.js';
import { machineFamily } from '../media/detect.js';
import { runReadOnlyTool } from './readtools.js';
import { TOOL_CODES, ToolError } from './toolerrors.js';

export const BASIC_PROGRAM_TEXT_MAX = 65536;   // characters of listing one load takes
// Bytes left free between the program's end and the start of string storage (FRETOP), for BASIC's stack and its
// first variables: a program that leaves less is program-too-large. A margin of this project's choosing.
export const BASIC_FREE_MARGIN = 256;

// First half: everything that can refuse, with nothing changed. The program goes where BASIC's own TXTTAB says
// its program starts, and must end BASIC_FREE_MARGIN bytes short of FRETOP. BASIC's pointers are checked to
// describe the program BASIC holds now (its links end where VARTAB says) before they are trusted: that is how a
// machine whose pointers are not where the dialect says is refused rather than written over.
// -> { dialect, lines, bytes, start, end }
export function planBasic(t, program) {
  if (typeof program !== 'string' || !program.trim()) throw new ToolError(TOOL_CODES.EMPTY, 'program');
  if (program.length > BASIC_PROGRAM_TEXT_MAX) throw new ToolError(TOOL_CODES.TOO_LARGE, `${program.length} characters, at most ${BASIC_PROGRAM_TEXT_MAX}`);
  const m = t.machine;
  if (!m) throw new ToolError(TOOL_CODES.NO_MACHINE);
  const dialect = DIALECTS[machineFamily(m.profile)];
  if (!dialect) throw new ToolError(TOOL_CODES.UNKNOWN_MACHINE, m.profile.name);
  if (!m.hasRom) throw new ToolError(TOOL_CODES.NO_BASIC, 'the machine runs without ROMs, so there is no BASIC program memory');
  const info = runReadOnlyTool(t, 'machine_info', {});
  if (info.atPrompt !== true || m.typist.busy) throw new ToolError(TOOL_CODES.NOT_AT_PROMPT, info.atPrompt === null ? 'it cannot be told from the screen' : m.typist.busy ? 'typing is still going in' : 'no OK on the screen');
  let lines;
  try { lines = parseProgram(program, dialect); } catch (e) {
    if (e instanceof BasicError) throw new ToolError({ 'line-too-long': TOOL_CODES.LINE_TOO_LONG, 'not-typable': TOOL_CODES.NOT_TYPABLE }[e.code] || TOOL_CODES.BAD_LINE_NUMBER, e.message);
    throw e;
  }
  if (!lines.length) throw new ToolError(TOOL_CODES.EMPTY, 'program (no numbered lines)');
  const rd = (a) => t.readByte(a & 0xFFFF), word = (a) => (rd(a) << 8) | rd(a + 1);
  const p = dialect.pointers, start = word(p.txttab), vartab = word(p.vartab), fretop = word(p.fretop);
  const now = start > 0 && start < 0xFFFF ? readProgram(rd, start, fretop) : null;
  if (!now || now.end + 1 !== vartab || word(p.arytab) < vartab || word(p.aryend) < word(p.arytab) || fretop <= vartab) {
    throw new ToolError(TOOL_CODES.UNKNOWN_MACHINE, `${dialect.name}: the pointers at $${p.txttab.toString(16).toUpperCase()} do not describe a program in memory`);
  }
  const bytes = buildProgram(lines, start);
  const end = start + bytes.length - 1;
  if (end + 1 + BASIC_FREE_MARGIN > fretop) throw new ToolError(TOOL_CODES.PROGRAM_TOO_LARGE, `${bytes.length} bytes from ${start}; ${Math.max(0, fretop - BASIC_FREE_MARGIN - start)} free`);
  for (let a = start; a <= end; a++) if (t.writeKind(a)) throw new ToolError(TOOL_CODES.PROGRAM_TOO_LARGE, `byte ${a} is not RAM`);
  return { dialect, lines, bytes, start, end };
}

// Second half: write the lines, then point VARTAB, ARYTAB and ARYEND just past them (no variables, as after NEW or
// a load), and read the program back through BASIC's links before saying it is there. -> {lines, bytes, start, end}
export function writeBasic(t, plan) {
  const { dialect, lines, bytes, start, end } = plan;
  const p = dialect.pointers, after = end + 1, hi = after >> 8, lo = after & 0xFF;
  t.pokeBytes(start, Array.from(bytes));
  for (const a of [p.vartab, p.arytab, p.aryend]) t.pokeBytes(a, [hi, lo]);
  const back = readProgram((a) => t.readByte(a & 0xFFFF), start);
  if (!back || back.lines.length !== lines.length || back.end !== end) throw new ToolError(TOOL_CODES.NOT_RAM, `the program did not read back at ${start}`);
  return { lines: lines.length, bytes: bytes.length, start, end };
}

// The two halves in one: what Session.loadBasic and the embed API call.
export function loadBasic(t, program) { return writeBasic(t, planBasic(t, program)); }
