/*
 * A floppy drive: spindle motor, index sensor, head stepper, side select, write protect and the disk's flux
 * transitions as they pass the head. A port of MAME 0.264's floppy_image_device (src/devices/imagedev/
 * floppy.cpp), so that the controller sees every bit and every index pulse at MAME's times:
 *   - the disk turns at 300 rpm from the moment the motor is switched on (revolution_start_time); the index
 *     pulse is high for the first 2,000,000 of the 200,000,000 positions of a revolution (2 ms);
 *   - positions convert to time and back through doubles exactly as MAME does (find_position,
 *     position_to_time), with the same rounding;
 *   - a long stretch without flux, or an unformatted area, reads as random flux (MAME's weak bits, from the
 *     same hash), so unformatted tracks behave as they do in MAME;
 *   - written flux replaces the covered span of the track (write_flux, wspan_*).
 * The drive knows nothing about machines. Time comes from an AttoClock (js/chips/attoclock.js).
 *
 * Media: mount(media) with media = { bytes, format: 'vdk' | 'jvc' | 'dmk', name, writeProtected,
 * onWrite(offset, bytes, size) }. The disk is decoded once (js/media/disk.js); writes stay in the flux
 * image and are committed to media.bytes when the motor stops, on flush() and on unmount (as MAME commits
 * its image), reported to media.onWrite as the changed byte ranges so a random-access store
 * (MediaStore.writeRange) can keep the file in step.
 */
import { NEVER, ZERO, add, asDouble, fromDouble, fromUsec, asTicks, fromTicks, toText, fromText } from './attotime.js';
import { loadDisk, saveDisk, diskGeometry, mgType, mgTime, mg, MG_F, MG_N, MG_D, MG_E } from '../media/disk.js';

// drive types (floppy.cpp setup_characteristics)
export const DRIVE_TYPES = {
  '525qd': { tracks: 84, sides: 2, rpm: 300 },    // FLOPPY_525_QD: the Dragon FDC's drives
  '35dd': { tracks: 84, sides: 2, rpm: 300 },     // FLOPPY_35_DD: the Dragon Alpha's built-in drives
  '525dd': { tracks: 42, sides: 2, rpm: 300 },    // FLOPPY_525_DD: the CoCo FDC's drives
};

const hash32 = (a) => {
  a = (a + 0x7ed55d16 + (a << 12)) >>> 0;
  a = ((a ^ 0xc761c23c) ^ (a >>> 19)) >>> 0;
  a = (a + 0x165667b1 + (a << 5)) >>> 0;
  a = ((a + 0xd3a2646c) ^ (a << 9)) >>> 0;
  a = (a + 0xfd7046c5 + (a << 3)) >>> 0;
  a = ((a ^ 0xb55a4f09) ^ (a >>> 16)) >>> 0;
  return a;
};

const DRIVE_STATE = ['mon', 'cyl', 'ss', 'actualSs', 'dir', 'stp', 'wpt', 'idx', 'ready', 'readyCounter', 'revCount', 'cacheIndex', 'cacheEntry', 'cacheWeak', 'imageDirty'];
const ATTO_STATE = ['revStart', 'cacheStart', 'cacheEnd', 'cacheWeakStart'];

// the first index from `from` whose cell's time is at or after t (track.length if none); the cells are in time order
function firstAtOrAfter(track, t, from) {
  let lo = from, hi = track.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (mgTime(track[mid]) >= t) hi = mid; else lo = mid + 1; }
  return lo;
}
// tracks seen to hold no damaged cell (see wspanRemoveDamaged)
const UNDAMAGED = new WeakSet();

