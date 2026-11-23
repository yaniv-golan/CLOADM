// Run: node tests/claude-act.test.js
//
// assemble_and_load and run (the acting tools), browser-free, no network. Both go through the
// same consent as poke, type_text and press_break: the "Let Claude use the emulator" gate in Session.gateTools.
//
// What is proved:
//  * both are acting tools, offered with the others, the tool count stays within 16;
//  * consent: through the Session's gate (the one the page uses) both are refused without it and nothing
//    changes; with it they run, after one restore point per turn, and Undo puts memory back;
//  * assemble_and_load writes what the assembler produced (bytes hand-computed), reports bytes, ranges and
//    symbols, does not start the machine, and on a ROM-less machine does NOT reset it (RAM elsewhere survives);
//  * errors come back with the line numbers of the source Claude wrote, and nothing is written;
//  * the write is read back and the bytes that did not take are named: ROM (also when the byte written is the
//    byte the ROM already holds), the vector page, a cartridge window, I/O, MC-10 on-chip RAM (takes) and the
//    $BFFF latch (does not);
//  * run takes a number, "$3000", "0x3000", "3000" or "RUN"; it validates before taking a restore point; "RUN"
//    with no BASIC ROM is refused; with a ROM, "RUN" delivers R, U, N, ENTER to firmware scanning the keyboard
//    matrix (firmware written here, in the BASIC socket);
//  * INCLUDE resolves only through the injected reader (none: an assembler error, nothing fetched); the page's
//    reader reads examples/ only (a traversal guard stops anything else before any request).
const Emu = require('./load')();
const C = Emu.TOOL_CODES;

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };
const boot = (id) => { const s = new Emu.Session({ store: Emu.memoryStore() }); s.switchMachine(id); frames(s, 40); return s; };
const hex2 = (b) => b.toString(16).padStart(2, '0');
const dead = new Emu.ClaudeBackend({ fetch: async () => { throw new Error('no network in this test'); }, apiKey: 'sk-ant-ACT-TEST-KEY-0123456789' });
// a chat over the session's target, as startAsk builds it, with the consent gate off (the default)
const ask = (s, opts = {}) => { const chat = s.startAsk({ backend: dead, ...opts }); return chat; };
// call a tool the way the backend does, through the gate: { ok, out | err }
const call = (chat, name, input = {}) => Promise.resolve(chat.backend.runTool(name, input)).then((out) => ({ ok: true, out }), (err) => ({ ok: false, err }));
// the same, with the machine running until the call settles (type_text waits for the machine to read its keys)
const callFrames = async (s, chat, name, input = {}, max = 4000) => {
  let done = false; const p = call(chat, name, input).then((r) => { done = true; return r; });
  for (let i = 0; i < max && !done; i++) { frames(s, 1); await new Promise((r) => setImmediate(r)); }
  return done ? p : { ok: false, err: { code: 'TEST-TIMEOUT', message: 'the call did not settle' } };
};
const turn = (chat) => { chat.snapped = false; };   // a new turn: the next change takes a restore point
const nt = (r) => (r.ok ? JSON.stringify(r.out.not_taken) : `${r.err.code}`);   // the not_taken list as JSON
const gap = (from, to, why) => JSON.stringify([{ from, to, why }]);
const mem = (m, addr, len) => Array.from({ length: len }, (_, i) => m.peek ? m.peek(addr + i) : m.ram[addr + i]);

