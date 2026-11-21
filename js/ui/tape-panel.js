/*
 * The cassette panel, under the screen while a tape
 * is in the deck or the deck is recording: what the deck is doing (LOADING · BLOCK 14 OF 31, a read error, end
 * of tape), the cassette with its label and reels (the tape winds from left to right as it plays), the tape's
 * bytes as a waveform strip coloured up to the play position, the progress stripe in the VDG colours, the
 * counter, the bit frequencies, the motor, how fast it is going, and two controls: real speed (the Media tab's
 * "Fast tape loading", inverted) and "Skip the tape (load instantly)". A read error (BASIC's ?IO ERROR as the
 * motor stops) marks its block red and offers a rewind.
 *
 * The screen itself shows BASIC's own S and F in its top-left corner, drawn by the emulated VDG: the panel
 * adds only what the screen can't show. The design's tape sound at real speed is not built (the emulated
 * audio is the machine's sound output, which doesn't carry the cassette input).
 */
import { $ } from './page.js';

const pad3 = (n) => String(Math.max(0, Math.floor(n)) % 1000).padStart(3, '0');
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const POLL_MS = 250;

export function setupTapePanel(page) {
  const { session } = page;
  const panel = $('tapePanel'), wave = $('tapeWave');
  let waveFor = null, heights = [];
  let speed = { at: performance.now(), frame: 0, x: 0 };

  // bar heights from the tape's bytes (decorative, aria-hidden): one bar per stretch of the image
  function shape(t) {
    const n = 48, b = t.bytes, per = Math.max(1, Math.floor(b.length / n));
    heights = Array.from({ length: n }, (_, i) => {
      let ones = 0, count = 0;
      for (let j = i * per; j < Math.min(b.length, (i + 1) * per); j += Math.max(1, Math.floor(per / 16))) {
        let v = b[j]; while (v) { ones += v & 1; v >>= 1; } count++;
      }
      return count ? 0.2 + 0.7 * ones / (count * 8) : 0.1;
    });
    waveFor = t;
  }
  function drawWave(st) {
    const r = wave.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (wave.width !== w || wave.height !== h) { wave.width = w; wave.height = h; }
    const g = wave.getContext('2d'), n = heights.length, step = w / n, bw = Math.max(2, step * 0.6);
    g.clearRect(0, 0, w, h);
    heights.forEach((v, i) => {
      const done = (i + 0.5) / n <= st.progress;
      const bad = st.error && Math.abs((i + 0.5) / n - st.progress) < 1.5 / n;
      g.fillStyle = bad ? '#D8202A' : done ? '#FF9A2E' : '#5C3A14';
      const bh = v * h * 0.85;
      g.fillRect(i * step + (step - bw) / 2, (h - bh) / 2, bw, bh);
    });
  }

  function update() {
    const m = session.personMachine;
    if (!m) return;
    const st = session.tapeStatus(), rec = session.tapeRecording;
    panel.hidden = !st && !rec;
    if (panel.hidden) return;
    // measured speed: emulated frames per real second against the machine's own rate
    const now = performance.now();
    if (now - speed.at >= 1000) { speed = { at: now, frame: m.frameCount, x: (m.frameCount - speed.frame) / m.fps / ((now - speed.at) / 1000) }; }
    const eyebrow = $('tapeEyebrow');
    eyebrow.classList.toggle('error', !!(st && st.error));
    if (rec && !st) {
      eyebrow.textContent = m.deck.motor ? 'RECORDING · MOTOR ON' : 'RECORDING · WAITING FOR THE MOTOR';
      $('tapeLabel').textContent = 'Recording'; $('tapeLength').textContent = '';
      panel.dataset.state = 'recording';
      $('btnSkipTape').hidden = true; $('btnTapeRetry').hidden = true;
      $('tapeCounter').textContent = `motor ${m.deck.motor ? 'ON' : 'off'}`; $('tapeSpeed').textContent = '';
      $('tapeBar').style.width = '0%';
      return;
    }
    if (waveFor !== m.deck.tape) shape(m.deck.tape);
    const p = m.profile.tape || {};
    eyebrow.textContent = st.error ? `READ ERROR · BLOCK ${st.error} OF ${st.blocks}`
      : st.progress >= 1 ? `END OF TAPE · ${st.blocks} BLOCKS`
        : st.motor ? `${rec ? 'RECORDING · ' : ''}LOADING · BLOCK ${Math.max(1, st.block)} OF ${st.blocks}`
          : `STOPPED · BLOCK ${st.block} OF ${st.blocks}`;
    panel.dataset.state = st.error ? 'error' : st.motor ? 'playing' : 'stopped';
    $('tapeLabel').textContent = st.name;
    $('tapeLength').textContent = mmss(st.duration);
    $('reelL').style.setProperty('--wound', (1 - st.progress).toFixed(3));
    $('reelR').style.setProperty('--wound', st.progress.toFixed(3));
    $('tapeBar').style.width = `${(st.progress * 100).toFixed(1)}%`;
    // the stripe keeps its full-width colours: the bar only uncovers more of it
    $('tapeBar').style.setProperty('--stripe-w', st.progress > 0 ? `${(100 / st.progress).toFixed(1)}%` : '100%');
    $('tapeCounter').textContent = `Counter ${pad3(st.seconds)} · ${p.zeroHz || 1200}/${p.oneHz || 2400} Hz · motor ${st.motor ? 'ON' : 'off'}`;
    $('tapeSpeed').textContent = !st.motor ? '' : st.realSpeed ? 'Real speed' : `Fast-forward ×${Math.max(1, Math.round(speed.x))}`;
    $('btnRealSpeed').setAttribute('aria-pressed', String(st.realSpeed));
    $('btnRealSpeed').textContent = `Real speed: ${st.realSpeed ? 'on' : 'off'}`;
    $('btnSkipTape').hidden = st.progress >= 1;
    $('btnTapeRetry').hidden = !st.error;
    drawWave(st);
  }

  // real speed is the Media tab's "Fast tape loading" turned round: one setting, two places
  $('btnRealSpeed').onclick = () => {
    const box = $('chkFastTape');
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change'));
    update();
  };
  $('btnSkipTape').onclick = () => { page.attempt(() => session.skipTape()); update(); page.focus(); };
  $('btnTapeRetry').onclick = () => { session.rewindTape(); page.status('Tape rewound: type CLOAD (or CLOADM) again'); update(); page.focus(); };
  session.on((ev) => { if (ev === 'machine' || ev === 'loaded') update(); });
  setInterval(update, POLL_MS);
  return { update };
}