// Does this image survive a round trip through its own format? Decode it, write it back with saveDisk(), decode
// again, and compare the flux track for track. True for VDK, JVC and double-density DMK; false for single-density
// DMK, whose FM bytes come back as a different but equivalent encoding. Two decodes and one encode of every track,
// about three times the cost of building the whole disk (a mount builds only the tracks the guest reads), so
// mount() does not do it: the drive works it out once per mount,
// the first time drive.mountBytes is read. The Session reads it in the background after a mount
// (Session.checkDiskLater), so the work is normally done before the first snapshot; a snapshot taken sooner gets
// the same answer by doing it then. It cannot throw, so deferring it moves no error: a bad image still fails at
// mount, in loadDisk. The caller keeps the mounted bytes only when this says the committed image cannot be trusted
// to rebuild the drive.
function roundTrips(bytes, format, tracks, heads) {
  let again;
  try {
    const a = loadDisk(bytes, format, { tracks, heads });
    const saved = saveDisk(a, format, { geometry: diskGeometry(bytes, format) });
    again = loadDisk(saved, format, { tracks, heads });
    for (let i = 0; i < again.count; i++) {
      const x = a.track(i), y = again.track(i);
      if (x.length !== y.length) return false;
      for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return false;
    }
    return true;
  } catch (e) { return false; }   // a format we cannot write back at all: keep the mounted bytes
}

export class FloppyDrive {
  constructor(clock, name, type = '525dd') {
    const t = DRIVE_TYPES[type];
    if (!t) throw new Error(`unknown drive type ${type}`);
    this.type = type;
    this.tracks = t.tracks;
    this.sides = t.sides;
    // set_rpm: m_rpm is a float, so 60 / m_rpm is a float division (0.2 s becomes 0.20000000298 s)
    const rpm = Math.fround(t.rpm);
    this.revTime = fromDouble(Math.fround(60 / rpm));
    this.angularSpeed = rpm / 60.0 * 2e8;
    this.freakout = fromUsec(16);
    this.clock = clock;
    this.indexTimer = clock.timer(`${name}.index`, () => this.indexResync());
    this.indexCb = null;          // (state) from the controller
    this.readyCb = null;
    this.media = null;
    this.image = null;
    // The image as mounted, kept ONLY for an image whose format does not survive a round trip (see mount());
    // null otherwise, which is every VDK and JVC image and every double-density DMK. Decided lazily: until the
    // get mountBytes() below first runs, pendingBytes holds a copy of the image as mounted.
    this.keptBytes = null;
    this.pendingBytes = null;
    this.written = new Set();     // track buffers changed since mount (by index)
    this.saveError = null;
    this.mon = 1; this.cyl = 0; this.ss = 0; this.actualSs = 0; this.dir = 0; this.stp = 1; this.wpt = 0; this.idx = 0;
    this.ready = true; this.readyCounter = 0;
    this.revStart = NEVER; this.revCount = 0;
    this.imageDirty = false;
    this.cacheClear();
  }

  // ---------------- media
  mount(media) {
    const g = diskGeometry(media.bytes, media.format);
    const image = loadDisk(media.bytes, media.format, { tracks: this.tracks, heads: this.sides });
    this.media = media;
    this.image = image;
    this.geometry = g;
    // A snapshot rebuilds a drive from the committed image (media.bytes) plus the flux of every written track,
    // which is exact only if the format gives back what it was given. VDK, JVC and double-density DMK do. A
    // single-density DMK image does not: its FM track bytes come back as a different but equivalent MFM/FM
    // encoding, so a committed image reloaded is not the flux the drive had. For those, keep the mounted bytes
    // too, so a restore starts from them - the cost is carrying the image twice in that case only. Which case
    // this is waits for the first time it matters (get mountBytes); until then, a copy of the bytes as mounted,
    // because flush() commits writes into media.bytes in place.
    this.keptBytes = null;
    this.pendingBytes = media.bytes.slice();
    this.written.clear();
    this.saveError = null;
    this.initLoad(!media.writeProtected);
  }
  // init_floppy_load
  initLoad(writeSupported) {
    this.cacheClear();
    this.revStart = this.mon ? NEVER : this.clock.now();
    this.revCount = 0;
    this.indexResync();
    this.wpt = writeSupported ? 0 : 1;
    if (!this.mon) this.readyCounter = 2;
    this.imageDirty = false;
  }
  unmount() {
    if (!this.image) return;
    this.flush();
    this.image = null; this.media = null; this.written.clear();
    this.keptBytes = null; this.pendingBytes = null;
    this.cacheClear();
    this.revStart = NEVER;
    this.indexResync();
  }
  get loaded() { return !!this.image; }
  // The image as mounted when its format does not round-trip, else null (see mount()). Worked out from the copy
  // taken at mount the first time it is asked for, so the answer is the one an eager check at mount would give.
  get mountBytes() {
    if (this.pendingBytes) {
      const b = this.pendingBytes;
      this.pendingBytes = null;
      this.keptBytes = roundTrips(b, this.media.format, this.tracks, this.sides) ? null : b;
    }
    return this.keptBytes;
  }
  setWriteProtect(on) { this.wpt = on ? 1 : 0; if (this.media) this.media.writeProtected = !!on; }

