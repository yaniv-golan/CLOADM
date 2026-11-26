// The 6803 welcome program (examples/welcome6803.asm) on the MC-10 and the Matra Alice, headless, without
// ROMs: the screen (colour stripe, CLOADM in block letters, the menu) checked as RAW SCREEN CELLS, not as a
// decoded approximation; the subtitle naming the machine the build runs on; keys 1-4 firing the Session's
// welcome events and nothing else. Expected cell values are derived here from the VDG character set and
// the SG4 layout (the MC6847 data sheet), not read back from the program.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const read = (f) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples', f)));
const src = fs.readFileSync(path.join(ROOT, 'examples/welcome6803.asm'), 'utf8');
const include = (name) => {
  const p = path.join(ROOT, 'examples', name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

// ---- expected VDG cell values, from the character set ----
// PRINTAT stores a printable byte under $40 as byte+$40; $40-$7E as itself; a byte with bit 7 set is
// inverse video and stored as byte&$3F.
const cell = (ch) => {
  const b = ch.charCodeAt(0);
  return b >= 0x40 && b < 0x80 ? b : b + 0x40;
};
const cells = (s) => [...s].map(cell);
const inverse = (ch) => ch.charCodeAt(0) & 0x3F;
// the eight VDG colours in the stripe's order, four cells each; SG4 cell = $80 | colour<<4 | block
const VDG = ['green', 'yellow', 'blue', 'red', 'buff', 'cyan', 'magenta', 'orange'];
const stripe = Array.from({ length: 32 }, (_, i) => 0x8F | (VDG.indexOf(VDG[i >> 2]) << 4));
// CLOADM, 8x6 pixels a letter, one column of cells (2 pixels) between letters; green SG4 quarter blocks
const ART = {
  C: ['.######.', '##....##', '##......', '##......', '##....##', '.######.'],
  L: ['##......', '##......', '##......', '##......', '##......', '#######.'],
  O: ['.######.', '##....##', '##....##', '##....##', '##....##', '.######.'],
  A: ['.######.', '##....##', '##....##', '########', '##....##', '##....##'],
  D: ['######..', '##...##.', '##....##', '##....##', '##...##.', '######..'],
  M: ['##....##', '###..###', '########', '##.##.##', '##....##', '##....##'],
};
const wantPixels = Array.from({ length: 6 }, (_, y) => [...'CLOADM'].map((ch) => ART[ch][y]).join('..'));

// the two shipping builds, one per machine, and the subtitle each must show
const MACHINES = [
  { id: 'mc10', file: 'welcome6803-mc10.bin', sub: 'TANDY MC-10' },
  { id: 'alice', file: 'welcome6803-alice.bin', sub: 'MATRA ALICE' },
];
const runFrames = (s, n) => { for (let i = 0; i < n; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };
const pressKey = (s, ch) => { s.shownMachine.stubKeys.push(ch.charCodeAt(0)); runFrames(s, 2); };
const BASE = 0x4000;                     // the 6803 machines' 32x16 text screen

// each build is this source assembled with that machine's flags: exactly one of MC10/ALICE is 1
const DEFINES = { mc10: { MC10: 1, ALICE: 0, SIX09: 0, HALTCODE: 0 }, alice: { MC10: 0, ALICE: 1, SIX09: 0, HALTCODE: 0 } };
for (const { id, file, sub } of MACHINES) {
  const bin = read(file);
  const asm = Emu.assemble(src, '6803', { include, defines: DEFINES[id] });
  check(`${id}: welcome6803.asm assembles to the committed ${file}`, asm.ok && Buffer.from(Emu.toBinary(asm, { format: 'dragondos' })).equals(Buffer.from(bin)),
    asm.ok ? '' : JSON.stringify(asm.errors));
  // the fixed entry points the Session hooks, and the mailbox it reads
  const sym = (n) => asm.symbols.get(n);
  check(`${id}: the entry points match WELCOME['6803']`, sym('WELCOME') === Emu.WELCOME['6803'].start
    && sym('EVENT') === Emu.WELCOME['6803'].event && sym('SOUNDOK') === Emu.WELCOME['6803'].soundOk);
  check(`${id}: the Session picks this build for the machine`, (() => {
    const s = new Emu.Session(); s.switchMachine(id); return s.welcomeFile === file;
  })());

  const s = new Emu.Session();
  s.switchMachine(id);
  const events = [];
  s.on((e) => { if (e.startsWith('welcome:')) events.push(e); });
  s.startWelcome(bin);
  runFrames(s, 50);
  const m = s.shownMachine, ram = (a) => m.ram[a];
  const row = (r) => Array.from({ length: 32 }, (_, i) => ram(BASE + r * 32 + i));

  check(`${id}: the welcome program is running`, s.welcomeRunning);
  // stripe: the eight colours, four cells each, at the top (built a block a frame) and the bottom (at once)
  check(`${id}: the stripe shows the eight VDG colours, top and bottom`, row(0).join() === stripe.join() && row(15).join() === stripe.join(),
    `${row(0).map((v) => v.toString(16)).join(' ')}`);
  // the black band behind the letters: row 1 and row 5 fully black, and the letters' rows outside the art
  check(`${id}: the black band is black (rows 1 and 5)`, row(1).every((v) => v === 0x80) && row(5).every((v) => v === 0x80));
  // CLOADM: decode the SG4 quarters back into pixels and compare with the hand-built art
  const pixels = Array.from({ length: 6 }, (_, y) => {
    let line = '';
    for (let c = 1; c < 30; c++) {
      const v = ram(BASE + (2 + (y >> 1)) * 32 + c), top = !(y & 1);
      line += (v & (top ? 8 : 2) ? '#' : '.') + (v & (top ? 4 : 1) ? '#' : '.');
      if (!(v & 0x80) || (v & 0x70)) line += '?';   // must be green SG4 cells
    }
    return line;
  });
  check(`${id}: CLOADM in green block letters`, pixels.join('\n') === wantPixels.join('\n'), `\n${pixels.join('\n')}`);
  // the subtitle names the machine this build runs on: raw cells at its place (row 6, column 3)
  const subRow = row(6).slice(3, 3 + sub.length + 3);
  const start = subRow.indexOf(cells(sub)[0]);
  check(`${id}: the subtitle is "${sub}"`, start >= 0 && subRow.slice(start, start + sub.length).join() === cells(sub).join(),
    row(6).map((v) => v.toString(16)).join(' '));
  check(`${id}: the subtitle is the other machine's nowhere on the screen`,
    !s.screenText().some((l) => (id === 'mc10' ? l.includes('MATRA ALICE') : l.includes('TANDY MC-10'))));
  // menu lines: raw cells, digit in inverse video then the text
  const menu = (r, digit, text) => [inverse(digit), ...cells(text)];
  const line = (r, digit, text) => row(r).slice(4, 4 + menu(r, digit, text).length).join() === menu(r, digit, text).join();
  check(`${id}: menu line 1 (raw cells)`, line(8, '1', ' TALK TO LIZA'), row(8).join());
  check(`${id}: menu line 2`, line(9, '2', ' COLOUR AND SOUND'));
  check(`${id}: menu line 3`, line(10, '3', ' ADD YOUR ROMS FOR BASIC'));
  check(`${id}: menu line 4`, line(11, '4', ' CHAT WITH CLAUDE'));
  check(`${id}: menu line 5 is WYRMFIRE`, line(12, '5', ' PLAY WYRMFIRE (DRAGON 64)'), s.screenText()[12]);
  check(`${id}: a blank row between the greeting and the menu, and between the menu and the prompt`, row(7).every((v) => v === 0x60) && row(13).every((v) => v === 0x60));
  check(`${id}: "PRESS 1 TO 5" (raw cells)`, s.screenText()[14] === '          PRESS 1 TO 5          ' && row(14).slice(10, 10 + cells('PRESS 1 TO 5').length).join() === cells('PRESS 1 TO 5').join());
  // option 3 with the ROMs in the sockets and the stub chosen: the Session sets ROMSW and the menu says to switch
  // them on rather than asking for what the machine already has (the same rule as the 6809 build)
  {
    const t = new Emu.Session(); t.switchMachine(id);
    // the image carries the socket's usual name, so it is loaded (unrecognised) rather than ignored
    for (const sock of t.shownMachine.profile.roms.filter((x) => x.required)) t.roms.put(id, sock.id, new Uint8Array(sock.size).fill(0x12), sock.files[0]);
    t.runWithoutRoms();
    t.startWelcome(bin); runFrames(t, 50);
    check(`${id}: ROMSW is set with the ROMs in and the stub chosen`, t.shownMachine.ram[Emu.WELCOME['6803'].romsw] === 1, String(t.shownMachine.ram[Emu.WELCOME['6803'].romsw]));
    const r3 = Array.from({ length: 32 }, (_, i) => t.shownMachine.ram[BASE + 10 * 32 + 4 + i]);
    const want = menu(10, '3', ' USE YOUR ROMS FOR BASIC');
    check(`${id}: menu line 3 then reads USE YOUR ROMS FOR BASIC`, r3.slice(0, want.length).join() === want.join(),
      r3.map((v) => String.fromCharCode(v & 0x7f)).join('').trim());
  }
  check(`${id}: the menu numbers are in inverse video`, [8, 9, 10, 11, 12].every((r, i) => ram(BASE + r * 32 + 4) === 0x31 + i));

  // keys
  pressKey(s, '6'); pressKey(s, '0'); pressKey(s, 'A');
  check(`${id}: other keys fire nothing (6 only with a carry-on line)`, !events.length, events.join());
  for (const k of ['1', '2', '3', '4', '5']) pressKey(s, k);
  check(`${id}: keys 1-5 fire their events in order, once each`, events.join() === 'welcome:liza,welcome:demo,welcome:roms,welcome:claude,welcome:wyrmfire', events.join());
  check(`${id}: the welcome program keeps running after the events`, s.welcomeRunning && s.screenText()[14].includes('PRESS 1 TO 5'));
  // the shipping build has no HALT: it is still polling keys a long time later (the screen is unchanged)
  const before = row(6).join();
  runFrames(s, 120);
  check(`${id}: the shipping build never halts (screen unchanged after 120 more frames)`, s.welcomeRunning && row(6).join() === before);

  // with a carry-on line: the options move up a row (7-11), the carry-on is option 6 on row 12, a blank row, then
  // PRESS 1 TO 6; key 6 carries on and key 5 is still WYRMFIRE
  {
    const t = new Emu.Session(); t.switchMachine(id);
    const ev = [];
    t.on((e) => { if (e.startsWith('welcome:')) ev.push(e); });
    const said = t.startWelcome(bin, { carryOn: 'LIZA' }); runFrames(t, 50);
    const tx = t.screenText(), tr = (r) => Array.from({ length: 32 }, (_, i) => t.shownMachine.ram[BASE + r * 32 + i]);
    check(`${id}: with a carry-on, the greeting on row 6 and options 1-5 on rows 7-11`, tx[6].trim() === sub && tx[7].trim() === '1 TALK TO LIZA'
      && tx[11].trim() === '5 PLAY WYRMFIRE (DRAGON 64)', JSON.stringify(tx.slice(6, 15)));
    check(`${id}: with a carry-on, option 6 on row 12 (inverse digit), a blank row, then PRESS 1 TO 6`, tx[12].trim() === '6 CARRY ON WITH LIZA'
      && tr(12)[4] === 0x36 && tr(13).every((v) => v === 0x60) && tx[14] === '          PRESS 1 TO 6          ', JSON.stringify(tx.slice(12, 15)));
    check(`${id}: startWelcome says 1 to 6 with a carry-on`, said === 'Welcome: press 1 to 6', said);
    pressKey(t, '7'); pressKey(t, '6'); pressKey(t, '5');
    check(`${id}: with a carry-on, 6 carries on and 5 is WYRMFIRE`, ev.join() === 'welcome:carryon,welcome:wyrmfire', ev.join());
  }
}

// the shipping build and the HALTCODE=1 comparison build (the one MAME runs) differ ONLY at the two fixed
// 2-byte slots: NOP NOP in the shipping image, BRA <HALT> and BRA <self> in the comparison. Same length, same
// HALT address, and every other byte identical - so the program MAME compares is the program the page ships.
for (const { id, file } of MACHINES) {
  const ship = Emu.assemble(src, '6803', { include, defines: Object.assign({}, DEFINES[id], { HALTCODE: 0 }) });
  const comp = Emu.assemble(src, '6803', { include, defines: Object.assign({}, DEFINES[id], { HALTCODE: 1 }) });
  const a = Emu.toBinary(ship, { format: 'dragondos' }), b = Emu.toBinary(comp, { format: 'dragondos' });
  const diff = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diff.push(i);
  const slots = diff.length === 4 && diff[1] - diff[0] === 1 && diff[3] - diff[2] === 1;
  check(`${id}: shipping and comparison builds differ only at the HALT sites`,
    ship.ok && comp.ok && a.length === b.length && slots, `${a.length}/${b.length} bytes, differ at ${diff.map((i) => i.toString(16)).join(' ')}`);
  check(`${id}: the comparison build's HALT is in the shipping build at the same address`,
    ship.symbols.get('HALT') === comp.symbols.get('HALT'));
  // the slots hold what they should: $01 is 6803 NOP; BRA +n and BRA -n are $20 with a signed offset
  check(`${id}: the shipping slots are NOP NOP and the comparison's are BRA`,
    a[diff[0]] === 0x01 && a[diff[1]] === 0x01 && b[diff[0]] === 0x20 && b[diff[2]] === 0x20,
    `${a[diff[0]].toString(16)} ${a[diff[1]].toString(16)} / ${b[diff[0]].toString(16)} ${b[diff[2]].toString(16)}`);
}

// the two machine builds differ ONLY in the subtitle bytes: same length, and every difference is inside the string
{
  const a = read(MACHINES[0].file), b = read(MACHINES[1].file);
  const diff = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diff.push(i);
  check('the two machine builds are the same length', a.length === b.length, `${a.length} ${b.length}`);
  // the subtitle is 12 chars (MC-10) vs 11 (Alice) plus the 0: 9 bytes differ at most, all inside one run
  check('the two machine builds differ only in the subtitle', diff.length <= 13 && diff.length > 0 && diff[diff.length - 1] - diff[0] < 16,
    `${diff.length} bytes differ: ${diff.map((i) => i.toString(16)).join(' ')}`);
}

// the tune (once the page has unlocked sound): it toggles the sound bit of the $BFFF latch and nothing else. Reading
// $BFFF gives the keyboard rows, not the latch (js/machines/mc10.js read), so a read-modify-write of it put key bits
// into the video bits and left the screen in a graphics mode; the program keeps the latch value in RAM instead.
// The half periods are counted in the program's own variable, so it writes nothing outside its screen and RAM.
for (const { id, file } of MACHINES) {
  const s = new Emu.Session();
  s.switchMachine(id);
  s.welcomeSound();
  s.startWelcome(read(file), { reason: 'visit' });   // (a visit's tune: after a switch it is silent, tests/welcome-tune.test.js)
  const m = s.shownMachine, latch = new Set(), outside = [];
  const write = m.write.bind(m);
  m.write = (a, v) => { a &= 0xFFFF; if (a === 0xBFFF) latch.add(v); else if (a < 0x4000 && a >= 0x100) outside.push(a); return write(a, v); };
  let f = 0;
  while (m.ram[0x5005] !== 1 && f < 200) { runFrames(s, 1); f++; }
  runFrames(s, 600);
  check(`${id}: the tune writes only the sound bit to the latch, and leaves the text screen (latch 0)`,
    m.ram[0x5005] === 1 && [...latch].every((v) => v === 0 || v === 0x80) && latch.has(0x80) && m.latch === 0, [...latch].map((v) => v.toString(16)).join(' '));
  check(`${id}: the tune writes nowhere below the screen`, !outside.length, outside.slice(0, 5).map((a) => a.toString(16)).join(' '));
  check(`${id}: the menu is still on the screen after the tune`, s.screenText()[8].trim() === '1 TALK TO LIZA', s.screenText()[8]);
}

console.log(fail ? `${fail} FAILED` : 'all 6803 welcome checks passed');
process.exitCode = fail ? 1 : 0;
