// cloadm --wav: the machine's sound recorded as a 16-bit PCM WAV, in emulated time.
// Oracles:
//  1. Our own firmware (assembled here) plays a known DAC pattern: five levels, then a square wave. The WAV must
//     decode to exactly the levels the firmware wrote (DAC value d is 320 x d: the documented scale), and the time
//     between every pair of DAC writes, recovered from the WAV, must be the time the firmware takes, counted by hand
//     from the MC6809 data sheet's cycle table (below). The sample grid is the documented one: each frame of
//     frameCycles CPU cycles gives 44100 / fps samples (the fraction carried), each the level averaged over its
//     window, so an edge inside a window is recovered from that sample's value to a small fraction of a cycle.
//  2. The same command twice gives byte-identical WAVs (no wall clock).
//  3. A snapshot taken mid-sound, restored and recorded, gives the same WAV as the uninterrupted run recorded from
//     the same frame.
//  4. The WAV is the box filter of the machine's own level events (machine.audioEvents, the stream the page plays
//     and that the Dragon Alpha comparison checks against MAME's -wavwrite, docs/verification.md), computed here
//     independently from a machine run in this process.
//  5. The single-bit sound (PIA1 PB1) adds 32 DAC steps: DAC 0, then PB1 set, then DAC 63 with PB1 set give
//     plateaus of exactly 0, 10240 and 30400 (js/machines/cocopia.js; the level MAME 0.264 uses, and the Tandy
//     service manual's resistor values give, see docs/verification.md).
//  6. Errors: wav-stop without a recording, a file that cannot be written.
// Run: node tests/cli-wav.test.js
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'cloadm.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-wav-'));
const tmp = (n) => path.join(TMP, n);
function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(r.stdout); } catch (e) { json = null; } }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}
// a 16-bit mono PCM WAV -> { rate, samples (Int16) }, every header field checked
function readWav(b) {
  const ok = b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE' && b.toString('latin1', 12, 16) === 'fmt '
    && b.readUInt16LE(20) === 1 && b.readUInt16LE(22) === 1 && b.readUInt16LE(34) === 16 && b.toString('latin1', 36, 40) === 'data'
    && b.readUInt32LE(4) === b.length - 8 && b.readUInt32LE(40) === b.length - 44;
  const n = (b.length - 44) / 2, samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = b.readInt16LE(44 + i * 2);
  return { ok, rate: b.readUInt32LE(24), byteRate: b.readUInt32LE(28), samples };
}

// ---- the DAC pattern firmware ----
// Table entries (DAC byte, count): the loop writes the byte to the DAC, then waits `count` turns. Cycles, MC6809
// data sheet (Motorola DS9846, cycle tables; indexed modes add their post-byte cycles):
//   NEXT  LDA ,U+      4 + 2 = 6
//         LDX ,U++     5 + 3 = 8
//         BEQ DONE     3
//         STA $FF20    5          the write
//   W     LEAX -1,X    4 + 1 = 5
//         BNE W        3
//         BRA NEXT     3
// so from one STA to the next: 8 x count + 3 + 6 + 8 + 3 + 5 = 8 x count + 25 cycles, whatever the CPU clock.
const LEVELS = [[0, 3000], [21, 2500], [42, 2000], [63, 1500], [10, 1200]];
const SQUARE = { high: 63, low: 0, count: 300, halves: 40 };
const entries = [...LEVELS, ...Array.from({ length: SQUARE.halves }, (_, i) => [i & 1 ? SQUARE.low : SQUARE.high, SQUARE.count]), [32, 1]];
const SOURCE = `
        ORG     $3000
START   ORCC    #$50            ; no interrupts
        CLR     $FF01           ; PIA0: CA2 = CB2 = 0, the sound mux on the DAC
        LDA     #$34
        STA     $FF01
        STA     $FF03
        CLR     $FF21           ; PIA1 port A: bits 7-1 out (the DAC)
        LDA     #$FE
        STA     $FF20
        LDA     #$34
        STA     $FF21
        LDA     #$3C            ; PIA1 CB2 high: sound on
        STA     $FF23
        LDA     $FF22           ; the single-bit sound off
        ANDA    #$FD
        STA     $FF22
        LDA     #$80            ; DAC 32 before the pattern
        STA     $FF20
        LDU     #TABLE
NEXT    LDA     ,U+
        LDX     ,U++
        BEQ     DONE
        STA     $FF20
W       LEAX    -1,X
        BNE     W
        BRA     NEXT
DONE    BRA     DONE
TABLE
${entries.map(([d, c]) => `        FCB     ${d * 4}\n        FDB     ${c}`).join('\n')}
        FCB     0
        FDB     0
        END     START
`;
const ASM = tmp('dac.asm');
fs.writeFileSync(ASM, SOURCE);
const SCALE = 320;               // documented: DAC value d is 320 x d

