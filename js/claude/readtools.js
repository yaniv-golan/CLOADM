/*
 * The read-only machine tools: what Claude may inspect without "Let Claude use the
 * machine". The design is explicit: reading always works - Claude can
 * look at the screen and read memory - while anything that changes the machine asks first.
 * (A disassembler tool is deferred past this release.)
 *
 * Nothing in this module may change machine state. That is not a convention here, it is the contract: every
 * function reads through Session.readByte (which goes to the machine's side-effect-free peek) or through
 * Session's own read-only helpers, never through read() or a PIA/ACIA access. A test passes write-shaped
 * arguments to every tool and diffs the machine's state to hold this to it.
 *
 * They live here rather than in js/claude/chat.js so the read-only surface can be tested on its own, and so
 * the split between read-only and acting has one place to name it (READ_ONLY_TOOLS below). The Session's
 * consent gate keys on the ACTING set (ChatSession.runTool gates chat.js's ACTING_TOOL_NAMES): it asks
 * for anything in that set, so a name is gated by being acting, not by being absent from here. The test that the
 * two sets together name every tool, exactly once, is what keeps them from drifting.
 *
 * Every tool answers a model, not a person: typed parameters with their units in the description, a JSON
 * result that echoes the request, and coded failures from js/claude/toolerrors.js.
 */
import { MC6847 } from '../chips/mc6847.js';
import { TOOL_CODES, ToolError, checkedInt } from './toolerrors.js';
import { disassemble } from '../asm/disassembler.js';
import { codeDisassembly } from '../debugger.js';
import { GIME } from '../chips/gime.js';

// The names of the tools that only read. The Session's consent gate keys on the ACTING set
// (ACTING_TOOL_NAMES), not on this one: this is the split's other half, and the two must together name every
// tool - the disjointness and completeness are asserted by a test rather than assumed here.
export const READ_ONLY_TOOLS = Object.freeze(['machine_info', 'screen_text', 'peek', 'disassemble']);

// The bounds the tools enforce, named once so the schemas and checkedInt() cannot drift apart. A test asserts
// that each schema's minimum/maximum equals the value used at the call site.
export const ADDRESS_MIN = 0, ADDRESS_MAX = 0xFFFF;      // the 16-bit address space, $0000-$FFFF
export const PEEK_LENGTH_MIN = 1, PEEK_LENGTH_MAX = 0x10000;   // 65536 = the whole space; a read over PEEK_MAX truncates
export const DISASSEMBLE_MIN = 1;                        // instructions per call; the max is DISASSEMBLE_MAX
// What an omitted optional parameter means, named for the same reason as the bounds: the schema states the
// default so a model can decide to omit the parameter, and the call site applies it - one constant for both, so
// the promise in the description and the behaviour cannot drift.
export const PEEK_DEFAULT_LENGTH = 16;
export const DISASSEMBLE_DEFAULT_COUNT = 8;

// The API tool array for the read-only tools. Kept in step with READ_ONLY_TOOLS by a test.
// Every integer parameter is typed "integer" (not "number") and carries the range the code enforces, with the
// units in the description: a model reads the schema, and a schema that says "number" or omits the range invites
// a fraction or an address it cannot use.
export function readOnlyTools() {
  const schema = (props, required) => ({ type: 'object', properties: props, required });
  const int = (description, min, max) => ({ type: 'integer', minimum: min, maximum: max, description });
  return [
    { name: 'machine_info', description: "The machine: model, RAM in KB, CPU (6809, 6803 or 6309), the video mode, whether it is at the BASIC prompt (null when it cannot be told), and the program counter as a decimal address in the 0-65535 range. Takes no parameters.", input_schema: schema({}, []) },
    { name: 'screen_text', description: SCREEN_TEXT_DESCRIPTION, input_schema: schema({}, []) },
    {
      name: 'peek',
      description: 'Read bytes of memory, as the machine sees them (RAM, ROM, cartridge). Reads only; nothing is changed. Returns {address,length,hex,truncated}: hex is the bytes as rows of up to 16, each "$0400: 4C 49 5A ..." (the row address, then the bytes in hex).',
      input_schema: schema({
        address: int('the first address, 0 to 65535 ($0000-$FFFF)', ADDRESS_MIN, ADDRESS_MAX),
        length: int(`how many bytes, ${PEEK_LENGTH_MIN} to ${PEEK_LENGTH_MAX}; at most ${PEEK_MAX} are returned and the result says when it truncated; omit for ${PEEK_DEFAULT_LENGTH}`, PEEK_LENGTH_MIN, PEEK_LENGTH_MAX),
      }, ['address']),
    },
    {
      name: 'disassemble',
      description: "Decode the instructions at an address, in this machine's own CPU instruction set (6809, 6803 or 6309), as the CPU would read them. Reads only; nothing is changed.",
      input_schema: schema({
        address: int('the address to decode from, 0 to 65535 ($0000-$FFFF)', ADDRESS_MIN, ADDRESS_MAX),
        count: int(`how many instructions, ${DISASSEMBLE_MIN} to ${DISASSEMBLE_MAX}; omit for ${DISASSEMBLE_DEFAULT_COUNT}`, DISASSEMBLE_MIN, DISASSEMBLE_MAX),
      }, ['address']),
    },
  ];
}