  // commit_image: the flux image back into the file, reported as changed ranges
  flush() {
    if (!this.image || !this.imageDirty) return;
    this.imageDirty = false;
    const m = this.media;
    let out;
    try {
      // geometry as mounted, so a headerless image (an OS-9 dump) is written back headerless: saveDisk would
      // otherwise add JVC's two-byte header for a two-sided disk, which is not what MAME writes for OS-9
      out = saveDisk(this.image, m.format, m.format === 'dmk' ? { trackLength: this.geometry.trackLength, writeProtected: this.geometry.writeProtected } : { geometry: this.geometry });
    } catch (e) { this.saveError = e; return; }
    this.saveError = null;
    const old = m.bytes;
    if (out.length !== old.length) {
      m.bytes = out;
      if (m.onWrite) m.onWrite(0, out, out.length);
      return;
    }
    for (let i = 0; i < out.length;) {
      if (out[i] === old[i]) { i++; continue; }
      let j = i;
      while (j < out.length && out[j] !== old[j]) j++;
      old.set(out.subarray(i, j), i);
      if (m.onWrite) m.onWrite(i, out.slice(i, j), out.length);
      i = j;
    }
  }

  // ---------------- control lines
  monW(state) {
    if (this.mon === state) return;
    this.mon = state;
    if (!this.mon && this.image) {
      this.revStart = this.clock.now();
      this.cacheClear();
      this.readyCounter = 2;
      this.indexResync();
    } else {
      if (this.imageDirty) this.flush();
      this.cacheClear();
      this.revStart = NEVER;
      this.indexTimer.adjust(ZERO);
      this.setReady(true);
    }
  }
  timeNextIndex() { return this.revStart >= NEVER ? NEVER : add(this.revStart, this.revTime); }
  indexResync() {
    if (this.revStart >= NEVER) {
      if (this.idx) { this.idx = 0; if (this.indexCb) this.indexCb(0); }
      return;
    }
    let delta = this.clock.now() - this.revStart;
    while (delta >= this.revTime) { delta -= this.revTime; this.revStart += this.revTime; this.revCount++; }
    const position = Math.trunc(asDouble(delta) * this.angularSpeed + 0.5);
    const newIdx = position < 2000000 ? 1 : 0;
    if (newIdx) this.indexTimer.adjust(fromDouble(2000000 / this.angularSpeed) - delta);
    else this.indexTimer.adjust(this.revTime - delta);
    if (newIdx !== this.idx) {
      this.idx = newIdx;
      if (this.idx && this.ready) {
        this.readyCounter--;
        if (!this.readyCounter) this.setReady(false);
      }
      if (this.indexCb) this.indexCb(this.idx);
    }
  }
  setReady(state) {
    if (state !== this.ready) { this.ready = state; if (this.readyCb) this.readyCb(state ? 1 : 0); }
  }
  readyR() { return this.ready ? 1 : 0; }
  idxR() { return this.idx; }
  wptR() { return this.wpt; }
  trk00R() { return this.cyl !== 0 ? 1 : 0; }      // active low: 0 at track 0
  dirW(state) { this.dir = state; }
  ssW(state) { this.actualSs = state; if (this.sides > 1) this.ss = state; }
  stpW(state) {
    if (this.stp !== state) {
      this.cacheClear();
      this.stp = state;
      if (this.stp === 0) {
        if (this.dir) { if (this.cyl) this.cyl--; } else if (this.cyl < this.tracks - 1) this.cyl++;
      }
    }
  }

