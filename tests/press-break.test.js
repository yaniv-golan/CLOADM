// Run: node tests/press-break.test.js
//
// press_break delivers BREAK to the CPU on every family. The bug this pins: Session.pressBreak used to set
// the key down and up inside one call, so the matrix was never read between the two - the machine does not
// sample the keyboard, the CPU reads it through the PIA (or $BFFF on the MC-10) - and BREAK was never
// delivered at all.
//
// Oracle: our own firmware (written here, no one else's ROM) occupies the BASIC socket, scans the keyboard
// matrix itself, records what it sees into RAM and halts. The test reads RAM afterwards. The firmware is
// per family because the matrix is read through different ports:
//   6809 (Dragon 64, CoCo 3): PIA0 port B drives the COLUMNS low (active low), port A reads the ROWS
//                             (js/machines/cocopia.js: rows = ~keyRowsForCols(p0.b.outValue()))
//   6803 (MC-10):             port 1 drives the COLUMNS, $BFFF reads the ROWS
// BREAK is row 6, column 2 on all three layouts (js/machines/keyboards.js keyPos.BREAK === [6, 2]), so it
// appears as bit 6 of port A / $BFFF while column 2 alone is driven low.
const Emu = require('./load')();

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

// where the firmware leaves its findings: a ran-marker, then 'B' + a count if BREAK was seen, then a done byte.
// In RAM: the Dragon 64 and CoCo 3 have RAM from $0000, and the MC-10 from $4000, so the family picks the base.
const mark = (id) => (id === 'mc10' ? 0x4100 : 0x0300);

const fw6809 = (base) => `
        ORG     $8000
START   LDS     #$3F00
        LDA     #$5A
        STA     $${base.toString(16).toUpperCase()}           ; the firmware ran
        LDA     #$00
        STA     $FF03           ; PIA0 port B control: bit 2 clear, so the next write sets the DDR
        LDA     #$FF
        STA     $FF02           ; port B DDR: all output (the column select)
        LDA     #$04
        STA     $FF03           ; port B control: data register from here on
        LDA     #$00
        STA     $FF01           ; port A control: bit 2 clear
        LDA     #$00
        STA     $FF00           ; port A DDR: all input (the row read)
        LDA     #$04
        STA     $FF01           ; port A control: data register
        LDA     #$FF
        STA     $FF02           ; all columns high (idle)
; keep scanning until BREAK is seen, so the press can arrive frames later
POLL    LDA     #$FB            ; drive column 2 low, the rest high
        STA     $FF02
        LDA     $FF00           ; the rows
        ANDA    #$40            ; bit 6 = BREAK's row
        BNE     NOTYET          ; set = not pressed
        LDA     #'B'
        STA     $${(base + 1).toString(16).toUpperCase()}
        LDA     #1
        STA     $${(base + 2).toString(16).toUpperCase()}
        LDA     #$FF
        STA     $FF02           ; columns idle again
        LDA     #$A5
        STA     $${(base + 3).toString(16).toUpperCase()}     ; done
HALT    BRA     HALT
NOTYET  LDA     #$FF
        STA     $FF02           ; columns idle again
        BRA     POLL
`;

