/*
 * The Library: everything the user has loaded,
 * kept in the media store (MediaLibrary.listMedia / openMedia / downloadMedia / renameMedia / deleteMedia /
 * importMedia: under library/, and disk images under disks/, where the drives find them), shown as tape spines and disk and cartridge tiles, filtered by machine and
 * kind; its empty state; the type-in card (js/ui/typein.js); and the magazine rack.
 *
 * It is a view of /play/ (#library), not a page of its own: it loads into the running machine, and the
 * type-in card shows that machine's screen. Click an item to load it (a disk image: mount it in a drive) and go
 * back to the emulator. Select mode turns clicks into a selection with
 * Load and Rename (one item), Download and Delete; Rename is inline on the item, and Delete asks nothing: the items
 * leave the shelf at once and are removed when the 8 s Undo toast ends (or the Library is left). Files loaded with
 * Insert…, the slots or a drop are kept here as well ("Everything you load is kept").
 *
 * A spine or a tile can also be dragged onto the machine's screen (the type-in card's view of the running
 * machine, the emulator's screen while the Library is open) to load it, as a click does (not in select mode).
 *
 * Where it is kept ("Stored in browser storage (OPFS), or linked to a folder on your computer"): inside this
 * browser, a folder the user picks (File System Access: disk writes go straight back to the image file), or
 * download and open where the browser keeps nothing. Choosing another copies the library there
 * (MediaLibrary.moveMedia; the old place keeps its copies) and is remembered: the choice in settings, the folder's
 * handle in IndexedDB (js/host/folder-handle.js). A folder whose permission didn't survive the reload is
 * offered for reconnecting (`reconnect`, from openChosenStore); until then the library is kept in the browser.
 */
import { detectMedia, FAMILY_NAMES } from '../media/detect.js';
import { expand, pickedFiles, droppedFiles } from './files.js';
import { DISK_PREFIX } from '../library.js';
import { $, showView } from './page.js';
import { availableChoices, openMediaStore } from '../host/media-store-open.js';
import { FsaMediaStore } from '../host/media-store-fsa.js';
import { saveFolder, forgetFolder } from '../host/folder-handle.js';

// (ROMs: not items of the Library: one card about Your ROMs, and under the ROMs chip a tile per stored image)
const KINDS = [['all', 'All'], ['tape', 'Tapes'], ['disk', 'Disks'], ['cart', 'Cartridges'], ['program', 'Programs'], ['snapshot', 'Snapshots'], ['roms', 'ROMs']];
const KIND_OF = { cas: 'tape', wav: 'tape', disk: 'disk', cart: 'cart', binary: 'program', basictext: 'program' };
// spine and label colours: the VDG colours the design allows for the Library
const SPINES = ['#EDE6C8', '#F2EA4A', '#2BD8D8', '#F08A1F', '#30D82B', '#EDE6C8', '#D8D8D8', '#F2EA4A'];