// ---- screen_text ----
// The text on the machine's screen, one line per row. There are three readers, one per kind of text screen:
//  * the MC6847 VDG's 32x16 page (the MC-10, the Dragons, the CoCo 1/2, and the CoCo 3 in its compatibility mode),
//    walked at a fixed 32-byte stride from the page the display uses, VDG codes decoded; on the CoCo 3 the page is
//    read in physical RAM where the GIME reads it (videoBase()), whatever the memory map shows the CPU;
//  * the CoCo 3's GIME text modes (32, 40, 64 or 80 columns, with or without attribute bytes), walked by the GIME
//    itself (gime.textScreen(): the video start, row pitch, horizontal offset, lines per row and the number of rows
//    the body shows, all from the emulator's own GIME state, never from the CPU-readable registers, which a
//    program cannot read back) and decoded through the GIME character set (GIME.TEXT_CHARS).
//  * the Dragon 64 Plus's 80-column board (its HD6845S CRTC), when the Plus screen is the one shown, walked by the
//    machine's own textScreen() (the same row walk its picture is drawn from: R12/R13, R1, R6, the 2K video RAM's
//    wrap) and decoded through PLUS_CHARS.
// A cell with no known character (a VDG semigraphics block, a Plus code outside $20-$7E) reads as a space and is
// counted. Anything else - a graphics mode, a GIME text mode whose rows are too short to show a character, a 6845
// set-up the board cannot show whole - is DECLINED with the mode's name and a reason: no guessing.
const CELL_COLS = 32;
// The description Claude sees. It names the machines and modes the reader covers, and how non-ASCII characters and
// attributes come back, so a model knows what to expect before it calls.
export const SCREEN_TEXT_DESCRIPTION = "The text on the machine's screen, one string per row with trailing spaces trimmed (trailing blank rows are left out, so `rows` counts the rows returned, not the rows the screen has). Reads the MC6847 VDG 32x16 text screen (MC-10, Dragon 32/64/200, CoCo 1/2, and the CoCo 3 in its CoCo-compatible mode), from the page the VDG shows (on the Dragon and CoCo 1/2 the SAM's display offset, so a page a program has moved is read where it is) and every CoCo 3 GIME text mode, 6809 or 6309: 32, 40, 64 or 80 columns, with or without attribute bytes (as NitrOS-9 and BASIC's WIDTH 40/80 use); on a GIME text mode `screenRows` is how many rows the screen shows. GIME characters $20-$7E are ASCII; the GIME's international characters $00-$1F come back as the Unicode letters they show (Ç ü é â ä à å ç ê ë è ï î ß Ä Å ó æ Æ ô ö ø û ù Ø Ö Ü § £ ± ° ƒ) and $7F as ▒. Attribute bytes are never shown as characters: with attributes on, `attributes` gives each row's runs of fg, bg, underline and blink, where fg and bg are palette slots, not colours (the foreground is palette register 8+fg, the background palette register bg). On the VDG's text screen a cell with bit 7 set is a semigraphics block (BASIC's cursor is one): it reads as a space, and `semigraphics` counts those cells (with a `note`), so a picture made of blocks is not mistaken for an empty screen; screenshot shows it. Returned with the mode's name, `cols`, and where the screen was read from: `base`, the CPU address of the whole screen, given only when the memory map shows all of it to the CPU in one contiguous run (otherwise null: an MMU that splits or hides it, or 256-byte virtual rows), and on a CoCo 3 `physicalBase`, its address in the CoCo 3's physical RAM. The CoCo 3's compatibility-mode page is read where the display reads it, in physical RAM (`physicalBase`), also when the memory map (MMU) shows it to the CPU elsewhere or not at all (`base` is then that other address, or null). Declined with text:false and a reason: a graphics mode; a GIME text mode whose rows are too short to show a character (1 or 2 scanlines per row) or that shows no rows ($FF99 lines per field 2); and, on the Dragon 64 Plus's 80-column screen, a 6845 set-up the board cannot show whole (no rows or columns, R1 or R6 not less than the totals R0+1 or R4+1, wider than 80 columns or taller than the 264-line picture, fewer than 10 raster lines a row, an interlace mode, R8's display skew set to non-output). The Dragon 64 Plus's 80-column screen (its HD6845S, while the Display tab shows it) is read from the board's 2K video RAM as the CRTC walks it (start address R12/R13 as `startAddress`, R1 columns, R6 rows as `screenRows`, the 2K wrapping), as the next frame draws it; codes $20-$7E are read as ASCII (P. Mooney's IC22 EPROM dump and the Dragon Archive's Compusense character ROM dump both put 'A' at offset $0410, so code c's glyph is at c*16); the board's other codes ($00-$1F other symbols, $7F a solid block, $80-$FF mostly underlined forms of $00-$7F) are not mapped to characters here: such a cell reads as a space and `unknown` counts them (with a `note`); `base` is its CPU address only while $FFE2 maps the video RAM over $0000-$07FF and the screen does not wrap. Takes no parameters.";

// Whether screen_text can read the screen faithfully, and if not, why. ONE rule, used by screen_text to decide
// what to answer and by machine_info to report `video.readable`, so the two cannot disagree: `readable === false`
// means screen_text answers text:false, and it is false for a graphics mode too (there are no character cells to
// read), not only for a text mode this reader cannot decode.
export function screenReadable(mode) {
  if (!mode.text) return { readable: false, reason: mode.reason || `${mode.name} has no character cells to read` };
  if (mode.readable === false) return { readable: false, reason: mode.reason || `${mode.name} cannot be read faithfully` };
  if (mode.gimeText || mode.plusText) return { readable: true };   // the GIME and the 6845 walk their own rows
  if (mode.cols && mode.cols > CELL_COLS) {
    return { readable: false, reason: `the machine's text rows are ${mode.cols} characters wide and this reader can only walk ${CELL_COLS}, so the rows cannot be read faithfully` };
  }
  return { readable: true };
}

