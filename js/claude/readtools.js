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
 * consent gate keys on the ACTING set (Session.ACTING_TOOLS, derived from chat.js's ACTING_TOOL_NAMES): it asks
 * for anything in that set, so a name is gated by being acting, not by being absent from here. The test that the
 * two sets together name every tool, exactly once, is what keeps them from drifting.
 *
 * Every tool answers a model, not a person: typed parameters with their units in the description, a JSON
 * result that echoes the request, and coded failures from js/claude/toolerrors.js.
 */
import { TOOL_CODES, ToolError, checkedInt } from './toolerrors.js';
import { disassemble } from '../asm/disassembler.js';
import { codeDisassembly } from '../debugger.js';

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
    { name: 'screen_text', description: "The text on the machine's screen: 16 rows of 32 characters, read from the page the display actually uses. Returned with the mode's name and `base`, the address that page was read from. A mode this reader cannot read faithfully (graphics, a wider GIME text mode, or GIME native text) is declined with a reason. Takes no parameters.", input_schema: schema({}, []) },
    {
      name: 'peek',
      description: 'Read bytes of memory, as the machine sees them (RAM, ROM, cartridge). Reads only; nothing is changed.',
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
// The text on the machine's screen, one line per row.
// The reader (Session.screenText) walks a fixed 32-byte row stride from a fixed base, which is right for the
// VDG's 32-column screen and wrong for a GIME text mode: at 40/64/80 columns the real stride is wider, so a
// fixed-stride walk returns row 0 again as every later row. Rather than hand back a screen that repeats row 0,
// a mode whose row stride is wider than the reader's is DECLINED, the same way a graphics mode is: the answer
// says there is no readable text screen and names the mode. That is honest and it cannot be acted on wrongly.
// The mode's own width and base are therefore the test of readability, not the reader's habits.
const CELL_COLS = 32;

// Whether screen_text can read the screen faithfully, and if not, why. ONE rule, used by screen_text to decide
// what to answer and by machine_info to report `video.readable`, so the two cannot disagree: `readable === false`
// means screen_text answers text:false, and it is false for a graphics mode too (there are no character cells to
// read), not only for a text mode this reader cannot decode.
export function screenReadable(mode) {
  if (!mode.text) return { readable: false, reason: mode.reason || `${mode.name} has no character cells to read` };
  if (mode.readable === false) return { readable: false, reason: mode.reason || `${mode.name} cannot be read faithfully` };
  if (mode.cols && mode.cols > CELL_COLS) {
    return { readable: false, reason: `the machine's text rows are ${mode.cols} characters wide and this reader can only walk ${CELL_COLS}, so the rows cannot be read faithfully` };
  }
  return { readable: true };
}

export function screenTextTool(target) {
  const m = target.machine;
  if (!m) throw new ToolError(TOOL_CODES.NO_MACHINE);
  const mode = videoMode(m);
  const read = screenReadable(mode);
  if (!read.readable) return { text: false, mode: mode.name, lines: [], rows: 0, reason: read.reason };
  // the base: a machine may put its text screen elsewhere than the profile's default (the CoCo 3's GIME video
  // base moves with $FF9D-$FF9F). Read from where the display really is, not from a fixed $400.
  const base = textBase(m, mode);
  // 16 rows x 32 cells: the VDG family's own geometry, which is the only one this reader can walk (a wider
  // GIME mode was declined above)
  const lines = [];
  for (let row = 0; row < 16; row++) {
    let line = '';
    for (let col = 0; col < CELL_COLS; col++) {
      const v = target.readByte((base + row * CELL_COLS + col) & 0xFFFF);
      if (v & 0x80) { line += ' '; continue; }
      const c = v & 0x3F;
      line += String.fromCharCode(c < 32 ? c + 64 : c);
    }
    lines.push(line);
  }
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  const shown = lines.slice(0, last + 1).map((l) => l.replace(/\s+$/, ''));
  return { text: true, mode: mode.name, cols: CELL_COLS, base, lines: shown, rows: shown.length };
}

// Where the machine's text screen actually starts. The profile's `textScreen` is the VDG family's fixed page; a
// GIME machine moves it with $FF9D/$FF9E/$FF9F, and the GIME's own videoBase() already decodes those registers
// (js/chips/gime.js, the same arithmetic MAME's gime_device uses). Using it means a moved base is followed
// rather than silently reading the old page. Machines without a GIME keep the profile's value.
//
// This is where the value becomes an ADDRESS, so it is the ONE place the 16-bit mask belongs: videoBase()'s
// legacy branch adds SAM bits and can exceed 16 bits (measured: 0x70400 at power-on), while the CPU addresses
// the page in the low 16. Masking here rather than in videoMode() keeps a single mask on the single path that
// needs it - two masks guarding one value is how neither of them can be tested.
function textBase(m, mode) {
  const gime = m.gime;
  if (gime && gime.regs && mode.gimeBase != null) return mode.gimeBase & 0xFFFF;
  return m.profile.textScreen || 0x400;
}

// ---- machine_info ----
// Structured so a model can read a field rather than parse a sentence; `atPrompt` and `video.readable` are null
// when they cannot be told, which is different from false. `readable` is the SAME answer screen_text gives, from
// the same rule (screenReadable), so a model can tell in one call whether screen_text is worth calling at all.
export function machineInfoTool(target) {
  const m = target.machine;
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
//   native text:  $FF99 (regs[9]) bit 4 = H50 (80 vs 64/40/32 columns), bit 2 = the wide (40/80) layout,
//                 bit 0 = attribute bytes
//   bitmap size:  $FF99 bits 2-4 are an INDEX into HRES_BYTES, 16/20/32/40/64/80/128/160 bytes per row;
//                 CRES = ff99 & 3 picks the depth (0 = 1bpp, 1 = 2bpp, else 4bpp)
// Read the live registers for the mode. The BASE comes from gime.videoBase(), which branches on the frame's
// latched legacy bit; the two can disagree for the moment between a register write and the next frame start, so
// the mode and the base are taken to describe the SAME thing by asking videoBase() for its own branch (below).
function videoMode(m) {
  // The d64plus can show the Hitachi HD6845S display instead of the VDG (`view === 'plus'`, which picks the
  // picture render() returns). Nothing in this repo reads 6845 text: there is no character-cell view of that
  // screen, so it is reported as graphics-shaped - the honest answer to "is there a text screen to read" -
  // and screen_text says so rather than handing back the VDG page, which is not what is on the screen.
  if (m.view === 'plus') return { text: false, name: 'HD6845S 80-column display (the Dragon Plus)', reason: 'this build has no character-cell reader for the Plus board\'s HD6845S display' };
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
      const cols = (r[9] & 0x10) ? ((r[9] & 0x04) ? 80 : 64) : ((r[9] & 0x04) ? 40 : 32);
      // No base is computed here: native text is declined just below, so no address is ever read from this page
      // and there is no field to report one in. (A `gimeBase` local was computed and discarded here until
      // 14b-tools-followup; the decline in aef90fe is what orphaned it.)
      // GIME native text holds ASCII (with an optional attribute byte per cell), NOT VDG codes: this reader
      // decodes VDG codes, so it cannot read it faithfully. Measured: a row of "hello, world! 1234567890"
      // came back as "(%,,/, 7/2,$! 1234567890" - the alphabet round-trips by accident, everything else does
      // not. It IS a text mode (machine_info says so), but NOT one this reader can read.
      return {
        text: true, readable: false, cols,
        name: `GIME native text, ${cols} columns${(r[9] & 0x01) ? ' with attributes' : ''}`,
        reason: 'GIME native text stores ASCII (not the VDG character codes this reader decodes), so the rows cannot be read faithfully',
      };
    }
    // legacy: the GIME emulates the VDG, and follows the mode byte the machine writes to its VDG-mode
    // register (gime.js keeps it in `ff22`, as MAME's ff22_write does). Bit 7 is A/G: clear = text.
    // The base here comes from videoBase()'s LEGACY branch, which adds SAM bits and can exceed 16 bits
    // (measured: 0x70400 at power-on). It is passed through RAW, unmasked: textBase() is where it becomes an
    // address and is the one place the mask belongs (see there). Masking in both places would make neither
    // mask observable, which is exactly how this went untested.
    const ag = !!(gime.ff22 & 0x80);
    const raw = (ag || gime.legacy !== true || typeof gime.videoBase !== 'function') ? null : gime.videoBase();
    // The reader returns a CPU ADDRESS and reads through the machine's map, while the display reads PHYSICAL
    // memory at videoBase(). Those are the same page only while the map routes the CPU address to it. Under the
    // power-on default map they agree; with the MMU enabled and a slot remapped they do not, and the reader
    // would report a page nobody is looking at - the same defect as the Plus-screen case, one layer down. So
    // rather than assume it, ask the map: if the CPU address's physical destination is not the displayed page
    // (or is ROM, which physAddr reports as -1), the rows cannot be read faithfully and the mode is declined.
    if (raw != null && typeof gime.physAddr === 'function') {
      const cpuBase = raw & 0xFFFF;              // the address the CPU would use for this page
      const mapped = gime.physAddr(cpuBase);     // where that address actually lands physically
      if (mapped !== raw) {
        // render an address as the machine's own $XXXX; a physical address can need five digits on a 512K CoCo 3
        const at = (n) => (n < 0 ? 'ROM' : `$${n.toString(16).toUpperCase().padStart(n > 0xFFFF ? 5 : 4, '0')}`);
        return {
          text: true, readable: false, cols: 32, gimeBase: raw,
          name: 'GIME legacy: MC6847 text',
          reason: `the CPU map routes $${cpuBase.toString(16).toUpperCase().padStart(4, '0')} to ${at(mapped)}, but the display reads ${at(raw)}: the memory map (MMU) has moved that page, so the rows cannot be read faithfully`,
        };
      }
    }
    return { text: !ag, cols: ag ? 0 : 32, gimeBase: raw, name: ag ? 'GIME legacy: MC6847 graphics' : 'GIME legacy: MC6847 text' };
  }
  const vdg = m.vdg;
  if (vdg && vdg.firstMode) {
    const mode = vdg.firstMode[0];     // the mode of the first active line
    const ag = !!(mode & 0x80);
    if (!ag) return { text: true, cols: 32, name: 'MC6847 text' };
    const gm = (mode >> 4) & 7;        // the MC6847's own GM numbering
    const names = { 0: '64x64 4-colour', 1: '128x64 2-colour', 2: '128x96 2-colour', 3: '128x96 4-colour',
      4: '128x192 2-colour', 5: '128x192 4-colour', 6: '256x192 2-colour', 7: '256x192 4-colour' };
    return { text: false, name: `MC6847 graphics, ${names[gm] || `GM${gm}`}` };
  }
  return { text: true, cols: 32, name: 'text' };
}

// Is the machine sitting at BASIC's READY prompt?
// The prompt is the ROM's own business, but the Session already decides "did BASIC start?" (the target's
// bootStatus -> 'stub' | 'ok' | 'booting' | 'failed'). A machine with no ROMs runs the built-in stub and has no
// BASIC prompt (null); otherwise `atPrompt` is whether the screen still shows OK, which the target's
// bootStatus has already established, and null when it cannot be told.
//
// When the machine is showing a screen this tool cannot read (the d64plus on its HD6845S display), the OK test
// would be run against a page nobody is looking at. That is not "yes" and not "no": it is unknowable from here,
// so it is null - the same "cannot be told" answer as a machine that has not booted yet.
function atBasicPrompt(target, mode) {
  // the SAME readability rule screen_text answers with: an OK test run against rows this reader cannot decode
  // (the Plus's hidden VDG page, GIME native text's ASCII) is not "yes" and not "no" - it is unknowable here
  if (!screenReadable(mode).readable) return null;
  const st = target.bootStatus ? target.bootStatus() : null;
  if (!st || st.state === 'stub' || st.state === 'booting') return null;
  if (st.state !== 'ok') return false;
  return target.screenText().some((l) => l.trim() === 'OK');
}

// ---- peek ----
// Bytes as the machine's CPU sees them, through the side-effect-free peek: RAM, ROM, cartridge and banked
// memory where the machine's map puts them, with no bus cycle and no I/O register touched.
// Asking for more than PEEK_MAX is not an error: it TRUNCATES, and the result says so (truncated + max), so a
// model that asked for 4096 and got 256 is told rather than left to notice. A length of 0 or above 65536 is an
// error (bad-length), and so is a read whose bytes would run past $FFFF - the check is made on the bytes read
// (at most 256), not on the bytes asked for, so an over-long request that still fits is served.
export const PEEK_MAX = 256;
export function peekTool(target, input) {
  if (!target.machine) throw new ToolError(TOOL_CODES.NO_MACHINE);
  const addr = checkedInt(input ? input.address : undefined, { min: ADDRESS_MIN, max: ADDRESS_MAX, code: TOOL_CODES.BAD_ADDRESS });
  const asked = input && input.length != null ? checkedInt(input.length, { min: PEEK_LENGTH_MIN, max: PEEK_LENGTH_MAX, code: TOOL_CODES.BAD_LENGTH }) : PEEK_DEFAULT_LENGTH;
  // the check is on the bytes actually read, not on the bytes asked for: an asked-for 4096 at $F800 is
  // completed by the 256-byte read it truncates to, so refusing it would contradict the remedy
  const length = Math.min(asked, PEEK_MAX);
  if (addr + length - 1 > 0xFFFF) throw new ToolError(TOOL_CODES.PAST_END, `${addr}+${length}`);
  const bytes = [];
  for (let i = 0; i < length; i++) bytes.push(target.readByte(addr + i));
  return { address: addr, length, bytes, truncated: length < asked, ...(length < asked ? { max: PEEK_MAX } : {}) };
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
  const m = target.machine;
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
      address: ins.addr, bytes: ins.bytes, text: ins.text, size: ins.size,
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
