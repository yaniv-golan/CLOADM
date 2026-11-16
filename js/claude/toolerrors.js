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
  EMPTY: 'empty',
  BAD_BYTE: 'bad-byte',
  ASSEMBLY_FAILED: 'assembly-failed',
  ORG_CONFLICT: 'org-conflict',
  NO_BASIC: 'no-basic',
  BAD_TARGET: 'bad-target',
});

// code -> the remedy sentence the model is given. Keep each one an instruction: what to do instead.
export const TOOL_ERRORS = Object.freeze({
  'bad-address': 'use an address from 0 to 65535',
  'not-ram': "that address is ROM or I/O on this machine's memory map: write to RAM",
  'too-large': 'send less: the limit for this parameter is given in detail',
  'bad-length': 'use a length from 1 to 65536 bytes: 65536 is the whole address space, and a read over 256 bytes is truncated',
  'bad-count': 'ask for at least 1 instruction, and at most 64',
  'past-end': 'start at a lower address: the bytes read (at most 256) must end at or before 65535 ($FFFF); reads do not wrap',
  'not-a-number': 'pass a whole number, not a string or a fraction',
  'unknown-tool': 'use one of the tool names offered in this request',
  'no-machine': 'open a machine first; there is none in this chat',
  'no-consent': 'the person has not allowed acting on the machine: explain the change instead of making it',
  'consent-declined': 'the person chose "Just tell me the fix": explain the change so they can make it',
  stopped: 'the person stopped Claude: do not change the machine',
  empty: 'send a non-empty value for the parameter named in detail',
  'bad-byte': 'a byte is a whole number from 0 to 255',
  'assembly-failed': 'fix the errors named in detail (line numbers are those of your source) and call again; nothing was written',
  'org-conflict': 'drop the org argument, or remove the ORG line from the source',
  'no-basic': 'RUN needs the BASIC ROMs, which this machine does not have: pass an address to jump to instead',
  'bad-target': 'pass an address 0-65535 (a decimal integer, or hex text like "$3000") or "RUN"',
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

// A whole number in range, or the ToolError naming which bound failed. Shared by every tool that takes an
// address, a length or a count, so the codes cannot drift between them.
export function checkedInt(value, { min, max, code }) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.trunc(value) !== value) throw new ToolError(TOOL_CODES.NOT_A_NUMBER, value);
  if (value < min || value > max) throw new ToolError(code, value);
  return value;
}
