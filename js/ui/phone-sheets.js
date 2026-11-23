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
import { $, ESC, viewOpen } from './page.js';

const SHEETS = [
  { id: 'sheetTape', chip: 'chipTape', nodes: ['.slots > .slot.tape', '#tapePanel'] },
  { id: 'sheetDisks', chip: 'chipDisks', nodes: ['#driveSlot', '#nitros9Slot'] },
  { id: 'sheetCart', chip: 'chipCart', nodes: ['#cartSlot'] },
  { id: 'sheetPower', chip: 'chipPower', nodes: ['#btnReset', '#btnHardReset', '#btnPause', '#btnTurbo', '#btnFull'] },
];
// what may open over a sheet, and so is shown in it while it is open (outside the dialog it would be inert, under it)
const GUESTS = ['#snapNeeds', '#lizaOffer', '#mediaOffer'];
const FOCUSABLE = 'button:not([hidden]):not([disabled]), select:not([disabled]), input:not([disabled]):not([type="hidden"]), a[href], summary, [tabindex]:not([tabindex="-1"])';

export function setupPhoneSheets(page, { touchKeys, ask = null }) {
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
    } else if (!on && moved) {
      close();
      for (const [mark, el] of moved) { mark.replaceWith(el); }
      moved = null;
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
    const disks = !disksHere ? 'None fitted' : d.length === 0 ? 'Empty' : d.length === 1 ? d[0].file : `${d.length} disks`;
    set('chipDisks', disks, d.length > 0, `Disks: ${disks}. Open the disk drives.`);
    const cart = !cartHere ? 'No port' : !cartOn ? 'Empty' : (m.cartPort.name || 'Cartridge');
    set('chipCart', cart, cartOn, `Cartridge: ${cart}. Open the cartridge port.`);
    const power = paused ? 'Paused' : 'Running';
    set('chipPower', power, false, `Power: ${power}. Open power.`);
    // a sheet whose port this machine lacks says so instead of standing empty
    const note = (id, show, text) => { const n = $(id).querySelector('.sheetnote'); n.hidden = !show; if (show) n.textContent = text; };
    note('sheetDisks', !disksHere, `The ${m.profile.name} has no disk drives fitted. Inserting a disk adds a controller for it.`);
    note('sheetCart', !cartHere, `The ${m.profile.name} has no cartridge port.`);
  }
  session.on(() => chips());
  new MutationObserver(chips).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // ---- opening and closing
  let openSheet = null, opener = null, guests = [];
  function open(id, from = null) {
    const d = $(id);
    if (openSheet === d) return;
    close(false);
    if (ask && ask.open) ask.hide();
    touchKeys.release();   // a stick or FIRE held with the other hand is let go of
    openSheet = d; opener = from;
    // what opens over the sheet is shown in it (an offer after a load from the sheet, the snapshot card)
    guests = GUESTS.map((sel) => document.querySelector(sel)).filter(Boolean).map((el) => { const mark = document.createComment('sheet guest'); el.before(mark); d.append(el); return [mark, el]; });
    d.hidden = false;   // (closed, a sheet is hidden for real: out of the accessibility tree and the focus order)
    d.showModal();
    const first = d.querySelector('.sheetbody [aria-selected="true"]') || [...d.querySelectorAll(`.sheetbody ${FOCUSABLE}`)].find((e) => e.checkVisibility());
    (first || d.querySelector('.sheetdone')).focus();
  }
  function close(refocus = true) {
    const d = openSheet;
    if (!d) return;
    openSheet = null;
    for (const [mark, el] of guests) mark.replaceWith(el);
    guests = [];
    if (d.open) d.close();
    d.hidden = true;
    const back = opener;
    opener = null;
    if (refocus && back && back.isConnected) back.focus();
  }
  for (const s of SHEETS) {
    const d = $(s.id);
    $(s.chip).onclick = (e) => open(s.id, e.currentTarget);
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
  return { open: (id, from) => open(id, from), close, get openSheet() { return openSheet; } };
}