// the sample grid of a recording that starts at a frame boundary: per frame, n = floor(carried + 44100 / fps)
// samples over frameCycles cycles -> for sample i, [start cycle, window length]
function grid(nSamples, frameCycles, fps, rate = 44100) {
  const out = [];
  let frac = 0, base = 0;
  while (out.length < nSamples) {
    frac += rate / fps;
    const n = Math.floor(frac);
    frac -= n;
    const step = frameCycles / n;
    for (let i = 0; i < n && out.length < nSamples; i++) out.push([base + i * step, step]);
    base += frameCycles;
  }
  return out;
}
// the plateaus (runs of 3+ equal samples) and the edge time between each pair, from the partial sample(s) between
function edges(samples, g) {
  const runs = [];
  for (let i = 0; i < samples.length;) {
    let j = i;
    while (j < samples.length && samples[j] === samples[i]) j++;
    if (j - i >= 3) runs.push({ from: i, to: j, value: samples[i] });
    i = j;
  }
  const out = [];
  for (let k = 1; k < runs.length; k++) {
    const a = runs[k - 1], b = runs[k], between = b.from - a.to;
    let t;
    if (between === 0) t = g[b.from][0];                       // on a window boundary
    else if (between === 1) {                                   // inside one window: v = (a x before + b x after) / step
      const [t0, step] = g[a.to], v = samples[a.to];
      t = t0 + step * (v - b.value) / (a.value - b.value);
    } else t = NaN;                                             // two edges in a window: the pattern never does this
    out.push({ from: a.value, to: b.value, t });
  }
  return { runs, edges: out };
}

// ---- 1. levels and timing, on a 50 Hz Dragon and a 60 Hz CoCo ----
for (const machine of ['dragon64', 'coco']) {
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine(machine, {}, { menu: false });
  const { frameCycles, fps } = s.shownMachine;
  const file = tmp(`dac-${machine}.wav`);
  const r = cli(['--machine', machine, '--asm', ASM, '--wav', file, '--frames', '14', '--json']);
  check(`${machine}: the run succeeds`, r.code === 0, r.err);
  const w = readWav(fs.readFileSync(file));
  check(`${machine}: a 16-bit mono PCM WAV at 44100 Hz, sizes consistent`, w.ok && w.rate === 44100 && w.byteRate === 88200);
  const step = r.json.steps.find((x) => x.step === 'wav');
  check(`${machine}: the result gives the file, the rate, the sample count and the DAC step`, step.samples === w.samples.length && step.rate === 44100 && step.dacStep === 320 && Math.abs(step.seconds - w.samples.length / 44100) < 1e-9);
  // 14 frames of samples: 44100 / fps each, the fraction carried
  check(`${machine}: 14 frames give floor(14 x 44100 / fps) samples`, w.samples.length === Math.floor(14 * 44100 / fps + 1e-9), `${w.samples.length}`);
  const { runs, edges: es } = edges(w.samples, grid(w.samples.length, frameCycles, fps));
  // the plateaus are exactly the levels written, in order: 32 (before), the five levels, the square, 32
  const want = [32, ...entries.map(([d]) => d)].filter((d, i, a) => i === 0 || d !== a[i - 1]).map((d) => d * SCALE);
  check(`${machine}: the plateaus are exactly 320 x the DAC values written, in order (${want.length})`,
    runs.length === want.length && runs.every((x, i) => x.value === want[i]), runs.map((x) => x.value).join(' '));
  // the time from each write to the next: 8 x count + 25 cycles (the pattern's first edge is the write of level 0)
  const gaps = es.slice(1).map((e, i) => e.t - es[i].t);
  const wantGaps = entries.slice(0, -1).map(([, c]) => 8 * c + 25);
  const worst = Math.max(...gaps.map((g, i) => Math.abs(g - wantGaps[i])));
  check(`${machine}: every interval between DAC writes is 8 x count + 25 cycles, to within 0.01 cycle (worst ${worst.toFixed(5)})`,
    gaps.length === wantGaps.length && worst < 0.01, `${gaps.length} vs ${wantGaps.length}`);
  // the square wave's period in seconds: 2 x (8 x 300 + 25) cycles at the machine's clock
  const sq = es.slice(LEVELS.length, LEVELS.length + SQUARE.halves);
  const period = (sq[sq.length - 1].t - sq[0].t) / ((sq.length - 1) / 2) / s.shownMachine.tickHz;
  check(`${machine}: the square wave's period is 2 x 2425 cycles (${(1 / period).toFixed(3)} Hz)`, Math.abs(period * s.shownMachine.tickHz - 4850) < 0.01);
}