// ---- what a tool target is ----
// The read-only tools take a TARGET, not a Session: an object with `machine` (the machine to read) and the same
// reads a tool needs on it (screenText, readByte, bootStatus), which is what Session.chatTarget() makes and what a
// caller with its own machine builds. A Session is NOT one: it says which machine it means through an accessor
// (shownMachine / personMachine), and a tool that guessed would read the chat machine when it meant the person's.
// Passing a Session here is refused by name rather than read through (a Session used to satisfy this by having a
// `machine` field, which is exactly the unclassified reach this classification ends).
function toolMachine(target) {
  if (!target || typeof target !== 'object') return null;
  // A Session (or anything like one) is a CALLER's mistake, and the model must be told so: a plain Error would be
  // reported as `tool-failed` with its "the tool failed inside the emulator" remedy, and the model would be told to
  // retry machine_info - the call that just failed. It stays tool-failed (the error set is the model's vocabulary,
  // and this is not a failure of what the model sent), but the DETAIL names the call, and the remedy now says a
  // detail that names a tool target means the call was wrong.
  if (typeof target.chatTarget === 'function' || 'shownMachine' in target || 'personMachine' in target) {
    throw new ToolError(TOOL_CODES.TOOL_FAILED,
      'these tools take a tool target (Session.chatTarget()), not a Session: a Session has two machines, so it says which one through an accessor');
  }
  return target.machine || null;
}

export function screenTextTool(target) {
  const m = toolMachine(target);
  if (!m) throw new ToolError(TOOL_CODES.NO_MACHINE);
  const r = readScreen(m, target.readByte);
  if (!r.text) return { text: false, mode: r.mode, lines: [], rows: 0, reason: r.reason };
  const lines = trimmed(r.rows), { rows: _all, mode, ...fields } = r;
  if (fields.attributes) fields.attributes = fields.attributes.slice(0, lines.length).map(attributeRuns);
  // the fields in the order a model has always seen them: what was read, where from, then the rows
  const { text, cols, base, physicalBase, startAddress, screenRows, attributes, semigraphics, unknown, note } = fields;
  const out = { text, mode, cols, base };
  if (physicalBase !== undefined) out.physicalBase = physicalBase;
  if (startAddress !== undefined) out.startAddress = startAddress;
  out.lines = lines; out.rows = lines.length;
  if (screenRows !== undefined) out.screenRows = screenRows;
  if (attributes) out.attributes = attributes;
  if (semigraphics) out.semigraphics = semigraphics;
  if (unknown) out.unknown = unknown;
  if (note) out.note = note;
  return out;
}

// The screen's rows as text, every row the screen shows at its full width (nothing trimmed). This is what
// Session.screenText returns, and so what the embed API's screenText, the page's Ask panel, the tape panel and the boot
// watchdog read: the SAME reader as screen_text, so the two cannot disagree on a text screen. A screen screen_text
// declines (a graphics mode, a set-up it cannot read) gives the VDG's page decoded, 16 rows of 32: the page vdgPage
// names, the one the VDG would show in text - on the SAM machines the SAM's display offset, so a ROM that has not set
// up the SAM yet (F = 0, its power-on state) is read at $0000, not at BASIC's $0400; on the MC-10 and a CoCo 3 the
// profile's page. A ROM that has not set the VDG to text yet (the PIA's power-on $FF selects graphics) can still have
// printed there, and a caller looking for OK or an error message looks there. `main: true` reads the machine's
// main screen (the VDG) even while the Dragon 64 Plus shows its 80-column board: BASIC prints OK there, whatever the
// Display tab shows.
export function screenRows(m, readByte, { main = false } = {}) {
  const r = readScreen(m, readByte, { main });
  if (r.text) return r.rows;
  const page = vdgPage(m);
  return vdgRows(page.byte).rows;
}
// The VDG's text page: where it starts and how the VDG fetches its bytes - the video hardware's own read, never the
// CPU's map.
//  * The SAM machines (Dragon 32/64/200, the Dragon 64 Plus and Alpha, CoCo 1/2): the page starts at the SAM's display
//    offset, F6-F0 x 512 (sam.displayBase, $FFC6-$FFD3; BASIC's power-on page $0400 is F = 2), and the SAM's video
//    counter is sized by M1-M0 (sam.counterMask), so a page past the end of a 4K or 16K counter wraps as the VDG sees
//    it; each byte comes through displayByte() (on the Dragon 64 Plus the motherboard RAM, whatever $FFE2 pages in
//    for the CPU: js/machines/d64plus.js).
//  * The MC-10's VDG and a CoCo 3 whose compatibility base is not latched yet: the profile's page, from `ram`, the
//    address-space view of the RAM the display uses (on the CoCo 3, physical $70000-$7FFFF, the power-on page).
// Returns { at, addr(i), byte(i) } for the page's bytes i = 0..511.
function vdgPage(m) {
  if (m.sam && typeof m.displayByte === 'function') {
    const at = m.sam.displayBase, mask = m.sam.counterMask;
    const addr = (i) => (at + i) & mask;
    return { at, addr, byte: (i) => m.displayByte(addr(i)) };
  }
  const at = m.profile.textScreen || 0x400, addr = (i) => (at + i) & 0xFFFF;
  return { at, addr, byte: (i) => m.ram[addr(i)] };
}

