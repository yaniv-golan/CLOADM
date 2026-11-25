/*
 * The example prompts the Ask Claude panel offers in an empty chat: three questions that fit what is on the machine
 * now. Browser-free, so the rules are tested in Node (tests/ask-prompts.test.js).
 *
 * Detection comes from the Session's and the machine's state, never from pixels: promptState(session) reads it,
 * promptsFor(state) is a pure table lookup, and promptsNow(session) is the two together with the fallback set on any
 * error (never zero chips). Nothing is ever sent to a model to make prompts: the sets are fixed text.
 *
 * Priority, first match wins:
 *   P1 the Debugger has the machine stopped            stopped
 *   P2 the person has just arrived from a link         fromLink (Session.arrivedFromLink: a shared moment's link)
 *   P3 WYRMFIRE                                        program 'wyrmfire'
 *   P4 a bundled program: the welcome menu (without and with ROMs for this machine), LIZA, 2048, Minesweeper, the demo
 *   P5 a machine-code program of the person's          userCode: the CPU runs from RAM
 *   P6 BASIC at its prompt with a program in memory    basic 'prompt', lines > 0
 *   P7 BASIC at its prompt, no program                 basic 'prompt', lines 0
 *   P8 BASIC running a program                         basic 'busy'
 *   P9 anything else                                   the fallback
 */
import { cpuFamily } from '../cpu/cpus.js';
import { DIALECTS, readProgram } from '../media/basic.js';

export const PROMPT_SETS = Object.freeze({
  stopped: ['Why did it stop here?', 'What does this code do?', 'What should I look at next?'],
  link: ['What am I looking at?', 'What can I do here?', 'How do I start this from the beginning?'],
  wyrmfire: ['How do I play this?', 'How does a 3D engine run on a 6809?', 'What are the controls?'],
  'welcome-norom': ['What is this computer?', 'What can I do without ROMs?', 'How do I add my ROMs?'],
  'welcome-rom': ['What is this computer?', 'Help me write my first BASIC program', 'What should I try first?'],
  liza: ['How does LIZA work?', 'Where does LIZA keep what I type?', 'How old is this kind of chatbot?'],
  2048: ['Give me a strategy for 2048', 'How is this game written?', 'Where does it keep the score?'],
  minesweeper: ['How do I play this?', 'How does it place the mines?', 'Where is the board in memory?'],
  demo: ['What are these colours?', 'Which graphics mode is this?', 'How does it make the sound?'],
  code: ['What is this program doing?', "Show me the code that's running now", 'Where does it keep its data?'],
  'basic-program': ['Explain my program', 'Find the bug in my program', 'Add a feature to my program'],
  'basic-empty': ['Help me write a short BASIC program', 'Draw something in colour', 'What can this BASIC do?'],
  'basic-busy': ['What is my program doing right now?', 'How do I stop it?', 'Why is it slow?'],
  fallback: ['What is this machine?', "What's on the screen right now?", 'What can I try here?'],
});
for (const v of Object.values(PROMPT_SETS)) Object.freeze(v);

const BUNDLED = new Set(['liza', '2048', 'minesweeper', 'demo']);

// state -> { id, prompts }: id is a PROMPT_SETS key. state's fields (all optional):
//   stopped, fromLink: booleans; program: Session.bundledRunning ('wyrmfire' | 'welcome' | 'liza' | '2048' | 'minesweeper' |
//   'demo' | null); roms: this machine has ROMs that start BASIC; userCode: the CPU runs from RAM;
//   basic: 'prompt' | 'busy' | null (no BASIC, or it cannot be told); lines: the BASIC program's line count
export function promptsFor(state) {
  const s = state || {};
  const pick = (id) => ({ id, prompts: PROMPT_SETS[id] });
  if (s.stopped) return pick('stopped');
  if (s.fromLink) return pick('link');
  if (s.program === 'wyrmfire') return pick('wyrmfire');
  if (s.program === 'welcome') return pick(s.roms ? 'welcome-rom' : 'welcome-norom');
  if (BUNDLED.has(s.program)) return pick(s.program);
  if (s.userCode) return pick('code');
  if (s.basic === 'prompt') return pick(s.lines > 0 ? 'basic-program' : 'basic-empty');
  if (s.basic === 'busy') return pick('basic-busy');
  return pick('fallback');
}

// Where a family's BASIC ROM sits: the CPU running below it is running from RAM, a program of the person's (the
// Dragon and CoCo map BASIC at $8000 and up; the CoCo 3 copies it to RAM at $8000 and runs it there; the MC-10's
// Micro Color BASIC is $E000-$FFFF). Bundled programs also run from RAM; they are told apart first (bundledRunning).
const ROM_FROM = { '6809': 0x8000, '6803': 0xE000 };
// Color BASIC's CURLIN, the line number BASIC is running: $FFFF in direct mode, at the prompt (Color BASIC Unravelled
// II, the direct page map: CURLIN at $68). The Dragon keeps Color BASIC's direct page for TXTTAB at $19 and CURPOS
// at $88 (js/media/basic.js, js/machines/stub.js); CURLIN at $68 is taken to be the same there, not confirmed from a
// Dragon source. Micro Color BASIC's is not known here: the MC-10 is at the prompt while OK shows on its screen.
const CURLIN = { coco: 0x68, dragon: 0x68 };

// the Session's state -> promptsFor's state. Throws on a machine it cannot read; promptsNow catches that.
export function promptState(session) {
  const m = session.personMachine;
  if (!m) return {};
  const program = session.bundledRunning;
  const out = {
    stopped: !!(m.debugger && m.debugger.stopped),
    fromLink: !!session.arrivedFromLink,
    program,
    roms: program === 'welcome' ? !!session.machineRoms(m.id).bootable : false,
    userCode: false,
    basic: null,
    lines: 0,
  };
  if (session.nitros9On(m)) return out;   // NitrOS-9, not BASIC and not a program of the person's
  const rd = (a) => m.peek(a & 0xFFFF), word = (a) => (rd(a) << 8) | rd(a + 1);
  const romFrom = ROM_FROM[cpuFamily(m.config.cpu)];
  out.userCode = !program && romFrom != null && ((m.cpu.pc >>> 0) & 0xFFFF) < romFrom;
  if (program || out.userCode || !m.hasRom || m.useStub) return out;
  const st = session._bootStatusOf(m);
  if (st.state === 'booting' || st.state === 'failed' || st.state === 'stub') return out;
  const d = DIALECTS[m.profile.lineage];
  if (!d) return out;
  const p = d.pointers, start = word(p.txttab), prog = start > 0 && start < 0xFFFF ? readProgram(rd, start, word(p.fretop) || 0x10000) : null;
  out.lines = prog ? prog.lines.length : 0;
  const curlin = CURLIN[d.id];
  if (curlin != null) out.basic = word(curlin) === 0xFFFF ? 'prompt' : 'busy';
  else out.basic = session.screenText(m).some((l) => l.trim() === 'OK') ? 'prompt' : 'busy';
  return out;
}

// the prompts for the Session now: the fallback set if anything in reading the state fails
export function promptsNow(session, { read = promptState } = {}) {
  try { return promptsFor(read(session)); } catch (e) { return promptsFor(null); }
}
