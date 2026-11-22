// A program as a tape a real Dragon or CoCo can play: buildCas (a .CAS from programs), casToWav / casToSamples (the signal, with the gaps a
// player adds: the layout the emulated deck plays, js/media/cassette.js tapeGaps) and `--assemble --format cas|wav`.
//  * buildCas against streams written out here byte by byte (the stream tools/mame-diff/tape/csave.asm writes, a 600-byte file in three
//    data blocks, two files, BASIC and data files), with their checksums and leaders, and its refusals;
//  * the signal: where the silences are (2 s at the start, 1 s around each namefile), the leaders, sine and square waves, the MC-10
//    family not padded, and the length against the emulated deck's;
//  * wavToCas of our WAV gives the .CAS bytes back exactly, also with noise, speed drift, inverted phase and a DC offset added;
//  * the emulated deck plays the WAV (decoded, as the page does) into our block-reading firmware (tools/mame-diff/tape/cload.asm) and
//    the file's bytes end up in memory, on the Dragon 64, the CoCo and (counted) the MC-10;
//  * the example docs/examples/bin-to-wav.mjs runs from a temporary directory and prints what the guide quotes;
//  * mutants: the same checks against copies of the code with one breakage each (no leader before the second file, a wrong checksum, the
//    MC-10 padded); each must fail at least one check.
// MAME is the oracle for the gaps and the reader (docs/verification.md); it is not run here. Run: node tests/bin-to-tape.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-bintotape-'));
const failures = [];
let n = 0;
const record = (label) => (name, cond, detail = '') => { if (label === 'real') n++; if (!cond) failures.push({ label, name, detail }); return cond; };
const peak = (a) => { let m = -Infinity; for (const v of a) if (v > m) m = v; return m; };
const same = (a, b) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
const throwsType = (fn, re) => { try { fn(); return false; } catch (e) { return e instanceof TypeError && re.test(e.message); } };

// ---- written out here, from the format ----
const blk = (type, data, leader = 128) => { let s = (type + data.length) & 255; for (const d of data) s = (s + d) & 255; return [...new Array(leader).fill(0x55), 0x3C, type, data.length, ...data, s, 0x55]; };
const nameOf = (s) => [...s.padEnd(8)].map((c) => c.charCodeAt(0));
const namefile = (name, type, ascii, exec, load) => [...nameOf(name), type, ascii, ascii, exec >> 8, exec & 255, load >> 8, load & 255];
const prog = (len, k = 37) => Array.from({ length: len }, (_, i) => (11 + k * i) & 255);
const leaderBefore = (bytes, syncAt) => { let c = 0; while (bytes[syncAt - 1 - c] === 0x55) c++; return c; };
const syncs = (bytes) => { const out = []; for (let p = 1; p < bytes.length; p++) if (bytes[p] === 0x3C && bytes[p - 1] === 0x55) out.push(p); return out; };
// runs of exactly zero samples of at least `min` seconds: their lengths in seconds, in order
const silences = (x, rate, min) => { const out = []; let run = 0; for (let i = 0; i <= x.length; i++) { if (i < x.length && x[i] === 0) { run++; continue; } if (run >= min * rate) out.push(run / rate); run = 0; } return out; };

