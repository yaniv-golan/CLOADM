// Run: node tests/basic-load.test.js
//
// load_basic and the BASIC codec (js/media/basic.js), browser-free, no network, no ROMs.
//
// No BASIC ROM may be used here (AGENTS.md 1.1), so real BASIC is not the oracle (AGENTS.md 4.6). The expected
// bytes below are written out by hand from the published tables, with the page each comes from, and are not
// computed by the code under test:
//   [CBU] Color BASIC Unravelled II p.B18, pp.B40-B41, p.7, p.A1   [EBU] Extended BASIC Unravelled II pp.B2-B3
//   [DBU] Disk BASIC Unravelled II p.B3   [SEBU] Super Extended BASIC Unravelled II p.B9
//   [ITD] Inside the Dragon (Smeed, Sommerville) App.7, App.8, p.226, p.230, p.231
//   [YC]  Your Computer, October 1983, "Tandy MC-10 review", Table 1   [MCX] MCX BASIC Memory Map
// Whether a real BASIC then LISTs and RUNs what load_basic wrote was checked by hand by the owner (docs/claude.md).
//
// What is proved:
//  * crunch: hand-built bytes for each family, every rule ('?' is PRINT, ' and ELSE get a ':', DATA, REM and
//    strings are not crunched, GO TO and GO SUB are two tokens on the Dragon and CoCo and one on the MC-10, $FF
//    functions on the Dragon and CoCo and single bytes on the MC-10), the Dragon's worked examples [ITD p.230];
//  * the wrong family's table gives different bytes (a test that a table mix-up cannot pass);
//  * round trip: every keyword of every table crunches and uncrunches to itself, and whole programs uncrunch to the
//    hand-written normalised listing; buildProgram lays lines out as [CBU p.7] says (hand-computed links);
//  * load_basic on the Dragon 64, the CoCo 3 and the MC-10 (our own firmware in the BASIC socket, BASIC's pointers
//    and the OK prompt set up by the test): the bytes in memory, the pointers, the JSON result, a restore point;
//  * errors, each changing nothing: no-basic, not-at-prompt, bad-line-number, line-too-long, not-typable,
//    program-too-large, unknown-machine (pointers that do not describe a program), empty;
//  * load_basic's own card on every call, even with acting allowed; "Don't load" is load-declined; "Don't ask again
//    this session" stops it until the switch is turned off; a load that cannot happen is refused without a card;
//  * Session.loadBasic and the embed API's loadBasic: the same bytes and result as the tool, no card, the same codes.
const Emu = require('./load')();
const C = Emu.TOOL_CODES;

let fail = 0, n = 0;
const check = (name, cond, detail = '') => { n++; if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const hx = (a) => Array.from(a, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const bytesOf = (s) => [...s].map((c) => c.charCodeAt(0));
const same = (a, b) => hx(a) === hx(b);
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.machine.fps + 0.01); };
const dead = new Emu.ClaudeBackend({ fetch: async () => { throw new Error('no network in this test'); }, apiKey: 'sk-ant-BASIC-TEST-KEY-0123456789' });
const call = (chat, name, input = {}) => Promise.resolve(chat.backend.runTool(name, input)).then((out) => ({ ok: true, out }), (err) => ({ ok: false, err }));

