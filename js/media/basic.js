/*
 * BASIC program text <-> the bytes BASIC keeps in memory, for the Dragon, the CoCo (Color, Extended, Disk and
 * Super Extended Color BASIC) and the MC-10 (Micro Color BASIC). Pure functions; no machine, no ROM.
 *
 * The oracle is published documentation, not a ROM (AGENTS.md 4.6). Sources:
 *   [CBU]  Color BASIC Unravelled II (Spectral Associates; 1999 edition, W. K. Zydhek), Color BASIC 1.2:
 *          introduction p.7 (token rules and the program format, quoted below), p.B18 (keyword table),
 *          pp.B40-B41 (the crunch routine: '?' is PRINT, ' is ":" then REM's token, ELSE always has a ":" before
 *          it, DATA is not crunched up to the next ":", REM and ' up to the end of the line, strings never;
 *          spaces are kept), p.B25 (largest line number $F9FF = 63999), p.A1 (direct page pointers; LBUFMX 250).
 *   [EBU]  Extended BASIC Unravelled II, Extended Color BASIC 1.1: p.B2 (commands), p.B3 (functions), p.A2.
 *   [DBU]  Disk BASIC Unravelled II, Disk BASIC 1.0/1.1: Appendix B p.B3 (1.1 tables), Appendix C p.C3 (1.0).
 *   [SEBU] Super Extended BASIC Unravelled II, Super Extended BASIC 2.0: p.B9 (commands and functions), p.A2.
 *   [ITD]  Inside the Dragon, D. Smeed and I. Sommerville (Addison-Wesley): Appendix 7 pp.346-348 (Dragon
 *          keywords and functions), Appendix 8 p.353 (DragonDOS), section 9.2 p.226 (program format), p.230
 *          (worked tokens: DIM $8C, FOR $80, = $CB, STR$ $FF8E, PEEK $FF8C), p.231 and section 9.6 (pointers).
 *   [YC]   "Tandy MC-10 review", Your Computer, October 1983, Table 1 (the MC-10's keywords in ROM order).
 *   [MC10M] MC-10 Operation and Language Reference Manual (Tandy), chapter 6 (line numbers 0 to 63999).
 *   [MCX]  "MCX BASIC Memory Map.txt" (D. Atkinson): the MC-10 direct page pointers $93-$A2.
 * What the sources do not settle is said where it is used (see MC10 and DRAGON below) and in docs/claude.md.
 *
 * The program format [CBU p.7]: "1. Start of text is a zero byte. 2. Each program line is preceded by a
 * two-byte RAM link containing the address of the first byte of the next line and a two-byte line number.
 * 3. The compressed (crunched) text is followed by a zero byte. 4. End of text is stored as two zero link
 * bytes." [ITD 9.2] says the same of the Dragon. Both are big-endian (the 6809's and 6803's byte order).
 */

export const BASIC_LINE_MAX = 63999;   // [CBU p.B25], [MC10M ch.6]

// Keyword tables, in ROM order: a token is $80 + the position. Functions are $FF then $80 + position, except
// on the MC-10, where every keyword is one byte.
const COLOR_COMMANDS = ['FOR', 'GO', 'REM', "'", 'ELSE', 'IF', 'DATA', 'PRINT', 'ON', 'INPUT', 'END', 'NEXT', 'DIM', 'READ', 'RUN', 'RESTORE',
  'RETURN', 'STOP', 'POKE', 'CONT', 'LIST', 'CLEAR', 'NEW', 'CLOAD', 'CSAVE', 'OPEN', 'CLOSE', 'LLIST', 'SET', 'RESET', 'CLS', 'MOTOR',
  'SOUND', 'AUDIO', 'EXEC', 'SKIPF', 'TAB(', 'TO', 'SUB', 'THEN', 'NOT', 'STEP', 'OFF', '+', '-', '*', '/', '^',
  'AND', 'OR', '>', '=', '<'];                                                                       // [CBU p.B18] $80-$B4
const EXT_COMMANDS = ['DEL', 'EDIT', 'TRON', 'TROFF', 'DEF', 'LET', 'LINE', 'PCLS', 'PSET', 'PRESET', 'SCREEN',
  'PCLEAR', 'COLOR', 'CIRCLE', 'PAINT', 'GET', 'PUT', 'DRAW', 'PCOPY', 'PMODE', 'PLAY', 'DLOAD', 'RENUM', 'FN', 'USING'];   // [EBU p.B2] $B5-$CD
