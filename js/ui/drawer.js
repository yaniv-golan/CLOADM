/*
 * The settings drawer beside the screen: tabs Media / Display / Input / POKEs / Machine (Machine settings; keyboard: arrow
 * keys move between tabs), the recent media list, the ROM summary, and the cassette and cartridge slots under
 * the screen. The Display tab is its own module (display-panel.js).
 */
import { $, put, putClass } from './page.js';
import { SessionError } from '../session.js';

// The recent list's rows: the entries for `machine`, each with the index it has in the FULL list. recentMedia()
// hands out copies, so an index looked up in a second call (indexOf) matches nothing and is always -1; the index
// must be taken from the same list the row was drawn from. This is the whole of that arithmetic, with no DOM, so a
// Node test can run the code the drawer runs rather than a copy of it.
export const recentRows = (all, machine) => all.map((r, i) => ({ r, i })).filter((x) => x.r.machine === machine);

// What a click on a recent row does: load the entry that row was DRAWN from. The list can change between drawing
// and clicking (a load, an eviction, a machine switch), so the row's own ENTRY decides which one to load, found
// again in the list as it is now by its identity (name, crc, machine). The index is only a fallback for an entry
// that has gone from the list: the row is then stale, and loadRecent(index) reports it, rather than silently
// loading whatever moved into that slot.
export const loadRow = (session, row) => {
  const now = session.library.recentMedia();
  // the name by the SESSION's rule (MediaLibrary.sameName, the store's own case rule), never by ===: on a store that
  // does not tell cases apart, "GAME.DSK" and "game.dsk" are one name everywhere else in the app, and a row drawn
  // from one spelling must find the entry under the other.
  const at = now.findIndex((r) => session.library.sameName(r.name, row.r.name) && r.crc === row.r.crc && r.machine === row.r.machine);
  // not found: the row was evicted (or its entry replaced) while the drawer was open. Loading by the row's old
  // index would load whatever moved into that slot -- a different file under the same click. Say it is gone, as a
  // SessionError: the drawer reports it on its own message line, where a plain Error would go to console.error.
  if (at < 0) throw new SessionError('That file is no longer in the recent list; open it again.');
  return session.library.loadRecent(at);
};