// ---- the library, at `root` ----
async function libraryChecks(root, check) {
  const C = await import(pathToFileURL(path.join(root, 'js/media/cassette.js')).href);
  const F = await import(pathToFileURL(path.join(root, 'js/media/formats.js')).href);
  const T = await import(pathToFileURL(path.join(root, 'js/media/tape.js')).href);
  const { buildCas, casToSamples, casToWav, wavToCas, tapeGaps, casBlocks, parseWav } = C, { parseCas } = F.formats;

  // buildCas: one file, byte by byte
  const data255 = prog(255);
  const one = buildCas([{ name: 'CLOADM', type: 'binary', load: 0x3000, exec: 0x3000, data: data255 }], { family: 'dragon' });
  const want1 = [...blk(0, namefile('CLOADM', 2, 0, 0x3000, 0x3000)), ...blk(1, data255), ...blk(0xFF, [])];
  check('buildCas: a binary is a namefile block (name padded to 8, type 2, ASCII flags 0, exec, load), its data block and an end-of-file block, each with a 128-byte leader', same(one, want1), `${one.length} vs ${want1.length}`);
  check('buildCas: the three families write the same bytes', same(buildCas([{ name: 'CLOADM', type: 'binary', load: 0x3000, exec: 0x3000, data: data255 }], { family: 'coco' }), one)
    && same(buildCas([{ name: 'CLOADM', type: 'binary', load: 0x3000, exec: 0x3000, data: data255 }], { family: 'mc10' }), one));
  check('buildCas: every block\'s checksum is the sum of its type, length and data, and casBlocks finds them all good', [...casBlocks(one)].length === 3 && [...casBlocks(one)].every((b) => b.ok));
  // 600 bytes: three data blocks of 255, 255 and 90
  const data600 = prog(600, 91);
  const big = buildCas([{ name: 'BIG', type: 'binary', load: 0x2000, exec: 0x2010, data: data600 }]);
  const wantBig = [...blk(0, namefile('BIG', 2, 0, 0x2010, 0x2000)), ...blk(1, data600.slice(0, 255)), ...blk(1, data600.slice(255, 510)), ...blk(1, data600.slice(510)), ...blk(0xFF, [])];
  check('buildCas: 600 bytes are three data blocks of 255, 255 and 90, then the end-of-file block', same(big, wantBig));
  const bigFiles = parseCas(big);
  check('buildCas: parseCas reads the 600-byte file back: its name, addresses and every byte', bigFiles.length === 1 && bigFiles[0].name === 'BIG' && bigFiles[0].load === 0x2000 && bigFiles[0].exec === 0x2010 && same(bigFiles[0].data, data600));
  check('buildCas: no data is a namefile and an end-of-file block', same(buildCas([{ name: 'EMPTY', type: 'binary', load: 0, exec: 0, data: [] }]), [...blk(0, namefile('EMPTY', 2, 0, 0, 0)), ...blk(0xFF, [])]));
  // two files: the second has a full leader in front of its namefile
  const dataB = prog(40, 5);
  const two = buildCas([{ name: 'ONE', type: 'binary', load: 0x3000, exec: 0x3000, data: data255 }, { name: 'TWO', type: 'binary', load: 0x4000, exec: 0x4001, data: dataB }]);
  const wantTwo = [...blk(0, namefile('ONE', 2, 0, 0x3000, 0x3000)), ...blk(1, data255), ...blk(0xFF, []), ...blk(0, namefile('TWO', 2, 0, 0x4001, 0x4000)), ...blk(1, dataB), ...blk(0xFF, [])];
  check('buildCas: two files are two sets of blocks, one after the other', same(two, wantTwo));
  const syn = syncs(two);
  check('buildCas: the second file\'s namefile has a full leader in front of it (at least 128 $55 bytes)', syn.length === 6 && leaderBefore(two, syn[3]) >= 128, String(leaderBefore(two, syn[3])));
  check('buildCas: every block of both files has its 128-byte leader, and the checksums are good', syn.every((s) => leaderBefore(two, s) >= 128) && [...casBlocks(two)].every((b) => b.ok));
  const twoFiles = parseCas(two);
  check('buildCas: parseCas reads both files', twoFiles.length === 2 && twoFiles[1].name === 'TWO' && twoFiles[1].load === 0x4000 && twoFiles[1].exec === 0x4001 && same(twoFiles[1].data, dataB) && same(twoFiles[0].data, data255));
  // other file types
  const bas = buildCas([{ name: 'LISTING', type: 'basic', ascii: true, data: [...'10 PRINT 1\r'].map((c) => c.charCodeAt(0)) }]);
  check('buildCas: an ASCII BASIC file is type 0 with both flags $FF and no addresses', same(bas.subarray(0, 128 + 3 + 15 + 2), Uint8Array.from(blk(0, namefile('LISTING', 0, 0xFF, 0, 0)).slice(0, 128 + 3 + 15 + 2))));
  check('buildCas: a data file is type 1', buildCas([{ name: 'D', type: 'data', data: [1] }])[128 + 3 + 8] === 1);
  // refusals
  const bad = (f, o) => throwsType(() => buildCas(f, o), /./);
  check('buildCas: an unknown family, an empty list, a long or non-ASCII name, an unknown type, a binary with no addresses and a 17-bit address are refused',
    bad([{ name: 'A', type: 'binary', load: 0, exec: 0, data: [] }], { family: 'zx' }) && bad([]) && bad([{ name: 'NINECHARS', type: 'binary', load: 0, exec: 0, data: [] }])
    && bad([{ name: 'É', type: 'binary', load: 0, exec: 0, data: [] }]) && bad([{ name: 'A', type: 'tape', data: [] }]) && bad([{ name: 'A', type: 'binary', data: [] }])
    && bad([{ name: 'A', type: 'binary', load: 0x10000, exec: 0, data: [] }]));

  // the gaps a player adds: what tapeGaps says, and what is in the signal
  const gaps = tapeGaps(two);
  const sync = syncs(two), lead = (s) => s - leaderBefore(two, s) + 1;   // where the run of $55 in front of the sync at s starts (the trailing $55 of the block before is its)
  const units = [...gaps].map(([at, g]) => [at, g.units]).filter(([, u]) => u).sort((a, b) => a[0] - b[0]);
  check('tapeGaps: 2 s of silence at the start, then 1 s after each namefile and 1 s before the second file\'s namefile', units.length === 4 && units[0][0] === 0 && units[0][1] === 2 && units.slice(1).every(([, u]) => u === 1)
    && units[1][0] > sync[0] && units[1][0] < sync[1] && units[2][0] > sync[2] && units[2][0] < sync[3] && units[3][0] > sync[3] && units[3][0] < sync[4], JSON.stringify(units));
  check('tapeGaps: a tape that already has its 128-byte leaders needs none made up', [...tapeGaps(one)].every(([, g]) => g.lead <= 0) && [...tapeGaps(two)].every(([, g]) => g.lead <= 0));
  const shortTape = Uint8Array.from([...blk(0, namefile('SHORT', 2, 0, 0x3000, 0x3000), 10), ...blk(1, prog(30), 10), ...blk(0xFF, [], 10)]);
  const madeUp = [...tapeGaps(shortTape)].filter(([, g]) => g.lead > 0).map(([at, g]) => [at, g.lead]);
  check('tapeGaps: 10-byte leaders are made up to 128 (118 more) in front of the first block and the block after the namefile, and not in front of the end-of-file block', madeUp.length === 2 && madeUp.every(([, lead]) => lead === 118), JSON.stringify(madeUp));
  const unpadded = tapeGaps(one, { pad: false });
  check('tapeGaps: with pad false (the MC-10 family) there is no silence and one leader of 128 in front of the bytes', unpadded.size === 1 && unpadded.get(0).units === 0 && unpadded.get(0).lead === 128);
  const rate = 44100;
  const sig = casToSamples(two, { family: 'dragon', sampleRate: rate });
  const quiet = silences(sig, rate, 0.9);
  check('casToSamples: a player\'s gaps: silences of 2 s, 1 s, 1 s and 1 s (at the start, after each namefile and before the second file)', quiet.length === 4 && Math.abs(quiet[0] - 2) < 1e-4 && quiet.slice(1).every((q) => Math.abs(q - 1) < 1e-4), JSON.stringify(quiet));
  check('casToSamples: the signal starts after 2 s of silence and its first sample after that is the rise of a cycle (starting upwards)', sig[2 * rate - 1] === 0 && sig[2 * rate] === 0 && sig[2 * rate + 3] > 0.3);
  check('casToSamples: gaps none plays the bytes as they are: no silence at all', silences(casToSamples(two, { gaps: 'none' }), rate, 0.1).length === 0);
  const noGapLen = casToSamples(two, { gaps: 'none' }).length, gapLen = sig.length;
  check('casToSamples: the player\'s gaps add 5 s of silence to a tape that already has its leaders', Math.abs((gapLen - noGapLen) / rate - 5) < 0.01, `${(gapLen - noGapLen) / rate}`);
  // the waves
  const sq = casToSamples(two, { wave: 'square', amplitude: 0.5 }), sn = casToSamples(two, { wave: 'sine', amplitude: 0.5 });
  check('casToSamples: a square wave has only the levels +amplitude, -amplitude and 0 (the silence); a sine has others in between', Array.from(sq).every((v) => v === 0 || Math.abs(Math.abs(v) - 0.5) < 1e-6) && Array.from(sn).some((v) => v !== 0 && Math.abs(Math.abs(v) - 0.5) > 0.05));
  check('casToSamples: the amplitude is the peak (0.5 here), and the default is 0.75', Math.abs(peak(sq) - 0.5) < 1e-6 && Math.abs(peak(casToSamples(one)) - 0.75) < 1e-3);
  check('casToSamples: a lower sample rate gives a proportionally shorter signal and the same bytes back', Math.abs(casToSamples(one, { sampleRate: 22050 }).length * 2 - casToSamples(one).length) < 4 && same(wavToCas(casToWav(one, { sampleRate: 22050 })).bytes, one));
  check('casToSamples: refuses a wave, gaps or family it does not know', throwsType(() => casToSamples(one, { wave: 'saw' }), /wave/) && throwsType(() => casToSamples(one, { gaps: 'some' }), /gaps/) && throwsType(() => casToSamples(one, { family: 'zx' }), /family/));
  // the MC-10 family: not padded
  const mc = casToSamples(two, { family: 'mc10' });
  check('casToSamples: the MC-10 family is not padded: no silence, the signal starts at once, with the 128-byte leader the deck plays in front of the bytes', silences(mc, rate, 0.1).length === 0 && mc[3] > 0.3 && Math.abs(mc.length - noGapLen - 28224) <= 3, `${mc.length - noGapLen}`);
  check('casToSamples: the MC-10 family\'s tape is as long as the deck plays it (pad false), the Dragon\'s as long as the deck plays it padded', (() => {
    const ds = new T.Tape(two, 894886, 'x', {}).seconds(), ms = new T.Tape(two, 894886, 'x', { pad: false }).seconds();
    return Math.abs(sig.length / rate - ds) / ds < 0.005 && Math.abs(mc.length / rate - ms) / ms < 0.005;
  })(), '');
  // the WAV container
  const w = casToWav(one, { wave: 'square' }), pw = parseWav(w);
  check('casToWav: a 16-bit mono PCM WAV at 44100 Hz', pw.sampleRate === 44100 && pw.channels === 1 && pw.bits === 16 && pw.samples.length > 44100 * 4);

  // wavToCas: identical bytes, clean and with what real recordings do
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const resample = (x, base, wow) => { const out = []; let t = 0; while (t < x.length - 1) { const i = Math.floor(t), f = t - i; out.push(x[i] * (1 - f) + x[i + 1] * f); t += base * (1 + wow * Math.sin(2 * Math.PI * out.length / 44100 / 2.3)); } return Float32Array.from(out); };
  for (const [what, cas, family] of [['one file', one, 'dragon'], ['two files', two, 'coco'], ['one file for the MC-10', one, 'mc10']]) {
    for (const wave of ['sine', 'square']) {
      const x = casToSamples(cas, { family, wave });
      // (the MC-10 family's tape has the deck's 128-byte leader in front of the bytes: nothing else is added)
      const expect = family === 'mc10' ? Uint8Array.from([...new Array(128).fill(0x55), ...cas]) : cas;
      const r = wavToCas(casToWav(cas, { family, wave }));
      check(`wavToCas: our ${wave} WAV of ${what} gives the .CAS bytes back, identical${family === 'mc10' ? ' (after the MC-10 deck\'s own leader)' : ''}`, same(r.bytes, expect) && r.badBlocks === 0, `(${r.bytes.length} of ${expect.length} bytes, ${r.blocks} blocks)`);
      const cases = [['inverted phase', Float32Array.from(x, (v) => -v)], ['a DC offset', Float32Array.from(x, (v) => v * 0.5 + 0.4)], ['noise (SNR 11 dB)', Float32Array.from(x, (v) => v + 0.15 * gauss())],
        ['noise (SNR 20 dB)', Float32Array.from(x, (v) => v + 0.05 * gauss())], ['8% slow', resample(x, 0.92, 0)], ['10% fast', resample(x, 1.1, 0)], ['wow of 8%', resample(x, 1, 0.08)],
        ['all of them', (() => { const y = resample(x, 0.95, 0.05); return Float32Array.from(y, (v) => -0.6 * v + 0.2 + 0.05 * gauss()); })()]];
      for (const [name, y] of cases) {
        if (family === 'coco' && wave === 'square' && name !== 'inverted phase') continue;   // (the two-file square tape: the clean and inverted cases; the rest are run on the others)
        const z = C.samplesToCas(y, 44100);
        check(`wavToCas: our ${wave} WAV of ${what} with ${name} gives the .CAS bytes back, identical`, same(z.bytes, expect) && z.badBlocks === 0, `(${z.bytes.length} of ${cas.length} bytes, ${z.blocks} blocks)`);
      }
    }
  }
  // a tape with short leaders is made up to the player's 128, the same files
  const short = Uint8Array.from([...blk(0, namefile('SHORT', 2, 0, 0x3000, 0x3000), 10), ...blk(1, prog(30), 10), ...blk(0xFF, [], 10)]);
  const padded = wavToCas(casToWav(short));
  check('casToWav: leaders shorter than a player\'s are made up (the namefile\'s and the next block\'s), the file is the same', leaderBefore(padded.bytes, syncs(padded.bytes)[0]) >= 128 && leaderBefore(padded.bytes, syncs(padded.bytes)[1]) >= 128
    && parseCas(padded.bytes).length === 1 && same(parseCas(padded.bytes)[0].data, prog(30)));
}

