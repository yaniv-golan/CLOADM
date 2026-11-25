// The clean-room BASIC (docs/clean-room-basic.md) on a Dragon 64, for the tests and for tools/basic-bb: boot a
// machine with a given BASIC ROM in the "basic" socket, type into it through the keyboard matrix, and read the
// screen. Nothing here knows the ROM's internals: it works the same on any Dragon 64 BASIC (the one RAM address it
// reads, the cursor's at $0088-$0089, is a black-box fact of the real ROMs).
const Emu = require('../load.js')();
const zlib = require('zlib'), crypto = require('crypto');

// a PNG of RGBA pixels (8 bits a channel, filter 0 on every row)
function rgbaPng(w, h, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'ascii'), data]), c = Buffer.alloc(4);
    len.writeUInt32BE(data.length); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// One VDG text cell as text. Normal characters ($40-$7F) as themselves; inverse ones ($00-$3F) as lower case
// for letters and @ [ \ ] ^ _ (the Dragon shows lower case that way), and as the character followed by U+0332
// (a combining low line) otherwise; a semigraphics cell (bit 7: blocks) as a space. The cursor is a screen byte that
// blinks between $60 and $20 at the address in $0088-$0089 [BB, 2026-11-25, the real ROMs]: rows() reads that cell as
// a space in both phases, so what is read does not depend on when (an inverse space a program put there reads as a
// space too).
function cell(v) {
  if (v & 0x80) return ' ';
  const c = v & 0x3F, ch = String.fromCharCode(c < 32 ? c + 64 : c);
  if (v & 0x40) return ch;
  return c < 32 ? String.fromCharCode(c + 96) : ch + '̲';
}

// ---- Sound measures (#wav ... #wav-stop; docs/clean-room-basic-p2.md section 11, decision 5) ----
// What a case's sound did, as measures only: never the levels written or their order, since a wave played from a
// table in the ROM would carry that table. The events are { t, v, on, dac }: t the CPU cycle (from #wav) of a write
// to the DAC (dac: PIA1 port A's output register, $FF20 or a mirror; v the port's bits 2-7, 0-63) or of a write
// anywhere in the PIAs that changed `on`, whether the DAC is heard (sound enabled, PIA1 CB2 high, and the
// multiplexer on the DAC, PIA0 CA2 and CB2 low) [HW: js/machines/cocopia.js].
//
// Segmentation, exactly:
//  1. Runs: the heard events (on) in order; a run ends where two consecutive heard events are more than GAP cycles
//     apart, or where an event with on false comes between them.
//  2. In a run, mid = (lowest + highest level) / 2; a full cycle starts at each event that takes the level from below
//     mid to mid or above (a rising crossing); a period is the time from one rising crossing to the next.
//  3. A run splits into tones where the pitch changes: going through its periods in order, once the current tone has
//     at least 2, a period that differs from the current tone's median period by more than SPLIT (3%), with the
//     period after it differing too, starts a new tone at the rising crossing that begins it (that period, which may
//     span both notes, counts in neither tone). One odd period (an interrupt in the tone loop) does not split a
//     tone; a note of the same pitch played straight after another, with no gap, is one tone with it.
//  4. Each tone: start (cycles from #wav to its first event), length (from its first event to its last), period (the
//     median of its periods, null with none), periods (how many), writes (its events), levels (how many distinct
//     levels), low and high (the lowest and highest level).
// The whole window: cycles (its length), writes (DAC writes), heard (those heard), sha256 (of every event as "t,v,on"
// lines: to tell two runs apart, never to rebuild one), end (at #wav-stop: sound enabled, and the multiplexer 0-3).
const GAP = 20000, SPLIT = 0.03;
const median = (a) => { const s = [...a].sort((x, y) => x - y), h = s.length >> 1; return s.length & 1 ? s[h] : (s[h - 1] + s[h]) / 2; };
function soundMeasures(events, { cycles = 0, end = null } = {}) {
  const runs = [];
  let run = null, last = 0;
  for (const e of events) {
    if (!e.on) { run = null; continue; }
    if (!run || e.t - last > GAP) runs.push(run = []);
    run.push(e); last = e.t;
  }
  const tones = [];
  const tone = (ev, periods) => {
    const lv = ev.map((e) => e.v);
    tones.push({ start: ev[0].t, length: ev[ev.length - 1].t - ev[0].t, period: periods.length ? median(periods) : null,
      periods: periods.length, writes: ev.length, levels: new Set(lv).size, low: Math.min(...lv), high: Math.max(...lv) });
  };
  const differs = (p, m) => Math.abs(p - m) > SPLIT * m;
  for (const r of runs) {
    const lo = Math.min(...r.map((e) => e.v)), hi = Math.max(...r.map((e) => e.v)), mid = (lo + hi) / 2;
    const cross = [];                               // the rising crossings' indices in the run
    for (let i = 1; i < r.length; i++) if (r[i - 1].v < mid && r[i].v >= mid) cross.push(i);
    const per = cross.slice(1).map((c, j) => r[c].t - r[cross[j]].t);   // per[j]: from cross[j] to cross[j + 1]
    let from = 0, cur = [];                         // the current tone's first event and its periods
    for (let j = 0; j < per.length; j++) {
      if (cur.length >= 2 && j + 1 < per.length && differs(per[j], median(cur)) && differs(per[j + 1], median(cur))) {
        tone(r.slice(from, cross[j]), cur);
        from = cross[j]; cur = [];
        continue;                                   // the period that spans the change counts in neither tone
      }
      cur.push(per[j]);
    }
    tone(r.slice(from), cur);
  }
  const text = events.map((e) => `${e.t},${e.v},${e.on ? 1 : 0}`).join('\n');
  return { cycles, writes: events.filter((e) => e.dac).length, heard: events.filter((e) => e.dac && e.on).length,
    sha256: crypto.createHash('sha256').update(text).digest('hex'), tones, ...(end ? { end } : {}) };
}

