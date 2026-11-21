// docs/game-development.md: its programs and commands run, so the guide cannot rot.
//  - every ```asm block that starts with "; example: NAME" is assembled and run on the Dragon 64 and the CoCo with
//    no ROMs, through the command line, and checked:
//      hello   POLCAT and CHROUT: the message, then the key typed, on the screen
//      pmode4  a 128x64 rectangle in PMODE 4: the screen is graphics, and exactly 128 x 64 pixels of the picture
//              are lit, in one block of that size at pixel (64, 64)
//      vsync   the field sync interrupt through $010C counts frames: after N more frames, N more counted
//    and every example has a check here (and every check an example);
//  - the play script the guide quotes is the starter game's script, line for line (its "..." aside);
//  - the guide's WAV command, run as written, gives the reference WAV byte for byte;
//  - the two settling patterns ("# pattern: settle|release|held" blocks) run as written and pass, and each is shown
//    to matter: the picture before the extra frame differs from the one after it, and the held-key command fails on
//    a starter game with its release wait taken out.
// Run: node tests/game-guide.test.js
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { spawnSync } = require('child_process');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cloadm.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-guide-'));
const tmp = (n) => path.join(TMP, n);
function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(r.stdout); } catch (e) { json = null; } }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'game-development.md'), 'utf8');
const blocks = (lang) => [...DOC.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1]);
// the pixels of a PNG the tool wrote (8-bit RGBA)
function pixels(file) {
  const buf = fs.readFileSync(file);
  let at = 8, w = 0, h = 0;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8), data = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), out = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    if (raw[y * (w * 4 + 1)] !== 0) throw new Error('filter');
    for (let x = 0; x < w; x++) out[y * w + x] = raw.readUInt32BE(y * (w * 4 + 1) + 1 + x * 4);
  }
  return { w, h, px: out };
}

