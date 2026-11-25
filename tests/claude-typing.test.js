// Run: node tests/claude-typing.test.js
//
// type_text paced by what the machine CONSUMES (js/machines/typist.js typePaced), browser-free, no network, no ROMs.
//
// The bug this guards against: Claude typed a multi-line BASIC program with type_text, BASIC dropped keys, and the
// tool still said it had typed everything. The typist held each key for a fixed few frames, so a key pressed and
// released while BASIC was busy (storing a line after ENTER, scrolling the screen) was never seen.
//
// The oracle is firmware written here, in the BASIC socket, that behaves the way that matters: it scans the
// keyboard matrix column by column (PIA0 port B drives the columns, port A reads the rows; on the MC-10, port 1
// and $BFFF), logs every NEW press (a bit going 1 -> 0, so a key held down counts once and a repeated letter
// needs a release in between, as a rollover table does) as column*8+row, and after logging ENTER stays busy for
// about ten frames without reading the keyboard, as a line editor storing the line does; it is also busy for ten
// frames after every 4 passes over the keyboard, whatever is pressed, as BASIC is while it scrolls or prints. Expected key codes come
// from the machine's own matrix layout (Machine.keyPos), not from the code under test.
//
// What is proved, on the Dragon 64, the CoCo 3 and the MC-10:
//  * the old fixed-timing typist (still used for pasting) loses keys typed after an ENTER on this firmware: the
//    test can see the bug;
//  * type_text delivers every key of a three-line program, in order, and reports requested = consumed and the
//    lines delivered;
//  * firmware that stops reading the keyboard after the first ENTER: type_text fails not-consumed, says how far it
//    got (1 line, the keys of it), types nothing more later, and leaves no key held down;
//  * a character the keyboard has no key for is not-typable before anything is typed or a restore point taken;
//  * Stop while typing ends the call with stopped and the rest is not typed;
//  * the policy (3 lines or fewer typed, a longer program offered as load_basic, verified after either) is in the
//    tool descriptions and in the system prompt.
const Emu = require('./load')();
const C = Emu.TOOL_CODES;

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };
const dead = new Emu.ClaudeBackend({ fetch: async () => { throw new Error('no network in this test'); }, apiKey: 'sk-ant-TYPING-TEST-KEY-0123456789' });
const call = (chat, name, input = {}) => Promise.resolve(chat.backend.runTool(name, input)).then((out) => ({ ok: true, out }), (err) => ({ ok: false, err }));
// call a tool with the machine running until it settles
const callFrames = async (s, chat, name, input, max = 6000, during = null) => {
  let done = false; const p = call(chat, name, input).then((r) => { done = true; return r; });
  for (let i = 0; i < max && !done; i++) { frames(s, 1); if (during) during(i); await new Promise((r) => setImmediate(r)); }
  return done ? p : { ok: false, err: { code: 'TEST-TIMEOUT', message: 'the call did not settle' } };
};

const firmware = require('./typing-firmware');
const SLOT = { dragon64: 0x4000, coco3: 0x8000, mc10: 0x2000 };

// a machine whose BASIC socket holds the scanning firmware, running, with Claude allowed to act
function machineWith(id, busy) {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine(id);
  const m0 = s.shownMachine, six = id === 'mc10' ? '6803' : '6809';
  const enter = m0.keyPos.ENTER[1] * 8 + m0.keyPos.ENTER[0];
  const asm = Emu.assemble(firmware(six, enter, busy), six);
  if (!asm.ok) throw new Error(asm.errors.map((e) => `line ${e.line}: ${e.message}`).join('; '));
  const rom = new Uint8Array(SLOT[id]).fill(0xFF);
  rom.set(asm.segments[0].data, 0);
  m0.setRoms({ basic: rom });
  m0.reset(true);
  m0.cpu.jump(asm.exec);
  frames(s, 6);
  const m = s.shownMachine, base = id === 'mc10' ? 0x4300 : 0x0300, logAt = base + (id === 'mc10' ? 0x50 : 0x40);
  const log = () => Array.from({ length: m.ram[base] }, (_, i) => m.ram[logAt + i]);
  const shift = m.keyPos.SHIFT[1] * 8 + m.keyPos.SHIFT[0];
  // the keys the firmware saw, SHIFT left out (it goes down with each shifted character)
  const keys = () => log().filter((c) => c !== shift);
  // what typing `text` must produce: each character's key position, from the machine's own layout
  const want = (text) => [...text].map((ch) => { const k = Emu.charToKeys(ch); const [r, c] = m.keyPos[k.key]; return c * 8 + r; });
  s.consent.setAllowed(true);
  const chat = s.startAsk({ backend: dead });
  return { s, m, chat, keys, want, started: m.hasRom && m.ram[base + 1] === 0x5A };
}

const PROGRAM = '10 PRINT "HELLO"\n20 GOTO 10\n30 REM AAAAAAAA\n';

