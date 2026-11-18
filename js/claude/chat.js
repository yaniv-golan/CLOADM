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
import { READ_ONLY_TOOLS, readOnlyTools, runReadOnlyTool } from './readtools.js';
import { TOOL_CODES, ToolError, checkedInt } from './toolerrors.js';
import { PACE } from '../machines/typist.js';
import { BASIC_LINE_MAX } from '../media/basic.js';
import { BASIC_PROGRAM_TEXT_MAX, planBasic, writeBasic } from './basicload.js';

// An acting tool's failure that changed nothing (no byte landed): withRestorePoint keeps no restore point for it
const unchanged = (err) => Object.assign(err, { unchanged: true });

// The acting tools' API schemas: the ones that change the BASIC session. They need "Let Claude use the
// machine", and the Session's consent gate (gateTools) is what asks - this list only describes them. The
// read-only tools are the other half, in js/claude/readtools.js; together the two name every tool.
export const TYPE_TEXT_MAX = 65536;      // characters one type_text may type (a long BASIC listing is legitimate)
export const POKE_MAX = 256;             // bytes one poke may write
export const SOURCE_MAX = 32768;         // characters of assembler source one assemble_and_load takes
// How Claude puts a BASIC program in (the owner's policy): typing is for short programs, and a longer one is
// loaded only after the person agrees. Stated in the tool descriptions and in the brief (js/claude/brief.js), and
// tests/claude-typing.test.js checks both say it.
export const TYPE_LINES_MAX = 3;
export const TYPING_POLICY = `Policy: type a BASIC program with type_text only when it has ${TYPE_LINES_MAX} lines or fewer; for a longer program, ask the person whether to load it with load_basic instead of typing it, and call load_basic only after they agree. After either, verify before you say it worked: type LIST and read the screen with screen_text, and compare with the program you meant.`;
const CONSENT = ' Needs "Let Claude use the machine": the person is asked the first time; if they decline you get the error no-consent or consent-declined and nothing changes.';
// load_basic is not behind that question: it has its own card on every call (js/session.js gateTools)
const LOAD_CONSENT = ' The person is asked on every call, whether or not "Let Claude use the machine" is on, unless they ticked "Don\'t ask again this session" (offered only while that switch is on; turning it off asks again); if they decline you get the error load-declined, if there is nobody to ask no-consent, and if they press Stop stopped; nothing changes.';
export function actingTools() {
  const schema = (props, required) => ({ type: 'object', properties: props, required });
  const int = (description) => ({ type: 'integer', description });
  return [
    {
      name: 'poke',
      description: 'Write bytes of memory through the machine\'s map: RAM takes them; ROM, I/O and absent RAM do not and are listed in not_taken. Returns {address,length,not_taken}.' + CONSENT,
      input_schema: schema({
        address: int('Decimal integer 0-65535 of the first byte.'),
        bytes: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 255 }, minItems: 1, maxItems: POKE_MAX, description: `Decimal byte values 0-255, at most ${POKE_MAX}.` },
      }, ['address', 'bytes']),
    },
    {
      name: 'type_text',
      description: `Type text at the BASIC session's keyboard as if typed (\\n presses Enter), at most ${TYPE_TEXT_MAX} characters. Each key is held until the machine has read it, and the next line waits until the machine is reading the keyboard again, so a busy BASIC drops nothing. Returns {requested,consumed,lines_requested,lines_delivered}: keys and Enters the machine actually read. If it stops reading the keyboard the rest is not typed and the error is not-consumed, with how far it got. ${TYPING_POLICY}` + CONSENT,
      input_schema: schema({ text: { type: 'string', minLength: 1, maxLength: TYPE_TEXT_MAX } }, ['text']),
    },
    {
      name: 'load_basic',
      description: `Load a BASIC program straight into the BASIC session's program memory, as loading it from tape or disk would: no typing. The text is tokenized for this machine's BASIC (Dragon, Color/Extended BASIC on a CoCo, Micro Color BASIC on an MC-10) and replaces the program in memory (like NEW, then the lines). One line per program line, each starting with its line number (0-${BASIC_LINE_MAX}), at most ${BASIC_PROGRAM_TEXT_MAX} characters in all. Needs the BASIC prompt (not the no-ROM stub, not a running program). Returns {lines,bytes,start,end}: the lines stored and the program's first and last byte addresses (decimal). Only characters $20-$7E. Errors: bad-line-number, line-too-long, not-typable, no-basic, not-at-prompt, program-too-large, unknown-machine; nothing is changed by a failed call. ${TYPING_POLICY}` + LOAD_CONSENT,
      input_schema: schema({ program: { type: 'string', minLength: 1, maxLength: BASIC_PROGRAM_TEXT_MAX, description: 'The program listing: numbered lines separated by \\n.' } }, ['program']),
    },
    {
      name: 'press_break',
      description: 'Press BREAK on the BASIC session. Returns {pressed:true}.' + CONSENT,
      input_schema: schema({}, []),
    },
    {
      name: 'assemble_and_load',
      description: "Assemble source for the BASIC session's own CPU and write it into memory; does not start it (use run). `org` is the load address as a decimal integer 0-65535; omit it if the source has its own ORG. Returns {bytes,ranges:[{from,to}],start,symbols:{NAME:address},not_taken:[{from,to,why}]} with every address a decimal integer; not_taken lists bytes that did not land (why: rom, io, latch, undecoded, absent-ram, lost). A failed assembly is the error assembly-failed with the line numbers of your source; nothing is written." + CONSENT,
      input_schema: schema({
        source: { type: 'string', minLength: 1, maxLength: SOURCE_MAX, description: 'Assembler source text.' },
        org: int('Load address, decimal 0-65535.'),
      }, ['source']),
    },
    {
      name: 'run',
      description: 'Start the code in memory. `target` is an address to jump to: a decimal integer 0-65535, or text in hex ("$3000", "0x3000", "3000"); or the text "RUN" (also the default) to type RUN so BASIC runs its program, which needs the BASIC ROMs (error no-basic without them). Returns {started, how:"jump"|"typed", target}.' + CONSENT,
      input_schema: schema({ target: { type: ['integer', 'string'], description: 'Address (decimal integer, or hex text) or "RUN".' } }, []),
    },
  ];
}

