/*
 * Typist: types text into a machine through its keyboard matrix, one key per few frames, as a
 * person would (works with any ROM). A queued tape wait pauses typing until a cassette load has
 * finished (the motor ran and has stayed off for a second).
 *
 * Paced typing (typePaced, for Claude's type_text and the RUN its run tool types; holdPaced for its BREAK) goes by what the machine CONSUMES rather than by the clock.
 * A key is held until the CPU has read its keyboard column, with the key down, PACE.holdScans times (and at
 * least PACE.holdFrames frames), then released and held up until the column has been read PACE.releaseScans
 * times with the key up (and at least PACE.gapFrames frames), so the next key is never pressed before the
 * machine has seen this one go. After an Enter, nothing more is pressed until the machine is reading the
 * keyboard again (PACE.resumeScans reads of any column): a line editor busy storing the line, or a screen
 * busy scrolling, reads no keys, and keys pressed then are what got dropped. The counts are the machine's own
 * (Machine.scanKeys, and the stub's POLCAT calls), so this works with any ROM and with none. A key the machine
 * does not read within PACE.timeoutFrames frames ends the job: it reports how far it got, honestly. A key counts
 * as consumed once the machine has read it while it was down (a machine that read it and then stopped reading the
 * keyboard has it); holding it for more reads is what lets a debouncing line editor accept it.
 */
import { charToKeys } from './keyboards.js';

export const PACE = Object.freeze({ holdScans: 4, holdFrames: 3, releaseScans: 2, gapFrames: 2, resumeScans: 2, timeoutFrames: 300 });

// One paced typing job: what was asked, what the machine took, and a promise that settles when it ends.
class PacedJob {
  constructor(chars) {
    this.chars = chars;
    this.requested = chars.length;
    this.consumed = 0;                  // keys the machine read while they were held (stub: took from its queue)
    this.linesRequested = chars.filter((c) => c === '\r').length;
    this.linesDelivered = 0;            // Enters consumed
    this.status = 'typing';             // 'typing' | 'done' | 'not-consumed' | 'stopped' | 'machine-restarted' | 'no-consent' (consent withdrawn while held) | 'machine-stopped' (the Debugger stopped it: the rest is dropped)
    this.at = null;                     // where it failed: { index, char, phase }
    this.promise = new Promise((resolve) => { this.resolve = resolve; });
  }
  end(status, at = null) {
    if (this.status !== 'typing') return;
    this.status = status; this.at = at;
    this.resolve(this);
  }
}

// the typeWhen items among `items`, dropped undecided: each one's cancel, once
function cancelDecisions(items) {
  for (const it of items) if (it && typeof it === 'object' && it.decide && it.cancel) { const c = it.cancel; it.cancel = null; c(); }
}

