/*
 * The machine tools' error codes, shared by the read-only tools (js/claude/readtools.js)
 * and the acting tools (js/claude/chat.js).
 *
 * The tools are used by a model, not a person. A model can act on a code and a remedy, but not on a stack
 * trace or a sentence, so every failure carries a stable code and an instruction:
 *
 *   throw new ToolError(TOOL_CODES.BAD_ADDRESS, 70000)
 *   -> tool_result content {"error":{"code":"bad-address","remedy":"use an address from 0 to 65535",
 *                                    "detail":"70000"}}, is_error:true
 *
 * The codes are exported as constants so tests assert them exactly rather than by matching prose, and they
 * are kebab-case identifiers in the wire format. Renaming one is a breaking change: they appear in tool
 * results, in tests, and in the model's reasoning.
 *
 * ToolError extends SessionError so that everything already built on SessionError - the consent gate's
 * refusal, the backend's error handling, the page's handling - keeps working unchanged. The code and remedy
 * ride on `.tool`, so a caller can show the remedy without parsing a message.
 */
import { SessionError } from '../errors.js';

// The stable codes. Tests import these, never the literal strings.
export const TOOL_CODES = Object.freeze({
  BAD_ADDRESS: 'bad-address',
  BAD_LENGTH: 'bad-length',
  TOO_LARGE: 'too-large',
  NOT_RAM: 'not-ram',
  BAD_COUNT: 'bad-count',
  PAST_END: 'past-end',
  NOT_A_NUMBER: 'not-a-number',
  UNKNOWN_TOOL: 'unknown-tool',
  NO_MACHINE: 'no-machine',
  NO_CONSENT: 'no-consent',
  CONSENT_DECLINED: 'consent-declined',
  STOPPED: 'stopped',
  MACHINE_RESTARTED: 'machine-restarted',
  EMPTY: 'empty',
  BAD_BYTE: 'bad-byte',
  ASSEMBLY_FAILED: 'assembly-failed',
  ORG_CONFLICT: 'org-conflict',
  NO_BASIC: 'no-basic',
  BAD_TARGET: 'bad-target',
  NOT_CONSUMED: 'not-consumed',
  NOT_TYPABLE: 'not-typable',
  BAD_LINE_NUMBER: 'bad-line-number',
  LINE_TOO_LONG: 'line-too-long',
  NOT_AT_PROMPT: 'not-at-prompt',
  PROGRAM_TOO_LARGE: 'program-too-large',
  UNKNOWN_MACHINE: 'unknown-machine',
  LOAD_DECLINED: 'load-declined',
  INCLUDE_UNREADABLE: 'include-unreadable',
  TOOL_FAILED: 'tool-failed',
});

