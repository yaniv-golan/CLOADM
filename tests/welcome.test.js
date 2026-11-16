// The welcome program (examples/welcome.asm) on every 6809 model, headless, without ROMs:
// the screen shows the colour stripe, CLOADM in block letters and the menu; keys 1-4 fire the Session's
// welcome events (and nothing else does); the tune waits for the audio unlock and then plays the expected
// notes on the DAC; loading another program ends the welcome hooks. Expected values are written here from
// the specification (VDG codes from the MC6847 data sheet's SG4 layout, note frequencies from equal
// temperament), not taken from the program.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'examples/welcome.asm'), 'utf8');
const bin = new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples/welcome.bin')));
// the same include resolver and the same flags tools/build-examples.js passes: the data file needs them
const include = (name) => {
  const p = path.join(ROOT, 'examples', name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};
const DEFINES = { MC10: 0, ALICE: 0, SIX09: 1 };

// the committed binary is the source assembled; the fixed entry points are where the Session hooks them
const asm = Emu.assemble(src, '6809', { include, defines: DEFINES });
check('welcome.asm assembles to the committed welcome.bin', asm.ok && Buffer.from(Emu.toBinary(asm)).equals(Buffer.from(bin)), asm.errors.join('; '));
// the subtitle comes from the include, and the flags are not optional: with none passed the build fails
// rather than silently taking some other machine's name
const noFlags = Emu.assemble(src, '6809', { include });
check('the welcome build without its machine flags is an error', !noFlags.ok && /MC10/.test(noFlags.errors.map((e) => e.message).join(' ')), JSON.stringify(noFlags.errors));
const sym = (n) => asm.symbols.get(n);
check('fixed addresses match Session WELCOME', sym('WELCOME') === Emu.WELCOME['6809'].start && sym('EVENT') === Emu.WELCOME['6809'].event
  && sym('SOUNDOK') === Emu.WELCOME['6809'].soundOk && sym('GREET') === Emu.WELCOME['6809'].greet && sym('CARRY') === Emu.WELCOME['6809'].carry
  && sym('CARRYN') === Emu.WELCOME.carryMax && Emu.WELCOME.events.join() === 'liza,demo,roms,claude,carryon');

// SG4 cell: bit 7 set, colour in bits 6-4, quarters upper-left 3, upper-right 2, lower-left 1, lower-right 0
const VDG = ['green', 'yellow', 'blue', 'red', 'buff', 'cyan', 'magenta', 'orange'];
// CLOADM, 8x6 pixels a letter, one column of cells (2 pixels) between letters
const ART = {
  C: ['.######.', '##....##', '##......', '##......', '##....##', '.######.'],
  L: ['##......', '##......', '##......', '##......', '##......', '#######.'],
  O: ['.######.', '##....##', '##....##', '##....##', '##....##', '.######.'],
  A: ['.######.', '##....##', '##....##', '########', '##....##', '##....##'],
  D: ['######..', '##...##.', '##....##', '##....##', '##...##.', '######..'],
  M: ['##....##', '###..###', '########', '##.##.##', '##....##', '##....##'],
};
const wantPixels = Array.from({ length: 6 }, (_, y) => [...'CLOADM'].map((ch) => ART[ch][y]).join('..'));

const clock = () => { let t = 0; return { now: () => t, tick: (ms) => { t += ms; } }; };
const runFrames = (s, n) => { for (let i = 0; i < n; i++) s.advance(1000 / s.machine.fps + 0.01); };
const pressKey = (s, ch) => { s.machine.stubKeys.push(ch.charCodeAt(0)); runFrames(s, 2); };

// starting the welcome program is announced ('welcome'), after it is running: the page's quick-save slots, hidden
// while the welcome program is all that has run, decide on it (their first listing can come before the start)
{
  const s = new Emu.Session();
  s.switchMachine('dragon64');
  const seen = [];
  s.on((e) => { if (e === 'welcome') seen.push(s.welcomeRunning); });
  s.startWelcome(bin);
  check('startWelcome emits welcome, with the welcome program running', seen.length === 1 && seen[0] === true, JSON.stringify(seen));
}
const models = Object.values(Emu.profiles).filter((p) => p.options.cpu.values[0] === '6809').map((p) => p.id);
check('every 6809 model is covered', models.length >= 11, models.join(' '));
for (const id of models) {
  const s = new Emu.Session();
  s.switchMachine(id);
  const events = [];
  s.on((e) => { if (e.startsWith('welcome:')) events.push(e); });
  s.startWelcome(bin);
  runFrames(s, 50);
  const m = s.machine, ram = (a) => m.ram[a];
  const screen = s.screenText();
  // stripe: 32 cells, four of each colour in order, at the top (built) and bottom (drawn at once)
  const stripe = (row) => Array.from({ length: 32 }, (_, i) => ram(0x400 + row * 32 + i));
  const want = Array.from({ length: 32 }, (_, i) => 0x8F | (VDG.indexOf(VDG[i >> 2]) << 4));
  check(`${id}: the stripe shows the eight VDG colours`, stripe(0).join() === want.join() && stripe(15).join() === want.join());
  // big letters: decode the SG4 quarters back into pixels
  const pixels = Array.from({ length: 6 }, (_, y) => {
    let line = '';
    for (let c = 1; c < 30; c++) {
      const v = ram(0x400 + (2 + (y >> 1)) * 32 + c), top = !(y & 1);
      line += (v & (top ? 8 : 2) ? '#' : '.') + (v & (top ? 4 : 1) ? '#' : '.');
      if (!(v & 0x80) || (v & 0x70)) line += '?';   // must be green SG4 cells
    }
    return line;
  });
  check(`${id}: CLOADM in green block letters`, pixels.join('\n') === wantPixels.join('\n'), `\n${pixels.join('\n')}`);
  check(`${id}: subtitle and menu`, screen[7].trim() === 'DRAGON AND COLOR COMPUTER' && screen[9].trim() === '1 TALK TO LIZA'
    && screen[10].trim() === '2 COLOUR AND SOUND' && screen[11].trim() === '3 ADD YOUR ROMS FOR BASIC'
    && screen[12].trim() === '4 CHAT WITH CLAUDE' && screen[14].trim() === 'PRESS 1 TO 4', JSON.stringify(screen.slice(7, 15)));
  check(`${id}: the menu numbers are in inverse video`, [9, 10, 11, 12].every((r, i) => ram(0x400 + r * 32 + 4) === 0x31 + i));
  // keys
  pressKey(s, '5'); pressKey(s, 'A');
  check(`${id}: other keys fire nothing`, !events.length, events.join());
  for (const k of ['1', '2', '3', '4']) pressKey(s, k);
  check(`${id}: keys 1-4 fire their events in order, once each`, events.join() === 'welcome:liza,welcome:demo,welcome:roms,welcome:claude', events.join());
  check(`${id}: the welcome program keeps running after the events`, s.welcomeRunning && /PRESS 1 TO 4/.test(s.screenText()[14]));
}

// sound: nothing before the unlock; then the tune, once
{
  const NOTES = [['C5', 72], ['E5', 76], ['G5', 79], ['E5', 76], ['C6', 84], ['A5', 81], ['G5', 79], ['E5', 76], ['D5', 74], ['C5', 72]];
  const freq = (midi) => 440 * 2 ** ((midi - 69) / 12);
  for (const id of ['dragon64', 'coco', 'coco3']) {
    const s = new Emu.Session();
    s.switchMachine(id);
    s.startWelcome(bin);
    const m = s.machine;
    const edges = [];   // [absolute tick, level]
    const frames = (n) => { for (let i = 0; i < n; i++) { const base = m.frameBase; m.runFrame(); for (let k = 2; k < m.audioEvents.length; k += 2) edges.push([base + m.audioEvents[k], m.audioEvents[k + 1]]); } };
    frames(100);
    const levelsBefore = new Set(edges.map((e) => e[1]));
    check(`${id}: silent until audio is unlocked`, edges.filter((e) => e[1] > 0.9).length === 0, [...levelsBefore].join());
    s.welcomeSound();
    edges.length = 0;
    frames(Math.ceil(m.fps * 3));
    // notes: runs of alternating high/low edges; a gap of mid level separates notes
    const notes = [];
    let cur = null;
    for (let i = 1; i < edges.length; i++) {
      const [t, lv] = edges[i], [t0, lv0] = edges[i - 1];
      const tone = (lv > 0.9 && lv0 < 0.1) || (lv < 0.1 && lv0 > 0.9);
      if (tone) { if (!cur) { cur = { half: [], start: t0 }; notes.push(cur); } cur.half.push(t - t0); cur.end = t; } else cur = null;
    }
    const got = notes.map((n) => { const h = n.half.reduce((a, b) => a + b) / n.half.length; return { f: m.tickHz / (2 * h), dur: (n.end - n.start) / m.tickHz }; });
    const ok = got.length === NOTES.length && got.every((g, i) => Math.abs(g.f / freq(NOTES[i][1]) - 1) < 0.015);
    check(`${id}: the tune plays C5 E5 G5 E5 C6 A5 G5 E5 D5 C5 within 1.5 %`, ok, got.map((g) => g.f.toFixed(0)).join(' '));
    check(`${id}: long notes are long (C6 and the last C5 at least 3x the others)`, got.length === 10 && got[4].dur > 3 * got[0].dur && got[9].dur > 3 * got[0].dur,
      got.map((g) => g.dur.toFixed(2)).join(' '));
    edges.length = 0;
    frames(Math.ceil(m.fps));
    check(`${id}: the tune plays once`, !edges.some((e) => e[1] > 0.9));
  }
}

// the Session's rules
{
  // every machine has a build, and the Session names it: 6809 models the 6809 file, the MC-10 and Alice
  // their own 6803 builds (their subtitles differ); see tests/welcome6803.test.js for those two running
  for (const id of models) {
    const s = new Emu.Session(); s.switchMachine(id);
    if (s.welcomeFile !== 'welcome.bin') { fail++; console.log(`FAIL ${id}: welcomeFile is ${s.welcomeFile}`); }
  }
  const s = new Emu.Session();
  s.switchMachine('dragon32');
  s.addRoms([{ name: 'd32.rom', bytes: new Uint8Array(0x4000).fill(0x12) }]);
  s.startWelcome(bin);
  check('with ROMs loaded it runs on the stub', s.machine.useStub && s.welcomeRunning);
  const events = [];
  s.on((e) => events.push(e));
  s.load('liza.bin', new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples/liza.bin'))), { remember: false });
  check('loading another program ends the welcome', !s.welcomeRunning);
  s.machine.ram[Emu.WELCOME['6809'].event] = 1;   // LIZA's memory, not a mailbox any more
  s.advance(1000 / s.machine.fps + 0.01);
  check('after it ends, the mailbox address is not read', !events.some((e) => e.startsWith('welcome:')));
  s.startWelcome(bin);
  s.switchMachine('coco');
  check('switching machine ends it', !s.welcomeRunning);
  s.startWelcome(bin);
  s.powerCycle();
  check('a power cycle ends it', !s.welcomeRunning);
  // the sound flag carries over to the next start
  const t = new Emu.Session();
  t.switchMachine('dragon64');
  t.welcomeSound();
  t.startWelcome(bin);
  check('audio unlocked before the start: the tune is armed', t.machine.ram[Emu.WELCOME['6809'].soundOk] === 1);
}

console.log(fail ? `${fail} FAILED` : 'all welcome checks passed');
process.exitCode = fail ? 1 : 0;
