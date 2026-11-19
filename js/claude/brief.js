/*
 * The brief Claude receives. The fixed part is here as code so it is reviewed with the code;
 * js/host/claude-brief.md holds the prose the reader can edit, and this builder appends the per-call facts.
 * The brief is the system prompt sent with every request.
 */
import { ACTING_TOOL_NAMES, CHAT_SCREEN, TYPING_POLICY } from './chat.js';
import { READ_ONLY_TOOLS } from './readtools.js';

// How the tools answer (js/claude/toolerrors.js, js/claude/chat.js), said whenever tools are on. The second
// paragraph is the rule that keeps a claim from outrunning its evidence: a tool's success says what reached the
// machine, never what the program then did.
export const VERIFY_RULE = 'An acting tool\'s success means the keys or bytes reached the machine, not that the program did what you wanted. Check the effect with screen_text, peek or machine_info before you say it happened. If you can\'t read the result, say it is unverified.';
export const TOOL_CONTRACT = `Tools: results are JSON. A failed call is {"error":{"code","remedy","detail"}}: do what the remedy says. ${READ_ONLY_TOOLS.join(', ')} only read and need no permission. ${ACTING_TOOL_NAMES.join(', ')} change the machine and need the person's permission (they are asked when needed); consent-declined, load-declined and no-consent mean nothing changed: explain the change instead of making it; stopped means the person stopped you: do not change the machine further; machine-restarted means the machine restarted while your keys went in; this is not a Stop: read the screen before typing again. A restore point is made before the first change of each turn.\n${VERIFY_RULE}`;

const SCREEN = (cols, rows) => `${cols} columns by ${rows} rows`;

// What runs on the machine, from its real state (the page decides it: Session.nitros9On, Machine.hasRom):
// 'basic' (BASIC ROMs are in), 'nitros9' (NitrOS-9 booted from disk) or 'none' (no ROMs: machine code only).
export const SOFTWARE = Object.freeze(['basic', 'nitros9', 'none']);
const LOADED = {
  // ROMs in say nothing about what runs now: a program, a game or the prompt
  basic: 'BASIC ROMs are loaded; what runs now may be BASIC\'s prompt or a program, so do not assume either.',
  nitros9: 'NitrOS-9 is running from disk, not BASIC: BASIC commands and BASIC programs do not apply.',
  none: 'No BASIC ROMs are loaded: the machine runs without ROMs, machine code only.',
};

// The machine's own text screen, by family (Machine profiles: js/machines/profiles.js). These are the machine's
// geometry, not its current mode (machine_info reads that), so the brief stays the same all conversation long.
export function machineScreen(family) {
  if (family === 'coco3') return `${SCREEN(32, 16)} of text at power-on (MC6847-compatible); the GIME can also show 40, 64 or 80 columns`;
  if (family === 'd64plus') return `${SCREEN(32, 16)} of text (MC6847), and an 80-column display on its 80-column board`;
  return `${SCREEN(32, 16)} of text (MC6847)`;
}

// the machine's facts, as short sentences
export function machineFacts({ machine, ram, cpu, software, family, edition, tools }) {
  if (!SOFTWARE.includes(software)) throw new Error(`machineFacts: software must be one of ${SOFTWARE.join(', ')}`);
  const bits = [
    `Machine: ${machine}.`,
    `RAM: ${ram}K.`,
    `CPU: ${cpu}.`,
    `Its screen: ${machineScreen(family)}.`,
    LOADED[software],
    `Edition: ${edition}.`,
    tools ? 'You can use the machine tools listed for this chat; machine_info and screen_text say what is running now.' : 'You cannot use machine tools in this chat.',
  ];
  return bits.join(' ');
}

// Where the replies are read: 'full' is the full-screen chat, the chat firmware's screen (CHAT_SCREEN, 42 x 24
// on every machine); 'panel' is the Ask Claude panel beside the emulator.
const REPLIES = {
  full: `Your replies show on the full-screen chat: ${SCREEN(CHAT_SCREEN.cols, CHAT_SCREEN.rows)}, plain text only, only characters the chat font has.`,
  panel: 'Your replies show in the Ask Claude panel beside the emulator: plain text only.',
};

// The full brief. opts: { machine, ram, cpu, software, family, edition, tools, view ('full' | 'panel'), base }
// `base` is the fixed prose (read from js/host/claude-brief.md by the page); when absent the built-in copy
// below is used, so Node tests and an embedder need no file.
export function claudeBrief(opts = {}) {
  const fixed = (opts.base && String(opts.base).trim()) || FIXED_BRIEF;
  if (!Object.hasOwn(REPLIES, opts.view)) throw new Error('claudeBrief: view must be "full" or "panel"');
  // the tool contract and the typing policy are the code's, not the editable prose: said whenever tools are on
  const policy = opts.tools ? `\n\n${TOOL_CONTRACT}\n\n${TYPING_POLICY}` : '';
  return `${fixed}\n\n${REPLIES[opts.view]} Keep answers short.${policy}\n\n${machineFacts(opts)}`;
}

// The built-in brief (kept in step with js/host/claude-brief.md by tests/claude-chat.test.js)
export const FIXED_BRIEF = `You are the assistant inside CLOADM, a browser emulator of 1980s Dragon and Tandy Color Computer machines. You are talking with someone using the emulator.
Write plain text and short answers: no Markdown, no tables, no code fences.
When you write a BASIC program for this machine, use the machine's BASIC dialect: line numbers, uppercase keywords, and say when Extended BASIC is needed.
Be warm and aware of the nostalgia of these machines. You are not LIZA, the old conversation program, and do not pretend to be.
Everything here is emulated and undoable: the person can reset the machine or undo your changes, so there is nothing to break.`;
