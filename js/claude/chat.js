/*
 * ChatSession: one conversation with Claude, the brief, the message list and the machine
 * tools, wired to a backend and a byte channel. Browser-free.
 *
 * The chat firmware's bytes arrive through the channel (pump, once a frame); a line ending in CR goes to the
 * backend, and the reply goes back down the channel as it streams. The backend is injected (js/claude/backend.js
 * for the API-key edition); the channel is injected (MemoryChannel now, DriveWire's later).
 *
 * The machine tools act on `target`, the BASIC session kept alongside the chat (Session.chatTarget
 * builds it): { machine, show(), screenText(), readByte(addr), pokeBytes(addr, bytes), typeText(text),
 * pressBreak(), snapshot(), restore(snap) }. Typing and BREAK need the BASIC session running, so they put it on
 * screen (show). Before Claude's first change in a turn the target is snapshotted, always through withRestorePoint; undoLast()
 * restores the newest snapshot (the last 10 are kept) and shows the BASIC session.
 */
import { hex } from '../util.js';
import { assemble } from '../asm/assembler.js';
import { describeError, loadIncludes } from '../media/includes.js';
import { ADDRESS_MAX, ADDRESS_MIN, READ_ONLY_TOOLS, readOnlyTools, runReadOnlyTool } from './readtools.js';
import { TOOL_CODES, ToolError, asToolError, checkedInt } from './toolerrors.js';
import { PACE } from '../machines/typist.js';
import { BASIC_LINE_MAX } from '../media/basic.js';
import { BASIC_PROGRAM_TEXT_MAX, planBasic, writeBasic } from './basicload.js';
import { opensTurn, wholeTurn } from './history.js';
import { actionRecord, readKind } from './actions.js';

// The acting tools: the ones that change the BASIC session. Each is one entry of ACTING below - its schema, a
// `check` that refuses with nothing changed, and an `act` that makes the change - and ChatSession.runTool runs
// every entry the same way: the consent gate, then check, then act inside the turn's restore point
// (withRestorePoint). The schemas offered to the model (actingTools) and the gated names (ACTING_TOOL_NAMES) are
// both derived from ACTING, so a tool cannot be offered without passing the gate and the restore point. The
// read-only tools are the other half, in js/claude/readtools.js; together the two name every tool.
// The bounds and defaults the code applies, named once so the schemas cannot drift from them (tests compare).
export const TYPE_TEXT_MAX = 65536;      // characters one type_text may type (a long BASIC listing is legitimate)
export const POKE_MIN = 1, POKE_MAX = 256;   // bytes one poke writes
export const BYTE_MIN = 0, BYTE_MAX = 255;
export const SOURCE_MAX = 32768;         // characters of assembler source one assemble_and_load takes
// with no org argument and no ORG line the assembler starts at this address (js/asm/assembler.js: pc = 0)
export const ASSEMBLE_DEFAULT_ORG = 0;
export const RUN_DEFAULT_TARGET = 'RUN';  // run with no target types RUN
// How Claude puts a BASIC program in (the policy): typing is for short programs, and a longer one is
// loaded with load_basic, whose card asks the person. Stated in the tool descriptions and in the brief (js/claude/brief.js), and
// tests/claude-typing.test.js checks both say it.
export const TYPE_LINES_MAX = 3;
// The page's cards are the permission: load_basic's card asks before anything is loaded, so Claude calls the tool
// rather than asking in prose first (a prose question and then the card is asking twice).
export const TYPING_POLICY = `Policy: type a BASIC program with type_text only when it has ${TYPE_LINES_MAX} lines or fewer; for a longer program, call load_basic instead of typing it. Do not ask in prose first: the page shows the person a card for each load_basic call (unless they chose not to be asked again) and nothing is loaded without their agreement. After either, verify before you say it worked: type LIST and read the screen with screen_text, and compare with the program you meant.`;
// The consent each acting tool states, as js/session.js (gateTools) implements it. Every acting tool can also
// fail tool-failed (an uncoded failure inside the emulator), so every description names it.
const CONSENT = ' Needs "Let Claude use the emulator": the person is asked the first time, unless that switch is already on (Allow turns it on for the visit; turning it off asks again); if they decline you get the error consent-declined, if there is nobody to ask no-consent, and if they press Stop stopped (also while Claude is paused, and for any later call in a turn they stopped); nothing changes then. Any other failure inside the emulator is tool-failed.';
// load_basic is not behind that question: it has its own card on every call (js/session.js gateTools)
const LOAD_CONSENT = ' The person is asked on every call, whether or not "Let Claude use the emulator" is on, unless they ticked "Don\'t ask again this session" (offered only while that switch is on; turning it off asks again); if they decline you get the error load-declined, if there is nobody to ask no-consent, and if they press Stop stopped (also while Claude is paused, and for any later call in a turn they stopped); nothing changes then. Any other failure inside the emulator is tool-failed.';
const ADDR = `${ADDRESS_MIN}-${ADDRESS_MAX}`;
// What a keyboard tool's success means, said in each of their descriptions: the machine read the keys, nothing more
export const CONSUMED_MEANS = 'consumed means the keyboard was scanned with the key down, not proof the program acted on it: check the effect with screen_text, peek or machine_info before you say it happened.';
const schema = (props, required) => ({ type: 'object', properties: props, required });
const int = (description, min, max) => ({ type: 'integer', minimum: min, maximum: max, description });

// A ToolError for a failure after which the machine is as it was (nothing landed): withRestorePoint does not keep
// a restore point for it, so a write that changed nothing neither adds one nor pushes a real one out of the last 10.
const unchanged = (code, detail) => Object.assign(new ToolError(code, detail), { unchanged: true });

