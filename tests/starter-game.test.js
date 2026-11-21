// The starter game (examples/starter-game/catch.asm): the guide's worked example of testing a game with the command
// line (docs/game-development.md), and its visual and audio regression references.
//  - the committed catch.bin is what the bundled assembler builds from catch.asm (tools/build-examples.js);
//  - the play script (examples/starter-game/catch.cloadm) passes on the Dragon 32, 64 and 200 and the CoCo 1/2: keys
//    held in the matrix move the paddle, two blocks are caught (SCORE, the screen), the frame matches the reference
//    PNG in tests/fixtures/starter-game pixel for pixel, three misses end the game. The reference is per video chip:
//    these machines all draw with the MC6847;
//  - on the CoCo 2B (the MC6847T1, other letter shapes) and the CoCo 3 (a 640-pixel-wide frame) the same play passes
//    without the picture, and the CoCo 2B's picture differs from the reference (so the claim above is a real limit);
//  - the catch sound, recorded with --wav, is byte-identical to tests/fixtures/starter-game/catch-sound.wav, and has
//    the pitches the source's cycle counts give (CPU clock / 2 / (18 + 8 x A) for A = 30 and 20);
//  - the tests turn red when the game is wrong: a paddle that does not move, a catch that does not score, a
//    different sound and a different colour are each built here from a changed source and must fail.
// Only project firmware: the game runs on the built-in firmware, no ROM.
// Run: node tests/starter-game.test.js
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'cloadm.js');
const DIR = path.join(ROOT, 'examples', 'starter-game');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'starter-game');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-game-'));
const tmp = (n) => path.join(TMP, n);
function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(r.stdout); } catch (e) { json = null; } }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}
const SOURCE = fs.readFileSync(path.join(DIR, 'catch.asm'), 'utf8');
const build = (src) => { const r = Emu.assemble(src, '6809'); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return Buffer.from(Emu.toBinary(r)); };

// ---- the build ----
const bin = build(SOURCE);
check('catch.bin is what the bundled assembler builds from catch.asm (node tools/build-examples.js)', bin.equals(fs.readFileSync(path.join(DIR, 'catch.bin'))));
check('the game loads at $3000 and fits below $4000 (a 16K machine runs it)', (() => { const r = Emu.assemble(SOURCE, '6809'); return r.exec === 0x3000 && r.segments.every((g) => g.addr >= 0x3000 && g.addr + g.data.length <= 0x4000); })());

// ---- the play script ----
const SCRIPT = path.join(DIR, 'catch.cloadm');
for (const machine of ['dragon64', 'dragon32', 'dragon200', 'coco']) {
  const r = cli(['--machine', machine, '--script', SCRIPT, '--json']);
  const shot = r.json && r.json.steps.find((x) => x.step === 'expect-screenshot');
  check(`${machine}: the play script passes: two catches, the picture, game over`, r.code === 0 && shot && shot.differing === 0, r.err || (r.json && r.json.error && r.json.error.message));
}
// the CoCo 2B (MC6847T1) and the CoCo 3 (640 pixels wide): the same play, without the picture
{
  const lines = fs.readFileSync(SCRIPT, 'utf8').split('\n').filter((l) => !/^expect-screenshot /.test(l));
  fs.writeFileSync(tmp('nopic.cloadm'), lines.join('\n'));
  for (const machine of ['coco2b', 'coco3']) {
    const r = cli(['--machine', machine, '--script', tmp('nopic.cloadm')]);
    check(`${machine}: the play script without the picture passes`, r.code === 0, r.err);
  }
  const t1 = cli(['--machine', 'coco2b', '--script', SCRIPT, '--json']);
  check('coco2b: the MC6847 reference picture does not match the MC6847T1\'s', t1.code === 1 && t1.json.error.code === 'expect-failed' && t1.json.error.screenshot.differing > 0);
}

// ---- the catch sound ----
const SOUND = ['--wait-for', 'text:PRESS SPACE', '--hold', 'SPACE:2', '--wait-for', 'mem:$3005=1', '--hold', 'LEFT', '--wait-for', 'mem:$3008=14'];
const soundOf = (file, extra = []) => cli(['--load', file, ...SOUND, '--wav', tmp('catch.wav'), '--frames', '12', '--wav-stop', '--expect-mem', '$3003=1', ...extra]);
{
  const r = soundOf(path.join(DIR, 'catch.bin'));
  const got = fs.readFileSync(tmp('catch.wav')), want = fs.readFileSync(path.join(FIX, 'catch-sound.wav'));
  check('the catch sound is byte-identical to the reference WAV', r.code === 0 && got.equals(want), r.err);
  // the reference itself: the two tones' pitches, from the rising edges of the 0 <-> 20160 square wave
  const n = (want.length - 44) / 2, v = Array.from({ length: n }, (_, i) => want.readInt16LE(44 + i * 2));
  const ups = [];
  for (let i = 1; i < n; i++) if (v[i - 1] < 10080 && v[i] >= 10080) ups.push(i);
  const hz = (a, b) => (b - a) / ((ups[b] - ups[a]) / 44100);
  const clock = 888625;   // the Dragon's CPU clock (14.218 MHz / 16)
  // crossings of mid-scale upwards: tone 1 starts high from the resting level (no crossing), so its 30 periods
  // give 29 (ups 0-28); tone 2's 50 high halves give 50 (ups 29-78); the return to rest is the 80th
  const f1 = hz(0, 28), f2 = hz(29, 78);
  check(`the reference's tones: ${f1.toFixed(1)} Hz and ${f2.toFixed(1)} Hz, as CPU clock / 2 / (18 + 8 x 30) and / (18 + 8 x 20) (within 0.5%)`,
    ups.length === 80 && Math.abs(f1 / (clock / 2 / 258) - 1) < 0.005 && Math.abs(f2 / (clock / 2 / 178) - 1) < 0.005, `${ups.length} edges`);
  check('the reference holds only the resting level, 0, full scale and the edges between', v.filter((x) => x === 10240 || x === 0 || x === 20160).length > n - 200);
}

// ---- mutations: a wrong game fails its tests ----
const mutants = [
  ['the paddle does not move left', 'DECB\nPM1', 'NOP\nPM1'],
  ['a catch does not score', '        INC     SCORE\n', '        NOP\n        NOP\n        NOP\n'],
  ['the catch sound is a semitone off', 'SNDCATCH LDA    #30', 'SNDCATCH LDA    #32'],
  ['the paddle is another colour', 'PADDLE  EQU     $9F', 'PADDLE  EQU     $AF'],
];
for (const [what, from, to] of mutants) {
  if (!SOURCE.includes(from)) { check(`mutant "${what}": its text is in the source`, false); continue; }
  fs.writeFileSync(tmp('m.bin'), build(SOURCE.replace(from, to)));
  const script = fs.readFileSync(SCRIPT, 'utf8').replace('load examples/starter-game/catch.bin', `load ${tmp('m.bin')}`);
  fs.writeFileSync(tmp('m.cloadm'), script);
  const play = cli(['--script', tmp('m.cloadm')]);
  const sound = soundOf(tmp('m.bin'));
  const same = fs.existsSync(tmp('catch.wav')) && fs.readFileSync(tmp('catch.wav')).equals(fs.readFileSync(path.join(FIX, 'catch-sound.wav')));
  check(`mutant "${what}": the play script or the sound reference fails`, play.code === 1 || sound.code === 1 || !same, `${play.code} ${sound.code} ${same}`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