// ---- The cassette (#tape, #tape-blank, #tape-rewind, #tape-blocks; docs/clean-room-basic.md section 7) ----
// What a case did with the tape, as a summary only: a block's data could in principle carry bytes from the ROM, so of
// a data block only its length and a SHA-256 are kept; of a namefile block (15 bytes) its fields. Per block: type,
// length, ok (its checksum), leader (the $55 bytes the decoder read before its $3C), then the namefile's name (8
// characters, padded as written), fileType, ascii and gaps (the flag bytes), exec and load, or the data's sha256. The
// motor: each run of it since the tape went in or the last summary, as { start, length } in fields (17,784 cycles,
// to 0.01; start from the first run's start, so how fast a line was typed does not count; length null while it is
// still running; carried: true for a run already going when the window began, whose length then depends on when the
// next line was typed). Blocks are decoded from the deck's recording by js/media/cassette.js (recordingToSamples,
// samplesToCas), the repository's own tape decoder.
const FIELD_CYCLES = 312 * 57;
function tapeDeck(b) {
  const m = b.m, d = m.deck, opts = m.profile.tape || {}, log = [];
  const real = d.setMotor;
  d.setMotor = function (on) { if (on !== this.motor) log.push([this.now(), on]); return real.call(this, on); };
  let bytes = null, recording = false, reported = 0, win = null;
  const window = () => { win = { t0: d.now(), on: d.motor, at: log.length }; };
  const insert = (cas) => { bytes = cas; d.insert(cas ? new Emu.Tape(cas, m.tickHz, 'case', opts) : null); };
  const recorded = () => {
    const ev = (d.recording || []).map((e) => e.slice());
    if (ev.length && d.motor) ev.push([d.now(), null]);
    if (!ev.length) return new Uint8Array(0);
    return Emu.samplesToCas(Emu.recordingToSamples(ev, m.tickHz, 44100), 44100, { zeroHz: opts.zeroHz, oneHz: opts.oneHz }).bytes;
  };
  const stopRecording = () => { if (recording) d.stopRecording(); recording = false; };
  const fields = (c) => Math.round(c / FIELD_CYCLES * 100) / 100;
  const block = (k, cas, from) => {
    let p = k.start - 1, leader = 0;
    while (p >= from && cas[p] === 0x55) { p--; leader++; }
    const s = { type: k.type, length: k.data.length, ok: k.ok, leader }, x = k.data;
    if (k.type === 0 && x.length === 15) {
      Object.assign(s, { name: String.fromCharCode(...x.subarray(0, 8)), fileType: x[8], ascii: x[9], gaps: x[10], exec: (x[11] << 8) | x[12], load: (x[13] << 8) | x[14] });
    } else if (x.length) s.sha256 = crypto.createHash('sha256').update(x).digest('hex');
    return s;
  };
  return {
    get inserted() { return win != null; },
    fixture(name, dir) {
      const { readFixture, fixtureCas } = require('../../tools/basic-bb/tapes.js');
      const cas = fixtureCas(dir ? readFixture(name, dir) : readFixture(name), Emu);
      stopRecording(); insert(cas); window();
    },
    blank() { stopRecording(); insert(null); d.startRecording(); recording = true; reported = 0; window(); },
    // -> false when there is nothing to rewind
    rewind() {
      if (recording) { const cas = recorded(); stopRecording(); insert(cas); } else if (bytes) insert(bytes); else return false;
      window();
      return true;
    },
    summary(name) {
      const spans = [];
      let on = win.on ? win.t0 : null;
      for (const [t, v] of log.slice(win.at)) { if (v) on = t; else if (on != null) { spans.push([on, t]); on = null; } }
      if (on != null) spans.push([on, null]);
      const base = spans.length ? spans[0][0] : 0;
      const out = { name, motor: spans.map(([s, e]) => ({ start: fields(s - base), length: e == null ? null : fields(e - s), ...(s === win.t0 && win.on ? { carried: true } : {}) })) };
      if (recording) {
        const cas = recorded(), all = [...Emu.casBlocks(cas)];
        out.blocks = all.slice(reported).map((k, i) => block(k, cas, reported + i > 0 ? all[reported + i - 1].end : 0));
        out.bad = out.blocks.filter((k) => !k.ok).length;
        reported = all.length;
      }
      window();
      return out;
    },
  };
}

