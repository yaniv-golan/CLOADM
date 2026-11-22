// cloadm --record / --record-dir: the picture and sound of a headless run as one AVI 1.0 file (js/media/avi.js), or
// as PNGs, a WAV and an ffconcat list.
// Oracles:
//  1. An AVI reader written here from the format's reference (Microsoft "AVI RIFF File Reference": RIFF/LIST
//     nesting, MainAVIHeader, AVIStreamHeader, BITMAPINFOHEADER with an RGBQUAD table, PCMWAVEFORMAT, idx1; vfw.h's
//     AVIPALCHANGE), sharing no code with the writer, decodes every frame to RGBA: each must equal
//     frameToRGBA(machine.render()) of the same frame of the same program run in this process.
//  2. The audio stream equals the same run's --wav output byte for byte, and each frame's audio chunk holds exactly
//     floor((k + 1) x 44100 / fps) - floor(k x 44100 / fps) samples, fps = tickHz / frameCycles as an exact fraction
//     (computed here with BigInt): nothing drifts.
//  3. The video header's dwRate / dwScale is tickHz / frameCycles exactly, on every model (888625 / 17784 on the PAL
//     Dragons; the NTSC clocks are fractions of a hertz: 14318180 / 16, 28636363 / 8).
//  4. The same command twice gives byte-identical files; the file built here in-process from the same frames is
//     byte-identical to the command line's.
//  5. Mutants of js/media/avi.js (the carried fraction dropped, R and B swapped, the palette chunk left out) must
//     each fail oracle 1 or 2.
//  6. Limits: a frame that changes size stops the run with record-size-changed naming the frame, the file still
//     written; a file reaching the size limit stops with record-too-big suggesting --record-dir, the file still
//     written; --record-dir's PNGs, WAV and ffconcat durations (to the microsecond, summing to the exact length).
//  7. ffprobe and ffmpeg, when installed, read the file at the same rate and decode the same pixels. When they are
//     not, the test says that check was skipped.
// Run: node tests/cli-record.test.js
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'cloadm.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-record-'));
const tmp = (n) => path.join(TMP, n);
function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(r.stdout); } catch (e) { json = null; } }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