// One read of the screen: { text: false, mode, reason } or { text: true, mode, cols, base, rows (untrimmed), ... }
function readScreen(m, readByte, { main = false } = {}) {
  const mode = videoMode(m, { main });
  const read = screenReadable(mode);
  if (!read.readable) return { text: false, mode: mode.name, reason: read.reason };
  if (mode.gimeText) return gimeText(m, mode);
  if (mode.plusText) return plusText(m, mode);
  // A CoCo 3 in its compatibility mode: the page is read where the display reads it, in physical RAM (videoBase(),
  // which follows the SAM's page bits and $FF9D), through the GIME's own side-effect-free mem(). Reading it through
  // the CPU's map instead would read another page whenever the MMU maps that CPU address elsewhere.
  if (mode.legacyBase != null) {
    const g = m.gime, at = mode.legacyBase;
    const r = vdgRows((i) => g.mem(at + i));
    return { text: true, mode: mode.name, cols: CELL_COLS,
      base: contiguousCpuBase(g, { base: at, rows: VDG_ROWS, pitch: CELL_COLS, hoff: 0, hven: false }), physicalBase: at, ...r };
  }
  // the VDG family: the page the VDG shows, read where it fetches it (vdgPage: the SAM's display offset on the SAM
  // machines), never through the CPU's map, which can page something else in (the Dragon 64 Plus's banks); a CoCo 3
  // whose compatibility-mode base is not latched yet - between a register write and the next frame - is read here
  // too, from the profile's page. `base` is the page's CPU address only while the page does not wrap round the SAM's
  // video counter and the CPU reads all 512 of its bytes, every row, the same there; otherwise null.
  const page = vdgPage(m), n = VDG_ROWS * CELL_COLS;
  let cpuSees = page.addr(n - 1) === page.at + n - 1;
  for (let i = 0; cpuSees && i < n; i++) cpuSees = readByte(page.addr(i)) === page.byte(i);
  return { text: true, mode: mode.name, cols: CELL_COLS, base: cpuSees ? page.at : null, ...vdgRows(page.byte) };
}
// 16 rows x 32 cells: the VDG family's own geometry. A cell with bit 7 set is a semigraphics block, not a character:
// read as a space, and counted, so a picture made of blocks (or BASIC's cursor) is not taken for an empty screen
const VDG_ROWS = 16;
function vdgRows(byte) {
  const rows = [];
  let blocks = 0;
  for (let row = 0; row < VDG_ROWS; row++) {
    let line = '';
    for (let col = 0; col < CELL_COLS; col++) {
      const v = byte(row * CELL_COLS + col);
      if (v & 0x80) { line += ' '; blocks++; continue; }
      const c = v & 0x3F;
      line += String.fromCharCode(c < 32 ? c + 64 : c);
    }
    rows.push(line);
  }
  return { rows, ...(blocks ? { semigraphics: blocks, note: `${blocks} of the ${VDG_ROWS * CELL_COLS} cells are semigraphics blocks, read as spaces: screenshot shows them` } : {}) };
}

// the rows as a model reads them: trailing spaces trimmed, trailing blank rows left out (both readers)
function trimmed(lines) {
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  return lines.slice(0, last + 1).map((l) => l.replace(/\s+$/, ''));
}

// The Dragon 64 Plus's 80-column screen, from the machine's own walk of it (mode.plusText = m.textScreen(), taken once
// by videoMode so the mode named, the checks made and the rows read are the same state), decoded through PLUS_CHARS
// (videoMode has declined any code without an entry). `base` is the CPU address of the whole screen when the CPU sees
// all of it in one run: only while $FFE2 bit 0 maps the video RAM over $0000-$07FF (and the banks reach memory: not
// under config.mameCompat, where MAME 0.264 never maps them), the SAM leaves $0000-$07FF where it is (page bit P1
// can move it), and the screen's cells do not wrap round the 2K.
function plusText(m, mode) {
  const t = mode.plusText;
  let unknown = 0;
  const rows = t.codes.map((row) => row.map((c) => { const ch = PLUS_CHARS[c]; if (ch == null) { unknown++; return ' '; } return ch; }).join(''));
  const out = { text: true, mode: mode.name, cols: t.cols, base: plusCpuBase(m, t), startAddress: t.start, rows, screenRows: t.rows };
  // a code with no known character reads as a space and is counted (as the VDG's semigraphics are), so a screen of
  // them is not mistaken for an empty one
  const notes = [];
  if (unknown) { out.unknown = unknown; notes.push(`${unknown} of the ${t.rows * t.cols} cells hold a code outside $20-$7E, whose character is not known here: read as spaces, screenshot shows them`); }
  // without the user's character generator the board draws nothing: say so, rather than let the text suggest a picture
  if (!m.charGen) notes.push('no character generator ROM is loaded, so the 80-column picture is blank; these are the characters its video RAM holds');
  if (notes.length) out.note = notes.join('; ');
  return out;
}
function plusCpuBase(m, t) {
  if (!m.banksReachMemory || m.vramBank !== 3) return null;
  const first = t.start & (t.videoRam - 1), len = t.rows * t.cols;
  if (first + len > t.videoRam) return null;
  if (m.ramAddr(first, m.sam.reg) !== first || m.ramAddr(first + len - 1, m.sam.reg) !== first + len - 1) return null;
  return first;
}