// name -> { schema (description, input_schema), check(chat, t, input) -> plan, act(chat, t, plan) -> result }.
// check may only read: everything that can refuse is there, so a refused call changes nothing and takes no restore
// point. act runs inside withRestorePoint. Both may be async.
const ACTING = {
  poke: {
    description: `Write bytes of memory through the machine's map: RAM takes them; ROM, I/O and absent RAM do not and are listed in not_taken. Returns {address,length,written,skipped,not_taken:[{from,to,why}]}: written is how many bytes landed, skipped how many did not. Errors: bad-address, not-a-number, empty, bad-byte, too-large, past-end (the bytes must end at or before ${ADDRESS_MAX}), not-ram (no byte landed).` + CONSENT,
    input_schema: schema({
      address: int(`Decimal integer ${ADDR} of the first byte.`, ADDRESS_MIN, ADDRESS_MAX),
      bytes: { type: 'array', items: { type: 'integer', minimum: BYTE_MIN, maximum: BYTE_MAX }, minItems: POKE_MIN, maxItems: POKE_MAX, description: `Decimal byte values ${BYTE_MIN}-${BYTE_MAX}, ${POKE_MIN} to ${POKE_MAX} of them.` },
    }, ['address', 'bytes']),
    check(chat, t, input) {
      const address = checkedInt(input.address, { min: ADDRESS_MIN, max: ADDRESS_MAX, code: TOOL_CODES.BAD_ADDRESS });
      const bytes = input.bytes;
      if (!Array.isArray(bytes) || bytes.length < POKE_MIN) throw new ToolError(TOOL_CODES.EMPTY, 'bytes');
      if (bytes.length > POKE_MAX) throw new ToolError(TOOL_CODES.TOO_LARGE, `${bytes.length} bytes, at most ${POKE_MAX}`);
      for (const b of bytes) checkedInt(b, { min: BYTE_MIN, max: BYTE_MAX, code: TOOL_CODES.BAD_BYTE });
      if (address + bytes.length - 1 > ADDRESS_MAX) throw new ToolError(TOOL_CODES.PAST_END, `${address}+${bytes.length}`);
      return { address, bytes };
    },
    act(chat, t, { address, bytes }) {
      const written = t.pokeBytes(address, bytes);       // how many landed, as the machine says
      if (written === 0) throw unchanged(TOOL_CODES.NOT_RAM, `$${address.toString(16).toUpperCase()}`);
      return { address, length: bytes.length, written, skipped: bytes.length - written, not_taken: chat.notTaken(address, bytes) };
    },
  },
  type_text: {
    description: `Type text at the machine's keyboard as if typed (\\n presses Enter), 1 to ${TYPE_TEXT_MAX} characters, into whatever program is reading it. Each key is held until the machine has read it, and the next line waits until the machine is reading the keyboard again, so a busy program drops nothing. Returns {requested,consumed,lines_requested,lines_delivered}: keys and Enters the machine read; ${CONSUMED_MEANS} Errors: empty, too-large, not-typable (nothing typed); not-consumed if the machine stops reading the keyboard (the rest is not typed; detail says how far it got); machine-stopped if the Debugger has the machine stopped (nothing typed); stopped if the person presses Stop while it types (the keys before it were typed; detail says how many); machine-restarted if the machine restarts while the keys go in (detail says how many went in); this is not a Stop: read the screen before typing again. ${TYPING_POLICY}` + CONSENT,
    input_schema: schema({ text: { type: 'string', minLength: 1, maxLength: TYPE_TEXT_MAX, description: `The keys to type, 1 to ${TYPE_TEXT_MAX} characters; \\n is Enter.` } }, ['text']),
    check(chat, t, input) {
      const text = input.text;
      if (typeof text !== 'string' || !text) throw new ToolError(TOOL_CODES.EMPTY, 'text');
      if (text.length > TYPE_TEXT_MAX) throw new ToolError(TOOL_CODES.TOO_LARGE, `${text.length} characters, at most ${TYPE_TEXT_MAX}`);
      const bad = t.untypable(text);
      if (bad.length) throw new ToolError(TOOL_CODES.NOT_TYPABLE, JSON.stringify(bad.join('')));
      return text;
    },
    act(chat, t, text) { t.show(); return chat.keys(t, t.typeText(text)); },
    needsRunning: true,
  },
  load_basic: {
    description: `Load a BASIC program straight into the program memory of the machine's BASIC, as loading it from tape or disk would: no typing. The text is tokenized for this machine's BASIC (Dragon, Color/Extended BASIC on a CoCo, Micro Color BASIC on an MC-10) and replaces the program in memory (like NEW, then the lines). One line per program line, each starting with its line number (0-${BASIC_LINE_MAX}), 1 to ${BASIC_PROGRAM_TEXT_MAX} characters in all. Needs the BASIC prompt (not the no-ROM stub, not a running program). Returns {lines,bytes,start,end}: the lines stored, the program's size in bytes, and its first and last byte addresses (decimal). Only characters $20-$7E. Errors: empty, too-large, bad-line-number, line-too-long, not-typable, no-basic, not-at-prompt, program-too-large, unknown-machine, each refused with nothing changed; not-ram if the program did not read back once written. ${TYPING_POLICY}` + LOAD_CONSENT,
    input_schema: schema({ program: { type: 'string', minLength: 1, maxLength: BASIC_PROGRAM_TEXT_MAX, description: `The program listing: numbered lines separated by \\n, 1 to ${BASIC_PROGRAM_TEXT_MAX} characters.` } }, ['program']),
    // the same implementation as Session.loadBasic (js/claude/basicload.js)
    check: (chat, t, input) => planBasic(t, input.program),
    act(chat, t, plan) { t.show(); return writeBasic(t, plan); },
  },
  press_break: {
    description: `Press BREAK on the machine's keyboard, held until the machine has read it down, as type_text holds a key. Takes no parameters. Returns {requested:1,consumed:1}; ${CONSUMED_MEANS} Errors: not-consumed if the machine does not read the keyboard while BREAK is held (a program that never scans it; a machine without ROMs, whose stub reads no BREAK); machine-stopped if the Debugger has the machine stopped (nothing pressed); stopped if the person presses Stop while it is held; machine-restarted if the machine restarts while the keys go in (detail says how many went in); this is not a Stop: read the screen before typing again.` + CONSENT,
    input_schema: schema({}, []),
    check: () => null,
    act(chat, t) { t.show(); return chat.keys(t, t.pressBreak(), { read: true }); },
    needsRunning: true,
  },
  assemble_and_load: {
    description: `Assemble source for the machine's own CPU and write it into memory; does not start it (use run). Returns {bytes,written,skipped,ranges:[{from,to}],start,symbols:{NAME:address},not_taken:[{from,to,why}]} with every address a decimal integer: bytes assembled, how many landed (written) and did not (skipped); not_taken lists bytes that did not land (why: rom, io, latch, undecoded, absent-ram, lost). Errors: empty, too-large, bad-address, not-a-number, assembly-failed (with the line numbers of your source), include-unreadable (an INCLUDE file could not be read), org-conflict, past-end, not-ram (no byte landed), each refused with nothing written.` + CONSENT,
    input_schema: schema({
      source: { type: 'string', minLength: 1, maxLength: SOURCE_MAX, description: `Assembler source text, 1 to ${SOURCE_MAX} characters. A comment starts with ; (a line with * or ;); after an instruction that takes no operand, text is a comment unless it starts like an operand (#, $, a digit, a comma).` },
      org: int(`Load address, decimal ${ADDR}. Omit it if the source has its own ORG; with neither, the code is assembled at ${ASSEMBLE_DEFAULT_ORG}.`, ADDRESS_MIN, ADDRESS_MAX),
    }, ['source']),
    check: (chat, t, input) => chat.assemble(t, input),
    act(chat, t, res) {
      const written = t.writeSegments(res);       // writes only (no reset: a ROM-less machine would lose its RAM; no jump); how many landed
      const total = res.segments.reduce((n, sg) => n + sg.data.length, 0);
      if (written === 0) {
        const last = res.segments[res.segments.length - 1];
        throw unchanged(TOOL_CODES.NOT_RAM, `${hex(res.segments[0].addr)}-${hex(last.addr + last.data.length - 1)}`);
      }
      // every segment is read back: a program aimed at ROM or I/O assembles and then is not there
      const not_taken = res.segments.flatMap((sg) => chat.notTaken(sg.addr, sg.data));
      return {
        bytes: total, written, skipped: total - written,
        ranges: res.segments.map((sg) => ({ from: sg.addr, to: sg.addr + sg.data.length - 1 })),
        start: res.exec,
        symbols: Object.fromEntries([...res.symbols].sort((a, b) => a[1] - b[1])),
        not_taken,
      };
    },
  },
  run: {
    description: `Start the code in memory. \`target\` is an address to jump to: a decimal integer ${ADDR}, or text in hex ("$3000", "0x3000", "3000"); or the text "RUN" to type RUN and Enter at the keyboard, as type_text types, so BASIC runs its program (needs the BASIC ROMs, and BASIC at its prompt). Returns {how:"jump", target} with the address the CPU was sent to, or {how:"typed", target:"RUN", requested, consumed, lines_requested, lines_delivered}; for "RUN", ${CONSUMED_MEANS} Errors: bad-target, no-basic, machine-stopped if the Debugger has the machine stopped (nothing run); for "RUN" also not-consumed (the machine did not read the keys), stopped (the person pressed Stop while it typed) and machine-restarted if the machine restarts while the keys go in (detail says how many went in); this is not a Stop: read the screen before typing again.` + CONSENT,
    input_schema: schema({ target: { anyOf: [{ type: 'integer', minimum: ADDRESS_MIN, maximum: ADDRESS_MAX }, { type: 'string' }], description: `Address (decimal integer ${ADDR}, or hex text) or "RUN"; omit for "${RUN_DEFAULT_TARGET}".` } }, []),
    check(chat, t, input) {
      const raw = input.target == null ? RUN_DEFAULT_TARGET : input.target;
      return { raw, parsed: t.checkRun(raw) };
    },
    act(chat, t, { raw, parsed }) {
      t.show();
      const job = t.run(raw);
      if (parsed != null) return { how: 'jump', target: parsed };
      return chat.keys(t, job, { read: true }).then((report) => ({ how: 'typed', target: RUN_DEFAULT_TARGET, ...report }));
    },
    // (a jump too: on a stopped machine it would set the PC and run nothing, which reads as success)
    needsRunning: true,
  },
};