class Basic {
  // rom: the 16K image for the "basic" socket; opts.machine (default dragon64)
  constructor(rom, { machine = 'dragon64' } = {}) {
    this.m = Emu.createMachine(machine);
    this.m.setRoms({ basic: rom, basic64: null });
    this.m.setComposite(0);        // the VDG's own colours in a picture, not a composite blend (P2 section 11)
    this.m.reset(true);
    this.frames = 0;
  }
  // A screen cleared while recording (a frame that leaves at most one row with text after one with two or more: CLS,
  // or a ROM clearing the screen for its own display) would lose what was on it, as no line scrolled off: the screen
  // as the frame before showed it is kept in `clears`, with that frame's number.
  frame() {
    this.m.runFrame(); this.frames++;
    if (!this.lines) return;
    const now = this.screen(), had = this.lastScreen || [], rows = (r) => r.filter((l) => l).length;
    if (rows(had) >= 2 && rows(now) <= 1) this.clears.push({ frame: this.frames - 1, screen: had });
    this.lastScreen = now;
  }
  // the picture now (the last whole frame): { width, height, sha256 of its RGBA pixels, png (base64) }
  shot(name) {
    const f = this.m.render(), p = Emu.frameToRGBA(f), rgba = Buffer.from(p.buffer, p.byteOffset, p.byteLength);
    return { name, width: f.width, height: f.height, sha256: crypto.createHash('sha256').update(rgba).digest('hex'), png: rgbaPng(f.width, f.height, rgba).toString('base64') };
  }
  // A clean start, before anything is recorded: the boot screen (a ROM's banner is ROM text) is blanked in the text
  // screen's memory from outside, then CLS is typed, and the screen must then hold only the OK prompt. -> true, or
  // false when it does not (nothing that was on the screen may then be recorded).
  cleanStart(limit = 1500) {
    this.m.ram.fill(0x60, 0x400, 0x600);
    const st = this.m.typist.typePaced('CLS\n');
    let n = 0;
    while (st.status === 'typing' && n++ < limit * 4) this.frame();
    if (!this.waitOk({ limit })) return false;
    const s = this.screen();
    return s.length === 1 && s[0] === 'OK';
  }
  // the SHA-256 of the last whole frame's RGBA pixels
  pixHash() {
    const p = Emu.frameToRGBA(this.m.render());
    return crypto.createHash('sha256').update(Buffer.from(p.buffer, p.byteOffset, p.byteLength)).digest('hex');
  }
  // Start recording the sound (#wav): every DAC write, and every change to whether the DAC is heard, with its cycle.
  // wavStop() takes the tap off and returns soundMeasures() of them (never the events themselves).
  wavStart() {
    const m = this.m, t0 = m.ioTime(), events = [];
    const heard = () => m.pia1.b.c2() && !m.pia0.a.c2() && !m.pia0.b.c2();
    let on = heard();
    const remove = m.busTaps.addWriteTap({ start: 0xFF00, end: 0xFF3F }, (a) => {
      const dac = a >= 0xFF20 && (a & 3) === 0 && (m.pia1.a.cr & 0x04) !== 0, now = heard();
      if (!dac && now === on) return;
      on = now;
      events.push({ t: m.ioTime() - t0, v: m.pia1.a.outValue() >> 2, on, dac });
    });
    this.wav = { t0, events, remove };
  }
  wavStop() {
    const m = this.m, w = this.wav;
    w.remove(); this.wav = null;
    return soundMeasures(w.events, { cycles: m.ioTime() - w.t0, end: { enabled: m.pia1.b.c2(), mux: (m.pia0.b.c2() ? 2 : 0) | (m.pia0.a.c2() ? 1 : 0) } });
  }
  // Start recording the transcript: every line that scrolls off the top of the screen, in order. A scroll is
  // recognised by what the CPU does, whatever the ROM: a write to the top row of a byte it has just read from the
  // same column of the row below (a block move). Writes that are not a move and overwrite text in the top row are
  // flagged, so a line is never lost silently. transcript() adds the screen as it is now.
  record() {
    if (this.taps) for (const remove of this.taps) remove();   // (each tap gives back its remove function)
    const m = this.m, recent = [];
    this.lines = []; this.flags = []; this.clears = []; this.lastScreen = this.screen();
    const SCR = 0x400;
    const cells0 = () => Array.from({ length: 32 }, (_, c) => cell(m.ram[SCR + c]));
    const row0 = () => cells0().join('').replace(/\s+$/, '');
    let snap = null, moved = new Set();     // the top row as it was before the move started; the columns moved
    this.taps = [
      m.busTaps.addReadTap({ start: SCR, end: SCR + 0x1FF }, (a) => { recent.push(a); if (recent.length > 8) recent.shift(); }),
      m.busTaps.addWriteTap({ start: SCR, end: SCR + 31 }, (a, v, old) => {
        const c = a - SCR;
        if (recent.includes(a + 32) && v === m.ram[a + 32]) {
          if (!moved.size) { const r = cells0(); r[c] = cell(old); snap = r.join('').replace(/\s+$/, ''); }
          moved.add(c);
          if (moved.size === 32) { this.lines.push(snap); moved = new Set(); }
        } else {
          const cursor = old === 0x20 && a === ((m.ram[0x88] << 8) | m.ram[0x89]);   // (the cursor blinking)
          if (old !== v && old !== 0x60 && !(old & 0x80) && !cursor) this.flags.push({ frame: this.frames, kind: 'top-row-overwritten', row: row0() });
          moved = new Set();
        }
      }, { old: true }),
    ];
  }
  // the lines recorded since record(), then the screen's rows (trailing blank rows dropped)
  transcript() { return [...this.lines, ...this.screen()]; }
  run(n) { for (let i = 0; i < n; i++) this.frame(); }
  // whether the VDG shows graphics (PIA1 PB7, A/G, high) rather than text
  graphicsShown() { return (this.m.pia1.b.outValue() & 0x80) !== 0; }
  // the 16 rows of the screen as text (trailing spaces kept), read from the display's own page; while a graphics
  // mode is shown, from the text screen at $0400 behind it (where BASIC still writes its text), so a prompt or an
  // error is read whether or not the ROM went back to text
  rows() {
    const m = this.m, at = this.graphicsShown() ? 0x400 : m.sam.displayBase, rows = [], cur = (m.ram[0x88] << 8) | m.ram[0x89];
    for (let r = 0; r < 16; r++) {
      let s = '';
      for (let c = 0; c < 32; c++) {
        const a = (at + r * 32 + c) & m.sam.counterMask, v = m.displayByte(a);
        s += cell(a === cur && v === 0x20 ? 0x60 : v);
      }
      rows.push(s);
    }
    return rows;
  }
  // the rows as text: trailing spaces and trailing blank rows dropped
  screen() {
    const r = this.rows().map((l) => l.replace(/\s+$/, ''));
    while (r.length && !r[r.length - 1]) r.pop();
    return r;
  }
  // type text through the matrix, paced by what the machine reads (the typist's paced mode), and run until it has
  // all been taken or `limit` frames pass. '\n' is ENTER. Returns the typist job's status.
  type(text, limit = 20000) {
    const job = this.lastJob = this.m.typist.typePaced(text);
    let n = 0;
    while (job.status === 'typing' && n++ < limit) this.frame();
    return job.status;
  }
  // hold matrix keys down together until the machine has read the last one's column 4 times (and 3 frames), then
  // let go for 3 frames; false if it was never read within `limit` frames
  keys(names, limit = 1500) {
    const m = this.m, last = names[names.length - 1], pos = m.keyPos[last];
    if (!pos || names.some((k) => !m.keyPos[k])) throw new Error(`no key ${names.join('+')}`);
    const base = m.colScans[pos[1]];
    for (const k of names) m.setKey(k, true);
    let n = 0;
    while ((m.colScans[pos[1]] - base < 4 || n < 3) && n < limit) { this.frame(); n++; }
    for (const k of names) m.setKey(k, false);
    this.run(3);
    return n < limit;
  }
  // run until fn() is true for `stable` frames in a row, or `limit` frames pass; true if it held
  until(fn, { limit = 3000, stable = 1 } = {}) {
    let ok = 0;
    for (let n = 0; n < limit; n++) {
      if (fn()) { if (++ok >= stable) return true; } else ok = 0;
      this.frame();
    }
    return false;
  }
  // the OK prompt is on the screen's last line with text, and the screen has not changed for `stable` frames
  waitOk({ limit = 3000, stable = 5 } = {}) {
    let last = null;
    return this.until(() => {
      const s = this.screen(), key = s.join('\n'), same = key === last;
      last = key;
      return same && s.length > 0 && s[s.length - 1] === 'OK';
    }, { limit, stable });
  }
}