class Typist {
  constructor(machine) {
    this.m = machine;
    this.queue = [];
    this.state = null;      // key held down / released, with frames left in that phase
  }
  type(text) { for (const ch of text) this.queue.push(ch); }
  // Type text paced by consumption (see the header). '\n' or '\r' is Enter. Returns the job; job.promise
  // settles with it when every key is consumed ('done'), when the machine stops reading the keyboard
  // ('not-consumed') or when the typing is cleared ('stopped'). The keys are queue items of their own, so a
  // pause that takes the queue back holds back exactly the keys not yet pressed.
  typePaced(text) {
    const chars = [...String(text).replace(/\r\n?|\n/g, '\r')];
    const job = new PacedJob(chars);
    chars.forEach((ch, index) => this.queue.push({ paced: ch, index, job, last: index === chars.length - 1 }));
    if (!chars.length) job.end('done');
    return job;
  }
  // Hold a key that is not a character (BREAK) the paced way: down until the machine has read it, as a paced typed
  // key is, so the job says whether the machine read it (consumed) or not (not-consumed). Returns the job.
  holdPaced(key) {
    const job = Object.assign(new PacedJob([key]), { key });
    this.queue.push({ paced: key, key, index: 0, job, last: true });
    return job;
  }
  waitTape() { this.queue.push({ waitTape: true }); }
  // Type `text` only if the machine is ready for it: decide(), asked once a frame from when the keys before it
  // have been typed, returns 'wait' (ask again next frame), 'type' (type the text now) or 'drop' (never type it).
  // Typing after a load is decided by what the machine does, not by a time: Session.loadMedia's EXEC.
  // `cancel` (optional) is called if the item is dropped before decide() settles it (clear, dropTyped): what decide()
  // watches with (the load detector's probe) goes with it.
  typeWhen(decide, text, cancel = null) { this.queue.push({ decide, text, cancel }); }
  // press a key that is not a character (BREAK): queued like typing, so it goes down and comes back up
  // across frames exactly as a typed key does. A key set down and up inside one call is invisible - the CPU
  // reads the PIA, it is not sampled by the machine - so the press has to span frames to be seen at all.
  press(key) { this.queue.push({ press: key }); }
  get busy() { return this.queue.length > 0 || this.state !== null; }
  // Drop every key. why: how the paced jobs end - 'stopped' (Claude was stopped: Session.stopClaude) or
  // 'machine-restarted' (the machine reset under them: Machine.reset). A job whose keys the machine had all read
  // ends 'done' either way: it was typed, only its last key's release was cut short.
  clear(why = 'stopped') {
    const jobs = new Set(this.queue.filter((it) => it && it.job).map((it) => it.job));
    if (this.state && this.state.job) jobs.add(this.state.job);
    if (this.state && this.state.keys) for (const k of this.state.keys) this.m.setKey(k, false);
    const dropped = this.queue;
    this.queue = []; this.state = null;
    cancelDecisions(dropped);
    for (const j of jobs) j.end(j.consumed === j.requested ? 'done' : why);
  }
  // Drop what type(), waitTape(), typeWhen() and press() queued (what a load typed, or is waiting to type), and let
  // go of such a key held down now; paced jobs (Claude's typing) are kept. A program loaded next replaces the one
  // those keys were for: Session.cancelLoadTyping.
  dropTyped() {
    const dropped = this.queue.filter((it) => !(it && typeof it === 'object' && it.paced !== undefined));
    this.queue = this.queue.filter((it) => it && typeof it === 'object' && it.paced !== undefined);
    cancelDecisions(dropped);
    if (this.state && !this.state.job) { for (const k of this.state.keys) this.m.setKey(k, false); this.state = null; }
  }
  // drop a job's keys still waiting (it has ended: nothing of it is typed later)
  dropJob(job) { this.queue = this.queue.filter((it) => !(it && it.job === job)); }
  // once per frame
  step() {
    const m = this.m, st = this.state;
    if (st && st.job) { this.stepPaced(st); return; }
    if (st) {
      if (--st.frames > 0) return;
      if (st.down) {
        for (const k of st.keys) m.setKey(k, false);
        this.state = { down: false, frames: 2, keys: [] };
        return;
      }
      this.state = null;
    }
    if (!this.queue.length) return;
    const item = this.queue[0];
    if (typeof item === 'object' && item.paced !== undefined) { this.startPaced(item); return; }
    if (typeof item === 'object' && item.press) {
      this.queue.shift();
      m.setKey(item.press, true);
      this.state = { down: true, frames: 3, keys: [item.press] };
      return;
    }
    if (typeof item === 'object' && item.decide) {
      const verdict = item.decide();
      if (verdict === 'wait') return;
      this.queue.shift();
      if (verdict === 'type') this.queue.unshift(...item.text);
      return;
    }
    if (typeof item === 'object') {
      const deck = m.deck;
      if (deck.motor) { item.started = true; item.settle = 0; }
      else if (item.started || !deck.tape || deck.tape.atEnd()) {
        item.settle = (item.settle || 0) + 1;
        if (item.settle > 50) this.queue.shift();
      }
      return;
    }
    this.queue.shift();
    const map = charToKeys(item);
    if (!map) return;
    const keys = map.shift ? ['SHIFT', map.key] : [map.key];
    for (const k of keys) m.setKey(k, true);
    this.state = { down: true, frames: 3, keys };
  }

