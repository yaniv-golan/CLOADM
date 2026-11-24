/*
 * WYRMFIRE on the page: a GPL game engine for the Dragon 64 that plays a Doom-format level (js/wyrmfire/pin.js names
 * the files; the Session runs it: Session.startWyrmfire).
 *
 * Entry points: the "Runs without ROMs" row (js/ui/welcome.js) and the Programs sheet it is part of, the palette's
 * "WYRMFIRE" (js/ui/command-box.js), ?start=wyrmfire (no question asked), and a .wad dropped anywhere or picked in Your
 * ROMs -> "Your game files" (the person's own WAD, converted here).
 *
 * The first seconds: the engine and the level are fetched BEFORE the switch, with the machine in use running on;
 * a strip under the screen says "WYRMFIRE · Getting the game… 42%" with Cancel, then "Starting…". What the service
 * worker already keeps is read from its cache (straight to "Starting…"). Offline and not kept, or a failed download:
 * the strip says so with Try again, and the machine is untouched. A tab in the background waits until it is shown
 * before it switches. From the page, with another machine or a program running, the machine menu's switch question
 * asks first ("Switching to Dragon 64 to play WYRMFIRE resets the …").
 *
 * The person's own WAD: checked first (js/wyrmfire/wad-check.js: a WAD, the main game file, has E1M1, not too big),
 * then converted off the main thread by WYRMFIRE's own converter (examples/wyrmfire/converter/worker.js, GPL-3.0-or-
 * later: the only GPL code the page runs, and only for this). The WAD never leaves the browser and is never stored:
 * only the converted level and the WAD's file name are kept, in "Your game files" (Session.saveGameFile).
 *
 * While it runs, the strip carries the credits (the version from the pin, the source, Freedoom, "Not affiliated with id
 * Software"), what is off ("no snapshots; with your own WAD, no clips and no Claude screen reads"), and the way to
 * play the person's own WAD.
 */
import { WYRMFIRE_PIN as PIN, wyrmfireSourceUrl, FREEDOOM_CREDIT } from '../wyrmfire/pin.js';
import { checkWad, convertErrorText, WAD_TEXT, WAD_MAX_MB, WadCheckError } from '../wyrmfire/wad-check.js';
import { profiles } from '../machines/profiles.js';
import { $, touchPanel } from './page.js';

// the words, in one place (tools/browser-check.js and tests/wyrmfire-ui.test.js read them from here)
export const WYRM_TEXT = Object.freeze({
  name: 'WYRMFIRE',
  subtitle: 'A 3D game for the Dragon 64 · Freedoom level',
  credit: 'GPL · Freedoom level (BSD)',
  getting: (pct) => `WYRMFIRE · Getting the game… ${pct}%`,
  starting: 'WYRMFIRE · Starting…',
  converting: (name) => `WYRMFIRE · Converting ${name}…`,
  offline: 'WYRMFIRE needs one download the first time, and you\'re offline.',
  failed: 'Couldn\'t download WYRMFIRE.',
  freedoom: 'Playing the Freedoom level. Have DOOM (the 1993 game)?',
  useWad: 'Use your DOOM1.WAD or DOOM.WAD…',
  own: (name) => `Playing E1M1 from your ${name}.`,
  backToFreedoom: 'Play the Freedoom level',
  privacy: 'Your WAD stays in this browser: it\'s converted here and never uploaded. WYRMFIRE is not affiliated with id Software.',
  trademark: 'DOOM is a trademark of id Software LLC.',
  guard: 'While WYRMFIRE runs: no snapshots. With your own WAD, no clips and no Claude screen reads.',
  share: 'Opens WYRMFIRE from the start, with the Freedoom level.',
  sideways: 'Turn sideways for a bigger view',
  keys: 'WYRMFIRE: Enter skips the music. Arrows move and turn, Z and X strafe, Space fires, E opens doors.',
  switchPurpose: ' to play WYRMFIRE',
  level: FREEDOOM_CREDIT,
});
// the credits line: WYRMFIRE <version> · Source ↗ · Level from Freedoom ↗ · Not affiliated with id Software
export const creditParts = () => [
  { text: `WYRMFIRE ${PIN.version}` },
  { text: 'Source ↗', href: wyrmfireSourceUrl() },
  { text: 'Level from Freedoom ↗', href: PIN.freedoom.site },
  { text: 'Not affiliated with id Software' },
];

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const abs = (p) => new URL(p, document.baseURI).href;
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
const link = (text, href) => { const a = el('a', text); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; };

