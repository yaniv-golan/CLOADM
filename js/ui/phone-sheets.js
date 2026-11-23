// A phone's layout (the on-screen panel on, body.touch-keys, or hidden for now, body.touch-hidden): the machine's ports
// and its power controls are not laid out under the screen, where the page would scroll, but sit in four sheets, each
// opened by its chip in one row under the panel (play/index.html #chipRow): Tape (the cassette deck), Disks (the disk
// drives), Cartridge (the cartridge port, its board and the Multi-Pak) and Power (Reset, Switch off and on, Pause, Turbo,
// Full screen, Hide keys). The chips' order is fixed, so a chip never moves under a finger.
// The sheets hold the page's own controls: the same nodes move into them while the phone layout is on and back to
// their places when it is off, so there is one of each control and one of each id, and the desktop page is as it was.
// Each sheet is a modal <dialog> (showModal): the page behind it is inert and the machine's keyboard does not type
// (js/ui/page.js and screen.js leave the keys alone while a dialog is open), while the machine keeps running.
// One sheet at a time: opening one closes another, and closes Ask's phone sheet; opening the full-screen chat closes it.
// It opens with the focus on its first control and gives the focus back to the chip that opened it when it closes.
// Esc closes it, after anything open over it (the drive menu, the offer after a load, the snapshot card: ESC.sheet).
import { $, ESC, viewOpen, markUndrawn } from './page.js';

const SHEETS = [
  { id: 'sheetTape', chip: 'chipTape', nodes: ['.slots > .slot.tape', '#tapePanel'] },
  { id: 'sheetDisks', chip: 'chipDisks', nodes: ['#driveSlot', '#nitros9Slot'] },
  { id: 'sheetCart', chip: 'chipCart', nodes: ['#cartSlot'] },
  { id: 'sheetPower', chip: 'chipPower', nodes: ['#btnReset', '#btnHardReset', '#btnPause', '#btnTurbo', '#btnFull'] },
  // Programs (Menu → Programs…, first, and the palette's "Programs"): the Media tab's programs, the "Running with no
  // ROMs" card, Last time, the no-ROM shelf ("on screen now" on the one running), Recent on this machine, the
  // snapshots and the way to the Library; the Media tab keeps its tape options
  { id: 'sheetPrograms', chip: null, nodes: ['#welcome', '#lastTime', '#shelfHead', '#shelf', '#recentHead', '#recentList', '#quickSave', '#linkLibrary'] },
  // Settings (Menu → Settings…, and openSettings(tab) from anywhere): the drawer's tabs and their panels
  { id: 'sheetSettings', chip: null, nodes: ['.drawer > [role="tablist"]', '#panel-media', '#panel-display', '#panel-input', '#panel-pokes', '#panel-machine'] },
];
// what may open over a sheet, and so is shown in it while it is open (outside the dialog it would be inert, under it)
const GUESTS = ['#snapNeeds', '#lizaOffer', '#mediaOffer'];
const FOCUSABLE = 'button:not([hidden]):not([disabled]), select:not([disabled]), input:not([disabled]):not([type="hidden"]), a[href], summary, [tabindex]:not([tabindex="-1"])';