  // ---------------- flux
  buffer() { return this.image.buffer(this.cyl, this.ss); }
  findIndex(position, buf) {
    let spos = (buf.length >> 1) - 1, step;
    for (step = 1; step < buf.length + 1; step <<= 1) { /* */ }
    step >>= 1;
    for (;;) {
      if (spos >= buf.length || (spos > 0 && mgTime(buf[spos]) > position)) { spos -= step; step >>= 1; }
      else if (spos < 0 || (spos < buf.length - 1 && mgTime(buf[spos + 1]) <= position)) { spos += step; step >>= 1; }
      else return spos;
    }
  }
  // returns [position, base]
  findPosition(when) {
    let base = this.revStart;
    let delta = when - base;
    while (delta >= this.revTime) { delta -= this.revTime; base += this.revTime; }
    while (delta < ZERO) { delta += this.revTime; base -= this.revTime; }
    let res = Math.trunc(asDouble(delta) * this.angularSpeed + 0.5) >>> 0;
    if (res >= 200000000) { res -= 200000000; base += this.revTime; }
    return [res, base];
  }
  positionToTime(base, position) { return base + fromDouble(position / this.angularSpeed); }
  cacheClear() {
    this.cacheStart = ZERO; this.cacheEnd = ZERO; this.cacheWeakStart = ZERO;
    this.cacheIndex = 0; this.cacheEntry = 0; this.cacheWeak = false;
  }
  cacheFillIndex(buf, st) {
    const cells = buf.length;
    this.cacheIndex = st.index;
    this.cacheStart = this.positionToTime(st.base, mgTime(buf[st.index]));
    this.cacheEntry = buf[this.cacheIndex];
    st.index++;
    if (st.index >= cells) { st.index = 0; st.base += this.revTime; }
    this.cacheEnd = this.positionToTime(st.base, mgTime(buf[st.index]));
  }
  cacheFill(when) {
    const buf = this.buffer();
    if (buf.length <= 1) {
      this.cacheStart = ZERO; this.cacheEnd = NEVER; this.cacheIndex = 0;
      this.cacheEntry = buf.length === 1 ? buf[0] : mg(MG_N, 0);
      this.cacheWeaknessSetup();
      return;
    }
    const [position, base] = this.findPosition(when);
    const st = { index: this.findIndex(position, buf), base };
    if (st.index === -1) {
      this.cacheStart = ZERO; this.cacheEnd = NEVER; this.cacheIndex = 0; this.cacheEntry = buf[0];
      this.cacheWeaknessSetup();
      return;
    }
    for (;;) {
      this.cacheFillIndex(buf, st);
      if (this.cacheEnd > when) { this.cacheWeaknessSetup(); return; }
    }
  }
  cacheWeaknessSetup() {
    const type = mgType(this.cacheEntry);
    if (type === MG_N || type === MG_D) { this.cacheWeak = true; this.cacheWeakStart = this.cacheStart; return; }
    this.cacheWeak = this.cacheEnd >= NEVER || (this.cacheEnd - this.cacheStart >= this.freakout);
    if (!this.cacheWeak) { this.cacheWeakStart = NEVER; return; }
    this.cacheWeakStart = this.cacheStart + fromUsec(16);
  }
  getNextTransition(fromWhen) {
    if (!this.image || this.mon) return NEVER;
    if (fromWhen < this.cacheStart || this.cacheStart === ZERO || (this.cacheEnd < NEVER && fromWhen >= this.cacheEnd)) this.cacheFill(fromWhen);
    if (!this.cacheWeak) return this.cacheEnd;
    // a flux transition in the middle of a 4 us interval with a 50% probability
    let intervalIndex = fromWhen < this.cacheWeakStart ? 0n : asTicks(fromWhen - this.cacheWeakStart, 250000);
    let weakTime = this.cacheWeakStart + fromTicks(intervalIndex * 2n + 1n, 500000);
    for (;;) {
      if (weakTime >= this.cacheEnd) return this.cacheEnd;
      if (weakTime > fromWhen) {
        const test = hash32((hash32((hash32((hash32(this.revCount) ^ 0x4242) >>> 0) + this.cacheIndex) >>> 0) + Number(intervalIndex & 0xffffffffn)) >>> 0);
        if (test & 1) return weakTime;
      }
      weakTime += fromUsec(4);
      intervalIndex++;
    }
  }
  writeFlux(start, end, transitions) {
    if (!this.image || this.mon || this.wpt) return;
    this.imageDirty = true;
    this.cacheClear();
    const ws = { start: this.findPosition(start)[0], end: this.findPosition(end)[0], flux: [] };
    for (const t of transitions) ws.flux.push(this.findPosition(t)[0]);
    const wspans = [ws];
    this.wspanSplitOnWrap(wspans);
    const key = this.cyl * this.sides + this.ss;
    let buf = this.buffer();
    if (!buf.length) { buf.push(mg(MG_N, 0)); buf.push(mg(MG_E, 199999999)); }
    this.wspanRemoveDamaged(wspans, buf);
    this.wspanWrite(wspans, buf);
    this.written.add(key);
    this.cacheClear();
  }
  wspanSplitOnWrap(wspans) {
    const ne = wspans.length;
    for (let i = 0; i < ne; i++) {
      const ws = wspans[i];
      if (ws.end < ws.start) {
        const we = { start: 0, end: ws.end, flux: [] };
        wspans.push(we);
        ws.end = 200000000;
        let split;
        for (split = 0; split !== ws.flux.length; split++) if (ws.flux[split] < ws.start) break;
        if (split === 0) { const t = ws.flux; ws.flux = we.flux; we.flux = t; }
        else { we.flux = ws.flux.slice(split); ws.flux = ws.flux.slice(0, split); }
      }
    }
  }
  wspanRemoveDamaged(wspans, track) {
    // only a loaded image has damaged cells (a write never adds one): a track known to have none is not scanned
    if (UNDAMAGED.has(track)) return;
    let any = false;
    for (let pos = 0; pos !== track.length; pos++) {
      if (mgType(track[pos]) !== MG_D) continue;
      any = true;
      const start = mgTime(track[pos]), end = mgTime(track[pos + 1]);
      let ne = wspans.length;
      for (let i = 0; i !== ne; i++) {
        const w = wspans[i];
        if (w.start > end || w.end <= start) continue;
        if (w.start >= start && w.end - 1 <= end) { wspans.splice(i, 1); i--; ne--; continue; }
        if (w.start >= start && w.end - 1 > end) { w.start = end + 1; while (w.flux.length && w.flux[0] <= end) w.flux.shift(); continue; }
        if (w.start < start && w.end - 1 <= end) { w.end = start; while (w.flux.length && w.flux[w.flux.length - 1] >= start) w.flux.pop(); continue; }
        const n = { start: end + 1, end: w.end, flux: w.flux.slice() };
        wspans.push(n);
        w.end = start;
        while (w.flux.length && w.flux[w.flux.length - 1] >= start) w.flux.pop();
        while (n.flux.length && n.flux[0] <= end) n.flux.shift();
      }
    }
    if (!any) UNDAMAGED.add(track);
  }
  // (the track's cells are in time order: the span's ends are found by binary search, and the cells it covers are
  // replaced by its flux in one splice; the result is MAME's wspan_write)
  wspanWrite(wspans, track) {
    for (const ws of wspans) {
      let si = firstAtOrAfter(track, ws.start, 0), ei = firstAtOrAfter(track, ws.end, si);
      if (si !== track.length && mgType(track[si]) === MG_E) {
        if (si === ei) {
          track.splice(si, 0, mg(MG_E, ws.start - 1));
          track.splice(si + 1, 0, track[si - 1] - mgTime(track[si - 1]) + ws.end);
          si = ei = si + 1;
        } else { track[si] = mg(MG_E, ws.start - 1); si++; }
      }
      if (ei !== track.length && mgType(track[ei]) === MG_E) { track[ei - 1] = mg(MG_N, ws.end); ei--; }
      track.splice(si, ei - si, ...ws.flux.map((f) => mg(MG_F, f)));
    }
  }