// code -> the remedy sentence the model is given. Keep each one an instruction: what to do instead.
export const TOOL_ERRORS = Object.freeze({
  'bad-address': 'use an address from 0 to 65535',
  'not-ram': "that address is ROM or I/O on this machine's memory map: write to RAM",
  'too-large': 'send less: the limit for this parameter is given in detail',
  'bad-length': 'use a length from 1 to 65536 bytes: 65536 is the whole address space, and a read over 256 bytes is truncated',
  'bad-count': 'ask for at least 1 instruction, and at most 64',
  'past-end': 'start at a lower address: the bytes read (at most 256) or written must end at or before 65535 ($FFFF); addresses do not wrap',
  'not-a-number': 'pass a whole number, not a string or a fraction',
  'unknown-tool': 'use one of the tool names offered in this request',
  'no-machine': 'open a machine first; there is none in this chat',
  'no-consent': 'the person has not allowed acting on the machine: explain the change instead of making it',
  'consent-declined': 'the person chose "Just tell me the fix": explain the change so they can make it',
  stopped: 'the person stopped Claude: do not change the machine',
  'machine-restarted': 'the machine restarted while your keys went in (detail says how many went in; the rest were not typed); this is not a Stop. Read the screen with screen_text and machine_info before you type again',
  empty: 'send a non-empty value for the parameter named in detail',
  'bad-byte': 'a byte is a whole number from 0 to 255',
  'assembly-failed': 'fix the errors named in detail (line numbers are those of your source) and call again; nothing was written',
  'org-conflict': 'drop the org argument, or remove the ORG line from the source',
  'no-basic': 'this needs the BASIC ROMs, which this machine does not have: for run, pass an address to jump to instead; for a program, write it in assembler with assemble_and_load',
  'bad-target': 'pass an address 0-65535 (a decimal integer, or hex text like "$3000") or "RUN"',
  'not-consumed': 'the machine did not read the keyboard while the keys were held (detail says how far it got; the rest was not typed or pressed): read the screen with screen_text and machine_info to see what is running; if a program is running that reads the keyboard, press_break may stop it; a program that never reads it ignores keys, so say so. Then type only what is missing, or offer load_basic for a long program',
  'bad-line-number': 'start every line with a line number from 0 to 63999 (detail names the line); nothing was loaded',
  'line-too-long': 'split the line named in detail: it is longer than this BASIC accepts (the limit is in detail); nothing was loaded',
  'not-at-prompt': 'BASIC must be at its OK prompt: read the screen with screen_text, press_break if a program is running, and try again',
  'program-too-large': 'the program does not fit in this BASIC session\'s free memory (detail gives the sizes): shorten it, or ask the person to free memory (for example PCLEAR 1 on a CoCo or Dragon)',
  'unknown-machine': 'this machine\'s BASIC is not one load_basic knows: type the program with type_text instead',
  'load-declined': 'the person chose not to load the program: do not load it; offer to type it if it has 3 lines or fewer, or give them the listing',
  'include-unreadable': 'an INCLUDE file could not be read (detail names it and why); nothing was written: put the code it holds into the source itself and call again',
  'tool-failed': 'the tool failed inside the emulator (detail says how): read the machine with machine_info or screen_text before going on, and tell the person; do not repeat the call unchanged. (When the detail says the CALL was wrong - it names a tool target, say - fix the call; nothing was read and the machine is fine.)',
  'not-typable': 'the machine cannot take the characters in detail (no key for them on this keyboard, or above $7E, which BASIC cannot store as text): leave them out or use plain ASCII it has (BASIC keywords are uppercase)',
});

export class ToolError extends SessionError {
  // code must be one of TOOL_CODES' values (an unknown code is a programming error, not a model error);
  // detail is the offending value, shown to the model so it can see what it sent.
  constructor(code, detail = null) {
    if (!TOOL_ERRORS[code]) throw new Error(`unknown tool error code: ${code}`);
    super(`${code}: ${TOOL_ERRORS[code]}${detail == null ? '' : ` (got ${detail})`}`);
    this.name = 'ToolError';
    this.code = code;
    this.tool = { code, remedy: TOOL_ERRORS[code], ...(detail == null ? {} : { detail: String(detail) }) };
  }
}

// What the model is given for a failure: the JSON the backend sends as an is_error tool_result.
export const toolErrorJson = (e) => JSON.stringify({ error: e.tool });

// Any failure as a ToolError: a ToolError as it is, anything else (a bug, an exception from below) as tool-failed
// with its message, so no tool hands the model a bare sentence or a stack trace.
export const asToolError = (e) => (e instanceof ToolError ? e : new ToolError(TOOL_CODES.TOOL_FAILED, e && e.message ? e.message : String(e)));

// A whole number in range, or the ToolError naming which bound failed. Shared by every tool that takes an
// address, a length or a count, so the codes cannot drift between them.
export function checkedInt(value, { min, max, code }) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.trunc(value) !== value) throw new ToolError(TOOL_CODES.NOT_A_NUMBER, value);
  if (value < min || value > max) throw new ToolError(code, value);
  return value;
}
