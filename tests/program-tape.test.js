// Run: node tests/program-tape.test.js
//
// "Download .CAS" and "Download .WAV" (Share's program mode; Session.programTape): the BASIC program in memory as the tape
// CSAVE writes (js/media/cassette.js buildCas, whose stream the tape tests check against MAME), on our stand-in BASIC
// (tests/fixtures/basic-standin.js: no ROMs). Per family (Dragon, CoCo, MC-10):
//  * the .CAS (.C10 on the MC-10) is identified as a tape holding one tokenised BASIC file of that name, whose bytes are
//    the program as BASIC keeps it (TXTTAB to VARTAB);
//  * the fast loader (Session.load with fastCas) puts the same program back on a fresh machine, and it lists the same;
//  * the .WAV decodes (wavToCas) back to the same blocks, with no bad block;
// and the name on tape (cleaned: upper case, letters and digits, 8 at most, else PROGRAM; no date), the note per family,
// the refusals (no program, the built-in firmware) and the ROM guard (a program holding a run of the machine's ROM).
const Emu = require('./load')();
const { build } = require('./fixtures/basic-standin');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const PROG = '10 REM TAPE\n20 FOR I=1 TO 3:PRINT "HI";I:NEXT\n30 GOTO 20';

// a machine on our stand-in BASIC, at OK, with PROG in memory
function withBasic(id, text = PROG) {
  const s = new Emu.Session({ store: Emu.memoryStore(), welcomeMenu: false });
  for (const [k, v] of Object.entries(build(Emu, id))) s.roms.put(id, k, v, `${k}.rom`);
  s.switchMachine(id, undefined, { menu: false });
  for (let i = 0; i < 600 && s.bootStatus().state !== 'ok'; i++) s.runFrames(1);
  if (text) s.loadBasic(text);
  return s;
}
const blocks = (b) => [...Emu.casBlocks(b)].map((x) => `${x.type}:${Buffer.from(b.subarray(x.start, x.end + 1)).toString('hex')}`).join();
const POINTERS = { dragon: [0x19, 0x1B], coco: [0x19, 0x1B] };

for (const [id, family, ext, who] of [['dragon64', 'dragon', 'CAS', 'Dragon'], ['coco', 'coco', 'CAS', 'CoCo'], ['coco3', 'coco', 'CAS', 'CoCo'], ['mc10', 'mc10', 'C10', 'MC-10']]) {
  const s = withBasic(id);
  const prog = s.basicProgramBytes();
  const t = s.programTape('my game.bas'), w = s.programTape('my game.bas', { wav: true });
  check(`${id}: the files are MYGAME.${ext} and MYGAME.WAV`, t.name === `MYGAME.${ext}` && w.name === 'MYGAME.WAV' && t.family === family, `${t.name} ${w.name}`);
  const d = Emu.formats.identify(t.name, t.bytes);
  const f = d.files && d.files[0];
  check(`${id}: identified as a tape of one tokenised BASIC file, MYGAME, holding the program's bytes`, d.kind === 'cas' && d.files.length === 1 && f.name === 'MYGAME' && f.fileType === 0
    && Buffer.from(f.data).equals(Buffer.from(prog)), JSON.stringify(d.files && d.files.map((x) => [x.name, x.fileType, x.data && x.data.length])));
  if (POINTERS[family]) {
    const rd = (a) => s.readByte(a), word = (a) => (rd(a) << 8) | rd(a + 1);
    check(`${id}: the bytes are BASIC's own, TXTTAB to VARTAB`, prog.length === word(POINTERS[family][1]) - word(POINTERS[family][0]) && prog.every((b, i) => b === rd(word(0x19) + i)));
  }
  check(`${id}: the namefile is CSAVE's for a tokenised BASIC file (type 0, both flags 0)`, (() => { const nf = [...Emu.casBlocks(t.bytes)][0]; const b = t.bytes.subarray(nf.start, nf.end + 1); return nf.type === 0 && Buffer.from(b.subarray(3, 11)).toString('latin1') === 'MYGAME  ' && b[11] === 0 && b[12] === 0 && b[13] === 0; })());
  // the fast loader restores it on a fresh machine
  const r = withBasic(id, null);
  const fast = r.fastCas;
  r.fastCas = true;
  try { r.load(t.name, t.bytes); } finally { r.fastCas = fast; }
  r.runFrames(10);
  check(`${id}: the fast loader puts the same program back on a fresh ${id}`, Buffer.from(r.basicProgramBytes() || []).equals(Buffer.from(prog)));
  // the WAV: the same blocks back
  const back = Emu.wavToCas(w.bytes);
  check(`${id}: the WAV decodes back to the same blocks, none bad`, blocks(back.bytes) === blocks(t.bytes) && back.badBlocks === 0, `${back.badBlocks}`);
  check(`${id}: the note: "For ${who} BASIC: CLOAD it in another emulator, or play the WAV into a real machine's cassette port."`,
    Emu.Session.programTapeNote(family) === `For ${who} BASIC: CLOAD it in another emulator, or play the WAV into a real machine's cassette port.`);
}

