// "This program needs BASIC" (js/needs-basic.js, Session.load / runAgainWithRoms): a program the person loaded, on
// a machine without BASIC's ROM, calls a BASIC routine the built-in firmware does not have. The programs here are our
// own bytes, written out below (no ROM code); the expected addresses and words come from the programs and the card's agreed copy,
// not from the code under test.
//  - it fires on the first fetch in BASIC's ROM space that the firmware does not implement, once per load, with the
//    address and the frame; the next load arms it again, a reset clears it; the card's words name the machine from its
//    sockets, with "ROMs" when more than one is needed (a CoCo's call into Extended Color BASIC);
//  - a hand-built .cas (blocks written here byte by byte) and a .bin both arm it;
//  - no false positives: the bundled programs (even with the detector forced on), the firmware's implemented hooks
//    (every vector, POLCAT and CHROUT, its interrupt handlers), the all-RAM map (TY=1) and CoCo 3 RAM mode, cartridge
//    code, ROMs present, and the Debugger stopped or stepping;
//  - after ROMs are added (a stand-in "BASIC ROM" built here) what was found stays, and Run again switches the machine
//    off and on and loads the same file: the program then calls the stand-in's routine.
// Run: node tests/needs-basic.test.js
const Emu = require('./load')();
const fs = require('fs');
const path = require('path');
const { needsBasicText, needsBasicWords, callsMissingBasic } = require('../js/needs-basic.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const json = (x) => JSON.stringify(x);
const example = (f) => new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'examples', f)));
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };

// a 6809 program at $3000 from its source, as a DragonDOS or DECB binary
function bin6809(src, format = 'dragondos') {
  const r = Emu.assemble(` ORG $3000\n${src}\n END START`, '6809');
  if (!r.ok) throw new Error(json(r.errors));
  return Emu.toBinary(r, { format });
}
// a session on machine id, recording what the detector says
function session(id) {
  const s = new Emu.Session({});
  s.switchMachine(id);
  const said = [];
  s.on((ev, arg) => { if (ev === 'needs-basic') said.push(arg && { address: arg.address, frame: arg.frame, file: arg.file }); });
  return { s, said };
}
// A .cas built here by hand (Color BASIC's cassette format: leader, sync $3C, block type, length, data, checksum = the
// sum of type, length and data): a machine-code file named PROG loaded at $3000 and run there
function cas(code) {
  const block = (type, data) => {
    const sum = (type + data.length + data.reduce((a, b) => a + b, 0)) & 0xFF;
    return [...new Array(128).fill(0x55), 0x3C, type, data.length, ...data, sum, 0x55];
  };
  const name = [...'PROG    '].map((c) => c.charCodeAt(0));
  const header = [...name, 0x02, 0x00, 0x00, 0x30, 0x00, 0x30, 0x00];   // type 2, binary, no gaps, exec $3000, load $3000
  return new Uint8Array([...block(0x00, header), ...block(0x01, [...code]), ...block(0xFF, [])]);
}
// the program that needs BASIC: interrupts off, a call into BASIC's ROM space at $A176, then a loop that calls it again
const CALLS_A176 = `START ORCC #$50
 JSR $A176
LOOP JSR $A176
 BRA LOOP`;