// The Dragon 64 Plus board's character mapping: video RAM code -> the character it shows. Sources: P. Mooney
// (Serenarian), "Appendix A: The DragonPlus Character Set", his IC22 EPROM dump transcribed from a 1986 programmer
// printout (World of Dragon forum, 25 March 2018, archive.worldofdragon.org/phpBB3/viewtopic.php?p=16452), and the
// Dragon Archive's Compusense character ROM dump. Both put 'A' at EPROM offset $0410 and 'a' at $0610: code c's glyph
// is at c * 16, so codes $20-$7E are ASCII. $00-$1F hold other visible symbols (accented letters, the pound sign and
// so on), $7F is a solid block and $80-$FF are mostly underlined forms of $00-$7F; this reader gives no character
// for a code outside $20-$7E (those symbols and the underlining are not mapped here): such a cell reads as a space
// and is counted (`unknown`), never guessed. Which half of the generator is used: P. Harvey-Smith's Eagle schematic, traced from
// his own DragonPlus board (World of Dragon forum, 7 June 2017, viewtopic.php?p=15826), wires EPROM A0-A3 to the
// 6845's RA0-RA3, A4-A10 to character bits 0-6, A11 to character bit 7 (through the latch/jumper path) and A12 to a
// font-select jumper; no 6845 output drives A11 or A12. That wiring is from a traced schematic with known drawing errors; not verified on hardware.
// Compusense's "Dragonplus Interface Technical Information" p. 4 says only the first set is used, and the archived
// ROM's upper 4K is all $FF. The ROM image itself is the user's and is never read or stored here.
export const PLUS_CHARS = Object.freeze(Array.from({ length: 256 }, (_, c) => (c >= 0x20 && c <= 0x7E ? String.fromCharCode(c) : null)));

// The 80-column screen as videoMode reports it, or the reason it cannot be read. The checks are on the CRTC's
// registers as they stand (the machine's own state, never a CPU read of $FFE1, which on the HD6845S answers only
// CRTC R12-R17), in this order:
//   * R8 bit 0 set selects an interlace mode (Hitachi HD6845S data sheet, Interlace and Skew Register (R8), Table 4,
//     PDF p. 11: bits 1-0 = 00 and 10 non-interlace, 01 interlace sync, 11 interlace sync and video), which changes
//     the rows' raster addressing; the emulator draws without interlace, so what the board shows is not known here.
//     Compusense's own set-up writes R8 = $A2 (bits 1-0 = 10: non-interlace; technical notes p. 4), which is read;
//   * R8 bits 5-4 = 11: the HD6845S's display (DISPTMG) skew "non-output" (same data sheet, Table 5, PDF p. 11: 00
//     non-skew, 01 one-character skew, 10 two-character skew, 11 non-output; Table 6 gives the cursor skew, bits
//     7-6, the same values). So the display timing is inhibited and the screen is blank. Neither our renderer nor
//     MAME 0.264 (mc6845.cpp defines MODE_DISPLAY_ENABLE_SKEW and never uses it) models skew, so a skew of 1 or 2
//     characters, which only moves the picture (Compusense's own $A2 is display and cursor skew 2), is read;
//   * R1 or R6 0: the CRTC displays no characters;
//   * R1 >= R0 + 1 or R6 >= R4 + 1: the data sheet's constraints Nhd < Nht and Nvd < Nvt are broken, and the chip's
//     output is not a screen of rows;
//   * R1 over 80 or R6 x (R9 + 1) over 264: the board's picture is 80 cells of 8 by 264 lines (MAME's plus_screen,
//     640 x 264), so part of what the registers address is never shown;
//   * fewer than 10 raster lines a row (R9 < 9): the board's characters are a 7 x 9 matrix below a blank row
//     (Compusense's technical notes, p. 4, "Character ROM"), 10 lines, so a shorter row cuts them.
// A code PLUS_CHARS has no character for does not decline the screen: plusText reads it as a space and counts it.
function plusMode(m) {
  const reg = m.crtc.reg, t = m.textScreen();
  const name = `HD6845S text (the Dragon Plus), ${t.cols} columns, ${t.rows} rows`;
  const no = (reason) => ({ text: true, readable: false, cols: t.cols, name, reason });
  const h2 = (v) => `$${v.toString(16).toUpperCase().padStart(2, '0')}`;
  if (reg[8] & 1) return no(`R8 = ${h2(reg[8])} selects an interlace mode, which this emulator does not model, so the rows shown are not known`);
  if ((reg[8] & 0x30) === 0x30) return no(`R8 = ${h2(reg[8])} sets the display skew to non-output (bits 5-4 = 11), so the board shows nothing`);
  if (!t.cols || !t.rows) return no(`the CRTC displays no characters (R1 = ${t.cols}, R6 = ${t.rows})`);
  if (t.cols > reg[0]) return no(`R1 = ${t.cols} displayed characters is not less than the ${reg[0] + 1} of a line (R0 + 1), as the 6845 requires`);
  if (t.rows > reg[4]) return no(`R6 = ${t.rows} displayed rows is not less than the ${reg[4] + 1} of a frame (R4 + 1), as the 6845 requires`);
  if (t.cols > 80) return no(`R1 = ${t.cols} columns is wider than the board's picture, which shows 80`);
  if (t.rows * t.perRow > t.height) return no(`${t.rows} rows of ${t.perRow} lines (R6, R9) are taller than the board's ${t.height}-line picture`);
  if (t.perRow < 10) return no(`${t.perRow} raster lines a row (R9 = ${reg[9]}) is shorter than the board's 10-line character (a 7 x 9 matrix below a blank row), so no character is shown whole`);
  return { text: true, cols: t.cols, name, plusText: t };
}