(async () => {
  for (const id of ['dragon64', 'coco3', 'mc10']) {
    // ---- the bug, seen: the fixed-timing typist loses keys after an ENTER on a busy machine ----
    {
      const { s, keys, want, started } = machineWith(id, 'busy');
      check(`${id}: the scanning firmware is the BASIC ROM and it runs`, started);
      s.typeText(PROGRAM);
      frames(s, 600);
      const got = keys(), exp = want(PROGRAM.replace(/\n/g, '\r'));
      check(`${id}: the old fixed-timing typist drops keys typed while the machine is busy after ENTER (the bug)`, got.length < exp.length, `${got.length} of ${exp.length} keys seen`);
    }
    // ---- paced: every key arrives, in order, and the result says what was consumed ----
    {
      const { s, m, chat, keys, want } = machineWith(id, 'busy');
      const r = await callFrames(s, chat, 'type_text', { text: PROGRAM });
      const got = keys(), exp = want(PROGRAM.replace(/\n/g, '\r'));
      check(`${id}: type_text delivers every key of a three-line program, in order, through the busy time after each ENTER`, r.ok && got.join() === exp.join(), `${r.ok ? '' : r.err.message} ${got.length} of ${exp.length}`);
      check(`${id}: the result is what the machine consumed: requested = consumed, 3 of 3 lines`, r.ok && JSON.stringify(r.out) === JSON.stringify({ requested: PROGRAM.length, consumed: PROGRAM.length, lines_requested: 3, lines_delivered: 3 }), r.ok ? JSON.stringify(r.out) : r.err.message);
      check(`${id}: nothing is left queued or held down, one restore point`, !m.typist.busy && m.keyCols.every((c) => c === 0) && chat.undo.length === 1);
    }
    // ---- a machine that stops reading the keyboard: not-consumed, honestly, and nothing typed later ----
    {
      const { s, m, chat, keys, want } = machineWith(id, 'hang');
      const text = 'AB\nCD\n';
      const r = await callFrames(s, chat, 'type_text', { text });
      const detail = r.ok ? '' : String(r.err.tool && r.err.tool.detail);
      const rep = (() => { try { return JSON.parse(detail.slice(detail.indexOf('{'))); } catch (e) { return null; } })();
      check(`${id}: firmware that stops reading the keyboard after ENTER: type_text fails not-consumed`, !r.ok && r.err.code === C.NOT_CONSUMED && /remedy/.test(JSON.stringify(r.err.tool)), r.ok ? JSON.stringify(r.out) : r.err.message);
      check(`${id}: not-consumed says how far it got: 3 of 6 keys, 1 of 2 lines`, rep && rep.requested === 6 && rep.consumed === 3 && rep.lines_requested === 2 && rep.lines_delivered === 1, detail);
      frames(s, 120);
      check(`${id}: after not-consumed nothing more is typed or held down`, keys().join() === want('AB\r').join() && !m.typist.busy && m.keyCols.every((c) => c === 0), `${keys()}`);
    }
    // ---- not-typable: refused before anything is typed or a restore point is taken ----
    {
      const { s, m, chat } = machineWith(id, 'busy');
      const r = await callFrames(s, chat, 'type_text', { text: 'PRINT {1}\n' });
      check(`${id}: a character with no key is not-typable, named, and nothing is typed`, !r.ok && r.err.code === C.NOT_TYPABLE && /\{/.test(r.err.tool.detail) && !m.typist.busy && chat.undo.length === 0, r.ok ? '' : r.err.message);
    }
    // ---- Stop while typing: stopped, and the rest is not typed ----
    {
      const { s, m, chat, keys } = machineWith(id, 'busy');
      const r = await callFrames(s, chat, 'type_text', { text: PROGRAM }, 6000, (i) => { if (i === 30) s.stopClaude(); });
      const seen = keys().length;
      frames(s, 300);
      check(`${id}: Stop while typing ends the call with stopped, and the rest is never typed`, !r.ok && r.err.code === C.STOPPED && seen < PROGRAM.length && keys().length === seen && !m.typist.busy && m.keyCols.every((c) => c === 0), r.ok ? JSON.stringify(r.out) : `${r.err.code} ${seen}`);
    }
  }

  // ---- the policy Claude is given: type 3 lines or fewer, call load_basic for more (its card asks, not Claude), verify after either ----
  {
    const tools = Emu.actingTools();
    const desc = (name) => (tools.find((t) => t.name === name) || {}).description || '';
    const says = (text) => /3 lines or fewer/.test(text) && /type_text/.test(text) && /call load_basic instead of typing it/.test(text)
      && /Do not ask in prose first/.test(text) && /card for each load_basic call \(unless they chose not to be asked again\)/.test(text) && !/ask the person whether/.test(text) && /verify/.test(text) && /LIST/.test(text) && /screen_text/.test(text);
    check('policy: TYPE_LINES_MAX is 3 and TYPING_POLICY states all three rules', Emu.TYPE_LINES_MAX === 3 && says(Emu.TYPING_POLICY), Emu.TYPING_POLICY);
    check('policy: the type_text and load_basic descriptions state it', says(desc('type_text')) && says(desc('load_basic')));
    const brief = Emu.claudeBrief({ machine: 'Dragon 64', ram: 64, cpu: '6809', software: 'basic', family: 'dragon', view: 'full', edition: 'test', tools: true });
    check('policy: the system prompt states it when Claude has the machine tools', says(brief), brief.slice(-600));
    check('policy: and leaves it out when there are no tools to follow it with', !/load_basic/.test(Emu.claudeBrief({ machine: 'Dragon 64', ram: 64, cpu: '6809', software: 'basic', family: 'dragon', view: 'full', edition: 'test', tools: false })));
  }

  console.log(`\n${n - fail}/${n} paced typing checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