// ---- 1. crunch: hand-built bytes ----
{
  const cr = (t, d) => Emu.crunch(t, d);
  // CoCo [CBU p.B18]: PRINT $87, GO $81, TO $A5, SUB $A6, IF $85, THEN $A7, ELSE $84, = $B3, REM $83, DATA $86
  check('coco: PRINT "HI":GOTO 10', same(cr('PRINT "HI":GOTO 10', 'coco'), [0x87, 0x20, 0x22, 0x48, 0x49, 0x22, 0x3A, 0x81, 0xA5, 0x20, 0x31, 0x30]), hx(cr('PRINT "HI":GOTO 10', 'coco')));
  check('coco: GOSUB is GO then SUB', same(cr('GOSUB 20', 'coco'), [0x81, 0xA6, 0x20, 0x32, 0x30]));
  check('coco: ELSE is stored with a ":" before it [CBU p.B41]', same(cr('IF A=1 THEN 30 ELSE 40', 'coco'), [0x85, 0x20, 0x41, 0xB3, 0x31, 0x20, 0xA7, 0x20, 0x33, 0x30, 0x20, 0x3A, 0x84, 0x20, 0x34, 0x30]), hx(cr('IF A=1 THEN 30 ELSE 40', 'coco')));
  check('coco: \' is ":" then REM\'s token, and nothing after it is crunched', same(cr("X=1 ' PRINT", 'coco'), [0x58, 0xB3, 0x31, 0x20, 0x3A, 0x83, 0x20, 0x50, 0x52, 0x49, 0x4E, 0x54]), hx(cr("X=1 ' PRINT", 'coco')));
  check('coco: nothing after REM is crunched', same(cr('REM GOTO', 'coco'), [0x82, 0x20, 0x47, 0x4F, 0x54, 0x4F]));
  check('coco: ? is PRINT [CBU p.B40]', same(cr('?1', 'coco'), [0x87, 0x31]));
  check('coco: DATA is not crunched up to the next ":", then crunching resumes', same(cr('DATA TO,"A:B":TO', 'coco'), [0x86, 0x20, 0x54, 0x4F, 0x2C, 0x22, 0x41, 0x3A, 0x42, 0x22, 0x3A, 0xA5]), hx(cr('DATA TO,"A:B":TO', 'coco')));
  check('coco: functions are $FF then the token: MID$ $FF90, PEEK $FF86 [CBU p.B18]', same(cr('A$=MID$(B$,2):X=PEEK(1)', 'coco'), [0x41, 0x24, 0xB3, 0xFF, 0x90, 0x28, 0x42, 0x24, 0x2C, 0x32, 0x29, 0x3A, 0x58, 0xB3, 0xFF, 0x86, 0x28, 0x31, 0x29]));
  check('coco: Extended BASIC: PCLEAR $C0, SQR $FF9B [EBU pp.B2-B3]', same(cr('PCLEAR 1:X=SQR(4)', 'coco'), [0xC0, 0x20, 0x31, 0x3A, 0x58, 0xB3, 0xFF, 0x9B, 0x28, 0x34, 0x29]));
  check('coco: Disk BASIC: DIR $CE, DSKO$ $E0 [DBU p.B3]', same(cr('DIR:DSKO$', 'coco'), [0xCE, 0x3A, 0xE0]));
  check('coco: Super Extended: HCLS $E6, LOCATE $F1, LPEEK $FFA8 [SEBU p.B9]', same(cr('HCLS:LOCATE 1,2:X=LPEEK(0)', 'coco'), [0xE6, 0x3A, 0xF1, 0x20, 0x31, 0x2C, 0x32, 0x3A, 0x58, 0xB3, 0xFF, 0xA8, 0x28, 0x30, 0x29]), hx(cr('HCLS:LOCATE 1,2:X=LPEEK(0)', 'coco')));
  check('coco: a keyword inside a name is crunched, as BASIC does (FORM is FOR, M)', same(cr('FORM', 'coco'), [0x80, 0x4D]));
  check('coco: strings are kept as written', same(cr('PRINT "goto"', 'coco'), [0x87, 0x20, 0x22, 0x67, 0x6F, 0x74, 0x6F, 0x22]));
  // Dragon [ITD App.7, p.230]: DIM $8C, FOR $80, = $CB, STR$ $FF8E, PEEK $FF8C; TO $BC, PRINT $87, LET $8E, GO $81, SUB $BD
  check('dragon: the worked examples of [ITD p.230]: DIM $8C, FOR $80, = $CB, STR$ $FF8E, PEEK $FF8C',
    same(cr('DIM', 'dragon'), [0x8C]) && same(cr('FOR', 'dragon'), [0x80]) && same(cr('=', 'dragon'), [0xCB]) && same(cr('STR$', 'dragon'), [0xFF, 0x8E]) && same(cr('PEEK', 'dragon'), [0xFF, 0x8C]));
  check('dragon: FOR I=1 TO 10', same(cr('FOR I=1 TO 10', 'dragon'), [0x80, 0x20, 0x49, 0xCB, 0x31, 0x20, 0xBC, 0x20, 0x31, 0x30]), hx(cr('FOR I=1 TO 10', 'dragon')));
  check('dragon: LET $8E, RUN $8F, GOSUB is $81 $BD, USR $FFA1', same(cr('LET:RUN:GOSUB:X=USR(0)', 'dragon'), [0x8E, 0x3A, 0x8F, 0x3A, 0x81, 0xBD, 0x3A, 0x58, 0xCB, 0xFF, 0xA1, 0x28, 0x30, 0x29]), hx(cr('LET:RUN:GOSUB:X=USR(0)', 'dragon')));
  check('dragon: DragonDOS DIR $D5, FREE $FFA3 [ITD App.8]', same(cr('DIR:X=FREE(0)', 'dragon'), [0xD5, 0x3A, 0x58, 0xCB, 0xFF, 0xA3, 0x28, 0x30, 0x29]));
  // MC-10 [YC Table 1], values $80 + position: GOTO $81, GOSUB $82, PRINT $86, PEEK $BC, MEM $C8, = $AF
  check('mc10: GOTO and GOSUB are one token each, PRINT $86', same(cr('GOTO 10:GOSUB 20:PRINT', 'mc10'), [0x81, 0x20, 0x31, 0x30, 0x3A, 0x82, 0x20, 0x32, 0x30, 0x3A, 0x86]));
  check('mc10: functions are single bytes: X=PEEK(MEM) is 58 AF BC 28 C8 29', same(cr('X=PEEK(MEM)', 'mc10'), [0x58, 0xAF, 0xBC, 0x28, 0xC8, 0x29]));
  check('mc10: there is no ELSE: the letters stay letters', same(cr('ELSE', 'mc10'), bytesOf('ELSE')));
  // the wrong table gives different bytes: a family mix-up cannot pass
  check('the three tables differ for the same line (PRINT, GOTO, = and PEEK)', !same(cr('PRINT X=PEEK(1):GOTO 1', 'coco'), cr('PRINT X=PEEK(1):GOTO 1', 'dragon'))
    && !same(cr('PRINT X=PEEK(1):GOTO 1', 'coco'), cr('PRINT X=PEEK(1):GOTO 1', 'mc10')) && !same(cr('PRINT X=PEEK(1):GOTO 1', 'dragon'), cr('PRINT X=PEEK(1):GOTO 1', 'mc10')));
}