// a run that never reaches its summary (a call that never settles empties the event loop) must not pass
process.exitCode = 1;
(async () => {
  // ---- 1. the tool sets ----
  {
    const names = Emu.machineTools().map((t) => t.name);
    check('assemble_and_load and run are offered', names.includes('assemble_and_load') && names.includes('run'), names.join(','));
    check('the total tool count stays within 16', names.length <= 16, `${names.length}`);
    check('every tool has an object schema and a description', Emu.machineTools().every((t) => t.description && t.input_schema.type === 'object'));
    check('assemble_and_load requires source; run requires nothing', JSON.stringify(Emu.machineTools().find((t) => t.name === 'assemble_and_load').input_schema.required) === '["source"]'
      && Emu.machineTools().find((t) => t.name === 'run').input_schema.required.length === 0);
  }

  // ---- 2. consent, through the Session's gate ----
  {
    const s = boot('dragon64');
    const chat = ask(s);
    const m = s.shownMachine;
    const pc = m.cpu.pc, snap = Emu.state.toJSON(m.snapshot());
    for (const [name, input] of [['assemble_and_load', { source: ' NOP\n', org: 0x3000 }], ['run', { target: 0x3000 }]]) {
      const r = await call(chat, name, input);       // consent.asker is null: nobody can say yes
      check(`${name}: refused with no consent: the code no-consent, with its remedy`, !r.ok && r.err.code === C.NO_CONSENT && r.err.tool.remedy === Emu.TOOL_ERRORS[C.NO_CONSENT], r.ok ? JSON.stringify(r.out) : r.err.message);
    }
    check('refused calls changed nothing and took no restore point', Emu.state.toJSON(m.snapshot()) === snap && m.cpu.pc === pc && chat.undo.length === 0 && !s.consent.allowed);
    // the person says "Just tell me the fix"
    s.consent.asker = () => Promise.resolve().then(() => s.consent.answer(false));
    const no = await call(chat, 'assemble_and_load', { source: ' NOP\n', org: 0x3000 });
    check('"Just tell me the fix": refused with consent-declined, nothing written', !no.ok && no.err.code === C.CONSENT_DECLINED && mem(m, 0x3000, 1)[0] === 0 && chat.undo.length === 0);
    // the person allows it
    s.consent.asker = () => Promise.resolve().then(() => s.consent.answer(true));
    const yes = await call(chat, 'assemble_and_load', { source: ' LDA #$41\n', org: 0x3000 });
    check('Allow: the program is written, after one restore point', yes.ok && mem(m, 0x3000, 2).join() === '134,65' && chat.undo.length === 1 && s.consent.allowed, yes.ok ? '' : yes.err.message);
    const before = chat.undo.length;
    const r2 = await call(chat, 'run', { target: 0x3000 });
    check('run goes through the same consent once allowed (no second question)', r2.ok && m.cpu.pc === 0x3000 && chat.undo.length === before, r2.ok ? r2.out : r2.err.message);
    // Undo puts memory and the CPU back
    turn(chat);
    await call(chat, 'assemble_and_load', { source: ' FCB $77,$78\n', org: 0x3100 });
    check('the turn took a restore point', chat.undo.length === 2 && mem(m, 0x3100, 2).join() === '119,120');
    check('Undo puts memory back', chat.undoLast() && mem(m, 0x3100, 2).join() === '0,0');
    check('the older restore point restores the first turn: the program is gone and the PC is back', s.restoreClaude(0) && mem(m, 0x3000, 2).join() === '0,0' && m.cpu.pc === pc);
  }

  // ---- 2b. consent does not survive a reload: a fresh Session on the same stored settings asks again ----
  {
    const store = Emu.memoryStore();
    const s1 = new Emu.Session({ store }); s1.switchMachine('dragon64'); frames(s1, 40);
    s1.consent.asker = () => Promise.resolve().then(() => s1.consent.answer(true));
    const c1 = s1.startAsk({ backend: dead });
    const ok1 = await call(c1, 'assemble_and_load', { source: ' FCB 1\n', org: 0x3000 });
    check('the first session: Allow, and it is allowed for the visit', ok1.ok && s1.consent.allowed);
    const kept = JSON.stringify([...store.keys()].map((k) => [k, store.get(k)]));
    check('nothing stored by the first session records the consent', !/claude.?allowed|consent/i.test(kept), kept.slice(0, 200));
    // the page reloads: a new Session over the same store (and a new machine)
    const s2 = new Emu.Session({ store }); s2.switchMachine('dragon64'); frames(s2, 40);
    check('after a reload the switch is off again', s2.consent.allowed === false);
    const c2 = s2.startAsk({ backend: dead });
    const asked = [];
    const r0 = await call(c2, 'run', { target: 0x3000 });
    check('with no one to ask, a tool is refused on the fresh session (no-consent)', !r0.ok && r0.err.code === C.NO_CONSENT && s2.shownMachine.cpu.pc !== 0x3000);
    s2.consent.asker = (name) => { asked.push(name); Promise.resolve().then(() => s2.consent.answer(false)); };
    const r1 = await call(c2, 'assemble_and_load', { source: ' FCB 2\n', org: 0x3100 });
    check('the fresh session asks again, and a no changes nothing', asked.join() === 'assemble_and_load' && !r1.ok && r1.err.code === C.CONSENT_DECLINED && s2.shownMachine.ram[0x3100] === 0 && !s2.consent.allowed);
    // a restored snapshot or an opened settings export does not grant it either
    const snap = s1.shownMachine.snapshot();
    s2.shownMachine.restore(snap);
    check('restoring a snapshot taken while allowed does not allow', s2.consent.allowed === false);
  }

  // ---- 2c. the three consent codes, one test each: no-consent, consent-declined, stopped ----
  {
    const s = boot('dragon64');
    const chat = ask(s);
    const none = await call(chat, 'poke', { address: 0x3000, bytes: [1] });
    check('no-consent: no one can be asked, so the tool throws no-consent (and nothing changes)', !none.ok && none.err.code === C.NO_CONSENT && s.shownMachine.ram[0x3000] === 0);
    s.consent.asker = () => Promise.resolve().then(() => s.consent.answer(false));
    const declined = await call(chat, 'poke', { address: 0x3000, bytes: [1] });
    check('consent-declined: "Just tell me the fix" throws consent-declined', !declined.ok && declined.err.code === C.CONSENT_DECLINED && s.shownMachine.ram[0x3000] === 0);
    // a key the person pressed has paused Claude; Stop while the next action waits throws stopped
    s.consent.setAllowed(true);
    s.consent.paused = { held: { queue: [], stub: [] }, wake: [] };
    const waiting = call(chat, 'poke', { address: 0x3000, bytes: [1] });
    await Promise.resolve();
    check('stopped: while paused the action waits, and nothing is written', s.shownMachine.ram[0x3000] === 0 && s.consent.paused.wake.length === 1);
    s.stopClaude();
    const stopped = await waiting;
    check('stopped: Stop throws stopped, nothing was written, no restore point', !stopped.ok && stopped.err.code === C.STOPPED && s.shownMachine.ram[0x3000] === 0 && chat.undo.length === 0, stopped.ok ? '' : stopped.err.message);
  }

  // ---- 2d. type_text and press_break, each on its own: refused without consent (no-consent), then they act after it ----
  for (const [name, input] of [['type_text', { text: 'PRINT 1\n' }], ['press_break', {}]]) {
    const s = boot('dragon64');
    const chat = ask(s); const m = s.shownMachine;
    const queued = () => m.stubKeys.length + (m.typist ? m.typist.queue.length : 0);
    const r = await call(chat, name, input);
    check(`${name}: without consent it is refused with no-consent, queues no key and takes no restore point`, !r.ok && r.err.code === C.NO_CONSENT && queued() === 0 && chat.undo.length === 0 && !s.consent.allowed, r.ok ? JSON.stringify(r.out) : r.err.message);
    s.consent.asker = () => Promise.resolve().then(() => s.consent.answer(false));
    const d = await call(chat, name, input);
    check(`${name}: "Just tell me the fix" is refused with consent-declined and queues nothing`, !d.ok && d.err.code === C.CONSENT_DECLINED && queued() === 0 && chat.undo.length === 0);
    s.consent.asker = () => Promise.resolve().then(() => s.consent.answer(true));
    // both settle once the machine has read the keys (or not), so they run with frames. The stub here takes typed
    // key codes but reads no matrix key, so BREAK is not read: press_break says so rather than claiming a press
    const taken = m.stubKeysTaken;
    const ok = await callFrames(s, chat, name, input);
    if (name === 'type_text') {
      check(`${name}: after Allow it acts: one restore point, keys delivered, and the result is JSON`, ok.ok && chat.undo.length === 1 && s.consent.allowed
        && m.stubKeysTaken - taken === 8 && JSON.stringify(ok.out) === '{"requested":8,"consumed":8,"lines_requested":1,"lines_delivered":1}', ok.ok ? JSON.stringify(ok.out) : ok.err.message);
    } else {
      check(`${name}: after Allow it acts (one restore point) and says the stub did not read BREAK: not-consumed, nothing left queued`, !ok.ok && ok.err.code === C.NOT_CONSUMED
        && /key 1 \(BREAK\) was not read by the machine/.test(ok.err.message) && /"consumed":0/.test(ok.err.message) && chat.undo.length === 1 && s.consent.allowed && queued() === 0, ok.ok ? JSON.stringify(ok.out) : ok.err.message);
    }
  }

  // ---- 3. assemble_and_load: what it writes and reports, and that it does not start the machine ----
  {
    const s = boot('dragon64');
    s.consent.setAllowed(true);
    const chat = ask(s);
    const m = s.shownMachine, pc = m.cpu.pc;
    const r = await call(chat, 'assemble_and_load', { source: 'START LDA #$41\n      STA $4000\n      BRA START\n', org: 0x3000 });
    check('it succeeds', r.ok, r.ok ? '' : r.err.message);
    check('it reports the count, the range, the start, the symbols and nothing missed', r.out.bytes === 7 && JSON.stringify(r.out.ranges) === '[{"from":12288,"to":12294}]' && r.out.start === 0x3000 && r.out.symbols.START === 0x3000 && r.out.not_taken.length === 0, JSON.stringify(r.out));
    // hand-computed: LDA #$41 = 86 41; STA $4000 = B7 40 00; BRA START (next PC $3007, offset -7) = 20 F9
    check('the bytes are the instructions\' encodings', mem(m, 0x3000, 7).map(hex2).join(' ') === '86 41 b7 40 00 20 f9', mem(m, 0x3000, 7).map(hex2).join(' '));
    check('nothing is running yet: the PC has not moved', m.cpu.pc === pc);
    check('the symbols reach the debugger', s.labels && s.labels.get('START') === 0x3000);
    const rr = await call(chat, 'run', { target: 0x3000 });
    frames(s, 6);
    check('run starts it, and the program runs ($4000 written)', rr.ok && rr.out.how === 'jump' && rr.out.target === 0x3000 && m.ram[0x4000] === 0x41, rr.ok ? rr.out : rr.err.message);
  }

  // ---- 3b. a ROM-less machine is not reset, its RAM survives ----
  {
    const s = boot('coco');
    const m = s.shownMachine;
    check('(the CoCo here has no ROM: the stub)', m.useStub);
    s.consent.setAllowed(true);
    const chat = ask(s);
    m.ram[0x5000] = 0xAB; m.ram[0x6123] = 0xCD;
    const fsr = m.framesSinceReset, pc = m.cpu.pc;
    const r = await call(chat, 'assemble_and_load', { source: ' FCB $11,$22\n', org: 0x3000 });
    check('the stub keeps the RAM the call did not target', r.ok && m.ram[0x5000] === 0xAB && m.ram[0x6123] === 0xCD && mem(m, 0x3000, 2).join() === '17,34', r.ok ? '' : r.err.message);
    check('and it was not reset or run: frame counter and PC unchanged', m.framesSinceReset === fsr && m.cpu.pc === pc, `${fsr}->${m.framesSinceReset}`);
  }

  // ---- 4. errors: the model's own line numbers; nothing written ----
  {
    const s = boot('dragon64');
    s.consent.setAllowed(true);
    const chat = ask(s);
    const m = s.shownMachine;
    const r = await call(chat, 'assemble_and_load', { source: ' NOP\n LDA #\n', org: 0x3000 });
    check('an assembly error is the code assembly-failed, with the line of the source Claude wrote (not shifted by the ORG line)', !r.ok && r.err.code === C.ASSEMBLY_FAILED && /1 error/.test(r.err.tool.detail) && /line 2:/.test(r.err.tool.detail) && !/line 3:/.test(r.err.tool.detail), r.ok ? '' : r.err.message);
    check('and nothing is written, no restore point taken', mem(m, 0x3000, 2).join() === '0,0' && chat.undo.length === 0);
    const c = await call(chat, 'assemble_and_load', { source: ' ORG $5000\n NOP\n', org: 0x3000 });
    check('a source ORG that contradicts org is refused', !c.ok && c.err.code === C.ORG_CONFLICT && mem(m, 0x5000, 1)[0] === 0, c.ok ? '' : c.err.message);
    const bad = await call(chat, 'assemble_and_load', { source: ' NOP\n', org: 0x10000 });
    check('an org out of range is bad-address', !bad.ok && bad.err.code === C.BAD_ADDRESS);
    const frac = await call(chat, 'assemble_and_load', { source: ' NOP\n', org: 'x' });
    check('an org that is not a number is not-a-number', !frac.ok && frac.err.code === C.NOT_A_NUMBER);
    const empty = await call(chat, 'assemble_and_load', { source: '* nothing\n' });
    check('a source with no bytes is empty', !empty.ok && empty.err.code === C.EMPTY && chat.undo.length === 0);
    check('failures took no restore point', chat.undo.length === 0);
    const mc = boot('mc10'); mc.consent.setAllowed(true);
    const x = await call(ask(mc), 'assemble_and_load', { source: ' LDA #$41\n PSHS A\n', org: 0x4100 });
    check("the machine's own CPU decides the instruction set: 6809-only PSHS on an MC-10 is an error", !x.ok && x.err.code === C.ASSEMBLY_FAILED, x.ok ? '' : x.err.message);
    const y = await call(ask(mc), 'assemble_and_load', { source: ' LDAA #$41\n', org: 0x4100 });
    check('and 6803 source assembles there', y.ok && y.out.bytes === 2 && mc.shownMachine.ram[0x4100] === 0x86, y.ok ? '' : y.err.message);
  }

  // ---- 5. the write is counted by the machine and read back; what did not take is named; nothing landed is not-ram ----
  {
    // our own ROM image, every byte $FF, in the BASIC socket (no one else's ROM): a byte written there that is
    // $FF is the byte it already holds, so only the map can say it did not take
    const rom = new Uint8Array(0x4000).fill(0xFF);
    const d = boot('dragon64'); d.shownMachine.setRoms({ basic: rom }); d.shownMachine.reset(true); frames(d, 4);
    d.consent.setAllowed(true);
    const chat = ask(d); const m = d.shownMachine;
    const notRam = (r) => !r.ok && r.err.code === C.NOT_RAM;
    // a write that lands nowhere is the error not-ram: no restore point, nothing changed, nothing hidden underneath
    const snap0 = Emu.state.toJSON(m.snapshot());
    for (const [label, addr, byte] of [['ROM, a different byte', 0x9000, 0x12], ['ROM, the byte it already holds', 0x9000, 0xFF], ['the vector page', 0xFFF0, 0xFF],
      ['the cartridge window', 0xC000, 0x00], ['I/O', 0xFF40, 0xFF], ['I/O (a PIA register)', 0xFF20, 0x55]]) {
      turn(chat);
      const a = await call(chat, 'assemble_and_load', { source: ` FCB $${byte.toString(16)}\n`, org: addr });
      const k = await call(chat, 'poke', { address: addr, bytes: [byte] });
      check(`${label}: assemble_and_load and poke both say not-ram, and nothing changed`, notRam(a) && notRam(k) && chat.undo.length === 0 && Emu.state.toJSON(m.snapshot()) === snap0,
        `${a.ok ? JSON.stringify(a.out) : a.err.code} / ${k.ok ? JSON.stringify(k.out) : k.err.code}`);
    }
    // the classification itself (why), for the single bytes above: ChatSession.notTaken is what both tools report from
    check('classification: ROM, even for the byte it holds', JSON.stringify(chat.notTaken(0x9000, [0xFF])) === gap(0x9000, 0x9000, 'rom'));
    check('classification: the vector page $FFE0-$FFFF is ROM', JSON.stringify(chat.notTaken(0xFFF0, [0xFF])) === gap(0xFFF0, 0xFFF0, 'rom'));
    check('classification: the cartridge window $C000-$DFFF is ROM, fitted or not', JSON.stringify(chat.notTaken(0xC000, [0])) === gap(0xC000, 0xC000, 'rom'));
    check('classification: I/O is I/O', JSON.stringify(chat.notTaken(0xFF40, [0xFF])) === gap(0xFF40, 0xFF40, 'io'));
    const ok = await call(chat, 'assemble_and_load', { source: ' FCB $12\n', org: 0x3000 });
    check('RAM takes it: written 1, skipped 0, not_taken empty', ok.ok && ok.out.written === 1 && ok.out.skipped === 0 && nt(ok) === '[]', JSON.stringify(ok.out));
    // a partial write is reported as one: the count the machine gives, and exactly the bytes that missed
    turn(chat);
    const mix = await call(chat, 'assemble_and_load', { source: ' ORG $7FFE\n FCB $01,$02,$03,$04\n' });
    check('a program running from RAM into ROM: written 2, skipped 2, and names exactly the bytes that missed', mix.ok && mix.out.bytes === 4 && mix.out.written === 2 && mix.out.skipped === 2
      && nt(mix) === gap(0x8000, 0x8001, 'rom') && m.ram[0x7FFE] === 1 && m.ram[0x7FFF] === 2 && chat.undo.length === 2, JSON.stringify(mix.out));
    turn(chat);
    const pm = await call(chat, 'poke', { address: 0x7FFE, bytes: [9, 8, 7, 6] });
    check('poke across the RAM/ROM edge: written 2, skipped 2, the ROM bytes are not_taken', pm.ok && pm.out.written === 2 && pm.out.skipped === 2 && pm.out.length === 4
      && nt(pm) === gap(0x8000, 0x8001, 'rom') && m.ram[0x7FFE] === 9 && m.ram[0x7FFF] === 8, JSON.stringify(pm.out));
    check('and the same bytes did not land anywhere hidden (the ROM image underneath is untouched)', m.peek ? m.peek(0x8000) === 0xFF : true);

    // MC-10: $0080-$00FF is on-chip RAM (takes), $BFFF is a latch (does not)
    const mc = boot('mc10'); mc.consent.setAllowed(true);
    const mchat = ask(mc);
    const iram = await call(mchat, 'assemble_and_load', { source: ' FCB $5A\n', org: 0x0090 });
    check('MC-10: $0080-$00FF is on-chip RAM and takes the write', iram.ok && iram.out.written === 1 && nt(iram) === '[]' && mc.shownMachine.ram[0x90] === 0x5A, JSON.stringify(iram.ok ? iram.out : iram.err.code));
    const latch = await call(mchat, 'assemble_and_load', { source: ' FCB $FF\n', org: 0xBFFF });
    check('MC-10: $BFFF is a latch: not-ram, even for $FF', notRam(latch) && JSON.stringify(mchat.notTaken(0xBFFF, [0xFF])) === gap(0xBFFF, 0xBFFF, 'latch'));
    const mrom = await call(mchat, 'poke', { address: 0xE000, bytes: [1] });
    check('MC-10: the ROM at $E000 is not-ram', notRam(mrom));
    const mpart = await call(mchat, 'poke', { address: 0xBFFE, bytes: [1, 2] });
    check('MC-10: a poke straddling $BFFF reports what landed', mpart.ok ? mpart.out.written === 1 || mpart.out.written === 2 : notRam(mpart), JSON.stringify(mpart.ok ? mpart.out : mpart.err.code));

    // CoCo (SAM, 4 ROM-less): the same on the stub machine
    const cc = boot('coco'); cc.consent.setAllowed(true);
    const cchat = ask(cc);
    const cio = await call(cchat, 'poke', { address: 0xFF22, bytes: [0xFF] });
    check('CoCo: an I/O address is not-ram', notRam(cio));
    const cram = await call(cchat, 'poke', { address: 0x3000, bytes: [5] });
    check('CoCo: RAM takes a poke', cram.ok && cram.out.written === 1 && cc.shownMachine.ram[0x3000] === 5);

    // CoCo 3: the vector page is ROM through the GIME too
    const c3 = boot('coco3'); c3.consent.setAllowed(true);
    const v3 = await call(ask(c3), 'assemble_and_load', { source: ' FCB $FF\n', org: 0xFFFE });
    check('CoCo 3: the vector page is not-ram', notRam(v3));
    const p3 = await call(ask(c3), 'poke', { address: 0xFF90, bytes: [1] });
    check('CoCo 3: the I/O page is not-ram', notRam(p3));
  }

  // ---- 5a. the poke half: on the Dragon 64 Plus a poke goes where the CPU's write goes, through the selected RAM bank ----
  {
    const s = boot('d64plus'); s.consent.setAllowed(true);
    const chat = ask(s); const m = s.shownMachine;
    check('(the Dragon 64 Plus here has no ROM, and its banks reach memory)', !m.hasRom && m.banksReachMemory !== false);
    const cpuRead = (a) => m.read(a);
    m.write(0xFFE2, 0x00);                                   // standard RAM
    await call(chat, 'poke', { address: 0x3000, bytes: [0x11] });
    check('standard RAM: the tool\'s write is what the CPU reads', cpuRead(0x3000) === 0x11, `$${cpuRead(0x3000).toString(16)}`);
    m.write(0xFFE2, 0x02);                                   // bank A
    check('bank A is selected and has its own $3000 (the CPU reads 0 there)', m.pramBank === 1 && cpuRead(0x3000) === 0x00);
    turn(chat);
    const pa = await call(chat, 'poke', { address: 0x3000, bytes: [0x77] });
    check('bank A: the poke changes what the CPU reads, and reports it landed', pa.ok && pa.out.written === 1 && cpuRead(0x3000) === 0x77, pa.ok ? JSON.stringify(pa.out) : pa.err.code);
    check('bank A: peek and poke agree (the tool reads back through the same map it wrote through)', m.peek(0x3000) === 0x77 && m.peek(0x3000) === cpuRead(0x3000));
    const aa = await call(chat, 'assemble_and_load', { source: ' FCB $5A,$5B\n', org: 0x3100 });
    check('bank A: assemble_and_load lands in the bank the CPU sees', aa.ok && aa.out.written === 2 && cpuRead(0x3100) === 0x5A && cpuRead(0x3101) === 0x5B, aa.ok ? JSON.stringify(aa.out) : aa.err.code);
    m.write(0xFFE2, 0x00);
    check('back on standard RAM the first value is still there (the poke did not touch it)', cpuRead(0x3000) === 0x11 && cpuRead(0x3100) === 0x00);
    const crtc = await call(chat, 'poke', { address: 0xFFE1, bytes: [1] });
    check('the CRTC ports are I/O: not-ram', !crtc.ok && crtc.err.code === C.NOT_RAM && JSON.stringify(chat.notTaken(0xFFE1, [1])) === gap(0xFFE1, 0xFFE1, 'io'));
  }

  // ---- 5c. a not-ram answer changes nothing at all (no hidden RAM under the ROM), on every family; and every acting tool leaves a restore point ----
  {
    for (const id of ['coco3', 'dragon64', 'mc10', 'd64plus']) {
      const s = boot(id); s.consent.setAllowed(true);
      const chat = ask(s); const m = s.shownMachine;
      // an address the map calls ROM (or, on the MC-10, undecoded: on-chip RAM while its control register is off)
      if (id === 'mc10') m.cpu.ramc = 0;
      const addrs = id === 'mc10' ? [0x0090, 0xE100, 0xBFFF] : [0xA000, 0xC100, 0xFFF0, 0xFF40];
      const before = Emu.state.toJSON(m.snapshot());
      for (const addr of addrs) {
        turn(chat);
        const kind = chat.target.writeKind(addr);
        const k = await call(chat, 'poke', { address: addr, bytes: [0x5A] });
        const a2 = await call(chat, 'assemble_and_load', { source: ' FCB $5A\n', org: addr });
        check(`${id} $${addr.toString(16).toUpperCase()} (${kind}): both tools say not-ram and the whole machine state is byte-identical (nothing hidden underneath), no restore point`,
          kind && !k.ok && k.err.code === C.NOT_RAM && !a2.ok && a2.err.code === C.NOT_RAM && Emu.state.toJSON(m.snapshot()) === before && chat.undo.length === 0,
          `${kind} ${k.ok ? JSON.stringify(k.out) : k.err.code} ${a2.ok ? JSON.stringify(a2.out) : a2.err.code}`);
      }
      // the MC-10's on-chip RAM, once its control register is on, takes the same write and says so
      if (id === 'mc10') {
        m.cpu.ramc = 0x40;
        const on = await call(chat, 'poke', { address: 0x0090, bytes: [0x5A] });
        check('mc10: with the on-chip RAM enabled $0090 takes the write, and the CPU reads it', on.ok && on.out.written === 1 && m.cpu.read8(0x90) === 0x5A, on.ok ? JSON.stringify(on.out) : on.err.code);
      }
      // every acting tool takes the turn's restore point BEFORE it changes anything, and Undo returns the machine to it
      for (const [name, input] of [['poke', { address: 0x3000, bytes: [1, 2] }], ['assemble_and_load', { source: ' FCB 7\n', org: 0x4100 }], ['type_text', { text: 'AB' }], ['press_break', {}], ['run', { target: 0x4100 }]]) {
        const s2 = boot(id); s2.consent.setAllowed(true);
        const c2 = ask(s2); const m2 = s2.shownMachine;
        if (id === 'mc10' && name === 'poke') input.address = 0x4200;
        const was = Emu.state.toJSON(m2.snapshot());
        // type_text and press_break answer once the machine has read their keys (or not), so they run with frames (the
        // restore point is the machine before the first key, so Undo still returns to `was`). These machines have no
        // ROM: the stub reads typed key codes but no BREAK, so press_break acts and then says not-consumed
        const keyed = name === 'type_text' || name === 'press_break';
        const acted = (x) => (name === 'press_break' ? !x.ok && x.err.code === C.NOT_CONSUMED : x.ok);
        const r = keyed ? await callFrames(s2, c2, name, input) : await call(c2, name, input);
        check(`${id}: ${name} takes a restore point holding the machine as it was, and Undo returns to it`,
          acted(r) && c2.undo.length === 1 && Emu.state.toJSON(c2.undo[0]) === was && c2.undoLast() && Emu.state.toJSON(m2.snapshot()) === was,
          r.ok ? JSON.stringify(r.out) : r.err.code);
        // and through the Session's own mechanism the page uses (restoreClaude, the "Restore to before Claude's changes" button)
        const s3 = boot(id); s3.consent.setAllowed(true);
        const c3 = ask(s3); const m3 = s3.shownMachine;
        const inp3 = name === 'poke' && id === 'mc10' ? { ...input, address: 0x4200 } : input;
        const was3 = Emu.state.toJSON(m3.snapshot());
        const r3 = keyed ? await callFrames(s3, c3, name, inp3) : await call(c3, name, inp3);
        const pts = s3.claudePoints.length;
        check(`${id}: ${name}: Session.restoreClaude() puts the machine (RAM, CPU registers, everything) back exactly to before the act`,
          acted(r3) && pts === 1 && s3.restoreClaude() && Emu.state.toJSON(m3.snapshot()) === was3 && s3.claudePoints.length === 0, r3.ok ? `${pts} points` : r3.err.code);
      }
    }
  }

  // ---- 5b. review fixes: past $FFFF, hidden RAM under ROM, a turn that ends mid-call ----
  {
    const s = boot('dragon64'); s.consent.setAllowed(true);
    const chat = ask(s); const m = s.shownMachine;
    const w = await call(chat, 'assemble_and_load', { source: ' ORG $FFFF\n FCB 1,2,3\n' });
    check('a program running past $FFFF is refused and wraps nothing onto page zero', !w.ok && w.err.code === C.PAST_END && m.ram[0] === 0 && m.ram[1] === 0 && chat.undo.length === 0, w.ok ? '' : w.err.message);
    const h = await call(chat, 'assemble_and_load', { source: ' FCB $AA\n', org: 0x9000 });
    check('a byte that cannot land is not-ram, and is not hidden in the RAM under the ROM', !h.ok && h.err.code === C.NOT_RAM && m.ram[0x9000] === 0, h.ok ? '' : h.err.message);
    // Stop pressed while the INCLUDEs are being read: nothing is written
    const s2 = boot('dragon64'); s2.consent.setAllowed(true);
    const c2 = ask(s2, { include: async () => { c2.controller = new AbortController(); c2.controller.abort(); return ' FCB 7\n'; } });
    const st = await call(c2, 'assemble_and_load', { source: ' INCLUDE "a.inc"\n', org: 0x3000 });
    check('a turn stopped while INCLUDEs were read writes nothing', !st.ok && st.err.code === C.STOPPED && s2.shownMachine.ram[0x3000] === 0 && c2.undo.length === 0, st.ok ? '' : st.err.message);
  }

  // ---- 6. run: target forms, validation before the restore point, RUN ----
  {
    const s = boot('dragon64');
    s.consent.setAllowed(true);
    const chat = ask(s);
    const m = s.shownMachine;
    for (const [input, want] of [[0x3000, 0x3000], ['$3000', 0x3000], ['0x3000', 0x3000], ['3000', 0x3000], [0x4000, 0x4000]]) {
      m.cpu.jump(0x2000);
      const r = await call(chat, 'run', { target: input });
      check(`run accepts ${JSON.stringify(input)}`, r.ok && m.cpu.pc === want, r.ok ? `PC $${m.cpu.pc.toString(16)}` : r.err.message);
    }
    // failures take no restore point: fill the stack to the cap, then fail many times, nothing is evicted
    for (let i = 0; i < 12; i++) { turn(chat); await call(chat, 'run', { target: 0x3000 }); }
    check('the restore point stack is capped at 10', chat.undo.length === 10);
    const oldest = chat.undo[0];
    for (const bad of [0x1FFFF, -1, 'banana', '$zz', 1.5, {}]) {
      turn(chat);
      const r = await call(chat, 'run', { target: bad });
      check(`run refuses ${JSON.stringify(bad)} and takes no restore point`, !r.ok && r.err.code === C.BAD_TARGET && chat.undo.length === 10 && chat.undo[0] === oldest, r.ok ? '' : r.err.message);
    }
    const nr = await call(chat, 'run', { target: 'RUN' });
    check('"RUN" with no BASIC ROMs is refused with a reason, before any restore point', !nr.ok && nr.err.code === C.NO_BASIC && chat.undo[0] === oldest, nr.ok ? '' : nr.err.message);
    const nr2 = await call(chat, 'run', {});
    check('run with no target is "RUN", and is refused the same way here', !nr2.ok && nr2.err.code === C.NO_BASIC);
  }

  // ---- 6b. the RUN contract: our own firmware in the BASIC socket scans the keyboard matrix and records keys ----
  {
    // PIA0 as in tests/press-break.test.js: port B drives the columns (active low), port A reads the rows.
    // Every new press (a bit that goes from 1 to 0 in a column's row byte) is appended to a log at $0340 ($4350 on the MC-10) as
    // column*8+row; $0300 counts them. The firmware never halts; the test reads RAM.
    const fw6809 = `
        ORG     $8000
START   LDS     #$3F00
        LDA     #$5A
        STA     $0301
        CLR     $FF03
        LDA     #$FF
        STA     $FF02
        LDA     #$04
        STA     $FF03
        CLR     $FF01
        CLR     $FF00
        LDA     #$04
        STA     $FF01
        LDA     #$FF
        STA     $FF02
        CLR     $0300
        LDU     #$0340
        LDX     #$0320
        LDB     #8
INIT    LDA     #$FF
        STA     ,X+
        DECB
        BNE     INIT
LOOP    CLRB
COL     STB     $0331
        LDX     #STB
        LDA     B,X
        STA     $FF02
        LDA     $FF00
        ORA     #$80
        STA     $0330
        LDX     #$0320
        LDB     $0331
        LDA     B,X
        STA     $0334
        LDA     $0330
        COMA
        ANDA    $0334
        STA     $0333
        LDA     $0330
        STA     B,X
        LDA     $0333
        BEQ     NEXT
        CLR     $0332
BIT     LSRA
        BCC     NOB
        PSHS    A
        LDA     $0331
        LSLA
        LSLA
        LSLA
        ORA     $0332
        STA     ,U+
        INC     $0300
        PULS    A
NOB     INC     $0332
        TSTA
        BNE     BIT
NEXT    LDB     $0331
        INCB
        CMPB    #8
        BNE     COL
        BRA     LOOP
STB     FCB     $FE,$FD,$FB,$F7,$EF,$DF,$BF,$7F
`;
    // the MC-10 (6803): port 1 ($02) drives the columns, $BFFF reads the rows (tests/press-break.test.js)
    const fw6803 = `
        ORG     $E000
START   LDS     #$01FF
        LDA     #$5A
        STA     $4301
        LDA     #$FF
        STA     $00
        CLR     $4300
        LDX     #$4350
        STX     $4340
        LDX     #$4320
        LDB     #8
INIT    LDA     #$FF
        STA     0,X
        INX
        DECB
        BNE     INIT
LOOP    CLRB
COL     STB     $4331
        LDX     #STB
        ABX
        LDA     0,X
        STA     $02
        LDA     $BFFF
        ORA     #$80
        STA     $4330
        LDX     #$4320
        LDB     $4331
        ABX
        LDA     0,X
        STA     $4334
        LDA     $4330
        COMA
        ANDA    $4334
        STA     $4333
        LDA     $4330
        STA     0,X
        LDA     $4333
        BEQ     NEXT
        CLR     $4332
BIT     LSRA
        BCC     NOB
        PSHA
        LDX     $4340
        LDA     $4331
        ASLA
        ASLA
        ASLA
        ORA     $4332
        STA     0,X
        INX
        STX     $4340
        INC     $4300
        PULA
NOB     INC     $4332
        TSTA
        BNE     BIT
NEXT    LDB     $4331
        INCB
        CMPB    #8
        BNE     COL
        BRA     LOOP
STB     FCB     $FE,$FD,$FB,$F7,$EF,$DF,$BF,$7F
`;
    const SLOT = { dragon64: 0x4000, coco3: 0x8000, mc10: 0x2000 };
    for (const id of ['dragon64', 'coco3', 'mc10']) {
      const six = id === 'mc10' ? '6803' : '6809';
      const base = id === 'mc10' ? 0x4300 : 0x0300;
      const asm = Emu.assemble(six === '6803' ? fw6803 : fw6809, six);
      if (!asm.ok) { check(`${id}: the scanning firmware assembles`, false, asm.errors.map((e) => `line ${e.line}: ${e.message}`).join('; ')); continue; }
      const rom = new Uint8Array(SLOT[id]).fill(0xFF);
      rom.set(asm.segments[0].data, 0);
      const s = new Emu.Session({ store: Emu.memoryStore() });
      s.switchMachine(id);
      s.shownMachine.setRoms({ basic: rom });
      s.shownMachine.reset(true);
      s.shownMachine.cpu.jump(asm.exec);
      frames(s, 6);
      const m = s.shownMachine;
      check(`${id}: our firmware is the BASIC ROM and it ran`, m.hasRom && m.ram[base + 1] === 0x5A && m.ram[base] === 0, `marker $${m.ram[base + 1].toString(16)}`);
      s.consent.setAllowed(true);
      const chat = ask(s);
      // RUN is typed the paced way, so the call settles once the firmware has read every key (it runs with frames)
      const r = await callFrames(s, chat, 'run', { target: 'RUN' });
      frames(s, 10);
      const count = m.ram[base];
      const got = Array.from({ length: count }, (_, i) => m.ram[base + 0x40 + i + (id === 'mc10' ? 0x10 : 0)]);
      // expected: the matrix position of each key, [row, column] -> column*8+row, from the machine's own layout
      const want = ['R', 'U', 'N', 'ENTER'].map((k) => m.keyPos[k][1] * 8 + m.keyPos[k][0]);
      check(`${id}: run("RUN") delivers R, U, N, ENTER to firmware scanning the matrix, in order, and reports them consumed`, r.ok && r.out.how === 'typed' && r.out.target === 'RUN' && got.join() === want.join()
        && JSON.stringify(r.out) === '{"how":"typed","target":"RUN","requested":4,"consumed":4,"lines_requested":1,"lines_delivered":1}',
        `${r.ok ? '' : r.err.message} got [${got.map((g) => g.toString(16))}] want [${want.map((g) => g.toString(16))}]`);
      check(`${id}: RUN took one restore point and undo clears what was still queued`, chat.undo.length === 1);
      // The same class for type_text: it says it typed 2 characters, and the firmware sees exactly those two keys
      turn(chat);
      const c0 = m.ram[base];
      const tt = await callFrames(s, chat, 'type_text', { text: 'UR' });
      frames(s, 10);
      const got2 = Array.from({ length: m.ram[base] - c0 }, (_, i) => m.ram[base + 0x40 + (id === 'mc10' ? 0x10 : 0) + c0 + i]);
      const want2 = ['U', 'R'].map((k) => m.keyPos[k][1] * 8 + m.keyPos[k][0]);
      check(`${id}: type_text says the machine consumed 2 keys and firmware scanning the matrix sees exactly U, R`, tt.ok && tt.out.consumed === 2 && tt.out.requested === 2 && got2.join() === want2.join(), `${tt.ok ? JSON.stringify(tt.out) : tt.err.code} got [${got2.map((g) => g.toString(16))}] want [${want2.map((g) => g.toString(16))}]`);
      // press_break, held the paced way: consumed, and the firmware logs BREAK as the one new key
      turn(chat);
      const c1 = m.ram[base];
      const pb = await callFrames(s, chat, 'press_break', {});
      frames(s, 10);
      const got3 = Array.from({ length: m.ram[base] - c1 }, (_, i) => m.ram[base + 0x40 + c1 + i + (id === 'mc10' ? 0x10 : 0)]);
      const want3 = [m.keyPos.BREAK[1] * 8 + m.keyPos.BREAK[0]];
      check(`${id}: press_break on firmware scanning the matrix: consumed, and the firmware saw exactly BREAK`, pb.ok && JSON.stringify(pb.out) === '{"requested":1,"consumed":1}' && got3.join() === want3.join(),
        `${pb.ok ? JSON.stringify(pb.out) : pb.err.message} got [${got3.map((g) => g.toString(16))}] want [${want3.map((g) => g.toString(16))}]`);
    }
  }

  // ---- 7. INCLUDE: only through the injected reader ----
  {
    const s = boot('dragon64'); s.consent.setAllowed(true);
    // a fetch that would serve the file: the tool must not reach for it (nothing is fetched by the tool itself)
    const realFetch = globalThis.fetch; let fetched = 0;
    globalThis.fetch = async () => { fetched++; return { ok: true, text: async () => 'TABLE FCB $11\n' }; };
    let none;
    try { none = await call(ask(s), 'assemble_and_load', { source: ' INCLUDE "data.inc"\n', org: 0x3000 }); } finally { globalThis.fetch = realFetch; }
    check('with no reader nothing is fetched, even with a fetch that would answer', fetched === 0, `${fetched} fetches`);
    check('with no reader an INCLUDE is an assembler error', !none.ok && none.err.code === C.ASSEMBLY_FAILED && /data\.inc/.test(none.err.tool.detail) && mem(s.shownMachine, 0x3000, 1)[0] === 0, none.ok ? '' : none.err.message);
    const s2 = boot('dragon64'); s2.consent.setAllowed(true);
    const asked = [];
    const files = { 'data.inc': 'TABLE FCB $11,$22,$33\n', 'nest.inc': ' INCLUDE "data.inc"\n FCB $44\n' };
    const chat = ask(s2, { include: async (name) => { asked.push(name); return files[name] ?? null; } });
    const r = await call(chat, 'assemble_and_load', { source: ' INCLUDE "nest.inc"\n', org: 0x3000 });
    check('with a reader, INCLUDE resolves (nested too) through it and only it', r.ok && r.out.bytes === 4 && mem(s2.shownMachine, 0x3000, 4).join() === '17,34,51,68' && asked.join() === 'nest.inc,data.inc', `${asked} ${r.ok ? '' : r.err.message}`);
    const miss = await call(chat, 'assemble_and_load', { source: ' INCLUDE "gone.inc"\n', org: 0x3100 });
    check('a file the reader does not have is an error, nothing written', !miss.ok && miss.err.code === C.ASSEMBLY_FAILED && mem(s2.shownMachine, 0x3100, 1)[0] === 0);

    // the page's reader: examples/ only, and a guard before any request
    const urls = [];
    const read = Emu.exampleReader(async (u) => { urls.push(u); return { ok: true, text: async () => `text of ${u}` }; });
    check('the page reader reads examples/<name>', await read('liza-data.inc') === 'text of examples/liza-data.inc' && urls.join() === 'examples/liza-data.inc');
    check('and a name in a sub-folder', await read('lib/x.inc') === 'text of examples/lib/x.inc');
    urls.length = 0;
    const hostile = ['../js/session.js', '..', 'a/../../b', '/etc/passwd', 'https://evil.example/x', '//evil.example/x', 'a\\b', 'a/./b', '', '.hidden', 'x y', 'a%2e%2e/b', 'a?b', 'a#b', null, 42];
    const results = await Promise.all(hostile.map((h) => read(h)));
    check('traversal, absolute, scheme and odd names never reach fetch', results.every((x) => x === null) && urls.length === 0, `${urls}`);
    const failing = Emu.exampleReader(async () => { throw new Error('offline'); });
    check('a failing fetch is "not found"', await failing('a.inc') === null);
    const notFound = Emu.exampleReader(async () => ({ ok: false }));
    check('an HTTP error is "not found"', await notFound('a.inc') === null);
  }

  // ---- 8. the key stays out ----
  {
    const KEY = 'sk-ant-ACT-TEST-KEY-0123456789';
    const s = boot('dragon64'); s.setClaudeKey(KEY); s.consent.setAllowed(true);
    const chat = ask(s);
    const r = await call(chat, 'assemble_and_load', { source: ' LDA #$41\n', org: 0x3000 });
    await call(chat, 'run', { target: 0x3000 });
    const ramText = Buffer.from(s.shownMachine.ram).toString('latin1');
    check('the key is in no tool schema, no tool result, no machine RAM and no snapshot', !JSON.stringify(Emu.machineTools()).includes(KEY) && !JSON.stringify(r.out).includes(KEY)
      && !ramText.includes(KEY) && !Emu.state.toJSON(s.shownMachine.snapshot()).includes(KEY) && !Emu.state.toJSON(chat.undo[0]).includes(KEY));
  }

  // ---- 9. the contract for a model: schemas, consent wording, JSON results, coded errors (poke, type_text, press_break too) ----
  {
    const tools = Emu.actingTools();
    check('the acting schemas name exactly the consent gate\'s ACTING_TOOLS', JSON.stringify(tools.map((t) => t.name).sort()) === JSON.stringify([...Emu.ACTING_TOOL_NAMES].sort()), tools.map((t) => t.name).join());
    check('no read-only tool is in the gate, and the two halves name every tool exactly once',
      Emu.READ_ONLY_TOOLS.every((x) => !Emu.ACTING_TOOL_NAMES.includes(x)) && Emu.machineTools().length === Emu.READ_ONLY_TOOLS.length + Emu.ACTING_TOOL_NAMES.length
      && new Set(Emu.machineTools().map((t) => t.name)).size === Emu.machineTools().length);
    // every acting tool is behind the consent gate: with a gate that says no, each is refused and nothing changes
    {
      const sg = boot('dragon64'); const cg = ask(sg); const before = Emu.state.toJSON(sg.shownMachine.snapshot());
      const asked = [];
      sg.consent.asker = (name) => { asked.push(name); Promise.resolve().then(() => sg.consent.answer(false)); };
      const inputs = { poke: { address: 0x3000, bytes: [1] }, type_text: { text: 'X' }, press_break: {}, assemble_and_load: { source: ' NOP\n', org: 0x3000 }, run: { target: 0x3000 }, load_basic: { program: '10 END' } };
      // load_basic has its own card on every call, after its program is checked: on this machine (no BASIC ROMs)
      // the check refuses it with no-basic before anyone is asked (its card is tested in tests/basic-load.test.js)
      const general = Emu.ACTING_TOOL_NAMES.filter((x) => x !== 'load_basic');
      const codes = [];
      for (const name of Emu.ACTING_TOOL_NAMES) { const r = await call(cg, name, inputs[name]); codes.push(r.ok ? 'RAN' : r.err.code); }
      check('every acting tool (assemble_and_load and run included) is gated: each asks, is refused, and nothing changes',
        Emu.ACTING_TOOL_NAMES.includes('assemble_and_load') && Emu.ACTING_TOOL_NAMES.includes('run') && asked.join() === general.join()
        && codes[Emu.ACTING_TOOL_NAMES.indexOf('load_basic')] === C.NO_BASIC && codes.filter((c) => c === C.CONSENT_DECLINED).length === general.length
        && Emu.state.toJSON(sg.shownMachine.snapshot()) === before && cg.undo.length === 0, `${codes}`);
    }
    // load_basic is not behind the consent question but has its own card on every call (js/session.js gateTools),
    // so its description says that and names its own codes; the others state the shared consent wording
    const general = tools.filter((t) => t.name !== 'load_basic'), lb = tools.find((t) => t.name === 'load_basic');
    check('every acting description but load_basic (actingTools()) states the consent it needs and both refusal codes', tools.length === Emu.ACTING_TOOL_NAMES.length && general.length === tools.length - 1
      && general.every((t) => /Needs "Let Claude use the emulator": the person is asked the first time/.test(t.description) && new RegExp(C.NO_CONSENT).test(t.description) && new RegExp(C.CONSENT_DECLINED).test(t.description)), general.map((t) => t.name).join());
    check('load_basic\'s description states its own card: asked on every call, "Don\'t ask again" only with the switch on, and the codes load-declined, no-consent and stopped (not the first-time consent wording)',
      /asked on every call, whether or not "Let Claude use the emulator" is on, unless they ticked "Don't ask again this session" \(offered only while that switch is on/.test(lb.description)
      && new RegExp(`error ${C.LOAD_DECLINED}`).test(lb.description) && new RegExp(C.NO_CONSENT).test(lb.description) && new RegExp(`Stop ${C.STOPPED}`).test(lb.description)
      && !/asked the first time/.test(lb.description) && !new RegExp(C.CONSENT_DECLINED).test(lb.description), lb.description.slice(-400));
    check('every acting description states its units or limits (addresses 0-65535, byte values, character limits)',
      /0-65535/.test(JSON.stringify(tools.find((t) => t.name === 'poke').input_schema)) && /0-255/.test(JSON.stringify(tools.find((t) => t.name === 'poke').input_schema))
      && /0-65535/.test(JSON.stringify(tools.find((t) => t.name === 'assemble_and_load').input_schema)) && /0-65535/.test(tools.find((t) => t.name === 'run').description)
      && /1 to \d+ characters/.test(tools.find((t) => t.name === 'type_text').description) && /\d+ to \d+ of them/.test(tools.find((t) => t.name === 'poke').description + JSON.stringify(tools.find((t) => t.name === 'poke').input_schema)));
    check('every acting parameter is typed and described with its unit or limits', tools.every((t) => Object.values(t.input_schema.properties).every((pr) => (pr.type || (pr.anyOf && pr.anyOf.every((alt) => alt.type))) && (pr.description || pr.maxLength || pr.items))), '');
    check('addresses are integers 0-65535 and say decimal', ['poke', 'assemble_and_load'].every((nm) => /[Dd]ecimal/.test(JSON.stringify(tools.find((t) => t.name === nm).input_schema))));
    const s = boot('dragon64'); s.consent.setAllowed(true);
    const chat = ask(s); const m = s.shownMachine;
    const err = async (name, input) => { const r = await call(chat, name, input); return r.ok ? `ok ${JSON.stringify(r.out)}` : r.err.code; };
    check('poke: bad-address / not-a-number', await err('poke', { address: 70000, bytes: [1] }) === C.BAD_ADDRESS && await err('poke', { address: '$30', bytes: [1] }) === C.NOT_A_NUMBER && await err('poke', { address: 1.5, bytes: [1] }) === C.NOT_A_NUMBER);
    check('poke: empty, bad-byte, too-long, past-end', await err('poke', { address: 0x3000, bytes: [] }) === C.EMPTY && await err('poke', { address: 0x3000 }) === C.EMPTY
      && await err('poke', { address: 0x3000, bytes: [256] }) === C.BAD_BYTE && await err('poke', { address: 0x3000, bytes: [-1] }) === C.BAD_BYTE && await err('poke', { address: 0x3000, bytes: [1.5] }) === C.NOT_A_NUMBER
      && await err('poke', { address: 0x3000, bytes: new Array(257).fill(1) }) === C.TOO_LARGE && await err('poke', { address: 0xFFFF, bytes: [1, 2] }) === C.PAST_END);
    check('poke: failures changed nothing and took no restore point', chat.undo.length === 0 && m.ram[0x3000] === 0);
    const pk = await call(chat, 'poke', { address: 0x3000, bytes: [9, 8] });
    check('poke: the result echoes the request as JSON', pk.ok && JSON.stringify(pk.out) === '{"address":12288,"length":2,"written":2,"skipped":0,"not_taken":[]}' && m.ram[0x3001] === 8, JSON.stringify(pk.out));
    const pr = await call(chat, 'poke', { address: 0xFFF0, bytes: [1] });
    check('poke: a byte that cannot land is not-ram', !pr.ok && pr.err.code === C.NOT_RAM, pr.ok ? JSON.stringify(pr.out) : pr.err.message);
    check('type_text: empty and too-long are coded, nothing typed', await err('type_text', { text: '' }) === C.EMPTY && await err('type_text', {}) === C.EMPTY && await err('type_text', { text: 'x'.repeat(Emu.TYPE_TEXT_MAX + 1) }) === C.TOO_LARGE);
    turn(chat);
    const tt = await callFrames(s, chat, 'type_text', { text: 'PRINT 1\n' });
    check('type_text: the result is what the machine consumed', tt.ok && JSON.stringify(tt.out) === '{"requested":8,"consumed":8,"lines_requested":1,"lines_delivered":1}', JSON.stringify(tt.out));
    const pb = await callFrames(s, chat, 'press_break', {});
    check('press_break: no ROMs, so nothing reads BREAK: not-consumed, coded', !pb.ok && pb.err.code === C.NOT_CONSUMED, pb.ok ? JSON.stringify(pb.out) : pb.err.message);
    check('an unknown tool is unknown-tool', await err('format_disk', {}) === C.UNKNOWN_TOOL);
    // every code a tool throws is in the shared table, with a remedy
    const thrown = [C.NO_CONSENT, C.CONSENT_DECLINED, C.STOPPED, C.EMPTY, C.BAD_BYTE, C.ASSEMBLY_FAILED, C.ORG_CONFLICT, C.NO_BASIC, C.BAD_TARGET, C.PAST_END, C.TOO_LARGE, C.BAD_ADDRESS, C.NOT_A_NUMBER, C.UNKNOWN_TOOL];
    check('every code the acting tools use has a remedy in TOOL_ERRORS', thrown.every((c) => typeof Emu.TOOL_ERRORS[c] === 'string' && Emu.TOOL_ERRORS[c].length > 10));
    // and the model receives them as JSON with is_error, through the real backend
    const KEY = 'sk-ant-ACT-TEST-KEY-0123456789';
    const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    const start = { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [] } };
    const toolTurn = (name, input) => sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }, { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: {} }, { type: 'message_stop' }]);
    const endTurn = sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }]);
    const bodies = [toolTurn('run', { target: 'banana' }), endTurn, toolTurn('assemble_and_load', { source: ' FCB 1\n', org: 0x3200 }), endTurn];
    const sent = [];
    const fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response(bodies[sent.length - 1], { status: 200, headers: { 'content-type': 'text/event-stream' } }); };
    const s3 = boot('dragon64'); s3.setClaudeKey(KEY); s3.consent.setAllowed(true);
    const c3 = s3.startAsk({ backend: new Emu.ClaudeBackend({ fetch, apiKey: KEY }) });
    await c3.sendLine('go');
    const res1 = sent[1].messages.slice(-1)[0].content[0];
    check('a coded failure reaches the model as {error:{code,remedy,detail}} with is_error', res1.is_error === true && JSON.parse(res1.content).error.code === C.BAD_TARGET && JSON.parse(res1.content).error.remedy === Emu.TOOL_ERRORS[C.BAD_TARGET] && JSON.parse(res1.content).error.detail === 'banana', res1.content);
    await c3.sendLine('again');
    const res2 = sent[3].messages.slice(-1)[0].content[0];
    check('a result reaches the model as JSON, not [object Object]', !res2.is_error && JSON.parse(res2.content).bytes === 1 && JSON.parse(res2.content).start === 0x3200, res2.content);
  }

  // ---- 8b. the key is in no file the Session writes: snapshot file, share file, share link, settings export, stored settings ----
  {
    const KEY = 'sk-ant-LEAK-TEST-KEY-9876543210abcdef';
    const store = Emu.memoryStore();
    const s = new Emu.Session({ store }); s.switchMachine('dragon64'); frames(s, 40);
    s.setClaudeKey(KEY); s.consent.setAllowed(true);
    const chat = ask(s);
    await call(chat, 'assemble_and_load', { source: ' FCB 1\n', org: 0x3000 });
    await call(chat, 'poke', { address: 0x3010, bytes: [2] });
    const bad = (text) => text.includes(KEY) || /sk-ant-/.test(text);
    // the whole file as written, un-gzipped (the decoded object would hide a key put in the file's own header fields)
    const decode = async (file) => require('zlib').gunzipSync(Buffer.from(file.bytes)).toString('latin1');
    const snapFile = await s.snapshotFile();
    const shared = await s.shareFile();
    const link = await s.longLink('https://example.invalid/play/');
    const exp = JSON.stringify(s.exportSettings());
    const stored = JSON.stringify([...store.keys()].map((k) => [k, store.get(k)]));
    check('the key is set in the key store (the test would be vacuous otherwise)', s.hasClaudeKey && s.keyStore.get() === KEY);
    check('Session.snapshotFile(): the whole file text has no trace of the key', !bad(await decode(snapFile)));
    check('Session.shareFile(): the whole file text has no trace of the key', !bad(await decode(shared)));
    // (the link's moment is compressed: its unpacked container is searched too)
    const linkBox = require('zlib').inflateRawSync(Buffer.from(Emu.fromBase64Url(new URL(link).hash.slice(3)).subarray(1))).toString('latin1');
    check('Session.longLink(): the link has no trace of the key (plain, as base64url, or in its unpacked moment)', /^#z=/.test(new URL(link).hash)
      && !bad(link) && !link.includes(Buffer.from(KEY).toString('base64url')) && !bad(linkBox));
    check('Session.exportSettings(): no trace of the key', !bad(exp), exp.slice(0, 120));
    check('the stored settings hold no trace of the key', !bad(stored));
    check('every restore point holds no trace of the key', chat.undo.every((u) => !bad(Emu.state.toJSON(u))));
  }

  console.log(`\n${n - fail}/${n} acting-tool checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