// 6803 firmware for $E000 (the MC-10's basic slot). On a 6803, $00 is Port 1 DDR, $01 is Port 2 DDR, $02 is
// Port 1 data and $03 is Port 2 data (MC6801/6803 internal register map) - so the column strobe is written to
// $02, and $01 is the wrong register. DDR1 must have BREAK's own column bit (bit 2) set as an output before
// $BFFF can show it: the gate is PER COLUMN, not whole-register (DDR1=$04 gives $bf, $fb gives $ff - measured
// on our core only; MAME 0.264 agrees with the DDR1=$FF readings the probe takes).
// (Settled against MAME 0.264: with this firmware in the socket, MAME accepts $02 as the strobe register and
// shows BREAK while column 2 is driven. Our core needs $02 as well, so there is no MC-10 core bug here.
// tools/mame-diff/mc10-strobe-probe.js is the probe that produced MAME's readings.)
//
// THREE readings, recorded after the key is held - a reading taken before the press proves nothing, because
// no key is down yet. The firmware first polls column 2 until BREAK appears, then records, in this order:
//   (1) no column driven   - $BFFF is exactly $FF (BREAK invisible)
//   (2) column 4 driven    - $BFFF is exactly $FF (the wrong column does not show BREAK)
//   (3) column 2 driven    - $BFFF is exactly $BF (BREAK's own column)
// (1) and (2) are what catch the wrong register: $01 leaves the machine's strobe at 0, and 0 drives every
// column, so BREAK shows in all three readings and only those two notice.
const fw6803 = (base) => `
        ORG     $E000
START   LDS     #$01FF
        LDA     #$5A
        STA     $${base.toString(16).toUpperCase()}           ; the firmware ran
        LDA     #$FF
        STA     $00             ; Port 1 DDR: all outputs (the column strobes)
; wait for BREAK on column 2, so the three readings below are taken while the key is actually held
WAIT    LDA     #$FB
        STA     $02
        LDA     $BFFF
        ANDA    #$40            ; bit 6 = BREAK's row (active low)
        BNE     WAIT
; (1) no column driven
        LDA     #$FF
        STA     $02
        LDA     $BFFF
        STA     $${(base + 6).toString(16).toUpperCase()}     ; no column driven
; (2) the wrong column
        LDA     #$EF
        STA     $02
        LDA     $BFFF
        STA     $${(base + 7).toString(16).toUpperCase()}     ; column 4 driven
; (3) BREAK's own column, read once more
        LDA     #$FB
        STA     $02
        LDA     $BFFF
        STA     $${(base + 8).toString(16).toUpperCase()}     ; column 2 driven
        LDA     #'B'
        STA     $${(base + 1).toString(16).toUpperCase()}
        LDA     #1
        STA     $${(base + 2).toString(16).toUpperCase()}
        ; leave column 2 driven (do NOT return the strobes to idle): the test samples the machine's strobe
        ; while the key is seen, and this is the value it must hold then
        LDA     #$A5
        STA     $${(base + 3).toString(16).toUpperCase()}
HALT    BRA     HALT
`;

// ROM size for each family's basic slot, so the firmware fits the socket the machine reads
const SLOT = { dragon64: 0x4000, coco3: 0x8000, mc10: 0x2000 };

const trial = (id, press) => {
  const cpu = id === 'mc10' ? '6803' : '6809';
  const base = mark(id);
  const res = Emu.assemble(cpu === '6803' ? fw6803(base) : fw6809(base), cpu);
  if (!res.ok) throw new Error(`${id}: firmware did not assemble: ${res.errors.map((e) => e.message).join('; ')}`);
  const rom = new Uint8Array(SLOT[id]).fill(0xFF);      // our own ROM image
  rom.set(res.segments[0].data, 0);
  const s = new Emu.Session();
  s.switchMachine(id);
  s.shownMachine.setRoms({ basic: rom });
  s.shownMachine.reset(true);
  s.shownMachine.cpu.jump(res.exec);                         // the reset vector is $FF, so start the firmware ourselves
  for (let i = 0; i < 4; i++) s.advance(1000 / s.shownMachine.fps + 0.01);
  const ran = s.shownMachine.ram[base] === 0x5A;
  if (press) s.pressBreak();
  for (let i = 0; i < 30; i++) s.advance(1000 / s.shownMachine.fps + 0.01);
  // the firmware polls until it sees BREAK, so "halted" is the done byte only when one was pressed; with
  // nothing pressed it is still polling, which is what the idle check means by "not seen"
  return { ran, done: s.shownMachine.ram[base + 3] === 0xA5, sawBreak: s.shownMachine.ram[base + 1] === 0x42 && s.shownMachine.ram[base + 2] === 1, strobe: s.shownMachine.strobe, m: s.shownMachine, base };
};