// ---- 2. round trips ----
{
  for (const id of Object.keys(Emu.DIALECTS)) {
    const d = Emu.DIALECTS[id];
    const bad = d.keywords.map(([k]) => k).filter((k) => Emu.uncrunch(Emu.crunch(k, d), d) !== k);
    check(`${id}: every keyword (${d.keywords.length}) crunches and uncrunches to itself`, bad.length === 0, bad.join(' '));
    const tokens = new Set(d.keywords.map(([, b]) => b.join(',')));
    check(`${id}: no two keywords share a token`, tokens.size === d.keywords.length);
  }
  const SRC = '  20 if a=1 then print "Hi there" else goto 10\r\n10 for i=1 to 10:? i;:next\n\n30 data 1,two:rem the end\n';
  const want = {
    coco: '10 FOR I=1 TO 10:PRINT I;:NEXT\n20 IF A=1 THEN PRINT "Hi there" ELSE GOTO 10\n30 DATA 1,TWO:REM THE END',
    dragon: '10 FOR I=1 TO 10:PRINT I;:NEXT\n20 IF A=1 THEN PRINT "Hi there" ELSE GOTO 10\n30 DATA 1,TWO:REM THE END',
  };
  for (const id of ['coco', 'dragon']) check(`${id}: a program round-trips to its normalised listing (sorted, upper case outside strings, ? as PRINT)`, Emu.normalizeProgram(SRC, id) === want[id], JSON.stringify(Emu.normalizeProgram(SRC, id)));
  const MC = '20 print "Hi":goto 10\n10 for i=1 to 3:?i:next i\n';
  check('mc10: a program round-trips to its normalised listing', Emu.normalizeProgram(MC, 'mc10') === '10 FOR I=1 TO 3:PRINTI:NEXT I\n20 PRINT "Hi":GOTO 10', JSON.stringify(Emu.normalizeProgram(MC, 'mc10')));
  check('a later line with the same number replaces the earlier, and a number alone deletes the line', Emu.normalizeProgram('10 PRINT 1\n20 END\n10 PRINT 2\n20\n', 'coco') === '10 PRINT 2');
  // [CBU p.7]: link to the next line, line number, crunched text, 0; the end is a zero link. Hand-computed at $1E01:
  // line 10 "PRINT" -> link $1E07 (1E01 + 4 + 1 + 1), 00 0A, 87, 00; line 20 "END" -> link $1E0D, 00 14, 8A, 00; 00 00
  const prog = Emu.buildProgram(Emu.parseProgram('10 PRINT\n20 END', 'coco'), 0x1E01);
  check('buildProgram lays out link, number, text, 0, then the zero end link', same(prog, [0x1E, 0x07, 0x00, 0x0A, 0x87, 0x00, 0x1E, 0x0D, 0x00, 0x14, 0x8A, 0x00, 0x00, 0x00]), hx(prog));
  const mem = new Uint8Array(0x10000); mem.set(prog, 0x1E01);
  check('readProgram and listProgram follow the links back to the listing', Emu.listProgram((a) => mem[a], 0x1E01, 'coco') === '10 PRINT\n20 END');
  const throws = (f, code) => { try { f(); return false; } catch (e) { return e.code === code; } };
  check('parse errors: no line number, 64000, a 6-digit number are bad-line-number', throws(() => Emu.parseProgram('PRINT 1', 'coco'), 'bad-line-number')
    && throws(() => Emu.parseProgram('64000 END', 'coco'), 'bad-line-number') && throws(() => Emu.parseProgram('000010 END', 'coco'), 'bad-line-number') && Emu.parseProgram('63999 END', 'coco').length === 1);
  // characters above $7E: a byte of $80 or more in program text would be read back as a token, so none is stored
  check('characters above $7E are not-typable, by name (Latin-1, the top of the byte range, beyond a byte)',
    throws(() => Emu.parseProgram('10 PRINT "CAFÉ"', 'coco'), 'not-typable') && throws(() => Emu.parseProgram('10 REM \u007F', 'dragon'), 'not-typable')
    && throws(() => Emu.parseProgram('10 PRINT "\u00FF"', 'mc10'), 'not-typable') && throws(() => Emu.parseProgram('10 PRINT "→"', 'coco'), 'not-typable')
    && Emu.parseProgram('10 PRINT "~}|{"', 'coco').length === 1);
  check('a line longer than the line input takes is line-too-long (249 on the CoCo, 128 on the MC-10)', throws(() => Emu.parseProgram(`10 REM ${'X'.repeat(243)}`, 'coco'), 'line-too-long')
    && Emu.parseProgram(`10 REM ${'X'.repeat(242)}`, 'coco').length === 1 && throws(() => Emu.parseProgram(`10 REM ${'X'.repeat(122)}`, 'mc10'), 'line-too-long'));
}