// the name on tape
{
  const n = Emu.Session.programTapeName;
  for (const [given, want] of [['my game.bas', 'MYGAME'], ['ADVENTURE2.CAS', 'ADVENTUR'], ['', 'PROGRAM'], [null, 'PROGRAM'], ['***.bas', 'PROGRAM'], ['hello world', 'HELLOWOR'],
    ['2026-11-25 save.cas', '20261125'], ['é-café', 'CAF'], ['ok', 'OK']]) check(`the name on tape: ${JSON.stringify(given)} -> ${want}`, n(given) === want, n(given));
  const s = withBasic('dragon64');
  check('the field starts with the loaded file\'s name, else PROGRAM', s.programTapeDefault() === 'PROGRAM');
  s.lastLoaded = { name: 'Space Race.bas', bytes: new Uint8Array(1) };
  check('... the loaded file\'s, cleaned', s.programTapeDefault() === 'SPACERAC');
  check('a name is never more than 8 characters, upper case letters and digits, and nothing is added (no date)', /^[A-Z0-9]{1,8}\.CAS$/.test(s.programTape('a very long name with spaces').name) && s.programTape('').name === 'PROGRAM.CAS');
}

// refusals
{
  const s = withBasic('dragon64', null);
  const e = throws(() => s.programTape('X'));
  check('no BASIC program in memory: refused, saying so', e instanceof Emu.SessionError && /no BASIC program in memory/.test(e.message), e && e.message);
  const stub = new Emu.Session({ welcomeMenu: false });
  stub.switchMachine('dragon64', undefined, { menu: false });
  check('the built-in firmware (no BASIC): no program, refused', stub.basicProgramBytes() === null && throws(() => stub.programTape('X')) instanceof Emu.SessionError);
}
// the ROM guard: a program whose REM holds 16 bytes of the machine's own BASIC ROM is not saved
{
  const s = withBasic('dragon64', `10 REM ${'X'.repeat(24)}\n20 END`);
  const m = s.shownMachine, rom = Object.values(m.roms).find(Boolean);
  let at = -1;
  for (let i = 0; i + 16 <= rom.length && at < 0; i++) { const w = rom.subarray(i, i + 16); if (w.every((b) => b !== 0) && new Set(w).size > 3) at = i; }
  const start = (s.readByte(0x19) << 8) | s.readByte(0x1A);
  // the REM's text starts after the link (2), the line number (2) and the REM token (1)
  s.pokeBytes(start + 5 + 2, Array.from(rom.subarray(at, at + 16)), s.shownMachine);
  check('(the program still reads as a program, with the ROM run in it)', !!s.basicProgramBytes());
  const e = throws(() => s.programTape('X'));
  const ew = throws(() => s.programTape('X', { wav: true }));
  check('the ROM guard: a program holding a run of the machine\'s ROM is not saved, as .CAS or .WAV', e instanceof Emu.SessionError && e.message === 'Not saved: the program contains bytes of your ROMs.'
    && ew instanceof Emu.SessionError, e && e.message);
  check('... while a program of its own is', !!withBasic('dragon64').programTape('X'));
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