// ---- the emulated deck and our block-reading firmware (the real code) ----
async function deckChecks(check) {
  const Emu = await import(pathToFileURL(path.join(ROOT, 'js/emu.js')).href);
  const { firmware } = require('../tools/mame-diff/tape/spec');
  const sumOf = (a) => a.reduce((s, v) => (s + v) & 0xFFFF, 0);
  for (const [id, family] of [['dragon64', 'dragon'], ['dragon32', 'dragon'], ['coco', 'coco'], ['coco3', 'coco']]) {
    const rd = firmware(id, 'cload.asm');
    for (const [what, data, wave] of [['255 bytes, sine', prog(255), 'sine'], ['255 bytes, square', prog(255), 'square'], ['600 bytes, sine', prog(600, 91), 'sine']]) {
      const cas = Emu.buildCas([{ name: 'CLOADM', type: 'binary', load: 0x3000, exec: 0x3000, data }], { family });
      const wav = Emu.casToWav(cas, { family, wave });
      const m = rd.machine(), d = Emu.formats.identify('built.wav', wav);
      m.deck.insert(new Emu.Tape(d.bytes, m.tickHz, 'built', m.profile.tape));
      for (let f = 0; f < 50 * 40 && m.cpu.pc !== rd.haltPc; f++) m.runFrame();
      const c = m.cpu, blocks = 2 + Math.ceil(data.length / 255);
      check(`${id}: the deck plays our ${wave} WAV of ${what} into cload.asm: ${blocks} blocks, ${data.length} bytes and their sum, no bad checksum`, m.cpu.pc === rd.haltPc && c.x === data.length && c.y === sumOf(data) && c.u === blocks && c.b === 0, `pc ${c.pc.toString(16)} x ${c.x} y ${c.y} u ${c.u} b ${c.b}`);
      check(`${id}: ...and the file's bytes are in memory at $3000 (the data) and $2F00 (the namefile: name, type, flags, exec, load)`,
        data.every((v, i) => m.read(0x3000 + i) === v) && same(Array.from({ length: 15 }, (_, i) => m.read(0x2F00 + i)), namefile('CLOADM', 2, 0, 0x3000, 0x3000)));
    }
  }
  // the MC-10 and Alice: the 6803 reader reports its counts in its internal RAM, high byte first
  for (const id of ['mc10', 'alice']) {
    const rd = firmware(id, 'cload6803.asm'), data = prog(255);
    const cas = Emu.buildCas([{ name: 'CLOADM', type: 'binary', load: 0x3000, exec: 0x3000, data }], { family: 'mc10' });
    const m = rd.machine({ ram: 4 }), d = Emu.formats.identify('built.wav', Emu.casToWav(cas, { family: 'mc10' }));
    m.deck.insert(new Emu.Tape(d.bytes, m.tickHz, 'built', m.profile.tape));
    for (let f = 0; f < 50 * 40 && m.cpu.pc !== rd.haltPc; f++) m.runFrame();
    const ir = m.cpu.iram, word = (a) => (ir[a - 0x80] << 8) | ir[a - 0x80 + 1];
    check(`${id}: the deck plays our WAV (the MC-10 family: not padded) into cload6803.asm: 3 blocks, 255 bytes, their sum, no bad checksum`,
      m.cpu.pc === rd.haltPc && m.cpu.x === 255 && (m.cpu.a | (m.cpu.b << 8)) === sumOf(data) && word(0x88) === 3 && word(0x8A) === 0);
  }
}