  // ---------------- snapshots
  // A drive is rebuilt from the image as committed (media.bytes) plus the flux of every track written since
  // mount, which is exact for an image whose format round-trips. For one that does not (a single-density DMK -
  // see mount()), the committed image reloaded is not the flux the drive had, so the mounted bytes are kept as
  // well and a restore starts from them. Every other image carries its bytes once.
  saveState() {
    const s = {};
    for (const k of DRIVE_STATE) s[k] = this[k];
    for (const k of ATTO_STATE) s[k] = toText(this[k]);
    if (this.image) {
      s.media = { bytes: this.media.bytes.slice(), format: this.media.format, name: this.media.name || '', writeProtected: !!this.media.writeProtected };
      const kept = this.mountBytes;
      if (kept) s.mountBytes = kept.slice();
      // The geometry as mounted. It has to be saved rather than derived again on restore: an OS-9 image's geometry
      // comes from its own first sector, so a guest that writes LSN 0 (a format, a descriptor change) would make
      // the committed bytes look like a different disk - 40x2 would come back as 80x1, throwing away every side-1
      // track, and on a 42-track drive the restore would not load at all.
      s.geometry = Object.assign({}, this.geometry);
      s.written = [...this.written].map((k) => ({ k, flux: Uint32Array.from(this.image.track(k)) }));
    } else s.media = null;
    return s;
  }
  // media.onWrite is the host's: pass it again (it is not part of a snapshot)
  loadState(s, onWrite = null) {
    if (s.media) {
      // An image that does not round-trip starts from its mounted bytes, because the committed image cannot
      // rebuild the flux; everything else starts from the committed image, which is the same bytes until
      // something is written. Either way media.bytes is the COMMITTED image: flush() diffs against it to report
      // changed ranges to the host, so seeding it from the mounted bytes would lose the writes the snapshot
      // already contains and re-report them (or miss them) on the next flush.
      const from = s.mountBytes || s.media.bytes;
      const bytes = from.slice();
      const media = { bytes, format: s.media.format, name: s.media.name, writeProtected: s.media.writeProtected, onWrite };
      this.media = media;
      // decided when the snapshot was taken: a snapshot carries mountBytes exactly when they are needed
      this.keptBytes = s.mountBytes ? s.mountBytes.slice() : null;
      this.pendingBytes = null;
      if (!s.geometry) throw new Error('snapshot: drive is missing "geometry"');
      this.geometry = Object.assign({}, s.geometry);
      this.image = loadDisk(bytes, s.media.format, { tracks: this.tracks, heads: this.sides }, this.geometry);
      this.written = new Set();
      for (const w of s.written) { this.image.setTrack(w.k, Array.from(w.flux)); this.written.add(w.k); }
      if (s.mountBytes) media.bytes = s.media.bytes.slice();   // committed, not mounted
    } else { this.media = null; this.image = null; this.keptBytes = null; this.pendingBytes = null; this.written = new Set(); }
    for (const k of DRIVE_STATE) { if (!(k in s)) throw new Error(`snapshot: drive is missing "${k}"`); this[k] = s[k]; }
    for (const k of ATTO_STATE) this[k] = fromText(s[k]);
  }
}