// The tools that need the machine to run or read keys (needsRunning: type_text, press_break, run) refuse while the
// Debugger has it stopped: machine-stopped, with where it stopped. Nothing is queued behind the stop, as
// the person's own typing is refused then (Session.refuseTyping; both ask Session.stoppedOn). The tools that only
// write memory (poke, assemble_and_load, load_basic) and every read work on a stopped machine, as the Debugger does.
export function stoppedRefusal(t, name) {
  const tool = Object.hasOwn(ACTING, name) ? ACTING[name] : null;
  const at = tool && tool.needsRunning && t && t.stopped ? t.stopped() : null;
  return at ? new ToolError(TOOL_CODES.MACHINE_STOPPED, `stopped in the Debugger at ${hex(at.pc)} (${at.kind})`) : null;
}

export function actingTools() {
  return Object.entries(ACTING).map(([name, { description, input_schema }]) => ({ name, description, input_schema }));
}

// Every tool this build offers: the read-only ones first, then the acting ones.
export function machineTools() { return [...readOnlyTools(), ...actingTools()]; }

// The acting tools' names, derived from ACTING rather than typed out again: ChatSession.runTool gates exactly
// these, and ui/claude.js's picture-in-picture rule uses them.
export const ACTING_TOOL_NAMES = Object.freeze(Object.keys(ACTING));