export function setupWyrmfire(page, { confirmSwitch }) {
  const { session } = page;
  const strip = $('wyrmStrip'), line = $('wyrmLine'), bar = $('wyrmBar');
  let job = null;          // the start under way: { controller, cancelled }
  let failedWith = null;   // the start Try again repeats
  let note = null;         // a line the strip keeps under the credits (the storage message, a WAD's error)

  // ---------------- the strip ----------------
  const button = (text, run, primary = false) => { const b = el('button', text); b.type = 'button'; if (primary) b.className = 'primary'; b.onclick = run; return b; };
  function show(text, buttons = [], state = 'busy') {
    strip.hidden = false;
    strip.dataset.state = state;
    line.replaceChildren(el('span', text, 'wyrmmsg'));
    bar.replaceChildren(...buttons);
    $('wyrmMore').hidden = true;
  }
  function hide() { strip.hidden = true; strip.dataset.state = ''; }
  // while it plays: the credits, what is off, the person's own WAD
  function playing() {
    const st = session.wyrmfireState;
    if (!st) { if (!job && strip.dataset.state === 'playing') hide(); return; }
    if (job) return;
    strip.hidden = false;
    strip.dataset.state = 'playing';
    strip.dataset.level = st.level;
    const credits = el('span', null, 'wyrmcredits');
    creditParts().forEach((p, i) => { if (i) credits.append(' · '); credits.append(p.href ? link(p.text, p.href) : p.text); });
    line.replaceChildren(credits);
    bar.replaceChildren();
    const more = $('wyrmMore');
    more.hidden = false;
    const level = $('wyrmLevel');
    if (st.level === 'user') level.replaceChildren(el('span', WYRM_TEXT.own(st.name)), ' ', button(WYRM_TEXT.backToFreedoom, () => start({ again: true })));
    else level.replaceChildren(el('span', WYRM_TEXT.freedoom), ' ', button(WYRM_TEXT.useWad, pickWad));
    $('wyrmNote').textContent = note || '';
    $('wyrmNote').hidden = !note;
  }
  session.on((ev) => { if (['wyrmfire', 'machine', 'loaded', 'program'].includes(ev)) playing(); });

  // ---------------- getting the files ----------------
  // a file's bytes: from the service worker's cache when it has them (no network), else fetched with progress.
  // -> { bytes, cached }
  async function cached(path) {
    try { return typeof caches === 'undefined' ? null : await caches.match(abs(path)); } catch (e) { return null; }
  }
  async function read(res, signal, onBytes) {
    if (!res.body || !res.body.getReader) { const b = new Uint8Array(await res.arrayBuffer()); onBytes(b.length); return b; }
    const reader = res.body.getReader(), parts = [];
    let n = 0;
    for (;;) {
      if (signal.aborted) { reader.cancel().catch(() => {}); throw new DOMException('cancelled', 'AbortError'); }
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); n += value.length; onBytes(n);
    }
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }
  // the engine and the Freedoom level, each checked against the pin (SHA-256 and size): a mismatch is a failure
  async function getFiles(signal, { level = true } = {}) {
    const files = [PIN.files.engine, ...(level ? [PIN.files.level] : [])];
    const hits = await Promise.all(files.map((f) => cached(f.path)));
    const allCached = hits.every(Boolean);
    if (!allCached && typeof navigator !== 'undefined' && navigator.onLine === false) throw Object.assign(new Error('offline'), { offline: true });
    const total = files.reduce((a, f) => a + f.size, 0), got = files.map(() => 0);
    const progress = () => { if (!allCached) show(WYRM_TEXT.getting(Math.min(99, Math.floor(got.reduce((a, b) => a + b, 0) * 100 / total))), [button('Cancel', cancel)]); };
    if (allCached) show(WYRM_TEXT.starting, [button('Cancel', cancel)]); else progress();
    const out = [];
    for (let i = 0; i < files.length; i++) {
      let res = hits[i];
      if (!res) {
        try { res = await fetch(abs(files[i].path), { signal }); }
        catch (e) { if (e && e.name === 'AbortError') throw e; throw Object.assign(new Error(e.message), { offline: typeof navigator !== 'undefined' && navigator.onLine === false }); }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      const bytes = await read(res, signal, (n) => { got[i] = n; progress(); });
      const sha = hex(await crypto.subtle.digest('SHA-256', bytes));
      if (sha !== files[i].sha256 || bytes.length !== files[i].size) throw new Error(`${files[i].path} is not the pinned file`);
      out.push(bytes);
    }
    return { engine: out[0], level: out[1] || null };
  }
  function cancel() {
    if (!job) return;
    job.cancelled = true;
    job.controller.abort();
    if (job.stop) job.stop();   // a conversion: its worker goes
  }
  // a tab in the background switches only once it is shown again
  const visible = () => new Promise((resolve) => {
    if (!document.hidden) { resolve(); return; }
    const on = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', on); resolve(); } };
    document.addEventListener('visibilitychange', on);
  });

  // ---------------- starting ----------------
  // Does starting it from the page reset something the person has? Another machine, or a program running (anything but
  // the welcome menu, the stub's bare prompt or WYRMFIRE itself).
  function needsAsking() {
    const m = session.personMachine;
    if (m.id !== PIN.machine.id) return true;
    if (session.wyrmfireRunning || session.welcomeRunning) return false;
    return !(m.atStubPrompt && m.atStubPrompt());
  }
  // fromLink: ?start=wyrmfire (nothing asked). again: Try again or Back to Freedoom (asked already, or nothing to ask).
  // own: { disk, name } for the person's converted level (its files are only the engine then).
  async function start({ fromLink = false, again = false, own = null } = {}) {
    if (job) return;
    if (!fromLink && !again && needsAsking()) {
      confirmSwitch({ name: profiles[PIN.machine.id].name, purpose: WYRM_TEXT.switchPurpose, id: PIN.machine.id, config: Object.assign({}, PIN.machine.config, { cpu: '6809' }) },
        () => run({ own }));
      return;
    }
    await run({ own });
  }
  async function run({ own = null } = {}) {
    job = { controller: new AbortController(), cancelled: false };
    const mine = job;
    failedWith = { own };
    note = own ? note : null;
    try {
      const files = await getFiles(mine.controller.signal, { level: !own });
      if (mine.cancelled) throw new DOMException('cancelled', 'AbortError');
      show(WYRM_TEXT.starting, [button('Cancel', cancel)]);
      await visible();
      if (mine.cancelled) throw new DOMException('cancelled', 'AbortError');
      // the switch begins: no Cancel from here
      show(WYRM_TEXT.starting, []);
      job = null;
      page.attempt(() => { session.startWyrmfire(files.engine, own ? own.disk : files.level, own ? { level: 'user', name: own.name } : {}); return WYRM_TEXT.keys; });
      page.focus();
      sideways();
    } catch (e) {
      job = null;
      if (e && e.name === 'AbortError') { hide(); playing(); page.focus(); return; }
      const offline = !!(e && e.offline);
      show(offline ? WYRM_TEXT.offline : WYRM_TEXT.failed, [button('Try again', () => run(failedWith), true), button('Close', () => { hide(); playing(); })], 'error');
      if (!offline) console.warn(`WYRMFIRE: ${e && e.message}`);
      return;
    }
    playing();
  }
  // "Turn sideways for a bigger view": once, on a phone held upright
  function sideways() {
    if (!touchPanel() || !matchMedia('(orientation: portrait)').matches) return;
    try { if (localStorage.getItem('wyrmfire.sideways')) return; localStorage.setItem('wyrmfire.sideways', '1'); } catch (e) { /* storage off: said every time */ }
    page.toast(WYRM_TEXT.sideways);
  }

  // ---------------- the person's own WAD ----------------
  // what goes wrong is said in the strip and in a toast
  function wadError(text) {
    show(text, [button(WYRM_TEXT.useWad, pickWad), button('Close', () => { hide(); playing(); })], 'error');
    page.status(text, true);
  }
  // a File (a drop, the picker): checked, converted, kept, played
  // One at a time: a second drop while one converts (or WYRMFIRE downloads) is not started; Cancel stops the worker.
  async function takeWad(file) {
    if (job) return;
    const name = String(file.name || 'your WAD').split(/[\\/]/).pop();
    if (file.size > WAD_MAX_MB * 1024 * 1024) { wadError(WAD_TEXT.tooBig()); return; }
    const mine = job = { controller: new AbortController(), cancelled: false, stop: null };
    show(WYRM_TEXT.converting(name), [button('Cancel', cancel)]);
    let bytes, disk;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
      if (mine.cancelled) throw new DOMException('cancelled', 'AbortError');
      checkWad(bytes);
      disk = await convert(bytes, mine);
    } catch (e) {
      job = null;
      if (e && e.name === 'AbortError') { hide(); playing(); page.focus(); return; }
      wadError(e instanceof WadCheckError || e.fromConverter ? e.message : WAD_TEXT.failed(e.message));
      return;
    }
    job = null;
    bytes = null;   // the WAD itself is let go: only the level is kept
    const kept = await session.saveGameFile(disk, name);
    note = kept.kept ? null : WAD_TEXT.storage;
    if (!kept.kept) page.toast(WAD_TEXT.storage);
    await start({ own: { disk, name } });
  }
  // WYRMFIRE's converter in a worker (GPL: examples/wyrmfire/converter/) -> the level disk; Error with the page's words
  // (mine: the job, whose stop() terminates the worker: Cancel)
  function convert(bytes, mine) {
    return new Promise((resolve, reject) => {
      const said = (text) => Object.assign(new Error(text), { fromConverter: true });
      let w;
      try { w = new Worker(abs(PIN.files.worker.path), { type: 'module' }); } catch (e) { reject(said(WAD_TEXT.failed(e.message))); return; }
      mine.stop = () => { w.terminate(); reject(new DOMException('cancelled', 'AbortError')); };
      w.onmessage = ({ data }) => {
        w.terminate();
        if (data && data.ok) resolve(new Uint8Array(data.disk));
        else reject(said(convertErrorText(data && data.kind, data && data.error)));
      };
      w.onerror = (e) => { w.terminate(); reject(said(WAD_TEXT.failed(e.message || 'the converter stopped'))); };
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      w.postMessage({ id: 1, wad: buf, map: PIN.freedoom.map }, [buf]);
    });
  }
  const picker = $('fileWad');
  function pickWad() { picker.click(); }
  picker.onchange = async () => { const f = picker.files[0]; picker.value = ''; if (f) await takeWad(f); };
  $('btnGameWad').onclick = pickWad;

  // ---------------- Your ROMs -> "Your game files" ----------------
  async function gameFiles() {
    const list = $('gameFileList');
    const files = await session.gameFiles();
    if (!files.length) { list.replaceChildren(el('span', 'None yet.', 'muted')); return; }
    list.replaceChildren(...files.map((f) => {
      const row = el('div', null, 'row gamefile');
      row.append(el('span', `WYRMFIRE level · from ${f.source} · ${Math.round(f.size / 1024)} KB`));
      const b = el('span', null, 'bar');
      b.append(button('Play', async () => {
        const got = await session.readGameFile();
        if (got) await start({ own: { disk: got.disk, name: got.source } });
      }, true), button('Remove', async () => {
        try { await session.removeGameFile(); page.status(`Removed the WYRMFIRE level from ${f.source}`); } catch (e) { page.status(e.message, true); }
      }));
      row.append(b);
      return row;
    }));
  }
  session.on((ev) => { if (ev === 'gamefiles' || ev === 'library') gameFiles(); });
  gameFiles();

  // the privacy words at every place a WAD can be dropped or picked
  for (const id of ['wyrmPrivacy', 'gamePrivacy', 'dropWadPrivacy']) { const n = $(id); if (n) n.textContent = `${WYRM_TEXT.privacy} ${WYRM_TEXT.trademark}`; }
  $('wyrmGuard').textContent = WYRM_TEXT.guard;
  page.takeWad = takeWad;
  return { start, takeWad, cancel, get busy() { return !!job; } };
}