export function setupDrawer(page, { showRoms }) {
  const { session } = page;
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function select(tab, focus = false) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) tab.focus();
  }
  tabs.forEach((t, i) => {
    t.onclick = () => select(t);
    t.onkeydown = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); select(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length], true); }
    };
  });
  select(tabs[0]);

  // Media: what was loaded on this machine before
  function recent() {
    const list = $('recentList');
    const items = recentRows(session.library.recentMedia(), session.personMachine.id);
    list.replaceChildren();
    // empty: hidden while "Last time" shows above it (the CSS), as the two would contradict each other
    for (const el of [list, $('recentHead')]) el.classList.toggle('recent-empty', !items.length);
    if (!items.length) {
      const p = document.createElement('p'); p.style.margin = '0';
      p.textContent = 'Nothing loaded yet. Use Open… above, click the deck or a drive, or drop a file on the screen.';
      list.append(p);
      return;
    }
    for (const { r, i } of items) {
      const b = document.createElement('button'); b.className = 'row';
      const n = document.createElement('span'); n.textContent = r.name;
      const k = document.createElement('span'); k.className = 'kind'; k.textContent = r.stored ? 'load again' : `${(r.size / 1024).toFixed(0)} KB`;
      // two rows of one name with different bytes: say which is which, or the list shows the same line twice
      if (r.copy) { const c = document.createElement('span'); c.className = 'copy'; c.textContent = r.copy; b.append(n, c, k); }
      else b.append(n, k);
      b.disabled = !r.stored;
      b.onclick = () => { page.attempt(() => loadRow(session, { r, i })); page.focus(); };
      list.append(b);
    }
  }

  // Machine settings: the ROM summary, first in the panel (R28b), its button "Add ROMs →" without BASIC and "See or
  // add ROMs →" with it; the header pill when the machine in use has no BASIC
  function roms() {
    const r = session.machineRoms(), m = session.personMachine;   // the person's machine (the BASIC session while the chat is on screen)
    $('romState').textContent = session.nitros9Running ? 'Not used · NitrOS-9 runs on CLOADM\'s own loader' : !m.useStub ? 'BASIC ready' : r.bootable ? 'Loaded · running without ROMs for now' : 'Not added · running without ROMs';
    $('btnManageRoms').textContent = r.bootable ? 'See or add ROMs →' : 'Add ROMs →';
    $('romPill').hidden = r.bootable || session.nitros9Running;   // NitrOS-9 needs no ROM
  }
  $('romPill').onclick = showRoms;
  $('btnManageRoms').onclick = showRoms;

  // slots under the screen: the cassette deck and the cartridge port
  let cartName = null;
  function slots() {
    const m = session.personMachine, t = m.deck.tape;
    // (refreshed every frame while a tape is in: each part is written only when it changes, put/putClass)
    put($('tapeName'), 'textContent', t ? t.name : 'No tape · Insert tape…');
    // a button that can't work is disabled with the reason, not clicked and complained about
    put($('btnRewind'), 'disabled', !t);
    put($('btnRewind'), 'title', t ? 'Back to the start of the tape' : 'No tape inserted');
    put($('btnEjectTape'), 'disabled', !t);
    put($('btnEjectTape'), 'title', t ? 'Take the tape out of the deck' : 'No tape inserted');
    put($('tapeState'), 'textContent', !t ? 'click the deck to insert' : m.deck.motor ? `motor on · ${(t.progress() * 100).toFixed(0)}%` : `stopped · ${(t.progress() * 100).toFixed(0)}%`);
    put($('cartSlot'), 'hidden', !m.hasCartridgePort);
    const loaded = !!(m.hasCartridgePort && m.cartPort);
    putClass($('btnCart'), 'loaded', loaded);
    // the Pak takes no cartridge image: on that board the button inserts it instead of opening a file
    const onSsc = $('selCartBoard').value === 'ssc';
    // the disk controller plugged in for a disk without a disk ROM says so: "Dragon disk controller · no disk ROM"
    const bare = loaded && m.cartPort === session.drives.bareController;
    put($('btnCart'), 'textContent', bare ? `${m.cartPort.plainName} · no disk ROM`
      : loaded ? (cartName ? `${cartName} · ${m.cartPort.name || 'cartridge'}` : (m.cartPort.name || 'Cartridge'))
      : onSsc ? 'Insert the Speech/Sound Pak…' : 'Insert cartridge…');
    put($('btnCartOut'), 'hidden', !loaded);
    // what holds media, for the phone's order (play/index.html: a slot with media comes first)
    putClass($('btnTape').closest('.slot'), 'has-media', !!t);
    putClass($('driveSlot'), 'has-media', session.drives.status().drives.length > 0);
    putClass($('cartSlot'), 'has-media', loaded);
    // the board menu offers the Pak only on the models that take it
    put($('selCartBoard').querySelector('option[value="ssc"]'), 'hidden', !session.offersSsc);
    if (!session.offersSsc && onSsc) { $('selCartBoard').value = 'auto'; session.cartBoard = 'auto'; slots(); }
  }
  $('btnCartOut').onclick = () => { page.attempt(() => session.takeOutCartridge()); cartName = null; slots(); page.focus(); };
  $('btnCart').onclick = () => {
    if ($('selCartBoard').value === 'ssc') page.attempt(() => session.insertSsc());
    else $('fileCart').click();
  };
  // the board the next cartridge image goes on (automatic: Orchestra-90 by its ROM, banked over 16K, else a Program Pak)
  $('selCartBoard').onchange = (e) => { session.cartBoard = e.target.value; slots(); };

  session.on((ev) => {
    if (ev === 'machine' || ev === 'loaded') { if (ev === 'machine') cartName = null; recent(); roms(); slots(); }
    if (ev === 'disks') slots();   // a disk mounted without a disk ROM plugs the controller in, and a reset gives it its ROM
    if (ev === 'roms') { roms(); recent(); }
    // a tape mounted or ejected starts or stops the per-frame refresh of this row. A power cycle ejects the
    // deck and reports 'firmware' (Session.powerCycle -> poweredOn), not 'reset', so it has to be in this list:
    // without it the watcher outlived the tape and redrew the row every frame for the life of the page.
    if (ev === 'tape' || ev === 'machine' || ev === 'loaded' || ev === 'reset' || ev === 'firmware') { slots(); watchTape(); }
  });
  // slots() shows the tape's motor state and progress, which change while a tape plays, and the cartridge
  // slot, which changes only on an event. So it is refreshed per frame while a tape is mounted (or the deck
  // is moving) and refreshed directly on the events that can change the rest; with no tape, nothing on this
  // row changes without an event. Replaces a 500 ms setInterval that ran for the whole session.
  let unwatch = null;
  function watchTape() {
    const t = session.personMachine && session.personMachine.deck.tape;
    if (t) {
      if (!unwatch) unwatch = page.onFrame(() => { if (session.personMachine) slots(); });
    } else if (unwatch) { unwatch(); unwatch = null; }
  }
  watchTape();
  return { refreshRoms: roms, cartridge: (name) => { cartName = name; slots(); } };
}