// ---- 2. determinism ----
{
  cli(['--asm', ASM, '--wav', tmp('d1.wav'), '--frames', '14']);
  cli(['--asm', ASM, '--wav', tmp('d2.wav'), '--frames', '14']);
  const a = fs.readFileSync(tmp('d1.wav')), b = fs.readFileSync(tmp('d2.wav'));
  check('two runs give byte-identical WAVs', a.length > 1000 && a.equals(b));
}

// ---- 3. a snapshot mid-sound continues with the same sound ----
{
  // the pattern runs from frame 1 to frame 11; frame 5 is in the middle of it
  const a = cli(['--asm', ASM, '--frames', '5', '--wav', tmp('u.wav'), '--frames', '9']);
  const b = cli(['--asm', ASM, '--frames', '5', '--save-snapshot', tmp('mid.cloadm-state')]);
  const c = cli(['--load-snapshot', tmp('mid.cloadm-state'), '--wav', tmp('r.wav'), '--frames', '9']);
  const u = fs.readFileSync(tmp('u.wav')), rr = fs.readFileSync(tmp('r.wav'));
  const levels = new Set(readWav(u).samples);
  check('the snapshot is taken mid-sound (the recording after it has several levels)', levels.size > 5, `${levels.size}`);
  check('restored from the snapshot, the recording is byte-identical to the uninterrupted run\'s', a.code === 0 && b.code === 0 && c.code === 0 && u.equals(rr));
}

// ---- 4. the WAV is the box filter of the machine's own level events ----
{
  const s = new Emu.Session({ welcomeMenu: false });
  s.switchMachine('dragon64', {}, { menu: false });
  s.runAssembled(Emu.assemble(SOURCE, '6809'));
  const m = s.shownMachine, want = [];
  let frac = 0;
  for (let f = 0; f < 14; f++) {
    s.runFrames(1);
    const ev = m.audioEvents.slice();
    frac += 44100 / m.fps;
    const n = Math.floor(frac);
    frac -= n;
    const step = m.frameCycles / n;
    // segments [start, end, level]; each sample: the overlap of every segment with its window
    const segs = [];
    for (let k = 0; k < ev.length; k += 2) segs.push([ev[k], k + 2 < ev.length ? ev[k + 2] : Infinity, ev[k + 1]]);
    for (let i = 0; i < n; i++) {
      const t0 = i * step, t1 = t0 + step;
      let acc = 0;
      for (const [a, b, v] of segs) acc += v * Math.max(0, Math.min(b, t1) - Math.max(a, t0));
      want.push(Math.round(acc / step * 20160));
    }
  }
  cli(['--asm', ASM, '--wav', tmp('ev.wav'), '--frames', '14']);
  const got = readWav(fs.readFileSync(tmp('ev.wav'))).samples;
  const bad = want.findIndex((v, i) => got[i] !== v);
  check(`the WAV is the machine's level events box-filtered and scaled, sample for sample (${want.length})`,
    got.length === want.length && bad < 0, bad >= 0 ? `sample ${bad}: ${got[bad]} vs ${want[bad]}` : `${got.length} vs ${want.length}`);
}