// ---- the command line, at `root` ----
async function cliChecks(root, check) {
  const Emu = await import(pathToFileURL(path.join(root, 'js/emu.js')).href);
  const dir = fs.mkdtempSync(path.join(TMP, 'cli-'));
  const cli = (args) => { const r = spawnSync(process.execPath, [path.join(root, 'cli/cloadm.js'), ...args], { encoding: 'utf8', cwd: dir }); return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) }; };
  const src = path.join(dir, 'game.asm');
  fs.writeFileSync(src, ' ORG $3000\nSTART LDA #$41\n STA $3100\nL BRA L\n END START\n');
  const program = [0x86, 0x41, 0xB7, 0x31, 0x00, 0x20, 0xFE];
  const read = (f) => fs.readFileSync(path.join(dir, f));
  let r = cli(['--assemble', src, '--machine', 'dragon64', '--format', 'cas', '--name', 'GAME', '--out', 'game.cas', '--json']);
  const want = [...blk(0, namefile('GAME', 2, 0, 0x3000, 0x3000)), ...blk(1, program), ...blk(0xFF, [])];
  check('--assemble --format cas --name GAME: the tape written out here: a namefile, the 7 program bytes, an end-of-file block', r.code === 0 && same(read('game.cas'), want), r.err + r.out);
  const j = r.code === 0 && r.json().assemble;
  check('--assemble --format cas --json: the tape object has the name, the family and the .CAS size', j && j.format === 'cas' && j.tape.name === 'GAME' && j.tape.family === 'dragon' && j.tape.cas === want.length && j.size === want.length && j.exec === 0x3000 && j.load === 0x3000, JSON.stringify(j));
  r = cli(['--assemble', src, '--machine', 'coco', '--format', 'wav', '--out', 'game.wav', '--json']);
  const wavBytes = read('game.wav'), back = Emu.wavToCas(wavBytes);
  check('--assemble --format wav: a WAV that decodes to the .CAS bytes (the name defaults to the source\'s: GAME), with a player\'s gaps', r.code === 0 && same(back.bytes, want) && r.json().assemble.tape.name === 'GAME' && r.json().assemble.tape.wave === 'sine'
    && r.json().assemble.tape.family === 'coco' && silences(Emu.parseWav(wavBytes).samples, 44100, 0.9).length === 2, r.err);
  r = cli(['--assemble', src, '--machine', 'dragon64', '--format', 'wav', '--square', '--out', 'sq.wav', '--json']);
  const sqSamples = Emu.parseWav(read('sq.wav')).samples, levels = new Set(Array.from(sqSamples, (v) => Math.round(Math.abs(v) * 1000)));
  check('--assemble --format wav --square: a square wave (two levels and silence) that decodes to the same bytes', r.code === 0 && r.json().assemble.tape.wave === 'square' && levels.size === 2 && same(Emu.wavToCas(read('sq.wav')).bytes, want), [...levels].join());
  r = cli(['--assemble', src, '--machine', 'mc10', '--format', 'wav', '--out', 'mc.wav', '--json']);
  const mcSamples = Emu.parseWav(read('mc.wav')).samples;
  check('--assemble --machine mc10 --format wav: the MC-10 family\'s tape, not padded (no silence), that decodes to the same stream', r.code === 0 && r.json().assemble.tape.family === 'mc10' && silences(mcSamples, 44100, 0.1).length === 0 && same(Emu.wavToCas(read('mc.wav')).bytes, [...new Array(128).fill(0x55), ...want]), r.err);
  r = cli(['--assemble', src, '--machine', 'mc10', '--format', 'cas', '--name', 'ALICE', '--out', 'game.c10']);
  check('--assemble --machine mc10 --format cas writes the .c10 file (the same blocks)', r.code === 0 && same(read('game.c10'), [...blk(0, namefile('ALICE', 2, 0, 0x3000, 0x3000)), ...blk(1, program), ...blk(0xFF, [])]), r.err);
  r = cli(['--assemble', src, '--cpu', '6803', '--format', 'cas', '--out', 'nm.cas', '--json']);
  check('--assemble --cpu 6803 --format cas with no machine: the MC-10 family', r.code === 0 && r.json().assemble.tape.family === 'mc10', r.err);
  r = cli(['--assemble', src, '--machine', 'mc10', '--out', 'x.bin']);
  check('--assemble --machine mc10 with no tape format: refused, and the message says a tape is what it takes', r.code === 2 && /loads \.c10 tapes, not binary files/.test(r.err) && /--format cas or wav/.test(r.err), r.err);
  // refusals
  const refuse = (args, re, what) => { const x = cli(['--assemble', src, '--machine', 'dragon64', '--out', 'r.out', ...args]); check(`--assemble ${what}: exit 2`, x.code === 2 && re.test(x.err), x.err); };
  refuse(['--format', 'dragondos', '--name', 'X'], /--name .* cas or wav/, '--name with a binary format');
  refuse(['--format', 'cas', '--square'], /--square .* wav/, '--square with --format cas');
  refuse(['--format', 'cas', '--name', 'NINECHARS'], /up to 8 printable ASCII/, 'a name of 9 characters');
  refuse(['--format', 'cas', '--name', 'É'], /up to 8 printable ASCII/, 'a name that is not ASCII');
  const gap = path.join(dir, 'gap.asm');
  fs.writeFileSync(gap, ' ORG $3000\nSTART BRA START\n ORG $3103\n FCB $11,$22\n END START\n');
  r = cli(['--assemble', gap, '--machine', 'dragon64', '--format', 'wav', '--out', 'gap.wav']);
  check('--assemble --format wav of a program in two pieces 257 bytes apart: bad-media (exit 3), "a tape file holds one contiguous range", nothing written', r.code === 3 && /a tape file holds one contiguous range/.test(r.err) && !fs.existsSync(path.join(dir, 'gap.wav')), r.err);
}