const DISK_COMMANDS = ['DIR', 'DRIVE', 'FIELD', 'FILES', 'KILL', 'LOAD', 'LSET', 'MERGE', 'RENAME', 'RSET', 'SAVE', 'WRITE', 'VERIFY', 'UNLOAD',
  'DSKINI', 'BACKUP', 'COPY', 'DSKI$', 'DSKO$', 'DOS'];                                              // [DBU p.B3] $CE-$E1 (DOS: 1.1 only)
const SECB_COMMANDS = ['WIDTH', 'PALETTE', 'HSCREEN', 'LPOKE', 'HCLS', 'HCOLOR', 'HPAINT', 'HCIRCLE', 'HLINE', 'HGET', 'HPUT', 'HBUFF', 'HPRINT', 'ERR',
  'BRK', 'LOCATE', 'HSTAT', 'HSET', 'HRESET', 'HDRAW', 'CMP', 'RGB', 'ATTR'];                           // [SEBU p.B9] $E2-$F8
const COLOR_FUNCTIONS = ['SGN', 'INT', 'ABS', 'USR', 'RND', 'SIN', 'PEEK', 'LEN', 'STR$', 'VAL', 'ASC', 'CHR$', 'EOF', 'JOYSTK', 'LEFT$', 'RIGHT$',
  'MID$', 'POINT', 'INKEY$', 'MEM'];                                                                 // [CBU p.B18] $FF80-$FF93
const EXT_FUNCTIONS = ['ATN', 'COS', 'TAN', 'EXP', 'FIX', 'LOG', 'POS', 'SQR', 'HEX$', 'VARPTR', 'INSTR', 'TIMER', 'PPOINT', 'STRING$'];   // [EBU p.B3] $FF94-$FFA1
const DISK_FUNCTIONS = ['CVN', 'FREE', 'LOC', 'LOF', 'MKN$', 'AS'];                                  // [DBU] $FFA2-$FFA7
const SECB_FUNCTIONS = ['LPEEK', 'BUTTON', 'HPOINT', 'ERNO', 'ERLIN'];                               // [SEBU p.B9] $FFA8-$FFAC

const DRAGON_COMMANDS = ['FOR', 'GO', 'REM', "'", 'ELSE', 'IF', 'DATA', 'PRINT', 'ON', 'INPUT', 'END', 'NEXT', 'DIM', 'READ', 'LET', 'RUN',
  'RESTORE', 'RETURN', 'STOP', 'POKE', 'CONT', 'LIST', 'CLEAR', 'NEW', 'DEF', 'CLOAD', 'CSAVE', 'OPEN', 'CLOSE', 'LLIST', 'SET', 'RESET',
  'CLS', 'MOTOR', 'SOUND', 'AUDIO', 'EXEC', 'SKIPF', 'DEL', 'EDIT', 'TRON', 'TROFF', 'LINE', 'PCLS', 'PSET', 'PRESET', 'SCREEN', 'PCLEAR',
  'COLOR', 'CIRCLE', 'PAINT', 'GET', 'PUT', 'DRAW', 'PCOPY', 'PMODE', 'PLAY', 'DLOAD', 'RENUM', 'TAB(', 'TO', 'SUB', 'FN', 'THEN',
  'NOT', 'STEP', 'OFF', '+', '-', '*', '/', '^', 'AND', 'OR', '>', '=', '<', 'USING'];                  // [ITD App.7] $80-$CD ($A6 printed "DELETE": a misprint for DEL)
const DRAGONDOS_COMMANDS = ['AUTO', 'BACKUP', 'BEEP', 'BOOT', 'CHAIN', 'COPY', 'CREATE', 'DIR', 'DRIVE', 'DSKINIT', 'FREAD', 'FWRITE', 'ERROR', 'KILL',
  'LOAD', 'MERGE', 'PROTECT', 'WAIT', 'RENAME', 'SAVE', 'SREAD', 'SWRITE', 'VERIFY', 'FROM', 'FLREAD', 'SWAP'];   // [ITD App.8] $CE-$E7