const examples = {};
for (const b of blocks('asm')) {
  const m = /^; example: (\S+)/.exec(b);
  if (m) examples[m[1]] = b;
}
const CHECKS = {
  hello(machine, file) {
    const r = cli(['--machine', machine, '--asm', file, '--frames', '5', '--type', 'Z', '--expect-screen', 'PRESS A KEY\\nZ', '--json']);
    return [r.code === 0, r.err];
  },
  pmode4(machine, file) {
    const r = cli(['--machine', machine, '--asm', file, '--frames', '10', '--screen', '--screenshot', tmp('p4.png'), '--json']);
    if (r.code !== 0) return [false, r.err];
    const text = r.json.steps.find((x) => x.step === 'screen').text;
    const { w, h, px } = pixels(tmp('p4.png'));
    // lit: a pixel of the active area (256 x 192 from (32, 24)) whose green is over a quarter; on the NTSC CoCo the
    // rectangle's edges carry artifact colours, so it is the lit pixels that are counted, not one colour
    let lit = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 24; y < 216; y++) {
      for (let x = 32; x < 288; x++) {
        if (((px[y * w + x] >>> 16) & 0xFF) <= 0x40) continue;
        lit++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
    return [text === false && lit === 128 * 64 && x1 - x0 + 1 === 128 && y1 - y0 + 1 === 64 && y0 === 24 + 64 && x0 === 32 + 64, `${lit} lit, ${x0},${y0}-${x1},${y1}`];
  },
  vsync(machine, file) {
    const sym = cli(['--machine', machine, '--asm', file, '--json']).json.steps[0].symbols.FRAMES;
    const r = cli(['--machine', machine, '--asm', file, '--frames', '10', '--peek', String(sym), '--frames', '37', '--peek', String(sym), '--peek', '$0400', '--json']);
    if (r.code !== 0) return [false, r.err];
    const p = r.json.steps.filter((x) => x.step === 'peek').map((x) => x.bytes[0]);
    return [p[1] - p[0] === 37 && p[0] >= 9 && p[2] === p[1], p.join(' ')];
  },
};
check('the guide has the examples this test checks, and no others', Object.keys(examples).sort().join() === Object.keys(CHECKS).sort().join(), Object.keys(examples).join());
for (const [name, src] of Object.entries(examples)) {
  fs.writeFileSync(tmp(`${name}.asm`), src);
  for (const machine of ['dragon64', 'coco']) {
    const [ok, detail] = CHECKS[name] ? CHECKS[name](machine, tmp(`${name}.asm`)) : [false, 'no check'];
    check(`example ${name} on the ${machine}`, ok, detail);
  }
}

// the quoted script is the starter game's
{
  const quoted = blocks('text').find((b) => b.includes('load examples/starter-game/catch.bin'));
  const script = fs.readFileSync(path.join(ROOT, 'examples', 'starter-game', 'catch.cloadm'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  const lines = quoted ? quoted.trim().split('\n') : [];
  let at = 0, ok = lines.length > 5;
  for (const l of lines) {
    if (l === '...') continue;
    const i = script.indexOf(l, at);
    if (i < 0) { ok = false; break; }
    at = i + 1;
  }
  check('the play script in the guide is the starter game\'s script, in order', ok);
}

// the WAV command, as written
{
  const sh = blocks('sh').find((b) => b.includes('--wav catch.wav'));
  const cmd = sh ? sh.replace(/\\\n\s*/g, ' ').split('\n')[0] : '';
  const args = [...cmd.matchAll(/'([^']*)'|(\S+)/g)].map((m) => (m[1] != null ? m[1] : m[2]));
  check('the guide\'s WAV command is a cloadm command line', args[0] === 'node' && args[1] === 'bin/cloadm.js', cmd);
  const r = cli(args.slice(2).map((a) => (a === 'catch.wav' ? tmp('catch.wav') : a)));
  check('the guide\'s WAV command gives the reference WAV byte for byte', r.code === 0
    && fs.readFileSync(tmp('catch.wav')).equals(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'starter-game', 'catch-sound.wav'))), r.err);
}

// the settling patterns, as written
{
  const argsOf = (name) => {
    const b = blocks('sh').find((x) => x.startsWith(`# pattern: ${name}\n`));
    const cmd = b ? b.split('\n').slice(1).join('\n').replace(/\\\n\s*/g, ' ').split('\n')[0] : '';
    const a = [...cmd.matchAll(/'([^']*)'|(\S+)/g)].map((m) => (m[1] != null ? m[1] : m[2]));
    return a[0] === 'node' && a[1] === 'bin/cloadm.js' ? a.slice(2) : null;
  };
  const settle = argsOf('settle'), release = argsOf('release'), held = argsOf('held');
  check('the guide has the three pattern commands', settle && release && held);
  if (settle && release && held) {
    const r = cli(settle.map((a) => (a === 'playfield.png' ? tmp('settled.png') : a)));
    check('pattern settle: runs as written', r.code === 0, r.err);
    // the same command without the extra frame: its picture is the half-drawn frame, not the settled one
    const i = settle.indexOf('--frames');
    const early = settle.slice(0, i).concat(settle.slice(i + 2)).map((a) => (a === 'playfield.png' ? tmp('early.png') : a));
    const e = cli(early);
    check('pattern settle: without --frames 1 the picture differs', e.code === 0
      && !fs.readFileSync(tmp('early.png')).equals(fs.readFileSync(tmp('settled.png'))), e.err);
    const rr = cli(release);
    check('pattern release: playing again after the game ends runs as written', rr.code === 0, rr.err);
    const h = cli(held);
    check('pattern held: SPACE held to past the game\'s end leaves the game-over screen', h.code === 0, h.err);
    // the starter game with WAITSP's release loop taken out (BNE WAITSP -> two NOPs, same size): the held-key
    // command must now fail, so it is what catches a game that does not wait for the release
    const src = fs.readFileSync(path.join(ROOT, 'examples', 'starter-game', 'catch.asm'), 'utf8');
    const loop = '        BITA    #KSPACE\n        BNE     WAITSP\n';
    fs.writeFileSync(tmp('norelease.asm'), src.replace(loop, '        BITA    #KSPACE\n        NOP\n        NOP\n'));
    const m = cli(held.map((a) => (a === '--load' ? '--asm' : a === 'examples/starter-game/catch.bin' ? tmp('norelease.asm') : a)));
    check('pattern held: fails on a game that does not wait for the release', src.includes(loop) && m.code === 1 && /\$3005 holds \$01/.test(m.err), m.err);
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