  // ---------------- paced keys ----------------
  // where a typed key is read: its column, or null for the stub (which takes key codes, not the matrix)
  startPaced(item) {
    const m = this.m, job = item.job;
    if (job.status !== 'typing') { this.dropJob(job); return; }
    // after an Enter, wait until the machine reads the keyboard again before pressing anything
    if (item.index > 0 && job.chars[item.index - 1] === '\r' && !item.resumed) {
      this.state = { job, item, phase: 'resume', frames: 0, base: m.keyScans, keys: [] };
      return;
    }
    this.queue.shift();
    this.pressPaced(item);
  }
  pressPaced(item) {
    const m = this.m, job = item.job;
    if (m.useStub) {
      // the stub takes key codes, never the matrix: a key that is no character (BREAK) cannot reach it
      if (item.key) { this.fail({ job, item, keys: [] }, 'down'); return; }
      m.stubKeys.push(m.stubCode(item.paced));
      this.state = { job, item, phase: 'down', frames: 0, stub: true, base: m.stubKeysTaken, keys: [] };
      return;
    }
    const map = item.key ? { key: item.key } : charToKeys(item.paced);
    const keys = map.shift ? ['SHIFT', map.key] : [map.key];
    const col = m.keyPos[map.key] ? m.keyPos[map.key][1] : null;
    for (const k of keys) m.setKey(k, true);
    this.state = { job, item, phase: 'down', frames: 0, col, base: col == null ? m.keyScans : m.colScans[col], keys };
  }
  seen(st) { const m = this.m; return st.stub ? m.stubKeysTaken - st.base : (st.col == null ? m.keyScans : m.colScans[st.col]) - st.base; }
  fail(st, phase) {
    const m = this.m;
    for (const k of st.keys) m.setKey(k, false);
    if (st.stub && st.phase === 'down') {               // a code the stub never took must not be typed later
      const i = m.stubKeys.lastIndexOf(m.stubCode(st.item.paced));
      if (i >= 0) m.stubKeys.splice(i, 1);
    }
    this.state = null;
    this.dropJob(st.job);
    st.job.end('not-consumed', { index: st.item.index, char: st.item.paced, phase });
  }
  stepPaced(st) {
    const m = this.m, job = st.job;
    if (job.status !== 'typing') { for (const k of st.keys) m.setKey(k, false); this.state = null; this.dropJob(job); return; }
    st.frames++;
    if (st.phase === 'resume') {
      if (m.keyScans - st.base >= PACE.resumeScans) {
        st.item.resumed = true; this.state = null;
        if (this.queue[0] === st.item) { this.queue.shift(); this.pressPaced(st.item); }
      } else if (st.frames > PACE.timeoutFrames) this.fail(st, 'resume');
      return;
    }
    if (st.phase === 'down') {
      const enough = st.stub ? this.seen(st) >= 1 : this.seen(st) >= PACE.holdScans && st.frames >= PACE.holdFrames;
      if (enough) {
        job.consumed++;
        if (st.item.paced === '\r') job.linesDelivered++;
        for (const k of st.keys) m.setKey(k, false);
        this.state = { job, item: st.item, phase: 'up', frames: 0, stub: st.stub, col: st.col, base: st.stub ? 0 : (st.col == null ? m.keyScans : m.colScans[st.col]), keys: [] };
      } else if (st.frames > PACE.timeoutFrames) {
        // read at least once while held and then no more: the machine has the key (it stopped reading after it)
        if (this.seen(st) > 0) { job.consumed++; if (st.item.paced === '\r') job.linesDelivered++; this.fail(st, 'release'); }
        else this.fail(st, 'down');
      }
      return;
    }
    // up: the key is released; the next one waits until the machine has seen it go (the last key needs only the gap)
    const gone = st.stub || st.item.last || this.seen(st) >= PACE.releaseScans;
    if (gone && st.frames >= PACE.gapFrames) {
      this.state = null;
      if (st.item.last) job.end('done');
    } else if (!gone && st.frames > PACE.timeoutFrames) this.fail(st, 'release');
  }
}

export { Typist };