// The chat firmware's channel mailbox (examples/chat.asm): two status/data pairs, one each way.
export const CHAT_CHANNEL = Object.freeze({ rx: 0x7000, tx: 0x7002 });
// Two of the firmware's variables, read by the page to tell whether BREAK would do anything (Esc on an empty, idle
// prompt leaves the chat instead): BLEN, the characters on the typed line (16 bits, high byte first), and WAIT, set
// from ENTER until the reply ends. tests/chat-firmware.test.js ties these addresses to the assembled source.
export const CHAT_STATE = Object.freeze({ blen: 0x700D, wait: 0x6031 });
// The chat firmware's screen (examples/chat.asm, COLS and ROWS): 42 columns of the 6x8 font in 256x192 graphics,
// 24 rows, on every machine (there is no 80-column CoCo 3 mode yet). tests/chat-firmware.test.js ties these to
// the source, so the brief can't tell Claude a width the screen doesn't have.
export const CHAT_SCREEN = Object.freeze({ cols: 42, rows: 24 });
// The byte that ends every turn toward the firmware (a reply, an error, a refusal or a stop): until it comes, the
// firmware takes no typing, so a line typed early can't land in the middle of a reply.
export const END_OF_REPLY = 0x04;

// a ChatSession built without a gate acts for nobody
const NO_GATE = () => { throw new ToolError(TOOL_CODES.NO_CONSENT); };

export class ChatSession {
  // deps: { backend, channel, brief, tools (bool), target (the BASIC session), onText, onToolUse,
  //         include ((name, { signal }) => text | null, may throw an Error with a string code: the page's INCLUDE
  //         reader for assemble_and_load, js/host/example-reader.js; none = no INCLUDE),
  //         gate ((name, input, call) => nothing, or a promise: the consent gate every acting tool passes; it throws
  //         or rejects to refuse. The default refuses (no-consent): whoever builds a ChatSession says who consents.
  //         Session.gateTools sets the person's) }
  constructor({ backend, channel = null, brief = '', tools = true, target = null, onText = null, onToolUse = null, include = null, gate = null } = {}) {
    if (!backend) throw new Error('ChatSession needs a backend');
    this.backend = backend;
    this.channel = channel;
    this.brief = brief;
    this.target = target;
    this.include = include;
    this.gate = gate || NO_GATE;
    // (name, input, call) => nothing, or a promise: the pre-act re-check, run synchronously just before the change;
    // a promise is a wait (a pause), after which it runs again. Session.gateTools sets it
    this.recheck = () => null;
    this.onRestorePoint = null;  // (snap) => void: a restore point was kept
    this.toolsOn = !!tools && !!target;
    this.messages = [];          // the conversation: [{role, content}]
    this.onText = onText;        // (delta) => void
    this.onToolUse = onToolUse;  // (name, input, text, isError, value) => void
    this.onChange = null;        // () => void: busy, undo or tools changed (the page's panel)
    this.onTurnEnd = null;       // () => void: a turn has ended, however it ended (the Session's gateTools)
    this.onAbort = null;         // (reason) => void: abort() was called, before the request is aborted (the Session's gateTools)
    this.onToolStart = null;     // (name) => void: the backend calls a tool (serveTool), before it runs (the Session's gateTools)
    this.onToolEnd = null;       // (name) => void: that call has ended, however it ended
    // Each turn's line carries what the views show besides the text: `turn` (a number that stays the
    // turn's when older turns are trimmed away), `actions` (one record per acting call, js/claude/actions.js) and
    // `reads` ({ tool: count } for the read-only calls). apiMessages sends none of them.
    this.turns = 0;              // the last turn's number
    this.actionSeq = 0;          // the next action record's number (restore points remember it: Session.restoreClaude)
    this.line = null;            // the turn in progress: its line (the person's message)
    this.undo = [];              // snapshots of the target before Claude's changes, newest last (the last 10)
    this.snapped = false;        // this turn has its snapshot already
    this.busy = false;
    this.controller = null;
    this.error = null;
    this.lineBuf = '';
    if (this.channel) this.channel.onReceive = (bytes) => { if (bytes) this.receive(bytes); };
    this.backend.runTool = (name, input) => this.serveTool(name, input);
  }

  get tools() { return this.toolsOn ? machineTools() : []; }
  setTools(on) { this.toolsOn = !!on && !!this.target; this.changed(); }
  changed() { if (this.onChange) this.onChange(); }

  // bytes from the firmware: a complete line ends at CR (or LF); backspace takes back a character
  receive(bytes) {
    const s = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
    for (const ch of s) {
      if (ch === '\r' || ch === '\n') { const line = this.lineBuf.replace(/\s+$/, ''); this.lineBuf = ''; if (line.trim()) this.sendLine(line); }
      else if (ch === '\b') this.lineBuf = this.lineBuf.slice(0, -1);
      else this.lineBuf += ch;
    }
  }