// A GIME text mode, from the GIME's own walk of it (mode.gimeText = gime.textScreen(), taken once by videoMode so
// the mode named and the rows read are the same state). Characters go through GIME.TEXT_CHARS (bit 7 ignored, as
// the GIME's font does); attribute bytes are decoded into runs per row, never printed. The page is physical RAM,
// read through the GIME's own side-effect-free mem(); `base` is the CPU address of the whole screen when the memory
// map shows it to the CPU contiguously (contiguousCpuBase), else null. `rows` counts the rows returned (trailing blank
// rows left out, as on the VDG); `screenRows` is how many the screen shows.
function gimeText(m, mode) {
  const t = mode.gimeText, chars = GIME.TEXT_CHARS;
  const rows = t.chars.map((c) => Array.from(c, (v) => chars[v & 0x7F]).join(''));
  const out = { text: true, mode: mode.name, cols: t.cols, base: contiguousCpuBase(m.gime, t), physicalBase: t.base, rows, screenRows: t.rows };
  if (t.attrs) out.attributes = t.attrs;
  return out;
}
// One row's attribute bytes as runs of equal attributes. GIME attribute byte (js/chips/gime.js drawText, MAME
// gime.cpp): bit 7 blink, bit 6 underline, bits 3-5 foreground (palette 8-15), bits 0-2 background (palette 0-7).
function attributeRuns(a) {
  const runs = [];
  for (let i = 0; i < a.length;) {
    let j = i + 1;
    while (j < a.length && a[j] === a[i]) j++;
    const v = a[i];
    runs.push({ from: i, to: j - 1, fg: (v >> 3) & 7, bg: v & 7, underline: !!(v & 0x40), blink: !!(v & 0x80) });
    i = j;
  }
  return runs;
}
// The CPU address of the whole screen, or null. It is given only when the bytes the GIME reads - from the video start
// to the end of the last row, [base, base + rows x pitch), or to that row's 256th byte when a horizontal offset
// wraps the cells within it - all reach the CPU as one contiguous run under the current memory map: the 8K slot
// holding the start, and each following slot the run crosses into, must map the physical blocks that follow. With
// 256-byte virtual rows (HVEN) the screen is a window on a wider page, so there is no one address for it: null.
function contiguousCpuBase(gime, t) {
  if (t.hven || !t.rows) return null;
  const len = t.hoff ? (t.rows - 1) * t.pitch + 256 : t.rows * t.pitch;
  for (let s = 0; s < 8; s++) {
    const cpu = s * 0x2000 + (t.base & 0x1FFF);
    if (cpu + len > 0xFE00 || gime.physAddr(cpu) !== t.base) continue;
    let whole = true;
    // every 8K block the run crosses into, from the next block boundary on
    for (let k = 0x2000 - (t.base & 0x1FFF); whole && k < len; k += 0x2000) whole = gime.physAddr(cpu + k) === ((t.base + k) & gime.ramMask);
    if (whole) return cpu;
  }
  return null;
}

// ---- machine_info ----
// Structured so a model can read a field rather than parse a sentence; `atPrompt` and `video.readable` are null
// when they cannot be told, which is different from false. `readable` is the SAME answer screen_text gives, from
// the same rule (screenReadable), so a model can tell in one call whether screen_text is worth calling at all.
export function machineInfoTool(target) {
  const m = toolMachine(target);
  if (!m) throw new ToolError(TOOL_CODES.NO_MACHINE);
  const mode = videoMode(m);
  const read = screenReadable(mode);
  return {
    model: m.profile.name,
    ramK: m.config.ram,
    cpu: m.config.cpu,
    hasBasicRoms: !!m.hasRom,
    video: { kind: mode.text ? 'text' : 'graphics', mode: mode.name, readable: read.readable },
    atPrompt: atBasicPrompt(target, mode),
    pc: (m.cpu.pc >>> 0) & 0xFFFF,
  };
}