const DRAGON_FUNCTIONS = ['SGN', 'INT', 'ABS', 'POS', 'RND', 'SQR', 'LOG', 'EXP', 'SIN', 'COS', 'TAN', 'ATN', 'PEEK', 'LEN', 'STR$', 'VAL',
  'ASC', 'CHR$', 'EOF', 'JOYSTK', 'FIX', 'HEX$', 'LEFT$', 'RIGHT$', 'MID$', 'POINT', 'INKEY$', 'MEM', 'VARPTR', 'INSTR', 'TIMER', 'PPOINT',
  'STRING$', 'USR'];                                                                                 // [ITD App.7] $FF80-$FFA1
const DRAGONDOS_FUNCTIONS = ['LOF', 'FREE', 'ERL', 'ERR', 'HIMEM', 'LOC', 'FRE$'];                    // [ITD App.8] $FFA2-$FFA8

// The MC-10: one list, one byte each [YC Table 1]; the values are $80 + the position in that ROM-order list (the
// article lists the keywords, not their values, and no source read states that functions have no $FF prefix:
// both are inferred from the order and agree with the toolshed tokenizer's cecb table, a secondary source).
const MC10_KEYWORDS = ['FOR', 'GOTO', 'GOSUB', 'REM', 'IF', 'DATA', 'PRINT', 'ON', 'INPUT', 'END', 'NEXT', 'DIM', 'READ', 'LET', 'RUN', 'RESTORE',
  'RETURN', 'STOP', 'POKE', 'CONT', 'LIST', 'CLEAR', 'NEW', 'CLOAD', 'CSAVE', 'LLIST', 'LPRINT', 'SET', 'RESET', 'CLS', 'SOUND', 'EXEC',
  'SKIPF', 'TAB(', 'TO', 'THEN', 'NOT', 'STEP', 'OFF', '+', '-', '*', '/', '^', 'AND', 'OR', '>', '=',
  '<', 'SGN', 'INT', 'ABS', 'USR', 'RND', 'SQR', 'LOG', 'EXP', 'SIN', 'COS', 'TAN', 'PEEK', 'LEN', 'STR$', 'VAL',
  'ASC', 'CHR$', 'LEFT$', 'RIGHT$', 'MID$', 'POINT', 'VARPTR', 'INKEY$', 'MEM'];                      // $80-$C8

// one searchable list: [keyword, bytes] in the order the ROM searches. Color BASIC searches its tables a group
// at a time, commands then functions [CBU pp.B40-B41], and the first keyword that matches wins.
function table(groups) {
  const out = [];
  for (const { commands = [], cmdBase = 0x80, functions = [], fnBase = 0x80, prefix = 0xFF } of groups) {
    commands.forEach((k, i) => out.push([k, [cmdBase + i]]));
    functions.forEach((k, i) => out.push([k, prefix == null ? [fnBase + i] : [prefix, fnBase + i]]));
  }
  return out;
}

// The dialects. `pointers` are the direct page addresses (2 bytes, high first) of the program's start
// (TXTTAB), the variables (VARTAB), the arrays (ARYTAB), the end of the arrays (ARYEND) and the start of string
// storage, the top of free RAM (FRETOP). `inputMax` is the longest line BASIC's line input takes.
export const DIALECTS = Object.freeze({
  coco: Object.freeze({
    id: 'coco', name: 'Color BASIC (with Extended, Disk and Super Extended BASIC keywords)',
    // Super Extended's group is searched before Disk BASIC's: the sources read do not give the order of those two,
    // and the only keyword it decides is LOCATE (Disk BASIC's LOC is its prefix), which a CoCo 3 must store as its
    // own token $F1 [SEBU p.B9] for LOCATE to work. No other keyword of either group is a prefix of the other's.
    keywords: table([{ commands: COLOR_COMMANDS, functions: COLOR_FUNCTIONS }, { commands: EXT_COMMANDS, cmdBase: 0xB5, functions: EXT_FUNCTIONS, fnBase: 0x94 },
      { commands: SECB_COMMANDS, cmdBase: 0xE2, functions: SECB_FUNCTIONS, fnBase: 0xA8 }, { commands: DISK_COMMANDS, cmdBase: 0xCE, functions: DISK_FUNCTIONS, fnBase: 0xA2 }]),
    questionIsPrint: true, colonBefore: ["'", 'ELSE'],                  // [CBU pp.B40-B41]
    pointers: { txttab: 0x19, vartab: 0x1B, arytab: 0x1D, aryend: 0x1F, fretop: 0x21 },   // [CBU p.A1], [EBU p.A2], [SEBU p.A2]
    inputMax: 249,                                                      // LBUFMX 250, "have 250 or more been entered?" [CBU p.A1, p.B7]
  }),
  // The Dragon's BASIC is Microsoft's Color BASIC with the keyword tables reordered [ITD App.7]; its crunch rules
  // ('?', the ":" before ' and ELSE) and its input limit are taken to be Color BASIC's: [ITD] does not state them.
  dragon: Object.freeze({
    id: 'dragon', name: 'Dragon BASIC (with DragonDOS keywords)',
    keywords: table([{ commands: DRAGON_COMMANDS, functions: DRAGON_FUNCTIONS }, { commands: DRAGONDOS_COMMANDS, cmdBase: 0xCE, functions: DRAGONDOS_FUNCTIONS, fnBase: 0xA2 }]),
    questionIsPrint: true, colonBefore: ["'", 'ELSE'],
    pointers: { txttab: 0x19, vartab: 0x1B, arytab: 0x1D, aryend: 0x1F, fretop: 0x21 },   // [ITD p.231, 9.6]
    inputMax: 249,
  }),
  // Micro Color BASIC: no ELSE and no ' [YC]. Its pointers are taken from the MCX BASIC map [MCX] (MCX replaces
  // the MC-10's BASIC and keeps its direct page); no source read confirms them for the stock ROM, so load_basic
  // checks what it finds there describes a program before it writes anything. The input limit is not documented
  // in the sources read: 128 is used, a conservative choice, not a measured one.
  mc10: Object.freeze({
    id: 'mc10', name: 'Micro Color BASIC',
    keywords: table([{ commands: MC10_KEYWORDS }]),
    questionIsPrint: true, colonBefore: [],
    pointers: { txttab: 0x93, vartab: 0x95, arytab: 0x97, aryend: 0x99, fretop: 0x9B },   // [MCX]
    inputMax: 128,
  }),
});