// The magazine rack. Only Dragon User's dates are
// confirmed (May 1983 to January 1989, 69 issues, against its archive), so no other dates are shown.
// Covers are drawn here, never fetched or re-hosted from the archives.
const MAGS = {
  us: [
    { n: 'The Rainbow', c: '#D8202A', fg: '#FFFFFF', d: 'The CoCo magazine: thick monthly issues of BASIC and assembly listings, tutorials and reviews.', u: 'https://colorcomputerarchive.com/repo/Documents/Magazines/Rainbow,%20The%20(OCR)/', l: 'Searchable issues at the Color Computer Archive' },
    { n: 'Hot CoCo', c: '#F08A1F', fg: '#1A1A1A', d: 'Wayne Green\'s CoCo spin-off from 80 Micro: games, utilities and beginner programming.', u: 'https://colorcomputerarchive.com/repo/Documents/Magazines/Hot%20Coco/', l: 'Issues at the Color Computer Archive' },
    { n: 'Color Computer Magazine', c: '#2A35E8', fg: '#FFFFFF', d: 'Started by New England Publications, later part of Ziff-Davis.', u: 'https://colorcomputerarchive.com/repo/Documents/Magazines/Color%20Computer%20Magazine/', l: 'Issues at the Color Computer Archive' },
  ],
  uk: [
    { n: 'Dragon User', y: 'MAY 1983 – JAN 1989 · 69 ISSUES', c: '#C42B23', fg: '#FFFFFF', d: 'The Dragon magazine: listings, graphics, machine code, hardware projects.', u: 'https://www.os9projects.com/DragonTop/DragonMag/DragonUser/DragonUser.html', l: 'All 69 issues, archived' },
    { n: 'INPUT', c: '#F2EA4A', fg: '#1A1A1A', d: 'A programming course in parts, with Dragon 32 versions of its programs.', u: 'https://www.retromags.com/gallery/category/1043-input/', l: 'Browse the covers' },
    { n: 'Your Computer', c: '#2A35E8', fg: '#FFFFFF', d: 'General home computing, with BASIC listings for many machines including the Dragon.' },
    { n: 'Popular Computing Weekly', c: '#EDE6C8', fg: '#1A1A1A', d: 'News, reviews and type-in games, Dragon among them.', u: 'https://www.computinghistory.org.uk/cgi/archive.pl?platform=Dragon+32&type=Listing', l: 'Dragon 32 type-ins at the CCH' },
    { n: 'Personal Computer World', c: '#2BD8D8', fg: '#0B0D0C', d: 'The technical one: longer listings, algorithms, hardware.' },
    { n: 'Personal Computing Today', c: '#F08A1F', fg: '#1A1A1A', d: 'Readers\' listings, games and utilities for many home computers.' },
  ],
};

// the storage choices, as the Library describes them (ids from availableChoices)
const STORAGE = {
  opfs: { label: 'Inside this browser', about: 'Private to this site and kept when you reload. Nothing to set up.',
    missing: 'This browser has no private storage for CLOADM.' },
  fsa: { label: 'A folder on this computer', about: 'Ordinary files in a folder you choose; disk writes go straight back to the image file.',
    missing: 'This browser can\'t open a folder for CLOADM (Chrome and Edge can).' },
  fallback: { label: 'Download and open files', about: 'The browser keeps nothing: download what you want to keep, and drop it back in next time.' },
};
// what the Library's spines and tiles carry when dragged (their media name)
const DRAG_TYPE = 'application/x-cloadm-library';

const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
const base = (name) => name.split('/').pop();
const prefixOf = (name) => name.slice(0, name.length - base(name).length);
// "A", "A and B", "3 items"
const names = (list) => (list.length === 1 ? base(list[0]) : list.length === 2 ? `${base(list[0])} and ${base(list[1])}` : `${list.length} items`);
const label = (name) => base(name).replace(/\.[^.]*$/, '').toUpperCase();