export function setupPhoneSheets(page, { touchKeys, ask = null }) {
  // held sideways (the touch keys around the screen; play/index.html draws the sheets from the right there)
  const sideways = matchMedia('(orientation: landscape) and (max-height: 500px)');
  // no chips: sideways, or a short phone upright (under 600 px; play/index.html): the ports are one tabbed sheet, from
  // Menu, as sideways (a bottom sheet upright)
  const short = matchMedia('(orientation: portrait) and (max-height: 599px)');
  const chipless = () => sideways.matches || short.matches;
  const session = page.session;
  const row = $('chipRow');
  const phone = () => document.body.classList.contains('touch-keys') || document.body.classList.contains('touch-hidden');
  // the nodes moved into the sheets, each with a marker where it came from
  let moved = null;
  function place() {
    const on = phone();
    row.hidden = !on;
    if (on && !moved) {
      moved = [];
      for (const s of SHEETS) {
        const body = $(s.id).querySelector('.sheetbody'), first = body.firstChild;
        for (const sel of s.nodes) {
          const el = document.querySelector(sel);
          if (!el) continue;
          const mark = document.createComment(`phone sheet: ${sel}`);
          el.before(mark);
          // (Power's own Hide keys stays last; the notes stay first)
          if (s.id === 'sheetPower') body.insertBefore(el, $('btnHideKeys')); else body.append(el);
          moved.push([mark, el]);
        }
        if (first && first.classList && first.classList.contains('sheetnote')) body.prepend(first);
      }
      markUndrawn();   // (the drawer, left with nothing to show, is not drawn: page.js)
    } else if (!on && moved) {
      close();
      for (const [mark, el] of moved.reverse()) { mark.replaceWith(el); }
      moved = null;
      markUndrawn();
    }
    chips();
  }
  new MutationObserver(place).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // ---- the chips: what is in each port, and whether the machine runs
  const fileOf = (name) => String(name).split('/').pop();
  function chips() {
    const m = session.personMachine;
    if (!m) return;
    const t = m.deck.tape, d = session.drives.status().drives, cartOn = !!(m.hasCartridgePort && m.cartPort);
    const disksHere = !$('driveSlot').hidden || d.length > 0, cartHere = !!m.hasCartridgePort;
    const paused = document.body.classList.contains('paused');
    const set = (id, state, has, label) => {
      const c = $(id), cs = c.querySelector('.cs');
      if (cs.textContent !== state) cs.textContent = state;
      c.classList.toggle('has-media', has);
      if (c.getAttribute('aria-label') !== label) c.setAttribute('aria-label', label);
    };
    const tape = t ? fileOf(t.name) : 'Empty';
    set('chipTape', tape, !!t, `Tape: ${tape}. Open the cassette deck.`);
    const disks = !disksHere ? 'None fitted' : d.length === 0 ? 'Empty' : d.length === 1 ? fileOf(d[0].name) : `${d.length} disks`;
    set('chipDisks', disks, d.length > 0, `Disks: ${disks}. Open the disk drives.`);
    const cart = !cartHere ? 'No port' : !cartOn ? 'Empty' : (m.cartPort.name || 'Cartridge');
    set('chipCart', cart, cartOn, `Cartridge: ${cart}. Open the cartridge port.`);
    const power = paused ? 'Paused' : 'Running';
    set('chipPower', power, false, `Power: ${power}. Open power.`);
    // a short phone upright: no chips; Menu's two items say the same, and Menu wears a dot while media is in
    const inMenu = !!moved && chipless() && !sideways.matches;
    // (the disk controller plugged in for a disk without a disk ROM is the disks', not a cartridge of its own)
    const cartOwn = cartOn && m.cartPort !== session.drives.bareController;
    const parts = [t && fileOf(t.name), d.length && `${d.length} disk${d.length > 1 ? 's' : ''}`, cartOwn && (m.cartPort.name || 'Cartridge')].filter(Boolean);
    const portState = parts.join(' · ') || 'Empty';
    for (const [id, state, name] of [['navPorts', portState, 'Tape, disks and cartridge'], ['navPower', power, 'Power']]) {
      const b = $(id);
      b.hidden = !inMenu;
      $(`${id}State`).textContent = state;
      b.setAttribute('aria-label', `${name}: ${state}.`);
    }
    const menu = $('btnMenu'), dot = inMenu && parts.length > 0;
    if (menu.classList.contains('media') !== dot) { menu.classList.toggle('media', dot); if (page.syncMenu) page.syncMenu(); }
    // a sheet whose port this machine lacks says so instead of standing empty
    const note = (id, show, text) => { const n = document.querySelector(`#${id} .sheetnote, [data-body="${id}"] .sheetnote`); n.hidden = !show; if (show) n.textContent = text; };
    note('sheetDisks', !disksHere, `The ${m.profile.name} has no disk drives fitted. Inserting a disk adds a controller for it.`);
    note('sheetCart', !cartHere, `The ${m.profile.name} has no cartridge port.`);
  }
  session.on(() => chips());
  new MutationObserver(chips).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // ---- opening and closing
  let openSheet = null, opener = null, guests = [];
  // from: what opened it (its chip, the tape bar's Deck, Menu), which has the focus back when it closes. Named, not
  // left to the dialog: a tapped button does not take the focus in iOS Safari, so the dialog's own return would go
  // to the page's body
  function open(id, from = null) {
    const d = $(id);
    if (openSheet === d) return;
    close(false);
    if (ask && ask.open) ask.hide();
    touchKeys.release();   // a stick or FIRE held with the other hand is let go of
    openSheet = d;
    opener = from || (document.activeElement !== document.body ? document.activeElement : null);
    // what opens over the sheet is shown in it (an offer after a load from the sheet, the snapshot card)
    guests = GUESTS.map((sel) => document.querySelector(sel)).filter(Boolean).map((el) => { const mark = document.createComment('sheet guest'); el.before(mark); d.append(el); return [mark, el]; });
    d.hidden = false;   // (closed, a sheet is hidden for real: out of the accessibility tree and the focus order)
    if (id === 'sheetSettings') fitSettings();
    d.showModal();
    const first = d.querySelector('.sheetbody [aria-selected="true"]') || [...d.querySelectorAll(`.sheetbody ${FOCUSABLE}`)].find((e) => e.checkVisibility());
    (first || d.querySelector('.sheetdone')).focus();
  }
  // (refocus false: what closes it takes the focus itself, a view, the chat, ⌨ after Hide keys, the next sheet)
  function close(refocus = true) {
    const d = openSheet;
    if (!d) return;
    openSheet = null;
    for (const [mark, el] of guests) mark.replaceWith(el);
    guests = [];
    if (d.open) d.close();
    d.hidden = true;
    if (d === ports) lendPorts(false);
    const back = opener;
    opener = null;
    if (refocus && back && back.isConnected && back.checkVisibility()) back.focus();
  }
  // Settings: from the screen's foot to the window's, and at least half the window (so the screen shows what a Display
  // setting does); Expand makes it the whole height, Collapse gives that back
  const settings = $('sheetSettings'), expand = $('btnSheetExpand');
  function fitSettings() {
    const m = document.querySelector('.layout > main > .monitor').getBoundingClientRect();
    settings.style.setProperty('--sheet-h', `${Math.round(Math.max(innerHeight - Math.max(m.bottom, 0), innerHeight / 2))}px`);
  }
  const expanded = (on) => { settings.classList.toggle('expanded', on); expand.textContent = on ? 'Collapse' : 'Expand'; expand.setAttribute('aria-pressed', String(on)); };
  expand.onclick = () => expanded(!settings.classList.contains('expanded'));
  settings.addEventListener('close', () => { expanded(false); settings.style.bottom = ''; settings.style.maxHeight = ''; });
  // the phone's own keyboard up over the sheet (a POKE's field): the sheet stands on it, and the field stays in view
  const vv = window.visualViewport;
  if (vv) vv.addEventListener('resize', () => {
    if (openSheet !== settings) return;
    const below = Math.max(0, innerHeight - vv.height - vv.offsetTop);
    settings.style.bottom = below ? `${Math.round(below)}px` : '';
    settings.style.maxHeight = below ? `${Math.round(vv.height)}px` : '';
    const f = document.activeElement;
    if (below && f && settings.contains(f) && f.matches('input, textarea, select')) f.scrollIntoView({ block: 'nearest' });
  });
  // openSettings(tab): the drawer's tab selected, and on a phone the Settings sheet opened on it (true then); every
  // caller that shows a settings tab comes here (the palette, the machine menu, Ask's rail, Menu's Settings…)
  function openSettings(tab = null, from = null) {
    if (tab) $(tab).click();
    if (!moved) return false;
    open('sheetSettings', from);
    return true;
  }
  page.openSettings = openSettings;
  // openPrograms: on a phone the Programs sheet; elsewhere the drawer's Media tab, where the same programs are, brought
  // into view with the focus on the first of them
  function openPrograms(from = null) {
    if (moved) { open('sheetPrograms', from); return; }
    $('tab-media').click();
    $('shelf').scrollIntoView({ block: 'nearest' });
    const first = $('shelf').querySelector('a, button');
    if (first) first.focus({ preventScroll: true });
  }
  page.openPrograms = openPrograms;
  // a program started from the sheet: the sheet closes so the screen shows it (before the program's own click runs,
  // so what that opens, the offer of LIZA's RAM, the chat, lands on the page and takes the focus)
  $('sheetPrograms').addEventListener('click', (e) => {
    if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (e.target.closest('#shelf a, #shelf button, #recentList button:not(:disabled), #btnRunAgain')) close(false);
  }, true);

  // ---- held sideways there are no chips: the keys' Menu opens the three ports as one side sheet, "Tape, disks and
  // cartridge", a tab each (switching in place). The port sheets' bodies are lent to its panels while it is open. It
  // opens on the tab that holds media, else the one last used, Tape at first.
  const ports = $('sheetPorts'), PORTS = ['sheetTape', 'sheetDisks', 'sheetCart'];
  const portTabs = [...ports.querySelectorAll('[role="tab"]')];
  const bodies = Object.fromEntries(PORTS.map((id) => [id, $(id).querySelector('.sheetbody')]));
  const chipOf = (id) => $(SHEETS.find((x) => x.id === id).chip);
  let portTab = 'sheetTape', lent = false;
  function selectPort(id, focus = false) {
    portTab = id;
    for (const t of portTabs) {
      const on = t.dataset.sheet === id;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
      if (on && focus) t.focus();
    }
  }
  portTabs.forEach((t, i) => {
    t.onclick = () => selectPort(t.dataset.sheet);
    t.onkeydown = (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      selectPort(portTabs[(i + (e.key === 'ArrowRight' ? 1 : portTabs.length - 1)) % portTabs.length].dataset.sheet, true);
    };
  });
  function lendPorts(on) {
    if (on === lent) return;
    lent = on;
    for (const t of portTabs) {
      const id = t.dataset.sheet;
      if (on) $(t.getAttribute('aria-controls')).append(bodies[id]); else $(id).append(bodies[id]);
    }
  }
  function openPorts(tab = null, from = null) {
    if (!moved) return false;
    const pick = tab || PORTS.find((id) => chipOf(id).classList.contains('has-media')) || portTab;
    if (openSheet && openSheet !== ports) close(false);
    lendPorts(true);
    selectPort(pick);
    open('sheetPorts', from);
    return true;
  }
  // turned with a sheet open: the same sheet, on the same tab, as the other shape (a port's own sheet upright, the
  // ports' side sheet sideways; Settings is one sheet either way, drawn from the bottom or the side)
  const turned = () => {
    chips();
    if (!openSheet || !moved) return;
    const id = openSheet.id, from = opener;
    if (chipless() && PORTS.includes(id)) openPorts(id, from);
    else if (!chipless() && openSheet === ports) { const t = portTab; close(false); open(t, from && from.checkVisibility() ? from : chipOf(t)); }
  };
  sideways.addEventListener('change', turned);
  short.addEventListener('change', turned);
  // Menu's items on a short phone
  const fromMenu = (fn) => () => { $('appbar').classList.remove('menu-open'); $('btnMenu').setAttribute('aria-expanded', 'false'); fn(); };
  $('navPorts').onclick = fromMenu(() => openPorts(null, $('btnMenu')));
  $('navPower').onclick = fromMenu(() => open('sheetPower', $('btnMenu')));
  // (Programs…: on a narrow page without the touch keys, the drawer's Media tab, far down the page there)
  $('navPrograms').onclick = fromMenu(() => openPrograms(moved ? $('btnMenu') : null));

  for (const s of [...SHEETS, { id: 'sheetPorts', chip: null }]) {
    const d = $(s.id);
    if (s.chip) $(s.chip).onclick = () => open(s.id, $(s.chip));
    d.querySelector('.sheetdone').onclick = () => close();
    // closed any other way (the browser's own close request): tidy up the same way
    d.addEventListener('close', () => { if (openSheet === d) close(); });
    // a tap on the backdrop (outside the sheet's box) closes it
    d.addEventListener('click', (e) => { if (e.target === d) { const r = d.getBoundingClientRect(); if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) close(); } });
  }
  $('btnHideKeys').onclick = () => { close(false); touchKeys.hide(); };
  page.onEscape(ESC.sheet, () => !!openSheet, () => close());
  // a view (the Library, Your ROMs, Share, the Debugger) takes the page, opened from a sheet or not: the sheet closes
  page.onView(() => { if (viewOpen()) close(false); }, { every: true });
  // the full-screen chat takes the page: a sheet closes
  new MutationObserver(() => { if (document.body.classList.contains('claude-open')) close(false); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  place();
  return { open, close, openSettings, openPrograms, openPorts, get openSheet() { return openSheet; } };
}