// ---- an independent AVI reader ----
// -> { width, height, rate: { num, den }, frames: [Uint32Array RGBA], chunkSamples: [n], audio: Buffer, palChanges, problems: [] }
function readAvi(b) {
  const problems = [], need = (c, what) => { if (!c) problems.push(what); };
  const id = (o) => b.toString('latin1', o, o + 4);
  need(id(0) === 'RIFF' && id(8) === 'AVI ', 'RIFF AVI header');
  need(b.readUInt32LE(4) === b.length - 8, 'RIFF size');
  // the top level: LIST hdrl, LIST movi, idx1
  const top = {};
  for (let o = 12; o + 8 <= b.length;) {
    const size = b.readUInt32LE(o + 4);
    const key = id(o) === 'LIST' ? id(o + 8) : id(o);
    top[key] = { at: o, size };
    o += 8 + size + (size & 1);
  }
  need(top.hdrl && top.movi && top.idx1, 'hdrl, movi and idx1');
  const h = top.hdrl.at;
  need(id(h + 12) === 'avih' && b.readUInt32LE(h + 16) === 56, 'avih');
  const avih = h + 20;
  const totalFrames = b.readUInt32LE(avih + 16), streams = b.readUInt32LE(avih + 24);
  const width = b.readUInt32LE(avih + 32), height = b.readUInt32LE(avih + 36);
  need(streams === 2, 'two streams');
  need(b.readUInt32LE(avih + 12) & 0x10, 'AVIF_HASINDEX');
  // the stream lists
  const strl = [];
  for (let o = avih + 56; o < h + 8 + top.hdrl.size;) {
    const size = b.readUInt32LE(o + 4);
    if (id(o) === 'LIST' && id(o + 8) === 'strl') strl.push(o);
    o += 8 + size + (size & 1);
  }
  need(strl.length === 2, 'two strl lists');
  const strh = (s) => { need(id(s + 12) === 'strh' && b.readUInt32LE(s + 16) === 56, 'strh'); return s + 20; };
  const strf = (s) => { const f = s + 12 + 64; need(id(f) === 'strf', 'strf'); return { at: f + 8, size: b.readUInt32LE(f + 4) }; };
  const vh = strh(strl[0]), ah = strh(strl[1]);
  need(id(vh) === 'vids' && id(ah) === 'auds', 'vids then auds');
  need(b.readUInt32LE(vh + 8) & 0x10000, 'AVISF_VIDEO_PALCHANGES');
  const rate = { num: b.readUInt32LE(vh + 24), den: b.readUInt32LE(vh + 20) };   // dwRate / dwScale
  need(b.readUInt32LE(vh + 32) === totalFrames, 'video dwLength = the frame count');
  const vf = strf(strl[0]).at;
  need(b.readUInt32LE(vf) === 40 && b.readInt32LE(vf + 4) === width && b.readInt32LE(vf + 8) === height, 'BITMAPINFOHEADER size');
  need(b.readUInt16LE(vf + 12) === 1 && b.readUInt16LE(vf + 14) === 8 && b.readUInt32LE(vf + 16) === 0, '8 bits, BI_RGB');
  const used = b.readUInt32LE(vf + 32) || 256;
  const pal = new Uint32Array(256);
  for (let i = 0; i < used; i++) { const q = vf + 40 + i * 4; pal[i] = (0xFF000000 | (b[q + 2]) | (b[q + 1] << 8) | (b[q] << 16)) >>> 0; }   // RGBQUAD B, G, R
  const af = strf(strl[1]).at;
  need(b.readUInt16LE(af) === 1 && b.readUInt16LE(af + 2) === 1 && b.readUInt32LE(af + 4) === 44100 && b.readUInt16LE(af + 14) === 16, 'PCM mono 44100 16-bit');
  need(b.readUInt32LE(ah + 20) === 1 && b.readUInt32LE(ah + 24) === 44100 && b.readUInt32LE(ah + 44) === 2, 'audio scale 1, rate 44100, sample size 2');
  // movi
  const movi = top.movi.at + 8, moviEnd = movi + top.movi.size;   // movi: the 'movi' tag
  const frames = [], chunkSamples = [], audio = [], seen = [];
  let palChanges = 0;
  const stride = (width + 3) & ~3;
  for (let o = movi + 4; o + 8 <= moviEnd;) {
    const cid = id(o), size = b.readUInt32LE(o + 4), d = o + 8;
    seen.push({ id: cid, offset: o - movi, size });
    if (cid === '00pc') {
      palChanges++;
      const first = b[d], n = b[d + 1] || 256;
      need(size === 4 + 4 * n, 'AVIPALCHANGE size');
      for (let i = 0; i < n; i++) { const q = d + 4 + i * 4; pal[first + i] = (0xFF000000 | b[q] | (b[q + 1] << 8) | (b[q + 2] << 16)) >>> 0; }   // PALETTEENTRY R, G, B
    } else if (cid === '00db') {
      need(size === stride * height, 'frame size');
      const px = new Uint32Array(width * height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) px[y * width + x] = pal[b[d + (height - 1 - y) * stride + x]];   // bottom-up
      frames.push(px);
    } else if (cid === '01wb') {
      chunkSamples.push(size / 2);
      audio.push(b.subarray(d, d + size));
    } else problems.push(`unknown chunk ${cid}`);
    o = d + size + (size & 1);
  }
  need(frames.length === totalFrames, 'frames = avih dwTotalFrames');
  const audioBytes = Buffer.concat(audio);
  need(b.readUInt32LE(ah + 32) === audioBytes.length / 2, 'audio dwLength = the samples');
  // idx1: every movi chunk, in order, at its offset from the 'movi' tag
  const ix = top.idx1.at + 8, entries = top.idx1.size / 16;
  need(entries === seen.length, 'idx1 has every chunk');
  for (let i = 0; i < Math.min(entries, seen.length); i++) {
    const e = ix + i * 16;
    if (id(e) !== seen[i].id || b.readUInt32LE(e + 8) !== seen[i].offset || b.readUInt32LE(e + 12) !== seen[i].size) { problems.push(`idx1 entry ${i}`); break; }
  }
  return { width, height, rate, frames, chunkSamples, audio: audioBytes, palChanges, problems };
}