export class BasicError extends Error {
  // code: 'bad-line-number' | 'line-too-long' | 'not-typable'; line: the 1-based line of the text
  constructor(code, message, line) { super(message); this.name = 'BasicError'; this.code = code; this.line = line; }
}

// Upper-case everything outside string literals, as typing at the keyboard would (keywords are only recognised in
// upper case): the program text load_basic is given is first put in this form.
export function upperOutsideStrings(s) {
  let q = false, out = '';
  for (const ch of s) { if (ch === '"') q = !q; out += q || ch === '"' ? ch : ch.toUpperCase(); }
  return out;
}

// One statement text (after the line number) -> its crunched bytes, by the rules in the header.
export function crunch(text, dialect) {
  const d = typeof dialect === 'string' ? DIALECTS[dialect] : dialect;
  const out = [];
  let i = 0, quote = false, data = false;
  while (i < text.length) {
    const ch = text[i];
    if (quote) { out.push(ch.charCodeAt(0)); if (ch === '"') quote = false; i++; continue; }
    if (ch === '"') { quote = true; out.push(0x22); i++; continue; }
    if (data) { if (ch === ':') data = false; out.push(ch.charCodeAt(0)); i++; continue; }
    if (d.questionIsPrint && ch === '?') { out.push(...d.keywords.find(([k]) => k === 'PRINT')[1]); i++; continue; }
    const hit = d.keywords.find(([k]) => text.startsWith(k, i));
    if (!hit) { out.push(ch.charCodeAt(0)); i++; continue; }
    const [k, bytes] = hit;
    if (d.colonBefore.includes(k)) out.push(0x3A);
    out.push(...bytes);
    i += k.length;
    if (k === 'REM' || k === "'") { for (const c of text.slice(i)) out.push(c.charCodeAt(0)); break; }
    if (k === 'DATA') data = true;
  }
  return out;
}

// Crunched bytes -> the text LIST would show (the ":" crunch put before ' and ELSE is left out again).
export function uncrunch(bytes, dialect) {
  const d = typeof dialect === 'string' ? DIALECTS[dialect] : dialect;
  const byBytes = new Map(d.keywords.map(([k, b]) => [b.join(','), k]));
  let out = '', quote = false;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x22) quote = !quote;
    if (quote || b < 0x80) {
      // a ':' that is only there because ' or ELSE follows
      if (!quote && b === 0x3A && d.colonBefore.length && i + 1 < bytes.length) {
        const next = byBytes.get(String(bytes[i + 1]));
        if (d.colonBefore.includes(next)) continue;
      }
      out += String.fromCharCode(b);
      continue;
    }
    const two = b === 0xFF && i + 1 < bytes.length ? byBytes.get(`${b},${bytes[i + 1]}`) : null;
    if (two) { out += two; i++; continue; }
    const k = byBytes.get(String(b));
    out += k == null ? String.fromCharCode(b) : k;
    if (k === 'REM' || k === "'") { out += String.fromCharCode(...bytes.slice(i + 1)); break; }
  }
  return out;
}