// Every tool this build offers: the read-only ones first, then the acting ones.
export function machineTools() { return [...readOnlyTools(), ...actingTools()]; }

// The acting tools' names, derived from the schemas above rather than typed out again, so a tool added to
// actingTools() is gated by the Session without a second list to remember. Session's consent gate
// (gateTools) and ui/claude.js's picture-in-picture rule both use this.
export const ACTING_TOOL_NAMES = Object.freeze(actingTools().map((t) => t.name));

// The chat firmware's channel mailbox (examples/chat.asm): two status/data pairs, one each way.
export const CHAT_CHANNEL = Object.freeze({ rx: 0x7000, tx: 0x7002 });
// Two of the firmware's variables, read by the page to tell whether BREAK would do anything (Esc on an empty, idle
// prompt leaves the chat instead): BLEN, the characters on the typed line, and WAIT, set from ENTER until the reply
// ends. tests/chat-firmware.test.js ties these addresses to the assembled source.
export const CHAT_STATE = Object.freeze({ blen: 0x6013, wait: 0x6037 });
// The chat firmware's screen (examples/chat.asm, COLS and ROWS): 42 columns of the 6x8 font in 256x192 graphics,
// 24 rows, on every machine (there is no 80-column CoCo 3 mode yet). tests/chat-firmware.test.js ties these to
// the source, so the brief can't tell Claude a width the screen doesn't have.
export const CHAT_SCREEN = Object.freeze({ cols: 42, rows: 24 });
// The byte that ends every turn toward the firmware (a reply, an error, a refusal or a stop): until it comes, the
// firmware takes no typing, so a line typed early can't land in the middle of a reply.
export const END_OF_REPLY = 0x04;