// ---- the programs (our own firmware, assembled here) ----
// Dragon 64: the DAC steps through four levels while a screen byte counts up (a changing picture and sound)
const DRAGON = `
        ORG     $3000
START   ORCC    #$50
        CLR     $FF01
        LDA     #$34
        STA     $FF01
        STA     $FF03
        CLR     $FF21
        LDA     #$FE
        STA     $FF20
        LDA     #$34
        STA     $FF21
        LDA     #$3C
        STA     $FF23
        CLRB
LOOP    STB     $FF20
        INC     $0400
        LDX     #300
W       LEAX    -1,X
        BNE     W
        ADDB    #$44
        BRA     LOOP
`;
// CoCo 3: $FF98's MOCH bit toggled every few thousand cycles: on the composite monitor the colour table swaps
// between colour and grey (js/chips/gime.js updateTable), so the recording needs palette-change chunks
const COCO3 = `
        ORG     $3000
START   ORCC    #$50
        LDA     #$10
LOOP    STA     $FF98
        LDX     #6000
W       LEAX    -1,X
        BNE     W
        EORA    #$10
        BRA     LOOP
`;
fs.writeFileSync(tmp('dragon.asm'), DRAGON);
fs.writeFileSync(tmp('coco3.asm'), COCO3);

// the same program in this process, frame by frame: the frames' RGBA, and the run's per-frame sound (the CLI's
// output stage: AudioOutput without its high-pass, at 20160 / 32767), recorded with the given avi module
const WAV_SCALE = 20160;
function inProcess(machine, source, frames, avi = Emu) {
  const s = new Emu.Session({ welcomeMenu: false });
  s.fastTape = false; s.turbo = false;
  s.switchMachine(machine, {}, { menu: false });
  s.runAssembled(Emu.assemble(source, '6809'));
  const m = s.shownMachine, rate = avi.frameRate(m.tickHz, m.frameCycles);
  let pending = null;
  const out = new Emu.AudioOutput(44100, { buffered: () => 0, write: (c) => { pending = c; } }, { highPass: false });
  out.volume = WAV_SCALE / 32767;
  const clock = avi.sampleClock(44100, rate), writer = avi.aviWriter({ rate, sampleRate: 44100 });
  const rgba = [];
  for (let k = 0; k < frames; k++) {
    s.runFrames(1);
    out.render(m.audioEvents, m.frameCycles, clock.next(), null);
    const f = m.render();
    rgba.push(Emu.frameToRGBA(f));
    writer.addFrame(f, Emu.pcm16(pending));
  }
  return { rgba, bytes: Buffer.from(writer.finish()), tickHz: m.tickHz, frameCycles: m.frameCycles };
}
// floor((k + 1) x 44100 x den / num) - floor(k x 44100 x den / num), exactly
function expectedCounts(tickHz, frameCycles, frames) {
  let q = 1n;
  while (!Number.isInteger(tickHz * Number(q))) q *= 2n;
  const p = BigInt(tickHz * Number(q)), per = 44100n * q * BigInt(frameCycles);   // samples per frame = per / p
  const at = (k) => (BigInt(k) * per) / p;
  return Array.from({ length: frames }, (_, k) => Number(at(k + 1) - at(k)));
}
// oracle 1 and 2 against a decoded file -> the problems found
function verify(a, { rgba, wavData, tickHz, frameCycles }) {
  const p = [...a.problems];
  if (a.frames.length !== rgba.length) p.push(`${a.frames.length} frames, not ${rgba.length}`);
  for (let k = 0; k < Math.min(a.frames.length, rgba.length); k++) {
    const got = a.frames[k], want = rgba[k];
    const i = want.findIndex((v, j) => v !== got[j]);
    if (i >= 0) { p.push(`frame ${k} pixel ${i}: ${got[i].toString(16)}, not ${want[i].toString(16)}`); break; }
  }
  if (!a.audio.equals(wavData)) p.push('the audio is not the --wav data');
  const counts = expectedCounts(tickHz, frameCycles, rgba.length);
  const bad = counts.findIndex((n, k) => a.chunkSamples[k] !== n);
  if (bad >= 0) p.push(`frame ${bad}'s audio chunk has ${a.chunkSamples[bad]} samples, not ${counts[bad]}`);
  if (a.rate.num * frameCycles !== tickHz * a.rate.den) p.push(`rate ${a.rate.num}/${a.rate.den} is not tickHz/frameCycles`);
  return p;
}
const wavDataOf = (file) => { const w = fs.readFileSync(file); return w.subarray(44); };