// ---- 5. the single-bit sound's level against the DAC ----
{
  const SB = `
        ORG     $3000
START   ORCC    #$50
        LDA     #$34            ; PIA0 CA2 = CB2 = 0: the sound mux on the DAC
        STA     $FF01
        STA     $FF03
        LDA     #$3C            ; PIA1 CB2 high: sound on
        STA     $FF23
        CLR     $FF20           ; DAC 0
        LDA     $FF22           ; PB1 (the single-bit sound) low
        ANDA    #$FD
        STA     $FF22
        BSR     WAIT
        ORA     #$02            ; PB1 high, DAC still 0
        STA     $FF22
        BSR     WAIT
        LDB     #$FC            ; DAC 63, PB1 still high
        STB     $FF20
DONE    BRA     DONE
WAIT    LDX     #3000           ; 24000 cycles: over a frame
W       LEAX    -1,X
        BNE     W
        RTS
        END     START
`;
  fs.writeFileSync(tmp('sb.asm'), SB);
  const r = cli(['--asm', tmp('sb.asm'), '--wav', tmp('sb.wav'), '--frames', '6']);
  const sb = readWav(fs.readFileSync(tmp('sb.wav'))).samples;
  const { runs } = edges(sb, grid(sb.length, 17784, 888625 / 17784));   // the Dragon 64's frame
  const levels = runs.map((x) => x.value).filter((v, i, a) => i === 0 || v !== a[i - 1]);
  check('single-bit sound: plateaus of exactly 0, 10240 (PB1 alone) and 30400 (DAC 63 + PB1)', r.code === 0 && levels.join() === '0,10240,30400', levels.join());
}

// ---- 6. errors and the end of the run ----
{
  const r = cli(['--asm', ASM, '--wav-stop', '--json']);
  check('wav-stop without a recording: exit 2, bad-argument', r.code === 2 && r.json.error.code === 'bad-argument');
  const w = cli(['--asm', ASM, '--wav', path.join(TMP, 'no-such-dir', 'x.wav'), '--frames', '2', '--json']);
  check('a WAV that cannot be written: exit 3, cannot-write', w.code === 3 && w.json.error.code === 'cannot-write');
  // a run that fails still writes what it recorded
  const f = cli(['--asm', ASM, '--wav', tmp('fail.wav'), '--frames', '3', '--expect-mem', '$0000=99', '--json']);
  check('a run that fails still writes its recording (3 frames)', f.code === 1 && fs.existsSync(tmp('fail.wav')) && readWav(fs.readFileSync(tmp('fail.wav'))).samples.length > 2600);
  // wav-stop: what follows it is not recorded; a second wav starts a second file
  const g = cli(['--asm', ASM, '--wav', tmp('s1.wav'), '--frames', '2', '--wav-stop', '--frames', '3', '--wav', tmp('s2.wav'), '--frames', '1', '--json']);
  const n1 = readWav(fs.readFileSync(tmp('s1.wav'))).samples.length, n2 = readWav(fs.readFileSync(tmp('s2.wav'))).samples.length;
  check('wav-stop ends the recording; a later wav records only its own frames', g.code === 0 && n1 > 1700 && n1 < 1800 && n2 > 870 && n2 < 900, `${n1} ${n2}`);
  const d = JSON.parse(cli(['--describe']).out);
  check('--describe lists wav and wav-stop', ['wav', 'wav-stop'].every((n) => d.steps.some((x) => x.name === n)));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