export class ChatSession {
  // deps: { backend, channel, brief, tools (bool), target (the BASIC session), onText, onToolUse,
  //         include (name => text | null: the page's INCLUDE reader for assemble_and_load; none = no INCLUDE) }
  constructor({ backend, channel = null, brief = '', tools = true, target = null, onText = null, onToolUse = null, include = null } = {}) {
    if (!backend) throw new Error('ChatSession needs a backend');
    this.backend = backend;
    this.channel = channel;
    this.brief = brief;
    this.target = target;
    this.include = include;
    this.toolsOn = !!tools && !!target;
    this.messages = [];          // the conversation: [{role, content}]
    this.onText = onText;        // (delta) => void
    this.onToolUse = onToolUse;  // (name, input, text, isError, value) => void
    this.onChange = null;        // () => void: busy, undo or tools changed (the page's panel)
    this.undo = [];              // snapshots of the target before Claude's changes, newest last (the last 10)
    this.snapped = false;        // this turn has its snapshot already
    this.busy = false;
    this.controller = null;
    this.error = null;
    this.lineBuf = '';
    if (this.channel) this.channel.onReceive = (bytes) => { if (bytes) this.receive(bytes); };
    this.backend.runTool = (name, input) => this.runTool(name, input);
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
    if (this.busy) return null;
    this.busy = true; this.error = null; this.snapped = false;
    this.controller = new AbortController();
    this.trim();
    this.messages.push({ role: 'user', content: text });
    this.changed();
    try {
      const res = await this.backend.send({
        system: this.brief, messages: this.messages.slice(), tools: this.tools,
        onText: (t) => { this.emitText(t); }, onToolUse: (n, i, r, e, v) => this.emitTool(n, i, r, e, v),
        signal: this.controller.signal,
      });
      this.messages.push({ role: 'assistant', content: res.text });
      // the reply ends its line: the firmware draws a line when it ends (it wraps at word boundaries), so the
      // last line of a reply without a newline would wait unseen
      if (res.text && !/[\r\n]$/.test(res.text)) this.emitText('\r\n');
      // a refusal is not an error and it is not silent: the model declined, and the person is told why the
      // reply is empty (stop_reason "refusal" comes with no text blocks).
      if (res.stopReason === 'refusal') this.emitText('\r\n[Claude declined to answer this one.]\r\n');
      return res;
    } catch (e) {
      this.error = e;
      this.messages.pop();                       // drop the unanswered user turn
      // a status line of its own, so what is typed next starts on a fresh line
      if (e && e.code === 'aborted') this.emitText('\r\n[stopped]\r\n');
      else this.emitText(`\r\n[${e && e.message ? e.message : 'error'}]\r\n`);
      return null;
    } finally {
      this.busy = false; this.controller = null;
      // the turn has ended: the firmware lays out the last line and gives a fresh prompt (examples/chat.asm)
      if (this.channel) this.channel.send(Uint8Array.of(END_OF_REPLY));
      this.changed();
    }
  }
  // BREAK aborts the request in flight (a new AbortController per call)
  abort() { if (this.controller) this.controller.abort(); }
  // drop the oldest turns when the conversation nears 64 KiB
  trim(limit = 64 * 1024) {
    let size = JSON.stringify(this.messages).length;
    while (size > limit && this.messages.length > 2) { this.messages.shift(); size = JSON.stringify(this.messages).length; }
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
  // They act on the target (the BASIC session); a change takes the turn's snapshot first so Undo can restore it.
  // Tools are off for this chat (the person has not turned them on, or there is no target machine): the model
  // is told with the no-consent CODE, not a bare sentence, so it can act on it like any other coded failure.
  async runTool(name, input) {
    const t = this.target;
    if (!t || !this.toolsOn) throw new ToolError(TOOL_CODES.NO_CONSENT);
    input = input || {};
    // dispatch on the declared read-only set, so this file does not keep a second copy of those names
    if (READ_ONLY_TOOLS.includes(name)) return runReadOnlyTool(t, name, input);
    if (!ACTING_TOOL_NAMES.includes(name)) throw new ToolError(TOOL_CODES.UNKNOWN_TOOL, name);
    // every acting tool: checked first (nothing changes), then its change runs through the one restore-point path
    // (awaited only when the checks are asynchronous, assemble_and_load's INCLUDEs: otherwise the point is taken in
    // the same step as the call, with no frame run in between)
    const act = this.prepareAction(t, name, input);
    return this.withRestorePoint(act instanceof Promise ? await act : act);
  }
  // The one path every acting tool's change takes: the turn's restore point is captured before act() runs and kept
  // once it has run, also when it fails part way (typing that stopped, a program that did not read back). Only a
  // failure marked `unchanged` (nothing landed) keeps no point, so it neither adds a useless one nor pushes a
  // real one out of the last 10. act() runs synchronously; what it returns (a value or a promise) is the result.
  withRestorePoint(act) {
    const snap = this.captureSnapshot();
    let out;
    try { out = act(); } catch (e) {
      if (!(e && e.unchanged)) this.commitSnapshot(snap);
      throw e;
    }
    this.commitSnapshot(snap);
    return out;
  }
  // An acting tool's checks, which change nothing and may refuse; -> act, the change itself (for withRestorePoint),
  // or a promise of it. A tool in ACTING_TOOL_NAMES with no case here is refused as unknown: it can never act
  // without the restore point.
  prepareAction(t, name, input) {
    switch (name) {
      case 'poke': {
        const address = checkedInt(input.address, { min: 0, max: 0xFFFF, code: TOOL_CODES.BAD_ADDRESS });
        const bytes = input.bytes;
        if (!Array.isArray(bytes) || !bytes.length) throw new ToolError(TOOL_CODES.EMPTY, 'bytes');
        if (bytes.length > POKE_MAX) throw new ToolError(TOOL_CODES.TOO_LARGE, `${bytes.length} bytes, at most ${POKE_MAX}`);
        for (const b of bytes) checkedInt(b, { min: 0, max: 255, code: TOOL_CODES.BAD_BYTE });
        if (address + bytes.length - 1 > 0xFFFF) throw new ToolError(TOOL_CODES.PAST_END, `${address}+${bytes.length}`);
        return () => {
          const written = t.pokeBytes(address, bytes);       // how many landed, as the machine says
          if (written === 0) throw unchanged(new ToolError(TOOL_CODES.NOT_RAM, `$${address.toString(16).toUpperCase()}`));
          return { address, length: bytes.length, written, skipped: bytes.length - written, not_taken: this.notTaken(address, bytes) };
        };
      }
      case 'type_text': return this.prepareTyping(t, input);
      case 'load_basic': {
        // the same implementation as Session.loadBasic (js/claude/basicload.js); everything that can fail before
        // writing is checked here, so a refused load changes nothing
        const plan = planBasic(t, input.program);
        return () => { t.show(); return writeBasic(t, plan); };
      }
      case 'press_break':
        return () => { t.show(); t.pressBreak(); return { pressed: true }; };
      case 'assemble_and_load': return this.prepareAssembly(t, input);
      case 'run': {
        // validated here: a run that throws changes nothing and must not evict a real restore point
        const raw = input.target == null ? 'RUN' : input.target;
        const parsed = t.checkRun(raw);
        return () => {
          t.show();
          t.run(raw);
          return parsed == null ? { started: true, how: 'typed', target: 'RUN' } : { started: true, how: 'jump', target: parsed };
        };
      }
      default: throw new ToolError(TOOL_CODES.UNKNOWN_TOOL, name);
    }
  }

  // type_text: typed at the keyboard paced by what the machine consumes (Typist.typePaced), and the result says
  // what the machine took, not what was asked: {requested, consumed, lines_requested, lines_delivered}. When the
  // machine stops reading the keyboard the rest is not typed and the call fails not-consumed, saying how far it got.
  prepareTyping(t, input) {
    if (typeof input.text !== 'string') throw new ToolError(TOOL_CODES.EMPTY, 'text');
    const text = input.text;
    if (!text) throw new ToolError(TOOL_CODES.EMPTY, 'text');
    if (text.length > TYPE_TEXT_MAX) throw new ToolError(TOOL_CODES.TOO_LARGE, `${text.length} characters, at most ${TYPE_TEXT_MAX}`);
    const bad = t.untypable(text);
    if (bad.length) throw new ToolError(TOOL_CODES.NOT_TYPABLE, JSON.stringify(bad.join('')));
    return () => { t.show(); return this.awaitTyping(t, t.typeText(text)); };
  }
  async awaitTyping(t, job) {
    // Stop (the abort signal) ends the typing too: what is not typed yet is dropped, and the call says stopped
    const signal = this.controller && this.controller.signal;
    const onAbort = () => { t.machine.typist.dropJob(job); job.end('stopped'); };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    await job.promise;
    if (signal) signal.removeEventListener('abort', onAbort);
    const report = { requested: job.requested, consumed: job.consumed, lines_requested: job.linesRequested, lines_delivered: job.linesDelivered };
    if (job.status === 'done') return report;
    if (job.status === 'stopped') throw new ToolError(TOOL_CODES.STOPPED, `${job.consumed} of ${job.requested} keys typed`);
    const at = job.at;
    const ch = at.char === '\r' ? 'Enter' : JSON.stringify(at.char);
    const why = at.phase === 'resume' ? `the machine did not read the keyboard again after line ${job.linesDelivered}`
      : at.phase === 'release' ? `the machine stopped reading the keyboard after key ${at.index + 1} (${ch})` : `key ${at.index + 1} (${ch}) was not read by the machine`;
    throw new ToolError(TOOL_CODES.NOT_CONSUMED, `${why} within ${PACE.timeoutFrames} frames; ${JSON.stringify(report)}`);
  }

  // assemble_and_load: assemble for the target's own CPU and write the bytes, without starting anything.
  async prepareAssembly(t, input) {
    const m = t.machine;
    if (typeof input.source !== 'string' || !input.source.trim()) throw new ToolError(TOOL_CODES.EMPTY, 'source');
    if (input.source.length > SOURCE_MAX) throw new ToolError(TOOL_CODES.TOO_LARGE, `${input.source.length} characters, at most ${SOURCE_MAX}`);
    const org = input.org == null ? null : checkedInt(input.org, { min: 0, max: 0xFFFF, code: TOOL_CODES.BAD_ADDRESS });
    // `org` is a leading ORG line, so errors are renumbered below to the source Claude wrote
    const prepended = org != null;
    const text = prepended ? ` ORG ${hex(org)}\n${input.source}` : input.source;
    // The assembler is synchronous and has no file system, so INCLUDE texts are gathered first by the injected
    // reader (the page reads examples/; a Node test passes a map). With no reader an INCLUDE is an assembler
    // error; nothing is fetched by the tool itself.
    const include = this.include ? await loadIncludes(text, (name) => this.include(name)) : null;
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
    if (res.segments.some((sg) => sg.addr + sg.data.length > 0x10000)) throw new ToolError(TOOL_CODES.PAST_END, 'the program runs past $FFFF; nothing was written');
    return () => this.loadAssembled(t, res);
  }
  loadAssembled(t, res) {
    const written = t.writeSegments(res);       // writes only (no reset: a ROM-less machine would lose its RAM; no jump); how many landed
    const total = res.segments.reduce((n, sg) => n + sg.data.length, 0);
    if (written === 0) {
      const last = res.segments[res.segments.length - 1];
      throw unchanged(new ToolError(TOOL_CODES.NOT_RAM, `${hex(res.segments[0].addr)}-${hex(last.addr + last.data.length - 1)}`));
    }
    // every segment is read back: a program aimed at ROM or I/O assembles and then is not there
    const not_taken = res.segments.flatMap((sg) => this.notTaken(sg.addr, sg.data));
    return {
      bytes: total, written, skipped: total - written,
      ranges: res.segments.map((sg) => ({ from: sg.addr, to: sg.addr + sg.data.length - 1 })),
      start: res.exec,
      symbols: Object.fromEntries([...res.symbols].sort((a, b) => a[1] - b[1])),
      not_taken,
    };
  }
  // The restore point's two halves (withRestorePoint is their only caller): capture before the change (null when
  // this turn already has its restore point), commit once it is made; the last 10 are kept.
  captureSnapshot() { return this.snapped ? null : this.target.snapshot(); }
  commitSnapshot(snap) {
    if (!snap) return;
    this.snapped = true;
    this.undo.push(snap);
    while (this.undo.length > 10) this.undo.shift();
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
