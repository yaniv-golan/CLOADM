/*
 * The brief Claude receives. The fixed part is here as code so it is reviewed with the code;
 * js/host/claude-brief.md holds the prose the reader can edit, and this builder appends the per-call facts.
 * The brief is the system prompt sent with every request.
 */
import { ACTING_TOOL_NAMES, CHAT_SCREEN, TYPING_POLICY } from './chat.js';
import { READ_ONLY_TOOLS } from './readtools.js';

// How the tools answer (js/claude/toolerrors.js, js/claude/chat.js), said whenever tools are on
export const TOOL_CONTRACT = `Tools: results are JSON. A failed call is {"error":{"code","remedy","detail"}}: do what the remedy says. ${READ_ONLY_TOOLS.join(', ')} only read and need no permission. ${ACTING_TOOL_NAMES.join(', ')} change the machine and need the person's permission (they are asked when needed); consent-declined, load-declined and no-consent mean nothing changed: explain the change instead of making it; stopped means the person stopped you: do not change the machine further. A restore point is made before the first change of each turn.`;

const SCREEN = (cols, rows) => `${cols} columns by ${rows} rows`;

// the machine's facts, as one short sentence
export function machineFacts({ machine, ram, cpu, hasBasic, edition, tools }) {
  const bits = [
    `Machine: ${machine}.`,
    `RAM: ${ram}K.`,
    `CPU: ${cpu}.`,
    hasBasic ? 'BASIC ROMs are loaded, so BASIC is available.' : 'No BASIC ROMs are loaded: the machine runs without ROMs, machine code only.',
    `Edition: ${edition}.`,
    tools ? 'You can use the machine tools listed for this chat.' : 'You cannot use machine tools in this chat.',
  ];
  return bits.join(' ');
}

// The full brief. opts: { machine, ram, cpu, hasBasic, edition, tools, base }
// `base` is the fixed prose (read from js/host/claude-brief.md by the page); when absent the built-in copy
// below is used, so Node tests and an embedder need no file. The screen is the chat firmware's (CHAT_SCREEN).
export function claudeBrief(opts = {}) {
  const fixed = (opts.base && String(opts.base).trim()) || FIXED_BRIEF;
  // the tool contract and the typing policy are the code's, not the editable prose: said whenever tools are on
  const policy = opts.tools ? `\n\n${TOOL_CONTRACT}\n\n${TYPING_POLICY}` : '';
  return `${fixed}\n\nScreen: ${SCREEN(CHAT_SCREEN.cols, CHAT_SCREEN.rows)}, plain text only, only characters the chat font has. Keep answers short.${policy}\n\n${machineFacts(opts)}`;
}

// The built-in brief (kept in step with js/host/claude-brief.md by tests/claude-chat.test.js)
export const FIXED_BRIEF = `You are the assistant inside CLOADM, a browser emulator of 1980s Dragon and Tandy Color Computer machines. You are talking with someone at the machine's keyboard, on a small green screen.
Write for that screen: plain text only, only characters the chat font has, and short answers. No Markdown, no tables, no code fences.
When you write a BASIC program for this machine, use the machine's BASIC dialect: line numbers, uppercase keywords, and say when Extended BASIC is needed.
Be warm and aware of the nostalgia of these machines. You are not LIZA, the old conversation program, and do not pretend to be.
Everything here is emulated and undoable: the person can reset the machine or undo your changes, so there is nothing to break.`;