  // one user line -> the backend -> the reply. Errors are recorded in this.error and said on the screen.
  async sendLine(text) {
    // a blank line asks nothing (the API would refuse it): no turn, and nothing recorded
    if (this.busy || typeof text !== 'string' || !text.trim()) return null;
    this.busy = true; this.error = null; this.snapped = false;
    this.controller = new AbortController(); this.abortReason = null;
    this.trim();
    const at = this.messages.length;             // where this turn starts in the conversation
    this.line = { role: 'user', content: text, turn: ++this.turns, actions: [], reads: {} };
    this.messages.push(this.line);
    this.changed();
    const used = [];             // the tools this turn called, in order
    try {
      const res = await this.backend.send({
        system: this.brief, messages: this.messages.slice(), tools: this.tools,
        onText: (t) => { this.emitText(t); }, onToolUse: (n, i, r, e, v) => { used.push(n); this.emitTool(n, i, r, e, v); },
        signal: this.controller.signal,
      });
      // The whole turn is recorded, not just its text: the person's line, each tool round as the API saw it (the
      // tool_use with its input, the tool_result exactly as sent) and the reply. A reply that says "I typed DIR"
      // then carries its evidence into every later request; with the text alone, Claude later finds its own claims
      // and nothing behind them. The views show only the line and the reply's text (transcript, js/claude/history.js).
      // A reply with no text is never recorded as an empty assistant message: the API would refuse every later
      // request of this chat (js/claude/history.js keeps the request valid in any case). A turn of tool calls only
      // ends with a note of what was used (a refusal after tool calls too); a refusal, or a reply of nothing, with no
      // tool calls drops the question, so it is not sent again inside every later one.
      const said = res.text && res.text.trim();
      const turn = res.messages.slice(at);
      if (res.lastText && res.lastText.trim()) turn.push({ role: 'assistant', content: res.lastText });
      // (worded as a note about the turn, not as something Claude said, and marked so the views do not show it)
      const note = !said && used.length ? { role: 'assistant', note: true, content: `(Note from the page, not a reply: in this turn Claude called ${[...new Set(used)].join(', ')} and wrote no text.)` } : null;
      if (said || used.length) this.record(at, turn, note);
      else this.messages.pop();
      if (!said && res.stopReason !== 'refusal' && !used.length) this.emitText('\r\n[Claude gave no reply.]\r\n');
      // the reply ends its line: the firmware draws a line when it ends (it wraps at word boundaries), so the
      // last line of a reply without a newline would wait unseen
      if (res.text && !/[\r\n]$/.test(res.text)) this.emitText('\r\n');
      // a refusal is not an error and it is not silent: the model declined, and the person is told why the
      // reply is empty (stop_reason "refusal" comes with no text blocks).
      if (res.stopReason === 'refusal') this.emitText('\r\n[Claude declined to answer this one.]\r\n');
      return res;
    } catch (e) {
      this.error = e;
      // A turn that failed after a tool ran changed the machine (or tried to): what ran stays in the conversation,
      // with a note from the page saying how the turn ended, so the next turn knows what was done. With no tool
      // result the unanswered line is dropped, as before.
      if (!this.keepFailed(at, e)) this.messages.pop();
      // a status line of its own, so what is typed next starts on a fresh line
      if (e && e.code === 'aborted') this.emitText(`\r\n[stopped${this.abortReason ? `: ${this.abortReason}` : ''}]\r\n`);
      else this.emitText(`\r\n[${e && e.message ? e.message : 'error'}]\r\n`);
      return null;
    } finally {
      this.busy = false; this.controller = null; this.line = null;
      // whatever the turn left behind that belongs to it alone (the Session's pause) ends with it
      if (this.onTurnEnd) this.onTurnEnd();
      // the turn has ended: the firmware lays out the last line and gives a fresh prompt (examples/chat.asm)
      if (this.channel) this.channel.send(Uint8Array.of(END_OF_REPLY));
      this.changed();
    }
  }
  // Replace the turn's line (at `at`) with the whole turn, checked the way every request is (wholeTurn: tool_use and
  // tool_result paired, nothing blank). A turn that does not check out is recorded as its line and its text only,
  // so a bad round can never wedge the chat. `note` (a page note) ends it. -> the turn's messages as recorded
  record(at, turn, note = null) {
    let list;
    try { list = wholeTurn(turn); } catch (e) {
      const text = turn.slice(1).filter((m) => m.role === 'assistant').map((m) => (typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join(''))).join('');
      list = [turn[0], ...(text.trim() ? [{ role: 'assistant', content: text }] : [])];
    }
    if (note) list.push(note);
    this.keepLine(list);
    this.messages.splice(at, this.messages.length - at, ...list);
    return list;
  }
  // the recorded turn's first message is a new object (wholeTurn): the line's turn number and records go with it
  keepLine(list) {
    if (this.line) for (const k of ['turn', 'actions', 'reads']) list[0][k] = this.line[k];
    this.line = list[0];
  }
  // A failed turn: kept when a tool result reached the conversation (e.partial, js/claude/backend.js), ending with
  // the page's note after those results, and marked `ended` so the views show it as the failed line they already
  // show. -> whether it was kept
  keepFailed(at, e) {
    const partial = e && Array.isArray(e.partial) ? e.partial.slice(at) : null;
    if (!partial || !partial.length) return false;
    let list;
    try { list = wholeTurn(partial); } catch (err) { return false; }
    const last = list[list.length - 1];
    if (!list.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')) || last.role !== 'user') return false;
    const code = (e && e.code) || 'error';
    // (with why the page stopped it, when it did: "aborted (you reset the machine)")
    const why = code === 'aborted' && this.abortReason ? ` (${this.abortReason})` : '';
    last.content = [...last.content, { type: 'text', text: `(Note from the page: this turn ended with ${code}${why} after these tool results.)` }];
    list[0].ended = code;
    this.keepLine(list);
    this.messages.splice(at, this.messages.length - at, ...list);
    return true;
  }
  // BREAK aborts the request in flight (a new AbortController per call); reason, when the page stopped it (a
  // Reset), goes into the status line: "[stopped: you reset the machine]"
  // onAbort runs first, whether or not a request is in flight
  abort(reason = null) {
    if (this.onAbort) this.onAbort(reason);
    if (this.controller) { this.abortReason = reason; this.controller.abort(); }
  }
  // drop the oldest turns when the conversation nears 64 KiB: whole turns (a person's line up to the next), so a
  // tool_use never loses its tool_result; the newest turn always stays
  trim(limit = 64 * 1024) {
    while (JSON.stringify(this.messages).length > limit) {
      const next = this.messages.findIndex((m, i) => i > 0 && opensTurn(m));
      if (next < 0) break;
      this.messages.splice(0, next);
    }
  }
  reset() { this.messages = []; this.error = null; this.changed(); }

  // A frame hook for the chat firmware, called after each frame of the chat machine (Session.pumpChat).
  //   RX ($7000/$7001): bytes toward the firmware. IN-status bit 7 set = a byte waits in IN-data; the
  //                     firmware reads it and clears the bit (an acknowledge).
  //   TX ($7002/$7003): bytes from the firmware. OUT-status bit 7 set = the firmware wrote a byte in
  //                     OUT-data; the page takes it and clears the bit.
  // The mailbox is read and written at CPU addresses (peek/poke), so a machine with an MMU (the CoCo 3) works too.
  // A DriveWire channel needs no pump: the firmware talks to the server itself, over the Becker port.
  pump(machine) {
    if (!this.channel || !machine || typeof this.channel.poll !== 'function') return;
    const rx = CHAT_CHANNEL.rx, tx = CHAT_CHANNEL.tx;
    const rd = (a) => (typeof machine.peek === 'function' ? machine.peek(a) : machine.ram[a]);
    if (!(rd(rx) & 0x80)) {
      const b = this.channel.poll();
      if (b != null) { machine.poke(rx + 1, b); machine.poke(rx, 0x80); }
    }
    if (rd(tx) & 0x80) {
      const b = rd(tx + 1);
      machine.poke(tx, 0);                          // the page acknowledges
      this.channel.fromMachine(Uint8Array.of(b));   // firmware -> backend
    }
  }

  emitText(t) { if (this.onText) this.onText(t); if (this.channel) this.channel.send(new TextEncoder().encode(t)); }
  emitTool(name, input, result, isError, value) {
    if (this.onToolUse) this.onToolUse(name, input, result, isError, value);
    if (this.channel) this.channel.send(new TextEncoder().encode(`[${name}${isError ? ' failed' : ''}]\r\n`));
  }

  // ---------------- the machine tools ----------------
  // They act on the target (the BASIC session). Tools are off for this chat (the person has not turned them on, or
  // there is no target machine): the model is told with the no-consent CODE, not a bare sentence.
  // An acting tool runs one way only: the consent gate (this.gate: Session.gateTools sets it; a bare ChatSession's
  // refuses), then its check (refusals, nothing changed), then the pre-act re-check (Stop, a pause, consent
  // withdrawn: this.recheck), then its act inside withRestorePoint. Every failure leaves as a ToolError (asToolError), never as a raw exception.
  // every call the backend makes: onToolStart and onToolEnd bracket it (the page's "Using type_text…"), runTool does it
  async serveTool(name, input) {
    if (this.onToolStart) this.onToolStart(name);
    try { return await this.runTool(name, input); } finally { if (this.onToolEnd) this.onToolEnd(name); }
  }
  async runTool(name, input) {
    try {
      const out = await this.callTool(name, input);
      this.noteAction(name, input, { result: out });
      return out;
    } catch (e) { this.noteAction(name, input, { err: e }); throw e; }
  }
  // A call's record on the turn in progress: an acting call's outcome from what it returned or threw (never
  // guessed: js/claude/actions.js), a read-only call counted. Nothing for a call outside a turn or an unknown tool.
  noteAction(name, input, how) {
    const line = this.line;
    if (!line) return;
    if (Object.hasOwn(ACTING, name)) { line.actions.push(actionRecord(name, input || {}, { ...how, seq: this.actionSeq++, time: Date.now() })); this.changed(); return; }
    if (!readKind(name)) return;
    // a read that worked is counted; one that failed is a line of its own (the person sees why it could not read)
    if (how.err) line.actions.push(actionRecord(name, input || {}, { ...how, seq: this.actionSeq++, time: Date.now() }));
    else line.reads[name] = (line.reads[name] || 0) + 1;
    this.changed();
  }
  // After a restore to the point taken before action `fromSeq`: the records it took back are marked undone (`at`, the
  // restore's time), the ones that changed something: done, partial, and a stop or keys not read after some keys went
  // in (delivered). A call that changed nothing (declined, an error, nothing typed) is not marked.
  markUndone(fromSeq, at = Date.now()) {
    for (const m of this.messages) {
      for (const rec of (m && m.actions) || []) {
        const changed = rec.outcome === 'done' || rec.outcome === 'partial' || (['stopped', 'not-read', 'restarted', 'debugger-stopped'].includes(rec.outcome) && rec.delivered > 0);
        if (rec.seq >= fromSeq && !rec.undoneAt && changed) rec.undoneAt = at;
      }
    }
    this.changed();
  }
  async callTool(name, input) {
    const t = this.target;
    if (!t || !this.toolsOn) throw new ToolError(TOOL_CODES.NO_CONSENT);
    input = input || {};
    // dispatch on the declared read-only set, so this file does not keep a second copy of those names
    if (READ_ONLY_TOOLS.includes(name)) return runReadOnlyTool(t, name, input);
    const tool = Object.hasOwn(ACTING, name) ? ACTING[name] : null;
    if (!tool) throw new ToolError(TOOL_CODES.UNKNOWN_TOOL, name);
    try {
      // a turn already stopped (an earlier call in this response was stopped) asks nobody and changes nothing
      if (this.controller && this.controller.signal.aborted) throw new ToolError(TOOL_CODES.STOPPED);
      // a machine the Debugger has stopped: refused before anyone is asked (no card for what cannot happen)
      const stopped = stoppedRefusal(t, name);
      if (stopped) throw stopped;
      // awaited only when they return a promise: with nothing to ask or read, the restore point below is the
      // machine at the call itself, with no frame run in between
      // `call` is this call's own record between the gate and the re-check (which consent it relied on)
      const call = {};
      const asked = this.gate(name, input, call);
      if (asked && typeof asked.then === 'function') await asked;
      let plan = tool.check(this, t, input);
      if (plan && typeof plan.then === 'function') plan = await plan;
      // the person may have pressed Stop, paused Claude or withdrawn consent while being asked or while the check
      // ran: the last test before the change is synchronous with it, and a pause waits here (then tests again)
      for (;;) {
        if (this.controller && this.controller.signal.aborted) throw new ToolError(TOOL_CODES.STOPPED);
        // (and again here, synchronous with the change: the Debugger may have stopped it while the card waited)
        const now = stoppedRefusal(t, name);
        if (now) throw now;
        const wait = this.recheck(name, input, call);
        if (!wait || typeof wait.then !== 'function') break;
        await wait;
      }
      return await this.withRestorePoint(() => tool.act(this, t, plan));
    } catch (e) { throw asToolError(e); }
  }

  // The turn's restore point around a change: taken before Claude's first change in a turn (the last 10 are kept)
  // and kept once the change is made, or when it fails part-way (typing that stopped has still typed). A failure
  // marked `unchanged` (nothing landed) keeps none.
  // The snapshot is taken before the act and kept as soon as the act has returned - for typing, once the typing has
  // started and before any frame runs, so the point is there (and Restore works) while the keys are still going in.
  // An act that throws at once keeps it unless it is marked `unchanged` (nothing landed).
  async withRestorePoint(act) {
    const snap = this.captureSnapshot();
    let pending;
    try { pending = act(); } catch (e) { if (!(e && e.unchanged)) this.commitSnapshot(snap); throw e; }
    this.commitSnapshot(snap);
    return await pending;
  }

  // The keyboard tools (type_text, press_break, run "RUN"): a paced job (Typist.typePaced / holdPaced) waited for, and
  // the result says what the machine took, not what was asked: {requested, consumed, lines_requested,
  // lines_delivered} (press_break: {requested, consumed}). When the machine stops reading the keyboard the rest is
  // not typed and the call fails not-consumed, saying how far it got. { read: true }: every key was read down at
  // least once is success, even if the machine then stopped reading the keyboard (BREAK, or the Enter of RUN, ends
  // what was reading it: a program halted, or a program started that never scans the keyboard).
  async keys(t, job, { read = false } = {}) {
    // Stop (the abort signal) ends the typing too: what is not typed yet is dropped, and the call says stopped
    const signal = this.controller && this.controller.signal;
    const onAbort = () => { t.machine.typist.dropJob(job); job.end('stopped'); };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    // a Debugger stop ends it too: the keys not typed yet are dropped, not left to go in after Resume
    const off = t.onStopped ? t.onStopped(() => { t.machine.typist.dropJob(job); job.end('machine-stopped'); }) : null;
    await job.promise;
    if (signal) signal.removeEventListener('abort', onAbort);
    if (off) off();
    const report = job.key ? { requested: job.requested, consumed: job.consumed }
      : { requested: job.requested, consumed: job.consumed, lines_requested: job.linesRequested, lines_delivered: job.linesDelivered };
    if (job.status === 'done' || (read && job.status === 'not-consumed' && job.consumed === job.requested)) return report;
    // (delivered: how many keys went in before the stop, so the page can tell "stopped before" from "while")
    if (job.status === 'stopped') throw Object.assign(new ToolError(TOOL_CODES.STOPPED, `${job.consumed} of ${job.requested} keys typed`), { delivered: job.consumed, requested: job.requested });
    // the machine reset under the typing (Machine.reset): not a Stop, so the model is not told the person stopped it
    if (job.status === 'machine-restarted') throw Object.assign(new ToolError(TOOL_CODES.MACHINE_RESTARTED, `${job.consumed} of ${job.requested} keys typed`), { delivered: job.consumed });
    // the Debugger stopped the machine while the keys went in: the rest was dropped (delivered: how many went in)
    if (job.status === 'machine-stopped') {
      const at = t.stopped ? t.stopped() : null;
      throw Object.assign(new ToolError(TOOL_CODES.MACHINE_STOPPED, `${at ? `stopped in the Debugger at ${hex(at.pc)} (${at.kind})` : 'stopped in the Debugger'} while the keys went in: ${job.consumed} of ${job.requested} keys typed, the rest dropped`), { delivered: job.consumed });
    }
    // the person turned the switch off while the typing was held by a pause: the rest was dropped
    if (job.status === 'no-consent') throw new ToolError(TOOL_CODES.NO_CONSENT, `${job.consumed} of ${job.requested} keys typed`);
    const at = job.at;
    const ch = at.char === '\r' ? 'Enter' : job.key ? job.key : JSON.stringify(at.char);
    const why = at.phase === 'resume' ? `the machine did not read the keyboard again after line ${job.linesDelivered}`
      : at.phase === 'release' ? `the machine stopped reading the keyboard after key ${at.index + 1} (${ch})` : `key ${at.index + 1} (${ch}) was not read by the machine`;
    throw Object.assign(new ToolError(TOOL_CODES.NOT_CONSUMED, `${why} within ${PACE.timeoutFrames} frames; ${JSON.stringify(report)}`), { delivered: job.consumed });
  }

  // assemble_and_load's check: assemble for the target's own CPU, without writing anything. -> the assembler's result
  async assemble(t, input) {
    const m = t.machine;
    if (typeof input.source !== 'string' || !input.source.trim()) throw new ToolError(TOOL_CODES.EMPTY, 'source');
    if (input.source.length > SOURCE_MAX) throw new ToolError(TOOL_CODES.TOO_LARGE, `${input.source.length} characters, at most ${SOURCE_MAX}`);
    const org = input.org == null ? null : checkedInt(input.org, { min: ADDRESS_MIN, max: ADDRESS_MAX, code: TOOL_CODES.BAD_ADDRESS });
    // `org` is a leading ORG line, so errors are renumbered below to the source Claude wrote
    const prepended = org != null;
    const text = prepended ? ` ORG ${hex(org)}\n${input.source}` : input.source;
    // The assembler is synchronous and has no file system, so INCLUDE texts are gathered first by the injected
    // reader (the page reads examples/; a Node test passes a map). With no reader an INCLUDE is an assembler
    // error; nothing is fetched by the tool itself. The reader gets the turn's signal, and the wait races it too, so
    // Stop ends the call even while a read hangs (a reader that ignores the signal included); a read that fails
    // with a code (the page's reader: 'timeout') fails the call with include-unreadable rather than reading as a
    // missing file.
    const include = this.include ? await this.readIncludes(text) : null;
    // the person may have stopped Claude, or the chat may have moved, while INCLUDEs were being read
    if (t.machine !== m || (this.controller && this.controller.signal.aborted)) throw new ToolError(TOOL_CODES.STOPPED, 'changed while assembling');
    const res = assemble(text, m.config.cpu, include ? { include } : {});
    if (!res.ok) {
      const shown = prepended ? res.errors.map((e) => (e.file || !e.line ? e : { ...e, line: e.line - 1 })) : res.errors;
      const lines = shown.slice(0, 8).map((e) => `${describeError(e)}${e.src ? ` | ${String(e.src).trim()}` : ''}`);
      throw new ToolError(TOOL_CODES.ASSEMBLY_FAILED, `${shown.length} error(s): ${lines.join('; ')}${shown.length > 8 ? '; ...' : ''}`.slice(0, 900));
    }
    if (org != null && res.segments.length && res.segments[0].addr !== org) throw new ToolError(TOOL_CODES.ORG_CONFLICT, `assembled at ${res.segments[0].addr}, org is ${org}`);
    if (!res.segments.length) throw new ToolError(TOOL_CODES.EMPTY, 'the source assembled to no bytes');
    if (res.segments.some((sg) => sg.addr + sg.data.length > ADDRESS_MAX + 1)) throw new ToolError(TOOL_CODES.PAST_END, 'the program runs past $FFFF; nothing was written');
    return res;
  }
  async readIncludes(text) {
    const signal = this.controller ? this.controller.signal : null;
    const stopped = () => new ToolError(TOOL_CODES.STOPPED, 'while reading INCLUDE files');
    if (signal && signal.aborted) throw stopped();
    let failed = null;
    const read = async (name) => {
      // once one read has failed with a code (a server not answering), the rest are not waited for one by one
      if (failed) return null;
      try { return await this.include(name, { signal }); } catch (e) {
        if (e && typeof e.code === 'string' && e.code !== 'aborted' && !failed) failed = { name, e };
        throw e;
      }
    };
    let onAbort = null;
    const aborted = new Promise((resolve, reject) => { onAbort = () => reject(stopped()); if (signal) signal.addEventListener('abort', onAbort, { once: true }); });
    aborted.catch(() => {});
    try {
      const include = await Promise.race([loadIncludes(text, read), aborted]);
      if (signal && signal.aborted) throw stopped();
      if (failed) throw new ToolError(TOOL_CODES.INCLUDE_UNREADABLE, `${failed.name}: ${failed.e.message || failed.e.code}`);
      return include;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  // withRestorePoint's halves: capture (null when this turn already has its restore point), then commit. onRestorePoint(snap) hears of each one kept (the Session stamps its time).
  captureSnapshot() { return this.snapped ? null : this.target.snapshot(); }
  commitSnapshot(snap) {
    if (!snap) return;
    this.snapped = true;
    this.undo.push(snap);
    while (this.undo.length > 10) this.undo.shift();
    if (this.onRestorePoint) this.onRestorePoint(snap);
    this.changed();
  }
  // Did bytes written at `addr` arrive? [] when they did, else [{from,to,why}] for the ones that did not. Two
  // checks, because neither alone is enough: the machine's own map (writeKind) names ROM, I/O and absent RAM,
  // which a read-back cannot tell from success when the byte written is the one already there ($FF in an
  // unhandled register, or the byte a ROM holds); and a read back through the CPU view catches a write lost
  // inside writable RAM. Consecutive bytes with the same reason are one range.
  notTaken(addr, data) {
    const t = this.target;
    const bad = [];
    for (let i = 0; i < data.length; i++) {
      const a = addr + i;
      const why = t.writeKind(a);
      if (why) bad.push({ a, why });
      else if (t.readByte(a) !== (data[i] & 0xFF)) bad.push({ a, why: 'lost' });
    }
    const out = [];
    for (let start = 0; start < bad.length;) {
      let end = start;
      while (end + 1 < bad.length && bad[end + 1].a === bad[end].a + 1 && bad[end + 1].why === bad[start].why) end++;
      out.push({ from: bad[start].a, to: bad[end].a, why: bad[start].why });
      start = end + 1;
    }
    return out;
  }
  // "Restore to before Claude's changes\": the BASIC session as it was before the newest turn's changes, on screen
  undoLast() {
    if (!this.undo.length) return false;
    this.target.restore(this.undo[this.undo.length - 1]);   // the Session's guarded path (restorePoint); a restore that throws keeps the point
    this.undo.pop();
    this.target.show();
    this.changed();
    return true;
  }
}