(async () => {
  const real = record('real');
  await libraryChecks(ROOT, real);
  await deckChecks(real);
  await cliChecks(ROOT, real);

  // ---- the example, and the guide ----
  const doc = fs.readFileSync(path.join(ROOT, 'docs/automation.md'), 'utf8');
  const example = path.join(ROOT, 'docs/examples/bin-to-wav.mjs');
  const out1 = path.join(TMP, 'one'), out2 = path.join(TMP, 'two');
  fs.mkdirSync(out1); fs.mkdirSync(out2);
  const runEx = (file, outdir, env = {}) => spawnSync(process.execPath, [file, outdir], { encoding: 'utf8', cwd: TMP, env: Object.assign({}, process.env, env) });
  const r1 = runEx(example, out1), j1 = (() => { try { return JSON.parse(r1.stdout.trim()); } catch (e) { return null; } })();
  real('the example runs from a directory outside the repository, checks its own results and writes GAME.cas and GAME.wav', r1.status === 0 && !!j1 && path.relative(ROOT, TMP).startsWith('..') && fs.existsSync(path.join(out1, 'GAME.cas')) && fs.existsSync(path.join(out1, 'GAME.wav')), r1.stderr + r1.stdout);
  real('it reports the file (GAME, load and exec $3000), 3 blocks, and the silences: 2 s at the start and 1 s after the namefile',
    !!j1 && j1.file.name === 'GAME' && j1.file.load === 0x3000 && j1.file.exec === 0x3000 && j1.blocks === 3 && j1.silences.length === 2 && j1.silences[0].at === 0 && j1.silences[0].seconds === 2 && j1.silences[1].seconds === 1, JSON.stringify(j1));
  const C = await import(pathToFileURL(path.join(ROOT, 'js/media/cassette.js')).href);
  real('the files it wrote agree: the WAV decodes to the .CAS', !!j1 && same(C.wavToCas(fs.readFileSync(path.join(out1, 'GAME.wav'))).bytes, fs.readFileSync(path.join(out1, 'GAME.cas'))));
  const copy = path.join(TMP, 'copy');
  fs.mkdirSync(copy);
  fs.copyFileSync(example, path.join(copy, 'bin-to-wav.mjs'));
  const r2 = runEx(path.join(copy, 'bin-to-wav.mjs'), out2, { CLOADM_DIR: ROOT });
  real('a copy of the .mjs alone runs with CLOADM_DIR and writes the same files', r2.status === 0 && r2.stdout === r1.stdout && fs.readFileSync(path.join(out2, 'GAME.wav')).equals(fs.readFileSync(path.join(out1, 'GAME.wav'))), r2.stderr);
  {
    const quoted = [...doc.matchAll(/```json\n(\{"cas":[^\n]*\})\n```/g)].map((m) => JSON.parse(m[1]));
    real('the guide quotes exactly what the example prints (every field)', quoted.length === 1 && !!j1 && JSON.stringify(quoted[0]) === JSON.stringify(j1), `${JSON.stringify(quoted[0])} vs ${JSON.stringify(j1)}`);
  }
  const heading = '### A tape for a real Dragon or CoCo', anchor = '#a-tape-for-a-real-dragon-or-coco';
  real('the guide has the section, and links to it from the game guide', doc.includes(heading) && fs.readFileSync(path.join(ROOT, 'docs/game-development.md'), 'utf8').includes(`automation.md${anchor}`));
  {
    // the command lines in the section run, in order, in a folder with the source they name
    const section = doc.slice(doc.indexOf(heading)).split('\n### ')[0].split('\n## ')[0];
    const dir = fs.mkdtempSync(path.join(TMP, 'doc-'));
    fs.writeFileSync(path.join(dir, 'game.asm'), ' ORG $3000\nSTART LDA #65\n STA $3100\nLOOP BRA LOOP\n END START\n');
    const lines = [...section.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) => m[1].split('\n')).map((l) => l.replace(/\s+#.*$/, '').trim()).filter((l) => /^node cli\/cloadm\.js /.test(l));
    real('the guide\'s tape section has its command lines', lines.length >= 3, lines.join(' | '));
    for (const l of lines) {
      const args = [...l.slice('node cli/cloadm.js '.length).matchAll(/'([^']*)'|(\S+)/g)].map((m) => (m[1] != null ? m[1] : m[2]));
      const x = spawnSync(process.execPath, [path.join(ROOT, 'cli/cloadm.js'), ...args], { encoding: 'utf8', cwd: dir });
      real(`the guide's command line runs: ${l.slice(0, 90)}`, x.status === 0, x.stdout + x.stderr);
    }
  }

  // ---- mutants: copies of the code with one breakage each ----
  const mutants = [
    ['no leader before the second file', '], TAPE_LEADER));\n', '], out.length ? 0 : TAPE_LEADER));\n', 'js/media/cassette.js'],
    ['a wrong checksum', 'let sum = (type + data.length) & 0xFF;', 'let sum = (type + data.length + 1) & 0xFF;', 'js/media/cassette.js'],
    ['the MC-10 padded', "mc10: { ext: 'c10', zeroHz: 1200, oneHz: 2400, pad: false }", "mc10: { ext: 'c10', zeroHz: 1200, oneHz: 2400, pad: true }", 'js/media/cassette.js'],
  ];
  const guarded = async (fn, root, check) => { try { await fn(root, check); } catch (e) { check(`a check threw: ${e.message}`, false); } };
  const results = [];
  for (const [what, from, to, file] of mutants) {
    const root = fs.mkdtempSync(path.join(TMP, 'mutant-'));
    for (const d of ['js', 'cli']) fs.cpSync(path.join(ROOT, d), path.join(root, d), { recursive: true });
    const f = path.join(root, file), text = fs.readFileSync(f, 'utf8');
    if (text.split(from).length !== 2) { real(`the mutation "${what}" applies exactly once (the code it breaks has moved)`, false); continue; }
    fs.writeFileSync(f, text.replace(from, to));
    const before = failures.length, m = record(`mutant: ${what}`);
    await guarded(libraryChecks, root, m);
    await guarded(cliChecks, root, m);
    results.push({ what, red: failures.splice(before).map((x) => x.name) });
  }

  let bad = 0;
  for (const x of failures) { bad++; console.log(`FAIL ${x.name} ${x.detail}`); }
  for (const { what, red } of results) {
    if (!red.length) bad++;
    console.log(`${red.length ? 'ok  ' : 'FAIL'} mutant (${what}) turns ${red.length} check${red.length === 1 ? '' : 's'} red${red.length ? `, first: ${red[0]}` : ''}`);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(bad ? `${bad} FAILED` : `${n}/${n} tape checks passed`);
  process.exitCode = bad ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