// Run one case (docs/clean-room-basic.md section 7) on a fresh machine with `rom` in the BASIC socket.
// Lines are typed through the keyboard; lines starting with # are directives (# alone or "# text": a comment):
//   #type TEXT      type TEXT (\n is ENTER) and wait until the screen settles (for INPUT, INKEY$)
//   #break          press BREAK and wait for OK
//   #keys A+B       hold matrix keys together (SHIFT+LEFT, SHIFT+0, CLEAR) until the machine has read them, then
//                   let go, and wait until the screen settles
//   #frames N       run N frames
//   #wait-text RE   run until the screen matches the regular expression
//   #timeout S      the emulated seconds each wait may take from here on (default 30)
//   #expect-timeout from here on a wait that times out is the case's result, not a failure: the case ends there with
//                   status ok and ended { at, as: 'timeout' } (the original ignoring BREAK in a search, say)
//   #nowait         the next line is not waited for with OK, only until the screen settles
//   #screenshot NAME  record the picture as it is now (for graphics: the result's shots, each with a PNG and the
//                   SHA-256 of its pixels, which tools/basic-bb/compare.js compares)
//   #wav NAME       start recording the sound: DAC writes and whether the DAC is heard, with their cycles
//   #wav-stop       stop it: the result's sounds get { name, ...soundMeasures() }, measures only (a #wav still
//                   recording when the case ends is stopped there)
//   #joy N V        set joystick axis N (JOYSTK's numbering: 0 right x, 1 right y, 2 left x, 3 left y) to V (0-63)
//   #tape NAME      put in the tape a fixture makes (tests/basic/tapes/NAME.json: tools/basic-bb/tapes.js), at its start
//   #tape-blank     put in a blank tape and record what the machine writes to it
//   #tape-rewind    after #tape-blank: what was recorded (decoded to .CAS by js/media/cassette.js) becomes the tape, at
//                   its start; after #tape: the same tape again from its start
//   #tape-blocks NAME  the result's tapes get { name, motor, blocks?, bad? } (tapeSummary, below): the motor's runs and,
//                   while recording, the blocks written since #tape-blank or the last #tape-blocks; never their bytes
// A typed line that starts with a digit is a program line: waited for until the screen settles; any other line
// is waited for until OK is back. -> { status, transcript, flags, frames, shots?, sounds?, tapes?, clears? }; status 'ok',
// 'no-boot', 'no-clean-start', 'timeout' (and where), 'stalled' (a typed line of which no key was taken, and where), or
// the typist's status when the machine stopped reading the keyboard. clears: the screens a clear wiped (Basic.frame).
// Nothing of the screen is recorded before the clean start (Basic.cleanStart): the boot screen, a ROM's banner among
// it, is blanked from outside and CLS must leave only OK, so no case can record the banner, whatever it types first.
//
// guard (on by default; tools/basic-bb/run.js and the black-box cases always use it): the case is stopped, with
// status 'refused' and nothing of its screen recorded, if the CPU ever runs an instruction from RAM written since
// the case began: machine code a case put there (through a vector it POKEd, say) could read the ROM. Our own
// suite's EXEC and USR cases (tests/basic/own) run without it.
function runCase(rom, text, { machine = 'dragon64', guard = true, tapes: tapeDir } = {}) {
  const b = new Basic(rom, { machine });
  let refused = null;
  const shots = [], sounds = [], typistNotes = [], tapes = [];
  const deck = tapeDeck(b);
  let wavName = null, at = 'start';
  const wavStop = () => { sounds.push({ name: wavName, ...b.wavStop() }); wavName = null; };
  let clean = false;   // nothing of the screen is recorded until the clean start (Basic.cleanStart) has held
  let expectTimeout = false;
  const out = (status, extra = {}) => {
    // after #expect-timeout a step that times out is the case's result: status ok, ended { at, as: 'timeout' }
    if (status === 'timeout' && expectTimeout) { status = 'ok'; extra = { ...extra, ended: { at: extra.at, as: 'timeout' } }; delete extra.at; }
    if (wavName != null) wavStop();
    if (!clean) return { status, transcript: [], flags: [], frames: b.frames, ...extra };
    return refused
      ? { status: 'refused', why: refused, transcript: [], flags: [], frames: b.frames }
      : { status, transcript: b.lines ? b.transcript() : b.screen(), flags: b.flags || [], frames: b.frames, ...(shots.length ? { shots } : {}), ...(sounds.length ? { sounds } : {}), ...(tapes.length ? { tapes } : {}), ...(b.clears ? { clears: b.clears } : {}), ...(typistNotes.length ? { typist: typistNotes } : {}), ...extra };
  };
  if (!b.waitOk({ limit: 600, stable: 3 })) return out('no-boot');
  let limit = 30 * 50, nowait = false;
  const settle = () => { let last = null; return b.until(() => { const k = b.rows().join(''); const same = k === last; last = k; return same; }, { limit, stable: 10 }); };
  // a line is judged by what follows it (OK back, the screen settled), not by whether the typist saw every key
  // taken: a BASIC that runs the line at once and stops reading the keyboard (PLAY sounding, CLOAD) leaves the typist
  // at "not-consumed" though the line ran; that is only noted (the result's typist). Keys that really were not taken
  // leave BASIC waiting for the line, and the wait after it fails. A line of which the machine took no key at all ends
  // the case, status 'stalled' at that line: the machine stopped reading the keyboard before it (a still screen would
  // otherwise pass every wait that follows).
  const typed = (t) => {
    const st = b.type(t, limit * 4);
    if (st === 'not-consumed' && b.lastJob.consumed === 0) return 'stalled';
    if (st === 'not-consumed') { typistNotes.push({ at, status: st }); return null; }
    return st === 'done' ? null : st;
  };
  if (!b.cleanStart(limit)) return out('no-clean-start');
  clean = true;
  let st;
  b.record();
  if (guard) {
    const written = new Uint8Array(0x8000);
    b.m.busTaps.addWriteTap({ start: 0, end: 0x7FFF }, (a) => { written[a] = 1; });
    b.m.addProbe((pc) => {
      if (pc < 0x8000 && written[pc] && !refused) refused = `ran code at $${pc.toString(16).toUpperCase()} written during the case`;
    });
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (refused) return out('refused');
    const line = lines[i], where = `line ${i + 1}`;
    at = where;
    if (line.startsWith('#')) {
      const m = /^#(\S*)\s?(.*)$/.exec(line), cmd = m[1], arg = m[2];
      if (cmd === '') continue;
      if (cmd === 'type') { if ((st = typed(arg.replace(/\\n/g, '\n')))) return out(st, { at: where }); if (!settle()) return out('timeout', { at: where }); }
      else if (cmd === 'break') {
        const job = b.m.typist.holdPaced('BREAK');
        let n = 0;
        while (job.status === 'typing' && n++ < limit) b.frame();
        if (!b.waitOk({ limit })) return out('timeout', { at: where });
      } else if (cmd === 'keys') { if (!b.keys(arg.split('+'), limit)) return out('not-consumed', { at: where }); if (!settle()) return out('timeout', { at: where }); }
      else if (cmd === 'frames') b.run(Number(arg));
      else if (cmd === 'wait-text') { const re = new RegExp(arg, 'm'); if (!b.until(() => re.test(b.screen().join('\n')), { limit })) return out('timeout', { at: where }); }
      else if (cmd === 'timeout') limit = Math.round(Number(arg) * 50);
      else if (cmd === 'expect-timeout') expectTimeout = true;
      else if (cmd === 'nowait') nowait = true;
      else if (cmd === 'screenshot') { b.frame(); shots.push(b.shot(arg || `shot${shots.length + 1}`)); }
      else if (cmd === 'wav') { if (wavName != null) return out('bad-directive', { at: where }); wavName = arg || `sound${sounds.length + 1}`; b.wavStart(); }
      else if (cmd === 'wav-stop') { if (wavName == null) return out('bad-directive', { at: where }); wavStop(); }
      else if (cmd === 'joy') {
        const j = /^([0-3])\s+(\d+)$/.exec(arg.trim());
        if (!j || Number(j[2]) > 63) return out('bad-directive', { at: where });
        b.m.joy[j[1] >> 1][j[1] & 1] = Number(j[2]);
      }
      else if (cmd === 'tape') { try { deck.fixture(arg.trim(), tapeDir); } catch (e) { return out('bad-directive', { at: where, why: e.message }); } }
      else if (cmd === 'tape-blank') deck.blank();
      else if (cmd === 'tape-rewind') { if (!deck.rewind()) return out('bad-directive', { at: where, why: 'no tape to rewind' }); }
      else if (cmd === 'tape-blocks') { if (!deck.inserted) return out('bad-directive', { at: where, why: 'no tape' }); tapes.push(deck.summary(arg.trim() || `tape${tapes.length + 1}`)); }
      else return out('bad-directive', { at: where });
      continue;
    }
    if (!line.trim()) continue;
    if ((st = typed(line + '\n'))) return out(st, { at: where });
    const ok = nowait || /^\s*\d/.test(line) ? settle() : b.waitOk({ limit });
    nowait = false;
    if (!ok) return out('timeout', { at: where });
  }
  return out('ok');
}

module.exports = { Basic, cell, runCase, soundMeasures, tapeDeck, Emu };