async function main() {
  // ---- oracles 1 to 4 on the Dragon 64 (PAL: 888625 / 17784, sound) and the CoCo 3 (NTSC fraction, palette changes)
  const runs = {};
  for (const [machine, src, frames] of [['dragon64', 'dragon.asm', 120], ['coco3', 'coco3.asm', 40]]) {
    const avi = tmp(`${machine}.avi`), wav = tmp(`${machine}.wav`);
    const args = ['--json', '--machine', machine, '--asm', tmp(src), '--wav', wav, '--record', avi, '--frames', String(frames)];
    const r = cli(args);
    check(`${machine}: the run succeeds`, r.code === 0, r.err);
    const bytes = fs.readFileSync(avi), a = readAvi(bytes);
    const ref = inProcess(machine, machine === 'dragon64' ? DRAGON : COCO3, frames);
    const oracle = { rgba: ref.rgba, wavData: wavDataOf(wav), tickHz: ref.tickHz, frameCycles: ref.frameCycles };
    const problems = verify(a, oracle);
    check(`${machine}: every frame's pixels are frameToRGBA's, the audio is --wav's, each frame's samples exact`, !problems.length, problems.join('; '));
    check(`${machine}: the step reports the frames and the exact rate`, r.json && r.json.steps[2].frames === frames && r.json.steps[2].fps === `${a.rate.num}/${a.rate.den}`, JSON.stringify(r.json && r.json.steps[2]));
    check(`${machine}: the file built in-process from the same frames is byte-identical`, ref.bytes.equals(bytes));
    const again = tmp(`${machine}-2.avi`);
    cli(args.map((x) => (x === avi ? again : x)));
    check(`${machine}: the same command gives a byte-identical file`, fs.readFileSync(again).equals(bytes));
    runs[machine] = { avi, a, oracle, frames };
  }
  check('dragon64: the rate is 888625/17784', runs.dragon64.a.rate.num === 888625 && runs.dragon64.a.rate.den === 17784, `${runs.dragon64.a.rate.num}/${runs.dragon64.a.rate.den}`);
  check('dragon64: the sound is not silent', runs.dragon64.a.audio.some((x) => x !== 0));
  check('dragon64: frames carry 882 and 883 samples', new Set(runs.dragon64.a.chunkSamples).size === 2);
  check('coco3: the colour table changes, and palette chunks record it', runs.coco3.a.palChanges >= 3, `${runs.coco3.a.palChanges} changes`);

  // ---- oracle 3 on every model: the header rate is tickHz / frameCycles
  for (const id of Object.keys(Emu.profiles)) {
    const f = tmp(`rate-${id}.avi`), r = cli(['--machine', id, '--record', f, '--frames', '2']);
    if (r.code !== 0) { check(`${id}: a two-frame recording`, false, r.err); continue; }
    const a = readAvi(fs.readFileSync(f));
    const s = new Emu.Session({ welcomeMenu: false });
    s.switchMachine(id, {}, { menu: false });
    const { tickHz, frameCycles } = s.shownMachine;
    check(`${id}: dwRate/dwScale ${a.rate.num}/${a.rate.den} = tickHz/frameCycles ${tickHz}/${frameCycles}`, a.rate.num * frameCycles === tickHz * a.rate.den && !a.problems.length, a.problems.join('; '));
  }

  // ---- oracle 5: mutants of js/media/avi.js
  const src = fs.readFileSync(path.join(ROOT, 'js', 'media', 'avi.js'), 'utf8');
  const mutants = {
    'the carried fraction dropped': ['rem -= n * num;', 'rem = 0;'],
    'R and B swapped in the colour tables': ['o.u8((c >>> 16) & 0xFF).u8((c >>> 8) & 0xFF).u8(c & 0xFF).u8(0)', 'o.u8(c & 0xFF).u8((c >>> 8) & 0xFF).u8((c >>> 16) & 0xFF).u8(0)'],
    'the palette chunk left out': ["if (pc) parts.push(['00pc', pc]);", ''],
  };
  for (const [name, [from, to]] of Object.entries(mutants)) {
    if (!src.includes(from)) { check(`mutant "${name}" applies`, false, 'the writer changed: update the mutant'); continue; }
    const file = tmp(`avi-${name.replace(/\W+/g, '-')}.mjs`);
    fs.writeFileSync(file, src.replace(from, to));
    const M = await import(file);
    const caught = ['dragon64', 'coco3'].some((machine) => {
      const run = runs[machine];
      const built = inProcess(machine, machine === 'dragon64' ? DRAGON : COCO3, run.frames, M);
      return verify(readAvi(built.bytes), run.oracle).length > 0;
    });
    check(`mutant "${name}" is caught`, caught);
  }

  // ---- oracle 6: a frame that changes size (the Dragon 64 Plus's second screen) stops the run, naming it
  {
    const f = tmp('plus.avi'), r = cli(['--json', '--machine', 'd64plus', '--record', f, '--frames', '3', '--view', 'plus', '--frames', '2']);
    check('size change: exit 3, record-size-changed', r.code === 3 && r.json && r.json.error.code === 'record-size-changed', r.out);
    check('size change: the message names the frame', r.json && /frame 3 of the recording/.test(r.json.error.message) && /record-stop/.test(r.json.error.message), r.json && r.json.error.message);
    const a = fs.existsSync(f) ? readAvi(fs.readFileSync(f)) : null;
    check('size change: the frames before it are written', a && a.frames.length === 3 && !a.problems.length, a && a.problems.join('; '));
  }
  // ---- the size limit: reached, the run stops with a suggestion, and the file holds what fit
  {
    const { main: run } = require('../cli/cloadm.js');
    const f = tmp('big.avi'), lines = [];
    const code = await run(['--json', '--machine', 'dragon64', '--record', f, '--frames', '20'], { out: (t) => lines.push(t), err: () => {}, recordLimit: 400000 });
    const j = JSON.parse(lines.join('\n'));
    check('limit: exit 3, record-too-big', code === 3 && j.error.code === 'record-too-big', j.error && j.error.code);
    check('limit: the message suggests --record-dir DIR', /--record-dir DIR/.test(j.error.message) && /1 GiB/.test(j.error.message), j.error.message);
    const b = fs.readFileSync(f), a = readAvi(b);
    check('limit: the file is written, valid and within the limit', b.length <= 400000 && a.frames.length > 0 && a.frames.length < 20 && !a.problems.length, `${b.length} bytes, ${a.frames.length} frames`);
    const w = Emu.aviWriter({ rate: { num: 50, den: 1 }, maxBytes: 10000 }), fr = new Emu.Frame(8, 8);
    let err = null;
    try { for (let i = 0; i < 100; i++) w.addFrame(fr, new Int16Array(882)); } catch (e) { err = e; }
    check('limit: the writer refuses the frame that would pass it', err && err.code === 'too-big' && w.frames > 1 && w.finish().length <= 10000);
  }
  // ---- riffChunk: RIFF pads odd-length data with one zero byte, which the size field does not count
  {
    const odd = Emu.riffChunk('01wb', Uint8Array.from([1, 2, 3])), even = Emu.riffChunk('00db', Uint8Array.from([1, 2, 3, 4]));
    const b = Buffer.from(odd);
    check('riffChunk: odd data is padded to an even length with a zero byte', b.length === 12 && b.toString('latin1', 0, 4) === '01wb' && b[8] === 1 && b[9] === 2 && b[10] === 3 && b[11] === 0, b.toString('hex'));
    check('riffChunk: the size field is the data\'s length, without the pad', b.readUInt32LE(4) === 3);
    check('riffChunk: even data has no pad', even.length === 12 && Buffer.from(even).readUInt32LE(4) === 4);
  }
  // ---- --record-dir: a PNG per frame, the WAV, an ffconcat list at the exact rate
  {
    const { decodePng } = require('../cli/cloadm.js');
    const dir = tmp('clip'), wav = tmp('dir.wav'), frames = 60;
    const r = cli(['--machine', 'dragon64', '--asm', tmp('dragon.asm'), '--wav', wav, '--record-dir', dir, '--frames', String(frames), '--record-stop', '--frames', '5']);
    check('record-dir: the run succeeds', r.code === 0, r.err);
    const pngs = fs.readdirSync(dir).filter((n) => n.endsWith('.png')).sort();
    check('record-dir: one PNG per frame until record-stop', pngs.length === frames && pngs[0] === 'frame00000.png', pngs.length);
    const ref = runs.dragon64.oracle;
    let same = true;
    for (const k of [0, 1, 30, frames - 1]) {
      const p = decodePng(fs.readFileSync(path.join(dir, pngs[k])), pngs[k]), px = new Uint32Array(p.rgba.buffer, p.rgba.byteOffset, p.rgba.length / 4);
      if (!px.every((v, i) => v === ref.rgba[k][i])) same = false;
    }
    check('record-dir: the PNGs are the frames', same);
    const sound = fs.readFileSync(path.join(dir, 'sound.wav'));
    check('record-dir: sound.wav is the --wav recording up to record-stop', sound.subarray(44).equals(wavDataOf(wav).subarray(0, sound.length - 44)) && (sound.length - 44) / 2 === expectedCounts(ref.tickHz, ref.frameCycles, frames).reduce((x, y) => x + y, 0));
    const list = fs.readFileSync(path.join(dir, 'frames.ffconcat'), 'utf8').trim().split('\n');
    const durations = list.filter((l) => l.startsWith('duration ')).map((l) => Math.round(Number(l.slice(9)) * 1e6));
    const exact = (k) => k * 17784 * 1e6 / 888625;
    const worst = Math.max(...durations.map((d, k) => Math.abs(durations.slice(0, k + 1).reduce((x, y) => x + y, 0) - exact(k + 1))));
    check('record-dir: ffconcat lists every frame, durations summing to the exact time within half a microsecond', list[0] === 'ffconcat version 1.0' && durations.length === frames && worst <= 0.5, `worst ${worst}`);
  }
  // ---- errors
  {
    const r = cli(['--json', '--record-stop']);
    check('record-stop without a recording: usage error', r.code === 2 && r.json && /no recording to stop/.test(r.json.error.message), r.out);
    const r2 = cli(['--json', '--record', tmp('none.avi')]);
    check('a recording with no frames: an error, no file', r2.code === 2 && !fs.existsSync(tmp('none.avi')), r2.out);
    const r3 = cli(['--json', '--record', path.join(TMP, 'no-such-dir', 'x.avi'), '--frames', '2']);
    check('an unwritable file: cannot-write', r3.code === 3 && r3.json && r3.json.error.code === 'cannot-write', r3.out);
  }
  // ---- oracle 7: ffprobe and ffmpeg, when installed
  const probe = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    console.log('SKIPPED ffprobe/ffmpeg check: ffprobe is not installed (the reader above is the oracle)');
  } else {
    const { avi, frames } = runs.dragon64;
    const p = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,pix_fmt,r_frame_rate,nb_read_frames,sample_rate,channels', '-of', 'json', avi], { encoding: 'utf8' });
    const st = JSON.parse(p.stdout).streams;
    check('ffprobe: pal8 rawvideo at 888625/17784, every frame', st[0].codec_name === 'rawvideo' && st[0].pix_fmt === 'pal8' && st[0].r_frame_rate === '888625/17784' && +st[0].nb_read_frames === frames, JSON.stringify(st[0]));
    check('ffprobe: 16-bit mono PCM at 44100 Hz', st[1].codec_name === 'pcm_s16le' && st[1].sample_rate === '44100' && st[1].channels === 1, JSON.stringify(st[1]));
    for (const machine of ['dragon64', 'coco3']) {
      const run = runs[machine], f = spawnSync('ffmpeg', ['-v', 'error', '-i', run.avi, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 30 });
      const raw = f.stdout, n = run.a.width * run.a.height * 4;
      let ok = f.status === 0 && raw.length === n * run.frames;
      for (let k = 0; ok && k < run.frames; k++) {
        const px = new Uint32Array(raw.buffer, raw.byteOffset + k * n, n / 4);
        if (!px.every((v, i) => v === run.oracle.rgba[k][i])) ok = false;
      }
      check(`ffmpeg: ${machine}'s frames decode to the same pixels${machine === 'coco3' ? ' (palette changes applied)' : ''}`, ok);
    }
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exitCode = fail ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