// ---- 3. load_basic on the machine ----
const SLOT = { dragon64: 0x4000, coco3: 0x8000, mc10: 0x2000 };
const LAYOUT = {   // where the test puts BASIC's program and the top of free RAM (FRETOP), and the dialect's pointers
  dragon64: { start: 0x1E01, fretop: 0x7E00, p: 0x19 },
  coco3: { start: 0x2601, fretop: 0x7E00, p: 0x19 },
  mc10: { start: 0x4346, fretop: 0x4E00, p: 0x93 },
};
// a machine with our own idle firmware as its BASIC ROM, BASIC's pointers describing an empty program (a zero
// before it and a zero end link at the start, as after NEW [CBU p.7]), and OK on the screen
function basicMachine(id, { ok = true } = {}) {
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine(id);
  const m = s.machine, six = id === 'mc10' ? '6803' : '6809';
  // the 6809 machines: the VDG text page at $0400 (SAM offset F1, PIA1 port B outputs low: alphanumeric mode),
  // and on the CoCo 3 the MMU and the GIME's video base set the way its BASIC leaves them (task 0 = blocks $38-$3F,
  // the CoCo-compatible mode, video at physical $70400), so the screen reader can read the prompt
  const coco3 = id === 'coco3' ? ' LDX #$FFA0\n LDA #$38\nMMU STA ,X+\n INCA\n CMPX #$FFA8\n BNE MMU\n LDA #$CE\n STA $FF90\n LDD #$E000\n STD $FF9D\n' : '';
  const asm = Emu.assemble(six === '6803' ? ' ORG $E000\nSTART BRA START\n'
    : ` ORG $8000\nSTART\n${coco3} STA $FFC9\n CLR $FF23\n LDA #$F8\n STA $FF22\n LDA #$04\n STA $FF23\n CLR $FF22\nIDLE BRA IDLE\n`, six);
  if (!asm.ok) throw new Error(JSON.stringify(asm.errors));
  const rom = new Uint8Array(SLOT[id]).fill(0xFF); rom.set(asm.segments[0].data, 0);
  m.setRoms({ basic: rom }); m.reset(true); m.cpu.jump(asm.exec);
  if (six === '6803') m.cpu.ramc = (m.cpu.ramc || 0) | 0x40;
  const L = LAYOUT[id], w = (a, v) => s.pokeBytes(a, [v >> 8, v & 0xFF], m);
  s.pokeBytes(L.start - 1, [0, 0, 0], m);
  w(L.p, L.start); w(L.p + 2, L.start + 2); w(L.p + 4, L.start + 2); w(L.p + 6, L.start + 2); w(L.p + 8, L.fretop);
  const screen = m.profile.textScreen || 0x400;
  for (let i = 0; i < 512; i++) m.ram[screen + i] = 0x60;
  if (ok) { m.ram[screen + 64] = 0x0F; m.ram[screen + 65] = 0x0B; }   // "OK" on the third row
  frames(s, 3);
  s.setClaudeAllowed(true);
  // load_basic's own card comes up on every call: this page says yes to it (section 5 tests the card itself)
  const cards = [];
  s.claudeGate = (name) => { cards.push(s.claudePending && s.claudePending.load); Promise.resolve().then(() => s.answerClaude(true)); };
  const chat = s.startAsk({ backend: dead });
  const word = (a) => (s.readByte(a, m) << 8) | s.readByte(a + 1, m);
  return { s, m, chat, L, word, cards, state: () => Emu.state.toJSON(m.snapshot()) };
}