// The screen mode, as a human label and whether it has character cells to read.
// On a machine without a GIME the ground truth is the mode byte the beam actually used for the lines it
// drew: the MC6847 keeps it per active line in `vdg.firstMode` (js/chips/mc6847.js drawSamples) on the
// MC-10 and the Dragon/CoCo 1/2 family. The byte's bit 7 is A/G: clear is a text mode, set is graphics.
// Deriving it from a register instead would duplicate each machine's own wiring and could disagree with
// what is on the screen.
//
// The CoCo 3 is different: it has no MC6847 object, and the GIME's bit meanings are its own. Taken from
// js/chips/gime.js, which implements them:
//   $FF90 (regs[0]) bit 7 = LCOM: SET means legacy MC6847 emulation, CLEAR means native mode
//   native mode:  $FF98 (regs[8]) bit 7 = HRES: SET is a high-res BITMAP, CLEAR is text
//   bitmap size:  $FF99 bits 2-4 are an INDEX into HRES_BYTES, 16/20/32/40/64/80/128/160 bytes per row;
//                 CRES = ff99 & 3 picks the depth (0 = 1bpp, 1 = 2bpp, else 4bpp)
//   native text:  everything about it (columns, attributes, start, pitch, rows) comes from gime.textScreen(),
//                 the GIME's own walk, so there is one copy of that arithmetic
// Read the emulator's register state for the mode (never the CPU-readable registers: most GIME registers cannot be
// read back by a program). In legacy mode the BASE comes from gime.videoBase(), which branches on the frame's
// latched legacy bit; the two can disagree for the moment between a register write and the next frame start, so
// the mode and the base are taken to describe the SAME thing by asking videoBase() for its own branch (below).
function videoMode(m, { main = false } = {}) {
  // The d64plus can show the Hitachi HD6845S display instead of the VDG (`view === 'plus'`, which picks the
  // picture render() returns; the board has no register that picks one: MAME shows two screens, the page's
  // Display tab one). While it does, the 80-column board's screen is the one read, never the VDG page behind it.
  if (m.view === 'plus' && !main) return plusMode(m);
  const gime = m.gime;
  if (gime && gime.regs) {
    const r = gime.regs;
    if (!(r[0] & 0x80)) {          // native (LCOM clear)
      if (r[8] & 0x80) {           // HRES set: a bitmap, no character cells
        const bytesPerRow = [16, 20, 32, 40, 64, 80, 128, 160][(r[9] >> 2) & 7];
        const cres = r[9] & 3;
        const depth = cres === 0 ? '1 bit/pixel' : cres === 1 ? '2 bits/pixel' : '4 bits/pixel';
        return { text: false, name: `GIME native bitmap, ${bytesPerRow} bytes per row, ${depth}` };
      }
      // GIME text: the GIME's own walk of the screen (gime.textScreen), from the emulator's state - the video start,
      // pitch, offset, lines per row and rows - so what is read is what the display draws
      const t = gime.textScreen();
      const name = `GIME native text, ${t.cols} columns${t.attr ? ' with attributes' : ''}, ${t.rows} rows`;
      // rows shorter than a glyph show only its top line or two ($FF98 lines per row 1 or 2), and a vertical
      // resolution with no body lines ($FF99 LPF 2) shows no rows at all: a text mode, but no characters to read
      if (t.lpr < 8) return { text: true, readable: false, cols: t.cols, name, reason: `the GIME draws ${t.lpr} scanline${t.lpr === 1 ? '' : 's'} per text row ($FF98 lines per row), so no character is shown whole` };
      if (!t.rows) return { text: true, readable: false, cols: t.cols, name, reason: 'the GIME shows no text rows in this vertical resolution ($FF99 lines per field)' };
      return { text: true, cols: t.cols, name, gimeText: t };
    }
    // legacy: the GIME emulates the VDG, and follows the mode byte the machine writes to its VDG-mode
    // register (gime.js keeps it in `ff22`, as MAME's ff22_write does). Bit 7 is A/G: clear = text.
    // The page is where the display reads it: videoBase()'s LEGACY branch, a PHYSICAL address (the SAM's page bits
    // and $FF9D; 0x70400 at power-on). readScreen reads it there, from physical RAM, so a page the memory map (MMU)
    // shows the CPU somewhere else, or nowhere, is still read, and `base` says where the CPU sees it (or null).
    // videoBase() branches on the frame's latched legacy bit, so it is asked only when that agrees with LCOM; until
    // the next frame start the profile's page is read through the CPU's map, as before the switch.
    const ag = !!(gime.ff22 & 0x80);
    const raw = (ag || gime.legacy !== true || typeof gime.videoBase !== 'function') ? null : gime.videoBase();
    return { text: !ag, cols: ag ? 0 : 32, legacyBase: raw, name: ag ? `GIME legacy: MC6847 graphics, ${graphicsName(gime.ff22)}` : 'GIME legacy: MC6847 text' };
  }
  const vdg = m.vdg;
  if (vdg && vdg.firstMode) {
    const mode = vdg.firstMode[0];     // the mode of the first active line
    const ag = !!(mode & 0x80);
    if (!ag) return { text: true, cols: 32, name: 'MC6847 text' };
    return { text: false, name: `MC6847 graphics, ${graphicsName(mode)}` };
  }
  return { text: true, cols: 32, name: 'text' };
}

// a VDG mode byte's graphics mode (GM2-0, bits 6-4) as the chip's own table names it: "RG6 256x192 2-colour"
function graphicsName(modeByte) {
  const g = MC6847.graphicsMode((modeByte >> 4) & 7);
  return `${g.name} ${g.width}x${g.height} ${g.colours}-colour`;
}

// Is the machine sitting at BASIC's READY prompt?
// The prompt is the ROM's own business, but the Session already decides "did BASIC start?" (the target's
// bootStatus -> 'stub' | 'nitros9' | 'ok' | 'booting' | 'restored' | 'reset' | 'failed'). A machine with no ROMs
// runs the built-in stub and has no BASIC prompt (null); otherwise `atPrompt` is whether the screen still shows OK,
// which the target's bootStatus has already established, and null when it cannot be told. A restored moment (a
// snapshot opened, not powered on) and a run a program took over after Reset answer `false`: BASIC's prompt is not
// what is on screen, and saying so stops a model from typing a BASIC line into a game.
//
// When the machine is showing a screen this tool cannot read (a graphics mode, a declined GIME or 6845 set-up), the
// OK test would be run against rows it cannot decode. That is not "yes" and not "no": it is unknowable from here,
// so it is null - the same "cannot be told" answer as a machine that has not booted yet.
function atBasicPrompt(target, mode) {
  // the SAME readability rule screen_text answers with: an OK test run against rows this reader cannot decode
  // is not "yes" and not "no" - it is unknowable here; a readable 80-column screen is searched itself, never the
  // VDG page behind it
  if (!screenReadable(mode).readable) return null;
  const st = target.bootStatus ? target.bootStatus() : null;
  if (!st || st.state === 'stub' || st.state === 'booting') return null;
  if (st.state !== 'ok') return false;
  // a GIME text mode is read by the GIME's own walk, not the VDG page Session.screenText decodes
  const tm = toolMachine(target);
  const lines = mode.gimeText ? gimeText(tm, mode).rows : mode.plusText ? plusText(tm, mode).rows : target.screenText();
  return lines.some((l) => l.trim() === 'OK');
}