// changed(): the library's contents changed here (the quick-save slots are in it too); showRoms(): opens Your ROMs
export function setupLibrary(page, { loadProgram, runShelf, changed, showRoms, reconnect = null, diskSaid }) {
  const { session } = page;
  const view = $('library');
  const meta = new Map();          // name -> { mtime, size, kind, family, format } (read once per version)
  let items = [], kind = 'all', family = '', keeping = false;
  // select mode: the selected names, the one being renamed, and a delete waiting for its Undo toast to end
  let selecting = false, renaming = null, pending = null;
  let announced = 0;   // the count #libCountLive last said: it is written only when the count changes
  const selected = new Set();
  let loading = null;              // the item being opened ("Loading…" on its tile)

  // ---------------- open and close (#library) ----------------
  const isOpen = () => location.hash === '#library';
  function show() {
    const open = isOpen();
    document.body.classList.toggle('library-open', open);
    showView(view, open);
    if (open) { refresh(); $('libHeading').focus(); }
  }
  page.onView(show);
  // Navigating to the fragment "#library" (an address typed or assigned, or Back/Forward to it; not page.openView, which
  // pushes history state) makes the browser run its own focusing steps on the fragment's target, after the popstate that
  // opened the view (show() above, with the heading focused). The Library's element has the id "library", which is not
  // focusable, so the browser puts the focus on the viewport (activeElement becomes the body). hashchange comes after those
  // steps: the heading takes the focus back there, unless the focus is already inside the view (the page has moved it on).
  // (No isOpen() test: a closed view is hidden and inert by then, and an element that cannot be focused ignores focus().)
  addEventListener('hashchange', () => { if (!view.contains(document.activeElement)) $('libHeading').focus(); });
  const close = () => {
    setSelecting(false);                  // (leaving ends the Undo toast, and so the delete: js/ui/feedback.js on the view change)
    page.closeView();
  };
  $('btnLibBack').onclick = (e) => { e.preventDefault(); close(); };
  // the header's Library link and the Media tab's "Open your library →" (their href is for a new tab)
  for (const id of ['navLibrary', 'linkLibrary']) $(id).onclick = (e) => { e.preventDefault(); page.openView('#library'); };

  // ---------------- the shelves ----------------
  async function describe(st) {
    const known = meta.get(st.name);
    if (known && known.mtime === st.mtime && known.size === st.size) return known;
    let d = { kind: 'other', family: null, format: '' };
    if (/\.cloadm$/i.test(st.name)) d = { kind: 'snapshot', family: null, format: 'snapshot' };
    else {
      try { const m = detectMedia(base(st.name), await session.library.openMedia(st.name)); d = { kind: KIND_OF[m.kind] || 'other', family: m.family || null, format: m.format || '' }; }
      catch (e) { d = { kind: 'other', family: null, format: 'unreadable' }; }
    }
    const out = Object.assign({ mtime: st.mtime, size: st.size }, d);
    meta.set(st.name, out);
    return out;
  }
  // Two can run at once (another tab's changes arrive as they are made: Session.mediaElsewhere), so each builds its own
  // list and only the latest one started is shown: filling the shared list from both doubled every item.
  let listing = 0;
  async function refresh() {
    const mine = ++listing;
    let list;
    try { list = await session.library.listMedia(); } catch (e) { page.status(session.library.mediaError(e, 'the library').message, true); list = []; }
    const got = [];
    for (const st of list) got.push(Object.assign({ name: st.name }, await describe(st)));
    if (mine !== listing) return;   // a later listing has started: it is the one to show
    changed();
    items = got;
    for (const n of [...selected]) if (!items.some((i) => i.name === n)) selected.delete(n);
    render();
  }
  const shownItems = () => items.filter((i) => (kind === 'all' || i.kind === kind) && (!family || i.family === family) && !(pending && pending.names.includes(i.name)));
  function render() {
    // the shelves are rebuilt: the item that had focus gets it back, so keys stay with the Library
    const had = document.activeElement && view.contains(document.activeElement) ? document.activeElement.dataset.name : null;
    const shown = shownItems();
    // (the filters show even in an empty Library: the ROMs chip is always there, and an empty Library shows the ROMs
    // card under its empty state)
    const roms = kind === 'roms';
    $('libEmpty').hidden = items.length > 0 || roms;
    $('libFilled').hidden = !items.length || roms;
    $('libNone').hidden = !items.length || shown.length > 0 || roms;
    $('libRomsBox').hidden = !roms && items.length > 0;
    romsCard(roms);
    $('btnLibSelect').hidden = !items.length || roms;   // (nothing to select: an empty Library, or the ROM tiles)
    const tapes = shown.filter((i) => i.kind === 'tape'), rest = shown.filter((i) => i.kind !== 'tape');
    $('libTapesBox').hidden = !tapes.length;
    $('libTilesBox').hidden = !rest.length;
    $('libTapes').replaceChildren(...tapes.map((t, i) => {
      const b = el('button', label(t.name), 'spine');
      b.style.background = SPINES[i % SPINES.length];
      return item(t, b);
    }));
    $('libTiles').replaceChildren(...rest.map((t) => {
      const b = el('button', null, 'tile');
      b.append(el('span', label(t.name), 'tag'), el('span', loading === t.name ? 'Loading…' : [t.format || t.kind, t.family && FAMILY_NAMES[t.family]].filter(Boolean).join(' · '), 'what'));
      return item(t, b);
    }));
    for (const b of view.querySelectorAll('[data-kind-filter]')) b.setAttribute('aria-pressed', String(b.dataset.kindFilter === kind));
    // select mode: the selection bar instead of the filters
    const n = selected.size;
    view.classList.toggle('selecting', selecting);
    $('libSelBar').hidden = !selecting;
    $('libTapHint').hidden = !selecting;
    $('libCount').textContent = n ? `${n} selected` : 'Select items';
    if (n !== announced) { announced = n; $('libCountLive').textContent = n ? `${n} selected` : ''; }
    $('libSelHint').hidden = n > 0;
    $('libSelActions').hidden = n === 0;
    $('btnLibLoad').hidden = n !== 1;
    $('btnLibRename').disabled = n !== 1;
    $('libOneNote').hidden = !selecting || n < 2;
    $('libFooter').textContent = selecting ? 'In select mode a click selects instead of loading. Done, or Esc, goes back to loading on click.'
      : 'Click a spine or a tile, or drag it onto the machine\'s screen, to load it. Drop files or a folder here to add them.';
    const field = view.querySelector('.rename input');
    if (field) { field.focus(); field.setSelectionRange(0, field.value.replace(/\.[^.]*$/, '').length); }
    else if (had) { const b = [...view.querySelectorAll('[data-name]')].find((x) => x.dataset.name === had); if (b) b.focus(); }
  }
  // the ROMs card: how many ROMs are stored and what uses them, or that there are none; the link opens Your ROMs.
  // Under the ROMs chip (never under All), a tile per stored image: its file name, size, the machines and cartridges
  // that use it, and Remove.
  function romsCard(tiles) {
    const r = session.storedRoms(), and = (l) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);
    $('libRomsText').textContent = r.count ? `Your ROMs: ${r.count} stored, used by ${and(r.users)}. Manage them in` : 'No ROMs yet. CLOADM never includes ROMs; add your own in';
    $('libRomsLink').textContent = 'Your ROMs →';
    const had = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.remove : null;
    $('libRomTiles').replaceChildren(...(tiles ? session.romFiles().map(romTile) : []));
    if (had) { const b = view.querySelector(`[data-remove="${had}"]`); if (b) b.focus(); }
  }
  const sizeOf = (n) => (n % 1024 ? `${n} bytes` : `${n / 1024} KB`);
  function romTile(f) {
    const t = el('li', null, 'romtile');
    t.dataset.crc = f.crc;
    const b = el('button', 'Remove', 'libbtn danger');
    b.dataset.remove = f.crc;
    b.setAttribute('aria-label', `Remove ${f.name}`);
    b.onclick = () => removeRom(f);
    t.append(el('strong', f.name, 'name'), el('span', sizeOf(f.size), 'size'), el('span', `Used by ${f.users.join(', ')}`, 'users'), b);
    return t;
  }
  // Remove: at once (the store is written now, so a reload cannot bring it back); the toast's Undo puts the bytes,
  // kept in memory until then, back in every socket they were in. A machine running the ROM keeps it until it is
  // switched off and on, and the toast's second line offers that.
  function removeRom(f) {
    const list = session.romFiles(), at = list.findIndex((x) => x.crc === f.crc);
    let r;
    try { r = session.removeRom(f.crc); } catch (e) { page.status(e.message, true); return; }
    // the focus goes to the next tile's Remove (the previous one's after the last), or the ROMs chip when none is left
    const next = list[at + 1] || list[at - 1];
    const to = next && view.querySelector(`[data-remove="${next.crc}"]`);
    (to || view.querySelector('[data-kind-filter="roms"]')).focus();
    page.toast(`Removed ${r.name || f.name}.`, {
      action: { label: 'Undo', run: () => {
        let back;
        try { back = session.restoreRom(r); } catch (e) { page.status(e.message, true); return; }
        // a socket given another ROM since keeps it: said, rather than silently not restored
        const kept = back.skipped.map((x) => x.name), and = (l) => (l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`);
        if (kept.length) page.status(back.restored.length ? `Restored ${r.name || f.name} (${and(kept)} already had another ROM)`
          : `${r.name || f.name} was not restored: ${and(kept)} already had another ROM`);
        const b = view.querySelector(`[data-remove="${r.crc}"]`); if (b) b.focus();
      } },
      also: r.running ? { text: `The ${r.running} keeps it until you switch off and on.`,
        action: { label: 'Switch off and on', run: () => session.powerCycle({ reason: 'you power cycled the machine' }) } } : null,
    });
  }
  $('libRomsLink').onclick = (e) => { e.preventDefault(); showRoms(); };
  session.on((ev) => { if (ev === 'roms' && isOpen()) render(); });
  // another tab added, renamed or removed Library items: list them again (an item this tab is deleting stays hidden)
  session.on((ev) => { if (ev === 'library' && isOpen()) refresh(); });
  // an item on the shelf: its button (a click loads it, or in select mode selects it), the tick box, and the name
  // field while it is being renamed
  function item(t, b) {
    b.dataset.name = t.name;
    b.title = `${base(t.name)} · ${(t.size / 1024).toFixed(t.size < 10240 ? 1 : 0)} KB${selecting ? '' : ' · click to load'}`;
    const on = selected.has(t.name);
    if (selecting) b.setAttribute('aria-pressed', String(on));
    b.append(el('span', on ? '✓' : '', 'tick'));
    b.lastChild.setAttribute('aria-hidden', 'true');
    b.onclick = () => (selecting ? toggle(t.name) : load(t.name));
    // dragged onto the machine's screen it loads, as a click does (not while selecting)
    b.draggable = !selecting;
    b.ondragstart = (e) => {
      e.dataTransfer.setData(DRAG_TYPE, t.name);
      e.dataTransfer.setData('text/plain', base(t.name));
      e.dataTransfer.effectAllowed = 'copy';
      $('typeinDropHint').textContent = `Drop to load ${base(t.name)} into the ${session.personMachine.profile.name.replace(/^Tandy /, '')}`;
      view.classList.add('dragging');
    };
    b.ondragend = () => { view.classList.remove('dragging'); $('typeinDrop').classList.remove('over'); };
    const box = el('div', null, 'item');
    box.append(b);
    if (renaming === t.name) box.append(renameField(t.name));
    return box;
  }
  function toggle(name) {
    if (selected.has(name)) selected.delete(name); else selected.add(name);
    renaming = null;
    render();
  }
  function setSelecting(on) {
    selecting = on; renaming = null; selected.clear();
    render();
  }
  // a disk image goes into the first empty drive (the last one if all are full), as the drives card puts a dropped
  // disk, and is read and written in the store in place; anything else loads as a file. "Loading…" shows on the
  // tile; then the emulator says what was loaded (a failure stays here, as a toast on the Library)
  async function load(name) {
    loading = name; render();
    try {
      if (name.startsWith(DISK_PREFIX)) {
        const st = session.drives.status();
        let drive = 0;
        while (drive < st.count - 1 && st.drives.some((d) => d.drive === drive)) drive++;
        let msg;
        try { msg = await session.drives.mount(drive, name); } catch (e) { page.status(e.message, true); return; }
        close();
        diskSaid(msg);
        return;
      }
      let bytes;
      try { bytes = await session.library.openMedia(name); } catch (e) { page.status(e.message, true); return; }
      close();
      keeping = true;
      try { await loadProgram(base(name), bytes); } finally { keeping = false; }
      const now = page.feedback.current;
      if (!now || !now.error) page.status(`Loaded ${label(name)} from your Library`);
    } finally { loading = null; render(); }
  }

  // filters
  const kinds = $('libKinds');
  for (const [id, text] of KINDS) {
    const b = el('button', text, 'chip-btn'); b.dataset.kindFilter = id;
    b.onclick = () => { kind = id; render(); };
    kinds.append(b);
  }
  const fam = $('libMachine');
  for (const [id, name] of [['', 'All machines'], ...Object.entries(FAMILY_NAMES)]) { const o = el('option', name); o.value = id; fam.append(o); }
  fam.onchange = () => { family = fam.value; render(); };

  // ---------------- select mode ----------------
  $('btnLibSelect').onclick = () => setSelecting(true);
  $('btnLibDone').onclick = () => setSelecting(false);
  $('btnLibSelectAll').onclick = () => { for (const i of shownItems()) selected.add(i.name); renaming = null; render(); };
  // Esc leaves select mode (in the name field it only cancels the rename); taken before the machine's keyboard sees it
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen() && selecting && !renaming && !(e.target.closest && e.target.closest('.rename'))) { e.preventDefault(); e.stopPropagation(); setSelecting(false); }
  }, { capture: true });
  const one = () => [...selected][0];
  $('btnLibLoad').onclick = () => { const n = one(); setSelecting(false); load(n); };
  $('btnLibDownload').onclick = async () => {
    const list = [...selected];
    try { for (const n of list) { const f = await session.library.downloadMedia(n); page.download(f.name, f.bytes); } page.status(`Saved ${names(list)}`); }
    catch (e) { page.status(e.message, true); }
  };
  // Rename: a name field on the item itself; Enter saves, Esc cancels. A disk in a drive is refused at once.
  $('btnLibRename').onclick = () => {
    const n = one();
    try { session.drives.checkNotInDrive(n, 'rename'); } catch (e) { page.status(e.message, true); return; }
    renaming = n;
    render();
  };
  function renameField(name) {
    const box = el('div', null, 'rename');
    const lab = el('label', 'Name'), input = el('input');
    input.value = base(name);
    input.spellcheck = false;
    lab.append(input);
    box.append(lab, el('span', 'Enter saves · Esc cancels'));
    let done = false;
    const finish = () => { done = true; renaming = null; };
    input.onkeydown = async (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(); render(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      finish();
      const clean = input.value.trim().replace(/[\\/]/g, '-');   // a name, not a path: the status says what it was saved as
      if (!clean || clean === base(name)) { render(); return; }
      try {
        await session.library.renameMedia(name, clean);
        selected.delete(name); selected.add(prefixOf(name) + clean);
        page.status(`Renamed to ${clean}`);
      } catch (err) { page.status(err.code === 'exists' ? `There is already a ${clean} in the library.` : err.message, true); }
      refresh();
    };
    input.onblur = () => { if (!done && renaming === name) { finish(); render(); } };
    return box;
  }
  // Delete: no question; the items leave the shelf now, with the page's toast (js/ui/feedback.js): 8 s with Undo.
  // They are removed when it ends: its time is up, the user's next action, another toast, leaving the Library or
  // closing the page
  $('btnLibDelete').onclick = () => {
    const list = [...selected];
    try { for (const n of list) session.drives.checkNotInDrive(n, 'delete'); } catch (e) { page.status(e.message, true); return; }
    const mine = { names: list };
    pending = mine;
    setSelecting(false);
    page.toast(`Deleted ${names(list)}`, {
      action: { label: 'Undo', run: () => { if (pending === mine) { pending = null; render(); } } },
      onEnd: async (why) => {
        if (why === 'action') return;
        if (pending === mine) pending = null;
        for (const n of list) { try { await session.library.deleteMedia(n); } catch (e) { page.toast(e.message, { error: true, view: 'library' }); } }
        refresh();
      },
    });
  };

  // ---------------- adding ----------------
  // a file the user gave CLOADM is kept in the library (ROMs go to their sockets, not here)
  async function keep(name, bytes) {
    if (keeping) return;
    try { await session.library.importMedia(base(name), bytes); }
    catch (e) { page.status(`${base(name)} wasn't kept in your Library: ${e.message}`, true); }
    if (isOpen()) refresh();
  }
  async function add(list) {
    const { files, errors } = await expand(list);
    let kept = 0, roms = 0;
    const say = page.reporter(), added = [];
    for (const f of files) {
      try { const r = await session.library.importMedia(base(f.name), f.bytes); if (r.roms) roms++; else { kept++; added.push(base(f.name)); } }
      catch (e) { errors.push(e.message); }
    }
    await refresh();
    // "5 files added to your Library", with Load for a single file (and Show when the user has left the Library)
    const text = [kept && `${kept} ${kept === 1 ? 'file' : 'files'} added to your Library`, roms && `${roms === 1 ? '1 ROM' : `${roms} ROMs`} added to Your ROMs`].filter(Boolean).join(' · ');
    if (errors.length) { say(text ? `${text}. ${errors.join(' · ')}` : errors.join(' · '), true, text ? { details: errors.join(' · ') } : {}); return; }
    if (!text) { say('Nothing added: no files in what you gave'); return; }
    const one = kept === 1 && items.find((i) => base(i.name) === added[0]);
    // ROMs only: "Open Your ROMs" (R19 A+)
    say(text, false, { action: roms && !kept ? { label: 'Open Your ROMs', run: showRoms } : !isOpen() ? { label: 'Show', run: () => page.openView('#library') } : one ? { label: 'Load', run: () => load(one.name) } : null });
  }
  const pick = () => $('fileLib').click();
  $('btnLibAdd').onclick = pick;
  $('btnLibAddEmpty').onclick = pick;
  $('btnLibFolder').onclick = () => $('folderLib').click();
  $('fileLib').onchange = async (e) => { const l = pickedFiles(e.target); e.target.value = ''; await add(l); };
  $('folderLib').onchange = async (e) => { const l = pickedFiles(e.target); e.target.value = ''; await add(l); };
  const fromShelf = (e) => e.dataTransfer && [...e.dataTransfer.types].includes(DRAG_TYPE);
  view.addEventListener('dragover', (e) => { e.preventDefault(); if (!fromShelf(e)) view.classList.add('drop'); });
  view.addEventListener('dragleave', () => view.classList.remove('drop'));
  view.addEventListener('drop', async (e) => {
    e.preventDefault(); view.classList.remove('drop');
    if (!fromShelf(e)) await add(await droppedFiles(e.dataTransfer));   // a spine let go anywhere else: nothing
  });
  // a spine or a tile dropped on the machine's screen: load it
  const screenDrop = $('typeinDrop');
  screenDrop.addEventListener('dragover', (e) => { if (!fromShelf(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; screenDrop.classList.add('over'); });
  screenDrop.addEventListener('dragleave', () => screenDrop.classList.remove('over'));
  screenDrop.addEventListener('drop', (e) => {
    if (!fromShelf(e)) return;
    e.preventDefault(); e.stopPropagation();
    screenDrop.classList.remove('over'); view.classList.remove('dragging');
    load(e.dataTransfer.getData(DRAG_TYPE));
  });
  // the programs that run without ROMs (the empty state's buttons)
  $('btnLibLiza').onclick = () => { close(); runShelf('LIZA'); };
  $('btnLibDemo').onclick = () => { close(); runShelf('Colour demo'); };

  // ---------------- where it is kept ----------------
  let moving = false;
  function renderStorage() {
    const kind = session.media && session.media.kind, folder = kind === 'fsa' && session.media.name;
    $('libWhere').textContent = kind === 'opfs' ? 'Stored in this browser (OPFS): private to this site, and kept when you reload.'
      : kind === 'fsa' ? `Linked to the folder “${folder}” on your computer: writes go straight back to the files.`
        : kind === 'fallback' ? 'Nothing is kept by the browser: the library lasts for this visit, so download what you want to keep.'
          : 'Kept in memory for this visit only: the browser\'s storage could not be opened.';
    $('libReconnect').hidden = !reconnect;
    if (reconnect) $('libReconnectText').textContent = `Your library is in the folder “${reconnect.name}”, and the browser wants your permission again before CLOADM uses it. Until then, what you load is kept inside this browser.`;
    $('libStorageChoices').replaceChildren(...availableChoices().map((c) => {
      const t = STORAGE[c.id], b = el('button', null, 'choice');
      b.dataset.storage = c.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(c.id === kind));
      b.disabled = !c.available || moving;
      b.append(el('strong', c.id === 'fsa' && kind === 'fsa' ? `${t.label}: ${folder}` : t.label),
        el('span', c.available ? (c.id === 'fsa' && kind === 'fsa' ? 'Choose another folder to move it there.' : t.about) : t.missing));
      b.onclick = () => choose(c.id);
      return b;
    }));
  }
  const whereNow = () => (session.media.kind === 'fsa' ? `in the folder “${session.media.name}”` : session.media.kind === 'opfs' ? 'inside this browser' : 'for this visit only (download what you want to keep)');
  // move the library to the chosen place (a folder: pick it first) and remember the choice
  async function choose(id) {
    if (moving || (id === session.media.kind && id !== 'fsa')) return;
    let store;
    if (id === 'fsa') {
      let dir;
      try { dir = await window.showDirectoryPicker({ id: 'cloadm-library', mode: 'readwrite' }); }
      catch (e) { if (e && e.name !== 'AbortError') page.status(`That folder can't be used: ${e.message}`, true); return; }
      if (!await FsaMediaStore.authorize(dir)) { page.status('CLOADM needs permission to write to that folder to keep your library there.', true); return; }
      store = new FsaMediaStore(dir);
    } else {
      try { store = await openMediaStore({ prefer: id }); } catch (e) { page.status(e.message, true); return; }
    }
    moving = true; renderStorage();
    try {
      const r = await session.library.moveMedia(store);
      if (id === 'fsa') await saveFolder(store.directory); else await forgetFolder();
      session.store.set('storage', id);
      reconnect = null;
      page.status(`Your library is now kept ${whereNow()}: ${r.copied} file(s) copied${r.kept ? `, ${r.kept} already there kept as they were` : ''}. The old copies stay where they were.`);
    } catch (e) { page.status(e.message, true); }
    moving = false;
    renderStorage(); refresh();
  }
  $('btnLibReconnect').onclick = async () => {
    const dir = reconnect;
    if (!dir || !await FsaMediaStore.authorize(dir).catch(() => false)) { page.status('Permission to use that folder was not given; your library stays inside this browser for now.', true); return; }
    try { await session.library.moveMedia(new FsaMediaStore(dir), { reconnecting: true }); reconnect = null; page.status(`Your library is back in the folder “${dir.name}”.`); }
    catch (e) { page.status(e.message, true); }
    renderStorage(); refresh();
  };
  $('btnLibStayHere').onclick = async () => {
    reconnect = null;
    session.store.set('storage', session.media.kind);
    await forgetFolder();
    page.status(`Your library is kept ${whereNow()} from now on.`);
    renderStorage();
  };
  session.on((ev) => { if (ev === 'storage') renderStorage(); });
  renderStorage();
  if (reconnect) page.status(`Your library folder “${reconnect.name}” needs your permission again: open the Library to reconnect it.`);

  // ---------------- the magazine rack ----------------
  for (const [where, list] of Object.entries(MAGS)) {
    $(`libMags-${where}`).replaceChildren(...list.map((m) => {
      const card = el('div', null, 'mag');
      const cover = el('div', null, 'cover'); cover.style.background = m.c; cover.style.color = m.fg;
      cover.append(el('span', m.n, 'title'), el('span', m.y || '', 'years'));
      card.append(cover, el('div', m.d, 'about'));
      if (m.u) { const a = el('a', m.l); a.href = m.u; a.rel = 'noopener'; a.target = '_blank'; card.append(a); }
      return card;
    }));
  }

  show();
  return { keep, open: () => page.openView('#library'), refresh };
}