(async () => {
  for (const id of ['dragon64', 'coco3', 'mc10']) {
    const { s, m, chat, L, word } = basicMachine(id);
    const r = await call(chat, 'load_basic', { program: '20 GOTO 10\n10 PRINT "HI"\n' });
    const goto = id === 'mc10' ? [0x81] : id === 'dragon64' ? [0x81, 0xBC] : [0x81, 0xA5];
    const print = id === 'mc10' ? 0x86 : 0x87;
    // hand-built: line 10 = link, 00 0A, PRINT, space, "HI", 0; line 20 = link, 00 14, GOTO, space, "10", 0; 00 00
    const l10 = [0x00, 0x0A, print, 0x20, 0x22, 0x48, 0x49, 0x22, 0x00];
    const a20 = L.start + 2 + l10.length;
    const l20 = [0x00, 0x14, ...goto, 0x20, 0x31, 0x30, 0x00];
    const a00 = a20 + 2 + l20.length;
    const want = [a20 >> 8, a20 & 0xFF, ...l10, a00 >> 8, a00 & 0xFF, ...l20, 0x00, 0x00];
    const got = Array.from({ length: want.length }, (_, i) => s.readByte(L.start + i, m));
    check(`${id}: load_basic writes the lines at TXTTAB in BASIC's format (hand-built bytes)`, r.ok && same(got, want), r.ok ? hx(got) : r.err.message);
    check(`${id}: the result is {lines,bytes,start,end}`, r.ok && JSON.stringify(r.out) === JSON.stringify({ lines: 2, bytes: want.length, start: L.start, end: L.start + want.length - 1 }), JSON.stringify(r.ok ? r.out : r.err.message));
    const after = L.start + want.length;
    check(`${id}: VARTAB, ARYTAB and ARYEND point just past the program; TXTTAB and FRETOP are unchanged`, word(L.p) === L.start && word(L.p + 2) === after && word(L.p + 4) === after && word(L.p + 6) === after && word(L.p + 8) === L.fretop);
    check(`${id}: the program lists back as written`, Emu.listProgram((a) => s.readByte(a, m), L.start, Emu.machineFamily(m.profile)) === '10 PRINT "HI"\n20 GOTO 10');
    check(`${id}: one restore point, and undo puts the empty program back`, chat.undo.length === 1 && chat.undoLast() && word(L.p + 2) === L.start + 2);
    // a second load replaces the first program (as NEW then the lines)
    chat.snapped = false;
    const r2 = await call(chat, 'load_basic', { program: '5 END' });
    check(`${id}: a later load replaces the program`, r2.ok && r2.out.lines === 1 && Emu.listProgram((a) => s.readByte(a, m), L.start, Emu.machineFamily(m.profile)) === '5 END');
  }

  // ---- 4. errors: each refused with its code, nothing changed, no restore point ----
  const refused = async (label, setup, input, code) => {
    const b = basicMachine(setup.id || 'dragon64', setup);
    if (setup.after) setup.after(b);
    const before = b.state();
    const r = await call(b.chat, 'load_basic', input);
    check(`${label}: ${code}, nothing changed, no restore point`, !r.ok && r.err.code === code && b.state() === before && b.chat.undo.length === 0 && typeof Emu.TOOL_ERRORS[code] === 'string',
      r.ok ? JSON.stringify(r.out) : `${r.err.code} ${r.err.message}`);
  };
  await refused('no OK on the screen', { ok: false }, { program: '10 END' }, C.NOT_AT_PROMPT);
  await refused('typing still going in', { after: (b) => b.s.typeTextPaced('X', b.m) }, { program: '10 END' }, C.NOT_AT_PROMPT);
  await refused('a line without a number', {}, { program: '10 END\nPRINT 1' }, C.BAD_LINE_NUMBER);
  await refused('line 64000', {}, { program: '64000 END' }, C.BAD_LINE_NUMBER);
  await refused('a character above $7E (é in a string)', {}, { program: '10 PRINT "CAFÉ"\n20 END' }, C.NOT_TYPABLE);
  await refused('a character above $7E (\\u0080, which would read back as the FOR token)', { id: 'coco3' }, { program: '10 REM \u0080' }, C.NOT_TYPABLE);
  await refused('a 250-character line', {}, { program: `10 REM ${'X'.repeat(243)}` }, C.LINE_TOO_LONG);
  await refused('a program bigger than free memory', { id: 'mc10' }, { program: Array.from({ length: 200 }, (_, i) => `${i + 1} PRINT "${'X'.repeat(40)}"`).join('\n') }, C.PROGRAM_TOO_LARGE);
  await refused('pointers that do not describe a program (VARTAB elsewhere)', { after: (b) => b.s.pokeBytes(0x1B, [0x30, 0x00], b.m) }, { program: '10 END' }, C.UNKNOWN_MACHINE);
  await refused('an empty program', {}, { program: '  \n' }, C.EMPTY);
  await refused('too long a text', {}, { program: 'x'.repeat(Emu.BASIC_PROGRAM_TEXT_MAX + 1) }, C.TOO_LARGE);
  {
    // no ROMs: the stub has no BASIC program memory
    const s = new Emu.Session({ store: Emu.memoryStore() });
    s.switchMachine('dragon64'); frames(s, 30); s.setClaudeAllowed(true);
    const chat = s.startAsk({ backend: dead });
    const before = Emu.state.toJSON(s.machine.snapshot());
    const r = await call(chat, 'load_basic', { program: '10 END' });
    check('no ROMs: no-basic, with a remedy that does not assume RUN, nothing changed', !r.ok && r.err.code === C.NO_BASIC && /assemble_and_load/.test(r.err.tool.remedy)
      && Emu.state.toJSON(s.machine.snapshot()) === before && chat.undo.length === 0, r.ok ? '' : r.err.message);
  }

  // ---- 5. load_basic's own card: on every call, even with acting allowed, until "Don't ask again this session" ----
  {
    check('load_basic is in actingTools() and the gate\'s ACTING_TOOL_NAMES', Emu.actingTools().some((t) => t.name === 'load_basic') && Emu.ACTING_TOOL_NAMES.includes('load_basic') && !Emu.READ_ONLY_TOOLS.includes('load_basic'));
    const b = basicMachine('coco3');
    const { s } = b;
    const seen = [];   // each card: what it says the load is
    let answer = { allow: true };
    s.claudeGate = () => { const p = s.claudePending; seen.push({ kind: p.kind, load: p.load }); Promise.resolve().then(() => s.answerClaude(answer.allow, { dontAsk: !!answer.dontAsk })); };
    const loadOnce = async (program = '10 PRINT 1\n20 END') => { b.chat.snapped = false; return call(b.chat, 'load_basic', { program }); };
    check('acting is allowed here (the switch is on)', s.claudeAllowed === true);
    const r1 = await loadOnce();
    check('with acting allowed, load_basic still shows its own card, describing the load (2 lines, 10-20, bytes)', r1.ok && seen.length === 1 && seen[0].kind === 'load'
      && JSON.stringify(seen[0].load) === JSON.stringify({ lines: 2, first: 10, last: 20, bytes: r1.out.bytes }), JSON.stringify(seen));
    const r2 = await loadOnce();
    check('and again on the next call: every call has its card', r2.ok && seen.length === 2);
    answer = { allow: false };
    const before = b.state();
    const r3 = await loadOnce('10 END');
    check('"Don\'t load" refuses with load-declined, nothing changes, no restore point', !r3.ok && r3.err.code === C.LOAD_DECLINED && seen.length === 3 && b.state() === before
      && /do not load it/.test(r3.err.tool.remedy), r3.ok ? '' : r3.err.message);
    answer = { allow: false, dontAsk: true };
    await loadOnce('10 END');
    check('"Don\'t ask again" with a refusal does not stop the asking', s.claudeLoadNoAsk === false);
    answer = { allow: true, dontAsk: true };
    const r4 = await loadOnce('10 END');
    const r5 = await loadOnce('20 END');
    check('"Don\'t ask again this session" with Load it: this load and the next go ahead without a card', r4.ok && r5.ok && seen.length === 5 && s.claudeLoadNoAsk === true);
    s.setClaudeAllowed(false);
    answer = { allow: true };
    const r6 = await loadOnce('30 END');
    check('turning the switch off brings the card back', r6.ok && seen.length === 6 && s.claudeLoadNoAsk === false);
    // with the switch off "Don't ask again this session" is not offered (the page hides the box) and counts for nothing
    // if it is sent anyway: every load still has its card, so no load goes in silently
    answer = { allow: true, dontAsk: true };
    const r6b = await loadOnce('31 END');
    const r6c = await loadOnce('32 END');
    check('switch off: Load it with "Don\'t ask again" does not stop the asking; the next load has its card too (no silent load)',
      r6b.ok && r6c.ok && seen.length === 8 && seen.every((x) => x.kind === 'load') && s.claudeLoadNoAsk === false && s.claudeAllowed === false, `${seen.length} ${s.claudeLoadNoAsk}`);
    // a load that cannot happen is refused with its own code before anyone is asked
    const r7 = await loadOnce('PRINT 1');
    check('a program that cannot load is refused (bad-line-number) without a card', !r7.ok && r7.err.code === C.BAD_LINE_NUMBER && seen.length === 8);
    // no page to ask: nobody can say yes
    s.claudeGate = null;
    const r8 = await loadOnce('40 END');
    check('with no page to ask, load_basic is no-consent', !r8.ok && r8.err.code === C.NO_CONSENT);
    // the general switch's card is separate: with the switch off another acting tool asks the consent question
    s.claudeGate = () => { seen.push({ kind: s.claudePending.kind }); Promise.resolve().then(() => s.answerClaude(false)); };
    await call(b.chat, 'poke', { address: 0x3000, bytes: [1] });
    check('other acting tools still get the consent card (kind consent), not the load card', seen[seen.length - 1].kind === 'consent');
    // Stop while the load card is up ends the call as stopped, not as the person's refusal (load-declined)
    s.setClaudeAllowed(true);
    s.claudeGate = () => { seen.push({ kind: s.claudePending.kind }); Promise.resolve().then(() => s.stopClaude()); };
    const beforeStop = b.state(), cardsBefore = seen.length, undoBefore = b.chat.undo.length;
    const r9 = await loadOnce('50 END');
    check('Stop while the load card is up: the error is stopped (not load-declined), nothing changes, no restore point',
      !r9.ok && r9.err.code === C.STOPPED && seen.length === cardsBefore + 1 && seen[seen.length - 1].kind === 'load' && b.state() === beforeStop && b.chat.undo.length === undoBefore && s.claudePending === null,
      r9.ok ? 'loaded' : r9.err.code);
  }

  // ---- 6. Session.loadBasic and the embed API: the same implementation, no card, no restore point ----
  {
    const b = basicMachine('dragon64');
    let asked = 0;
    b.s.claudeGate = () => { asked++; };
    const r = b.s.loadBasic('20 GOTO 10\n10 PRINT "HI"');
    const bytesNow = Array.from({ length: r.bytes }, (_, i) => b.s.readByte(b.L.start + i, b.m));
    // the same bytes the tool wrote in section 3 for this program on the Dragon (hand-built there)
    const t = basicMachine('dragon64');
    const rt = await call(t.chat, 'load_basic', { program: '20 GOTO 10\n10 PRINT "HI"' });
    const bytesTool = Array.from({ length: rt.out.bytes }, (_, i) => t.s.readByte(t.L.start + i, t.m));
    check('Session.loadBasic writes exactly what the tool writes, returns the same result, and asks nobody', JSON.stringify(r) === JSON.stringify(rt.out) && same(bytesNow, bytesTool)
      && asked === 0 && b.chat.undo.length === 0 && b.word(b.L.p + 2) === b.L.start + r.bytes);
    const fails = (f) => { try { f(); return null; } catch (e) { return e.code; } };
    check('Session.loadBasic refuses with the same codes: bad-line-number, not-typable, empty', fails(() => b.s.loadBasic('PRINT')) === C.BAD_LINE_NUMBER
      && fails(() => b.s.loadBasic('10 PRINT "É"')) === C.NOT_TYPABLE && fails(() => b.s.loadBasic('')) === C.EMPTY && fails(() => b.s.loadBasic(7)) === C.EMPTY);
    const stub = new Emu.Session({ store: Emu.memoryStore() }); stub.switchMachine('coco3'); frames(stub, 30);
    const before = Emu.state.toJSON(stub.machine.snapshot());
    check('Session.loadBasic with no BASIC ROMs: no-basic, nothing changed', fails(() => stub.loadBasic('10 END')) === C.NO_BASIC && Emu.state.toJSON(stub.machine.snapshot()) === before);
    // the embed API: a host's call is answered by id, the result or the coded message
    const sent = [];
    const api = new Emu.EmbedApi(b.s, (msg) => sent.push(msg));
    const ok = api.handle({ cloadm: 1, id: 1, method: 'loadBasic', args: ['5 END'] });
    const bad = api.handle({ cloadm: 1, id: 2, method: 'loadBasic', args: ['END'] });
    const notText = api.handle({ cloadm: 1, id: 3, method: 'loadBasic', args: [5] });
    check('embed API loadBasic: the result by id; a refusal is its coded message; a non-string is refused', Emu.EmbedApi.METHODS.includes('loadBasic') && ok.result && ok.result.lines === 1
      && Emu.listProgram((a) => b.s.readByte(a, b.m), b.L.start, 'dragon') === '5 END' && /^bad-line-number:/.test(bad.error) && /must be a string/.test(notText.error), JSON.stringify([ok, bad, notText]));
  }

  console.log(`\n${n - fail}/${n} BASIC load checks passed`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