// ---- peek ----
// Bytes as the machine's CPU sees them, through the side-effect-free peek: RAM, ROM, cartridge and banked
// memory where the machine's map puts them, with no bus cycle and no I/O register touched.
// Asking for more than PEEK_MAX is not an error: it TRUNCATES, and the result says so (truncated + max), so a
// model that asked for 4096 and got 256 is told rather than left to notice. A length of 0 or above 65536 is an
// error (bad-length), and so is a read whose bytes would run past $FFFF - the check is made on the bytes read
// (at most 256), not on the bytes asked for, so an over-long request that still fits is served.
export const PEEK_MAX = 256;
// the bytes come as hex rows of 16, each with its address: far fewer tokens than a JSON array of numbers, and what a
// person reading memory expects
const PEEK_ROW = 16;
export function peekTool(target, input) {
  if (!toolMachine(target)) throw new ToolError(TOOL_CODES.NO_MACHINE);
  const addr = checkedInt(input ? input.address : undefined, { min: ADDRESS_MIN, max: ADDRESS_MAX, code: TOOL_CODES.BAD_ADDRESS });
  const asked = input && input.length != null ? checkedInt(input.length, { min: PEEK_LENGTH_MIN, max: PEEK_LENGTH_MAX, code: TOOL_CODES.BAD_LENGTH }) : PEEK_DEFAULT_LENGTH;
  // the check is on the bytes actually read, not on the bytes asked for: an asked-for 4096 at $F800 is
  // completed by the 256-byte read it truncates to, so refusing it would contradict the remedy
  const length = Math.min(asked, PEEK_MAX);
  if (addr + length - 1 > 0xFFFF) throw new ToolError(TOOL_CODES.PAST_END, `${addr}+${length}`);
  const hex = [];
  for (let row = 0; row < length; row += PEEK_ROW) {
    const n = Math.min(PEEK_ROW, length - row), bytes = [];
    for (let i = 0; i < n; i++) bytes.push(target.readByte(addr + row + i).toString(16).toUpperCase().padStart(2, '0'));
    hex.push(`$${(addr + row).toString(16).toUpperCase().padStart(4, '0')}: ${bytes.join(' ')}`);
  }
  return { address: addr, length, hex, truncated: length < asked, ...(length < asked ? { max: PEEK_MAX } : {}) };
}

// ---- disassemble ----
// The instructions at an address, decoded for this machine's CPU (6809, 6803 or 6309). It reads through the
// same side-effect-free peek as peekTool, so decoding a block that spans the I/O page touches no register;
// the test diffs the machine's full saved state around a call that does exactly that.
//
// The CPU comes from the machine, never from the request: a model that has just read machine_info must not be
// able to decode one machine's bytes with another's instruction set, which would silently misreport every
// instruction. ONE disassembler does the work - main's js/asm/disassembler.js, whose DECODERS table already
// covers all three - so there is no second instruction table to drift.
export const DISASSEMBLE_MAX = 64;
export function disassembleTool(target, input) {
  const m = toolMachine(target);
  if (!m) throw new ToolError(TOOL_CODES.NO_MACHINE);
  const { cpu, dp } = codeDisassembly(m);
  const addr = checkedInt(input ? input.address : undefined, { min: ADDRESS_MIN, max: ADDRESS_MAX, code: TOOL_CODES.BAD_ADDRESS });
  // the cap is the bound checkedInt enforces, so there is ONE rejection path and one detail format: a count of 0
  // or above the cap is bad-count, and asking for more is refused rather than silently truncated to the cap
  const asked = input && input.count != null ? checkedInt(input.count, { min: DISASSEMBLE_MIN, max: DISASSEMBLE_MAX, code: TOOL_CODES.BAD_COUNT }) : DISASSEMBLE_DEFAULT_COUNT;
  const list = [];
  let at = addr;
  let reachedEnd = false;
  while (list.length < asked) {
    // disassemble() throws only for a CPU with no decoder, and the CPU here comes from the machine, which has
    // one; illegal bytes decode with illegal:true rather than throwing, so there is no per-instruction failure
    // path to guard.
    const ins = disassemble(cpu, at, { peek: (a) => target.readByte(a), dp });
    list.push({
      // the bytes in hex, as peek gives them ("31 3F")
      address: ins.addr, bytes: [...ins.bytes].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' '), text: ins.text, size: ins.size,
      // where a direct-page, extended, indexed or branch operand actually points, resolved with this machine's
      // own dp; `text` keeps the symbolic form ($10 in `LDA <$10`), so this is the only place the address shows
      ...(ins.target != null ? { target: ins.target } : {}),
      ...(ins.illegal ? { illegal: true } : {}),
    });
    const next = (at + ins.size) & 0xFFFF;
    // the listing runs up the address space and does not wrap: stopping at $FFFF is said, not silent, so a
    // model that asked for 8 and got 2 is told rather than left to notice
    if (next <= at) { reachedEnd = true; break; }
    at = next;
  }
  return { address: addr, cpu, count: list.length, instructions: list, ...(reachedEnd ? { truncated: true, reason: 'the listing reached the end of the address space; start at a lower address for more' } : {}) };
}

// ---- the dispatcher ----
// Runs one read-only tool by name. ChatSession routes to this only for READ_ONLY_TOOLS members, so an
// unknown name here is a programming error and throws.
export function runReadOnlyTool(target, name, input) {
  switch (name) {
    case 'machine_info': return machineInfoTool(target);
    case 'screen_text': return screenTextTool(target);
    case 'peek': return peekTool(target, input);
    case 'disassemble': return disassembleTool(target, input);
    default: throw new Error(`not a read-only tool: ${name}`);
  }
}
