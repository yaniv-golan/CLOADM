// A POSITIVE-CONTROLLED stall probe for the no-pop check in tools/browser-check.js.
//
// Three modes:
//   control - NO stall. The numbers MUST be the real check's own (step ~0.0078, peak ~0.0165). If they are not, the
//             probe is not playing DAC_HIGH through the audio path and nothing else it measures means anything.
//   stall   - the check's busy page: fill 100 ms, spin the thread STALL ms at a phase, then resume. The step is
//             measured over the WHOLE played stream, as the real check does, not a slice read afterwards.
//   plant   - as stall, with a deliberate pop on resume: a 128-sample chunk at the OPPOSITE level of the queue's
//             last sample is written into the sink, i.e. a step the machine never played. Proves the measurement can
//             SEE a pop at all - an earlier plant (setting the held value to 0) was inert and read as a pass.
//
//   node tools/audio-stall-probe.js <control|stall|plant> [N] [stallMs] [outfile]
const path = require('path'), http = require('http'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { chromium } = require('playwright');

const MODE = process.argv[2] || 'control';
const N = +(process.argv[3] || 1), STALL = +(process.argv[4] || 500);
const OUT = process.argv[5] || require('path').join(require('os').tmpdir(), `cloadm-audio-stall-${MODE}.txt`);

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(ROOT, u.endsWith('/') ? `${u}index.html` : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  const type = /\.js$/.test(f) ? 'text/javascript' : /\.html?$/.test(f) ? 'text/html' : /\.css$/.test(f) ? 'text/css' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  fs.createReadStream(f).pipe(res);
});

const DAC_HIGH = ` ORG $3000
 ORCC #$50
 LDA $FF01
 ANDA #$F7
 ORA #$30
 STA $FF01
 LDA $FF03
 ANDA #$F7
 ORA #$30
 STA $FF03
 LDA $FF21
 ANDA #$FB
 STA $FF21
 LDA #$FE
 STA $FF20
 LDA $FF21
 ORA #4
 STA $FF21
 LDA $FF23
 ORA #$38
 STA $FF23
 CLRB
UP STB $FF20
 LDX #300
D LEAX -1,X
 BNE D
 ADDB #4
 CMPB #$FC
 BNE UP
H BRA H
 END`;