(async () => {
  for (const id of ['dragon64', 'coco3', 'mc10']) {
    const idle = trial(id, false);
    check(`${id}: the firmware ran`, idle.ran, `marker $${idle.m.ram[idle.base].toString(16)}`);
    check(`${id}: nothing pressed, BREAK not seen`, !idle.sawBreak, `seen $${idle.m.ram[idle.base + 1].toString(16)}`);
    check(`${id}: and it is still polling, not halted`, !idle.done, `done $${idle.m.ram[idle.base + 3].toString(16)}`);

    const pressed = trial(id, true);
    check(`${id}: press_break is seen by firmware scanning the matrix`, pressed.sawBreak,
      `seen $${pressed.m.ram[pressed.base + 1].toString(16)} count=${pressed.m.ram[pressed.base + 2]}`);
    check(`${id}: and the firmware halted after seeing it`, pressed.done, `done $${pressed.m.ram[pressed.base + 3].toString(16)}`);
    // The MC-10's three matrix readings, taken by the firmware itself with BREAK held. TWO of the three catch
    // the wrong strobe register: with the store on $01 the machine's strobe stays 0, 0 drives every column, and
    // BREAK shows in all three readings - so "no column driven" and "column 4 driven" both fail while "column 2
    // driven" is blind to it and passes.
    if (id === 'mc10') {
      const rb = (off) => pressed.m.ram[pressed.base + off];
      check('mc10: no column driven -> BREAK invisible', rb(6) === 0xFF,
        `none=$${rb(6).toString(16)} wrong=$${rb(7).toString(16)} own=$${rb(8).toString(16)} strobe=$${pressed.strobe.toString(16)}`);
      check('mc10: column 4 driven -> BREAK invisible', rb(7) === 0xFF, `$${rb(7).toString(16)}`);
      // requires the done marker as well: an unwritten byte is $00, and $00 & 0x40 is 0, so a bit-test alone
      // would pass on a firmware that never got past WAIT (measured with no press: seen=$0, own=$0)
      check('mc10: column 2 driven -> BREAK visible', pressed.done && rb(8) === 0xBF,
        `own=$${rb(8).toString(16)} done=$${rb(3).toString(16)}`);
      // A second, independent read of the same value: the machine's own strobe, read directly rather than
      // through the CPU. regRead($02) and machine.strobe are the SAME value (mc10.js:169 and cpu6803.js:178
      // compose to it; verified equal over all 65,536 DDR1/port-1 pairs, 0 mismatches), so this is not a
      // different measurement - it is the same number reached by a second route, which is what makes it worth
      // keeping: a change that broke either composition would show up here.
      check('mc10: the machine\'s strobe came from Port 1 data ($02)', pressed.strobe === 0xFB,
        `strobe $${pressed.strobe.toString(16)}`);
    }
  }

  // ---- the chat tool takes a restore point, and on main's model that is the turn's one snapshot ----
  // The snapshot is taken BEFORE the press, so it holds everything except the queued key: undoing it takes
  // the BREAK back (the typist queue is cleared by loadState). That is what makes the entry meaningful now -
  // before the fix the entry was pure waste, because the press changed nothing at all. The press is paced: the
  // call answers once the machine has read BREAK (or not), so here, with the machine standing still, the calls are
  // not awaited; Stop (the turn's abort) ends what is still held.
  {
    const s = new Emu.Session();
    s.switchMachine('dragon64');
    for (let i = 0; i < 30; i++) s.advance(1000 / s.shownMachine.fps + 0.01);
    const basic = s.shownMachine;
    let snaps = 0, restores = 0;
    const target = {
      get machine() { return basic; }, show: () => {}, screenText: () => s.screenText(),
      readByte: (a) => s.readByte(a), pokeBytes: (a, b) => s.pokeBytes(a, b),
      typeText: (t) => s.typeText(t), pressBreak: () => s.pressBreak(),
      snapshot: () => { snaps++; return basic.snapshot(); }, restore: (x) => { restores++; basic.restore(x); },
    };
    const chat = new Emu.ChatSession({ backend: new Emu.ClaudeBackend({ fetch: async () => ({}), apiKey: 'k' }), target, gate: () => null });   // an explicit allow gate: a ChatSession without one refuses
    chat.toolsOn = true;
    chat.snapped = false;                     // a new turn
    chat.controller = new AbortController();
    const settled = (p) => p.then(() => 'ok', (e) => e.code);
    const first = settled(chat.runTool('press_break', {}));
    await new Promise((r) => setImmediate(r));
    check('press_break takes the turn restore point', snaps === 1 && chat.undo.length === 1, `snaps ${snaps}, stack ${chat.undo.length}`);
    check('the press is queued for the CPU', basic.typist.busy, JSON.stringify(basic.typist.queue));
    const undid = chat.undoLast();
    check('undo takes the queued BREAK back', undid && restores === 1 && !basic.typist.busy,
      `restores ${restores}, busy ${basic.typist.busy}`);
    chat.abort();
    check('and the call it took back ends stopped', await first === 'stopped');
    // the per-turn rule: a second acting call in the same turn takes no second snapshot
    chat.snapped = false;
    chat.controller = new AbortController();
    const two = [settled(chat.runTool('press_break', {})), settled(chat.runTool('press_break', {}))];
    await new Promise((r) => setImmediate(r));
    check('two presses in one turn take one snapshot', snaps === 2, `snaps ${snaps}`);
    chat.abort();
    check('and Stop ends both', (await Promise.all(two)).join() === 'stopped,stopped');
  }

  console.log(`\n${n - fail}/${n} press_break checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