(async () => {
  // ---- it fires once, with the address and the frame; the card's words ----
  for (const [id, machine] of [['dragon64', 'Dragon 64'], ['dragon32', 'Dragon 32'], ['coco', 'CoCo 1/2']]) {
    const { s, said } = session(id);
    s.load('NEEDS.BIN', bin6809(CALLS_A176, id === 'coco' ? 'decb' : 'dragondos'));
    check(`${id}: a program the person loads, without BASIC, arms the detector`, s.needsBasic.armed);
    frames(s, 10);
    const f = s.needsBasic.found;
    check(`${id}: it fires once, at the first call ($A176), in the first frames; the loop's later calls do not fire it again`,
      said.length === 1 && said[0].address === 0xA176 && said[0].frame <= 1 && said[0].file === 'NEEDS.BIN' && !s.needsBasic.armed, json(said));
    const t = f && needsBasicText(f);
    check(`${id}: the card says its agreed words, naming the ${machine}`,
      t && t.lead === `NEEDS.BIN needs the ${machine}'s BASIC ROM, which isn't added yet.`
        && t.body === "It tried to use BASIC, and there's nothing there yet, so the screen fills with junk."
        && t.details === `It called $A176, in the BASIC ROM's space, at frame ${f.frame}.`, json(t));
  }
  // the plural, from the profile's sockets: a CoCo's call into Extended Color BASIC's space needs both ROMs
  {
    const { s, said } = session('coco');
    s.load('EXT.BIN', bin6809('START ORCC #$50\n JSR $8C1B\nL BRA L', 'decb'));
    frames(s, 3);
    const t = s.needsBasic.found && needsBasicText(s.needsBasic.found);
    check('coco: a call at $8C1B (Extended Color BASIC) needs two ROMs: "ROMs, which aren\'t added yet"',
      said.length === 1 && t && t.lead === "EXT.BIN needs the CoCo 1/2's BASIC ROMs, which aren't added yet." && t.details.startsWith('It called $8C1B,'), json(t));
    check('the words come from the sockets: the CoCo 3 and the MC-10 need one ROM, the CoCo 1/2 one or two',
      json([needsBasicWords(Emu.profiles.coco3, 0xA176), needsBasicWords(Emu.profiles.mc10, 0xFBD4), needsBasicWords(Emu.profiles.coco, 0xA176)])
        === json([{ machine: 'CoCo 3', plural: false, roms: 'ROM' }, { machine: 'MC-10', plural: false, roms: 'ROM' }, { machine: 'CoCo 1/2', plural: false, roms: 'ROM' }]));
  }
  // the CoCo 3 and the MC-10
  {
    const { s, said } = session('coco3');
    s.load('C3.BIN', bin6809(CALLS_A176, 'decb'));
    frames(s, 5);
    check('coco3: fires at $A176, once', said.length === 1 && said[0].address === 0xA176, json(said));
    check('coco3: "the CoCo 3\'s BASIC ROM"', needsBasicText(s.needsBasic.found).lead === "C3.BIN needs the CoCo 3's BASIC ROM, which isn't added yet.");
  }
  {
    const { s, said } = session('mc10');
    // 6803: SEI ; JSR $FBD4 ; BRA * (at $5000, raw)
    s.load('MC.RAW', new Uint8Array([0x0F, 0xBD, 0xFB, 0xD4, 0x20, 0xFE]), { askAddresses: () => ({ load: 0x5000, exec: 0x5000 }) });
    frames(s, 5);
    check('mc10: fires at $FBD4, once, naming the MC-10', said.length === 1 && said[0].address === 0xFBD4
      && needsBasicText(s.needsBasic.found).lead === "MC.RAW needs the MC-10's BASIC ROM, which isn't added yet.", json(said));
    const { s: s2, said: said2 } = session('mc10');
    // POLCAT ($F883) and CHROUT ($F9C6), the firmware's hooks: JSR $F883 ; LDAA #$41 ; JSR $F9C6 ; BRA to the start
    s2.load('MCOK.RAW', new Uint8Array([0x0F, 0xBD, 0xF8, 0x83, 0x86, 0x41, 0xBD, 0xF9, 0xC6, 0x20, 0xF5]), { askAddresses: () => ({ load: 0x5000, exec: 0x5000 }) });
    frames(s2, 30);
    check('mc10: POLCAT and CHROUT, the firmware\'s hooks, never fire it', s2.needsBasic.armed && said2.length === 0, json(said2));
  }

  // ---- a hand-built .cas arms it too ----
  {
    const { s, said } = session('dragon64');
    const code = Emu.assemble(` ORG $3000\n${CALLS_A176}\n END START`, '6809').segments[0].data;
    const msg = s.load('NEEDS.CAS', cas(code));
    frames(s, 5);
    check('a hand-built .cas, loaded without BASIC, goes into memory and fires at $A176', /started at \$3000/.test(msg) && said.length === 1 && said[0].address === 0xA176, `${msg} ${json(said)}`);
  }

  // ---- once per load: a reset clears it, the next load arms it again ----
  {
    const { s, said } = session('dragon64');
    const prog = bin6809(CALLS_A176);
    s.load('NEEDS.BIN', prog);
    frames(s, 3);
    s.reset();
    check('a reset clears what was found (the page is told: null)', said.length === 2 && said[1] === null && !s.needsBasic.found && !s.needsBasic.armed, json(said));
    frames(s, 10);
    check('...and does not arm it again: the program Reset restarted calls BASIC, nothing more is said', said.length === 2, json(said));
    s.load('NEEDS.BIN', prog);
    frames(s, 3);
    check('the next load arms it again: it fires again', said.length === 3 && said[2] && said[2].address === 0xA176, json(said));
    s.powerCycle();
    check('a power-on clears it too', said.length === 4 && said[3] === null && !s.needsBasic.found, json(said));
    s.load('NEEDS.BIN', prog);
    frames(s, 3);
    s.switchMachine('coco');
    check('a machine switch clears it', said.length === 6 && said[5] === null && !s.needsBasic.found, json(said));
  }

  // ---- no false positives ----
  // the bundled programs: not armed by their own start, and silent even with the detector forced on, keys typed
  for (const id of ['dragon64', 'coco', 'coco3', 'mc10']) {
    const progs = ['welcome', 'liza', ...(id === 'mc10' ? [] : ['demo', '2048', 'minesweeper'])];
    for (const prog of progs) {
      const { s, said } = session(id);
      if (prog === 'welcome') s.startWelcome(example(s.welcomeFile), { reason: 'shelf' });
      else if (prog === 'liza') s.runLiza(example(s.lizaFile));
      else if (prog === 'demo') s.load('demo.bin', example('demo.bin'), { remember: false, ours: true });
      else s.runGame(prog, example(s.gameFile(prog)));
      const armed = s.needsBasic.armed;
      s.needsBasic.arm(s.personMachine, prog, null);
      frames(s, 60);
      s.typeText(prog === 'liza' ? 'HELLO THERE\n' : ' ');
      frames(s, 120);
      if (prog === '2048' || prog === 'minesweeper') { for (const k of ['LEFT', 'UP', 'RIGHT', 'DOWN', 'SPACE']) { s.shownMachine.setKey(k, true); frames(s, 3); s.shownMachine.setKey(k, false); frames(s, 10); } }
      check(`${id}: ${prog} does not arm the detector, and never fires it when forced on`, !armed && said.length === 0, json(said));
    }
  }
  // WYRMFIRE (the bundled engine and the Freedoom level, js/wyrmfire/pin.js): not armed by its start, and silent with the
  // detector forced on, through its title and into play (it reads the disk through the bare controller, no BASIC)
  {
    const { WYRMFIRE_PIN: PIN } = require('../js/wyrmfire/pin.js');
    const read = (p) => new Uint8Array(fs.readFileSync(path.join(__dirname, '..', p)));
    const { s, said } = session('dragon64');
    s.startWyrmfire(read(PIN.files.engine.path), read(PIN.files.level.path));
    const armed = s.needsBasic.armed, m = s.personMachine;
    s.needsBasic.arm(m, 'WYRMFIRE.BIN', null);
    let f = 0;
    while (m.read(0x200) === 0 && f < 3000) { m.setKey('ENTER', f % 50 < 25); frames(s, 1); f++; }
    m.setKey('ENTER', false);
    for (const k of ['UP', 'LEFT', 'RIGHT', 'SPACE']) { m.setKey(k, true); frames(s, 20); m.setKey(k, false); frames(s, 5); }
    check('WYRMFIRE does not arm the detector, and never fires it when forced on, through its title and into play',
      !armed && m.read(0x200) > 0 && said.length === 0 && s.needsBasic.armed, `${f} frames to play, ${json(said)}`);
  }
  // the firmware's implemented hooks: every vector at $A000 (POLCAT, CHROUT, CSRDON, BLKIN, BLKOUT, JOYIN, WRTLDR),
  // with interrupts on (the firmware's IRQ and FIRQ handlers run)
  for (const id of ['dragon64', 'coco', 'coco3']) {
    const { s, said } = session(id);
    s.load('HOOKS.BIN', bin6809(`START ANDCC #$AF
L JSR [$A000]
 LDA #'A
 JSR [$A002]
 JSR [$A004]
 JSR [$A006]
 JSR [$A008]
 JSR [$A00A]
 JSR [$A00C]
 BRA L`, id === 'dragon64' ? 'dragondos' : 'decb'));
    frames(s, 100);
    check(`${id}: the firmware's own hooks and interrupt handlers never fire it`, s.needsBasic.armed && said.length === 0, json(said));
  }
  // the all-RAM map (TY=1: $FFDF): $A176 is RAM then; the program puts an RTS there and calls it, then goes back to
  // map type 0 ($FFDE) and loops. The same machine without the switch fires (the control).
  for (const id of ['dragon64', 'coco', 'coco3']) {
    const { s, said } = session(id);
    const fmt = id === 'dragon64' ? 'dragondos' : 'decb';
    s.load('ALLRAM.BIN', bin6809(`START ORCC #$50
 STA $FFDF
 LDA #$39
 STA $A176
 JSR $A176
 JSR $A176
 STA $FFDE
L BRA L`, fmt));
    frames(s, 10);
    check(`${id}: a call to $A176 in the all-RAM map (${id === 'coco3' ? 'CoCo 3 RAM mode' : 'TY=1'}) does not fire it`, s.needsBasic.armed && said.length === 0, json(said));
  }
  // the rule itself, on a machine whose map is switched by hand
  {
    const { s } = session('dragon64');
    frames(s, 2);   // (the firmware has set the SAM up: 64K, map type 0)
    const m = s.shownMachine;
    const ram = !callsMissingBasic(m, 0xA176);
    check('the rule, on the stub at $A176 (map type 0): it would fire', !ram);
    m.write(0xFFDF, 0);
    check('the rule, all-RAM (TY=1): it would not', !callsMissingBasic(m, 0xA176));
    m.write(0xFFDE, 0);
    check('the rule: $C000 (cartridge space) and $3000 (RAM) are not BASIC\'s ROM space; the POLCAT entry is implemented',
      !callsMissingBasic(m, 0xC000) && !callsMissingBasic(m, 0x3000) && !callsMissingBasic(m, 0xB100) && callsMissingBasic(m, 0xB101));
  }
  // cartridge code: a cartridge's own code runs at $C000 and prints through CHROUT; the cartridge's pages on a CoCo 3
  for (const id of ['dragon64', 'coco', 'coco3']) {
    const { s, said } = session(id);
    const r = Emu.assemble(` ORG $C000
START ORCC #$50
L LDA #'C
 JSR [$A002]
 LDX #$4000
D LEAX -1,X
 BNE D
 BRA L
 END START`, '6809');
    const rom = new Uint8Array(8192).fill(0x12);
    rom.set(r.segments[0].data, 0);
    const msg = s.load('GAME.ROM', rom);
    frames(s, 60);
    check(`${id}: a cartridge's own code (${msg.split(':')[0]}) never fires it`, /running at \$C000/.test(msg) && said.length === 0 && s.shownMachine.cartPort, `${msg} ${json(said)}`);
  }
  // ROMs present: a stand-in BASIC built here. Not armed: the machine has its BASIC
  // (the stand-in: $8000 BRA *, and at $A176 "INC $0500 ; LDA #$41 ; RTS"; RTS elsewhere; reset vector $8000)
  const standIn = () => {
    const rom = new Uint8Array(16384).fill(0x39);
    rom.set([0x20, 0xFE], 0);
    rom.set([0x7C, 0x05, 0x00, 0x86, 0x41, 0x39], 0x2176);
    rom[0x3FFE] = 0x80; rom[0x3FFF] = 0x00;
    return rom;
  };
  {
    const { s, said } = session('dragon64');
    s.addRoms([{ name: 'd64_1.rom', bytes: standIn() }]);
    s.load('NEEDS.BIN', bin6809(CALLS_A176));
    frames(s, 10);
    check('ROMs present: the load does not arm it, and nothing fires', !s.needsBasic.armed && said.length === 0 && s.shownMachine.read(0x500) > 0, json(said));
    s.runWithoutRoms();
    s.load('NEEDS.BIN', bin6809(CALLS_A176));
    frames(s, 10);
    check('ROMs stored but the machine runs without them by choice: not armed either (there is a BASIC to switch on)', !s.needsBasic.armed && said.length === 0, json(said));
  }
  // the Debugger: stopped at a breakpoint before the call, Step into $A176 and out again: nothing; resumed, the
  // second call (at $A178) fires
  {
    const { s, said } = session('dragon64');
    const r = Emu.assemble(` ORG $3000
START ORCC #$50
CALL1 JSR $A176
 LDX #$2000
D LEAX -1,X
 BNE D
 JSR $A178
L BRA L
 END START`, '6809');
    s.load('DBG.BIN', Emu.toBinary(r, { format: 'dragondos' }));
    const d = s.debug;
    d.addBreakpoint(r.symbols.get('CALL1'));
    frames(s, 3);
    check('the Debugger stops at the breakpoint before the call', d.stopped && s.shownMachine.cpu.pc === r.symbols.get('CALL1'), `pc ${s.shownMachine.cpu.pc.toString(16)}`);
    frames(s, 5);
    d.step();
    const into = s.shownMachine.cpu.pc;
    d.step();
    d.stepOver();
    check('stepping into $A176 and back while the Debugger has the machine stopped never fires it', into === 0xA176 && said.length === 0 && s.needsBasic.armed, json(said));
    d.clearBreakpoints();
    s.resume();
    frames(s, 5);
    check('resumed, the next call into BASIC ($A178) fires it', said.length === 1 && said[0].address === 0xA178, json(said));
  }

  // ---- after ROMs are added: what was found stays, Run again switches off and on and loads the same file ----
  {
    const { s, said } = session('dragon64');
    s.load('NEEDS.BIN', bin6809(CALLS_A176));
    frames(s, 3);
    let refused = '';
    try { s.runAgainWithRoms(); } catch (e) { refused = e.message; }
    check('Run again before the ROMs are added is refused, saying so', refused === "The Dragon 64's BASIC ROM isn't added yet.", refused);
    s.addRoms([{ name: 'd64_1.rom', bytes: standIn() }]);
    check('adding the ROMs (which switches the machine on with them) keeps what was found, for the card\'s offer',
      s.needsBasic.found && s.needsBasic.found.address === 0xA176 && s.machineRoms('dragon64').bootable && said.length === 1, json(said));
    const msg = s.runAgainWithRoms();
    frames(s, 5);
    const m = s.shownMachine;
    check('Run again: the machine has its ROM, the same file loaded through load, and its calls reach the stand-in\'s routine at $A176',
      m.hasRom && /^NEEDS\.BIN loaded and started/.test(msg) && m.read(0x500) > 0 && !s.needsBasic.armed && !s.needsBasic.found, `${msg} $0500=${m.read(0x500)}`);
    check('...and the card goes (null said)', said[said.length - 1] === null, json(said));
  }

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exitCode = fail ? 1 : 0;
})();