(async () => {
  const Emu = require(path.join(ROOT, 'tests/load.js'))();
  const bin = [...Emu.toBinary(Emu.assemble(DAC_HIGH, '6809'))];
  const lines = [];
  const say = (s) => { lines.push(s); console.log(s); };
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/play/`;
  const browser = await chromium.launch();
  const results = [];
  try {
    for (let run = 1; run <= N; run++) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      try {
        await page.goto(`${base}?machine=dragon64`);
        const waitFor = async (fn, ms = 30000, arg) => { for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await page.evaluate(fn, arg).catch(() => false)) return true; await page.waitForTimeout(50); } return false; };
        await waitFor(() => !!(window.emu && window.emu.ready === true));
        await waitFor(() => !!(window.emu && window.emu.started));
        // the check's stubPrompt, verbatim
        await page.evaluate(() => { const s = window.emu.session; s.endWelcome(); s.stubRun = null; s.keys.clear(); window.emu.machine.reset(true); });
        await page.mouse.click(5, 5);
        const okAudio = await waitFor(() => !!(window.emu.audioRunning && window.emu.audioRunning() && window.emu.audio.path === 'worklet' && window.emu.audio.out));
        if (!okAudio) throw new Error('audio never started');
        // tap and the `made` wrapper, as the check installs them
        await page.evaluate(() => {
          const a = window.emu.audio, sink = a.out.sink, write = sink.write.bind(sink);
          window.made = []; window.played = []; window.blocks = [];
          sink.write = (c) => { window.made.push([sink.written, c.slice()]); write(c); };   // [index, chunk], as the check stores it
          a.node.port.addEventListener('message', (e) => { const t = e.data.tap; if (!t) return; window.blocks.push(t); for (const v of t.out) window.played.push(v); });
          a.node.port.postMessage({ tap: true });
        });
        await page.evaluate((b) => window.emu.session.load('dac.bin', new Uint8Array(b), { remember: false }), bin);
        // positive control: a quarter-second of sound, as the check's `wait()` does
        const n0 = await page.evaluate(() => window.played.length);
        await waitFor((n) => window.played.length >= n + 12000, 30000, n0);
        if (MODE === 'control') {
          const m = await page.evaluate(() => {
            const p = window.played; let jump = 0, at = 0, peak = 0;
            for (let i = 1; i < p.length; i++) { const d = Math.abs(p[i] - p[i - 1]); if (d > jump) { jump = d; at = i; } peak = Math.max(peak, Math.abs(p[i])); }
            return { jump: +jump.toFixed(4), peak: +peak.toFixed(4), n: p.length, at };
          });
          say(`control run ${run}: step ${m.jump} peak ${m.peak} samples ${m.n}  (the real check passes at ~0.0078 / ~0.0165)`);
          results.push({ mode: 'control', ...m });
        } else {
          const phase = run === 1 ? 0 : (run * 137) % 400;
          const r = await page.evaluate(([STALL, phase, plant]) => new Promise((res) => {
            setTimeout(() => {
              const a = window.emu.audio, sink = a.out.sink;
              const made = window.made, last = made.length ? made[made.length - 1][1] : null;
              const v = last && last.length ? last[last.length - 1] : 0;
              a.out.sink.write(new Float32Array(Math.round(0.1 * a.ctx.sampleRate)).fill(v));
              const b0 = window.blocks.length;
              const t = performance.now(); while (performance.now() - t < STALL);
              // PLANT: a step the machine never played - write a chunk whose first sample is the opposite of the
              // queue's held value, i.e. exactly what a bad resume would do. Written straight into the sink so it is
              // in the played stream and the measurement must see it.
              if (plant) {
                const held = (made.length && made[made.length - 1][1].length) ? made[made.length - 1][1][made[made.length - 1][1].length - 1] : 0;
                sink.write(new Float32Array(128).fill(held >= 0 ? -0.5 : 0.5));
              }
              setTimeout(() => {
                const p = window.played, bs = window.blocks.slice(b0);
                let jump = 0, at = 0, peak = 0;
                for (let i = 1; i < p.length; i++) { const d = Math.abs(p[i] - p[i - 1]); if (d > jump) { jump = d; at = i; } peak = Math.max(peak, Math.abs(p[i])); }
                let dry = 0; for (const b of bs) if (b.n < b.out.length) dry++;
                const win = []; for (let i = Math.max(0, at - 5); i <= Math.min(p.length - 1, at + 5); i++) win.push(+p[i].toFixed(4));
                res({ jump: +jump.toFixed(4), peak: +peak.toFixed(4), phase, blocks: bs.length, dry, n: p.length, win, seed: a.out.seed, depth: sink.buffered() });
              }, 700);
            }, phase);
          }), [STALL, phase, MODE === 'plant']);
          say(`${MODE} run ${String(run).padStart(2)}: stall ${STALL} ms phase ${String(r.phase).padStart(3)}  step ${r.jump}  peak ${r.peak}  dry ${r.dry}/${r.blocks}  seed ${r.seed}  window ${JSON.stringify(r.win)}`);
          results.push({ mode: MODE, ...r });
        }
      } catch (e) {
        say(`${MODE} run ${String(run).padStart(2)}: ERROR ${String(e && e.message).slice(0, 140)}`);
      } finally {
        await ctx.close();
      }
    }
    if (results.length) {
      const worst = results.reduce((a, b) => (b.jump > a.jump ? b : a), results[0]);
      say(`--- worst step ${worst.jump}, peak ${worst.peak}; over 0.01: ${results.filter((r) => r.jump >= 0.01).length}/${results.length}`);
    }
  } finally {
    await browser.close();
    server.close();
    fs.writeFileSync(OUT, lines.join('\n') + '\n');
  }
})();