// Program text -> [{ number, text, bytes }] in line-number order (a later line with the same number replaces an
// earlier one, as typing it would). Throws BasicError for a missing or out-of-range line number or a line longer
// than the dialect's line input takes, and 'not-typable' for a character above $7E: BASIC keeps program text as 7-bit
// ASCII, and a byte of $80 or more in it is read as a token (and a code point above $FF fits no byte at all), so
// such a character cannot be stored as the text it is. Blank lines are skipped.
export function parseProgram(source, dialect) {
  const d = typeof dialect === 'string' ? DIALECTS[dialect] : dialect;
  const lines = new Map();
  String(source).replace(/\r\n?/g, '\n').split('\n').forEach((raw, idx) => {
    const line = upperOutsideStrings(raw.replace(/\s+$/, '').replace(/^\s+/, ''));
    if (!line) return;
    const bad = [...new Set([...line].filter((c) => c.codePointAt(0) > 0x7E))];
    if (bad.length) throw new BasicError('not-typable', `line ${idx + 1}: ${JSON.stringify(bad.join(''))} cannot be stored in a BASIC line (only characters $20-$7E)`, idx + 1);
    const m = /^(\d+) *(.*)$/.exec(line);
    if (!m || m[1].length > 5 || Number(m[1]) > BASIC_LINE_MAX) throw new BasicError('bad-line-number', `line ${idx + 1}: "${line.slice(0, 40)}" does not start with a line number from 0 to ${BASIC_LINE_MAX}`, idx + 1);
    if (line.length > d.inputMax) throw new BasicError('line-too-long', `line ${idx + 1} (number ${Number(m[1])}) is ${line.length} characters; ${d.name} takes at most ${d.inputMax}`, idx + 1);
    const number = Number(m[1]);
    const bytes = crunch(m[2], d);
    if (!bytes.length) { lines.delete(number); return; }   // a number alone deletes that line, as typing it does
    lines.set(number, { number, text: m[2], bytes });
  });
  return [...lines.values()].sort((a, b) => a.number - b.number);
}

// The program's text as LIST would give it, one "NUMBER TEXT" per line: the form a round trip must reproduce.
export function normalizeProgram(source, dialect) {
  return parseProgram(source, dialect).map((l) => `${l.number} ${uncrunch(l.bytes, dialect)}`).join('\n');
}

// [{number, bytes}] at `start` -> the bytes from `start`: each line is link (the next line's address), line number,
// the crunched text and 0; then the two zero bytes of the end link.
export function buildProgram(lines, start) {
  const out = [];
  let at = start;
  for (const l of lines) {
    const next = at + 4 + l.bytes.length + 1;
    out.push(next >> 8 & 0xFF, next & 0xFF, l.number >> 8, l.number & 0xFF, ...l.bytes, 0);
    at = next;
  }
  out.push(0, 0);
  return Uint8Array.from(out);
}

// Program bytes in memory (read through `peek`) from `start` -> [{number, bytes, at}], following the links; stops
// at the zero end link. null when the links do not form a program ending before `limit` (a cycle, a link backwards).
export function readProgram(peek, start, limit = 0x10000) {
  const lines = [];
  let at = start;
  for (let guard = 0; guard < 0x4000; guard++) {
    if (at + 1 >= limit) return null;
    const link = (peek(at) << 8) | peek(at + 1);
    if (link === 0) return { lines, end: at + 1 };
    if (link <= at + 4 || link > limit) return null;
    const number = (peek(at + 2) << 8) | peek(at + 3);
    const bytes = [];
    for (let a = at + 4; a < link - 1; a++) bytes.push(peek(a));
    if (peek(link - 1) !== 0) return null;
    lines.push({ number, bytes, at });
    at = link;
  }
  return null;
}

// The program as text, LIST style, from bytes in memory.
export function listProgram(peek, start, dialect) {
  const p = readProgram(peek, start);
  return p ? p.lines.map((l) => `${l.number} ${uncrunch(l.bytes, dialect)}`).join('\n') : null;
}
