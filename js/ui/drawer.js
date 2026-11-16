/*
 * The settings drawer beside the screen: tabs Media / Display / Input / POKEs / Machine (keyboard: arrow
 * keys move between tabs), the recent media list, the ROM summary, and the cassette and cartridge slots under
 * the screen. The Display tab is its own module (display-panel.js).
 */
import { $ } from './page.js';

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
    const list = $('recentList'), items = session.recentMedia().filter((r) => r.machine === session.machine.id);
    list.replaceChildren();
    // empty: hidden while "Last time" shows above it (the CSS), as the two would contradict each other
    for (const el of [list, $('recentHead')]) el.classList.toggle('recent-empty', !items.length);
    if (!items.length) {
      const p = document.createElement('p'); p.style.margin = '0';
      p.textContent = 'Nothing loaded yet. Use Open… above, click the deck or a drive, or drop a file on the screen.';
      list.append(p);
      return;
    }
    const all = session.recentMedia();
    for (const r of items) {
      const b = document.createElement('button'); b.className = 'row';
      const n = document.createElement('span'); n.textContent = r.name;
      const k = document.createElement('span'); k.className = 'kind'; k.textContent = r.stored ? 'load again' : `${(r.size / 1024).toFixed(0)} KB`;
      b.append(n, k); b.disabled = !r.stored;
      b.onclick = () => { page.attempt(() => session.loadRecent(all.indexOf(r))); page.focus(); };
      list.append(b);
    }
  }

  // Machine tab: ROM summary; header pill when the machine in use has no BASIC
  function roms() {
    const r = session.machineRoms(), m = session.machine;
    $('romState').textContent = !m.useStub ? 'BASIC ready' : r.bootable ? 'Loaded · running the stub' : 'Not added · running the stub';
    $('romPill').hidden = r.bootable;
  }
  $('romPill').onclick = showRoms;
  $('btnManageRoms').onclick = showRoms;

  // slots under the screen: the cassette deck and the cartridge port
  let cartName = null;
  function slots() {
    const m = session.machine, t = m.deck.tape;
    $('tapeName').textContent = t ? t.name : 'No tape · Insert tape…';
    // a button that can't work is disabled with the reason, not clicked and complained about
    $('btnRewind').disabled = !t;
    $('btnRewind').title = t ? 'Back to the start of the tape' : 'No tape inserted';
    $('tapeState').textContent = !t ? 'click the deck to insert' : m.deck.motor ? `motor on · ${(t.progress() * 100).toFixed(0)}%` : `stopped · ${(t.progress() * 100).toFixed(0)}%`;
    $('btnTape').classList.toggle('turning', !!(t && m.deck.motor));
    $('cartSlot').hidden = !m.hasCartridgePort;
    const loaded = !!(m.hasCartridgePort && m.cartPort);
    $('btnCart').classList.toggle('loaded', loaded);
    // the Pak takes no cartridge image: on that board the button inserts it instead of opening a file
    const onSsc = $('selCartBoard').value === 'ssc';
    $('btnCart').textContent = loaded ? (cartName ? `${cartName} · ${m.cartPort.name || 'cartridge'}` : (m.cartPort.name || 'Cartridge'))
      : onSsc ? 'Insert the Speech/Sound Pak…' : 'Insert cartridge…';
    // the board menu offers the Pak only on the models that take it
    $('selCartBoard').querySelector('option[value="ssc"]').hidden = !session.offersSsc;
    if (!session.offersSsc && onSsc) { $('selCartBoard').value = 'auto'; session.cartBoard = 'auto'; slots(); }
  }
  $('btnCart').onclick = () => {
    if ($('selCartBoard').value === 'ssc') page.attempt(() => session.insertSsc());
    else $('fileCart').click();
  };
  // the board the next cartridge image goes on (automatic: Orchestra-90 by its ROM, banked over 16K, else a Program Pak)
  $('selCartBoard').onchange = (e) => { session.cartBoard = e.target.value; slots(); };

  session.on((ev) => {
    if (ev === 'machine' || ev === 'loaded') { if (ev === 'machine') cartName = null; recent(); roms(); slots(); }
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
    const t = session.machine && session.machine.deck.tape;
    if (t) {
      if (!unwatch) unwatch = page.onFrame(() => { if (session.machine) slots(); });
    } else if (unwatch) { unwatch(); unwatch = null; }
  }
  watchTape();
  return { refreshRoms: roms, cartridge: (name) => { cartName = name; slots(); } };
}
